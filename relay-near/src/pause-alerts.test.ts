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
 const chain={rpc:async()=>({keys:[{public_key:'owner',access_key:{permission:'FullAccess'}}]}),events:async()=>parseEvents(fixture,vault)};
 const pass=()=>checkPauses(w,async()=>({owner:'owner.testnet'}),k=>k==='owner'?['456']:[],async(chat,text)=>{sent.push(chat+text);return true;},chain);
 await pass(); w=new Watches(file); await pass();
 expect(sent).toHaveLength(1); expect(sent[0]).toContain('456Styx');
 expect(sent[0]).toContain('<b>too many payments</b> & slow');
 expect(sent[0]).toContain('&network=testnet#sentinels');
 expect(sent[0]).toContain('/txns/pause-tx');
});
