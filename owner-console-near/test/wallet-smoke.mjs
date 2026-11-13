// Browser-only wallet stand-in. No keys, real wallet API or signed transaction is used.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const fixture=JSON.parse(readFileSync(new URL('./live-testnet.json',import.meta.url),'utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 for(const accountId of ['stranger.testnet','styx-owner-c87a.testnet','member.testnet']){
  // member.testnet: the vault's owner is treated as a Sputnik DAO and this account proposes to it.
  const daoBond='100000000000000000000000';
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let paused=false;
  await page.route('**/@near-wallet-selector_core.js?*',route=>route.fulfill({contentType:'application/javascript',body:`
   export async function setupWalletSelector(){
    const accounts=[{accountId:${JSON.stringify(accountId)},active:true}];
    return {store:{getState:()=>({accounts}),observable:{subscribe:fn=>{fn();return {unsubscribe(){}};}}},
     wallet:async()=>({id:'meteor-wallet',getAccounts:async()=>accounts,signAndSendTransaction:async params=>{window.__submitted=params;return {transaction:{hash:'mock-owner-change'}};}})};
   }` }));
  await page.route('https://api-testnet.nearblocks.io/**',route=>route.fulfill({status:403}));
  await page.route('https://styx-relay-near.fly.dev/links/**',route=>route.fulfill({json:{publicKey:decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()),linked:true}}));
  await page.route(fixture.rpc,async route=>{
   const q=route.request().postDataJSON(),p=q.params;let result;
   if(q.method==='status')result=fixture.status;
  else if(q.method==='query'){
    if(p.request_type==='view_access_key_list')result=fixture.accessKeys;
    else if(p.request_type==='view_account')result={amount:'10000000000000000000000000',locked:'0',storage_usage:500,code_hash:'11111111111111111111111111111111',block_height:1,block_hash:'mock'};
    else{
     const args=JSON.parse(Buffer.from(p.args_base64,'base64').toString());
     result=structuredClone(fixture.views[p.account_id+':'+p.method_name+':'+JSON.stringify(args,Object.keys(args).sort())]);
     if(p.method_name==='get_policy') result=accountId==='member.testnet'?{result:[...Buffer.from(JSON.stringify({roles:[],proposal_bond:daoBond}))],logs:[],block_height:1,block_hash:'mock'}:undefined;
     if(!result && p.method_name.startsWith('get_')) result={result:[...Buffer.from('null')],logs:[],block_height:1,block_hash:'mock'}; // no entry, as the contract answers
     if(p.method_name==='get_agent'){const a=JSON.parse(Buffer.from(result.result).toString());a.valid_until='1600000000';result.result=[...Buffer.from(JSON.stringify(a))];}
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
   await page.locator('#agents .expiry.expired').first().waitFor();
   assert.equal(await page.getByRole('button',{name:'Renew for 30 days'}).count(),0);
  }else if(accountId==='member.testnet'){
   // A DAO owns the vault: the same change becomes one add_proposal to the DAO, with its bond.
   await page.getByText(/changes you make here are proposals its members vote on/).waitFor();
   await page.locator('#advanced > summary').click();
   await page.locator('form[data-method="pause"] button').click();
   await page.locator('#send').click();
   await page.waitForFunction(()=>window.__submitted);
   const p=await page.evaluate(()=>window.__submitted);
   assert.equal(p.signerId,'member.testnet');assert.equal(p.receiverId,'styx-owner-c87a.testnet');
   assert.equal(p.actions.length,1);assert.equal(p.actions[0].params.methodName,'add_proposal');assert.equal(p.actions[0].params.deposit,daoBond);
   const fc=p.actions[0].params.args.proposal.kind.FunctionCall;
   assert.equal(fc.receiver_id,fixture.vault);assert.deepEqual(fc.actions.map(a=>a.method_name),['pause']);
  }else{
   // An expired agent: the owner renews it with the same limits in one configure_agent.
   await page.locator('#agents .expiry.expired').first().waitFor();
   await page.getByRole('button',{name:'Renew for 30 days'}).first().click();
   const renew=JSON.parse((await page.locator('#preview').textContent()).slice((await page.locator('#preview').textContent()).indexOf('{')));
   assert.equal(renew.method,'configure_agent');assert.equal(renew.args.agent,fixture.known.agent);
   assert.equal(renew.args.per_payment_limit,'100000000');assert.equal(renew.args.daily_limit,'1000000000');
   assert.ok(Number(renew.args.valid_until)>Date.now()/1000+29*86400);
   await page.locator('#cancel').click();
   // Names: kept in this browser per vault, exported as a file, never sent anywhere.
   const agentPanel=page.locator('#agents article').filter({hasText:fixture.known.agent}).first();
   await agentPanel.getByRole('button',{name:'Name it'}).click();
   await agentPanel.locator('.name-row input').fill('Billing bot');
   await agentPanel.getByRole('button',{name:'Save'}).click();
   await agentPanel.locator('.name-row strong',{hasText:'Billing bot'}).waitFor();
   const [names]=await Promise.all([page.waitForEvent('download'),page.locator('#labels-export').click()]);
   assert.deepEqual(JSON.parse(readFileSync(await names.path(),'utf8')),{vault:fixture.vault,labels:{[fixture.known.agent]:'Billing bot'}});
   await page.reload();
   await page.locator('#agents article').filter({hasText:fixture.known.agent}).first().locator('.name-row strong',{hasText:'Billing bot'}).waitFor();
   await page.locator('#advanced > summary').click();
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
   // Guided setup: the rules step sends several vault calls as one transaction, one approval.
   await page.locator('#setup-steps button',{hasText:'Set the rules'}).click();
   const setup=page.locator('#setup-form');
   await setup.getByRole('button',{name:'Team'}).click();
   assert.equal(await setup.locator('input[name="per_payment_limit"]').inputValue(),'50');
   await setup.locator('input[name="limit"]').fill('500');
   await setup.locator('textarea[name="recipient"]').fill('vendor-a.styx-owner-c87a.testnet, Vendor A\nvendor-b.testnet');
   await setup.locator('input[name="agent"]').fill('');
   await setup.getByRole('button',{name:'Review and sign'}).click();
   assert.match(await page.locator('#preview').textContent(),/3 calls, one approval/);
   await page.evaluate(()=>{window.__submitted=undefined;});
   await page.locator('#send').click();
   await page.waitForFunction(()=>window.__submitted);
   const batch=await page.evaluate(()=>window.__submitted);
   assert.equal(batch.receiverId,fixture.vault);
   assert.deepEqual(batch.actions.map(a=>[a.params.methodName,a.params.args.recipient??null,a.params.gas]),[['set_vault_daily_limit',null,'30000000000000'],['set_recipient','vendor-a.styx-owner-c87a.testnet','30000000000000'],['set_recipient','vendor-b.testnet','30000000000000']]);
   assert.match(await page.locator('#setup-form').textContent(),/Styx_pvt_bot/);
   // With the indexer down, name the approver by hand; then every rule is done and the ready screen shows the hand-off.
   await page.locator('#lookup select').selectOption('approver');
   await page.locator('#lookup input').fill(fixture.known.approver);
   await page.locator('#lookup button').click();
   await page.locator('#setup-form').getByText('This vault is ready').waitFor();
   await page.locator('#approvers .tg-badge.on').first().waitFor();
   const ready=await page.locator('#setup-form').textContent();
   assert.match(ready,/Hand the agent its key/);assert.doesNotMatch(ready,/private_key/);
   const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download agent settings'}).click()]);
   assert.equal(file.suggestedFilename(),`styx-agent-${fixture.vault}.env`);
   const env=readFileSync(await file.path(),'utf8');
   assert.match(env,new RegExp(`^STYX_NEAR_APPROVER=${fixture.known.approver}$`,'m'));assert.doesNotMatch(env,/private/);
  }
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: non-owner write guards; mocked owner pause preview, exact wallet call, finality and chain state reread; setup rules and a pasted recipient list batched into one transaction, presets and agent hand-off shown; expired agent renewed with the same limits; a key named, exported and kept across a reload; approver shown as getting Telegram alerts; a change by a DAO member sent as one add_proposal. No real wallet or transaction.');
}finally{await browser.close();}
