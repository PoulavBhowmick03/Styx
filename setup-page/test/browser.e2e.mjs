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
  start("anvil", ["--port", String(RPC_PORT), "--silent", "--config-out", config]);
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

  async function openPage({ account = owner, chainId = "0x7a69", rejectNext = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 1400 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const prompts = [];
    const control = { reject: rejectNext };
    await page.exposeFunction("__wallet", async (method, params) => {
      prompts.push(method);
      if (method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return chainId;
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
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);
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
    await page.fill("#token-input", tokenAddress);
  };
  const dd = (page, id) => page.locator(`#${id}`).textContent();
  const checksText = (page) => page.locator("#checks").textContent();

  let vault;
  await scenario("the owner deploys a vault, sets limits and a vendor, and funds it", async () => {
    const { page, errors, prompts, context } = await openPage();
    await connect(page, token);
    await page.click("#deploy");
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
    await statusIs(page, /Save limits: confirmed/);
    assert.equal(call(vault, "perPaymentLimit()(uint256)"), "1000000");
    assert.equal(call(vault, "dailyLimit()(uint256)"), "10000000");
    assert.equal(call(vault, "agent()(address)").toLowerCase(), agent.toLowerCase());
    assert.equal(call(vault, "policyVersion()(uint256)"), "1");
    assert.match(await dd(page, "v-version"), /^1$/);

    await page.fill("#vendor-address", VENDOR);
    await page.fill("#vendor-label", XSS);
    await page.click("#add-vendor");
    await statusIs(page, /Allow vendor: confirmed/);
    assert.equal(call(vault, "allowedRecipient(address)(bool)", VENDOR), "true");
    await page.locator("#vendors li").first().waitFor();
    assert.equal(await page.locator("#vendors img").count(), 0); // a hostile label stays text
    assert.ok((await page.locator("#vendors li").first().textContent()).includes(XSS));

    // The protection panel says the agent's 5 USDC is outside the vault.
    assert.match(await checksText(page), /agent's address holds 5 USDC. The vault does not cover it/);
    assert.match(await page.locator("#agent-sweep").textContent(), /send at least 4\.5 USDC/);

    await page.fill("#fund-amount", "8");
    await page.click("#fund");
    await statusIs(page, /confirmed/);
    assert.equal(call(token, "balanceOf(address)(uint256)", vault), "8000000");
    assert.match(await dd(page, "v-balance"), /^8 USDC$/);
    await shot(page, "dashboard-agent-funded");

    // The owner (or the agent's owner) drains the agent to gas only; the page then agrees.
    send(agentKey, token, "transfer(address,uint256)", owner, "4800000");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await connect(page, token);
    await page.fill("#vault-input", vault);
    await page.click("#load-vault");
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
    await statusIs(page, /Pause: confirmed/);
    assert.equal(call(vault, "paused()(bool)"), "true");
    assert.match(await dd(page, "v-paused"), /PAUSED/);
    assert.match(await checksText(page), /vault is paused/);
    control.reject = true;
    await page.click("#toggle-pause");
    await statusIs(page, /rejected the request in your wallet. Nothing was sent/);
    assert.equal(call(vault, "paused()(bool)"), "true");
    control.reject = false;
    await page.click("#toggle-pause");
    await statusIs(page, /Unpause: confirmed/);
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
    assert.match(await page.locator("#withdraw-review").textContent(), /Withdraw 1\.5 USDC from the vault to .* protects 6\.5 USDC/);
    assert.equal(sends(prompts), 0 + sends(prompts)); // nothing sent by the review itself
    const sentBefore = sends(prompts);
    await page.click("#withdraw-confirm");
    await statusIs(page, /Withdraw 1\.5 USDC: confirmed/);
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
