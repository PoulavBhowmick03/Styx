# Sentinels: watchers that can only pause the vault

Spending limits stop one large theft. A hijacked agent can still drain a vault in small payments
that each pass every limit. A **sentinel** is a watcher agent that reads each payment the vault makes
and may pause the vault. A **parent** scores the sentinels, retires the noisy ones and starts their
next generation with what it learned.

## What a sentinel can and cannot do

The owner calls `set_sentinel(key, true)` (contract version 3). The vault then adds a NEAR
function-call access key on its own account. Its receiver is the vault, its only method is
`sentinel_pause`, and its gas allowance is 0.05 NEAR. `set_sentinel(key, false)` deletes the key.

- **It can** call `sentinel_pause(reason)`. The vault sets `paused` and logs `sentinel_paused`
  `{sentinel, reason, day, vault_day_spent}`. A reason may be up to 280 bytes. Pausing a vault that is
  already paused does nothing.
- **It cannot** pay, unpause, withdraw, change a limit, recipient, approver or agent, or add a key.
  The key's permission names only `sentinel_pause`, so NEAR refuses anything else signed with it.
  Only the owner unpauses.
- A vault holds at most 8 sentinels. A key cannot be an agent and a sentinel at once (`RoleConflict`).

Contract unit tests cover each of these rules: 70 pass in `contracts/near/styx-vault`, on branch
`sentinels` (Poulav reviewed them). The exact interface is in
[`SENTINELS_HANDOFF.md`](SENTINELS_HANDOFF.md#interface-from-task-a).

## The swarm (`sentinels/`, the `styx-sentinels` command)

- **Watcher.** It lists the vault's transactions through FastNEAR's transaction API (NearBlocks as
  fallback), confirms each one with RPC, and reads the vault's own receipt logs: payments (NEAR, EVM and x402), pauses and unpauses.
- **Three sentinels, each with its own key** (kept in `~/.styx-near/sentinels/keys/<vault>/`, mode 600):
  - `burst`: more than N payments in M minutes (starts at 4 in 5 minutes);
  - `concentration`: one recipient takes more than X% of the vault's daily limit within an hour
    (starts at 40%);
  - `judge`: a model on NEAR AI Cloud, through `agent-near-ai`'s attested client. It reads the last
    20 payments and answers `{pause, reason}`. The attestation evidence is kept with each verdict.
    It runs only when `NEARAI_API_KEY` is set.
- **Pausing.** A sentinel pauses through the agent CLI's `sentinel_pause` request, signed with its own
  key at 20 Tgas, inside the key's 0.05 NEAR allowance. A sentinel whose key is not yet on the vault does not try. After the owner unpauses, sentinels
  judge only newer payments.
- **The parent** keeps score:
  - A pause during a marked attack is a **catch**. `drain_attack.sh` marks its run in
    `$STYX_NEAR_STATE_ROOT/sentinel-attack.json`; `styx-sentinels mark-attack` marks one by hand.
  - A pause the owner reverses with no attack marked is a **false alarm**.
  - Score = catches − 2 × false alarms. At −2 the parent retires the sentinel and spawns the next
    generation with a note: a rule's threshold goes up, and the judge is told what it got wrong.
  - It asks the owner to remove the old key and install the new one. One console link signs both in
    one approval.
  - Every decision is a line in `~/.styx-near/sentinels/<vault>/lineage.jsonl`: spawn, pause, settled,
    retire, key confirmed.
- **The live page** (`sentinels-ui/`, served by the runner on `127.0.0.1:8790`) shows:
  - each sentinel, with its score, pauses and reasons;
  - a timeline of payments, pauses, unpauses and attack windows;
  - the lineage and the generations;
  - the key changes waiting for the owner.

Tests: 25 runner tests cover the detectors on fixture streams, scoring, and the retire/respawn
decision. They also cover a mocked judge, the attack marker, the CLI request, owner links and key
sync. The page has 5 unit tests. None of these tests use the network.

## Your own sentinels (plug-ins)

Anyone can add a kind of sentinel without touching the runner. A plug-in is one Python module:

- `KIND`, its name, and `DEFAULTS`, its starting params;
- `build(params, notes)`, an object whose `judge(history, now, daily_limit)` returns
  `{"pause": bool, "reason": str}`;
- `mutate(params, direction)`, which returns `(params, note)`: "looser" after false alarms, "stricter"
  after misses.

To use one:
1. List it outside the repo, in `~/.styx-near/sentinels/plugins.toml`:
   `[plugins.new_recipient]` with `module = "/path/to/new_recipient.py"`.
2. Run `styx-sentinels add --vault <vault> --kind new_recipient`. It gets its own key, and the owner
   installs it with the same one-approval link.
3. From then on the parent scores, retires and mutates it like a built-in.

The example, [`sentinels/examples/new_recipient.py`](../../sentinels/examples/new_recipient.py),
pauses when an account first paid within the last 10 minutes takes more than 3 payments.

**Isolation.** The runner never imports a plug-in.
- Each call runs in a fresh `python -I -B` process that gets the module's source and the request on
  stdin, and answers on stdout.
- The request holds only public payment fields (agent, recipient, amount, time, transaction, kind,
  exception), the time, the daily limit, and the plug-in's own params and notes. Never a key, a key
  path or the swarm's folder.
- The process has an empty environment, a fresh empty working folder, a 5-second wall-clock limit
  and a CPU limit.
- On macOS it also runs under `sandbox-exec`: no network, no file writes, and no reads of
  `~/.styx-near`, `~/.near-credentials`, the key folder or the swarm's home. On other systems it runs
  without that OS sandbox.
- A crash, a timeout or a malformed answer is a quiet verdict and a `plugin_error` line in the
  lineage. A failed mutation leaves the child with its parent's params.

Tests (`sentinels/tests/test_plugins.py`):
- the example pauses a new recipient, not an old one;
- on macOS, a plug-in that tries to read a key file gets a permission error, sees no `STYX_`
  variables and cannot write a file;
- a plug-in sees only the public fields;
- an endless loop times out quietly in about 1 second;
- a crash is quiet and logged;
- selection makes a plug-in's children looser, then stricter;
- an unregistered kind waits;
- `add` makes a key and an enable link.

## The owner console

The **Sentinels** panel, for version 3 vaults:
- lists the keys from `get_sentinels`, with their names and access-key allowance;
- shows recent `sentinel_paused` events with their reasons, as plain text;
- shows a paused banner with **Review unpause**;
- installs keys pasted one per line, all in one approval, and removes a key with one click.

The parent's links (`?sentinel_enable=…&sentinel_label=…&sentinel_remove=…`) open that review
prefilled, once the owner is connected. Before it opens, the console rereads `get_sentinels`.

Tests: 76 console unit tests, plus `npm run smoke:sentinels`. That smoke runs in a browser with a
stand-in wallet: the parent's link opens one review with two calls, the pause reason renders as
text, and pasting a key signs one `set_sentinel`. The existing smokes still pass.

## Try it without a vault

```bash
uv run --project sentinels styx-sentinels rehearse
```

The rehearsal replays this on simulated payments, with no keys and no chain:
1. normal traffic;
2. a payroll round that the burst sentinel pauses;
3. the owner unpauses, so that pause is a false alarm and burst g1 is retired;
4. burst g2 starts at 6 payments in 5 minutes, and the second payroll round goes through;
5. a drain of 8 payments to one account, which burst g2 pauses, scored as a catch.

The live page opens on `127.0.0.1:8790`. A runner test checks that this outcome holds.

## Run it on testnet

The v3 factory is on `styx-vaults.testnet` ([TESTNET_RUN.md](TESTNET_RUN.md#sentinel-v3-factory-deployment-14-nov-2026)).

1. In the console, create a new vault, fund it, set its limits, one allowed recipient and an agent.
2. Write `~/.styx-near/v3.env` with these settings, all outside the repo:
   - `STYX_NEAR_VAULT`;
   - `STYX_NEAR_AGENT_KEY_FILE`;
   - `STYX_NEAR_STATE_ROOT`;
   - `VENDOR`, the allowed recipient;
   - `NEARAI_API_KEY`, optional, for the judge.
3. Build the CLI: `cargo build --release --manifest-path sdk/near/Cargo.toml`.
4. Run `scripts/near/demo_sentinels.sh`. The first run creates the sentinels' keys and prints one
   console link. Sign it as the owner, then run the script again. It:
   - checks that every key is on the vault;
   - starts the swarm and its page;
   - runs `drain_attack.sh 20 1`;
   - waits for the pause;
   - prints the reason, the scores and the lineage.
5. In the console's Sentinels panel, read the reason and unpause. Record each transaction with
   `scripts/near/tx_outcome.sh` in [TESTNET_RUN.md](TESTNET_RUN.md).

## What ran on testnet (14 Nov 2026)

On `sentinels.styx-vaults.testnet` ([TESTNET_RUN.md](TESTNET_RUN.md#sentinels-on-testnet-14-nov-2026)):
1. A drain of 1 tUSDC payments, each inside every limit, started.
2. The burst sentinel paused the vault with its own key, 8.6 seconds after the fifth payment. Its
   reason was "5 payments in 5 min (5 total), over the 4 allowed".
3. Six payments settled. The seventh was refused with `VaultPaused`, and the drain stopped.
4. The owner unpaused, and the parent scored the pause as a catch.

The same sentinel key, used to call `unpause`, `withdraw`, `set_vault_daily_limit` or `pay`, was
refused by NEAR before any block.

Not yet on testnet:
- the judge sentinel, which needs a NEAR AI Cloud key;
- a retirement and respawn, which ran only in the rehearsal and the unit tests.
