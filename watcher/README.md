# Vault watcher

A read-only Python 3.11+ process watches one chain, vault and agent. It alerts through the
relay's `POST /alerts` using a separate watcher token. It reads full block transactions and
receipts, so it catches an agent's reverted call to the vault even when the receipt has no logs.
It also alerts once per UTC day when `spentByDay(day)` is strictly above a configured threshold.
Amounts are integer token base units; USDC uses six decimals here.

```sh
export WATCHER_TOKEN=... # Same value as the relay's RELAY_WATCHER_TOKEN; keep outside agent environment.
python3 watcher/watcher.py \
  --rpc https://rpc.testnet.arc.io --chain-id 5042002 \
  --vault 0x... --agent 0x... \
  --relay https://your-relay.example \
  --threshold 8000000 --start-block DEPLOYMENT_BLOCK \
  --state "$HOME/.styx-watcher/vault.json"
```

No Python dependency installation is needed. Supply real addresses and a known deployment
block. The watcher reads historical `spentByDay` at each scanned block: the endpoint must
support those historical calls. Start at or after deployment. The first scan alerts if spend is
already above the threshold at the selected start block; earlier transactions are not covered.
Remote RPC/relay URLs require HTTPS; HTTP is allowed for loopback tests. Redirects are refused
so a relay redirect cannot forward the bearer token. No owner/agent key is needed.

`--confirmations` defaults to 2 blocks; `--poll-seconds` defaults to 5. `--once` scans at most
100 blocks, retries pending receipts and flushes queued notices, then exits. Run continuously
to catch up beyond 100 blocks. An unavailable read makes `--once` exit 1. No receipt or a partial
receipt remains unknown and is retried after restart; neither produces a revert alert. Other
blocks continue to be scanned while those receipts remain pending. On Arc, a receipt that never
appears cannot produce a definitive revert alert. Pending entries are retained until resolved.

## Recovery and delivery limits

State is written atomically and fsynced, and one process locks each state file. State binds the
chain, vault, agent, threshold, starting block and confirmation count; use a new state file when
changing them. The cursor records block hashes. A detected reorganization stops scanning and
requires an operator to choose a canonical restart block and a fresh state file. Two confirmations
reduce reorganization exposure but do not establish finality. RPC responses are trusted, including
the completeness of block transactions; the watcher is not an independent chain verifier.

The durable outbox retries unavailable relay calls and `{"alerted":false}` (including rate limits).
A crash after the relay accepted a notice but before the local acknowledgement was saved can
send the notice twice. The relay API has no idempotency key, so delivery is at least once when
both services recover, with possible duplicates. Do not treat an alert as payment authorization.
An offline RPC, relay or Telegram service can delay alerts. Reverted calls to intermediaries,
transactions not included in blocks, and never-visible Arc receipts are outside this watcher’s
revert detection. Threshold alerts are based on vault state, not an agent's invoice text.

## Tests

```sh
uv run pytest watcher/tests -v
```

Tests generate fresh keys at runtime, fund them only on local Anvil, deploy the existing mock
token and vault, and use a fake HTTP relay matching `relay/README.md`. They cover empty-log
reverts, ignored owner calls, successful payments, spend thresholds, UTC rollover, receipt absence,
partial receipts, unavailable RPC, relay retries, restart deduplication, confirmation delay,
reorganizations, configuration binding, concurrent processes and redirect refusal.
No real Telegram delivery or live Arc run has been verified.

API references consulted before implementation:
[relay contract](../relay/README.md),
[Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/),
[receipt schema](https://ethereum.github.io/execution-apis/api/methods/eth_getTransactionReceipt/).
The `spentByDay(uint256)` selector was generated from the local contract signature with `cast sig`.
