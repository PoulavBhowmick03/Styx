import { describe,it,expect } from 'vitest';
import { fixture } from './fixture';
import { review,usdc } from './review';
import { signatureFile,pendingSchema } from './protocol';
const facts=()=>({get_vault:{contract_version:1,token:'usdc.testnet',paused:false,vault_daily_limit:'900000000'},get_agent:{enabled:true,version:1,valid_until:'2000',per_payment_limit:'100000000',daily_limit:'500000000'},get_recipient:{allowed:true,version:1},get_approver:{enabled:true,version:1},payment_hash:fixture().authorization.payment_hash,exception_message:fixture().message});
describe('chain review',()=>{
 it('accepts matching views',async()=>{const f=facts();expect((await review(fixture(),async m=>f[m as keyof typeof f],1000n)).errors).toEqual([]);});
 for(const [method,field,value] of [['get_vault','paused',true],['get_agent','version',2],['get_recipient','allowed',false],['get_approver','version',2]] as const) it(`refuses ${method} ${field}`,async()=>{const f:any=facts();f[method][field]=value;expect((await review(fixture(),async m=>f[m],1000n)).errors.length).toBeGreaterThan(0);});
 for(const method of ['payment_hash','exception_message']) it(`refuses changed ${method}`,async()=>{const f:any=facts();f[method]='wrong';expect((await review(fixture(),async m=>f[m],1000n)).errors.length).toBeGreaterThan(0);});
 it('refuses expiry and unavailable RPC',async()=>{const f:any=facts();expect((await review(fixture(),async m=>f[m],1600n)).errors).toContain('Authorization expired');await expect(review(fixture(),async()=>{throw Error('offline');})).rejects.toThrow('offline');});
 it('rejects wallet key mismatch and reports the key',()=>{expect(()=>signatureFile(fixture(),{accountId:'owner.testnet',publicKey:'wrong-key',signature:''},null)).toThrow('wrong-key');});
 it('formats without rounding and validates schema',()=>{expect(usdc('150000001')).toBe('150.000001 USDC');expect(pendingSchema.safeParse({...fixture(),exceededRule:'dailyLimit'}).success).toBe(false);});
});
describe('telegram link message',()=>{
 it('signs the code as a 32-byte nonce for a non-vault recipient',async()=>{
  const {linkMessage,linkNonce,linkSchema,LINK_RECIPIENT}=await import('./protocol');const code='A'.repeat(42)+'w';
  expect(linkNonce(code)).toHaveLength(32);expect(linkNonce(code).toString('base64url')).toBe(code);
  expect(linkMessage(code)).toContain(`Code: ${code}`);expect(LINK_RECIPIENT).not.toMatch(/\./);
  expect(linkSchema.safeParse({schema:'styx-near-telegram-link/1',code:'short',accountId:'a.testnet',publicKey:fixture().payment.agent,signature:''}).success).toBe(false);
 });
});
