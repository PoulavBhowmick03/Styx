# Getting started with Styx

Styx is a vault on NEAR that pays an AI agent's payments within rules you set. The agent holds a key
that NEAR lets call only the pay methods; it cannot change a limit, pause, or withdraw. Sentinels are
watcher agents whose keys can only pause the vault.

## 1. Look around (no wallet)
- [styxco.xyz/try](https://styxco.xyz/try/): send calls with a real agent key and see NEAR refuse the owner methods.
- [The console on a live vault](https://styxco.xyz/console/?vault=sentinels.styx-vaults.testnet&network=testnet): limits, agents, sentinels, payments.
- `uv run --project sentinels styx-sentinels rehearse`: the sentinel swarm on simulated payments, page on 127.0.0.1:8790.

## 2. Your own vault (a NEAR testnet wallet, about 4.2 testnet NEAR)
1. [styxco.xyz/console](https://styxco.xyz/console/): **Create a vault**, sign once.
2. **Register and fund it** (mints test tUSDC), sign once.
3. **Set the rules**: daily cap, a recipient, an approver (copy the invite link for them), and **Generate agent key**. Sign once.
4. The ready screen prints the commands that give Claude Code the payment tools for this vault.

## 3. Add sentinels
1. Build the CLI: `cargo build --release --manifest-path sdk/near/Cargo.toml`.
2. `uv run --project sentinels styx-sentinels init --vault <your vault>`, open the one link it prints, sign once.
3. `uv run --project sentinels styx-sentinels run --vault <your vault> --cli sdk/near/target/release/styx-near-vault`.
   The page opens on 127.0.0.1:8790. Set `NEARAI_API_KEY` to add the judge.
4. A drill: `scripts/near/demo_sentinels.sh` (settings in `~/.styx-near/v3.env`, see `docs/near/SENTINELS.md`).

## More
- How it works and what ran: [README](README.md), [docs/near/SENTINELS.md](docs/near/SENTINELS.md), [docs/near/TESTNET_RUN.md](docs/near/TESTNET_RUN.md).
- Testnet only. Keys stay in `~/.styx-near/`, never in the repo.
