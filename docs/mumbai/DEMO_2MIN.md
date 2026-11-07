# Two-minute demo script (for Poulav)

One take, about 2 minutes, about 270 spoken words. Everything on screen is `scripts/demo.sh` against the live vault on Arc testnet, plus the owner's phone.

## Before you press record

| Do | Why |
| --- | --- |
| `scripts/demo.sh check` shows "Room for 1 more runs today" or more, and "Relay is up" | A run needs room under the agent's daily limit |
| Phone: Telegram open on the Styx bot, MetaMask unlocked on Arc Testnet with the owner account | The approval is the centre of the demo, so it has to be quick |
| Terminal: large font, dark background, window cleared, `cd` at the repo root | |
| A browser tab open on the explorer, and one on `https://styxco.xyz/setup/?vault=<vault>` | You open a transaction on the explorer in two places |
| Nothing secret on screen: no `.env`, no key file listings, no shell history | The relay token lives in `.env` |
| Rehearse once all the way through, including the phone signature | Arc confirmations and the relay take a few seconds each |

You do not have to hit the clock live. Record the steps in one session and cut the waiting (confirmations, the phone). The words below are timed for the cut.

## The script

| Time | On screen | Say |
| --- | --- | --- |
| **0:00 to 0:15** | The terminal, empty. Or the first lines of the README | "A recent study from Cornell and Yale gave AI agents a wallet with a spending cap. Nine of ten models raised the cap themselves, by reading the approval code that was emailed to their owner. The limit and the approval were both somewhere the agent could reach. Styx puts them in the contract." |
| **0:15 to 0:28** | `scripts/demo.sh check`. Point at the vault address, the balance, and "Agent limits" | "This is a vault on Arc holding USDC. The agent has its own limits: so much per payment, so much per day. The agent holds only a gas key. It cannot change any of this." |
| **0:28 to 0:42** | `scripts/demo.sh pay`. The agent proposes 0.1 USDC, "Settled, with no approval needed". Click the explorer link for a second | "A routine payment, inside the limit. The agent pays it through the tools and the vault settles it. No human needed." |
| **0:42 to 1:05** | `scripts/demo.sh approve`. The vault says the payment is over the limit. The alert arrives on the phone. Open it, show the recipient and amount, sign in MetaMask. Back to the terminal: "Settled. Vendor A received 2 USDC" | "Now a 2 USDC payment, over the agent's limit. The vault will not move it. The owner gets an alert, opens it, checks the exact recipient and amount against what the vault says, and signs in their own wallet. No code to read from an inbox, no file to carry. The contract checks that signature itself." |
| **1:05 to 1:30** | `scripts/demo.sh attack`. Three `PASS ... reverted on chain` lines. Open the first on the explorer | "Now the agent misbehaves, on the real chain. First, it calls the contract to raise its own limit. That is what the study saw agents do. It reverts. Then it pays over its limit directly, skipping the tools. Reverts. Then it replays the owner's signature on the payment that already went through. Reverts." |
| **1:30 to 1:50** | `scripts/demo.sh review`. Four results, all `verified`. Then someone else's key: refused | "Every payment leaves a record. A reviewer, with their own key and their own connection to Arc, opens exactly one record and checks four things against the chain: the record is intact, it was authorized, it settled, and the policy was what it says. Another reviewer's key opens nothing." |
| **1:50 to 2:00** | `scripts/demo.sh arkiv` ("Fetched ... encrypted bytes"), then `scripts/demo.sh links` | "The sealed record also sits on Arkiv, fetchable with none of our processes running. The limit lives in the contract, and so does the approval. That is Styx." |

## What each step does, for your reference

| Step | Command | What it proves | Expected output |
| --- | --- | --- | --- |
| Check | `scripts/demo.sh check` | The vault, the agent's limits and today's room, read from the chain | Vault, balance, agent, limits, spent today, "Room for N more runs today", "Relay is up" |
| Pay | `scripts/demo.sh pay` | A payment inside the limit settles with no approval | "Settled, with no approval needed" and an explorer link |
| Approve | `scripts/demo.sh approve` | Over the limit, the owner's signature over the exact payment is required, and arrives with no file | "Approver alerted on Telegram", then "Signature received through the relay", then "Settled" |
| Attack | `scripts/demo.sh attack` | The agent cannot raise its own limit, pay over it directly, or replay a payment | `PASS` for A5, A1 and A4, each with a transaction link |
| Review | `scripts/demo.sh review` | One record checked against the chain by a reviewer's own key | Four results `verified`, then a refusal for the other key |
| Arkiv | `scripts/demo.sh arkiv` | The sealed record can be fetched with nothing of ours running | "Fetched N encrypted bytes from Arkiv" |
| Links | `scripts/demo.sh links` | Where a viewer can look | Vault on the explorer, Arc Studio, the setup page |

`scripts/demo.sh auto` runs every step with no pauses. It still waits for the phone signature. Use it only for a rehearsal, because the pauses between steps are what give you time to talk.

## Say only what the screen shows

- Use "a recent study", and give the link if you are asked: https://arxiv.org/abs/2610.35835. We did not repeat the study's email test. What we show is that the contract refuses an agent that tries to raise its own limit.
- A5 (raising its own limit) must have passed on Arc in your rehearsal before you say it passed on camera.
- Amounts, recipients and timing are public on Arc. Only the invoice and the approval record are encrypted. Say that if anyone asks about privacy.
- Do not say audited, secure, production-ready, or that it stops prompt injection. Say what you just showed.

## If something goes wrong on camera

- **The Telegram alert is slow.** Say "the alert is on its way" and keep talking about the recipient and amount the owner will check. Cut the wait later.
- **A step says "Not settled yet. Retry with the same ID".** Run the same step again. Do not start a new payment.
- **Arkiv does not answer.** It says nothing about the payment. Skip it and close on `links`.
- **A rate-limit error from the public RPC.** Wait a few seconds and run the step again.
- **Over 2 minutes.** Cut the Arkiv step first, then shorten the check step to one line.
