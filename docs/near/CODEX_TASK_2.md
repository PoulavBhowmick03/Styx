# Codex task 2: hosting, and the reviewer's check on NEAR

Same repo and rules as `docs/near/CODEX_TASK.md`: work in `/Users/odinson/Developer/Styx-near` on
`main`, small conventional commits, push after each, no keys or `.env` in git. Pull before every
push: another engineer commits to `contracts/`, `sdk/near/`, `scripts/near/` and `docs/near/`
(except the files named below), so do not edit those. Read `docs/near/TESTNET_RUN.md` first: it
lists what has run on testnet and the deployed accounts.

## Part A: make the relay and the approval page deployable

1. `relay-near/`: add a `Dockerfile` (node 22 slim, non-root user, `npm ci --omit=dev` if the start
   script allows it, otherwise build first) and a `fly.toml` (app name placeholder `styx-relay-near`,
   internal port from `PORT`, a volume mounted for `RELAY_STATE_FILE`, health check on a cheap
   endpoint; add a `GET /health` returning `{ok:true}` if there is none). Secrets (`RELAY_TOKEN`)
   are set with `fly secrets set`, never in the file. Add CORS for the page's origin, read from
   `ALLOWED_ORIGINS` (comma separated), because the page calls the relay from the browser.
2. `approval-page-near/`: add `vercel.json` for a Vite static build. Let the page take a default
   relay URL from `VITE_DEFAULT_RELAY` at build time, still overridable by `?relay=`.
3. Write `docs/near/HOSTING.md`: the exact commands to deploy both, and the env each needs. Do not
   deploy anything yourself: deploying is the user's call.

## Part B: `reviewer-near/`, the reviewer's verification tool (Python 3.11, `pynacl`, stdlib HTTP)

The agent's CLI will seal a record of one settled payment to the reviewer's key and post it on
chain through the vault's `post_record(payment_id, sealed)` method, which emits:

```
EVENT_JSON:{"standard":"styx","version":"1.0.0","event":"record_sealed","data":[{
  "payment_id": "...", "payment_hash": "<base64>", "agent": "ed25519:...", "sealed": "<base64>"}]}
```

`sealed` is a NaCl sealed box (`crypto_box_seal`, X25519 + XSalsa20-Poly1305) to the reviewer's
public key. The plaintext is UTF-8 JSON:

```json
{
  "schema": "styx-near-record/1",
  "network": "testnet",
  "vault": "vault.styx-owner-c87a.testnet",
  "payment": { "...": "exactly the contract's Payment JSON" },
  "payment_hash": "<base64, 32 bytes>",
  "invoice": "<base64 of the invoice file bytes>",
  "salt": "<base64, 32 bytes>",
  "invoice_reference": "INV-1003",
  "settlement_tx": "<base58 tx hash of the pay or pay_with_exception call>",
  "authorization": null,
  "signature": null
}
```

For an exception, `authorization` is the contract's `ExceptionAuthorization` JSON as submitted
(with `callback_url` filled from the signature) and `signature` is the approver's base64 signature.

Reviewer key file (written by the tool, mode 600): `{"schema":"styx-near-reviewer-key/1",
"public_key":"<base64 X25519>","secret_key":"<base64 X25519>"}`.

Commands:

- `styx-near-review keygen <path>`: writes a key file, prints the public key.
- `styx-near-review verify --key <path> --rpc <url> --vault <account> --tx <post_record tx hash>`:
  fetch the `post_record` transaction with the `tx` RPC method (`sender_account_id` = the vault,
  `wait_until: FINAL`), find the `record_sealed` event, open the box, then check, each as a named
  line in a report that ends in PASS or FAIL:
  1. the record's `vault` is the vault asked about and `payment.payment_id` matches the event;
  2. `sha256(salt || invoice) == payment.evidence_commitment`;
  3. the vault's own `payment_hash` view of `record.payment` equals `record.payment_hash` and the
     event's `payment_hash`;
  4. `consumed_payment(payment_id)` on the vault equals that hash;
  5. `settlement_tx` is final with `SuccessValue` and its receipts carry a `payment_executed` event
     whose `payment_id`, `agent`, `recipient`, `amount` and `payment_hash` match, and an NEP-141
     `ft_transfer` from the vault to that recipient for that amount;
  6. for an exception: `exception: true` in the event, the event's `signer` equals
     `authorization.signer`, and the NEP-413 signature verifies (sha256 over borsh(u32 2147484061)
     + borsh(Payload{message, nonce, recipient: vault, callbackUrl})) where `message` is the vault's
     `exception_message` view for that authorization.
- Tests: build a record, seal and open it, and run the checks against canned RPC responses for
  both a pass and each kind of failure. The tool must refuse anything it cannot verify rather than
  report a pass.

The other engineer adds `export_record` to the agent CLI and posts a real record on testnet; you
will find its transaction in `docs/near/TESTNET_RUN.md` once it exists. When it does, run your
verifier against it and record the output in `docs/near/REVIEWER.md`. Until then, say in that
file that only the canned tests have run.

## Report back

`docs/near/HOSTING.md` and `docs/near/REVIEWER.md`: what was tested and what was not. Claim only
what a test shows.
