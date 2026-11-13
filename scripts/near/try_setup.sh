#!/usr/bin/env bash
# Sets up the vault behind styxco.xyz/try: a factory vault with small limits whose agent key is
# published on purpose, so anyone can sign with it and see what the vault and NEAR allow.
#
#   OWNER=<your testnet account> scripts/near/try_setup.sh
#
# What it does, each call signed by OWNER from the near CLI's keychain:
#   1. creates <NAME>.<FACTORY> through the factory (4 NEAR) unless it exists and OWNER owns it;
#   2. registers the vault and the recipient with the token and mints test tokens to the vault;
#   3. makes the agent key in TRY_HOME (never in the repo) and installs it with the limits;
#   4. allows one recipient and sets the vault's daily limit;
#   5. writes TRY_HOME/try.env, the settings the page is built with.
# Safe to run again: it tops the vault up and re-applies the limits.
#
# Optional: NAME (try), FACTORY (styx-vaults.testnet), TOKEN (usdc.styx-owner-c87a.testnet, the test
# token anyone can mint), RECIPIENT (vendor-a.styx-owner-c87a.testnet), PER_PAYMENT (1), DAILY (20),
# FUND (500), DAYS (30, how long the agent's policy lasts), TRY_HOME (~/.styx-near/try), NETWORK, RPC.
set -euo pipefail
: "${OWNER:?set OWNER to a testnet account in the near CLI keychain}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${NAME:-try}"; FACTORY="${FACTORY:-styx-vaults.testnet}"; VAULT="$NAME.$FACTORY"
TOKEN="${TOKEN:-usdc.styx-owner-c87a.testnet}"; RECIPIENT="${RECIPIENT:-vendor-a.styx-owner-c87a.testnet}"
TRY_HOME="${TRY_HOME:-$HOME/.styx-near/try}"; RPC="${RPC:-https://test.rpc.fastnear.com}"
case "$(cd "$(dirname "$TRY_HOME")" 2>/dev/null && pwd)/" in "$ROOT"/*) echo "TRY_HOME must be outside the repo"; exit 1;; esac
if [ -z "${NETWORK:-}" ]; then
  found="$(near config show-connections 2>&1 | grep -c 'network_connection.testnet-fastnear' || true)"
  [ "${found:-0}" -gt 0 ] && NETWORK=testnet-fastnear || NETWORK=testnet
fi
NET=(network-config "$NETWORK" sign-with-legacy-keychain send)
usdc() { echo "$(( $1 * 1000000 ))"; }
near_retry() {
  local out
  for attempt in 1 2 3 4 5 6; do
    out="$(near "$@" 2>&1)" || true
    if ! grep -q '^Error' <<<"$out" || grep -qiE 'already exists|succeeded|successfully' <<<"$out"; then
      grep -E 'Transaction ID|succeeded|successfully|panicked' <<<"$out" | head -2
      return 0
    fi
    sleep $((attempt * 3))
  done
  grep -A3 '^Error' <<<"$out" | head -6
  return 1
}
call() { # contract method json [deposit] [gas]
  near_retry contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas "${5:-100 Tgas}" \
    attached-deposit "${4:-0 NEAR}" sign-as "$OWNER" "${NET[@]}"
}
view() { # contract method json -> the JSON result, or "null" when the account or method is missing
  python3 - "$RPC" "$1" "$2" "$3" <<'PY'
import base64, json, sys, urllib.request
rpc, account, method, args = sys.argv[1:5]
body = {"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"request_type": "call_function", "finality": "final",
        "account_id": account, "method_name": method, "args_base64": base64.b64encode(args.encode()).decode()}}
reply = json.load(urllib.request.urlopen(urllib.request.Request(rpc, json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=30))
result = reply.get("result", {})
print(bytes(result["result"]).decode() if "result" in result else "null")
PY
}
field() { python3 -c 'import json,sys; v=json.load(sys.stdin); print("" if v is None else v.get(sys.argv[1], ""))' "$1"; }

echo "1/5 the vault $VAULT"
owner="$(view "$VAULT" get_vault '{}' | field owner)"
if [ -z "$owner" ]; then
  call "$FACTORY" create_vault "{\"name\":\"$NAME\",\"token\":\"$TOKEN\"}" '4 NEAR' '300 Tgas'
  for _ in $(seq 1 10); do owner="$(view "$VAULT" get_vault '{}' | field owner)"; [ -n "$owner" ] && break; sleep 2; done
fi
[ "$owner" = "$OWNER" ] || { echo "$VAULT is owned by '${owner:-nobody}', not $OWNER: choose another NAME"; exit 1; }

echo "2/5 token registration and test tokens"
for account in "$VAULT" "$RECIPIENT"; do
  [ "$(view "$TOKEN" storage_balance_of "{\"account_id\":\"$account\"}")" != "null" ] \
    || call "$TOKEN" storage_deposit "{\"account_id\":\"$account\",\"registration_only\":true}" '0.00125 NEAR'
done
call "$TOKEN" mint "{\"account_id\":\"$VAULT\",\"amount\":\"$(usdc "${FUND:-500}")\"}"

echo "3/5 the agent key, published on purpose"
mkdir -p "$TRY_HOME" && chmod 700 "$TRY_HOME"
[ -f "$TRY_HOME/agent.json" ] || uv run -q --with pynacl --with base58 "$ROOT/scripts/near/keygen.py" "$TRY_HOME/agent.json" >/dev/null
AGENT_PK="$(field public_key < "$TRY_HOME/agent.json")"
until=$(( $(date +%s) + ${DAYS:-30} * 86400 ))
call "$VAULT" configure_agent "{\"agent\":\"$AGENT_PK\",\"per_payment_limit\":\"$(usdc "${PER_PAYMENT:-1}")\",\"daily_limit\":\"$(usdc "${DAILY:-20}")\",\"valid_until\":\"$until\",\"enabled\":true}"

echo "4/5 one allowed recipient and the vault's daily limit"
[ "$(view "$VAULT" get_recipient "{\"recipient\":\"$RECIPIENT\"}" | field allowed)" = "True" ] \
  || call "$VAULT" set_recipient "{\"recipient\":\"$RECIPIENT\",\"allowed\":true}"
call "$VAULT" set_vault_daily_limit "{\"limit\":\"$(usdc "${DAILY:-20}")\"}"

echo "5/5 settings for the page"
( umask 177; cat > "$TRY_HOME/try.env" <<EOF
VITE_TRY_VAULT=$VAULT
VITE_TRY_RECIPIENT=$RECIPIENT
VITE_TRY_AGENT_KEY=$(field private_key < "$TRY_HOME/agent.json")
EOF
)
echo "agent key $AGENT_PK on $VAULT; policy: $(view "$VAULT" get_agent "{\"agent\":\"$AGENT_PK\"}")"
echo "Build the site with these settings (they hold the key, so they stay out of the repo):"
echo "  set -a; . $TRY_HOME/try.env; set +a; scripts/build_site.sh"
