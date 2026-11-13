// Browser-only wallet stand-in. No keys, real wallet API or signed transaction is used.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const fixture=JSON.parse(readFileSync(new URL('./live-testnet.json',import.meta.url),'utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 for(const accountId of ['stranger.testnet','styx-owner-c87a.testnet']){
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let paused=false;
  await page.route('**/@near-wallet-selector_core.js?*',route=>route.fulfill({contentType:'application/javascript',body:`
   export async function setupWalletSelector(){
    const accounts=[{accountId:${JSON.stringify(accountId)},active:true}];
    return {store:{getState:()=>({accounts}),observable:{subscribe:fn=>{fn();return {unsubscribe(){}};}}},
     wallet:async()=>({id:'meteor-wallet',getAccounts:async()=>accounts,signAndSendTransaction:async params=>{window.__submitted=params;return {transaction:{hash:'mock-owner-change'}};}})};
   }` }));
  await page.route('https://api-testnet.nearblocks.io/**',route=>route.fulfill({status:403}));
  await page.route(fixture.rpc,async route=>{
   const q=route.request().postDataJSON(),p=q.params;let result;
   if(q.method==='status')result=fixture.status;
  else if(q.method==='query'){
    if(p.request_type==='view_access_key_list')result=fixture.accessKeys;
    else{
     const args=JSON.parse(Buffer.from(p.args_base64,'base64').toString());
     result=structuredClone(fixture.views[p.account_id+':'+p.method_name+':'+JSON.stringify(args,Object.keys(args).sort())]);
     if(p.method_name==='get_vault'){
      const info=JSON.parse(Buffer.from(result.result).toString());info.paused=paused;result.result=[...Buffer.from(JSON.stringify(info))];
     }
    }
   }else if(q.method==='tx' && p.tx_hash==='mock-owner-change'){
    paused=true;result={final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:p.tx_hash}};
   }
   assert.ok(result,'Missing canned RPC result');await route.fulfill({json:{result}});
  });
  await page.goto((process.env.CONSOLE_URL??'http://127.0.0.1:5174')+'/?vault='+fixture.vault);
  await page.getByText(/Lists unavailable/).waitFor();
  if(accountId==='stranger.testnet'){
   assert.match(await page.locator('#role').textContent(),/Read-only/);
   for(const button of await page.locator('[data-write]').all())assert.equal(await button.isDisabled(),true);
  }else{
   await page.locator('form[data-method="pause"] button').click();
   assert.match(await page.locator('#preview').textContent(),/"method": "pause"/);
   assert.match(await page.locator('#preview').textContent(),/"deposit": "0"/);
   await page.locator('#send').click();
   await page.getByText(/Transaction finalized: mock-owner-change/).waitFor();
   const submitted=await page.evaluate(()=>window.__submitted);
   assert.equal(submitted.signerId,accountId);assert.equal(submitted.receiverId,fixture.vault);
   assert.deepEqual(submitted.actions,[{type:'FunctionCall',params:{methodName:'pause',args:{},gas:'100000000000000',deposit:'0'}}]);
   const card=page.locator('#overview-data article').filter({has:page.getByText('Paused',{exact:true})});
   assert.match(await card.textContent(),/true/);
  }
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: non-owner write guards; mocked owner pause preview, exact wallet call, finality and chain state reread. No real wallet or transaction.');
}finally{await browser.close();}
