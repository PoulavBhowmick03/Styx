#!/usr/bin/env bash
# Terminal side of the real-wallet test (docs/near/WALLET_TEST.md). The browser side is the approval
# page and the owner console with your own NEAR wallet.
#
#   wallet_test.sh relay                       start the relay locally (keep this terminal open)
#   wallet_test.sh approver <ed25519:pk>       owner registers your wallet key as approver on both vaults
#   wallet_test.sh request near|arc|base <ed25519:pk>
#                                              agent proposes an over-limit payment, asks that key,
#                                              posts it to the relay, prints the approval page URL
#   wallet_test.sh submit                      fetch your signature from the relay and settle
#
# Reads ~/.styx-near/demo.env (vault v1, NEAR payments) and ~/.styx-near/v2.env (vault-v2, Arc/Base).
# The relay token is generated once into ~/.styx-near/relay-token and never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/sdk/near/target/release/styx-near-vault"
OWNER="${OWNER:-styx-owner-c87a.testnet}"
NETWORK="${NETWORK:-testnet-fastnear}"
RELAY="${RELAY:-http://127.0.0.1:8788}"
PAGE="${PAGE:-http://localhost:5173}"
TOKEN_FILE="${RELAY_TOKEN_FILE:-$HOME/.styx-near/relay-token}"
LAST="$HOME/.styx-near/wallet-test-last.env"
[ -f "$TOKEN_FILE" ] || { umask 077; openssl rand -hex 24 > "$TOKEN_FILE"; }
TOKEN="$(cat "$TOKEN_FILE")"
field() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

case "${1:-}" in
relay)
  cd "$ROOT/relay-near"
  [ -d node_modules ] || npm ci
  mkdir -p "$HOME/.styx-near/relay" && chmod 700 "$HOME/.styx-near/relay"
  echo "relay on $RELAY, allowing the pages at localhost/127.0.0.1 ports 5173 and 5174"
  RELAY_TOKEN="$TOKEN" RELAY_STATE_FILE="$HOME/.styx-near/relay/requests.json" PORT=8788 \
    ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174" \
    exec npm start
  ;;
approver)
  pk="${2:?usage: wallet_test.sh approver ed25519:<your wallet public key>}"
  for vault in "vault.$OWNER" "vault-v2.$OWNER"; do
    near contract call-function as-transaction "$vault" set_approver json-args "{\"approver\":\"$pk\",\"enabled\":true}" \
      prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config "$NETWORK" \
      sign-with-legacy-keychain send 2>&1 | grep -E 'succeeded|panicked|rror' | head -1
    near contract call-function as-read-only "$vault" get_approver json-args "{\"approver\":\"$pk\"}" \
      network-config "$NETWORK" now 2>&1 | tr -d '\n ' | grep -oE '\{[^}]*\}' | sed "s|^|  $vault: |"
  done
  ;;
request)
  chain="${2:?usage: wallet_test.sh request near|arc|base ed25519:<your wallet public key>}"
  pk="${3:?usage: wallet_test.sh request near|arc|base ed25519:<your wallet public key>}"
  case "$chain" in
    near) envfile="$HOME/.styx-near/demo.env"; recipient="vendor-a.$OWNER"; amount=120000000; usdc=120 ;;
    arc)  envfile="$HOME/.styx-near/v2.env"; recipient="eip155:5042002:0xf4D88218d13333247BF7616AFFb45F24a21E07cc"; amount=6000000; usdc=6 ;;
    base) envfile="$HOME/.styx-near/v2.env"; recipient="eip155:84532:0xf4D88218d13333247BF7616AFFb45F24a21E07cc"; amount=6000000; usdc=6 ;;
    *) echo "chain must be near, arc or base"; exit 1 ;;
  esac
  set -a; . "$envfile"; set +a
  S="$STYX_NEAR_STATE_ROOT"; tag="wallet-$(date +%s)"; until=$(( $(date +%s) + 3600 ))
  printf 'Invoice %s: %s USDC, real-wallet approval test\n' "$tag" "$usdc" > "$S/$tag.txt"
  proposal=$(echo "{\"method\":\"propose\",\"recipient\":\"$recipient\",\"amount\":\"$amount\",\"invoice_file\":\"$S/$tag.txt\",\"invoice_reference\":\"$tag\",\"valid_until\":$until}" | STYX_NEAR_APPROVER="$pk" "$BIN")
  echo "proposed: $proposal"
  id=$(echo "$proposal" | field payment_id)
  echo "{\"method\":\"request_approval\",\"payment_id\":\"$id\",\"authorization_expiry\":$until,\"pending_file\":\"$S/$tag-pending.json\",\"signer\":\"$pk\"}" | "$BIN" >/dev/null
  request=$(python3 - "$S/$tag-pending.json" "$RELAY" "$TOKEN" <<'PY'
import json, sys, urllib.request
pending = json.load(open(sys.argv[1]))
req = urllib.request.Request(sys.argv[2] + "/requests", data=json.dumps({"pending": pending}).encode(),
                             headers={"content-type": "application/json", "authorization": "Bearer " + sys.argv[3]})
reply = json.load(urllib.request.urlopen(req, timeout=20))
print("telegram alert sent" if reply.get("alerted") else "no telegram alert (not configured, or it failed)", file=sys.stderr)
print(reply["requestId"])
PY
)
  printf 'ENVFILE=%s\nPAYMENT_ID=%s\nREQUEST_ID=%s\nTAG=%s\n' "$envfile" "$id" "$request" "$tag" > "$LAST"
  echo
  echo "Open this in the browser where your wallet is, review, and sign:"
  echo "  $PAGE/?relay=$RELAY&request=$request"
  ;;
submit)
  . "$LAST"; set -a; . "$ENVFILE"; set +a
  S="$STYX_NEAR_STATE_ROOT"
  python3 - "$RELAY" "$TOKEN" "$REQUEST_ID" "$S/$TAG-signature.json" <<'PY'
import json, os, sys, urllib.request
req = urllib.request.Request(f"{sys.argv[1]}/requests/{sys.argv[3]}/signature", headers={"authorization": "Bearer " + sys.argv[2]})
reply = json.load(urllib.request.urlopen(req, timeout=20))
if reply.get("status") != "signed":
    sys.exit(f"not signed yet: {reply}")
fd = os.open(sys.argv[4], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as out:
    json.dump(reply["signature"], out)
print("signature from", reply["signature"].get("accountId"), reply["signature"].get("publicKey"))
PY
  echo "{\"method\":\"submit\",\"payment_id\":\"$PAYMENT_ID\",\"signature_file\":\"$S/$TAG-signature.json\"}" | "$BIN"
  ;;
*)
  sed -n '2,13p' "$0"; exit 1 ;;
esac
