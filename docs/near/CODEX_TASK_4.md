# Codex task 4: the agent's model in a NEAR AI Cloud TEE, with evidence a reviewer can check

Same repo and rules as before (`/Users/odinson/Developer/Styx-near`, `main`, small conventional
commits, `git pull --rebase` before every push, no keys or `.env` in git). Do not edit
`contracts/`, `sdk/near/`, `scripts/near/`, `mcp-server/`, or `docs/near/` files other than the
ones named here: another engineer is adding Chain Signatures to the contract and CLI at the same
time. Never claim more than a test shows; no "private payments" (amounts and recipients are public
on chain), no "secure" or "audited".

## Why

Today the agent's model runs wherever the operator points it, so the invoice text (vendor, prices,
bank notes) goes to that model's provider in the clear, and nobody can later show which model made
the decision to pay. NEAR AI Cloud runs models inside TEEs, publishes attestation for them, and
signs responses. We want: the agent's model runs there, every completion that leads to a payment is
verified against the attestation before the agent acts, and the evidence goes into the sealed
record the reviewer opens.

## Read first, and verify everything there rather than assuming

- https://docs.near.ai/llms.txt (page index), the Private Inference, Quick Start and Models pages.
- The verification pages under https://docs.near.ai/cloud/verification/ (gateway attestation,
  model attestations, TLS connection, response signatures, quote/nonce/signer bindings,
  verification policy).
- https://github.com/near-examples/nearai-cloud-verification-example and
  https://github.com/nearai/nearai-cloud-verifier. Reuse their verification code where the license
  allows, and say what you reused.
- Credits: HACKATHON.md Q-000. The API key comes from the environment (`NEARAI_API_KEY`), never a
  file in the repo. If no key is available when you reach the live run, stop there and say so.

## What to build, in a new folder `agent-near-ai/` (Python 3.11, its own `pyproject.toml`)

1. **An agent runner** `styx-near-ai-agent`: it starts the repo's MCP server
   (`python -m styx_mcp.server` with `STYX_BACKEND=vault` and `STYX_VAULT_CLI` pointing at
   `sdk/near/target/release/styx-near-vault`, exactly as `scripts/near/model_trial.py` does) as an
   MCP stdio client, lists its tools, and runs a tool-calling loop against NEAR AI Cloud's chat
   completions API with a model that supports tool calls (pick one from their Models page that runs
   in a TEE, and say which). Input: an invoice file and a short instruction. System prompt: the same
   generic accounts-payable prompt as `mcp-server/examples/model_trial.py`.
2. **Verification before acting.** Before the first completion, verify the gateway attestation with
   a fresh nonce (and model attestations if your policy requires them, following their verification
   policy page). After every completion, verify its response signature against the attested signing
   key, and check the signed request and response hashes match what you sent and received. If any
   check fails, the runner must not call any tool that moves money (`styx_submit_payment`) on the
   basis of that completion; it stops and reports why.
3. **Evidence file** `inference-<payment_id first 12 hex>.json`, mode 600, written into the vault
   directory for every payment the runner submits, with this shape:

```json
{
  "schema": "styx-near-inference/1",
  "provider": "near-ai-cloud",
  "model": "<model id>",
  "attestation": {
    "nonce": "<hex you generated>",
    "signing_address": "<the attested signing key or address, as the API names it>",
    "report_sha256": "<sha256 of the raw attestation report you verified>",
    "report_url": "<the exact request that returns it, without the API key>",
    "verified": ["<each check you ran, by name>"]
  },
  "completions": [
    {
      "chat_id": "<id>",
      "request_sha256": "<hex>",
      "response_sha256": "<hex>",
      "signature": "<as returned>",
      "signing_algo": "<ecdsa | ed25519, as returned>",
      "verified": true
    }
  ],
  "invoice_sha256": "<hex of the invoice file bytes>",
  "payment_id": "0x...",
  "tool_calls": [{"tool": "styx_propose_payment", "arguments": {}}]
}
```

   Keep the raw attestation report too, next to it, as `attestation-<same stem>.json`, so the
   reviewer can re-verify it offline later.
4. **Reviewer extension** in `reviewer-near/`: a new optional check. The other engineer will add an
   optional field `inference_evidence` to the sealed record (`styx-near-record/1`), holding the
   evidence file above verbatim. When present, the reviewer re-verifies each completion signature
   against `signing_address`, checks `invoice_sha256` against the record's invoice, checks
   `payment_id` matches, and, if the raw attestation report is supplied with `--attestation <file>`,
   re-verifies it and its hash. When absent, the report says "no inference evidence", not a failure.
5. **Tests**: canned attestation and signature fixtures (record real ones from a live call if you
   have a key, and say so), covering a pass, a bad signature, a hash mismatch, and the runner
   refusing to submit after a failed check.

## Live run (only with a key)

Against the testnet vault in `docs/near/TESTNET_RUN.md`, using `~/.styx-near/demo.env` for the agent
key and approver: one routine invoice (25 tUSDC, should settle) and one `hostile-redirect` invoice
from the trial scenarios. Record the outcome, the model, and the transaction ids.

## Report back

`docs/near/NEAR_AI.md`: what runs where, what each verification step proves and what it does not
(for example: it attests the model's environment and that this response came from it; it says
nothing about the agent's NEAR key or the machine running the MCP server), what was tested live
and what only with fixtures.
