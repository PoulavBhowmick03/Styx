import { chainClient, type ChainEvent } from './chain';
export type TimedEvent = ChainEvent & { ns: bigint };
export const payments = new Set(['payment_executed', 'evm_payment_signed', 'x402_authorization_signed']);
export function pauseStats(pause: TimedEvent, events: TimedEvent[]) {
 // Count from the owner's last unpause before this pause: earlier payments were already reviewed.
 const since = events.filter(e => e.kind === 'unpaused' && e.ns < pause.ns).reduce<bigint | null>((v,e) => v === null || e.ns > v ? e.ns : v, null);
 const before = events.filter(e => e.kind === 'payment_executed' && e.ns < pause.ns && (since === null || e.ns > since) && typeof e.data.amount === 'string' && /^\d+$/.test(e.data.amount) && typeof e.data.recipient === 'string');
 const last = before.reduce<bigint | null>((v,e) => v === null || e.ns > v ? e.ns : v, null);
 return { count: before.length, sinceUnpause: since !== null, seconds: last === null ? null : Number(pause.ns - last) / 1e9 };
}
export async function load(vault: string, chain = chainClient()): Promise<TimedEvent[]> {
 const events = await chain.events(vault), blocks = new Map<string, bigint>();
 const out: TimedEvent[] = [];
 for (const e of events) {
  if (!payments.has(e.kind) && !['sentinel_paused','unpaused','paused'].includes(e.kind)) continue;
  if (!blocks.has(e.block)) {
   const b = await chain.rpc('block', {block_id:e.block});
   blocks.set(e.block, BigInt(b.header.timestamp_nanosec ?? b.header.timestamp));
  }
  out.push({...e, ns: blocks.get(e.block)!});
 }
 return out.sort((a,b)=>a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0);
}

export type PauseRow = { ns: bigint; sentinel: string; reason: unknown; tx: string; count: number; sinceUnpause: boolean; seconds: number | null };
/** What a reviewer needs first: totals, and one line per sentinel pause. */
export function summary(events: TimedEvent[]) {
 const settled = events.filter(e => e.kind === 'payment_executed' && typeof e.data.amount === 'string' && /^\d+$/.test(e.data.amount));
 const base = settled.reduce((n, e) => n + BigInt(e.data.amount as string), 0n);
 const pauses: PauseRow[] = events.filter(e => e.kind === 'sentinel_paused').map(e => ({
  ns: e.ns, sentinel: String(e.data.sentinel ?? ''), reason: e.data.reason, tx: e.tx, ...pauseStats(e, events) }));
 return { payments: settled.length, tokens: Number(base) / 1e6, pauses, unpauses: events.filter(e => e.kind === 'unpaused').length };
}
