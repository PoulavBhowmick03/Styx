import '../../site/styx.css';
import './proof.css';
import { load, pauseStats, payments, type TimedEvent } from './events';
import { reasonText } from './chain';
const vault = new URLSearchParams(location.search).get('vault') ?? 'lambda.styx-vaults.testnet';
const input = document.querySelector<HTMLInputElement>('#vault')!; input.value=vault;
const status = document.querySelector('#status')!, timeline = document.querySelector('#timeline')!;
function el(tag: string, text: string) { const e=document.createElement(tag); e.textContent=text; return e; }
function render(events: TimedEvent[]) {
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
