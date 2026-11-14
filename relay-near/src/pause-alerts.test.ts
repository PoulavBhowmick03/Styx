import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from './pause.fixture.json';
import { parseEvents, reasonText } from './chain';
import { checkPauses } from './pause-alerts';
import { Watches } from './watches';
it('parses only successful Styx receipts from the vault', () => {
 expect(parseEvents(fixture, 'other.testnet')).toEqual([]);
 const bad=structuredClone(fixture); bad.receipts_outcome[0].outcome.status = {Failure: {}} as any;
 expect(parseEvents(bad,'lambda.styx-vaults.testnet')).toEqual([]);
 expect(parseEvents(fixture,'lambda.styx-vaults.testnet')).toHaveLength(1);
 expect(new TextEncoder().encode(reasonText('🙂'.repeat(100))).length).toBe(280);
});
it('sends plain text to linked owner chats once across restart', async () => {
 const vault='lambda.styx-vaults.testnet', file=join(mkdtempSync(join(tmpdir(),'pause-')),'watches.json');
 let w=new Watches(file); w.watch('123',vault);
 const sent: string[]=[];
 const chain={rpc:async(m:string)=>m==='block'?{header:{timestamp_nanosec:'1'}}:({keys:[{public_key:'owner',access_key:{permission:'FullAccess'}}]}),events:async()=>parseEvents(fixture,vault)};
 const pass=()=>checkPauses(w,async()=>({owner:'owner.testnet',paused:true}),k=>k==='owner'?['456']:[],async(chat,text)=>{sent.push(chat+text);return true;},chain);
 await pass(); w=new Watches(file); await pass();
 expect(sent).toHaveLength(1); expect(sent[0]).toContain('456Styx');
 expect(sent[0]).toContain('<b>too many payments</b> & slow');
 expect(sent[0]).toContain('&network=testnet#sentinels');
 expect(sent[0]).toContain('/txns/pause-tx');
});
it('treats pauses from before the first pass as history, then alerts each new one', async () => {
 const vault='lambda.styx-vaults.testnet', w=new Watches(); w.watch('123',vault);
 const old=parseEvents(fixture,vault), sent: string[]=[];
 let events=old;
 const chain={rpc:async(m:string)=>m==='block'?{header:{timestamp_nanosec:'1'}}:({keys:[{public_key:'owner',access_key:{permission:'FullAccess'}}]}),events:async()=>events};
 const pass=()=>checkPauses(w,async()=>({owner:'owner.testnet',paused:false}),k=>k==='owner'?['456']:[],async(chat,text)=>{sent.push(text);return true;},chain);
 await pass();
 expect(sent).toHaveLength(0);
 events=[...old,{...old[0],id:'new-pause',tx:'new-tx'}];
 await pass(); await pass();
 expect(sent).toHaveLength(1); expect(sent[0]).toContain('/txns/new-tx');
});
it('reads only new transactions after the first pass', async () => {
 const vault='lambda.styx-vaults.testnet', w=new Watches(); w.watch('123',vault);
 const calls: number[]=[];
 const chain={rpc:async(m:string)=>m==='block'?{header:{timestamp_nanosec:'1'}}:({keys:[{public_key:'owner',access_key:{permission:'FullAccess'}}]}),
  events:async(_v:string,known?:Set<string>)=>{calls.push(known!.size);known!.add('tx-1');return [];}};
 const pass=()=>checkPauses(w,async()=>({owner:'owner.testnet',paused:false}),()=>['456'],async()=>true,chain as any);
 await pass(); await pass();
 expect(calls).toEqual([0,1]); // the second pass starts from what the first read
});
it('keeps what it read when a request fails midway, and alerts on the next pass', async () => {
 const vault='lambda.styx-vaults.testnet', w=new Watches(); w.watch('123',vault);
 const pause=parseEvents(fixture,vault)[0], sent: string[]=[];
 let fail=true;
 const chain={rpc:async(m:string)=>m==='block'?{header:{timestamp_nanosec:'1'}}:({keys:[{public_key:'owner',access_key:{permission:'FullAccess'}}]}),
  events:async(_v:string,known:Set<string>,sink:any[])=>{if(fail){sink.push(pause);known.add('pause-tx');throw new Error('429');}return sink;}};
 const pass=()=>checkPauses(w,async()=>({owner:'owner.testnet',paused:true}),()=>['456'],async(_c,t)=>{sent.push(t);return true;},chain as any);
 await pass(); expect(sent).toHaveLength(0);
 fail=false; await pass(); expect(sent).toHaveLength(1);
 await pass(); expect(sent).toHaveLength(1);
});
