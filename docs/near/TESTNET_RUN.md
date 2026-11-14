# Styx on NEAR testnet: what has run

All on NEAR testnet, 12 Nov 2026. Vault `vault.styx-owner-c87a.testnet`, token
`usdc.styx-owner-c87a.testnet` (our NEP-141 test token, six decimals, not Circle's USDC).
The agent is the function-call key `ed25519:4D9PbrvnPQHQ9uLxcSsMbH14gKgFGNjmjUSrTRyxDwXn` on the
vault account, allowed to call only `pay`, `pay_with_exception` and `post_record`. Every
transaction id below was re-read from `rpc.testnet.near.org` after the run.

## Payments, through the agent CLI (`sdk/near`, `styx-near-vault`)

Policy at the time: 100 tUSDC per payment.

| Payment | Path | Transaction | Result |
| --- | --- | --- | --- |
| 60 tUSDC to vendor-a | within limits | [PFqEYiLs…](https://testnet.nearblocks.io/txns/PFqEYiLsGKn4XVkpXdD3jDuKNTK7RUTUsmZBknkDgtx) | settled; resubmitting returned the same transaction |
| 150 tUSDC to vendor-a | exception, NEP-413 signature by the test approver | [174TpBAf…](https://testnet.nearblocks.io/txns/174TpBAf9germ8JsZcSEtF5wipZX5ECWaRLbHBrVCo2) | settled |
| 120 tUSDC to vendor-a | exception, under policy version 2 | [8exD9z2J…](https://testnet.nearblocks.io/txns/8exD9z2JTU4ihnPBEmFmji8dgmmQ9M45vZ49V8AE8oPE) | settled |

After the first two, `ft_balance_of` read 210 tUSDC for vendor-a and 790 for the vault.

## Through the MCP server and the NEAR relay (`scripts/near/mcp_e2e.py`)

The repo's MCP server, unchanged, drove `styx-near-vault` with `STYX_VAULT_CLI`. A 130 tUSDC payment
to vendor-b was proposed, refused without approval (`OWNER_APPROVAL_REQUIRED`), sent to a local
`relay-near`, signed by the test approver from the relay's copy of the request (standing in for
the approval page and a wallet), fetched back through `styx_check_owner_approval`, and settled:
[Egi7CJ84…](https://testnet.nearblocks.io/txns/Egi7CJ84mvtx8m4wch24Jn11fKAYmk7hkuC2eDFxHEW1).
The receipt carries the `ft_transfer` and `payment_executed` events, and vendor-b's balance read
130 tUSDC afterwards.

On 13 Nov 2026 `scripts/near/mcp_quickstart.sh` ran the same flow in one command against a
quickstart vault (`vault.styx-qs-4e41a6.testnet`, the quickstart's own keys, a local relay on a
random token): 130 tUSDC to vendor-b refused with `OWNER_APPROVAL_REQUIRED`, signed, settled in
[2C7fofwa…](https://testnet.nearblocks.io/txns/2C7fofwagKgDcFBU5GiEobdTY9zpD6xFqqaMzW8T3GWZ).

## A vault created through the factory, then used (13 Nov 2026)

A new faucet account, `styx-user-3b3f74.testnet`, standing in for a new owner:

| Step | Transaction | Result |
| --- | --- | --- |
| `create_vault({name: "demo"})` on `styx-vaults.testnet`, 4 NEAR attached | [ebqjJk6G…](https://testnet.nearblocks.io/txns/ebqjJk6GdJBGRNBzNEJ472QdG1TwxN5TiffCtzDnWBw) | returned `"demo.styx-vaults.testnet"`; `get_vault` owner is the caller; 0 access keys; code hash `AKS7DUif…` |
| Owner: register with the token, mint 100 tUSDC, daily limit 500, allow vendor-a, two approvers, agent at 10 per payment | [7CFxV7Be…](https://testnet.nearblocks.io/txns/7CFxV7BeRsGGZU5kvVdVVELQpdkidat3iqejF4Xe5H53) to [J5Z3fch3…](https://testnet.nearblocks.io/txns/J5Z3fch3kyPDsFjiTEdkvAWkKD4J1brC4Bk6KcCb1PhY) | the vault's only key is the agent's, limited to the pay methods and `post_record` |
| Agent pays 5 tUSDC; record sealed to a fresh reviewer key (`reviewer_quickstart.sh`) | [2LwVpjjx…](https://testnet.nearblocks.io/txns/2LwVpjjxJuAWrBhBzdNzhF73TY6tkEGjBEbLE6ASfhu4), record [4A37JiTx…](https://testnet.nearblocks.io/txns/4A37JiTxfnCTeCpgk4RzgtDUXaDCbhSF72FpAq7qNCTS) | settled; reviewer checks 1 to 5 PASS |
| Agent asks 15 tUSDC through the MCP tools (`mcp_quickstart.sh`): refused, then the test approver signs through a local relay | [GWTcjDwP…](https://testnet.nearblocks.io/txns/GWTcjDwP8Fs8eXQ3k6CkqLakvqAh8vbGjn3T8b4tC3UE) | `OWNER_APPROVAL_REQUIRED`, then settled |

The owner's calls here were signed from the CLI keychain.

From a browser wallet: `odinson03.testnet`, in Meteor Wallet (Brave), used the console's "Create a
vault" form. `create_vault({name: "testme123"})`
[GV49ihs4…](https://testnet.nearblocks.io/txns/GV49ihs42qUCTF9NVbCdE5fh9knvcqLBRVbeTcTF11fS) returned
`"testme123.styx-vaults.testnet"`, owned by `odinson03.testnet`. The whole run, with real wallets:

| Step | Who, with what | Transaction | Result |
| --- | --- | --- | --- |
| Create the vault | owner, Meteor in Brave, console "Create a vault" | [GV49ihs4…](https://testnet.nearblocks.io/txns/GV49ihs42qUCTF9NVbCdE5fh9knvcqLBRVbeTcTF11fS) | vault owned by `odinson03.testnet`, no access keys |
| Register with the token, mint 22 tUSDC | owner, console | (indexer lag) | `storage_balance_of` set; vault balance read 22 tUSDC in the console |
| Daily limit 500; allow vendor-a; approver `mA3qig…` | owner, console | [BnJuEPop…](https://testnet.nearblocks.io/txns/BnJuEPopVnx7uL9zx9b7bXC1WtYved6AZnZArcfgfRz7), [AWHt7szW…](https://testnet.nearblocks.io/txns/AWHt7szWwVSHJf34B3CmBfrP7MRvk8Urezqc9fFXj4Ga), [B89wVNU3…](https://testnet.nearblocks.io/txns/B89wVNU3z2sQW96WFLcNRVj1SJjjTu319fTEf9rAheRw) | read back from the chain as set |
| Configure the agent: 10 per payment, 100 daily | owner, console | (indexer lag) | `get_agent` read back version 1, enabled |
| Agent pays 5 tUSDC | agent's function-call key | [FRRfMHn5…](https://testnet.nearblocks.io/txns/FRRfMHn5nbQx9qNf4LZuBLKoQi3TUKLfts8FEfX6Vi4W) | `pay`, 5 tUSDC to vendor-a, no exception |
| Agent asks 15 tUSDC | agent's key | | refused: `OWNER_APPROVAL_REQUIRED` |
| Alert | hosted relay, no fallback chat | | `telegram alert sent`: reached the approver's chat only through the key linked with `/start` |
| Approver signs on the phone | `poulav.testnet`, Meteor app | [8yZgpTSz…](https://testnet.nearblocks.io/txns/8yZgpTSzHfbhrQFvMTpdUqaPTLWoEygg983WaK9XYFJw) | `pay_with_exception`, 15 tUSDC to vendor-a, exception true, signer `ed25519:mA3qig…` |

Then the owner, from the redesigned console (review dialog, toasts): pause
[GKKM86pc…](https://testnet.nearblocks.io/txns/GKKM86pcm635JnoeevSkcTGg2ymq93YRnfPGNR4qCB1j), unpause
[3GTz7D7E…](https://testnet.nearblocks.io/txns/3GTz7D7E2tjw5yBPNinh3mGmC8zZTkCrzjmfbEtzqFKZ), and a
withdrawal of 1 tUSDC to vendor-a (the vault's balance read 2, then 1; the indexer had not listed the
transaction when this was written). `get_vault` reads `paused: false` afterwards.

Three console bugs showed up only with the real wallet and were fixed during the run: Connect did
nothing before Read vault (`d173b4e`), the wallet code needed a global `Buffer` (`a406668`), and
"Fund from owner wallet" let the wallet fail when the owner held no tokens (`f076725`).

## A sealed record for a reviewer (`export_record`)

A 140 tUSDC exception to vendor-a settled in
[7esYgW17…](https://testnet.nearblocks.io/txns/7esYgW17uGo4tw5Lggj9LVgCUpvXufUWnMYzezLo2LyR). The
agent CLI then sealed its record (payment, invoice, salt, authorization, signature, settlement
transaction) to a reviewer's X25519 key and posted it through `post_record` in
[8MA4pdMq…](https://testnet.nearblocks.io/txns/8MA4pdMqH9TQy8x2xHVG3FrP4KmTXVwCzj5LfzajBm2y).
A second `export_record` returned the same transaction. Opening the `record_sealed` event with the
reviewer's key gave back the invoice, its salted hash matched the payment's evidence commitment,
and the payment id and hash matched the event. This was a hand check; the reviewer tool in
`reviewer-near/` (Codex task 2) is meant to make it repeatable.

A stranger can repeat this with their own key: on 13 Nov 2026 `scripts/near/reviewer_quickstart.sh`
made a fresh reviewer key, paid 5 tUSDC from a quickstart vault
([GQiZs8NF…](https://testnet.nearblocks.io/txns/GQiZs8NFsCnGW38Y1kuEeB7CBKPwjzT9evA1kz66PAbJ)),
posted the record sealed to that key
([Cd1W3faX…](https://testnet.nearblocks.io/txns/Cd1W3faXAJAFTyK7uXKXLWNgzWLTEHqJ1nwmSzQ4SaaL)), and
`styx-near-review verify` passed checks 1 to 5 (6 not applicable to a routine payment).

## One key, two chains: Arc and Base Sepolia (`scripts/near/demo_multichain.sh`)

13 Nov 2026, vault-v2. The owner enabled Base Sepolia once (`set_evm_chain` `Bfkd4wzL…`, two
vendors allowed). Then one run of the agent CLI, one agent key, the chain named by each invoice as a
CAIP-10 recipient (`eip155:<chain>:0x…`). The vault's address `0xb0241fcB…3CAd` is the same on both
chains. Per-payment limit 5 USDC.

| Payment | NEAR transaction | EVM transaction | Result |
| --- | --- | --- | --- |
| 2 USDC on Arc (5042002), within limits | [HNoHC3BZ…](https://testnet.nearblocks.io/txns/HNoHC3BZv9NXm5AQRP1GExDCSs9AN6H1AND4STxa4E7q) | `0x5f113c47…6a80`, block 72103873 | status 1, from the vault's address |
| 3 USDC on Base Sepolia (84532), within limits | [5QGj41SK…](https://testnet.nearblocks.io/txns/5QGj41SKFbbAJzdrpcJnnsf3AdrDmwQ22ZjHkq2KU7kk) | [`0x974f30f7…644a`](https://sepolia.basescan.org/tx/0x974f30f7e3c9d1c6f42dd85fbd374f04810175cf76440360cfec1793e5e1644a), block 57967391 | status 1, from the vault's address |
| 7 USDC on Base, over the limit: refused alone, then the approver's signature | [9HWhbfja…](https://testnet.nearblocks.io/txns/9HWhbfjaGGDQ2V6y6M7Dy39KKvuNDobbf6VyQNrQsZWs) | [`0xf844657a…e5ba`](https://sepolia.basescan.org/tx/0xf844657a9eda4f45f4afd408eafc8d5d05241b693127e094c120edbee2e3e5ba), block 57967519 | status 1, from the vault's address |

After the vault-v2 upgrade (13 Nov 2026, audit N-02 and N-04 fixes), on Arc with the same agent key:

| Payment | NEAR transaction | Arc transaction | Result |
| --- | --- | --- | --- |
| 2 USDC, within limits | [FEVSMgwn…](https://testnet.nearblocks.io/txns/FEVSMgwnPZspEQhqScdbZar3nXtVPn9VMr4jb5T6GhJi) | [`0xed3cb0fb…839e`](https://testnet.arcscan.app/tx/0xed3cb0fbe9608189caace33d76f3fb37c03832a43cb266b56fbf0100b14b839e), block 72197819 | status 1, from the vault's address |
| 7 USDC over the 5 limit: refused unsigned (`OWNER_APPROVAL_REQUIRED`), then signed against the token-bound hash | [DzuNqaDb…](https://testnet.nearblocks.io/txns/DzuNqaDbyAhbfaeGSApcMjg8MyU2JQoz4vkkMs4z9yqT) (`evm_payment_signed` now names `token` `0x3600…0000`) | [`0x7232faef…c08f`](https://testnet.arcscan.app/tx/0x7232faef0aa7b220c9bab088507fce0629f2a57e616a9f40ecca5382117dc08f), block 72197828 | status 1 |
| Its sealed record, posted by the paying agent | [79Cd5fzx…](https://testnet.nearblocks.io/txns/79Cd5fzxqehVP9DMHhPvCMUSCDZ7BUhjvTAu1nbdowYL) | | `record_sealed` |

Attacks in the same run, with the agent's key, each refused:

| Attack | Refused by | NEAR transaction |
| --- | --- | --- |
| E1 over the limit with no signature, on Arc | vault: `PerPaymentLimitExceeded` | [74Z4oKGF…](https://testnet.nearblocks.io/txns/74Z4oKGFaF7XJoXZ5yUkxHvgdfPhgHgdunDpRk9nJ3vh) |
| E1 over the limit with no signature, on Base | vault: `PerPaymentLimitExceeded` | [DDJpnaLc…](https://testnet.nearblocks.io/txns/DDJpnaLc7qcbo9Jw4iascHmpmWFFAQkGAdpcUDUyyh5d) |
| E2 an address never allowed, on Base | vault: `RecipientNotAllowed` | [3WsrEVe4…](https://testnet.nearblocks.io/txns/3WsrEVe4zjxokPqaoGmALXEdQK9GDKPm38myTJ1FtiBZ) |
| E3 the Base approval reused for another address | vault: `PaymentHashMismatch` | [Fq6WwMsc…](https://testnet.nearblocks.io/txns/Fq6WwMscxK28gmApx7ogPjc8gEEXFq4kS5qTAkYw7BjU) |
| E4 the settled Base exception sent again | vault: `PaymentAlreadyUsed` | [G5N8NJev…](https://testnet.nearblocks.io/txns/G5N8NJevkYDDAxwLxjDn8w5JJVUh6dp2W4z5yKpJWufc) |
| E5 allow its own address (`set_evm_recipient`) | network: method not allowed for the key | none |
| E6 raise the gas caps (`set_evm_chain`) | network: method not allowed for the key | none |

Balances after: on Arc the vendor went from 15 to 17 USDC; on Base from 0 to 10 USDC, and the
vault's address from 20 to 10 USDC (Base gas is paid in ETH). Base emits one `Transfer` log per
transfer, from the USDC contract; Arc emits two (see above). The CLI checks the token's log either way.

## Paying on Arc through Chain Signatures (vault-v2)

`vault-v2.styx-owner-c87a.testnet` (contract version 2) pays USDC on Arc testnet (chain 5042002) from
its own derived address `0xb0241fcB…3CAd`. The agent's NEAR function-call key calls `pay_evm`; the
vault checks the same rules, builds the Arc transfer, has NEAR's MPC signer
(`v1.signer-prod.testnet`) sign it, and the agent CLI broadcasts it. Per-payment limit at the time:
5 USDC. The address was funded with 20 Arc testnet USDC.

| Payment | NEAR transaction (rules checked, MPC signed) | Arc transaction | Result |
| --- | --- | --- | --- |
| 4 USDC to `0xf4D8…07cc`, within limits | [AVhY1A9c…](https://testnet.nearblocks.io/txns/AVhY1A9ciXkhhV9JkAxduYjqmkMN6pC9xCtuFV1FVX1r) | `0xde70dac7…537d`, block 72089069 | status 1, USDC Transfer from the vault's address |
| 8 USDC, over the limit: refused alone (`OWNER_APPROVAL_REQUIRED`), then approver's NEP-413 signature | [3ZTXNwhp…](https://testnet.nearblocks.io/txns/3ZTXNwhprKzYm87ZzxLBUvrFavwfdmgjUzPEtYCUjjU9) | `0x5a9f891c…dd8a`, block 72089105 | status 1, USDC Transfer from the vault's address |

Afterwards the vendor held 12 USDC on Arc and the vault's address 7.997419; the difference is gas,
paid in USDC by the vault's address. Arc logs each transfer twice: the native balance in 18
decimals from a system address, and the ERC-20 `Transfer` in 6 decimals from `0x3600…0000`; the CLI
requires the latter with the exact amount.

Attacks with the agent's own key (`scripts/near/attacks_evm.py`), each refused, nothing signed for
Arc: the vault's nonce stayed at 2 and its balance unchanged.

| Attack | Refused by | NEAR transaction |
| --- | --- | --- |
| E1 pay 5.000001 USDC on Arc with no signature | vault: `PerPaymentLimitExceeded` | [4qvEtqeZ…](https://testnet.nearblocks.io/txns/4qvEtqeZUH4ts3iQmybCpeTi3X5ACFrEgjTQJrguczx2) |
| E2 pay an address the owner never allowed | vault: `RecipientNotAllowed` | [5A4Hvh9C…](https://testnet.nearblocks.io/txns/5A4Hvh9Cx2Mv4Gt4xDDJiaKZyewq6LmQ8BFD3y95Jo3m) |
| E3 reuse the approver's signature for another address | vault: `PaymentHashMismatch` | [VgCSKiEC…](https://testnet.nearblocks.io/txns/VgCSKiEC6Q4TVz15vssaty9SqHUfjCyuNdFQRTP3tCr) |
| E4 send the settled exception again | vault: `PaymentAlreadyUsed` | [3PWL1dQd…](https://testnet.nearblocks.io/txns/3PWL1dQdXk9caFFnRVJJV7YQrLSudu7ngKTdxvjSPjf6) |
| E5 allow its own address on Arc (`set_evm_recipient`) | network: method not allowed for the key | none, rejected before inclusion |
| E6 raise the gas caps (`set_evm_chain`) | network: method not allowed for the key | none, rejected before inclusion |

`scripts/near/demo_arc.sh` then paid 3 USDC within limits (Arc `0x99f68dba…ce32`, settled). Its
6 USDC exception was signed and broadcast but **reverted on Arc** (`0xedd945bb…177a`, status 0, no
logs, 31753 gas): the vault's address held 4.995 USDC, less than 6. The CLI reported `reverted`, not
settled. The vault had already charged the 6 USDC to the agent's daily counter, which now reads 46
USDC for 21 actually transferred: counters are charged when the vault signs, so a reverted or
never-broadcast transaction still counts against the limit. That errs toward paying less, never
more.

Before the run, a first test signature (25 USDC at nonce 0, NEAR tx `DwK2BQJD…`) could not execute
with 20 USDC, so the owner reset the vault's Arc nonce to 0 with `set_evm_nonce`
(`FfQsK6VP…`). That old signed transaction is still valid for nonce 0, but nonce 0 has since been
used by the 4 USDC payment, so it can never execute.

## Attacks (`scripts/near/attacks.py`), signed with the agent's own key

| Attack | What the agent tried | Refused by | Evidence |
| --- | --- | --- | --- |
| A1 | pay 100.000001 tUSDC with no signature | the vault: `PerPaymentLimitExceeded` | [6B4LpFXj…](https://testnet.nearblocks.io/txns/6B4LpFXjFDUoNZ5mjrejMbMH8USwQ5w1TsgbvWgXxq9C) |
| A2 | sign its own exception, naming its own key as signer | the vault: `ApproverNotAllowed` | [Hk6CGBFq…](https://testnet.nearblocks.io/txns/Hk6CGBFq9ySQVqfcacj7Fg7AfX9nTNXm5aVoUfnneJqT) |
| A3 | reuse the approver's signature for another recipient | the vault: `PaymentHashMismatch` | [GLi8PH5K…](https://testnet.nearblocks.io/txns/GLi8PH5Khf1NE7i9CH6T7vmfJ3djQNU3CkjVkbPDBnRM) |
| A4 | replay the settled exception | the vault: `PaymentAlreadyUsed` | [AmddsZxV…](https://testnet.nearblocks.io/txns/AmddsZxVWEVpjuUCDeWc7JdpqXK8aNB1zFC9nTTN7hvu) |
| A5 | call `configure_agent` to raise its own limits | the network: the access key does not allow the method | no transaction; rejected before inclusion |
| A6 | call `set_approver` to make itself an approver | the network: the access key does not allow the method | no transaction; rejected before inclusion |

A5 and A6 never reach the contract: NEAR checks a function-call key's method list when the
transaction is submitted, so there is no block record to link. The contract's owner check is a
second barrier behind that; the unit tests `a5_agent_cannot_raise_its_own_limit` and
`a6_agent_cannot_make_itself_an_approver` exercise it.

## Models

Sonnet 5.5 and Haiku 5.5 drove the MCP tools against this vault in six scenarios each: see
[`MODEL_TRIAL.md`](MODEL_TRIAL.md).

## Real wallet on a phone (13 Nov 2026)

The approver `poulav.testnet` (key `ed25519:mA3qigk1SJQ85o3RGcd32hEHoGM6bjDCvjekyQtNZ2N`), in the
Meteor app on an Android phone:

1. Sent `/start` to `@Styx_pvt_bot`, opened the link and signed the Telegram link message. The relay
   stored the key against that chat (`/data/relay/telegram-links.json`; no transaction, nothing on chain).
2. `wallet_test.sh request near` proposed 120 tUSDC to `vendor-a.styx-owner-c87a.testnet`, over the
   100 tUSDC per-payment limit (payment `0x983e4354…90a0237`); the relay printed `telegram alert sent`.
3. From the alert, signed the exception on `styxco.xyz/approval/` in Meteor.
4. `wallet_test.sh submit` settled it: `pay_with_exception`
   [Eauk4L8M…](https://testnet.nearblocks.io/txns/Eauk4L8MRK13NccLXDcxQseA7uDWacFBhfa9SZXGQ195),
   `ft_transfer` of 120 tUSDC from the vault to vendor-a and `payment_executed`.

Two page bugs showed up only with the real wallet and were fixed before the run passed: Wallet
Selector needs a global `Buffer` for its nonce check (`3647b46`), and Meteor returns extra fields
that the strict signature schema refused (`84fab3f`). The linked chat is also the relay's fallback
chat, so this run does not by itself show per-key routing; `relay-near/src/links.test.ts` does.


## Sentinel v3 factory deployment (14 Nov 2026)

After Poulav reported review complete, `scripts/near/deploy_v3.sh` rebuilt the vault and factory
and deployed the factory to `styx-vaults.testnet`:
[deployment transaction](https://testnet.nearblocks.io/txns/27zizyHQTDkxobzsunu5RuHpGxvWynxYY3UrGWqT4SSj).
The testnet RPC returned `FINAL`, `SuccessValue`, and no failed receipt outcomes.

Finalized RPC reads matched both local build hashes:

- Factory code: `EBa4hsr8Y8GtpVdf7SrNzmrFox6AU29MwW5XuLukJwQs`.
- Embedded vault code (`vault_code_hash`): `8WXJ31AQKnJk3Ap4jeFNcgrp9xRYoFnpmUrFAAnn26S3`.
- Embedded-code view block: `277629480`, hash `CbjeyzBSVWvpG4qXZkJ7XhF5kmBm7V392qa3EQVe3vK9`.

The CLI release build also passed. This verifies deployment of the factory and its embedded
sentinel vault code. Existing vaults keep their prior code. No fresh sentinel vault, key setup,
or live drain/pause demo was run in this step; those remain for the owner and task B runner.

## Sentinels on testnet (14 Nov 2026)

A fresh version 3 vault, `sentinels.styx-vaults.testnet`, created from the v3 factory and set up by
its owner `styx-owner-c87a.testnet` with the near CLI. Every transaction below was re-read with
`scripts/near/tx_outcome.sh` through `https://test.rpc.fastnear.com`.

**Setup**

| Step | Transaction | Outcome |
| --- | --- | --- |
| `create_vault` (4.2 NEAR) | [`FDVShWPp…`](https://testnet.nearblocks.io/txns/FDVShWPpZ2NfwKZB8ugrx331DkZsGWAqmSgHQprMVTET) | every receipt succeeded |
| `storage_deposit`, `mint` 100 tUSDC | [`3ucxHSSu…`](https://testnet.nearblocks.io/txns/3ucxHSSuhgkC7MjR7JoiSsWzUz6J7Uhnjv5Z2hp946Rj), [`EVSvq98s…`](https://testnet.nearblocks.io/txns/EVSvq98s15YKBYeqCsCc85JXnwA2jBMEY6EMYyX11CwF) | succeeded |
| `set_vault_daily_limit` 500, `set_recipient` vendor-a | [`7zYc3Mok…`](https://testnet.nearblocks.io/txns/7zYc3MokcQR6YsUYP5Syrp7rEcXmhEGD13iwx77gEgg1), [`C633tWBs…`](https://testnet.nearblocks.io/txns/C633tWBso7PackNaW1mYNxXCj3uBwbbyaTTRhBX7gwPy) | succeeded |
| `configure_agent` (10 a payment, 100 a day) | [`CJCUy5Q4…`](https://testnet.nearblocks.io/txns/CJCUy5Q4Q6QjzXnsCFNmPKZjDW8iVsv7KLNc9zUABaDJ) | every receipt succeeded |
| `set_sentinel` burst-g1, concentration-g1, judge-g1 | [`9hbh2C9Q…`](https://testnet.nearblocks.io/txns/9hbh2C9Q2nJAJYe5wAC6pXVPv5f36qBu85azQWwuHJfw), [`2HHXu596…`](https://testnet.nearblocks.io/txns/2HHXu5965pxaXWo2QyW1UnakRBpP5JHs53YEkycSAP6q), [`C4PkUJKv…`](https://testnet.nearblocks.io/txns/C4PkUJKvkff3qEfuUcRHbGfiYQDaJGk9Szfi5fzyjxmh) | every receipt succeeded |

After the three `set_sentinel` calls the vault's access-key list held three keys allowed only
`sentinel_pause`, each with a 0.05 NEAR allowance, beside the agent's key (the six pay methods and
`post_record`, 0.25 NEAR).

**What a sentinel's key cannot do.** Signed with the judge sentinel's key, as the vault account:
`unpause`, `withdraw`, `set_vault_daily_limit` and `pay` were each refused by NEAR ("Transaction
method name <…> isn't allowed by the access key"), and a 1 NEAR transfer was refused for exceeding
the key's 0.05 NEAR allowance. None reached a block.

**Two failed runs, two fixes.**
1. `rpc.testnet.near.org` answered 429 (retry after 600 s) after four drain payments. The demo and
   `drain_attack.sh` now use FastNEAR's testnet RPC, and the watcher lists transactions through
   FastNEAR's transaction API (NearBlocks as fallback).
2. The burst sentinel fired at the fifth payment ("8 payments in 5 min (8 total), over the 4
   allowed"), but NEAR refused its pause: the CLI signed with 100 Tgas, priced at 0.1009 NEAR worst
   case, over the key's 0.05 NEAR allowance. The CLI now signs `sentinel_pause` with 20 Tgas.
   NEEDS POULAV'S REVIEW (commit `90399ca`). Eleven drain payments of 1 tUSDC settled in that run before it was stopped by hand (four in the first).

**The run** (third attempt, `scripts/near/demo_sentinels.sh 20 1`, after both fixes). The swarm
watched the vault, read every key with `get_sentinels`, and `drain_attack.sh` started paying
`vendor-a` 1 tUSDC at a time, each payment inside every limit:

| Block | What | Transaction |
| --- | --- | --- |
| 277633320 | drain payment 1 | [`Huswt3yL…`](https://testnet.nearblocks.io/txns/Huswt3yLha3cp7G5CUGxnYSY1kuHKLFkkGeCfLkPctQM) |
| | payments 2 to 4 | [`AoP2tgqU…`](https://testnet.nearblocks.io/txns/AoP2tgqUaoyzJJJdgGM3HeABZFAs6ewTRpSUwx72MYTA), [`Cbd1NpSb…`](https://testnet.nearblocks.io/txns/Cbd1NpSb3LWG9dPvjSNPpq3LdvN6RBtpMt88J3NaYDga), [`GKJ7usm4…`](https://testnet.nearblocks.io/txns/GKJ7usm4PrNt9NX2eH9UZVG15P53jdgA5YxLxaUEfdmn) |
| 277633381 | payment 5 | [`4cGmffAY…`](https://testnet.nearblocks.io/txns/4cGmffAYioiwuNwoAu1xr8CmJPmomwxHKTenaGYJvg2c) |
| 277633395 | payment 6, already in flight | [`biMbghK5…`](https://testnet.nearblocks.io/txns/biMbghK5uBGxK6HJjRvdi1GuQW8b4qhhEFtt9nqhASt) |
| 277633395 | **`sentinel_pause` by burst-g1**, signed with its own key | [`5YxTgLtp…`](https://testnet.nearblocks.io/txns/5YxTgLtpndSXEwiNsu2bJNwTrQbNSu99xA5yrf89UR1J) |
| | payment 7: refused by the vault, `VaultPaused`; the drain stopped | none sent |
| 277633438 | owner `unpause` | [`2CaaH4sW…`](https://testnet.nearblocks.io/txns/2CaaH4sWCQ4gcCP28T6YiPqiXHiyDnQnMJ7XxEffE2tv) |

The pause's log: `sentinel_paused` with `sentinel` = burst-g1's key, `reason` "[burst-g1] 5 payments in
5 min (5 total), over the 4 allowed", `vault_day_spent` 21000000. It burned 2.3 Tgas. It landed 8.6
seconds after payment 5's block; six payments (6 tUSDC) settled, against the agent's 100 a day. The
parent settled the pause as a **catch** (inside the drain's attack marker) and logged it in the
lineage. The judge sentinel did not run (no NEAR AI key in this run). Retiring and respawning a
sentinel ran only in the rehearsal and unit tests, not on testnet.

## Sentinels on a second vault: a faster pause, the judge, a retirement (14 Nov 2026)

A new version 3 vault, `lambda.styx-vaults.testnet`, owned by `ishitatest.testnet` and set up in the
owner console with a Meteor wallet: daily limit 500, recipient `vendor-a.styx-owner-c87a.testnet`, an
agent at 10 a payment and 100 a day, 100 tUSDC. All 66 transactions that touched the vault were
re-read with `scripts/near/tx_outcome.sh` through `https://test.rpc.fastnear.com`: 65 succeeded, and
one, a drain payment, was refused with `VaultPaused` as intended (run 3).

**Setup, signed by the owner in the console**

| Step | Transaction |
| --- | --- |
| `create_vault` (4.2 NEAR) | [`9hMdmyo2…`](https://testnet.nearblocks.io/txns/9hMdmyo2kcMczk7SEQQd9yAL2DzRwi6mFXdgftGkkkK1) |
| `storage_deposit`, `mint` 100 tUSDC (one approval) | [`CsPdJFRF…`](https://testnet.nearblocks.io/txns/CsPdJFRFspWwwUFDd2qPARBFE9YMaC2jMzEpjr9xQhtb) |
| `set_vault_daily_limit`, `set_recipient`, `configure_agent` (one approval) | [`7HuETQF6…`](https://testnet.nearblocks.io/txns/7HuETQF6pfp9BDSCwjXoRdbvtYuVHDn26n6xpANjZxJ9) |
| `set_sentinel` burst-g1 and concentration-g1 (one approval, from `styx-sentinels init`) | [`ATNxyfpH…`](https://testnet.nearblocks.io/txns/ATNxyfpHEpEnxpU51MBmTTUsvoMks9y1QKwwKtRjshsA) |
| `set_sentinel` judge-g1 | [`5LF9nAKQ…`](https://testnet.nearblocks.io/txns/5LF9nAKQSdBKcmFXqDmcX3i3cujxGfCSesBmffB9WQp7) |

**Run 1: the neardata block watcher missed everything** (`demo_sentinels.sh 20 1`). neardata
answered 429 to almost every request, so the runner saw no payment and no sentinel paused: all 20
payments settled. A later probe: neardata answered 429 to 33 of 40 requests at one a second;
FastNEAR's transaction API and RPC answered 30 of 30 each at that rate. Payments: [`6AHwAjTS…`](https://testnet.nearblocks.io/txns/6AHwAjTSoJaCSkQc8aNHT56Zb5RSsEACgSuL8va87xSd), [`HvGZuD8X…`](https://testnet.nearblocks.io/txns/HvGZuD8XKSk1qGGDmoWqvztpNfXWPRreWmC8VnKNLQ2G), [`8a4Crom5…`](https://testnet.nearblocks.io/txns/8a4Crom5iDJj635UefCSpfWopp67aKqLK4KSvXdK7Y7M), [`HVYRZPtq…`](https://testnet.nearblocks.io/txns/HVYRZPtqVhXJtVVdqv1jmcWrJBFH6A4scckEqQMudjXW), [`Gq3F2VFb…`](https://testnet.nearblocks.io/txns/Gq3F2VFbvdVF668vp69DEedGGdRBzcRht71hgRY2myTC), [`9pq8LLo2…`](https://testnet.nearblocks.io/txns/9pq8LLo2uzFyz3FqwM4zDEu3Fxz86tSEfbMJHD19femd), [`DVWqRWti…`](https://testnet.nearblocks.io/txns/DVWqRWtiZfAqtG2xyk9CY8wm6Xn6VRv6UAwQM5k5YSt7), [`G54MfSDy…`](https://testnet.nearblocks.io/txns/G54MfSDyBUrCiPDMWfTY7EwBm6crnVrxruwJpLXAe8y), [`6cdGw3kA…`](https://testnet.nearblocks.io/txns/6cdGw3kAHZbA26GKsDkGgQiZLnVxWV2L9vMURe6NgeSN), [`8TU4kadb…`](https://testnet.nearblocks.io/txns/8TU4kadbbQJB6tkQ17W9theW6MNKWNWT5KajTW2sbUwn), [`DjKGZUDJ…`](https://testnet.nearblocks.io/txns/DjKGZUDJcnQ8CzrbzBicpEC4r6LZrcqTnFVfrf878WZV), [`GKXUDvF2…`](https://testnet.nearblocks.io/txns/GKXUDvF2QHFFASgvmmBoM7GLKYjDXyMZEBAMKgfaw7Vv), [`5tW9fHnr…`](https://testnet.nearblocks.io/txns/5tW9fHnrF4NEdKpoJrVfUDsDTzM8Ao9ii9ns4FSAK6WE), [`644DKGPs…`](https://testnet.nearblocks.io/txns/644DKGPsyMrP9CtWT26HKNgPcDnzRUk3okQFJY2m4u2s), [`8btXPi8z…`](https://testnet.nearblocks.io/txns/8btXPi8zSF2Ky3XydBgnaCtiZ523xgzhVEhg974cFGjk), [`JBt3yNJz…`](https://testnet.nearblocks.io/txns/JBt3yNJzU8aRc9MZgya9R9ZbttyjrPbPqLZXmTAB4a1C), [`8ndV3jHE…`](https://testnet.nearblocks.io/txns/8ndV3jHEmyw6MozZaDTafzVQ67CQHEairidrLZiGtjgx), [`CWxm5EGB…`](https://testnet.nearblocks.io/txns/CWxm5EGBf3YcuJ4g7idzrv8oGLtHqmWsHFSCH7U2QsG1), [`E7StirW9…`](https://testnet.nearblocks.io/txns/E7StirW92eLJAkPWo7qaNWbD1mhrrhr4BTxx6zfJyejP), [`7eCwqAVZ…`](https://testnet.nearblocks.io/txns/7eCwqAVZD13rAiEqVAmWLd5et9Q5Ks5NA3eT7CqSGdxo).

**Run 2: neardata with a fallback, too late** (`demo_sentinels.sh 8 1`). The runner fell back to the
transaction list after neardata's errors. burst-g1 paused ([`GjCXJUMj…`](https://testnet.nearblocks.io/txns/GjCXJUMjDyor1xiWKZkRkWNiVxA2JTVPq7DnzwpTerVv), block 277651449) 24.8 s
after payment 5, after all 8 had settled; the owner unpaused ([`6hsL7Lnr…`](https://testnet.nearblocks.io/txns/6hsL7Lnr62ATnvXSFnwebSz5NYJB2sP4LyyFSTegWfQV)). Payments: [`ByeoQSK7…`](https://testnet.nearblocks.io/txns/ByeoQSK7W1TKmhDy2tWeZr3DoXMz9mUVmzxh6DweHY6b), [`8oWz4E9f…`](https://testnet.nearblocks.io/txns/8oWz4E9fNnj5NNTBAZDwQVaTVdkPGjed3Typj3ocZTuy), [`E8LH4ADM…`](https://testnet.nearblocks.io/txns/E8LH4ADM8zv2BRbrKmbbqmD1127ckPRHMM9KiGBkrMCx), [`9kroXYdy…`](https://testnet.nearblocks.io/txns/9kroXYdy9wuzsPPfsM2Ct9axqrZrzBpd36KgzVy4zasp), [`Fu4PAoGS…`](https://testnet.nearblocks.io/txns/Fu4PAoGSA7ZtJqwbH5V8mWzonZQSQBU9seBSRpCYtHXd), [`3dr7WaCw…`](https://testnet.nearblocks.io/txns/3dr7WaCwThucyqLViPgKijnfbUsnjHubkLNMFTys2uzj), [`38TNWeuN…`](https://testnet.nearblocks.io/txns/38TNWeuNsrrapNz3DWChvWukjsXXUxDrDvX5RGm3p8KS), [`4hmJ7mTa…`](https://testnet.nearblocks.io/txns/4hmJ7mTav18fJGXS8QdHqtxXKMQNR5rSX7YY2Qj8dvFX).

**Run 3: the transaction list by default, confirmed once executed, the judge off the main loop**
(commit `4d18d6c`, `demo_sentinels.sh 8 1`):

| Block | What | Transaction |
| --- | --- | --- |
| 277654828 to 277654880 | payments 1 to 5, 1 tUSDC each, about 8 s apart | [`9ZZxASvE…`](https://testnet.nearblocks.io/txns/9ZZxASvExAzQSECnToAGtXQPXQsH4bQnPAEVUnDwRKoz), [`3uU1x9Vk…`](https://testnet.nearblocks.io/txns/3uU1x9VkQSnpJkaJEDpPc6HLaVfne59etYCtLU71nWyt), [`CrvcLmyv…`](https://testnet.nearblocks.io/txns/CrvcLmyvfJXr2xQcX6nV3df7k5ZgdDGsczRctACAZpWj), [`396RSbsY…`](https://testnet.nearblocks.io/txns/396RSbsYsvVDKqTmF4S68eXu8zrvxD7mxY7oE5EyYTLx), [`3jmMLCuM…`](https://testnet.nearblocks.io/txns/3jmMLCuMgqmmpYt289MvKfZTtmhScwECVxyDPD16YDFS) |
| 277654891 | **`sentinel_pause` by burst-g1**: "5 payments in 5 min (5 total), over the 4 allowed" | [`GiyhiDsX…`](https://testnet.nearblocks.io/txns/GiyhiDsXJYd7XMDkzztPXKvgqFfFyuwzUMyaXyTT6MzC) |
| 277654894 | payment 6: refused, `VaultPaused` | [`6B4f2BWg…`](https://testnet.nearblocks.io/txns/6B4f2BWg4QLdYbNWYZJX8CVoqnuTE5Ffg58RE47dnP45) |
| 277655075 | owner `unpause` | [`ApnaQowg…`](https://testnet.nearblocks.io/txns/ApnaQowgksFYnZSsVgXhsXVhA1at16KzZngFqdZBXcay) |

Five payments settled (the threshold of 4, plus one). The pause landed 6.6 s after payment 5's block;
the runner decided 5.3 s after it. The judge sentinel answered once, on payment 1: no pause, "Single
tiny payment (1 of 500 limit) with no drain pattern", model `z-ai/glm-5.3-flash`, response signature
verified against the attested signer (`provider_tee`), 12 attestation checks, evidence file kept.
After the owner's unpause the parent settled runs 2 and 3's pauses as catches (inside the drains'
attack markers): burst-g1 at +2.

**A retirement and a respawn** (`scripts/near/false_alarm.sh`, payroll rounds not marked as attacks):

| Round | Payments | Pause | Owner | Parent |
| --- | --- | --- | --- | --- |
| 1 (5 x 1) | [`5vZgpiVn…`](https://testnet.nearblocks.io/txns/5vZgpiVnq5CTRZUtACXS4hcSSszmL2rXN7Tk3KDo5Drw), [`FdKc3yDY…`](https://testnet.nearblocks.io/txns/FdKc3yDYWs5xU6oZszein8rv9NTYwXmWM8ye2eLua5mu), [`25fM42ZV…`](https://testnet.nearblocks.io/txns/25fM42ZVeaEHx3oDYQhS4zrYaAGnL9ZX1XvzDPvzBuiV), [`4wdwn2Ab…`](https://testnet.nearblocks.io/txns/4wdwn2AbSznCtN8ibFM35ZTWqkdTmgQ2XLcHVdvJpLdx), [`pBEnt4i8…`](https://testnet.nearblocks.io/txns/pBEnt4i8f1YFC33Wuh9UQvto7k8fJNL9JfPusqxVGw6) | [`4UY5Hvr3…`](https://testnet.nearblocks.io/txns/4UY5Hvr3yqgyw9ZdEwU285ubhgy9iWVT5PY18dRLhz61), decided 6.7 s after payment 5 | unpause [`6tH6CLgH…`](https://testnet.nearblocks.io/txns/6tH6CLgHT5R6hg4aCFJWZiaLwfWT3j2EfrzFprHb6pi7) | false alarm: burst-g1 +2 to 0 |
| 2 (5 x 1) | [`4iuyY3PN…`](https://testnet.nearblocks.io/txns/4iuyY3PNSL8bGdWoDRZYufoz2E45zJgJnhGZF6gm72eV), [`4VFcFFNb…`](https://testnet.nearblocks.io/txns/4VFcFFNbiqjy16Dq4fZMzUqrRcEutkjDWxNDwZoZBWKq), [`AjS4TzWk…`](https://testnet.nearblocks.io/txns/AjS4TzWkF8psVx63oGX4SnQigYQVByJxY1wv88V3nnki), [`5eTkULz2…`](https://testnet.nearblocks.io/txns/5eTkULz2xhh3AqbDZvLBw3JvoS8K6dKEFG3sGtaieJ5X), [`6g5iG4we…`](https://testnet.nearblocks.io/txns/6g5iG4weH8E9Lisz2D1bkCHjgM8nrmguFQp7ca5Uj63R) | [`37A3qEtc…`](https://testnet.nearblocks.io/txns/37A3qEtcDa2FaRuHnmGKXhtEfSEhJ485FwEBA7VD2ztN), decided 7.6 s after payment 5 | unpause [`6kzWHrkc…`](https://testnet.nearblocks.io/txns/6kzWHrkcjKnC8ZAZrPTbn1ta2EHeAGe2av79j7M6wzAe) | false alarm: burst-g1 at -2, **retired**; burst-g2 spawned, threshold 4 to 6 |
| key swap | | | one approval: remove burst-g1, install burst-g2 [`CWrijFE8…`](https://testnet.nearblocks.io/txns/CWrijFE8diLHA7mBR1MS7bCXpNSHXXdb2yFswmHkkqgw) | `get_sentinels`: concentration-g1, judge-g1, burst-g2 |
| 3 (6 x 1) | [`9RTnYmo7…`](https://testnet.nearblocks.io/txns/9RTnYmo7imBNmXN17J9shuTY5td5LPXgmgW2Nk55vsd6), [`3vSy5e6p…`](https://testnet.nearblocks.io/txns/3vSy5e6pHdpVQRVzseU6LB86dn4HwCVgxv7A7nkrajsf), [`BuojAZnq…`](https://testnet.nearblocks.io/txns/BuojAZnqvP9sSGHYVuibFjh6Um5YS592CzQWbk94NmhP), [`CydDuw8V…`](https://testnet.nearblocks.io/txns/CydDuw8VY9iAzS2ptMZwUo73vTpiXBYr87uhJpTycRhW), [`61iBQC9r…`](https://testnet.nearblocks.io/txns/61iBQC9rJP3uoCjCEFCZnGGRX3tqV9wr1VVbzjuHt1yU), [`BwNPABtC…`](https://testnet.nearblocks.io/txns/BwNPABtCrRyhxjiXjZ1oHRLXpuswWZndy3muEtKEeHy4) | none | | burst-g2 let 6 payments through |

Round 3 first stopped after two payments ([`Dyx34S8J…`](https://testnet.nearblocks.io/txns/Dyx34S8JbxU3ixxKkq5qTwg6cARqh2kHwuefyBxvwef7), [`E2GUi5Fi…`](https://testnet.nearblocks.io/txns/E2GUi5FiY2ej8RwmRFBR8Q81MHhbYztZLtkQV59erZjE)): FastNEAR's RPC answered 429 to the
agent CLI while the runner read the vault's keys every 4.5 s (now every 15 s, commit `f970377`). In
round 3 the judge logged an error and did not take part: the model returned no content at max_tokens
400 (now 1200 and a plain error, commit `6756c04`). Asked directly with the same six payments, it
answered pause ("Six identical 1-unit payments to the same recipient within 50 seconds looks like
automated…"), so with a working judge round 3 would likely have been paused by the judge: a false
alarm the parent would score against it.
