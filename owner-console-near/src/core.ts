import { Buffer } from 'buffer';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { serialize } from 'borsh';
export const LIVE_VAULT='vault.styx-owner-c87a.testnet';
export const TEST_TOKEN='usdc.styx-owner-c87a.testnet';
export const GAS='100000000000000';
export const STORAGE_DEPOSIT='1250000000000000000000';
export function account(value:string){if(value.length<2 || value.length>64 || !/^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*$/.test(value)) throw Error('Invalid NEAR account id');return value;}
export function publicKey(value:string){try{if(!value.startsWith('ed25519:') || bs58.decode(value.slice(8)).length!==32) throw Error();}catch{throw Error('Expected an ed25519 public key (32 bytes, base58)');}return value;}
export function units(value:string){
 if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) throw Error('Enter a non-negative amount with at most six decimals');
 const [whole,fraction='']=value.split('.');const n=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
 if(n>=1n<<128n) throw Error('Amount exceeds uint128');return n.toString();
}
export function amount(value:string){const n=BigInt(value);return `${n/1000000n}.${(n%1000000n).toString().padStart(6,'0')}`;}
export type Plan={receiverId:string;method:string;args:Record<string,unknown>;deposit:string;gas:string};
export function formPlan(method:string,v:Record<string,string>,vault:string,token:string,network:string):Plan{
 account(vault);account(token);
 const enabled=()=>{if(!['true','false'].includes(v.enabled)) throw Error('Choose enabled or disabled');return v.enabled==='true';};
 let args:Record<string,unknown>={},receiverId=vault,deposit='0';
 switch(method){
 case 'configure_agent':{
  if(!/^[0-9]+$/.test(v.valid_until) || BigInt(v.valid_until)>=1n<<64n) throw Error('Expiry must be Unix seconds (uint64)');
  args={agent:publicKey(v.agent),per_payment_limit:units(v.per_payment_limit),daily_limit:units(v.daily_limit),valid_until:v.valid_until,enabled:enabled()};break;
 }
 case 'set_approver':args={approver:publicKey(v.approver),enabled:enabled()};break;
 case 'set_sentinel':args={key:publicKey(v.key),enabled:enabled()};break;
 case 'set_recipient':if(!['true','false'].includes(v.allowed)) throw Error('Choose allowed or denied');args={recipient:account(v.recipient),allowed:v.allowed==='true'};break;
 case 'set_vault_daily_limit':args={limit:units(v.limit)};break;
 case 'pause':case 'unpause':break;
 case 'withdraw':args={to:account(v.to),amount:units(v.amount)};break;
 case 'storage_deposit':receiverId=token;deposit=STORAGE_DEPOSIT;args={account_id:vault,registration_only:true};break;
 case 'ft_transfer':receiverId=token;deposit='1';args={receiver_id:vault,amount:units(v.amount),memo:'Styx vault funding'};break;
 case 'mint':if(network!=='testnet' || token!==TEST_TOKEN) throw Error('Mint is only available for the Styx testnet test token');receiverId=token;args={account_id:vault,amount:units(v.amount)};break;
 default:throw Error('Unsupported owner method');
 }
 return {receiverId,method,args,deposit,gas:GAS};
}
export type EventRow={event:string;data:Record<string,any>;tx:string;time:string};
const eventNames=new Set(['agent_configured','approver_set','recipient_set','payment_executed','payment_failed','record_sealed','sentinel_set','sentinel_paused','paused','unpaused']);
export function parseEvents(tx:any,vault:string,time='Unavailable'):EventRow[]{
 const rows:EventRow[]=[];
 for(const receipt of tx.receipts_outcome??[]){
  const out=receipt.outcome;
  if(out?.executor_id!==vault || (!('SuccessValue' in (out.status??{})) && !('SuccessReceiptId' in (out.status??{})))) continue;
  for(const line of out.logs??[]){
   if(typeof line!=='string' || !line.startsWith('EVENT_JSON:')) continue;
   let log:any;try{log=JSON.parse(line.slice(11));}catch{continue;}
   if(log.standard!=='styx' || log.version!=='1.0.0' || !eventNames.has(log.event) || !Array.isArray(log.data)) continue;
   for(const data of log.data) if(data && typeof data==='object' && !Array.isArray(data)) rows.push({event:log.event,data,tx:tx.transaction.hash,time});
  }
 }
 return rows;
}
export function discoveries(rows:EventRow[]){
 const agents=new Set<string>(),approvers=new Set<string>(),recipients=new Set<string>();
 for(const {event,data} of rows){
  if(['agent_configured','payment_executed','payment_failed','record_sealed'].includes(event) && typeof data.agent==='string') agents.add(publicKey(data.agent));
  if(event==='approver_set' && typeof data.approver==='string') approvers.add(publicKey(data.approver));
  if(event==='payment_executed' && typeof data.signer==='string') approvers.add(publicKey(data.signer));
  if(typeof data.recipient==='string') recipients.add(account(data.recipient));
 }
 return {agents,approvers,recipients};
}
export class RPC{
 constructor(readonly url:string){if(!['https:','http:'].includes(new URL(url).protocol)) throw Error('RPC must use HTTP(S)');}
 async call(method:string,params:Record<string,unknown>):Promise<any>{
  const r=await fetch(this.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'styx-console',method,params}),signal:AbortSignal.timeout(20000)});
  if(!r.ok) throw Error(`RPC unavailable (${r.status})`);const data=await r.json();if(data.error || !('result' in data)) throw Error('RPC returned an error or incomplete response');return data.result;
 }
 async assertNetwork(network:string){const status=await this.call('status',{});if(status.chain_id!==network) throw Error(`RPC chain ${status.chain_id??'unavailable'} differs from selected network ${network}`);}
 async view(account_id:string,method_name:string,args:Record<string,unknown>={}){
  const r=await this.call('query',{request_type:'call_function',finality:'final',account_id,method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
  return JSON.parse(Buffer.from(r.result).toString());
 }
 async transaction(hash:string,sender:string){
  const tx=await this.call('tx',{tx_hash:hash,sender_account_id:sender,wait_until:'FINAL'});
  if(tx.final_execution_status!=='FINAL' || !('SuccessValue' in (tx.status??{})) || tx.transaction.hash!==hash) throw Error('Transaction not final and successful');return tx;
 }
}
export function indexerRows(data:any):{hash:string;sender:string}[]{
 if(!Array.isArray(data?.txns)) throw Error('Indexer response has no transaction list');
 return data.txns.map((t:any)=>{const hash=t.transaction_hash??t.hash,sender=t.signer_account_id??t.signer_id??t.predecessor_account_id;
 if(typeof hash!=='string' || typeof sender!=='string') throw Error('Indexer transaction is missing its hash or sender');return {hash,sender};});
}
export async function history(rpc:RPC,vault:string,network:string,get:typeof fetch=fetch):Promise<{rows:EventRow[];notice:string}>{
 const host=network==='testnet'?'https://api-testnet.nearblocks.io':'https://api.nearblocks.io';
 const rows:EventRow[]=[],seen=new Set<string>();let failed=0,complete=false,cursor:string|undefined,stopped='';
 // Bound work and always label the result as a window, never a complete registry.
 // NearBlocks serves only the first page by number; later pages need the returned cursor.
 for(let page=1;page<=3;page++){
  let txns:{hash:string;sender:string}[];
  try{
   const r=await get(`${host}/v1/account/${encodeURIComponent(vault)}/txns?per_page=25${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal:AbortSignal.timeout(15000)});
   if(!r.ok) throw Error(`Indexer unavailable (${r.status})`);
   const data=await r.json();txns=indexerRows(data);cursor=typeof data.cursor==='string'?data.cursor:undefined;
  }catch(e){stopped=e instanceof Error?e.message:String(e);break;}
  for(const {hash,sender} of txns){
   if(seen.has(hash)) continue;seen.add(hash);
   try{
    const tx=await rpc.transaction(hash,sender);
    const block=await rpc.call('block',{block_id:tx.transaction_outcome.block_hash});
    const time=new Date(Number(BigInt(block.header.timestamp_nanosec??block.header.timestamp)/1000000n)).toISOString();
    rows.push(...parseEvents(tx,vault,time));
   }catch{failed++;}
  }
  if(txns.length<25 || !cursor){complete=true;break;}
 }
 if(stopped && !seen.size) return {rows,notice:`Lists unavailable: ${stopped}. Manual key lookups still work.`};
 return {rows,notice:`Event window: ${seen.size} indexed transactions checked; ${failed} unavailable or failed. ${stopped?`Stopped early: ${stopped}.`:complete?'Indexer list exhausted.':'Limited to the latest 75 indexer entries.'} Older keys or events may be absent. Use manual lookups.`};
}
export async function overview(rpc:RPC,vault:string){
 const info=await rpc.view(vault,'get_vault');if(![1,2,3].includes(info.contract_version)) throw Error('Unsupported vault contract version');
 const day=await rpc.view(vault,'current_day');
 const [spent,balance,storage,keys]=await Promise.all([
  rpc.view(vault,'spent_by_vault',{day}),rpc.view(info.token,'ft_balance_of',{account_id:vault}),
  rpc.view(info.token,'storage_balance_of',{account_id:vault}),rpc.call('query',{request_type:'view_access_key_list',finality:'final',account_id:vault})]);
 return {info,day,spent,balance,storage,keys};
}

// ---- Creating a vault through the factory (contracts/near/styx-factory) ----
export const FACTORIES:Record<string,string>={testnet:'styx-vaults.testnet'};
// Mirrors the factory's rule, so a bad name is caught before the wallet opens.
export function vaultName(name:string):string{
 if(!/^[a-z0-9]([a-z0-9]|[-_](?=[a-z0-9])){1,31}$/.test(name) || name.length>32) throw Error('Vault name: 2 to 32 of a-z, 0-9, - or _, starting and ending with a letter or digit');
 return name;
}
export function nearToYocto(value:string):string{
 const m=/^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,24}))?$/.exec(value.trim());if(!m) throw Error('Deposit must be NEAR, for example 4 or 4.5');
 return (BigInt(m[1])*10n**24n+BigInt((m[2]??'').padEnd(24,'0')||'0')).toString();
}
export function createPlan(name:string,token:string,depositNear:string,network:string,minimum:string):Plan{
 const factory=FACTORIES[network];if(!factory) throw Error(`No vault factory on ${network}`);
 const deposit=nearToYocto(depositNear);if(BigInt(deposit)<BigInt(minimum)) throw Error(`Deposit must be at least ${amountNear(minimum)} NEAR (the vault code's storage plus 0.5 NEAR)`);
 return {receiverId:factory,method:'create_vault',args:{name:vaultName(name),token:account(token)},deposit,gas:'100000000000000'};
}
export const amountNear=(yocto:string)=>{const v=BigInt(yocto),whole=v/10n**24n,frac=(v%10n**24n).toString().padStart(24,'0').slice(0,4).replace(/0+$/,'');return frac?`${whole}.${frac}`:`${whole}`;};
// The factory returns the vault account, or null when creation failed and the deposit was refunded.
export function createdVault(tx:any):string|null{
 const value=tx?.status?.SuccessValue;if(typeof value!=='string') throw Error('Transaction did not succeed');
 return JSON.parse(Buffer.from(value,'base64').toString()||'null');
}

// ---- What a transaction did, in words, for toasts and the review title ----
const tokens=(v:unknown)=>{const s=String(v??'0');return amount(s).replace(/\.?0+$/,'');};
export function describePlan(p:Plan):string{
 const a=p.args as Record<string,unknown>;
 switch(p.method){
  case 'configure_agent':return a.enabled?`Agent configured: ${tokens(a.per_payment_limit)} per payment, ${tokens(a.daily_limit)} a day`:'Agent disabled';
  case 'set_recipient':return `${a.allowed?'Recipient allowed':'Recipient blocked'}: ${a.recipient}`;
  case 'set_approver':return `${a.enabled?'Approver set':'Approver disabled'}: ${String(a.approver).slice(0,18)}…`;
  case 'set_sentinel':return `${a.enabled?'Sentinel installed':'Sentinel removed'}: ${String(a.key).slice(0,18)}…`;
  case 'set_vault_daily_limit':return `Vault daily limit set to ${tokens(a.limit)}`;
  case 'pause':return 'Vault paused';
  case 'unpause':return 'Vault unpaused';
  case 'withdraw':return `Withdrew ${tokens(a.amount)} to ${a.to}`;
  case 'storage_deposit':return 'Vault registered with the token';
  case 'ft_transfer':return `Funded the vault with ${tokens(a.amount)}`;
  case 'mint':return `Minted ${tokens(a.amount)} tUSDC to the vault`;
  case 'create_vault':return `Vault created: ${a.name}`;
  case 'add_proposal':{const n=(a as any).proposal?.kind?.FunctionCall?.actions?.length??0;return `Proposed to ${p.receiverId}: ${n} change${n===1?'':'s'}, for its members to vote on`;}
  default:return p.method;
 }
}

// ---- Several calls to one receiver, signed once ----
// NEAR runs a transaction's actions in order, in one receipt, and all of them fail together.
// Setup calls burn 1.5 to 3.2 Tgas each on testnet. Up to eight calls get 30 Tgas each; a longer
// batch (for example a recipient list) gets 14 Tgas each, so twenty calls stay under the 300 Tgas limit.
export const BATCH_GAS='30000000000000';
export const BATCH_GAS_LONG='14000000000000';
export const BATCH_MAX=20;
export type Batch={receiverId:string;calls:Plan[]};
export function batchPlan(plans:Plan[]):Batch{
 if(!plans.length) throw Error('Nothing to sign: fill in at least one field');
 if(plans.length>BATCH_MAX) throw Error(`At most ${BATCH_MAX} calls in one transaction`);
 const receiverId=plans[0].receiverId;
 if(plans.some(p=>p.receiverId!==receiverId)) throw Error('One transaction can only call one contract');
 return {receiverId,calls:plans.length===1?plans:plans.map(p=>({...p,gas:plans.length>8?BATCH_GAS_LONG:BATCH_GAS}))};
}
export const describeBatch=(b:Batch)=>b.calls.length===1?describePlan(b.calls[0]):`${b.calls.length} changes in one transaction`;
export const batchDeposit=(b:Batch)=>b.calls.reduce((s,p)=>s+BigInt(p.deposit),0n).toString();

// ---- Can this account pay for what it is about to sign? ----
// NEAR keeps 1e19 yoctoNEAR per byte of account storage locked; the rest of `amount` is spendable.
export const GAS_RESERVE='50000000000000000000000'; // 0.05 NEAR for gas
export function spendable(view:{amount:string;storage_usage:number}):bigint{
 const free=BigInt(view.amount)-BigInt(view.storage_usage)*10n**19n;return free>0n?free:0n;
}
export function fundsProblem(view:{amount:string;storage_usage:number},deposit:string,who:string):string|null{
 const free=spendable(view),need=BigInt(deposit)+BigInt(GAS_RESERVE);
 return free>=need?null:`${who} has ${amountNear(free.toString())} NEAR to spend; this needs ${amountNear(deposit)} NEAR plus about 0.05 for gas.`;
}

// ---- Handing the agent its key: settings for scripts/near/mcp_config.sh, never the key itself ----
// The env file names where the key file will live; the key stays in the file the browser downloaded.
export const agentHome=(vault:string)=>`$HOME/.styx-near-agent/${account(vault)}`;
export function agentEnv(vault:string,approver:string):string{
 const home=agentHome(vault);
 return ['# Styx agent settings for scripts/near/mcp_config.sh. No key material: only where the key file lives.',
  `STYX_NEAR_VAULT=${account(vault)}`,`STYX_NEAR_AGENT_KEY_FILE=${home}/agent.json`,`STYX_NEAR_STATE_ROOT=${home}/state`,
  `STYX_NEAR_APPROVER=${publicKey(approver)}`,''].join('\n');
}
export const agentEnvName=(vault:string)=>`styx-agent-${account(vault)}.env`;
// No clone needed: cargo installs the agent CLI from GitHub, and uvx runs the MCP server from GitHub
// (it finds styx-near-vault on PATH). Assumes the browser saved the key file to ~/Downloads.
export const REPO='https://github.com/PoulavBhowmick03/Styx';
export function agentSetupCommands(vault:string,keyFile:string,approver:string):string{
 if(!/^styx-agent-[a-z0-9._-]+\.json$/.test(keyFile)) throw Error('Unexpected key file name');
 const home=agentHome(vault),v=account(vault),a=publicKey(approver);
 return [`mkdir -p -m 700 "${home}/state" "${home}/invoices"`,
  `mv ~/Downloads/${keyFile} "${home}/agent.json" && chmod 600 "${home}/agent.json"`,
  `cargo install --locked --git ${REPO} styx-near`,
  `claude mcp add styx-vault -e STYX_BACKEND=vault -e STYX_VAULT_DIR="${home}/invoices" -e STYX_NEAR_VAULT=${v} -e STYX_NEAR_AGENT_KEY_FILE="${home}/agent.json" -e STYX_NEAR_STATE_ROOT="${home}/state" -e STYX_NEAR_APPROVER=${a} -- uvx --from "git+${REPO}#subdirectory=mcp-server" styx-mcp-server`].join('\n');
}

// ---- Starting points for the rules step (amounts in tokens) ----
export const PRESETS:{name:string;note:string;values:Record<string,string>}[]=[
 {name:'Cautious',note:'5 a payment, 20 a day',values:{limit:'50',per_payment_limit:'5',daily_limit:'20'}},
 {name:'Personal agent',note:'10 a payment, 100 a day',values:{limit:'500',per_payment_limit:'10',daily_limit:'100'}},
 {name:'Team',note:'50 a payment, 500 a day',values:{limit:'2000',per_payment_limit:'50',daily_limit:'500'}},
];

// ---- Approver invites: the approver proves they hold a key by signing one NEP-413 message ----
// Not a transaction. The owner's console checks the signature and that the key is on the named
// account, then fills in the approver field; adding the approver is still the owner's own transaction.
export const inviteMessage=(vault:string)=>`Styx: I will approve payments over the limit for ${account(vault)} with this key.`;
const b64u=(b:Uint8Array)=>Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64u=(s:string)=>new Uint8Array(Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64'));
export function inviteSigningBytes(vault:string,nonce:Uint8Array):Uint8Array{
 if(nonce.length!==32) throw Error('Nonce must be 32 bytes');
 return serialize({struct:{tag:'u32',message:'string',nonce:{array:{type:'u8',len:32}},recipient:'string',callbackUrl:{option:'string'}}},
  {tag:2147484061,message:inviteMessage(vault),nonce:Array.from(nonce),recipient:vault,callbackUrl:null});
}
export type Invite={vault:string;accountId:string;publicKey:string;nonce:string;signature:string};
export function joinUrl(base:string,vault:string,network:string):string{
 const u=new URL(base);u.search='';u.hash='';u.searchParams.set('join',account(vault));u.searchParams.set('network',network);return u.toString();
}
export function returnUrl(base:string,network:string,i:Invite):string{
 const u=new URL(base);u.search='';u.hash='';
 for(const [k,v] of [['vault',i.vault],['network',network],['approver',i.publicKey],['approver_account',i.accountId],['nonce',i.nonce],['sig',i.signature]]) u.searchParams.set(k,v);
 return u.toString();
}
export function readInvite(q:URLSearchParams):Invite|null{
 if(!q.get('approver')) return null;
 const i={vault:account(q.get('vault')??''),accountId:account(q.get('approver_account')??''),publicKey:publicKey(q.get('approver')??''),nonce:q.get('nonce')??'',signature:q.get('sig')??''};
 if(unb64u(i.nonce).length!==32) throw Error('Invite link is damaged: bad nonce');return i;
}
export const newInviteNonce=()=>{const n=new Uint8Array(32);crypto.getRandomValues(n);return b64u(n);};
export const inviteNonceBytes=(n:string)=>unb64u(n);
// Wallets return the signature in base64 (NEP-413). The wallet signs sha256 of the Borsh payload.
export async function inviteValid(i:Invite):Promise<boolean>{
 try{
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(inviteSigningBytes(i.vault,unb64u(i.nonce)))));
  const sig=Buffer.from(i.signature.replace(/-/g,'+').replace(/_/g,'/'),'base64');
  return sig.length===64 && nacl.sign.detached.verify(digest,new Uint8Array(sig),bs58.decode(i.publicKey.slice(8)));
 }catch{return false;}
}

// ---- Agent policy expiry: the vault refuses payments with PolicyExpired once valid_until passes ----
export const EXPIRY_SOON_SECONDS=48*3600;
export function expiry(validUntil:string,now:number):{state:'ok'|'soon'|'expired';text:string}{
 const left=Number(BigInt(validUntil))-now;
 const span=(s:number)=>s>=86400?`${Math.floor(s/86400)} day${s>=2*86400?'s':''}`:s>=3600?`${Math.floor(s/3600)} h`:`${Math.max(1,Math.floor(s/60))} min`;
 if(left<0) return {state:'expired',text:`Expired ${span(-left)} ago: the vault refuses this agent's payments (PolicyExpired).`};
 if(left<EXPIRY_SOON_SECONDS) return {state:'soon',text:`Expires in ${span(left)}. After that the vault refuses its payments.`};
 return {state:'ok',text:`Active for ${span(left)} more.`};
}
// Same limits, new expiry. configure_agent replaces the whole policy, so every field is carried over.
export function extendValues(agent:string,state:{per_payment_limit:string;daily_limit:string;enabled:boolean},now:number,days=30):Record<string,string>{
 return {agent:publicKey(agent),per_payment_limit:amount(state.per_payment_limit),daily_limit:amount(state.daily_limit),valid_until:String(now+days*86400),enabled:String(state.enabled)};
}
// Agents are the vault's function-call keys allowed to call pay; they are on chain even when no indexer is.
export function agentKeys(keys:{keys:{public_key:string;access_key:{permission:any}}[]}):string[]{
 return keys.keys.filter(k=>typeof k.access_key.permission==='object' && k.access_key.permission.FunctionCall?.method_names?.includes('pay')).map(k=>k.public_key);
}

// ---- Names for keys and accounts: kept in this browser (or a shared file), never on chain ----
export type Labels=Record<string,string>;
const labelKey=(k:string)=>{if(k.startsWith('ed25519:')) return publicKey(k);return account(k);};
export function cleanLabel(name:string):string{const n=name.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,40);if(!n) throw Error('Name cannot be empty');return n;}
// Accepts a labels file: {"vault":"…","labels":{"ed25519:…":"CFO", "vendor.testnet":"Acme"}}. Bad entries are dropped.
export function parseLabels(text:string,vault:string):Labels{
 let d:any;try{d=JSON.parse(text);}catch{throw Error('Not a labels file (invalid JSON)');}
 if(!d || typeof d!=='object' || typeof d.labels!=='object' || Array.isArray(d.labels)) throw Error('Not a labels file');
 if(d.vault!==undefined && d.vault!==vault) throw Error(`These labels are for ${String(d.vault)}, not ${vault}`);
 const out:Labels={};for(const [k,v] of Object.entries(d.labels)){try{if(typeof v==='string') out[labelKey(k)]=cleanLabel(v);}catch{/* skip */}}return out;
}
export const labelsFile=(vault:string,labels:Labels)=>JSON.stringify({vault:account(vault),labels},null,2)+'\n';
export const short=(k:string)=>k.startsWith('ed25519:')?`${k.slice(0,14)}…${k.slice(-4)}`:k;
export const named=(k:string,labels:Labels)=>labels[k]?`${labels[k]} (${short(k)})`:k;

// ---- A pasted recipient list: one account per line (or comma/space separated), optional name after a comma ----
export function parseRecipients(text:string):{account:string;name?:string}[]{
 const out:{account:string;name?:string}[]=[],seen=new Set<string>();
 const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
 for(const line of lines){
  const named=/^([^,\s]+)\s*,\s*(.+)$/.exec(line);
  const parts=named?[named[1]]:line.split(/[\s,;]+/).filter(Boolean);
  for(const raw of parts){
   const a=raw.toLowerCase();try{account(a);}catch{throw Error(`Not a NEAR account: ${raw}`);}
   if(seen.has(a)) continue;seen.add(a);out.push(named?{account:a,name:cleanLabel(named[2])}:{account:a});
  }
 }
 return out;
}

// ---- Does an approver get Telegram alerts? The relay answers GET /links/<key> with {linked}. ----
export const DEFAULT_RELAY='https://styx-relay-near.fly.dev';
export async function telegramLinked(relay:string,key:string,get:typeof fetch=fetch):Promise<boolean|null>{
 try{
  const r=await get(new URL(`/links/${encodeURIComponent(publicKey(key))}`,relay).toString(),{signal:AbortSignal.timeout(8000)});
  if(!r.ok) return null;const d=await r.json();return d?.publicKey===key && typeof d.linked==='boolean'?d.linked:null;
 }catch{return null;}
}

// ---- Spend alerts: the relay's bot watches a vault from a t.me deep link (relay-near/src/watches.ts) ----
// Start payloads allow [A-Za-z0-9_-] up to 64 characters; account ids never hold two separators in a
// row, so '.' is written as '--'. Returns null when the vault id is too long for a payload.
export function watchLink(bot:string,vault:string):string|null{
 const payload='watch-'+account(vault).replace(/\./g,'--');
 return payload.length<=64?`https://t.me/${bot}?start=${payload}`:null;
}

// ---- A DAO as the owner. The vault checks predecessor_account_id == owner, so a Sputnik DAO that
// created the vault (or was made owner) changes its rules through passed proposals. The console wraps
// the same calls in one add_proposal (FunctionCall kind, Sputnik DAO v2), with the DAO's proposal bond.
export type DaoPolicy={proposal_bond:string};
export const isDaoPolicy=(p:any):p is DaoPolicy=>!!p && typeof p==='object' && typeof p.proposal_bond==='string' && /^[0-9]+$/.test(p.proposal_bond) && Array.isArray(p.roles);
export const PROPOSAL_GAS='50000000000000';
export function daoProposal(b:Batch,dao:string,bond:string,description:string):Batch{
 const desc=description.replace(/[\u0000-\u001f]/g,' ').slice(0,500);
 const actions=b.calls.map(c=>({method_name:c.method,args:Buffer.from(JSON.stringify(c.args)).toString('base64'),deposit:c.deposit,gas:c.gas}));
 return {receiverId:account(dao),calls:[{receiverId:account(dao),method:'add_proposal',args:{proposal:{description:desc,kind:{FunctionCall:{receiver_id:b.receiverId,actions}}}},deposit:bond,gas:PROPOSAL_GAS}]};
}

// ---- Freeze an agent: the same policy with enabled false. configure_agent then removes its access key. ----
export function freezeValues(agent:string,state:{per_payment_limit:string;daily_limit:string;valid_until:string|number}):Record<string,string>{
 return {agent:publicKey(agent),per_payment_limit:amount(state.per_payment_limit),daily_limit:amount(state.daily_limit),valid_until:String(state.valid_until),enabled:'false'};
}

// ---- Payments as CSV, with local names beside the keys ----
// Quoted per RFC 4180. A cell that a spreadsheet would run as a formula (= + - @, tab, CR) gets a
// leading apostrophe, so a name or recipient cannot execute in the owner's spreadsheet.
const csvCell=(v:unknown)=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s)) s="'"+s;return /[",\n\r]/.test(s)||s!==s.trim()?`"${s.replace(/"/g,'""')}"`:s;};
export function paymentsCsv(rows:EventRow[],names:Labels):string{
 const head=['time_utc','agent','agent_name','recipient','recipient_name','amount','exception','signer','signer_name','payment_id','transaction'];
 const lines=rows.filter(r=>r.event==='payment_executed').map(r=>{const d=r.data;return [r.time,d.agent,names[d.agent]??'',d.recipient,names[d.recipient]??'',amount(String(d.amount)),d.exception?'yes':'no',d.signer??'',d.signer?names[d.signer]??'':'',d.payment_id??'',r.tx];});
 return [head,...lines].map(l=>l.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

// ---- Sentinels (contract version 3): watcher keys that may only call sentinel_pause ----
// set_sentinel installs a function-call key on the vault allowed only sentinel_pause (0.05 NEAR
// allowance), or deletes it. A sentinel cannot pay, unpause or change a rule; only the owner unpauses.
export const SENTINEL_VERSION=3;
export const MAX_SENTINELS=8;
// The command that protects a vault with sentinels: no key material in it, the runner makes its own keys.
export function sentinelQuickstart(vault:string):string{
 return ['git clone https://github.com/PoulavBhowmick03/Styx && cd Styx',
  'cargo build --release --manifest-path sdk/near/Cargo.toml',
  `uv run --project sentinels styx-sentinels quickstart --vault ${account(vault)} --cli sdk/near/target/release/styx-near-vault`].join('\n');
}
export function sentinelKeys(keys:{keys:{public_key:string;access_key:{permission:any}}[]}):string[]{
 return keys.keys.filter(k=>{const m=typeof k.access_key.permission==='object'?k.access_key.permission.FunctionCall?.method_names:undefined;return Array.isArray(m) && m.length===1 && m[0]==='sentinel_pause';}).map(k=>k.public_key);
}
export type SentinelPause={time:string;sentinel:string;reason:string;tx:string};
// Newest first. A reason is the sentinel's own words, at most 280 bytes on chain: render it as text only.
export function sentinelPauses(rows:EventRow[]):SentinelPause[]{
 return rows.filter(r=>r.event==='sentinel_paused' && typeof r.data.sentinel==='string')
  .map(r=>({time:r.time,sentinel:r.data.sentinel,reason:typeof r.data.reason==='string'?r.data.reason:'',tx:r.tx}))
  .sort((a,b)=>b.time.localeCompare(a.time));
}
// A link from the sentinel parent (styx-sentinels): ?sentinel_enable=<key>&sentinel_label=<name>&sentinel_remove=<key>.
// Each parameter may repeat; labels pair with enables in order. Everything goes in one reviewed transaction.
export type SentinelChange={key:string;enabled:boolean;name?:string};
export function readSentinelLink(q:URLSearchParams):SentinelChange[]{
 const enable=q.getAll('sentinel_enable'),remove=q.getAll('sentinel_remove'),label=q.getAll('sentinel_label');
 const out:SentinelChange[]=[],seen=new Set<string>();
 const add=(raw:string,enabled:boolean,name?:string)=>{const key=publicKey(raw.trim());if(seen.has(key)) throw Error(`Sentinel key appears twice in the link: ${key}`);seen.add(key);
  let clean:string|undefined;try{clean=name?cleanLabel(name):undefined;}catch{clean=undefined;}out.push(clean?{key,enabled,name:clean}:{key,enabled});};
 remove.forEach(k=>add(k,false));enable.forEach((k,i)=>add(k,true,label[i]));
 if(out.length>BATCH_MAX) throw Error(`At most ${BATCH_MAX} sentinel changes in one link`);
 return out;
}
// Keys to add, one per line, an optional name after a comma (the same shape as the recipient list).
export function parseSentinelKeys(text:string):{key:string;name?:string}[]{
 const out:{key:string;name?:string}[]=[],seen=new Set<string>();
 for(const line of text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean)){
  const m=/^([^,\s]+)\s*(?:,\s*(.+))?$/.exec(line);if(!m) throw Error(`Not a key line: ${line}`);
  const key=publicKey(m[1]);if(seen.has(key)) continue;seen.add(key);out.push(m[2]?{key,name:cleanLabel(m[2])}:{key});
 }
 return out;
}
// Which requested changes still need a transaction, given the keys enabled now; and whether the cap holds.
export function sentinelChanges(wanted:SentinelChange[],enabled:string[]):{todo:SentinelChange[];already:SentinelChange[]}{
 const now=new Set(enabled),todo=wanted.filter(c=>c.enabled!==now.has(c.key)),already=wanted.filter(c=>c.enabled===now.has(c.key));
 const after=new Set(now);for(const c of todo) c.enabled?after.add(c.key):after.delete(c.key);
 if(after.size>MAX_SENTINELS) throw Error(`A vault holds at most ${MAX_SENTINELS} sentinels; this would make ${after.size}. Remove one first.`);
 return {todo,already};
}
