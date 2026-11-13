# NEAR approval page and relay

> **13 Nov 2026:** MyNearWallet shut down in October 2026, so both pages now offer only Meteor Wallet. Mentions of MyNearWallet below are historical.

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

Initial NEAR-only validation on 12 November 2026 (EVM extension results below):

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

Not tested in that initial run: a real wallet signature or redirect round trip, live NEAR RPC, deployed contract
integration, CLI signature consumption, testnet settlement, Vercel deployment, proxy deployment,
multi-process access, crash/power-loss recovery, load or abuse resistance. No Telegram alerts at the time;
per-approver Telegram links came later (link mode, `?link=<code>`; see `relay-near/README.md`).
Signing and contract integration still need Poulav's review before being trusted, as PLAN.md requires.

## Trust and limits

Since 13 November the page reads through its own RPC per network, not the RPC named in the request
(which the agent supplies); it shows both. That RPC is still trusted: the page is not a light client.
The page shows the vault and token so the approver can check them independently. Network is the requested wallet network, not independently
attested by RPC. Six-decimal formatting does not establish that a token is genuine USDC.
Invoice text is unverified and rendered as text. Current daily spend, used nonces/payment IDs,
funding and successful settlement are not checked here. Native NEAR transfers are enforced by the
contract/token; EVM funding and settlement require separate destination-chain verification.
An approval lifts only the per-payment limit. It cannot guarantee payment succeeds later.

## EVM approvals on vault-v2 (13 November 2026, IST)

The same page and relay now accept both payment shapes under styx-near-pending/1:

- NEAR: chainId is absent or null; payment includes token and a NEAR account recipient. Native
  payments work on contract versions 1 and 2.
- EVM: chainId is a non-null JSON number matching payment.chain_id. payment is the contract's
  EvmPayment, with a lowercase 0x address recipient and no token field. EVM payments require
  contract version 2. Chain IDs must be non-negative safe integers to avoid silently rounding
  the contract's u64. Conflicting chain IDs and mixed payment shapes are rejected.

For EVM, the page calls evm_payment_hash, get_evm_recipient {chain_id,recipient}, and
get_evm_chain {chain_id}, alongside the shared vault/agent/approver/message views. Reads remain
pinned to one finalized block per review. A disabled/missing chain, invalid token address,
recipient denial/version change, hash/message mismatch or shared policy refusal blocks signing.
The page clearly shows the EVM chain ID, current ERC-20 token address and EVM recipient.
The top-level pending.token is still the NEAR token account emitted by the CLI; it is checked
against get_vault.token and is not displayed as the EVM asset.

NEP-413 is unchanged: exact exception_message text, approval_nonce bytes, recipient equal to
the NEAR vault account, and the exact callback URL actually signed. The EVM recipient is never
used as the NEP-413 recipient. The relay applies the same expiry/auth/duplicate/signature rules
and does not query chain state. It verifies that the signature matches the file's message;
the page's contract hash readback binds that message's authorization to the displayed payment.

The token and gas settings are not committed by EvmPayment. The page labels the token as current
chain configuration; if its recheck observes a token change, it hides signing and requires a
reload/review. The token seen before a redirect is retained with the public redirect context and
compared on return too. This does not freeze contract configuration after approval. The page
also explains that EVM approval authorizes MPC signing, not proof of inclusion or settlement.
Daily counters charge on signing; gas is outside the payment limits under the configured caps.

### Fixture provenance and tests

Each package has test/vault-v2.json captured from public FastNEAR testnet RPC on 12 November UTC
(13 November IST). The request is reconstructed from the real pay_evm_with_exception transaction
[3ZTXNwhp…](https://testnet.nearblocks.io/txns/3ZTXNwhprKzYm87ZzxLBUvrFavwfdmgjUzPEtYCUjjU9)
on vault-v2.styx-owner-c87a.testnet: 8 USDC on EVM chain 5042002. The signature and contract
arguments are actual public transaction data. invoiceReference and signature.accountId are
explicitly synthetic metadata; the transaction does not identify the approver's wallet account.
No private key or decrypted invoice is in either fixture.

All seven view responses were read at finalized block
5D7TXDko51h56xyZq5iFwFen5oiNqoGU6bua4zFMeNru. The live evm_payment_hash matched the authorization,
and the relay verified the captured signature against the live exception_message view output.
This historical authorization is expired and already consumed. Tests freeze time before its
expiry for acceptance checks; they do not create a new authorization or resubmit it on chain.

Verified:

- Approval page: 37 passing tests, including legacy NEAR cases, null/absent chain IDs, native
  payments on v2, actual EVM payment parsing, exact EVM view arguments, finalized-block pinning,
  destination display, wrong contract version, disabled/missing chain, bad token address,
  recipient/policy/signer versions, mismatched hash/message, expiry and unavailable RPC.
- Relay: 17 passing tests, including all prior cases. The real historical NEP-413 signature is
  accepted with a frozen clock. EVM requests survive file persistence/reload and the HTTP flow.
  Wrong chain shapes and changed key, nonce, message, vault or callback are refused; expiry and
  duplicate rules remain enforced.
- Both TypeScript checks, the static Vite build and the relay bundle pass. Existing wallet
  dependency externalization/eval and bundle-size warnings remain.
- Headless Chrome against the static build passes five scenarios with mocked relay/RPC and
  a frozen clock: EVM destination display, disabled chain, changed hash, token change before
  signing, and token change on a simulated redirect return. Refusals hide the sign button.
  No uncaught browser errors were observed.

Run the checks from the repo root:

```sh
(cd relay-near && npm ci && npm test && npm run typecheck && npm run build)
(cd approval-page-near && npm ci && npm test && npm run typecheck && npm run build)
# Serve the static page in one terminal:
(cd approval-page-near && npm exec -- vite preview --host 127.0.0.1 --port 5178)
# In another terminal, with Chrome installed:
(cd approval-page-near && npm run smoke:evm)
```

CHROME_PATH overrides the Chrome executable; APPROVAL_URL overrides the smoke-test page URL.

Not tested: a new real-wallet EVM approval or actual MyNearWallet redirect round trip, CLI
consumption of a newly produced signature, a new MPC signature/broadcast/EVM settlement,
deployment, independent RPC corroboration or configuration changes after approval. No
transaction was submitted and nothing was deployed. Poulav's signing-code review remains required.
