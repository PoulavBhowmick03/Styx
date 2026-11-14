# NEAR approval relay

Node 22+. Run `npm ci`, then `npm run build` and `RELAY_TOKEN=<local-token> RELAY_STATE_FILE=state/requests.json npm start`.
Default bind is 127.0.0.1:8788; put a TLS reverse proxy in front for hosting.
One process owns the JSON file. Omit RELAY_STATE_FILE for memory only. Corrupt state fails startup.
The relay verifies the exact NEP-413 payload; it does not read chain state or authorize payments.
Requests expire after at most 24 hours. Public reads contain the pending request.

Telegram is optional: TELEGRAM_BOT_TOKEN, APPROVAL_PAGE_URL and RELAY_PUBLIC_URL turn it on. The
relay long-polls the bot (one process per token). /start in a private chat returns a one-time link
(15 minutes) to the approval page in link mode; the wallet signs a NEP-413 link message (nonce = the
code, recipient `styx-telegram-link`, never a vault) and the page posts it to POST /links. Alerts for
a request go to the chats linked to its `authorization.signer`, or to TELEGRAM_CHAT_ID when none is
linked. Links live in RELAY_LINKS_FILE (default: telegram-links.json beside RELAY_STATE_FILE).
/status lists a chat's keys, /unlink removes them. A link only routes alerts; it authorizes nothing.

Spend alerts: `/watch <vault>` (or the deep link `t.me/<bot>?start=watch-<vault with . written as -->`)
makes the relay read that vault's spend for the UTC day every WATCH_INTERVAL seconds (default 300,
at least 60) through NEAR_RPC_URL (default https://test.rpc.fastnear.com), with view calls only, and
message the chat once at 80% and once at 100% of the vault daily limit. Spend is public on chain, so
watching needs no signature. Up to 5 vaults per chat; `/unwatch [vault]` stops. Watches live in
RELAY_WATCHES_FILE (default: telegram-watches.json beside RELAY_STATE_FILE).

Run `npm test` and `npm run typecheck`. See ../docs/near/APPROVAL_PAGE.md for the wire flow.

EVM requests use non-null chainId matching payment.chain_id and an EvmPayment without token.
Absent/null chainId retains the NEAR Payment shape. NEP-413 verification is unchanged. The
relay does not query the vault; the page checks the EVM hash, chain configuration and recipient.
Tests include the actual public signature of a vault-v2 testnet exception, with a frozen clock.
See ../docs/near/APPROVAL_PAGE.md for fixture provenance and tested scope.

Sentinel pause alerts (testnet): watched vaults are also scanned through FastNEAR's transaction
listing API; each transaction is confirmed through NEAR_RPC_URL at FINAL, accepting only successful
Styx receipt logs executed by that vault. Each sentinel_paused alert includes a short sentinel key,
its reason truncated at a UTF-8 boundary to 280 bytes as plain text (no parse_mode), a NearBlocks
transaction link, and https://styxco.xyz/console/?vault=<vault>&network=testnet#sentinels.
The owner opens Review unpause and signs in the console. The bot cannot unpause.
Recipients are linked chats for the current owner's full-access keys; merely watching a vault
does not subscribe unrelated chats to pause alerts. All indexed history is scanned, including
pauses during downtime. Dedupe IDs include vault, transaction, receipt, log, data index and chat,
and persist without expiry in RELAY_WATCHES_FILE on the Fly volume. One process owns this file.
Delivery uses a durable reservation before sending to prevent duplicates after a crash. Telegram
has no idempotency key: a crash after reservation or an ambiguous/failed send can lose an alert;
exactly-once delivery across both systems cannot be guaranteed. Such sends are not retried.

No deployment is required for tests. `fly deploy` from relay-near would build the new relay image
and replace the styx-relay-near Machine using the existing secrets, configuration and persistent
volume; it would enable these chain reads and Telegram alerts. It would not deploy the console
or change contracts. No deployment was performed for this change.
