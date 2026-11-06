# Styx

Payment controls with verifiable evidence on Arc testnet. Work in progress.

See `docs/mumbai/BUILD_PLAN.md` for the plan.

## Arkiv

Reviewers can fetch an encrypted payment record from Arkiv's Rabdi testnet with no other process running. See `arkiv/schema.md`.

```bash
cd arkiv && npm install --legacy-peer-deps
ARKIV_PUBLISHER_KEY_FILE=... ARKIV_ACCESS_KEY=... npm run publish-grant -- payment.grant
npm run fetch-grant -- <lookup-tag> <writer-address> fetched.grant
```

**Writer address:** none yet; nothing has been published.

## World

Optional step-up authentication in front of the owner signing page, enabled with `VITE_WORLD_GATE=1`. A denied, cancelled or expired attempt never reaches the wallet.

World's Mumbai proofs are mocked and use fake identities. The contract never checks World; the owner's signature is what authorizes a payment. It has not yet run against World's live service. See `world/debrief.md`.

```bash
cd owner-page && npm install --legacy-peer-deps
WORLD_CLIENT_ID=... WORLD_CLIENT_SECRET=... WORLD_REDIRECT_URI=... npm run world-gate
VITE_WORLD_GATE=1 npm run dev
```
