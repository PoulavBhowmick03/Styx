// The guided path for one person, and the agent registration both paths share. Pure logic only, so it can be tested
// without a page. The relay's API is: GET /links/<wallet> and POST /agents/register.
import { getAddress, isAddress } from "viem";

import { parseUsdc } from "./amounts";

export type Path = "me" | "team" | undefined;

/** `?path=me` or `?path=team`; anything else is no choice yet. */
export function pathFromSearch(search: string): Path {
  const value = new URLSearchParams(search).get("path");
  return value === "me" || value === "team" ? value : undefined;
}

/** Defaults offered in plain words. The vault's cap starts equal to the daily figure. */
export const DEFAULTS = { perPayment: "1", daily: "10", days: "7" } as const;

export interface StepInput {
  walletOnArc: boolean;
  /** A vault this wallet owns, built from the repository's code, was found on the chain. */
  vaultReady: boolean;
  /** The agent address is known: typed in, or already configured on the vault. */
  agentKnown: boolean;
  /** The agent is switched on, inside its window, with limits above zero. */
  agentLimitsSet: boolean;
  /** The vault's own daily cap is above zero. */
  capSet: boolean;
  vendorCount: number;
  vaultTokens: bigint;
  /** null when the relay could not be asked. */
  linked: boolean | null;
  alertsSkipped: boolean;
  /** The agent was connected during this visit. The chain cannot say, so a reload starts it again. */
  agentConnected: boolean;
}

export interface Step {
  id: number;
  title: string;
  done: boolean;
  /** The first step that is not done. */
  current: boolean;
}

export const STEP_TITLES = [
  "Connect your wallet",
  "Create your vault",
  "Name your agent",
  "Set the limits",
  "Allow your first vendor",
  "Fund the vault",
  "Phone alerts",
  "Connect the agent",
] as const;

/** Each step is done only when the chain (or the relay) says so, never because it was clicked past. */
export function stepStates(input: StepInput): Step[] {
  const done = [
    input.walletOnArc,
    input.vaultReady,
    input.agentKnown,
    input.agentLimitsSet && input.capSet,
    input.vendorCount > 0,
    input.vaultTokens > 0n,
    input.linked === true || input.alertsSkipped,
    input.agentConnected,
  ];
  // A later step is never done while an earlier one is not: the vault, for one, has to exist first.
  let firstOpen = done.findIndex((d) => !d);
  if (firstOpen === -1) firstOpen = done.length;
  return STEP_TITLES.map((title, index) => ({ id: index + 1, title, done: index < firstOpen, current: index === firstOpen }));
}

export interface LimitsProblem {
  message: string;
}

/** Turns the three plain-word fields into numbers, or says what is wrong. Amounts are never floats. */
export function parseLimits(perPayment: string, daily: string, days: string): { per: bigint; daily: bigint; days: number } | LimitsProblem {
  let per: bigint, day: bigint;
  try {
    per = parseUsdc(perPayment);
    day = parseUsdc(daily);
  } catch {
    return { message: "Enter amounts like 1 or 0.25." };
  }
  if (per === 0n || day === 0n) return { message: "Limits must be above zero." };
  if (per > day) return { message: "The most per payment cannot be above the most per day." };
  if (!/^[1-9][0-9]{0,3}$/.test(days.trim())) return { message: "Days must be a whole number from 1 to 9999." };
  return { per, daily: day, days: Number(days.trim()) };
}
export const isLimitsProblem = (value: unknown): value is LimitsProblem => typeof value === "object" && value !== null && "message" in value;

/** The agent's address, checked the way the vault will: not zero, not the owner, a real address. */
export function agentAddressProblem(input: string, owner: string): string | undefined {
  const value = input.trim();
  if (!isAddress(value, { strict: false })) return "That is not an address. It starts with 0x and has 40 more characters.";
  if (/^0x0{40}$/i.test(value)) return "The zero address cannot be an agent.";
  if (value.toLowerCase() === owner.toLowerCase()) return "That is your own wallet. The agent needs its own key on its own machine: use the address scripts/agent_setup.sh prints.";
  return undefined;
}

// ---- Registering an agent with the relay ----

/** The exact text the owner signs: these lines joined by a newline, with no trailing newline. */
export function registrationMessage(input: { chainId: number | string; vault: string; agent: string; approver: string; issuedAt: number | string }): string {
  return [
    "Register a Styx agent",
    `Chain: ${input.chainId}`,
    `Vault: ${getAddress(input.vault)}`,
    `Agent: ${getAddress(input.agent)}`,
    `Approver: ${getAddress(input.approver)}`,
    `Issued: ${input.issuedAt}`,
  ].join("\n");
}

export interface Registered {
  token: string;
  relay: string;
}

export class RelayError extends Error {}

async function relayJson(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RelayError(`The relay answered with something unreadable (HTTP ${response.status}).`);
  }
  if (typeof body !== "object" || body === null) throw new RelayError("The relay answered with something unexpected.");
  const record = body as Record<string, unknown>;
  if (!response.ok || typeof record.error === "string") throw new RelayError(typeof record.error === "string" ? record.error : `The relay refused (HTTP ${response.status}).`);
  return record;
}

/** Whether a wallet has linked Telegram, or null when the relay cannot be reached. Never throws. */
export async function fetchLinked(relay: string, wallet: string, fetcher: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const body = await relayJson(await fetcher(`${relay}/links/${getAddress(wallet)}`, { cache: "no-store" }));
    return typeof body.linked === "boolean" ? body.linked : null;
  } catch {
    return null;
  }
}

/** Posts the signed registration. The token is in the response body only, never in a URL. */
export async function registerAgent(
  relay: string,
  body: { chainId: string; vault: string; agent: string; approver: string; issuedAt: number; signature: string },
  fetcher: typeof fetch = fetch,
): Promise<Registered> {
  let response: Response;
  try {
    response = await fetcher(`${relay}/agents/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  } catch {
    throw new RelayError("The relay could not be reached. Nothing was registered. Try again.");
  }
  const record = await relayJson(response);
  if (typeof record.token !== "string" || !record.token || typeof record.relay !== "string") throw new RelayError("The relay's answer had no token.");
  return { token: record.token, relay: record.relay };
}

// ---- The agent's settings ----

export interface McpInput {
  vault: string;
  codeHash: string;
  relayUrl: string;
  relayToken: string;
  chainId?: string;
  token?: string;
  rpcUrls?: string;
}

export const ARC_RPCS = "https://arc-testnet.drpc.org,https://rpc.testnet.arc.io";
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
/** Shown where the agent's own machine must supply a path: scripts/agent_setup.sh prints the real ones. */
export const AGENT_PATH_PLACEHOLDER = "/REPLACE/with/the/path/agent_setup.sh/printed";

export function mcpEnv(input: McpInput): Record<string, string> {
  return {
    STYX_BACKEND: "vault",
    STYX_VAULT_VERSION: "2",
    STYX_VAULT_CHAIN_ID: input.chainId ?? "5042002",
    STYX_VAULT_RPC_URLS: input.rpcUrls ?? ARC_RPCS,
    STYX_VAULT_ADDRESS: getAddress(input.vault),
    STYX_VAULT_TOKEN: input.token ?? ARC_USDC,
    STYX_VAULT_CODE_HASH: input.codeHash,
    STYX_VAULT_AGENT_KEY_FILE: `${AGENT_PATH_PLACEHOLDER}/agent.key`,
    STYX_VAULT_DIR: `${AGENT_PATH_PLACEHOLDER}/vault`,
    STYX_VAULT_STATE_ROOT: `${AGENT_PATH_PLACEHOLDER}/state`,
    STYX_VAULT_RELAY_URL: input.relayUrl,
    STYX_VAULT_RELAY_TOKEN: input.relayToken,
  };
}

/** The ready-to-paste block for an MCP client's configuration. */
export function mcpConfig(input: McpInput): string {
  return JSON.stringify({ mcpServers: { "styx-vault": { command: "styx-mcp-server", env: mcpEnv(input) } } }, null, 2);
}
