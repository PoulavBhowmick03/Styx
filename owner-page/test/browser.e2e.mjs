// Drives the real page in headless Chrome against a local chain. Anvil stands in for the wallet by
// answering the page's EIP-1193 requests, so this covers the UI, not a real wallet extension.
// Needs anvil, forge, cast, Chrome, and a built erebus-vault. Run: npm run e2e
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const CLI = join(ROOT, "sdk/evm/target/debug/erebus-vault");
const WORK = mkdtempSync(join(tmpdir(), "owner-page-e2e-"));
chmodSync(WORK, 0o700);
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const RPC_PORT = 18661, PAGE_PORT = 18662, GATE_PORT = 18663, RELAY_PORT = 18664, TELEGRAM_PORT = 18665;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const VENDOR = "0x00000000000000000000000000000000000000a1";
const XSS = '<img src=x onerror="window.__pwned=1">';

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${cmd} ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) { if (await check().catch(() => false)) return; await sleep(100); }
  throw new Error(`timed out waiting for ${label}`);
}
const children = [];
// Each child leads its own process group, because vite and tsx start children of their own.
const start = (cmd, args, opts = {}) => { const c = spawn(cmd, args, { stdio: "ignore", detached: true, ...opts }); children.push(c); return c; };

const results = [];
async function scenario(name, run) {
  await run();
  results.push(name);
  console.log(`PASS  ${name}`);
}

let browser;
try {
  const config = join(WORK, "anvil.json");
  start("anvil", ["--port", String(RPC_PORT), "--silent", "--config-out", config]);
  await waitFor(async () => spawnSync("cast", ["chain-id", "--rpc-url", RPC]).status === 0 && JSON.parse(readFileSync(config, "utf8")), "anvil");
  const keys = JSON.parse(readFileSync(config, "utf8")).private_keys;
  const [ownerKey, agentKey, strangerKey] = keys;
  const addr = (k) => sh("cast", ["wallet", "address", "--private-key", k]).toLowerCase();
  const owner = addr(ownerKey), agent = addr(agentKey), stranger = addr(strangerKey);
  const contracts = join(ROOT, "contracts/evm");
  const create = (c, ...a) => /Deployed to: (0x[0-9a-fA-F]{40})/.exec(sh("forge", ["create", c, "--broadcast", "--rpc-url", RPC, "--private-key", ownerKey, "--constructor-args", ...a], contracts))[1].toLowerCase();
  const token = create("src/MockERC20.sol:MockERC20", "USD Coin", "USDC");
  const vault = create("src/ErebusPolicyVault.sol:ErebusPolicyVault", owner, token);
  const send = (to, sig, ...a) => sh("cast", ["send", to, sig, ...a, "--rpc-url", RPC, "--private-key", ownerKey]);
  const now = Math.floor(Date.now() / 1000);
  send(vault, "configurePolicy(address,uint256,uint256,uint64)", agent, "1000000", "1000000000", String(now + 86400)); // A high daily limit: this test proposes many payments.
  send(vault, "setRecipient(address,bool)", VENDOR, "true");
  send(token, "mint(address,uint256)", vault, "100000000");
  const agentFile = join(WORK, "agent.key");
  writeFileSync(agentFile, agentKey, { mode: 0o600 });
  const invoice = join(WORK, "invoice");
  writeFileSync(invoice, "invoice body");
  const cli = (request) => {
    const r = spawnSync(CLI, [], {
      input: JSON.stringify(request), encoding: "utf8",
      env: { EREBUS_VAULT_CHAIN_ID: "31337", EREBUS_VAULT_RPC_URLS: RPC, EREBUS_VAULT_ADDRESS: vault, EREBUS_VAULT_TOKEN: token,
        EREBUS_VAULT_STATE_ROOT: join(WORK, "journal"), EREBUS_VAULT_AGENT_KEY_FILE: agentFile },
    });
    return JSON.parse(r.stdout);
  };
  const propose = () => cli({ method: "propose", recipient: VENDOR, amount: "6000000", invoice_file: invoice, invoice_reference: XSS, valid_until: now + 3600 });
  let counter = 0;
  const approve = (paymentId) => {
    const pendingFile = join(WORK, `pending-${counter++}.json`);
    const r = cli({ method: "request_approval", payment_id: paymentId, authorization_expiry: now + 600, pending_file: pendingFile });
    assert.equal(r.status, "ok", JSON.stringify(r));
    return pendingFile;
  };
  const ownerConfig = join(WORK, "owner.json");
  writeFileSync(ownerConfig, JSON.stringify({ chainId: "31337", vault, owner, token, vendors: { [VENDOR]: "Acme Supplies" }, relay: `http://127.0.0.1:${RELAY_PORT}` }));

  const vite = join(ROOT, "owner-page/node_modules/.bin/vite");
  start(vite, ["--host", "127.0.0.1", "--port", String(PAGE_PORT), "--strictPort"], { cwd: join(ROOT, "owner-page") });
  start(vite, ["--host", "127.0.0.1", "--port", String(GATE_PORT), "--strictPort"], { cwd: join(ROOT, "owner-page"), env: { ...process.env, VITE_WORLD_GATE: "1" } });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PAGE_PORT}`)).ok, "page");
  await waitFor(async () => (await fetch(`http://127.0.0.1:${GATE_PORT}`)).ok, "gated page");
  browser = await chromium.launch({ channel: "chrome", headless: true });

  /** A page whose wallet is Anvil, connected as `account`, on `chainId`. */
  async function openPage(port, { account = owner, chainId = "0x7a69" } = {}) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const prompts = [];
    await page.exposeFunction("__wallet", async (method, params) => {
      // Reads show the owner nothing, so only the requests a wallet would prompt for are recorded.
      if (method !== "eth_call" && method !== "eth_chainId") prompts.push(method);
      if (method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return chainId;
      const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      if (r.error) throw new Error(r.error.message);
      return r.result;
    });
    await page.addInitScript(() => { window.ethereum = { request: ({ method, params }) => window.__wallet(method, params ?? []) }; });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForLoadState("networkidle");
    return { page, errors, prompts, context };
  }
  const load = async (page, pendingFile) => {
    await page.setInputFiles("#config-file", ownerConfig);
    await page.setInputFiles("#pending-file", pendingFile);
  };
  const status = (page) => page.locator("#status").textContent();
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };

  await scenario("the owner reviews, signs in the page, and the payment settles", async () => {
    const id = propose().payment_id;
    const pending = approve(id);
    const { page, errors, prompts, context } = await openPage(PAGE_PORT);
    await load(page, pending);
    await page.locator("#sign").waitFor({ state: "visible" });
    assert.equal(await page.locator("#amount").textContent(), "6 USDC");
    assert.equal(await page.locator("#vendor").textContent(), "Acme Supplies");
    assert.equal((await page.locator("#recipient").textContent()).toLowerCase(), VENDOR);
    await waitFor(async () => /limit of 1 USDC, read from the chain/.test(await page.locator("#rule").textContent()), "the chain's limit");
    await shot(page, "review");
    await page.click("#sign");
    await page.locator("#output").waitFor({ state: "visible" });
    await shot(page, "signed");
    assert.equal(await page.locator("#sign").isVisible(), false);
    assert.deepEqual(prompts, ["eth_requestAccounts", "eth_signTypedData_v4"]);
    const signature = join(WORK, "signature.json");
    writeFileSync(signature, await page.locator("#output-text").inputValue());
    assert.equal(errors.length, 0, errors.join());
    await context.close();
    const paid = cli({ method: "submit", payment_id: id, signature_file: signature });
    assert.equal(paid.state, "settled", JSON.stringify(paid));
  });

  await scenario("agent text in the invoice reference stays text and cannot run script", async () => {
    const { page, context } = await openPage(PAGE_PORT);
    await load(page, approve(propose().payment_id));
    await page.locator("#sign").waitFor({ state: "visible" });
    assert.equal(await page.locator("#invoice").textContent(), XSS);
    assert.equal(await page.locator("#invoice img").count(), 0);
    await sleep(200);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    await context.close();
  });

  for (const [name, mutate, message] of [
    ["an altered amount", (p) => { p.payment.amount = "7000000"; }, /does not match/],
    ["an altered recipient", (p) => { p.payment.recipient = "0x00000000000000000000000000000000000000b2"; }, /does not match/],
    ["another vault", (p) => { p.vault = "0x00000000000000000000000000000000000000c3"; }, /another vault/],
    ["another chain", (p) => { p.chainId = "1"; }, /another chain/],
    ["a number instead of a decimal string", (p) => { p.payment.amount = 6000000; }, /decimal string/],
  ]) {
    await scenario(`${name} never shows the sign button`, async () => {
      const original = JSON.parse(readFileSync(approve(propose().payment_id), "utf8"));
      mutate(original);
      const file = join(WORK, `mutated-${counter++}.json`);
      writeFileSync(file, JSON.stringify(original));
      const { page, prompts, context } = await openPage(PAGE_PORT);
      await load(page, file);
      await waitFor(async () => message.test(await status(page)), name);
      assert.equal(await page.locator("#sign").isVisible(), false);
      assert.equal(prompts.length, 0);
      await context.close();
    });
  }

  await scenario("a limit misstated by the agent is replaced with the chain's", async () => {
    const original = JSON.parse(readFileSync(approve(propose().payment_id), "utf8"));
    original.perPaymentLimit = "1";
    const file = join(WORK, `understated-${counter++}.json`);
    writeFileSync(file, JSON.stringify(original));
    const { page, context } = await openPage(PAGE_PORT);
    await load(page, file);
    await waitFor(async () => /limit of 1 USDC, read from the chain/.test(await page.locator("#rule").textContent()), "the chain's limit");
    assert.equal((await page.locator("#rule").textContent()).includes("0.000001"), false);
    await context.close();
  });

  await scenario("when the chain cannot be read, the agent's limit stays marked as unverified", async () => {
    const { page, context } = await openPage(PAGE_PORT, { chainId: "0x1" });
    await load(page, approve(propose().payment_id));
    await page.locator("#sign").waitFor({ state: "visible" });
    await sleep(300);
    assert.match(await page.locator("#rule").textContent(), /agent says the limit is 1 USDC. Not verified/);
    await context.close();
  });

  await scenario("a recipient outside the owner's list never shows the sign button", async () => {
    const other = join(WORK, "other-owner.json");
    writeFileSync(other, JSON.stringify({ chainId: "31337", vault, owner, token, vendors: {} }));
    const { page, context } = await openPage(PAGE_PORT);
    await page.setInputFiles("#config-file", other);
    await page.setInputFiles("#pending-file", approve(propose().payment_id));
    await waitFor(async () => /allowlist/.test(await status(page)), "allowlist refusal");
    assert.equal(await page.locator("#sign").isVisible(), false);
    await context.close();
  });

  await scenario("the wrong account is refused before any signature is requested", async () => {
    const { page, prompts, context } = await openPage(PAGE_PORT, { account: stranger });
    await load(page, approve(propose().payment_id));
    await page.locator("#sign").waitFor({ state: "visible" });
    await page.click("#sign");
    await waitFor(async () => /owner account/.test(await status(page)), "account refusal");
    assert.equal(prompts.includes("eth_signTypedData_v4"), false);
    await context.close();
  });

  await scenario("the wrong chain is refused before any signature is requested", async () => {
    const { page, prompts, context } = await openPage(PAGE_PORT, { chainId: "0x1" });
    await load(page, approve(propose().payment_id));
    await page.locator("#sign").waitFor({ state: "visible" });
    await page.click("#sign");
    await waitFor(async () => /Switch your wallet/.test(await status(page)), "chain refusal");
    assert.equal(prompts.includes("eth_signTypedData_v4"), false);
    await context.close();
  });

  // ---- The whole alert path: agent request, Telegram alert, link, signature, settlement ----
  const alerts = [];
  const telegram = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    alerts.push({ path: req.url, ...JSON.parse(raw) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: alerts.length } }));
  });
  await new Promise((r) => telegram.listen(TELEGRAM_PORT, "127.0.0.1", r));
  const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
  const agentToken = randomBytes(24).toString("hex");
  start(join(ROOT, "relay/node_modules/.bin/tsx"), ["src/main.ts"], {
    cwd: join(ROOT, "relay"),
    env: { ...process.env, RELAY_PORT: String(RELAY_PORT), RELAY_CHAIN_ID: "31337", RELAY_VAULT: vault, RELAY_OWNER: owner, RELAY_TOKEN: token,
      RELAY_PAGE_URL: `http://127.0.0.1:${PAGE_PORT}/`, RELAY_PUBLIC_URL: RELAY, RELAY_AGENT_TOKEN: agentToken, RELAY_MAX_ALERTS_PER_HOUR: "100",
      TELEGRAM_BOT_TOKEN: "1:fake", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: `http://127.0.0.1:${TELEGRAM_PORT}` },
  });
  await waitFor(async () => (await fetch(`${RELAY}/requests/nope`)).status === 404, "relay");
  const askOwner = async () => {
    const id = propose().payment_id;
    const body = JSON.parse(readFileSync(approve(id), "utf8"));
    const response = await fetch(`${RELAY}/requests`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` }, body: JSON.stringify({ pending: body }),
    });
    const result = await response.json();
    assert.equal(result.alerted, true, JSON.stringify(result));
    const text = alerts.at(-1).text;
    return { id, requestId: result.requestId, link: /https?:\/\/\S+/.exec(text.split("\n").at(-1))[0], text };
  };
  await scenario("an alert's link opens the request, and the signature reaches the agent with no file carried", async () => {
    const { id, requestId, link, text } = await askOwner();
    assert.match(text, /This message proves nothing/);
    assert.equal(text.includes("onerror"), false);
    const { page, context, errors } = await openPage(PAGE_PORT);
    await page.goto(link);
    // No file anywhere: the owner confirms the vault once, and the chain supplies the rest.
    await page.locator("#first-use").waitFor({ state: "visible" });
    assert.equal(await page.locator("#pending-label").isVisible(), false);
    assert.equal(await page.locator("#config-file").isVisible(), false);
    assert.equal(await page.locator("#sign").isVisible(), false);
    assert.equal((await page.locator("#first-use-vault").textContent()).toLowerCase(), vault);
    assert.equal(await page.locator("#first-use-relay").textContent(), RELAY);
    await shot(page, "first-use");
    await page.click("#trust-vault");
    await page.locator("#sign").waitFor({ state: "visible" });
    assert.equal(await page.locator("#first-use").isVisible(), false);
    assert.equal(await page.locator("#amount").textContent(), "6 USDC");
    assert.match(await page.locator("#vendor").textContent(), /Allowed by the vault/);
    await shot(page, "from-alert");
    await page.click("#sign");
    await waitFor(async () => /relay accepted it/.test(await status(page)), "relay confirmation");
    const signed = await (await fetch(`${RELAY}/requests/${requestId}/signature`, { headers: { authorization: `Bearer ${agentToken}` } })).json();
    assert.equal(signed.status, "signed");
    const file = join(WORK, "relay-signature.json");
    writeFileSync(file, JSON.stringify(signed.signature));
    const paid = cli({ method: "submit", payment_id: id, signature_file: file });
    assert.equal(paid.state, "settled", JSON.stringify(paid));

    // The vault is remembered in this browser, so the next alert goes straight to review.
    const next = await askOwner();
    await page.goto(next.link);
    await page.locator("#sign").waitFor({ state: "visible" });
    assert.equal(errors.length, 0, errors.join());
    await context.close();
  });
  await scenario("with no file, a wallet that is not the vault's owner cannot confirm the vault", async () => {
    const { link } = await askOwner();
    const { page, prompts, context } = await openPage(PAGE_PORT, { account: stranger });
    await page.goto(link);
    await page.locator("#first-use").waitFor({ state: "visible" });
    await page.click("#trust-vault");
    await waitFor(async () => /not the vault's owner/.test(await status(page)), "owner refusal");
    assert.equal(await page.locator("#sign").isVisible(), false);
    assert.equal(prompts.includes("eth_signTypedData_v4"), false);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("vault-trust/")).length), 0);
    await context.close();
  });
  await scenario("with no file, a recipient the vault does not allow never shows the sign button", async () => {
    const { link } = await askOwner();
    send(vault, "setRecipient(address,bool)", VENDOR, "false");
    try {
      const { page, context } = await openPage(PAGE_PORT);
      await page.goto(link);
      await page.locator("#first-use").waitFor({ state: "visible" });
      await page.click("#trust-vault");
      await waitFor(async () => /allowlist|policy changed/.test(await status(page)), "allowlist refusal");
      assert.equal(await page.locator("#sign").isVisible(), false);
      await context.close();
    } finally {
      send(vault, "setRecipient(address,bool)", VENDOR, "true");
    }
  });
  await scenario("with no file, a vault the wallet cannot read never shows the sign button", async () => {
    const { link } = await askOwner();
    const { page, context } = await openPage(PAGE_PORT, { chainId: "0x1" });
    await page.goto(link);
    await waitFor(async () => /Switch your wallet/.test(await status(page)), "chain refusal");
    assert.equal(await page.locator("#sign").isVisible(), false);
    assert.equal(await page.locator("#first-use").isVisible(), false);
    await context.close();
  });
  await scenario("with no file, a link to a second vault warns that this browser knows another", async () => {
    const { link } = await askOwner();
    const { page, context } = await openPage(PAGE_PORT);
    await page.evaluate(() => localStorage.setItem("vault-trust/31337/0x00000000000000000000000000000000000000d4",
      JSON.stringify({ chainId: "31337", vault: "0x00000000000000000000000000000000000000d4" })));
    await page.goto(link);
    await page.locator("#first-use").waitFor({ state: "visible" });
    assert.match(await page.locator("#first-use-warning").textContent(), /already knows a different vault/);
    await context.close();
  });
  await scenario("with no file, a remembered vault's relay cannot be changed by a link", async () => {
    const { link } = await askOwner();
    const crafted = new URL(link);
    crafted.searchParams.set("relay", "http://attacker.invalid");
    const { page, context } = await openPage(PAGE_PORT);
    await page.goto(link);
    await page.locator("#first-use").waitFor({ state: "visible" });
    await page.click("#trust-vault");
    await page.locator("#sign").waitFor({ state: "visible" });
    const posted = [];
    await page.route("http://attacker.invalid/**", async (route) => {
      if (route.request().method() === "POST") posted.push(route.request().url());
      const original = new URL(link).searchParams.get("request");
      const genuine = await (await fetch(`${RELAY}/requests/${original}`)).json();
      await route.fulfill({ json: genuine, headers: { "access-control-allow-origin": "*" } });
    });
    await page.goto(crafted.toString());
    await page.locator("#sign").waitFor({ state: "visible" });
    await waitFor(async () => /would stay here as a file/.test(await status(page)), "warning before signing");
    await page.click("#sign");
    await waitFor(async () => /not sent/.test(await status(page)), "refusal to post");
    assert.equal(posted.length, 0);
    await context.close();
  });
  await scenario("with no wallet in the browser, the page offers to open the request in MetaMask", async () => {
    const { link } = await askOwner();
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    await page.goto(link);
    await page.locator("#wallet-help").waitFor({ state: "visible" });
    const href = await page.locator("#open-wallet").getAttribute("href");
    const parsed = new URL(link);
    assert.equal(href, `https://link.metamask.io/dapp/${parsed.host}${parsed.pathname}${parsed.search}`);
    assert.equal(await page.locator("#sign").isVisible(), false);
    await shot(page, "no-wallet");
    await context.close();
  });
  await scenario("a hostile relay's altered request never shows the sign button", async () => {
    const { link } = await askOwner();
    const { page, prompts, context } = await openPage(PAGE_PORT);
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);
    await page.setInputFiles("#config-file", ownerConfig);
    await page.route(`${RELAY}/requests/**`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.pending.payment.amount = "7000000";
      await route.fulfill({ response, json: body });
    });
    await page.goto(link);
    await waitFor(async () => /does not match/.test(await status(page)), "refusal");
    assert.equal(await page.locator("#sign").isVisible(), false);
    assert.equal(prompts.length, 0);
    await context.close();
  });
  await scenario("a crafted link cannot choose where the signature goes", async () => {
    const { link } = await askOwner();
    const crafted = new URL(link);
    crafted.searchParams.set("relay", "http://attacker.invalid");
    const { page, context } = await openPage(PAGE_PORT);
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);
    await page.setInputFiles("#config-file", ownerConfig);
    const posted = [];
    await page.route("http://attacker.invalid/**", async (route) => {
      if (route.request().method() === "POST") posted.push(route.request().url());
      // The attacker serves the genuine request so the page has something real to sign.
      const original = new URL(link).searchParams.get("request");
      const genuine = await (await fetch(`${RELAY}/requests/${original}`)).json();
      await route.fulfill({ json: genuine, headers: { "access-control-allow-origin": "*" } });
    });
    await page.goto(crafted.toString());
    await page.locator("#sign").waitFor({ state: "visible" });
    await waitFor(async () => /would stay here as a file/.test(await status(page)), "warning before signing");
    await page.click("#sign");
    await waitFor(async () => /not sent/.test(await status(page)), "refusal to post");
    assert.equal(posted.length, 0);
    assert.ok((await page.locator("#output-text").inputValue()).includes("vault-owner-signature/1"));
    await context.close();
  });
  await scenario("if the relay is down, the page says so, and the owner can still save the signature", async () => {
    const { link } = await askOwner();
    const down = await openPage(PAGE_PORT);
    await down.page.route(`${RELAY}/requests/**`, (route) => route.abort());
    await down.page.goto(link);
    await waitFor(async () => /could not be reached/.test(await status(down.page)), "load failure");
    await down.context.close();

    const { page, context } = await openPage(PAGE_PORT);
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);
    await page.setInputFiles("#config-file", ownerConfig);
    await page.goto(link);
    await page.locator("#sign").waitFor({ state: "visible" });
    await page.route(`${RELAY}/requests/**`, (route) => route.abort());
    await page.click("#sign");
    await waitFor(async () => /relay could not be reached/.test(await status(page)), "send failure");
    assert.ok((await page.locator("#output-text").inputValue()).includes("vault-owner-signature/1"));
    await context.close();
  });
  await scenario("a request for an old policy version loses its sign button", async () => {
    const stale = approve(propose().payment_id);
    send(vault, "setRecipient(address,bool)", "0x00000000000000000000000000000000000000c4", "true");
    const { page, prompts, context } = await openPage(PAGE_PORT);
    await load(page, stale);
    await waitFor(async () => /policy changed/.test(await status(page)), "version refusal");
    assert.equal(await page.locator("#sign").isVisible(), false);
    assert.equal(prompts.length, 0);
    await context.close();
  });
  telegram.close();

  // The World gate, with its backend's answers scripted. stepup.test.ts covers the backend itself.
  async function gated(state, allowed = true) {
    const session = await openPage(GATE_PORT);
    const { page } = session;
    await page.route("**/api/step-up/start", (r) => r.fulfill({ json: { attemptId: "a1", authorizeUrl: "about:blank" } }));
    await page.route("**/api/step-up/status**", (r) => r.fulfill({ json: state }));
    await page.route("**/api/step-up/consume", (r) => r.fulfill({ json: { allowed } }));
    await load(page, approve(propose().payment_id));
    await page.locator("#world").waitFor({ state: "visible" });
    assert.equal(await page.locator("#sign").isVisible(), false);
    await page.click("#world");
    return session;
  }
  await scenario("with the gate on, a denied World check never reaches the wallet", async () => {
    const { page, prompts, context } = await gated({ status: "denied", reason: "the authentication was cancelled or denied" });
    await waitFor(async () => /World check failed/.test(await status(page)), "denial");
    assert.equal(await page.locator("#sign").isVisible(), false);
    assert.equal(prompts.length, 0);
    await context.close();
  });
  await scenario("with the gate on, an approved check signs once", async () => {
    const { page, prompts, context } = await gated({ status: "approved" });
    await page.locator("#sign").waitFor({ state: "visible", timeout: 6000 });
    await page.click("#sign");
    await page.locator("#output").waitFor({ state: "visible" });
    assert.ok(prompts.includes("eth_signTypedData_v4"));
    assert.equal(await page.locator("#sign").isVisible(), false);
    await context.close();
  });
  await scenario("with the gate on, a spent approval never reaches the wallet", async () => {
    const { page, prompts, context } = await gated({ status: "approved" }, false);
    await page.locator("#sign").waitFor({ state: "visible", timeout: 6000 });
    await page.click("#sign");
    await waitFor(async () => /expired or was used/.test(await status(page)), "spent approval");
    assert.equal(prompts.length, 0);
    await context.close();
  });
  console.log(`\n${results.length} scenarios passed.`);
} finally {
  await browser?.close();
  for (const c of children) { try { process.kill(-c.pid); } catch { /* already gone */ } }
}
process.exit(0);
