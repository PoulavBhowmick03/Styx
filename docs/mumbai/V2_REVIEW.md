# V2 organization review and proposed interface

7 November 2026, IST. Reviewed source baseline: `1f33dde`.
The document was rebased onto `ce7c376` before publication. Later setup-page changes were not reviewed in this pass.
This is a time-bounded adversarial review, not an audit.

## Recommendation and decision

**Do not attempt the contract migration for this submission. Keep v1 as the money path.**
Stop implementation after this review unless Poulav explicitly overrides this recommendation.
No v2 contract or SDK implementation accompanies this document.

The organization requirement is real. It is also a new authorization system, not a small agent-list change.
The current client, relay, approval page, disclosure record, and watcher assume v1.
Contract tests alone cannot establish that their combined replacements work.
The 04:00 test target also leaves little time for human review and real wallet failures before 05:30.
The stated 09:00 submission deadline does not extend that deployment decision window.

My judgment: another feature is less valuable tonight than a reproducible, reviewed v1 demonstration.
All live evidence described in `STATUS.md` concerns v1. I did not independently repeat those Arc runs.
I cannot promise a reviewed, integrated v2 by 04:00. I recommend that other workers wait for Poulav's decision.
The interface below is precise enough for review, but is **proposed and unimplemented**, not a frozen shipping interface.

Use the remaining time for Poulav's deployed-contract review, a second-machine disclosure run, and a full hosted phone approval rehearsal.
Then preserve the video, receipts, exact build configuration, code hash, and fallback instructions.
The restart and transport findings below deserve attention before more authorization features.

## Architecture comparison

| Design | Benefit | Cost and failure boundary | Recommendation |
| --- | --- | --- | --- |
| One shared vault, agent policies, approver registry | One funding address and one vendor list. Agents join without another deployment. A global cap limits aggregate loss. | A contract defect affects the shared balance. Approvers have broad authority unless scope is explicit. Per-agent accounting and independent revocation versions are necessary. | Preferred next organization version, after the event. |
| One vault per agent, factory | Separate balances and daily counters. A single agent's vault can hold only its allocation. V1 already supplies much of the mechanism. | Repeated funding, vendor updates, deployments, and reconciliation. A factory alone does not add approvers or ERC-1271 to v1. No automatic organization-wide cap. | Good alternative if prefunded isolation matters more than a shared treasury. Do not invent a new factory tonight. |
| Safe plus module | Existing multisig administration. A module can enforce recurring payment policy. | The module creates an additional execution authority. A custom module still needs adversarial review, deployment evidence, and client integration. | Evaluate after the event, not as a deadline shortcut. A Safe can instead own the proposed isolated vault. |

Safe modules can execute through the Safe independently of its ordinary signature path.
The module must enforce its own restrictions. See [Safe module documentation](https://docs.safe.global/advanced/smart-account-modules).
I did not verify a supported Safe deployment or service on Arc. That is a separate integration prerequisite.

For Styx's stated shared-treasury workflow, I recommend the shared vault.
Keep funds inside that vault and restrict its external calls to the configured ERC-20 and signature validators.
A Safe owner controls the vault through ordinary Safe transactions. No module is required for that ownership model.

## Ranked findings in the current repository

These are source findings unless an explicit reproduction appears below. Severity describes the scenario, not demonstrated exploitation.
No confirmed unauthorized v1 vault withdrawal or signature bypass emerged from this pass.

### 1. High: retained payments and raw transactions lack a deployment binding

Locations: `sdk/evm/src/arc_vault/journal.rs:56-83`, `service.rs:499-529`, `service.rs:556-576`.

The journal stores the payment and attempts, but no chain ID, vault address, or expected code hash.
The retry path checks the current environment's vault, then broadcasts retained raw bytes without comparing their destination or chain.

Scenario: retain an unresolved payment for vault A. Reuse its state directory with vault B on the same chain.
The current configuration checks B, but the retained transaction still pays A's vendor from A.
An unsubmitted ordinary proposal also lacks a signed vault domain and can execute against B if B accepts its policy fields.
An exception signature has a vault domain, so that variant fails instead of migrating cleanly.

Fix: persist chain, vault, token, agent, contract version, and a reviewed code identity before the first attempt.
Reject configuration mismatches before reads that classify settlement and before any broadcast.
Decode and bind retained transaction bytes to that context. Separate state roots remain a useful operating precaution.
This scenario is inferred from source. No switched-vault transaction was sent in this review.

### 2. Medium: the relay's hourly alert limit races concurrent requests

Locations: `relay/src/relay.ts:148-158`, `relay/src/relay.ts:197-214`, `relay/src/relay.ts:252-261`.

The limit check occurs before an awaited notifier call. The counter increases only after delivery.
Concurrent requests can all see a free slot and send alerts. Concurrent identical requests can also duplicate an alert.
An agent token holder can therefore bypass the intended hourly budget and flood the owner's approval channel.
This does not grant payment authority. Request storage still has its separate maximum.

Local reproduction against the actual Relay class: five concurrent requests delivered five alerts with `maxAlertsPerHour=1`.
The notifier was a controlled asynchronous fake. No Telegram request occurred.

Fix: reserve a slot and mark each request in flight synchronously, then release failed reservations.
Persist rate-limit state if the limit must survive restart. Add concurrent approval and watcher-notice tests.

### 3. Medium: MCP relay transport permits bearer-token disclosure

Locations: `mcp-server/src/styx_mcp/vault.py:60-66`, `mcp-server/src/styx_mcp/vault.py:104-110`.

Configuration accepts remote HTTP. The request uses the default urllib redirect handler with an Authorization header.
A remote HTTP connection exposes the agent token and pending requests to a network observer.
A redirect can forward that header to another origin. The watcher already refuses redirects (`watcher/watcher.py:23-38`).

Fix: require HTTPS outside loopback and refuse redirects, or explicitly strip credentials on every origin change.
Local reproduction with two loopback HTTP servers: urllib forwarded a synthetic Authorization header across an HTTP 302 redirect.
No real credential was used. This demonstrates the transport behavior, not a hosted-service compromise.

### 4. Medium: a successful receipt alone becomes "settled" in submit

Locations: `sdk/evm/src/arc_vault/service.rs:470-479`, `service.rs:501-513`.

The first path reports settlement from receipt status without checking a matching payment event or the receipt's block number.
The consumed-ID path returns the last attempt's transaction hash without checking `paymentHashById` or that attempt's event.
The independent reviewer performs stronger checks (`verify.rs:195-239`), but callers can act on submit's weaker result first.

Scenario: a partially malformed or inconsistent provider reports success without matching settlement evidence.
The client reports "settled". A lagging failover endpoint can also disagree with the earlier state read.
This relies on incomplete or inconsistent RPC evidence. It is not an on-chain payment bypass.

Fix: require the exact vault event, payment hash, transaction hash, and canonical block context before reporting settlement.
Keep incomplete answers unknown. A receipt also does not establish finality without a finality rule.

### 5. Medium: the example's restart state is atomic but not durable or serialized

Locations: `mcp-server/examples/vault_agent.py:65-71`, `vault_agent.py:114-137`.

The example writes a temporary file and renames it, but does not fsync the file or directory and holds no process lock.
A machine crash can lose the remembered payment ID after submission.
Two concurrent instances can both load empty state, propose different IDs, and pay the same invoice.
The Rust journal serializes its own operations, but cannot identify two different IDs as the same invoice.

Fix: take an exclusive example-state lock before loading state, and hold it for the full run.
Fsync both the new file and containing directory before the first submit.
Use an invoice operation identifier or durable recovery index for the proposal-to-example-state gap.
The earlier restart fix improves normal restart behavior. It does not establish crash durability or concurrent-run safety.

### 6. Low: the default CI path omits setup and restart regressions

Locations: `.github/workflows/ci.yml:59-76`, `pyproject.toml:14-15`.

The workflow covers owner-page and relay tests, but has no setup-page test step.
Its Python paths omit `mcp-server/examples`, which contains the restart regression tests.
A green default run therefore cannot establish those properties.
Fix: collect those tests explicitly and run setup typecheck, unit tests, and browser tests.

## Review scope and limits

I read the requested vault, complete `arc_vault` module, approval logic, relay sources, and MCP vault adapter.
I also inspected the setup code comparison, funding protection, example restart path, watcher, Arkiv adapter, CI, and packaging instructions.
I inspected the repository layout and the adjacent disclosure boundary.
I did not review every line of the older settlement, shielded, transport, coordinator, or Python backends.
A claim of complete whole-repository security coverage within this time budget is not credible.
No findings in those unreviewed paths can be inferred from this report.

The earlier approval-label finding is addressed in the current page: agent values are labeled unverified (`approval.ts:245`).
The page also has chain policy checks (`approval.ts:344-350`). The historical review's open status is stale for that finding.
Splitting invoices is still permitted by v1. Its daily cap, not its per-payment cap, bounds aggregate authorized spending.
The proposed v2 preserves that distinction.

## Proposed authorization rules

- The owner is immutable. Only `msg.sender == owner` reaches administration or withdrawal.
- Every enabled agent has its own limits, expiry, version, and daily spend counter.
- Every payment also counts toward a vault-wide daily cap. Exceptions lift only the per-payment cap.
- Both counters use `block.timestamp / 86400`. Configuration never resets either counter.
- Both caps apply to ordinary and exception payments. Lowering a cap below existing spend blocks further payments that day.
- A UTC day is a bucket, not a rolling 24-hour window. Near midnight, two daily allowances can occur close together.
- Vendors remain vault-wide. Their individual versions prevent old approvals from reviving after removal and re-addition.
- Every agent configuration call increments only that agent's version, including disable and re-enable calls.
- Every approver configuration call increments only that approver's version, including removal and re-addition calls.
- An agent change invalidates that agent's pending payments. Other agents' pending payments survive.
- An approver change invalidates only that signer's pending authorizations. Other signers' authorizations survive.
- A recipient change invalidates only payments naming that recipient. Unrelated recipients' approvals survive.
- Vault cap changes take effect at execution without invalidating pending signatures. Pause does not consume or invalidate them.
- Payment IDs are vault-global and one-time. Approval nonces are one-time per signer, across agents and signer versions.
- A nonce is not reset on removal. A payment hash binds the agent, recipient, amount, token, commitment, versions, and expiry.
- Agents cannot also be enabled approvers. The owner cannot be an agent. Administration rejects these overlapping roles.
- Each listed approver can approve exceptions for every agent. There is no quorum, department scope, or approver spending budget.

A compromised agent can spend its remaining daily allowance among allowed vendors, including by splitting invoices.
It cannot exceed either daily cap or produce its own exception signature.
A compromised approver can sign many exceptions, but needs an enabled agent to submit them.
With a cooperating agent, that approver can authorize spending up to both remaining daily caps.
No separate per-approver cap exists. Calling these signers limited by their own budget would be false.
A compromised owner can withdraw the entire balance. The owner remains the treasury trust root.

Removal races follow transaction order. A payment ordered before removal can settle. A payment ordered after removal must fail.
Neither a pending admin transaction nor a front-end off switch revokes authority before execution.
Removal followed by re-addition must never revive old signatures.

For contract signers, use `isValidSignature(bytes32,bytes)` through STATICCALL and require the ERC-1271 magic value.
EOA signatures use canonical low-s ECDSA with v of 0/1/27/28. Contract signatures are arbitrary bytes, not fixed 65-byte arrays.
Validator reverts, short returns, wrong magic, or unavailable validation cannot establish approval.
External signature validation requires a reentrancy guard around payment execution and a bounded return-data copy.
The current validity of a smart wallet signature can change. Current validation cannot establish historical validity.
See [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271).

The immutable owner uses signer version zero. Other signers must match their current enabled approver version.
Undeployed counterfactual wallets and ERC-6492 are outside this proposal.

## Exact proposed Solidity interface

Parameter names, order, widths, event indexing, and return order below are normative for this proposal.
All configuration calls are owner-only. Both payment functions and withdrawal use the same reentrancy lock.
`configureAgent` rejects zero addresses and role overlap. `setApprover` rejects zero and the owner address.
`setRecipient` rejects zero and the vault itself. Constructor rejects zero owner or token.
The initial daily cap is zero, all role versions are zero, and all agents and approvers are disabled.
The owner is implicitly authorized without insertion into the approver registry.

```solidity
struct Payment {
    bytes32 paymentId;
    address agent;
    address token;
    address recipient;
    uint256 amount;
    bytes32 evidenceCommitment;
    uint256 policyVersion;       // This agent's version, never a global version.
    uint256 recipientVersion;
    uint64 validUntil;
}
struct ExceptionAuthorization {
    bytes32 paymentHash;
    address signer;
    uint256 signerVersion;
    uint256 approvalNonce;
    uint64 authorizationExpiry;
}

constructor(address vaultOwner, address vaultToken);
function configureAgent(address agent, uint256 perPaymentLimit, uint256 dailyLimit,
    uint64 validUntil, bool enabled) external;
function setApprover(address approver, bool enabled) external;
function setRecipient(address recipient, bool allowed) external;
function setVaultDailyLimit(uint256 limit) external;
function pause() external;
function unpause() external;
function withdraw(address to, uint256 amount) external;
function pay(Payment calldata p) external;
function payWithException(Payment calldata p, ExceptionAuthorization calldata a,
    bytes calldata signature) external;
function domainSeparator() external view returns (bytes32);
function hashPayment(Payment calldata p) external pure returns (bytes32);
function exceptionDigest(ExceptionAuthorization calldata a) external view returns (bytes32);
function contractVersion() external pure returns (uint256); // Always 2.
function owner() external view returns (address);
function token() external view returns (address);
function paused() external view returns (bool);
function vaultDailyLimit() external view returns (uint256);
function agentPolicy(address agent) external view returns
    (uint256 version, uint256 perPaymentLimit, uint256 dailyLimit, uint64 validUntil, bool enabled);
function approverState(address signer) external view returns (uint256 version, bool enabled);
function allowedRecipient(address recipient) external view returns (bool);
function recipientVersion(address recipient) external view returns (uint256);
function spentByAgentDay(address agent, uint256 day) external view returns (uint256);
function spentByDay(uint256 day) external view returns (uint256); // All agents combined.
function consumedPayment(bytes32 paymentId) external view returns (bool);
function paymentHashById(bytes32 paymentId) external view returns (bytes32);
function consumedApprovalNonce(address signer, uint256 nonce) external view returns (bool);

event AgentConfigured(address indexed agent, uint256 indexed version,
    uint256 perPaymentLimit, uint256 dailyLimit, uint64 validUntil, bool enabled);
event ApproverSet(address indexed approver, uint256 indexed version, bool enabled);
event RecipientSet(address indexed recipient, uint256 indexed version, bool allowed);
event VaultDailyLimitSet(uint256 limit);
event Paused();
event Unpaused();
event OwnerWithdrawal(address indexed to, uint256 amount);
event PaymentExecuted(bytes32 indexed paymentId, address indexed agent,
    address indexed recipient, uint256 amount, bytes32 paymentHash,
    bytes32 evidenceCommitment, uint256 policyVersion, uint256 recipientVersion,
    uint256 perPaymentLimit, uint256 dailyLimit, uint256 vaultDailyLimit,
    uint256 day, uint256 agentDaySpentAfter, uint256 vaultDaySpentAfter,
    bool exception, address signer, uint256 signerVersion, bytes32 approvalDigest);

error NotOwner();
error NotAgent();
error VaultPaused();
error PolicyExpired();
error AgentMismatch();
error TokenMismatch();
error PolicyVersionMismatch();
error RecipientVersionMismatch();
error PaymentExpired();
error ZeroAmount();
error RecipientNotAllowed();
error PaymentAlreadyUsed();
error DailyLimitExceeded();         // Agent cap.
error VaultDailyLimitExceeded();    // Aggregate cap.
error PerPaymentLimitExceeded();
error PaymentHashMismatch();
error ApproverNotAllowed();
error SignerVersionMismatch();
error BadSignature();
error ApprovalNonceUsed();
error AuthorizationExpired();
error TransferFailed();
error ZeroAddress();
error InvalidRecipient();           // Vault itself.
error RoleConflict();
error Reentrancy();
```

`approverState(owner)` returns `(0,true)`. Every other address starts at `(0,false)`.
Versions increment even for repeated identical configuration. Version overflow reverts through checked arithmetic.
An expired agent policy can remain enabled. Expiry still blocks all payments.
There is no native receive function, fallback, arbitrary-call function, owner transfer, or upgrade path.
Withdrawal rejects zero and the vault itself. It remains possible while paused.

Payment checks occur in this order:

1. Acquire the reentrancy lock. Require `agentPolicy[msg.sender].enabled`, otherwise `NotAgent`.
2. Require unpaused, current agent policy, matching `p.agent == msg.sender`, and the configured token.
3. Require agent version, payment expiry, nonzero amount, nonzero recipient, recipient allowlist, and recipient version.
4. Require unused payment ID. Require remaining agent daily capacity, then remaining vault daily capacity.
5. For ordinary payments, require the per-payment limit.
6. For exceptions, require the exact payment hash, signer membership, signer version, unused signer nonce, and authorization expiry.
7. Check the exception signature. Then consume its nonce, the payment ID, and both daily counters.
8. Emit `PaymentExecuted` and transfer the exact ERC-20 amount. A failed transfer reverts all effects and the event.

All expiries are inclusive: a timestamp equal to an expiry is valid.
Daily capacity uses subtraction after a `spent > limit` check, so lowered limits do not underflow.
Routine events use `exception=false`, zero signer, zero signer version, and zero approval digest.
Exception events use the exact authorization signer, version, and digest.
No exception bypasses membership, pause, expiry, token, vendor, replay, or daily-cap checks.
Transfers require the recipient's balance increase to equal the amount, as in v1.
The token remains trusted to implement ordinary ERC-20 behavior.

## Exact EIP-712 encoding and shared vector

Domain fields, in order:
`EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`.
Name: `StyxPolicyVault`. Version: `2`. Chain: current `block.chainid`. Contract: this v2 vault.

```text
Payment(bytes32 paymentId,address agent,address token,address recipient,uint256 amount,bytes32 evidenceCommitment,uint256 policyVersion,uint256 recipientVersion,uint64 validUntil)
ExceptionAuthorization(bytes32 paymentHash,address signer,uint256 signerVersion,uint256 approvalNonce,uint64 authorizationExpiry)
```

`paymentHash = keccak256(abi.encode(PAYMENT_TYPEHASH, every Payment field in declaration order))`.
`authorizationHash` uses the same construction for `ExceptionAuthorization`.
`exceptionDigest = keccak256(0x1901 || domainSeparator || authorizationHash)`.
The wallet signs the authorization, with `ExceptionAuthorization` as primary type. It does not sign `Payment` as primary type.
No nested Payment type is included in the authorization type string. Its bytes32 hash supplies the binding.
EIP-712 alone provides no replay protection. The ID and nonce stores supply it. See [EIP-712](https://eips.ethereum.org/EIPS/eip-712).
Evidence commitments retain v1's `keccak256("VAULT_EVIDENCE_V1" || salt32 || invoiceBytes)` construction.

The following is the single shared vector. It contains public addresses and hashes, with no signing key.

```json
{
  "domain": {
    "name": "StyxPolicyVault",
    "version": "2",
    "chainId": "31337",
    "verifyingContract": "0x1111111111111111111111111111111111111111"
  },
  "paymentType": "Payment(bytes32 paymentId,address agent,address token,address recipient,uint256 amount,bytes32 evidenceCommitment,uint256 policyVersion,uint256 recipientVersion,uint64 validUntil)",
  "authorizationType": "ExceptionAuthorization(bytes32 paymentHash,address signer,uint256 signerVersion,uint256 approvalNonce,uint64 authorizationExpiry)",
  "payment": {
    "paymentId": "0x0101010101010101010101010101010101010101010101010101010101010101",
    "agent": "0x2222222222222222222222222222222222222222",
    "token": "0x3333333333333333333333333333333333333333",
    "recipient": "0x4444444444444444444444444444444444444444",
    "amount": "6000000",
    "evidenceCommitment": "0x0505050505050505050505050505050505050505050505050505050505050505",
    "policyVersion": "3",
    "recipientVersion": "2",
    "validUntil": "1800000000"
  },
  "authorization": {
    "paymentHash": "0xde5f4caf50fab61c41387225690fa7bc32e60fa2bd14cadee26c9e80697e3fe0",
    "signer": "0x5555555555555555555555555555555555555555",
    "signerVersion": "4",
    "approvalNonce": "7",
    "authorizationExpiry": "1799999900"
  },
  "expected": {
    "paymentTypeHash": "0x15d3e62976183acb16dd9c5e3a105fac50978894b73572a44ee5bbd680c06ff1",
    "authorizationTypeHash": "0x07b3e3056d0dbc43fc752e8be644f4d501e35738773443d766313a340719b99d",
    "domainSeparator": "0x70ab38861e8285ed06070f93c4113300ce9c837831973e6ad2b4c1deeb323565",
    "paymentHash": "0xde5f4caf50fab61c41387225690fa7bc32e60fa2bd14cadee26c9e80697e3fe0",
    "authorizationHash": "0x55fa6b6cf177014cbdcb756a19607eff7e260d5262c60e9090fddae8db152af5",
    "approvalDigest": "0x8035116dccbce04853c0fb8bdeb540883e41e35b92248fad2cf2ea4024492694"
  }
}
```

The six expected outputs agree between local viem hashing and independent `cast abi-encode` plus `cast keccak`.
This checks encoding agreement only. No v2 contract checks this vector yet.

## Required integration work if Poulav overrides the recommendation

**Claude 1:** version the pending, signature, and reviewer formats. Do not reinterpret a v1 file as v2.
Use `vault-pending-approval/2` and `vault-approver-signature/2` for the proposed v2 flow.
The pending envelope retains v1's fields, with the new Payment and ExceptionAuthorization structures above.
The signature envelope retains `paymentId`, `approvalDigest`, and `signature`, and adds `signer` and decimal-string `signerVersion`.
Every integer in these files remains a canonical decimal string. Signature hex can have any even byte length for contract signers.
The pending authorization names its intended signer before hashing. It cannot switch signers after approval.

The page must read agent, recipient, and signer versions independently from the configured chain.
The relay must authenticate each agent separately and bind its token to that agent and vault.
A shared agent bearer token grants cross-agent access to requests even though the contract still binds payment authority.
A signer must be the owner or a current approver. EOA address recovery alone cannot validate a contract owner.
ERC-1271 validation failure or RPC failure must not be reported as approval.
A Safe's threshold owners sign for the Safe address. A single connected Safe owner EOA is not the vault owner.
Safe signature collection needs its own tested wallet flow.

**Claude 2:** show the selected agent and its policy on every action.
Show both remaining daily caps, UTC reset semantics, and the scope of every approver.
Show that removal takes effect only after its transaction executes.
An agent join request is untrusted input. It never enables a wallet without an owner transaction.
Preserve explicit v1 configuration and funding support.

**Codex, in a future implementation:** keep the current CLI protocol and v1 defaults.
Select v2 explicitly through a versioned configuration, and require `contractVersion() == 2` before using its ABI.
Add an optional signer to `request_approval`, defaulting to the on-chain owner.
Persist the selected deployment and signer version in the journal before issuing the request.
Keep arbitrary signature bytes throughout v2. Do not widen the existing v1 signature type silently.
Create distinct v2 event decoding and reviewer records. V1's event cannot describe the two spend counters or approver authority.
Historical ERC-1271 authorization needs execution evidence and reviewed contract code, not a present-day signature call alone.
The watcher needs all configured agents or event-driven discovery, plus per-agent and aggregate thresholds.

## Tests required before any implementation is accepted

Write failing tests before the contract. At minimum:

- A1: oversized routine payment fails. Splitting stays within the agent and vault daily caps.
- A2: agent-signed exception fails. Role overlap is refused in both configuration directions.
- A3: changing recipient, amount, agent, token, commitment, versions, expiry, signer, nonce, chain, or vault fails.
- A4: payment ID and signer nonce replay fail, including across agents and after remove/re-add.
- Agent B configuration preserves A's pending approval. Changing A invalidates A without resetting A's spend.
- Approver B configuration preserves approver A's pending authorization. Removing A invalidates A immediately in execution order.
- Removing and re-adding a recipient does not revive old approval. An unrelated vendor change preserves it.
- Same nonce for different signers works once each. Same signer nonce for a different agent fails.
- Both transaction orderings of payment versus agent removal, approver removal, and cap reduction behave as specified.
- Each daily cap is binding on both payment paths, after policy changes, and across disable/re-enable.
- Two agents can each remain within their own cap while the second payment fails on the aggregate cap.
- Exact expiry and UTC midnight boundaries behave as specified. Lowered limits do not underflow.
- Owner EOA and ERC-1271 owner can authorize exceptions. Only the owner address can call withdrawal and administration.
- A threshold-wallet fixture requires its threshold. One participant EOA cannot administer the vault directly.
- ERC-1271 wrong magic, short return, revert, large return, revoked signature, and reentrant callbacks fail safely.
- Arbitrary-length contract signatures work. Malformed and high-s EOA signatures fail.
- Transfer failure, inexact balance delta, and reentrancy roll back IDs, nonces, counters, and logs.
- V1 and v2 run through the real CLI on Anvil, including timeout, crash recovery, export, and independent verification.
- Existing v1 tests stay green. All three implementations agree on the shared vector.

These are acceptance requirements, not claims that those tests exist or pass.

## Commands and evidence from this review

- `git pull --ff-only origin main`: succeeded. The active work branch is `codex/v2`.
- `forge test --summary`: 84 passed, including 44 policy-vault tests and A1–A4. No failures.
- `cargo test arc_vault --lib --locked` in `sdk/evm`: 12 passed. No failures.
- Shared proposed v2 vector: six outputs agree between viem and cast.
- Relay concurrency reproduction: five alerts delivered despite an hourly limit of one, with a fake notifier.
- urllib redirect reproduction: a synthetic Authorization header reached a different loopback origin.
- Other findings are source review results. No hosted-service exploit was attempted.
- No v2 contract, SDK changes, deployment, Arc transaction, key access, or live wallet test occurred.
- Full Rust, Python, browser, hosted, and second-machine suites were not repeated for this document.

**Poulav must decide:** accept the recommendation and finish v1 evidence, or explicitly authorize a new v2 implementation despite this review.
A decision to proceed still requires human contract/signing review and the 05:30 live-path gate.
