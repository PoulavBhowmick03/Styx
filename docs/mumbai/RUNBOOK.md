# Runbook: gates G1 to G4

Everything here uses Arc testnet and test funds only. Keep every key outside this repo.

## 0. Before spending anything

```bash
(cd sdk/evm && cargo build --bins)
(cd contracts/evm && forge test && python3 script/arc_simulate.py)  # simulates against real USDC on Arc; no funds
scripts/local_demo.sh                                               # full rehearsal on a local chain
```

If the contract came from Arc Studio, put it at `contracts/evm/src/StyxPolicyVault.sol` first. These checks then test Studio's version, and a changed interface shows up here rather than on stage.

## 1. Keys and funds

Create separate accounts for the owner, the agent and the issuer. The owner's key stays in its own wallet and browser profile.

| Account | Needs | Notes |
| --- | --- | --- |
| Owner | About 8.1 USDC from `https://faucet.circle.com` | Funds the vault and pays for setup |
| Agent | About 0.3 USDC for gas | Each payment costs about 0.01 USDC. The script's reverted attacks can cost up to 0.02 each |
| Vendor A, vendor B | Nothing | Any two addresses you control. Transfers to `address(0)` revert on Arc |

Native USDC and ERC-20 USDC are one balance on Arc. The native side uses 18 decimals and the ERC-20 side uses 6, so 1 USDC is `1000000` below.

## 2. Deploy and configure (owner)

Deploy through Arc Studio as the plan describes, and record the address, transaction and block. The constructor takes the owner address and `0x3600000000000000000000000000000000000000`.

```bash
export RPC=https://rpc.testnet.arc.io USDC=0x3600000000000000000000000000000000000000
export VAULT=0x...  AGENT=0x...  VENDOR_A=0x...  VENDOR_B=0x...
UNTIL=$(( $(date +%s) + 7*86400 ))
cast send "$VAULT" 'configurePolicy(address,uint256,uint256,uint64)' "$AGENT" 1000000 10000000 "$UNTIL" --rpc-url "$RPC" --interactive
cast send "$VAULT" 'setRecipient(address,bool)' "$VENDOR_A" true --rpc-url "$RPC" --interactive
cast send "$VAULT" 'setRecipient(address,bool)' "$VENDOR_B" true --rpc-url "$RPC" --interactive
# The vault has no receive function: fund it through the ERC-20 interface.
cast send "$USDC" 'transfer(address,uint256)' "$VAULT" 8000000 --rpc-url "$RPC" --interactive
cast call "$USDC" 'balanceOf(address)(uint256)' "$VAULT" --rpc-url "$RPC"   # expect 8000000
```

Every `configurePolicy` or `setRecipient` call raises the policy version, so finish setup before proposing payments.

## 3. Owner pages

**Hosted, with no file.** The approval page is at `https://styxco.xyz` and the setup page at `https://styxco.xyz/setup/`, on one site so that what the owner confirms on one is read by the other. When the owner connects to their vault on the setup page, section 7 sets the browser up to approve from alerts. The approval page then reads the owner, token, limits and allowlist from the vault itself, so no config file is needed. The hosted relay serves one vault and one owner, set in `relay/fly.toml`, and accepts approvals only from `https://styxco.xyz`.

**Local, with a config file.**

```bash
cd owner-page && npm install --legacy-peer-deps && npm run dev
```

Open it in the owner's own browser profile. Copy `owner-config.example.json` outside the repo and fill in the real addresses, or download the config from the Vendors section of the setup page. Vendor labels come only from this file.

To get a Telegram alert instead of carrying files by hand, run the relay. See `relay/README.md`.

## 4. Run G1, G2 and the attacks

```bash
export STYX_VAULT_CHAIN_ID=5042002
export STYX_VAULT_RPC_URLS=https://rpc.testnet.arc.io,https://rpc.drpc.testnet.arc.io,https://rpc.blockdaemon.testnet.arc.io,https://rpc.quicknode.testnet.arc.io
export STYX_VAULT_ADDRESS="$VAULT" STYX_VAULT_TOKEN="$USDC"
export STYX_VAULT_AGENT_KEY_FILE=~/keys/agent.key   # owner-only, hex key
export ISSUER_KEY_FILE=~/keys/issuer.key              # owner-only, 32 raw bytes
export VENDOR_A VENDOR_B OUT=~/styx-gate-run
scripts/run_gates.sh
```

The script pauses for the owner. Load the pending file it names into the page, sign, and save the output to the signature path it prints. `results.txt` in `OUT` keeps every transaction hash for the README.

**If a step reports `unknown`:** a missing receipt is not a failure. Run `styx-vault` `submit` again with the same payment ID, or check the explorer at `https://explorer.testnet.arc.io`. Never propose a new payment to retry.

## 5. G3 on a second machine

The script's reviewer section runs on one machine, which does not pass G3. On a second machine or clean profile, with only `sdk/evm`'s `styx-disclosure` binary:

1. The reviewer runs `{"method":"keygen","key_file":"..."}` and sends back their public key.
2. The issuer runs `export_vault_payment` with that key, using the record in `OUT`, and sends the grant.
3. The reviewer runs `verify_vault_payment` with their own RPC, the issuer's address, and the vault's code hash obtained separately. Then repeat with a tampered copy and a second record.

`mcp-server/examples/g3_review.sh <first.grant> <second.grant> <issuer>` runs the reviewer's side in one go, sends no transaction, and says whether each outcome was the expected one. It never says G3 passed.

**A grant made by an older build cannot be opened by a newer one.** The grant's domain string changed when the project was renamed to Styx, so the issuer and the reviewer must use `styx-disclosure` from the same build, and grants made before the rename must be reissued.

## 6. G4 Arkiv

Get tGLM from `hub.arkiv.network/faucet` and an access key from `hub.arkiv.network/access-keys`, using a separate publisher key.

```bash
cd arkiv && npm install --legacy-peer-deps
ARKIV_PUBLISHER_KEY_FILE=... ARKIV_ACCESS_KEY=... npm run publish-grant -- exception.grant
# With every other process stopped:
npm run fetch-grant -- <lookup-tag> <writer-address> fetched.grant
```

Run the verifier on `fetched.grant`, then add the writer address and one query to the README and update `arkiv/`'s files. `scripts/arkiv_gate.sh` does the publish, then the fetch and verify with every project process stopped, and refuses to run if one is still running.

## Using a model as the agent

`mcp-server/examples/vault_agent.py` is a scripted agent with no model. To use a real one, point its MCP client at `styx-mcp-server` with `STYX_BACKEND=vault`, `STYX_VAULT_DIR`, `STYX_VAULT_CLI` and the `STYX_VAULT_*` settings above. Never put an owner key in that environment. The server refuses to start if `STYX_VAULT_OWNER_KEY`, `STYX_VAULT_OWNER_KEY_FILE` or `STYX_DISCLOSURE_KEY_FILE` is set, but it cannot detect a key under another name.

## The live demo

`scripts/demo.sh` runs the demo one key press at a time through the real MCP tools on Arc: `check`, `pay`, `approve`, `attack`, `review`, `arkiv` and `links`, or all of them with no argument. Pass a step's name to run only that step.

It reads a private settings file, `~/.styx-mumbai/demo.env`, or the path in `DEMO_ENV`, which stays outside this repo. It sets the `STYX_VAULT_*` values, `STYX_VAULT_RELAY_TOKEN`, `DEMO_RPC`, `DEMO_APPROVER`, `DEMO_VENDOR_A`, `DEMO_VENDOR_B`, `DEMO_ISSUER`, `ISSUER_KEY_FILE`, `REVIEWER_KEY_FILE`, `OTHER_REVIEWER_KEY_FILE`, `DEMO_ARKIV_TAG`, `DEMO_ARKIV_WRITER`, and optionally `ARKIV_ACCESS_KEY`. `check` reports how many runs today's limits allow.
