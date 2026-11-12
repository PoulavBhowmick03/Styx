# NEAR testnet deployments

All accounts are testnet. Keys live in `~/.near-credentials`, never in the repo.

| What | Account | Deploy tx |
| --- | --- | --- |
| Owner | `styx-owner-c87a.testnet` | faucet-created |
| Test token (NEP-141, 6 decimals, not Circle's USDC) | `usdc.styx-owner-c87a.testnet` | [3iDSsjCShEQKd3kPcbCChgjPxwE66bqCLvn6WKpg8wYb](https://testnet.nearblocks.io/txns/3iDSsjCShEQKd3kPcbCChgjPxwE66bqCLvn6WKpg8wYb) |
| Vault (`styx-vault` v1) | `vault.styx-owner-c87a.testnet` | [Hq22uExGZ3QcCh5vcYbnUMt38BhUT9QFup8UrQaXzKE5](https://testnet.nearblocks.io/txns/Hq22uExGZ3QcCh5vcYbnUMt38BhUT9QFup8UrQaXzKE5) |

Deployed 12 Nov 2026 from `contracts/near/build.sh` output (non-reproducible build, cargo-near 0.23).

## vault-v2: Chain Signatures (contract version 2)

| What | Value |
| --- | --- |
| Vault | `vault-v2.styx-owner-c87a.testnet`, deploy tx [CoRFUnqJ…](https://testnet.nearblocks.io/txns/CoRFUnqJ4tcsog4SZZWmzR7hM35hh9qRcuMXipoUkU42) |
| MPC signer | `v1.signer-prod.testnet`, path `styx-evm`, domain 0 |
| Vault's address on Arc testnet | `0xb0241fcBD5A1D9D79a37C927559186eD08563CAd` |
| Arc chain settings | chain 5042002, USDC `0x3600…0000`, max fee 200 gwei, priority 1 gwei, gas limit 120000 |
| Allowed EVM vendors | `0xf4D88218d13333247BF7616AFFb45F24a21E07cc`, `0x14E823AE14720657A7B90429797A5Ea4636e1291` (addresses only; nobody holds their keys) |
| Agent | the same function-call key, here allowed `pay`, `pay_with_exception`, `pay_evm`, `pay_evm_with_exception`, `post_record` |
