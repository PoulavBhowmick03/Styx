import { it,expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay,server } from './relay';
import { fixture } from '../../approval-page-near/src/fixture';
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
