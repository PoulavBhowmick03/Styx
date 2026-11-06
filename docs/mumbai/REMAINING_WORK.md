# Remaining work

Written 6 November 2026. Submissions close Saturday 7 November 2026 at 09:00 IST. Status is in `STATUS.md`, the original plan in `BUILD_PLAN.md`, and live-run steps in `RUNBOOK.md`.

## Goal

Anyone with an agent controlling a wallet can move funds into a vault, set limits, and get a phone alert when the agent wants to exceed them, without using a terminal.

**Priority rule:** gates G0 to G3 come first. They need humans, and no agent task here may delay them. Everything below must leave the existing tests green.

## Who does what

Each agent writes only the paths it owns. Each one reviews another's work, as plan section 12 requires.

| Worker | Owns | Reviews |
| --- | --- | --- |
| **Claude 1** (Poulav) | `arkiv/`, `relay/`, `owner-page/`, `mcp-server/src/erebus_mcp/vault.py`, `sdk/py/src/erebus/_vault.py`, `mcp-server/tests/test_vault*.py` | Claude 2 |
| **Claude 2** (Ishita) | `setup-page/`, `mcp-server/examples/`, `docs/mumbai/AGENT_INSTALL.md` | Codex |
| **Codex** (Poulav) | `packaging/`, `.github/`, `watcher/`, `docs/mumbai/SECURITY_REVIEW.md`, `sdk/evm/src/arc_vault/` (bug fixes only) | Claude 1 |
| **Humans** | Arc Studio, deployments, keys, funds, sponsor logins, booth questions, the G0 decision, the demo video, the final README | Everything that handles contracts or signing |

**Nobody edits `contracts/evm/src/ErebusPolicyVault.sol`.** It is frozen until Studio's version arrives. Report contract bugs to Poulav.

## Rules for every agent

- Work on your own branch, `claude1/...`, `claude2/...` or `codex/...`. Rebase on `main` and merge only with passing tests. Never force-push `main`.
- Small commits with conventional messages. Keep contract changes and agent or MCP changes separate.
- Never commit keys, tokens, `.env` files, keystores or mnemonics, test keys included. Generate keys at runtime in tests. Run `gitleaks protect --staged --config .gitleaks.toml` before each commit.
- Do not deploy, spend funds, or use a sponsor login unless a human says so.
- Read official docs before using an API. Never guess endpoints or package exports. Mark assumptions.
- Claim only what a test or live run shows. Never claim audited, production-ready, regulatory compliance, prompt-injection prevention, private payments, or support for all wallets (plan section 13).
- **G0 is open.** Do not write that the whole project was built at the event, and do not remove existing disclosure. See `STATUS.md`.
- Treat agent-written text as untrusted everywhere. Keep owner keys, the Telegram bot token and World secrets out of the agent's environment.
- If something needs a human, write it in your report and move on to the next task.

## Test commands

```bash
(cd sdk/evm && cargo build --bins && cargo test --no-fail-fast && cargo test --test vault_local_chain -- --ignored)
(cd sdk/core && cargo test) && (cd sdk/transport && cargo test)
(cd contracts/evm && forge test)
(cd owner-page && npm install --legacy-peer-deps && npm run typecheck && npm test && npm run e2e)
(cd arkiv && npm install --legacy-peer-deps && npm run typecheck && npm test)
uv sync --all-packages && uv run pytest mcp-server/tests sdk/py/tests
scripts/local_demo.sh
```

One known failure: `test_every_mapped_message_exists_where_it_is_produced`, which reads `sdk/shielded/src`, a path not in this repo.

## Frozen interfaces

**Contract:** the EIP-712 types, `PaymentExecuted` and the error names, as in `BUILD_PLAN.md` section 4 and `sdk/core/tests/fixtures/vault-eip712-vector.json`.

**CLI and MCP:** the `erebus-vault` methods and four tools as they stand in `sdk/evm/src/arc_vault/service.rs` and `mcp-server/src/erebus_mcp/vault.py`. Additions are fine; changes go through the owner.

**Relay, owned by Claude 1.** All bodies are JSON. `relay/README.md` is authoritative.

| Call | Who | Purpose |
| --- | --- | --- |
| `POST /requests` with `Authorization: Bearer <agent token>` and body `{"pending": <vault-pending-approval/1>}` | Agent | Stores a request and alerts the owner. Returns `{"requestId", "alerted"}` |
| `GET /requests/<id>` | Owner page | Returns the pending file. The page verifies everything itself |
| `POST /requests/<id>/signature` with a `vault-owner-signature/1` body | Owner page | Accepted only if it recovers to the configured owner over this exact request |
| `GET /requests/<id>/signature` with the agent token | Agent | `{"status":"pending"}` or `{"status":"signed","signature":{...}}` |
| `POST /alerts` with a separate watcher token and body `{"kind","text"}` | Watcher | Sends the owner a notice with no request attached |

## Tasks

### Claude 1: alerts and relay (done, not yet run with a real bot)

Built and tested against a fake Telegram server and a local chain: `relay/`, opening requests from alert links in `owner-page/`, and `erebus_check_owner_approval` plus relay alerts in `vault.py`. See `relay/README.md`.

Next, once a human provides a bot token: send one real alert and open its link on a phone.

### Claude 2: setup and real agents

1. `setup-page/`: a static page where an owner, in their own wallet, can deploy or connect a vault, set limits, add and remove vendors, fund it through USDC `transfer`, pause, unpause and withdraw. Use viem. The native balance and ERC-20 USDC are the same money on Arc, with 18 and 6 decimals, and amounts must never pass through floats. Show the current policy version and warn that any policy change invalidates pending approvals. Test with Anvil in headless Chrome, following `owner-page/test/browser.e2e.mjs`.
2. **Moving the money:** make the setup flow state that the vault only protects what is inside it, and guide the owner to move funds in and leave the agent with gas only.
3. **A real model as the agent:** add MCP configs in `mcp-server/examples/` for common agents, starting with Claude Code. On a local chain, record what a model actually does when refused and when given hostile invoice text. Report honestly. Do not claim prompt-injection prevention.
4. `docs/mumbai/AGENT_INSTALL.md`: from a clean machine to a first refused and first approved payment. Test it by following it.

### Claude 2: next tasks (6 November, after the first real-wallet run)

Tasks 1 to 4 above are done. See the report in `STATUS.md`. The vault is deployed at `0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1`. Do not send transactions to it and do not use anyone's keys. Test on Anvil.

The first real MetaMask run found these, in priority order:

1. **Owners end up on the wrong vault.** With the page's real vault available, an owner clicked deploy and configured a second vault, `0x392b...e234`, by mistake. They then believed the real one was set up. Make the connected vault unmistakable at the top of the page and in every action's confirmation. Support `?vault=0x...` to open a specific vault, and warn before deploying a second one. Add a way to switch vaults that does not need a reload.
2. **Plain sends to the vault revert.** An owner lost gas sending 70 USDC directly from MetaMask, because the vault has no receive function. Say this plainly next to the vault address and in section 5.
3. **"Could not list vendors" on Arc.** `setup-page/src/main.ts:340` queries logs in a range the public RPC refuses. Page through from the vault's deploy block in small ranges, with a clear partial-result message, so owners can see the vendors they allowed. Check the RPC's limit in Arc's docs and do not guess it.
4. **Say what the daily limit means.** On the setup page, state that it is the most the agent can pay without a signature, because splitting into small payments is allowed. Do the page wording only. Do not change the contract.
5. **Fix `vault_agent.py` restarts** (`SECURITY_REVIEW.md`, "restart after unknown"). Rerunning it must reconcile retained payment IDs before it proposes anything new, because the project rule is to never mint a new ID to retry. Add a failing test first.
6. `docs/mumbai/ARCHITECTURE.md`: the architecture diagram Arc's prizes require, as a Mermaid diagram plus a short explanation of owner, agent, reviewer, vault, relay and pages. Show what is on-chain and what is off-chain, and what each part is trusted for. Describe only what exists.
7. `docs/mumbai/DEMO_SCRIPT.md`: a 2 to 4 minute shot list for the real demo, using `scripts/run_gates.sh`, that shows Arc Studio. Label anything not yet run on Arc as not yet run. Arc's prizes require showing Studio and a shareable Studio URL.

Report what you find. Poulav decides the entry type (G0) and the prize picks, so don't write those as settled. `README_DRAFT.md` is local to Poulav's machine, so don't look for it.

**Ishita, as a human:** try the Cursor, Claude Desktop and Codex configs in the real apps. Ask the Arc booth whether pages outside Studio meet "connect them to a web or mobile app without leaving Studio" and, on the World side, whether OIDC step-up counts as Agent Pass.

### Codex: packaging, CI, watcher, security

1. **Security review first.** Adversarially review `ErebusPolicyVault.sol`, `sdk/evm/src/arc_vault/` and `owner-page/src/approval.ts`, and write findings with file and line in `docs/mumbai/SECURITY_REVIEW.md`. Add failing tests where you can. Report contract issues; do not patch the contract. This is not an audit and must not be described as one.
2. **Packaging:** `packaging/erebus-cli` is a metadata-only stub. Ship `erebus-vault` and `erebus-disclosure` so an install needs no Rust toolchain, then make the MCP server installable in one command. Keep `uv lock` working.
3. **CI:** a GitHub Actions workflow running the test commands above, including gitleaks, with pinned actions and no secrets.
4. `watcher/`: watches a vault and its agent address. Alerts through the relay's `POST /alerts` when the agent's transaction to the vault reverts, since reverts emit no events, and when daily spend passes a threshold. Tests run on Anvil.

### Codex: next tasks (6 November, after the live Arc run)

Tasks 1 to 4 above are done. Claude 1 keeps everything on Arc and the end-to-end product test. Do not send transactions on Arc.

**A. Arkiv (G4) moved to Claude 1** on 6 November. Codex does not work in `arkiv/`.

**B. Review Arc Studio's contract.** `SECURITY_REVIEW.md` was written against the earlier contract at `84b3288`. Repeat the review on `contracts/evm/src/ErebusPolicyVault.sol` from `1e8156c`, the deployed code. Do not edit it. Add a dated section with file and line, say which earlier findings still apply, and add failing tests where you can. This is not an audit, and Poulav's own review is still owed.

**C. Review Claude 2's work,** as this file already assigns: `setup-page/`, including the code check in `src/build.ts`, `mcp-server/examples/` and `AGENT_INSTALL.md`.

Do not make claims about the entry type (G0). `reach.md` and the README must not say the whole project was built at the event.

### Humans

1. **G0:** enter as Continuity with disclosure, get written confirmation from ETHGlobal, or ship a truly from-scratch repo. Show ETHGlobal the first commit when asking.
2. **G1 to G3:** follow `RUNBOOK.md`.
3. **Telegram:** create a bot with @BotFather, and give Claude 1's relay its token and your chat ID in the relay's environment only. Never commit them.
4. **G4, G5:** Arkiv and World credentials, if time allows.
5. **Submission:** the README, real demo video and partner picks.

## After Mumbai, before real money

- An independent security audit, then a mainnet deployment
- Smart-contract wallets as owners, since the vault supports plain accounts only
- Hosted approval pages, with MetaMask and at least one other real wallet tested
- More chains and tokens
- Agent key management and recovery
- Interviews with teams running stablecoin payments, since demand and pricing are unproven
