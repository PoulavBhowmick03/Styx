import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { pendingSchema, signatureSchema, signingBytes, type Pending, type Signature } from './protocol';
export class RelayError extends Error { constructor(public status:number,message:string){super(message);} }
const fail=(status:number,message:string):never=>{throw new RelayError(status,message);};
type Entry={pending:Pending;signature?:Signature};
export function verify(p:Pending,input:unknown):Signature {
 const parsed=signatureSchema.safeParse(input);
 if(!parsed.success) return fail(400,'invalid signature file');
 const s=parsed.data;
 if(s.paymentId!==p.payment.payment_id || s.publicKey!==p.authorization.signer || s.nonce!==p.authorization.approval_nonce) return fail(403,'signature does not match request');
 const digest=createHash('sha256').update(signingBytes(p,s.callbackUrl)).digest();
 if(!nacl.sign.detached.verify(digest,Buffer.from(s.signature,'base64'),bs58.decode(s.publicKey.slice(8)))) return fail(403,'invalid NEP-413 signature');
 return s;
}
export class Relay {
 private entries=new Map<string,Entry>();
 constructor(private token:string,private file?:string,private now=()=>Math.floor(Date.now()/1000)){
  if(!token) throw new Error('RELAY_TOKEN required');
  if(file) { try {
   const rows=JSON.parse(readFileSync(file,'utf8'));
   for(const [id,e] of rows){
    if(!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('invalid saved id');
    const pending=pendingSchema.parse(e.pending);
    this.entries.set(id,{pending,...(e.signature?{signature:verify(pending,e.signature)}:{})});
   }
  } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; } }
 }
 auth(token?:string){const a=Buffer.from(token??''),b=Buffer.from(this.token);if(a.length!==b.length || !timingSafeEqual(a,b)) fail(401,'unauthorized');}
 private save(next:Map<string,Entry>){if(this.file){mkdirSync(dirname(this.file),{recursive:true,mode:0o700});writeFileSync(this.file+'.tmp',JSON.stringify([...next]),{mode:0o600});renameSync(this.file+'.tmp',this.file);}this.entries=next;}
 submit(input:unknown,token?:string){
  this.auth(token);const parsed=pendingSchema.safeParse(input);if(!parsed.success) return fail(400,'invalid pending file');
  const p=parsed.data,expiry=BigInt(p.authorization.authorization_expiry),now=BigInt(this.now());
  if(expiry<=now || expiry>now+86400n) return fail(400,'authorization expiry must be within 24 hours');
  const next=new Map([...this.entries].filter(([,e])=>BigInt(e.pending.authorization.authorization_expiry)>now));
  if(next.size>=10000) return fail(429,'request capacity reached');
  const requestId=randomBytes(32).toString('base64url');next.set(requestId,{pending:p});this.save(next);return {requestId,alerted:false};
 }
 private find(id:string){const e=this.entries.get(id);return e??fail(404,'unknown request');}
 private expired(e:Entry){return BigInt(e.pending.authorization.authorization_expiry)<=BigInt(this.now());}
 pending(id:string){const e=this.find(id);return {pending:e.pending,status:this.expired(e)?'expired':e.signature?'signed':'pending'};}
 sign(id:string,input:unknown){const e=this.find(id);if(this.expired(e)) fail(410,'expired');if(e.signature) fail(409,'already signed');const signature=verify(e.pending,input);const next=new Map(this.entries);next.set(id,{...e,signature});this.save(next);return {status:'signed'};}
 signature(id:string,token?:string){this.auth(token);const e=this.find(id);if(this.expired(e)) fail(410,'expired');return e.signature?{status:'signed',signature:e.signature}:{status:'pending'};}
}
export function server(relay:Relay, allowedOrigins:string[] = []){return createServer(async(req,res)=>{
 const origin=req.headers.origin;
 res.setHeader('Vary','Origin');
 if(origin && !allowedOrigins.includes(origin)){res.writeHead(403).end();return;}
 if(origin) res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Cache-Control','no-store');
 if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
 try {
  const path=new URL(req.url??'/', 'http://localhost').pathname;
  if(path==='/health' && req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));return;}
  const token=req.headers.authorization?.replace(/^Bearer /,'');
  let body:unknown;
  if(req.method==='POST'){let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>65536) fail(413,'body too large');}try{body=JSON.parse(data);}catch{fail(400,'invalid JSON');}}
  const match=path.match(/^\/requests\/([A-Za-z0-9_-]{43})(\/signature)?$/);
  let result:unknown;
  if(path==='/requests' && req.method==='POST') result=relay.submit((body as {pending?:unknown})?.pending,token);
  else if(match && req.method==='GET') result=match[2]?relay.signature(match[1],token):relay.pending(match[1]);
  else if(match?.[2] && req.method==='POST') result=relay.sign(match[1],body);
  else fail(404,'unknown endpoint');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 } catch(e){res.writeHead(e instanceof RelayError?e.status:500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e instanceof RelayError?e.message:'request failed'}));}
});}
