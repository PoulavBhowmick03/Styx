// Version 2 of the vault: many agents, approvers, an aggregate daily cap. Pure logic only, so it can be tested
// without a page. The contract is contracts/evm/src/StyxVault.sol and its interface is written down in
// docs/mumbai/STYX_V2_INTERFACE.md.
import { parseAbi } from "viem";

import { formatUsdc } from "./amounts";
import type { Check } from "./protection";
import { MAX_AGENT_GAS } from "./protection";

export const vaultV2Abi = parseAbi([
  "function contractVersion() view returns (uint256)",
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function paused() view returns (bool)",
  "function vaultDailyLimit() view returns (uint256)",
  "function agentPolicy(address agent) view returns (uint256 version, uint256 perPaymentLimit, uint256 dailyLimit, uint64 validUntil, bool enabled)",
  "function approverState(address signer) view returns (uint256 version, bool enabled)",
  "function allowedRecipient(address) view returns (bool)",
  "function recipientVersion(address) view returns (uint256)",
  "function spentByAgentDay(address agent, uint256 day) view returns (uint256)",
  "function spentByDay(uint256 day) view returns (uint256)",
  "function configureAgent(address agent, uint256 perPaymentLimit, uint256 dailyLimit, uint64 validUntil, bool enabled)",
  "function setApprover(address approver, bool enabled)",
  "function setRecipient(address recipient, bool allowed)",
  "function setVaultDailyLimit(uint256 limit)",
  "function pause()",
  "function unpause()",
  "function withdraw(address to, uint256 amount)",
  "event AgentConfigured(address indexed agent, uint256 indexed version, uint256 perPaymentLimit, uint256 dailyLimit, uint64 validUntil, bool enabled)",
  "event ApproverSet(address indexed approver, uint256 indexed version, bool enabled)",
  "event RecipientSet(address indexed recipient, uint256 indexed version, bool allowed)",
  "event VaultDailyLimitSet(uint256 limit)",
  "error NotOwner()",
  "error ZeroAddress()",
  "error RoleConflict()",
  "error InvalidRecipient()",
  "error TransferFailed()",
  "error Reentrancy()",
]);

export interface AgentView {
  address: string;
  version: bigint;
  perPaymentLimit: bigint;
  dailyLimit: bigint;
  validUntil: bigint;
  enabled: boolean;
  /** USDC (6 decimals) the agent has paid today, UTC. */
  spentToday: bigint;
  /** USDC the agent's own address holds. On Arc that is also its gas. */
  held: bigint;
}

export interface ApproverView {
  address: string;
  version: bigint;
  enabled: boolean;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

/** True while the policy window is open. Expiry is inclusive: a time equal to it is still valid. */
export const isLive = (agent: AgentView, now: bigint) => agent.enabled && agent.validUntil >= now;

/**
 * What stands between the owner and an agent that can actually pay. Every item is something the contract checks,
 * so each one that is not "ok" is a reason a payment would be refused.
 */
export function assessV2(input: {
  cap: bigint;
  agents: AgentView[];
  vendorCount: number;
  vaultTokens: bigint;
  paused: boolean;
  now: bigint;
  partial: boolean;
}): Check[] {
  const checks: Check[] = [];
  checks.push(
    input.cap > 0n
      ? { id: "cap", state: "ok", text: `The vault's daily cap is ${formatUsdc(input.cap)} USDC.` }
      : { id: "cap", state: "todo", text: "The vault's daily cap is 0, so no agent can pay anything. Set it in A." },
  );
  const live = input.agents.filter((a) => isLive(a, input.now) && a.perPaymentLimit > 0n && a.dailyLimit > 0n);
  const switchedOn = input.agents.filter((a) => a.enabled);
  if (live.length) {
    checks.push({ id: "agent", state: "ok", text: `${live.length === 1 ? "One agent is" : `${live.length} agents are`} switched on, within their policy window, with limits above zero.` });
  } else if (switchedOn.length) {
    checks.push({ id: "agent", state: "todo", text: "Every agent that is switched on has expired or has a zero limit, so none can pay. Save the agent again in B." });
  } else {
    checks.push({ id: "agent", state: "todo", text: input.partial ? "No switched-on agent was found in the part of the history this page could read. Add one in B." : "No agent is switched on. Add one in B." });
  }
  checks.push(
    input.vendorCount > 0
      ? { id: "vendor", state: "ok", text: `${input.vendorCount} vendor${input.vendorCount === 1 ? " is" : "s are"} allowed.` }
      : { id: "vendor", state: "todo", text: "No vendor is allowed, so every payment would be refused. Allow one in Vendors." },
  );
  checks.push(
    input.vaultTokens > 0n
      ? { id: "funded", state: "ok", text: `The vault holds ${formatUsdc(input.vaultTokens)} USDC. Only this is under your rules.` }
      : { id: "funded", state: "todo", text: "The vault is empty, so there is nothing for the rules to protect. Move USDC into it." },
  );
  for (const agent of switchedOn) {
    if (agent.held > MAX_AGENT_GAS) {
      checks.push({ id: `held-${agent.address}`, state: "warn", text: `Agent ${agent.address} holds ${formatUsdc(agent.held)} USDC of its own. The vault does not cover it: that agent can send it anywhere. Leave an agent's address with gas only.` });
    }
    if (input.cap > 0n && agent.dailyLimit > input.cap) {
      checks.push({ id: `cap-binds-${agent.address}`, state: "warn", text: `Agent ${agent.address} has a daily limit of ${formatUsdc(agent.dailyLimit)} USDC, above the vault's cap of ${formatUsdc(input.cap)}. The vault's cap will bind first.` });
    }
  }
  if (input.paused) checks.push({ id: "paused", state: "warn", text: "The vault is paused. No agent can pay until you unpause." });
  return checks;
}

/** Whether a "ready" verdict is fair: nothing left to do and nothing to fix. */
export const isReady = (checks: Check[]) => checks.length >= 4 && checks.every((c) => c.state === "ok");

export interface RefusalContext {
  owner: string;
  /** Addresses that are switched-on approvers right now. */
  approvers: string[];
  /** Addresses that are switched-on agents right now. */
  agents: string[];
}

/** What the contract would refuse for `configureAgent`, found before the wallet is asked. */
export function agentProblem(agent: string, enabling: boolean, ctx: RefusalContext): string | undefined {
  if (same(agent, ZERO)) return "The agent address cannot be zero.";
  if (same(agent, ctx.owner)) return "The owner cannot be an agent: the owner would hold the key that can approve. Use a separate address.";
  if (enabling && ctx.approvers.some((a) => same(a, agent))) return "That address is an approver. An address cannot be both an agent and an approver. Remove it as an approver first.";
  return undefined;
}

/** What the contract would refuse for `setApprover`. */
export function approverProblem(approver: string, enabling: boolean, ctx: RefusalContext): string | undefined {
  if (same(approver, ZERO)) return "The approver address cannot be zero.";
  if (same(approver, ctx.owner)) return "The owner is always an approver already. Add someone else.";
  if (enabling && ctx.agents.some((a) => same(a, approver))) return "That address is a switched-on agent. An address cannot be both. Switch the agent off first.";
  return undefined;
}

/** Limits the page insists on, beyond what the contract checks. */
export function limitsProblem(perPayment: bigint, daily: bigint): string | undefined {
  if (perPayment === 0n || daily === 0n) return "Limits must be above zero. A zero limit would switch the agent off in practice. Use the off switch to do that on purpose.";
  if (perPayment > daily) return "The per-payment limit is above the agent's daily limit, so the daily limit would always bind first. Lower the per-payment limit.";
  return undefined;
}

/** Day number the contract uses for its daily counters: UTC midnight, not a rolling 24 hours. */
export const dayOf = (timestamp: bigint) => timestamp / 86_400n;
