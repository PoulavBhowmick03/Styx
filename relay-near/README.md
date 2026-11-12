# NEAR approval relay

Node 22+. Run `npm ci`, then `npm run build` and `RELAY_TOKEN=<local-token> RELAY_STATE_FILE=state/requests.json npm start`.
Default bind is 127.0.0.1:8788; put a TLS reverse proxy in front for hosting.
One process owns the JSON file. Omit RELAY_STATE_FILE for memory only. Corrupt state fails startup.
The relay verifies the exact NEP-413 payload; it does not read chain state or authorize payments.
No Telegram alerts. Requests expire after at most 24 hours. Public reads contain the pending request.

Run `npm test` and `npm run typecheck`. See ../docs/near/APPROVAL_PAGE.md for the wire flow.

EVM requests use non-null chainId matching payment.chain_id and an EvmPayment without token.
Absent/null chainId retains the NEAR Payment shape. NEP-413 verification is unchanged. The
relay does not query the vault; the page checks the EVM hash, chain configuration and recipient.
Tests include the actual public signature of a vault-v2 testnet exception, with a frozen clock.
See ../docs/near/APPROVAL_PAGE.md for fixture provenance and tested scope.
