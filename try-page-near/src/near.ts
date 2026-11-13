// Builds, signs and sends NEAR transactions with one ed25519 key, and reads views. Signing code:
// Poulav reviews it. The encoding is NEAR's Borsh transaction format
// (https://docs.near.org/protocol/transaction-anatomy); near.test.ts checks it byte for byte against
// a hand-written encoding, and the testnet run in docs/near/TRY_PAGE.md shows the network accepts it.
import { serialize, type Schema } from 'borsh';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const publicKeySchema: Schema = { enum: [{ struct: { ed25519: { array: { type: 'u8', len: 32 } } } }] };
const accessKeySchema: Schema = { struct: { nonce: 'u64', permission: { enum: [
  { struct: { functionCall: { struct: { allowance: { option: 'u128' }, receiverId: 'string', methodNames: { array: { type: 'string' } } } } } },
  { struct: { fullAccess: { struct: {} } } },
] } } };
// The order is NEAR's action numbering; the page only ever builds numbers 2, 3 and 5.
const actionSchema: Schema = { enum: [
  { struct: { createAccount: { struct: {} } } },
  { struct: { deployContract: { struct: { code: { array: { type: 'u8' } } } } } },
  { struct: { functionCall: { struct: { methodName: 'string', args: { array: { type: 'u8' } }, gas: 'u64', deposit: 'u128' } } } },
  { struct: { transfer: { struct: { deposit: 'u128' } } } },
  { struct: { stake: { struct: { stake: 'u128', publicKey: publicKeySchema } } } },
  { struct: { addKey: { struct: { publicKey: publicKeySchema, accessKey: accessKeySchema } } } },
] };
const transactionSchema: Schema = { struct: {
  signerId: 'string', publicKey: publicKeySchema, nonce: 'u64', receiverId: 'string',
  blockHash: { array: { type: 'u8', len: 32 } }, actions: { array: { type: actionSchema } },
} };
const signedSchema: Schema = { struct: { transaction: transactionSchema, signature: { enum: [{ struct: { ed25519: { array: { type: 'u8', len: 64 } } } }] } } };

export type Action =
  | { functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } }
  | { transfer: { deposit: bigint } }
  | { addKey: { publicKey: { ed25519: Uint8Array }; accessKey: { nonce: bigint; permission: { fullAccess: Record<string, never> } } } };
export type Transaction = { signerId: string; publicKey: { ed25519: Uint8Array }; nonce: bigint; receiverId: string; blockHash: Uint8Array; actions: Action[] };

export const TGAS = 1_000_000_000_000n;
export const functionCall = (methodName: string, args: unknown, gas = 100n * TGAS, deposit = 0n): Action =>
  ({ functionCall: { methodName, args: new TextEncoder().encode(JSON.stringify(args)), gas, deposit } });
export const transfer = (yocto: bigint): Action => ({ transfer: { deposit: yocto } });
export const addFullAccessKey = (publicKey: Uint8Array): Action =>
  ({ addKey: { publicKey: { ed25519: publicKey }, accessKey: { nonce: 0n, permission: { fullAccess: {} } } } });

export type Key = { secret: Uint8Array; publicKey: Uint8Array; publicKeyText: string };
/** A NEAR ed25519 private key, `ed25519:` + base58 of the 64-byte secret (seed, then public key). */
export function parseKey(text: string): Key {
  if (!text.startsWith('ed25519:')) throw new Error('not an ed25519 key');
  const secret = bs58.decode(text.slice(8));
  if (secret.length !== 64) throw new Error('not a 64-byte ed25519 secret');
  const pair = nacl.sign.keyPair.fromSecretKey(secret);
  return { secret, publicKey: pair.publicKey, publicKeyText: 'ed25519:' + bs58.encode(pair.publicKey) };
}

const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
export const encodeTransaction = (tx: Transaction): Uint8Array => serialize(transactionSchema, tx);
export function base64(bytes: Uint8Array): string { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }

/** Signs sha256 of the encoded transaction, as NEAR requires. Returns the hash and the signed bytes. */
export async function sign(tx: Transaction, key: Key): Promise<{ hash: string; signed: Uint8Array }> {
  const digest = await sha256(encodeTransaction(tx));
  const signature = nacl.sign.detached(digest, key.secret);
  return { hash: bs58.encode(digest), signed: serialize(signedSchema, { transaction: tx, signature: { ed25519: signature } }) };
}

export type RpcReply = { result?: any; error?: any };
export async function rpc(url: string, method: string, params: unknown): Promise<RpcReply> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'styx-try', method, params }), signal: AbortSignal.timeout(40_000) });
  if (!response.ok) throw new Error(`RPC unavailable (${response.status})`);
  return await response.json() as RpcReply;
}
export async function view<T>(url: string, account: string, method: string, args: unknown = {}): Promise<T> {
  const reply = await rpc(url, 'query', { request_type: 'call_function', finality: 'optimistic', account_id: account,
    method_name: method, args_base64: base64(new TextEncoder().encode(JSON.stringify(args))) });
  if (reply.error || !reply.result?.result) throw new Error(`cannot read ${method} on ${account}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(reply.result.result))) as T;
}
export type AccessKey = { nonce: number; permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } } };
/** The key as NEAR holds it, or null when it is not on the account. Also the block hash a transaction needs. */
export async function accessKey(url: string, account: string, publicKey: string): Promise<{ key: AccessKey; blockHash: Uint8Array } | null> {
  const reply = await rpc(url, 'query', { request_type: 'view_access_key', finality: 'optimistic', account_id: account, public_key: publicKey });
  if (reply.error || reply.result?.error) return null;
  return { key: reply.result as AccessKey, blockHash: bs58.decode(reply.result.block_hash) };
}

const invalidNonce = (reply: RpcReply) => JSON.stringify(reply.error?.data ?? '').includes('InvalidNonce');
const timedOut = (reply: RpcReply) => reply.error?.cause?.name === 'TIMEOUT_ERROR';
/**
 * Signs `actions` from `signer` to `receiverId` with `key` and sends them. Returns the RPC's reply
 * untouched (verdict.ts reads it) and the transaction hash. Other visitors use the same key, so a
 * nonce another transaction just took is retried with a fresh one; nothing else is retried.
 */
export async function send(url: string, signer: string, key: Key, receiverId: string, actions: Action[]): Promise<{ hash: string; reply: RpcReply }> {
  let last: { hash: string; reply: RpcReply } | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await accessKey(url, signer, key.publicKeyText);
    if (!current) return { hash: '', reply: { error: { data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: { AccessKeyNotFound: { account_id: signer, public_key: key.publicKeyText } } } } } } } };
    const tx: Transaction = { signerId: signer, publicKey: { ed25519: key.publicKey }, nonce: BigInt(current.key.nonce) + 1n + BigInt(attempt), receiverId, blockHash: current.blockHash, actions };
    const { hash, signed } = await sign(tx, key);
    let reply = await rpc(url, 'send_tx', { signed_tx_base64: base64(signed), wait_until: 'EXECUTED_OPTIMISTIC' });
    for (let poll = 0; poll < 6 && timedOut(reply); poll++)
      reply = await rpc(url, 'tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'EXECUTED_OPTIMISTIC' });
    last = { hash, reply };
    if (!invalidNonce(reply)) break;
  }
  return last!;
}
