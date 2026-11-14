# Prompts for the next Sentinels features

Shared rules for every prompt below (from CLAUDE.md): testnet only; no keys, `.env` files or
keystores in the repo, and never print one; small conventional commits; contract or signing-code
changes go in their own commit marked NEEDS POULAV'S REVIEW and are never deployed; claim only what a
test or a testnet run shows (no "secure", "audited", "solves"). Work on your own branch from `main`
and do not merge to `main` or deploy without asking. Read first: `CLAUDE.md`,
`docs/near/SENTINELS.md`, `docs/near/SENTINELS_HANDOFF.md`, and the sentinels sections of
`docs/near/TESTNET_RUN.md`.

## 1. Codex: pause alerts on Telegram, with an Unpause link (branch `sentinel-alerts`)

The relay (`relay-near/`, deployed on Fly as `styx-relay-near`) already sends Telegram spend alerts
for watched vaults (`relay-near/src/watches.ts`, `telegram.ts`) and approval alerts with a "Freeze
this agent" console link. Add a third alert: when a watched vault logs `sentinel_paused`
(EVENT_JSON, standard `styx`, data `{sentinel, reason, day, vault_day_spent}`), send the owner's
linked Telegram chat one message: the sentinel's key (short form), the reason as plain text (it is
the sentinel's own words, up to 280 bytes: never render it as HTML or Markdown), the transaction
link, and a console link `https://styxco.xyz/console/?vault=<vault>&network=testnet#sentinels` that
opens the paused banner with Review unpause. One alert per pause transaction, even across relay
restarts. Unit tests with fixture receipts in `relay-near/src/*.test.ts`, no network. Done when
`npm test` passes in `relay-near` and the README of `relay-near` documents the alert. Do not deploy
the relay; say what `fly deploy` would change.

## 2. Codex: a public proof page at styxco.xyz/proof/ (branch `sentinel-proof-page`)

Judges cannot open the swarm's live page (it runs on 127.0.0.1). Build a read-only static page
(new Vite + TypeScript app `proof-page-near/`, styled with `site/styx.css` like the console, built
into `/proof/` by `scripts/build_site.sh`) that reads a vault from the chain only: FastNEAR's
transaction API for the vault's transactions and `https://test.rpc.fastnear.com` to confirm each
one, the same way `sentinels/styx_sentinels/events.py` does. `?vault=` picks the vault (default
`lambda.styx-vaults.testnet`). Show: payments as a timeline, each `sentinel_paused` with its reason
as text, each owner `unpaused`, and for each pause "N payments settled before it, the pause landed
X s after the last one" computed from block timestamps, with NearBlocks links for every
transaction. No keys, no wallet, no writes. Vitest unit tests for the event parsing and the
latency maths with fixture transactions; one browser smoke like `owner-console-near/test/*.mjs`.
Every value from the chain is escaped.

## 3. Claude Code: sentinels off and on, as numbers (branch `sentinel-comparison`)

Write `scripts/near/compare_sentinels.sh`: on a version 3 vault from `~/.styx-near/v3.env`, run
`drain_attack.sh N 1` with no runner (sentinels off), record how many payments settle, then wait for
the 5-minute window and the owner's unpause if needed, start the swarm, and run the same drain
(sentinels on). Print one table: payments settled, tUSDC lost, time from the first payment to the
pause, with transaction links. Keep N small (8) and stop if the vault's balance or the agent's
daily limit would not cover both runs. Run it once on testnet with the owner, record every
transaction with `scripts/near/tx_outcome.sh` in `docs/near/TESTNET_RUN.md`, and put the table in
`docs/near/SENTINELS.md`. Note that the "off" run spends N tUSDC on purpose.

## 4. Claude Code: pluggable sentinels (branch `sentinel-plugins`)

Every sentinel answers `judge(history, now, daily_limit) -> Verdict` (`sentinels/styx_sentinels/rules.py`,
the `Sentinel` protocol). Let anyone add a kind without editing the runner:
- a plug-in is a Python module exposing `KIND`, `DEFAULTS` (params), `build(params, notes)` and
  `mutate(params, direction) -> (params, note)` (direction `looser` | `stricter`, as `adjust` in
  `swarm.py` does for burst and concentration);
- plug-ins are listed in `~/.styx-near/sentinels/plugins.toml` (outside the repo) and enabled per
  vault with `styx-sentinels add --vault V --kind K`;
- run each plug-in in its own subprocess that receives only the payment list as JSON on stdin and
  returns `{pause, reason}` on stdout, with a time limit; it never receives a key, a key path or the
  swarm's home; a crash or timeout is a quiet verdict plus a lineage line;
- the parent scores, retires and mutates plug-ins exactly like built-ins.
Ship one example plug-in, `new_recipient` (pauses when a recipient never paid before takes more
than X% of the daily limit). Tests for the isolation (a plug-in that tries to read the key folder
gets nothing), the timeout, and selection over a plug-in. Update `docs/near/SENTINELS.md`.

## 5. Claude Code, for Poulav: a velocity limit in the contract (branch `vault-velocity-limit`)

Roadmap item, contract change: NEEDS POULAV'S REVIEW, do not deploy. In
`contracts/near/styx-vault`, add an owner-set `max_payments_per_window` and `window_seconds`
(default off) checked in every pay path (`pay`, `pay_with_exception`, the EVM and x402 paths): a
payment that would exceed it is refused with a new error `VelocityLimit`, before any transfer or
signature request. Only the owner sets it (`onlyOwner`-style check like the other setters); it is
part of `get_vault`. Unit tests in `cargo test --lib` (the 70 existing must still pass): the limit
off by default, the N+1th payment refused, the window sliding, the agent and a sentinel key unable
to change it. One commit for the contract, marked NEEDS POULAV'S REVIEW, and a short design note in
`docs/near/` saying what changes for the factory and the console.
