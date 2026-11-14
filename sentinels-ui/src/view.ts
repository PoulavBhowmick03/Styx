// Pure rendering: state in, HTML out. Every value from the runner is escaped.
import type { LineageEntry, Member, State } from './types';

export const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const clock=(t:number)=>new Date(t*1000).toISOString().slice(11,19);
export const tokens=(base:number)=>(base/1e6).toLocaleString('en-US',{maximumFractionDigits:2});
const words=(s:string)=>s.replace(/_/g,' ');

export function mode(s:State):string{return s.rehearsal?'Rehearsal: simulated payments':s.dry_run?'Dry run: pauses not sent':`Sentinels on ${s.network??'testnet'}`;}

export function card(m:Member,firedId:string,paused:boolean):string{
 const last=m.pauses.at(-1),open=m.pauses.some(p=>p.outcome==='open');
 const health=Math.max(4,Math.min(100,50+m.score*15));
 const params=Object.entries(m.params).map(([k,v])=>`${words(k)} ${v}`).join(' · ');
 const settle=last&&open&&m.status==='active'?`<div class="actions-row"><button class="ok" data-label="catch" data-member="${esc(m.id)}" data-time="${last.time}">It was an attack</button><button data-label="false_alarm" data-member="${esc(m.id)}" data-time="${last.time}">False alarm</button></div>`:'';
 return `<article class="card sentinel ${m.status}${m.id===firedId&&paused?' fired':''}">
 <div class="card-head"><span class="kind">${esc(m.kind)}</span><span class="gen">Generation ${m.generation} · ${m.status==='active'?'Active':'Retired'}</span></div>
 <div class="score ${m.score<0?'neg':m.score>0?'pos':''}">${m.score>0?'+':''}${m.score}</div>
 <p class="meta">${m.catches} caught · ${m.false_alarms} false alarms</p>
 <div class="health"><i style="width:${health}%" class="${m.score<0?'neg':''}"></i></div>
 <p class="meta">${esc(params)}</p>
 ${last?`<blockquote>${esc(last.reason)}<span class="meta">${clock(last.time)} · ${esc(words(last.outcome))}</span>${settle}</blockquote>`:'<p class="meta quiet">No pauses yet. Watching.</p>'}
 ${m.notes.length?`<p class="meta note-line">Learned: ${esc(m.notes.at(-1))}</p>`:''}
 <p class="meta key">Key ${esc(m.public_key.slice(0,24))}…</p></article>`;
}

export function timeline(s:State):string{
 const events=(s.events??[]).filter(e=>e.time);
 if(!events.length) return '<p class="empty">No payments yet.</p>';
 const t0=Math.min(...events.map(e=>e.time)),t1=Math.max(...events.map(e=>e.time))+1;
 const x=(t:number)=>`${(((t-t0)/(t1-t0))*96+2).toFixed(2)}%`;
 const flagged=new Set((s.lineage??[]).flatMap(e=>e.action==='pause'&&typeof e.evidence?.recipient==='string'?[e.evidence.recipient as string]:[]));
 const max=Math.max(1,...events.filter(e=>e.type==='payment').map(e=>e.amount??0));
 const bands=(s.attack_windows??[]).map(([a,b])=>`<div class="band" style="left:${x(a)};width:calc(${x(b)} - ${x(a)})" title="Marked attack"></div>`).join('');
 const marks=events.map(e=>{
  if(e.type==='payment') return `<div class="bar${flagged.has(e.recipient??'')||/drain/.test(e.recipient??'')?' hot':''}" style="left:${x(e.time)};height:${(12+70*(e.amount??0)/max).toFixed(0)}px" title="${esc(tokens(e.amount??0))} to ${esc(e.recipient)}"></div>`;
  if(e.type==='sentinel_pause_sent'||e.type==='sentinel_paused') return `<div class="mark pause" style="left:${x(e.time)}"><span>${esc(e.sentinel??'Sentinel')} paused</span></div>`;
  if(e.type==='unpaused') return `<div class="mark unpause" style="left:${x(e.time)}"><span>Owner unpaused</span></div>`;
  return '';}).join('');
 return bands+marks;
}

export function line(e:LineageEntry):string{
 const who=`<b>${esc(e.member)}</b>`;
 switch(e.action){
  case 'spawn': return `${who} spawned${e.parent?` from ${esc(e.parent)}`:''}${e.notes?.length?`. Learned: ${esc(e.notes.at(-1))}`:''}`;
  case 'pause': return `${who} paused the vault: ${esc(e.reason)}`;
  case 'retire': return `${who} retired at score ${e.score} after ${e.false_alarms} false alarm${e.false_alarms===1?'':'s'}`;
  case 'settled': return `${who}'s pause settled as <b>${esc(words(e.outcome??''))}</b>: ${esc(e.why)}`;
  case 'labelled': return `The owner marked ${who}'s pause <b>${esc(words(e.outcome??''))}</b>`;
  case 'attack_marked': return `Attack marked: ${esc(e.label)}`;
  case 'pause_failed': return `${who} tried to pause and failed: ${esc(e.error)}`;
  default: return esc(words(e.action));
 }
}

export function feed(entries:LineageEntry[]):string{
 return entries.slice().reverse().map(e=>`<li><time>${clock(e.time)}</time><span class="tag ${esc(e.action)}">${esc(words(e.action))}</span><span>${line(e)}</span></li>`).join('')||'<li class="empty">Nothing yet.</li>';
}

export function generations(members:Member[]):string{
 const kinds=[...new Set(members.map(m=>m.kind))];
 return kinds.map(k=>`<div class="family"><span class="kind">${esc(k)}</span>${members.filter(m=>m.kind===k).map(m=>`<span class="node ${m.status}">G${m.generation} · ${m.score>0?'+':''}${m.score} · ${m.status==='active'?'active':'retired'}</span>`).join('<span class="then">then</span>')}</div>`).join('')||'<p class="empty">No sentinels yet. Run styx-sentinels init.</p>';
}

export function ownerActions(s:State):string{
 const all=s.owner_actions??[],pending=all.filter(a=>!a.done),done=all.filter(a=>a.done && !a.cancelled).length;
 const signed=done?`<p class="meta">${done} key change${done===1?'':'s'} confirmed on the vault.</p>`:'';
 if(!pending.length) return `<p class="empty">Nothing to sign.</p>${signed}`;
 const items=pending.slice(-8).reverse().map(a=>`<li>${a.action==='enable'?'Install':'Remove'} <b>${esc(a.member)}</b>'s key${s.rehearsal?' <span class="meta">(rehearsal)</span>':` <span class="meta">· <a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">this one</a></span>`}</li>`).join('');
 const all_=!s.rehearsal && s.sign_all?`<a class="sign-all" href="${esc(s.sign_all)}" target="_blank" rel="noopener noreferrer">Review and sign ${pending.length===1?'it':`all ${pending.length}`} in one approval</a>`:'';
 return `<ul class="owner">${items}</ul>${all_}${signed}<p class="meta">Only the vault owner can install or remove a sentinel key. A new sentinel waits until its key is on the vault.</p>`;
}
