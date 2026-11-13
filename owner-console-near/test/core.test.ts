import { describe,it,expect,vi } from 'vitest';
import fs from 'node:fs';
import { units,amount,formPlan,parseEvents,discoveries,indexerRows,RPC,overview,history,LIVE_VAULT,TEST_TOKEN,STORAGE_DEPOSIT,createPlan,vaultName,nearToYocto,createdVault,describePlan } from '../src/core';
const live=JSON.parse(fs.readFileSync(new URL('./live-testnet.json',import.meta.url),'utf8'));
const tx=Object.values(live.transactions)[0] as any;
const plan=(method:string,values:Record<string,string>={})=>formPlan(method,values,LIVE_VAULT,TEST_TOKEN,'testnet');
describe('amounts and transaction previews',()=>{
 it('converts precisely both ways, including fractions',()=>{expect(units('140')).toBe('140000000');expect(units('0.000001')).toBe('1');expect(amount('140000001')).toBe('140.000001');expect(units(amount('340282366920938463463374607431768211455'))).toBe('340282366920938463463374607431768211455');});
 for(const invalid of ['-1','1e6','1.0000001','NaN','01','1.','340282366920938463463374607431769']) it(`rejects invalid amount ${invalid}`,()=>expect(()=>units(invalid)).toThrow());
 it('maps configure_agent to the contract JSON',()=>expect(plan('configure_agent',{agent:live.known.agent,per_payment_limit:'100',daily_limit:'500',valid_until:'1794614400',enabled:'true'}).args).toEqual({agent:live.known.agent,per_payment_limit:'100000000',daily_limit:'500000000',valid_until:'1794614400',enabled:true}));
 it('maps approver and recipient state',()=>{expect(plan('set_approver',{approver:live.known.approver,enabled:'false'}).args).toEqual({approver:live.known.approver,enabled:false});expect(plan('set_recipient',{recipient:live.known.recipient,allowed:'true'}).args).toEqual({recipient:live.known.recipient,allowed:true});});
 it('maps daily limit, pause, unpause and withdraw',()=>{expect(plan('set_vault_daily_limit',{limit:'1000'}).args).toEqual({limit:'1000000000'});for(const method of ['pause','unpause']) expect(plan(method).args).toEqual({});expect(plan('withdraw',{to:live.known.recipient,amount:'1.5'}).args).toEqual({to:live.known.recipient,amount:'1500000'});});
 it('maps token registration, funding, and test mint with correct deposits',()=>{const storage=plan('storage_deposit');expect(storage.receiverId).toBe(TEST_TOKEN);expect(storage.deposit).toBe(STORAGE_DEPOSIT);expect(storage.args).toEqual({account_id:LIVE_VAULT,registration_only:true});const fund=plan('ft_transfer',{amount:'2'});expect(fund.deposit).toBe('1');expect(fund.args.receiver_id).toBe(LIVE_VAULT);expect(fund.args.amount).toBe('2000000');expect(plan('mint',{amount:'3'}).args).toEqual({account_id:LIVE_VAULT,amount:'3000000'});});
 it('refuses arbitrary mint targets, unsupported methods, malformed keys and booleans',()=>{expect(()=>formPlan('mint',{amount:'1'},LIVE_VAULT,TEST_TOKEN,'mainnet')).toThrow();expect(()=>formPlan('mint',{amount:'1'},LIVE_VAULT,'other.testnet','testnet')).toThrow();expect(()=>plan('new')).toThrow();expect(()=>plan('set_approver',{approver:'bad',enabled:'true'})).toThrow();expect(()=>plan('set_recipient',{recipient:'vendor.testnet',allowed:'yes'})).toThrow();expect(()=>plan('configure_agent',{agent:live.known.agent,per_payment_limit:'1',daily_limit:'2',valid_until:'-1',enabled:'true'})).toThrow();});
});
describe('events and chain reads from the live vault snapshot',()=>{
 it('parses the live exception event and discovers its keys',()=>{const rows=parseEvents(tx,LIVE_VAULT,'2026-11-12');expect(rows).toHaveLength(1);expect(rows[0].event).toBe('payment_executed');expect(rows[0].data.amount).toBe('140000000');const keys=discoveries(rows);expect(keys.agents.has(live.known.agent)).toBe(true);expect(keys.approvers.has(live.known.approver)).toBe(true);expect(keys.recipients.has(live.known.recipient)).toBe(true);});
 it('ignores foreign executors, failed receipts, malformed logs and other standards',()=>{const copy=structuredClone(tx);for(const r of copy.receipts_outcome)r.outcome.executor_id='fake.testnet';expect(parseEvents(copy,LIVE_VAULT)).toEqual([]);for(const r of copy.receipts_outcome){r.outcome.executor_id=LIVE_VAULT;r.outcome.status={Failure:{}};}expect(parseEvents(copy,LIVE_VAULT)).toEqual([]);copy.receipts_outcome=[{outcome:{executor_id:LIVE_VAULT,status:{SuccessValue:''},logs:['EVENT_JSON:{','EVENT_JSON:{"standard":"fake","event":"agent_configured","data":[]}']}}];expect(parseEvents(copy,LIVE_VAULT)).toEqual([]);});
 it('recognizes each configuration and lifecycle event shape (synthetic using live keys)',()=>{const data=[['agent_configured',{agent:live.known.agent}],['approver_set',{approver:live.known.approver}],['recipient_set',{recipient:live.known.recipient}],['payment_failed',{agent:live.known.agent,payment_id:'synthetic'}],['record_sealed',{agent:live.known.agent,payment_id:'synthetic'}]];const copy=structuredClone(tx);copy.receipts_outcome=[{outcome:{executor_id:LIVE_VAULT,status:{SuccessValue:''},logs:data.map(([event,d])=>'EVENT_JSON:'+JSON.stringify({standard:'styx',version:'1.0.0',event,data:[d]}))}}];expect(parseEvents(copy,LIVE_VAULT)).toHaveLength(5);expect(discoveries(parseEvents(copy,LIVE_VAULT)).agents.size).toBe(1);});
 it('accepts indexed live transaction IDs and refuses missing senders',()=>{expect(indexerRows({txns:[{transaction_hash:tx.transaction.hash,signer_account_id:LIVE_VAULT}]})).toEqual([{hash:tx.transaction.hash,sender:LIVE_VAULT}]);expect(()=>indexerRows({txns:[{hash:'x'}]})).toThrow();expect(()=>indexerRows({error:'offline'})).toThrow();});
 for(const [version,ok] of [[2,true],[3,false]] as const) it(`${ok?'opens':'refuses'} a version ${version} vault`,async()=>{
  const rpc=new RPC('https://example.com');vi.spyOn(rpc,'view').mockImplementation(async(account,method,args={})=>{const sorted=JSON.stringify(args,Object.keys(args).sort());const v=JSON.parse(Buffer.from(live.views[account+':'+method+':'+sorted].result).toString());return method==='get_vault'?{...v,contract_version:version}:v;});vi.spyOn(rpc,'call').mockResolvedValue(live.accessKeys);
  if(ok) expect((await overview(rpc,LIVE_VAULT)).info.contract_version).toBe(2); else await expect(overview(rpc,LIVE_VAULT)).rejects.toThrow('Unsupported');
 });
 it('renders core overview data from captured RPC responses',async()=>{
  const rpc=new RPC('https://example.com');vi.spyOn(rpc,'view').mockImplementation(async(account,method,args={})=>{const sorted=JSON.stringify(args,Object.keys(args).sort());return JSON.parse(Buffer.from(live.views[account+':'+method+':'+sorted].result).toString());});vi.spyOn(rpc,'call').mockResolvedValue(live.accessKeys);
  const state=await overview(rpc,LIVE_VAULT);expect(state.info.owner).toBe('styx-owner-c87a.testnet');expect(state.info.token).toBe(TEST_TOKEN);expect(state.keys.keys.some((k:any)=>k.public_key===live.known.agent)).toBe(true);
 });
 it('reports indexer outage without treating it as no history',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:403})));try{const result=await history(new RPC('https://example.com'),LIVE_VAULT,'testnet');expect(result.notice).toContain('Lists unavailable');expect(result.notice).toContain('Manual key lookups');}finally{vi.unstubAllGlobals();}});
});
it('rejects RPC/wallet network mismatch before signing',async()=>{const rpc=new RPC('https://example.com');vi.spyOn(rpc,'call').mockResolvedValue({chain_id:'testnet'});await rpc.assertNetwork('testnet');await expect(rpc.assertNetwork('mainnet')).rejects.toThrow('differs');});
describe('indexer paging',()=>{
 it('follows the cursor past the first page and keeps rows when a later page fails',async()=>{
  const urls:string[]=[];const page=(n:number,from:number)=>({cursor:'c'+from,txns:Array.from({length:n},(_,i)=>({transaction_hash:'h'+(from+i),signer_account_id:'s.testnet'}))});
  const get=vi.fn(async(url:string)=>{urls.push(url);return urls.length===1?new Response(JSON.stringify(page(25,0))):urls.length===2?new Response(JSON.stringify(page(25,25))):new Response('',{status:422});}) as never;
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:503})));
  try{const result=await history(new RPC('https://example.com'),LIVE_VAULT,'testnet',get);
   expect(urls[0]).not.toMatch(/[?&]page=/);expect(urls[1]).toContain('cursor=c0');expect(urls[2]).toContain('cursor=c25');
   expect(result.notice).toContain('50 indexed transactions checked');expect(result.notice).toContain('Stopped early: Indexer unavailable (422)');
  }finally{vi.unstubAllGlobals();}
 });
});
describe('creating a vault',()=>{
 const min='3804260000000000000000000';
 it('builds the factory call with the caller-paid deposit',()=>{const p=createPlan('acme-pay',TEST_TOKEN,'4','testnet',min);expect(p).toEqual({receiverId:'styx-vaults.testnet',method:'create_vault',args:{name:'acme-pay',token:TEST_TOKEN},deposit:'4000000000000000000000000',gas:'100000000000000'});expect(createPlan('a1',TEST_TOKEN,'3.9','testnet',min).deposit).toBe('3900000000000000000000000');});
 for(const bad of ['a','Acme','acme.pay','-acme','acme-','ac--me','acme pay','x'.repeat(33)]) it(`refuses vault name ${JSON.stringify(bad)}`,()=>expect(()=>vaultName(bad)).toThrow('Vault name'));
 it('refuses a deposit under the minimum, bad NEAR amounts and unknown networks',()=>{expect(()=>createPlan('acme',TEST_TOKEN,'3.5','testnet',min)).toThrow('at least 3.8042');for(const d of ['-1','4,5','1e3','']) expect(()=>nearToYocto(d)).toThrow();expect(()=>createPlan('acme',TEST_TOKEN,'4','mainnet',min)).toThrow('No vault factory');});
 it('reads the created vault, or null for a refunded failure',()=>{const b64=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64');expect(createdVault({status:{SuccessValue:b64('acme.styx-vaults.testnet')}})).toBe('acme.styx-vaults.testnet');expect(createdVault({status:{SuccessValue:b64(null)}})).toBeNull();expect(()=>createdVault({status:{Failure:{}}})).toThrow();});
});
describe('describing what a transaction did',()=>{
 it('names each owner action in words',()=>{
  expect(describePlan(plan('mint',{amount:'100'}))).toBe('Minted 100 tUSDC to the vault');
  expect(describePlan(plan('set_vault_daily_limit',{limit:'500'}))).toBe('Vault daily limit set to 500');
  expect(describePlan(plan('set_approver',{approver:live.known.approver,enabled:'true'}))).toMatch(/^Approver set: ed25519:/);
  expect(describePlan(plan('set_recipient',{recipient:live.known.recipient,allowed:'false'}))).toBe(`Recipient blocked: ${live.known.recipient}`);
  expect(describePlan(plan('configure_agent',{agent:live.known.agent,per_payment_limit:'10',daily_limit:'100',valid_until:'1794614400',enabled:'true'}))).toBe('Agent configured: 10 per payment, 100 a day');
  expect(describePlan(plan('withdraw',{to:live.known.recipient,amount:'1.5'}))).toBe(`Withdrew 1.5 to ${live.known.recipient}`);
  expect(describePlan(plan('pause'))).toBe('Vault paused');
  expect(describePlan(createPlan('acme',TEST_TOKEN,'4','testnet','3804260000000000000000000'))).toBe('Vault created: acme');
 });
});

import { batchPlan,BATCH_GAS,describeBatch,batchDeposit,spendable,fundsProblem } from '../src/core';
describe('one approval for several calls',()=>{
 const p=(m:string,v:Record<string,string>={})=>formPlan(m,v,LIVE_VAULT,TEST_TOKEN,'testnet');
 it('batches calls to the vault and gives each 30 Tgas',()=>{
  const b=batchPlan([p('set_vault_daily_limit',{limit:'500'}),p('set_recipient',{recipient:'vendor-a.styx-owner-c87a.testnet',allowed:'true'})]);
  expect(b.receiverId).toBe(LIVE_VAULT);expect(b.calls.map(c=>c.gas)).toEqual([BATCH_GAS,BATCH_GAS]);
  expect(describeBatch(b)).toBe('2 changes in one transaction');expect(describeBatch(batchPlan([b.calls[0]]))).toBe('Vault daily limit set to 500');
 });
 it('keeps a single call as it was',()=>{const one=p('pause');expect(batchPlan([one]).calls).toEqual([one]);});
 it('batches token registration and mint, summing the deposit',()=>{
  const b=batchPlan([p('storage_deposit'),p('mint',{amount:'100'})]);expect(b.receiverId).toBe(TEST_TOKEN);expect(batchDeposit(b)).toBe(STORAGE_DEPOSIT);
 });
 it('refuses mixed receivers, empty and oversized batches',()=>{
  expect(()=>batchPlan([p('storage_deposit'),p('pause')])).toThrow(/one contract/);
  expect(()=>batchPlan([])).toThrow();expect(()=>batchPlan(Array(21).fill(p('pause')))).toThrow();
 });
});
describe('funds before signing',()=>{
 const view=(near:string,bytes=182)=>({amount:(BigInt(near)*10n**24n).toString(),storage_usage:bytes});
 it('subtracts locked storage',()=>expect(spendable({amount:'10000000000000000000000',storage_usage:100})).toBe(9000000000000000000000n));
 it('passes when the deposit and gas fit',()=>expect(fundsProblem(view('10'),(4n*10n**24n).toString(),'a.testnet')).toBeNull());
 it('explains a shortfall in NEAR',()=>expect(fundsProblem(view('3'),(4n*10n**24n).toString(),'a.testnet')).toMatch(/^a\.testnet has 2\.99\d* NEAR to spend; this needs 4 NEAR/));
});

import { agentEnv,agentSetupCommands,agentEnvName,PRESETS } from '../src/core';
describe('agent hand-off',()=>{
 const vault='styx-demo-2917.styx-vaults.testnet',approver=live.known.approver;
 it('writes the four settings mcp_config.sh reads, and no key material',()=>{
  const env=agentEnv(vault,approver);
  expect(env).toContain(`STYX_NEAR_VAULT=${vault}`);expect(env).toContain(`STYX_NEAR_APPROVER=${approver}`);
  expect(env).toContain(`STYX_NEAR_AGENT_KEY_FILE=$HOME/.styx-near-agent/${vault}/agent.json`);
  expect(env).not.toMatch(/private|secret|ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/);
 });
 it('refuses a bad approver or vault',()=>{expect(()=>agentEnv(vault,'nope')).toThrow();expect(()=>agentEnv('Bad Vault',approver)).toThrow();});
 it('moves the downloads into a private folder, then runs mcp_config.sh',()=>{
  const cmds=agentSetupCommands(vault,'styx-agent-x-1234.json');
  expect(cmds.split('\n')).toHaveLength(4);expect(cmds).toContain('chmod 600');expect(cmds).toContain(agentEnvName(vault));expect(cmds).toMatch(/^mkdir -p -m 700/);
  expect(()=>agentSetupCommands(vault,'../../etc/passwd')).toThrow();
 });
 it('presets keep the agent day inside the vault day',()=>{for(const p of PRESETS) expect(Number(p.values.daily_limit)).toBeLessThanOrEqual(Number(p.values.limit));});
});

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { inviteSigningBytes,inviteValid,joinUrl,returnUrl,readInvite,newInviteNonce,inviteNonceBytes,inviteMessage } from '../src/core';
describe('approver invites',()=>{
 const vault='styx-demo-2917.styx-vaults.testnet',base='https://styxco.xyz/console/';
 const pair=nacl.sign.keyPair(),pk='ed25519:'+bs58.encode(pair.publicKey);
 const sign=(nonce:string)=>Buffer.from(nacl.sign.detached(createHash('sha256').update(inviteSigningBytes(vault,inviteNonceBytes(nonce))).digest(),pair.secretKey)).toString('base64');
 it('accepts a NEP-413 signature over the invite message, round-tripped through the return link',async()=>{
  const nonce=newInviteNonce(),i={vault,accountId:'poulav.testnet',publicKey:pk,nonce,signature:sign(nonce)};
  const back=readInvite(new URL(returnUrl(base,'testnet',i)).searchParams)!;
  expect(back).toEqual(i);expect(await inviteValid(back)).toBe(true);
 });
 it('rejects a signature for another vault, another key or another nonce',async()=>{
  const nonce=newInviteNonce(),sig=sign(nonce);
  expect(await inviteValid({vault:'other.testnet',accountId:'a.testnet',publicKey:pk,nonce,signature:sig})).toBe(false);
  expect(await inviteValid({vault,accountId:'a.testnet',publicKey:'ed25519:'+bs58.encode(nacl.sign.keyPair().publicKey),nonce,signature:sig})).toBe(false);
  expect(await inviteValid({vault,accountId:'a.testnet',publicKey:pk,nonce:newInviteNonce(),signature:sig})).toBe(false);
  expect(await inviteValid({vault,accountId:'a.testnet',publicKey:pk,nonce,signature:'garbage'})).toBe(false);
 });
 it('builds the join link and ignores links without an approver',()=>{
  expect(joinUrl(base+'?vault=x#y',vault,'testnet')).toBe(`${base}?join=${vault}&network=testnet`);
  expect(readInvite(new URLSearchParams('vault='+vault))).toBeNull();
  expect(()=>readInvite(new URLSearchParams(`vault=${vault}&approver=${pk}&approver_account=a.testnet&nonce=AA&sig=x`))).toThrow(/nonce/);
  expect(inviteMessage(vault)).toContain(vault);
 });
});

import { expiry,extendValues,agentKeys } from '../src/core';
describe('agent expiry',()=>{
 const now=1_800_000_000;
 it('reads ok, soon and expired',()=>{
  expect(expiry(String(now+10*86400),now)).toMatchObject({state:'ok',text:'Active for 10 days more.'});
  expect(expiry(String(now+5*3600),now)).toMatchObject({state:'soon',text:/^Expires in 5 h/});
  expect(expiry(String(now-2*86400),now)).toMatchObject({state:'expired',text:/^Expired 2 days ago/});
 });
 it('extends with the same limits, so configure_agent changes only the expiry',()=>{
  const v=extendValues(live.known.agent,{per_payment_limit:'100000000',daily_limit:'1000000000',enabled:true},now);
  const p=formPlan('configure_agent',v,LIVE_VAULT,TEST_TOKEN,'testnet');
  expect(p.args).toEqual({agent:live.known.agent,per_payment_limit:'100000000',daily_limit:'1000000000',valid_until:String(now+30*86400),enabled:true});
 });
 it('finds agents among the access keys',()=>{
  expect(agentKeys({keys:[{public_key:'ed25519:a',access_key:{permission:{FunctionCall:{method_names:['pay','post_record']}}}},{public_key:'ed25519:b',access_key:{permission:'FullAccess'}},{public_key:'ed25519:c',access_key:{permission:{FunctionCall:{method_names:['other']}}}}]})).toEqual(['ed25519:a']);
 });
});

import { parseLabels,labelsFile,cleanLabel,named,short } from '../src/core';
describe('key labels',()=>{
 const vault=LIVE_VAULT,agent=live.known.agent;
 it('round-trips a labels file for the same vault',()=>{const l={[agent]:'Billing bot','vendor-a.styx-owner-c87a.testnet':'Vendor A'};expect(parseLabels(labelsFile(vault,l),vault)).toEqual(l);});
 it('refuses another vault and junk, drops bad entries',()=>{
  expect(()=>parseLabels(labelsFile('other.testnet',{}),vault)).toThrow(/not/);expect(()=>parseLabels('nope',vault)).toThrow();
  expect(parseLabels(JSON.stringify({labels:{'ed25519:bad':'x',[agent]:'  ok\u0007  ','UPPER':'y',[LIVE_VAULT]:''}}),vault)).toEqual({[agent]:'ok'});
 });
 it('cleans and caps names',()=>{expect(cleanLabel('a'.repeat(60))).toHaveLength(40);expect(()=>cleanLabel('  ')).toThrow();});
 it('shows the name with a short key',()=>{expect(named(agent,{[agent]:'CFO'})).toBe(`CFO (${short(agent)})`);expect(named(agent,{})).toBe(agent);});
});

import { parseRecipients,BATCH_GAS_LONG } from '../src/core';
describe('recipient lists',()=>{
 it('reads one per line with optional names, or a plain separated list, without duplicates',()=>{
  expect(parseRecipients('vendor-a.testnet, Vendor A\nvendor-b.testnet\n\nVENDOR-A.testnet')).toEqual([{account:'vendor-a.testnet',name:'Vendor A'},{account:'vendor-b.testnet'}]);
  expect(parseRecipients('a.testnet b.testnet;c.testnet')).toEqual([{account:'a.testnet'},{account:'b.testnet'},{account:'c.testnet'}]);
 });
 it('names the bad line',()=>expect(()=>parseRecipients('ok.testnet\nbad!')).toThrow(/Not a NEAR account: bad!/));
 it('gives a long batch 14 Tgas a call, under 300 Tgas',()=>{
  const plans=Array.from({length:20},(_,i)=>formPlan('set_recipient',{recipient:`v${i}.testnet`,allowed:'true'},LIVE_VAULT,TEST_TOKEN,'testnet'));
  const b=batchPlan(plans);expect(b.calls.every(c=>c.gas===BATCH_GAS_LONG)).toBe(true);
  expect(b.calls.reduce((s,c)=>s+BigInt(c.gas),0n)<=300_000_000_000_000n).toBe(true);
 });
});

import { telegramLinked } from '../src/core';
describe('telegram link status',()=>{
 const key=live.known.approver;
 const reply=(status:number,body:unknown)=>(async()=>({ok:status<300,json:async()=>body}))as never;
 it('reads linked and not linked',async()=>{
  expect(await telegramLinked('https://relay.example',key,reply(200,{publicKey:key,linked:true}))).toBe(true);
  expect(await telegramLinked('https://relay.example',key,reply(200,{publicKey:key,linked:false}))).toBe(false);
 });
 it('says unknown when the relay is down, answers for another key, or is malformed',async()=>{
  expect(await telegramLinked('https://relay.example',key,reply(404,{}))).toBeNull();
  expect(await telegramLinked('https://relay.example',key,reply(200,{publicKey:'ed25519:x',linked:true}))).toBeNull();
  expect(await telegramLinked('https://relay.example',key,(async()=>{throw Error('down');})as never)).toBeNull();
 });
 it('asks for the encoded key',async()=>{let url='';await telegramLinked('https://relay.example',key,(async(u:string)=>{url=u;return {ok:true,json:async()=>({publicKey:key,linked:true})};})as never);expect(url).toBe(`https://relay.example/links/${encodeURIComponent(key)}`);});
});
