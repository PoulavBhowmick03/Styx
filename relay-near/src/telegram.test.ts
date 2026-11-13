import { describe, expect, it } from 'vitest';
import { alertText, telegramNotifier, usdc } from './telegram';

const pending = {
  schema: 'styx-near-pending/1', network: 'testnet', rpcUrl: 'https://rpc', vault: 'vault-v2.owner.testnet', token: 'usdc.owner.testnet',
  chainId: 84532,
  payment: { payment_id: '0x' + 'ab'.repeat(32), agent: 'ed25519:A', chain_id: 84532, recipient: '0xf4d88218d13333247bf7616affb45f24a21e07cc', amount: '6000000' },
  authorization: { signer: 'ed25519:Signer' }, message: 'm', invoiceReference: 'INV-9', perPaymentLimit: '5000000', exceededRule: 'perPaymentLimit',
} as never;

describe('telegram alert', () => {
  it('formats USDC amounts', () => {
    expect(usdc('6000000')).toBe('6');
    expect(usdc('12500000')).toBe('12.5');
    expect(usdc('1')).toBe('0.000001');
  });
  it('says what is asked, on which chain, and links the page', () => {
    const text = alertText(pending, 'https://page/?request=x');
    expect(text).toContain('Amount: 6 USDC');
    expect(text).toContain('Base Sepolia');
    expect(text).toContain('Per-payment limit: 5 USDC');
    expect(text).toContain('Review and sign: https://page/?request=x');
  });
  it('sends one plain-text message with a button for https links, and reports failure', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fake = (async (url: string, init: { body: string }) => { calls.push({ url, body: JSON.parse(init.body) }); return { json: async () => ({ ok: true }) }; }) as never;
    const notify = telegramNotifier({ botToken: 'T', chatId: '42', pageUrl: 'https://page.example', relayUrl: 'https://relay.example', fetch: fake });
    expect(await notify(pending, 'abc')).toBe(true);
    expect(calls[0].url).toBe('https://api.telegram.org/botT/sendMessage');
    expect(calls[0].body.chat_id).toBe('42');
    expect(calls[0].body.parse_mode).toBeUndefined();
    expect(JSON.stringify(calls[0].body.reply_markup)).toContain('https://page.example/?relay=https%3A%2F%2Frelay.example&request=abc');
    const broken = telegramNotifier({ botToken: 'T', chatId: '42', pageUrl: 'https://p', relayUrl: 'https://r', fetch: (async () => { throw new Error('down'); }) as never });
    expect(await broken(pending, 'abc')).toBe(false);
  });
});
