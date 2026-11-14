import '../../site/styx.css';
import './style.css';
import type { State } from './types';
import { card, esc, feed, generations, mode, ownerActions, timeline } from './view';

const $=<T extends HTMLElement=HTMLElement>(s:string)=>document.querySelector<T>(s)!;

function render(s:State){
 const members=s.members??[],lineage=s.lineage??[];
 $('#mode').textContent=mode(s);
 const state=$('#state');state.textContent=s.paused?'Vault paused':'Vault live';state.className=`pill ${s.paused?'paused':'live'}`;
 $('#vault').innerHTML=s.vault?`Watching <code>${esc(s.vault)}</code>`:'Watching a vault';
 const caption=$('#caption');caption.hidden=!s.caption;caption.textContent=s.caption??'';
 const fired=lineage.filter(e=>e.action==='pause').at(-1)?.member??'';
 const active=members.filter(m=>m.status==='active');
 $('#summary').textContent=`${active.length} active · ${members.length-active.length} retired · ${members.reduce((n,m)=>n+m.catches,0)} attacks caught`;
 $('#cards').innerHTML=members.slice().sort((a,b)=>(a.status===b.status?0:a.status==='active'?-1:1)).map(m=>card(m,fired,!!s.paused)).join('')||'<p class="empty">No sentinels yet. Run styx-sentinels init.</p>';
 $('#timeline').innerHTML=timeline(s);
 $('#feed').innerHTML=feed(lineage);
 $('#tree').innerHTML=generations(members);
 $('#actions').innerHTML=ownerActions(s);
}

async function tick(){
 try{render(await (await fetch('./api/state',{cache:'no-store'})).json());}
 catch{$('#state').textContent='Runner not reachable';}
}
// Settling a pause: the owner tells the parent whether it was an attack or a false alarm.
document.addEventListener('click',async e=>{
 const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button[data-label]');if(!b) return;
 b.disabled=true;
 await fetch('./api/label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({member:b.dataset.member,time:Number(b.dataset.time),outcome:b.dataset.label})});
 await tick();
});
void tick();setInterval(tick,1500);
