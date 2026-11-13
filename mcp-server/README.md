# Styx MCP server

Gives an agent the vault's payment tools over the NEAR agent CLI (`styx-near-vault`, built from
`sdk/near`). The agent's environment holds only its function-call key; it has no tools to change
policy, approve exceptions or withdraw.

## Tools (`STYX_BACKEND=vault`)

| Tool | What it does |
| --- | --- |
| `styx_propose_payment` | Journals a payment from an invoice file. Takes the amount twice, `amount_usdc` and `amount` in base units, and refuses a mismatch. Moves no funds |
| `styx_request_owner_approval` | Writes the pending approval and, with a relay set, alerts the approver |
| `styx_check_owner_approval` | With a relay set, reports whether the approver has signed |
| `styx_submit_payment` | Sends the payment, and retries an unknown outcome under the same ID |
| `styx_payment_status` | Reads the payment's state |

A recipient is a NEAR account, or `eip155:<chain id>:0x…` for a payment on an EVM chain through the
vault's Chain Signatures.

## Settings

`STYX_BACKEND=vault`, `STYX_VAULT_DIR` (an owner-only directory for invoices and approval files),
`STYX_VAULT_CLI` (the path to `styx-near-vault`), and optionally `STYX_VAULT_RELAY_URL` with
`STYX_VAULT_RELAY_TOKEN`. The CLI reads its own `STYX_NEAR_*` settings (vault, agent key file, state
directory, approver, EVM RPCs); see `sdk/near/src/main.rs` and `scripts/near/quickstart.sh`.

## Test

```bash
uv run pytest
```
