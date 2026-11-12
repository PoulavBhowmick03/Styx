# NEAR testnet deployments

All accounts are testnet. Keys live in `~/.near-credentials`, never in the repo.

| What | Account | Deploy tx |
| --- | --- | --- |
| Owner | `styx-owner-c87a.testnet` | faucet-created |
| Test token (NEP-141, 6 decimals, not Circle's USDC) | `usdc.styx-owner-c87a.testnet` | [3iDSsjCShEQKd3kPcbCChgjPxwE66bqCLvn6WKpg8wYb](https://testnet.nearblocks.io/txns/3iDSsjCShEQKd3kPcbCChgjPxwE66bqCLvn6WKpg8wYb) |
| Vault (`styx-vault` v1) | `vault.styx-owner-c87a.testnet` | [Hq22uExGZ3QcCh5vcYbnUMt38BhUT9QFup8UrQaXzKE5](https://testnet.nearblocks.io/txns/Hq22uExGZ3QcCh5vcYbnUMt38BhUT9QFup8UrQaXzKE5) |

Deployed 12 Nov 2026 from `contracts/near/build.sh` output (non-reproducible build, cargo-near 0.23).
