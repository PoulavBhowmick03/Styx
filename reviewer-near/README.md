# Styx NEAR reviewer

Python 3.11+, PyNaCl, and standard-library HTTP. No wallet or transaction submission.

```sh
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/styx-near-review keygen ~/.styx-near/my-reviewer.json
.venv/bin/styx-near-review verify --key ~/.styx-near/reviewer.json \
  --rpc https://test.rpc.fastnear.com --vault vault.styx-owner-c87a.testnet \
  --tx 8MA4pdMqH9TQy8x2xHVG3FrP4KmTXVwCzj5LfzajBm2y
.venv/bin/python -m unittest discover -s tests -v
```

Create the parent key directory first. Key generation uses mode 600 and refuses to overwrite.
Only the public key is printed. Verification prints named checks and ends in PASS or FAIL;
exit status is 0 or 1 respectively. It does not print invoice content or secret material.
RPC failure, missing finality, missing receipts, decryption failure or mismatched evidence fails.
The tool trusts the selected RPC's chain answers; it is not a light client. It verifies one
record, not history completeness, current policy suitability or delivery of invoiced goods.

Receipt events must come from the requested vault or named token, be successful and belong to
the transaction receipt graph. The submitted payment/authorization must match the sealed record.
The memo binds the token transfer to the payment ID. Exception verification uses the contract's
message view and independently encodes the NEP-413 Borsh payload in Python.

Tests generate fresh keys in memory; no test private keys are stored in the repository.
See ../docs/near/REVIEWER.md for the live verification and remaining limits.
