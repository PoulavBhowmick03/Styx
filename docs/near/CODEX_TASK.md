# Codex task: NEAR approval page and relay for Styx

You are working in the Styx repo (`/Users/odinson/Developer/Styx-near`, branch `main`). Read
`docs/near/PLAN.md`, `README.md`, `contracts/near/styx-vault/src/lib.rs` (the contract you are
signing for) and `relay/src/relay.ts` plus `owner-page/src/approval-v2.ts` (the EVM versions you
are mirroring) before writing anything. Do not modify `contracts/`, `sdk/`, `mcp-server/`,
`relay/` or `owner-page/`: another engineer is working there. Put your work in two new folders,
`relay-near/` and `approval-page-near/`, each with its own `package.json`, tests, and README.
Commit small conventional commits to `main` and push after each. Never commit keys or `.env`.

## What the pieces do

An agent proposes a payment over its per-payment limit. The agent's CLI writes a **pending file**
and posts it to the relay. The approver opens the approval page, which fetches the request from
the relay, shows the payment read back from the chain, asks their NEAR wallet to sign a NEP-413
message, and posts the signature back. The agent's CLI fetches the signature and submits
`pay_with_exception`. The vault verifies the signature itself: the relay and page have no
authority, so they must be honest about what they show, and nothing more.

## Pending file (`styx-near-pending/1`), posted by the agent as `{"pending": <this>}`

```json
{
  "schema": "styx-near-pending/1",
  "network": "testnet",
  "rpcUrl": "https://test.rpc.fastnear.com",
  "vault": "vault.styx-owner-c87a.testnet",
  "token": "usdc.styx-owner-c87a.testnet",
  "payment": {
    "payment_id": "<string>",
    "agent": "ed25519:<base58>",
    "token": "usdc.styx-owner-c87a.testnet",
    "recipient": "vendor.testnet",
    "amount": "150000000",
    "evidence_commitment": "<base64 32 bytes>",
    "policy_version": 1,
    "recipient_version": 1,
    "valid_until": "<unix seconds as string>"
  },
  "authorization": {
    "payment_hash": "<base64 32 bytes>",
    "signer": "ed25519:<base58, the approver's public key>",
    "signer_version": 1,
    "approval_nonce": "<base64 32 bytes>",
    "authorization_expiry": "<unix seconds as string>",
    "callback_url": null
  },
  "message": "<the exact string the vault's exception_message view returns for this authorization>",
  "invoiceReference": "<free text, show it>",
  "perPaymentLimit": "100000000",
  "exceededRule": "perPaymentLimit"
}
```

`payment` and `authorization` are exactly the JSON the contract methods take. Amounts are USDC
base units with six decimals.

## What the page must do

1. Load the request by id from the relay (`GET /requests/:id`), no auth: the id is a 32-byte
   random token, and a request holds nothing secret.
2. **Read back from the chain, not from the file**: call the vault's views over `rpcUrl`
   (`get_vault`, `get_agent {agent}`, `get_recipient {recipient}`, `get_approver {approver}`,
   `payment_hash {payment}`, `exception_message {authorization}`) and show the limits, the
   recipient's allowed state, whether the signer is a current approver and its version, and check
   that `payment_hash` and `message` match the file. If anything differs, say so and do not offer
   to sign.
3. Show the payment plainly: amount, recipient, agent key, the per-payment limit it exceeds, the
   daily limit that still applies, expiry.
4. Sign with `@near-wallet-selector` (`signMessage` per NEP-413) using
   `message` = the file's `message`, `nonce` = the 32 bytes of `approval_nonce` decoded from
   base64, `recipient` = the vault account id, and `callbackUrl` only if the chosen wallet needs
   a redirect (MyNearWallet). Whatever `callbackUrl` was actually included in the signed payload
   must be reported back verbatim, because the contract rebuilds the payload with it.
5. After signing, check locally that `publicKey` equals `authorization.signer`. If it does not,
   tell the approver which key the wallet used so the owner can register it with `set_approver`,
   and do not post.
6. Post the signature to the relay.

## Signature file (`styx-near-signature/1`), what the page posts and the agent fetches

```json
{
  "schema": "styx-near-signature/1",
  "paymentId": "<payment.payment_id>",
  "accountId": "<the signer's NEAR account>",
  "publicKey": "ed25519:<base58>",
  "signature": "<base64, 64 bytes>",
  "nonce": "<base64, must equal approval_nonce>",
  "callbackUrl": null
}
```

## Relay (`relay-near/`), Node + TypeScript, no database, in-memory with a JSON file fallback

- `POST /requests` (bearer token from `RELAY_TOKEN`): body `{pending}`. Validate the schema, that
  `authorization_expiry` is in the future and at most 24 h away, `exceededRule`, and that
  `amount > perPaymentLimit`. Return `{requestId, alerted: false}`. `requestId` is 32 random bytes
  base64url.
- `GET /requests/:id`: returns the pending file and `{status: "pending" | "signed" | "expired"}`.
- `POST /requests/:id/signature`: body is the signature file. Verify the NEP-413 signature
  yourself before storing (sha256 over borsh(u32 2147484061) + borsh(Payload{message, nonce,
  recipient, callbackUrl?}), ed25519 against `publicKey`; use `borsh` and `tweetnacl` or
  `@noble/ed25519`), check `publicKey == authorization.signer` and `nonce == approval_nonce`.
  First valid signature stands; a second is 409.
- `GET /requests/:id/signature` (bearer token): `{status: "pending"}`, `{status: "signed",
  signature: <file>}`, or 410 once expired.
- Optional, only if time allows: a Telegram alert like `relay/src/relay.ts` does.
- Tests with the real NEP-413 construction: sign with a known key in the test and assert the
  relay accepts it, and that a wrong nonce, wrong key, or wrong message is refused.

## Hosting

The page should build to static files (Vite) so it can be deployed on Vercel next to the
existing `owner-page`. Take the relay URL and request id from the query string:
`/?relay=https://...&request=<id>`.

## Report back

When done, write `docs/near/APPROVAL_PAGE.md`: how to run both locally, what was tested, what
was not. Claim only what a test shows.
