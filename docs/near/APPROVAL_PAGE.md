# NEAR approval page and relay

## Local run

Use Node 22 or later. From the repository root:

```sh
cd relay-near
npm ci
export RELAY_TOKEN='choose-a-local-token'
export RELAY_STATE_FILE=state/requests.json
npm start
```

In a second terminal:

```sh
cd approval-page-near
npm ci
npm run dev
```

The project-local .npmrc enables legacy peer resolution for Wallet Selector's dependencies.
Keep the token and state outside version control. The relay binds to 127.0.0.1:8788 by default;
PORT overrides the port. Use a TLS reverse proxy for remote hosting. Run only one relay process
per state file. Without RELAY_STATE_FILE, restart loses requests. State writes use temporary-file
rename before acknowledging; this is not a database or a power-loss durability guarantee.

Post `{ "pending": <pending file> }` to `POST http://127.0.0.1:8788/requests` with
`Authorization: Bearer <RELAY_TOKEN>` and Content-Type application/json. The response contains
requestId and alerted:false. Open:

```text
http://127.0.0.1:5173/?relay=http://127.0.0.1:8788&request=<requestId>
```

GET /requests/:id is public and returns `{pending,status}`. The page reads the six requested
vault views at one finalized block, checks versions, hash, message, limits and expiry, then offers
Wallet Selector. It supports Meteor inline signing and MyNearWallet redirect signing. Keep the
same browser tab for redirect signing. The redirect session records the exact callback URL and
checks the returned state. A mismatched wallet key is displayed and never posted.

POST /requests/:id/signature is public and verifies NEP-413 before storing. GET
/requests/:id/signature requires the bearer token; it returns pending or signed with the signature
file, or HTTP 410 after expiry. A duplicate signature POST returns 409. Public request reads
report expired status. Expired entries may be pruned on a later create, after which reads are 404.

**CLI integration:** when submitting pay_with_exception, copy signature.callbackUrl verbatim into
authorization.callback_url. The message view does not include callback_url, but the signed Borsh
payload does. The relay verifies the callback from the signature file. accountId is wallet metadata;
the signature proves possession of the named public key, not ownership of that NEAR account.

## Build and validation

```sh
(cd relay-near && npm test && npm run typecheck)
(cd approval-page-near && npm test && npm run typecheck && npm run build)
```

approval-page-near/dist is the static deployment output. Set the Vercel project root to
approval-page-near, build command npm run build, output directory dist.

Verified locally on 12 November 2026:

- Relay: 7 passing tests. A deterministic ed25519 key signs an independently manually encoded
  NEP-413 payload; the relay verifies it using Borsh encoding. Covers wrong key, nonce and message,
  callback tampering, acceptance with a callback, duplicate refusal, JSON restart persistence,
  expiry, bearer checks, expiry window, amount validation and HTTP request/signature endpoints.
- Page: 10 passing tests. Matching mocked chain views pass; changed versions, pause, recipient
  state, hash, message and expiry block approval. RPC errors propagate. A wallet key mismatch
  reports the actual key. Six-decimal amount formatting and unsupported rule rejection are checked.
- Both TypeScript checks and Vite static build passed. The wallet dependencies emit browser
  externalization/eval and large-bundle build warnings.
- Headless installed Chrome smoke checks: missing query gives a visible error; matching mocked
  relay/RPC responses render the payment and initialize Wallet Selector with the sign button
  visible and no uncaught page errors. These were manual tool-driven checks, not committed tests.

Not tested: a real wallet signature or redirect round trip, live NEAR RPC, deployed contract
integration, CLI signature consumption, testnet settlement, Vercel deployment, proxy deployment,
multi-process access, crash/power-loss recovery, load or abuse resistance. No Telegram alerts.
Signing and contract integration still need Poulav's review before being trusted, as PLAN.md requires.

## Trust and limits

The supplied RPC can fabricate view results. The page shows the RPC, vault and token so the
approver can check them independently. Network is the requested wallet network, not independently
attested by RPC. Six-decimal formatting does not establish that a token is genuine USDC.
Invoice text is unverified and rendered as text. Current daily spend, used nonces/payment IDs,
funding and successful settlement are not checked here; the contract enforces those conditions.
An approval lifts only the per-payment limit. It cannot guarantee payment succeeds later.
