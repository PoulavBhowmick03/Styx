// Sentinels panel, browser-only: a version 3 vault paused by a sentinel, opened from the parent's link.
// The wallet is a stand-in; no key, real wallet or signed transaction is used.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
const fixture=JSON.parse(readFileSync(new URL('./live-testnet.json',import.meta.url),'utf8'));
const key=n=>'ed25519:'+bs58.encode(new Uint8Array(32).fill(n));
const OLD=key(7),NEW=key(9),OWNER='styx-owner-c87a.testnet',vault=fixture.vault;
const reason='6 payments in 5 min (12 total), over the 4 allowed <b>not html</b>';
const view=v=>({result:[...Buffer.from(JSON.stringify(v))],logs:[],block_height:1,block_hash:'mock'});
const pauseTx={final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:'pause-tx'},transaction_outcome:{block_hash:'pause-block'},
 receipts_outcome:[{outcome:{executor_id:vault,status:{SuccessValue:''},logs:['EVENT_JSON:'+JSON.stringify({standard:'styx',version:'1.0.0',event:'sentinel_paused',data:[{sentinel:OLD,reason,day:20769,vault_day_spent:'6000000'}]})]}}]};
let server;const base=process.env.CONSOLE_URL??(server=await createServer({root:new URL('..',import.meta.url).pathname,server:{port:5191,host:'127.0.0.1',strictPort:true},logLevel:'error'}),await server.listen(),'http://127.0.0.1:5191');
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/@near-wallet-selector_core.js?*',route=>route.fulfill({contentType:'application/javascript',body:`
  export async function setupWalletSelector(){
   const accounts=[{accountId:${JSON.stringify(OWNER)},active:true}];
   return {store:{getState:()=>({accounts}),observable:{subscribe:fn=>{fn();return {unsubscribe(){}};}}},
    wallet:async()=>({id:'meteor-wallet',getAccounts:async()=>accounts,signAndSendTransaction:async params=>{window.__submitted=params;return {transaction:{hash:'mock-sentinel-change'}};}})};
  }` }));
 await page.route('https://api-testnet.nearblocks.io/**',route=>route.fulfill({json:{txns:[{transaction_hash:'pause-tx',signer_account_id:vault}]}}));
 await page.route('https://styx-relay-near.fly.dev/**',route=>route.fulfill({status:503}));
 await page.route(fixture.rpc,async route=>{
  const q=route.request().postDataJSON(),p=q.params;let result;
  if(q.method==='status')result=fixture.status;
  else if(q.method==='block')result={header:{timestamp_nanosec:'1794650000000000000'}};
  else if(q.method==='tx')result=p.tx_hash==='pause-tx'?pauseTx:{final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:p.tx_hash}};
  else if(q.method==='query'){
   if(p.request_type==='view_access_key_list'){result=structuredClone(fixture.accessKeys);result.keys.push({public_key:OLD,access_key:{nonce:0,permission:{FunctionCall:{allowance:'50000000000000000000000',receiver_id:vault,method_names:['sentinel_pause']}}}});}
   else if(p.request_type==='view_account')result={amount:'10000000000000000000000000',locked:'0',storage_usage:500,code_hash:'11111111111111111111111111111111',block_height:1,block_hash:'mock'};
   else{
    const args=JSON.parse(Buffer.from(p.args_base64,'base64').toString());
    result=structuredClone(fixture.views[p.account_id+':'+p.method_name+':'+JSON.stringify(args,Object.keys(args).sort())]);
    if(p.method_name==='get_sentinels') result=view([OLD]);
    if(p.method_name==='get_policy') result=undefined;
    if(!result && p.method_name.startsWith('get_')) result=view(null);
    if(p.method_name==='get_vault'){const info=JSON.parse(Buffer.from(result.result).toString());result=view({...info,contract_version:3,paused:true});}
   }
  }
  if(!result && q.method==='query' && p.method_name==='get_policy') return route.fulfill({json:{jsonrpc:'2.0',id:q.id,error:{name:'HANDLER_ERROR',cause:{name:'NO_CONTRACT_CODE'}}}});
  assert.ok(result,`Missing mock ${q.method} ${JSON.stringify(p)}`);await route.fulfill({json:{jsonrpc:'2.0',id:q.id,result}});
 });
 const link=new URL(base+'/');for(const [k,v] of [['vault',vault],['network','testnet'],['sentinel_remove',OLD],['sentinel_enable',NEW],['sentinel_label','burst-g2']]) link.searchParams.append(k,v);
 await page.goto(link.toString());
 // The parent's link opens one review with both changes, once the owner is connected.
 await page.locator('#review[open]').waitFor();
 const preview=await page.locator('#preview').textContent();
 assert.match(preview,/2 calls, one approval/);assert.match(preview,/Sentinel removed/);assert.match(preview,/Sentinel installed/);
 // The panel: the paused banner, the key with allowance, and the pause reason as plain text.
 await page.locator('#cancel').click();
 await page.locator('#sentinels .paused-banner').getByText('The vault is paused.').waitFor();
 assert.match(await page.locator('#sentinel-count').textContent(),/1 of 8/);
 assert.match(await page.locator('#sentinel-list').textContent(),/methods: sentinel_pause/);
 await page.locator('#sentinel-pauses .pause').first().waitFor();
 assert.equal(await page.locator('#sentinel-pauses .pause p').first().textContent(),reason);
 assert.equal(await page.locator('#sentinel-pauses b').count(),0);
 // Install by pasting a key with a name, then sign: one set_sentinel to the vault.
 await page.locator('#sentinel-more').evaluate(d=>{d.open=true;});
 await page.locator('#sentinel-add textarea').fill(`${NEW}, Judge watcher`);
 await page.locator('#sentinel-add button').click();
 await page.locator('#review[open]').waitFor();
 await page.locator('#send').click();
 await page.waitForFunction(()=>window.__submitted);
 const sent=await page.evaluate(()=>window.__submitted);
 assert.equal(sent.signerId,OWNER);assert.equal(sent.receiverId,vault);
 assert.deepEqual(sent.actions.map(a=>[a.params.methodName,a.params.args]),[['set_sentinel',{key:NEW,enabled:true}]]);
 // The unpause is one reviewed click from the banner.
 await page.locator('#sentinels .paused-banner button').click();
 assert.match(await page.locator('#preview').textContent(),/"method": "unpause"/);
 const stored=await page.evaluate(()=>Object.entries(localStorage).find(([k])=>k.startsWith('styx-labels:'))?.[1]);
 assert.match(stored,/burst-g2/);
 // Exact Telegram URL opens review without signing, once per visit.
 await page.goto(`${base}/?vault=${encodeURIComponent(vault)}&network=testnet#sentinels`);
 await page.locator('#review[open]').waitFor();
 assert.match(await page.locator('#preview').textContent(),/"method": "unpause"/);
 assert.equal(await page.evaluate(()=>window.__submitted),undefined);
 await page.locator('#cancel').click();
 await page.locator('#review[open]').waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);
 console.log('PASS: v3 vault, parent link opens one review (remove + install), paused banner, reason as text, paste-to-install signs set_sentinel, unpause review, names kept; no browser errors.');
}finally{await browser.close();await server?.close();}
