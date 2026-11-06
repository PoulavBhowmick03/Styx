// Carries approval requests from the agent to the owner, and signatures back. The relay holds no key
// and grants no authority: a signature only matters because the vault checks it. Anything from the
// agent is untrusted, so alerts are built only from fields that passed validation.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Address, Hex } from "viem";

import {
  approvalDigest,
  buildSignatureFile,
  formatUsdc,
  parsePending,
  paymentHash,
  SIGNATURE_SCHEMA,
  type OwnerConfig,
  type Pending,
} from "../../owner-page/src/approval";
import {
  approvalDigestV2,
  buildSignatureFileV2,
  isPendingV2,
  parsePendingV2,
  paymentHashV2,
  SIGNATURE_SCHEMA_V2,
  type PendingV2,
} from "../../owner-page/src/approval-v2";

import { RelayError } from "./errors";
import type { People } from "./people";

export interface RelayConfig {
  chainId: bigint;
  vault: Address;
  owner: Address;
  token: Address;
  pageUrl: string;
  relayUrl: string;
  agentToken: string;
  watcherToken?: string;
  maxAlertsPerHour: number;
  maxRequests: number;
  stateDir?: string;
  /** A v2 vault, and each of its agents' own token. One agent's token never acts for another. */
  v2?: { vault: Address; agentTokens: Map<Address, string> };
  /** Agents registered by their vault's owner, and who to alert. Any vault can join this way. */
  people?: People;
}

export interface Alert {
  text: string;
  /** The approval link, when this alert has one. */
  url?: string;
}

/** With no chat named, the alert goes to the relay's own configured chat. */
export type Notify = (alert: Alert, chatId?: string) => Promise<boolean>;
type AlertKind = string;

/** A request cannot stay open longer than this, so an agent token cannot fill the store for good. */
export const MAX_REQUEST_LIFETIME_SECONDS = 86_400;

interface Stored {
  id: string;
  digest: Hex;
  pending: unknown;
  expiresAt: number;
  alerted: boolean;
  /** Set on v2 requests: only this agent's token can read the signature. */
  agent?: Address;
  signature?: { schema: string; paymentId: Hex; approvalDigest: Hex; signature: Hex; signer?: Address; signerVersion?: string };
}

export { RelayError };

export function tokenMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Relay {
  private readonly requests = new Map<string, Stored>();
  private readonly byDigest = new Map<string, string>();
  private readonly sending = new Map<string, Promise<boolean>>();
  // Separate budgets, so a burst of watcher notices cannot use up the owner's approval alerts.
  private readonly alertTimes: Record<AlertKind, number[]> = {};

  constructor(
    private readonly config: RelayConfig,
    private readonly notify: Notify,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    const tokens = [...(config.v2?.agentTokens.values() ?? [])];
    // A shared token would let one agent act for another.
    if (new Set(tokens).size !== tokens.length || tokens.includes(config.agentToken)) {
      throw new Error("each agent needs its own token");
    }
    this.load();
  }

  private ownerConfig(): OwnerConfig {
    const { chainId, vault, owner, token } = this.config;
    return { chainId, vault, owner, token, vendors: new Map() };
  }

  private statePath(): string | undefined {
    return this.config.stateDir ? join(this.config.stateDir, "requests.json") : undefined;
  }

  private load(): void {
    const path = this.statePath();
    if (!path) return;
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(stored)) return;
    for (const entry of stored as Partial<Stored>[]) {
      // A damaged entry is dropped, not trusted: the agent can ask again, and the vault still decides.
      const valid = typeof entry?.id === "string" && typeof entry.digest === "string" && typeof entry.expiresAt === "number" && entry.pending !== undefined;
      if (!valid) continue;
      const request = entry as Stored;
      this.requests.set(request.id, request);
      this.byDigest.set(request.digest, request.id);
    }
  }

  private save(): void {
    const path = this.statePath();
    if (!path) return;
    mkdirSync(this.config.stateDir!, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.requests.values()]), { mode: 0o600 });
    renameSync(temporary, path);
  }

  private validate(input: unknown): Pending {
    let pending: Pending;
    try {
      pending = parsePending(input);
    } catch {
      throw new RelayError(400, "invalid pending approval");
    }
    if (pending.chainId !== this.config.chainId || pending.vault !== this.config.vault || pending.payment.token !== this.config.token) {
      throw new RelayError(400, "this request is for another vault");
    }
    if (paymentHash(pending.payment) !== pending.authorization.paymentHash) {
      throw new RelayError(400, "the authorization does not match the payment");
    }
    if (pending.authorization.authorizationExpiry <= BigInt(this.now())) throw new RelayError(400, "this request has expired");
    if (pending.authorization.authorizationExpiry > BigInt(this.now() + MAX_REQUEST_LIFETIME_SECONDS)) {
      throw new RelayError(400, "this request stays open too long");
    }
    if (pending.exceededRule !== "perPaymentLimit" || pending.payment.amount <= pending.perPaymentLimit) {
      throw new RelayError(400, "this amount does not exceed the stated limit");
    }
    return pending;
  }

  /** Takes a slot before anything is awaited, so concurrent requests cannot all see the same free one. */
  private reserveAlertSlot(kind: AlertKind): number | undefined {
    const cutoff = this.now() - 3600;
    const times = (this.alertTimes[kind] ?? []).filter((at) => at > cutoff);
    this.alertTimes[kind] = times;
    if (times.length >= this.config.maxAlertsPerHour) return undefined;
    const at = this.now();
    times.push(at);
    return at;
  }

  /** Only a delivered alert counts against the budget, so an outage cannot use it up. */
  private async send(kind: AlertKind, alert: Alert, reserved: number, chatId?: string): Promise<boolean> {
    const delivered = await this.notify(alert, chatId).catch(() => false);
    if (!delivered) {
      const times = this.alertTimes[kind] ?? [];
      const index = times.indexOf(reserved);
      if (index >= 0) times.splice(index, 1);
    }
    return delivered;
  }

  private link(id: string): string {
    const url = new URL(this.config.pageUrl);
    url.searchParams.set("relay", this.config.relayUrl);
    url.searchParams.set("request", id);
    return url.toString();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, request] of this.requests) {
      if (request.expiresAt <= now) {
        this.requests.delete(id);
        this.byDigest.delete(request.digest);
      }
    }
  }

  private async validateV2(input: unknown, token: string | undefined): Promise<PendingV2> {
    const registered = this.config.people?.agentByToken(token);
    const configured = [...(this.config.v2?.agentTokens.values() ?? [])].some((expected) => tokenMatches(token, expected));
    if (!this.config.v2 && !this.config.people) throw new RelayError(400, "this relay has no v2 vault");
    if (!registered && !configured) throw new RelayError(401, "unauthorized");
    let pending: PendingV2;
    try {
      pending = parsePendingV2(input);
    } catch {
      throw new RelayError(400, "invalid pending approval");
    }
    if (pending.chainId !== this.config.chainId || pending.payment.token !== this.config.token) {
      throw new RelayError(400, "this request is for another vault");
    }
    if (registered) {
      if (pending.vault !== registered.vault || pending.payment.agent !== registered.agent) {
        throw new RelayError(403, "this token is for another agent");
      }
      if (pending.authorization.signer !== registered.approver) {
        throw new RelayError(403, "the owner chose a different approver for this agent");
      }
      if (!(await this.config.people!.stillApprover(pending.vault, pending.authorization.signer))) {
        throw new RelayError(403, "the vault no longer lists this approver");
      }
    } else {
      if (pending.vault !== this.config.v2?.vault) throw new RelayError(400, "this request is for another vault");
      if (!tokenMatches(token, this.config.v2.agentTokens.get(pending.payment.agent))) {
        throw new RelayError(403, "this token is for another agent");
      }
    }
    if (paymentHashV2(pending.payment) !== pending.authorization.paymentHash) {
      throw new RelayError(400, "the authorization does not match the payment");
    }
    if (pending.authorization.authorizationExpiry < BigInt(this.now())) throw new RelayError(400, "this request has expired");
    if (pending.authorization.authorizationExpiry > BigInt(this.now() + MAX_REQUEST_LIFETIME_SECONDS)) {
      throw new RelayError(400, "this request stays open too long");
    }
    if (pending.exceededRule !== "perPaymentLimit" || pending.payment.amount <= pending.perPaymentLimit) {
      throw new RelayError(400, "this amount does not exceed the stated limit");
    }
    return pending;
  }

  /** Stores a request and alerts the owner. Repeating one request never alerts twice. */
  async submit(input: unknown, token: string | undefined): Promise<{ requestId: string; alerted: boolean; rateLimited?: boolean; needsLink?: boolean }> {
    if (isPendingV2(input)) {
      const pending = await this.validateV2(input, token);
      // Typed fields only. The agent's invoice reference is shown on the page, marked as unverified.
      const lines = (url: string) => [
        "An agent wants to spend over its limit.",
        `Agent: ${pending.payment.agent}`,
        `Requested: ${formatUsdc(pending.payment.amount)}`,
        `Recipient: ${pending.payment.recipient}`,
        `Approver asked to sign: ${pending.authorization.signer}`,
        `The agent says the limit is ${formatUsdc(pending.perPaymentLimit)} per payment.`,
        "",
        "This message proves nothing. Check the details on the approval page before signing.",
        url,
      ];
      // A registered agent's alert goes only to its approver's own chat. The configured vault can still
      // use the relay's own chat, so nothing is lost if its approver has not linked yet.
      const registered = Boolean(this.config.people?.agentByToken(token));
      const linked = this.config.people?.chatFor(pending.authorization.signer);
      if (registered && !linked) {
        return { ...(await this.hold(input, approvalDigestV2(pending), Number(pending.authorization.authorizationExpiry) + 1, pending.payment.agent)), needsLink: true };
      }
      return this.store(input, approvalDigestV2(pending), Number(pending.authorization.authorizationExpiry) + 1, pending.payment.agent, lines, linked);
    }
    if (!tokenMatches(token, this.config.agentToken)) throw new RelayError(401, "unauthorized");
    const pending = this.validate(input);
    // Typed fields only. The agent's invoice reference is shown on the page, marked as unverified.
    const lines = (url: string) => [
      "Your agent wants to spend over its limit.",
      `Requested: ${formatUsdc(pending.payment.amount)}`,
      `Recipient: ${pending.payment.recipient}`,
      `The agent says the limit is ${formatUsdc(pending.perPaymentLimit)} per payment.`,
      "",
      "This message proves nothing. Check the details on the approval page before signing.",
      url,
    ];
    return this.store(input, approvalDigest(pending), Number(pending.authorization.authorizationExpiry), undefined, lines);
  }

  /** Keeps a request without alerting anyone, so asking again after the approver links finds the same one. */
  private async hold(input: unknown, digest: Hex, expiresAt: number, agent: Address | undefined): Promise<{ requestId: string; alerted: boolean }> {
    const request = this.remember(input, digest, expiresAt, agent);
    this.save();
    return { requestId: request.id, alerted: request.alerted };
  }

  private remember(input: unknown, digest: Hex, expiresAt: number, agent: Address | undefined): Stored {
    this.prune();
    const known = this.byDigest.get(digest);
    let request = known ? this.requests.get(known) : undefined;
    if (!request) {
      if (this.requests.size >= this.config.maxRequests) throw new RelayError(429, "too many open requests");
      request = {
        id: randomBytes(16).toString("base64url"),
        digest,
        pending: input,
        expiresAt,
        alerted: false,
        ...(agent ? { agent } : {}),
      };
      this.requests.set(request.id, request);
      this.byDigest.set(digest, request.id);
    }
    return request;
  }

  private async store(
    input: unknown,
    digest: Hex,
    expiresAt: number,
    agent: Address | undefined,
    lines: (url: string) => string[],
    chatId?: string,
  ): Promise<{ requestId: string; alerted: boolean; rateLimited?: boolean }> {
    const request = this.remember(input, digest, expiresAt, agent);
    if (request.alerted) return { requestId: request.id, alerted: true };
    // A repeat while the first send is still going reports its result, and never alerts twice.
    const sending = this.sending.get(request.id);
    if (sending) return { requestId: request.id, alerted: await sending };
    // Each person has their own budget, so one vault's agent cannot use up another's alerts.
    const budget = chatId ? `approval:${chatId}` : "approval";
    const reserved = this.reserveAlertSlot(budget);
    if (reserved === undefined) {
      this.save();
      return { requestId: request.id, alerted: false, rateLimited: true };
    }
    const url = this.link(request.id);
    const delivery = this.send(budget, { text: lines(url).join("\n"), url }, reserved, chatId);
    this.sending.set(request.id, delivery);
    try {
      request.alerted = await delivery;
    } finally {
      this.sending.delete(request.id);
    }
    this.save();
    return { requestId: request.id, alerted: request.alerted };
  }

  private find(id: string): Stored {
    const request = this.requests.get(id);
    if (!request) throw new RelayError(404, "unknown request");
    if (request.expiresAt <= this.now()) throw new RelayError(410, "this request has expired");
    return request;
  }

  pending(id: string): unknown {
    return this.find(id).pending;
  }

  /** Accepts only the named signer's signature over this exact request. The first valid one stands. */
  async sign(id: string, body: unknown): Promise<void> {
    const request = this.find(id);
    const value = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const v2 = isPendingV2(request.pending);
    if (value.schema !== (v2 ? SIGNATURE_SCHEMA_V2 : SIGNATURE_SCHEMA) || typeof value.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value.signature)) {
      throw new RelayError(400, "invalid signature file");
    }
    let file: string;
    try {
      file = v2
        ? await buildSignatureFileV2(parsePendingV2(request.pending), value.signature as Hex)
        : await buildSignatureFile(parsePending(request.pending), this.ownerConfig(), value.signature as Hex);
    } catch {
      throw new RelayError(403, "this signature is not the named signer's for this request");
    }
    if (request.signature) return;
    request.signature = JSON.parse(file) as Stored["signature"];
    this.save();
  }

  signature(id: string, token: string | undefined): { status: "pending" } | { status: "signed"; signature: NonNullable<Stored["signature"]> } {
    const request = this.find(id);
    const expected = request.agent ? this.config.v2?.agentTokens.get(request.agent) : this.config.agentToken;
    const registered = this.config.people?.agentByToken(token);
    const asRegistered = request.agent !== undefined && registered?.agent === request.agent && isPendingV2(request.pending) && parsePendingV2(request.pending).vault === registered?.vault;
    if (!asRegistered && !tokenMatches(token, expected)) throw new RelayError(401, "unauthorized");
    return request.signature ? { status: "signed", signature: request.signature } : { status: "pending" };
  }

  /** A notice from the watcher, with no request attached. */
  async notice(body: unknown): Promise<{ alerted: boolean }> {
    const value = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof value.kind !== "string" || typeof value.text !== "string" || !value.kind || !value.text) {
      throw new RelayError(400, "invalid alert");
    }
    const reserved = this.reserveAlertSlot("notice");
    if (reserved === undefined) return { alerted: false };
    const clean = (s: string, max: number) => s.replace(/[^\x20-\x7e\n]/g, "").slice(0, max);
    const alerted = await this.send("notice", { text: `Vault notice (${clean(value.kind, 40)})\n${clean(value.text, 500)}` }, reserved);
    return { alerted };
  }
}
