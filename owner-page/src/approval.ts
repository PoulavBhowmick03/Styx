// Everything the page decides, with no DOM or wallet access, so it can be tested directly.
//
// The pending file comes from the agent's side and is untrusted. Nothing here shows a value
// from it without first tying that value to the digest the owner will sign, and vendor labels
// come only from the owner's own config file.

import {
  getAddress,
  hashStruct,
  hashTypedData,
  isAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";

export const PENDING_SCHEMA = "vault-pending-approval/1";
export const SIGNATURE_SCHEMA = "vault-owner-signature/1";
const USDC_DECIMALS = 6;

export const TYPES = {
  Payment: [
    { name: "paymentId", type: "bytes32" },
    { name: "agent", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "evidenceCommitment", type: "bytes32" },
    { name: "policyVersion", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
  ExceptionAuthorization: [
    { name: "paymentHash", type: "bytes32" },
    { name: "approvalNonce", type: "uint256" },
    { name: "authorizationExpiry", type: "uint64" },
  ],
} as const;

const SIGNING_TYPES = { ExceptionAuthorization: TYPES.ExceptionAuthorization } as const;

export interface OwnerConfig {
  chainId: bigint;
  vault: Address;
  owner: Address;
  token: Address;
  vendors: Map<Address, string>;
}

export interface Payment {
  paymentId: Hex;
  agent: Address;
  token: Address;
  recipient: Address;
  amount: bigint;
  evidenceCommitment: Hex;
  policyVersion: bigint;
  validUntil: bigint;
}

export interface Authorization {
  paymentHash: Hex;
  approvalNonce: bigint;
  authorizationExpiry: bigint;
}

export interface Pending {
  chainId: bigint;
  vault: Address;
  payment: Payment;
  authorization: Authorization;
  invoiceReference: string;
  exceededRule: string;
  perPaymentLimit: bigint;
}

export class ApprovalError extends Error {}

function fail(message: string): never {
  throw new ApprovalError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Integers arrive as canonical decimal strings, so none ever passes through a float. */
function integer(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(`${label} must be a decimal string`);
  }
  return BigInt(value);
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    fail(`${label} must be an address`);
  }
  return getAddress(value);
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail(`${label} must be 32 bytes of hex`);
  }
  return value.toLowerCase() as Hex;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be text`);
  return value;
}

export function parseOwnerConfig(input: unknown): OwnerConfig {
  const value = record(input, "owner config");
  const vendors = new Map<Address, string>();
  for (const [vendor, label] of Object.entries(record(value.vendors, "vendors"))) {
    vendors.set(address(vendor, "vendor"), text(label, "vendor label"));
  }
  return {
    chainId: integer(value.chainId, "chainId"),
    vault: address(value.vault, "vault"),
    owner: address(value.owner, "owner"),
    token: address(value.token, "token"),
    vendors,
  };
}

export function parsePending(input: unknown): Pending {
  const value = record(input, "pending file");
  if (value.schema !== PENDING_SCHEMA) fail("unsupported pending file");
  const payment = record(value.payment, "payment");
  const authorization = record(value.authorization, "authorization");
  return {
    chainId: integer(value.chainId, "chainId"),
    vault: address(value.vault, "vault"),
    payment: {
      paymentId: bytes32(payment.paymentId, "paymentId"),
      agent: address(payment.agent, "agent"),
      token: address(payment.token, "token"),
      recipient: address(payment.recipient, "recipient"),
      amount: integer(payment.amount, "amount"),
      evidenceCommitment: bytes32(payment.evidenceCommitment, "evidenceCommitment"),
      policyVersion: integer(payment.policyVersion, "policyVersion"),
      validUntil: integer(payment.validUntil, "validUntil"),
    },
    authorization: {
      paymentHash: bytes32(authorization.paymentHash, "paymentHash"),
      approvalNonce: integer(authorization.approvalNonce, "approvalNonce"),
      authorizationExpiry: integer(authorization.authorizationExpiry, "authorizationExpiry"),
    },
    invoiceReference: text(value.invoiceReference, "invoiceReference"),
    exceededRule: text(value.exceededRule, "exceededRule"),
    perPaymentLimit: integer(value.perPaymentLimit, "perPaymentLimit"),
  };
}

export function paymentHash(payment: Payment): Hex {
  return hashStruct({
    data: { ...payment },
    primaryType: "Payment",
    types: { Payment: TYPES.Payment },
  });
}

function domain(pending: Pending) {
  return {
    name: "ErebusPolicyVault",
    version: "1",
    chainId: pending.chainId,
    verifyingContract: pending.vault,
  } as const;
}

export function approvalDigest(pending: Pending): Hex {
  return hashTypedData({
    domain: domain(pending),
    types: SIGNING_TYPES,
    primaryType: "ExceptionAuthorization",
    message: pending.authorization,
  });
}

/** Formats base units exactly, using integer arithmetic only. */
export function formatUsdc(amount: bigint): string {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const fraction = (amount % scale).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${amount / scale}${fraction ? `.${fraction}` : ""} USDC`;
}

export interface ApprovalView {
  vault: Address;
  vendorLabel: string;
  recipient: Address;
  amount: string;
  invoiceReference: string;
  expiresAt: string;
  exceededRule: string;
  digest: Hex;
}

/**
 * Checks a pending file against the owner's config and the current time, and returns what to
 * show. Throwing here means the sign button never appears.
 */
export function reviewPending(pending: Pending, config: OwnerConfig, nowSeconds: bigint): ApprovalView {
  if (pending.chainId !== config.chainId) fail("this approval is for another chain");
  if (pending.vault !== config.vault) fail("this approval is for another vault");
  if (pending.payment.token !== config.token) fail("this approval is for another token");
  if (paymentHash(pending.payment) !== pending.authorization.paymentHash) {
    fail("the authorization does not match the payment shown");
  }
  const vendorLabel = config.vendors.get(pending.payment.recipient);
  if (vendorLabel === undefined) fail("the recipient is not on your allowlist");
  if (pending.authorization.authorizationExpiry <= nowSeconds) fail("this approval has expired");
  if (pending.payment.validUntil <= nowSeconds) fail("this payment has expired");
  if (pending.exceededRule !== "perPaymentLimit") fail("unsupported exceeded rule");
  if (pending.payment.amount <= pending.perPaymentLimit) {
    fail("this amount does not exceed the limit the file states");
  }
  return {
    vault: pending.vault,
    vendorLabel,
    recipient: pending.payment.recipient,
    amount: formatUsdc(pending.payment.amount),
    invoiceReference: pending.invoiceReference,
    expiresAt: new Date(Number(pending.authorization.authorizationExpiry) * 1000).toISOString(),
    exceededRule: `Exceeds the per-payment limit of ${formatUsdc(pending.perPaymentLimit)}`,
    digest: approvalDigest(pending),
  };
}

/**
 * The exact `eth_signTypedData_v4` payload. Integers stay decimal strings, because JSON has no
 * bigint and a JavaScript number would lose precision.
 */
export function typedDataRequest(pending: Pending): string {
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...SIGNING_TYPES,
    },
    primaryType: "ExceptionAuthorization",
    domain: { ...domain(pending), chainId: pending.chainId.toString() },
    message: {
      paymentHash: pending.authorization.paymentHash,
      approvalNonce: pending.authorization.approvalNonce.toString(),
      authorizationExpiry: pending.authorization.authorizationExpiry.toString(),
    },
  });
}

/** Refuses a signature unless it recovers to the owner, so a wallet mismatch shows up here. */
export async function buildSignatureFile(
  pending: Pending,
  config: OwnerConfig,
  signature: Hex,
): Promise<string> {
  const recovered = await recoverTypedDataAddress({
    domain: domain(pending),
    types: SIGNING_TYPES,
    primaryType: "ExceptionAuthorization",
    message: pending.authorization,
    signature,
  });
  if (recovered !== config.owner) fail("the wallet's signature does not recover to the owner");
  return JSON.stringify(
    {
      schema: SIGNATURE_SCHEMA,
      paymentId: pending.payment.paymentId,
      approvalDigest: approvalDigest(pending),
      signature,
    },
    null,
    2,
  );
}

export interface RelayLink {
  relay: string;
  request: string;
}

/**
 * Reads an alert's link. The link grants nothing: whatever the relay returns still has to pass
 * `reviewPending` against the owner's own config, so a link to a hostile relay cannot change that.
 */
export function parseRelayLink(search: string): RelayLink | undefined {
  const params = new URLSearchParams(search);
  const relay = params.get("relay"), request = params.get("request");
  if (!relay || !request) return undefined;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(request)) throw new ApprovalError("this approval link is malformed");
  let url: URL;
  try {
    url = new URL(relay);
  } catch {
    throw new ApprovalError("this approval link is malformed");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ApprovalError("this approval link is malformed");
  return { relay: url.origin, request };
}
