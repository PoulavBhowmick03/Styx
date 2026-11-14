# NEAR Hackathon submission: draft answers

DRAFT for Poulav to edit into his own voice before submitting. Every claim below is backed by
`docs/near/TESTNET_RUN.md` or a test in the repo. Deadline: 14 Nov 2026, 23:59 UTC.

| Field | Answer |
| --- | --- |
| Project name | Styx |
| Team lead | (fill in) |
| Email | (fill in) |
| Team size | (fill in) |
| Tracks | `security` (AI Security & Defense, primary), `agents` (Agent Economy), `business` (Autonomous Business) |
| NEAR wallet address | `odinson03.near` (mainnet; the prize is paid here) |
| Repository | https://github.com/PoulavBhowmick03/Styx |
| Demo post | (the X post link, tagging @NEARProtocol and #NEARHackathon) |
| Website | https://styxco.xyz (approval page at /approval/, owner console at /console/) |

## What did you build? (20 to 2,000 characters)

```text
A recent study (https://arxiv.org/abs/2610.35835) gave AI agents wallets with spending caps. Nine of ten models raised their own cap at least once, by reading the approval code meant for the owner. The limit and the approval sat where the agent could reach them.

Styx puts both on chain. The owner funds a vault contract and sets who it may pay and, per agent, the most it can pay per payment and per day. On NEAR the agent is a function-call access key on the vault, allowed only the pay methods: when it tries to raise its own limit, NEAR rejects the transaction before the contract runs. Going over the per-payment limit needs the approver's NEP-413 signature over that exact payment, checked on chain. Through Chain Signatures the same vault pays USDC on other chains from its MPC-derived address, under the same limits.

Limits alone don't stop a drain of small payments that each pass them. So Styx adds sentinels: watcher agents (a burst rule, a concentration rule, a judge model on NEAR AI Cloud) whose own keys NEAR allows only sentinel_pause. A parent scores them, retires noisy ones and breeds a looser or stricter next generation; the owner approves every key change. The vault can also cap payments per time window.

Built on NEAR: a Rust vault and a factory that creates one from the owner's wallet; an owner console; an agent CLI and MCP server; an approval page and relay that alert each approver on Telegram; the sentinel swarm and its live page; sealed records a reviewer opens with their own key.

On testnet: payments settled on NEAR, Arc and Base; exceptions settled with the approver's signature; all six attacks signed with the agent's own key were refused. Sonnet 5.5 and Haiku 5.5 as the agent sent nothing to the attacker. The same drain of 8 payments ran twice: without sentinels all 8 settled; with them, a sentinel paused the vault 43 s in, after 5, and the next was refused.
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
