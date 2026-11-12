import { Buffer, type Pending } from './protocol';
export type View=(method:string,args:Record<string,unknown>)=>Promise<any>;
export function rpcView(p:Pending):View {
 let block:string|undefined;
 return async(method,args)=>{
  const response=await fetch(p.rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:method,method:'query',params:{request_type:'call_function',...(block?{block_id:block}:{finality:'final'}),account_id:p.vault,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')}}),signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('RPC unavailable');
  const data=await response.json();if(data.error || !data.result?.result) throw new Error(`RPC failed: ${method}`);
  block??=data.result.block_hash;
  return JSON.parse(Buffer.from(data.result.result).toString());
 };
}
export async function review(p:Pending,view:View,now=BigInt(Math.floor(Date.now()/1000))){
 // First view pins the remaining reads to the same finalized block.
 const vault=await view('get_vault',{});
 const [agent,recipient,approver,hash,message]=await Promise.all([
  view('get_agent',{agent:p.payment.agent}),view('get_recipient',{recipient:p.payment.recipient}),view('get_approver',{approver:p.authorization.signer}),view('payment_hash',{payment:p.payment}),view('exception_message',{authorization:p.authorization})]);
 const errors:string[]=[];
 const check=(ok:unknown,text:string)=>{if(!ok) errors.push(text);};
 check(vault.contract_version===1,'Unsupported contract version');check(!vault.paused,'Vault paused');
 check(vault.token===p.token && vault.token===p.payment.token,'Token differs');
 check(agent?.enabled,'Agent disabled or missing');check(agent?.version===p.payment.policy_version,'Agent version differs');
 check(recipient?.allowed,'Recipient is not allowed');check(recipient?.version===p.payment.recipient_version,'Recipient version differs');
 check(approver?.enabled,'Signer is not a current approver');check(approver?.version===p.authorization.signer_version,'Signer version differs');
 check(hash===p.authorization.payment_hash,'Payment hash differs');check(message===p.message,'Exception message differs');
 check(BigInt(p.authorization.authorization_expiry)>now,'Authorization expired');check(BigInt(p.payment.valid_until)>now,'Payment expired');
 if(agent){check(BigInt(agent.valid_until)>=now,'Agent policy expired');check(agent.per_payment_limit===p.perPaymentLimit,'Per-payment limit differs');check(BigInt(p.payment.amount)>BigInt(agent.per_payment_limit),'Payment does not exceed current limit');check(BigInt(p.payment.amount)<=BigInt(agent.daily_limit),'Amount exceeds agent daily limit');}
 check(BigInt(p.payment.amount)<=BigInt(vault.vault_daily_limit),'Amount exceeds vault daily limit');
 return {vault,agent,recipient,approver,hash,message,errors};
}
export const usdc=(value:string)=>{const n=BigInt(value);return `${n/1000000n}.${(n%1000000n).toString().padStart(6,'0')} USDC`;};
