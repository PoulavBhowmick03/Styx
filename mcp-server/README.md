# Styx MCP server

Gives an agent the vault's tools, or a reviewer the disclosure tools. `STYX_BACKEND` chooses which. The agent's environment holds only a gas key, and it has no tools to change policy, sign exceptions or withdraw.

## Vault tools (`STYX_BACKEND=vault`)

| Tool | What it does |
| --- | --- |
| `styx_propose_payment` | Journals a payment from an invoice file. Moves no funds |
| `styx_request_owner_approval` | Writes the pending approval and, with a relay set, alerts the owner |
| `styx_check_owner_approval` | With a relay set, reports whether the owner has signed |
| `styx_submit_payment` | Sends the payment, and retries an unknown outcome under the same ID |
| `styx_payment_status` | Reads the payment's state |

Settings: `STYX_VAULT_DIR`, `STYX_VAULT_CHAIN_ID`, `STYX_VAULT_RPC_URLS`, `STYX_VAULT_ADDRESS`, `STYX_VAULT_TOKEN`, `STYX_VAULT_AGENT_KEY_FILE`, `STYX_VAULT_STATE_ROOT`, and optionally `STYX_VAULT_RELAY_URL` with `STYX_VAULT_RELAY_TOKEN`. See `docs/mumbai/AGENT_INSTALL.md`.

## Reviewer tools (`STYX_BACKEND=disclosure`)

`create_disclosure_key`, `disclosure_key_info`, plus `export_vault_payment` when `STYX_DISCLOSURE_VAULT_ISSUER_KEY_FILE` is set, and `verify_vault_payment` when `STYX_DISCLOSURE_VAULT_PINS` is set. Settings also include `STYX_DISCLOSURE_DIR`, `STYX_DISCLOSURE_KEY_FILE` and `STYX_DISCLOSURE_CLI`.

## Test

```bash
uv run pytest mcp-server/tests
```
