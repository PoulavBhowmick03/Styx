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

### vault-v2 upgrade (13 Nov 2026)

Redeployed in place (no state migration: the root state layout is unchanged) from commit `f0582f1`,
`contracts/near/build.sh` output, 330,426 bytes: deploy tx
[8QmtVfwZ…](https://testnet.nearblocks.io/txns/8QmtVfwZ3iynEbhr3fhVTFEcahWmBA62phWBaW3gdbVp). It binds
EVM approvals to the token (audit N-02) and lets only the paying agent post a record (N-04, partly).
No EVM request was in flight (`evm_pending` null). EVM approvals made before it no longer match.
The v1 vault `vault.styx-owner-c87a.testnet` was not redeployed.

## NEAR relay on Fly (13 Nov 2026)

`https://styx-relay-near.fly.dev` (app `styx-relay-near`, region `sin`, 1 GB volume for request
state). Secrets set with `flyctl secrets import`, never in the repo: `RELAY_TOKEN` (kept locally in
`~/.styx-near/relay-token-fly`), `TELEGRAM_BOT_TOKEN` (bot `@Styx_pvt_bot`),
`RELAY_PUBLIC_URL`, `APPROVAL_PAGE_URL` (`http://localhost:5173` until the approval page is deployed;
then set it to the page's https URL and add that origin to `ALLOWED_ORIGINS` in `fly.toml`).
`/health` answers `{"ok":true}`; requests from `wallet_test.sh` reach it. The earlier, pre-NEAR relay app on Fly
(`erebus-vault-relay`) belongs to another project and was left running.

## Site and relay origins (13 Nov 2026)

`styxco.xyz` (Vercel project `styx-approve`, built by `scripts/build_site.sh`) serves the landing page,
the approval page at `/approval/` and the owner console at `/console/`. The relay's
`ALLOWED_ORIGINS` is `https://styxco.xyz` only, and its Telegram links go to
`https://styxco.xyz/approval/`. The standalone Vercel projects used briefly that day were deleted.

## Per-approver Telegram links (13 Nov 2026)

The relay (commit `b8ea16f`, deployed to Fly the same day) polls `@Styx_pvt_bot`. An approver sends
`/start` in a private chat, opens the one-time link (`styxco.xyz/approval/?link=<code>`, page commit
`c31356b`), and signs a NEP-413 link message in Meteor. The relay then sends the alerts for that key
to that chat. There is no fallback chat: `TELEGRAM_CHAT_ID` was removed from Fly the same day, so an
approver who has not linked gets no alert (the agent sees `alerted: false` and still has the link). Links are stored in
`/data/relay/telegram-links.json` on the Fly volume. `/status` and `/unlink` in the bot.
