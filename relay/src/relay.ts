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
}

export interface Alert {
  text: string;
  /** The approval link, when this alert has one. */
  url?: string;
}

export type Notify = (alert: Alert) => Promise<boolean>;

interface Stored {
  id: string;
  digest: Hex;
  pending: unknown;
  expiresAt: number;
  alerted: boolean;
  signature?: { schema: string; paymentId: Hex; approvalDigest: Hex; signature: Hex };
}

/** A failure with the HTTP status it should produce. Messages never echo submitted values. */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function tokenMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Relay {
  private readonly requests = new Map<string, Stored>();
  private readonly byDigest = new Map<string, string>();
  private alertTimes: number[] = [];

  constructor(
    private readonly config: RelayConfig,
    private readonly notify: Notify,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
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
    let stored: Stored[];
    try {
      stored = JSON.parse(readFileSync(path, "utf8")) as Stored[];
    } catch {
      return;
    }
    for (const request of stored) {
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
    if (pending.exceededRule !== "perPaymentLimit" || pending.payment.amount <= pending.perPaymentLimit) {
      throw new RelayError(400, "this amount does not exceed the stated limit");
    }
    return pending;
  }

  private takeAlertSlot(): boolean {
    const cutoff = this.now() - 3600;
    this.alertTimes = this.alertTimes.filter((at) => at > cutoff);
    if (this.alertTimes.length >= this.config.maxAlertsPerHour) return false;
    this.alertTimes.push(this.now());
    return true;
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

  /** Stores a request and alerts the owner. Repeating one request never alerts twice. */
  async submit(input: unknown): Promise<{ requestId: string; alerted: boolean; rateLimited?: boolean }> {
    const pending = this.validate(input);
    this.prune();
    const digest = approvalDigest(pending);
    const known = this.byDigest.get(digest);
    let request = known ? this.requests.get(known) : undefined;
    if (!request) {
      if (this.requests.size >= this.config.maxRequests) throw new RelayError(429, "too many open requests");
      request = {
        id: randomBytes(16).toString("base64url"),
        digest,
        pending: input,
        expiresAt: Number(pending.authorization.authorizationExpiry),
        alerted: false,
      };
      this.requests.set(request.id, request);
      this.byDigest.set(digest, request.id);
    }
    if (request.alerted) return { requestId: request.id, alerted: true };
    if (!this.takeAlertSlot()) {
      this.save();
      return { requestId: request.id, alerted: false, rateLimited: true };
    }
    const url = this.link(request.id);
    // Typed fields only. The agent's invoice reference is shown on the page, marked as unverified.
    const text = [
      "Your agent wants to spend over its limit.",
      `Requested: ${formatUsdc(pending.payment.amount)}`,
      `Recipient: ${pending.payment.recipient}`,
      `The agent says the limit is ${formatUsdc(pending.perPaymentLimit)} per payment.`,
      "",
      "This message proves nothing. Check the details on the approval page before signing.",
      url,
    ].join("\n");
    request.alerted = await this.notify({ text, url }).catch(() => false);
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

  /** Accepts only the owner's signature over this exact request. The first valid one stands. */
  async sign(id: string, body: unknown): Promise<void> {
    const request = this.find(id);
    const value = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (value.schema !== SIGNATURE_SCHEMA || typeof value.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value.signature)) {
      throw new RelayError(400, "invalid signature file");
    }
    const pending = parsePending(request.pending);
    let file: string;
    try {
      file = await buildSignatureFile(pending, this.ownerConfig(), value.signature as Hex);
    } catch {
      throw new RelayError(403, "this signature is not the owner's for this request");
    }
    if (request.signature) return;
    request.signature = JSON.parse(file) as Stored["signature"];
    this.save();
  }

  signature(id: string): { status: "pending" } | { status: "signed"; signature: NonNullable<Stored["signature"]> } {
    const request = this.find(id);
    return request.signature ? { status: "signed", signature: request.signature } : { status: "pending" };
  }

  /** A notice from the watcher, with no request attached. */
  async notice(body: unknown): Promise<{ alerted: boolean }> {
    const value = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof value.kind !== "string" || typeof value.text !== "string" || !value.kind || !value.text) {
      throw new RelayError(400, "invalid alert");
    }
    if (!this.takeAlertSlot()) return { alerted: false };
    const clean = (s: string, max: number) => s.replace(/[^\x20-\x7e\n]/g, "").slice(0, max);
    const alerted = await this.notify({ text: `Vault notice (${clean(value.kind, 40)})\n${clean(value.text, 500)}` }).catch(() => false);
    return { alerted };
  }
}
