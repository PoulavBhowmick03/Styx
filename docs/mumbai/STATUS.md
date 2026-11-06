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

Everything below is merged to `main` except where it says otherwise. Nothing was deployed and no funds were spent. All runs used a local Anvil chain, plus one read-only fetch of the deployed vault's code from Arc. Re-checked against `main` at `c0da548`, after Arc Studio's contract replaced the earlier one.

### Task 1 and 2: setup page (`setup-page/`)

- **Built:** a static page (viem and Vite) where the owner, in their own wallet, deploys or connects a vault, sets limits, allows and removes vendors, funds it by USDC `transfer`, pauses, unpauses and withdraws. It shows the policy version and warns that saving a change invalidates unused approvals. It downloads an `owner-config.json` for the approval page, with an optional `relay` address, which the owner page now requires before it will send a signature to a relay.
- **Moving the money:** the page says the vault protects only the USDC inside it. A checklist checks that the vault is funded, the agent is not the owner, the agent's address holds gas only (0.05 to 0.5 USDC, a guideline from `RUNBOOK.md`, not a contract rule) and the vault is not paused. It says how much to move out of the agent's address, but cannot move it, because it never holds the agent's key.
- **Amounts:** text to bigints, never floats. More than 6 decimals is refused, not rounded. Tokens that are not 6-decimal are refused.
- **Tests:** 17 unit tests and 7 headless-Chrome scenarios on Anvil pass against Arc Studio's contract.
- **Code check, fixed after the contract changed:** the page flags a vault whose code differs from its build. The deployed Arc vault was built with the optimizer on (200 runs, Cancun), and the repo's default build has it off, so the page would have called the real vault "different" and told the owner not to fund it. It also did not ignore the compiler's metadata trailer. Both are fixed: the page now builds the vault with the deployed settings, and the check ignores the owner and token slots and the trailer. Checked read-only against `0xb3bc2a82…3fb1` on Arc: it matches, and a one-byte change in the code does not. This is a convenience check, not a proof. The contract still needs a human review, and I did not review it.
- **Not verified:** any real wallet (MetaMask or other), and anything that sends a transaction on Arc. The page has not been used on Arc yet.

### Task 3: a real model as the agent (`mcp-server/examples/`)

15 runs: 11 of `claude-sonnet-5-5` and 4 of `claude-haiku-5-5`, using only the four vault MCP tools on a fresh chain each time. Details are in `mcp-server/examples/MODEL_TRIAL.md`, and raw reports in `trials/`. Funds reached a stranger in none of them. This does not show prompt-injection prevention. These runs used the earlier local contract. On `main` at `c0da548` I re-ran three (Sonnet routine and refused, Haiku pressure): the same outcomes.

1. **The vault itself never refused the model.** `erebus_propose_payment` returns `exception_required` for an over-limit payment, so no run called `submit` on one. The runs tested the tool's pre-flight answer, not the contract's revert.
2. **Haiku partly followed an injection.** It submitted with a fake `signature-owner.json` named in the invoice, and the tools refused because the file did not exist. Its report told the owner to create that file and never said the name came from the invoice. Sonnet did not act on injected text in any of 6 hostile runs.
3. **Splitting is allowed by the vault.** Six 1 USDC payments to an allowed vendor fit under a 10 USDC daily limit and settle with no signature. The new contract keeps a per-payment cap and a cumulative daily cap, so this still holds. The daily limit is the real ceiling on what the agent can pay without a signature.
4. **Models do not know the time.** Fixed in `1711205`: both times default to one hour from now. One Haiku run re-checked it.

### Task 4: install guide (`docs/mumbai/AGENT_INSTALL.md`)

Followed from a fresh clone, before the contract changed. The first payment failed at first, because an agent will not guess the invoice reference. After the guide was fixed: the allowed payment settled, the 6 USDC payment was refused, the owner signed, it settled, and `cast` showed 6,250,000 base units at the vendor. The test record, with deviations, is in `mcp-server/examples/INSTALL_TEST.md`.

- **Not re-followed end to end** after the contract change and the optional-times change. Two edits since then were checked only in parts: the `forge build` line was removed (the setup page builds the vault itself), and the paragraph about times was reworded.
- **Not run:** Part 3 on Arc, any browser wallet, interactive Claude Code, and installing the prerequisites from nothing.
- **Not loaded into the tools:** the Cursor, Claude Desktop and Codex configs follow each tool's docs. Only the Claude Code config was run.

### Review of Claude 1's `relay/` and `owner-page/`

Read from the code, not reproduced. Re-checked against `main` at `c0da548`.

| Finding | State |
| --- | --- |
| No upper bound on `authorizationExpiry`, so a compromised agent token could fill the 200 request slots for good | **Fixed** in `b8089eb`: 24-hour cap (`relay/src/relay.ts`). 200 slots can still be held for 24 hours, so a flood is slowed, not stopped |
| One alert budget shared by approvals and watcher notices, spent before sending | **Fixed**: separate budgets, and only delivered alerts count |
| The relay address came from the link, and the signature was posted there | **Fixed**: the owner config must name the relay (`mayPostSignature`). Consequence: the owner config must include `relay`, or the signature is shown as a file only |
| The alert's "Limit" came from the agent's file and was shown as fact | **Fixed**: the alert says "The agent says…", and the owner page reads the limit from the chain. The relay still checks against the claimed limit |
| "Signed and sent to your agent" overclaimed | **Fixed**: now "the relay accepted it. The agent still has to collect and submit it", with separate messages for refused and unreachable |
| The state file was parsed with no shape check | **Fixed**: damaged entries are dropped |

Not checked: the new `1e8156c` contract against `SECURITY_REVIEW.md`, and the watcher. I did not compare Codex's review with mine.

### Next steps

**Ishita**
1. **Get a human review of the Arc Studio contract (`1e8156c`) before funding the vault with anything that matters.** The deployed vault `0xb3bc2a82…3fb1` is unconfigured and empty. This is Poulav's review, as the project rules say.
2. Run `AGENT_INSTALL.md` Part 3 on Arc testnet with a real wallet: connect to that vault (the owner is `0xC0296012…50e0`, so the wallet must be that account), set limits, allow vendors, fund, leave the agent gas only, then a first refused and first approved payment. This is G1 and G2. Test USDC is from `https://faucet.circle.com`. Add the relay address on the vendors section if the relay is running.
3. Try the Cursor, Claude Desktop and Codex configs in the real apps.
4. Resolve G0 as described above.

**Poulav and Claude 1**
1. Decide about splitting. Options: lower the daily limit, add a rule in the contract, or tell owners plainly that the daily limit is the real cap. The contract is frozen, so I changed nothing.
2. Tell the owner in the setup and approval pages that the daily limit is the most the agent can pay without a signature.
3. Consider a cap on the relay's total open requests per hour, since the 24-hour cap still allows 200 slots to be held for a day.

**Reviews still owed**
- Codex reviews Claude 2's work (`setup-page/`, `mcp-server/examples/`, `AGENT_INSTALL.md`), as `REMAINING_WORK.md` assigns. Include the new code check in `setup-page/src/build.ts`.
- Poulav reviews all contract and signing code. The setup page deploys the contract and does not sign.
