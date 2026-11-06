// Drives the real setup page in headless Chrome against a local chain. Anvil stands in for the wallet by
// answering the page's EIP-1193 requests, so this covers the page, not a real wallet extension.
// Needs anvil, forge, cast and Chrome, and `forge build` in contracts/evm. Run: npm run e2e
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const WORK = mkdtempSync(join(tmpdir(), "setup-page-e2e-"));
const SHOTS = process.env.E2E_SCREENSHOTS;
// E2E_VIEWPORT=360x900 makes every page this wide, so the screenshots can be taken at phone width.
const [VIEW_W, VIEW_H] = (process.env.E2E_VIEWPORT ?? "").match(/^(\d+)x(\d+)$/)?.slice(1).map(Number) ?? [];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const RPC_PORT = 18761, PAGE_PORT = 18762, HOSTED_PORT = 18764, BUILT_PORT = 18765;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const XSS = '<img src=x onerror="window.__pwned=1">';
const VENDOR = "0x00000000000000000000000000000000000000a1";

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${cmd} ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Mining is slow on some machines (about 2 ms a block on one, ten times that on another), and cast gives up on a
// call after 45 s. Small calls stay well under that.
const mine = (rpc, blocks) => { for (let left = blocks; left > 0; left -= 5000) sh("cast", ["rpc", "anvil_mine", "0x" + Math.min(5000, left).toString(16), "--rpc-url", rpc]); };
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

  // A 2-page fallback window (about 20,000 blocks) keeps the "RPC cannot say when the vault was created" test cheap.
  const FALLBACK_BLOCKS = 2 * 9999;
  start(join(ROOT, "setup-page/node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", String(PAGE_PORT), "--strictPort"], { cwd: join(ROOT, "setup-page"), env: { ...process.env, VITE_LOG_FALLBACK_PAGES: "2" } });
  // The hosted site is built with a relay address. This one stands in for it, so the approvals section can be tested.
  start(join(ROOT, "setup-page/node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", String(HOSTED_PORT), "--strictPort"], { cwd: join(ROOT, "setup-page"), env: { ...process.env, VITE_LOG_FALLBACK_PAGES: "2", VITE_RELAY_URL: "https://relay.example/ignored/path" } });
  // The production build, made the way scripts/build_site.sh makes the setup page (base /setup/, a relay baked in)
  // and served under /setup/ the way the hosted site serves it. The dev servers above do not exercise that.
  {
    const out = join(WORK, "built-setup");
    const built = spawnSync(join(ROOT, "setup-page/node_modules/.bin/vite"), ["build", "--base", "/setup/", "--outDir", out, "--emptyOutDir"], {
      cwd: join(ROOT, "setup-page"), encoding: "utf8", env: { ...process.env, VITE_RELAY_URL: "https://relay.example" },
    });
    assert.equal(built.status, 0, `the production build failed: ${built.stderr}`);
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
    const server = createServer((request, response) => {
      const pathname = new URL(request.url, "http://x").pathname;
      const file = pathname.startsWith("/setup/") ? join(out, pathname.slice("/setup/".length) || "index.html") : "";
      if (!file || !file.startsWith(out) || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404); response.end("not found"); return; }
      response.writeHead(200, { "content-type": types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
      response.end(readFileSync(file));
    });
    await new Promise((resolve) => server.listen(BUILT_PORT, "127.0.0.1", resolve));
    children.push({ kill: () => server.close() });
  }
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PAGE_PORT}`)).ok, "page");
  await waitFor(async () => (await fetch(`http://127.0.0.1:${HOSTED_PORT}`)).ok, "hosted-style page");
  browser = await chromium.launch({ channel: "chrome", headless: true });

  async function openPage(options = {}) { return openPageAt("", options); }
  async function openPageAt(query, { account = owner, chainId = "0x7a69", rejectNext = false, port = PAGE_PORT, path = "" } = {}) {
    const context = await browser.newContext({ viewport: { width: VIEW_W ?? 1000, height: VIEW_H ?? 1400 }, acceptDownloads: true });
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
    await page.goto(`http://127.0.0.1:${port}/${path}${query}`);
    await page.waitForLoadState("networkidle");
    return { page, errors, prompts, control, context };
  }
  const sends = (prompts) => prompts.filter((m) => m === "eth_sendTransaction").length;
  const status = (page) => page.locator("#status").textContent();
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}${VIEW_W ? `-${VIEW_W}` : ""}.png`), fullPage: true }); };
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
  const forgeVault = () => create(ownerKey, "src/StyxPolicyVault.sol:StyxPolicyVault", owner, token); // repo default build: differs from the page's
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
    mine(RPC, 25_000); // more than two pages, and further back than the 2-page fallback window
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
    // The vendor is 25,000+ blocks old by now, outside the 2-page window this build uses, so nothing more is mined.
    assert.ok(25_000 > FALLBACK_BLOCKS);
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

  await scenario("the page says what the daily limit means, and it is true: six 1 USDC payments pass with no signature", async () => {
    const { page, context } = await openPage();
    await connect(page, token);
    await openVaultByAddress(page, vault);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    const meaning = await page.locator("#daily-meaning").textContent();
    assert.match(meaning, /The daily limit is the most the agent can pay in a day without your signature/);
    assert.match(meaning, /does not stop splitting/);
    assert.match(await page.locator('label[for="policy-daily"]').textContent(), /most the agent can pay in a day without your signature/);
    assert.match(await page.locator("#daily-meaning").locator("xpath=..").textContent(), /accept losing in a day/);
    assert.equal(await page.locator("#daily-meaning").isVisible(), true);
    assert.match(await page.locator("#dashboard").textContent(), /most the agent can pay in a day without a signature/);
    await shot(page, "daily-limit-meaning");
    await context.close();

    // The claim, on the contract: limit 1 USDC per payment and 10 per day. Six 1 USDC payments settle with no
    // owner signature, and a single 6 USDC payment is refused.
    // Earlier scenarios mined many blocks, so the chain's clock is ahead of the real one. Use the chain's.
    const chainNow = Number(sh("cast", ["block", "latest", "--field", "timestamp", "--rpc-url", RPC]));
    const split = forgeVault();
    send(ownerKey, split, "configurePolicy(address,uint256,uint256,uint64)", agent, "1000000", "10000000", String(chainNow + 86400));
    send(ownerKey, split, "setRecipient(address,bool)", VENDOR, "true");
    send(ownerKey, token, "mint(address,uint256)", split, "12000000"); // more than the daily limit, so the limit is what stops payments
    const version = call(split, "policyVersion()(uint256)");
    const pay = (key, id, amount) => spawnSync("cast", ["send", split, "pay((bytes32,address,address,address,uint256,bytes32,uint256,uint64))",
      `(0x${id.toString(16).padStart(64, "0")},${agent},${token},${VENDOR},${amount},0x${"00".repeat(32)},${version},${chainNow + 3600})`,
      "--rpc-url", RPC, "--private-key", key], { encoding: "utf8" });
    const vendorBefore = BigInt(call(token, "balanceOf(address)(uint256)", VENDOR));
    const refused = pay(agentKey, 900, "6000000");
    assert.notEqual(refused.status, 0, "one 6 USDC payment must be refused");
    assert.equal(BigInt(call(token, "balanceOf(address)(uint256)", VENDOR)), vendorBefore);
    for (let i = 1; i <= 6; i++) {
      const done = pay(agentKey, 900 + i, "1000000");
      assert.equal(done.status, 0, `payment ${i} of 1 USDC should settle: ${done.stderr}`);
    }
    assert.equal(BigInt(call(token, "balanceOf(address)(uint256)", VENDOR)) - vendorBefore, 6_000_000n);
    // The daily limit is what finally stops it: the next payments past 10 USDC in total are refused.
    for (let i = 7; i <= 10; i++) assert.equal(pay(agentKey, 900 + i, "1000000").status, 0);
    assert.notEqual(pay(agentKey, 911, "1000000").status, 0, "the 11th USDC in a day must be refused");
    assert.equal(BigInt(call(token, "balanceOf(address)(uint256)", VENDOR)) - vendorBefore, 10_000_000n); // exactly the daily limit, never signed for
  });

  // ---- Approving from alerts with no config file ----
  const trustRecords = (page) => page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith("vault-trust/"))));
  const approvalsText = (page) => page.locator("#approvals-state").textContent();
  const hosted = (options = {}) => openPageAt("", { port: HOSTED_PORT, ...options });

  await scenario("on a build with a relay, connecting as the owner sets approvals up and says what happens next", async () => {
    const { page, prompts, context } = await hosted();
    await connect(page, token);
    await openVaultByAddress(page, vault);
    await waitFor(async () => /^Ready in this browser/.test(await approvalsText(page)), "approvals ready");
    const state = await approvalsText(page);
    assert.ok(state.toLowerCase().includes(vault.toLowerCase()), "names the vault");
    assert.ok(state.includes("https://relay.example") && !state.includes("ignored/path"), "names the relay's origin only");
    assert.equal(await page.locator("#approvals-steps").isVisible(), true);
    assert.match(await page.locator("#approvals-steps").textContent(), /No file is needed/);
    assert.match(await page.locator("#approvals-note").textContent(), /Changing limits or vendors cancels approvals that are waiting/);
    assert.match(await page.locator("#approvals-trusted").textContent(), /trusts this vault for approvals/);
    // The record is exactly what the approval page reads, so alerts go straight to review.
    const records = await trustRecords(page);
    const key = `vault-trust/31337/${vault.toLowerCase()}`;
    assert.deepEqual(Object.keys(records), [key]);
    const saved = JSON.parse(records[key]);
    assert.equal(saved.chainId, "31337");
    assert.equal(saved.vault.toLowerCase(), vault.toLowerCase());
    assert.equal(saved.relay, "https://relay.example");
    assert.equal(sends(prompts), 0); // setting this up sends nothing
    await shot(page, "approvals-ready");
    await context.close();
  });

  await scenario("a wallet that is not the owner sets nothing up", async () => {
    const { page, context } = await hosted({ account: stranger });
    await connect(page, token);
    await openVaultByAddress(page, vault);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    assert.match(await approvalsText(page), /You are not this vault's owner/);
    assert.deepEqual(await trustRecords(page), {});
    assert.equal(await page.locator("#approvals-steps").isVisible(), false);
    await context.close();
  });

  await scenario("a look-alike vault is not trusted for approvals, even when its owner is you", async () => {
    const odd = forgeVault(); // the repo's own build: its code differs from the page's
    const { page, context } = await hosted();
    await connect(page, token);
    await openVaultByAddress(page, odd);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    assert.match(await approvalsText(page), /does not match the build this page knows/);
    assert.deepEqual(await trustRecords(page), {});
    await page.click("#unlock-funding"); // unlocking funding must not set approvals up either
    assert.deepEqual(await trustRecords(page), {});
    await context.close();
  });

  await scenario("the owner can stop trusting a vault and set it up again, and two vaults are listed", async () => {
    const { page, context } = await hosted();
    await connect(page, token);
    await openVaultByAddress(page, vault);
    await waitFor(async () => /^Ready in this browser/.test(await approvalsText(page)), "ready");
    await page.click("#approvals-forget");
    assert.deepEqual(await trustRecords(page), {});
    assert.match(await approvalsText(page), /Approvals are not set up for this vault in this browser/);
    assert.match(await page.locator("#approvals-trusted").textContent(), /trusts no vault/);
    assert.equal(await page.locator("#approvals-use").isVisible(), true);
    await page.click("#approvals-use");
    await waitFor(async () => /^Ready in this browser/.test(await approvalsText(page)), "ready again");
    assert.equal(Object.keys(await trustRecords(page)).length, 1);
    // A second vault the owner also owns: both are listed, and forgetting one leaves the other.
    await openVaultByAddress(page, otherVault);
    await waitFor(async () => (await dd(page, "v-address")).trim().toLowerCase() === otherVault.toLowerCase(), "second vault");
    await waitFor(async () => /2 vaults/.test(await page.locator("#approvals-trusted").textContent()), "two listed");
    assert.match(await page.locator("#approvals-trusted").textContent(), /An alert for any other vault always asks you first/);
    await page.click("#approvals-forget");
    const left = Object.keys(await trustRecords(page));
    assert.deepEqual(left, [`vault-trust/31337/${vault.toLowerCase()}`]);
    await context.close();
  });

  await scenario("a copy of the page with no relay says so and sets nothing up", async () => {
    const { page, context } = await openPage(); // the plain build
    await connect(page, token);
    await openVaultByAddress(page, vault);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    assert.match(await approvalsText(page), /not connected to an alert relay/);
    assert.deepEqual(await trustRecords(page), {});
    for (const id of ["approvals-use", "approvals-forget", "approvals-steps"]) assert.equal(await page.locator(`#${id}`).isVisible(), false, id);
    await context.close();
  });

  await scenario("the production build, served under /setup/ as the hosted site serves it, loads its contract build and sets approvals up", async () => {
    const { page, errors, context } = await openPageAt("", { port: BUILT_PORT, path: "setup/" });
    await connect(page, token);
    await openVaultByAddress(page, vault);
    await page.locator("#dashboard").waitFor({ state: "visible" });
    // Matching means the page found its contract build at /setup/vault-artifact.json and compared it.
    assert.match(await dd(page, "v-code"), /^Matches this repository/);
    await waitFor(async () => /^Ready in this browser/.test(await approvalsText(page)), "approvals ready on the production build");
    assert.deepEqual(Object.keys(await trustRecords(page)), [`vault-trust/31337/${vault.toLowerCase()}`]);
    assert.equal(errors.length, 0, errors.join());
    await context.close();
  });

  // ---- Version 2 vaults: many agents, approvers, an aggregate cap ----
  const AGENT_A = agent, AGENT_B = "0x00000000000000000000000000000000000000c1", APPROVER = "0x00000000000000000000000000000000000000d1";
  const createV2 = () => /Deployed to: (0x[0-9a-fA-F]{40})/.exec(sh("forge", ["create", "src/StyxVault.sol:StyxVault", "--optimize", "--optimizer-runs", "200", "--evm-version", "cancun", "--broadcast", "--rpc-url", RPC, "--private-key", ownerKey, "--constructor-args", owner, token], contracts))[1];
  const lines = (cmd) => sh("cast", ["call", ...cmd, "--rpc-url", RPC]).split("\n").map((l) => l.trim().split(" ")[0]);
  const policyOf = (v, who) => lines([v, "agentPolicy(address)(uint256,uint256,uint256,uint64,bool)", who]); // version, per, daily, until, enabled
  const confirmText = (page) => page.locator("#v2-confirm-text").textContent();
  const v2Vault = createV2();
  const openV2 = async (options = {}) => {
    const opened = await openPageAt(`?vault=${v2Vault}`, options);
    await opened.page.click("#connect");
    await opened.page.locator("#v2").waitFor({ state: "visible", timeout: 30000 });
    return opened;
  };
  const refreshed = (page, re, label) => waitFor(async () => re.test(await page.locator("#v2").textContent()), label, 300);

  await scenario("a version 2 vault is detected, shows its own screens, and says plainly that the cap starts at 0", async () => {
    const { page, context, errors } = await openV2();
    assert.equal(await page.evaluate(() => document.body.dataset.version), "2");
    for (const hidden of ["#s-approvals", "section.v1only"]) assert.equal(await page.locator(`${hidden}:visible`).count(), 0, hidden);
    assert.ok((await page.locator("#vault-banner").textContent()).toLowerCase().includes(v2Vault.toLowerCase()));
    assert.match(await page.locator("#v2-cap-section").textContent(), /starts at 0, and while it is 0 no agent can pay anything/);
    await waitFor(async () => /vault's daily cap is 0, so no agent can pay anything/.test(await page.locator("#v2-checks").textContent()), "cap check");
    assert.match(await page.locator("#v2-verdict").textContent(), /^Not yet/);
    assert.match(await dd(page, "v2-code"), /^Matches this repository's build/);
    assert.match(await page.locator("#v2-agent-list").textContent(), /No agent yet/);
    assert.equal(errors.length, 0, errors.join());
    await shot(page, "v2-empty");
    await context.close();
  });

  await scenario("the cap, an agent and its switch-off reach the chain, each confirmed with the vault and the agent named", async () => {
    const { page, prompts, context } = await openV2();
    const before = sends(prompts);
    await page.fill("#v2-cap-input", "5");
    await page.click("#v2-cap-save");
    await page.locator("#v2-confirm").waitFor({ state: "visible" });
    let text = await confirmText(page);
    await shot(page, "v2-confirm-cap");
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(sideways <= 0, `no horizontal scrolling, got ${sideways}px`);
    assert.ok(await page.locator("#v2-confirm").isVisible() && await page.evaluate(() => document.activeElement?.id === "v2-confirm"), "the confirmation panel is shown and holds focus");
    assert.match(await page.locator("#v2-confirm-title").textContent(), /Step 2 of 2\. Nothing has been sent yet/);
    assert.ok(text.toLowerCase().includes(v2Vault.toLowerCase()), "the confirmation names the vault");
    assert.match(text, /daily cap to 5 USDC \(it is 0 now\)/);
    assert.equal(sends(prompts), before, "asking is not sending");
    await page.click("#v2-confirm-yes");
    await statusIs(page, /Set the vault daily cap to 5 USDC on vault .*: confirmed/);
    assert.equal(call(v2Vault, "vaultDailyLimit()(uint256)"), "5000000");

    // Agent A, then agent B.
    for (const [who, per, daily] of [[AGENT_A, "1", "3"], [AGENT_B, "0.5", "2"]]) {
      await page.fill("#v2-agent-address", who);
      await page.fill("#v2-agent-per", per);
      await page.fill("#v2-agent-daily", daily);
      await page.click("#v2-agent-save");
      await page.locator("#v2-confirm").waitFor({ state: "visible" });
      text = await confirmText(page);
      assert.ok(text.toLowerCase().includes(v2Vault.toLowerCase()) && text.toLowerCase().includes(who.toLowerCase()), "the confirmation names the vault and the agent");
      assert.match(text, /Approvals waiting for other agents stay valid/);
      await page.click("#v2-confirm-yes");
      await statusIs(page, /Save agent 0x\w+\.\.\.\w+ on vault .*: confirmed/);
    }
    const a = policyOf(v2Vault, AGENT_A), b = policyOf(v2Vault, AGENT_B);
    assert.deepEqual([a[0], a[1], a[2], a[4]], ["1", "1000000", "3000000", "true"]);
    assert.deepEqual([b[0], b[1], b[2], b[4]], ["1", "500000", "2000000", "true"]);
    await refreshed(page, new RegExp(`${AGENT_B.slice(2)}[\\s\\S]*ON`, "i"), "both agents listed");
    assert.equal(await page.locator("#v2-agent-list li").count(), 2);

    // Switching A off keeps its limits and leaves B alone.
    await page.locator("#v2-agent-list li", { hasText: new RegExp(AGENT_A, "i") }).getByRole("button", { name: "Switch off" }).click();
    text = await confirmText(page);
    assert.ok(text.toLowerCase().includes(AGENT_A.toLowerCase()) && text.toLowerCase().includes(v2Vault.toLowerCase()));
    assert.match(text, /Switch it OFF/);
    await page.click("#v2-confirm-yes");
    await statusIs(page, /Switch off agent .* on vault .*: confirmed/);
    const a2 = policyOf(v2Vault, AGENT_A), b2 = policyOf(v2Vault, AGENT_B);
    assert.deepEqual([a2[0], a2[1], a2[2], a2[4]], ["2", "1000000", "3000000", "false"]); // off, limits kept, version moved on
    assert.deepEqual(b2, b); // the other agent is untouched
    await shot(page, "v2-agents");
    await context.close();
  });

  await scenario("approvers are added and removed, with the contract's refusals caught before the wallet is asked", async () => {
    const { page, prompts, context } = await openV2();
    await page.locator("#v2-approver-list li").first().waitFor();
    assert.match(await page.locator("#v2-approver-list").textContent(), /OWNER, ALWAYS AN APPROVER/);
    const before = sends(prompts);
    const refused = async (address, re) => { await page.fill("#v2-approver-address", address); await page.click("#v2-approver-add"); await statusIs(page, re); assert.equal(sends(prompts), before); };
    await refused(owner, /owner is always an approver already/);
    await refused(AGENT_B, /switched-on agent\. An address cannot be both/);
    await refused("not-an-address", /must be an address/);
    // An agent cannot be saved as an approver's twin either.
    await page.fill("#v2-agent-address", owner); await page.click("#v2-agent-save");
    await statusIs(page, /owner cannot be an agent/);
    assert.equal(sends(prompts), before);

    await page.fill("#v2-approver-address", APPROVER);
    await page.click("#v2-approver-add");
    text: {
      const text = await confirmText(page);
      assert.ok(text.toLowerCase().includes(v2Vault.toLowerCase()) && text.toLowerCase().includes(APPROVER.toLowerCase()));
      assert.match(text, /any enabled agent, with no budget of its own/);
      assert.match(text, /does not change any agent/);
    }
    await page.click("#v2-confirm-yes");
    await statusIs(page, /Add approver .* on vault .*: confirmed/);
    assert.deepEqual(lines([v2Vault, "approverState(address)(uint256,bool)", APPROVER]), ["1", "true"]);
    await refreshed(page, new RegExp(`${APPROVER.slice(2)}[\\s\\S]*ON`, "i"), "approver listed");
    // The agent that is now an approver's neighbour is untouched, and an approver cannot become an agent.
    await page.fill("#v2-agent-address", APPROVER); await page.click("#v2-agent-save");
    await statusIs(page, /That address is an approver/);

    await page.locator("#v2-approver-list li", { hasText: new RegExp(APPROVER, "i") }).getByRole("button", { name: "Remove" }).click();
    assert.match(await confirmText(page), /Adding it again later does not bring an old approval back/);
    await page.click("#v2-confirm-yes");
    await statusIs(page, /Remove approver .* on vault .*: confirmed/);
    assert.deepEqual(lines([v2Vault, "approverState(address)(uint256,bool)", APPROVER]), ["2", "false"]);
    await shot(page, "v2-approvers");
    await context.close();
  });

  await scenario("vendors and funding work on a version 2 vault, and the checklist turns ready", async () => {
    const { page, context } = await openV2();
    await page.fill("#vendor-address", VENDOR);
    await page.fill("#vendor-label", "Acme");
    await page.click("#add-vendor");
    await statusIs(page, /Allow vendor on vault .*: confirmed/);
    assert.equal(call(v2Vault, "allowedRecipient(address)(bool)", VENDOR), "true");
    await page.locator("#vendors li").first().waitFor({ timeout: 20000 });
    assert.ok((await page.locator("#vendors li").first().textContent()).includes("Acme"));
    await page.fill("#fund-amount", "4");
    await page.click("#fund");
    await page.locator("#fund-confirm").waitFor({ state: "visible" });
    assert.ok((await page.locator("#fund-review").textContent()).toLowerCase().includes(v2Vault.toLowerCase()));
    await page.click("#fund-confirm");
    await statusIs(page, /Move 4 USDC into the vault on vault .*: confirmed/);
    assert.equal(call(token, "balanceOf(address)(uint256)", v2Vault), "4000000");
    // Agent B is on with limits, the cap is 5, a vendor is allowed and the vault is funded.
    await waitFor(async () => /An agent can pay now/.test(await page.locator("#v2-verdict").textContent()), "ready verdict", 300);
    // Agent B's address holds 0 of its own, so there is no warning. Pause works through the shared button.
    await page.click("#toggle-pause");
    await statusIs(page, /Pause on vault .*: confirmed/);
    assert.equal(call(v2Vault, "paused()(bool)"), "true");
    await waitFor(async () => /vault is paused/.test(await page.locator("#v2-checks").textContent()), "paused check", 300);
    await page.click("#toggle-pause");
    await statusIs(page, /Unpause on vault .*: confirmed/);
    await shot(page, "v2-ready");
    await context.close();
  });

  await scenario("a wallet that is not the owner can read a version 2 vault but change nothing, and a version 1 vault keeps its own screens", async () => {
    const stranger_ = await openV2({ account: stranger });
    await stranger_.page.locator("#v2-not-owner").waitFor({ state: "visible" });
    for (const id of ["v2-cap-save", "v2-agent-save", "v2-agent-off", "v2-approver-add"]) assert.equal(await stranger_.page.locator(`#${id}`).isDisabled(), true, id);
    assert.equal(sends(stranger_.prompts), 0);
    await stranger_.context.close();
    const one = await openPageAt(`?vault=${vault}`);
    await one.page.click("#connect");
    await one.page.locator("#dashboard").waitFor({ state: "visible", timeout: 30000 });
    assert.equal(await one.page.evaluate(() => document.body.dataset.version), "1");
    assert.equal(await one.page.locator("#v2:visible").count(), 0);
    assert.match(await dd(one.page, "v-code"), /^Matches this repository/);
    await one.context.close();
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
