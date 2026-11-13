# Real-wallet checklist: everything built since 13 Nov 2026

Every item here passes unit and mocked-wallet browser tests. None has run with a real Meteor wallet
on testnet yet. Run this before claiming any of it. Testnet only. Record each transaction in the
table at the end (`scripts/near/tx_outcome.sh <hash> <signer account>` prints its outcome), then copy
the passing rows into `TESTNET_RUN.md`.

## Before you start

1. **Deploy what you are testing.** The site deploys on every push to `main` (Vercel); the relay
   deploys with `cd relay-near && fly deploy`. Branch `ux-approvals` (auto-resume, decline, freeze
   link, escalation) is not on `main` until you merge it; without it, skip steps 8 to 11.
2. **Wallets.** Meteor on your laptop with the owner account (`odinson03.testnet`), and Meteor on
   your phone with the approver account (`poulav.testnet`). About 6 testnet NEAR in the owner account.
3. **Agent machine.** Rust (`cargo`), `uv`, and Claude Code installed.

## A. Owner console

1. **Funds check.** At https://styxco.xyz/console/, connect the owner. Under Create a vault, enter a
   new name and a deposit larger than your balance, then Preview vault. Expect: a message naming your
   spendable NEAR, and no wallet prompt. Set the deposit back to 4.
2. **Create, then two approvals.** Preview vault, sign (approval 1). In Set up this vault:
   - Step 1, Register and fund (amount 100): one wallet prompt with **two** actions,
     `storage_deposit` and `mint` (approval 2).
   - Step 2, Set the rules: click **Team**, check the limits fill in. Paste two recipients, one per
     line, the first with a name: `vendor-a.styx-owner-c87a.testnet, Vendor A` and
     `vendor-b.styx-owner-c87a.testnet`. Leave the approver empty for now. Generate the agent key.
     Review: it should list every call. Sign (approval 3): **one** prompt, several actions.
   Expect: three approvals in total; both steps ticked off; Vendor A named in Agents & access.
3. **Approver invite.** In Set the rules, click **Copy an invite link for your approver**. Open the
   link on the phone, in Meteor's browser, as `poulav.testnet`: connect, **Sign once**, then send the
   link it shows back to the laptop and open it. Expect: "Approver invite from poulav.testnet:
   signature checked, and the key is on that account", and the approver field filled in. Review and
   sign. Expect the step to tick off.
4. **Telegram, deep link.** On the phone, tap **Open @Styx_pvt_bot in Telegram (Start is sent for
   you)**. Expect: the bot opens with Start, answers with a link; sign the link message. Back on the
   laptop, reload: the approver panel says **Telegram alerts: on**.
5. **Spend alerts.** In the vault overview, tap **Get spend alerts on Telegram**. Expect: "Watching
   <vault>". Steps 7 and 8 should then trigger the 80% message once the day's spend passes it (set
   the vault daily limit low, for example 20, from Advanced, to reach it quickly).
6. **Names and export.** Rename the agent ("Billing bot"), Export names, Import the file into
   another browser. Expect: the same names.

## B. The agent

7. **Hand-off without the repo.** On the ready screen, Download agent settings, then run the four
   commands it shows (they `cargo install` the CLI and add the MCP server with `uvx` from GitHub).
   Put an invoice in `$HOME/.styx-near-agent/<vault>/invoices/` and ask Claude to pay it, inside
   the limits. Expect: settled, with a transaction hash.
8. **Auto-resume after approval** (branch `ux-approvals`). Ask Claude to pay an invoice over the
   per-payment limit. Expect: it asks, says it is waiting, and **you do not type anything**: sign on
   the phone and Claude submits by itself within a few seconds. Note whether Claude Code cut the
   wait short.
9. **Decline** (branch `ux-approvals`). Ask Claude to pay another over-limit invoice. On the phone,
   tap **Decline** and sign. Expect: the page says Declined; Claude says it was declined and does not
   pay or ask again.
10. **Freeze from Telegram** (branch `ux-approvals`, relay deployed). From the alert in step 9, tap
    **Freeze this agent (owner)** on the laptop, connect the owner. Expect: the review opens by itself
    with `enabled: false`; sign. Then ask Claude to pay a small invoice. Expect: refused by NEAR (the
    agent's key is gone).
11. **Escalation** (branch `ux-approvals`, needs a second approver key). Add a second approver, set
    `STYX_VAULT_APPROVERS=<its key>` and `STYX_VAULT_ESCALATE_MINUTES=1` in the agent's MCP settings,
    and leave a request unsigned. Expect: after a minute Claude asks the second approver.

## C. Expiry and DAO

12. **Expiry warning and renew.** In Advanced, re-enable or configure an agent with an expiry an hour
    from now. Expect: Agents & access warns "Expires in …" and offers **Extend 30 days**; sign; the
    warning goes.
13. **DAO owner** (optional, needs a Sputnik DAO on testnet). Create a vault from the DAO through a
    proposal, open it in the console as a member. Expect: "changes you make here are proposals"; a
    change sends one `add_proposal` with the bond. Vote it through; the vault changes.

## Results

| Step | What happened | Transaction(s) | Pass? |
| --- | --- | --- | --- |
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 | | | |
| 10 | | | |
| 11 | | | |
| 12 | | | |
| 13 | | | |
