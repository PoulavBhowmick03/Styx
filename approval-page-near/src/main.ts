import './polyfill';
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
// Inside the Meteor mobile app's own browser this signs through the app natively; elsewhere it stays hidden.
import { setupMeteorWalletApp } from '@near-wallet-selector/meteor-wallet-app';
import '@near-wallet-selector/modal-ui/styles.css';
import { Buffer, pendingSchema, signatureFile, isEvmPending } from './protocol';
import { review, rpcView, usdc, destinationDetails, PAGE_RPC } from './review';
import { linkFlow } from './link';
import { summary, text, showDetails, shortKey, amount, chainName } from './ui';
import '../../site/styx.css';
const status=document.querySelector('#status')!, details=document.querySelector('#details')!;
const connect=document.querySelector<HTMLButtonElement>('#connect')!,sign=document.querySelector<HTMLButtonElement>('#sign')!;
const error=(e:unknown)=>{status.textContent=e instanceof Error?e.message:String(e);status.className='error';};
async function main(){
 const query=new URLSearchParams(location.search),id=query.get('request'),relay=new URL(query.get('relay')??import.meta.env.VITE_DEFAULT_RELAY??'');
 const code=query.get('link');
 if(code!==null){if(!['https:','http:'].includes(relay.protocol)) throw new Error('Invalid relay');return linkFlow(code,relay,{title:document.querySelector('h1')!,status,details,connect,sign},error);}
 if(!id && code===null){status.textContent='Open the link in your Telegram alert to review a request. To get alerts, send /start to the Styx bot.';text('lead','This page shows one payment an agent asks to make over its limit, read back from the vault, for the approver to sign.');return;}
 if(!id || !/^[A-Za-z0-9_-]{43}$/.test(id) || !['https:','http:'].includes(relay.protocol)) throw new Error('This link is incomplete. Open it again from the Telegram alert.');
 const endpoint=new URL(`/requests/${id}`,relay).toString();
 const response=await fetch(endpoint);if(!response.ok) throw new Error('Cannot load request');
 const data=await response.json(),p=pendingSchema.parse(data.pending);
 let displayedEvmToken:string|undefined;
 const check=async()=>{try{
  const facts=await review(p,rpcView(p));
  if(facts.errors.length) throw new Error(facts.errors.join('\n'));
  if(isEvmPending(p)){
   if(displayedEvmToken!==undefined && displayedEvmToken!==facts.evmChain.token) throw new Error('EVM token configuration changed. Reload and review the destination again.');
   displayedEvmToken=facts.evmChain.token;
  }
  return facts;
 }catch(e){sign.hidden=true;throw e;}};
 const facts=await check();
 text('lead','An agent asks to pay over its per-payment limit. Check the payment, then sign it in your wallet.');
 summary([['Amount',amount(usdc(p.payment.amount)),true],['To',p.payment.recipient],['On',chainName(p.chainId)],['Per-payment limit',amount(usdc(facts.agent.per_payment_limit))],['Vault',p.vault],['Approver',shortKey(p.authorization.signer)],['Expires',new Date(Number(p.authorization.authorization_expiry)*1000).toLocaleString()]]);
 showDetails([`Network: ${p.network}`,`RPC: ${PAGE_RPC[p.network]} (this page's own; the request suggested ${p.rpcUrl})`,`Vault: ${p.vault}`,...destinationDetails(p,facts),`Amount: ${usdc(p.payment.amount)}`,`Agent: ${p.payment.agent}`,`Per-payment limit: ${usdc(facts.agent.per_payment_limit)}`,`Agent daily limit: ${usdc(facts.agent.daily_limit)}`,`Vault daily limit: ${usdc(facts.vault.vault_daily_limit)}`,`Daily spending still applies; remaining balance is not checked here.`,`Approver: ${p.authorization.signer} — enabled: ${facts.approver.enabled}, version: ${facts.approver.version}`,`Authorization expires: ${new Date(Number(p.authorization.authorization_expiry)*1000).toISOString()}`,`Payment expires: ${new Date(Number(p.payment.valid_until)*1000).toISOString()}`,`Invoice reference (unverified): ${p.invoiceReference}`,`Message:\n${p.message}`].join('\n\n'));
 if(data.status==='signed'){status.textContent='Already signed. The agent can submit the payment.';status.className='done';return;}
 if(data.status!=='pending') throw new Error(`Request is ${data.status}`);
 const post=async(result:{accountId:string;publicKey:string;signature:string},callback:string|null)=>{
  await check();const file=signatureFile(p,result,callback);
  const r=await fetch(endpoint+'/signature',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(file)});
  if(!r.ok) throw new Error(`Relay refused signature (${r.status})`);
  sessionStorage.removeItem('styx-near-sign');status.textContent='Signature delivered. The agent can submit the payment.';status.className='done';sign.hidden=true;
 };
 const fragment=new URLSearchParams(location.hash.slice(1));
 if(fragment.has('signature')){
  const saved=JSON.parse(sessionStorage.getItem('styx-near-sign')??'null');
  history.replaceState(null,'',location.pathname+location.search);
  if(!saved || saved.endpoint!==endpoint || saved.nonce!==p.authorization.approval_nonce || fragment.get('state')!==saved.state) throw new Error('No matching redirect signing session');
  if(isEvmPending(p) && saved.evmToken!==facts.evmChain.token) throw new Error('EVM token configuration changed. Reload and review the destination again.');
  await post({accountId:fragment.get('accountId')??'',publicKey:fragment.get('publicKey')??'',signature:fragment.get('signature')??''},saved.callback);return;
 }
 const selector=await setupWalletSelector({network:p.network,modules:[setupMeteorWallet(),setupMeteorWalletApp({contractId:p.vault})]});
 const modal=setupModal(selector,{contractId:p.vault});
 connect.hidden=false;sign.hidden=false;status.textContent=`Checked on chain through this page's own RPC: the vault, limits and approver match this request. Confirm the vault under All details.`;
 connect.onclick=()=>modal.show();
 sign.onclick=async()=>{sign.disabled=true;try{
  await check();const wallet=await selector.wallet();
  const callback=null; // Meteor signs inline; no redirect callback is put in the signed payload
  const state=crypto.randomUUID();
  if(callback) sessionStorage.setItem('styx-near-sign',JSON.stringify({endpoint,nonce:p.authorization.approval_nonce,callback,state,evmToken:displayedEvmToken??null}));
  const result=await wallet.signMessage({message:p.message,nonce:Buffer.from(p.authorization.approval_nonce,'base64'),recipient:p.vault,...(callback?{callbackUrl:callback,state}:{})});
  if(result) await post(result,callback);
 }catch(e){error(e);}finally{sign.disabled=false;}};
}
main().catch(error);
