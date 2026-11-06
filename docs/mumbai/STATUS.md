# Status

Updated 6 November 2026.

## Gates

| Gate | Status | Notes |
| --- | --- | --- |
| G0 | **Team says: fresh project, not Continuity. Conflict open, see below** | Arc Studio project: not confirmed |
| G1 | Not reported | The team left this blank. Needs the vault address, deploy transaction, the 0.25 USDC payment, A1 and A2 |
| G2 | Not run | Needs the 6 USDC exception with a real wallet, A3 and A4 |
| G3 | Not run | Needs the reviewer on a second machine |
| G4 | Not run | Needs tGLM and an Arkiv access key |
| G5 | Not run | Needs a World client |

**Review:** the team reports the contract and signing code as reviewed. The review scope and date are not recorded here. Any contract that comes from Studio needs its own review.

## Open conflict on G0

The repo as it stands does not match "fresh project":

- Commit `b28d8d6`, the first commit, imports about 62,000 lines of code from the earlier Erebus repo at `d56c777`.
- The vault client, CLI, reviewer and MCP tools are built on that code.
- ETHGlobal's rules for the from-scratch track: "Pre-existing project-specific code, designs, or assets are not allowed."
- Undisclosed pre-existing work or misrepresentation can mean disqualification, revoked prizes and a ban.

Resolve before submitting, by one of:

1. Enter as Continuity and disclose the prior work.
2. Get written confirmation from ETHGlobal that this repo qualifies as entered.
3. Ship a from-scratch repo with none of the imported code. New implementations must be written, not copied.

Until this is resolved, nothing should state that the whole project was built at the event. The video's closing and `README_DRAFT.md` still describe Continuity.

## How the owner is alerted

With the relay running, an over-cap request sends the owner a Telegram alert with a link to the approval page, and the signature goes back to the agent automatically. See `relay/README.md`. This is tested against a fake Telegram server and a local chain. It has not run with a real bot, because that needs a token from @BotFather.

Without the relay, the tool writes a pending file and someone carries it to the owner by hand. An agent that skips the tools sends no alert: the vault still refuses the payment, and the planned watcher covers those attempts.

## How to run G2 and G3

Both need G1's deployed, funded vault. See `RUNBOOK.md` for the exact commands.

**G2:** run `scripts/run_gates.sh`, which pauses and prints a pending file. Load it with the owner config in `owner-page`, sign in the owner's wallet, and save the signature file to the printed path. The script then runs A1 to A3, settles the 6 USDC, and runs A4.

**G3:** on a second machine, the reviewer runs `keygen` and sends their public key. The issuer runs `export_vault_payment` and sends the grant. The reviewer runs `verify_vault_payment` with their own RPC, the issuer address and the vault's code hash, then repeats with a tampered copy and a second record.
