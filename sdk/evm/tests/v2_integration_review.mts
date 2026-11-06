// Reproductions against the integration branch. This file does not alter its services.
// Run: relay/node_modules/.bin/tsx --test sdk/evm/tests/v2_integration_review.mts
// Three tests intentionally fail until the service owners fix the reviewed behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { getAddress, keccak256, toHex } from "../../../relay/node_modules/viem/_esm/index.js";
import { generatePrivateKey, privateKeyToAccount } from "../../../relay/node_modules/viem/_esm/accounts/index.js";
import { Relay } from "../../../relay/src/relay.ts";
import { parsePendingV2, paymentHashV2, buildSignatureFileV2, SIGNATURE_SCHEMA_V2, reviewPendingV2, typedDataRequestV2, approvalDigestV2 } from "../../../owner-page/src/approval-v2.ts";

const now = 1_900_000_000;
const vault = getAddress("0x1000000000000000000000000000000000000001");
const token = getAddress("0x3600000000000000000000000000000000000000");
const agentA = getAddress("0xa00000000000000000000000000000000000000a");
const agentB = getAddress("0xb00000000000000000000000000000000000000b");
const approver = privateKeyToAccount(generatePrivateKey());
const bearerA = "local-agent-a-credential-with-32-characters";
const bearerB = "local-agent-b-credential-with-32-characters";
function pending(suffix: string, agent = agentA, signer = approver.address, expiry = now + 600) {
  const value = {
    schema:"vault-pending-approval/2", chainId:"5042002", vault,
    payment:{paymentId:keccak256(toHex(suffix)), agent, token,
      recipient:getAddress("0x4000000000000000000000000000000000000004"), amount:"2000000",
      evidenceCommitment:keccak256(toHex("invoice")), policyVersion:"1", recipientVersion:"1", validUntil:String(now+600)},
    authorization:{paymentHash:"0x"+"00".repeat(32), signer, signerVersion:"1", approvalNonce:"7", authorizationExpiry:String(expiry)},
    invoiceReference:"local test", exceededRule:"perPaymentLimit", perPaymentLimit:"1000000",
  };
  value.authorization.paymentHash = paymentHashV2(parsePendingV2(value).payment);
  return value;
}
function relay(notify = async () => true, shared = false) {
  return new Relay({chainId:5042002n, vault, token, owner:approver.address,
    pageUrl:"https://review.example/", relayUrl:"https://relay.example/", agentToken:"legacy-local-credential",
    maxAlertsPerHour:1, maxRequests:50,
    v2:{vault, agentTokens:new Map([[agentA,bearerA],[agentB,shared ? bearerA : bearerB]])}}, notify, () => now);
}
async function signature(value: ReturnType<typeof pending>) {
  const p = parsePendingV2(value);
  const sig = await approver.signTypedData({domain:{name:"StyxVault",version:"2",chainId:p.chainId,verifyingContract:p.vault},
    types:{ExceptionAuthorization:[{name:"paymentHash",type:"bytes32"},{name:"signer",type:"address"},
      {name:"signerVersion",type:"uint256"},{name:"approvalNonce",type:"uint256"},{name:"authorizationExpiry",type:"uint64"}]},
    primaryType:"ExceptionAuthorization", message:p.authorization});
  return JSON.parse(await buildSignatureFileV2(p, sig));
}

test("isolation: agent A cannot retrieve agent B's signature with distinct credentials", async () => {
  const r = relay(); const p = pending("isolated",agentB);
  const id = (await r.submit(p,bearerB)).requestId;
  await r.sign(id,await signature(p));
  assert.throws(() => r.signature(id,bearerA));
  assert.equal(r.signature(id,bearerB).status,"signed");
});
test("binding: a valid signature for another request is rejected", async () => {
  const r = relay(); const p = pending("target"); const q = pending("other");
  const id = (await r.submit(p,bearerA)).requestId;
  await assert.rejects(r.sign(id,await signature(q)));
});
test("expiry: the last authorized second remains usable", async () => {
  const r = relay(); const p = pending("inclusive",agentA,approver.address,now);
  const id = (await r.submit(p,bearerA)).requestId;
  await r.sign(id,await signature(p));
  assert.equal(r.signature(id,bearerA).status,"signed");
});
test("display binding: changing a payment field without a matching authorization is refused", () => {
  const p = parsePendingV2(pending("display"));
  const facts = {contractVersion:2n, owner:approver.address, token, paused:false, recipientAllowed:true,
    recipientVersion:1n, agentVersion:1n, agentPerPaymentLimit:1_000_000n, agentValidUntil:BigInt(now+600),
    agentEnabled:true, signerVersion:1n, signerEnabled:true};
  const view = reviewPendingV2(p,facts,approver.address,BigInt(now));
  const typed = JSON.parse(typedDataRequestV2(p));
  assert.equal(view.vault,typed.domain.verifyingContract);
  assert.equal(view.digest,approvalDigestV2(p));
  assert.equal(view.agent,p.payment.agent);
  assert.equal(view.recipient,p.payment.recipient);
  assert.equal(view.amount,"2 USDC");
  for (const field of Object.keys(p.payment)) {
    const changed = structuredClone(p);
    const value = changed.payment[field as keyof typeof changed.payment];
    (changed.payment as any)[field] = typeof value === "bigint" ? value+1n
      : value.length === 42 ? getAddress("0x6000000000000000000000000000000000000006") : "0x"+"ab".repeat(32);
    assert.throws(() => reviewPendingV2(changed,facts,approver.address,BigInt(now)),field);
  }
});
test("OPEN R3: concurrent requests respect the configured alert cap", {skip:process.env.STYX_REVIEW_SKIP_OPEN_FINDINGS === "1"}, async () => {
  let delivered = 0;
  const r = relay(async () => { await setTimeout(20); delivered++; return true; });
  await Promise.all(Array.from({length:5},(_,i) => r.submit(pending(`concurrent-${i}`),bearerA)));
  assert.equal(delivered,1,"five concurrent requests must not bypass maxAlertsPerHour=1");
});
test("OPEN R4: duplicate credentials must not permit cross-agent signature retrieval", {skip:process.env.STYX_REVIEW_SKIP_OPEN_FINDINGS === "1"}, async () => {
  const r = relay(undefined,true); const p = pending("shared-credential",agentB);
  const id = (await r.submit(p,bearerA)).requestId;
  await r.sign(id,await signature(p));
  assert.throws(() => r.signature(id,bearerA),"reject duplicate credentials at configuration time");
});
test("OPEN R2: contract-wallet signatures are not restricted to 65 bytes", {skip:process.env.STYX_REVIEW_SKIP_OPEN_FINDINGS === "1"}, async () => {
  const r = relay(); const wallet = getAddress("0x5000000000000000000000000000000000000005");
  const p = pending("contract-wallet",agentA,wallet);
  const id = (await r.submit(p,bearerA)).requestId;
  // The SDK's passing Anvil ERC-1271 test exercises a valid 130-byte threshold signature.
  // This fixture isolates the relay's length gate; it makes no signature-validity claim.
  try {
    await r.sign(id,{schema:SIGNATURE_SCHEMA_V2,signature:"0x"+"11".repeat(130)});
  } catch (error) {
    assert.notEqual((error as Error).message,"invalid signature file","ERC-1271 signatures must reach contract validation, rather than a 65-byte parser gate");
  }
});
