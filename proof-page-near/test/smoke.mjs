import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const fixture=JSON.parse(readFileSync(new URL('./pause.json',import.meta.url),'utf8'));
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:5193,strictPort:true},logLevel:'error'});
await server.listen();
let browser;
try {
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',async route=>{
  const q=route.request().postDataJSON(),url=route.request().url();let data;
  if(url.includes('/v0/account')) data={account_txs:q.max_block_height===null?[{transaction_hash:'pause-tx',tx_block_height:5}]:[]};
  else if(url.includes('/v0/transactions'))data={transactions:[{transaction:{hash:'pause-tx',signer_id:'sentinel.testnet'}}]};
  else if(q.method==='tx')data={result:fixture};
  else if(q.method==='block')data={result:{header:{timestamp_nanosec:'10500000000'}}};
  else throw new Error('Unexpected network request '+url);
  await route.fulfill({json:data});
 });
 await page.goto('http://127.0.0.1:5193/?vault=lambda.styx-vaults.testnet');
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('1 confirmed events'));
 assert.match(await page.locator('#timeline').textContent(),/<b>too many payments<\/b> & slow/);
 assert.equal(await page.locator('#timeline b').count(),0);
 assert.match(await page.locator('#timeline').textContent(),/0 payments settled before it/);
 assert.match(await page.locator('#summary').textContent(),/1 sentinel pause/);
 assert.match(await page.locator('#summary td').nth(2).textContent(),/<b>too many payments<\/b> & slow/);
 assert.equal(await page.locator('#summary b').count(),0);
 assert.equal(await page.locator('#timeline a').getAttribute('href'),'https://testnet.nearblocks.io/txns/pause-tx');
 assert.deepEqual(errors,[]);
 await page.setViewportSize({width:375,height:812});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 console.log('Proof browser smoke passed (mocked chain; no wallet or writes).');
} finally {await browser?.close();await server.close();}
