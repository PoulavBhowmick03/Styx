# Status

Updated 6 November 2026.

## Deployment

| | |
| --- | --- |
| **Vault** | `0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1` on Arc testnet, chain ID 5042002 |
| **Transaction** | `0x2ee6f85d0dc2b48b9aead4d2da04a3179fb9df2ac5afded5c8a09705727252c7`, block 71050472 |
| **Owner** | `0xC0296012Cfbb0e6DF5dA7158B65Dbc46DD9650e0` |
| **Token** | `0x3600000000000000000000000000000000000000` (USDC) |
| **Arc Studio** | https://studio.arc.io/app/038ffe00-c21d-4804-99f6-90c3d44f5e16 |
| **Build** | solc 0.8.24, optimizer on with 200 runs, EVM target cancun |

Read back from Arc: the transaction succeeded, the owner and token are correct, and the vault is unconfigured and empty. The deployed bytecode matches this repo's source under those build settings, apart from the owner, token and metadata hash. The repo's `foundry.toml` builds with the optimizer off, so its local bytecode differs. Tests of that exact build: our 44 vault tests, 7 end-to-end tests on Anvil, and 10 simulated scenarios against real USDC on Arc. Nothing has been paid on Arc yet.

## Gates

| Gate | Status | Notes |
| --- | --- | --- |
| G0 | **Team says: fresh project, not Continuity. Conflict open, see below** | Arc Studio project: not confirmed |
| G1 | Deployed, not funded or configured | Still needs funding, the 0.25 USDC payment, A1 and A2 |
| G2 | Not run | Needs the 6 USDC exception with a real wallet, A3 and A4 |
| G3 | Not run | Needs the reviewer on a second machine |
| G4 | Not run | Needs tGLM and an Arkiv access key |
| G5 | Not run | Needs a World client |

**Review:** the team reported reviewing an earlier local version of the contract and signing code. The deployed contract comes from Arc Studio (`1e8156c`) and still needs its own human review. Review it before funding the vault with anything that matters.

## Open conflict on G0

The repo as it stands does not match "fresh project":

- Commit `b28d8d6`, the first commit, imports about 62,000 lines of code from the earlier Erebus repo at `d56c777`.
- The vault client, CLI, reviewer and MCP tools are built on that code.
- ETHGlobal's rules for the from-scratch track: "Pre-existing project-specific code, designs, or assets are not allowed."
- Undisclosed pre-existing work or misrepresentation can mean disqualification, revoked prizes and a ban.

Resolve before submitting, by one of:

1. Enter as Continuity and disclose the prior work.
2. Get written confirmation from ETHGlobal that this repo qualifies as entered.
3. Ship a from-scratch repo with none of the imported code. New implementations must be written, not copied.

Until this is resolved, nothing should state that the whole project was built at the event. The video's closing and `README_DRAFT.md` still describe Continuity.

## How the owner is alerted

With the relay running, an over-cap request sends the owner a Telegram alert with a link to the approval page, and the signature goes back to the agent automatically. See `relay/README.md`. This is tested against a fake Telegram server and a local chain. It has not run with a real bot, because that needs a token from @BotFather.

Without the relay, the tool writes a pending file and someone carries it to the owner by hand. An agent that skips the tools sends no alert: the vault still refuses the payment, and the planned watcher covers those attempts.

## How to run G2 and G3

Both need G1's deployed, funded vault. See `RUNBOOK.md` for the exact commands.

**G2:** run `scripts/run_gates.sh`, which pauses and prints a pending file. Load it with the owner config in `owner-page`, sign in the owner's wallet, and save the signature file to the printed path. The script then runs A1 to A3, settles the 6 USDC, and runs A4.

**G3:** on a second machine, the reviewer runs `keygen` and sends their public key. The issuer runs `export_vault_payment` and sends the grant. The reviewer runs `verify_vault_payment` with their own RPC, the issuer address and the vault's code hash, then repeats with a tampered copy and a second record.

## Claude 2 report (Ishita), 6 November 2026

Everything below is merged to `main`. Nothing was deployed to a live network and no funds were spent. All runs used a local Anvil chain.

### Task 1 and 2: setup page (`setup-page/`)

- **Built:** a static page (viem and Vite) where the owner, in their own wallet, deploys or connects a vault, sets limits, allows and removes vendors, funds it by USDC `transfer`, pauses, unpauses and withdraws. It shows the policy version and warns that saving a change invalidates unused approvals. It can download an `owner-config.json` for the approval page.
- **Moving the money:** the page says the vault protects only the USDC inside it. A checklist checks that the vault is funded, the agent is not the owner, the agent's address holds gas only (0.05 to 0.5 USDC, a guideline from `RUNBOOK.md`, not a contract rule) and the vault is not paused. It says how much to move out of the agent's address, but cannot move it, because it never holds the agent's key.
- **Amounts:** text to bigints, never floats. More than 6 decimals is refused, not rounded. Tokens that are not 6-decimal are refused.
- **Tests:** 15 unit tests and 7 headless-Chrome scenarios on Anvil pass, including a wallet rejection, a hostile vendor label shown as text, a non-owner, and a wrong-decimals token. The repo's `MockERC20` has 18 decimals, so the tests set its decimals slot to 6 and no contract was changed.
- **Not verified:** any real wallet (MetaMask or other), and anything on Arc testnet. Connecting to an existing vault compares its code with this checkout's build and flags a difference, but does not block it.

### Task 3: a real model as the agent (`mcp-server/examples/`)

15 runs: 11 of `claude-sonnet-5-5` and 4 of `claude-haiku-5-5`, using only the four vault MCP tools on a fresh chain each time. Details are in `mcp-server/examples/MODEL_TRIAL.md`, and raw reports in `trials/`. Funds reached a stranger in none of them. This does not show prompt-injection prevention.

1. **The vault itself never refused the model.** `erebus_propose_payment` returns `exception_required` for an over-limit payment, so no run called `submit` on one. The runs tested the tool's pre-flight answer, not the contract's revert.
2. **Haiku partly followed an injection.** It submitted with a fake `signature-owner.json` named in the invoice, and the tools refused because the file did not exist. Its report told the owner to create that file and never said the name came from the invoice. Sonnet did not act on injected text in any of 6 hostile runs.
3. **Splitting is allowed by the vault.** Six 1 USDC payments to an allowed vendor fit under a 10 USDC daily limit and settle with no signature. Only the model's restraint stopped it in these runs. The daily limit is the real ceiling on what the agent can pay without a signature.
4. **Models do not know the time.** Haiku guessed `valid_until` wrong and a routine payment failed.

### Task 4: install guide (`docs/mumbai/AGENT_INSTALL.md`)

Followed from a fresh clone. The first payment failed at first, because an agent will not guess the invoice reference or `valid_until`. The guide now supplies both, plus the approval expiry. After that: the allowed payment settled, the 6 USDC payment was refused, the owner signed, it settled, and `cast` showed 6,250,000 base units at the vendor. The test record, with deviations, is in `mcp-server/examples/INSTALL_TEST.md`.

- **Not run:** Part 3 on Arc, any browser wallet, interactive Claude Code, and installing the prerequisites from nothing.
- **Not loaded into the tools:** the Cursor, Claude Desktop and Codex configs follow each tool's docs. Only the Claude Code config was run.

### Review of Claude 1's `relay/` and `owner-page/`

Read from the code, not reproduced. Re-checked against `main` at `3fcaf0b`.

| Finding | Where | State |
| --- | --- | --- |
| No upper bound on `authorizationExpiry`. A compromised agent token can fill all 200 request slots with requests that never expire, and `save()` keeps them across restarts, which blocks approvals | `relay/src/relay.ts:128`, `:173` | **Open** |
| One hourly alert budget is shared by approvals and watcher notices, and is spent before sending. A looping agent or a revert storm can use all 10 slots, so a real request gets `rateLimited` and no alert. A failed Telegram send burns a slot on each retry | `relay/src/relay.ts:135-141`, `:180`, `:241` | **Open.** The watcher now exists, so this matters more |
| The relay address comes from the link and the signature is posted there. Review still checks the owner's config, but a crafted link sends a real signature to an attacker's server. Suggested fix: pin the relay URL in the owner config | `owner-page/src/approval.ts:308`, `owner-page/src/main.ts` (`sendToRelay`) | **Open** |
| The alert's "Limit" came from the agent's file and was shown as fact | `relay/src/relay.ts:190` | Wording fixed ("The agent says the limit is"). `1c17a90` reads the limit from the chain in the owner page. The relay still checks against the claimed limit at `:129` |
| "Signed and sent to your agent" overclaims, since the signature reached the relay only. "Could not be reached" is shown for any non-OK reply, including a 403 | `owner-page/src/main.ts` | Not re-checked |
| The state file is parsed with no shape check, so a malformed file crashes startup | `relay/src/relay.ts:96` | Not re-checked |

Codex's review is in `SECURITY_REVIEW.md`. I did not compare the two.

### Next steps

**For Poulav and Claude 1**
1. Fix the two open relay findings: cap `authorizationExpiry`, and give approvals and watcher notices separate alert budgets. Do not charge a failed send against the budget.
2. Pin the relay URL in the owner config so a link cannot choose where the signature goes.
3. Decide about splitting. Options: lower the daily limit, add a rule in the contract, or tell owners plainly that the daily limit is the real cap. The contract is frozen, so I changed nothing.
4. Add a way for models to learn the current time in `vault.py`, such as a chain-time tool or a default validity window.
5. Tell the owner in the setup and approval pages that the daily limit is the most the agent can pay without a signature.

**For Ishita**
1. Run `AGENT_INSTALL.md` Part 3 on Arc testnet with a real wallet: deploy or connect, set limits, fund, leave the agent gas only, then a first refused and first approved payment. This is needed for G1 and G2. Test USDC is from `https://faucet.circle.com`.
2. Try the Cursor, Claude Desktop and Codex configs in the real apps.
3. Resolve G0 as described above. This report changes nothing about it.

**Reviews still owed**
- Codex reviews Claude 2's work (`setup-page/`, `mcp-server/examples/`, `AGENT_INSTALL.md`), as `REMAINING_WORK.md` assigns.
- Poulav reviews all contract and signing code. The setup page deploys the frozen contract and does not sign.
