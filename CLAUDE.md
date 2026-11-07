# Styx at ETHGlobal Mumbai

Full plan: `docs/mumbai/BUILD_PLAN.md`.

Poulav reviews all contract and signing code.
No keys in the repo.

## Scope (plan section 1)

A funded vault on Arc pays an agent's routine invoices within the owner's rules, needs the owner's signature over the exact payment before allowing an exception, and gives a reviewer one record they can check against the chain.

- **Owner:** sets policy, allows vendors, signs exceptions, pauses, withdraws.
- **Agent:** holds a gas-only key and the MCP tools. Proposes and submits payments the vault allows. Cannot change policy, sign exceptions or withdraw.
- **Reviewer:** holds a disclosure key and their own Arc RPC. Opens one disclosed record and verifies it against Arc. Cannot read any other record.

**In scope:** one vault per owner and one agent; USDC only, through its ERC-20 interface, on Arc testnet; one reviewer record format; MCP tools and a minimal owner signing page.

**Out of scope:** shielding, stealth addresses, cross-chain settlement; a negotiation engine, delivery escrow, AP2 integration; budgets shared across several agents, an attack detector, production key management.

## Rules

- **Secrets.** No key material, `.env` files or keystores in the repo, test keys included. Use testnet funds only.
- **Review.** Poulav reviews every line of contract and signing code before it is trusted.
- **Claims.** Claim only what a test or the live demo shows (plan section 13).
- **Commits.** Small commits with conventional messages. Keep contract changes and agent/MCP changes separate.

## Pitch and framing (for the submission and the demo)

The problem Styx answers: a recent study (Cornell and Yale, "I-HITL", arXiv 2610.35835, reported by CoinDesk on 1 November 2026) found agents with wallets often raise their own spending cap, for example by reading the emailed approval code meant for the owner. The limit and the approval sat where the agent could reach them. Styx puts both in the contract.

- **Lead with the mechanism, not invoices.** Say "payments" and "spending limits". Invoices are what we built and ran it on, so they belong in the demo description only.
- **The line to keep:** the agent cannot change limits, recipients, approvers, pause or withdraw (all `onlyOwner` in `StyxVault.sol`), and going over a limit needs the owner's signature over that exact payment.
- **Do not write disclaimers into pitch text** such as "unaudited" or "does not solve the problem". Also never claim the opposite: no "audited", "secure", "solves", prompt-injection prevention, or private payments. Say what the tests and the live runs show.
- **Cite the study as "a recent study"** with its link. We did not reproduce its email scenario. We tested Haiku 5.5 and Sonnet 5.5 against hostile invoices on a local chain (`mcp-server/examples/trials`).
- Final form text is in `docs/mumbai/SUBMISSION_FORM.md`. Keep it and `docs/mumbai/DEMO_SCRIPT.md` in step with each other and with the README.

## Attacks

`contracts/evm/script/attacks_v2.sh` sends real transactions that must all revert: A1 to A4 (pay over the limit directly, sign with the agent's own key, reuse a signature for another recipient, replay a settled payment) and A5 and A6 (the agent raises its own limit, the agent makes itself an approver).

- A1 to A4 have run on Arc. **A5 and A6 have run on a local chain only.** Run them on Arc before saying so on camera or in writing.
- The contract is unchanged by this work. `test_agentAndApproverCannotAdminOrWithdraw` in `contracts/evm/test/StyxVault.t.sol` is the unit test for the same refusal. Any change to `StyxVault.sol` needs Poulav's review and its own commit.
- `scripts/demo.sh` runs A5, A1 and A4 by default (`DEMO_ATTACKS` overrides).
- `scripts/demo.sh` reads `.env` at the repo root, which git ignores. Never commit it. It holds the relay token, so keep it out of the repo, screenshots and the video. `scripts/demo.sh auto` runs every step.
