import '../../site/styx.css';
import './proof.css';
import { load, pauseStats, payments, summary, type TimedEvent } from './events';
import { reasonText } from './chain';
const vault = new URLSearchParams(location.search).get('vault') ?? 'lambda.styx-vaults.testnet';
const input = document.querySelector<HTMLInputElement>('#vault')!; input.value=vault;
const status = document.querySelector('#status')!, timeline = document.querySelector('#timeline')!;
function el(tag: string, text: string) { const e=document.createElement(tag); e.textContent=text; return e; }
const short=(k:string)=>k.length>24?`${k.slice(0,14)}…${k.slice(-6)}`:k;
function renderSummary(events: TimedEvent[]) {
 const box=document.querySelector<HTMLElement>('#summary')!, s=summary(events);
 box.replaceChildren();box.hidden=!events.length;
 box.append(el('p',`${s.payments} payments settled (${s.tokens.toLocaleString('en-US',{maximumFractionDigits:6})} tUSDC) · ${s.pauses.length} sentinel ${s.pauses.length===1?'pause':'pauses'} · ${s.unpauses} owner ${s.unpauses===1?'unpause':'unpauses'}`));
 if(!s.pauses.length){box.append(el('p','No sentinel has paused this vault in the loaded history.'));return;}
 const table=document.createElement('table'),head=document.createElement('tr');
 for(const h of ['When (UTC)','Sentinel','Reason','Payments before it','Seconds after the last payment','Transaction']) head.append(el('th',h));
 table.append(head);
 for(const p of s.pauses){
  const tr=document.createElement('tr'),link=el('a','NearBlocks') as HTMLAnchorElement;
  link.href=`https://testnet.nearblocks.io/txns/${encodeURIComponent(p.tx)}`;link.rel='noreferrer';
  const td=document.createElement('td');td.append(link);
  tr.append(el('td',new Date(Number(p.ns/1000000n)).toISOString().replace('T',' ').slice(0,19)),el('td',short(p.sentinel)),el('td',reasonText(p.reason)),
   el('td',`${p.count}${p.sinceUnpause?' since the last unpause':''}`),el('td',p.seconds===null?'none earlier':`${p.seconds.toFixed(1)} s`),td);
  table.append(tr);
 }
 box.append(table);
 document.querySelector('#all-label')!.textContent=`Every event (${events.length})`;
}
function render(events: TimedEvent[]) {
 renderSummary(events);
 for (const e of events) {
  const row=el('li',''); row.className=e.kind.includes('paused') ? 'pause' : '';
  const title=e.kind==='sentinel_paused'?'Sentinel paused':e.kind==='unpaused'?'Owner unpaused':e.kind==='paused'?'Owner paused':e.kind==='payment_executed'?'Payment settled':'Payment authorization signed';
  row.append(el('h2',title),el('p',new Date(Number(e.ns/1000000n)).toISOString()));
  if (payments.has(e.kind)) row.append(el('p',`Amount: ${String(e.data.amount ?? '')} base units; recipient: ${String(e.data.recipient ?? '')}`));
  if(e.kind==='sentinel_paused') {
   row.append(el('p',`Sentinel: ${String(e.data.sentinel ?? '')}`),el('p',reasonText(e.data.reason)));
   const s=pauseStats(e,events);
   row.append(el('p',`${s.count} payments settled ${s.sinceUnpause?'since the owner\'s last unpause':'before it'}, ${s.seconds===null?'no earlier settlement in loaded history':`landed ${s.seconds.toFixed(3)} s after the last`}`));
   row.append(el('p','Block timestamps cannot order events within the same block; equal timestamps are excluded from “before”.'));
  }
  const link=el('a','View transaction on NearBlocks') as HTMLAnchorElement;
  link.href=`https://testnet.nearblocks.io/txns/${encodeURIComponent(e.tx)}`; link.rel='noreferrer';row.append(link);timeline.append(row);
 }
 status.textContent=events.length?`${events.length} confirmed events for ${vault}.`:`No confirmed events for ${vault}.`;
}
if(!/^(?=.{2,64}$)([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*$/.test(vault)) status.textContent='Enter a valid NEAR vault account.';
else load(vault).then(render).catch(()=>{status.textContent='Could not confirm complete history. Retry by selecting Read vault.';});
