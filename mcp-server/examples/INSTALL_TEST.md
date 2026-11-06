# Testing `docs/mumbai/AGENT_INSTALL.md`

> Written before the vault contract was replaced with Arc Studio's version and before `valid_until` became optional. Part 1's `forge build` step has since been removed from the guide, because the setup page now builds the vault itself. The guide was not re-followed end to end after those changes.

Followed on 6 November 2026, step by step, from a fresh clone of this repository (branch `claude2/real-agent`) into an empty folder, on macOS. The Rust build, the Python environment, the contract build and the npm installs were all fresh. The agent was Claude Code (`claude -p`, version 2.1.319) using the guide's own `claude-code.mcp.json` and prompts.

## What passed

| Guide step | Result |
| --- | --- |
| Part 1: clone, `cargo build --bins`, `uv sync --all-packages`, `forge build`, `npm install` in `owner-page` | All worked. `styx-mcp-server` found on `PATH` after the `export PATH` line |
| Part 2: `local_vault.py` | Printed the `env.sh` path and the owner config path. Exits 0 on Ctrl-C and deletes its folder, and no Anvil process is left |
| Part 2: first payment, allowed | Agent proposed and submitted 0.25 USDC. Settled |
| Part 2: first payment, refused | Agent proposed 6 USDC, was told it needs an exception, wrote `pending-<id>.json`. Nothing paid |
| Part 2: approved | The owner step signed through the local chain. The agent submitted the same payment ID with the signature file. Settled |
| Part 2: check the chain | `cast` returned `6250000` for Vendor A, the two payments |
| Part 3 step 1: make the agent key | Written with mode 600 in a mode 700 folder. Only the address printed. The address derived from the key matched |
| Part 3 step 2: `npm run dev` in `setup-page` | Served the page and `vault-artifact.json` |
| `setup-page` typecheck, unit tests, browser test | 15 unit tests and 7 browser scenarios passed in the fresh clone |

## What failed, and what changed in the guide

1. **The first payment did not happen.** The original prompt said only "pay `inv-1.txt`". The agent cannot read invoice files, and `styx_propose_payment` needs an invoice reference and a `valid_until` time. The agent said it would not guess either and stopped, which was the right behaviour. The guide now gives the reference and a computed `valid_until` in every prompt.
2. **The refused payment had no approval expiry.** With no one to ask, a non-interactive agent has nothing to give. The guide's prompt now carries `authorization_expiry`.
3. **A fresh agent session does not remember the payment ID.** The guide now says to paste it.
4. **`cast` prints `6250000 [6.25e6]`.** The guide now says so.

## Deviations from the guide, to be fair about what was tested

- I used a scratch folder instead of `~/styx-agent`, so nothing was created in a home directory. The Part 3 key step ran with `HOME` pointed at the scratch folder.
- I used `claude -p` with the guide's prompts, not an interactive `claude` session. Because Claude Code skips the project-server approval prompt in `-p` runs, the approval step the guide mentions ("approve the styx-vault server when asked") was not exercised.
- The owner "signed" through `sign_with_rpc.mts`, with the local chain standing in for a wallet. That runs the owner page's review and signing code, but no browser wallet was involved.
- The machine already had Rust, uv, Foundry, Node, Chrome and Claude Code installed, and a warm Cargo cache. Installing those from nothing was not tested.

## Not verified

- **Anything on Arc testnet.** Part 3 steps 2 to 5 (deploying or connecting a vault, setting limits, funding, the agent paying on Arc, signing with a real wallet) were not run. No live network was touched and no funds were spent.
- Any real browser wallet, with the setup page or the approval page.
- The configs for Cursor, Claude Desktop and Codex. They follow each tool's documentation (read 6 November 2026) and parse as JSON or TOML, but none was loaded into the tool.
- Interactive Claude Code, Windows, Linux, or other Foundry versions (the key step reads Foundry 1.9's JSON layout).
- The relay and Telegram alert path.
- The Rust-free packaged install, which does not exist yet.

## Noise to expect

`claude -p` prints `[mcp-sdk] SEP-2352 ... issuer stamp` on stderr, and "no stdin data received in 3s" when stdin is a terminal. Neither affected a run.

## The agent configs, tested on 7 November

| Agent | Result |
| --- | --- |
| Claude Code | Ran: the example's `.mcp.json` started the server and the agent paid and was refused (see above) |
| Codex | **Partly.** Real Codex 0.154.0 accepted every key in `codex.config.toml` (`command`, `args`, `env`, `env_vars`) and listed the server as enabled. That check passed the keys as `-c` overrides: the file itself was not loaded from `~/.codex`, which was left alone. In a session on a local chain, Codex started the server and found all four tools. It then refused the tool call, because its non-interactive mode blocks MCP tools unless `default_tools_approval_mode` is set. With `approve` set, two sessions (300 s and 150 s) did not finish, the cause was not found, and no payment was made. **Not shown: a payment completed through Codex** |
| Claude Desktop | **Not loaded.** The app is installed, but testing means editing its live config file and restarting it. That was left for Ishita |
| Cursor | **Not loaded.** It is not installed on this machine |

Three Codex sessions used Ishita's Codex login, on a throwaway local chain only. Nothing was sent to Arc.

## Followed again from a fresh clone after the rename, 7 November

The guide was followed step by step from a clone of the public GitHub repository (`55fe561`, after the rename to Styx and the removal of unused code), into an empty folder, on macOS with Apple Silicon, with Rust, uv, Foundry, Node and Claude Code already installed.

| Guide step | Result |
| --- | --- |
| Part 1: `cargo build --bins` with an empty target folder | Built in 31 seconds. Produced `styx-vault` and `styx-disclosure` |
| Part 1: `uv sync --all-packages` | Worked. The MCP server is `.venv/bin/styx-mcp-server`, and no `erebus` command is left |
| Part 1: `npm install` in `owner-page` | Worked |
| Part 2: `local_vault.py` | Started. Printed the `env.sh` path (now with `STYX_VAULT_*` names) and the owner config path |
| Part 2: first payment, allowed, with **no times in the prompt** | The agent proposed and submitted, and the vault reported `settled`. This is the first time the guide's "leave the times out" claim was followed through the guide, not just the trial harness |
| Part 2: first payment, refused, no times | The vault said it needs an exception. The agent wrote `pending-<id>.json` and nothing was paid |
| Part 2: the owner's signature through `sign_with_rpc.mts` | Wrote `signature-inv2.json` |
| Part 2: approved | The agent submitted with the signature and the vault reported `settled`. `cast` showed `6250000 [6.25e6]` at vendor A, as the guide says |
| Part 3 step 1: the agent key snippet | Wrote a mode 600 key file in a mode 700 folder and printed only the address |
| Part 3 step 2: `npm run dev` in `setup-page` | Served the page and its contract build, which had 50 ABI entries |
| Configs named in the guide | All four files exist, none has an old name, and every `STYX_*` name in the docs and configs is read by code |

**Deviations from the guide, so this is read fairly:**
- A scratch folder instead of `~/styx-agent`, and `claude -p` with the guide's prompts instead of an interactive session. Because `claude -p` skips the project-server approval prompt, the guide's "approve the styx-vault server when asked" was not exercised.
- Part 3 steps 3 to 5 need Arc testnet and a wallet and were not run. The hosted pages and the relay were not used.
- The machine already had every prerequisite and a warm Cargo cache. Installing them from nothing was not tested.

**What the walkthrough changed in the guide:** the prompts no longer carry times (they were unnecessary and made the guide look harder than it is); Part 3 now says there are two ways to approve, the relay route with no file and the file route, and that the hosted relay serves one vault and one owner; and the "valid_until has already passed" entry now says to leave it out.

**Not caught by the guide, found while reviewing the removal:** `packaging/smoke-install.py` fails on its last step. After the removal `styx-mcp-server` refuses to start without `STYX_BACKEND` set to `vault` or `disclosure`, and that includes `--help`, which exits 2. The smoke test expects `--help` to succeed.

