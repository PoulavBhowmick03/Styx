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
