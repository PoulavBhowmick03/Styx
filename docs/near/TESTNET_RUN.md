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

## Not yet run

- The approval page with a real wallet (Meteor or MyNearWallet). The relay has run locally only.
- A model driving the MCP tools on NEAR.
- Hostile-invoice model trials on NEAR.
