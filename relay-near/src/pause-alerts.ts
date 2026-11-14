import { chainClient, reasonText, type ChainEvent } from './chain';
import { type Watches, type View } from './watches';
// Per Watches store and vault: transaction hashes already read. A restart reads the history once more;
// the durable pause ids keep that from sending anything twice.
type Scan = { known: Set<string>; unhandled: ChainEvent[] };
const scanned = new WeakMap<Watches, Map<string, Scan>>();
export async function checkPauses(w: Watches, view: View, chatsForKey: (key: string) => string[], send: (chat: string, text: string) => Promise<boolean>, chain = chainClient()) {
  for (const [vault] of w.vaults()) {
    try {
      const info = await view(vault, 'get_vault');
      const keys = await chain.rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: info.owner });
      const chats = [...new Set<string>(keys.keys.filter((k: any) => k.access_key?.permission === 'FullAccess').flatMap((k: any) => chatsForKey(k.public_key)))];
      if (!chats.length) continue;
      const byVault = scanned.get(w) ?? new Map<string, Scan>(); scanned.set(w, byVault);
      const scan = byVault.get(vault) ?? { known: new Set<string>(), unhandled: [] }; byVault.set(vault, scan);
      // Events read but not yet handled stay in scan.unhandled until this pass gets through them;
      // a failed request or alert keeps them for the next pass instead of losing them.
      const got = await chain.events(vault, scan.known, scan.unhandled);
      if (got !== scan.unhandled) for (const e of got) if (!scan.unhandled.some(u => u.id === e.id)) scan.unhandled.push(e);
      const pauses = scan.unhandled.filter(e => e.kind === 'sentinel_paused' && typeof e.data.sentinel === 'string');
      let alert = pauses;
      if (!w.pauseSent(`${vault}:baseline`)) {
        // First pass with a linked chat: past pauses are history, not news. Alert only the latest,
        // and only while the vault is still paused; record the rest as already seen.
        let latest: (typeof pauses)[number] | undefined, best = -1n;
        if (info.paused) for (const e of pauses) {
          const b = await chain.rpc('block', { block_id: e.block });
          const ns = BigInt(b.header.timestamp_nanosec ?? b.header.timestamp);
          if (ns > best) { best = ns; latest = e; }
        }
        for (const e of pauses) if (e !== latest) for (const chat of chats) w.markPause(`${vault}:${e.id}:${chat}`);
        w.markPause(`${vault}:baseline`);
        alert = latest ? [latest] : [];
      }
      for (const e of alert) {
        if (typeof e.data.sentinel !== 'string') continue;
        const key = e.data.sentinel;
        const text = `Styx: ${vault} paused by sentinel ${key.slice(0, 14)}…${key.slice(-6)}\nReason: ${reasonText(e.data.reason)}\nTransaction: https://testnet.nearblocks.io/txns/${encodeURIComponent(e.tx)}\nUnpause: https://styxco.xyz/console/?vault=${encodeURIComponent(vault)}&network=testnet#sentinels`;
        for (const chat of chats) {
          const id = `${vault}:${e.id}:${chat}`;
          if (w.pauseSent(id)) continue;
          // Reserve durably before Telegram: a crash cannot replay a pause.
          w.markPause(id);
          await send(chat, text);
        }
      }
      scan.unhandled.length = 0;
    } catch { /* retry chain reads next pass */ }
  }
}
