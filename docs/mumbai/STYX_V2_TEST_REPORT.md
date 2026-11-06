# StyxVault v2 test report

The contract and SDK pass local tests. The branch is ready for Poulav's code review and integration.
Deployment still needs human review, v2 page and relay integration, and a real-wallet rehearsal.
These checks are tests and source review, not an audit.

## What changed

`StyxVault` adds independent agent policies, delegated approvers, ERC-1271 signatures, and an aggregate daily cap.
Agent, approver, and recipient versions invalidate only the corresponding pending approvals.
Both daily counters remain binding for exception payments and survive policy changes.
Only the immutable owner can administer or withdraw.

The SDK selects v2 explicitly with `STYX_VAULT_VERSION=2`.
It keeps v1's default behavior and separates v2 JSON files, events, records, and journals.
Retained payments bind their chain, vault, token, agent, and reviewed code hash before submission.
Unknown outcomes retain the payment ID and signed transaction bytes.

The exact interface, generated ABI, schemas, configuration, and shared vector are in [STYX_V2_INTERFACE.md](STYX_V2_INTERFACE.md).

## Test results

| Check | Result | Evidence and limits |
| --- | --- | --- |
| Full default contract suite | 83 passed | Includes 39 v2 tests and all 44 retained v1 tests |
| V2 optimized Cancun contract suite | 39 passed | solc 0.8.24, optimizer 200 runs, Cancun |
| Optimized budget fuzz tests | 4,096 cases each | Two properties. One executes 32 policy/payment operations per case |
| Full normal Rust SDK suite | 22 passed, 14 ignored | Includes four v2 unit tests. All fourteen ignored Anvil tests run explicitly |
| Rust core, transport, and durable journal | 13, 8, and 29 passed | Includes the retained storage and crash-recovery tests |
| V2 real CLI on Anvil | 7 passed | Repeated against both default and optimized Cancun deployments |
| Existing v1 Anvil suite | 7 passed | A1–A4, timeout recovery, disclosure, independent verification, and RPC failover |
| Full Python SDK and MCP suite | 40 passed | Includes the scripted agent, relay integration, and disclosure adapter |
| Rust clippy | Passed | Library and tests, with warnings denied |
| Rust formatting and diff whitespace | Passed | The changed Rust module and repository diff |
| Generated ABI | Matches fresh compilation | Includes function signatures, tuples, errors, and event indexing |
| Shared signing vector | Passed | Solidity, Rust, viem, and independent cast ABI/hash calculations agree |
| New CI step | Passed locally | Runs v2 Anvil tests explicitly and the optimized contract suite. Hosted Actions not run |
| Targeted mutation checks | 3 detected | Removing the reentrancy guard, removing the agent cap, or changing the domain causes its targeted test to fail |
| Gitleaks | Passed before commits | Staged changes scanned with the repository configuration |

The normal Rust suite's fourteen ignored tests all ran explicitly: seven v1 cases and seven v2 cases.
Results refer to current main after its project rename and removal of unused subsystems.

## Contract coverage

- A1: the agent cannot bypass its per-payment limit through the ordinary path.
- A2: the agent cannot approve its own exception. Enabled agent and approver roles cannot overlap.
- A3: a signature cannot redirect an exact payment to another recipient or change its signed fields.
- A4: payment IDs and signer nonces cannot execute twice, including across agents.
- Unrelated agent, approver, and vendor changes preserve pending approvals.
- Removal and re-addition do not revive old agent, approver, or recipient versions.
- Payment-before-removal and removal-before-payment follow execution order.
- Agent and aggregate daily caps bind both payment paths. Splitting payments cannot exceed the caps.
- Cap reductions do not reset spend or underflow. UTC rollover starts new counters.
- Policy, payment, and authorization expiry boundaries remain inclusive.
- Owner EOA signatures and two-participant ERC-1271 signature fixtures authorize exact exceptions.
- Wrong magic, short return, validator revert, large invalid return, and callback reentry fail safely.
- High-s, malformed, wrong-chain, wrong-vault, and altered-field signatures fail.
- False-return, reverting, inexact, and reentrant token transfers roll back IDs, nonces, and counters.
- A failed transfer can retry the same exact payment and nonce after the token recovers.
- Owner-only withdrawal remains available while paused. Agents and approvers cannot reach administration.
- Event fields match their ABI, exact authorization, and both spend counters.

The sequence model changes policies, enabled agents, pause, recipients, aggregate caps, and UTC days.
It compares payment outcomes with a separate budget model and checks token conservation after every operation.

## Real CLI scenarios on Anvil

1. Routine and delegated exception payments settle. An unrelated agent configuration preserves the pending exception.
2. Exported records pass independent verification. Altered signature bytes and wrong-chain records fail.
3. Removing an approver after settlement does not invalidate historical execution evidence.
4. Timeout and restart preserve the exact transaction hash and payment ID, without a second payment.
5. Changing the deployment configuration rejects a retained payment before rebroadcast.
6. A contract approver accepts a 130-byte signature. A contract owner requires both signature participants.
7. A retained signed transaction reverts after approver removal. Its payment ID and approval nonce remain unused.
8. An unsubmitted payment can switch signers under the same payment ID. The old signature file is refused.
9. An expired authorization can refresh under the same payment ID. The old signature file is refused.

These scenarios are grouped into seven integration test functions.
The two-participant wallet is a signature-validation fixture, not an actual Safe deployment.
Its execution helper exists for test setup. It is not a wallet implementation for deployment.

The mutation checks ran only in a temporary checkout. No broken variant is part of the branch.

## Regression found and corrected

A new failing test exposed an SDK recovery error: an unsubmitted payment could not replace its removed approver.
The fixed flow creates a fresh authorization nonce for a replacement signer, signer version, or expired authorization.
It preserves the exact payment and payment ID, and clears the old retained signature.
Identical live requests keep their original authorization.
Once a transaction exists, reconciliation takes precedence over authorization refresh.

Validation ran in an isolated integration worktree. The shared checkout's local changes were preserved.

## Commands

```sh
forge test --root contracts/evm --summary
FOUNDRY_FUZZ_RUNS=4096 FOUNDRY_OPTIMIZER=true FOUNDRY_OPTIMIZER_RUNS=200 FOUNDRY_EVM_VERSION=cancun \
  forge test --root contracts/evm --match-contract StyxVaultTest --summary
cargo build --manifest-path sdk/evm/Cargo.toml --bins --locked
cargo test --manifest-path sdk/evm/Cargo.toml --locked --no-fail-fast
cargo test --manifest-path sdk/evm/Cargo.toml --locked --test vault_local_chain -- --ignored
cargo test --manifest-path sdk/core/Cargo.toml --locked
cargo test --manifest-path sdk/transport/Cargo.toml --locked
cargo test --manifest-path sdk/journal/Cargo.toml --locked
uv run --frozen pytest mcp-server/tests sdk/py/tests -q
cargo clippy --manifest-path sdk/evm/Cargo.toml --lib --tests --locked -- -D warnings
cargo fmt --manifest-path sdk/evm/Cargo.toml --check
```

For the v2 CLI tests, set `STYX_VAULT_TEST_BINARY` to the built vault executable's absolute path.
The tests generate their own local signer material and launch isolated Anvil nodes.

```sh
STYX_VAULT_TEST_BINARY="$STYX_VAULT_CLI" \
  cargo test --manifest-path sdk/evm/Cargo.toml arc_vault::v2::integration --lib --locked -- --ignored
FOUNDRY_OPTIMIZER=true FOUNDRY_OPTIMIZER_RUNS=200 FOUNDRY_EVM_VERSION=cancun \
  STYX_VAULT_TEST_BINARY="$STYX_VAULT_CLI" \
  cargo test --manifest-path sdk/evm/Cargo.toml arc_vault::v2::integration --lib --locked -- --ignored
```

Local tools: Foundry and Anvil 1.5.1, solc 0.8.24, Rust 1.96.0.

## Before testnet deployment

Poulav must review the contract, typed signing formats, and the deployment build settings.
The approval page, relay, Python adapter, and setup page still need their v2 changes from their owners.
The current Python response allowlist rejects the new `contract_version` field until that adapter changes.
The existing v1 disclosure CLI does not accept v2 records. The v2 CLI supplies `verify_record` instead.

The complete hosted v2 flow, actual Safe integration, mobile wallet signing, and Arc USDC behavior did not run.
No Arc transaction, deployment, live key, or sponsor account was used.
Canonical receipt checks are not a finality guarantee. RPC honesty remains a trust assumption.
Poulav controls the deployment and go/no-go decision.
