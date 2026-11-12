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
export const pendingSchema=z.object({
 schema:z.literal('styx-near-pending/1'), network:z.enum(['testnet','mainnet']), rpcUrl:z.string().url().refine(s=>['https:','http:'].includes(new URL(s).protocol)), vault:account, token:account,
 payment:z.object({payment_id:z.string().min(1).max(256),agent:key,token:account,recipient:account,amount:uint(128),evidence_commitment:bytes(32),policy_version:version,recipient_version:version,valid_until:uint(64)}).strict(),
 authorization:z.object({payment_hash:bytes(32),signer:key,signer_version:version,approval_nonce:bytes(32),authorization_expiry:uint(64),callback_url:z.string().url().nullable()}).strict(),
 message:z.string().min(1).max(8192),invoiceReference:z.string().max(8192),perPaymentLimit:uint(128),exceededRule:z.literal('perPaymentLimit')
}).strict().refine(p=>p.token===p.payment.token && BigInt(p.payment.amount)>BigInt(p.perPaymentLimit),'token mismatch or amount within stated limit');
export type Pending=z.infer<typeof pendingSchema>;
export const signatureSchema=z.object({schema:z.literal('styx-near-signature/1'),paymentId:z.string(),accountId:account,publicKey:key,signature:bytes(64),nonce:bytes(32),callbackUrl:z.string().url().nullable()}).strict();
export type Signature=z.infer<typeof signatureSchema>;
// Exactly the field order in Nep413Payload in the vault. The tag precedes the payload.
export function signingBytes(p:Pending, callbackUrl:string|null):Uint8Array {
 return serialize({struct:{tag:'u32',message:'string',nonce:{array:{type:'u8',len:32}},recipient:'string',callbackUrl:{option:'string'}}},{tag:2147484061,message:p.message,nonce:Buffer.from(p.authorization.approval_nonce,'base64'),recipient:p.vault,callbackUrl});
}
export function signatureFile(p:Pending,result:{accountId:string;publicKey:string;signature:string},callbackUrl:string|null):Signature {
 if(result.publicKey!==p.authorization.signer) throw new Error(`Wallet used ${result.publicKey}. Ask the owner to register this key with set_approver and create a new request.`);
 return signatureSchema.parse({schema:'styx-near-signature/1',paymentId:p.payment.payment_id,...result,nonce:p.authorization.approval_nonce,callbackUrl});
}
