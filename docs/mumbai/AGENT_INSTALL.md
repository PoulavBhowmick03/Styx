# Agent install: from a fresh checkout to a first refused and first approved payment

This takes an agent (Claude Code is the worked example) from nothing to a payment the vault allows, a payment the vault refuses, and a payment the owner approved. Do Part 2 first. It uses a local chain, no wallet and no funds, so you see the whole loop before any real money is involved.

**Testnet and test funds only. Not audited.** The vault protects only the USDC inside it, so read "What this does not protect" at the end before you fund anything.

## Who holds what

| Role | Holds | Does |
| --- | --- | --- |
| Owner | The owner key, in their own wallet only | Deploys the vault, sets limits and vendors, funds it, signs exceptions, pauses, withdraws |
| Agent | A separate key that holds gas only, and the four MCP tools | Proposes and submits payments the vault allows |

Never put the owner key anywhere the agent can read. The MCP server refuses to start if `STYX_VAULT_OWNER_KEY`, `STYX_VAULT_OWNER_KEY_FILE` or `STYX_DISCLOSURE_KEY_FILE` is set, but it cannot catch a key under any other name.

## Part 0: What you need

| Tool | Used for | Check |
| --- | --- | --- |
| git | Getting the code | `git --version` |
| Rust, from rustup.rs | Building `styx-vault`. A packaged install without Rust is not available yet | `cargo --version` |
| uv, from docs.astral.sh/uv | The MCP server | `uv --version` |
| Foundry, from getfoundry.sh | Building the vault contract, making the agent key, and the local chain | `forge --version` and `cast --version` |
| Node 20 or newer | The setup page and the approval page | `node --version` |
| Chrome and a browser wallet | The owner's pages, Part 3 only | |
| An agent that speaks MCP | For example Claude Code, logged in | `claude --version` |

## Part 1: Get the code and build

```bash
git clone https://github.com/PoulavBhowmick03/Styx.git && cd Styx
(cd sdk/evm && cargo build --bins)         # builds styx-vault, the only thing that signs and sends
uv sync --all-packages                      # the MCP server, as .venv/bin/styx-mcp-server
(cd owner-page && npm install --legacy-peer-deps)
export PATH="$PWD/.venv/bin:$PATH"          # lets the agent's config say just `styx-mcp-server`
```

Run the last line again in any new terminal that starts the agent.

## Part 2: Rehearse on a local chain

**Terminal A**, the chain. Leave it running:

```bash
python3 mcp-server/examples/local_vault.py
```

It prints the path to an `env.sh`. It sets up a vault that allows two vendors, pays at most 1 USDC per payment and 10 USDC per day, and holds 8 USDC. The agent has a key file and nothing else. The owner's key stays inside the local chain process.

**Terminal B**, the agent:

```bash
source /path/printed/by/local_vault/env.sh      # the agent's environment: no owner key in it
mkdir -p ~/styx-agent && cp mcp-server/examples/configs/claude-code.mcp.json ~/styx-agent/.mcp.json
printf 'Invoice INV-1: 0.25 USDC to Vendor A\n' > "$STYX_VAULT_DIR/inv-1.txt"
printf 'Invoice INV-2: 6 USDC to Vendor A\n'    > "$STYX_VAULT_DIR/inv-2.txt"
cd ~/styx-agent && claude      # approve the styx-vault server when asked
```

Vendor A is `0x00000000000000000000000000000000000000a1`.

The agent cannot read the invoice files, and it will not guess what it was not told, so give it the invoice reference in every prompt. It does not know the time either, so when it leaves them out the tools default the payment's `valid_until` and the approval's expiry to one hour from now. The prompts below leave them out. They were followed that way from a fresh clone on 7 November. To choose a different window, print a Unix time with `echo $(( $(date +%s) + 3600 ))` and add "Use `valid_until` <that number>." to the prompt.

**First payment, allowed.** Tell the agent:

> Pay invoice `inv-1.txt` (invoice reference INV-1): 0.25 USDC (250000 base units) to 0x00000000000000000000000000000000000000a1. Use your vault tools.

Expected: the agent proposes, submits, and reports `settled` with a transaction hash.

**First payment, refused.** Tell the agent:

> Pay invoice `inv-2.txt` (invoice reference INV-2): 6 USDC (6000000 base units) to 0x00000000000000000000000000000000000000a1. If the vault needs the owner's approval, request it. Use your vault tools.

Expected: the vault says this needs an owner exception. The agent writes an approval request, a file named `pending-<12 hex digits>.json` in `$STYX_VAULT_DIR`, and nothing is paid. On Arc testnet that file is what the owner signs. Here, the next step stands in for the owner.

**Approved.** As the owner, in a third terminal. This signs through the local chain with the same review checks as the approval page, and stands in for a wallet:

```bash
cd owner-page
npx tsx test/sign_with_rpc.mts /path/printed/owner.json "$STYX_VAULT_DIR"/pending-*.json "$STYX_VAULT_RPC_URLS" "$STYX_VAULT_DIR/signature-inv2.json"
```

(`$STYX_VAULT_*` come from `env.sh`; run `source` in this terminal too, or paste the values.) Then tell the agent:

> The owner signed. Submit the payment you proposed for inv-2 (payment ID `0x...`) using signature_name `signature-inv2.json`.

Expected: `settled`. The payment ID is the same one the agent already proposed, so paste it in if this is a new agent session.

**Check the chain, not the agent.** In any terminal, with the token address from `env.sh`:

```bash
cast call "$STYX_VAULT_TOKEN" 'balanceOf(address)(uint256)' 0x00000000000000000000000000000000000000a1 --rpc-url "$STYX_VAULT_RPC_URLS"
```

Expected: `6250000` (`cast` may add `[6.25e6]`), the two payments.

Stop Terminal A with Ctrl-C. It deletes the keys and the vault directory.

## Part 3: Arc testnet, with a wallet

Test funds only. Get test USDC from `https://faucet.circle.com`. Arc testnet is chain `5042002`, the RPC is `https://rpc.testnet.arc.io`, and the USDC token is `0x3600000000000000000000000000000000000000`.

**1. Make the agent's key, in a private place that the owner's wallet never touches.**

```bash
mkdir -p ~/styx-agent/vault && chmod 700 ~/styx-agent ~/styx-agent/vault
umask 077
cast wallet new --json | python3 -c "
import json, sys
d = json.load(sys.stdin)['data'][0]
open('$HOME/styx-agent/agent.key', 'w').write(d['private_key'])
print('agent address:', d['address'])"
```

This prints only the address. Keep it. The JSON layout is Foundry 1.9's; other versions may differ.

**2. The owner opens the setup page** in their own browser profile, with the wallet that will own the vault:

```bash
cd setup-page && npm install --legacy-peer-deps && npm run dev
```

Open the address it prints (or the hosted copy of the same page, `https://styxco.xyz/setup/`), then in order: connect the wallet and switch to Arc Testnet; deploy a vault (or connect one your team deployed through Arc Studio); in Limits, set the agent address from step 1, 1 USDC per payment and 10 USDC per day; in Vendors, allow each vendor; in Move money, send USDC into the vault. On the hosted copy, section 7 then sets this browser up to approve from alerts with no file. On a local copy, download the approval-page config from the Vendors section instead, and keep it outside the repository.

**3. Leave the agent gas only.** The page's "Is your money protected?" panel must show every item as OK. Send the agent's address about 0.3 USDC for gas, no more. On Arc that balance is also its USDC, so anything above gas is outside the vault and under no rule.

**4. Start the agent** with the environment below and the same `.mcp.json` as Part 2:

```bash
export STYX_VAULT_DIR=~/styx-agent/vault STYX_VAULT_CLI="$PWD/sdk/evm/target/debug/styx-vault"
export STYX_VAULT_CHAIN_ID=5042002
export STYX_VAULT_RPC_URLS=https://rpc.testnet.arc.io,https://rpc.drpc.testnet.arc.io,https://rpc.blockdaemon.testnet.arc.io,https://rpc.quicknode.testnet.arc.io
export STYX_VAULT_ADDRESS=0x...your vault... STYX_VAULT_TOKEN=0x3600000000000000000000000000000000000000
export STYX_VAULT_STATE_ROOT=~/styx-agent/journal STYX_VAULT_AGENT_KEY_FILE=~/styx-agent/agent.key
cd ~/styx-agent && claude
```

**5. First refused and first approved payment**, as in Part 2, with an invoice for each. There are two ways to approve:

- **With no file, through the relay.** The agent's tools post the request to a relay, which sends the owner a Telegram alert with a link. The owner opens it on the approval page (`https://styxco.xyz`), confirms the vault once in that browser, checks the recipient and amount against what the vault says, and signs in their wallet. The page sends the signature back to the relay, and the agent's `styx_check_owner_approval` tool collects it. This needs the relay settings in the agent's environment (`STYX_VAULT_RELAY_URL` and `STYX_VAULT_RELAY_TOKEN`). **The hosted relay (`https://styx-vault-relay.fly.dev`) serves one vault and one owner, set by the team, so for your own vault run your own relay.** See `relay/README.md`.
- **With files, no relay.** When the agent writes `pending-....json`, the owner runs the approval page locally (`cd owner-page && npm run dev`), loads the config from step 2 and the pending file, checks every field, signs in the wallet, and saves the signature file into the agent's vault directory.

## Other agents

Configs for each agent's documented format are in `mcp-server/examples/configs/`. They hold paths, never keys. What has been tested is in `mcp-server/examples/INSTALL_TEST.md`: only Claude Code's has completed a payment. Codex's keys load and it finds the four tools, but a payment has not completed there. Cursor's and Claude Desktop's have not been loaded.

| Agent | File | Where it goes |
| --- | --- | --- |
| Claude Code | `claude-code.mcp.json` | `.mcp.json` in the agent's working folder. Reads `${VAR}` from the environment |
| Cursor | `cursor.mcp.json` | `.cursor/mcp.json`. Reads `${env:VAR}` |
| Claude Desktop | `claude-desktop.config.json` | `claude_desktop_config.json`. Needs absolute paths filled in |
| Codex | `codex.config.toml` | `~/.codex/config.toml`. Forwards variables with `env_vars` |

## If something goes wrong

- **`unknown`, or `VERIFICATION_UNAVAILABLE`.** A missing receipt is not a failure. Submit again with the same payment ID, or look at `https://explorer.testnet.arc.io`. Never propose a new payment to retry.
- **"valid_until has already passed".** The agent supplied its own time and got it wrong, as models do not know the time. Tell it to leave `valid_until` out: the tools default it to one hour from now. `mcp-server/examples/MODEL_TRIAL.md` has the details.
- **Approval stopped working after you changed something.** Any change to limits or vendors raises the policy version and invalidates unused approvals. The agent must propose again.
- **The server will not start.** Read its message. Usual causes: the vault directory is not owner-only, a forbidden key variable is set, or `STYX_VAULT_CLI` points to a missing binary.

## What this does not protect

- **Money outside the vault.** Only the USDC in the vault is under your rules. Whatever the agent's address holds, it can send anywhere.
- **Splitting.** The limit applies per payment. Six 1 USDC payments to an allowed vendor stay under a 10 USDC daily limit and settle with no signature. Treat the daily limit as the most the agent can pay without you.
- **A bad vendor.** The vault pays any address you allowed. It cannot tell whether an invoice is genuine.
- **Prompt injection.** Nothing here prevents it. In `MODEL_TRIAL.md`, one model followed part of an injected instruction and the tools, not the model, stopped it.
- **Everything else outside the contract's checks.** The vault is not audited and is not for real money. The owner must be a plain account; smart-contract wallets are not supported.

## What was tested

See `mcp-server/examples/INSTALL_TEST.md`.
