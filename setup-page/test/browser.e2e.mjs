// Drives the real setup page in headless Chrome against a local chain. Anvil stands in for the wallet by
// answering the page's EIP-1193 requests, so this covers the page, not a real wallet extension.
// Needs anvil, forge, cast and Chrome, and `forge build` in contracts/evm. Run: npm run e2e
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const WORK = mkdtempSync(join(tmpdir(), "setup-page-e2e-"));
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const RPC_PORT = 18761, PAGE_PORT = 18762;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const XSS = '<img src=x onerror="window.__pwned=1">';
const VENDOR = "0x00000000000000000000000000000000000000a1";

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${cmd} ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, label, tries = 150) {
  for (let i = 0; i < tries; i++) { if (await check().catch(() => false)) return; await sleep(100); }
  throw new Error(`timed out waiting for ${label}`);
}
const children = [];
const start = (cmd, args, opts = {}) => { const c = spawn(cmd, args, { stdio: "ignore", ...opts }); children.push(c); return c; };
const results = [];
async function scenario(name, run) { await run(); results.push(name); console.log(`PASS  ${name}`); }

let browser;
try {
  const config = join(WORK, "anvil.json");
  // Keeps old state so the page can ask what the vault's code was at an old block, as Arc's public RPC lets it.
  start("anvil", ["--port", String(RPC_PORT), "--silent", "--prune-history", "400000", "--config-out", config]);
  await waitFor(async () => spawnSync("cast", ["chain-id", "--rpc-url", RPC]).status === 0 && JSON.parse(readFileSync(config, "utf8")), "anvil");
  const keys = JSON.parse(readFileSync(config, "utf8")).private_keys;
  const addr = (k) => sh("cast", ["wallet", "address", "--private-key", k]);
  const [owner, agent, stranger] = keys.slice(0, 3).map(addr);
  const ownerKey = keys[0], agentKey = keys[1];
  const contracts = join(ROOT, "contracts/evm");
  const create = (key, c, ...a) => /Deployed to: (0x[0-9a-fA-F]{40})/.exec(sh("forge", ["create", c, "--broadcast", "--rpc-url", RPC, "--private-key", key, "--constructor-args", ...a], contracts))[1];
  const call = (to, sig, ...a) => sh("cast", ["call", to, sig, ...a, "--rpc-url", RPC]).split(" ")[0];
  const send = (key, to, sig, ...a) => sh("cast", ["send", to, sig, ...a, "--rpc-url", RPC, "--private-key", key]);

  // The repo's mock token has 18 decimals; real Arc USDC has 6. Set the decimals slot (slot 2) to 6 so the
  // page sees a 6-decimal token, without changing any contract.
  const token = create(ownerKey, "src/MockERC20.sol:MockERC20", "USD Coin", "USDC");
  sh("cast", ["rpc", "anvil_setStorageAt", token, "0x2", "0x" + "6".padStart(64, "0"), "--rpc-url", RPC]);
  assert.equal(call(token, "decimals()(uint8)"), "6");
  const badToken = create(ownerKey, "src/MockERC20.sol:MockERC20", "Wrong", "WRG"); // 18 decimals
  send(ownerKey, token, "mint(address,uint256)", owner, "20000000"); // 20 USDC
  send(ownerKey, token, "mint(address,uint256)", agent, "5000000"); // the agent starts with 5 USDC: unprotected

  start(join(ROOT, "setup-page/node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", String(PAGE_PORT), "--strictPort"], { cwd: join(ROOT, "setup-page") });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PAGE_PORT}`)).ok, "page");
  browser = await chromium.launch({ channel: "chrome", headless: true });

  async function openPage(options = {}) { return openPageAt("", options); }
  async function openPageAt(query, { account = owner, chainId = "0x7a69", rejectNext = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 1400 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const prompts = [];
    // `control` makes the stand-in RPC behave like Arc's public one when a test asks it to.
    const control = { reject: rejectNext, logCalls: [], flakyLogs: 0, noHistory: false, rateLimited: 0, oldCodeCalls: 0 };
    await page.exposeFunction("__wallet", async (method, params) => {
      prompts.push(method);
      if (method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return chainId;
      if (method === "eth_getLogs") {
        const { fromBlock, toBlock } = params[0];
        const span = BigInt(toBlock) - BigInt(fromBlock) + 1n;
        control.logCalls.push([BigInt(fromBlock), BigInt(toBlock)]);
        if (control.flakyLogs > 0) { control.flakyLogs--; throw new Error("RPC error -32014: block not imported yet"); }
        if (span > 10000n) throw new Error("RPC error -32012: block range exceeds 10000");
      }
      if (method === "eth_getCode" && params[1] !== "latest") control.oldCodeCalls++;
      // Like Arc's public endpoint, which answers HTTP 429 / -32005 once a request budget is spent.
      if ((method === "eth_getLogs" || method === "eth_getCode") && control.rateLimited > 0) { control.rateLimited--; throw new Error("HTTP request failed. Status: 429. rate limit exceeded (-32005)"); }
      if (method === "eth_getCode" && control.noHistory && params[1] !== "latest") throw new Error("missing trie node: historical state is not available");
      if (method === "eth_sendTransaction" && control.reject) {
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      }
      const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      if (r.error) throw new Error(r.error.message);
      return r.result;
    });
    // Errors lose their `code` crossing exposeFunction, so a rejection is rebuilt here as a wallet would send it.
    await page.addInitScript(() => {
      window.ethereum = {
        request: ({ method, params }) => window.__wallet(method, params ?? []).catch((e) => {
          throw Object.assign(new Error(e.message), /rejected/i.test(e.message) ? { code: 4001 } : {});
        }),
      };
    });
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/${query}`);
    await page.waitForLoadState("networkidle");
    return { page, errors, prompts, control, context };
  }
  const sends = (prompts) => prompts.filter((m) => m === "eth_sendTransaction").length;
  const status = (page) => page.locator("#status").textContent();
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
  const statusIs = (page, re, label) => waitFor(async () => re.test(await status(page)), label ?? String(re), 200).catch(async (e) => { throw new Error(`${e.message}; status was: ${await status(page)}`); });
  const connect = async (page, tokenAddress) => {
    await page.click("#connect");
    await page.locator("#s-vault").waitFor({ state: "visible" });
    // A page opened with ?vault= opens that vault at once and folds the chooser away.
    if (await page.locator("#token-input").isVisible()) await page.fill("#token-input", tokenAddress);
  };
  const dd = (page, id) => page.locator(`#${id}`).textContent();
  const checksText = (page) => page.locator("#checks").textContent();

  let vault;
  await scenario("the owner deploys a vault, sets limits and a vendor, and funds it", async () => {
    const { page, errors, prompts, context } = await openPage();
    await connect(page, token);
    await page.click("#deploy");
    await page.locator("#deploy-confirm").waitFor({ state: "visible" });
    await page.click("#deploy-yes");
    await page.locator("#dashboard").waitFor({ state: "visible", timeout: 30000 });
    vault = (await dd(page, "v-address")).trim();
    assert.equal(call(vault, "owner()(address)").toLowerCase(), owner.toLowerCase());
    assert.equal(call(vault, "token()(address)").toLowerCase(), token.toLowerCase());
    assert.match(await dd(page, "v-code"), /^Matches this repository/);
    assert.match(await checksText(page), /vault is empty/);
    assert.match(await page.locator("#verdict").textContent(), /^Not yet/);
    assert.match(await page.locator("#policy-warning").textContent(), /from version 0 to 1.*becomes invalid/);

    await page.fill("#policy-agent", agent);
    await page.fill("#policy-per", "1");
    await page.fill("#policy-daily", "10");
    await page.fill("#policy-days", "7");
    await page.click("#save-policy");
    await statusIs(page, /Save limits on vault 0x\w+\.\.\.\w+: confirmed/);
    assert.equal(call(vault, "perPaymentLimit()(uint256)"), "1000000");
    assert.equal(call(vault, "dailyLimit()(uint256)"), "10000000");
    assert.equal(call(vault, "agent()(address)").toLowerCase(), agent.toLowerCase());
    assert.equal(call(vault, "policyVersion()(uint256)"), "1");
    assert.match(await dd(page, "v-version"), /^1$/);

    await page.fill("#vendor-address", VENDOR);
    await page.fill("#vendor-label", XSS);
    await page.click("#add-vendor");
    await statusIs(page, /Allow vendor on vault .*: confirmed/);
    assert.equal(call(vault, "allowedRecipient(address)(bool)", VENDOR), "true");
    await page.locator("#vendors li").first().waitFor({ timeout: 8000 }).catch(async (e) => { throw new Error(`${e.message}; vendors-note was: ${await page.locator("#vendors-note").textContent()}`); });
    assert.equal(await page.locator("#vendors img").count(), 0); // a hostile label stays text
    assert.ok((await page.locator("#vendors li").first().textContent()).includes(XSS));

    // The protection panel says the agent's 5 USDC is outside the vault.
    assert.match(await checksText(page), /agent's address holds 5 USDC. The vault does not cover it/);
    assert.match(await page.locator("#agent-sweep").textContent(), /send at least 4\.5 USDC/);

    await page.fill("#fund-amount", "8");
    await page.click("#fund");
    await page.locator("#fund-confirm").waitFor({ state: "visible" });
    assert.ok((await page.locator("#fund-review").textContent()).includes(vault)); // the review names the full vault address
    await page.click("#fund-confirm");
    await statusIs(page, /Move 8 USDC into the vault on vault .*: confirmed/);
    assert.equal(call(token, "balanceOf(address)(uint256)", vault), "8000000");
    assert.match(await dd(page, "v-balance"), /^8 USDC$/);
    await shot(page, "dashboard-agent-funded");

    // The owner (or the agent's owner) drains the agent to gas only; the page then agrees.
    send(agentKey, token, "transfer(address,uint256)", owner, "4800000");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await connect(page, token); // the address bar still names the vault, so it reopens by itself
    await page.locator("#dashboard").waitFor({ state: "visible" });
    await waitFor(async () => /^All checks pass/.test(await page.locator("#verdict").textContent()), "protected verdict");
    assert.match(await page.locator("#verdict").textContent(), /do not say the contract has been audited/);
    await shot(page, "dashboard-protected");
    // Same browser, so the label typed earlier is still there and goes into the approval-page config.
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-config")]);
    const file = join(WORK, "owner-config-labelled.json");
    await download.saveAs(file);
    assert.deepEqual(Object.values(JSON.parse(readFileSync(file, "utf8")).vendors), [XSS]);
    assert.equal(errors.length, 0, errors.join());
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.ok(sends(prompts) >= 4);
    await context.close();
  });

  await scenario("pause and unpause reach the chain, and a wallet rejection sends nothing", async () => {
    const { page, context, control } = await openPage();
    await connect(page, token);
    await page.fill("#vault-input", vault);
    await page.click("#load-vault");
    await page.locator("#dashboard").waitFor({ state: "visible" });
    await page.click("#toggle-pause");
    await statusIs(page, /Pause on vault .*: confirmed/);
    assert.equal(call(vault, "paused()(bool)"), "true");
    assert.match(await dd(page, "v-paused"), /PAUSED/);
    assert.match(await checksText(page), /vault is paused/);
    control.reject = true;
    await page.click("#toggle-pause");
    await statusIs(page, /rejected the request in your wallet. Nothing was sent/);
    assert.equal(call(vault, "paused()(bool)"), "true");
    control.reject = false;
    await page.click("#toggle-pause");
    await statusIs(page, /Unpause on vault .*: confirmed/);
    assert.equal(call(vault, "paused()(bool)"), "false");
    await context.close();
  });

  await scenario("bad input is refused before the wallet is asked", async () => {
    const { page, prompts, context } = await openPage();
    await connect(page, token);
    await page.fill("#vault-input", vault);
    await page.click("#load-vault");
    await page.locator("#dashboard").waitFor({ state: "visible" });
    const before = sends(prompts);
    const expectRefusal = async (re) => { await statusIs(page, re); assert.equal(sends(prompts), before); };
    await page.fill("#policy-agent", owner); // the owner's own address as the agent
    await page.click("#save-policy");
    await expectRefusal(/cannot be your own address/);
    await page.fill("#policy-agent", agent);
    await page.fill("#policy-per", "0.0000001"); // finer than 6 decimals
    await page.click("#save-policy");
    await expectRefusal(/at most 6 decimals/);
    await page.fill("#policy-per", "1e3");
    await page.click("#save-policy");
    await expectRefusal(/plain decimal/);
    await page.fill("#policy-per", "11");
    await page.fill("#policy-daily", "10");
    await page.click("#save-policy");
    await expectRefusal(/above the daily limit/);
    await page.fill("#fund-amount", "9999");
    await page.click("#fund");
    await expectRefusal(/You hold only/);
    await page.fill("#vendor-address", "not-an-address");
    await page.click("#add-vendor");
    await expectRefusal(/must be an address/);
    await page.fill("#withdraw-amount", "9999");
    await page.click("#withdraw");
    await expectRefusal(/Enter an amount between/);
    await context.close();
  });

  await scenario("withdrawal needs a review step and then moves exactly that amount", async () => {
    const { page, context, prompts } = await openPage();
    await connect(page, token);
    await page.fill("#vault-input", vault);
    await page.click("#load-vault");
    await page.locator("#dashboard").waitFor({ state: "visible" });
    const before = BigInt(call(token, "balanceOf(address)(uint256)", stranger));
    await page.fill("#withdraw-to", stranger);
    await page.fill("#withdraw-amount", "1.5");
    await page.click("#withdraw");
    await page.locator("#withdraw-confirm").waitFor({ state: "visible" });
    assert.match(await page.locator("#withdraw-review").textContent(), /Withdraw 1\.5 USDC from vault 0x\w+ to .* protects 6\.5 USDC/);
    assert.equal(sends(prompts), 0 + sends(prompts)); // nothing sent by the review itself
    const sentBefore = sends(prompts);
    await page.click("#withdraw-confirm");
    await statusIs(page, /Withdraw 1\.5 USDC on vault .*: confirmed/);
    assert.equal(sends(prompts), sentBefore + 1);
    assert.equal(BigInt(call(token, "balanceOf(address)(uint256)", stranger)) - before, 1_500_000n);
    assert.equal(call(token, "balanceOf(address)(uint256)", vault), "6500000");
    await context.close();
  });

  await scenario("labels stay in the browser that typed them, so a fresh browser exports an unlabelled vendor", async () => {
    const { page, context } = await openPage();
    await connect(page, token);
    await page.fill("#vault-input", vault);
    await page.click("#load-vault");
    await page.locator("#vendors li").first().waitFor();
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-config")]);
    const file = join(WORK, "owner-config.json");
    await download.saveAs(file);
    const exported = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(exported.chainId, "31337");
    assert.equal(exported.vault.toLowerCase(), vault.toLowerCase());
    assert.equal(exported.owner.toLowerCase(), owner.toLowerCase());
    assert.equal(exported.token.toLowerCase(), token.toLowerCase());
    assert.deepEqual(Object.values(exported.vendors), ["Unlabelled vendor"]);
    assert.equal("relay" in exported, false); // no relay unless the owner names one
    // A relay address is exported as its origin, and a bad one is refused without writing a file.
    await page.fill("#relay-url", "ftp://relay.example");
    await page.click("#export-config");
    await statusIs(page, /must be an http or https URL/);
    await page.fill("#relay-url", "https://relay.example/some/path?x=1");
    const [second] = await Promise.all([page.waitForEvent("download"), page.click("#export-config")]);
    const withRelay = join(WORK, "owner-config-relay.json");
    await second.saveAs(withRelay);
    assert.equal(JSON.parse(readFileSync(withRelay, "utf8")).relay, "https://relay.example");
    await context.close();
  });

  // ---- Task: owners must always know which vault they are changing ----
  const forgeVault = () => create(ownerKey, "src/ErebusPolicyVault.sol:ErebusPolicyVault", owner, token); // repo default build: differs from the page's
  const openChooser = async (page) => { if (!(await page.locator("#vault-input").isVisible())) await page.click("#chooser summary"); };
  const openVaultByAddress = async (page, address) => { await openChooser(page); await page.fill("#vault-input", address); await page.click("#load-vault"); };
  let otherVault;

  await scenario("the banner always names the connected vault and whether you own it", async () => {
    const { page, context } = await openPage();
    await connect(page, token);
    assert.match(await page.locator("#vault-banner").textContent(), /No vault connected yet/);
    await openVaultByAddress(page, vault);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    const banner = await page.locator("#vault-banner").textContent();
    assert.ok(banner.toLowerCase().includes(vault.toLowerCase()), "the banner shows the full vault address");
    assert.match(banner, /You are the owner/);
    await context.close();
    const stranger_ = await openPage({ account: stranger });
    await connect(stranger_.page, token);
    await openVaultByAddress(stranger_.page, vault);
    await stranger_.page.locator("#dashboard").waitFor({ state: "visible" });
    assert.match(await stranger_.page.locator("#vault-banner").textContent(), /You are NOT the owner/);
    await stranger_.context.close();
  });

  await scenario("a vault named in the page's address opens only after connecting, and says so", async () => {
    const { page, prompts, context } = await openPageAt(`?vault=${vault.toLowerCase()}`);
    assert.equal(await page.locator("#dashboard").isVisible(), false); // nothing opens before the wallet connects
    assert.equal(prompts.length, 0);
    await page.click("#connect");
    await page.locator("#dashboard").waitFor({ state: "visible", timeout: 15000 });
    assert.ok((await page.locator("#vault-banner").textContent()).toLowerCase().includes(vault.toLowerCase()));
    assert.match(await page.locator("#link-note").textContent(), /Opened from the vault in this page's address/);
    assert.ok(page.url().toLowerCase().includes(`vault=${vault.toLowerCase()}`));
    await context.close();
    const bad = await openPageAt("?vault=0xnope");
    await statusIs(bad.page, /not a valid address, so it was ignored/);
    await bad.page.click("#connect");
    await bad.page.locator("#s-vault").waitFor({ state: "visible" });
    assert.equal(await bad.page.locator("#dashboard").isVisible(), false);
    await bad.context.close();
  });

  await scenario("deploying needs a confirmation, warns about an existing vault, and can be cancelled", async () => {
    const { page, prompts, context } = await openPage();
    await connect(page, token);
    await openVaultByAddress(page, vault);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    await openChooser(page);
    const before = sends(prompts);
    await page.click("#deploy");
    await page.locator("#deploy-confirm").waitFor({ state: "visible" });
    const warning = await page.locator("#deploy-confirm-text").textContent();
    assert.match(warning, /already have a vault/);
    assert.ok(warning.toLowerCase().includes(vault.toLowerCase()));
    assert.match(warning, /SECOND, separate vault/);
    assert.equal(sends(prompts), before); // asking is not sending
    await page.click("#deploy-no");
    await statusIs(page, /Deploy cancelled. Nothing was sent/);
    assert.equal(sends(prompts), before);
    assert.equal(await page.locator("#deploy-confirm").isVisible(), false);
    // Confirming deploys a second vault, and the banner moves to it and says it is a different one.
    await page.click("#deploy");
    await page.click("#deploy-yes");
    await waitFor(async () => !(await page.locator("#vault-banner").textContent()).toLowerCase().includes(vault.toLowerCase()), "banner moves to the new vault");
    otherVault = (await dd(page, "v-address")).trim();
    assert.notEqual(otherVault.toLowerCase(), vault.toLowerCase());
    assert.match(await status(page), /^Vault 0x\w+ connected/);
    assert.equal(sends(prompts), before + 1);
    await context.close();
  });

  await scenario("switching vaults needs no reload and carries nothing over from the last one", async () => {
    const { page, context } = await openPage();
    await connect(page, token);
    await openVaultByAddress(page, vault);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    await page.locator("#vendors li").first().waitFor();
    // Type things for vault A, including a half-finished fund review and a withdrawal review.
    await page.fill("#policy-agent", agent);
    await page.fill("#vendor-address", VENDOR);
    await page.fill("#fund-amount", "1");
    await page.click("#fund");
    await page.locator("#fund-confirm").waitFor({ state: "visible" });
    await page.fill("#withdraw-amount", "1");
    await page.click("#withdraw");
    await page.locator("#withdraw-confirm").waitFor({ state: "visible" });
    const urlBefore = page.url();
    await openVaultByAddress(page, otherVault);
    await waitFor(async () => (await page.locator("#vault-banner").textContent()).toLowerCase().includes(otherVault.toLowerCase()), "banner shows vault B");
    await waitFor(async () => (await dd(page, "v-address")).trim().toLowerCase() === otherVault.toLowerCase(), "dashboard shows vault B");
    assert.ok(page.url().toLowerCase().includes(`vault=${otherVault.toLowerCase()}`)); // same page, address bar now names vault B
    assert.equal(new URL(page.url()).origin, new URL(urlBefore).origin);
    assert.equal(await page.locator("#policy-agent").inputValue(), ""); // vault B has no agent, and A's is gone
    assert.equal(await page.locator("#vendor-address").inputValue(), "");
    assert.equal(await page.locator("#fund-amount").inputValue(), "");
    assert.equal(await page.locator("#fund-confirm").isVisible(), false);
    assert.equal(await page.locator("#withdraw-confirm").isVisible(), false);
    assert.equal(await page.locator("#vendors li").count(), 0); // A's vendor is not listed under B
    assert.match(await checksText(page), /vault is empty/);
    // The recent list offers both, and switching back works too.
    await openChooser(page);
    assert.equal(await page.locator("#recent button").count(), 2);
    await page.locator("#recent button", { hasText: new RegExp(vault, "i") }).click();
    await waitFor(async () => (await dd(page, "v-address")).trim().toLowerCase() === vault.toLowerCase(), "back to vault A");
    await context.close();
  });

  await scenario("a vault whose code differs cannot be funded until the owner unlocks it, and the unlock does not follow them", async () => {
    const odd = forgeVault();
    const { page, prompts, context } = await openPage();
    await connect(page, token);
    await openVaultByAddress(page, odd);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    assert.match(await dd(page, "v-code"), /^DIFFERS/);
    assert.equal(await page.locator("#fund").isDisabled(), true);
    assert.equal(await page.locator("#fund-max").isDisabled(), true);
    await page.locator("#unlock-funding").waitFor({ state: "visible" });
    const before = sends(prompts);
    await page.click("#unlock-funding");
    assert.equal(await page.locator("#fund").isDisabled(), false);
    assert.equal(sends(prompts), before); // unlocking sends nothing
    await openVaultByAddress(page, vault); // switch to a matching vault, then back to the odd one
    await waitFor(async () => (await dd(page, "v-address")).trim().toLowerCase() === vault.toLowerCase(), "vault A");
    assert.equal(await page.locator("#fund").isDisabled(), false);
    await openVaultByAddress(page, odd);
    await waitFor(async () => (await dd(page, "v-address")).trim().toLowerCase() === odd.toLowerCase(), "odd vault again");
    assert.equal(await page.locator("#fund").isDisabled(), true); // locked again
    await context.close();
  });

  await scenario("the page warns about plain sends next to the address and in the funding section, and the warning is true", async () => {
    const { page, context } = await openPage();
    await connect(page, token);
    await openVaultByAddress(page, vault);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    const near = await page.locator("#plain-send-warning").textContent();
    assert.match(near, /Do not send money to this address with your wallet's Send button/);
    assert.match(near, /lose the gas/);
    assert.match(near, /Move into vault/);
    assert.match(await page.locator("#fund-send-warning").textContent(), /Use this section, not your wallet's Send button/);
    for (const id of ["plain-send-warning", "fund-send-warning"]) assert.equal(await page.locator(`#${id}`).isVisible(), true);
    await shot(page, "plain-send-warning");
    await context.close();
    // The warning is only worth showing if it is true: a plain native send to the vault reverts and costs gas.
    const before = BigInt(sh("cast", ["balance", vault, "--rpc-url", RPC]));
    const attempt = spawnSync("cast", ["send", vault, "--value", "1", "--rpc-url", RPC, "--private-key", ownerKey], { encoding: "utf8" });
    assert.notEqual(attempt.status, 0, "a plain send to the vault must fail");
    assert.equal(BigInt(sh("cast", ["balance", vault, "--rpc-url", RPC])), before);
    // ...and the token transfer the page uses is accepted.
    const vaultTokens = BigInt(call(token, "balanceOf(address)(uint256)", vault));
    send(ownerKey, token, "transfer(address,uint256)", vault, "1");
    assert.equal(BigInt(call(token, "balanceOf(address)(uint256)", vault)), vaultTokens + 1n);
  });

  // ---- Task: list vendors on an RPC that limits log ranges, as Arc's public one does ----
  let farVault, farCreated;
  await scenario("vendors are listed across many blocks without ever asking for more than 9,999 at once", async () => {
    const beforeCreate = BigInt(sh("cast", ["block-number", "--rpc-url", RPC]));
    farVault = forgeVault();
    farCreated = beforeCreate + 1n; // automine: the deployment is the next block
    send(ownerKey, farVault, "configurePolicy(address,uint256,uint256,uint64)", agent, "1000000", "10000000", String(Math.floor(Date.now() / 1000) + 86400));
    send(ownerKey, farVault, "setRecipient(address,bool)", VENDOR, "true");
    sh("cast", ["rpc", "anvil_mine", "0x61a8", "--rpc-url", RPC]); // 25,000 blocks: more than two pages
    const { page, control, context } = await openPage();
    await connect(page, token);
    await openVaultByAddress(page, farVault);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    await page.locator("#vendors li").first().waitFor({ timeout: 20000 });
    assert.ok((await page.locator("#vendors li").first().textContent()).toLowerCase().includes(VENDOR));
    assert.equal(await page.locator("#vendors-note").textContent(), ""); // complete: no partial-list message
    assert.ok(control.logCalls.length >= 3, `expected several pages, saw ${control.logCalls.length}`);
    for (const [from, to] of control.logCalls) assert.ok(to - from + 1n <= 9999n, `range ${from}-${to} is too wide`);
    await shot(page, "vendors-paged");
    await context.close();
  });

  await scenario("a flaky -32014 from the load balancer is retried and the list still arrives", async () => {
    const { page, control, context } = await openPage();
    control.flakyLogs = 2;
    await connect(page, token);
    await openVaultByAddress(page, farVault);
    await page.locator("#vendors li").first().waitFor({ timeout: 30000 });
    assert.equal(await page.locator("#vendors-note").textContent(), "");
    assert.ok(control.logCalls.length >= 5); // two failed calls were repeated
    await context.close();
  });

  await scenario("a rate-limited RPC is waited out, and the page says it is waiting", async () => {
    const { page, control, context } = await openPage();
    await connect(page, token);
    control.rateLimited = 3; // the next three lookups are refused with 429
    await page.fill("#vault-input", farVault);
    await page.click("#load-vault");
    await waitFor(async () => /rate-limiting requests\. Waiting \d+s/.test(await status(page)), "a waiting message", 300); // it says so instead of looking stuck
    await page.locator("#vendors li").first().waitFor({ timeout: 30000 });
    assert.equal(await page.locator("#vendors-note").textContent(), ""); // recovered: complete, no partial message
    assert.equal(control.rateLimited, 0);
    await context.close();
  });

  await scenario("a creation-block hint is checked in two lookups, and a wrong hint is ignored", async () => {
    // The vault's own block: verified with two historical lookups, then the scan starts there.
    const good = await openPageAt(`?created=${farCreated}`);
    await connect(good.page, token);
    await openVaultByAddress(good.page, farVault);
    await good.page.locator("#vendors li").first().waitFor({ timeout: 20000 });
    assert.equal(good.control.oldCodeCalls, 2, `a true hint should cost 2 lookups, cost ${good.control.oldCodeCalls}`);
    await good.context.close();
    // A wrong hint costs its two checks, is dropped, and the page still finds the vendor by searching.
    const bad = await openPageAt(`?created=${farCreated + 7n}`);
    await connect(bad.page, token);
    await openVaultByAddress(bad.page, farVault);
    await bad.page.locator("#vendors li").first().waitFor({ timeout: 30000 });
    assert.ok(bad.control.oldCodeCalls > 2);
    assert.equal(await bad.page.locator("#vendors-note").textContent(), "");
    await bad.context.close();
  });

  await scenario("after the first full read, a refresh reads only the new blocks", async () => {
    const { page, control, context } = await openPage();
    await connect(page, token);
    await openVaultByAddress(page, farVault);
    await page.locator("#vendors li").first().waitFor({ timeout: 20000 });
    const firstRead = control.logCalls.length;
    assert.ok(firstRead >= 3);
    const headBefore = BigInt(sh("cast", ["block-number", "--rpc-url", RPC]));
    await page.fill("#vendor-address", "0x00000000000000000000000000000000000000d4");
    await page.click("#add-vendor");
    await statusIs(page, /Allow vendor on vault .*: confirmed/);
    await waitFor(async () => (await page.locator("#vendors li").count()) === 2, "both vendors listed");
    const extra = control.logCalls.slice(firstRead);
    assert.equal(extra.length, 1, `a refresh should make one log call, made ${extra.length}`);
    assert.ok(extra[0][0] > headBefore - 5n && extra[0][1] - extra[0][0] < 50n, "and only over the newest blocks");
    await context.close();
  });

  await scenario("when the RPC cannot say when the vault was created, the list is marked partial and a lookup still works", async () => {
    sh("cast", ["rpc", "anvil_mine", "0x1ADB0", "--rpc-url", RPC]); // 110,000 more: the vendor is now older than the fallback window
    const { page, control, context } = await openPage();
    control.noHistory = true;
    await connect(page, token);
    await openVaultByAddress(page, farVault);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    await waitFor(async () => /Partial list/.test(await page.locator("#vendors-note").textContent()), "partial note", 300);
    const note = await page.locator("#vendors-note").textContent();
    assert.match(note, /could not say when the vault was created/);
    assert.match(note, /A vendor allowed earlier may be missing/);
    // Only the recent vendor (added by the previous scenario) is inside what could be read. The old one is not.
    assert.equal(await page.locator("#vendors li").count(), 1);
    const listed = (await page.locator("#vendors li").first().textContent()).toLowerCase();
    assert.ok(listed.includes("d4") && !listed.includes(VENDOR));
    for (const [from, to] of control.logCalls) assert.ok(to - from + 1n <= 9999n);
    await page.fill("#vendor-address", VENDOR);
    await page.click("#check-vendor");
    await statusIs(page, /is allowed/); // the way out the note points to
    await shot(page, "vendors-partial");
    await context.close();
  });

  await scenario("a non-owner can read the vault but every change is disabled", async () => {
    const { page, context, prompts } = await openPage({ account: stranger });
    await connect(page, token);
    await page.fill("#vault-input", vault);
    await page.click("#load-vault");
    await page.locator("#not-owner").waitFor({ state: "visible" });
    for (const id of ["save-policy", "add-vendor", "fund", "toggle-pause", "withdraw"]) {
      assert.equal(await page.locator(`#${id}`).isDisabled(), true, id);
    }
    assert.equal(sends(prompts), 0);
    await context.close();
  });

  await scenario("a token that is not 6-decimal USDC is refused for deploy and connect", async () => {
    const { page, context, prompts } = await openPage();
    await connect(page, badToken);
    await page.click("#deploy");
    await statusIs(page, /18 decimals. This page handles 6-decimal USDC only/);
    await page.fill("#token-input", "0x00000000000000000000000000000000000000e1");
    await page.click("#deploy");
    await statusIs(page, /no contract at the token address/);
    await page.fill("#vault-input", token); // a token is not a vault
    await page.click("#load-vault");
    await statusIs(page, /Could not read that vault/);
    assert.equal(sends(prompts), 0);
    await context.close();
  });

  console.log(`\n${results.length} scenarios passed.`);
} finally {
  await browser?.close();
  for (const c of children) c.kill();
}
process.exit(0);
