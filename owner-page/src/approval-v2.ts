// The checks for a v2 approval, with no DOM or wallet access. v1's checks in approval.ts are separate.
//
// A v2 authorization names its signer, who may be the owner or an approver with their own wallet.
// The file comes from the agent's side and is untrusted. The vault's own answers decide what is shown.

import {
  encodeFunctionData,
  getAddress,
  hashStruct,
  hashTypedData,
  isAddress,
  parseAbi,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";

import { ApprovalError, formatUsdc } from "./approval";

export const PENDING_SCHEMA_V2 = "vault-pending-approval/2";
export const SIGNATURE_SCHEMA_V2 = "vault-approver-signature/2";
const DOMAIN_NAME = "StyxVault";
const DOMAIN_VERSION = "2";

export const TYPES_V2 = {
  Payment: [
    { name: "paymentId", type: "bytes32" },
    { name: "agent", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "evidenceCommitment", type: "bytes32" },
    { name: "policyVersion", type: "uint256" },
    { name: "recipientVersion", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
  ExceptionAuthorization: [
    { name: "paymentHash", type: "bytes32" },
    { name: "signer", type: "address" },
    { name: "signerVersion", type: "uint256" },
    { name: "approvalNonce", type: "uint256" },
    { name: "authorizationExpiry", type: "uint64" },
  ],
} as const;

const SIGNING_TYPES = { ExceptionAuthorization: TYPES_V2.ExceptionAuthorization } as const;

export interface PaymentV2 {
  paymentId: Hex;
  agent: Address;
  token: Address;
  recipient: Address;
  amount: bigint;
  evidenceCommitment: Hex;
  policyVersion: bigint;
  recipientVersion: bigint;
  validUntil: bigint;
}

export interface AuthorizationV2 {
  paymentHash: Hex;
  signer: Address;
  signerVersion: bigint;
  approvalNonce: bigint;
  authorizationExpiry: bigint;
}

export interface PendingV2 {
  chainId: bigint;
  vault: Address;
  payment: PaymentV2;
  authorization: AuthorizationV2;
  invoiceReference: string;
  exceededRule: string;
  perPaymentLimit: bigint;
}

function fail(message: string): never {
  throw new ApprovalError(message);
}

function exactly(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) fail(`${label} has the wrong fields`);
  return record;
}

const integer = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail(`${label} must be a decimal string`);
  return BigInt(value);
};
const address = (value: unknown, label: string): Address => {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) fail(`${label} must be an address`);
  return getAddress(value);
};
const bytes32 = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail(`${label} must be 32 bytes of hex`);
  return value.toLowerCase() as Hex;
};

export function isPendingV2(input: unknown): boolean {
  return typeof input === "object" && input !== null && (input as { schema?: unknown }).schema === PENDING_SCHEMA_V2;
}

export function parsePendingV2(input: unknown): PendingV2 {
  const value = exactly(
    input,
    ["schema", "chainId", "vault", "payment", "authorization", "invoiceReference", "exceededRule", "perPaymentLimit"],
    "pending file",
  );
  if (value.schema !== PENDING_SCHEMA_V2) fail("unsupported pending file");
  const payment = exactly(value.payment, TYPES_V2.Payment.map((field) => field.name), "payment");
  const authorization = exactly(
    value.authorization,
    TYPES_V2.ExceptionAuthorization.map((field) => field.name),
    "authorization",
  );
  if (typeof value.invoiceReference !== "string") fail("invoiceReference must be text");
  if (typeof value.exceededRule !== "string") fail("exceededRule must be text");
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
      recipientVersion: integer(payment.recipientVersion, "recipientVersion"),
      validUntil: integer(payment.validUntil, "validUntil"),
    },
    authorization: {
      paymentHash: bytes32(authorization.paymentHash, "paymentHash"),
      signer: address(authorization.signer, "signer"),
      signerVersion: integer(authorization.signerVersion, "signerVersion"),
      approvalNonce: integer(authorization.approvalNonce, "approvalNonce"),
      authorizationExpiry: integer(authorization.authorizationExpiry, "authorizationExpiry"),
    },
    invoiceReference: value.invoiceReference,
    exceededRule: value.exceededRule,
    perPaymentLimit: integer(value.perPaymentLimit, "perPaymentLimit"),
  };
}

const domain = (pending: { chainId: bigint; vault: Address }) =>
  ({ name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: pending.chainId, verifyingContract: pending.vault }) as const;

export function paymentHashV2(payment: PaymentV2): Hex {
  return hashStruct({ data: { ...payment }, primaryType: "Payment", types: { Payment: TYPES_V2.Payment } });
}

export function approvalDigestV2(pending: PendingV2): Hex {
  return hashTypedData({
    domain: domain(pending),
    types: SIGNING_TYPES,
    primaryType: "ExceptionAuthorization",
    message: pending.authorization,
  });
}

/** Integers stay decimal strings, because JSON has no bigint and a number would lose precision. */
export function typedDataRequestV2(pending: PendingV2): string {
  const { authorization } = pending;
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
      paymentHash: authorization.paymentHash,
      signer: authorization.signer,
      signerVersion: authorization.signerVersion.toString(),
      approvalNonce: authorization.approvalNonce.toString(),
      authorizationExpiry: authorization.authorizationExpiry.toString(),
    },
  });
}

/** Everything the page asks the vault itself before it shows a sign button. */
export interface ChainFactsV2 {
  contractVersion: bigint;
  owner: Address;
  token: Address;
  paused: boolean;
  recipientAllowed: boolean;
  recipientVersion: bigint;
  agentVersion: bigint;
  agentEnabled: boolean;
  agentPerPaymentLimit: bigint;
  agentValidUntil: bigint;
  signerEnabled: boolean;
  signerVersion: bigint;
}

const ABI = parseAbi([
  "function contractVersion() view returns (uint256)",
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function paused() view returns (bool)",
  "function allowedRecipient(address) view returns (bool)",
  "function recipientVersion(address) view returns (uint256)",
  "function agentPolicy(address) view returns (uint256 version, uint256 perPaymentLimit, uint256 dailyLimit, uint64 validUntil, bool enabled)",
  "function approverState(address) view returns (uint256 version, bool enabled)",
]);

export const VAULT_ABI_V2 = ABI;
export const callData = (functionName: string, args: readonly unknown[] = []): Hex =>
  encodeFunctionData({ abi: ABI, functionName: functionName as never, args: args as never });

export interface ApprovalViewV2 {
  vault: Address;
  signer: Address;
  signerRole: string;
  agent: Address;
  recipient: Address;
  amount: string;
  invoiceReference: string;
  expiresAt: string;
  exceededRule: string;
  digest: Hex;
}

/**
 * Checks a request against the vault's answers and the connected wallet. Throwing means the sign button
 * never appears. Each refusal is something that would only revert later, or a signature nobody should make.
 */
export function reviewPendingV2(
  pending: PendingV2,
  facts: ChainFactsV2,
  wallet: Address,
  nowSeconds: bigint,
): ApprovalViewV2 {
  const { payment, authorization } = pending;
  if (facts.contractVersion !== 2n) fail("this address is not a v2 vault");
  if (payment.token !== facts.token) fail("this approval is for another token");
  if (paymentHashV2(payment) !== authorization.paymentHash) fail("the authorization does not match the payment shown");
  if (wallet !== authorization.signer) {
    fail(`This request names ${authorization.signer} as the approver. Connect that wallet, then try again.`);
  }
  if (!facts.signerEnabled) fail("the vault does not list this wallet as an approver");
  if (facts.signerVersion !== authorization.signerVersion) {
    fail("this approver's access changed after the request was made. Ask the agent to request approval again");
  }
  if (facts.paused) fail("the vault is paused");
  if (!facts.agentEnabled) fail("the vault has switched off this agent");
  if (facts.agentVersion !== payment.policyVersion) {
    fail("this agent's policy changed after the request was made. Ask the agent to propose it again");
  }
  if (facts.agentValidUntil < nowSeconds) fail("this agent's policy has expired");
  if (!facts.recipientAllowed) fail("the recipient is not on the vault's allowlist");
  if (facts.recipientVersion !== payment.recipientVersion) {
    fail("this recipient's status changed after the request was made. Ask the agent to propose it again");
  }
  if (authorization.authorizationExpiry < nowSeconds) fail("this approval has expired");
  if (payment.validUntil < nowSeconds) fail("this payment has expired");
  if (pending.exceededRule !== "perPaymentLimit") fail("unsupported exceeded rule");
  if (payment.amount <= facts.agentPerPaymentLimit) {
    fail(`This payment is within the agent's limit of ${formatUsdc(facts.agentPerPaymentLimit)}, so it needs no approval.`);
  }
  return {
    vault: pending.vault,
    signer: authorization.signer,
    signerRole: wallet === facts.owner ? "Owner" : "Approver",
    agent: payment.agent,
    recipient: payment.recipient,
    amount: formatUsdc(payment.amount),
    invoiceReference: pending.invoiceReference,
    expiresAt: new Date(Number(authorization.authorizationExpiry) * 1000).toISOString(),
    exceededRule: `Exceeds this agent's limit of ${formatUsdc(facts.agentPerPaymentLimit)}, read from the chain`,
    digest: approvalDigestV2(pending),
  };
}

/** Refuses a signature unless it recovers to the signer the authorization names. */
export async function buildSignatureFileV2(pending: PendingV2, signature: Hex): Promise<string> {
  const { authorization } = pending;
  const recovered = await recoverTypedDataAddress({
    domain: domain(pending),
    types: SIGNING_TYPES,
    primaryType: "ExceptionAuthorization",
    message: authorization,
    signature,
  });
  if (recovered !== authorization.signer) fail("the wallet's signature does not recover to the named approver");
  return JSON.stringify(
    {
      schema: SIGNATURE_SCHEMA_V2,
      paymentId: pending.payment.paymentId,
      approvalDigest: approvalDigestV2(pending),
      signer: authorization.signer,
      signerVersion: authorization.signerVersion.toString(),
      signature,
    },
    null,
    2,
  );
}
