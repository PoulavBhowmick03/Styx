import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const fixture=JSON.parse(readFileSync(new URL('./live-testnet.json',import.meta.url),'utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 let indexerDown=false;
 await page.route('https://api-testnet.nearblocks.io/**',route=>route.fulfill(indexerDown?{status:403}:{json:{txns:Object.keys(fixture.transactions).map(hash=>({transaction_hash:hash,signer_account_id:fixture.vault}))}}));
 await page.route(fixture.rpc,async route=>{
  const q=route.request().postDataJSON(),p=q.params;let result;
  if(q.method==='status')result=fixture.status;
  else if(q.method==='query'){
   if(p.request_type==='view_access_key_list')result=fixture.accessKeys;
   else{
    const args=JSON.parse(Buffer.from(p.args_base64,'base64').toString());
    const sorted=JSON.stringify(args,Object.keys(args).sort());
    result=fixture.views[p.account_id+':'+p.method_name+':'+sorted];
   }
  }else if(q.method==='tx')result=fixture.transactions[p.tx_hash];
  else if(q.method==='block')result={header:fixture.blocks[p.block_id]};
  assert.ok(result,`Missing mock ${q.method} ${JSON.stringify(p)}`);
  await route.fulfill({json:{jsonrpc:'2.0',id:q.id,result}});
 });
 await page.goto((process.env.CONSOLE_URL??'http://127.0.0.1:5174')+'/?vault='+fixture.vault);
 await page.locator('#overview-data').getByText('styx-owner-c87a.testnet',{exact:true}).waitFor();
 await page.locator('#payment-rows tr').waitFor();
 assert.match(await page.locator('#role').textContent(),/Read-only/);
 assert.match(await page.locator('#payment-rows').textContent(),/140.000000/);
 await page.locator('#agents progress').waitFor();
 assert.match(await page.locator('#agents').textContent(),/Gas allowance/);
 for(const button of await page.locator('[data-write]').all())assert.equal(await button.isDisabled(),true);
 // Manual lookups remain usable during an indexer outage.
 indexerDown=true;await page.locator('#history').click();
 await page.getByText(/Lists unavailable/).waitFor();
 await page.locator('#lookup select').selectOption('approver');
 await page.locator('#lookup input').fill(fixture.known.approver);
 await page.locator('#lookup button').click();
 await page.locator('#approvers code').getByText(fixture.known.approver,{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: overview, payment event, agent spend/gas allowance, disconnected write guards, indexer outage and manual lookup; no uncaught browser errors.');
}finally{await browser.close();}
