// Indexers name transactions; only successful vault receipts supply events.
export type ChainEvent = { id: string; kind: string; tx: string; block: string; data: Record<string, unknown> };
export function parseEvents(tx: any, vault: string): ChainEvent[] {
  const events: ChainEvent[] = [];
  for (const [ri, receipt] of (tx.receipts_outcome ?? []).entries()) {
    const o = receipt.outcome;
    if (o?.executor_id !== vault || !(o.status && ('SuccessValue' in o.status || 'SuccessReceiptId' in o.status))) continue;
    for (const [li, line] of (o.logs ?? []).entries()) {
      if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(line.slice(11));
        if (e.standard !== 'styx' || !Array.isArray(e.data)) continue;
        for (const [di, data] of e.data.entries()) if (data && typeof data === 'object' && !Array.isArray(data))
          events.push({ id: `${tx.transaction.hash}:${receipt.id ?? ri}:${li}:${di}`, kind: e.event,
            tx: tx.transaction.hash, block: receipt.block_hash, data });
      } catch { /* unrelated or malformed log */ }
    }
  }
  return events;
}
export function chainClient(get: typeof fetch = fetch, rpcUrl = 'https://test.rpc.fastnear.com') {
  async function post(url: string, body: unknown) {
    const r = await get(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('Chain request failed'); return r.json();
  }
  async function rpc(method: string, params: unknown) {
    const r = await post(rpcUrl, { jsonrpc: '2.0', id: 'styx-events', method, params });
    if (r.error || !r.result) throw new Error('RPC confirmation failed'); return r.result;
  }
  // `known` carries the hashes already read across calls, so a watcher pays RPC only for new
  // transactions: re-reading a vault's whole history each pass gets rate-limited (429).
  // `sink` receives events as each transaction is read, so progress survives a failed request.
  async function events(vault: string, known?: Set<string>, sink?: ChainEvent[]): Promise<ChainEvent[]> {
    const out: ChainEvent[] = sink ?? [], seen = known ?? new Set<string>(); let cursor: number | null = null;
    for (;;) {
      const page = await post('https://tx.test.fastnear.com/v0/account', { account_id: vault, max_block_height: cursor });
      const rows = page.account_txs;
      if (!Array.isArray(rows)) throw new Error('Invalid transaction listing');
      const hashes = [...new Set<string>(rows.map((r: any) => r.transaction_hash).filter((h: unknown) => typeof h === 'string'))].filter(h => !seen.has(h));
      for (let i = 0; i < hashes.length; i += 20) {
        const batch = await post('https://tx.test.fastnear.com/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) });
        for (const h of hashes.slice(i, i + 20)) {
          const listed = batch.transactions?.find((t: any) => t.transaction?.hash === h)?.transaction;
          if (!listed?.signer_id) throw new Error('Missing transaction signer');
          const tx = await rpc('tx', { tx_hash: h, sender_account_id: listed.signer_id, wait_until: 'FINAL' });
          if (tx.transaction?.hash !== h) throw new Error('Transaction hash mismatch');
          out.push(...parseEvents(tx, vault)); seen.add(h);
        }
      }
      if (!rows.length) break;
      // FastNEAR returns every transaction it counts on the first page and does not move on
      // max_block_height, so stop once all of txs_count are read; otherwise page down.
      if (Number.isSafeInteger(page.txs_count) && seen.size >= page.txs_count) break;
      const next = Math.min(...rows.map((r: any) => Number(r.tx_block_height))) - 1;
      if (!Number.isSafeInteger(next) || next < 0 || (cursor !== null && next >= cursor)) throw new Error('Invalid listing cursor');
      cursor = next;
    }
    return out;
  }
  return { rpc, events };
}
export function reasonText(value: unknown): string {
  if (typeof value !== 'string') return '';
  let out = ''; for (const c of value) { if (new TextEncoder().encode(out + c).length > 280) break; out += c; } return out;
}
