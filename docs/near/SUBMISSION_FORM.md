# NEAR Hackathon submission: draft answers

DRAFT for Poulav to edit into his own voice before submitting. Every claim below is backed by
`docs/near/TESTNET_RUN.md` or a test in the repo. Deadline: 14 Nov 2026, 23:59 UTC.

| Field | Answer |
| --- | --- |
| Project name | Styx |
| Team lead | (fill in) |
| Email | (fill in) |
| Team size | (fill in) |
| Tracks | `security` (AI Security & Defense, primary), `swarms` (the sentinel swarm), `agents` (Agent Economy), `business` (Autonomous Business) |
| NEAR wallet address | `odinson03.near` (mainnet; the prize is paid here) |
| Repository | https://github.com/PoulavBhowmick03/Styx |
| Demo post | (the X post link, tagging @NEARProtocol and #NEARHackathon) |
| Website | https://styxco.xyz (approval page at /approval/, owner console at /console/) |

## What did you build? (20 to 2,000 characters)

```text
Styx: a NEAR vault where an AI agent's key can only pay, within limits it cannot change; a velocity cap in the contract stops drains; and a self-selecting swarm of watcher agents, whose keys can only pause, catches the rest.

A recent study (https://arxiv.org/abs/2610.35835) gave AI agents wallets with spending caps. Nine of ten models raised their own cap at least once, by reading the approval code meant for the owner. Styx puts the limits and the approval on chain. On NEAR the agent is a function-call access key on the vault, allowed only the pay methods: when it tries to raise its own limit, NEAR rejects the transaction before the contract runs. Over the per-payment limit, the vault needs the approver's NEP-413 signature over that exact payment. Through Chain Signatures the same vault pays USDC on EVM chains under the same limits.

Limits alone don't stop a drain of small payments that each pass them. So the owner can cap payments per time window, enforced by the contract on every pay path. And sentinels (a burst rule, a concentration rule, a judge model on NEAR AI Cloud) watch every payment; NEAR lets their keys call only sentinel_pause. A parent scores them, retires noisy ones and breeds looser or stricter children; the owner approves every key change.

Built on NEAR: a Rust vault and factory, an owner console, an agent CLI and MCP server, an approval page and Telegram relay, the sentinel swarm (local or hosted), and a public proof page.

On testnet: payments settled on NEAR, Arc and Base; exceptions settled with the approver's signature; all six attacks signed with the agent's own key were refused. The same 8-payment drain ran twice: without sentinels all 8 settled; with them, a sentinel paused the vault after 5 and the next was refused. With a cap of 4 payments per 5 minutes, the 5th payment of a drain was refused on chain.
```

## Notes for the post on X

- Say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, attach the video.
- One line to keep: the agent's key cannot change limits, recipients or approvers, pause or
  withdraw, and NEAR enforces that at the access-key level.
- Do not claim "secure", "audited", "solves" or prompt-injection prevention, and do not add
  disclaimers either. Say what ran.
- Real wallets ran the whole flow on 13 Nov 2026 (`TESTNET_RUN.md`): vault created and configured from
  the console in Meteor, agent payments, the alert in the approver's own Telegram, approval signed on a phone.
  Pause, unpause and withdraw from the console too.
