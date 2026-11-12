import { describe,it,expect,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { pendingSchema, signingBytes, signatureFile } from './protocol';
import { review,rpcView,destinationDetails } from './review';
import { fixture as nearFixture } from './fixture';
const live=JSON.parse(readFileSync(new URL('../test/vault-v2.json',import.meta.url),'utf8'));
const pending=()=>pendingSchema.parse(structuredClone(live.pending));
const facts=()=>Object.fromEntries(Object.entries(live.views).map(([method,value]:[string,any])=>[method,JSON.parse(Buffer.from(value.result.result).toString())]));
const now=BigInt(live.pending.authorization.authorization_expiry)-1n;
describe('EVM pending validation',()=>{
 it('accepts the actual v2 EvmPayment without a token field',()=>{expect(pending().chainId).toBe(5042002);expect('token' in pending().payment).toBe(false);});
 for(const bad of [null,undefined,'5042002',1,-1,1.5,Number.MAX_SAFE_INTEGER+1]) it(`rejects invalid/mismatched outer chain ${String(bad)}`,()=>{expect(pendingSchema.safeParse({...live.pending,chainId:bad}).success).toBe(false);});
 it('rejects a payment chain mismatch or NEAR-shaped recipient/token',()=>{
  for(const payment of [{...live.pending.payment,chain_id:1},{...live.pending.payment,recipient:'vendor.testnet'},{...live.pending.payment,recipient:'0x'+'A'.repeat(40)},{...live.pending.payment,token:'usdc.testnet'}]) expect(pendingSchema.safeParse({...live.pending,payment}).success).toBe(false);
 });
 it('treats chain id zero as EVM rather than absent',()=>{expect(pendingSchema.safeParse({...live.pending,chainId:0,payment:{...live.pending.payment,chain_id:0}}).success).toBe(true);});
 it('continues accepting NEAR requests with absent or null chainId',()=>{expect(pendingSchema.safeParse(nearFixture()).success).toBe(true);expect(pendingSchema.safeParse({...nearFixture(),chainId:null}).success).toBe(true);});
});
describe('live v2 view snapshot',()=>{
 it('uses only EVM hash/recipient views with exact args and displays the chain, token and address',async()=>{
  const f=facts();const view=vi.fn(async(method:string,args:Record<string,unknown>)=>{expect(args).toEqual(live.views[method].args);return f[method];});
  const p=pending();const result=await review(p,view,now);expect(result.errors).toEqual([]);
  expect(view.mock.calls.map(([m])=>m)).not.toContain('payment_hash');expect(view.mock.calls.map(([m])=>m)).not.toContain('get_recipient');
  const shown=destinationDetails(p,result).join('\n');expect(shown).toContain('EVM chain id: 5042002');expect(shown).toContain(f.get_evm_chain.token);expect(shown).toContain(p.payment.recipient);expect(shown).not.toContain(f.get_vault.token);
 });
 for(const [method,change,error] of [
  ['get_vault',{contract_version:1},'Unsupported contract version'],['get_vault',{contract_version:3},'Unsupported contract version'],
  ['get_evm_chain',{enabled:false},'EVM chain disabled or missing'],['get_evm_chain',null,'EVM chain disabled or missing'],['get_evm_chain',{token:'usdc.testnet'},'Invalid EVM token address'],
  ['get_evm_recipient',{allowed:false},'Recipient is not allowed'],['get_evm_recipient',{version:999},'Recipient version differs'],
  ['get_agent',{version:999},'Agent version differs'],['get_approver',{version:999},'Signer version differs']
 ] as const) it(`refuses ${method} ${JSON.stringify(change)}`,async()=>{const f=facts();f[method]=change===null?null:{...f[method],...change};expect((await review(pending(),async m=>f[m],now)).errors).toContain(error);});
 for(const method of ['evm_payment_hash','exception_message']) it(`refuses changed ${method}`,async()=>{const f=facts();f[method]='wrong';expect((await review(pending(),async m=>f[m],now)).errors.length).toBeGreaterThan(0);});
 it('refuses unavailable chain views and expired authorization',async()=>{const f=facts();await expect(review(pending(),async m=>{if(m==='get_evm_chain') throw Error('offline');return f[m];},now)).rejects.toThrow('offline');expect((await review(pending(),async m=>f[m],BigInt(live.pending.authorization.authorization_expiry))).errors).toContain('Authorization expired');});
 it('supports NEAR payments on contract v2',async()=>{const p=nearFixture();const f={get_vault:{contract_version:2,token:p.token,paused:false,vault_daily_limit:'900000000'},get_agent:{enabled:true,version:1,valid_until:'2000',per_payment_limit:p.perPaymentLimit,daily_limit:'500000000'},get_recipient:{allowed:true,version:1},get_approver:{enabled:true,version:1},payment_hash:p.authorization.payment_hash,exception_message:p.message};expect((await review(p,async m=>f[m as keyof typeof f],1000n)).errors).toEqual([]);});
 it('pins the EVM reads to the first finalized block',async()=>{
  const calls:any[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{const q=JSON.parse(options.body);calls.push(q.params);return new Response(JSON.stringify({result:live.views[q.params.method_name].result}));}));
  try{expect((await review(pending(),rpcView(pending()),now)).errors).toEqual([]);expect(calls[0].finality).toBe('final');for(const call of calls.slice(1))expect(call.block_id).toBe(live.views.get_vault.result.block_hash);}finally{vi.unstubAllGlobals();}
 });
 it('builds the same signature file and includes only the NEAR vault as NEP-413 recipient',()=>{
  const p=pending(),s=signatureFile(p,live.signature,live.signature.callbackUrl);expect(s).toEqual(live.signature);
  const bytes=Buffer.from(signingBytes(p,null));expect(bytes.includes(Buffer.from(p.vault))).toBe(true);
  expect(()=>signatureFile(p,{...live.signature,publicKey:p.payment.agent},null)).toThrow('Wallet used');
 });
});
