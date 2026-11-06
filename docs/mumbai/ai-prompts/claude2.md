# Prompts given to Claude 2

Claude 2 is a Claude Code session working for Ishita (see `docs/mumbai/ai-usage.md`). This file keeps what it was asked, as the plan requires.

- **Briefs 1 to 4, including 3b, are verbatim.** They were pasted into the session as written. Brief 5 was an image and is transcribed.
- **The chat requests are paraphrased.** They are shorter messages typed or spoken by Ishita. They are summarised from the session, not quoted, and the wording is Claude 2's.
- The project's `CLAUDE.md` was also loaded as standing instructions. It is in the repository.

## Brief 1 (verbatim): the first assignment

```
You are Claude 2 on Styx, a vault that enforces payment rules for software agents on Arc testnet.

Repo: https://github.com/PoulavBhowmick03/Styx
Clone it, then read all of these before doing anything else:
- docs/mumbai/REMAINING_WORK.md (your tasks, rules and file ownership)
- docs/mumbai/STATUS.md
- docs/mumbai/BUILD_PLAN.md
- docs/mumbai/RUNBOOK.md

You own only: setup-page/, mcp-server/examples/, docs/mumbai/AGENT_INSTALL.md.
Claude 1 and Codex own other paths, and they are working at the same time. If you need a change elsewhere, write it in your report and don't make it. ErebusPolicyVault.sol is frozen.

Do the "Claude 2" tasks in REMAINING_WORK.md, in order:
1. setup-page: a static page where an owner, in their own wallet, deploys or connects a vault, sets limits, manages vendors, funds it, pauses and withdraws.
2. Make the flow state that the vault only protects what is inside it, and guide the owner to move funds in and leave the agent with gas only.
3. Test a real model as the agent over MCP on a local chain, and report what it actually does when refused and when given hostile invoice text.
4. Write AGENT_INSTALL.md, and test it by following it on a clean setup.

Rules:
- Work on a branch named claude2/<task>. Rebase on main, and merge only when the tests in REMAINING_WORK.md pass. Never force-push main.
- Small commits with conventional messages. Run gitleaks before each commit.
- Never commit keys, tokens, .env files or mnemonics, test keys included. Generate test keys at runtime.
- Do not deploy to a live network, spend funds, or use a sponsor login unless Ishita says so.
- Read official docs before using any API. Never guess endpoints or package exports. Mark assumptions.
- Amounts never pass through JavaScript floats. Native USDC has 18 decimals and ERC-20 USDC has 6, and they are the same balance on Arc.
- Treat agent-written text as untrusted, and render it as text only.
- Claim only what a test or live run shows. Never claim audited, production-ready, regulatory compliance, prompt-injection prevention, private payments, or support for all wallets.
- Do not write that the whole project was built at the event, and do not remove any disclosure. STATUS.md explains why.

You also review Claude 1's commits to relay/ and owner-page/. Report findings with file and line, and don't edit those paths.

After each task, report what you built, the test results, what you could not verify, and anything that needs a human. If something needs a human, record it and move to the next task.
```

## Brief 2 (verbatim): the second assignment

```
Pull main, then read docs/mumbai/REMAINING_WORK.md, section "Claude 2: next tasks", and docs/mumbai/STATUS.md.

Do those tasks in priority order, on branches named claude2/<task>. All the rules in that doc still apply.

The vault is live at 0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1, and Poulav is configuring it now. Test on Anvil only: don't send transactions on Arc, and don't use anyone's keys.

Don't edit contracts/evm/src/ErebusPolicyVault.sol, and don't describe the entry type or prize picks as decided.

After each task, report what you built, the test results, and what you could not verify.
```

## Brief 3 (verbatim): the G3 reviewer

```
You are the reviewer for Styx gate G3, on a machine that has never held any Styx key. Repo: https://github.com/PoulavBhowmick03/Styx. Pull main.

Build only the reviewer tool: (cd sdk/evm && cargo build --bin erebus-disclosure). It reads one JSON request on stdin and writes JSON on stdout. Read docs/mumbai/RUNBOOK.md section 5 and sdk/evm/src/disclosure/cli.rs, and do not guess the fields.

1. Make a new private directory outside the repo. Run {"method":"keygen","key_file":"<dir>/key"}. Give Ishita the public key to send to Poulav. Never share the key file.
2. Poulav sends back two grant files and his issuer address. Save them with mode 0600. Check the issuer against 0x35879a311848b924cce79d788e102de499546a4e, and tell us if it differs.
3. Get the vault's code hash yourself from your own RPC connection, not from anything Poulav sent: cast keccak "$(cast code 0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1 --rpc-url https://rpc.testnet.arc.io)". Compare it with docs/mumbai/STATUS.md and report the result.
4. Run verify_vault_payment on the first grant with chain_id 5042002, your RPC, that vault, that code hash and the issuer. Report all four results. Then run these and report each outcome:
   - a copy of the grant with one byte changed
   - the second grant
   - the first grant with an unreachable RPC, which must read as unavailable and never as unpaid
5. Report exactly what you ran and what it printed, plus the machine (not this repo's owner's Mac) and your RPC. Do not send any transaction. Do not claim G3 passed if any step differed.
```

## Brief 3b (verbatim): Poulav's decision about the second machine

Pasted by Ishita after the G3 brief, from Poulav.

```
Does her Mac count? I think yes. G3 asks for a second machine or clean profile, and the "never held any Styx key" line was stricter wording from my prompt, not the plan's. G3 needs to show three things:
- The reviewer has their own key.
- They use their own RPC.
- They have no access to the issuer's machine or the real vault's keys.

Her Mac meets all three, since none of the real owner, agent or issuer keys have been on it. The throwaway Anvil keys were never funded on Arc and don't affect what this test proves.

I'd record the caveat in STATUS.md instead of redoing the setup: "second Mac with its own key and RPC, but it also holds the repo and some unfunded local test keys." If you want it stricter, she can create a new macOS user and redo the key there, and I'd reissue the first grant for the new key.

Add this to the message you send her:

Poulav's decision: this Mac counts as the second machine. Do not redo step 1. Your report's caveat will be recorded as written, so keep it in your final report. Pull main first: STATUS.md now has the code hash and issuer. Run steps 2 and 4 with the grants attached.
```

## Brief 4 (verbatim): the v1 finish and the v2 plan, 7 November, about 01:05 IST

```
Pull main and read docs/mumbai/REMAINING_WORK.md ("V2 for organizations"). It is about 01:05 IST; submissions close at 09:00, with a go or no-go on the v2 contract at 05:30. v1 stays live and is the fallback.

Now:
1. Rebase and push claude2/submission-prep to main if tests pass, including g3_review.sh and your ai-usage.md. Poulav has not decided on claude2/restore-provenance, so keep holding that branch.
2. G3 is recorded in STATUS.md at 80c59c9 or later. Check the hash and the four results match what you saw, and report any difference.
3. Bring the docs up to the current state, v1 only, describing what exists:
   - docs/mumbai/ARCHITECTURE.md: hosted pages on Vercel, relay on Fly, watcher, Arkiv. The page domain is moving to styxco.xyz, so check with Claude 1's push before writing it.
   - docs/mumbai/DEMO_SCRIPT.md: the alert to approval flow with no file, plus the reviewer checks, Studio, and the Arkiv query. Video comes later, so make it ready to follow.
   - SUBMISSION_README_SECTIONS.md: every claim cites a transaction from STATUS.md or says "not yet". Add the hosted approval and G4. Leave the entry type as a decision for Poulav and do not state it.
4. Have the setup page guide owners through the new no-file approval: connect as owner here, then alerts go straight to review. Claude 1 is changing the approval page, so read its push first.
5. Fill what you can in the TO FILL parts of ai-usage.md. The rest is for humans.
6. Test the Cursor, Claude Desktop and Codex configs only if a real app is available. Otherwise label them not loaded.

Then, once Codex's docs/mumbai/V2_REVIEW.md is on main with the interface, and only if Poulav has not chosen to stop:
7. On branch claude2/v2, build the setup page for organizations: add, limit and switch off agents one at a time; add and remove approvers. Say clearly what each change does. Test on Anvil. Do not merge to main until Poulav says v2 ships. v1's setup flow must keep working.

Rules: no transactions on Arc, no one's keys, nothing in owner-page/, relay/ or contracts/. Run gitleaks before each commit. Claim only what a test shows. Do not state the entry type or when the code was written. Report what ran and what didn't.
```

## Brief 5 (transcribed from a screenshot): the rename, the removal and the v2 wait, 7 November, about 02:40 IST

Ishita sent this as an image. Claude 2 transcribed it, so a typo is possible even though it was copied with care.

```
Pull main. It is about 02:40 IST; submissions close at 09:00. The project is now named Styx everywhere (8399c2c). Claude 1 is about to merge a large removal of unused code: StyxSettlement, StyxShieldedPool, StyxCodec, x402, the relay and chain modules, the coordinator crate and the Metropolis MCP tools. Wait until `git log` on main shows it, then do these in order. Codex is building v2 on codex/v2. v1 stays live and is the fallback.

1. Follow docs/mumbai/AGENT_INSTALL.md from a fresh clone, on a local chain, under the new names (styx-vault, styx-disclosure, STYX_* settings, styx_* tools). Fix the guide wherever it is wrong. Report every deviation. Do this first: nobody has run it since the rename, and it is what a judge would try.

2. Bring the docs in line with the code that now exists: ARCHITECTURE.md, DEMO_SCRIPT.md, RUNBOOK.md, AGENT_INSTALL.md, SUBMISSION_README_SECTIONS.md, mcp-server/examples/configs/ and packaging/README.md. Remove references to anything deleted. In DEMO_SCRIPT.md, add the rogue-agent shot: attack A1 reverts on chain, then the watcher sends an agent_revert notice to Telegram. Label it not yet rehearsed through the hosted relay. Keep, word for word, every sentence stating that code came from an earlier repository. Do not state the entry type or when the code was written.

3. Update the line counts in SUBMISSION_README_SECTIONS.md from git, stating both what the first commit imported and what remains. Every claim must cite a transaction in STATUS.md or say "not yet". Note that G3 and Arkiv are being rerun with reissued grants, because the grant domain string changed, and don't cite those reruns until they are recorded.

4. Fix V2_REVIEW.md finding 5 in mcp-server/examples/vault_agent.py, tests first: hold an exclusive lock on the state for the whole run, and fsync the file and its directory before the first submit. Only you touch this file.

5. Check that mcp-server/examples/INSTALL_TEST.md and MODEL_TRIAL.md are still on main. If they are missing, restore them from history and tell Poulav. STATUS.md cites them.

6. Review Claude 1's removal from outside: does anything on main still reference deleted code? Do the configs load? Does `uv sync --all-packages` work from clean? Report findings. Do not edit relay/, owner-page/ or sdk/.

7. When Poulav sends new grants, rerun mcp-server/examples/g3_review.sh with them on your Mac and report exactly what it prints.

8. When Codex's interface lands on main, build the organization screens in setup-page on branch claude2/v2: add, limit and switch off agents; add and remove approvers. Test on Anvil. Do not merge until Poulav says v2 ships. v1's setup flow must keep working.

Rules: no transactions on Arc, no one's keys, nothing in contracts/ or sdk/evm/. Run gitleaks before each commit, and check that your push actually reached origin. Don't deploy: pushes no longer update the site, and Claude 1 handles deployment. Claim only what a test shows. Report what ran and what didn't.
```

## Ishita's chat requests (paraphrased, in order)

1. Write the report so far into `STATUS.md` so Poulav's agent can read it. Never add Claude as a co-author in commits or pushes: the author should be `ishitab02` only. Include the next steps in `STATUS.md`.
2. Pull the latest `main` and check whether what was added to `STATUS.md` is still applicable.
3. (After the second brief) Keep the Mac awake while working (`caffeinate`).
4. Explain everything done in easy language so that Ishita and Poulav can understand, and add everything said to `STATUS.md` for Poulav's agent.
5. (After the G3 brief) Report the reviewer steps.
6. Look at what Poulav's Claude is doing, and say what else is left and what to do next.
7. Do the things that do not need Poulav, locally only, and do not push to `main`. (This produced the reviewer helper `g3_review.sh`, the faster setup-page test, this file, and the README section drafts.)
8. Look at what Poulav's Claude is doing (a terminal log was pasted), say what else is left and what to do next.
9. The two grants are on the Desktop, use them (this produced the G3 reviewer run reported in `STATUS.md`), followed by Poulav's decision above and Brief 4.
10. Take World out of the documents (Ishita said World is not used), then Brief 5.

## Not here

- Poulav's prompts to Claude 1 and Codex. **TO FILL** by Poulav.
- Whatever Poulav and Ishita said to each other outside this session.
