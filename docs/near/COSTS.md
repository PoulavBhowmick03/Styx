# What Styx costs to run, and who pays

Measured on NEAR testnet on 13 Nov 2026 from the transactions in [`TESTNET_RUN.md`](TESTNET_RUN.md):
gas burned summed over the transaction and all its receipts (`EXPERIMENTAL_tx_status` on the
archival RPC), and state read with `view_state` on `vault.styx-owner-c87a.testnet`. NEAR amounts
are in NEAR, not dollars. Testnet and mainnet gas prices can differ; the gas units do not.

## Per payment

| Action | Example | Gas | NEAR burned | Paid by |
| --- | --- | ---: | ---: | --- |
| Pay within limits | [PFqEYiLs…](https://testnet.nearblocks.io/txns/PFqEYiLsGKn4XVkpXdD3jDuKNTK7RUTUsmZBknkDgtx) | 8.1 Tgas | 0.00074 | the vault account (the agent's function-call key spends the vault's balance, within its allowance) |
| Pay with an approver's NEP-413 signature | [Eauk4L8M…](https://testnet.nearblocks.io/txns/Eauk4L8MRK13NccLXDcxQseA7uDWacFBhfa9SZXGQ195) | 9.0 Tgas | 0.00083 | the vault account; the approver signs off chain and pays nothing |
| Post a sealed record | [8MA4pdMq…](https://testnet.nearblocks.io/txns/8MA4pdMqH9TQy8x2xHVG3FrP4KmTXVwCzj5LfzajBm2y) | 3.2 Tgas | 0.00030 | the vault account |
| Pay on an EVM chain within limits (Arc) | [HNoHC3BZ…](https://testnet.nearblocks.io/txns/HNoHC3BZv9NXm5AQRP1GExDCSs9AN6H1AND4STxa4E7q) | 16.6 Tgas | 0.00157 | the vault account, plus 1 yoctoNEAR attached to `v1.signer-prod.testnet` `sign` |
| Pay on an EVM chain with a signature (Base) | [9HWhbfja…](https://testnet.nearblocks.io/txns/9HWhbfjaGGDQ2V6y6M7Dy39KKvuNDobbf6VyQNrQsZWs) | 17.3 Tgas | 0.00164 | as above |

The EVM transaction itself pays destination gas from the vault's derived address
(`0xb0241fcB…3CAd`), which must hold the chain's gas token. The CLI broadcasts it; the vault caps
gas per chain (`set_evm_chain`), but there is no aggregate gas budget across payments.

## State that stays

Each payment leaves state the vault keeps for good, so a payment id can never pay twice. Measured
bytes per entry, including NEAR's 40-byte per-key overhead:

| Entry | When | Bytes | NEAR locked (10^19 yoctoNEAR per byte) |
| --- | --- | ---: | ---: |
| Consumed payment | every payment | 143 | 0.00143 |
| Consumed approval nonce | every exception | 110 | 0.00110 |
| Record slot | every sealed record | 148 | 0.00148 |
| Daily spend counters | per agent per UTC day, and per vault per day | 102 and 65 | 0.00102 and 0.00065 |

So an exception with a record locks about 0.004 NEAR, from the vault account's balance. There is no
cleanup method yet: storage grows with payment count (roadmap: prune entries past `valid_until`).

The contract code is 328,194 bytes (`styx_vault.wasm`), which locks about 3.28 NEAR on the vault
account when deployed. The owner pays that once, and the owner's configuration calls.

## Off chain

| Piece | What runs | Paid by |
| --- | --- | --- |
| Relay | one Fly machine, `shared-cpu-1x`, 256 MB, always on, 1 GB volume (`relay-near/fly.toml`) | whoever operates the relay; billed by Fly, not measured from an invoice here |
| Pages | static files on Vercel (`styxco.xyz`) | the site operator |
| Telegram alerts | Bot API `sendMessage` | free |
| Agent's model in NEAR AI Cloud | 3 to 5 attested completions per payment in our runs (`z-ai/glm-5.3-flash`) | the holder of `NEARAI_API_KEY`. Token counts are not in the evidence files, so this cost is not measured here |

No piece of Styx needs a server that holds keys: the relay can be run by anyone, and the vault does
not depend on it.
