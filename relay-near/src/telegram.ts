// Telegram alert for a new approval request: https://core.telegram.org/bots/api#sendmessage
// Plain text (no parse_mode), so nothing in a request can inject formatting or links. The alert
// carries no authority: the vault checks the approver's signature itself.
import type { Pending } from './protocol';

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

export function telegramNotifier(options: {
  botToken: string; chatId: string; pageUrl: string; relayUrl: string;
  apiBase?: string; fetch?: typeof fetch; timeoutMs?: number;
}): Notify {
  const send = options.fetch ?? fetch;
  const base = options.apiBase ?? 'https://api.telegram.org';
  return async (pending, requestId) => {
    const link = `${options.pageUrl.replace(/\/$/, '')}/?relay=${encodeURIComponent(options.relayUrl)}&request=${requestId}`;
    const body: Record<string, unknown> = { chat_id: options.chatId, text: alertText(pending, link), link_preview_options: { is_disabled: true } };
    if (link.startsWith('https://')) body.reply_markup = { inline_keyboard: [[{ text: 'Review and sign with Meteor', url: link }]] };
    try {
      const response = await send(`${base}/bot${options.botToken}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      return ((await response.json()) as { ok?: boolean }).ok === true;
    } catch {
      return false; // errors can contain the URL, which contains the bot token, so nothing is logged
    }
  };
}
