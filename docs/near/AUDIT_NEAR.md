# Styx NEAR v2 contract review

13 November 2026. Source reviewed at `31994644b5aa6fcf468eafa38ad61176344d21f9`.
Scope: `contracts/near/styx-vault/src/lib.rs`, `src/evm.rs`, existing unit/sandbox tests,
and the test token where the vault depends on it. The three requested planning/run documents
were read. Pages, relay, Python/CLI tools and Solidity are outside this review.

This is a bounded source review with reproductions, not a claim about all possible executions.
No production contract logic was changed. The only addition under contracts is
`contracts/near/styx-vault/tests/audit_pocs.rs`; no module line or dependency change is needed.
No testnet/mainnet transaction was submitted. Test keys were generated in memory.
The reproduction file is committed as `f7f11a7`.

## Summary

| ID | Title | Severity | Status / evidence |
| --- | --- | --- | --- |
| N-01 | Failed MPC delivery may expose a usable signature while releasing its reservation | high | Conditional concern; source reasoning, not reproduced |
| N-02 | EVM token is neither committed by approval nor frozen for callback assembly | medium | **Fixed** in `3003a00`, deployed to vault-v2 13 Nov 2026; the reproductions are now regression tests |
| N-03 | Late callbacks undo nonce recovery, clear newer locks and overwrite signed outputs | medium | Bug; two mock-VM reproductions pass |
| N-04 | Any enabled agent can claim another payment's record, including before rollback | medium | **Partly fixed** in `f0582f1` (only the payer posts; rollback frees the slot), deployed to vault-v2; settlement is still not required before posting |
| N-05 | Failed access-key installation leaves an enabled policy and can retain full access | medium | Bug; Wasm sandbox reproduction passes |
| N-06 | Malformed successful signer response bypasses cleanup and strands state | medium | Bug; Wasm sandbox reproduction passes |
| N-07 | Callback events combine old policy version with new policy limits | low | Evidence bug; mock-VM reproduction passes |
| N-08 | Per-transaction gas caps do not bound aggregate EVM gas expenditure | medium | Design limit; reasoned, no draining trial |
| N-09 | Permanent storage growth is funded by the vault and can stop processing | low | Design limit; reasoned, no storage-exhaustion trial |
| N-10 | Daily counters and expiry bound admission/signing, not EVM settlement | info | Design limit; late-callback test plus source reasoning |
| N-11 | A single pending slot serializes all EVM chains | info | Design limit; source and existing single-request test |
| N-12 | No contract-controlled upgrade/migration procedure | low | Design limit; source review only |

None of these findings is fixed by this review. Severity reflects the stated preconditions;
particularly, N-01 is **not a demonstrated bypass** and does not assume compromise of the MPC
key. N-02/N-03 require an owner configuration/recovery action while an authorization or request
is outstanding. N-05 requires failed installation of a key the owner chose; it does not promote
a correctly restricted key to full access.

## Test evidence and boundaries

Command, run from `contracts/near/styx-vault`:

```text
cargo test
41 existing unit tests: passed
14 audit_pocs integration-target tests: passed
2 existing sandbox tests: passed
0 doc tests
exit status: 0
```

Of the 14 new tests, 12 use near-sdk's mock VM and manually deliver callbacks through the public
Rust methods. Two execute the actual Wasm in NEAR sandbox. Direct Rust calls do not exercise the
SDK's private-method or JSON callback wrappers; the two sandbox tests cover those distinctions.
The PoCs assert the undesired behavior, so a passing reproduction documents a bug, not a fix.
The existing sandbox tests rebuilt the vault/test-token artifacts through the existing build
script. The vault artifact reported SHA-256
`fe8c4fc94a1291c5c3d329086d0d78251fbae911a6be686ea2f7ade10c00ffb2`.
This is not an assertion that that artifact equals currently deployed code.

The baseline before adding PoCs also passed (41 unit + 2 sandbox). An initial new sandbox test
attempt was refused by its access-key allowance at 250 Tgas before execution; lowering the
harness attachment to 200 Tgas allowed the intended callback test to run. Its final assertion
is the callback-deserialization failure and retained state, not that preliminary refusal.

## Findings verified by tests

### N-02 — EVM token configuration is not bound through approval and callback

**Where:** `contracts/near/styx-vault/src/lib.rs:128` (EvmPayment), `:336` (chain updates),
`:517` and `:524` (callback reload/rebuild), `:737` (transaction token), `:750`–`:785`
(request construction), `:899` (payment hash).

**What:** Every declared EvmPayment field is hashed, but the ERC-20 token and chain-configuration
version are absent. Changing the configured token leaves an existing payment hash/approval
valid. Separately, the request hashes the current token but passes only gas fields to its
callback. The callback fetches the token again, so the serialized transaction can differ from
the transaction the MPC signer signed.

**Scenario:** An approver reviews token A; the owner later changes that chain to token B. The
agent can submit the retained authorization and get a valid token-B transaction. This need not
involve a malicious owner: routine token replacement is enough. If the owner changes A to B
*after* the MPC request, the returned signature is instead attached to a token-B payload that
was never signed for the vault's key. Counters/payment ID remain charged and nonce advances.

**Tests:** `vm_evm_approval_survives_token_change_before_submission` confirms unchanged approval
hash, acceptance of the old authorization, and token B in a correctly recovering emitted raw
transaction. `vm_token_change_during_mpc_emits_transaction_for_wrong_signer` captures the actual
outgoing MPC digest, signs it with a fresh stand-in key, changes the token, then independently
RLP-decodes and recovers the emitted transaction: token B, different digest, different recovered
key, nonce 1 and 60 units charged. No EVM broadcast was performed; rejection by the funded vault
address's chain is a consequence inferred from the changed sender, not a transaction we sent.

**Suggested fix:** Bind the token or chain-configuration version into the approved payment.
Retain the complete authorized transfer/preimage, including token, for callback assembly;
verify the callback uses the exact requested digest. Changing configuration must not silently
reinterpret an outstanding authorization. The existing gas-field snapshot is useful but incomplete.

**Fixed (13 Nov 2026, `3003a00`).** `hash_evm_payment` now hashes under `styx-evm-payment-v2` and
appends the chain's token, so `evm_payment_hash` changes with the token and an older approval fails
with `PaymentHashMismatch`. The token is captured in `transfer_fields` with the gas caps when signing
is requested, and `on_evm_signed` builds the transaction from that, never from current state. Tests:
`vm_token_change_during_mpc_keeps_the_signed_token`, `vm_evm_approval_is_refused_after_a_token_change`,
`vm_evm_approval_pays_when_the_token_is_unchanged`. Live on vault-v2: see `TESTNET_RUN.md`.

### N-03 — Nonce recovery does not invalidate old callbacks

**Where:** `contracts/near/styx-vault/src/lib.rs:361`–`:367`, `:516`, `:541`–`:542`,
`:713`–`:714`, `:751`, `:763`.

**What:** set_evm_nonce can clear the pending slot while its old request can still finish. There
is no request identity/generation check in the callback; it unconditionally clears the global
slot and writes `old_nonce + 1`. Signed outputs use an overwriteable `(chain, nonce)` key.

**Scenario:** A request for nonce 0 is delayed. The owner resets the chain and the agent starts
a new request. The old callback arrives, clears the newer request's lock, and can restore nonce
1 even if the owner had resynchronized to 100. Two callbacks for nonce 0 overwrite each other's
stored output. Already published raw transactions are not revoked when their stored copy changes.
Only one competing transaction at a given sender/nonce can execute on EVM; this is not a proof
that both nonce-0 transfers execute.

**Tests:** `vm_old_callback_reverts_owner_nonce_resync` observes 100 becoming 1.
`vm_old_callback_clears_new_lock_and_overwrites_signed_tx` starts two requests around a reset,
observes the second request's lock cleared by the first callback, and the signed-output slot
replaced by the second callback; both reservations remain charged. These are manually scheduled
callback interleavings, not a live MPC timing reproduction.

**Suggested fix:** Track immutable request IDs/generations, reserved nonce and status per chain.
A stale callback must not alter a newer request's lock/nonce. Do not overwrite retained signed
alternatives invisibly. Recovery must reconcile the original transaction's possible EVM outcome;
clearing a NEAR flag does not cancel an already issued EVM signature.

### N-04 — Sealed-record ownership and settlement are not checked

**Where:** `contracts/near/styx-vault/src/lib.rs:415`–`:432`, `:480`, `:789`–`:800`, `:842`–`:843`.

**What:** post_record checks only that the caller is *an* enabled agent and the payment ID is in
consumed_payments. That map holds a hash, not the paying agent or a settled status. A record is
single-use, and rollback does not remove it.

**Scenario:** Agent B observes agent A's public pending payment ID, posts junk ciphertext under
it, and takes the sole record slot. If A's transfer fails, the consumed ID is released but the
record claim remains. A later successful retry still cannot post its actual invoice. This
breaks disclosure availability/provenance; the PoC does not decrypt another agent's invoice or
forge a valid payment-hash proof.

**Test:** `vm_other_agent_can_claim_record_and_claim_survives_rollback` posts as B for A's pending
payment, verifies the event names B, rolls A's transfer back, settles a retry, and observes A's
post rejected. Native mock VM only; the real token transfer is represented by callback results.

**Suggested fix:** Retain payer and settlement state for each payment; require the original
payer and a confirmed settled status to claim the record. Define retry cleanup/replacement rules
so a failed attempt cannot permanently occupy a later successful attempt's record slot. EVM
signing success must not be labelled destination-chain settlement without evidence.

**Partly fixed (13 Nov 2026, `f0582f1`).** The vault writes the payer under a raw `payer:` storage
prefix when it consumes a payment and removes it, with the record slot, on rollback; `post_record`
refuses any other agent with `NotPayer`. Test: `vm_only_the_paying_agent_posts_the_record_and_rollback_frees_it`.
Not done: requiring confirmed settlement before a record (a NEAR record can still be posted while
the transfer is in flight; if it then fails, the slot is freed). Payments consumed before the
upgrade have no payer entry and can no longer get a record.

### N-05 — Access-key and policy state diverge after promise failure

**Where:** `contracts/near/styx-vault/src/lib.rs:262`–`:278` and `:25`–`:26`.

**What:** configure_agent commits an enabled policy before AddKey executes. There is no callback
that reverts/finalizes installation. A duplicate pre-existing key causes AddKey to fail, yet the
policy stays enabled. Repeating enabled=true takes the no-op branch, so it cannot repair the
installation or restrict an existing full-access key.

**Scenario:** The owner configures the public key of an existing full-access key on the vault,
expecting it to become restricted. The action fails, the public policy says enabled, and the
key remains full access. Its holder already had full access; this is not privilege escalation
from a correctly installed agent. More ordinary failed installs/removals can instead leave an
unusable enabled policy or a disabled policy with a remaining protocol key. Disabled policies
still block payments at the contract layer.

**Test:** `sandbox_failed_install_leaves_enabled_policy_and_full_access_key` executes Wasm,
configures the sandbox vault's existing full-access key, checks failure plus enabled policy and
unchanged FullAccess permission, then repeats configuration and observes success without
restriction. The test also confirms both callback methods reject a separate owner's direct ABI
call with the private-method error.

**Suggested fix:** Represent installation as pending and finalize policy state only after the
key-action outcome is known, with explicit failure/retry handling and concurrency generations.
Require/provision a fresh agent key and make failed restriction visible. A pre-existing
full-access key must never be advertised as successfully restricted by this operation.

### N-06 — Successful malformed signer output never reaches rollback

**Where:** `contracts/near/styx-vault/src/lib.rs:504`–`:518`, `:569`–`:582`, `:757`–`:785`,
`:361`–`:367`. Also near-sdk-macros 5.30.1 generated callback deserialization.

**What:** `#[callback_result] Result<MpcSignature, PromiseError>` handles a failed promise, but
successful invalid JSON is deserialized by the SDK wrapper before on_evm_signed runs. The
wrapper panics; clearing evm_pending and rollback are never executed. Resetting the nonce clears
the global lock but cannot release that payment ID, approval nonce or spending reservation.

**Scenario:** A configured signer returns an incompatible response after an interface change,
or another callback execution failure occurs after the request has committed. All EVM chains
can remain blocked, and the failed operation remains charged even when no usable signature was
returned. A normal agent cannot choose the immutable signer address; the reproduced trigger is
a deliberately incompatible signer selected at initialization, not a claim about today's MPC.

**Test:** `sandbox_empty_success_from_signer_strands_lock_and_accounting` deploys a minimal
sign() Wasm returning empty successful bytes, submits pay_evm through an actually installed
function-call key, observes the SDK's deserialization failure, and checks pending chain,
consumed payment and 60 units charged. Owner nonce recovery clears the lock but leaves the ID.
This test does not exercise real MPC yield timeout or callback out-of-gas.

**Suggested fix:** Receive bounded raw promise bytes and explicitly validate/decode them inside
recoverable logic. Persist pending request metadata before external work and provide safe
reconciliation for callbacks that never commit. Distinguish an unavailable signature from proof
that no usable signature exists (N-01); a general refund-on-error is not a complete fix.

### N-07 — Execution events use the current policy's limits

**Where:** `contracts/near/styx-vault/src/lib.rs:449`, `:461`–`:465`, `:543`, `:557`–`:558`.

**What/scenario:** A payment is admitted under policy version 1 with a per-payment limit of 100.
Before the callback, the owner changes the policy to version 2 with limit 1. The success event
then combines payment policy_version 1 with limit 1. A reviewer cannot read those fields as the
policy used to admit the payment. An already admitted payment completing after a policy change
is not itself a spending-rule bypass.

**Test:** `vm_callback_event_uses_changed_policy_instead_of_original_policy` observes an amount
60 event with policy_version 1, per_payment_limit 1 and daily_limit 1 after reconfiguration.
This tests the native callback; the analogous EVM reload is source-reviewed, not separately tested.

**Suggested fix:** Snapshot the admission policy limits/version needed for evidence, or label
current-state values explicitly and publish a separately committed admission-policy record.

## Conditional and source-only findings

### N-01 — MPC failure does not establish that no spendable signature escaped

**Where:** `contracts/near/styx-vault/src/lib.rs:569`–`:570`, `:789`–`:799`, `:751`, `:541`.
Upstream MPC 3.18.0: `crates/contract/src/api/sign.rs:84`–`:168`, `:191`–`:219`;
`crates/contract/src/pending_requests.rs:59`–`:83`.

**Status:** Reasoned, not reproduced. High potential impact if the delivery/signature-escape
race occurs; no demonstrated cap bypass or duplicate settlement is claimed.

**Concern:** On an MPC promise error the vault refunds counters, frees the payment/approval
nonce and leaves the EVM nonce reusable. But an ECDSA signature is usable independently of the
promise delivering it. Upstream respond receives a valid signature in a public NEAR transaction's
arguments. Its resolution helper explicitly permits resuming an already timed-out yield as a
no-op and counts queued entries, not successful resume results. A late valid response, including
one rejected after request cleanup, can expose signature bytes even if the vault receives failure.
A failed function-call transaction does not make its submitted signature mathematically invalid.

**Conditional scenario:** Request A reserves amount 100 at EVM nonce n. A late MPC response
publishes its valid signature while timeout delivery makes the vault roll A back. The agent
reconstructs raw A. A tiny payment B is then signed at the reused nonce n, advancing the vault
nonce to n+1 and charging only B. If raw A is broadcast instead and executes at n, the vault has
charged B's small amount for A's larger transfer. A's freed ID could subsequently be submitted at
n+1. This needs actual signature escape across the failure boundary, which this review did not
exercise with MPC nodes or EVM settlement. N-03 recovery races can make reconciliation harder.

**Suggested fix:** Treat an issued signing request/nonce as potentially signed until its outcome
is reconciled. Do not release credit or reuse its nonce for another payment solely because a
NEAR promise failed. Retain idempotent request/preimage state and use verified destination-chain
finality/replacement evidence, or an execution contract with its own consumed authorization IDs.
Prioritize a real MPC timeout/late-response integration reproduction before relying on rollback
as proof of non-payment. The successful local Err-callback rollback test proves bookkeeping
only; it does not disprove this cross-chain concern.

### N-08 — Tiny payments can exhaust the separate EVM gas balance

**Where:** `contracts/near/styx-vault/src/lib.rs:116`–`:123`, `:336`–`:343`, `:707`, `:729`–`:740`,
`:757`–`:762`; `contracts/near/styx-vault/src/evm.rs:43`–`:53`.

**Status:** Reasoned, not tested with a draining run. Design limit, medium impact on a funded
account; acceptable for a bounded testnet demo only if the separate gas exposure is understood.

An enabled agent can make many one-base-unit payments to allowed recipients. Each may incur
nearly a full ERC-20 transaction's gas while adding only one unit to the daily token counter.
Per-transaction gas caps bound each transaction, not the day's total or the number of payments.
The derived address pays native gas (ETH on Base, native USDC on Arc). NEAR key allowance,
request serialization, expiry and account balances constrain the attack, so expenditure is not
literally unbounded. They are not an EVM daily gas budget.

**Suggested fix:** Separate per-chain native-gas budgets, payment-count/rate bounds or minimum
amounts; reserve worst-case costs and reconcile conservatively. Keep the gas buffer small for
testnet. Do not describe the token daily cap as a cap on all wallet outflows.

### N-09 — The vault pays for permanent state growth

**Where:** `contracts/near/styx-vault/src/lib.rs:202`–`:215`, `:265`, `:425`, `:542`, `:690`,
`:757`–`:762`, `:842`–`:848`, `:921`.

**Status:** Source reasoning only; storage exhaustion and storage-caused callback failure were
not induced. Low design risk for a short demo, a lifecycle/availability issue for sustained use.

Successful IDs and approval nonces are retained forever; signed EVM outputs accumulate by
chain/nonce (except owner overwrites). Agent calls are non-payable; vault NEAR pays storage
stake, execution and 1-yocto deposits, with the function-call allowance limiting agent gas.
There is no storage deposit charged to an agent or pruning policy. Small payments create state
out of proportion to transferred value. IDs/evidence/sealed payloads also have no application
length bounds; runtime limits are not a policy budget.

With insufficient liquid NEAR for storage, the affected receipt fails atomically. If that receipt
is a callback after external work, earlier receipts/effects are not automatically undone:
reservations can remain and settlement evidence may be absent. Source inspection establishes
these transitions; the exact exhaustion threshold was not measured.

**Suggested fix:** Bound input sizes and growth, fund/monitor a defined storage reserve, and
adopt explicit retention/archival rules that preserve replay protection. Do not prune consumed
IDs/nonces merely to recover funds while old authorizations or EVM signatures can still execute.

### N-10 — Signing-day limits are not settlement-day limits; issued EVM signatures do not expire

**Where:** `contracts/near/styx-vault/src/lib.rs:685`, `:702`–`:706`, `:715`–`:724`,
`:755`–`:763`, `:539`–`:568`; `contracts/near/styx-vault/src/evm.rs:43`–`:53`.

**Status:** Design limit. `vm_signed_evm_output_can_arrive_after_payment_expiry` verifies that
an accepted request can produce a correctly recovering raw transaction after payment expiry,
charged to the original day and not the callback day. No late EVM inclusion was tested.

Counters reserve at admission and stay charged on successful signing even if a broadcast never
occurs or the EVM execution reverts. This is conservative over-counting and the run document
already describes a reverted Arc transfer; that historical transaction was not re-fetched in
this review. On the other side, ordinary EIP-1559 transfer calldata contains no validity window:
expiry, pause or recipient/approver revocation on NEAR cannot revoke an already issued raw
transaction. Actual transfers may occur on a later day. The native path similarly reserves by
admission day, though it has a much shorter asynchronous transfer path.

**Suggested handling:** Accept and disclose this admission/signing-budget model for testnet;
report signed, broadcast and settled separately. Do not refund on missing receipts. A requirement
for expiring or settlement-day-capped EVM payments needs destination-side enforcement and a
reconciliation protocol, not just another NEAR timestamp check.

### N-11 — One slow EVM request blocks every configured EVM chain

**Where:** `contracts/near/styx-vault/src/lib.rs:215`, `:364`–`:366`, `:516`, `:714`, `:763`.

**Status:** Design limit, acceptable for a serial testnet demo. The existing
`one_evm_request_at_a_time` test checks serialization on one chain. Cross-chain blocking is
reasoned from the chain-independent is_none check, not a separately run multi-chain PoC.

A delayed Arc signing request blocks a Base request as well, including one from another agent;
native NEAR payments are not gated by this slot. The plan's phrase "one request per chain" is
stronger concurrency than the implementation. Resetting an unrelated chain does not clear it.

**Suggested fix:** Per-chain pending records with request identities and safe recovery, rather
than simply clearing the existing global slot (N-03). If intentional for the demo, state the
serialization accurately.

### N-12 — Upgrade authority exists outside the contract, but no migration procedure exists

**Where:** `contracts/near/styx-vault/src/lib.rs:190`–`:241`, `:243`–`:368`, `:965`–`:968`.

**Status:** Source-reviewed design limit, acceptable for a disposable testnet deployment.

There is no upgrade/migrate entry point, storage-schema version or in-contract migration
protocol. That does not make the account immutable: a retained vault full-access key can deploy
replacement code. The key-install sandbox test confirms such a key can remain. The separately
named owner account is not automatically the holder of that vault-account protocol authority.
Deploying changed code against old Borsh state without a migration can brick reads or reinterpret
state. Redeploying to another account also changes the MPC-derived address.

**Suggested handling:** Document and protect the full-access deployment authority; review a
versioned migration/recovery plan before a persistent deployment. Do not infer immutability from
the absence of an upgrade method, and do not infer that the owner account alone can migrate it.

## Areas checked without a failure in the exercised cases

- **Owner entry points:** all ten rule/withdraw/nonce methods call assert_owner, which checks
  predecessor against the stored owner (`lib.rs:255`, `:283`, `:298`, `:307`, `:313`, `:319`,
  `:326`, `:337`, `:347`, `:362`, `:666`). Existing tests reject agent configuration, approver,
  recipient and withdrawal attempts. This is a source check of all entry points, not an exhaustive
  runtime matrix of every caller/method pair.
- **Installed key scope:** the configured receiver is the vault, allowance is 0.25 NEAR and the
  exact list is pay/pay_with_exception/pay_evm/pay_evm_with_exception/post_record. Existing sandbox
  tests cover ordinary installation and protocol rejection of owner-method calls. N-05 qualifies
  installation-failure and existing-key behavior; remove/re-enable failure interleavings were
  reasoned about, not exhaustively sandbox-tested.
- **Role separation:** enabled agents cannot be enabled approvers and vice versa. A function-call
  key can cryptographically produce an ed25519 message signature; access-key permission does not
  remove that mathematical ability. The actual barrier is approver membership/version and
  RoleConflict, as exercised by the existing agent-self-approval refusal tests.
- **NEP-413:** tag 2147484061 as u32 LE; message string, fixed 32-byte nonce, vault string and
  Borsh Option callback in that order (`lib.rs:861`–`:895`). The existing independent layout test
  covers None. The new callback-URL test signs an independently hand-encoded Some payload and
  the contract accepts it; another new test changes the callback URL and gets BadSignature.
  Existing tests cover wrong signer, hash substitution, signer version, nonce replay and expiry.
- **Payment commitments:** `vm_hashes_commit_every_field_and_separate_domains` mutates every
  declared Payment/EvmPayment field and observes a different view hash. The EVM hash has the
  `styx-evm-payment` prefix. The vault account, payment hash, signer, signer version and expiry
  are in the exception message; nonce/callback are bound by the outer NEP-413 payload. This
  does not cover absent economic fields such as the EVM token/configuration (N-02).
- **Shared caps/arithmetic:** both paths read the same agent/day and vault/day counters. Checks
  first require spent <= limit before evaluating amount <= limit-spent; committed additions
  therefore cannot overflow u128 for admitted requests. Release overflow checks are enabled.
  Existing tests cover agent caps and combined native/EVM spend; the new valid-signature EVM
  exception test still gets VaultDailyLimitExceeded after native spending. Arithmetic reasoning
  is not a fuzz/property-test proof of all possible states.
- **Day/rollback:** `vm_callback_url_and_day_boundary_rollback_preserve_new_spend` accepts a native
  exception with callback URL, moves to day 2, adds spending, rolls back day 1 only, and retries
  the original ID/nonce successfully. The original sandbox verifies a real failed token transfer
  followed by a successful retry. Separate-agent rollback isolation follows the explicit key in
  source; it was not separately randomized. Ordinary MPC Err bookkeeping passes the existing
  signer_failure_rolls_back_and_frees_the_chain test; N-01 limits what that result means.
- **Replay:** both paths share consumed_payments, and the new cross-domain ID-reuse test gets
  PaymentAlreadyUsed. Existing tests cover native replay and approval nonce reuse. Native failed
  transfers free their ID only in the failure callback. N-01/N-03 qualify cross-chain timeout and
  recovery behavior.
- **Callback access:** both methods are private and the new sandbox test verifies the actual ABI
  rejects calls from the separate owner. Direct mock-VM callback calls intentionally model a
  legitimate self callback; they do not demonstrate an external caller bypassing private.
- **EVM encoding:** the existing raw-transaction test matches the cast vector byte for byte;
  the independent k256 recovery test matches its public signer. calldata fixes transfer selector,
  recipient and padded amount; native value is zero and access list empty. Integer/list encoding
  and zero stripping were source-reviewed. The high-s test covers s -> n-s and parity flip.
  normalize does not perform full point/scalar/signature validation; this review found no
  untrusted-caller route around the private callback and configured MPC's own signature checks.
  Arbitrary invalid r/point inputs and every RLP length boundary were not fuzzed.
- **Token dependency:** the test token intentionally allows anyone to mint, checks token
  registration/transfer through near-contract-standards, and uses six decimals. Its minting is
  not treated as a vault authorization bug. Native settlement/rollback was tested with this token;
  production-token deviations and malicious token reentrancy were not tested.

## MPC interface verification

Compared the source at upstream tag **3.18.0**, commit
`e691bdb98d68dcf74653da58d043453a6318765f`, rather than assuming mutable main matches deployment.
Primary sources:

- [sign API and return/timeout handling](https://github.com/near/mpc/blob/e691bdb98d68dcf74653da58d043453a6318765f/crates/contract/src/api/sign.rs)
- [SignRequestArgs JSON compatibility](https://github.com/near/mpc/blob/e691bdb98d68dcf74653da58d043453a6318765f/crates/near-mpc-crypto-types/src/sign.rs)
- [Payload and signature representations](https://github.com/near/mpc/blob/e691bdb98d68dcf74653da58d043453a6318765f/crates/near-mpc-crypto-types/src/primitives.rs)
- [Yield resolution](https://github.com/near/mpc/blob/e691bdb98d68dcf74653da58d043453a6318765f/crates/contract/src/pending_requests.rs)
- [Deposit constant](https://github.com/near/mpc/blob/e691bdb98d68dcf74653da58d043453a6318765f/crates/near-mpc-contract-interface/src/deposits.rs),
  [gas defaults](https://github.com/near/mpc/blob/e691bdb98d68dcf74653da58d043453a6318765f/crates/contract/src/config.rs)

The requested `{request:{path,payload_v2:{Ecdsa:hex32},domain_id:0}}` shape matches those types.
SignatureResponse uses scheme=Secp256k1 with big_r.affine_point (33 bytes hex), s.scalar (32 bytes
hex), recovery_id. Styx's subset struct ignores the additional scheme field; the fixed ECDSA
request and trusted signer's verification supply the curve assumption. Deposit is 1 yoctoNEAR;
the default minimum is 15 Tgas, while Styx attaches 50. Those gas requirements are configurable.
The upstream return callback yields a signature on success and schedules failure on timeout;
that normally enters Styx's Err branch if its own callback can run. It does not prove a signature
never escaped (N-01). This was source verification, not running upstream MPC tests, reproducing
real yield timing, checking current MPC governance/configuration, or matching deployed bytecode.

## Remaining limits

No new public-chain actions, exploit broadcasts, deployed-code equivalence checks, exhaustive
concurrent-receipt scheduling, MPC-node testing, storage/gas exhaustion, formal verification,
fuzzing, economic fee-drain run, migration run or production-token review was performed. The
review does not establish a general absence of authorization or settlement bugs. The highest
priority unanswered question is N-01's signature-escape boundary; local callback rollback alone
is insufficient evidence to close it. All proposed changes remain suggestions for Poulav's review.
