import { describe,it,expect,vi } from 'vitest';
import fs from 'node:fs';
import { units,amount,formPlan,parseEvents,discoveries,indexerRows,RPC,overview,history,LIVE_VAULT,TEST_TOKEN,STORAGE_DEPOSIT,createPlan,vaultName,nearToYocto,createdVault,describePlan,sentinelKeys,sentinelPauses,readSentinelLink,parseSentinelKeys,sentinelChanges,sentinelQuickstart,parseLabels,hostedChanges,currentPause,pauseLabelsFile,readPauseLabels,type EventRow,velocityText,velocitySupported } from '../src/core';
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
 for(const [version,ok] of [[2,true],[3,true],[4,false]] as const) it(`${ok?'opens':'refuses'} a version ${version} vault`,async()=>{
  const rpc=new RPC('https://example.com');vi.spyOn(rpc,'view').mockImplementation(async(account,method,args={})=>{const sorted=JSON.stringify(args,Object.keys(args).sort());const v=JSON.parse(Buffer.from(live.views[account+':'+method+':'+sorted].result).toString());return method==='get_vault'?{...v,contract_version:version}:v;});vi.spyOn(rpc,'call').mockResolvedValue(live.accessKeys);
  if(ok) expect((await overview(rpc,LIVE_VAULT)).info.contract_version).toBe(version); else await expect(overview(rpc,LIVE_VAULT)).rejects.toThrow('Unsupported');
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
 it('moves the key into a private folder, installs the CLI and adds the MCP server, without the repo',()=>{
  const cmds=agentSetupCommands(vault,'styx-agent-x-1234.json',approver),lines=cmds.split('\n');
  expect(lines).toHaveLength(4);expect(cmds).toContain('chmod 600');expect(lines[0]).toMatch(/^mkdir -p -m 700 .*\/invoices"$/);
  expect(lines[2]).toBe('cargo install --locked --git https://github.com/PoulavBhowmick03/Styx styx-near');
  expect(lines[3]).toContain(`-e STYX_NEAR_APPROVER=${approver}`);expect(lines[3]).toMatch(/-- uvx --from "git\+https:\/\/github.com\/PoulavBhowmick03\/Styx#subdirectory=mcp-server" styx-mcp-server$/);
  expect(cmds).not.toMatch(/private|secret/);
  expect(()=>agentSetupCommands(vault,'../../etc/passwd',approver)).toThrow();expect(()=>agentSetupCommands(vault,'styx-agent-x.json','nope')).toThrow();
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

import { watchLink } from '../src/core';
describe('spend alert link',()=>{
 it('encodes the vault as the relay decodes it',()=>expect(watchLink('Styx_pvt_bot','styx-demo-2917.styx-vaults.testnet')).toBe('https://t.me/Styx_pvt_bot?start=watch-styx-demo-2917--styx-vaults--testnet'));
 it('gives up when the payload would pass 64 characters',()=>expect(watchLink('b','a'.repeat(55)+'.testnet')).toBeNull());
});

import { daoProposal,isDaoPolicy,PROPOSAL_GAS } from '../src/core';
describe('DAO-owned vaults',()=>{
 const p=(m:string,v:Record<string,string>={})=>formPlan(m,v,LIVE_VAULT,TEST_TOKEN,'testnet');
 it('wraps the same calls in one Sputnik add_proposal with the bond',()=>{
  const inner=batchPlan([p('set_vault_daily_limit',{limit:'500'}),p('pause')]);
  const b=daoProposal(inner,'acme.sputnikv2.testnet','100000000000000000000000','Styx: 2 changes');
  expect(b.receiverId).toBe('acme.sputnikv2.testnet');expect(b.calls).toHaveLength(1);
  const c=b.calls[0];expect(c.method).toBe('add_proposal');expect(c.deposit).toBe('100000000000000000000000');expect(c.gas).toBe(PROPOSAL_GAS);
  const fc=(c.args as any).proposal.kind.FunctionCall;expect(fc.receiver_id).toBe(LIVE_VAULT);
  expect(fc.actions.map((a:any)=>[a.method_name,JSON.parse(Buffer.from(a.args,'base64').toString()),a.gas])).toEqual([['set_vault_daily_limit',{limit:'500000000'},BATCH_GAS],['pause',{},BATCH_GAS]]);
 });
 it('recognises a Sputnik policy and nothing else',()=>{
  expect(isDaoPolicy({proposal_bond:'100000000000000000000000',roles:[]})).toBe(true);
  expect(isDaoPolicy(null)).toBe(false);expect(isDaoPolicy({proposal_bond:1,roles:[]})).toBe(false);expect(isDaoPolicy({owner:'x'})).toBe(false);
 });
});

import { freezeValues } from '../src/core';
describe('freezing an agent',()=>{
 it('keeps the policy and turns it off, which configure_agent turns into a disable',()=>{
  const v=freezeValues(live.known.agent,{per_payment_limit:'100000000',daily_limit:'1000000000',valid_until:'1795105186'});
  expect(formPlan('configure_agent',v,LIVE_VAULT,TEST_TOKEN,'testnet').args).toEqual({agent:live.known.agent,per_payment_limit:'100000000',daily_limit:'1000000000',valid_until:'1795105186',enabled:false});
  expect(describePlan(formPlan('configure_agent',v,LIVE_VAULT,TEST_TOKEN,'testnet'))).toBe('Agent disabled');
 });
});

import { paymentsCsv } from '../src/core';
describe('payments CSV',()=>{
 const row=(data:Record<string,any>)=>({event:'payment_executed',data:{agent:'ed25519:A',recipient:'vendor-a.testnet',amount:'5000000',exception:false,payment_id:'0x1',...data},tx:'TX1',time:'2026-11-14T10:00:00.000Z'});
 it('writes a header and one line per payment, with names',()=>{
  const csv=paymentsCsv([row({}),{event:'agent_configured',data:{},tx:'X',time:''}],{'ed25519:A':'Billing bot','vendor-a.testnet':'Vendor A'});
  expect(csv.split('\r\n')).toEqual(['time_utc,agent,agent_name,recipient,recipient_name,amount,exception,signer,signer_name,payment_id,transaction','2026-11-14T10:00:00.000Z,ed25519:A,Billing bot,vendor-a.testnet,Vendor A,5.000000,no,,,0x1,TX1','']);
 });
 it('quotes commas and quotes, and defuses formulas',()=>{
  const csv=paymentsCsv([row({exception:true,signer:'ed25519:S'})],{'ed25519:A':'=HYPERLINK("x")','ed25519:S':'Ann, CFO'});
  const line=csv.split('\r\n')[1];
  expect(line).toContain(`"'=HYPERLINK(""x"")"`);expect(line).toContain('"Ann, CFO"');expect(line).toContain(',yes,ed25519:S,');
 });
});

describe('sentinels',()=>{
 const K=live.known.agent,A=live.known.approver;
 it('maps set_sentinel to the contract JSON and words',()=>{
  const p=plan('set_sentinel',{key:K,enabled:'true'});
  expect(p).toMatchObject({receiverId:LIVE_VAULT,method:'set_sentinel',args:{key:K,enabled:true},deposit:'0'});
  expect(describePlan(p)).toMatch(/^Sentinel installed: /);expect(describePlan(plan('set_sentinel',{key:K,enabled:'false'}))).toMatch(/^Sentinel removed: /);
  expect(()=>plan('set_sentinel',{key:'ed25519:short',enabled:'true'})).toThrow();
 });
 it('finds only keys limited to sentinel_pause',()=>{
  const fc=(m:string[])=>({FunctionCall:{allowance:'50000000000000000000000',receiver_id:LIVE_VAULT,method_names:m}});
  expect(sentinelKeys({keys:[{public_key:'S',access_key:{permission:fc(['sentinel_pause'])}},{public_key:'P',access_key:{permission:fc(['pay','pay_with_exception'])}},
   {public_key:'X',access_key:{permission:fc(['sentinel_pause','pay'])}},{public_key:'F',access_key:{permission:'FullAccess'}}]})).toEqual(['S']);
 });
 it('reads sentinel_paused events with their reasons, newest first',()=>{
  const copy=structuredClone(tx);const log=(event:string,d:object)=>'EVENT_JSON:'+JSON.stringify({standard:'styx',version:'1.0.0',event,data:[d]});
  copy.receipts_outcome=[{outcome:{executor_id:LIVE_VAULT,status:{SuccessValue:''},logs:[log('sentinel_paused',{sentinel:K,reason:'6 payments in 5 min',day:1,vault_day_spent:'6000000'}),log('unpaused',{}),log('sentinel_set',{sentinel:K,enabled:true})]}}];
  const rows=parseEvents(copy,LIVE_VAULT,'2026-11-14T10:00:00.000Z');expect(rows.map(r=>r.event)).toEqual(['sentinel_paused','unpaused','sentinel_set']);
  const later:EventRow={...rows[0],time:'2026-11-14T11:00:00.000Z',data:{sentinel:A,reason:'<b>x</b>'}};
  expect(sentinelPauses([...rows,later])).toEqual([{time:later.time,sentinel:A,reason:'<b>x</b>',tx:later.tx},{time:'2026-11-14T10:00:00.000Z',sentinel:K,reason:'6 payments in 5 min',tx:rows[0].tx}]);
 });
 it('reads the parent link: removes first, enables with their names, repeated parameters',()=>{
  const q=new URLSearchParams();q.append('sentinel_enable',K);q.append('sentinel_label','burst-g2');q.append('sentinel_remove',A);
  expect(readSentinelLink(q)).toEqual([{key:A,enabled:false},{key:K,enabled:true,name:'burst-g2'}]);
  expect(readSentinelLink(new URLSearchParams('vault=x'))).toEqual([]);
  const twice=new URLSearchParams();twice.append('sentinel_enable',K);twice.append('sentinel_remove',K);expect(()=>readSentinelLink(twice)).toThrow('twice');
  expect(()=>readSentinelLink(new URLSearchParams('sentinel_enable=ed25519:bad'))).toThrow();
 });
 it('parses pasted keys with names',()=>{
  expect(parseSentinelKeys(`${K}, Burst watcher\n\n${A}\n${K}`)).toEqual([{key:K,name:'Burst watcher'},{key:A}]);
  expect(()=>parseSentinelKeys('vendor.testnet')).toThrow();
 });
 it('skips changes already on chain and keeps the cap of 8',()=>{
  expect(sentinelChanges([{key:K,enabled:true},{key:A,enabled:false}],[K])).toEqual({todo:[],already:[{key:K,enabled:true},{key:A,enabled:false}]});
  expect(sentinelChanges([{key:K,enabled:false}],[K]).todo).toEqual([{key:K,enabled:false}]);
  const eight=Array.from({length:8},(_,i)=>`k${i}`);
  expect(()=>sentinelChanges([{key:K,enabled:true}],eight)).toThrow('at most 8');
  expect(sentinelChanges([{key:'k0',enabled:false},{key:K,enabled:true}],eight).todo).toHaveLength(2);
 });
});

describe('getting sentinels',()=>{
 it('gives the commands for the loaded vault, with no key in them',()=>{
  const cmd=sentinelQuickstart('lambda.styx-vaults.testnet');
  expect(cmd).toContain('styx-sentinels quickstart --vault lambda.styx-vaults.testnet');
  expect(cmd).toContain('cargo build --release --manifest-path sdk/near/Cargo.toml');
  expect(cmd.split('\n')).toHaveLength(3);
  expect(cmd).not.toMatch(/ed25519:|NEARAI_API_KEY=/);
  expect(()=>sentinelQuickstart('bad; rm -rf /')).toThrow();
  expect(()=>sentinelQuickstart('Lambda.styx-vaults.testnet')).toThrow();
 });
 it('accepts the names file styx-sentinels names writes',()=>{
  const file=JSON.stringify({vault:'lambda.styx-vaults.testnet',labels:{'ed25519:Cg1uVkD8hQymZyN9GzKWMsr49P2wjaQp9tLLbDVu5Xaw':'burst-g1','ed25519:999SwGbAyfw8rgCy4oSTzkEu1apfAc5xDkekc2YBoGgq':'concentration-g1'}},null,2)+'\n';
  expect(Object.values(parseLabels(file,'lambda.styx-vaults.testnet')).sort()).toEqual(['burst-g1','concentration-g1']);
  expect(()=>parseLabels(file,'other.styx-vaults.testnet')).toThrow();
 });
 it('takes only this vault\'s key installs from a hosted service\'s answer',()=>{
  const V='lambda.styx-vaults.testnet',A='ed25519:Cg1uVkD8hQymZyN9GzKWMsr49P2wjaQp9tLLbDVu5Xaw',B='ed25519:999SwGbAyfw8rgCy4oSTzkEu1apfAc5xDkekc2YBoGgq';
  const link=`https://styxco.xyz/console/?vault=${V}&network=testnet&sentinel_enable=${A}&sentinel_label=burst-g1&sentinel_enable=${B}&sentinel_label=concentration-g1`;
  expect(hostedChanges({vault:V,link},V,'https://styxco.xyz')).toEqual([{key:A,enabled:true,name:'burst-g1'},{key:B,enabled:true,name:'concentration-g1'}]);
  expect(hostedChanges({vault:V,link:null},V,'https://styxco.xyz')).toEqual([]);
  expect(()=>hostedChanges({vault:'other.styx-vaults.testnet',link},V,'https://styxco.xyz')).toThrow(/another vault/);
  expect(()=>hostedChanges({vault:V,link:link.replace('styxco.xyz','evil.example')},V,'https://styxco.xyz')).toThrow(/another site/);
  expect(()=>hostedChanges({vault:V,link:link.replace(`vault=${V}`,'vault=other.styx-vaults.testnet')},V,'https://styxco.xyz')).toThrow(/another vault/);
  expect(()=>hostedChanges({vault:V,link:`https://styxco.xyz/console/?vault=${V}&sentinel_remove=${A}`},V,'https://styxco.xyz')).toThrow(/only install/);
  expect(()=>hostedChanges(null,V,'https://styxco.xyz')).toThrow();
 });
 it('describes the pause the vault is in, with the payments in the 5 minutes before it',()=>{
  const row=(event:string,time:string,data:Record<string,any>={},tx='t'):EventRow=>({event,time,data,tx});
  const pay=(min:number,sec=0)=>row('payment_executed',`2026-11-14T12:${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}.000Z`,{amount:'1000000'});
  const rows=[pay(10),row('sentinel_paused','2026-11-14T12:11:00.000Z',{sentinel:'ed25519:A',reason:'old'},'old'),row('unpaused','2026-11-14T12:12:00.000Z'),
   pay(14),pay(20),pay(21),pay(22,30),row('sentinel_paused','2026-11-14T12:23:00.000Z',{sentinel:'ed25519:B',reason:'<b>3 payments</b>'},'p2'),pay(24)];
  const c=currentPause(rows)!;
  expect([c.sentinel,c.reason,c.tx,c.recent,c.recentBase]).toEqual(['ed25519:B','<b>3 payments</b>','p2',3,3000000n]);
  expect(currentPause([...rows,row('unpaused','2026-11-14T12:30:00.000Z')])).toBeNull();
  expect(currentPause([...rows.filter(r=>r.event!=='sentinel_paused'),row('sentinel_paused','Unavailable',{sentinel:'ed25519:C',reason:'r'},'p3')])!.recent).toBeNull(); // no time from the indexer: say so, do not guess
 });
 it('writes the owner\'s pause verdicts in the file the runner imports',()=>{
  const file=JSON.parse(pauseLabelsFile('lambda.styx-vaults.testnet',{p1:'catch',p2:'false_alarm'}));
  expect(file).toEqual({vault:'lambda.styx-vaults.testnet',pause_labels:[{tx:'p1',outcome:'catch'},{tx:'p2',outcome:'false_alarm'}]});
  expect(readPauseLabels('{"p1":"catch","p2":"nonsense"}')).toEqual({p1:'catch'});
  expect(readPauseLabels('not json')).toEqual({});expect(readPauseLabels(null)).toEqual({});
 });
});

describe('velocity limit',()=>{
 it('maps set_velocity_limit, with bounds, and words',()=>{
  expect(plan('set_velocity_limit',{max_payments_per_window:'5',window_seconds:'600'}).args).toEqual({max_payments_per_window:5,window_seconds:600});
  expect(plan('set_velocity_limit',{max_payments_per_window:'0',window_seconds:''}).args).toEqual({max_payments_per_window:0,window_seconds:0});
  for(const [n,w] of [['101','600'],['5','0'],['5','86401'],['x','600'],['-1','60']]) expect(()=>plan('set_velocity_limit',{max_payments_per_window:n,window_seconds:w})).toThrow();
  expect(describePlan(plan('set_velocity_limit',{max_payments_per_window:'5',window_seconds:'600'}))).toBe('Velocity limit: at most 5 payments in 10 min');
  expect(describePlan(plan('set_velocity_limit',{max_payments_per_window:'0',window_seconds:'0'}))).toBe('Velocity limit off');
 });
 it('shows only on vaults that have it',()=>{
  expect(velocitySupported({contract_version:3})).toBe(false);
  expect(velocityText({contract_version:3})).toBeNull();
  expect(velocityText({max_payments_per_window:5,window_seconds:600})).toBe('At most 5 payments in any 10 min.');
  expect(velocityText({max_payments_per_window:0,window_seconds:0})).toContain('No velocity limit');
 });
});
