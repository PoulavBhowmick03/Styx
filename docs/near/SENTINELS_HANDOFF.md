# Styx Sentinels: hand-off for Claude Code and Codex

Deadline: 14 Nov 2026, 23:59 UTC. One submission, no edits after.

## The idea in one line

Spending limits stop big theft. A hijacked agent can still drain a vault in small payments that all
pass the limits. **Sentinels** are watcher agents that read every payment and can pause the vault.
NEAR makes sure that pausing is *all* they can do: each sentinel holds a function-call key allowed
only `sentinel_pause`. A parent loop scores the sentinels (false alarms vs attacks caught), retires
noisy ones and respawns them with its notes. This is the Spawn lifecycle, applied to agent security.

Demo: an injected agent drains the vault in small allowed payments → a sentinel pauses it mid-drain
→ the owner unpauses → the parent retires a noisy sentinel and respawns it.

## Starting point

Branch `vault-x402-guardian` (5 commits on top of `main`):
- `22f5cbd` contract version 3: `pay_x402` (vault-signed EIP-3009).
- `b7d30e1` CLI: `submit_x402`.
- `9e7fc69` MCP: `styx_pay_x402`.
- `27f70b7` docs/near/X402.md.
- `99339f4` contract: a single guardian key that may only call `guardian_pause`. Sentinels replace
  this.

Contract tests: 60/60 passing. Nothing on this branch is deployed or run on testnet.

## Rules (from CLAUDE.md)

- **Worktrees.** Each agent works in its own git worktree, never the shared folder. Codex and
  Claude collided once already today.
- **Keys and funds.** No keys, .env or keystores in the repo. Sentinel keys live in
  `~/.styx-near/sentinels/`. Testnet only.
- **Contract changes.** They go in their own commits marked "NEEDS POULAV'S REVIEW". Poulav reviews
  every line of contract and signing code.
- **Claims.** Claim only what a test or a testnet run shows.
- **Commits.** Small commits with conventional messages. Push only when the human says so.

---

## Codex: task A, contract and CLI (start first, about 2–3 h)

```text
Repo Styx-near, branch `sentinels` from `vault-x402-guardian`, in your own git worktree. Read
CLAUDE.md and SENTINELS_HANDOFF.md first.

1. Contract (contracts/near/styx-vault/src/lib.rs). Replace the single guardian with a set of
   sentinels (keep contract version 3; it is unreleased):
   - set_sentinel(key: PublicKey, enabled: bool), owner only, at most 8 enabled. Enabling installs
     a function-call key on the vault account allowed only "sentinel_pause", with a 0.05 NEAR
     allowance. Disabling deletes the key. ed25519 only. RoleConflict if the key is an enabled
     agent, and configure_agent refuses an enabled sentinel's key.
   - sentinel_pause(reason: String): predecessor must be the vault account and the signer an
     enabled sentinel. Reason at most 280 bytes. Sets paused and emits
     "sentinel_paused" {sentinel, reason, day, vault_day_spent}. Pausing an already paused vault
     is a no-op (no error).
   - get_sentinels() -> list of enabled keys. get_vault keeps reporting paused.
   - unpause stays owner only. Remove guardian_pause/set_guardian, or keep them as aliases; your
     choice, but document it.
   - Unit tests: a sentinel pauses; an agent key cannot; a disabled sentinel cannot; a sentinel
     cannot unpause, pay, or change rules; the limit of 8; role conflicts both ways; reason length.
   - Keep every existing test (x402 included) passing and `cargo check --target
     wasm32-unknown-unknown` clean. Commit, marked NEEDS POULAV'S REVIEW.
2. Agent CLI (sdk/near/src/main.rs). New request {"method":"sentinel_pause","reason":"..."} that
   signs sentinel_pause with the key file at STYX_NEAR_SENTINEL_KEY_FILE, as the vault account,
   using the CLI's existing transaction code. It returns {status, tx_hash}. A parse test. Add
   "sentinel_pause" to the Python seam (sdk/py/src/styx/_vault.py) parameters. Commit.
3. Testnet scripts (no keys in the repo; read settings from ~/.styx-near/*.env like the others):
   - scripts/near/deploy_v3.sh: build the vault, rebuild and redeploy the factory, print what to
     run next.
   - scripts/near/drain_attack.sh <n> <amount>: the agent pays n small, allowed payments to one
     recipient as fast as it can. Print each tx; stop on the first refusal (VaultPaused) and say so.
   Commit.
Finish with a summary: tests, and the exact interface (method names, args, events) for task B.
```

## Claude Code: task B, sentinel runner and parent loop (parallel with A, about 4–5 h)

```text
Repo Styx-near, branch `sentinels-runner` from `vault-x402-guardian`, in your own git worktree.
Read CLAUDE.md and SENTINELS_HANDOFF.md first. Build against the interface in task A
(sentinel_pause(reason), event sentinel_paused, CLI request sentinel_pause); rebase onto Codex's
`sentinels` branch when it lands.

Build a Python package `sentinels/` (a uv workspace member, like agent-near-ai):
1. Watcher: reads the vault's payment_executed and sentinel_paused events, the same way
   owner-console-near/src/core.ts history() does (indexer list, then RPC confirmation of each tx's
   receipt logs). It produces a clean stream of payments: agent, recipient, amount, time, exception.
2. Three sentinels, each its own process with its own key file
   (~/.styx-near/sentinels/<name>.json), each pausing through the CLI request sentinel_pause:
   - burst: more than N payments in M minutes;
   - concentration: one recipient taking more than X% of the vault's daily limit in a window;
   - judge: a model on NEAR AI Cloud (reuse agent-near-ai's verified client and its attestation
     check), given the last K payments, answers {pause: bool, reason}. Keep the attestation
     evidence with each verdict.
   Every pause carries a short human reason.
3. Parent loop (the Spawn lifecycle). Each cycle:
   - score every sentinel. A pause the owner reverses (an unpause within T minutes) with no attack
     marked is a false alarm. A pause during a marked attack (scripts write a marker file, or the
     owner sends /attack to the bot) is a catch. Score = catches - 2 * false alarms.
   - retire the lowest scorer below a threshold: stop its process and write a "retire" request,
     a console link that disables its key (only the owner can).
   - respawn: generate a new key and start a new process with the parent's notes (its past false
     alarms, as context for the judge, or tuned thresholds for the rules), and write an "enable"
     link for the owner.
   - append each decision to a lineage log (JSON lines): who, why, score, notes passed on.
4. Tests: detectors on fixture streams; scoring and the retire/respawn decision on fixture
   histories; a mocked judge. No network in unit tests.
5. scripts/near/demo_sentinels.sh: start the three sentinels and the parent, run drain_attack.sh,
   then show the pause, the reason, and the lineage log.
Commit in small pieces; summarize what passed.
```

## Claude Code: task C, console and docs (after A and B)

```text
On top of both branches:
- owner-console-near: a Sentinels panel listing enabled sentinel keys (with names), recent
  sentinel_paused events with reasons, and Review-and-sign actions for enable and disable (batched
  with the existing batch code). Retire and enable links from the parent open these reviews
  prefilled. Unit and smoke tests like the existing ones.
- README, docs/near/SENTINELS.md, docs/near/SUBMISSION_FORM.md and docs/near/DEMO_SCRIPT.md: what a
  sentinel can and cannot do (NEAR enforces pause-only), the drain demo, the parent loop. Claims
  only from tests and the testnet run.
```

## Ishita / Poulav (people only)

1. **Now:** push `vault-x402-guardian` so both agents can start. Post the existing Styx demo on X
   so there is a valid entry no matter what.
2. **When task A is in:** review the contract diff. Run `scripts/near/deploy_v3.sh` on testnet,
   create a vault in the console, set limits, an agent and 3 sentinel keys.
3. **When task B is in:** run `scripts/near/demo_sentinels.sh`. Record each transaction with
   `scripts/near/tx_outcome.sh` into TESTNET_RUN.md.
4. **Only if the run works:** record the new demo, update the X post or reply with it, and submit.
   If it does not work by about 20:00 UTC, submit Styx as it is.

## Order and timing (UTC)

| When | Codex | Claude Code | People |
| --- | --- | --- | --- |
| now | A1 contract | B1 watcher, B2 rules | push branch, post demo |
| +2 h | A2 CLI, A3 scripts | B2 judge, B3 parent | review the contract |
| +4 h | help with fixes | rebase on A, B5 demo script | deploy v3 to testnet |
| +6 h | — | C console and docs | run the demo, record |
| by 20:00 | — | — | decide: Sentinels or Styx as is, submit |

## Interface (from task A)

Implemented on `sentinels`, from `76dcbb0`. Contract and signing code **NEEDS POULAV'S REVIEW**.
Version stays 3. This changes the unreleased guardian state layout; create a fresh vault.
`set_guardian`, `guardian_pause` and `get_vault().guardian` are removed; there are no aliases.

### Contract calls

| Method | JSON args | Authorization / result |
| --- | --- | --- |
| `set_sentinel` | `{"key":"ed25519:<public key>","enabled":true}` (or false) | Owner predecessor only; at most 8 enabled; returns the access-key action promise. |
| `sentinel_pause` | `{"reason":"burst: 12 payments in 60 seconds"}` | Predecessor must be the vault; signer public key must be enabled. Returns null. |
| `get_sentinels` | `{}` | View; JSON array of enabled public-key strings, in enable order. |
| `get_vault` | `{}` | Existing view, including `paused` and `contract_version: 3`. |
| `unpause` | `{}` | Owner predecessor only; returns null and emits `unpaused`. |

Enabling adds an ed25519 function-call access key on the vault, receiver = vault,
method names = **only** `sentinel_pause`, allowance = **0.05 NEAR**. Disabling removes that key.
Repeating the current enabled/disabled state makes no key action and emits no event.
An enabled agent cannot become a sentinel; an enabled sentinel cannot become an agent (`RoleConflict`).
Key installation/removal uses asynchronous NEAR actions: inspect the final outcome and account keys,
not just `get_sentinels`, when confirming owner setup.

Reasons are UTF-8 strings of at most **280 bytes** (empty allowed). An authorized pause while paused
is a no-op with no event; authorization and reason length are still checked. Unpause remains owner only.
Refusals: `NotOwner`, `SentinelMustBeEd25519`, `RoleConflict`, `TooManySentinels`, `NotSentinel`, `ReasonTooLong`.

### Events

All logs use `EVENT_JSON:` followed by the existing envelope:
`{"standard":"styx","version":"1.0.0","event":"<name>","data":[{...}]}`.

- `sentinel_set`: `{"sentinel":"ed25519:<public key>","enabled":true}` (or false), on a role change.
- `sentinel_paused`: `{"sentinel":"ed25519:<public key>","reason":"...","day":1,"vault_day_spent":"6000000"}`.
  `day` is a JSON number, UTC Unix seconds / 86400. Spend is a decimal-string U128 in token base units,
  from the vault's current day counter at pause time (including reserved in-flight payments).
- `unpaused`: `{}`, from the existing owner method. Owner `pause` continues to emit `paused` with `{}`.
  A sentinel emits `sentinel_paused`, without an additional `paused` event.

### CLI and Python seam

Send one JSON request on stdin to `styx-near-vault`:

```json
{"method":"sentinel_pause","reason":"burst: 12 payments in 60 seconds"}
```

Successful final outcome: `{"status":"ok","tx_hash":"<NEAR transaction hash>"}`.
Errors retain the existing `{status:"error",code,message}` response and nonzero exit.
The request rejects missing or extra fields. It signs as the **vault account**, using only
`STYX_NEAR_SENTINEL_KEY_FILE`; it never falls back to the agent key.

Required settings: `STYX_NEAR_VAULT`, `STYX_NEAR_SENTINEL_KEY_FILE`, `STYX_NEAR_STATE_ROOT`.
Use `STYX_NEAR_NETWORK=testnet` (the default); the vault must end in `.testnet` and report version 3.
`STYX_NEAR_RPC_URL` defaults to `https://rpc.testnet.near.org`. Key JSON must hold `private_key`
or `secret_key`, with owner-only permissions (`chmod 600`). Keep keys under `~/.styx-near/sentinels/`
and all state outside the repository. The sentinel path does not open the payment journal.
Python: `VaultSeam(binary=...).call("sentinel_pause", reason="...")`; it forwards the same request.

CLI vault checking now accepts versions 1–3. Proposing against a paused vault returns the named
`VaultPaused` refusal (`POLICY_LIMIT`), matching a transaction-time refusal.

### Scripts and runner marker

- `scripts/near/deploy_v3.sh`: reads `~/.styx-near/v3.env` (override `STYX_NEAR_DEMO_ENV`, still under
  `~/.styx-near/*.env`). Builds vault first, rebuilds factory with that embedded wasm, then deploys
  the existing testnet factory using its external legacy keychain. `FACTORY` defaults to
  `styx-vaults.testnet`; `NETWORK` must be `testnet`. Prints fresh-vault setup steps.
- `scripts/near/drain_attack.sh <n> <amount>`: same settings file; requires agent CLI settings and
  `VENDOR`, one allowed NEAR testnet recipient. Amount is token units with 6 decimals maximum
  (example: `20 0.25` attempts twenty 250000-base-unit payments). Pins the public testnet RPC.
  Sequential propose/submit calls have no sleeps or retries. Each result prints, including tx hashes.
  The first refusal stops the loop; `VaultPaused` prints a stop message and exits 0.
  Unknown or reverted outcomes stop with nonzero exit, for reconciliation before another run.
- Marker: `$STYX_NEAR_STATE_ROOT/sentinel-attack.json`, atomically replaced with
  `{"attack_id":"drain-<uuid>","active":true,"time":<Unix seconds>,"vault":"<account>"}`.
  Normal exit, refusal, or a Python exception writes the same attack id with `active:false` and
  the ending time. A killed process can leave an active marker; runners should check liveness
  or expire stale markers. Each run writes unique invoice references outside the repo.

### Validation

- Contract `cargo test --lib`: **70 passed**, including x402 regressions and sentinel authorization,
  role conflicts, capacity, UTF-8 byte limit, event fields, idempotency, and access-key receipt actions.
- Contract `cargo check --target wasm32-unknown-unknown`: passed without warnings.
- `sdk/near` `cargo test`: **9 passed**, including strict sentinel request parsing.
- Root `uv run pytest` after `uv sync --all-packages`: **27 passed** (includes Python seam forwarding).
- `bash -n` passed for both scripts. Mock CLI runs checked settled payments, pause refusal,
  unknown/reverted outcomes, marker cleanup, and mainnet rejection.
- No testnet deployment or drain was run. Deployment and the live sentinel demo remain for human review and task B.


Deployment follow-up (14 Nov 2026): Poulav reported review complete. The v3 factory was deployed
and both its code hash and embedded vault hash matched local builds on finalized testnet reads.
See [TESTNET_RUN.md](TESTNET_RUN.md#sentinel-v3-factory-deployment-14-nov-2026) for the transaction
and hashes. The CLI release build passed. Fresh-vault setup and the task B live demo remain pending.
