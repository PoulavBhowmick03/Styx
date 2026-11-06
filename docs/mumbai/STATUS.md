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

A second vault, `0x392B9B12054C0E4E900752d63a77e1591aBBe234`, was deployed by mistake through the setup page and holds 50 USDC. The owner can withdraw it. It is not the demo vault, and it is not a Studio deployment.

## Live run on Arc testnet

Each is a real transaction on the deployed vault, with its receipt read back from Arc.

| Step | Result | Transaction |
| --- | --- | --- |
| 0.25 USDC routine payment | Settled | `0x41cf57420722e3492f50a0552b23b3047ec8f322385c003d9c489a59be61b58f` |
| A1: agent pays 6 USDC directly | Reverted | `0xeb8612da5b68338c6eb81212ebc8fbee9a5d7059f0f1cd0c4f49b23fc688167d` |
| A2: agent signs the exception itself | Reverted | `0x31f8f4ca516eb8218ca9417aac1610ae4c3322fd299490a338ee5b848def57bc` |
| A3: owner's signature on a payment to vendor B | Reverted | `0xd6043ce2a4090e059127c342d42a1cf715f085f39a2906a36a22284181fb2e3b` |
| 6 USDC exception, signed by the owner in MetaMask | Settled | `0x32cc0ccc5092830eaaa0796a8d964b9453cf52a4eeb2a13138ff4bda0dd982f2` |
| A4: the settled exception resubmitted | Reverted | `0x1c1cb3dc8d91db63bc877db30cd1977a174299bd4d3c59122af8b6e893745574` |

Balances after: vault 53.75 USDC, vendor A 6.25 USDC, vendor B 0. A1 to A3 were also sent again in reruns, and those reverted too.

The reviewer, on this same machine, verified all four results for the record, refused a tampered copy and a record sealed to someone else, and reported "unavailable" with its RPC unreachable. That is not yet G3, which needs a second machine.

Not shown by this run: an audit, any wallet besides MetaMask, or the reasons for the reverts from the receipts. The revert reason for A4 was confirmed separately by simulation: `PaymentAlreadyUsed`.

## Live product run on Arc testnet

The agent side used only the real MCP server over stdio, with a real relay, a real Telegram bot and the owner's MetaMask.

| Step | Result | Evidence |
| --- | --- | --- |
| Agent proposes 2 USDC, over the 1 USDC limit | Tool answers `exception_required` | |
| Agent asks for approval | Relay reports the alert delivered; owner received it in Telegram and opened its link | |
| Owner signs in MetaMask, config without `relay` | Page signs but refuses to post the signature | See below |
| Tampered copy of the signature posted to the relay | 403 | |
| Real signature posted to the relay, by hand | Accepted; `erebus_check_owner_approval` returned it | |
| Agent submits through the tool | Settled | `0xbfaf884fd68aa72d4043a8bdf812c55f41bcda7c92c5d42788b4a90818fc1450` |
| Settled exception resubmitted directly | Reverted | `0xaa17d6c6aeab1d2816093a824c84468a2a0a6e08d3a0d18a0d620e94075cf45d` |
| 0.25 USDC routine payment through the tools | Settled | `0x5ed2e5e078b7c2d419037963471df405c031c43c95bbcc84eb6e99de6535f455` |
| Payment to a recipient not on the allowlist | Tool refuses, `POLICY_LIMIT` | |
| 5 USDC, over what is left of the daily limit | Tool refuses, `POLICY_LIMIT`: "no approval can lift" | |
| Watcher, threshold 8 USDC | Relay accepted its notices; no unresolved transactions | Telegram delivery of these to be confirmed by the owner |

**Not shown yet:** the page posting a signature to the relay by itself on Arc (that path has only run on a local chain), and opening the link on a phone.

**What this run found, all fixed:**

- Arc's RPC answers 403 to Python's default User-Agent, which stopped the watcher completely. Its tests used a local chain and could not see this.
- The watcher made 3 requests per block, and Arc produces about 2 blocks a second, so it could never catch up. It now reads blocks in batches.
- An owner config saved before the relay existed makes the page refuse to post the signature, correctly, but it only said so after signing. It now warns first.

The Blockdaemon RPC returned a string JSON-RPC `id` and, to `cast`, undecodable bytes when tested. Use the primary RPC for the watcher.

## Gates

| Gate | Status | Notes |
| --- | --- | --- |
| G0 | **Team says: fresh project, not Continuity. Conflict open, see below** | Arc Studio project: not confirmed |
| G1 | **Passed on Arc testnet** | See "Live run" below |
| G2 | **Passed on Arc testnet** | Signed in MetaMask. See "Live run" below |
| G3 | Passed on one machine, not yet on a second | The gate needs a second machine or clean profile with its own RPC |
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

With the relay running, an over-cap request sends the owner a Telegram alert with a link to the approval page, and the signature goes back to the agent automatically. See `relay/README.md`. This has run on Arc with a real bot; see "Live product run". The page and relay ran on the owner's Mac, so the link does not open on a phone yet.

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
- **Not verified:** any real wallet (MetaMask or other), and anything that sends a transaction on Arc. An owner used an earlier version with MetaMask on Arc, and round 2 below covers what that found.

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

The next steps for this round are at the end of the round 2 report below.

## Claude 2 report, round 2 (Ishita), 6 November 2026

The seven tasks from `REMAINING_WORK.md`, "Claude 2: next tasks". All are merged to `main`. I sent no transaction to Arc, used no one's keys, and did not touch `ErebusPolicyVault.sol`. All tests ran on Anvil. I made read-only calls to Arc's public RPC (block number, code, logs) to check the page's code against the live vault. Nothing here says anything about the entry type or the prize picks.

### 1. The connected vault is unmistakable (`setup-page/`)

- A banner at the top always shows the full vault address, its owner, and "You are the owner" or "You are NOT the owner".
- Every action's status names the vault (`Save limits on vault 0xb3bc...3fb1: ...`).
- Deploying needs a second click. If a vault is already connected or remembered, it says "You already have a vault... this creates a SECOND, separate vault". Cancelling sends nothing.
- `?vault=0x...` opens a specific vault, but only after the wallet connects, and says it came from the link. The address bar updates when you switch.
- Vaults switch without a reload. Switching clears the agent address, vendor fields, amounts and every pending review, so nothing typed for one vault can be saved on another. The page also ignores a stale answer from the vault you just left.
- Funding is now review-then-confirm and names the full vault address. It always uses the vault's own token, not an editable field.
- **A new risk from `?vault=`:** a link can name any contract. So funding is switched off for a vault whose code differs from the build, until the owner clicks an unlock that lasts only until they switch vaults.
- **Tests:** 5 new browser scenarios. **Not verified:** none of this has been tried with a real wallet.

### 2. Plain sends to the vault revert

The warning sits next to the vault address and in the funding section. It says a wallet's Send button may be exactly that kind of transfer on Arc, since USDC is also the native coin. The test checks the claim on Anvil: a native send to the vault fails and changes nothing, and the token `transfer` the page uses works. **Not verified:** what MetaMask's Send does on Arc. That comes from the owner's report.

### 3. Vendors on Arc

- **Arc's documented limit:** `eth_getLogs` is capped at 10,000 blocks per call (`-32012`), so the page reads in chunks of at most 9,999 blocks, newest first.
- **A limit I found by testing the live endpoint, not in its docs:** it rate-limits (HTTP 429, `-32005`). 27 quick calls succeeded and then it refused, and the budget had not refilled four seconds later. That would have broken more than the vendor list.
- **So:** every read now waits and retries (and says so on screen) on `-32005` and the documented `-32014`. Writes are never retried, because a retried send could pay twice.
- **Finding the start:** the page remembers a vault's creation block. Otherwise it checks a hint on-chain with two lookups (`?created=<block>`, or the known live vault), and otherwise searches old state outward from the newest block.
- **Later refreshes** read only new blocks.
- **If an RPC cannot answer old state,** the page reads the most recent ~120,000 blocks and says "Partial list... a vendor allowed earlier may be missing. Use Check address".
- **A bug this found:** viem caches the block number for a few seconds, which hid a vendor allowed a moment earlier. Fixed.
- **Live, read-only:** against the real vault, the known hint verified in 3 requests, one scan found its 4 `RecipientSet` events, and the search with no hint found block 71050472 in 16 requests (6.3 s) with no rate-limit waits.
- **Tests:** 20 unit tests for the paging, retry and search logic, and browser scenarios covering the 10,000-block limit, `-32014`, rate limits, hints, incremental reads, and the no-history fallback.
- **Not verified:** other RPC providers (Blockdaemon, dRPC, QuickNode), or whether they keep old state.

### 4. What the daily limit means

The setup page says the daily limit is the most the agent can pay in a day without a signature, and that the per-payment limit does not stop splitting. Wording only. The test proves it on the contract: six 1 USDC payments settled with no signature, one 6 USDC payment was refused, and the daily limit stopped the 11th.

### 5. `vault_agent.py` restarts

The review's finding was real. Rerunning the script after `unknown` minted a second payment ID. I wrote 7 tests against the real `Agent` class first, and all failed. Now each ID is written to a private state file before its first submit. A rerun looks up each kept ID on the chain, retries an unsettled one under the same ID, and proposes nothing while the chain cannot be read. An unreadable state file stops the run. On a real local vault the second run made 0 proposals and nothing was paid twice.

- **Not verified:** the case where an `unknown` payment lands later, on a real chain. The tests fake that.
- **CI gap:** the tests live in `mcp-server/examples/` because I may not edit `mcp-server/tests/`. CI's test paths do not collect them yet. Run `uv run pytest mcp-server/examples`.
- Also fixed: `local_vault.py` did not stop on Ctrl-C when started from a background shell.

### 6. `docs/mumbai/ARCHITECTURE.md`

Two Mermaid diagrams (the parts, and an ordinary payment against an exception), a table of what each part holds and is trusted for, and what is on-chain, off-chain, public and encrypted. Each part says what has actually been run. Both diagrams rendered in Chrome with Mermaid 11.4.1. I did not check GitHub's own renderer.

### 7. `docs/mumbai/DEMO_SCRIPT.md`

A 3 minute 45 second shot list around `scripts/run_gates.sh` that shows Arc Studio. Each shot says what has run on Arc and what has not. The local rehearsal of the script took 6.4 seconds on Anvil; Arc timing is not measured. The closing line is left open, because the entry type is not decided.

### What needs a human

1. **A real-wallet retry of the setup page on Arc.** Everything in tasks 1 to 4 is tested on a local chain only. Connect to `0xb3bc...3fb1`. Do not deploy.
2. **A human review of the Arc Studio contract (`1e8156c`).** I did not review it.
3. **G3 on a second machine,** and the reviewer shot in the demo.
4. **Check the Studio URL opens for a logged-out viewer.** I could not.
5. **The Arc booth question** (do pages outside Studio meet "connect them to a web or mobile app without leaving Studio"?) and the World question (does OIDC step-up count as Agent Pass?).
6. **Try the Cursor, Claude Desktop and Codex configs** in the real apps. Only Claude Code's was run.
7. **G0.**

### Next steps by owner of the work

**Poulav and Claude 1**
1. Decide about splitting. The setup page now says the daily limit is the real cap. The approval page does not say it yet.
2. Optional: cap the relay's open requests per hour. The 24-hour cap still lets 200 be held for a day.

**Codex**
1. Add `mcp-server/examples` to the pytest test paths and CI.
2. Review Claude 2's work, including `setup-page/src/logs.ts`, `setup-page/src/build.ts` and `mcp-server/examples/vault_agent.py`.
3. Check the watcher against Arc's public rate limit. I saw 429s after about 27 quick requests, and the watcher reads historical state. I did not test the watcher.

### Round 2 in plain words (for Ishita, Poulav and anyone reading quickly)

**What was wrong, and what I did about it**

1. **An owner ended up working on the wrong vault.** The setup page now shows, at the top of the screen at all times, which vault every button acts on and whether you own it. Deploying a new vault now asks "are you sure?" and warns if you already have one. You can open a specific vault from a link (`?vault=0x...`) and switch between vaults without reloading. Switching wipes whatever you had typed, so nothing meant for one vault can be saved on another.
2. **An owner lost gas sending money straight to the vault.** The vault cannot receive a normal transfer. The page now says so next to the vault address and in the funding section, and tells owners to use the "Move into vault" button instead.
3. **The vendor list said "Could not list vendors" on Arc.** Arc's public server refuses to return more than 10,000 blocks of history at once, and it also cuts you off if you ask too fast. The page now asks in small pieces, waits and tries again when it is told to slow down, and says clearly when a list is only partial. Checking an address always works.
4. **Owners may think the per-payment limit caps an invoice. It does not.** The page now says the daily limit is the most the agent can pay in a day without a signature, because six small payments each stay under the per-payment limit. We proved this on the contract: six 1 USDC payments went through with no signature, and the daily limit stopped the 11th. This is wording only. The contract was not changed.
5. **The example agent could pay twice after a restart.** If it crashed or timed out and was started again, it made a brand-new payment instead of checking the old one. It now saves each payment's ID before sending and checks the old one first after a restart.
6. **Two documents Arc's prizes need:** `ARCHITECTURE.md` (diagrams and who is trusted with what) and `DEMO_SCRIPT.md` (a shot list for the video, with each step marked as run or not yet run on Arc).

**One new safety rule I added.** A link can now name any contract, so the page switches off funding for a vault whose code differs from the build the page knows. The owner can unlock it on purpose.

**What I could not check**
- None of the setup-page changes has been tried with a real wallet. They were tested in a browser against a local test chain only.
- I tested only Arc's main public server, not the other providers.
- I could not check that the Arc Studio link opens for someone who is not logged in.
- The "payment lands later after an unknown result" case was tested with a fake, not on a real chain.
- I did not review the Arc Studio contract. That review is a person's job.

**What people need to do**

| Who | What |
| --- | --- |
| Ishita | Try the setup page on Arc with a real wallet. Connect to `0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1` and do not deploy. Check the Studio link when logged out. Run the reviewer on a second machine (G3). Ask the two Arc booth questions. Try the Cursor, Claude Desktop and Codex configs |
| Poulav | Review the Arc Studio contract. Decide about the splitting loophole. Decide G0 and the prize picks. Add the daily-limit wording to the approval page if you agree with it |
| Claude 1 | Optional: cap how many open requests the relay allows per hour |
| Codex | Add `mcp-server/examples` to the test paths and CI. Review my work. Check the watcher against Arc's rate limit |

**Housekeeping:** every commit in this round is authored by ishitab02 with no co-author line. No keys, tokens or `.env` files were committed.
