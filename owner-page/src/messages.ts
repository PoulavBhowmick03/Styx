// The exact text a wallet signs to link Telegram or register an agent. The relay and the pages must agree.

import type { Address } from "viem";

export const linkMessage = (wallet: Address, issuedAt: number): string =>
  ["Link this wallet to Styx alerts", `Wallet: ${wallet}`, `Issued: ${issuedAt}`].join("\n");

/** Signing from the bot's own button: the code ties the signature to the Telegram chat that asked. */
export const claimMessage = (wallet: Address, issuedAt: number, code: string): string =>
  ["Link this wallet to Styx alerts", `Wallet: ${wallet}`, `Issued: ${issuedAt}`, `Telegram code: ${code}`].join("\n");

export const registerMessage = (chainId: bigint, vault: Address, agent: Address, approver: Address, issuedAt: number): string =>
  ["Register a Styx agent", `Chain: ${chainId}`, `Vault: ${vault}`, `Agent: ${agent}`, `Approver: ${approver}`, `Issued: ${issuedAt}`].join("\n");

/** A signed message older than this is refused, so an old signature cannot be replayed later. */
export const MESSAGE_LIFETIME_SECONDS = 600;
