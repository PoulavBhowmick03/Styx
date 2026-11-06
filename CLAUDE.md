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
