import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Watches, crossed, checkVaults, watchPayload, vaultFromPayload, MAX_WATCHES_PER_CHAT, spendText } from './watches';

describe('spend watches', () => {
  it('sends 80% once and 100% once per day', () => {
    expect(crossed(79n, 100n, 0)).toBeNull();
    expect(crossed(80n, 100n, 0)).toBe(80);
    expect(crossed(90n, 100n, 80)).toBeNull();
    expect(crossed(100n, 100n, 80)).toBe(100);
    expect(crossed(150n, 100n, 0)).toBe(100);
    expect(crossed(5n, 0n, 0)).toBeNull();
  });
  it('round-trips vault ids through Telegram start payloads', () => {
    const v = 'styx-demo-2917.styx-vaults.testnet';
    expect(watchPayload(v)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(vaultFromPayload(watchPayload(v))).toBe(v);
    expect(vaultFromPayload('approver')).toBeNull();
    expect(vaultFromPayload('watch-Bad!')).toBeNull();
  });
  it('limits watches per chat, unwatches, and keeps state across restarts', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'watch-')), 'w.json'), w = new Watches(file);
    for (let i = 0; i < MAX_WATCHES_PER_CHAT; i++) w.watch('42', `v${i}.testnet`);
    expect(() => w.watch('42', 'one-more.testnet')).toThrow(/at most/);
    expect(() => w.watch('42', 'Bad Vault')).toThrow();
    w.markSent('v0.testnet', 10, 80);
    const again = new Watches(file);
    expect(again.list('42')).toHaveLength(MAX_WATCHES_PER_CHAT);
    expect(again.alreadySent('v0.testnet', 10)).toBe(80);
    expect(again.unwatch('42', 'v0.testnet')).toBe(1);
    expect(again.unwatch('42')).toBe(MAX_WATCHES_PER_CHAT - 1);
    expect(again.list('42')).toEqual([]);
  });
  it('checks each watched vault once per pass and does not repeat an alert', async () => {
    const w = new Watches(); w.watch('42', 'a.testnet'); w.watch('7', 'a.testnet'); w.watch('42', 'broken.testnet');
    let spent = '450000000';
    const view = async (acct: string, method: string) => {
      if (acct === 'broken.testnet') throw new Error('down');
      return method === 'get_vault' ? { vault_daily_limit: '500000000' } : method === 'current_day' ? 20771 : spent;
    };
    const sent: [string, string][] = [];
    const send = async (c: string, t: string) => { sent.push([c, t]); };
    await checkVaults(w, view, send);
    expect(sent.map(s => s[0]).sort()).toEqual(['42', '7']);
    expect(sent[0][1]).toBe(spendText('a.testnet', 450000000n, 500000000n, 80));
    expect(sent[0][1]).toContain('450 of its 500 token daily limit today (90%)');
    await checkVaults(w, view, send);
    expect(sent).toHaveLength(2);
    spent = '500000000';
    await checkVaults(w, view, send);
    expect(sent).toHaveLength(4);
    expect(sent[3][1]).toContain('whole daily limit');
  });
});
