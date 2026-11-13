// Approver invite round trip in a browser with a stand-in wallet. The stand-in signs NEP-413 with a
// throwaway key made here, so the console's real signature check runs. No real wallet or transaction.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { serialize } from 'borsh';
const fixture=JSON.parse(readFileSync(new URL('./live-testnet.json',import.meta.url),'utf8'));
const BASE=process.env.CONSOLE_URL??'http://127.0.0.1:5174';
const approver=nacl.sign.keyPair(),approverPk='ed25519:'+bs58.encode(approver.publicKey),approverAccount='approver-test.testnet';
const owner='styx-owner-c87a.testnet';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
async function open(accountId,url,keyOnChain=true){
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('nodeSign',(message,nonceB64,recipient)=>{
  const bytes=serialize({struct:{tag:'u32',message:'string',nonce:{array:{type:'u8',len:32}},recipient:'string',callbackUrl:{option:'string'}}},
   {tag:2147484061,message,nonce:[...Buffer.from(nonceB64,'base64')],recipient,callbackUrl:null});
  return Buffer.from(nacl.sign.detached(createHash('sha256').update(bytes).digest(),approver.secretKey)).toString('base64');
 });
 await page.route('**/@near-wallet-selector_core.js?*',route=>route.fulfill({contentType:'application/javascript',body:`
  export async function setupWalletSelector(){
   const accounts=[{accountId:${JSON.stringify(accountId)},active:true}];
   return {store:{getState:()=>({accounts}),observable:{subscribe:fn=>{fn();return {unsubscribe(){}};}}},
    wallet:async()=>({id:'meteor-wallet',getAccounts:async()=>accounts,
     signMessage:async({message,nonce,recipient})=>({accountId:${JSON.stringify(accountId)},publicKey:${JSON.stringify(approverPk)},
      signature:await window.nodeSign(message,btoa(String.fromCharCode(...nonce)),recipient)})})};
  }` }));
 await page.route('https://api-testnet.nearblocks.io/**',route=>route.fulfill({status:403}));
 await page.route(fixture.rpc,async route=>{
  const q=route.request().postDataJSON(),p=q.params;let result;
  if(q.method==='status')result=fixture.status;
  else if(q.method==='query'){
   if(p.request_type==='view_access_key_list')result=fixture.accessKeys;
   else if(p.request_type==='view_access_key'){if(!keyOnChain) return route.fulfill({json:{error:{name:'HANDLER_ERROR',cause:{name:'UNKNOWN_ACCESS_KEY'}}}});result={nonce:1,permission:'FullAccess',block_height:1,block_hash:'mock'};}
   else if(p.request_type==='view_account')result={amount:'10000000000000000000000000',locked:'0',storage_usage:500,code_hash:'11111111111111111111111111111111',block_height:1,block_hash:'mock'};
   else{const args=JSON.parse(Buffer.from(p.args_base64,'base64').toString());result=structuredClone(fixture.views[p.account_id+':'+p.method_name+':'+JSON.stringify(args,Object.keys(args).sort())]);}
  }
  assert.ok(result,'Missing canned RPC result');await route.fulfill({json:{result}});
 });
 await page.goto(url);return {page,errors};
}
try{
 // 1. The approver opens the invite and signs once; the page gives a link back for the owner.
 const join=await open(approverAccount,`${BASE}/?join=${fixture.vault}&network=testnet`);
 await join.page.locator('#join-sign').click();
 const back=(await join.page.locator('#join-result pre').textContent()).trim();
 assert.match(back,new RegExp(`approver=${encodeURIComponent(approverPk).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
 assert.equal(await join.page.locator('#create').isHidden(),true);
 assert.equal(await join.page.locator('#join-result .setup-note a').getAttribute('href'),'https://t.me/Styx_pvt_bot?start=approver');
 assert.deepEqual(join.errors,[]);
 // 2. The owner opens the link: the signature is checked and the approver field is filled in.
 const own=await open(owner,back.replace(/^https?:\/\/[^/]+\/?/,BASE+'/'));
 await own.page.getByText(`Approver invite from ${approverAccount}`).waitFor();
 assert.equal(await own.page.locator('#setup-form input[name="approver"]').inputValue(),approverPk);
 assert.match(await own.page.locator('#setup-form').textContent(),/signature checked, and the key is on that account/);
 assert.deepEqual(own.errors,[]);
 // 3. A link whose signature was made for another vault is refused.
 const forged=back.replace(/^https?:\/\/[^/]+\/?/,BASE+'/').replace(/sig=[^&]+/,'sig='+encodeURIComponent(Buffer.alloc(64,7).toString('base64')));
 const bad=await open(owner,forged);
 await bad.page.getByText('Invite link did not check out').waitFor();
 assert.equal(await bad.page.locator('#setup-form input[name="approver"]').count()===0 || await bad.page.locator('#setup-form input[name="approver"]').inputValue()!==approverPk,true);
 console.log('PASS: approver signs once on the join page; owner link checks the NEP-413 signature and the key on chain, fills the approver; forged signature refused. No real wallet or transaction.');
}finally{await browser.close();}
