import { Buffer } from 'buffer';
import bs58 from 'bs58';
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
const eventNames=new Set(['agent_configured','approver_set','recipient_set','payment_executed','payment_failed','record_sealed']);
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
 const info=await rpc.view(vault,'get_vault');if(![1,2].includes(info.contract_version)) throw Error('Unsupported vault contract version');
 const day=await rpc.view(vault,'current_day');
 const [spent,balance,storage,keys]=await Promise.all([
  rpc.view(vault,'spent_by_vault',{day}),rpc.view(info.token,'ft_balance_of',{account_id:vault}),
  rpc.view(info.token,'storage_balance_of',{account_id:vault}),rpc.call('query',{request_type:'view_access_key_list',finality:'final',account_id:vault})]);
 return {info,day,spent,balance,storage,keys};
}
