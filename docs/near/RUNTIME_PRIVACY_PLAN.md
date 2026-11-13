# TLS binding to the NEAR AI gateway, and the runner's loose ends

## Facts (13 Nov 2026, from docs.near.ai and the live API)

- `GET /v1/attestation/report?...&include_tls_fingerprint=true` (no API key needed) returns
  `gateway_attestation.tls_cert_fingerprint`: SHA-256 of the gateway certificate's SPKI.
- With TLS binding, the quote's report data is `SHA-256(signer bytes || raw fingerprint) || nonce`
  instead of `signer bytes zero-padded || nonce`. Model reports in the same response carry their own
  `tls_cert_fingerprint` and use the same layout.
- The peer certificate, the report and the inference requests must use **one TLS connection**; on a
  reconnect the flow is repeated. It binds the client connection to the **gateway**, not to the
  model endpoint behind it.
- The report also returns `ohttp_key_config` and `ohttp_attestation` (Oblivious HTTP), not used yet.

## Steps

- [x] Verifier: accept the TLS-bound report-data layout; check the gateway fingerprint against the
      peer SPKI observed on the connection; unit tests with a live-recorded fixture
- [x] Runner: one TLS connection for the report and every completion and signature request; read the
      peer certificate from it; re-run the binding on reconnect; record it in the evidence
- [x] Reviewer: report the TLS binding from the evidence and check it against the saved report
- [x] Live run on the owner's vault, payment amount confirmed on chain
- [x] Stub MCP server and runner tests use `amount_usdc` plus `amount`
- [x] README "Try it": the NEAR AI TEE agent
- [x] Docs: NEAR_AI.md

Done 13 Nov 2026: see "TLS bound to the attested gateway" in NEAR_AI.md.
