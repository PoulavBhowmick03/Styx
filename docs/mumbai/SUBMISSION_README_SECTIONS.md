# Submission README: draft sections

**A draft for Poulav.** `README.md` is Poulav's, and nothing here has been merged into it. The sections follow `BUILD_PLAN.md`, section 14. Every number and hash was read from git or `STATUS.md` on 6 November 2026, and the commands to check them are in the notes at the end.

Anything marked **[DECISION]** is for the humans. The entry type (G0) and the partner picks are not decided in this file, and nothing in it says they are. Do not write that the whole project was built at the event.

---

## What Styx is

A funded vault on Arc testnet pays an agent's routine invoices within the owner's rules, needs the owner's signature over the exact payment before it allows an exception, and gives a reviewer one sealed record they can check against the chain. The owner sets the rules and signs exceptions from their own wallet. The agent holds a gas-only key and can only propose and submit payments the vault allows.

Testnet and test funds only. Not audited.

## What existed before, and what was added here

**[DECISION: the entry type.]** Whatever it is, this section must keep the disclosure below. It must not say the whole project was built at the event.

**What was already there.** The first commit in this repository (`b28d8d6`, 6 November 2026) contains about 63,500 lines of code (excluding lock files). Its own `PROVENANCE.md` said that this code was imported from the earlier Erebus repository, `https://github.com/PoulavBhowmick03/Erebus`, at commit `d56c777036701138b535c22fb32f320e5c351979` (dated 23 October 2026), by `git archive` with no history, and that it predates ETHGlobal Mumbai. The imported paths it listed:

`sdk/core`, `sdk/journal`, `sdk/coordinator`, `sdk/transport`, `sdk/evm`, `sdk/py`, `mcp-server`, `contracts/evm`, `LICENSE`, `.gitignore`, `.gitleaks.toml`.

The first commit also holds files that did **not** come from that source, written for this build: `docs/mumbai/BUILD_PLAN.md`, `PROVENANCE.md`, `pyproject.toml`, `uv.lock`, `packaging/erebus-cli/pyproject.toml`, `.env.example`, `CLAUDE.md` and `README.md`. Before the import, test keys were removed from some imported tests (the old `PROVENANCE.md` lists each edit).

**What was added after the first commit** (new files only, excluding lock files and generated trial records; 15,667 lines in 111 files):

| Area | New lines | New files |
| --- | --- | --- |
| `sdk/evm` (the `arc_vault` module and the `erebus-vault` CLI) | 3,652 | 16 |
| `owner-page` (the approval page) | 2,526 | 13 |
| `setup-page` (the owner's setup page) | 2,391 | 17 |
| `contracts/evm` (the vault contract and its tests) | 1,432 | 5 |
| `docs/mumbai` | 1,053 | 7 |
| `mcp-server/examples` | 1,025 | 11 |
| `relay` | 846 | 8 |
| `mcp-server/tests` | 703 | 3 |
| `watcher` | 684 | 3 |
| `arkiv` | 433 | 12 |
| Everything else (scripts, packaging, CI, small files) | 922 | 16 |

Existing files were also changed: 22 files, 566 lines added and 100 removed. They include the disclosure code in `sdk/evm`, `sdk/transport` and `sdk/py`, and the MCP server.

The vault contract was produced with Arc Studio (see below). **[DECISION or TO FILL: what that means for the entry, and how the imported code was written. See `ai-usage.md`.]**

## Provenance and where to look

| | |
| --- | --- |
| Vault | [`0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1`](https://explorer.testnet.arc.io/address/0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1) on Arc testnet, chain ID 5042002 |
| Deployment | [`0x2ee6f85d0dc2b48b9aead4d2da04a3179fb9df2ac5afded5c8a09705727252c7`](https://explorer.testnet.arc.io/tx/0x2ee6f85d0dc2b48b9aead4d2da04a3179fb9df2ac5afded5c8a09705727252c7), block 71050472 |
| Owner | `0xC0296012Cfbb0e6DF5dA7158B65Dbc46DD9650e0` |
| Token | `0x3600000000000000000000000000000000000000` (USDC, 6 decimals through its ERC-20 interface) |
| Arc Studio | https://studio.arc.io/app/038ffe00-c21d-4804-99f6-90c3d44f5e16 **[check it opens when logged out]** |
| Build | solc 0.8.24, optimizer on with 200 runs, EVM target cancun |
| Contract source | `contracts/evm/src/ErebusPolicyVault.sol`, from commit `1e8156c` |

## Roles and trust boundaries

| Role | Holds | Can | Cannot |
| --- | --- | --- | --- |
| Owner | The owner key, in their own wallet | Set policy, allow vendors, sign exceptions, pause, withdraw | Nothing withheld |
| Agent | A gas-only key and the MCP tools | Propose and submit payments the vault allows | Change policy, sign an exception, or withdraw |
| Reviewer | Their own key and RPC | Open one sealed record and verify it against Arc | Read any other record |

The vault enforces every rule itself. The tools, the relay and the pages can refuse, delay or mislead, but none of them can make a payment the vault would refuse. The relay holds no keys. The owner must be a plain account. See `docs/mumbai/ARCHITECTURE.md` for the diagram and what each part is trusted for.

## What is public and what is encrypted

Public on Arc: the vault, its policy and allowlist, and every payment's amount, recipient and time, with the limits that were enforced, the policy version and the owner's approval digest. A hash commits to the invoice without showing it.

Encrypted: the invoice itself and the approval record, in one sealed record that only one reviewer's key opens. **Payments are not private.**

## Claims ledger

Each claim is here only with the evidence that exists. A claim with no evidence yet is marked so.

| Claim | Evidence | Status |
| --- | --- | --- |
| The vault blocks unauthorized agent payments | A1 [`0xeb8612da...`](https://explorer.testnet.arc.io/tx/0xeb8612da5b68338c6eb81212ebc8fbee9a5d7059f0f1cd0c4f49b23fc688167d) and A2 [`0x31f8f4ca...`](https://explorer.testnet.arc.io/tx/0x31f8f4ca516eb8218ca9417aac1610ae4c3322fd299490a338ee5b848def57bc) reverted on Arc. The contract tests (44 vault tests, per `STATUS.md`) | Shown |
| An approval binds the exact payment | A3 [`0xd6043ce2...`](https://explorer.testnet.arc.io/tx/0xd6043ce2a4090e059127c342d42a1cf715f085f39a2906a36a22284181fb2e3b): a signature for one vendor, submitted for another, reverted | Shown |
| No double payment through this path | A4 [`0x1c1cb3dc...`](https://explorer.testnet.arc.io/tx/0x1c1cb3dc8d91db63bc877db30cd1977a174299bd4d3c59122af8b6e893745574) reverted, and again through the tools [`0xaa17d6c6...`](https://explorer.testnet.arc.io/tx/0xaa17d6c6aeab1d2816093a824c84468a2a0a6e08d3a0d18a0d620e94075cf45d). The test `timeout_reconciles_by_payment_id_without_paying_twice` (`sdk/evm/tests/vault_local_chain.rs`) | Shown for this path. Not claimed for all routes |
| A routine payment settles | [`0x41cf5742...`](https://explorer.testnet.arc.io/tx/0x41cf57420722e3492f50a0552b23b3047ec8f322385c003d9c489a59be61b58f) | Shown |
| An owner-signed exception settles | In MetaMask [`0x32cc0ccc...`](https://explorer.testnet.arc.io/tx/0x32cc0ccc5092830eaaa0796a8d964b9453cf52a4eeb2a13138ff4bda0dd982f2). Through the tools [`0xbfaf884f...`](https://explorer.testnet.arc.io/tx/0xbfaf884fd68aa72d4043a8bdf812c55f41bcda7c92c5d42788b4a90818fc1450). With the signature returned automatically [`0x3b9558c3...`](https://explorer.testnet.arc.io/tx/0x3b9558c3c381af00ee12286ceb6c8bf6fd08f65449d8595e4032d1dea8428073) | Shown |
| The reviewer verifies settlement independently | The reviewer checked all four results on the issuer's own machine | **Not yet: G3 needs a second machine with its own RPC** |
| One-record disclosure: a second record does not open | Shown on one machine | **Not yet on a second machine** |
| The policy was enforced at execution | Event fields checked against a pinned code hash, on one machine | **Not yet on a second machine** |
| The owner is alerted and the signature returns without a file | A real Telegram bot and MetaMask, per `STATUS.md` | Shown. **Opening the link on a phone is not shown yet** |
| A watcher reports reverts and daily spend | Two Telegram notices reached the owner, per `STATUS.md` | Shown |

Never claim: audited, production-ready, regulatory compliance, prompt-injection prevention, private payments, World enforced on-chain, exactly-once payment across all routes, or support for all wallets. Only MetaMask has been used.

## AI usage

Parts of this project were written with AI tools. `docs/mumbai/ai-usage.md` lists which, with the prompts in `docs/mumbai/ai-prompts/`. It has gaps marked TO FILL that only Poulav and Ishita can complete. **[TO FILL: a one-paragraph summary once those are filled in.]**

## License

Apache-2.0. See `LICENSE`.

## Partners

**[DECISION: the partner picks.]** Select Arkiv or World only if that gate has actually passed. Neither has been run (G4 and G5 are "not run" in `STATUS.md`).

---

## Notes for the team (not for the README)

1. **`PROVENANCE.md` was removed.** It was in the first commit and was deleted by `6dd604c` ("docs: simplify README and CLAUDE.md, remove PROVENANCE.md"). `BUILD_PLAN.md` still says it exists, and the project rules say not to remove any disclosure. It is in git history and can be restored. Whatever the entry type, the content above needs to be somewhere the judges will see it.
2. **The first commit's message does not say it is imported code.** It is titled "Bootstrap Styx with private settlement and core protocol". `STATUS.md` records the conflict with "fresh project".
3. **Check the numbers.** From the repository root:
   - `git diff --shortstat $(git hash-object -t tree /dev/null) b28d8d6` (first commit; includes lock files)
   - `git diff --shortstat b28d8d6 HEAD` (everything since)
   - `git diff --numstat --diff-filter=A b28d8d6 HEAD` (new files, by area)
   - `git diff --name-only --diff-filter=M b28d8d6 HEAD` (existing files changed)
4. Line counts measure size, not effort or quality, and they say nothing about who or what wrote the code.
