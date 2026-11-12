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

## Not yet run

- The approval page with a real wallet (Meteor or MyNearWallet). The relay has run locally only.
- Hostile-invoice model trials on NEAR.
