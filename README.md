# Styx

Payment controls with verifiable evidence on Arc testnet. Work in progress.

See `docs/mumbai/BUILD_PLAN.md` for the plan.

Run it with `docs/mumbai/RUNBOOK.md`. `scripts/local_demo.sh` rehearses the whole flow on a local chain.

## Live on Arc testnet

- **Vault:** [`0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1`](https://explorer.testnet.arc.io/address/0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1), deployed from [Arc Studio](https://studio.arc.io/app/038ffe00-c21d-4804-99f6-90c3d44f5e16). Not audited. Test funds only.
- **Evidence:** the routine payment, the owner-approved exception and attacks A1 to A4 ran as real transactions. Hashes are in `docs/mumbai/STATUS.md`.

## Arkiv

Reviewers can fetch an encrypted payment record from Arkiv's Rabdi testnet with no other process running. See `arkiv/schema.md`.

```bash
cd arkiv && npm install --legacy-peer-deps
ARKIV_PUBLISHER_KEY_FILE=... ARKIV_ACCESS_KEY=... npm run publish-grant -- payment.grant
npm run fetch-grant -- <lookup-tag> <writer-address> fetched.grant
```

**Writer address:** `0xbF21009ffB20f219513EAAE6E19DeC69d73cf258`

**One query to run,** which needs no key and returns one encrypted record, or nothing once it expires on about 14 November 2026:

```bash
cd arkiv && npm install --legacy-peer-deps
npm run fetch-grant -- 2da3058148c284654bd85b1a670a3ce9 0xbF21009ffB20f219513EAAE6E19DeC69d73cf258 fetched.grant
```

It is sealed to one reviewer, so only that reviewer's key can open it.

## World

Optional step-up authentication in front of the owner signing page, enabled with `VITE_WORLD_GATE=1`. A denied, cancelled or expired attempt never reaches the wallet.

World's Mumbai proofs are mocked and use fake identities. The contract never checks World; the owner's signature is what authorizes a payment. It has not yet run against World's live service. See `world/debrief.md`.

```bash
cd owner-page && npm install --legacy-peer-deps
WORLD_CLIENT_ID=... WORLD_CLIENT_SECRET=... WORLD_REDIRECT_URI=... npm run world-gate
VITE_WORLD_GATE=1 npm run dev
```
