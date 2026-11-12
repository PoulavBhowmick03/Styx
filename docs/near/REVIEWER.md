# Reviewer verification on NEAR

## Run

```sh
cd reviewer-near
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/styx-near-review verify \
  --key ~/.styx-near/reviewer.json \
  --rpc https://test.rpc.fastnear.com \
  --vault vault.styx-owner-c87a.testnet \
  --tx 8MA4pdMqH9TQy8x2xHVG3FrP4KmTXVwCzj5LfzajBm2y
```

The key remains outside the repo. No decrypted invoice is printed or committed.
`keygen <path>` creates a fresh X25519 key file (mode 600, no overwrite) and prints its public key.
The verifier does not sign or submit transactions.

## Live result

Run on 12 November 2026 against FastNEAR testnet. Exit status 0:

```text
1 record identity and sealed box: PASS
2 salted invoice commitment: PASS
3 contract payment hash: PASS
4 consumed payment: PASS
5 final settlement and token transfer: PASS
6 exception NEP-413 signature: PASS
PASS
```

This checked the real sealed record in post_record transaction
[8MA4pdMq…](https://testnet.nearblocks.io/txns/8MA4pdMqH9TQy8x2xHVG3FrP4KmTXVwCzj5LfzajBm2y),
including its settled exception transaction
[7esYgW17…](https://testnet.nearblocks.io/txns/7esYgW17uGo4tw5Lggj9LVgCUpvXufUWnMYzezLo2LyR).
The standard rpc.testnet.near.org endpoint returned HTTP 429 during the initial fetch;
FastNEAR supplied the final transaction and views. No result was inferred from the unavailable RPC.

## Tests and limits

10 unittest methods pass, with subcases for routine and exception records, seal/open and wrong
reviewer key, identity mismatch, invoice/salt/hash tampering, missing consumed payment, failed
or non-final settlement, wrong execution fields and executor, missing/wrong token transfer,
changed callback/nonce/signer/message, submitted-payload mismatch, unavailable RPC, unrelated
receipt and key-file permissions/no-overwrite. Test keys are generated in memory.

Receipt evidence is restricted to successful receipts reachable from the transaction and to the
vault/token executor. The submitted transaction arguments, transfer memo and signature digest
are also bound to the record. All receipt outcomes referenced by the graph must be present.
Malformed/incomplete evidence returns FAIL with exit status 1. The CLI suppresses dependency
error text that could contain decrypted content.

Not tested: an independent second RPC corroborating the live result, archival history availability,
a real routine-payment sealed record, deployment, load, power-loss behavior or all possible
malformed JSON cases. The selected RPC is trusted; this is not a light client or a contract
review. PASS proves these checks for this record, not invoice truth, delivery, policy suitability
or private payments. Amounts and recipients remain public. Signing verification needs Poulav's
review under the repo rules.
