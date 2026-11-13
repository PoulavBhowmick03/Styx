// Which Telegram chats get the alerts for which approver key. A chat asks with /start and gets a
// one-time code; whoever holds the key signs linkMessage(code) in their wallet (NEP-413), and the
// relay then maps that public key to the chat. The relay never reads chain state: a link only
// routes alerts, and the vault still checks the approver's signature over each payment.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { key, linkSchema, linkSigningBytes } from './protocol';
import { fail, nep413Valid } from './relay';

export const CODE_TTL = 900, MAX_CODES = 1000, MAX_CHATS_PER_KEY = 5, MAX_KEYS = 10000;
const chatId = /^-?[0-9]{1,20}$/;
type Code = { chatId: string; expires: number };

export class Links {
  private codes = new Map<string, Code>(); // memory only: a restart just means sending /start again
  private keys = new Map<string, string[]>();
  offset = 0; // Telegram getUpdates offset, saved so a restart does not answer old messages twice

  constructor(private file?: string, private now = () => Math.floor(Date.now() / 1000)) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(saved.offset) || saved.offset < 0 || !Array.isArray(saved.links)) throw new Error('invalid saved links');
      for (const [k, chats] of saved.links) {
        if (!key.safeParse(k).success || !Array.isArray(chats) || chats.length > MAX_CHATS_PER_KEY || !chats.every((c: unknown) => typeof c === 'string' && chatId.test(c))) throw new Error('invalid saved link');
        this.keys.set(k, chats);
      }
      this.offset = saved.offset;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify({ offset: this.offset, links: [...this.keys] }), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }

  create(chat: string): string {
    if (!chatId.test(chat)) return fail(400, 'invalid chat');
    const now = this.now();
    for (const [c, v] of this.codes) if (v.expires <= now) this.codes.delete(c);
    if (this.codes.size >= MAX_CODES) return fail(429, 'link capacity reached');
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { chatId: chat, expires: now + CODE_TTL });
    return code;
  }

  link(input: unknown): { chatId: string; publicKey: string; accountId: string } {
    const parsed = linkSchema.safeParse(input);
    if (!parsed.success) return fail(400, 'invalid link');
    const l = parsed.data, code = this.codes.get(l.code);
    if (!code) return fail(404, 'unknown or used link code; send /start to the bot again');
    if (code.expires <= this.now()) { this.codes.delete(l.code); return fail(410, 'link code expired; send /start to the bot again'); }
    // A bad signature leaves the code usable: the code is the secret, the signature names the key.
    if (!nep413Valid(linkSigningBytes(l.code), l.signature, l.publicKey)) return fail(403, 'invalid NEP-413 signature');
    const chats = this.keys.get(l.publicKey) ?? [];
    if (!chats.includes(code.chatId)) {
      if (chats.length >= MAX_CHATS_PER_KEY) return fail(429, `a key can alert at most ${MAX_CHATS_PER_KEY} chats; /unlink one first`);
      if (!this.keys.has(l.publicKey) && this.keys.size >= MAX_KEYS) return fail(429, 'link capacity reached');
    }
    this.codes.delete(l.code);
    this.keys.set(l.publicKey, chats.includes(code.chatId) ? chats : [...chats, code.chatId]);
    this.save();
    return { chatId: code.chatId, publicKey: l.publicKey, accountId: l.accountId };
  }

  unlink(chat: string): number {
    let removed = 0;
    for (const [k, chats] of this.keys) {
      if (!chats.includes(chat)) continue;
      removed++;
      const rest = chats.filter(c => c !== chat);
      if (rest.length) this.keys.set(k, rest); else this.keys.delete(k);
    }
    if (removed) this.save();
    return removed;
  }

  chats(publicKey: string): string[] { return [...(this.keys.get(publicKey) ?? [])]; }
  keysFor(chat: string): string[] { return [...this.keys].filter(([, c]) => c.includes(chat)).map(([k]) => k); }
  setOffset(offset: number) { if (offset > this.offset) { this.offset = offset; this.save(); } }
}
