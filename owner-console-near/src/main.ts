import './polyfill';
import { setupWalletSelector, type WalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
// Inside the Meteor mobile app's own browser this signs through the app natively; elsewhere it stays hidden.
import { setupMeteorWalletApp } from '@near-wallet-selector/meteor-wallet-app';
import '@near-wallet-selector/modal-ui/styles.css';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { RPC, TEST_TOKEN, account, publicKey, amount, formPlan, overview, history as readHistory, discoveries, FACTORIES, createPlan, createdVault, amountNear, describePlan, type EventRow, type Plan } from './core';
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
let plan:Plan|undefined,planContext:typeof context;
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
function reviewLines(values:Record<string,string>,p:Plan){
 const human=Object.entries(values).filter(([k])=>['amount','per_payment_limit','daily_limit','limit'].includes(k)).map(([k,v])=>`${labels[k]}: ${v} → ${String(p.args[k])} base units`);
 return [`Network: ${context!.network}`,`Signer: ${connected}`,`Vault: ${context!.vault}`,`Token: ${facts!.info.token}`,...human,`Attached NEAR: ${near(p.deposit)} (${p.deposit} yoctoNEAR)`,'',JSON.stringify(p,null,2)];
}
function previewPlan(method:string,values:Record<string,string>){
 if(!context || !facts || connected!==facts.info.owner) throw Error('Connect the vault owner');
 plan=formPlan(method,values,context.vault,facts.info.token,context.network);planContext=context;
 openReview(describePlan(plan),reviewLines(values,plan),sendPlan);
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
 try{
  await c.rpc.assertNetwork(c.network);
  const current=await c.rpc.view(c.vault,'get_vault');
  const active=selector.store.getState().accounts.find(a=>a.active)?.accountId;
  if(active!==current.owner || current.token!==facts?.info.token) throw Error('Owner or token changed; read and preview again');
  const wallet=await selector.wallet();
  if(!(await wallet.getAccounts()).some(a=>a.accountId===active)) throw Error('Selected wallet account differs');
  if(selected.method==='storage_deposit' && await c.rpc.view(current.token,'storage_balance_of',{account_id:c.vault})) throw Error('Vault is already registered; refresh state');
  // Funding sends the owner's own tokens: say so before the wallet fails on chain.
  if(selected.method==='ft_transfer'){
   const held=await c.rpc.view(current.token,'ft_balance_of',{account_id:active});
   if(BigInt(held)<BigInt(String(selected.args.amount))) throw Error(`Your account holds ${amount(held)} of ${current.token}, less than ${amount(String(selected.args.amount))}.`+(c.network==='testnet' && current.token===TEST_TOKEN?' On testnet, use Mint tUSDC to fund the vault directly.':''));
  }
  clearPlan();say('Waiting for wallet approval. Do not submit again while the outcome is unknown.');
  const callback=new URL(location.href);callback.searchParams.set('vault',c.vault);callback.searchParams.set('rpc',c.rpc.url);callback.searchParams.set('network',c.network);
  const result=await wallet.signAndSendTransaction({signerId:active,receiverId:selected.receiverId,actions:[{type:'FunctionCall',params:{methodName:selected.method,args:selected.args,gas:selected.gas,deposit:selected.deposit}}]});
  const hash=(result as any)?.transaction?.hash;
  if(hash) await c.rpc.transaction(hash,active!);
  if(typeof selected.args.agent==='string')known.agents.add(selected.args.agent);
  if(typeof selected.args.approver==='string')known.approvers.add(selected.args.approver);
  if(typeof selected.args.recipient==='string')known.recipients.add(selected.args.recipient);
  setupChoice=undefined;await refresh();say(hash?`Transaction finalized: ${hash}. State read back from the chain.`:'Wallet returned without a transaction outcome. State refreshed; verify before retrying.');
  if(hash) toast('ok',describePlan(selected),'Finalized and read back from the chain.',txLink(c.network,hash));
  else toast('error','No transaction outcome','The wallet returned without one. State refreshed; check before retrying.');
 }catch(e){fail(e);status.append(document.createTextNode(' If you approved in the wallet, the outcome may be unknown. Check state and transaction status before retrying.'));toast('error',`Not done: ${describePlan(selected)}`,e instanceof Error?e.message:String(e));try{await refresh();}catch{/* retain the original error */}}
 finally{busy=false;role();}
}
// Makes an agent key in this browser, downloads it once, and returns the public key.
function generateAgentKey():string{
 if(!context || connected!==facts?.info.owner) throw Error('Connect the owner before generating an agent key');
 const pair=nacl.sign.keyPair(),pk='ed25519:'+bs58.encode(pair.publicKey);
 const keyFile={account_id:context.vault,public_key:pk,private_key:'ed25519:'+bs58.encode(pair.secretKey)};
 const url=URL.createObjectURL(new Blob([JSON.stringify(keyFile,null,2)+'\n'],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download=`styx-agent-${context.vault}-${crypto.randomUUID()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);pair.secretKey.fill(0);
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
 if(v.kind==='agent')known.agents.add(publicKey(v.key));else if(v.kind==='approver')known.approvers.add(publicKey(v.key));else known.recipients.add(account(v.key));await refreshKnown();
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
for(const key of ['vault','rpc','network']){const v=query.get(key);if(v)(loadForm.elements.namedItem(key) as HTMLInputElement).value=v;}
// A wallet redirect or an explicit vault link reads state on arrival; opening the page alone is read-only too.
if(query.has('vault') || query.has('transactionHashes')) loadForm.requestSubmit();
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
  createStatus.textContent=`Created ${vault}. Opening it.`;toast('ok',`Vault created: ${vault}`,'You own it. Set it up below, one step at a time.',txLink(network,hash));
  (loadForm.elements.namedItem('vault') as HTMLInputElement).value=vault;busy=false;await load();
  $('#setup').scrollIntoView({behavior:'smooth'});
 }catch(err){const m=err instanceof Error?err.message:String(err);createStatus.textContent=m+' If you approved in the wallet, check the transaction before retrying.';toast('error','Vault not created',m);}
 finally{busy=false;}
}

// ---- Guided setup: one step at a time, each ticked off from chain state ----
type Step={title:string;why:string;method:()=>string;fields:string[];defaults:()=>Record<string,string>;done:()=>boolean};
const testToken=()=>context?.network==='testnet' && facts?.info.token===TEST_TOKEN;
const agentInstalled=()=>!!facts?.keys.keys.some((k:any)=>typeof k.access_key.permission==='object' && k.access_key.permission.FunctionCall?.method_names?.includes('pay'));
const steps:Step[]=[
 {title:'Register with the token',why:'The token keeps a balance for the vault only after this one-time registration. It costs 0.00125 NEAR.',method:()=>'storage_deposit',fields:[],defaults:()=>({}),done:()=>!!facts?.storage},
 {title:'Fund the vault',why:'The agent pays from this balance. On testnet, mint test tUSDC straight into the vault.',method:()=>testToken()?'mint':'ft_transfer',fields:['amount'],defaults:()=>({amount:'100'}),done:()=>BigInt(facts?.balance??'0')>0n},
 {title:'Set the vault daily limit',why:'Nothing can be paid while it is 0. It caps every agent together per UTC day.',method:()=>'set_vault_daily_limit',fields:['limit'],defaults:()=>({limit:'500'}),done:()=>(facts?.info.vault_daily_limit??'0')!=='0'},
 {title:'Allow a recipient',why:'The agent can pay only accounts you allow.',method:()=>'set_recipient',fields:['recipient','allowed'],defaults:()=>({allowed:'true'}),done:()=>known.recipients.size>0},
 {title:'Add an approver',why:'Their NEAR public key signs payments over the per-payment limit. They get each request in Telegram after sending /start to @Styx_pvt_bot.',method:()=>'set_approver',fields:['approver','enabled'],defaults:()=>({enabled:'true'}),done:()=>known.approvers.size>0},
 {title:'Add the agent',why:'Generate the agent key here (it downloads once), then set its limits. The vault installs it as a key that can only call the pay methods.',method:()=>'configure_agent',fields:['agent','per_payment_limit','daily_limit','valid_until','enabled'],defaults:()=>({per_payment_limit:'10',daily_limit:'100',valid_until:String(Math.floor(Date.now()/1000)+7*86400),enabled:'true'}),done:agentInstalled},
];
let setupChoice:number|undefined;
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
 if(current<0){form.replaceChildren(el('h3','This vault is ready'),el('p','The agent can pay allowed recipients within its limits. Give it the downloaded key file and the vault name; payments over the per-payment limit go to your approver.'));return;}
 const step=steps[current],method=step.method(),values=step.defaults();
 form.replaceChildren(el('p',`Step ${current+1} of ${steps.length}${state[current]?' · already done':''}`),el('h3',step.title),el('p',step.why));
 for(const field of step.fields) form.append(fieldInput(field,values[field]??''));
 const actions=document.createElement('div');actions.className='setup-actions';
 if(method==='configure_agent'){const gen=el('button','Generate agent key') as HTMLButtonElement;gen.type='button';gen.className='secondary';gen.onclick=()=>{try{const pk=generateAgentKey();(form.elements.namedItem('agent') as HTMLInputElement).value=pk;toast('ok','Agent key downloaded','Keep the file safe; only its public key goes on chain.');}catch(e){toast('error','Cannot generate a key',e instanceof Error?e.message:String(e));}};actions.append(gen);}
 const sign=el('button','Review and sign') as HTMLButtonElement;sign.dataset.write='';sign.disabled=busy;actions.append(sign);
 const skip=el('button',current<steps.length-1?'Skip this step':'Close') as HTMLButtonElement;skip.type='button';skip.className='secondary';skip.onclick=()=>{setupChoice=current<steps.length-1?current+1:-1;renderSetup();};actions.append(skip);
 form.append(actions);
 form.onsubmit=e=>{e.preventDefault();try{previewPlan(method,readForm(form));}catch(err){toast('error','Cannot preview',err instanceof Error?err.message:String(err));}};
}
