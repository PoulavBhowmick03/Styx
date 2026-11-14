# Public testnet proof

`npm ci && npm run build`, `npm test`, `npm run smoke` (Chrome installed, or set CHROME_PATH).
The site build includes this app at `/proof/`. No deployment is performed by these commands.
`?vault=` defaults to lambda.styx-vaults.testnet. No wallet, keys, relay, or write methods.

FastNEAR `/v0/account` pages through history by block height; `/v0/transactions` supplies signers.
Each listed transaction is read from test.rpc.fastnear.com at FINAL. Only successful receipt logs
executed by the selected vault, standard styx, are displayed. Receipt block timestamps come from
RPC, preserving nanoseconds for comparisons. The indexer can omit history but cannot invent
confirmed events. Failed reads show an error rather than a partial count. History loads on page
open or Read vault; it does not auto-refresh.

Pause counts include valid payment_executed events strictly before the pause within loaded history.
EVM signing events are displayed as authorizations, not settled payments. Equal block timestamps
cannot establish order and are excluded from “before”. No earlier payment means no latency value.
Every dynamic value is rendered with textContent; transaction URLs encode the hash. Reasons are
limited to 280 UTF-8 bytes without splitting a code point. Tests and browser smoke use fixtures
with all remote requests mocked.
