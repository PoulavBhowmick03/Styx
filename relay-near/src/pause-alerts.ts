import { chainClient, reasonText } from './chain';
import { type Watches, type View } from './watches';
export async function checkPauses(w: Watches, view: View, chatsForKey: (key: string) => string[], send: (chat: string, text: string) => Promise<boolean>, chain = chainClient()) {
  for (const [vault] of w.vaults()) {
    try {
      const info = await view(vault, 'get_vault');
      const keys = await chain.rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: info.owner });
      const chats = [...new Set<string>(keys.keys.filter((k: any) => k.access_key?.permission === 'FullAccess').flatMap((k: any) => chatsForKey(k.public_key)))];
      if (!chats.length) continue;
      for (const e of await chain.events(vault)) {
        if (e.kind !== 'sentinel_paused' || typeof e.data.sentinel !== 'string') continue;
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
    } catch { /* retry chain reads next pass */ }
  }
}
