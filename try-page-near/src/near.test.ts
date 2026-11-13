import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { addFullAccessKey, encodeTransaction, functionCall, parseKey, sign, transfer, type Transaction } from './near';

// An independent encoding, written out by hand from NEAR's Borsh layout, with no schema library.
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const u128 = (n: bigint) => new Uint8Array([...u64(n & ((1n << 64n) - 1n)), ...u64(n >> 64n)]);
const str = (s: string) => { const b = new TextEncoder().encode(s); return [...u32(b.length), ...b]; };
const cat = (...parts: ArrayLike<number>[]) => new Uint8Array(parts.flatMap(p => [...Array.from(p)]));

const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const key = parseKey('ed25519:' + bs58.encode(pair.secretKey));
const blockHash = new Uint8Array(32).map((_, i) => i);
const base = (actions: Transaction['actions']): Transaction =>
  ({ signerId: 'vault.testnet', publicKey: { ed25519: key.publicKey }, nonce: 277523782000001n, receiverId: 'vault.testnet', blockHash, actions });
const head = cat(str('vault.testnet'), [0], key.publicKey, u64(277523782000001n), str('vault.testnet'), blockHash);

describe('transaction encoding', () => {
  it('encodes a function call as NEAR does', () => {
    const args = new TextEncoder().encode('{"a":1}');
    const expected = cat(head, u32(1), [2], str('pay'), u32(args.length), args, u64(100_000_000_000_000n), u128(0n));
    expect(encodeTransaction(base([functionCall('pay', { a: 1 })]))).toEqual(expected);
  });
  it('encodes a transfer and a full-access AddKey', () => {
    const other = new Uint8Array(32).fill(9);
    const expected = cat(head, u32(2), [3], u128(10n ** 21n), [5], [0], other, u64(0n), [1]);
    expect(encodeTransaction(base([transfer(10n ** 21n), addFullAccessKey(other)]))).toEqual(expected);
  });
  it('signs sha256 of the transaction with the key, and appends an ed25519 signature', async () => {
    const tx = base([functionCall('pay', { a: 1 })]);
    const { hash, signed } = await sign(tx, key);
    const body = encodeTransaction(tx);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body as BufferSource));
    expect(hash).toBe(bs58.encode(digest));
    expect(signed.slice(0, body.length)).toEqual(body);
    expect(signed[body.length]).toBe(0);
    expect(nacl.sign.detached.verify(digest, signed.slice(body.length + 1), pair.publicKey)).toBe(true);
    expect(signed.length).toBe(body.length + 65);
  });
});
describe('parseKey', () => {
  it('derives the public key and refuses other shapes', () => {
    expect(key.publicKeyText).toBe('ed25519:' + bs58.encode(pair.publicKey));
    expect(() => parseKey('secp256k1:abc')).toThrow();
    expect(() => parseKey('ed25519:' + bs58.encode(pair.publicKey))).toThrow();
  });
});
