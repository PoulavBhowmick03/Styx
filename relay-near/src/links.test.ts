import { it, expect, describe } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Links, CODE_TTL, MAX_CHATS_PER_KEY } from './links';
import { Relay, server } from './relay';
import { telegramBot, telegramNotifier, HELP } from './telegram';
import { fixture } from './fixture';

const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
const other = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(10));
const pk = (p = pair) => 'ed25519:' + bs58.encode(p.publicKey);
// Independent manual NEP-413 encoding, rather than the production borsh helper.
function signLink(code: string, p = pair, overrides: Record<string, unknown> = {}) {
  const str = (s: string) => { const b = Buffer.from(s), size = Buffer.alloc(4); size.writeUInt32LE(b.length); return Buffer.concat([size, b]); };
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2147484061);
  const message = `Styx: send approval alerts for this key to the Telegram chat that asked for this link.\nCode: ${code}`;
  const payload = Buffer.concat([tag, str(message), Buffer.from(code, 'base64url'), str('styx-telegram-link'), Buffer.from([0])]);
  const signature = Buffer.from(nacl.sign.detached(createHash('sha256').update(payload).digest(), p.secretKey)).toString('base64');
  return { schema: 'styx-near-telegram-link/1', code, accountId: 'approver.testnet', publicKey: pk(p), signature, ...overrides };
}

describe('links', () => {
  it('links a key to the chat that asked, once, and persists it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-links-'));
    try {
      const file = join(dir, 'links.json'), links = new Links(file, () => 1000), code = links.create('42');
      expect(Buffer.from(code, 'base64url')).toHaveLength(32);
      expect(links.link(signLink(code))).toEqual({ chatId: '42', publicKey: pk(), accountId: 'approver.testnet' });
      expect(() => links.link(signLink(code))).toThrow('unknown or used');
      links.setOffset(77);
      const loaded = new Links(file, () => 1000);
      expect(loaded.chats(pk())).toEqual(['42']);
      expect(loaded.keysFor('42')).toEqual([pk()]);
      expect(loaded.offset).toBe(77);
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('refuses a bad signature without using up the code', () => {
    const links = new Links(undefined, () => 1000), code = links.create('42');
    expect(() => links.link({ ...signLink(code), publicKey: pk(other) })).toThrow('invalid NEP-413');
    expect(() => links.link(signLink(links.create('43'), pair, { code }))).toThrow('invalid NEP-413');
    expect(links.chats(pk(other))).toEqual([]);
    expect(links.link(signLink(code)).chatId).toBe('42');
  });
  it('refuses expired, unknown and malformed links', () => {
    let now = 1000;
    const links = new Links(undefined, () => now), code = links.create('42');
    now += CODE_TTL;
    expect(() => links.link(signLink(code))).toThrow('expired');
    expect(() => links.link(signLink('A'.repeat(43)))).toThrow('unknown');
    expect(() => links.link({ ...signLink(links.create('42')), extra: 1 })).toThrow('invalid link');
    expect(() => links.create('not-a-chat')).toThrow('invalid chat');
  });
  it('unlinks a chat from every key and caps chats per key', () => {
    const links = new Links(undefined, () => 1000);
    links.link(signLink(links.create('42')));
    links.link(signLink(links.create('42'), other));
    expect(links.keysFor('42')).toHaveLength(2);
    expect(links.unlink('42')).toBe(2);
    expect(links.chats(pk())).toEqual([]);
    for (let i = 0; i < MAX_CHATS_PER_KEY; i++) links.link(signLink(links.create(String(100 + i))));
    expect(() => links.link(signLink(links.create('999')))).toThrow('at most');
  });
  it('fails startup on corrupt saved links', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-links-'));
    try {
      const file = join(dir, 'links.json');
      writeFileSync(file, JSON.stringify({ offset: 0, links: [['ed25519:bad', ['42']]] }));
      expect(() => new Links(file)).toThrow('invalid saved link');
    } finally { rmSync(dir, { recursive: true }); }
  });
});

type Sent = { method: string; body: Record<string, any> };
function fakeTelegram(updates: unknown[][] = []) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: { body: string }) => {
    const method = url.split('/').pop()!, body = JSON.parse(init.body);
    sent.push({ method, body });
    // Drained: answer ok:false so the poller takes its retry wait (real getUpdates long-polls instead).
    return { json: async () => method === 'getUpdates' ? (updates.length ? { ok: true, result: updates.shift() } : { ok: false }) : { ok: true } };
  }) as never;
  return { sent, fetch, messages: () => sent.filter(s => s.method === 'sendMessage') };
}
const msg = (update_id: number, text: string, type = 'private', id = 42) => ({ update_id, message: { text, chat: { id, type } } });
const opts = { botToken: 'T', pageUrl: 'https://page.example', relayUrl: 'https://relay.example' };

describe('telegram bot', () => {
  it('answers /start with a one-time link, and /status and /unlink', async () => {
    const tg = fakeTelegram(), links = new Links(undefined, () => 1000), bot = telegramBot({ ...opts, links, fetch: tg.fetch });
    await bot.handle(msg(1, '/start'));
    const reply = tg.messages()[0].body, url = reply.reply_markup.inline_keyboard[0][0].url as string;
    expect(reply.chat_id).toBe('42');
    expect(reply.parse_mode).toBeUndefined();
    expect(url).toMatch(/^https:\/\/page\.example\/\?relay=https%3A%2F%2Frelay\.example&link=[A-Za-z0-9_-]{43}$/);
    links.link(signLink(new URL(url).searchParams.get('link')!));
    await bot.handle(msg(2, '/status'));
    expect(tg.messages()[1].body.text).toContain(pk());
    await bot.handle(msg(3, '/unlink'));
    expect(tg.messages()[2].body.text).toContain('Unlinked 1 key');
    expect(links.chats(pk())).toEqual([]);
    await bot.handle(msg(4, 'hello'));
    expect(tg.messages()[3].body.text).toBe(HELP);
  });
  it('treats a t.me deep link (/start <payload>) as /start', async () => {
    const tg = fakeTelegram(), links = new Links(undefined, () => 1000), bot = telegramBot({ ...opts, links, fetch: tg.fetch });
    await bot.handle(msg(1, '/start approver'));
    expect(tg.messages()[0].body.reply_markup.inline_keyboard[0][0].url).toMatch(/&link=[A-Za-z0-9_-]{43}$/);
  });
  it('ignores groups and channels', async () => {
    const tg = fakeTelegram(), bot = telegramBot({ ...opts, links: new Links(), fetch: tg.fetch });
    await bot.handle(msg(1, '/start', 'group', -100));
    await bot.handle({ update_id: 2 } as never);
    expect(tg.sent).toEqual([]);
  });
  it('polls updates from the saved offset and advances it', async () => {
    const tg = fakeTelegram([[msg(5, '/status'), msg(6, '/status')]]), links = new Links();
    links.offset = 5;
    const bot = telegramBot({ ...opts, links, fetch: tg.fetch, retryMs: 1 });
    bot.start();
    await new Promise(r => setTimeout(r, 30));
    bot.stop();
    expect(tg.sent[0]).toMatchObject({ method: 'getUpdates', body: { offset: 5, allowed_updates: ['message'] } });
    expect(tg.messages()).toHaveLength(2);
    expect(links.offset).toBe(7);
  });
});

describe('alert routing', () => {
  const pending = () => { const p = fixture(); p.authorization.signer = pk(); return p; };
  it('alerts the chats linked to the signer, not the fallback', async () => {
    const tg = fakeTelegram(), links = new Links(undefined, () => 1000);
    links.link(signLink(links.create('42')));
    links.link(signLink(links.create('43')));
    const notify = telegramNotifier({ ...opts, chatId: '7', chats: k => links.chats(k), fetch: tg.fetch });
    expect(await notify(pending(), 'r'.repeat(43))).toBe(true);
    expect(tg.messages().map(m => m.body.chat_id).sort()).toEqual(['42', '43']);
    expect(tg.messages()[0].body.reply_markup.inline_keyboard[0][0].text).toBe('Review and sign with Meteor');
  });
  it('falls back to TELEGRAM_CHAT_ID for an unlinked signer, and to nobody without it', async () => {
    const tg = fakeTelegram(), links = new Links();
    expect(await telegramNotifier({ ...opts, chatId: '7', chats: k => links.chats(k), fetch: tg.fetch })(pending(), 'r')).toBe(true);
    expect(tg.messages().map(m => m.body.chat_id)).toEqual(['7']);
    expect(await telegramNotifier({ ...opts, chats: k => links.chats(k), fetch: tg.fetch })(pending(), 'r')).toBe(false);
  });
});

it('links over HTTP from an allowed origin and confirms in the chat', async () => {
  const tg = fakeTelegram(), links = new Links(undefined, () => 1000), bot = telegramBot({ ...opts, links, fetch: tg.fetch });
  const app = server(new Relay('token'), ['https://page.example'], undefined, { links, linked: bot.linked });
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(app.address() as any).port}/links`, code = links.create('42');
    const post = (body: unknown) => fetch(url, { method: 'POST', headers: { Origin: 'https://page.example', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const bad = await post({ ...signLink(code), publicKey: pk(other) });
    expect(bad.status).toBe(403);
    const ok = await post(signLink(code));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ linked: true, publicKey: pk() });
    expect(tg.messages()[0].body).toMatchObject({ chat_id: '42' });
    expect(tg.messages()[0].body.text).toContain(`alerts for ${pk()}`);
    expect((await post(signLink(code))).status).toBe(404);
  } finally { await new Promise<void>(r => app.close(() => r())); }
});

it('has no link endpoint when Telegram is off', async () => {
  const app = server(new Relay('token'));
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  try { expect((await fetch(`http://127.0.0.1:${(app.address() as any).port}/links`, { method: 'POST', body: '{}' })).status).toBe(404); }
  finally { await new Promise<void>(r => app.close(() => r())); }
});
