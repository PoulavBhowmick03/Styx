import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  approvalDigestV2,
  buildSignatureFileV2,
  isPendingV2,
  parsePendingV2,
  paymentHashV2,
  reviewPendingV2,
  TYPES_V2,
  type ChainFactsV2,
} from "../src/approval-v2";

const vector = JSON.parse(readFileSync(resolve(__dirname, "../../sdk/evm/src/arc_vault/v2/vector.json"), "utf8"));
const NOW = 1_700_000_000n;
const OWNER = getAddress("0x00000000000000000000000000000000000000aa");

const pendingJson = (overrides: Record<string, unknown> = {}) => ({
  schema: "vault-pending-approval/2",
  chainId: vector.domain.chainId,
  vault: vector.domain.verifyingContract,
  payment: vector.payment,
  authorization: vector.authorization,
  invoiceReference: "INV-1",
  exceededRule: "perPaymentLimit",
  perPaymentLimit: "1000000",
  ...overrides,
});

const facts = (overrides: Partial<ChainFactsV2> = {}): ChainFactsV2 => ({
  contractVersion: 2n,
  owner: OWNER,
  token: getAddress(vector.payment.token),
  paused: false,
  recipientAllowed: true,
  recipientVersion: BigInt(vector.payment.recipientVersion),
  agentVersion: BigInt(vector.payment.policyVersion),
  agentEnabled: true,
  agentPerPaymentLimit: 1_000_000n,
  agentValidUntil: NOW + 1000n,
  signerEnabled: true,
  signerVersion: BigInt(vector.authorization.signerVersion),
  ...overrides,
});
const signer = getAddress(vector.authorization.signer) as Address;

describe("the v2 digest", () => {
  it("matches the vector shared with Solidity and Rust", () => {
    const pending = parsePendingV2(pendingJson());
    expect(paymentHashV2(pending.payment)).toBe(vector.expected.paymentHash);
    expect(approvalDigestV2(pending)).toBe(vector.expected.approvalDigest);
  });
});

describe("reading a v2 file", () => {
  it("tells v1 and v2 files apart", () => {
    expect(isPendingV2(pendingJson())).toBe(true);
    expect(isPendingV2({ schema: "vault-pending-approval/1" })).toBe(false);
  });
  it("refuses extra and missing fields", () => {
    expect(() => parsePendingV2(pendingJson({ extra: "1" }))).toThrow(/wrong fields/);
    const { signer: _dropped, ...partial } = vector.authorization;
    expect(() => parsePendingV2(pendingJson({ authorization: partial }))).toThrow(/wrong fields/);
  });
  it("refuses a number where a decimal string belongs", () => {
    expect(() => parsePendingV2(pendingJson({ payment: { ...vector.payment, amount: 6000000 } }))).toThrow(/decimal string/);
  });
  it("lists the fields in the order the type strings give", () => {
    const names = (type: readonly { name: string; type: string }[]) => type.map((f) => `${f.type} ${f.name}`).join(",");
    expect(`Payment(${names(TYPES_V2.Payment)})`).toBe(vector.paymentType);
    expect(`ExceptionAuthorization(${names(TYPES_V2.ExceptionAuthorization)})`).toBe(vector.authorizationType);
  });
});

describe("reviewing against the vault", () => {
  const review = (overrides: Partial<ChainFactsV2> = {}, wallet = signer) =>
    reviewPendingV2(parsePendingV2(pendingJson()), facts(overrides), wallet, NOW);

  it("shows the limit from the chain, not the one the agent states", () => {
    const pending = parsePendingV2(pendingJson({ perPaymentLimit: "1" }));
    expect(reviewPendingV2(pending, facts(), signer, NOW).exceededRule).toContain("1 USDC, read from the chain");
  });
  it("marks an approver and an owner differently", () => {
    expect(review().signerRole).toBe("Approver");
    expect(review({ owner: signer }).signerRole).toBe("Owner");
  });
  it("refuses a wallet other than the named approver", () => {
    expect(() => review({}, OWNER)).toThrow(/names .* as the approver/);
  });
  it.each<[string, Partial<ChainFactsV2>, RegExp]>([
    ["not v2", { contractVersion: 1n }, /not a v2 vault/],
    ["another token", { token: OWNER }, /another token/],
    ["removed approver", { signerEnabled: false }, /does not list this wallet/],
    ["changed approver", { signerVersion: 99n }, /access changed/],
    ["paused", { paused: true }, /paused/],
    ["switched-off agent", { agentEnabled: false }, /switched off/],
    ["changed agent", { agentVersion: 99n }, /policy changed/],
    ["expired policy", { agentValidUntil: NOW - 1n }, /policy has expired/],
    ["unlisted recipient", { recipientAllowed: false }, /allowlist/],
    ["changed recipient", { recipientVersion: 99n }, /status changed/],
    ["within the limit", { agentPerPaymentLimit: 6_000_000n }, /needs no approval/],
  ])("refuses: %s", (_name, overrides, message) => {
    expect(() => review(overrides)).toThrow(message);
  });
  it("refuses an altered payment", () => {
    const altered = parsePendingV2(pendingJson({ payment: { ...vector.payment, amount: "7000000" } }));
    expect(() => reviewPendingV2(altered, facts(), signer, NOW)).toThrow(/does not match/);
  });
  it("treats an expiry equal to now as valid, as the vault does", () => {
    const at = parsePendingV2(pendingJson());
    const expiry = at.authorization.authorizationExpiry;
    const current = facts({ agentValidUntil: at.payment.validUntil });
    expect(reviewPendingV2(at, current, signer, expiry).digest).toBe(vector.expected.approvalDigest);
    expect(() => reviewPendingV2(at, current, signer, expiry + 1n)).toThrow(/approval has expired/);
  });
});

describe("the signature file", () => {
  const signedBy = async (account: ReturnType<typeof privateKeyToAccount>, named: Address) => {
    const pending = parsePendingV2(pendingJson({ authorization: { ...vector.authorization, signer: named } }));
    const signature = await account.signTypedData({
      domain: { name: "StyxVault", version: "2", chainId: pending.chainId, verifyingContract: pending.vault },
      types: { ExceptionAuthorization: TYPES_V2.ExceptionAuthorization },
      primaryType: "ExceptionAuthorization",
      message: pending.authorization,
    });
    return { pending, signature: signature as Hex };
  };
  it("holds the exact fields for a signature by the named approver", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { pending, signature } = await signedBy(account, account.address);
    const file = JSON.parse(await buildSignatureFileV2(pending, signature));
    expect(Object.keys(file)).toEqual(["schema", "paymentId", "approvalDigest", "signer", "signerVersion", "signature"]);
    expect(file.schema).toBe("vault-approver-signature/2");
    expect(file.signer).toBe(account.address);
    expect(file.signerVersion).toBe(vector.authorization.signerVersion);
  });
  it("refuses a signature by anyone else", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { pending, signature } = await signedBy(account, signer);
    await expect(buildSignatureFileV2(pending, signature)).rejects.toThrow(/named approver/);
  });
});
