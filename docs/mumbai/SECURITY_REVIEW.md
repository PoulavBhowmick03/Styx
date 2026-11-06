# Codex security review and delivery report

6 November 2026. Baseline: `84b3288`. This is a limited adversarial review, not an audit.
Scope: the frozen `StyxPolicyVault.sol`, `sdk/evm/src/arc_vault/`, and
`owner-page/src/approval.ts`. No live deployment, wallet extension or Arc transaction tested.
The contract was not edited. Poulav must review signing-related changes and Studio's replacement.

## Ranked findings

### 1. High: failover accepts evidence from an unchecked chain (fixed)

Location: `sdk/evm/src/arc_vault/rpc.rs:64` (`request`). Previously `check_chain`
validated one answer, then each later request independently selected an endpoint without checking
its chain. A correctly configured primary followed by an unavailable primary and a wrong-chain
fallback could mix code, owner, consumed-payment state and receipts. This can falsely identify
settlement or authorization on the configured chain; signed transactions retain their EIP-155 chain.

Reproduction: `cargo test arc_vault::security_tests::failover_must_validate_the_endpoint_that_answers --lib`
in `sdk/evm`. A dead endpoint followed by a fake chain-1 endpoint returned a code hash for a
31337-configured client before the fix. The test failed before the fix and passes afterwards.
Every endpoint now answers `eth_chainId` before supplying a read or accepting broadcast.
This still trusts each RPC's answers and does not protect against a malicious RPC lying about its chain.

### 2. Medium: ordinary records are not bound to the reviewer's configured chain (fixed)

Location: `sdk/evm/src/arc_vault/verify.rs:125` (`verify_record`). A record's chain ID
was not compared with the RPC configuration. Ordinary payments have no domain-bound owner signature;
changing only `chainId` left payment/event comparisons unaffected. A real receipt on one chain
could therefore support a record naming another chain.

Reproduction: `cargo test arc_vault::security_tests::record_chain_must_equal_the_reviewers_chain --lib`.
A chain-1 record supplied to a 31337 client was not rejected as a chain mismatch before the fix.
It is now rejected before reading evidence. This test covers the guard; it does not simulate
identical deployments on two live chains.

### 3. Medium: approval page presents an agent-controlled limit as policy (open, Claude 1)

Location: `owner-page/src/approval.ts:215-229`, specifically the comparison with
`pending.perPaymentLimit` and the rendered `exceededRule`. The limit is supplied by the agent,
not part of the signed payment, and not checked against owner configuration or on-chain policy.
An agent can misstate how large an exception is. The recipient and payment amount remain bound;
this is misleading signing context, not a cryptographic signature bypass.

Reproduced with the shared EIP-712 vector through `parsePending`, `reviewPending`, and
`approvalDigest`: change only `perPaymentLimit` from `"1000000"` to `"1"`. Both reviews
succeed, the digest is unchanged, and the label changes from `1 USDC` to `0.000001 USDC`.
Suggested fix for the owner: independently read the policy on the configured chain and bind its
version to the request, or explicitly label the limit unverified and omit authoritative policy claims.
No owner-page files were edited. Its owner should add the regression test.

### 4. Medium: malformed receipt reports failed settlement (fixed)

Location: `sdk/evm/src/arc_vault/verify.rs:191` (`check_chain`). A receipt with missing
status or block number was treated as failed settlement. A partial provider response is unknown,
and must not trigger a fresh payment or a claim of non-payment.

Reproduction: `cargo test arc_vault::security_tests::malformed_receipt_status_is_unknown --lib`.
The fake RPC returns a receipt without status. Before: `failed`; after: `unavailable`.
The test failed before the fix and passes afterwards.

## Contract and remaining boundaries

No findings in the frozen contract for unauthorized callers, signature domain/payment binding,
ID/nonce replay, daily-limit exceptions, effects/transfer rollback, or low-s/wallet-v checking.
This means no confirmed issue found in this pass, not proof of safety.
Existing contract tests: **84 passed**. Targeted Rust module tests: **12 passed**, including
three regressions observed failing before fixes. Owner-page typecheck and tests are recorded below.

Additional limits: no finality guarantee is implemented in the reviewed client; a receipt can
be removed by a reorganization. RPC honesty and a separately obtained code-hash pin remain trust
assumptions. A successful transaction alone is not a substitute for independent event verification.

## Task reports

### Task 1: security

Built three failing-first regression tests and fixes confined to `arc_vault`.
No contract, owner-page or other worker's source was edited.
Human: resolve finding 3; review Rust changes and Studio replacement before trusting them.
No live-chain behavior, real owner wallet or malicious-RPC consensus was verified.

### Claude 2 review

At fetched `origin/main` (`6edde8d`), `setup-page/` still does not exist and the remote
publishes only `main`; Claude 2's new work cannot yet be reviewed. Do not infer approval.
No setup files or example files were edited. The existing scripted example has one finding:

**Medium, open — restart after unknown creates another payment proposal.**
`mcp-server/examples/vault_agent.py:64-68` always proposes a fresh routine payment on entry.
After `settle` exhausts its same-ID retries and returns `unknown` (`:62`), `run` emits `failed`
and exits. Rerunning the script proposes a fresh ID without reconciling the retained one.
If the first payment later lands, both can pay the same invoice within policy limits.
Reproduction used a subclass of the actual `Agent`: `propose` records successive IDs,
`settle` returns `unknown`, and `run(0)` is invoked twice. Observed two different proposed IDs
and two `failed` events. This demonstrates the restart behavior; no double settlement was sent.
The example owner should persist/resume the payment ID across invocations and label uncertainty
explicitly. A real model run still needs the owner's chosen model/account; no credentials were used.

### Task 2: packaging

Built macOS arm64 **release** wheels for CLI, SDK and MCP, plus SHA256SUMS in ignored `dist/`.
`packaging/install-mcp.sh` installs all tools in one command from a supplied wheelhouse.
The isolated smoke test passed with Cargo/rustc absent from PATH, real vault version,
disclosure key generation and MCP entry point checks. `uv lock --check` and workspace sync passed;
`uv.lock` did not change. See `packaging/README.md` for build and install commands.
Human: distribute reviewed artifacts or publish packages. No PyPI release, Linux runtime,
Windows support or clean second-machine install was verified.

### Task 3: CI

Added `.github/workflows/ci.yml` with the handoff's Rust, Foundry, owner-page/browser,
Arkiv, Python and local-demo commands, watcher tests and platform wheel builds.
Actions are pinned to fetched commit SHAs; checkout credentials are not persisted and token
permissions are read-only. Gitleaks is checksum-pinned and scans PR/push commits; manual runs
scan history. No repository secrets, model account, Telegram account or live deployment needed.
The known missing-source Python test still runs and is retained in the JUnit artifact and warning;
only that exact failure is tolerated while `sdk/shielded/src` is absent.

Local evidence so far: EVM full suite passed; seven Anvil vault tests passed; core and transport
passed; Foundry 84 passed; owner-page typecheck/tests passed and 13 browser scenarios passed;
Arkiv typecheck/tests passed; local demo passed. Python raw run: 430 passed, 35 skipped,
one documented failure. No hosted Actions run has been verified; a human must enable/run it.

### Task 4: watcher

Built `watcher/watcher.py`: full-block agent/vault transaction scanning, receipt-status revert
alerts, historical daily-spend threshold checks, durable cursor/pending receipts/outbox, separate
watcher bearer token, redirect refusal and process locking. No signing or transaction sending.
**10 tests passed** against local Anvil with fresh random keys and a fake relay implementing `/alerts`.
Missing/partial receipts stay unknown and are retried; the relay's `alerted:false` stays queued.

Human/limits: no live Arc or Telegram run; historical state RPC support is required. Reorganizations
stop processing for operator review. Delivery can duplicate after a crash between remote acceptance
and saving the acknowledgement, since `/alerts` has no idempotency key. Never-visible receipts
cannot yield definitive revert alerts. See `watcher/README.md` for commands and recovery.

## Final local verification after rebasing on `6edde8d`

- `sdk/evm`: bins build passed; normal suite 103 passed, 54 ignored; explicitly requested
  vault Anvil suite **7 passed**. Other ignored integrations were not exercised.
- `sdk/core`: 118 passed, 1 ignored. `sdk/transport`: 137 passed, 1 ignored.
- `contracts/evm`: **84 passed**. Frozen vault source unchanged.
- `owner-page`: typecheck passed; **34 tests and 16 browser scenarios passed** on the rebased
  relay integration. Browser wallet is Anvil, not a real browser extension.
- `relay`: typecheck passed; **24 tests passed** with a fake notifier.
- `arkiv`: typecheck and tests passed; no live publication.
- Python final raw suite: **433 passed, 36 skipped, 1 known failure**. The CI reporter returned
  success with the documented warning and zero unexpected failures. Raw pytest remains red.
- `scripts/local_demo.sh`: passed before rebase; the seven vault Anvil tests and rebased
  browser relay scenarios cover the relevant combined local flow. No second-machine G3 claim.
- Watcher: **10 Anvil tests passed**. Native release wheels rebuilt against the rebased tree;
  isolated no-Rust install smoke passed. `uv lock --check` / sync passed without lock changes.
- Workflow passed `actionlint` 1.7.7. Gitleaks staged checks passed before every commit.

Only assigned paths changed. `main` has not been merged or force-pushed; the raw known test
failure remains, and the open owner-page/example findings need their owners. No live network
transaction, deployment, sponsor login, Telegram delivery, hosted CI run or Linux wheel runtime
was attempted. Claude 2's unpublished setup work still needs review when available.

Human follow-up: resolve the two open findings; review signing-sensitive changes; run hosted CI
and distribute native wheelhouses; perform the live gates and G0 decision. Also add this session's
AI assistance to `docs/mumbai/ai-usage.md` (outside Codex ownership): the changed paths listed by
`git diff --name-only origin/main...codex/vault-hardening`, guided by the user's Codex task prompt.
