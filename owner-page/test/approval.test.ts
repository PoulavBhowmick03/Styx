import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getAddress, keccak256, parseSignature, recoverTypedDataAddress, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  ApprovalError,
  approvalDigest,
  buildSignatureFile,
  formatUsdc,
  mayPostSignature,
  parseOwnerConfig,
  parsePending,
  parseRelayLink,
  POLICY_CALLS,
  reviewAgainstChain,
  paymentHash,
  reviewPending,
  SIGNATURE_SCHEMA,
  typedDataRequest,
  type OwnerConfig,
  type Pending,
  configFromChain,
  parseTrust,
  relayForFirstUse,
} from "../src/approval";

const vector = JSON.parse(
  readFileSync(resolve(__dirname, "../../sdk/core/tests/fixtures/vault-eip712-vector.json"), "utf8"),
);
const NOW = 1_700_000_000n;

function pendingJson() {
  return {
    schema: "vault-pending-approval/1",
    chainId: vector.domain.chainId,
    vault: vector.domain.verifyingContract,
    payment: vector.payment,
    authorization: { paymentHash: vector.expected.paymentHash, ...vector.authorization },
    invoiceReference: "INV-1",
    exceededRule: "perPaymentLimit",
    perPaymentLimit: "1000000",
  };
}

function ownerConfig(owner: Address = "0x0000000000000000000000000000000000000abc"): OwnerConfig {
  return parseOwnerConfig({
    chainId: vector.domain.chainId,
    vault: vector.domain.verifyingContract,
    owner,
    token: vector.payment.token,
    vendors: { [vector.payment.recipient]: "Acme Supplies" },
  });
}

function pendingWith(change: (value: ReturnType<typeof pendingJson>) => void): Pending {
  const value = structuredClone(pendingJson());
  change(value);
  return parsePending(value);
}

describe("digests", () => {
  it("match the vector generated independently with cast", () => {
    const pending = parsePending(pendingJson());
    expect(paymentHash(pending.payment)).toBe(vector.expected.paymentHash);
    expect(approvalDigest(pending)).toBe(vector.expected.approvalDigest);
  });

  it("the wallet payload is decimal strings and has the same digest", async () => {
    const pending = parsePending(pendingJson());
    const request = JSON.parse(typedDataRequest(pending));
    expect(request.domain.chainId).toBe("5042002");
    expect(request.message.approvalNonce).toBe("7");
    expect(request.primaryType).toBe("ExceptionAuthorization");

    const account = privateKeyToAccount(generatePrivateKey());
    const signature = await account.signTypedData({
      domain: { ...request.domain, chainId: BigInt(request.domain.chainId) },
      types: { ExceptionAuthorization: request.types.ExceptionAuthorization },
      primaryType: "ExceptionAuthorization",
      message: {
        paymentHash: request.message.paymentHash,
        approvalNonce: BigInt(request.message.approvalNonce),
        authorizationExpiry: BigInt(request.message.authorizationExpiry),
      },
    });
    const recovered = await recoverTypedDataAddress({
      domain: { ...request.domain, chainId: BigInt(request.domain.chainId) },
      types: { ExceptionAuthorization: request.types.ExceptionAuthorization },
      primaryType: "ExceptionAuthorization",
      message: { ...pending.authorization },
      signature,
    });
    expect(recovered).toBe(account.address);
  });

  it("a real account signature is in wallet format", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signature = await account.sign({ hash: vector.expected.approvalDigest as Hex });
    expect([27n, 28n]).toContain(parseSignature(signature).v);
  });
});

describe("parsing", () => {
  it("rejects numbers and non-canonical integers", () => {
    const withAmount = (amount: unknown) =>
      parsePending({ ...pendingJson(), payment: { ...vector.payment, amount } });
    expect(() => withAmount(6000000)).toThrow(ApprovalError);
    expect(() => withAmount("06000000")).toThrow(ApprovalError);
    expect(() => withAmount("6.0")).toThrow(ApprovalError);
    expect(() => withAmount("1e6")).toThrow(ApprovalError);
  });

  it("rejects another schema", () => {
    expect(() => parsePending({ ...pendingJson(), schema: "other" })).toThrow(ApprovalError);
  });

  it("keeps precision above the float limit", () => {
    const big = "9007199254740993";
    const pending = pendingWith((value) => {
      value.authorization.approvalNonce = big;
    });
    expect(pending.authorization.approvalNonce.toString()).toBe(big);
    expect(JSON.parse(typedDataRequest(pending)).message.approvalNonce).toBe(big);
  });
});

describe("review", () => {
  it("shows the owner's label, never agent text, for the vendor", () => {
    const view = reviewPending(parsePending(pendingJson()), ownerConfig(), NOW);
    expect(view.vendorLabel).toBe("Acme Supplies");
    expect(view.amount).toBe("6 USDC");
    expect(view.exceededRule).toBe("The agent says the limit is 1 USDC. Not verified");
    expect(view.digest).toBe(vector.expected.approvalDigest);
  });

  it("refuses a payment altered without updating its hash", () => {
    const alterations: ((value: ReturnType<typeof pendingJson>) => void)[] = [
      (value) => void (value.payment = { ...value.payment, amount: "7000000" }),
      (value) => void (value.payment = { ...value.payment, validUntil: "1800000001" }),
      (value) => void (value.payment = { ...value.payment, evidenceCommitment: keccak256(toHex("other")) }),
    ];
    for (const alter of alterations) {
      expect(() => reviewPending(pendingWith(alter), ownerConfig(), NOW)).toThrow(/does not match/);
    }
  });

  it("refuses a recipient outside the owner's allowlist", () => {
    const other = "0x4000000000000000000000000000000000000005";
    const pending = parsePending(pendingJson());
    pending.payment.recipient = getAddress(other);
    pending.authorization.paymentHash = paymentHash(pending.payment);
    expect(() => reviewPending(pending, ownerConfig(), NOW)).toThrow(/allowlist/);
  });

  it("refuses another chain, vault, or token", () => {
    const chain = pendingWith((value) => {
      value.chainId = "1";
    });
    expect(() => reviewPending(chain, ownerConfig(), NOW)).toThrow(/chain/);
    const vault = pendingWith((value) => {
      value.vault = "0x1000000000000000000000000000000000000009";
    });
    expect(() => reviewPending(vault, ownerConfig(), NOW)).toThrow(/vault/);
    const pending = parsePending(pendingJson());
    pending.payment.token = getAddress("0x3600000000000000000000000000000000000009");
    pending.authorization.paymentHash = paymentHash(pending.payment);
    expect(() => reviewPending(pending, ownerConfig(), NOW)).toThrow(/token/);
  });

  it("refuses an expired approval or payment", () => {
    const pending = parsePending(pendingJson());
    expect(() => reviewPending(pending, ownerConfig(), 1_800_000_600n)).toThrow(/expired/);
  });

  it("refuses a file claiming an exception for an amount within the limit", () => {
    const pending = pendingWith((value) => {
      value.perPaymentLimit = "6000000";
    });
    expect(() => reviewPending(pending, ownerConfig(), NOW)).toThrow(/does not exceed/);
  });
});

describe("signature file", () => {
  async function signedBy(key: Hex, pending: Pending): Promise<Hex> {
    const request = JSON.parse(typedDataRequest(pending));
    return privateKeyToAccount(key).signTypedData({
      domain: { ...request.domain, chainId: pending.chainId },
      types: { ExceptionAuthorization: request.types.ExceptionAuthorization },
      primaryType: "ExceptionAuthorization",
      message: { ...pending.authorization },
    });
  }

  it("is produced for the owner's signature", async () => {
    const key = generatePrivateKey();
    const pending = parsePending(pendingJson());
    const owner = privateKeyToAccount(key).address;
    const file = JSON.parse(await buildSignatureFile(pending, ownerConfig(owner), await signedBy(key, pending)));
    expect(file.schema).toBe(SIGNATURE_SCHEMA);
    expect(file.paymentId).toBe(vector.payment.paymentId);
    expect(file.approvalDigest).toBe(vector.expected.approvalDigest);
  });

  it("is refused for any other signer", async () => {
    const pending = parsePending(pendingJson());
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const signature = await signedBy(generatePrivateKey(), pending);
    await expect(buildSignatureFile(pending, ownerConfig(owner), signature)).rejects.toThrow(/does not recover/);
  });
});

describe("formatUsdc", () => {
  it("is exact for fractions and large values", () => {
    expect(formatUsdc(250_000n)).toBe("0.25 USDC");
    expect(formatUsdc(1n)).toBe("0.000001 USDC");
    expect(formatUsdc(0n)).toBe("0 USDC");
    expect(formatUsdc(123_456_789_012_345_678_901n)).toBe("123456789012345.678901 USDC");
  });
});

describe("the chain's answer", () => {
  it("replaces the limit the agent stated", () => {
    const pending = pendingWith((value) => {
      value.perPaymentLimit = "1";
    });
    expect(reviewAgainstChain(pending, { perPaymentLimit: 1_000_000n, policyVersion: 3n })).toBe(
      "Exceeds the vault's limit of 1 USDC, read from the chain",
    );
    expect(reviewAgainstChain(pending, { perPaymentLimit: 6_000_000n, policyVersion: 3n })).toMatch(/does not need an exception/);
  });

  it("refuses a request for an old policy version", () => {
    expect(() => reviewAgainstChain(parsePending(pendingJson()), { perPaymentLimit: 1n, policyVersion: 4n })).toThrow(/policy changed/);
  });

  it("uses the vault's real getter selectors", () => {
    expect(POLICY_CALLS.perPaymentLimit).toBe(keccak256(toHex("perPaymentLimit()")).slice(0, 10));
    expect(POLICY_CALLS.policyVersion).toBe(keccak256(toHex("policyVersion()")).slice(0, 10));
  });
});

describe("alert links", () => {
  const id = "abcdefghijklmnopqrstuv";

  it("are read from the page's query string", () => {
    expect(parseRelayLink(`?relay=${encodeURIComponent("https://relay.example/ignored")}&request=${id}`)).toEqual({
      relay: "https://relay.example",
      request: id,
    });
    expect(parseRelayLink("")).toBeUndefined();
  });

  it("refuse other schemes and malformed IDs", () => {
    expect(() => parseRelayLink(`?relay=${encodeURIComponent("javascript:alert(1)")}&request=${id}`)).toThrow(ApprovalError);
    expect(() => parseRelayLink(`?relay=not-a-url&request=${id}`)).toThrow(ApprovalError);
    expect(() => parseRelayLink(`?relay=https://relay.example&request=${encodeURIComponent("../../alerts")}`)).toThrow(ApprovalError);
  });
});

describe("where a signature may go", () => {
  const withRelay = (relay?: string) => parseOwnerConfig({
    chainId: vector.domain.chainId, vault: vector.domain.verifyingContract, owner: "0x0000000000000000000000000000000000000abc",
    token: vector.payment.token, vendors: {}, ...(relay ? { relay } : {}),
  });
  const link = { relay: "https://relay.example", request: "abcdefghijklmnopqrstuv" };

  it("is only the relay in the owner's config", () => {
    expect(mayPostSignature(link, withRelay("https://relay.example/ignored"))).toBe(true);
    expect(mayPostSignature(link, withRelay("https://attacker.example"))).toBe(false);
    expect(mayPostSignature(link, withRelay())).toBe(false);
  });

  it("refuses a config with another scheme", () => {
    expect(() => withRelay("javascript:alert(1)")).toThrow(ApprovalError);
  });
});

describe("approving with no config file", () => {
  const pending = () => parsePending(pendingJson());
  const vault = () => pending().vault;
  const trust = (relay?: string) => ({ chainId: pending().chainId, vault: vault(), ...(relay ? { relay } : {}) });
  const facts = (recipientAllowed = true) => ({
    owner: getAddress("0x00000000000000000000000000000000000000aa"),
    token: pending().payment.token,
    recipientAllowed,
  });

  it("gives reviewPending the same config shape, from the chain", () => {
    const config = configFromChain(pending(), facts(), trust("https://relay.example"), {});
    expect(config.owner).toBe(facts().owner);
    expect(config.relay).toBe("https://relay.example");
    expect(config.vendors.get(pending().payment.recipient)).toMatch(/Allowed by the vault/);
    expect(reviewPending(pending(), config, NOW).recipient).toBe(pending().payment.recipient);
  });

  it("refuses a recipient the vault does not allow", () => {
    const config = configFromChain(pending(), facts(false), trust(), {});
    expect(() => reviewPending(pending(), config, NOW)).toThrow(/allowlist/);
  });

  it("refuses a token other than the vault's", () => {
    const other = { ...facts(), token: getAddress("0x00000000000000000000000000000000000000bb") };
    expect(() => reviewPending(pending(), configFromChain(pending(), other, trust(), {}), NOW)).toThrow(/another token/);
  });

  it("refuses a request for a vault the owner did not confirm", () => {
    const wrong = { ...trust(), vault: getAddress("0x00000000000000000000000000000000000000cc") };
    expect(() => configFromChain(pending(), facts(), wrong, {})).toThrow(/did not confirm/);
  });

  it("uses the owner's own saved label, matched in lower case", () => {
    const recipient = pending().payment.recipient;
    const config = configFromChain(pending(), facts(), trust(), { [recipient.toLowerCase()]: "Acme" });
    expect(config.vendors.get(recipient)).toBe("Acme");
  });

  it("lets a build's own relay override the one in a link", () => {
    const link = { relay: "https://attacker.example", request: "a".repeat(16) };
    expect(relayForFirstUse(link, "https://relay.example/")).toBe("https://relay.example");
    expect(relayForFirstUse(link, undefined)).toBe("https://attacker.example");
  });

  it("drops a damaged saved record", () => {
    expect(parseTrust("not json")).toBeUndefined();
    expect(parseTrust(JSON.stringify({ chainId: 1, vault: "x" }))).toBeUndefined();
    expect(parseTrust(JSON.stringify({ chainId: "1", vault: vault() }))?.vault).toBe(vault());
  });
});
