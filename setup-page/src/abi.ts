import { parseAbi } from "viem";

export const vaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function agent() view returns (address)",
  "function policyVersion() view returns (uint256)",
  "function perPaymentLimit() view returns (uint256)",
  "function dailyLimit() view returns (uint256)",
  "function policyValidUntil() view returns (uint64)",
  "function paused() view returns (bool)",
  "function allowedRecipient(address) view returns (bool)",
  "function spentByDay(uint256) view returns (uint256)",
  "function configurePolicy(address newAgent, uint256 newPerPaymentLimit, uint256 newDailyLimit, uint64 validUntil)",
  "function setRecipient(address recipient, bool allowed)",
  "function pause()",
  "function unpause()",
  "function withdraw(address to, uint256 amount)",
  "event RecipientSet(uint256 indexed policyVersion, address indexed recipient, bool allowed)",
  "error NotOwner()",
  "error ZeroAddress()",
  "error TransferFailed()",
  "error Reentrancy()",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 value) returns (bool)",
]);
