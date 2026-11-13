import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const live=JSON.parse(readFileSync(new URL('./vault-v2.json',import.meta.url),'utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 for(const failure of [null,'get_evm_chain','evm_payment_hash','changed-token-on-recheck','changed-token-on-redirect']){
  const page=await browser.newPage(),errors=[],methods=[];let chainReads=0;
  page.on('pageerror',e=>errors.push(e.message));
  // This request is historical and consumed. The frozen clock tests its UI shape only.
  await page.clock.install({time:new Date((Number(live.pending.authorization.authorization_expiry)-60)*1000)});
  await page.route('https://relay.example/**',r=>r.fulfill({json:{pending:live.pending,status:'pending'}}));
  // The page reads through its own testnet RPC (review.ts PAGE_RPC), not the request's.
  await page.route('https://test.rpc.fastnear.com/',async route=>{
   const q=route.request().postDataJSON(),method=q.params.method_name;methods.push(method);
   const captured=live.views[method];assert.ok(captured,`Unexpected view: ${method}`);
   assert.deepEqual(JSON.parse(Buffer.from(q.params.args_base64,'base64').toString()),captured.args);
   const result=structuredClone(captured.result);
   if(method==='get_evm_chain')chainReads++;
   if(failure==='changed-token-on-recheck' && method==='get_evm_chain' && chainReads>1){
    const value=JSON.parse(Buffer.from(result.result).toString());result.result=[...Buffer.from(JSON.stringify({...value,token:'0x'+'1'.repeat(40)}))];
   }
   if(method===failure){
    const value=JSON.parse(Buffer.from(result.result).toString());
    result.result=[...Buffer.from(JSON.stringify(method==='get_evm_chain'?{...value,enabled:false}:'wrong hash'))];
   }
   await route.fulfill({json:{jsonrpc:'2.0',id:q.id,result}});
  });
  let target=(process.env.APPROVAL_URL??'http://127.0.0.1:5178')+'/?relay=https://relay.example&request='+'a'.repeat(43);
  if(failure==='changed-token-on-redirect'){
   await page.addInitScript(saved=>sessionStorage.setItem('styx-near-sign',JSON.stringify(saved)),{endpoint:'https://relay.example/requests/'+'a'.repeat(43),nonce:live.pending.authorization.approval_nonce,callback:target,state:'redirect-check',evmToken:'0x'+'1'.repeat(40)});
   target+='#'+new URLSearchParams({signature:live.signature.signature,accountId:live.signature.accountId,publicKey:live.signature.publicKey,state:'redirect-check'});
  }
  await page.goto(target);
  if(failure==='changed-token-on-recheck'){
   await page.locator('#sign').waitFor({state:'visible'});await page.locator('#sign').click();
   await page.getByText('EVM token configuration changed. Reload and review the destination again.',{exact:true}).waitFor();
   assert.equal(await page.locator('#sign').isVisible(),false);
  }else if(failure==='changed-token-on-redirect'){
   await page.getByText('EVM token configuration changed. Reload and review the destination again.',{exact:true}).waitFor();
   assert.equal(await page.locator('#sign').isVisible(),false);
  }else if(failure){
   await page.getByText(failure==='get_evm_chain'?'EVM chain disabled or missing':'Payment hash differs',{exact:true}).waitFor();
   assert.equal(await page.locator('#sign').isVisible(),false);
  }else{
   await page.locator('#sign').waitFor({state:'visible'});
   const shown=await page.locator('#details').textContent();
   const chain=JSON.parse(Buffer.from(live.views.get_evm_chain.result.result).toString());
   assert.ok(shown.includes('EVM chain id: 5042002'));assert.ok(shown.includes(chain.token));assert.ok(shown.includes(live.pending.payment.recipient));
   assert.ok(!shown.includes(live.pending.token));
  }
  assert.ok(methods.includes('evm_payment_hash'));assert.ok(methods.includes('get_evm_recipient'));assert.ok(methods.includes('get_evm_chain'));
  assert.ok(!methods.includes('payment_hash'));assert.ok(!methods.includes('get_recipient'));assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: v2 EVM chain/token/recipient rendered; disabled chain, changed hash and token changes on recheck block signing. Frozen historical fixture, mocked RPC/relay, no real wallet.');
}finally{await browser.close();}
