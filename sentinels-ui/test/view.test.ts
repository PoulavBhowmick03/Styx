import { describe, expect, it } from 'vitest';
import { headline, status, kindName, energy, esc, evolution, feed, genome, judgeBlock, line, mode, ownerActions, row, timeline } from '../src/view';
import type { Member } from '../src/types';

const member=(over:Partial<Member>={}):Member=>({id:'burst-g1',kind:'burst',generation:1,params:{max_payments:4,window_seconds:300},public_key:'ed25519:KEY',status:'active',notes:[],pauses:[],score:0,catches:0,false_alarms:0,...over});
const GLYPHS=/[←-⇿✓✔✗✘✕✖•●○★☆\u{1F300}-\u{1FAFF}]/u;

describe('swarm page',()=>{
 it('escapes everything that comes from the runner',()=>{
  expect(esc('<img onerror=x>')).toBe('&lt;img onerror=x&gt;');
  const html=row(member({pauses:[{time:1,reason:'<script>alert(1)</script>',tx:'t',outcome:'open'}]}),{},'');
  expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('It was an attack');
  expect(feed([{time:1,action:'pause',member:'<b>x</b>',reason:'r'}])).toContain('&lt;b&gt;x&lt;/b&gt;');
 });
 it('says the genome in words and the record with misses',()=>{
  expect(genome(member())).toBe('More than 4 payments in 5 min');
  expect(genome(member({kind:'concentration',params:{share:0.3,window_seconds:3600}}))).toBe('One recipient over 30% of the daily limit in 60 min');
  const html=row(member({score:-1,misses:['leak'],catches:0}),{},'');
  expect(html).toContain('0 catches · 0 false alarms · 1 miss');expect(html).toContain('-1');
 });
 it('shows energy from the key allowance, and the key state only when known',()=>{
  expect(energy(member({allowance:'25000000000000000000000'}),{})).toContain('width:50.0%');
  expect(energy(member({allowance:'25000000000000000000000'}),{})).toContain('0.0250 NEAR energy');
  expect(energy(member({allowance:'5000000000000000000000'}),{})).toContain('energy low');
  expect(energy(member(),{rehearsal:true})).toContain('rehearsal');
  expect(row(member({ratified:false}),{installed_known:true},'')).toContain('Waiting for the owner');
  expect(row(member({ratified:true}),{installed_known:true},'')).toContain('Key on chain');
  expect(row(member(),{},'')).not.toContain('Key on chain');
 });
 it('draws each lineage with its mutations and why each parent retired',()=>{
  const g1=member({status:'retired',score:-2,false_alarms:1});
  const g2=member({id:'burst-g2',generation:2,params:{max_payments:6,window_seconds:300},parent:'burst-g1',mutation:{max_payments:[4,6]},notes:['Raised the burst threshold to 6']});
  const c1=member({id:'concentration-g1',kind:'concentration',status:'retired',score:-2,misses:['a','b']});
  const c2=member({id:'concentration-g2',kind:'concentration',generation:2,mutation:{share:[0.4,0.3]}});
  const html=evolution([g1,g2,c1,c2],[{time:1,action:'retire',member:'burst-g1',score:-2,false_alarms:1,direction:'looser'},{time:2,action:'retire',member:'concentration-g1',score:-2,misses:2,direction:'stricter'}]);
  expect(html).toContain('max payments 4 to 6');expect(html).toContain('share 40% to 30%');
  expect(html).toContain('retired at -2 after 1 false alarm');expect(html).toContain('retired at -2 after 2 misses');
  expect(html).toContain('Inherited note: Raised the burst threshold to 6');
  expect(line({time:1,action:'spawn',member:'burst-g2',parent:'burst-g1',mutation:{max_payments:[4,6]}})).toContain('born from burst-g1, max payments 4 to 6');
 });
 it('asks the owner only when something waits, with one link for all',()=>{
  expect(ownerActions({owner_actions:[]})).toBe('');
  const acts=[{action:'enable' as const,member:'burst-g2',public_key:'k',link:'l'},{action:'remove' as const,member:'burst-g1',public_key:'j',link:'l'},{action:'enable' as const,member:'x',public_key:'m',link:'l',done:true}];
  const html=ownerActions({owner_actions:acts,sign_all:'https://styxco.xyz/console/?all=1'});
  expect(html).toContain('Review and sign all 2 in one approval');expect(html).not.toContain('<b>x</b>');
  expect(ownerActions({owner_actions:acts,rehearsal:true})).not.toContain('href=');
 });
 it('draws payments, pauses, unpauses and attack spans, and uses words, never symbols',()=>{
  const state={events:[{type:'payment',time:10,tx:'a',recipient:'v.testnet',amount:2e6},{type:'sentinel_pause_sent',time:20,tx:'b',sentinel:'burst-g2'},{type:'unpaused',time:30,tx:'c'}],attack_windows:[[15,25,'drill']] as [number,number,string][]};
  const html=timeline(state);
  expect(html).toContain('class="tl-bar"');expect(html).toContain('burst-g2 paused');expect(html).toContain('Owner unpaused');expect(html).toContain('class="tl-band"');
  expect(mode({rehearsal:true})).toBe('Rehearsal · simulated payments');
  for(const out of [html,row(member({score:2}),{installed_known:true},''),evolution([member()],[]),ownerActions({owner_actions:[{action:'enable',member:'a',public_key:'k',link:'l'}],sign_all:'s'})]) expect(out).not.toMatch(GLYPHS);
 });
 it('shows each judge verdict with its model and what the client checked, in words, and escapes it',()=>{
  const v={time:5,pause:false,reason:'<b>normal</b>',model:'z-ai/test',verified:true,signature_kind:'provider_tee',signing_address:'0xabcdef0123456789',chat_id:'chat-123456789012345',checks:['gateway quote','model quote'],attested_signers:1,tls_bound:true,file:'judge-g1-1.json'};
  const j=member({kind:'judge',id:'judge-g1',verdicts:[v]});
  const html=judgeBlock(j);
  expect(html).toContain('model z-ai/test');expect(html).toContain('Verified: the response signature was checked against the attested model signer');
  expect(html).toContain('Checks run: gateway quote, model quote');expect(html).toContain('href="./api/evidence/judge-g1-1.json"');
  expect(html).toContain('&lt;b&gt;normal');expect(html).not.toContain('<b>normal');
  expect(judgeBlock(member({kind:'judge',verdicts:[{...v,verified:false}]}))).toContain('Not verified');
  expect(judgeBlock(member({kind:'judge'}))).toContain('has not answered yet');
  expect(judgeBlock(member())).toBe('');
  expect(row(j,{},'')).toContain('Latest model verdicts');
  expect(line({time:0,action:'pause',member:'judge-g1',reason:'drain',model:'z-ai/test',verified:true,evidence_file:'f.json'})).toContain('model z-ai/test, response signature verified');
 });
 it('leads with one plain sentence and a status word per sentinel',()=>{
  const m=member({catches:1,score:1});
  expect(headline({},[m],'').title).toBe('Your vault is watched.');
  expect(headline({},[m],'').sub).toContain('1 sentinel read every payment');
  expect(headline({},[m],'').sub).toContain('1 attack caught so far');
  const paused=headline({paused:true,lineage:[{time:1,action:'pause',member:'burst-g1',reason:'5 payments in 5 min'}]},[m],'burst-g1');
  expect(paused.title).toBe('Paused by the burst sentinel.');expect(paused.sub).toContain('5 payments in 5 min. No payment goes out');
  expect(headline({},[],'').title).toBe('No sentinels yet.');
  expect(status(m,{paused:true},'burst-g1')).toContain('Paused the vault');
  expect(status(member({ratified:false}),{installed_known:true},'')).toContain('Waiting for the owner');
  expect(status(m,{},'')).toContain('Watching');
  expect(kindName('new_recipient')).toBe('New recipient');
  // Technical numbers sit in the detail block, hidden until "Show details".
  expect(row(m,{},'')).toMatch(/<div class="detail">[\s\S]*fitness \+1/);
 });
});
