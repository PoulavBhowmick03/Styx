import { it,expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay,server } from './relay';
import { fixture } from './fixture';
const pair=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
function pending(){const p=fixture();p.authorization.signer='ed25519:'+bs58.encode(pair.publicKey);return p;}
// Independent manual encoding, rather than the production borsh helper.
function signature(p= pending(),callbackUrl:string|null=null){
 const str=(s:string)=>{const b=Buffer.from(s),size=Buffer.alloc(4);size.writeUInt32LE(b.length);return Buffer.concat([size,b]);};
 const tag=Buffer.alloc(4);tag.writeUInt32LE(2147484061);
 const payload=Buffer.concat([tag,str(p.message),Buffer.from(p.authorization.approval_nonce,'base64'),str(p.vault),Buffer.from([callbackUrl===null?0:1]),...(callbackUrl===null?[]:[str(callbackUrl)])]);
 return {schema:'styx-near-signature/1',paymentId:p.payment.payment_id,accountId:'owner.testnet',publicKey:p.authorization.signer,nonce:p.authorization.approval_nonce,signature:Buffer.from(nacl.sign.detached(createHash('sha256').update(payload).digest(),pair.secretKey)).toString('base64'),callbackUrl};
}
it('accepts real NEP-413 signatures, persists, and first signature stands',()=>{
 const dir=mkdtempSync(join(tmpdir(),'styx-near-'));try{const file=join(dir,'requests.json');const r=new Relay('token',file,()=>1000);const {requestId}=r.submit(pending(),'token');expect(Buffer.from(requestId,'base64url')).toHaveLength(32);r.sign(requestId,signature());expect(()=>r.sign(requestId,signature())).toThrow('already signed');const loaded=new Relay('token',file,()=>1000);expect(loaded.signature(requestId,'token').status).toBe('signed');expect(new Relay('token',file,()=>1500).pending(requestId).status).toBe('expired');expect(()=>new Relay('token',file,()=>1500).signature(requestId,'token')).toThrow('expired');}finally{rmSync(dir,{recursive:true});}
});
it('accepts signed callback and refuses a changed callback',()=>{const r=new Relay('token',undefined,()=>1000);const {requestId}=r.submit(pending(),'token');const s=signature(pending(),'https://example.com/?request=1');expect(()=>r.sign(requestId,{...s,callbackUrl:null})).toThrow('invalid NEP');r.sign(requestId,s);});
for(const mutation of ['nonce','key','message']) it(`refuses wrong ${mutation}`,()=>{const r=new Relay('token',undefined,()=>1000);const {requestId}=r.submit(pending(),'token');const p=pending();let s=signature();if(mutation==='nonce')s.nonce=Buffer.alloc(32,2).toString('base64');if(mutation==='key')s.publicKey=fixture().payment.agent;if(mutation==='message'){p.message='wrong';s=signature(p);}expect(()=>r.sign(requestId,s)).toThrow();expect(r.signature(requestId,'token').status).toBe('pending');});
it('checks auth, expiry window and over-limit rule',()=>{const r=new Relay('token',undefined,()=>1000);expect(()=>r.submit(pending(),'bad')).toThrow('unauthorized');for(const expiry of ['999','87401']){const p=pending();p.authorization.authorization_expiry=expiry;expect(()=>r.submit(p,'token')).toThrow('expiry');}const p=pending();p.payment.amount=p.perPaymentLimit;expect(()=>r.submit(p,'token')).toThrow('invalid pending');});
it('serves HTTP public pending, protected fetch and signature post',async()=>{const app=server(new Relay('token',undefined,()=>1000));await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));try{const base=`http://127.0.0.1:${(app.address() as any).port}`;const create=await fetch(base+'/requests',{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json'},body:JSON.stringify({pending:pending()})});const {requestId}=await create.json();expect(create.status).toBe(200);expect((await fetch(base+'/requests/'+requestId)).status).toBe(200);expect((await fetch(base+'/requests/'+requestId+'/signature')).status).toBe(401);expect((await fetch(base+'/requests/'+requestId+'/signature',{method:'POST',body:JSON.stringify(signature())})).status).toBe(200);}finally{await new Promise<void>(resolve=>app.close(()=>resolve()));}});
it('allows configured browser origins, rejects others, and exposes health',async()=>{
 const app=server(new Relay('token'),['https://approval.example']);await new Promise<void>(r=>app.listen(0,'127.0.0.1',r));
 try{const url=`http://127.0.0.1:${(app.address() as any).port}/health`;
 expect(await (await fetch(url)).json()).toEqual({ok:true});
 const allowed=await fetch(url,{headers:{Origin:'https://approval.example'}});expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://approval.example');
 expect((await fetch(url,{headers:{Origin:'https://evil.example'}})).status).toBe(403);
 const preflight=await fetch(url,{method:'OPTIONS',headers:{Origin:'https://approval.example'}});expect(preflight.status).toBe(204);
 }finally{await new Promise<void>(r=>app.close(()=>r()));}
});

// A decline: the approver signs declineMessage with the request's nonce and the styx-decline recipient.
function decline(p=pending(),key=pair){
 const str=(s:string)=>{const b=Buffer.from(s),size=Buffer.alloc(4);size.writeUInt32LE(b.length);return Buffer.concat([size,b]);};
 const tag=Buffer.alloc(4);tag.writeUInt32LE(2147484061);
 const message=`Styx: decline payment ${p.payment.payment_id} of ${p.payment.amount} base units to ${p.payment.recipient} from ${p.vault}.`;
 const payload=Buffer.concat([tag,str(message),Buffer.from(p.authorization.approval_nonce,'base64'),str('styx-decline'),Buffer.from([0])]);
 return {schema:'styx-near-decline/1',publicKey:'ed25519:'+bs58.encode(key.publicKey),signature:Buffer.from(nacl.sign.detached(createHash('sha256').update(payload).digest(),key.secretKey)).toString('base64')};
}
it('records a decline signed by the requested approver, tells the agent, and refuses a later signature',()=>{
 const dir=mkdtempSync(join(tmpdir(),'styx-near-'));try{
  const file=join(dir,'requests.json'),r=new Relay('token',file,()=>1000),{requestId}=r.submit(pending(),'token');
  expect(r.decline(requestId,decline())).toEqual({status:'declined'});
  expect(r.signature(requestId,'token')).toEqual({status:'declined'});
  expect(r.pending(requestId).status).toBe('declined');
  expect(()=>r.sign(requestId,signature())).toThrow('already declined');
  expect(new Relay('token',file,()=>1000).signature(requestId,'token')).toEqual({status:'declined'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('refuses a decline from another key, a forged one, or after signing',()=>{
 const r=new Relay('token',undefined,()=>1000),{requestId}=r.submit(pending(),'token');
 expect(()=>r.decline(requestId,decline(pending(),nacl.sign.keyPair()))).toThrow('requested approver');
 expect(()=>r.decline(requestId,{...decline(),signature:Buffer.alloc(64,1).toString('base64')})).toThrow('invalid NEP');
 const changed=pending();changed.payment.amount='999999999';
 expect(()=>r.decline(requestId,decline(changed))).toThrow('invalid NEP');
 r.sign(requestId,signature());
 expect(()=>r.decline(requestId,decline())).toThrow('already signed');
});
it('serves POST /requests/<id>/decline',async()=>{
 const r=new Relay('token',undefined,()=>1000),app=server(r);await new Promise<void>(res=>app.listen(0,'127.0.0.1',res));
 try{const {requestId}=r.submit(pending(),'token');const url=`http://127.0.0.1:${(app.address() as any).port}/requests/${requestId}/decline`;
  const ok=await fetch(url,{method:'POST',body:JSON.stringify(decline())});expect(ok.status).toBe(200);expect(await ok.json()).toEqual({status:'declined'});
 }finally{await new Promise<void>(res=>app.close(()=>res()));}
});
