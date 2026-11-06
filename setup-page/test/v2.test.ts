import { describe, expect, it } from "vitest";

import { agentProblem, approverProblem, assessV2, dayOf, isLive, isReady, limitsProblem, type AgentView } from "../src/v2";

const OWNER = "0x00000000000000000000000000000000000000a0";
const AGENT = "0x00000000000000000000000000000000000000b1";
const NOW = 1_800_000_000n;
const agent = (over: Partial<AgentView> = {}): AgentView => ({ address: AGENT, version: 1n, perPaymentLimit: 1_000_000n, dailyLimit: 3_000_000n, validUntil: NOW + 86_400n, enabled: true, spentToday: 0n, held: 100_000n, ...over });
const ready = { cap: 5_000_000n, agents: [agent()], vendorCount: 1, vaultTokens: 4_000_000n, paused: false, now: NOW, partial: false };
const states = (checks: ReturnType<typeof assessV2>) => Object.fromEntries(checks.map((c) => [c.id, c.state]));

describe("what stands between the owner and an agent that can pay", () => {
  it("is ready only when the cap, an agent, a vendor and funds all exist", () => {
    expect(isReady(assessV2(ready))).toBe(true);
    for (const missing of [{ cap: 0n }, { agents: [] }, { vendorCount: 0 }, { vaultTokens: 0n }]) expect(isReady(assessV2({ ...ready, ...missing }))).toBe(false);
  });
  it("says a cap of 0 stops every agent", () => {
    const c = assessV2({ ...ready, cap: 0n }).find((x) => x.id === "cap");
    expect(c?.state).toBe("todo");
    expect(c?.text).toContain("no agent can pay anything");
  });
  it("does not count an agent that is off, expired or has a zero limit", () => {
    for (const bad of [agent({ enabled: false }), agent({ validUntil: NOW - 1n }), agent({ perPaymentLimit: 0n }), agent({ dailyLimit: 0n })]) {
      expect(states(assessV2({ ...ready, agents: [bad] })).agent).toBe("todo");
    }
  });
  it("treats an expiry equal to now as still valid, as the contract does", () => {
    expect(isLive(agent({ validUntil: NOW }), NOW)).toBe(true);
    expect(isLive(agent({ validUntil: NOW - 1n }), NOW)).toBe(false);
  });
  it("warns about an agent holding more than gas, and an agent limit above the vault cap", () => {
    const s = states(assessV2({ ...ready, agents: [agent({ held: 5_000_000n, dailyLimit: 9_000_000n })] }));
    expect(s[`held-${AGENT}`]).toBe("warn");
    expect(s[`cap-binds-${AGENT}`]).toBe("warn");
  });
  it("is not ready while paused", () => {
    expect(isReady(assessV2({ ...ready, paused: true }))).toBe(false);
  });
  it("does not blame the owner for agents it could not read, when the history was partial", () => {
    expect(assessV2({ ...ready, agents: [], partial: true }).find((c) => c.id === "agent")?.text).toContain("part of the history");
  });
});

describe("what the contract refuses, caught before the wallet is asked", () => {
  const ctx = { owner: OWNER, approvers: ["0x00000000000000000000000000000000000000d1"], agents: [AGENT] };
  it("refuses the zero address, the owner, and an approver as an agent", () => {
    expect(agentProblem("0x0000000000000000000000000000000000000000", true, ctx)).toMatch(/zero/);
    expect(agentProblem(OWNER.toUpperCase().replace("0X", "0x"), true, ctx)).toMatch(/owner cannot be an agent/);
    expect(agentProblem("0x00000000000000000000000000000000000000D1", true, ctx)).toMatch(/approver/);
    expect(agentProblem(AGENT, true, ctx)).toBeUndefined();
  });
  it("lets an approver be switched off as an agent, because only enabling conflicts", () => {
    expect(agentProblem("0x00000000000000000000000000000000000000d1", false, ctx)).toBeUndefined();
  });
  it("refuses the zero address, the owner, and a switched-on agent as an approver", () => {
    expect(approverProblem("0x0000000000000000000000000000000000000000", true, ctx)).toMatch(/zero/);
    expect(approverProblem(OWNER, true, ctx)).toMatch(/always an approver/);
    expect(approverProblem(AGENT, true, ctx)).toMatch(/switched-on agent/);
    expect(approverProblem(AGENT, false, ctx)).toBeUndefined();
  });
  it("insists on limits above zero and a per-payment limit within the daily limit", () => {
    expect(limitsProblem(0n, 1n)).toMatch(/above zero/);
    expect(limitsProblem(2n, 1n)).toMatch(/above the agent's daily limit/);
    expect(limitsProblem(1n, 1n)).toBeUndefined();
  });
  it("counts days from UTC midnight, as the contract does", () => {
    expect(dayOf(86_399n)).toBe(0n);
    expect(dayOf(86_400n)).toBe(1n);
  });
});
