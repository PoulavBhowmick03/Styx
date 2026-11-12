# Styx on NEAR: catch-up brief for Ishita

Hi Ishita. This is everything that happened to Styx for the NEAR Hackathon, in plain words, plus
what's next for you. Deadline: **14 Nov 2026, 23:59 UTC**.

## The one-line version

Styx already worked on Arc (from ETHGlobal Mumbai). We rebuilt it natively on NEAR, ran it for real
on NEAR testnet, and then added something only NEAR can do: the same vault now also pays on Arc,
without the agent ever holding an Arc key.

## What Styx does (same idea as before)

An AI agent gets a budget. The owner sets the rules in a contract: who can be paid, how much per
payment, how much per day. The agent can pay inside the rules. To go over, the owner (or an
approver) has to sign that exact payment. The agent can't change the rules, can't add itself as an
approver, can't withdraw.

## What's new on NEAR

1. **The agent is a key, not a wallet.** On NEAR an account can hold "function-call keys" that are
   only allowed to call certain methods. Our agent is one of those keys on the vault's own account,
   and it may only call the pay methods. If the agent tries to raise its own limit, NEAR itself
   rejects the transaction before our contract even runs. That's the headline for Track 06
   (AI Security & Defense), which literally lists "function call keys" as a hint.
2. **Approvals use NEP-413.** That's NEAR's standard for "sign a message with your wallet". The
   approver signs the exact payment, and the vault checks the signature on chain.
3. **Chain Signatures (the wow part).** NEAR has an MPC network that can sign transactions for other
   chains on behalf of a NEAR account. Our vault uses it: it gets its own address on Arc, builds the
   Arc USDC transfer itself, checks the same limits, and has the MPC network sign it. The agent still
   only has its NEAR key. "One policy, every chain."
4. **Everything else was reused.** The MCP server (the tools the AI agent uses) runs unchanged; we
   just pointed it at a new NEAR command-line tool.

## What actually ran on testnet (all transactions are in `docs/near/TESTNET_RUN.md`)

- Payments inside the limits settled; payments over the limit settled only with the approver's
  signature.
- All six attacks the agent tried with its own key were refused: four by the vault with a named
  error, two by NEAR itself.
- On Arc: 4 USDC and 8 USDC (with a signature) settled from the vault's MPC address; six more attacks
  were refused and nothing got signed for them. One 6 USDC transfer reverted because the address ran
  out of money; that's written up honestly too.
- Real models (Sonnet 5.5 and Haiku 5.5) acted as the agent against hostile invoices: no money went
  to the attacker, nothing went over the limit without a signature. Haiku did try a fake signature
  file twice; the tools refused it. See `docs/near/MODEL_TRIAL.md`.
- A sealed record of a payment was posted on chain and opened by a reviewer with their own key.

## Where things live

| What | Where |
| --- | --- |
| The vault contract (Rust) | `contracts/near/styx-vault` |
| The agent's NEAR command-line tool | `sdk/near` |
| Approval page and relay (built by Codex) | `approval-page-near`, `relay-near` |
| Owner console page (Codex) | `owner-console-near` |
| Reviewer tool for sealed records (Codex) | `reviewer-near` |
| Scripts: quickstart, demo, attacks, model trials | `scripts/near` |
| Plans, run logs, submission drafts | `docs/near` |

Live on testnet: `vault.styx-owner-c87a.testnet` (the NEAR-only vault) and
`vault-v2.styx-owner-c87a.testnet` (with Chain Signatures; its Arc address is
`0xb0241fcBD5A1D9D79a37C927559186eD08563CAd`). These belong to Poulav's keys, so you can't sign as
their owner. For your own copy, use the quickstart below.

## Try it yourself in 2 steps

You need Rust (with the `wasm32-unknown-unknown` target), `cargo-near` 0.17+, `near-cli-rs`,
Python 3.11+ and `uv`.

1. `cd contracts/near/styx-vault && cargo test` runs everything on a local NEAR sandbox, no accounts
   needed. You should see 41 unit tests and 2 sandbox tests pass.
2. `scripts/near/quickstart.sh` makes you a fresh testnet account from the faucet, deploys your own
   token and vault, sets the rules, and runs the payments and all six attacks. Your keys end up in
   `~/.near-credentials` and `~/.styx-near-quickstart/<your-account>/`, never in the repo. That
   folder also gets a `demo.env` you'll need for the task below.

## Your task: NEAR AI Cloud

**The idea.** Right now the agent's AI model runs wherever, so the invoice text goes to a model
provider in the clear, and nobody can later prove which model decided to pay. NEAR AI Cloud runs
models inside secure hardware (TEEs) and signs every answer. We want the agent's model to run
there, verify that proof before every payment, and attach the proof to the sealed record so the
reviewer can check it too. This fits the Privacy track and the "TEE attestation" hint in Track 06,
and Illia (a judge) built NEAR AI.

**The full spec** is `docs/near/CODEX_TASK_4.md`. Read it first. It says exactly what to build
(`agent-near-ai/`, plus a small extension to `reviewer-near/`), the evidence file format, the tests,
and what not to claim.

**What you need:**
- A NEAR AI Cloud API key in the `NEARAI_API_KEY` environment variable. The free route: join NEAR
  Builders and claim $10 of credits at https://nearbuilders.org/dashboard (it gives you a separate
  key). Never put the key in a file inside the repo.
- Your own testnet vault from `scripts/near/quickstart.sh`. Where the spec says
  `~/.styx-near/demo.env`, use `~/.styx-near-quickstart/<your-account>/demo.env`.

**Split the work like this:**
- **Codex** builds `agent-near-ai/` and the reviewer extension.
- **Your Claude Code** adds the small piece on the Rust side: an optional `inference_evidence` field
  in the sealed record the agent CLI posts (`export_record` in `sdk/near/src/main.rs`). It then runs
  the end-to-end check on your vault and writes up the results.

## House rules (same as always)

- Work on `main` in the Styx repo, small commits with conventional messages, `git pull --rebase`
  before every push.
- No keys, `.env` files or API keys in the repo. Testnet only.
- Claim only what a test or a real run shows. Don't write "secure", "audited", "solves", or
  "private payments" (amounts and recipients are public on chain).
- Contract and signing code gets Poulav's review.
- Codex works in its own folders. Claude Code stays out of them, and the other way around.

Questions: ask Poulav. Thanks!
