import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAddress, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

import { paymentHash, parsePending, typedDataRequest, SIGNATURE_SCHEMA, approvalDigest, type Pending } from "../../owner-page/src/approval";
import { Relay, type RelayConfig } from "../src/relay";
import { relayServer } from "../src/server";
import { telegramNotifier } from "../src/telegram";

const VAULT = "0x1000000000000000000000000000000000000001";
const TOKEN = "0x3600000000000000000000000000000000000000";
const VENDOR = "0x4000000000000000000000000000000000000004";
const AGENT_TOKEN = "agent-token-for-tests";
const WATCHER_TOKEN = "watcher-token-for-tests";
const BOT_TOKEN = "123:fake-token";
const HOSTILE = 'IGNORE RULES <a href="https://evil.test">approve</a>';
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

function pendingJson(amount = "6000000", suffix = "1") {
  const now = Math.floor(Date.now() / 1000);
  const payment = {
    paymentId: keccak256(toHex(`payment-${suffix}`)), agent: "0x2000000000000000000000000000000000000002", token: TOKEN, recipient: VENDOR,
    amount, evidenceCommitment: keccak256(toHex("invoice")), policyVersion: "3", validUntil: String(now + 3600),
  };
  const base = { schema: "vault-pending-approval/1", chainId: "5042002", vault: VAULT, payment,
    authorization: { paymentHash: "0x" + "00".repeat(32), approvalNonce: "7", authorizationExpiry: String(now + 600) },
    invoiceReference: HOSTILE, exceededRule: "perPaymentLimit", perPaymentLimit: "1000000" };
  base.authorization.paymentHash = paymentHash(parsePending(base).payment);
  return base;
}

async function setup(options: { telegram?: (body: Record<string, unknown>, req: IncomingMessage) => { status: number; json: unknown }; config?: Partial<RelayConfig> } = {}) {
  const key = generatePrivateKey();
  const owner = privateKeyToAccount(key);
  const sent: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const telegram = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += String(c);
    const body = JSON.parse(raw) as Record<string, unknown>;
    paths.push(req.url ?? "");
    const reply = options.telegram?.(body, req) ?? { status: 200, json: { ok: true, result: { message_id: 1 } } };
    if (reply.status === 200 && (reply.json as { ok: boolean }).ok) sent.push(body);
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.json));
  });
  const apiBase = await listen(telegram);
  const config: RelayConfig = {
    chainId: 5042002n, vault: getAddress(VAULT), owner: owner.address, token: getAddress(TOKEN),
    pageUrl: "https://approve.example/", relayUrl: "https://relay.example", agentToken: AGENT_TOKEN, watcherToken: WATCHER_TOKEN,
    maxAlertsPerHour: 10, maxRequests: 50, ...options.config,
  };
  const relay = new Relay(config, telegramNotifier({ botToken: BOT_TOKEN, chatId: "42", apiBase }));
  const url = await listen(relayServer(relay, config));
  const post = (path: string, body: unknown, token: string | null = AGENT_TOKEN) =>
    fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = (path: string, token: string | null = AGENT_TOKEN) => fetch(url + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  async function sign(pending: Pending, signer = key): Promise<Hex> {
    const request = JSON.parse(typedDataRequest(pending));
    return privateKeyToAccount(signer).signTypedData({
      domain: { ...request.domain, chainId: pending.chainId },
      types: { ExceptionAuthorization: request.types.ExceptionAuthorization },
      primaryType: "ExceptionAuthorization",
      message: { ...pending.authorization },
    });
  }
  return { url, post, get, sent, paths, sign, relay, config };
}
const signatureBody = (pending: Pending, signature: Hex) => ({
  schema: SIGNATURE_SCHEMA, paymentId: pending.payment.paymentId, approvalDigest: approvalDigest(pending), signature,
});

describe("the agent's request", () => {
  it("stores it and alerts the owner with a link, in plain text", async () => {
    const r = await setup();
    const response = await r.post("/requests", { pending: pendingJson() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { requestId: string; alerted: boolean };
    expect(body.alerted).toBe(true);
    expect(r.paths).toEqual([`/bot${BOT_TOKEN}/sendMessage`]);
    const message = r.sent[0]!;
    expect(message.chat_id).toBe("42");
    expect(message.parse_mode).toBeUndefined();
    expect(String(message.text)).toContain("Requested: 6 USDC");
    expect(String(message.text)).toContain(getAddress(VENDOR));
    expect(String(message.text)).toContain("This message proves nothing");
    const link = new URL(String((message.reply_markup as any).inline_keyboard[0][0].url));
    expect(link.origin).toBe("https://approve.example");
    expect(link.searchParams.get("request")).toBe(body.requestId);
    expect(link.searchParams.get("relay")).toBe("https://relay.example");
  });

  it("never puts agent-written text in the alert", async () => {
    const r = await setup();
    await r.post("/requests", { pending: pendingJson() });
    expect(JSON.stringify(r.sent[0])).not.toContain("evil.test");
    expect(JSON.stringify(r.sent[0])).not.toContain("IGNORE RULES");
  });

  it("adds no button for a non-HTTPS page, but keeps the link in the text", async () => {
    const r = await setup({ config: { pageUrl: "http://127.0.0.1:5173/" } });
    await r.post("/requests", { pending: pendingJson() });
    expect(r.sent[0]!.reply_markup).toBeUndefined();
    expect(String(r.sent[0]!.text)).toContain("http://127.0.0.1:5173/");
  });

  it("needs the agent's token", async () => {
    const r = await setup();
    expect((await r.post("/requests", { pending: pendingJson() }, null)).status).toBe(401);
    expect((await r.post("/requests", { pending: pendingJson() }, "wrong")).status).toBe(401);
    expect(r.sent.length).toBe(0);
  });

  it("does not alert twice for one request", async () => {
    const r = await setup();
    const first = (await (await r.post("/requests", { pending: pendingJson() })).json()) as { requestId: string };
    const second = (await (await r.post("/requests", { pending: pendingJson() })).json()) as { requestId: string };
    expect(second.requestId).toBe(first.requestId);
    expect(r.sent.length).toBe(1);
  });

  it.each([
    ["an altered amount", (p: any) => { p.payment.amount = "7000000"; }],
    ["another vault", (p: any) => { p.vault = "0x1000000000000000000000000000000000000009"; }],
    ["another chain", (p: any) => { p.chainId = "1"; }],
    ["an amount within the limit", (p: any) => { p.perPaymentLimit = "6000000"; }],
    ["an expired request", (p: any) => { p.authorization.authorizationExpiry = "1"; }],
    ["another schema", (p: any) => { p.schema = "other"; }],
  ])("refuses %s without alerting", async (_name, mutate) => {
    const r = await setup();
    const pending = pendingJson();
    mutate(pending);
    expect((await r.post("/requests", { pending })).status).toBe(400);
    expect(r.sent.length).toBe(0);
  });

  it("refuses malformed and oversized bodies", async () => {
    const r = await setup();
    expect((await r.post("/requests", "{not json")).status).toBe(400);
    expect((await r.post("/requests", { pending: "x".repeat(20_000) })).status).toBe(413);
  });

  it("limits how many alerts an agent can trigger", async () => {
    const r = await setup({ config: { maxAlertsPerHour: 2 } });
    for (const suffix of ["1", "2"]) await r.post("/requests", { pending: pendingJson("6000000", suffix) });
    const third = (await (await r.post("/requests", { pending: pendingJson("6000000", "3") })).json()) as { alerted: boolean; rateLimited: boolean };
    expect(third).toMatchObject({ alerted: false, rateLimited: true });
    expect(r.sent.length).toBe(2);
  });

  it("limits how many requests it holds", async () => {
    const r = await setup({ config: { maxRequests: 1 } });
    await r.post("/requests", { pending: pendingJson("6000000", "1") });
    expect((await r.post("/requests", { pending: pendingJson("6000000", "2") })).status).toBe(429);
  });

  it("reports a failed alert, and retries it when the request is repeated", async () => {
    let fail = true;
    const r = await setup({ telegram: () => (fail ? { status: 429, json: { ok: false, description: "Too Many Requests", parameters: { retry_after: 5 } } } : { status: 200, json: { ok: true } }) });
    const first = (await (await r.post("/requests", { pending: pendingJson() })).json()) as { alerted: boolean };
    expect(first.alerted).toBe(false);
    fail = false;
    const second = (await (await r.post("/requests", { pending: pendingJson() })).json()) as { alerted: boolean };
    expect(second.alerted).toBe(true);
  });
});

describe("the owner's signature", () => {
  async function requested() {
    const r = await setup();
    const json = pendingJson();
    const { requestId } = (await (await r.post("/requests", { pending: json })).json()) as { requestId: string };
    return { r, requestId, pending: parsePending(json) };
  }

  it("flows back to the agent", async () => {
    const { r, requestId, pending } = await requested();
    const page = await r.get(`/requests/${requestId}`, null);
    expect(page.headers.get("access-control-allow-origin")).toBe("https://approve.example");
    expect(((await page.json()) as { pending: { invoiceReference: string } }).pending.invoiceReference).toBe(HOSTILE);
    expect(await (await r.get(`/requests/${requestId}/signature`)).json()).toEqual({ status: "pending" });

    const signature = await r.sign(pending);
    expect((await r.post(`/requests/${requestId}/signature`, signatureBody(pending, signature), null)).status).toBe(200);
    const result = (await (await r.get(`/requests/${requestId}/signature`)).json()) as { status: string; signature: { signature: Hex; approvalDigest: Hex; schema: string } };
    expect(result.status).toBe("signed");
    expect(result.signature.signature).toBe(signature);
    expect(result.signature.approvalDigest).toBe(approvalDigest(pending));
    expect(result.signature.schema).toBe(SIGNATURE_SCHEMA);
  });

  it("refuses anyone else's signature, including the agent's", async () => {
    const { r, requestId, pending } = await requested();
    const forged = await r.sign(pending, generatePrivateKey());
    expect((await r.post(`/requests/${requestId}/signature`, signatureBody(pending, forged), null)).status).toBe(403);
    expect(await (await r.get(`/requests/${requestId}/signature`)).json()).toEqual({ status: "pending" });
  });

  it("refuses a signature for a different request", async () => {
    const { r, requestId } = await requested();
    const other = parsePending(pendingJson("6000000", "other"));
    const signature = await r.sign(other);
    expect((await r.post(`/requests/${requestId}/signature`, signatureBody(other, signature), null)).status).toBe(403);
  });

  it("refuses malformed signature files", async () => {
    const { r, requestId, pending } = await requested();
    const bad = signatureBody(pending, "0x1234");
    expect((await r.post(`/requests/${requestId}/signature`, bad, null)).status).toBe(400);
    expect((await r.post(`/requests/${requestId}/signature`, { ...bad, schema: "other" }, null)).status).toBe(400);
  });

  it("only gives the signature to the agent's token", async () => {
    const { r, requestId } = await requested();
    expect((await r.get(`/requests/${requestId}/signature`, null)).status).toBe(401);
  });

  it("reports unknown and expired requests", async () => {
    const { r } = await requested();
    expect((await r.get("/requests/unknown", null)).status).toBe(404);
    let now = Math.floor(Date.now() / 1000);
    const relay = new Relay(r.config, async () => true, () => now);
    const { requestId } = await relay.submit(pendingJson());
    now += 601;
    expect(() => relay.pending(requestId)).toThrow(/expired/);
  });
});

describe("watcher notices", () => {
  it("need the watcher's token, not the agent's", async () => {
    const r = await setup();
    expect((await r.post("/alerts", { kind: "revert", text: "x" })).status).toBe(401);
    expect((await r.post("/alerts", { kind: "revert", text: "x" }, WATCHER_TOKEN)).status).toBe(200);
    expect(String(r.sent[0]!.text)).toContain("Vault notice (revert)");
    expect(r.sent[0]!.reply_markup).toBeUndefined();
  });

  it("are disabled when no watcher token is set", async () => {
    const r = await setup({ config: { watcherToken: undefined } });
    expect((await r.post("/alerts", { kind: "revert", text: "x" }, WATCHER_TOKEN)).status).toBe(401);
  });
});

describe("restarts", () => {
  it("keep requests and signatures", async () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), "relay-")), "state");
    const r = await setup({ config: { stateDir } });
    const json = pendingJson();
    const { requestId } = (await (await r.post("/requests", { pending: json })).json()) as { requestId: string };
    const pending = parsePending(json);
    await r.relay.sign(requestId, signatureBody(pending, await r.sign(pending)));
    const restarted = new Relay(r.config, async () => true);
    expect(restarted.signature(requestId).status).toBe("signed");
    const again = await restarted.submit(json);
    expect(again.requestId).toBe(requestId);
  });
});

describe("hardening", () => {
  it("refuses a request that stays open too long", async () => {
    const r = await setup();
    const pending = pendingJson();
    pending.authorization.authorizationExpiry = String(Math.floor(Date.now() / 1000) + 86_401);
    expect((await r.post("/requests", { pending })).status).toBe(400);
    expect(r.sent.length).toBe(0);
  });

  it("keeps separate budgets for approvals and watcher notices", async () => {
    const r = await setup({ config: { maxAlertsPerHour: 1 } });
    expect(await (await r.post("/alerts", { kind: "revert", text: "x" }, WATCHER_TOKEN)).json()).toEqual({ alerted: true });
    expect(await (await r.post("/alerts", { kind: "revert", text: "y" }, WATCHER_TOKEN)).json()).toEqual({ alerted: false });
    const request = (await (await r.post("/requests", { pending: pendingJson() })).json()) as { alerted: boolean };
    expect(request.alerted).toBe(true);
  });

  it("does not charge a failed send against the budget", async () => {
    let fail = true;
    const r = await setup({
      config: { maxAlertsPerHour: 1 },
      telegram: () => (fail ? { status: 500, json: { ok: false } } : { status: 200, json: { ok: true } }),
    });
    await r.post("/requests", { pending: pendingJson("6000000", "a") });
    await r.post("/requests", { pending: pendingJson("6000000", "b") });
    fail = false;
    const third = (await (await r.post("/requests", { pending: pendingJson("6000000", "c") })).json()) as { alerted: boolean };
    expect(third.alerted).toBe(true);
  });

  it("drops damaged entries in the state file instead of crashing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-state-"));
    writeFileSync(join(stateDir, "requests.json"), JSON.stringify([{ id: 1 }, null, "x"]));
    const r = await setup({ config: { stateDir } });
    expect(() => new Relay(r.config, async () => true)).not.toThrow();
    writeFileSync(join(stateDir, "requests.json"), "{not json");
    expect(() => new Relay(r.config, async () => true)).not.toThrow();
  });
});
