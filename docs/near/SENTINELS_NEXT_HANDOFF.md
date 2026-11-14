# Hand-off: Sentinels next (14 Nov 2026)

For Poulav's Claude Code. Everything below is on `main` up to `f970377` (fast-forwarded from
`sentinels-next`), plus `6756c04` and these docs on branch `sentinels-service`. Read `CLAUDE.md`,
`docs/near/SENTINELS.md` and the section "Sentinels on a second vault" in
`docs/near/TESTNET_RUN.md` first.

## Commits

None of these change the contract (`contracts/`) or the agent CLI's signing code (`sdk/near`), so
none is marked NEEDS POULAV'S REVIEW. The runner signs pauses through the existing CLI request.

| Commit | What |
| --- | --- |
| `74ba7bc` | neardata block watcher (now opt-in, see `4d18d6c`) |
| `4f8abd7` | each judge verdict keeps its model and checked evidence; the page shows it; `/api/evidence/<file>` |
| `0f84bf5` | `scripts/near/false_alarm.sh`; `drain_attack.sh` gains `STYX_NEAR_NO_ATTACK_MARK=1` |
| `8396bcb` | judge call cap (`STYX_JUDGE_MAX_CALLS`, default 12) |
| `d7fd459` | backoff and transaction-list fallback for neardata |
| `2ae218f`, `f65830b`, `abfe912` | `styx-sentinels quickstart`, the console's Get sentinels box, the README's 3 steps |
| `2d6daa5`, `621bdb5` | `styx-sentinels names`, Import names in the Sentinels panel |
| `03bba29` | merge of `origin/sentinels-runner` (your misses, stricter children, energy, calmer page); the judge verdicts moved into the new rows |
| `4d18d6c` | the fix that met the target: transaction list by default every 1.5 s, confirmed once executed, judge on its own thread, `decided_after_s` in the lineage |
| `f970377` | key reads every 15 s (a 429 from FastNEAR's RPC hit the agent CLI at 4.5 s) |
| `6756c04` | judge `max_tokens` 1200 and a plain error when the model gives no content |

## Tests (all passing at `f970377`; runner re-run at `6756c04`)

| Suite | Count |
| --- | --- |
| Contract (`cargo test --lib`) | 70 |
| CLI (`sdk/near`, `cargo test`) | 10 |
| Sentinels runner | 51 |
| Owner console (vitest) | 78 |
| Swarm page (vitest) | 7 |
| Python workspace | 27 |
| Console smokes: `smoke`, `smoke:wallet`, `smoke:invite`, `smoke:sentinels` | 4 of 4 pass |

## What ran on testnet

Vault `lambda.styx-vaults.testnet`, owner `ishitatest.testnet` (Meteor). 66 transactions touched the
vault; all were re-read with `tx_outcome.sh`: 65 succeeded, one drain payment was refused with
`VaultPaused` as intended. Full tables with links: `TESTNET_RUN.md`.

- Drain, target met: 5 payments settled, the pause landed 6.6 s after the fifth, the sixth refused.
- Judge on NEAR AI Cloud: one verdict in a live drain, signature verified (`provider_tee`).
- Retire and respawn: two payroll false alarms took burst-g1 from +2 to −2; burst-g2 spawned at a
  threshold of 6; the owner swapped the keys in one approval; six payroll payments then passed.

## What failed and why

1. neardata rate-limits anonymous clients (429 on 33 of 40 requests at one a second). Run 1 missed
   all 20 payments; run 2 paused after 8. Fixed by `4d18d6c`.
2. FastNEAR's RPC answered 429 to the agent CLI during a payroll round while the runner read keys
   every 4.5 s. Fixed by `f970377`.
3. The judge returned no content at `max_tokens` 400 (round 3), so it did not take part. Fixed by
   `6756c04`, not yet re-run live. Asked directly about that payroll, it said pause: expect judge
   false alarms on payroll, which the parent will score and select against.
4. `state.json`'s event list showed one unpause twice (cosmetic, not fixed).

## What's left, in priority order

1. Re-run a payroll round with the fixed judge, to see its verdicts (and a judge false alarm) live.
2. Sentinels as a service (`styx-sentinels serve`, a Dockerfile and `fly.toml`, a console button):
   in progress on branch `sentinels-service`, not deployed.
3. `docs/near/NEXT_PROMPTS.md`: prompts for Telegram pause alerts, a public proof page, the
   off/on comparison, pluggable sentinels, and a contract velocity limit (NEEDS POULAV'S REVIEW).
4. `SUBMISSION_FORM.md`, `DEMO_SCRIPT.md` and the README's numbers still describe the first vault.

## Reproduce

```sh
cargo build --release --manifest-path sdk/near/Cargo.toml
# ~/.styx-near/v3.env: STYX_NEAR_VAULT, STYX_NEAR_AGENT_KEY_FILE, STYX_NEAR_STATE_ROOT, VENDOR, STYX_NEAR_CLI, NEARAI_API_KEY (optional)
uv run --project sentinels styx-sentinels quickstart --vault <vault> --cli sdk/near/target/release/styx-near-vault   # sign the printed link once
scripts/near/demo_sentinels.sh 8 1     # a drain; the owner unpauses in the console after
scripts/near/false_alarm.sh 5 1        # a payroll round; the owner unpauses (twice for a sentinel at +2)
scripts/near/false_alarm.sh 6 1        # after the key swap: the next generation lets it through
```

Wait 10 minutes after a drain before a payroll round: a pause within 600 s of an attack window is
scored as a catch.
