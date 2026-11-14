# Getting started with Styx

Styx is a vault on NEAR that pays your AI agent's payments within rules you set.
- **The agent** holds a key that NEAR lets call only the pay methods: it cannot change a limit, pause
  or withdraw.
- **Your approver** signs any payment over the per-payment limit, from their own wallet.
- **Sentinels** are watcher agents whose keys can only pause the vault, for when a drain of small
  payments starts.

Everything is on NEAR testnet, with test tokens.

## 1. Look around (no wallet, two minutes)
- [styxco.xyz/try](https://styxco.xyz/try/): send calls with a real agent key and see NEAR refuse every
  owner method.
- [A live vault in the console](https://styxco.xyz/console/?vault=sentinels.styx-vaults.testnet&network=testnet):
  its status, balance, today's spend, agents, sentinels and payments.
- The sentinels without a vault: `uv run --project sentinels styx-sentinels rehearse`. This replays a
  drain on simulated payments; the page opens on `127.0.0.1:8790`.

## 2. Your own vault (a Meteor wallet with about 4.2 testnet NEAR)
1. At [styxco.xyz/console](https://styxco.xyz/console/), click **Create a vault** and approve.
2. **Register and fund it**: the console mints test tUSDC. Approve.
3. **Set the rules**:
   - pick a preset, or fill in the daily cap and the most payments in any 10 minutes;
   - paste the accounts the agent may pay;
   - copy the invite link for your approver;
   - click **Generate agent key**.

   Approve. The page ticks each step off when the chain shows it is done.
4. The ready screen prints four commands that give Claude Code the Styx payment tools for this vault.
   Run them, put an invoice in the folder they create, and ask Claude to pay it.

## 3. Your approver (their own wallet and Telegram)
1. They open your invite link, connect their wallet and sign once. That is not a transaction.
2. They send `/start` to `@Styx_pvt_bot` in Telegram and sign the link it returns, once.
3. Every payment over the limit then reaches their phone, and they sign that exact payment on the
   approval page.

## 4. Add sentinels (a machine you keep on, with Rust and uv)
1. `cargo build --release --manifest-path sdk/near/Cargo.toml`
2. `uv run --project sentinels styx-sentinels quickstart --vault <your vault> --cli sdk/near/target/release/styx-near-vault`
3. Open the one console link it prints and approve.

They start watching once their keys are on the vault, and the live page opens on `127.0.0.1:8790`.
- For the judge sentinel, set `NEARAI_API_KEY` and add `--extra judge` after `uv run`.
- They watch only while that machine runs the command.
- If one pauses the vault, the console's Sentinels panel shows why. Unpause there if it was a false
  alarm; the sentinels learn from it.
- To see it work, `scripts/near/compare_sentinels.sh` runs the same drain with sentinels off and on.
  It needs the settings file described in [docs/near/SENTINELS.md](docs/near/SENTINELS.md#run-it-on-testnet).

## More
- How it works, and what ran on testnet: the [README](README.md),
  [docs/near/SENTINELS.md](docs/near/SENTINELS.md) and [docs/near/TESTNET_RUN.md](docs/near/TESTNET_RUN.md).
- Keys stay in `~/.styx-near/`, never in the repo.
