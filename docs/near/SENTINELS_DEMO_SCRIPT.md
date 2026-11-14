# Sentinels demo: recording script (about 90 seconds)

A live run on Styx's own testnet vault, `sentinels.styx-vaults.testnet`. It shows a hijacked agent
draining in small allowed payments, a sentinel pausing the vault with its own pause-only key, and the
owner reading the reason and unpausing. Every step is a real testnet transaction. This run happened
on 14 Nov 2026 ([TESTNET_RUN.md](TESTNET_RUN.md#sentinels-on-testnet-14-nov-2026)).

No vault or keys? `uv run --project sentinels styx-sentinels rehearse` replays the whole lifecycle on
simulated payments, including a retirement and a respawn. It is good for a backup take, but it is not
evidence.

## Before recording (on Poulav's machine)

1. **Settings.** `~/.styx-near/v3.env` holds the vault, the agent key path, the state root, and
   `VENDOR`. It contains paths only, no keys. Point `STYX_NEAR_CLI` in it at a CLI built from
   `main` (`cargo build --release --manifest-path sdk/near/Cargo.toml`). The CLI must sign
   `sentinel_pause` with 20 Tgas, which commit `90399ca` and later do.
2. **Owner and keys.** The vault's owner is `styx-owner-c87a.testnet` (near CLI legacy keychain). Its
   three sentinel keys are already installed: burst-g1, concentration-g1 and judge-g1.
3. **Judge (optional).** `export NEARAI_API_KEY=...` in the recording terminal, so the judge
   sentinel takes part. Without it, the judge waits and the rule sentinels watch.
4. **Clear the window.** Start at least 5 minutes after the last drain payment. Otherwise the burst
   sentinel pauses on the previous run's payments before the new drain begins.
5. **Vault state.** Check that the vault is not paused, then unpause it if needed:
   - `near contract call-function as-read-only sentinels.styx-vaults.testnet get_vault json-args {} network-config testnet-fastnear now`
   - Unpause from the console, or with the CLI as the owner.

   The agent allows 100 tUSDC a day, and each run spends about 6.
6. **Screen layout.**
   - Left half: a terminal in the repo, font large, nothing from `~/.styx-near` visible.
   - Right half: the browser, with two tabs: `http://127.0.0.1:8790/` (opens once the runner
     starts) and `https://styxco.xyz/console/?vault=sentinels.styx-vaults.testnet&network=testnet`,
     scrolled to Sentinels.
7. **Rehearse once without recording.** The run takes about 2 minutes. Payments land about 9 seconds
   apart.

## Shots

| Time | On screen | Say |
| --- | --- | --- |
| 0:00 | The console's Sentinels panel: three keys, each "methods: sentinel_pause", allowance 0.05 NEAR | "Spending limits stop one big theft. They don't stop a hijacked agent draining a vault in small payments that each pass every limit. So this vault has sentinels: watcher agents. Each has its own NEAR key, and NEAR lets that key do exactly one thing: pause the vault." |
| 0:15 | Terminal: `scripts/near/demo_sentinels.sh 20 1`. Steps 1 to 3 print: version 3, every key installed. Switch to the swarm page: three cards, "Vault live" | "Three sentinels: a burst rule, a concentration rule, and a judge model on NEAR AI Cloud. They read every payment the vault makes." |
| 0:25 | Step 4: "Payment 1/20, 2/20…" with transaction hashes. On the page, bars appear in the shaded attack band | "Now the agent is hijacked. It pays one token at a time, to one account, as fast as it can. Every payment is inside the limits, so the vault pays." |
| 0:45 | The page goes **Vault paused**. Burst's card: "5 payments in 5 min (5 total), over the 4 allowed". Terminal: `the vault refused: VaultPaused`, "Stopped" | "Five payments in, the burst sentinel pauses the vault with its own key. The next payment is refused, and the drain stops." |
| 0:55 | Terminal step 5: "The vault is PAUSED", the lineage lines. Open the pause transaction on nearblocks: signer key = burst's key, method `sentinel_pause` | "It's a real testnet transaction, signed by the sentinel. That key can't pay, unpause, withdraw or change a rule. NEAR refuses all of that before a block." |
| 1:05 | Console, Recent pauses: the reason and the transaction. The paused banner, then **Review unpause** and sign (or the CLI unpause) | "The owner sees why, and unpauses. Only the owner can." |
| 1:15 | Swarm page: burst **+1**, "1 caught"; the lineage: "settled as catch: inside a marked attack"; Generations | "A parent scores every sentinel. This pause was a catch. A sentinel that cries wolf twice is retired, and its next generation starts with what it learned. That's in the repo's rehearsal." |
| 1:25 | `docs/near/TESTNET_RUN.md`, the Sentinels section | "Every transaction is listed in the repo. Built at the NEAR Hackathon." |

## If something goes wrong

- **The page shows "pause failed" with `InvalidTransaction`.** The CLI is older than `90399ca`:
  rebuild it.
- **`429` in the terminal.** Something is using `rpc.testnet.near.org`. The scripts use FastNEAR;
  check that `STYX_SENTINEL_RPC` isn't set to the other one.
- **It paused before the drain started.** The 5-minute window wasn't clear. Unpause, wait 5 minutes,
  and run again.
- **Stopping.** Ctrl+C stops the runner, and the page goes away with it. If the drain is still
  running, `pkill -f drain_attack` stops it.

Do not say "secure", "audited" or "solves". Say what ran.
