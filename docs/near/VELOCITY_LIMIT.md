# Velocity limit (contract, NEEDS POULAV'S REVIEW, not deployed)

The vault can now refuse a drain of small payments before any sentinel has to act. The owner may set
at most N payments in any W seconds. The limit counts every pay path together, vault-wide.

## The contract (`contracts/near/styx-vault`)

**`set_velocity_limit(max_payments_per_window: u32, window_seconds: u64)`**
- Owner only. The agent's key and a sentinel's key are refused with `NotOwner`.
- `0` turns it off, which is the default for a new vault.
- When on, the limit is 1 to 100 payments, over a window of 1 second to 1 day.
- It emits `velocity_limit_set`.

**The check**
- It runs in the two shared checks, so it covers `pay`, `pay_with_exception`, `pay_evm`,
  `pay_evm_with_exception` and `pay_x402`.
- It comes right after `VaultPaused`, before any counter, transfer or MPC signature request.
- A payment that would be the N+1th inside the window is refused with `VelocityLimit`. A refused
  payment charges nothing.

**What counts**
- A payment counts when its counters are charged.
- A payment that later rolls back still counts: the limit bounds how often the agent may try, not
  only what settles.
- The window slides: an entry leaves it W seconds after it was made.

**State and views**
- New state: `velocity_max`, `velocity_window` and `recent_payments`. `recent_payments` holds at most
  N timestamps; older ones are dropped on every write.
- `get_vault` adds `max_payments_per_window` and `window_seconds`.

**Tests:** the 70 existing unit tests pass unchanged, plus 10 new ones:
- the limit is off by default;
- the N+1th payment is refused;
- the window slides;
- exceptions are covered;
- the limit is shared across NEAR and EVM payments;
- x402 is covered;
- a refused payment charges nothing;
- neither the agent nor a sentinel can change it;
- the owner's bounds and clearing work.

`cargo check --target wasm32-unknown-unknown` is clean.

## What changes elsewhere

**Version**
- `contract_version` stays 3. A vault's code never changes after creation: it has no full-access
  key.
- Clients tell this build apart by `get_vault` containing `max_payments_per_window`.
- The new fields change the stored layout, but no existing vault can be upgraded anyway. If you
  prefer a clean signal, bumping to 4 also needs the CLI's version check (sdk/near, 1 to 3 today),
  the console's `overview()` check and the one test asserting 3.

**Factory**
- The factory embeds the vault's wasm at build time.
- Rebuild and redeploy it with `scripts/near/deploy_v3.sh` after review. Only vaults created
  afterwards get the limit; `sentinels.styx-vaults.testnet` keeps its code.

**Console (separate commit, not made)**
- In the Set the rules step and in Advanced, add "Payments per window" and "Window (seconds)" fields
  that call `set_velocity_limit`. Show them only when `get_vault` has `max_payments_per_window`.
- Show the setting in the vault overview.
- `formPlan` and `describePlan` each need a case for `set_velocity_limit`.

**Agent CLI and MCP**
- A refusal surfaces as the vault's named error `VelocityLimit`, like `DailyLimitExceeded`. The
  CLI's refusal mapping should name it, so the agent tells the user to wait rather than retry in a
  loop.

**Sentinels**
- Still useful. The velocity limit is a fixed rule the owner sets once. Sentinels adapt (burst,
  concentration, the judge, and selection), and they catch drains slower than any limit the owner
  would accept.
