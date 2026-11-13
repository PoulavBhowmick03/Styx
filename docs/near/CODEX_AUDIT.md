# Codex task: audit the Styx NEAR contracts

You are auditing, not building. Work in `/Users/odinson/Developer/Styx-near`. Do not change any file
under `contracts/`. Write findings only to `docs/near/AUDIT_NEAR.md`, and put any proof-of-concept
tests in a new file `contracts/near/styx-vault/tests/audit_pocs.rs` (sandbox) or
`contracts/near/styx-vault/src/audit_tests.rs` gated behind `#[cfg(test)]` and added with one
`mod` line, so they can be reviewed and run without touching the contract logic. Commit with
`git pull --rebase` first, conventional messages, push to `main`.

## Scope

- `contracts/near/styx-vault/src/lib.rs` and `src/evm.rs` (vault, contract version 2): NEAR payments
  through a NEP-141 token, NEP-413 exception approvals, Chain Signatures payments on EVM chains.
- `contracts/near/styx-usdc` only as far as the vault depends on it (it is a test token; anyone can
  mint, by design).
- Out of scope: the TypeScript pages, the relay, the Python tools, the EVM Solidity build.

Read first: `docs/near/PLAN.md`, `docs/near/CHAIN_SIGNATURES_PLAN.md`, `docs/near/TESTNET_RUN.md`
(what has run on testnet, every transaction), `src/tests.rs` and `tests/sandbox.rs` (what is tested).
The MPC signer interface is documented in the Chain Signatures plan; verify it against
https://github.com/near/mpc (`crates/contract/src/api/sign.rs`, `crates/near-mpc-crypto-types`).

## The properties the contract claims, and you should try to break

1. Only the owner can configure agents, approvers, recipients, EVM chains and EVM recipients, set
   limits or nonces, pause, unpause and withdraw.
2. An agent is a function-call key on the vault account limited to `pay`, `pay_with_exception`,
   `pay_evm`, `pay_evm_with_exception`, `post_record`. Check `configure_agent`'s key handling:
   install, remove, re-enable, and what happens to a key's state if a promise fails.
3. A payment over the per-payment limit settles only with a valid NEP-413 signature by a current
   approver, over that exact payment, once (nonce), before expiry. Check the NEP-413 payload
   reconstruction byte for byte (tag, Borsh layout, `recipient` = vault, `callback_url`), the message
   format, and whether any field of `Payment`/`EvmPayment` can change without changing the signed
   hash. Check the domain separation between NEAR and EVM payment hashes.
4. No signature lifts the agent's daily limit or the vault's daily limit; NEAR and EVM payments share
   both counters. Look for overflow, underflow, day-boundary and rollback errors (`on_transfer`,
   `on_evm_signed`, `rollback`), including a rollback that could subtract from another day or
   another agent.
5. A payment id settles at most once, including across a failed transfer and retry, and across
   NEAR and EVM.
6. Callbacks: `on_transfer` and `on_evm_signed` are `#[private]`. Check what each trusts from its
   arguments versus state, behaviour when the promise result is malformed, the case where the MPC
   yield times out, and the case where the owner changes chain settings or the agent's policy
   between the call and its callback.
7. EVM transactions: the vault alone chooses token, nonce and gas fields; check that the agent cannot
   influence anything else that is signed, that RLP/EIP-1559 encoding is right (there is a byte-for-
   byte test against `cast`), low-s normalization and the recovery bit, and nonce handling, including
   `set_evm_nonce` overwriting a stored signed transaction and the single `evm_pending` slot.

## Known issues to assess, not just repeat

Give each a severity and say whether it is a bug, a design limit, or acceptable for a testnet build:
- Counters are charged when the vault signs an EVM transaction, so a reverted or never-broadcast
  transaction still counts (seen on testnet).
- Nothing caps the number of payments per day; gas on EVM chains is paid by the vault's derived
  address outside the limits (bounded per transaction by the owner's gas caps).
- `consumed_payments`, `consumed_nonces` and `evm_signed` grow forever; who pays for storage and what
  happens when the vault's NEAR balance cannot.
- `evm_pending` is one slot for all chains.
- No upgrade or migration path.

## Output

`docs/near/AUDIT_NEAR.md`: a summary table (id, title, severity: critical / high / medium / low /
info, status), then for each finding: where (file:line), what, a concrete exploit or failure
scenario, a proof-of-concept test name if you wrote one, and a suggested fix in words (no code
changes to the contract). Separate "verified by a test you ran" from "reasoned, not tested". List
what you checked and found correct, so a clean area is visible too. Run
`cd contracts/near/styx-vault && cargo test` and report the result. Do not call the contract "secure"
or "audited"; say what you checked and what you found.
