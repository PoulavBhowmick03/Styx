import { NATIVE_PER_TOKEN_UNIT, formatUsdc } from "./amounts";

// Assumptions, from docs/mumbai/RUNBOOK.md: a payment costs about 0.01 USDC of gas, and the demo gives the
// agent about 0.3 USDC. These are guidance thresholds the owner can read, not rules the contract enforces.
export const MIN_AGENT_GAS = 50_000n; // 0.05 USDC, in 6-decimal base units
export const MAX_AGENT_GAS = 500_000n; // 0.5 USDC: above this, funds sit outside the vault

export type CheckState = "ok" | "todo" | "warn";
export interface Check {
  id: string;
  state: CheckState;
  text: string;
}

export interface Snapshot {
  owner: string;
  agent: string; // zero address when no policy has been set
  vaultTokens: bigint; // ERC-20 balance of the vault, 6 decimals
  agentTokens: bigint; // ERC-20 balance of the agent's address, 6 decimals
  agentNative: bigint; // native balance of the agent's address, 18 decimals
  /** True on Arc, where the native balance and the ERC-20 balance are one and the same money. */
  sameMoney: boolean;
  paused: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * What stands between the owner and the claim "the vault protects my agent's money".
 * The vault protects only what is inside it. Anything the agent's address holds is spendable by the agent
 * with no rule at all.
 */
export function assessProtection(s: Snapshot): Check[] {
  const checks: Check[] = [];
  checks.push(
    s.vaultTokens > 0n
      ? { id: "funded", state: "ok", text: `The vault holds ${formatUsdc(s.vaultTokens)} USDC. Only this is under your rules.` }
      : { id: "funded", state: "todo", text: "The vault is empty, so there is nothing for the rules to protect. Move USDC into it." },
  );

  if (s.agent === ZERO) {
    checks.push({ id: "agent", state: "todo", text: "No agent is set. Save a policy with the agent's address." });
    return checks;
  }
  if (same(s.agent, s.owner)) {
    checks.push({ id: "agent", state: "warn", text: "The agent address is your own address. The agent would hold your owner key, so nothing stops it. Use a separate address." });
    return checks;
  }

  if (s.agentTokens > MAX_AGENT_GAS) {
    checks.push({
      id: "agent-funds",
      state: "warn",
      text: `The agent's address holds ${formatUsdc(s.agentTokens)} USDC. The vault does not cover it: the agent can send it anywhere with no limit. Move ${formatUsdc(s.agentTokens - MAX_AGENT_GAS)} USDC or more out of that address, into the vault, leaving it gas only.`,
    });
  } else {
    checks.push({ id: "agent-funds", state: "ok", text: `The agent's address holds ${formatUsdc(s.agentTokens)} USDC, which is gas money only.` });
  }

  const gas = s.sameMoney ? s.agentTokens : s.agentNative / NATIVE_PER_TOKEN_UNIT;
  if (s.agentNative === 0n || (s.sameMoney && gas < MIN_AGENT_GAS)) {
    checks.push({ id: "agent-gas", state: "todo", text: "The agent's address has little or no gas, so its payments will fail. Send it a small amount (about 0.3 USDC is plenty for a demo)." });
  } else {
    checks.push({ id: "agent-gas", state: "ok", text: "The agent's address has gas." });
  }

  if (s.paused) checks.push({ id: "paused", state: "warn", text: "The vault is paused. The agent cannot pay anything until you unpause." });
  return checks;
}

/** True when every check passes: funded, an agent that is not the owner, gas-only, not paused. */
export function isProtected(checks: Check[]): boolean {
  return checks.length >= 3 && checks.every((c) => c.state === "ok");
}
