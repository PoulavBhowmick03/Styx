// Pure rendering: state in, HTML out. Every value from the runner is escaped. No symbol glyphs:
// state is always a word (site/styx.css).
import type { LineageEntry, Member, State, Verdict } from './types';

export const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const clock=(t:number)=>new Date(t*1000).toISOString().slice(11,19);
export const tokens=(base:number)=>(base/1e6).toLocaleString('en-US',{maximumFractionDigits:2});
const words=(s:string)=>s.replace(/_/g,' ');
const plural=(n:number,one:string,many=one+'s')=>`${n} ${n===1?one:many}`;
const signed=(n:number)=>`${n>0?'+':''}${n}`;
export const FULL_ALLOWANCE=5e22;

export function mode(s:State):string{return s.rehearsal?'Rehearsal · simulated payments':s.dry_run?'Dry run · pauses not sent':`Live on NEAR ${s.network??'testnet'}`;}

// The genome in words: what this sentinel watches for.
export function genome(m:Member):string{
 const p=m.params;
 if(m.kind==='burst') return `More than ${p.max_payments} payments in ${Math.round((p.window_seconds??300)/60)} min`;
 if(m.kind==='concentration') return `One recipient over ${Math.round((p.share??0.4)*100)}% of the daily limit in ${Math.round((p.window_seconds??3600)/60)} min`;
 if(m.kind==='judge') return `A model on NEAR AI Cloud reads the last ${p.window??20} payments`;
 return Object.entries(p).map(([k,v])=>`${words(k)} ${v}`).join(', ');
}

// The key's allowance on NEAR is the sentinel's energy: every pause burns gas from it.
export function energy(m:Member,s:State):string{
 if(s.rehearsal) return '<span class="meta">Energy: rehearsal</span>';
 if(m.allowance==null) return '<span class="meta">Energy: not read yet</span>';
 const left=Number(m.allowance),pct=Math.max(0,Math.min(100,left/FULL_ALLOWANCE*100));
 return `<span class="energy${pct<20?' low':''}" title="Gas allowance left on this sentinel's NEAR key"><i style="width:${pct.toFixed(1)}%"></i></span><span class="meta">${(left/1e24).toFixed(4)} NEAR energy${m.next_key?' · fresh key proposed':''}</span>`;
}

export function chainState(m:Member,s:State):string{
 if(s.rehearsal||!s.installed_known) return '';
 return m.ratified?'<span class="tag ok">Key on chain</span>':'<span class="tag wait">Waiting for the owner</span>';
}

const short=(s:string,n=14)=>s.length>n+2?`${s.slice(0,n)}…`:s;

/** What the judge answered and what the NEAR AI client checked, in words. The full evidence is a file the runner serves. */
export function verdictBlock(v:Verdict):string{
 const checked=v.verified
  ?`Verified: the response signature was checked against the attested ${v.signature_kind==='gateway'?'gateway':'model'} signer${v.tls_bound?', on the TLS connection the attestation bound':''}.`
  :'Not verified: this answer carries no checked signature.';
 const checks=v.checks.length?`Checks run: ${v.checks.map(esc).join(', ')}.`:'';
 return `<div class="verdict"><p class="meta">${clock(v.time)} · ${v.pause?'Asked to pause':'No pause'} · model ${esc(v.model)}</p>
 <p>${esc(v.reason||'No reason given.')}</p>
 <p class="meta ${v.verified?'ok-line':'bad-line'}">${esc(checked)}</p>
 <p class="meta">Signer ${esc(short(v.signing_address,12))} · chat ${esc(short(v.chat_id,12))}. ${checks} <a href="./api/evidence/${esc(v.file)}" target="_blank" rel="noopener noreferrer">Full evidence (JSON)</a></p></div>`;
}

export function judgeBlock(m:Member):string{
 if(m.kind!=='judge') return '';
 const list=(m.verdicts??[]).slice(-3).reverse();
 if(!list.length) return '<p class="meta quiet verdicts">The judge has not answered yet. It asks the model when a new payment lands.</p>';
 return `<div class="verdicts"><p class="meta">Latest model verdicts</p>${list.map(verdictBlock).join('')}</div>`;
}

export function row(m:Member,s:State,firedId:string):string{
 const last=m.pauses.at(-1),misses=m.misses?.length??0,open=last?.outcome==='open';
 const settle=open&&m.status==='active'?`<div class="settle"><button class="ok" data-label="catch" data-member="${esc(m.id)}" data-time="${last!.time}">It was an attack</button><button data-label="false_alarm" data-member="${esc(m.id)}" data-time="${last!.time}">False alarm</button></div>`:'';
 return `<article class="row ${m.id===firedId&&s.paused?'fired':''}">
 <div class="who"><b>${esc(m.kind)}</b><span class="meta">Generation ${m.generation}</span>${chainState(m,s)}</div>
 <div class="fitness ${m.score<0?'neg':m.score>0?'pos':''}"><span>${signed(m.score)}</span><small>fitness</small></div>
 <div class="record meta">${plural(m.catches,'catch','catches')} · ${plural(m.false_alarms,'false alarm')} · ${plural(misses,'miss','misses')}</div>
 <div class="gene">${esc(genome(m))}</div>
 <div class="power">${energy(m,s)}</div>
 ${last?`<p class="last${open?' open':''}"><span class="meta">${clock(last.time)} · ${esc(words(last.outcome))}</span> ${esc(last.reason)}</p>${settle}`:''}
 ${judgeBlock(m)}
 </article>`;
}

export function timeline(s:State):string{
 const events=(s.events??[]).filter(e=>e.time);
 if(!events.length) return '<p class="empty">No payments yet.</p>';
 const t0=Math.min(...events.map(e=>e.time)),t1=Math.max(...events.map(e=>e.time))+1;
 const pos=(t:number)=>((t-t0)/(t1-t0))*96+2,x=(t:number)=>`${pos(t).toFixed(2)}%`,flip=(t:number)=>pos(t)>70?' flip':'';
 const flagged=new Set((s.lineage??[]).flatMap(e=>e.action==='pause'&&typeof e.evidence?.recipient==='string'?[e.evidence.recipient as string]:[]));
 const max=Math.max(1,...events.filter(e=>e.type==='payment').map(e=>e.amount??0));
 const bands=(s.attack_windows??[]).map(([a,b,l])=>`<div class="tl-band" style="left:${x(a)};width:calc(${x(b)} - ${x(a)})" title="${esc(l)}"></div>`).join('');
 const marks=events.map(e=>{
  if(e.type==='payment') return `<div class="tl-bar${flagged.has(e.recipient??'')?' hot':''}" style="left:${x(e.time)};height:${(10+54*(e.amount??0)/max).toFixed(0)}px" title="${esc(tokens(e.amount??0))} to ${esc(e.recipient)}"></div>`;
  if(e.type==='sentinel_pause_sent') return `<div class="tl-mark pause${flip(e.time)}" style="left:${x(e.time)}"><span>${esc(e.sentinel??'Sentinel')} paused</span></div>`;
  if(e.type==='unpaused') return `<div class="tl-mark unpause${flip(e.time)}" style="left:${x(e.time)}"><span>Owner unpaused</span></div>`;
  return '';}).join('');
 return bands+marks;
}

const change=(mut:Record<string,[number|null,number]>|undefined)=>Object.entries(mut??{}).map(([k,[a,b]])=>
 k==='share'?`share ${Math.round((a??0)*100)}% to ${Math.round(b*100)}%`:`${words(k)} ${a} to ${b}`).join(', ');

// One lineage per kind, oldest first: each generation, the mutation that made it, and why.
export function evolution(members:Member[],lineage:LineageEntry[]):string{
 const kinds=[...new Set(members.map(m=>m.kind))];
 if(!kinds.length) return '<p class="empty">No sentinels yet. Run styx-sentinels init.</p>';
 const retiredWhy=new Map(lineage.filter(e=>e.action==='retire').map(e=>[e.member,e]));
 return kinds.map(k=>{
  const gens=members.filter(m=>m.kind===k).sort((a,b)=>a.generation-b.generation);
  const nodes=gens.map((m,i)=>{
   const r=retiredWhy.get(m.id);
   const why=r?`retired at ${signed(r.score??m.score)} after ${r.direction==='stricter'?plural(r.misses??0,'miss','misses'):plural(r.false_alarms??0,'false alarm')}`:m.status==='active'?'alive':'retired';
   const link=i>0?`<div class="mutation"><span class="meta">${gens[i-1].status==='retired'?'mutated':'then'}</span><b>${esc(change(m.mutation))||'same genome'}</b></div>`:'';
   return `${link}<div class="gen ${m.status}"><span class="g">G${m.generation}</span><span class="fit">${signed(m.score)}</span><span class="meta">${esc(why)}</span></div>`;
  }).join('');
  const learned=gens.at(-1)?.notes.at(-1);
  return `<div class="lineage-row"><span class="kind">${esc(k)}</span><div class="chain">${nodes}</div>${learned?`<p class="meta learned">Inherited note: ${esc(learned)}</p>`:''}</div>`;
 }).join('');
}

export function line(e:LineageEntry):string{
 const who=`<b>${esc(e.member)}</b>`;
 switch(e.action){
  case 'spawn': return e.parent?`${who} born from ${esc(e.parent)}${e.mutation&&Object.keys(e.mutation).length?`, ${esc(change(e.mutation))}`:''}`:`${who} born`;
  case 'pause': return `${who} paused the vault: ${esc(e.reason)}${e.model?` (model ${esc(e.model)}, ${e.verified?'response signature verified':'not verified'}${e.evidence_file?`, <a href="./api/evidence/${esc(e.evidence_file)}" target="_blank" rel="noopener noreferrer">evidence</a>`:''})`:''}`;
  case 'retire': return `${who} retired at fitness ${e.score}; its child will be ${esc(e.direction??'looser')}`;
  case 'settled': return `${who}'s pause settled as <b>${esc(words(e.outcome??''))}</b>: ${esc(e.why)}`;
  case 'labelled': return `The owner marked ${who}'s pause <b>${esc(words(e.outcome??''))}</b>`;
  case 'attack_marked': return `Attack marked: ${esc(e.label)}`;
  case 'missed': return `${who} missed ${esc(e.label)}`;
  case 'pause_failed': return `${who} tried to pause and failed: ${esc(e.error)}`;
  case 'key_confirmed': return `The owner ${e.change==='remove'?'removed':'installed'} ${who}'s key on chain`;
  case 'key_swapped': return `${who} now pauses with a fresh key`;
  case 'energy_low': return `${who} is low on energy: a fresh key is proposed`;
  default: return esc(words(e.action));
 }
}

export function feed(entries:LineageEntry[]):string{
 return entries.slice().reverse().slice(0,60).map(e=>`<li><time>${clock(e.time)}</time><span class="tag ${esc(e.action)}">${esc(words(e.action))}</span><span>${line(e)}</span></li>`).join('')||'<li class="empty">Nothing yet.</li>';
}

export function ownerActions(s:State):string{
 const pending=(s.owner_actions??[]).filter(a=>!a.done);
 if(!pending.length) return '';
 const items=pending.slice(-8).reverse().map(a=>`<li>${a.action==='enable'?'Install':'Remove'} <b>${esc(a.member)}</b>'s key${a.why==='energy'?' (fresh key, low energy)':''}</li>`).join('');
 const sign=!s.rehearsal&&s.sign_all?`<a class="sign-all" href="${esc(s.sign_all)}" target="_blank" rel="noopener noreferrer">Review and sign ${pending.length===1?'it':`all ${pending.length}`} in one approval</a>`:'<span class="meta">Rehearsal: nothing is signed.</span>';
 return `<section class="owner"><div class="head"><h2>Waiting for the owner</h2>${sign}</div><ul>${items}</ul>
 <p class="meta">The parent proposes; the owner decides. Only set_sentinel, signed by the vault's owner (or voted through by its DAO), changes which keys can pause.</p></section>`;
}
