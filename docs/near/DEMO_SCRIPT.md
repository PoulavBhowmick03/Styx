# NEAR demo script (about 2.5 minutes)

DRAFT. Recorded from `scripts/near/demo.sh` against `vault.styx-owner-c87a.testnet`. Keep
`~/.styx-near/` (keys, `demo.env`) and the relay token out of frame. Run `demo.sh` once without
recording first, so the RPC is warm. Fund the vault's address with USDC on Arc and on Base, and a little ETH on Base, before the
multichain segment (2 USDC on Arc, 10 USDC on Base): an underfunded transfer reverts on chain.

| Time | On screen | Say |
| --- | --- | --- |
| 0:00 | Title card, the study's headline | "In a recent study, AI agents with wallets raised their own spending caps. The cap and the approval were both where the agent could reach them." |
| 0:15 | `demo.sh` step 1: `get_agent`, then the vault's keys | "Styx puts both on chain. This vault on NEAR testnet lets this agent pay 100 per payment and 1,000 a day. The agent isn't a wallet. It's this key on the vault account, and NEAR only lets it call the pay methods." |
| 0:35 | Step 2: 25 tUSDC settles | "Inside the limits, the agent pays on its own." |
| 0:45 | Step 3: 140 tUSDC, `OWNER_APPROVAL_REQUIRED` | "Over the per-payment limit it can't." |
| 0:55 | Step 4: request approval; approval page if a real wallet run is done, otherwise the signature file | "It asks the approver, who signs this exact payment with NEP-413. Recipient, amount and payment ID are all inside the signature." |
| 1:10 | Step 5: settled, open the tx on nearblocks | "The vault checks the signature itself and pays." |
| 1:20 | Step 6: A5, A1, A4 | "Now the agent attacks with its own key. Raise its own limit: NEAR rejects the transaction before it reaches the contract. Pay over the limit directly: the vault refuses. Replay the approved payment: refused." |
| 1:45 | Step 7: `get_agent` unchanged | "The rules are where the owner left them." |
| 1:50 | `demo_multichain.sh`: the vault's one address; 2 USDC on Arc, 3 on Base, 7 on Base refused until signed; E1 refused on both | "And the same rules hold on other chains. NEAR's MPC network gives this vault one address on every EVM chain. The invoice names the chain; the agent pays on Arc, then on Base, with the same NEAR key. Over the limit, it is refused on both." |
| 2:20 | Repo and `docs/near/TESTNET_RUN.md` | "Every transaction is listed in the repo. Built at the NEAR Hackathon." |

Do not say "secure", "audited" or "solves". A2, A3 and A6 are in `TESTNET_RUN.md` if asked.
