# V2 disclosure handoff

Branch: `codex/v2-disclosure`, based on `origin/claude1/v2` at `2afe0ed`.
Worktree: `~/Developer/styx-codex`.

## Disclosure behavior

`styx-disclosure` now accepts both `vault-payment-record/1` and `vault-payment-record/2`.
Export and review select the parser from the record's schema.
V2 review calls the existing v2 `verify_record`; v1 keeps its existing verifier.
The encrypted grant format, sealing, opening and transaction-signing functions did not change.

The response fields are unchanged:
`status`, `record_integrity`, `authorization`, `settlement`, `policy_at_execution`,
`reasons`, `payment_id`, `tx_hash`, `delivery_verified`.
`delivery_verified` remains false. No Python allowlist change is required.
A routine payment reports authorization as `not_applicable`.
An unreachable RPC reports unavailable chain evidence; it does not establish non-payment.

The reviewer supplies only:

- The grant and their private reviewer key.
- The expected issuer address obtained separately.
- Their own RPC and expected chain, vault address and runtime code hash.

The real-binary test clears the child environment. It supplies no `STYX_VAULT_*` variables to the disclosure binary.
Wrong reviewer keys, wrong issuers, tampering and wrong chain or vault pins are refused.
The reviewer should use the official Studio deployment pins in `STYX_V2_INTERFACE.md`.
Its Forge predecessor goes unused.

This enables local v2 grant export and review. It does not establish the independent human G3 gate or an Arkiv network round trip.
Those still need their own evidence. The G3 example's all-verified case expects an exception payment;
a routine payment correctly has `authorization=not_applicable`.

## V1 journal and settlement changes

New v1 journal records retain the chain, vault, token and agent.
Every retained signed transaction is decoded and checked against that context, its recorded hash and exact payment tuple before reuse.
The journal directory, version number, payment IDs and signed transaction format stay the same.

Legacy records with signed attempts can recover their binding from those authenticated transaction bytes.
Local tests cover a settled legacy record and a timed-out legacy attempt.
The timeout resumes the same transaction hash, retains one attempt and pays the vendor once.
A different vault, token or agent is refused. Failed context checks leave the legacy file unchanged.

**Automatic migration of unsigned legacy records is not safe and is not implemented.**
Those records contain no authenticated chain or vault identity.
This binary refuses to sign or request approval for them and leaves their bytes unchanged.
It does not invent a replacement payment ID or a binding from the current environment.
Poulav must resolve those pending proposals before replacing the live fallback binary with this build.
The existing live directory and its keys were not read or changed during this work.
Existing signed records remain readable through the tested migration path.

Submit, status and record export now require the matching payment event and canonical receipt before reporting settlement.
The checks bind receipt status, transaction hash, destination, sender, block hash and payment fields.
A consumed ID or successful receipt alone is insufficient. Missing evidence leaves settlement unknown or unavailable.
A canonical receipt observation is not a finality guarantee.

## Verification results

| Check | Result |
| --- | --- |
| Rust normal tests | 25 passed: 19 library, 4 disclosure CLI, 2 shared-vector tests |
| V1 real-binary Anvil suite | 10 passed, including attacks A1–A4 and legacy journal cases |
| V2 real-binary Anvil suite | 8 passed, including routine and exception disclosure and ERC-1271 cases |
| Optimized Cancun contract tests | 83 passed: 44 v1 and 39 v2; both v2 fuzz tests ran 256 cases |
| Setup-page typecheck and unit tests | Passed; 37 tests |
| Setup-page browser tests | 26 scenarios passed on Anvil |
| Owner-page typecheck and unit tests | Passed; 69 tests |
| Relay typecheck and unit tests | Passed; 36 tests |
| Full MCP server and Python SDK tests | 41 passed |
| MCP examples | 10 passed |
| Integration review reproductions | Four TypeScript checks pass; three TypeScript checks and one MCP check expose open findings |

The disclosure regression failed on the original v1-only parser before the change.
The journal-binding and event-evidence regressions also failed before their fixes.
No Arc transaction, deployment, live key operation, independent G3 review or Arkiv network write was performed.

CI now explicitly runs setup-page checks and MCP examples.
The v2 Anvil step includes the disclosure regression and names both binary paths.
The workflow itself has not yet completed on GitHub for this branch.

## Repeat the Rust checks

From `sdk/evm`, with Foundry installed:

```sh
cargo build --locked --bins
cargo test --locked --no-fail-fast
cargo test --locked --test vault_local_chain -- --ignored
STYX_VAULT_TEST_BINARY="$PWD/target/debug/styx-vault" \
STYX_DISCLOSURE_TEST_BINARY="$PWD/target/debug/styx-disclosure" \
  cargo test --locked --lib arc_vault::v2::integration -- --ignored
```

For the contract build settings:

```sh
FOUNDRY_OPTIMIZER=true FOUNDRY_OPTIMIZER_RUNS=200 FOUNDRY_EVM_VERSION=cancun \
  forge test --root contracts/evm
```

The integration findings and failing reproduction commands are in `V2_INTEGRATION_REVIEW.md`.
Poulav must decide whether those integration gaps and the unsigned-legacy migration limit permit shipping v2.
