import { describe, expect, it, vi } from "vitest";

import { ARC_RPCS, AGENT_PATH_PLACEHOLDER, RelayError, agentAddressProblem, fetchLinked, isLimitsProblem, mcpConfig, mcpEnv, parseLimits, pathFromSearch, registerAgent, registrationMessage, stepStates, type StepInput } from "../src/guide";

const OWNER = "0xC0296012Cfbb0e6DF5dA7158B65Dbc46DD9650e0";
const AGENT = "0x00000000000000000000000000000000000000b1";
const VAULT = "0xd596e0fca7b12dc7f92c6beb3c4537fe2794aba8";
const start: StepInput = { walletOnArc: false, vaultReady: false, agentKnown: false, agentLimitsSet: false, capSet: false, vendorCount: 0, vaultTokens: 0n, linked: null, alertsSkipped: false, agentConnected: false };
const current = (i: StepInput) => stepStates(i).find((s) => s.current)?.id;

describe("which path", () => {
  it("reads only me or team", () => {
    expect(pathFromSearch("?path=me")).toBe("me");
    expect(pathFromSearch("?vault=0x1&path=team")).toBe("team");
    expect(pathFromSearch("?path=other")).toBeUndefined();
    expect(pathFromSearch("")).toBeUndefined();
  });
});

describe("the guided steps follow the chain", () => {
  it("starts at the wallet and moves one step at a time", () => {
    expect(current(start)).toBe(1);
    let i = { ...start, walletOnArc: true };
    expect(current(i)).toBe(2);
    i = { ...i, vaultReady: true };
    expect(current(i)).toBe(3);
    i = { ...i, agentKnown: true };
    expect(current(i)).toBe(4);
    i = { ...i, agentLimitsSet: true };
    expect(current(i)).toBe(4); // the vault's cap is still 0
    i = { ...i, capSet: true };
    expect(current(i)).toBe(5);
    i = { ...i, vendorCount: 1 };
    expect(current(i)).toBe(6);
    i = { ...i, vaultTokens: 1n };
    expect(current(i)).toBe(7);
    i = { ...i, linked: true };
    expect(current(i)).toBe(8);
    i = { ...i, agentConnected: true };
    expect(current(i)).toBeUndefined();
  });
  it("never shows a later step as done while an earlier one is open", () => {
    const steps = stepStates({ ...start, walletOnArc: true, vendorCount: 3, vaultTokens: 5n });
    expect(steps.map((s) => s.done)).toEqual([true, false, false, false, false, false, false, false]);
  });
  it("lets alerts be skipped, but an unreachable relay does not count as linked", () => {
    const ready = { ...start, walletOnArc: true, vaultReady: true, agentKnown: true, agentLimitsSet: true, capSet: true, vendorCount: 1, vaultTokens: 1n };
    expect(current({ ...ready, linked: null })).toBe(7);
    expect(current({ ...ready, linked: false })).toBe(7);
    expect(current({ ...ready, linked: false, alertsSkipped: true })).toBe(8);
  });
});

describe("limits in plain words", () => {
  it("parses exact amounts and days", () => {
    expect(parseLimits("1", "10", "7")).toEqual({ per: 1_000_000n, daily: 10_000_000n, days: 7 });
    expect(parseLimits("0.000001", "0.000002", "1")).toEqual({ per: 1n, daily: 2n, days: 1 });
  });
  it("refuses zero, an inverted pair, junk and bad days", () => {
    for (const bad of [parseLimits("0", "10", "7"), parseLimits("5", "1", "7"), parseLimits("abc", "10", "7"), parseLimits("1", "10", "0"), parseLimits("1", "10", "1.5"), parseLimits("1.0000001", "10", "7")]) expect(isLimitsProblem(bad)).toBe(true);
  });
  it("refuses the owner's own address, zero and junk as the agent", () => {
    expect(agentAddressProblem(OWNER.toLowerCase(), OWNER)).toMatch(/your own wallet/);
    expect(agentAddressProblem("0x0000000000000000000000000000000000000000", OWNER)).toMatch(/zero/);
    expect(agentAddressProblem("nope", OWNER)).toMatch(/not an address/);
    expect(agentAddressProblem(AGENT, OWNER)).toBeUndefined();
  });
});

describe("the registration the owner signs", () => {
  it("is exactly six lines, joined by newlines, with checksummed addresses and no trailing newline", () => {
    const message = registrationMessage({ chainId: 5042002, vault: VAULT, agent: AGENT, approver: OWNER, issuedAt: 1_800_000_000 });
    expect(message).toBe(
      [
        "Register a Styx agent",
        "Chain: 5042002",
        "Vault: 0xD596E0fCa7b12Dc7f92c6BeB3C4537FE2794aBA8",
        "Agent: 0x00000000000000000000000000000000000000B1",
        "Approver: 0xC0296012Cfbb0e6DF5dA7158B65Dbc46DD9650e0",
        "Issued: 1800000000",
      ].join("\n"),
    );
    expect(message.endsWith("\n")).toBe(false);
  });
});

describe("the relay's answers", () => {
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("reads linked, and says unknown rather than guessing", async () => {
    expect(await fetchLinked("https://r.test", OWNER, reply(200, { linked: true }))).toBe(true);
    expect(await fetchLinked("https://r.test", OWNER, reply(200, { linked: false }))).toBe(false);
    expect(await fetchLinked("https://r.test", OWNER, reply(500, { error: "down" }))).toBeNull();
    expect(await fetchLinked("https://r.test", OWNER, vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
  it("posts the registration in the body, never in the URL, and returns the token", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ token: "tok123", relay: "https://r.test" }), { status: 200 }));
    const out = await registerAgent("https://r.test", { chainId: "5042002", vault: VAULT, agent: AGENT, approver: OWNER, issuedAt: 1, signature: "0xsig" }, fetcher as unknown as typeof fetch);
    expect(out).toEqual({ token: "tok123", relay: "https://r.test" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://r.test/agents/register");
    expect(init.method).toBe("POST");
    expect(url).not.toContain("tok");
  });
  it("turns the relay's error into a message", async () => {
    await expect(registerAgent("https://r.test", { chainId: "5042002", vault: VAULT, agent: AGENT, approver: OWNER, issuedAt: 1, signature: "0x" }, reply(400, { error: "the approver is not enabled" }))).rejects.toThrow(/approver is not enabled/);
    await expect(registerAgent("https://r.test", { chainId: "1", vault: VAULT, agent: AGENT, approver: OWNER, issuedAt: 1, signature: "0x" }, vi.fn(async () => { throw new Error("x"); }) as unknown as typeof fetch)).rejects.toBeInstanceOf(RelayError);
  });
});

describe("the agent's settings", () => {
  const input = { vault: VAULT, codeHash: "0x4ed8c17d810632423c99decd2c130a16b4c3ff3bea5c4717d1b36fd0ea8512d5", relayUrl: "https://r.test", relayToken: "tok123" };
  it("carries every name the agent's tool reads", () => {
    const env = mcpEnv(input);
    expect(Object.keys(env).sort()).toEqual(
      ["STYX_BACKEND", "STYX_VAULT_ADDRESS", "STYX_VAULT_AGENT_KEY_FILE", "STYX_VAULT_CHAIN_ID", "STYX_VAULT_CODE_HASH", "STYX_VAULT_DIR", "STYX_VAULT_RELAY_TOKEN", "STYX_VAULT_RELAY_URL", "STYX_VAULT_RPC_URLS", "STYX_VAULT_STATE_ROOT", "STYX_VAULT_TOKEN", "STYX_VAULT_VERSION"].sort(),
    );
    expect(env.STYX_BACKEND).toBe("vault");
    expect(env.STYX_VAULT_VERSION).toBe("2");
    expect(env.STYX_VAULT_RPC_URLS).toBe(ARC_RPCS);
    expect(env.STYX_VAULT_TOKEN).toBe("0x3600000000000000000000000000000000000000");
    expect(env.STYX_VAULT_ADDRESS).toBe("0xD596E0fCa7b12Dc7f92c6BeB3C4537FE2794aBA8");
    expect(env.STYX_VAULT_AGENT_KEY_FILE!.startsWith(AGENT_PATH_PLACEHOLDER)).toBe(true);
  });
  it("is JSON a client can load", () => {
    const parsed = JSON.parse(mcpConfig(input));
    expect(parsed.mcpServers["styx-vault"].env.STYX_VAULT_RELAY_TOKEN).toBe("tok123");
  });
});
