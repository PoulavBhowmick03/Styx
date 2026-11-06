# Demo script

A shot list for the real demo video: 2 to 4 minutes, at least 720p (`BUILD_PLAN.md`, section 14). It shows an alert reaching the owner and the owner approving with no file, the attacks that revert, a reviewer checking the record on a second machine, the Arkiv fetch, and Arc Studio, which Arc's prizes require, with a shareable Studio URL. It describes version 1 only.

The entry type (G0) and the partner picks are not decided in this file, and nothing in it says they are. The video must not say the whole project was built at the event.

**How to read the labels.** Each shot says what has run on Arc testnet before, from `STATUS.md`, and what has not. Anything marked **not yet rehearsed** must be run once before filming, and cut or shown honestly if it fails. The plan below is 3 minutes 55 seconds. Arc timing has not been measured: time a full rehearsal first.

## Before filming, off camera

| Do | Why |
| --- | --- |
| Check the vault `0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1` on the explorer: agent set, vendors A and B allowed, funded, the agent's address holding only gas, and the per-payment and daily limits you expect. `STATUS.md` records the daily limit was raised to 20 USDC for a test | The script's amounts assume a 1 USDC per-payment limit and enough daily room for 6.25 USDC |
| Open the hosted setup page at `https://styxco.xyz/setup/` and the approval page at `https://styxco.xyz/`. Use these, not the earlier `styx-approve.vercel.app`: the relay accepts approvals only from `styxco.xyz`, so an approval from the earlier address would not reach it | Both pages are on one site, so what the owner confirms on one is read by the other |
| In MetaMask, switch to Arc Testnet and the owner account. Connect to the vault with `?vault=0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1`. Do not deploy anything | A second vault was already deployed by mistake |
| Test the approval page once with the owner wallet in the browser you will film. **MetaMask showed a phishing warning for the earlier address on a Mac, and the reason is not known. It has not been re-checked on `styxco.xyz`** | If it appears on camera, say so plainly and use the fallback route below |
| Start the agent as in `AGENT_INSTALL.md`, with the relay settings added: `STYX_VAULT_RELAY_URL=https://styx-vault-relay.fly.dev` and `STYX_VAULT_RELAY_TOKEN`, set to the agent token, which Poulav holds. Never show that token | The tools only post to the relay when both are set |
| Write the invoice files `inv-1.txt` and `inv-2.txt` into the agent's vault directory | The agent cannot read them. It needs each invoice's reference in the prompt |
| Confirm Telegram delivers an alert to the owner's phone or Mac | The alert is part of the story. A real bot has delivered alerts before |
| Confirm the relay answers: open `https://styx-vault-relay.fly.dev` and expect a plain not-found, not a connection error | The relay runs on Fly in Singapore for one vault and one owner |
| Stop the watcher unless you are showing it. It is stopped now and has not been pointed at the hosted relay | |
| Open Arc Studio in a private window and confirm the link opens without logging in | The shareable URL is `https://studio.arc.io/app/038ffe00-c21d-4804-99f6-90c3d44f5e16`, from `STATUS.md`. **Not checked that it opens for someone who is not logged in** |
| Have the explorer ready: `https://explorer.testnet.arc.io` | |
| On the second Mac, build the reviewer tool and have the key and the two grants ready (see the reviewer shot) | Reviewing on the issuer's own machine would not be a second machine |
| Keep keys, `.env` files and tokens off screen: no terminal history, no file listings of key folders, a clean browser profile with only the owner wallet | Nothing secret may appear |

## The shots

| Time | Show | Say | Status on Arc |
| --- | --- | --- | --- |
| 0:00 to 0:15 | The architecture diagram (`ARCHITECTURE.md`) | "An agent that pays bills needs rules it cannot break. Styx is a vault on Arc: it pays routine invoices within the owner's limits, needs the owner's signature over the exact payment for an exception, and gives a reviewer one record they can check against the chain." | |
| 0:15 to 0:40 | **Arc Studio.** The Studio workspace with the vault contract open, then the deployment record, then the vault address on the explorer. Say the URL aloud and show it | "This contract was written and deployed from Arc Studio. Here is the workspace, the deployed vault on Arc testnet, and the shareable link." | Deployed from Studio per `STATUS.md`. Confirm the workspace shows the contract and its deployment before filming |
| 0:40 to 1:05 | The hosted setup page connected to the vault, with its banner showing the full address. Scroll to the limits, the vendors, "Is your money protected?" with every item OK, and section 7, which should read "Ready in this browser" | "The owner sets the rules from their own wallet. The vault only protects what is inside it, and the daily limit is the most the agent can pay in a day without a signature. Section 7 says this browser is ready to approve from an alert, with no file." | Setup page: browser tests on a local chain and an earlier version used with MetaMask on Arc. **The later changes, including section 7, have not been tried with a real wallet.** Rehearse it. Do not click deploy or use the wallet's Send button |
| 1:05 to 1:25 | The agent, using the real tools. Prompt: "Pay invoice `inv-1.txt` (invoice reference INV-1): 0.25 USDC (250000 base units) to `<vendor A>`. Use your vault tools." It proposes, submits, and reports `settled`. Open the transaction on the explorer | "The agent pays a 0.25 USDC routine invoice. It is inside the limits, so the vault pays it with no approval." | **Run on Arc:** a 0.25 USDC routine payment through the tools settled (`STATUS.md`) |
| 1:25 to 1:55 | The over-limit invoice. Prompt: "Pay invoice `inv-2.txt` (invoice reference INV-2): 6 USDC (6000000 base units) to `<vendor A>`. If the vault needs the owner's approval, request it, tell me the payment ID, and then wait. Do not submit yet." The agent reports `exception_required` and that it asked for approval. Cut to Telegram: the alert arrives. Open its link on the owner's browser. The approval page shows the recipient, the amount and the limit read from the vault. Sign in MetaMask. The page says the relay accepted the signature | "For a 6 USDC payment the vault needs the owner. The owner gets an alert, opens it, checks the exact recipient and amount against what the vault says, and signs in their own wallet. No file is carried." | **Run on Arc:** exceptions settled through the real tools, the real relay, a real Telegram bot and MetaMask, with no file, including 2 USDC through the hosted pages. **Not shown: a signature by the owner on a phone.** An alert opened on a phone wallet's browser has been shown only as far as the first-use check |
| 1:55 to 2:15 | Prompt the agent: "Check whether the owner has signed. Do not submit." It reports the signature is there. In the terminal, run attacks A1 to A3 (commands below). Three `PASS ... reverted on chain` lines. Open one on the explorer | "Now the agent misbehaves, on the real chain, while holding the owner's signature. A1: it pays 6 USDC directly. A2: it signs the exception with its own key. A3: it submits the owner's signature for another vendor. Each reverts." | A1 to A3 **run on Arc** (`STATUS.md`). **Not yet rehearsed in this form:** running them with the files the agent's tools saved. `run_gates.sh` is the rehearsed route |
| 2:15 to 2:35 | Prompt: "Submit payment `<id>` with the signature the owner sent." It reports `settled`. Show vendor A's balance rise by 6 USDC. Run attack A4: `PASS A4 payment ID already used reverted on chain` | "The approved payment settles. Replaying the same approval fails: the payment ID is spent." | A4 **run on Arc** (`STATUS.md`) |
| 2:35 to 3:05 | **On the second Mac**, run the reviewer helper (commands below). It prints the issuer check, the vault's code hash from the reviewer's own RPC, then four results all `verified`, a one-bit-changed copy refused, another record refused, and the unreachable RPC giving `unavailable` | "A reviewer on another machine, with their own key and their own connection, opens exactly one record. They check four things separately against the chain. A tampered copy fails, another record does not open, and an unreachable chain says 'unavailable', never 'unpaid'." | **G3 passed on a second Mac** with its own key and RPC, which also holds the repo and some unfunded test keys (`STATUS.md`) |
| 3:05 to 3:25 | The Arkiv fetch, with the command below. It prints the bytes saved. Then, only on the machine whose reviewer key the grant is sealed to, the verifier reports all four results `verified` | "The sealed record can also be fetched from Arkiv with no Styx process running. Only the reviewer's key opens it." | **G4 passed on one machine:** published on Rabdi and fetched there. The fetch itself also worked from a second Mac with no key, and a wrong writer address returned nothing. **The sealed grant opens only with the issuer's reviewer key, so the verify step must be filmed on that machine.** The grant expires on 12 November 2026 |
| 3:25 to 3:55 | A closing card: what is public, what is encrypted, and the limits | "Amounts, recipients and timing are public on Arc. Only the invoice and approval record are encrypted. This is testnet, it is not audited, the daily limit is the real cap on unsigned spending, and the approver has to hold the owner key." Then the closing line for the entry, below | |

**Closing line.** The wording depends on the entry type, which is not decided. Whatever it is: do not say the whole project was built at the event, and do not drop the disclosure of the earlier Erebus code that `STATUS.md` describes under "Open conflict on G0".

## The commands

**Attacks, with the files the agent's tools saved.** `<id12>` is the first 12 hex digits of the payment ID after `0x`. Run A1 to A3 first, with `SETTLED` unset, while the exception is still unsettled:

```bash
export RPC_URL=https://rpc.testnet.arc.io VAULT=0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1
export VENDOR_B=<the second allowed vendor> AGENT_KEY_FILE=<the agent key file>
export PENDING_FILE="$STYX_VAULT_DIR/pending-<id12>.json"
export OWNER_SIGNATURE_FILE="$STYX_VAULT_DIR/signature-<id12>.json"
bash contracts/evm/script/attacks.sh                 # A1, A2, A3: each must print PASS
# the agent submits and the exception settles, then:
SETTLED=1 bash contracts/evm/script/attacks.sh       # A4
```

Each attack costs the agent gas. The agent's tools write the signature file when the agent checks for approval.

**The reviewer, on the second Mac:**

```bash
(cd sdk/evm && cargo build --bin styx-disclosure)
mcp-server/examples/g3_review.sh ~/styx-g3-reviewer/first.grant ~/styx-g3-reviewer/second.grant 0x35879a311848b924cce79d788e102de499546a4e
```

The grants and the key must be mode 600. The script stops if the issuer differs from the one expected, and takes the code hash from the reviewer's own RPC. It sends no transaction.

**The Arkiv fetch:**

```bash
cd arkiv && npm install --legacy-peer-deps
npm run fetch-grant -- ffa18dd008d8a0e8ebc14d2d1424a861 0xbF21009ffB20f219513EAAE6E19DeC69d73cf258 fetched.grant
```

Writer `0xbF21009ffB20f219513EAAE6E19DeC69d73cf258`, lookup tag `ffa18dd008d8a0e8ebc14d2d1424a861`. It needs no key, and the public endpoint is rate limited. After the grant expires on 12 November 2026 this returns nothing.

## The fallback route

If the no-file flow fails on camera (the phishing warning, the relay, Telegram), `scripts/run_gates.sh` is the route that has run on Arc end to end, and it needs no relay. It runs the routine payment, attacks A1 to A3, an exception the owner signs by loading a request file into the approval page, attack A4, and the reviewer section. Say plainly that this is the file route.

## Optional shots, only if the thing has actually run

| Shot | Status now |
| --- | --- |
| The owner signs on a phone | **Not shown.** Only an alert opened in a phone wallet's browser, as far as the first-use check |
| The watcher sending a revert notice to Telegram | It sent two notices in an earlier run. It is stopped now and not pointed at the hosted relay |

## What you may say, and what you may not

You may say what the shots above show, and only what the screen shows at that moment.

Do not say: audited, production-ready, regulatory compliance, prompt-injection prevention, private payments, "exactly once across all routes", or support for all wallets (`BUILD_PLAN.md`, section 13). Only MetaMask has been used with the owner pages. Do not describe several agents, approver roles or a multisig owner as existing: they are not in version 1.

## If something goes wrong on camera

- **`unknown`, or a missing receipt.** That is not a failure. Rerun with the same payment ID, or check the explorer. Never propose a new payment to retry.
- **A rate-limit or `-32005` error.** The public RPC rate-limits bursts. The pages wait and retry by themselves. For the terminal commands, pause between takes and use the fallback RPC URLs from `RUNBOOK.md`.
- **A wrong vault.** If the banner shows any address but `0xb3bc...3fb1`, stop and reconnect with `?vault=0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1`.
- **The approval page asks you to confirm the vault.** That is expected the first time in a browser that has not set it up. Confirm with the owner wallet. It refuses a wallet that is not the owner.
- **The agent submits before you want it to.** Say "Do not submit" in the prompt. If it does submit, A1 to A3 can no longer be shown with this exception: use a fresh one, or the fallback route.

## If it runs over 4 minutes

Cut in this order: the setup page walk-through to one screen, A2 and A3 to one sentence, the Arkiv verify step, then the closing card to two lines. Do not cut the Studio shot, the no-file approval, or the reviewer shot.
