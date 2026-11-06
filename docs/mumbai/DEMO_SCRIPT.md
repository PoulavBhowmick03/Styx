# Demo script

A shot list for the real demo video: 2 to 4 minutes, at least 720p (`BUILD_PLAN.md`, section 14). It runs `scripts/run_gates.sh` against the vault on Arc testnet and shows Arc Studio, which Arc's prizes require, with a shareable Studio URL.

Which prizes to enter and the entry type are not decided here: they are Poulav's calls. Nothing below says either.

**How to read the labels.** Each shot says what has run on Arc testnet before, from `STATUS.md`, and what has not. Anything marked **not yet run on Arc** must be rehearsed before it goes in the video, and cut or shown honestly if it fails. The running time is a plan of 3 minutes 45 seconds. The only timing measured is the local rehearsal, which took 6.4 seconds on Anvil with automatic signing. Arc timing has not been measured, so time a full rehearsal on Arc before filming.

## Before filming, off camera

| Do | Why |
| --- | --- |
| Confirm the vault `0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1` is configured: agent set, 1 USDC per payment, 10 USDC per day, vendor A and vendor B allowed, funded, and the agent address holding only gas | `STATUS.md` records this as done for the live run. Check it again on the day |
| Do not deploy anything. Connect to the vault above on the setup page | A second vault was already deployed by mistake. Use `?vault=0xb3bc...` so the banner shows the right one |
| Use a clean browser profile that has only the owner wallet. Close every other tab and any key manager | Nothing secret may appear on screen |
| Keep keys outside the repo, and check that no terminal command, history, `.env` file or file listing on screen shows key material or the Telegram token | The project rule is no keys in the repo or in the video |
| Open the Arc Studio workspace in a private window and confirm the link opens without logging in | The shareable URL is `https://studio.arc.io/app/038ffe00-c21d-4804-99f6-90c3d44f5e16`, from `STATUS.md`. **Not checked that it opens for someone who is not logged in** |
| Have the explorer ready: `https://explorer.testnet.arc.io` | To show the transactions and the reverts |
| Have a second laptop or a clean profile ready for the reviewer shot, with its own RPC | Reviewing on the same machine is not G3 |
| Rehearse the whole sequence once on Arc and time it | Arc timing is unmeasured. Each run of `run_gates.sh` spends a little gas, and the reverted attacks cost the agent gas too |

Set the environment from `RUNBOOK.md`, section 4 (the RPC list includes the fallbacks, since the public endpoint rate-limits bursts), then film the terminal with a large font.

## The shots

| Time | Show | Say | Status on Arc |
| --- | --- | --- | --- |
| 0:00 to 0:15 | The architecture diagram (`ARCHITECTURE.md`) | "An agent that pays bills needs rules it cannot break. Styx is a vault on Arc: it pays routine invoices within the owner's limits, needs the owner's signature over the exact payment for an exception, and gives a reviewer one record they can check against the chain." | |
| 0:15 to 0:45 | **Arc Studio.** The Studio workspace with the vault contract open, then the deployment record, then the vault address on the explorer. Say the URL aloud and show it on screen | "This contract was written and deployed from Arc Studio. Here is the workspace, the deployed vault on Arc testnet, and the shareable link." | Deployed from Studio per `STATUS.md`. Confirm the workspace shows the contract and its deployment before filming |
| 0:45 to 1:10 | The setup page, connected to the vault with its banner showing the full address. Scroll: the limits (1 USDC per payment, 10 per day), the vendors, and "Is your money protected?" with every item OK. Do not click deploy, and do not use the wallet's Send button | "The owner sets the rules from their own wallet. The vault only protects what is inside it, so the page checks that the vault is funded and that the agent's address holds gas only. The daily limit is the most the agent can pay in a day without a signature." | A person used an earlier page with MetaMask on Arc. **The later fixes were tested on a local chain only, not re-tried with a real wallet.** Rehearse it |
| 1:10 to 1:35 | Terminal: run `scripts/run_gates.sh`. Show the preflight line and the routine payment | "The agent pays a 0.25 USDC routine invoice. It is inside the limits, so the vault pays it with no approval." The terminal prints `state settled, tx ...` and the balances line. Open the transaction on the explorer | **Run on Arc**: a 0.25 USDC payment settled (`STATUS.md`) |
| 1:35 to 2:00 | The script's attack lines, then one reverted transaction on the explorer | "Now the agent misbehaves, on the real chain. A1: it pays 6 USDC directly. A2: it signs its own exception. A3: it submits a signature for another vendor. Each reverts." The terminal prints `PASS A1 over the per-payment limit reverted on chain` and the same for A2 and A3 | **Run on Arc**: A1, A2 and A3 reverted (`STATUS.md`) |
| 2:00 to 2:35 | The terminal pauses with `OWNER: open owner-page...`. Switch to the approval page. It shows the full recipient, the amount, the limit read from the chain and the expiry. Sign in the wallet. The signature file is saved and the terminal continues to `state settled` and the new balances | "For a 6 USDC payment the vault needs the owner. The owner checks the exact recipient and amount, signs in their own wallet, and the vault checks that signature against this one payment." Say nothing about an alert here unless the Telegram path was actually run | **Run on Arc**: a 6 USDC exception signed in MetaMask settled. **Not yet run on Arc: the Telegram alert with a real bot.** Without it, the file path above is what happens. The alert and automatic return are tested against a fake server only |
| 2:35 to 2:50 | The terminal: `PASS A4 payment ID already used reverted on chain` | "Replaying the settled approval fails: the payment ID is spent." | **Run on Arc**: A4 reverted (`STATUS.md`) |
| 2:50 to 3:25 | **On the second laptop or clean profile**, the reviewer with only their key and own RPC runs `verify_vault_payment`. Show four results all `verified`, then a tampered copy refused, a record sealed to someone else refused, and the RPC unplugged giving `unavailable` | "A reviewer opens exactly one record. They check four things separately against the chain with their own RPC. A tampered copy fails, another record does not open, and an unreachable chain says 'unavailable', never 'unpaid'." | **Run on Arc on one machine** by the script. **Not yet run on a second machine (G3).** The script's reviewer section on one machine is not G3 |
| 3:25 to 3:45 | A closing card: what is public, what is encrypted, and the limits | "Amounts, recipients and timing are public on Arc. Only the invoice and approval record are encrypted. This is testnet, it is not audited, the daily limit is the real cap on unsigned spending, and the owner has to be a plain account." Then the closing line for the entry, below | |

**Closing line.** The wording depends on the entry type, which is not decided. Whatever it is: do not say the whole project was built at the event, and do not drop the disclosure of the earlier Erebus code that `STATUS.md` describes under "Open conflict on G0".

## Optional shots, only if their gate has passed

Leave these out unless the gate has actually been run, and do not claim them otherwise.

| Shot | Gate | Status now |
| --- | --- | --- |
| The reviewer fetches the sealed grant from Arkiv with every Erebus process stopped | G4 | Not run |
| The owner page asks for a World check before the sign button appears, and a denied check never reaches signing | G5 | Not run with World. Tested with a local fake only, and World's proofs at this event are mocked |
| A phone alert from a real Telegram bot with the approval link | | Not run with a real bot |

## What you may say, and what you may not

You may say what the shots above show. Say only what the screen shows at that moment.

Do not say: audited, production-ready, regulatory compliance, prompt-injection prevention, private payments, World enforced on-chain, "exactly once across all routes", or support for all wallets (`BUILD_PLAN.md`, section 13). Only MetaMask has been used with the owner pages.

## If something goes wrong on camera

- **`unknown`, or a missing receipt.** That is not a failure. The script prints the payment ID. Rerun with the same ID (`RESUME_ROUTINE`, `RESUME_EXCEPTION` and `PENDING_FILE`, as `RUNBOOK.md` and the script's comments describe), or check the explorer. Never propose a new payment to retry.
- **A rate-limit or `-32005` error.** The public RPC rate-limits bursts. The setup page waits and retries by itself. For the script, put the fallback RPC URLs in `EREBUS_VAULT_RPC_URLS`, and pause between takes.
- **The owner does not sign in time.** The script waits `WAIT_SECONDS` (default 900) and then stops with "no owner signature arrived". Resume from the paused step with the `RESUME_*` variables, so the same payment IDs are kept, rather than starting a new run.
- **A wrong vault.** If the banner shows any address but `0xb3bc...3fb1`, stop and reconnect with `?vault=0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1`.

## If it runs over 4 minutes

Cut in this order: the setup page walk-through to one screen, the A2 and A3 explanations to one sentence, then the closing card to two lines. Do not cut the Studio shot or the reviewer shot.
