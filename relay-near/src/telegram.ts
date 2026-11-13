// Telegram alert for a new approval request: https://core.telegram.org/bots/api#sendmessage
// Plain text (no parse_mode), so nothing in a request can inject formatting or links. The alert
// carries no authority: the vault checks the approver's signature itself.
import type { Pending } from './protocol';
import { type Watches, vaultFromPayload, isAccount } from './watches';

export type Notify = (pending: Pending, requestId: string) => Promise<boolean>;

const CHAINS: Record<string, string> = { '5042002': 'Arc testnet', '84532': 'Base Sepolia' };

export function usdc(baseUnits: string): string {
  const v = BigInt(baseUnits), whole = v / 1_000_000n, frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function alertText(p: Pending, link: string): string {
  const payment = p.payment as Record<string, unknown>;
  const chainId = (p as Record<string, unknown>).chainId ?? payment.chain_id;
  const where = chainId ? `${CHAINS[String(chainId)] ?? 'chain ' + chainId}, paid by the vault through NEAR Chain Signatures` : 'NEAR';
  return [
    'Styx: an agent asks to go over its per-payment limit.',
    `Vault: ${p.vault}`,
    `Amount: ${usdc(String(payment.amount))} USDC`,
    `Recipient: ${payment.recipient}`,
    `On: ${where}`,
    `Per-payment limit: ${usdc(p.perPaymentLimit)} USDC`,
    `Invoice: ${p.invoiceReference}`,
    `Approver key asked to sign: ${p.authorization.signer}`,
    '',
    `Review and sign with Meteor Wallet: ${link}`,
    'On a phone, copy this link and open it in the Meteor app\'s browser: the app then signs it directly.',
    'Nothing is paid unless you sign this exact payment in your NEAR wallet.',
  ].join('\n');
}

type Api = { botToken: string; apiBase?: string; fetch?: typeof fetch; timeoutMs?: number };

// One Bot API call. Errors can contain the URL, which contains the bot token, so nothing is logged.
async function call(api: Api, method: string, body: Record<string, unknown>, timeoutMs = api.timeoutMs ?? 10_000): Promise<{ ok?: boolean; result?: unknown } | undefined> {
  try {
    const response = await (api.fetch ?? fetch)(`${api.apiBase ?? 'https://api.telegram.org'}/bot${api.botToken}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    return (await response.json()) as { ok?: boolean; result?: unknown };
  } catch { return undefined; }
}

const page = (pageUrl: string, relayUrl: string, param: string, value: string) =>
  `${pageUrl.replace(/\/$/, '')}/?relay=${encodeURIComponent(relayUrl)}&${param}=${value}`;
const button = (link: string, text: string) => link.startsWith('https://') ? { reply_markup: { inline_keyboard: [[{ text, url: link }]] } } : {};
const send = (api: Api, chatId: string, text: string, extra: Record<string, unknown> = {}) =>
  call(api, 'sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...extra }).then(r => r?.ok === true);

// Alerts go to the chats linked to the approver key the request asks to sign. With none linked,
// they go to the optional fallback chat (TELEGRAM_CHAT_ID), so a single-owner setup keeps working.
// The owner console link that opens the review to disable this agent (owner signs; the bot cannot).
export function freezeLink(consoleUrl: string, p: Pending): string {
  const u = new URL(consoleUrl);
  u.search = ''; u.hash = '';
  u.searchParams.set('vault', p.vault); u.searchParams.set('network', p.network); u.searchParams.set('freeze', p.payment.agent);
  return u.toString();
}

export function telegramNotifier(options: Api & {
  chatId?: string; chats?: (publicKey: string) => string[]; pageUrl: string; relayUrl: string; consoleUrl?: string;
}): Notify {
  return async (pending, requestId) => {
    const link = page(options.pageUrl, options.relayUrl, 'request', requestId);
    const linked = options.chats?.(pending.authorization.signer) ?? [];
    const to = linked.length ? linked : options.chatId ? [options.chatId] : [];
    const freeze = options.consoleUrl ? freezeLink(options.consoleUrl, pending) : undefined;
    const text = alertText(pending, link) + (freeze ? `\n\nNot expected? The vault owner can freeze this agent: ${freeze}` : '');
    const markup = button(link, 'Review and sign with Meteor') as { reply_markup?: { inline_keyboard: { text: string; url: string }[][] } };
    if (freeze?.startsWith('https://') && markup.reply_markup) markup.reply_markup.inline_keyboard.push([{ text: 'Freeze this agent (owner)', url: freeze }]);
    const sent = await Promise.all(to.map(chat => send(options, chat, text, markup)));
    return sent.some(Boolean);
  };
}

type Chats = {
  create(chatId: string): string; unlink(chatId: string): number; keysFor(chatId: string): string[];
  offset: number; setOffset(offset: number): void;
};
type Update = { update_id: number; message?: { text?: string; chat?: { id?: number; type?: string } } };

export const HELP = [
  'Styx sends you approval alerts: when an agent asks to pay over its limit and your NEAR key is the approver asked to sign.',
  '',
  '/start: link your NEAR wallet to this chat',
  '/status: the keys linked and vaults watched in this chat',
  '/unlink: stop all approval alerts to this chat',
  '/watch <vault>: a message when the vault passes 80% and 100% of its daily limit',
  '/unwatch <vault>: stop those (or /unwatch for all)',
].join('\n');

export function telegramBot(options: Api & { pageUrl: string; relayUrl: string; links: Chats; watches?: Watches; retryMs?: number }) {
  const { links } = options;
  let running = false;
  async function handle(update: Update) {
    const chat = update.message?.chat;
    // Private chats only: in a group, anyone present could follow the link and see the alerts.
    if (chat?.type !== 'private' || typeof chat.id !== 'number') return;
    const words = (update.message?.text ?? '').trim().split(/\s+/), chatId = String(chat.id), command = words[0].split('@')[0], arg = words.slice(1).join(' ');
    const watches = options.watches;
    const watch = async (vault: string) => {
      try { watches!.watch(chatId, vault); await send(options, chatId, `Watching ${vault}. You get a message here when it passes 80% and 100% of its daily limit. Send /unwatch ${vault} to stop.`); }
      catch (e) { await send(options, chatId, `Not watching: ${e instanceof Error ? e.message : String(e)}`); }
    };
    // A t.me deep link ?start=watch-<vault> watches that vault; any other payload is a plain /start.
    if (command === '/start' && watches && vaultFromPayload(arg)) await watch(vaultFromPayload(arg)!);
    else if (command === '/watch' && watches) {
      if (!isAccount(arg)) await send(options, chatId, 'Send /watch followed by the vault account, for example /watch acme.styx-vaults.testnet');
      else await watch(arg);
    } else if (command === '/unwatch' && watches) {
      const n = watches.unwatch(chatId, arg || undefined);
      await send(options, chatId, n ? `Stopped spend alerts for ${n} vault${n === 1 ? '' : 's'}.` : 'This chat was not watching that.');
    } else if (command === '/start') {
      const link = page(options.pageUrl, options.relayUrl, 'link', links.create(chatId));
      await send(options, chatId, [
        'Link your NEAR wallet to get Styx approval alerts in this chat.',
        '',
        'Open the link and sign the link message in Meteor Wallet. It proves you hold the key and cannot move funds. The link works once and expires in 15 minutes.',
        'On a phone, copy the link and open it in the Meteor app\'s browser.',
        '',
        link,
      ].join('\n'), button(link, 'Link my NEAR wallet'));
    } else if (command === '/status') {
      const keys = links.keysFor(chatId);
      const watched = watches?.list(chatId) ?? [];
      await send(options, chatId, (keys.length ? `This chat gets alerts for:\n${keys.join('\n')}` : 'No key is linked to this chat. Send /start to link one.') + (watched.length ? `\n\nWatching spend of:\n${watched.join('\n')}` : ''));
    } else if (command === '/unlink') {
      const n = links.unlink(chatId);
      await send(options, chatId, n ? `Unlinked ${n} key${n === 1 ? '' : 's'}. This chat gets no more Styx alerts.` : 'No key was linked to this chat.');
    } else {
      await send(options, chatId, HELP);
    }
  }
  async function poll() {
    while (running) {
      const r = await call(options, 'getUpdates', { offset: links.offset, timeout: 25, allowed_updates: ['message'] }, 35_000);
      if (!r?.ok || !Array.isArray(r.result)) { await new Promise(res => setTimeout(res, options.retryMs ?? 5_000)); continue; }
      for (const update of r.result as Update[]) {
        // Saved before handling: one failed reply must not make the relay answer the same message forever.
        links.setOffset(update.update_id + 1);
        await handle(update);
      }
    }
  }
  return {
    handle,
    start() { if (!running) { running = true; void poll(); } },
    stop() { running = false; },
    say: (chatId: string, text: string) => send(options, chatId, text),
    linked: (chatId: string, publicKey: string, accountId: string) =>
      send(options, chatId, `Linked. This chat now gets Styx approval alerts for ${publicKey} (account ${accountId}, as your wallet reported it).\nSend /unlink to stop them.`),
  };
}
