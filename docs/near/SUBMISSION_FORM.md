# NEAR Hackathon submission: draft answers

DRAFT for Poulav to edit into his own voice before submitting. Every claim below is backed by
`docs/near/TESTNET_RUN.md` or a test in the repo. Deadline: 14 Nov 2026, 23:59 UTC.

| Field | Answer |
| --- | --- |
| Project name | Styx |
| Team lead | (fill in) |
| Email | (fill in) |
| Team size | (fill in) |
| Tracks | AI Security & Defense (primary), Agent Economy, Autonomous Business |
| NEAR wallet address | (fill in: the prize goes here) |
| Repository | https://github.com/PoulavBhowmick03/Styx |
| Demo post | (the X post link, tagging @NEARProtocol and #NEARHackathon) |
| Website | https://styxco.xyz (Arc build; NEAR approval page link once deployed) |

## What did you build? (20 to 2,000 characters)

```text
A recent study (https://arxiv.org/abs/2610.35835) gave AI agents wallets with spending caps. Nine of ten models raised their own cap at least once, by reading the emailed approval code meant for the owner. The limit and the approval sat where the agent could reach them.

Styx puts both on chain. The owner funds a vault contract and sets, per agent, the recipients it may pay and the most it can pay per payment and per day. On NEAR the agent is a function-call access key on the vault account, allowed to call only the pay methods. When the agent's key tries to raise its own limit or make itself an approver, NEAR rejects the transaction before the contract runs. Going over the per-payment limit needs the approver's NEP-413 signature over that exact payment, which the vault verifies on chain. A signature for one recipient fails for another, a payment ID pays once, and no signature lifts the daily limits. Through NEAR Chain Signatures the same vault also pays USDC on Arc from an address NEAR's MPC network derives for it, under the same limits: the vault builds the transaction and the agent never holds an EVM key.

Built on NEAR: a Rust vault contract (near-sdk) paying a NEP-141 token, with a callback that rolls the counters back if the transfer fails. A Rust agent CLI the existing MCP server drives unchanged. A wallet-selector approval page and relay for NEP-413 signing. Sealed records a reviewer opens with their own key.

On testnet: payments inside the limits settled on NEAR and on Arc, exceptions settled with the approver's signature, and all six attacks signed with the agent's own key were refused: four by the vault with named errors, two by the network itself. We also ran Sonnet 5.5 and Haiku 5.5 as the agent against hostile invoices on testnet: no tokens reached the attacker's account and nothing went over the limit without a signature.
```

## Notes for the post on X

- Say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, attach the video.
- One line to keep: the agent's key cannot change limits, recipients or approvers, pause or
  withdraw, and NEAR enforces that at the access-key level.
- Do not claim "secure", "audited", "solves" or prompt-injection prevention, and do not add
  disclaimers either. Say what ran.
- The approval page has not yet been used with a real wallet. Do that before showing it on camera.
