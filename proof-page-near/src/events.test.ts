import { it, expect } from 'vitest';
import fixture from '../test/pause.json';
import { parseEvents, reasonText, chainClient } from './chain';
import { pauseStats, load, summary, type TimedEvent } from './events';
const vault='lambda.styx-vaults.testnet';
const pause={...parseEvents(fixture,vault)[0],ns:10_500_000_000n};
const payment=(ns:bigint,kind='payment_executed'):TimedEvent=>({...pause,kind,ns,data:{amount:'1',recipient:'receiver.testnet'}});
it('accepts only successful vault Styx receipts and preserves literal reason',()=>{
 expect(parseEvents(fixture,'wrong.testnet')).toEqual([]);
 expect(pause.data.reason).toBe('<b>too many payments</b> & slow');
 const bad=structuredClone(fixture);bad.receipts_outcome[0].outcome.status={Failure:{}} as any;
 expect(parseEvents(bad,vault)).toEqual([]);
 bad.receipts_outcome[0].outcome.status={SuccessValue:''};bad.receipts_outcome[0].outcome.logs=['EVENT_JSON:{','EVENT_JSON:'+JSON.stringify({standard:'other',data:[{}]})];
 expect(parseEvents(bad,vault)).toEqual([]);
 expect(new TextEncoder().encode(reasonText('🙂'.repeat(100))).length).toBe(280);
});
it('counts settled payments strictly earlier and computes fractional seconds',()=>{
 expect(pauseStats(pause,[payment(9_000_000_000n),payment(1n),payment(pause.ns),payment(20_000_000_000n),payment(8n,'evm_payment_signed')])).toEqual({count:2,sinceUnpause:false,seconds:1.5});
 expect(pauseStats(pause,[])).toEqual({count:0,sinceUnpause:false,seconds:null});
 const unpause={...pause,kind:'unpaused',ns:5_000_000_000n};
 expect(pauseStats(pause,[payment(1n),payment(2n),unpause,payment(9_000_000_000n)])).toEqual({count:1,sinceUnpause:true,seconds:1.5});
});
it('uses receipt block timestamps and caches blocks',async()=>{
 const got=await load(vault,{events:async()=>[pause],rpc:async(method,params)=>{expect(method).toBe('block');expect(params).toEqual({block_id:'block-1'});return {header:{timestamp_nanosec:'10500000000'}};}});
 expect(got[0].ns).toBe(pause.ns);
});
it('paginates listings, resolves signers, confirms through RPC',async()=>{
 const calls:any[]=[];
 const get=async(url:any,opts:any)=>{
  const q=JSON.parse(opts.body);calls.push(q);
  let data;
  if(url.includes('/v0/account')) data={account_txs:q.max_block_height===null?[{transaction_hash:'pause-tx',tx_block_height:50}]:[]};
  else if(url.includes('/v0/transactions'))data={transactions:[{transaction:{hash:'pause-tx',signer_id:'sentinel.testnet'}}]};
  else data={result:fixture};
  return new Response(JSON.stringify(data));
 };
 expect(await chainClient(get as any).events(vault)).toHaveLength(1);
 expect(calls.find(c=>c.method==='tx').params.wait_until).toBe('FINAL');
 expect(calls.at(-1).max_block_height).toBe(49);
});
it('stops when every counted transaction is read, as FastNEAR answers the same page again',async()=>{
 const rows=[{transaction_hash:fixture.transaction.hash,tx_block_height:5}];
 let listings=0;
 const fake=(async(url:string,init:any)=>{
  const q=JSON.parse(init.body);let data:any;
  if(url.includes('/v0/account')){listings++;data={account_txs:rows,txs_count:1};}
  else if(url.includes('/v0/transactions')) data={transactions:[{transaction:{hash:fixture.transaction.hash,signer_id:'sentinel.testnet'}}]};
  else if(q.method==='tx') data={result:fixture};
  return {ok:true,json:async()=>data} as any;
 }) as typeof fetch;
 const events=await chainClient(fake).events(vault);
 expect(events.length).toBe(1);expect(listings).toBe(1);
});
it('summarises payments, tokens and each pause for the top of the page',()=>{
 const unpause={...pause,kind:'unpaused',ns:5_000_000_000n};
 const s=summary([payment(1n),payment(2n),unpause,payment(9_000_000_000n),pause]);
 expect(s.payments).toBe(3);expect(s.tokens).toBe(0.000003);expect(s.unpauses).toBe(1);
 expect(s.pauses).toHaveLength(1);
 expect(s.pauses[0]).toMatchObject({count:1,sinceUnpause:true,seconds:1.5,tx:pause.tx});
 expect(summary([]).pauses).toEqual([]);
});
