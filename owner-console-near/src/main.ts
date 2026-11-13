import './polyfill';
import { setupWalletSelector, type WalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
// Inside the Meteor mobile app's own browser this signs through the app natively; elsewhere it stays hidden.
import { setupMeteorWalletApp } from '@near-wallet-selector/meteor-wallet-app';
import '@near-wallet-selector/modal-ui/styles.css';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { RPC, TEST_TOKEN, account, publicKey, amount, formPlan, overview, history as readHistory, discoveries, FACTORIES, createPlan, createdVault, amountNear, describePlan, batchPlan, describeBatch, batchDeposit, fundsProblem, agentEnv, agentEnvName, agentSetupCommands, PRESETS, inviteMessage, inviteNonceBytes, newInviteNonce, joinUrl, returnUrl, readInvite, inviteValid, type Invite, type EventRow, type Plan, type Batch } from './core';
import '../../site/styx.css';
import './style.css';
const $=<T extends HTMLElement=HTMLElement>(s:string)=>document.querySelector<T>(s)!;
const status=$('#status');
const say=(message:string)=>{status.textContent=message;};
const fail=(e:unknown)=>say(e instanceof Error?e.message:String(e));
const loadForm=$<HTMLFormElement>('#load');
const readForm=(form:HTMLFormElement)=>Object.fromEntries(new FormData(form).entries()) as Record<string,string>;
let context:{vault:string;network:string;rpc:RPC}|undefined, facts:Awaited<ReturnType<typeof overview>>|undefined;
let selector:WalletSelector|undefined, connected='',rows:EventRow[]=[],busy=false;
let known={agents:new Set<string>(),approvers:new Set<string>(),recipients:new Set<string>()};
let plan:Batch|undefined,planContext:typeof context;
let unsubscribe:(()=>void)|undefined;
const review=$<HTMLDialogElement>('#review');
let pendingAction:(()=>Promise<void>)|undefined;
const clearPlan=()=>{plan=undefined;pendingAction=undefined;if(review.open)review.close();};
// One review dialog for every transaction: it opens where the user pressed Preview, and Sign runs \`action\`.
function openReview(title:string,lines:string[],action:()=>Promise<void>){
 $('#review-title').textContent=title;$('#preview').textContent=lines.join('\n');pendingAction=action;
 if(!review.open) review.showModal();
}
const txLink=(network:string,hash:string)=>`https://${network==='testnet'?'testnet.':''}nearblocks.io/txns/${encodeURIComponent(hash)}`;
function toast(kind:'ok'|'error',title:string,detail='',href?:string){
 const node=document.createElement('div');node.className=`toast ${kind}`;node.setAttribute('role',kind==='error'?'alert':'status');
 node.append(el('strong',title));if(detail) node.append(el('span',detail));
 if(href){const link=el('a','View transaction') as HTMLAnchorElement;link.href=href;link.target='_blank';link.rel='noopener noreferrer';node.append(link);}
 const close=el('button','Close') as HTMLButtonElement;close.type='button';close.className='toast-close';close.onclick=()=>node.remove();node.append(close);
 $('#toasts').append(node);setTimeout(()=>node.remove(),kind==='ok'?9000:20000);
}
function role(){
 const owner=!!facts && connected===facts.info.owner;
 $('#role').textContent=connected?`${connected} · ${owner?'Owner controls available':`Read-only: the vault owner is ${facts?.info.owner??'not yet known'}.`}`:'Read-only: connect the owner account to change rules.';
 document.querySelectorAll<HTMLButtonElement>('[data-write]').forEach(button=>button.disabled=!owner || busy);
 $('#disconnect').hidden=!connected;
 renderSetup();
}
const el=(tag:string,text:string)=>{const node=document.createElement(tag);node.textContent=text;return node;};
function card(label:string,value:string){const node=el('article','');node.className='card';node.append(el('small',label),el('strong',value));return node;}
function render(){
 if(!facts || !context) return;
 const {info,day,spent,balance,storage}=facts;
 const area=$('#overview-data');area.replaceChildren(...[
  ['Owner',info.owner],['Token',info.token],['Paused',String(info.paused)],['Vault daily limit',amount(info.vault_daily_limit)],
  ["Today's vault spend",amount(spent)],['Vault token balance',amount(balance)],['UTC day',String(day)],['Network',context.network]
 ].map(([k,v])=>card(k,v)));
 $('#storage-status').textContent=storage?'Vault is registered with this token.':'Vault is not registered. Register it before funding.';
 const register=document.querySelector<HTMLButtonElement>('form[data-method="storage_deposit"] button');if(register){register.hidden=!!storage;}
 document.querySelector<HTMLElement>('form[data-method="mint"]')!.hidden=context.network!=='testnet'||info.token!==TEST_TOKEN;
 role();
}
async function walletSetup(network:string,vault:string){
 unsubscribe?.();
 selector=await setupWalletSelector({network:network as 'testnet'|'mainnet',modules:[setupMeteorWallet(),setupMeteorWalletApp({contractId:vault})]});
 const update=()=>{const accounts=selector!.store.getState().accounts;connected=accounts.find(a=>a.active)?.accountId??'';clearPlan();role();};
 update();const subscription=selector.store.observable.subscribe(update);unsubscribe=()=>subscription.unsubscribe();
 $('#connect').onclick=()=>setupModal(selector!,{contractId:vault}).show();
}
async function refresh(){
 if(!context) return;const current=context;
 const next=await overview(current.rpc,current.vault);if(context!==current) return;
 facts=next;render();await refreshKnown();
}
function allowance(key:string){
 const entry=facts?.keys.keys.find((k:any)=>k.public_key===key);
 const permission=entry?.access_key.permission;
 if(!entry) return 'No access key installed';
 if(permission==='FullAccess') return 'FULL ACCESS — this key is not restricted';
 const call=permission?.FunctionCall;
 return call?`Gas allowance: ${call.allowance===null?'unlimited':`${call.allowance} yoctoNEAR (${near(call.allowance)} NEAR)`}; receiver: ${call.receiver_id}; methods: ${call.method_names.join(', ')||'all methods'}`:'Access-key permission unavailable';
}
function near(value:string){const n=BigInt(value);return `${n/10n**24n}.${(n%10n**24n).toString().padStart(24,'0').replace(/0+$/,'')||'0'}`;}
async function refreshKnown(){
 if(!context || !facts) return;
 const c=context,day=facts.day;
 for(const [kind,keys] of Object.entries(known)){
  const container=$('#'+kind);container.replaceChildren(el('h3',kind[0].toUpperCase()+kind.slice(1)));
  for(const key of keys){
   const field=kind==='agents'?'agent':kind==='approvers'?'approver':'recipient';
   const panel=el('article','');panel.className='panel';panel.append(el('code',key));container.append(panel);
   try{
    const state=await c.rpc.view(c.vault,'get_'+field,{[field]:key});
    if(context!==c) return;
    if(!state){panel.append(el('p','No current entry'));continue;}
    panel.append(el('pre',JSON.stringify(state,null,2)));
    if(kind==='agents'){
     panel.append(el('p',allowance(key)));
     const spent=await c.rpc.view(c.vault,'spent_by_agent',{agent:key,day});
     panel.append(el('p',`${amount(spent)} / ${amount(state.daily_limit)} tokens spent today`));
     const bar=document.createElement('progress');bar.max=10000;bar.value=BigInt(state.daily_limit)>0n?Number(BigInt(spent)*10000n/BigInt(state.daily_limit)):0;panel.append(bar);
    }
   }catch(e){panel.append(el('p',`Current state unavailable: ${e instanceof Error?e.message:'RPC failure'}`));}
  }
 }
}
function renderPayments(){
 const tbody=$('#payment-rows');tbody.replaceChildren();
 const c=context!;
 for(const row of rows.filter(r=>r.event==='payment_executed')){
  const d=row.data,tr=document.createElement('tr');
  const cells:[string,string][]=[['Time (UTC)',row.time],['Agent',d.agent],['Recipient',d.recipient],['Amount',amount(d.amount)],['Exception / signer',d.exception?`Yes / ${d.signer}`:'No']];
  for(const [label,value] of cells){const td=el('td',String(value));td.dataset.label=label;tr.append(td);}
  const link=el('a',row.tx.slice(0,10)+'…') as HTMLAnchorElement;link.href=`https://${c.network==='testnet'?'testnet.':''}nearblocks.io/txns/${encodeURIComponent(row.tx)}`;link.target='_blank';link.rel='noopener noreferrer';
  const td=el('td','');td.dataset.label='Transaction';td.append(link);tr.append(td);tbody.append(tr);
 }
 $('#other-events').replaceChildren(...rows.filter(r=>r.event!=='payment_executed').map(r=>{
  // Do not render sealed ciphertext blobs; show event identity and public payment/key fields.
  return el('p',`${r.time} · ${r.event} · ${r.data.payment_id??r.data.agent??r.data.approver??r.data.recipient??''} · ${r.tx}`);
 }));
}
async function loadHistory(){
 if(!context) return;const c=context;$('#history-status').textContent='Reading the indexer and confirming receipt logs with RPC…';
 const result=await readHistory(c.rpc,c.vault,c.network);if(context!==c) return;
 rows=result.rows;$('#history-status').textContent=result.notice;
 const found=discoveries(rows);for(const kind of ['agents','approvers','recipients'] as const) for(const key of found[kind]) known[kind].add(key);
 renderPayments();await refreshKnown();renderSetup();
}
const definitions:[string,string,string[]][]=[
 ['configure_agent','Configure an agent',['agent','per_payment_limit','daily_limit','valid_until','enabled']],
 ['set_recipient','Allow or block a recipient',['recipient','allowed']],['set_approver','Set an approver',['approver','enabled']],
 ['set_vault_daily_limit','Vault daily limit',['limit']],['pause','Pause the vault',[]],['unpause','Unpause the vault',[]],['withdraw','Withdraw tokens',['to','amount']],
 ['storage_deposit','Register vault with token (0.00125 NEAR)',[]],['ft_transfer','Fund from owner wallet (1 yoctoNEAR)',['amount']],['mint','Mint tUSDC — test-token only',['amount']]
];
const labels:Record<string,string>={agent:'Agent public key',approver:'Approver public key',recipient:'Recipient account',to:'Withdrawal destination',per_payment_limit:'Per-payment limit (tokens)',daily_limit:'Agent daily limit (tokens)',valid_until:'Policy expiry (Unix seconds)',limit:'Vault daily limit (tokens)',amount:'Amount (tokens)',enabled:'Enabled',allowed:'Allowed'};
function fieldInput(field:string,value=''){
 const label=el('label',labels[field]);let input:HTMLInputElement|HTMLSelectElement;
 if(['enabled','allowed'].includes(field)){
  input=document.createElement('select');for(const v of ['true','false']){const option=el('option',v) as HTMLOptionElement;option.value=v;input.append(option);}
 }else{input=document.createElement('input');input.required=true;input.autocomplete='off';if(field==='valid_until')input.placeholder='Unix seconds, e.g. 1794614400';}
 input.name=field;if(value)input.value=value;label.append(input);return label;
}
function reviewLines(values:Record<string,string>,b:Batch){
 // Only amounts that a call in this transaction actually uses; an unused form field is not shown.
 const used=new Set(b.calls.flatMap(c=>Object.keys(c.args)));
 const units=Object.entries(values).filter(([k,v])=>v && used.has(k) && ['amount','per_payment_limit','daily_limit','limit'].includes(k)).map(([k,v])=>`${labels[k]}: ${v}`);
 const calls=b.calls.length>1?['',`${b.calls.length} calls, one approval. They run in order and fail together:`,...b.calls.map((c,i)=>`  ${i+1}. ${describePlan(c)}`)]:[];
 return [`Network: ${context!.network}`,`Signer: ${connected}`,`Vault: ${context!.vault}`,`Token: ${facts!.info.token}`,...units,`Attached NEAR: ${near(batchDeposit(b))}`,...calls,'',JSON.stringify(b.calls.length>1?b:b.calls[0],null,2)];
}
function previewBatch(plans:Plan[],values:Record<string,string>){
 if(!context || !facts || connected!==facts.info.owner) throw Error('Connect the vault owner');
 plan=batchPlan(plans);planContext=context;
 openReview(describeBatch(plan),reviewLines(values,plan),sendPlan);
}
function previewPlan(method:string,values:Record<string,string>){
 if(!context || !facts) throw Error('Connect the vault owner');
 previewBatch([formPlan(method,values,context.vault,facts.info.token,context.network)],values);
}
for(const [method,title,fields] of definitions){
 const form=document.createElement('form');form.className='panel';form.dataset.method=method;form.append(el('h3',title));
 for(const field of fields) form.append(fieldInput(field));
 const button=el('button','Preview transaction') as HTMLButtonElement;button.dataset.write='';button.disabled=true;form.append(button);
 form.oninput=clearPlan;
 form.onsubmit=e=>{e.preventDefault();try{previewPlan(method,readForm(form));}catch(e){fail(e);toast('error','Cannot preview',e instanceof Error?e.message:String(e));}};
 (['storage_deposit','ft_transfer','mint'].includes(method)?$('#fund-forms'):$('#rule-forms')).append(form);
}
$('#cancel').onclick=clearPlan;
review.addEventListener('close',()=>{pendingAction=undefined;});
$('#send').onclick=async()=>{const action=pendingAction;if(action && !busy) await action();};
async function sendPlan(){
 if(!plan || !context || !selector || context!==planContext || busy) return;
 const selected=plan,c=context;busy=true;role();
 const title=describeBatch(selected);
 try{
  await c.rpc.assertNetwork(c.network);
  const current=await c.rpc.view(c.vault,'get_vault');
  const active=selector.store.getState().accounts.find(a=>a.active)?.accountId;
  if(active!==current.owner || current.token!==facts?.info.token) throw Error('Owner or token changed; read and preview again');
  const wallet=await selector.wallet();
  if(!(await wallet.getAccounts()).some(a=>a.accountId===active)) throw Error('Selected wallet account differs');
  for(const call of selected.calls){
   if(call.method==='storage_deposit' && await c.rpc.view(current.token,'storage_balance_of',{account_id:c.vault})) throw Error('Vault is already registered; refresh state');
   // Funding sends the owner's own tokens: say so before the wallet fails on chain.
   if(call.method==='ft_transfer'){
    const held=await c.rpc.view(current.token,'ft_balance_of',{account_id:active});
    if(BigInt(held)<BigInt(String(call.args.amount))) throw Error(`Your account holds ${amount(held)} of ${current.token}, less than ${amount(String(call.args.amount))}.`+(c.network==='testnet' && current.token===TEST_TOKEN?' On testnet, use Mint tUSDC to fund the vault directly.':''));
   }
  }
  const funds=fundsProblem(await c.rpc.call('query',{request_type:'view_account',finality:'final',account_id:active}),batchDeposit(selected),active!);
  if(funds) throw Error(funds);
  clearPlan();say('Waiting for wallet approval. Do not submit again while the outcome is unknown.');
  const result=await wallet.signAndSendTransaction({signerId:active,receiverId:selected.receiverId,actions:selected.calls.map(p=>({type:'FunctionCall' as const,params:{methodName:p.method,args:p.args,gas:p.gas,deposit:p.deposit}}))});
  const hash=(result as any)?.transaction?.hash;
  if(hash) await c.rpc.transaction(hash,active!);
  for(const call of selected.calls){
   if(typeof call.args.agent==='string')known.agents.add(call.args.agent);
   if(typeof call.args.approver==='string')known.approvers.add(call.args.approver);
   if(typeof call.args.recipient==='string')known.recipients.add(call.args.recipient);
  }
  setupChoice=undefined;await refresh();say(hash?`Transaction finalized: ${hash}. State read back from the chain.`:'Wallet returned without a transaction outcome. State refreshed; verify before retrying.');
  if(hash) toast('ok',title,'Finalized and read back from the chain.',txLink(c.network,hash));
  else toast('error','No transaction outcome','The wallet returned without one. State refreshed; check before retrying.');
 }catch(e){fail(e);status.append(document.createTextNode(' If you approved in the wallet, the outcome may be unknown. Check state and transaction status before retrying.'));toast('error',`Not done: ${title}`,e instanceof Error?e.message:String(e));try{await refresh();}catch{/* retain the original error */}}
 finally{busy=false;role();}
}
// Makes an agent key in this browser, downloads it once, and returns the public key.
function generateAgentKey():string{
 if(!context || connected!==facts?.info.owner) throw Error('Connect the owner before generating an agent key');
 const pair=nacl.sign.keyPair(),pk='ed25519:'+bs58.encode(pair.publicKey);
 const keyFile={account_id:context.vault,public_key:pk,private_key:'ed25519:'+bs58.encode(pair.secretKey)};
 const url=URL.createObjectURL(new Blob([JSON.stringify(keyFile,null,2)+'\n'],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;lastAgentFile=`styx-agent-${context.vault}-${crypto.randomUUID()}.json`;link.download=lastAgentFile;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);pair.secretKey.fill(0);
 return pk;
}
$('#generate').onclick=()=>{
 try{
  const pk=generateAgentKey();
  const form=document.querySelector<HTMLFormElement>('form[data-method="configure_agent"]')!;
  (form.elements.namedItem('agent') as HTMLInputElement).value=pk;
  $('#generated').textContent=`Downloaded once. Public key: ${pk}. Set its limits and expiry in Configure an agent, preview, then sign.`;clearPlan();
 }catch(e){fail(e);}
};
$('#lookup').onsubmit=async e=>{e.preventDefault();try{
 if(!context) throw Error('Read a vault first');const v=readForm($<HTMLFormElement>('#lookup'));
 if(v.kind==='agent')known.agents.add(publicKey(v.key));else if(v.kind==='approver')known.approvers.add(publicKey(v.key));else known.recipients.add(account(v.key));await refreshKnown();renderSetup();
}catch(e){fail(e);}};
$('#history').onclick=()=>loadHistory().catch(fail);
$('#disconnect').onclick=async()=>{try{await (await selector?.wallet())?.signOut();connected='';clearPlan();role();}catch(e){fail(e);}};
async function load(){
 if(busy) return;clearPlan();facts=undefined;connected='';selector=undefined;unsubscribe?.();role();
 try{
  const values=readForm(loadForm);if(!['testnet','mainnet'].includes(values.network)) throw Error('Unsupported network');
  context={vault:account(values.vault),network:values.network,rpc:new RPC(values.rpc)};
  known={agents:new Set(),approvers:new Set(),recipients:new Set()};rows=[];
  say('Reading finalized vault state…');await context.rpc.assertNetwork(context.network);await refresh();
  await walletSetup(context.network,context.vault);say('Vault state read from the chain.');
  const loadedUrl=new URL(location.href);loadedUrl.searchParams.set('vault',context.vault);loadedUrl.searchParams.set('rpc',context.rpc.url);loadedUrl.searchParams.set('network',context.network);window.history.replaceState(null,'',loadedUrl);
  const hashes=new URLSearchParams(location.search).get('transactionHashes');
  if(hashes){const clean=new URL(location.href);clean.searchParams.delete('transactionHashes');window.history.replaceState(null,'',clean);for(const hash of hashes.split(',')) await context.rpc.transaction(hash,facts!.info.owner);await refresh();say('Wallet return: transaction finalized and state read back.');}
  await loadHistory();
 }catch(e){facts=undefined;role();fail(e);}
}
loadForm.onsubmit=e=>{e.preventDefault();void load();};
// Before a vault is read there is no wallet selector yet: Connect reads the vault in the form first,
// then opens the wallet list, instead of doing nothing.
$('#connect').onclick=async()=>{try{if(!selector) await load();if(selector && context) setupModal(selector,{contractId:context.vault}).show();}catch(e){fail(e);}};
const query=new URLSearchParams(location.search);
// ---- Join mode (?join=<vault>): an invited approver signs one message and gets a link back for the owner ----
async function joinFlow(vault:string,network:string){
 for(const sec of document.querySelectorAll<HTMLElement>('main > section, main > nav, main > form, #status, #role, main > .kicker')) sec.hidden=true;
 $('#join').hidden=false;$('#join-title').textContent=`Approve exceptions for ${vault}`;
 $('#join-lead').textContent='The owner of this vault asked you to approve payments that go over its limit. Connect your NEAR wallet and sign one message: it is not a transaction, cannot move funds, and only proves which key you will approve with. You get a link to send back to the owner.';
 const sel=await setupWalletSelector({network:network as 'testnet'|'mainnet',modules:[setupMeteorWallet(),setupMeteorWalletApp({contractId:vault})]});
 const sync=()=>{const a=sel.store.getState().accounts.find(x=>x.active);$('#join-sign').hidden=!a;$('#join-connect').textContent=a?`Connected: ${a.accountId}`:'Connect wallet';};
 sync();sel.store.observable.subscribe(sync);
 $('#join-connect').onclick=()=>setupModal(sel,{contractId:vault}).show();
 $('#join-sign').onclick=async()=>{
  try{
   const nonce=newInviteNonce(),wallet=await sel.wallet();
   const r=await wallet.signMessage({message:inviteMessage(vault),nonce:Buffer.from(inviteNonceBytes(nonce)),recipient:vault});
   if(!r) return;
   const i:Invite={vault,accountId:r.accountId,publicKey:r.publicKey,nonce,signature:r.signature};
   if(!(await inviteValid(i))) throw Error('The wallet returned a signature that does not check out. Try again.');
   const url=returnUrl(consoleBase(),network,i);
   $('#join-status').textContent=`Signed with ${r.publicKey}. Send this link to the vault owner:`;
   const result=$('#join-result');result.replaceChildren(copyBlock(url),telegramNote(true));$('#join-sign').hidden=true;
  }catch(e){$('#join-status').textContent=e instanceof Error?e.message:String(e);}
 };
}
for(const key of ['vault','rpc','network']){const v=query.get(key);if(v)(loadForm.elements.namedItem(key) as HTMLInputElement).value=v;}
// A wallet redirect or an explicit vault link reads state on arrival; opening the page alone is read-only too.
if(query.has('join')){const v=query.get('join')!;joinFlow(account(v),query.get('network')==='mainnet'?'mainnet':'testnet').catch(fail);}
else if(query.has('vault') || query.has('transactionHashes')) loadForm.requestSubmit();
role();
// ---- Create a vault through the factory: preview, sign in the wallet, read the result, open it ----
const createForm=$<HTMLFormElement>('#create-form'),createStatus=$('#create-status');
(createForm.elements.namedItem('token') as HTMLInputElement).value=TEST_TOKEN;
createForm.onsubmit=async e=>{e.preventDefault();try{
 const v=readForm(createForm),where=readForm(loadForm),network=where.network,factory=FACTORIES[network];
 if(!factory) throw Error(`No vault factory on ${network}`);
 const rpc=new RPC(where.rpc);await rpc.assertNetwork(network);
 const minimum=await rpc.view(factory,'min_deposit');
 const p=createPlan(v.name,v.token,v.deposit,network,minimum),vault=`${p.args.name}.${factory}`;
 const taken=await rpc.call('query',{request_type:'view_account',finality:'final',account_id:vault}).then(()=>true,()=>false);
 if(taken) throw Error(`${vault} already exists; choose another name`);
 if(!selector) await walletSetup(network,factory);
 if(!connected){setupModal(selector!,{contractId:factory}).show();createStatus.textContent='Connect your wallet, then press Preview vault again.';return;}
 const funds=fundsProblem(await rpc.call('query',{request_type:'view_account',finality:'final',account_id:connected}),p.deposit,connected);
 if(funds) throw Error(funds+(network==='testnet'?' Top up the account with testnet NEAR, then press Preview vault again.':''));
 createStatus.textContent='';
 openReview(`Create ${vault}`,[`Network: ${network}`,`Signer and owner: ${connected}`,`Factory: ${factory}`,`New vault: ${vault}`,`Token: ${p.args.token}`,`Attached NEAR: ${amountNear(p.deposit)} (minimum ${amountNear(minimum)})`,'',JSON.stringify(p,null,2)],()=>sendCreate(p,rpc,network));
}catch(err){createStatus.textContent=err instanceof Error?err.message:String(err);}};
async function sendCreate(p:Plan,rpc:RPC,network:string){
 if(!selector || busy) return;busy=true;
 try{
  const wallet=await selector.wallet(),signer=connected;
  clearPlan();createStatus.textContent='Waiting for wallet approval. Do not submit again while the outcome is unknown.';
  const result=await wallet.signAndSendTransaction({signerId:signer,receiverId:p.receiverId,actions:[{type:'FunctionCall',params:{methodName:p.method,args:p.args,gas:p.gas,deposit:p.deposit}}]});
  const hash=(result as any)?.transaction?.hash;if(!hash) throw Error('Wallet returned without a transaction. Check your wallet before trying again.');
  const tx=await rpc.call('tx',{tx_hash:hash,sender_account_id:signer,wait_until:'FINAL'});
  const vault=createdVault(tx);
  if(!vault){createStatus.textContent=`Creation failed and the deposit was refunded (${hash}).`;toast('error','Vault not created','The deposit was refunded.',txLink(network,hash));return;}
  createStatus.textContent=`Created ${vault}. Opening it.`;toast('ok',`Vault created: ${vault}`,'You own it. Two more approvals below and it is ready.',txLink(network,hash));
  (loadForm.elements.namedItem('vault') as HTMLInputElement).value=vault;busy=false;await load();
  $('#setup').scrollIntoView({behavior:'smooth'});
 }catch(err){const m=err instanceof Error?err.message:String(err);createStatus.textContent=m+' If you approved in the wallet, check the transaction before retrying.';toast('error','Vault not created',m);}
 finally{busy=false;}
}

// ---- Guided setup: two steps, one wallet approval each, ticked off from chain state ----
// Each step's calls go to one contract (the token, then the vault), so each step is one transaction.
const BOT='Styx_pvt_bot';
type Step={title:string;why:string;fields:string[];optional?:boolean;defaults:()=>Record<string,string>;plans:(v:Record<string,string>)=>Plan[];done:()=>boolean};
const testToken=()=>context?.network==='testnet' && facts?.info.token===TEST_TOKEN;
const agentInstalled=()=>!!facts?.keys.keys.some((k:any)=>typeof k.access_key.permission==='object' && k.access_key.permission.FunctionCall?.method_names?.includes('pay'));
const rulesDone={limit:()=>(facts?.info.vault_daily_limit??'0')!=='0',recipient:()=>known.recipients.size>0,approver:()=>known.approvers.size>0,agent:agentInstalled};
const owned=(method:string,v:Record<string,string>)=>formPlan(method,v,context!.vault,facts!.info.token,context!.network);
const steps:Step[]=[
 {title:'Register and fund the vault',why:`One approval: the token registers the vault (0.00125 NEAR, once) and ${'{fund}'} into it. The agent pays from this balance.`,fields:['amount'],defaults:()=>({amount:'100'}),
  plans:v=>[...(facts?.storage?[]:[owned('storage_deposit',{})]),owned(testToken()?'mint':'ft_transfer',v)],done:()=>!!facts?.storage && BigInt(facts?.balance??'0')>0n},
 {title:'Set the rules',why:'One approval sets the vault\'s daily cap, who it may pay, who approves exceptions, and the agent\'s own limits. Leave a field empty to skip it.',
  fields:['limit','recipient','approver','agent','per_payment_limit','daily_limit','valid_until'],optional:true,
  defaults:()=>({approver:invited?.publicKey??'',limit:rulesDone.limit()?'':'500',per_payment_limit:'10',daily_limit:'100',valid_until:String(Math.floor(Date.now()/1000)+7*86400)}),
  plans:v=>[
   ...(v.limit?[owned('set_vault_daily_limit',{limit:v.limit})]:[]),
   ...(v.recipient?[owned('set_recipient',{recipient:v.recipient.trim(),allowed:'true'})]:[]),
   ...(v.approver?[owned('set_approver',{approver:v.approver.trim(),enabled:'true'})]:[]),
   ...(v.agent?[owned('configure_agent',{agent:v.agent.trim(),per_payment_limit:v.per_payment_limit,daily_limit:v.daily_limit,valid_until:v.valid_until,enabled:'true'})]:[]),
  ],done:()=>Object.values(rulesDone).every(f=>f())},
];
function telegramNote(you=false){
 const box=document.createElement('div');box.className='setup-note';
 const link=el('a',`Open @${BOT} in Telegram`) as HTMLAnchorElement;link.href=`https://t.me/${BOT}`;link.target='_blank';link.rel='noopener noreferrer';
 box.append(el('p',you?`Get each request on your phone: send /start to @${BOT} in Telegram, open the link it replies with, and sign the link message in this wallet. Once is enough.`:`Your approver links their wallet to Telegram once: send /start to @${BOT}, open the link it replies with, and sign the link message in their NEAR wallet. After that, every request over the per-payment limit reaches their phone.`),link);
 return box;
}
let setupChoice:number|undefined,lastAgentFile:string|undefined,invited:(Invite&{onChain:boolean})|undefined;
const consoleBase=()=>location.origin+location.pathname;
function inviteBox(){
 const box=document.createElement('div');box.className='invite';
 if(invited){box.append(el('small',`From ${invited.accountId}'s invite: signature checked${invited.onChain?', and the key is on that account':'. The key is not on that account on chain; check with them before adding it.'}`));}
 const b=el('button','Copy an invite link for your approver') as HTMLButtonElement;b.type='button';b.className='secondary';
 b.onclick=async()=>{const url=joinUrl(consoleBase(),context!.vault,context!.network);try{await navigator.clipboard.writeText(url);toast('ok','Invite link copied','Send it to your approver. They sign once in their wallet and send you back a link that fills this in.');}catch{prompt('Copy this invite link',url);}};
 box.append(b);return box;
}
function download(name:string,text:string){
 const url=URL.createObjectURL(new Blob([text],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function copyBlock(text:string){
 const wrap=document.createElement('div');wrap.className='copy-block';const pre=el('pre',text);
 const b=el('button','Copy') as HTMLButtonElement;b.type='button';b.className='secondary';b.onclick=async()=>{try{await navigator.clipboard.writeText(text);b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500);}catch{b.textContent='Select and copy';}};
 wrap.append(pre,b);return wrap;
}
// After setup: give the agent its key without ever showing the key. The env file holds paths only.
function agentHandoff(){
 const box=document.createElement('div');box.className='setup-note';const vault=context!.vault;
 box.append(el('h4','Hand the agent its key'));
 const approver=[...known.approvers][0];
 if(!approver){box.append(el('p','Add an approver first: the agent\'s settings name who it asks for exceptions.'));return box;}
 box.append(el('p','Download the settings (vault, approver, and where the key file will live; no key material). From the Styx repo, these commands move both downloads into a private folder and print the claude mcp add line for your agent.'));
 const dl=el('button','Download agent settings') as HTMLButtonElement;dl.type='button';dl.className='secondary';dl.onclick=()=>download(agentEnvName(vault),agentEnv(vault,approver));box.append(dl);
 if(lastAgentFile) box.append(copyBlock(agentSetupCommands(vault,lastAgentFile)));
 else box.append(el('p','This visit did not generate the key, so move them by hand: the agent key file to $HOME/.styx-near-agent/'+vault+'/agent.json (chmod 600), the settings file to demo.env beside it, and a state folder there (mkdir -m 700). Then run scripts/near/mcp_config.sh on that demo.env.'));
 return box;
}
function presetBar(form:HTMLFormElement){
 const bar=document.createElement('div');bar.className='presets';bar.append(el('span','Start from'));
 for(const p of PRESETS){const b=el('button',p.name) as HTMLButtonElement;b.type='button';b.className='secondary';b.title=p.note;
  b.onclick=()=>{for(const [k,v] of Object.entries(p.values)){const i=form.elements.namedItem(k) as HTMLInputElement|null;if(i && !(k==='limit' && rulesDone.limit()))i.value=v;}bar.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));};bar.append(b);}
 return bar;
}
function renderSetup(){
 const section=$('#setup');
 if(!context || !facts || connected!==facts.info.owner){section.hidden=true;return;}
 section.hidden=false;
 const state=steps.map(s=>s.done()),count=state.filter(Boolean).length;
 const current=setupChoice??state.findIndex(d=>!d);
 $('#setup-progress').textContent=`${count} of ${steps.length} done`;
 $('#setup-steps').replaceChildren(...steps.map((step,i)=>{
  const item=document.createElement('li');item.className=(state[i]?'done ':'')+(i===current?'current':'');
  const button=el('button',`${state[i]?'Done':`Step ${i+1}`} · ${step.title}`) as HTMLButtonElement;button.type='button';button.className='step-link';
  button.onclick=()=>{setupChoice=i;renderSetup();};item.append(button);return item;
 }));
 const form=$<HTMLFormElement>('#setup-form');
 if(current<0){
  form.replaceChildren(el('h3','This vault is ready'),el('p','The agent can pay allowed recipients within its limits. Payments over the per-payment limit go to your approver.'),agentHandoff(),telegramNote());
  return;
 }
 const step=steps[current],values=step.defaults();
 const fund=testToken()?'mints test tUSDC':'moves your tokens';
 form.replaceChildren(el('p',`Step ${current+1} of ${steps.length} · one wallet approval${state[current]?' · already done':''}`),el('h3',step.title),el('p',step.why.replace('{fund}',fund)));
 if(step.fields.includes('per_payment_limit')) form.append(presetBar(form));
 for(const field of step.fields){
  const label=fieldInput(field,values[field]??'');
  if(step.optional){const input=label.querySelector('input');if(input)input.required=false;}
  if(field==='recipient' && rulesDone.recipient()) label.append(el('small','A recipient is already allowed; add another or leave empty.'));
  if(field==='approver'){if(rulesDone.approver()) label.append(el('small','An approver is already set; add another or leave empty.'));label.append(inviteBox());form.append(label,telegramNote());continue;}
  if(field==='agent' && agentInstalled()) label.append(el('small','An agent is already installed; add another or leave empty.'));
  form.append(label);
 }
 const actions=document.createElement('div');actions.className='setup-actions';
 if(step.fields.includes('agent')){const gen=el('button','Generate agent key') as HTMLButtonElement;gen.type='button';gen.className='secondary';gen.onclick=()=>{try{const pk=generateAgentKey();(form.elements.namedItem('agent') as HTMLInputElement).value=pk;toast('ok','Agent key downloaded','Keep the file safe; only its public key goes on chain.');}catch(e){toast('error','Cannot generate a key',e instanceof Error?e.message:String(e));}};actions.append(gen);}
 const sign=el('button','Review and sign') as HTMLButtonElement;sign.dataset.write='';sign.disabled=busy;actions.append(sign);
 const skip=el('button',current<steps.length-1?'Skip this step':'Close') as HTMLButtonElement;skip.type='button';skip.className='secondary';skip.onclick=()=>{setupChoice=current<steps.length-1?current+1:-1;renderSetup();};actions.append(skip);
 form.append(actions);
 form.onsubmit=e=>{e.preventDefault();try{const v=readForm(form);previewBatch(step.plans(v),v);}catch(err){toast('error','Cannot preview',err instanceof Error?err.message:String(err));}};
}

// ---- Return link from an invited approver (declared after the setup state it fills in) ----
if(!query.has('join')){
 // A return link from an invited approver: check the signature and that the key is on their account.
 try{const i=readInvite(query);if(i){(async()=>{
  if(!(await inviteValid(i))){toast('error','Invite link did not check out','The signature does not match the key and vault. Ask the approver for a new link.');return;}
  const rpc=new RPC((loadForm.elements.namedItem('rpc') as HTMLInputElement).value);
  const onChain=await rpc.call('query',{request_type:'view_access_key',finality:'final',account_id:i.accountId,public_key:i.publicKey}).then(()=>true,()=>false);
  invited={...i,onChain};setupChoice=1;renderSetup();
  toast('ok',`Approver invite from ${i.accountId}`,onChain?'Signature checked; the key is on their account. It is filled in under Set the rules.':'Signature checked, but the key is not on that account. Check with them before adding it.');
 })().catch(fail);}}catch(e){fail(e);}
}
