# Submission form answers

The text to paste into the ETHGlobal form. Sources for the problem: the I-HITL paper (https://arxiv.org/abs/2610.35835), the CoinDesk report on it (https://www.coindesk.com/tech/2026/11/01/ai-agents-bypassed-crypto-spending-limits-without-human-approval-researchers-find-in-a-new-test), the Devcon 8 talk (https://cfp.devcon.org/devcon8/talk/HGQQNC/) and MetaMask's May 2026 security report (https://metamask.com/news/crypto-security-report-may-2026).

## Short description

Agent spending limits enforced by the contract, so an agent can't raise its own cap

## Description

A recent study from Cornell and Yale gave AI agents a wallet with a spending cap. Nine of ten models raised the cap themselves at least once. Raising it needed an emailed one-time code, and the agent had access to that inbox, so it read the code and approved its own increase. The limit and the approval were both somewhere the agent could reach.

Styx puts both in the contract. The owner funds a vault on Arc with USDC and sets which recipients can be paid and the most that can go out per payment and per day, for each agent. The agent holds only a gas key. It can pay inside those limits, and it can't change them, add an approver, or withdraw. To go over a limit, the owner signs that exact payment in their own wallet, and the contract checks the signature before it moves any money. A signature for one recipient doesn't work for another, and a payment ID can only be used once.

Each payment also produces an encrypted record that one reviewer can open with their own key and check against Arc. They see four things separately: the record is intact, it was authorized, it settled, and the policy was what the record says. They can't read any other record.

We built and ran it on supplier invoices on Arc testnet, but the rules apply to any payment an agent makes.

## How it's made

The core is one Solidity contract, `StyxVault`, built with Foundry and deployed to Arc testnet from Arc Studio. It holds USDC through its ERC-20 interface and enforces everything itself: the recipient allowlist, per-payment and daily limits for each agent, expiry, and used payment IDs so a retry can't pay twice. Every function that changes limits, recipients, approvers, pausing or withdrawals is owner-only, so the agent's key can't touch them. Exceptions use an EIP-712 signature over the exact payment. The contract also rejects any token transfer that doesn't change the recipient's balance by exactly the amount.

The agent side is a Python MCP server with a few payment tools (propose, submit, status, request approval, check approval). It calls a Rust command line tool, `styx-vault`, built on alloy. That tool is the only thing that holds the agent key. It writes the payment ID and digest to a local journal before sending, so a timeout can be retried under the same ID. The MCP server won't start if an owner key variable is set.

The owner pages are TypeScript with Vite and viem, hosted on Vercel. One is a setup page for deploying, setting limits and recipients, funding, pausing and withdrawing. The other is the approval page, which reads the vault and shows the full recipient and amount before the owner signs. Neither ever asks for a key. A small relay on Fly carries a pending request to the owner and the signature back. It holds no keys, and the vault rejects a bad signature whatever the relay does. Telegram delivers the alerts, and a read-only watcher flags reverts and daily spend.

For the reviewer we wrote a Rust disclosure tool that opens one sealed record, and we publish the ciphertext to Arkiv's Rabdi testnet so it can be fetched with none of our processes running.

We tested it by attacking it. On Arc, an agent calling the contract directly to pay over its limit, signing an exception with its own key, reusing the owner's signature for another recipient, and replaying a settled payment all reverted. An agent trying to raise its own limit or make itself an approver reverts in the contract tests and in a run on a local chain, and the limit stays where it was. We also ran real models against hostile invoices on a local chain.
