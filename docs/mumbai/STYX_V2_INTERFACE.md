# StyxVault v2 integration contract

This document is the implementation handoff for the organization vault.
The contract is `contracts/evm/src/StyxVault.sol`. Tests are in `contracts/evm/test/StyxVault.t.sol`.
V1 remains separate. This implementation does not migrate balances or deployed contracts.
Poulav still reviews contract and signing code before deployment.

## Signing domain and schemas

The EIP-712 domain name is **StyxVault**, version **2**.
The chain ID is the executing chain. The verifying contract is the v2 vault address.
The domain name change invalidates signatures from the earlier proposal.
The single shared vector is [`vector.json`](../../sdk/evm/src/arc_vault/v2/vector.json).
The generated ABI is [`styx-vault.abi.json`](../../sdk/evm/src/arc_vault/v2/styx-vault.abi.json).

```text
Payment(bytes32 paymentId,address agent,address token,address recipient,uint256 amount,bytes32 evidenceCommitment,uint256 policyVersion,uint256 recipientVersion,uint64 validUntil)
ExceptionAuthorization(bytes32 paymentHash,address signer,uint256 signerVersion,uint256 approvalNonce,uint64 authorizationExpiry)
```

`hashPayment` is the EIP-712 struct hash, not a full typed-data digest.
`exceptionDigest` is `keccak256(0x1901 || domainSeparator || authorizationStructHash)`.
The primary type for wallet signing is `ExceptionAuthorization`.
The authorization names its signer before signing. A relay cannot choose another signer afterwards.
Evidence commitments retain `keccak256("VAULT_EVIDENCE_V1" || salt32 || invoiceBytes)`.

The pending schema is `vault-pending-approval/2`.
Its fields are `schema`, `chainId`, `vault`, `payment`, `authorization`, `invoiceReference`, `exceededRule`, and `perPaymentLimit`.
`payment` and `authorization` contain exactly the fields in the type strings.
`exceededRule` is `perPaymentLimit`. The invoice reference and stated limit remain untrusted agent text.

The signature schema is `vault-approver-signature/2`.
Its fields are `schema`, `paymentId`, `approvalDigest`, `signer`, `signerVersion`, and `signature`.
All integer fields in these files use canonical decimal strings.
All byte strings use `0x` hex. Addresses contain exactly 20 bytes, and hashes contain exactly 32 bytes.
EOA signatures have 65 bytes. Contract signatures can have other lengths.
The SDK accepts at most 16 KiB of decoded signature bytes.

## Authority and revocation

Every payment counts toward both the agent's daily cap and the vault's aggregate daily cap.
An exception lifts only the per-payment cap. An approver has no separate spending budget or department scope.
An enabled approver can authorize exceptions for any enabled agent.
A cooperating compromised agent and approver can spend up to both remaining daily caps.
A compromised owner can withdraw all funds.

Daily buckets use UTC midnight, not a rolling 24-hour window.
A policy change never resets spend. A reduced cap below existing spend blocks further payment that day.
Agent, approver, and recipient versions advance independently, including repeated configuration calls.
Removing and re-adding a role or recipient never revives an old approval.
Changing one agent, approver, or recipient preserves unrelated pending approvals.
A vault cap change enforces the new cap at execution without invalidating signatures.
Pause blocks both payment paths. Unpause preserves unexpired approvals.
Revocation takes effect in transaction order, after the removal transaction executes.

An agent cannot also be an enabled approver. The owner cannot be an agent.
Only a direct call from the immutable owner reaches administration or withdrawal.
A Safe owner calls those functions through its own transaction execution.
A threshold participant's EOA cannot call them directly.
Contract signatures use ERC-1271 STATICCALL and its standard magic value.
The current ERC-1271 answer does not establish historical authorization.

## Solidity interface


Parameter names, order, widths, event indexing, and return order below are normative for this implementation.
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

## CLI configuration and methods

Set `STYX_VAULT_VERSION=2` explicitly. Without it, the CLI preserves v1 behavior.
V2 reads only the following namespace:

| Variable | Meaning |
| --- | --- |
| `STYX_VAULT_CHAIN_ID` | Expected chain ID |
| `STYX_VAULT_RPC_URLS` | Comma-separated endpoints, each checked before use |
| `STYX_VAULT_ADDRESS` | V2 deployment address |
| `STYX_VAULT_TOKEN` | Expected ERC-20 token |
| `STYX_VAULT_CODE_HASH` | Independently reviewed runtime code hash, including this deployment's immutables |
| `STYX_VAULT_STATE_ROOT` | Private durable state directory |
| `STYX_VAULT_AGENT_KEY_FILE` | Private agent signer file, needed only for propose and submit |
| `STYX_VAULT_RECEIPT_TIMEOUT_SECONDS` | Optional receipt wait, default 60 |
| `STYX_VAULT_RPC_TIMEOUT_SECONDS` | Optional RPC timeout, default 15 |

The protocol response remains `protocol: 1` for the JSON transport.
V2 also returns `contract_version: 2` from `version`.
The existing methods keep their request parameters and add these capabilities:

- `request_approval` accepts optional `signer`. It defaults to the immutable owner.
- `submit` accepts a v2 signature file through `signature_file`. A retained valid file survives retries.
- `export_record` writes `vault-payment-record/2`.
- `verify_record` accepts `record_file` and checks it against the configured chain and code pin.

A request uses snake_case method parameters. Pending, signature, and exported files use camelCase fields.
The CLI request deadlines remain JSON integers, matching the existing transport.
Amounts remain decimal strings. The SDK supports uint128 amounts and nonces, and uint64 versions and timestamps.
The contract accepts its full Solidity integer widths. Larger values fail closed in this SDK.

The v2 journal lives in a `styx-v2` subdirectory of the state root.
Every record binds the chain, vault, token, code hash, and agent before any submission.
A configuration mismatch stops a retry. Each raw transaction hash must match its retained bytes before rebroadcast.
Use one durable state root per signer and deployment. Independent roots do not coordinate transaction nonces.
An unsubmitted payment can request a different signer, or refresh an expired authorization, under the same payment ID.
This creates a new signer nonce and clears the retained signature. Identical live requests keep their original authorization.
A timeout remains unknown. Retry the same payment ID and retain its state directory.
An unused payment ID does not establish that a pending transaction cannot land later.

Exported records include the exact signature, payment, authorization, event, invoice opening, and settlement pointer.
Verification compares the actual transaction input and canonical receipt with those fields and the code pin.
This proves authorization through the reviewed contract's successful execution.
It does not call a smart wallet today and treat that answer as historical evidence.
Canonical observation is not a finality guarantee. RPC honesty remains a trust assumption.

## Work owned by other teams

Claude 1 must add v2 pending/signature schemas, explicit signer selection, and ERC-1271 handling to the approval page and relay.
Relay agent tokens must bind to each agent and vault. One global agent token does not isolate employees.
The Python adapter must pass the new namespace and optional signer, and accept the versioned artifact formats.
Its current response allowlist rejects `contract_version`, so v2 MCP initialization requires that adapter change.
The adapter must also handle the nested report for `verify_record` if it exposes verification.
A refreshed authorization needs a new pending-file path. The CLI never overwrites an existing file.
After a retained transaction exists, the CLI reconciles it before any authorization refresh.
The existing v1 disclosure CLI does not read v2 records. Use the v2 `verify_record` method until that adapter is updated.

Claude 2 must add agent and approver management, the aggregate cap, and per-agent policy reads to setup.
The initial aggregate cap is zero. No agent can pay until the owner configures both caps and an allowed recipient.
Setup must show the selected vault and agent for every action.
No approval UI, relay, Python adapter, or setup change is included in this branch.

Poulav controls the final human review and deployment decision.
No Arc deployment or transaction is authorized by this handoff.

## Deployment

### Official Arc Studio deployment

Poulav selected the Studio deployment below as the official v2 vault.
These two values came from Poulav's deployment handoff. This branch did not query Arc or send a transaction.

```sh
STYX_VAULT_ADDRESS=0xd596e0fca7b12dc7f92c6beb3c4537fe2794aba8
STYX_VAULT_CODE_HASH=0x4ed8c17d810632423c99decd2c130a16b4c3ff3bea5c4717d1b36fd0ea8512d5
```

[Official vault on the Arc explorer](https://explorer.testnet.arc.io/address/0xd596e0fca7b12dc7f92c6beb3c4537fe2794aba8).
Poulav's contract review and shipping decision remain required.

### Unused Forge deployment

The Forge deployment below goes unused. Its historical reads do not describe the official Studio vault.
Do not use this address or its code hash in deployment pins.

**Deployed with Forge, not Arc Studio.** Studio compiled the unchanged source, but its deployment tool could not set the required fee caps.
The authorized fallback submitted one creation transaction with zero value. No funding or configuration followed.

| Field | Verified value |
| --- | --- |
| Network | Arc testnet, chain ID `5042002` |
| Contract | [`0x8b1D755B5e6957a7384d676baFED4274181e4BC9`](https://explorer.testnet.arc.io/address/0x8b1D755B5e6957a7384d676baFED4274181e4BC9) |
| Deployment transaction | [`0x9d8d291dd2c98a52359a84e49e686839609442e70190f17990e35ecf89888a92`](https://explorer.testnet.arc.io/tx/0x9d8d291dd2c98a52359a84e49e686839609442e70190f17990e35ecf89888a92) |
| Block | `71091654` |
| Receipt status | Success |
| Deployer | `0x2a1397fAB3e8b8d763c95B78B6EbED5b77Ec9ad1` |
| `owner()` | `0xC0296012Cfbb0e6DF5dA7158B65Dbc46DD9650e0` |
| `token()` | `0x3600000000000000000000000000000000000000` |
| `contractVersion()` | `2` |
| `paused()` | `false` |
| `vaultDailyLimit()` | `0` |
| Native / ERC-20 USDC balance | `0` / `0` |
| Runtime code keccak256 | `0x7f5592d4cd5c185cd0cec65474c879fc8aa90e001f672fc36cfec246c4da1336` |
| Runtime size | `8106` bytes |
| Build | solc `0.8.24+commit.e11b9ed9`, optimizer enabled, `200` runs, Cancun |
| Max fee / priority fee | `40000000000` / `1000000000` wei |
| Gas used / effective gas price | `1828730` / `21000000000` wei |
| Source commit | `0d296be` |
| Source SHA256 | `306462b7f968cf79441112cb1537aeeaacf4aeb5e2863651066f3602f96c33c4` |


[Arc Studio source and compilation workspace](https://studio.arc.io/app/f4f4c197-06ec-46ff-b3d1-ea18259cd358).
This URL shows the unchanged contract and its build. It is not evidence of a Studio deployment.
Studio's downloaded source matched `0d296be` byte-for-byte before the fallback deployment.

Both `https://rpc.testnet.arc.io` and `https://rpc.drpc.testnet.arc.io` returned the same receipt block and runtime code hash.
The getter and balance reads above used blocks `71091808` and `71091810`, respectively.
The receipt block was canonical on both providers.

The runtime matches the local optimized build after masking immutable address slots and removing the Solidity metadata trailer.
All immutable patches contain the expected owner or token address. The creation input also matches the local bytecode and constructor arguments exactly.
The deployer's nonce advanced from `0` to `1`. No second deployment was attempted.

Poulav's contract review remains outstanding. The vault is empty and unconfigured.
Only its immutable owner can configure agents, approvers, recipients, or the aggregate daily cap.
The v1 vault was not used or changed.
