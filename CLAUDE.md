# Styx on NEAR (NEAR Hackathon)

Plan and status: `docs/near/PLAN.md`. Everything that ran: `docs/near/TESTNET_RUN.md`.
Deadline: 14 Nov 2026, 23:59 UTC. Official rules: https://nearhackathon.com/HACKATHON.md.

Poulav reviews all contract and signing code.
No keys in the repo.

## Scope

A funded vault on NEAR pays an agent's payments within the owner's rules, on NEAR and, through Chain
Signatures, on EVM chains (Arc testnet, Base Sepolia). Going over the per-payment limit needs an
approver's NEP-413 signature over the exact payment. A reviewer can open one sealed record and check
it against the chain.

- **Owner:** sets policy, recipients, approvers and EVM chains; pauses; withdraws.
- **Approver:** signs exceptions from their NEAR wallet on the approval page.
- **Agent:** a function-call key on the vault account, allowed only the pay methods and
  `post_record`, plus the MCP tools. Cannot change policy, approve, pause or withdraw.
- **Reviewer:** holds a reviewer key and their own RPC. Opens one record. Cannot read any other.

**Out of scope:** private payments (amounts and recipients are public on chain), NEAR Intents
(mainnet only), running the agent runtime in a TEE, production key management.

## Rules

- **Secrets.** No key material, `.env` files or keystores in the repo, test keys included. Settings
  with keys live in `~/.styx-near/`. Testnet funds only.
- **Review.** Poulav reviews every line of contract and signing code before it is trusted.
- **Claims.** Claim only what a test or a testnet run shows.
- **Commits.** Small commits with conventional messages. Keep contract changes separate from agent,
  MCP and page changes.

## Pitch and framing

- Lead with the mechanism: "payments" and "spending limits"; invoices are only the demo scenario.
- The line to keep: the agent's key cannot change limits, recipients or approvers, pause or
  withdraw, and NEAR enforces that at the access-key level; going over a limit needs the approver's
  signature over that exact payment.
- Cite the study as "a recent study" with its link (https://arxiv.org/abs/2610.35835).
- No disclaimers in pitch text, and never the opposite: no "audited", "secure", "solves",
  prompt-injection prevention or private payments.
- Keep `docs/near/SUBMISSION_FORM.md`, `docs/near/DEMO_SCRIPT.md` and the README in step.
- Q-002: the README keeps the one-line note that Styx began at ETHGlobal Mumbai on another chain.

## Deployment

- Relay: `https://styx-relay-near.fly.dev` (`relay-near/fly.toml`, secrets on Fly only).
- Site: `styxco.xyz` (`scripts/build_site.sh`, Vercel project `styx-approve`): `/approval/`,
  `/console/`.
- One-run demo: `scripts/near/demo_full.sh`; real-wallet steps: `docs/near/WALLET_TEST.md`.
