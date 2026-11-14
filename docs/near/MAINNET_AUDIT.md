# Styx contract mainnet-readiness review

Date: 14 November 2026. Reviewed source: `60b9932905bbad5c3c28a0d65cc0b18a88152a2f`
(`sentinels`). **Release decision: do not deploy this build with mainnet funds.**

This is a source review with local reproductions, not certification or a guarantee that every
vulnerability has been found. The contract implementation was not changed. Five tests were added
to `contracts/near/styx-vault/tests/audit_pocs.rs`. The unfinished Sentinel Python package and its
workspace changes were preserved and are outside this contract review. No on-chain transaction
was submitted during this review. The existing testnet deployment is not a mainnet acceptance test.

## Scope and trust model

Reviewed all three contracts: vault `src/lib.rs` and `src/evm.rs`; factory `src/lib.rs` and
`build.rs`; test token `src/lib.rs`. Also read contract manifests, build/deploy scripts, existing
unit/sandbox/audit tests, and the earlier `AUDIT_NEAR.md`. No Makefile or additional AGENTS.md
was found in this worktree. Earlier findings were rechecked against current source; old line
numbers and test counts are not evidence for this build.

The owner is trusted to choose policy, recipients, approvers, MPC signer, EVM token contracts and
gas limits. Agents and sentinels can be compromised. Approvers authorize exact exceptions rather
than general spending. Native NEAR pays storage, access-key gas and cross-contract deposits.
A NEAR token contract and the MPC service are external dependencies, with independently failing
receipts and callbacks. A public EVM signature can be submitted by anyone after issuance.
Destination token behavior, decimals, upgrades, sanctions/pauses and settlement are separate trust
boundaries. Mainnet destination contracts and actual production deployment addresses were not
provided, so those implementations and their deployed bytecode are not audited here.

Factory-created vaults have no initial access keys and no upgrade method. The factory has a deploy
key in the existing testnet setup: compromise can change code for FUTURE vaults, not directly
replace existing children. Direct deployments can retain full-access keys and need a separate
key inventory. Owner compromise defeats owner-controlled limits by design.

## Findings overview

| ID | Severity / classification | Finding | Evidence |
| --- | --- | --- | --- |
| M-01 | Release blocker | Factory mainnet vaults default permanently to testnet MPC signer | New mock-VM reproduction + factory source |
| M-02 | Medium | Stale MPC callbacks clear newer locks, reverse nonce resync and overwrite outputs | Existing mock-VM reproductions rerun |
| M-03 | Medium | Malformed successful signer responses strand reservations and global EVM lock | Existing Wasm sandbox reproduction rerun |
| M-04 | Medium, configuration-dependent | Failed agent/sentinel key installation leaves role enabled; retries do not repair permissions | Existing agent + new sentinel Wasm reproductions |
| M-05 | Medium | Agent-controlled payment ID permits disproportionate vault-funded storage growth | New mock-VM reproduction; exhaustion not attempted |
| M-06 | High IF external signature exposure occurs; unresolved | Signature-failure rollback can release budget for an externally usable authorization | Source reasoning; NOT a demonstrated exploit |
| M-07 | Medium if pause is sold as revocation | Pause/revocation does not cancel pending or issued external payments | New mock-VM reproduction + EVM/EIP-3009 semantics |
| M-08 | Medium economic limit | Payment limits exclude aggregate EVM gas and use raw units across assets | Source; no economic draining run |
| M-09 | Low | Settlement evidence combines old payment versions with current policy limits | Existing mock-VM reproduction rerun |
| M-10 | Low operational risk | No upgrade, migration or comprehensive recovery path for factory vaults | Full public-method inventory |
| M-11 | Low build risk | Factory build can embed stale vault WASM; toolchain not pinned | Build script source |
| M-12 | Production exclusion | Test token permits unrestricted minting | Token source; intentional test behavior |

No unrestricted outsider theft or bypass from a correctly installed pause-only sentinel key was
proved. That statement is limited to this review; it is not a proof of absence. Several passing
audit tests deliberately demonstrate bugs.

## Detailed findings

### M-01 — Mainnet factory defaults to the testnet MPC contract

`styx-vault/src/lib.rs:32,261-282` uses `v1.signer-prod.testnet` when `mpc_signer` is absent.
`styx-factory/src/lib.rs:68` always supplies null. The signer has no setter. Deploying this factory
on mainnet therefore creates vaults pointing at the testnet signer account name on the MAINNET
ledger, not a cross-network call to testnet. That target is not the documented production signer.
NEAR's MPC repository identifies `v1.signer` as mainnet; production deployment and its key/domain
must be independently verified before use.

`vm_factory_style_initialization_on_mainnet_keeps_testnet_signer` initializes a `.near` vault
context and observes the testnet default. This is a configuration proof, not a live mainnet failure.
Native token payments are not blocked by this defect; EVM/x402 signing is affected. Funds sent to
an assumed derived EVM address could become inaccessible through this vault's intended interface.

Required correction: network-explicit immutable signer configuration in the factory, verified
against production MPC code/key/domain, plus mainnet-like integration tests. Verify the derived
address BEFORE funding. Do not simply replace a suffix in deployment instructions.

### M-02 — Recovery does not invalidate old callbacks

`set_evm_nonce` (`lib.rs:478-484`) changes nonce and clears the global pending flag.
`on_evm_signed` (`:667,692-693`) unconditionally clears that flag, writes `nonce + 1` and replaces
`(chain,nonce)` output, without checking a request ID or recovery generation.

Reproductions: `vm_old_callback_reverts_owner_nonce_resync` changes the nonce to 100, then an old
nonce-0 callback restores it to 1. `vm_old_callback_clears_new_lock_and_overwrites_signed_tx`
starts a second request after recovery and shows the old callback clearing its lock and two
outputs replacing the same slot. The owner recovery action is a precondition. These tests manually
deliver callbacks; they do not prove two conflicting same-nonce EVM transactions both settle.

Use durable request identities and generation-bound pending state. Recovery must reconcile issued
signatures and destination nonce before authorizing replacement work. A stale callback must never
mutate a newer request. Keeping the old output is necessary even if a replacement is authorized.

### M-03 — Successful malformed callback data bypasses cleanup

`on_evm_signed` and `on_x402_signed` (`:665,:750`) accept typed `Result<MpcSignature,PromiseError>`.
The SDK deserializes a successful promise's bytes before entering the method. A successful empty or
malformed response panics before rollback or lock cleanup. The sandbox reproduction
`sandbox_empty_success_from_signer_strands_lock_and_accounting` demonstrates failed deserialization,
retained consumed-payment marker, 60 charged units, and a stuck EVM request. Nonce reset clears
only the lock; it does not restore the payment or counter.

The x402 wrapper uses the same typed pattern but was not separately exercised with malformed bytes.
Its reservation-stranding consequence is source inference; x402 does not use the global nonce lock.
A malformed NEP-141 success can similarly prevent `on_transfer` settlement reporting; the configured
token is a trusted dependency and an actual transfer may already have occurred.

Parse bounded raw callback results inside a controlled state transition. Record unavailable or
malformed results as UNKNOWN when an external signature/transfer may exist. Do not solve this by
unconditionally releasing the reservation; M-06 explains why that can be unsafe.

### M-04 — Role registry and actual access-key permissions diverge

Agent policy is saved before AddKey (`:310-325`); sentinel membership is saved before AddKey
(`:393-410`). Neither has a result callback. Adding an already installed key fails at the protocol
layer. The registry stays enabled, and repeating enable becomes a no-op rather than repairing it.

`sandbox_failed_install_leaves_enabled_policy_and_full_access_key` reproduces this for agents.
New `sandbox_failed_sentinel_install_leaves_enabled_role_and_full_access_key` reproduces it for
sentinels, including a retry that succeeds while the existing full-access permission remains.
The sentinel test also verifies owner disable removes the key and registry entry.

This requires an already installed full-access key chosen by the owner/direct deployer. It is NOT
an elevation of a correctly restricted key. Factory vaults start without such keys. A depleted
native balance or other action failure can instead create an enabled but unusable role.

Use a pending installation state and reconcile the AddKey outcome before exposing an enabled role.
A failed attempt must be visible and recoverable. Owner tooling must read final receipt outcomes
AND on-chain permissions; membership alone cannot prove pause-only capability.

### M-05 — Storage expenditure is not bounded by payment limits

`check_shared` and `check_evm_payment` (`:939-970,:1058-1086`) do not bound `payment_id` length or
require a canonical fixed-size ID. `set_payer` (`:1157-1164`) writes that entire ID as part of a raw
storage key. Consumption maps, counters, records, signatures and signed transactions also grow
permanently, without per-agent storage budgets or garbage collection.

New `vm_one_base_unit_payment_can_charge_disproportionate_payment_id_storage` admits a payment
of one base unit with an 1024-byte ID and observes at least 1024 bytes added to mock storage with
zero deposit. An initial 8192-byte-ID probe was rejected by the host key-length limit (2048 bytes);
therefore single-entry size is protocol-bounded, even though the contract adds no application bound.
The accepted probe does not execute the transfer or exhaust a funded sandbox account. At the NEAR
storage price, native balance must back those bytes; total draining cost is not measured here.

An enabled malicious agent is required. Its function-call gas allowance is finite, which limits
transaction gas but is not a storage-byte quota. Tiny token payments can reserve substantially more
native NEAR than their token value suggests. Failed callbacks and persistent records complicate
safe reclamation.

Require bounded/canonical IDs and bounded evidence/sealed-record inputs. Add per-agent creation,
storage and gas budgets; measure storage deltas under protocol execution. Preserve replay protection
when pruning: removing consumption markers can re-enable previously signed payments.

### M-06 — Unknown external signatures cannot safely be refunded as non-payments

`on_evm_signed` rolls back on missing/invalid results (`:721-734`), and `on_x402_signed` does so on
an invalid or unexpected signature (`:800-807`). Failure of delivery to this callback is not proof
that an external usable signature does not exist. A signature could be observed from MPC execution
or obtained before a delivery/gas failure while the local callback reports a failed request.
If such a signature remains usable and the budget is released, later authorized payments can
exceed the intended spending reservation when both are executed externally.

This is a conditional dependency-boundary concern, inherited from N-01 and rechecked in current
source. No end-to-end exploit or signature-exposure path against the current MPC service was proved.
Severity is high only if that exposure is established. It is an unresolved mainnet acceptance issue,
not a confirmed high-severity theft finding.

Investigate the exact MPC request/response/retry contract and logs, callback gas behavior, and timeout
semantics. Use durable reservation states (requested, signed, settled, failed-before-signing, unknown).
Only release on evidence that external execution cannot occur. Expiry helps x402 after its deadline;
ordinary EVM transfers encode no payment deadline.

### M-07 — Pausing stops admission, not outstanding authorization execution

Payment validation checks `paused` before requesting the transfer/signature. Callbacks do not retract
their promises when paused, an agent is disabled, or a recipient is revoked. New
`vm_pause_and_recipient_revocation_do_not_cancel_pending_evm_signature` requests a payment, pauses,
revokes its recipient, then obtains a signed output and an advanced nonce from the old callback.

Already signed raw EVM transfers remain executable at their nonce with no timestamp expiry.
EIP-3009 authorizations remain executable until `valid_before`, independently of the NEAR pause.
There is no maximum future `valid_until`: an agent can request a long-lived x402 authorization
while its policy is valid. Existing late-signature test confirms the older day's reservation remains
charged and a signed output can arrive after expiry. No destination broadcast was made in these tests.

Specify this boundary in product claims and incident procedures. Bound authorization lifetimes;
consider destination-enforced policy/deadlines and a cancellation/replacement procedure. Merely
checking `paused` in the callback is insufficient: an external signature may already be public.

### M-08 — Token caps do not bound all economic spend

`set_evm_chain` (`:453-460`) caps each transaction's fee fields, but there is no aggregate daily
native-EVM gas budget or payment-count budget. A malicious enabled agent can choose many tiny allowed
transfers; each spends gas from the derived EVM address. This is bounded by configured fee limits,
spending counts implied by the smallest token unit, and available funding, not by the token amount cap.
No mainnet gas-drain trial was performed.

The same daily counters sum raw `u128` amounts for native token, EVM chains and x402. No decimal or
asset-price normalization is performed. This is reasonable only for an explicit same-unit asset policy
(e.g. approved 6-decimal dollar tokens); arbitrary `set_evm_chain` tokens do not preserve it. Add
asset/decimal constraints or separate asset budgets, plus an explicit fee budget and concurrency policy.

### M-09 — Settlement logs can misstate the policy checked

`on_transfer` (`:598-621`) reloads agent policy and vault cap at callback time while logging the
payment's earlier policy version. EVM callback similarly reloads policy (`:694-710`).
`vm_callback_event_uses_changed_policy_instead_of_original_policy` changes limits from 100/250 to 1/1
and disables the agent between request and success. The event reports payment 60, old version 1,
and new 1-unit limits. Enforcement happened at admission; the event is misleading evidence.

Snapshot admission policy with the reservation and emit that snapshot plus any distinct settlement
state. Reviewers and sentinels must not infer historical authorization from current-state limits.
`post_record` is payer-bound now, but still accepts consumed/in-flight payments, not only settled ones
(`:563-583`). A sealed record event is therefore not payment-settlement proof.

### M-10 — Immutable deployments need a complete recovery specification

Factory vaults intentionally cannot deploy new code. There is no owner rotation, native NEAR withdrawal,
contract-controlled upgrade/migration, or general pending-payment repair. Owner token withdrawal handles
only the configured NEP-141 token, not arbitrary accidentally sent tokens. EVM recovery must currently
use the agent payment path, owner configuration and nonce management; no dedicated rescue path exists.

These are design constraints, not outsider exploits. With known callback faults they increase the cost
of permanently deploying this build. Define native/token/EVM recovery, owner loss/rotation, and movement
to a fixed replacement vault before irreversible production launch. New vault addresses also derive
different external addresses; relocation does not automatically move previously funded EVM assets.

### M-11 — Factory source changes can coexist with stale embedded vault code

`styx-factory/build.rs:10-15` returns if the vault WASM path exists. Although source changes cause
its build script to rerun, it does not rebuild an existing artifact. The factory then includes those
bytes (`src/lib.rs:19`), potentially deploying an older vault than the current source review.
`deploy_v3.sh` builds vault first and therefore avoids this particular path; a plain factory build
is not equivalent. `rust-toolchain.toml` selects moving `stable`; reproducible metadata advertises
an older toolchain image while its configured command is non-reproducible.

Require a clean, pinned build and an attested source-to-artifact mapping. Verify factory code hash,
embedded vault hash and fresh child hash against the reviewed artifact. Current testnet artifact
hashes in TESTNET_RUN.md are not proof of a future mainnet build.

### M-12 — Exclude the test token from production

`styx-usdc/src/lib.rs:29-36` allows anyone to mint any amount to any registered account. This is clearly
intentional and documented. It must not be deployed or presented as backed USDC or a valuable production
asset. Its standard transfer/storage implementation is delegated to near-contract-standards; this review
is not an audit of every upstream token dependency or of Circle's production token implementations.

## Controls verified and coverage limits

- Owner methods use predecessor equality, not signer-account identity. Agent payments require vault
  predecessor plus an enabled signer public key. Native token/agent/policy/recipient bindings are checked.
- Daily limits use subtract-before-add comparisons, so accepted additions do not overflow. Reservations
  happen before async work; normal failures subtract only the original payment and its original day.
- NEP-413 binds vault account, payment hash, signer version, nonce, expiry and callback URL. Agent/approver
  role conflicts and replay guards are present. EVM hashes bind chain and token with a separate domain.
- Historical token mutation and other-agent record-claim flaws are fixed in current source; current
  regression tests check them. No claim is made that old deployed vaults contain those fixes.
- EIP-1559 encoding, low-s normalization and independent EIP-712 digest tests exist. x402 checks signature
  recovery against configured `from`; ordinary EVM callback does not independently verify the recovered
  signer. It trusts MPC response correctness and can publish an unusable output on a wrong response.
- Sentinel count, byte-length, idempotency and role-conflict tests exist. New Wasm test checks actual
  installed permission, successful pause, refusal of unpause/pay/rule/callback methods, and owner unpause.
- Factory sandbox checks successful creation/ownership, no initial keys, duplicate-name refund, minimum
  deposits and invalid names. Refund events announce scheduling, not successful refund settlement; a lost
  refund to a deleted caller has no durable claim/retry mechanism. No refund-loss scenario was reproduced.
- No independent audit of NEAR runtime, cryptographic host functions, MPC nodes, destination contracts,
  wallet selectors, relay or agent inference is claimed. RPC/indexer compromise and key custody need an
  operational review. No fuzz/property campaign, formal verification or dependency advisory scan was run.

## Required mainnet exit criteria

1. Resolve M-01 and M-02 through M-05, with regression tests that FAIL on this build and PASS on fixes.
2. Resolve the M-06 signature-uncertainty model against actual MPC integration behavior; retain unknown
   reservations until non-executability is established.
3. Decide and document M-07/M-08 semantics, bounded lifetimes, asset units and aggregate fee budgets.
4. Choose immutable/recoverable deployment policy deliberately. Exercise owner rotation/loss and fund
   recovery, including pending work and external assets, before permanently locking code.
5. Test fresh factory children with restricted agent and sentinel keys, approver exceptions, async
   interleavings, gas exhaustion, malformed callbacks, depleted storage/gas balances, invalid signatures,
   recovery and destination reverts. Include actual production-equivalent token/MPC interfaces.
6. Pin dependencies/toolchain, run dependency advisory review, reproduce artifacts from a clean checkout,
   and independently review the fixes and final source-to-deployment hashes. Use a capped canary only
   after those checks; a passing happy-path transaction alone does not establish mainnet readiness.

## Primary references checked

- [NEAR private callbacks](https://docs.near.org/smart-contracts/security/cross-contract-calls/callbacks)
- [NEAR storage cost attacks](https://docs.near.org/smart-contracts/security/storage)
- [NEAR Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures)
- [NEAR MPC repository and production signer](https://github.com/near/mpc)
- [EIP-3009 specification](https://eips.ethereum.org/EIPS/eip-3009)

External references explain protocol assumptions; the local reproductions establish only the behavior
asserted in their tests. Exact validation results follow below.

## Validation results from this review

| Command | Result |
| --- | --- |
| `cargo test --manifest-path contracts/near/styx-vault/Cargo.toml` before new tests | 70 unit + 15 audit reproductions + 2 sandbox passed; doc tests 0 |
| `cargo test --manifest-path contracts/near/styx-vault/Cargo.toml --test audit_pocs` final run | 20 passed: 16 mock-VM and 4 Wasm sandbox tests |
| `cargo test --manifest-path contracts/near/styx-factory/Cargo.toml` | 5 unit + 2 sandbox passed; doc tests 0 |
| `cargo check --manifest-path contracts/near/styx-usdc/Cargo.toml --target wasm32-unknown-unknown` | Passed; one upstream deprecated FT macro warning |

The audit sandbox rebuilt vault WASM and reported SHA-256
`6f91e7b7645089ad57983f080410e4fbf5cb36a4ec6ecac2d3607ef11fab5538`
(base58 `8WXJ31AQKnJk3Ap4jeFNcgrp9xRYoFnpmUrFAAnn26S3`).
The new tests are at `audit_pocs.rs:751` onward. Keys for test execution were generated in memory;
no key material or settings files were added to the repository. Production code was not patched.

An initial storage probe failed at the host key-length boundary; it was corrected to test an
accepted 1024-byte ID. This distinction is included in M-05. The final suite has no failing tests.
New callback ordering tests are mock-VM tests, not network scheduler or EVM settlement proofs.
The correctly restricted sentinel and failed sentinel installation tests exercise actual Wasm,
access-key actions and transaction admission inside local NEAR sandbox.
