// Spend alerts. A chat sends /watch <vault>; every few minutes the relay reads the vault's spend for
// today through RPC (read-only view calls: get_vault, current_day, spent_by_vault) and messages the
// chat once when spend passes 80% of the vault daily limit and once when it reaches 100%. Spend and
// limits are public on chain, so watching needs no signature; it carries no authority either.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail } from './relay';

export const MAX_WATCHES_PER_CHAT = 5, MAX_WATCHED = 2000, THRESHOLDS = [80, 100] as const;
const accountId = /^(?=.{2,64}$)([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*$/;
const chatId = /^-?[0-9]{1,20}$/;
export const isAccount = (a: string) => accountId.test(a);

// Telegram start payloads allow [A-Za-z0-9_-] only. Account ids never hold two separators in a row,
// so writing '.' as '--' is reversible.
export const watchPayload = (vault: string) => 'watch-' + vault.replace(/\./g, '--');
export function vaultFromPayload(p: string): string | null {
  if (!p.startsWith('watch-')) return null;
  const v = p.slice(6).replace(/--/g, '.');
  return isAccount(v) ? v : null;
}

// The highest threshold today's spend has reached that was not yet sent, or null.
export function crossed(spent: bigint, limit: bigint, alreadySent: number): number | null {
  if (limit <= 0n) return null;
  let hit: number | null = null;
  for (const t of THRESHOLDS) if (spent * 100n >= limit * BigInt(t) && t > alreadySent) hit = t;
  return hit;
}

export class Watches {
  private watches = new Map<string, string[]>(); // vault -> chats
  private pauses = new Set<string>();
  private sent = new Map<string, number>();       // `${vault}:${day}` -> highest threshold sent

  constructor(private file?: string) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(saved.watches) || !Array.isArray(saved.sent)) throw new Error('invalid saved watches');
      for (const id of saved.pauses ?? []) if (typeof id === 'string') this.pauses.add(id);
      for (const [v, chats] of saved.watches) {
        if (!isAccount(v) || !Array.isArray(chats) || !chats.every((c: unknown) => typeof c === 'string' && chatId.test(c))) throw new Error('invalid saved watch');
        this.watches.set(v, chats);
      }
      for (const [k, n] of saved.sent) if (typeof k === 'string' && Number.isInteger(n)) this.sent.set(k, n);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify({ watches: [...this.watches], sent: [...this.sent], pauses: [...this.pauses] }), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
  pauseSent(id: string) { return this.pauses.has(id); }
  markPause(id: string) { this.pauses.add(id); this.save(); }
  watch(chat: string, vault: string) {
    if (!chatId.test(chat) || !isAccount(vault)) return fail(400, 'invalid watch');
    const chats = this.watches.get(vault) ?? [];
    if (chats.includes(chat)) return;
    if (this.list(chat).length >= MAX_WATCHES_PER_CHAT) return fail(429, `a chat can watch at most ${MAX_WATCHES_PER_CHAT} vaults; /unwatch one first`);
    if (!this.watches.has(vault) && this.watches.size >= MAX_WATCHED) return fail(429, 'watch capacity reached');
    this.watches.set(vault, [...chats, chat]); this.save();
  }
  unwatch(chat: string, vault?: string): number {
    let n = 0;
    for (const [v, chats] of this.watches) {
      if ((vault && v !== vault) || !chats.includes(chat)) continue;
      n++; const rest = chats.filter(c => c !== chat);
      if (rest.length) this.watches.set(v, rest); else this.watches.delete(v);
    }
    if (n) this.save();
    return n;
  }
  list(chat: string): string[] { return [...this.watches].filter(([, c]) => c.includes(chat)).map(([v]) => v); }
  vaults(): [string, string[]][] { return [...this.watches]; }
  alreadySent(vault: string, day: number) { return this.sent.get(`${vault}:${day}`) ?? 0; }
  markSent(vault: string, day: number, t: number) {
    this.sent.set(`${vault}:${day}`, t);
    for (const k of this.sent.keys()) { const d = Number(k.split(':').pop()); if (d < day - 2) this.sent.delete(k); } // keep a few days
    this.save();
  }
}

export type View = (account: string, method: string, args?: Record<string, unknown>) => Promise<any>;
export function rpcView(rpcUrl: string, get: typeof fetch = fetch): View {
  return async (account_id, method_name, args = {}) => {
    const r = await get(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 'styx-watch', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
    const d = await r.json() as { result?: { result?: number[] } };
    if (!d.result?.result) throw new Error('view failed');
    return JSON.parse(Buffer.from(d.result.result).toString());
  };
}
const tokens = (base: bigint) => { const w = base / 1_000_000n, f = (base % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, ''); return f ? `${w}.${f}` : `${w}`; };
export function spendText(vault: string, spent: bigint, limit: bigint, t: number) {
  const pct = Number(spent * 100n / limit);
  return t >= 100
    ? `Styx: ${vault} has used its whole daily limit (${tokens(spent)} of ${tokens(limit)} tokens). The vault refuses further payments until the next UTC day.`
    : `Styx: ${vault} has spent ${tokens(spent)} of its ${tokens(limit)} token daily limit today (${pct}%).`;
}
// One pass over every watched vault. A vault that cannot be read is skipped until the next pass.
export async function checkVaults(w: Watches, view: View, send: (chat: string, text: string) => Promise<unknown>) {
  for (const [vault, chats] of w.vaults()) {
    try {
      const info = await view(vault, 'get_vault'), day = Number(await view(vault, 'current_day'));
      const spent = BigInt(await view(vault, 'spent_by_vault', { day })), limit = BigInt(info.vault_daily_limit);
      const t = crossed(spent, limit, w.alreadySent(vault, day));
      if (t === null) continue;
      for (const chat of chats) await send(chat, spendText(vault, spent, limit, t));
      w.markSent(vault, day, t);
    } catch { /* unreadable this pass */ }
  }
}
