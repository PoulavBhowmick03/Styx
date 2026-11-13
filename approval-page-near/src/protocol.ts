import { z } from 'zod';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { serialize } from 'borsh';
export { Buffer };
export const bytes = (n: number) => z.string().refine(s => { try { const b=Buffer.from(s,'base64'); return b.length===n && b.toString('base64')===s; } catch { return false; } }, `expected canonical base64 (${n} bytes)`);
export const key = z.string().refine(s => { try { return s.startsWith('ed25519:') && bs58.decode(s.slice(8)).length===32; } catch { return false; } });
const account=z.string().min(2).max(64).regex(/^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*$/);
const uint=(bits:number)=>z.string().regex(/^(0|[1-9][0-9]*)$/).refine(s=>BigInt(s)<(1n<<BigInt(bits)));
const version=z.number().int().nonnegative().safe();
export const evmAddress=z.string().regex(/^0x[0-9a-f]{40}$/);
const chainId=z.number().int().nonnegative().safe();
const paymentFields={payment_id:z.string().min(1).max(256),agent:key,amount:uint(128),evidence_commitment:bytes(32),policy_version:version,recipient_version:version,valid_until:uint(64)};
const pendingFields={
 schema:z.literal('styx-near-pending/1'),network:z.enum(['testnet','mainnet']),rpcUrl:z.string().url().refine(s=>['https:','http:'].includes(new URL(s).protocol)),vault:account,token:account,
 authorization:z.object({payment_hash:bytes(32),signer:key,signer_version:version,approval_nonce:bytes(32),authorization_expiry:uint(64),callback_url:z.string().url().nullable()}).strict(),
 message:z.string().min(1).max(8192),invoiceReference:z.string().max(8192),perPaymentLimit:uint(128),exceededRule:z.literal('perPaymentLimit')
};
const nearPendingSchema=z.object({...pendingFields,chainId:z.null().optional(),payment:z.object({...paymentFields,token:account,recipient:account}).strict()}).strict().refine(p=>p.token===p.payment.token,'token mismatch');
const evmPendingSchema=z.object({...pendingFields,chainId,payment:z.object({...paymentFields,chain_id:chainId,recipient:evmAddress}).strict()}).strict().refine(p=>p.chainId===p.payment.chain_id,'EVM chain ids differ');
export const pendingSchema=z.union([nearPendingSchema,evmPendingSchema]).refine(p=>BigInt(p.payment.amount)>BigInt(p.perPaymentLimit),'amount within stated limit');
export type Pending=z.infer<typeof pendingSchema>;
export type EvmPending=z.infer<typeof evmPendingSchema>;
export function isEvmPending(p:Pending):p is EvmPending { return p.chainId!=null; }
export const signatureSchema=z.object({schema:z.literal('styx-near-signature/1'),paymentId:z.string(),accountId:account,publicKey:key,signature:bytes(64),nonce:bytes(32),callbackUrl:z.string().url().nullable()}).strict();
export type Signature=z.infer<typeof signatureSchema>;
// Exactly the field order in Nep413Payload in the vault. The tag precedes the payload.
function nep413Bytes(message:string,nonce:Uint8Array,recipient:string,callbackUrl:string|null):Uint8Array {
 return serialize({struct:{tag:'u32',message:'string',nonce:{array:{type:'u8',len:32}},recipient:'string',callbackUrl:{option:'string'}}},{tag:2147484061,message,nonce,recipient,callbackUrl});
}
export function signingBytes(p:Pending, callbackUrl:string|null):Uint8Array {
 return nep413Bytes(p.message,Buffer.from(p.authorization.approval_nonce,'base64'),p.vault,callbackUrl);
}
// Linking a Telegram chat to an approver key. The relay sends the chat a one-time code (32 random
// bytes, base64url); the wallet signs linkMessage(code) with the code as NEP-413 nonce. This is not a
// vault message: the recipient is LINK_RECIPIENT, so it can never pass as a payment approval.
export const LINK_RECIPIENT='styx-telegram-link';
export const linkCode=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export function linkMessage(code:string):string { return `Styx: send approval alerts for this key to the Telegram chat that asked for this link.\nCode: ${code}`; }
export function linkNonce(code:string):Buffer { return Buffer.from(code.replace(/-/g,'+').replace(/_/g,'/')+'=','base64'); }
export function linkSigningBytes(code:string):Uint8Array { return nep413Bytes(linkMessage(code),linkNonce(code),LINK_RECIPIENT,null); }
export const linkSchema=z.object({schema:z.literal('styx-near-telegram-link/1'),code:linkCode,accountId:account,publicKey:key,signature:bytes(64)}).strict();
export type Link=z.infer<typeof linkSchema>;
export function signatureFile(p:Pending,result:{accountId:string;publicKey:string;signature:string},callbackUrl:string|null):Signature {
 if(result.publicKey!==p.authorization.signer) throw new Error(`Wallet used ${result.publicKey}. Ask the owner to register this key with set_approver and create a new request.`);
 return signatureSchema.parse({schema:'styx-near-signature/1',paymentId:p.payment.payment_id,...result,nonce:p.authorization.approval_nonce,callbackUrl});
}
