// Who should be alerted. Everything here is about routing notifications: it grants no authority,
// because the vault checks every signature whatever this file believes.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";

import { claimMessage, linkMessage, MESSAGE_LIFETIME_SECONDS, registerMessage } from "../../owner-page/src/messages";
import { RelayError } from "./errors";

export interface ChainReader {
  contractVersion(vault: Address): Promise<bigint>;
  owner(vault: Address): Promise<Address>;
  token(vault: Address): Promise<Address>;
  signerEnabled(vault: Address, signer: Address): Promise<boolean>;
}

export interface RegisteredAgent {
  vault: Address;
  agent: Address;
  approver: Address;
  tokenHash: string;
}

interface Options {
  chain: ChainReader;
  chainId: bigint;
  token: Address;
  botUsername: string;
  /** The approval page, for the bot's connect button. */
  pageUrl: string;
  stateDir?: string;
  now?: () => number;
  maxAgents?: number;
  maxPendingLinks?: number;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new RelayError(400, "invalid address");
  return getAddress(value);
}

function signature(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value)) throw new RelayError(400, "invalid signature");
  return value as Hex;
}

export class People {
  private readonly chats = new Map<Address, string>();
  private readonly codes = new Map<string, { wallet: Address; expiresAt: number }>();
  private readonly chatCodes = new Map<string, { chatId: string; telegram: string; expiresAt: number }>();
  private readonly agents = new Map<string, RegisteredAgent>();
  private chain: ChainReader;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.chain = options.chain;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.load();
  }

  /** Lets a test change what the chain reports. */
  setChainForTest(chain: ChainReader): void {
    this.chain = chain;
  }

  private path(): string | undefined {
    return this.options.stateDir ? join(this.options.stateDir, "people.json") : undefined;
  }

  private load(): void {
    const path = this.path();
    if (!path) return;
    try {
      const stored = JSON.parse(readFileSync(path, "utf8")) as { chats?: [string, string][]; agents?: RegisteredAgent[] };
      for (const [wallet, chat] of stored.chats ?? []) if (isAddress(wallet) && typeof chat === "string") this.chats.set(wallet, chat);
      for (const agent of stored.agents ?? []) {
        if (isAddress(agent?.vault) && isAddress(agent?.agent) && isAddress(agent?.approver) && typeof agent?.tokenHash === "string") {
          this.agents.set(agent.tokenHash, agent);
        }
      }
    } catch {
      // No file yet, or a damaged one. People link again, and the vault still decides.
    }
  }

  private save(): void {
    const path = this.path();
    if (!path) return;
    mkdirSync(this.options.stateDir!, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify({ chats: [...this.chats], agents: [...this.agents.values()] }), { mode: 0o600 });
    renameSync(temporary, path);
  }

  private fresh(issuedAt: unknown): number {
    if (typeof issuedAt !== "number" && typeof issuedAt !== "string") throw new RelayError(400, "invalid time");
    const value = Number(issuedAt);
    if (!Number.isSafeInteger(value)) throw new RelayError(400, "invalid time");
    if (Math.abs(this.now() - value) > MESSAGE_LIFETIME_SECONDS) throw new RelayError(400, "this signature is too old. Sign again");
    return value;
  }

  /** A wallet proves itself by signing, and gets a one-time code for the bot. */
  async startLink(body: unknown): Promise<{ code: string; botUrl: string }> {
    const value = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const wallet = address(value.wallet);
    const issuedAt = this.fresh(value.issuedAt);
    const recovered = await recoverMessageAddress({ message: linkMessage(wallet, issuedAt), signature: signature(value.signature) }).catch(() => undefined);
    if (recovered !== wallet) throw new RelayError(403, "this signature is not from that wallet");
    for (const [code, entry] of this.codes) if (entry.expiresAt <= this.now()) this.codes.delete(code);
    if (this.codes.size >= (this.options.maxPendingLinks ?? 1000)) throw new RelayError(429, "too many open links. Try again soon");
    const code = randomBytes(16).toString("base64url");
    this.codes.set(code, { wallet, expiresAt: this.now() + MESSAGE_LIFETIME_SECONDS });
    return { code, botUrl: `https://t.me/${this.options.botUsername}?start=${code}` };
  }

  /** The code works once, and only for the wallet that asked for it. */
  completeLink(code: string, chatId: string): Address | undefined {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry || entry.expiresAt <= this.now()) return undefined;
    this.chats.set(entry.wallet, chatId);
    this.save();
    return entry.wallet;
  }

  /** The bot's side: someone pressed Start, so this chat gets a one-time connect link. */
  codeForChat(chatId: string, telegram: string): string {
    for (const [code, entry] of this.chatCodes) if (entry.expiresAt <= this.now() || entry.chatId === chatId) this.chatCodes.delete(code);
    if (this.chatCodes.size >= (this.options.maxPendingLinks ?? 1000)) throw new RelayError(429, "too many open links. Try again soon");
    const code = randomBytes(16).toString("base64url");
    this.chatCodes.set(code, { chatId, telegram: telegram.slice(0, 64), expiresAt: this.now() + MESSAGE_LIFETIME_SECONDS });
    return code;
  }

  connectUrl(code: string): string {
    const url = new URL(this.options.pageUrl);
    url.searchParams.set("link", code);
    return url.toString();
  }

  /** Lets the page show who is asking, so someone can notice a link that is not theirs. */
  describeCode(code: string): { telegram: string } | undefined {
    const entry = this.chatCodes.get(code);
    return entry && entry.expiresAt > this.now() ? { telegram: entry.telegram } : undefined;
  }

  /** The wallet signs over the bot's code, which joins that wallet to that chat. */
  async claim(body: unknown): Promise<{ linked: true; wallet: Address; telegram: string }> {
    const value = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const wallet = address(value.wallet);
    const issuedAt = this.fresh(value.issuedAt);
    if (typeof value.code !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(value.code)) throw new RelayError(400, "invalid code");
    const entry = this.chatCodes.get(value.code);
    if (!entry || entry.expiresAt <= this.now()) throw new RelayError(410, "this link expired or was used. Press Start in the bot again");
    const recovered = await recoverMessageAddress({ message: claimMessage(wallet, issuedAt, value.code), signature: signature(value.signature) }).catch(() => undefined);
    if (recovered !== wallet) throw new RelayError(403, "this signature is not from that wallet");
    this.chatCodes.delete(value.code);
    this.chats.set(wallet, entry.chatId);
    this.save();
    return { linked: true, wallet, telegram: entry.telegram };
  }

  isLinked(wallet: Address): boolean {
    return this.chats.has(wallet);
  }

  chatFor(wallet: Address): string | undefined {
    return this.chats.get(wallet);
  }

  /** The vault's owner chooses an agent's approver, by signing. The token is only ever returned here. */
  async register(body: unknown): Promise<{ token: string }> {
    const value = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (value.chainId !== this.options.chainId.toString()) throw new RelayError(400, "this relay serves another chain");
    const vault = address(value.vault), agent = address(value.agent), approver = address(value.approver);
    const issuedAt = this.fresh(value.issuedAt);
    const message = registerMessage(this.options.chainId, vault, agent, approver, issuedAt);
    const recovered = await recoverMessageAddress({ message, signature: signature(value.signature) }).catch(() => undefined);
    let owner: Address, version: bigint, token: Address, enabled: boolean;
    try {
      [version, owner, token, enabled] = await Promise.all([
        this.chain.contractVersion(vault),
        this.chain.owner(vault),
        this.chain.token(vault),
        this.chain.signerEnabled(vault, approver),
      ]);
    } catch {
      throw new RelayError(503, "the vault could not be read. Try again");
    }
    if (version !== 2n) throw new RelayError(400, "this address is not a Styx vault");
    if (token !== this.options.token) throw new RelayError(400, "this vault holds another token");
    if (recovered !== owner) throw new RelayError(403, "only the vault's owner can register an agent");
    if (!enabled) throw new RelayError(400, "the vault does not list that approver. Add them first");
    const stale = [...this.agents.entries()].find(([, entry]) => entry.vault === vault && entry.agent === agent);
    if (!stale && this.agents.size >= (this.options.maxAgents ?? 2000)) throw new RelayError(429, "this relay is full");
    if (stale) this.agents.delete(stale[0]);
    const issued = randomBytes(32).toString("hex");
    this.agents.set(hash(issued), { vault, agent, approver, tokenHash: hash(issued) });
    this.save();
    return { token: issued };
  }

  agentByToken(token: string | undefined): RegisteredAgent | undefined {
    return token ? this.agents.get(hash(token)) : undefined;
  }

  /** False only when the chain answers that this signer may not approve. An unreadable chain is not a no. */
  async stillApprover(vault: Address, signer: Address): Promise<boolean> {
    try {
      return await this.chain.signerEnabled(vault, signer);
    } catch {
      return true;
    }
  }
}

export interface BotUpdate {
  update_id?: number;
  message?: { chat?: { id?: number | string }; from?: { username?: string; first_name?: string }; text?: string };
}

/** What the bot says to a message. It only ever acts on a one-time code. */
export function botReply(people: People, update: BotUpdate): { chatId: string; text: string; url?: string; button?: string } | undefined {
  const chat = update.message?.chat?.id;
  if (chat === undefined) return undefined;
  const chatId = String(chat);
  const match = /^\/start\s+([A-Za-z0-9_-]{16,64})\s*$/.exec(update.message?.text ?? "");
  if (match) {
    const wallet = people.completeLink(match[1]!, chatId);
    return wallet
      ? { chatId, text: `Linked. Approval requests for ${wallet} will come to this chat. An alert never moves money: you always review and sign on the page.` }
      : { chatId, text: "That link expired or was used. Send /start to get a new one." };
  }
  const from = update.message?.from;
  const telegram = from?.username ? `@${from.username}` : from?.first_name ?? "this Telegram account";
  const url = people.connectUrl(people.codeForChat(chatId, telegram));
  return {
    chatId,
    text: "Connect the wallet you approve payments with, and approval requests for it will come to this chat. You sign once to prove the wallet is yours. It costs nothing and moves no money. This works once, for 10 minutes.\n\n" + url,
    url,
    button: "Connect my wallet",
  };
}

/** Long-polls Telegram. No webhook, so the bot needs no public endpoint of its own. */
export async function runBot(options: { botToken: string; apiBase?: string; people: People; send: (chatId: string, reply: { text: string; url?: string; button?: string }) => Promise<unknown> }): Promise<never> {
  const base = options.apiBase ?? "https://api.telegram.org";
  let offset = 0;
  for (;;) {
    try {
      const response = await fetch(`${base}/bot${options.botToken}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`, { signal: AbortSignal.timeout(35_000) });
      const body = (await response.json()) as { ok?: boolean; result?: BotUpdate[] };
      for (const update of body.result ?? []) {
        if (typeof update.update_id === "number") offset = update.update_id + 1;
        const reply = botReply(options.people, update);
        if (reply) await options.send(reply.chatId, reply).catch(() => undefined);
      }
    } catch {
      // Errors can contain the URL, which contains the bot token, so nothing is logged.
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
