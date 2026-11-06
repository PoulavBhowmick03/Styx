# AI usage

`BUILD_PLAN.md` (section 0) requires a record of which files AI tools wrote or helped with, with the prompts. The README must carry the same disclosure (section 14). This is that record.

**Who wrote this and how far it can be trusted.** It was written on 6 November 2026 by Claude 2, a Claude Code session working for Ishita. It is complete and checked against git for Claude 2's own work. For the rest of the project it repeats what the team's own documents say and leaves **TO FILL** where only a person knows the answer. Nothing marked TO FILL has been guessed.

## Summary

| Who or what | Role | Where the evidence is |
| --- | --- | --- |
| **Claude 2**: Claude Code (version 2.1.319 when checked on 6 November), model `claude-sonnet-5-5` as the tool reported it, working for Ishita | Wrote and tested the setup page, the example agent tooling, and several documents. Reviewed other agents' code read-only | git history (`git log --author=ishitab02`, 24 commits) and the file list below |
| **Claude 1**: an AI agent working for Poulav | Relay, approval page, the vault MCP tools, Arkiv, the live Arc product run | `REMAINING_WORK.md`, "Who does what". **TO FILL** by Poulav |
| **Codex**: an AI agent working for Poulav | Packaging, CI, the watcher, `SECURITY_REVIEW.md`, bug fixes in `sdk/evm/src/arc_vault/` | `REMAINING_WORK.md`, "Who does what". **TO FILL** by Poulav |
| **Arc Studio**: Arc's tool | The deployed `ErebusPolicyVault.sol` (`1e8156c`, 6 November 21:02), which `STATUS.md` says comes from Studio. It replaced a local version written earlier that day (`26ac813`, 10:23) | `STATUS.md`, "Deployment", and git history. `BUILD_PLAN.md`, section 5, describes Studio as driven by prompts (`arc-studio run "<prompt>"`) and says the vault would be written in Studio, either by prompting it with section 4 of the plan or in its editor. **TO FILL**: which of those was done, the prompt, and any hand edits. Who or what wrote the local version `26ac813` |
| **`BUILD_PLAN.md`** | The plan every other file follows | Its own first paragraph says it "starts from GPT's `Erebus_Implementation_Roadmap.docx`" and makes six changes to it, so an AI wrote the roadmap it grew from. **TO FILL**: who or what wrote the plan itself |
| **`CLAUDE.md`**, in the repository since the first commit | Standing instructions for Claude Code, read by every Claude Code session here | Evidence that Claude Code was used in this repository, by more than Claude 2. **TO FILL**: by whom and for what |
| **The earlier Erebus code** imported in the first commit (`b28d8d6`, from `d56c777`, about 62,000 lines) | Pre-existing | `STATUS.md`, "Open conflict on G0". **TO FILL**: how it was written, whether AI helped, and by whom. This matters for the entry type |
| **Humans** | Direction, accounts, keys, funds, the MetaMask signatures, every real-wallet and Telegram step, and the decisions that are theirs (entry type, prize picks) | |

## Claude 2

**Tools.** Claude Code on Ishita's Mac: it read and edited files, ran shell commands and tests, fetched documentation pages, and made read-only calls to Arc's public RPC. It sent no transaction to Arc. It held no owner, agent or issuer key for the live vault. It generated two keys of its own: throwaway test keys on local chains, and the reviewer key for G3 (public key `342d97ba...9127`, private key in a private folder on Ishita's Mac). Everything it signed or sent ran on a local Anvil chain.

**Models used as test subjects, not as authors.** `mcp-server/examples/MODEL_TRIAL.md` records 15 runs in which `claude-sonnet-5-5` and `claude-haiku-5-5` acted as the vault's agent on a local chain. Their output is data in `trials/`. They wrote none of the repository's code.

**Files Claude 2 wrote** (all of these are AI-written, directed by Ishita):

| Path | What |
| --- | --- |
| `setup-page/` (all of it: `index.html`, `src/*.ts`, `scripts/`, `test/`, `README.md`, build config) | The owner's setup page and its tests. Poulav later edited it once (`301e2c3`) |
| `mcp-server/examples/model_trial.py`, `local_vault.py`, `g3_review.sh`, `test_vault_agent.py` | The model trial harness, the local rehearsal vault, the reviewer's G3 helper, and the restart tests |
| `mcp-server/examples/configs/` | MCP configs for four agents |
| `mcp-server/examples/MODEL_TRIAL.md`, `INSTALL_TEST.md`, `trials/` | Trial and install-test records, and the raw run reports |
| `docs/mumbai/AGENT_INSTALL.md`, `ARCHITECTURE.md`, `DEMO_SCRIPT.md`, `SUBMISSION_README_SECTIONS.md`, `ai-usage.md`, `ai-prompts/claude2.md` | Guides, plans and this record |
| `docs/mumbai/STATUS.md` | The "Claude 2 report" sections only |
| `PROVENANCE.md` on the unpushed branch `claude2/restore-provenance` | Not written: copied verbatim from the first commit, where it already existed, so the file's content is the team's own |

**Files Claude 2 changed but did not create:** `mcp-server/examples/vault_agent.py`. Poulav's side wrote it (`9e067e4`). Claude 2 changed how it restarts (`46406d8`).

**Read, not written:** Claude 2 reviewed Claude 1's `relay/` and `owner-page/` and reported findings. It edited neither. It did not review the contract, and that review is a person's.

**How this appears in git.** 30 commits are authored `ishitab02`, counting unpushed branches on 7 November 2026. The seven earliest (`02b7fad`, `218e18c`, `4c23fd7`, `6b01b61`, `ca08a71`, `eda32c5`, `f22a809`) end with `Co-Authored-By: Claude Sonnet 5.5`. Later commits omit that line because Ishita asked for it to be left out. The omission does not mean the later work was not AI-written: every one of those commits is Claude 2's work, and this file is the record.

**What a human checked.** **TO FILL** by Ishita: which of these files she read line by line, and which she only ran. Claude 2 cannot know. What is known: Poulav reviewed the contract and signing code per `STATUS.md`, which is the team's own review. Claude 2's own checks were tests: 37 unit tests and 26 browser scenarios for the setup page, 7 tests for the example agent, and runs against a local chain and the live Arc RPC, read-only. Ishita ran the second-machine reviewer step on her Mac with Claude 2, and Poulav decided that Mac counts as the second machine.

**Known limits.** None of the setup-page changes after the first real-wallet run has been tried with a real wallet. None of it is audited.

## Claude 1, Codex and the rest

These are the team's own records, from `REMAINING_WORK.md`. Each owner should correct them.

| Paths | Owner per `REMAINING_WORK.md` | TO FILL by Poulav |
| --- | --- | --- |
| `relay/`, `owner-page/`, `arkiv/`, `mcp-server/src/erebus_mcp/vault.py`, `sdk/py/src/erebus/_vault.py`, `mcp-server/tests/test_vault*.py` | Claude 1 | Which tool and model; what was hand-written; what was reviewed |
| `packaging/`, `.github/`, `watcher/`, `docs/mumbai/SECURITY_REVIEW.md`, `sdk/evm/src/arc_vault/` | Codex | The same |
| `contracts/evm/src/ErebusPolicyVault.sol` | Arc Studio, per `STATUS.md` | The Studio prompt, the model if it is shown, and any hand edits |
| `sdk/evm/src/arc_vault/` (first version), the earlier local contract, `BUILD_PLAN.md` | Not stated anywhere in the repo | Who or what wrote them |
| The 62,000 imported lines | Pre-existing | How they were written |

**Review.** `CLAUDE.md` says Poulav reviews every line of contract and signing code. `STATUS.md` records that the team reported reviewing the contract and signing code. That is the team's own review, not an audit, and nothing here calls it one.

## Prompts

The briefs Claude 2 was given, and Ishita's requests, are in `docs/mumbai/ai-prompts/claude2.md`. The other agents' prompts are **TO FILL** by Poulav, in the same folder.

## What this record does not say

It does not say the project is audited, that every line was read by a person, or how the earlier Erebus code was written. It says only what the git history and the team's own documents show.
