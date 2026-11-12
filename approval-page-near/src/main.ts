import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import '@near-wallet-selector/modal-ui/styles.css';
import { Buffer, pendingSchema, signatureFile } from './protocol';
import { review, rpcView, usdc } from './review';
import './style.css';
const status=document.querySelector('#status')!, details=document.querySelector('#details')!;
const connect=document.querySelector<HTMLButtonElement>('#connect')!,sign=document.querySelector<HTMLButtonElement>('#sign')!;
const error=(e:unknown)=>{status.textContent=e instanceof Error?e.message:String(e);};
async function main(){
 const query=new URLSearchParams(location.search),id=query.get('request'),relay=new URL(query.get('relay')??import.meta.env.VITE_DEFAULT_RELAY??'');
 if(!id || !/^[A-Za-z0-9_-]{43}$/.test(id) || !['https:','http:'].includes(relay.protocol)) throw new Error('Invalid relay or request');
 const endpoint=new URL(`/requests/${id}`,relay).toString();
 const response=await fetch(endpoint);if(!response.ok) throw new Error('Cannot load request');
 const data=await response.json(),p=pendingSchema.parse(data.pending);
 const check=async()=>{const facts=await review(p,rpcView(p));if(facts.errors.length) throw new Error(facts.errors.join('\n'));return facts;};
 const facts=await check();
 details.textContent=[`Network: ${p.network}`,`RPC (supplied by agent): ${p.rpcUrl}`,`Vault: ${p.vault}`,`Token (confirm this is your USDC): ${facts.vault.token}`,`Amount: ${usdc(p.payment.amount)}`,`Recipient: ${p.payment.recipient} — allowed: ${facts.recipient.allowed}`,`Agent: ${p.payment.agent}`,`Per-payment limit: ${usdc(facts.agent.per_payment_limit)}`,`Agent daily limit: ${usdc(facts.agent.daily_limit)}`,`Vault daily limit: ${usdc(facts.vault.vault_daily_limit)}`,`Daily spending still applies; remaining balance is not checked here.`,`Approver: ${p.authorization.signer} — enabled: ${facts.approver.enabled}, version: ${facts.approver.version}`,`Authorization expires: ${new Date(Number(p.authorization.authorization_expiry)*1000).toISOString()}`,`Payment expires: ${new Date(Number(p.payment.valid_until)*1000).toISOString()}`,`Invoice reference (unverified): ${p.invoiceReference}`,`Message:\n${p.message}`].join('\n\n');
 if(data.status!=='pending') throw new Error(`Request is ${data.status}`);
 const post=async(result:{accountId:string;publicKey:string;signature:string},callback:string|null)=>{
  await check();const file=signatureFile(p,result,callback);
  const r=await fetch(endpoint+'/signature',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(file)});
  if(!r.ok) throw new Error(`Relay refused signature (${r.status})`);
  sessionStorage.removeItem('styx-near-sign');status.textContent='Signature delivered. The agent can submit the payment.';sign.hidden=true;
 };
 const fragment=new URLSearchParams(location.hash.slice(1));
 if(fragment.has('signature')){
  const saved=JSON.parse(sessionStorage.getItem('styx-near-sign')??'null');
  history.replaceState(null,'',location.pathname+location.search);
  if(!saved || saved.endpoint!==endpoint || saved.nonce!==p.authorization.approval_nonce || fragment.get('state')!==saved.state) throw new Error('No matching redirect signing session');
  await post({accountId:fragment.get('accountId')??'',publicKey:fragment.get('publicKey')??'',signature:fragment.get('signature')??''},saved.callback);return;
 }
 const selector=await setupWalletSelector({network:p.network,modules:[setupMyNearWallet(),setupMeteorWallet()]});
 const modal=setupModal(selector,{contractId:p.vault});
 connect.hidden=false;sign.hidden=false;status.textContent='Chain checks passed. Confirm the vault, token and RPC before signing.';
 connect.onclick=()=>modal.show();
 sign.onclick=async()=>{sign.disabled=true;try{
  await check();const wallet=await selector.wallet();
  const callback=wallet.id==='my-near-wallet'?location.origin+location.pathname+location.search:null;
  const state=crypto.randomUUID();
  if(callback) sessionStorage.setItem('styx-near-sign',JSON.stringify({endpoint,nonce:p.authorization.approval_nonce,callback,state}));
  const result=await wallet.signMessage({message:p.message,nonce:Buffer.from(p.authorization.approval_nonce,'base64'),recipient:p.vault,...(callback?{callbackUrl:callback,state}:{})});
  if(result) await post(result,callback);
 }catch(e){error(e);}finally{sign.disabled=false;}};
}
main().catch(error);
