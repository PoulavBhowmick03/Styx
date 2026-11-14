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
