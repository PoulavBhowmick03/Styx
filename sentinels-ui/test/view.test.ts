import { describe, expect, it } from 'vitest';
import { card, esc, feed, generations, line, mode, ownerActions, timeline } from '../src/view';
import type { Member } from '../src/types';

const member=(over:Partial<Member>={}):Member=>({id:'burst-g1',kind:'burst',generation:1,params:{max_payments:4,window_seconds:300},public_key:'ed25519:KEY',status:'active',notes:[],pauses:[],score:0,catches:0,false_alarms:0,...over});

describe('swarm page',()=>{
 it('escapes everything that comes from the runner',()=>{
  expect(esc('<img onerror=x>')).toBe('&lt;img onerror=x&gt;');
  const html=card(member({pauses:[{time:1,reason:'<script>alert(1)</script>',tx:'t',outcome:'open'}]}),'',false);
  expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
 });
 it('shows the settle buttons only for an open pause of an active sentinel',()=>{
  const open=member({pauses:[{time:5,reason:'burst',tx:'t',outcome:'open'}]});
  expect(card(open,'',false)).toContain('data-label="catch"');
  expect(card({...open,status:'retired'},'',false)).not.toContain('data-label');
  expect(card(member({pauses:[{time:5,reason:'b',tx:'t',outcome:'catch'}]}),'',false)).not.toContain('data-label');
 });
 it('says in words what each lineage step was',()=>{
  expect(line({time:0,action:'retire',member:'burst-g1',score:-2,false_alarms:1})).toBe('<b>burst-g1</b> retired at score -2 after 1 false alarm');
  expect(line({time:0,action:'spawn',member:'burst-g2',parent:'burst-g1',notes:['Raised it']})).toContain('spawned from burst-g1. Learned: Raised it');
  expect(feed([])).toContain('Nothing yet');
 });
 it('labels rehearsals and dry runs, and links owner actions only for real vaults',()=>{
  expect(mode({rehearsal:true})).toBe('Rehearsal: simulated payments');
  expect(mode({dry_run:true})).toBe('Dry run: pauses not sent');
  const actions=[{action:'enable' as const,member:'burst-g2',public_key:'k',link:'https://styxco.xyz/console/?sentinel_enable=k'}];
  expect(ownerActions({owner_actions:actions})).toContain('href="https://styxco.xyz/console/?sentinel_enable=k"');
  expect(ownerActions({rehearsal:true,owner_actions:actions})).not.toContain('href=');
  const many={owner_actions:[...actions,{action:'remove' as const,member:'burst-g1',public_key:'j',link:'l'},{action:'enable' as const,member:'judge-g1',public_key:'m',link:'l',done:true}],sign_all:'https://styxco.xyz/console/?all=1'};
  const html=ownerActions(many);
  expect(html).toContain('Review and sign all 2 in one approval');expect(html).toContain('1 key change confirmed');expect(html).not.toContain('judge-g1');
  expect(ownerActions({owner_actions:[{...actions[0],done:true}]})).toContain('Nothing to sign.');
 });
 it('draws payments, pauses, unpauses and attack bands on the timeline, and families as words',()=>{
  const html=timeline({events:[{type:'payment',time:10,tx:'a',recipient:'v.testnet',amount:2e6},{type:'sentinel_pause_sent',time:20,tx:'b',sentinel:'burst-g2'},{type:'unpaused',time:30,tx:'c'}],attack_windows:[[15,25,'drill']]});
  expect(html).toContain('class="bar"');expect(html).toContain('burst-g2 paused');expect(html).toContain('Owner unpaused');expect(html).toContain('class="band"');
  expect(generations([member(),member({id:'burst-g2',generation:2})])).toContain('<span class="then">then</span>');
 });
});
