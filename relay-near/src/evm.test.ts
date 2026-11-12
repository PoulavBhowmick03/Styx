import { it,expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay,verify,server } from './relay';
import { pendingSchema } from './protocol';
const live=JSON.parse(readFileSync(new URL('../test/vault-v2.json',import.meta.url),'utf8'));
const now=Number(live.pending.authorization.authorization_expiry)-1;
it('verifies the real v2 NEP-413 signature from testnet',()=>{expect(verify(pendingSchema.parse(live.pending),live.signature)).toEqual(live.signature);});
it('stores and restores the real historical EVM request with a frozen clock',()=>{
 const dir=mkdtempSync(join(tmpdir(),'styx-v2-'));try{
  const file=join(dir,'state.json'),relay=new Relay('token',file,()=>now);const {requestId}=relay.submit(live.pending,'token');relay.sign(requestId,live.signature);
  const restored=new Relay('token',file,()=>now);expect(restored.pending(requestId).pending).toEqual(live.pending);expect(restored.signature(requestId,'token')).toEqual({status:'signed',signature:live.signature});expect(()=>restored.sign(requestId,live.signature)).toThrow('already signed');
 }finally{rmSync(dir,{recursive:true});}
});
it('rejects wrong EVM request schemas and expired authorization',()=>{
 const relay=new Relay('token',undefined,()=>now);
 for(const pending of [{...live.pending,chainId:1},{...live.pending,chainId:null},{...live.pending,payment:{...live.pending.payment,token:live.pending.token}},{...live.pending,payment:{...live.pending.payment,recipient:'vendor.testnet'}}])expect(()=>relay.submit(pending,'token')).toThrow('invalid pending');
 expect(()=>new Relay('token',undefined,()=>now+1).submit(live.pending,'token')).toThrow('expiry');
});
for(const change of [{message:'different message'},{vault:'other.testnet'}])it(`rejects changing signed context ${JSON.stringify(change)}`,()=>expect(()=>verify(pendingSchema.parse({...live.pending,...change}),live.signature)).toThrow('invalid NEP'));
for(const change of [{nonce:Buffer.alloc(32,3).toString('base64')},{publicKey:live.pending.payment.agent},{callbackUrl:'https://other.example/callback'}])it(`rejects changed EVM signature field ${Object.keys(change)[0]}`,()=>expect(()=>verify(pendingSchema.parse(live.pending),{...live.signature,...change})).toThrow());
it('serves an EVM request and accepts its real signature over HTTP',async()=>{
 const app=server(new Relay('token',undefined,()=>now));await new Promise<void>(r=>app.listen(0,'127.0.0.1',r));
 try{const base=`http://127.0.0.1:${(app.address() as any).port}`;const created=await fetch(base+'/requests',{method:'POST',headers:{Authorization:'Bearer token'},body:JSON.stringify({pending:live.pending})});expect(created.status).toBe(200);const {requestId}=await created.json();
 expect((await (await fetch(`${base}/requests/${requestId}`)).json()).pending.chainId).toBe(5042002);
 expect((await fetch(`${base}/requests/${requestId}/signature`,{method:'POST',body:JSON.stringify(live.signature)})).status).toBe(200);
 expect((await (await fetch(`${base}/requests/${requestId}/signature`,{headers:{Authorization:'Bearer token'}})).json()).signature).toEqual(live.signature);
 }finally{await new Promise<void>(r=>app.close(()=>r()));}
});
