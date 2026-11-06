# Approval relay

When an agent needs the owner's approval, the relay sends a Telegram alert with a link to the approval page, then carries the owner's signature back to the agent. Nobody passes files by hand.

**The relay grants no authority.** It holds no keys. The alert only points to the page, the page checks the request against the owner's own config, and the vault checks the signature. A compromised relay can withhold or delay requests or read their contents, but it cannot make a payment go through.

## Run it

Install dependencies here and in `owner-page`, whose checks the relay reuses.

```bash
(cd ../owner-page && npm install --legacy-peer-deps)
npm install --legacy-peer-deps
```

1. Create a bot by messaging @BotFather on Telegram, and copy its token.
2. Send your bot any message, then open `https://api.telegram.org/bot<token>/getUpdates` and read `message.chat.id`.
3. Start the relay. Keep these values out of the repo and out of the agent's environment, apart from the agent token.

```bash
export TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
export RELAY_AGENT_TOKEN="$(openssl rand -hex 32)"
export RELAY_CHAIN_ID=5042002 RELAY_VAULT=0x... RELAY_OWNER=0x... RELAY_TOKEN=0x3600000000000000000000000000000000000000
export RELAY_PAGE_URL=http://127.0.0.1:5173/ RELAY_PUBLIC_URL=http://127.0.0.1:8799
export RELAY_STATE_DIR=~/.vault-relay
npm start
```

Optional: `RELAY_PORT`, `RELAY_HOST`, `RELAY_MAX_ALERTS_PER_HOUR` (10), `RELAY_MAX_REQUESTS` (200), `RELAY_WATCHER_TOKEN`.

Give the agent's MCP server the relay with `EREBUS_VAULT_RELAY_URL` and `EREBUS_VAULT_RELAY_TOKEN`, the latter set to `RELAY_AGENT_TOKEN`. `erebus_request_owner_approval` then alerts the owner and reports `owner_alerted`. Asking again retries a failed alert. `erebus_check_owner_approval` reports `pending`, `expired` or `signed`, and when signed it returns the `signature_name` to pass to `erebus_submit_payment`.

The link opens the owner page with the request loaded. The first time in a browser, choose your owner config; the page remembers it in that browser. Set `relay` in that config to this relay's URL: the page only sends signatures to the relay named there, so a crafted link cannot redirect one. After signing, the page sends the signature back, and still shows the file in case the relay is down.

To open the link on your phone, the page and relay must be reachable from it, so set both URLs to HTTPS addresses you host or tunnel. A non-HTTPS page still works, but the alert has a text link and no button.

**Not yet exercised:** a real Telegram bot. The tests use a fake Telegram server that follows the Bot API docs.

## API

All bodies are JSON.

| Call | Auth | Purpose |
| --- | --- | --- |
| `POST /requests` with `{"pending": <vault-pending-approval/1>}` | Agent token | Validates, stores and alerts. Returns `{"requestId", "alerted"}`, plus `"rateLimited": true` when over the limit. Repeating a request returns the same ID and retries a failed alert |
| `GET /requests/<id>` | The ID | Returns `{"pending": ...}` for the page |
| `POST /requests/<id>/signature` with a `vault-owner-signature/1` body | The ID | 403 unless it recovers to the owner over this exact request |
| `GET /requests/<id>/signature` | Agent token | `{"status":"pending"}` or `{"status":"signed","signature":{...}}` |
| `POST /alerts` with `{"kind","text"}` | Watcher token | Sends a notice with no link |

Errors are `{"error": "..."}`: 400 invalid, 401 unauthorized, 403 wrong signer, 404 unknown, 410 expired, 413 too large, 429 too many open requests.

## Limits

- An agent that skips the tools sends no alert. The vault still refuses the payment, and catching those attempts is the watcher's job.
- Approval alerts and watcher notices have separate hourly budgets, and only delivered alerts count. An agent that floods approval requests can still use up the approval budget and delay a real one.
- Requests can stay open for at most 24 hours.
- Anyone holding a request's ID can read its pending file. The ID is random, and travels only in the alert and to the agent.
- Telegram sees what the alert says: the amount and recipient, both of which become public on the chain if the payment settles, plus the fact that a request exists before it does.
