#!/usr/bin/env bash
# A legitimate burst (a payroll round) that is NOT marked as an attack. A sentinel pauses the vault,
# the owner unpauses it in the console, and the parent scores the pause as a false alarm. At score -2
# it retires that sentinel and spawns the next generation with a higher threshold; one console link
# (remove the old key, install the new one) is signed by the owner.
#
# Usage: scripts/near/false_alarm.sh [n payments, default 5] [amount each, default 1]
#   First round, burst-g1 (more than 4 in 5 minutes):   false_alarm.sh 5 1   -> paused, retired, g2 spawned
#   Second round, burst-g2 (more than 6 in 5 minutes):  false_alarm.sh 6 1   -> goes through, no pause
# Settings: ~/.styx-near/v3.env, the same file demo_sentinels.sh reads. Testnet only. Nothing here is
# written inside the repo; sentinel keys and state live in ~/.styx-near/sentinels/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${STYX_NEAR_DEMO_ENV:-$HOME/.styx-near/v3.env}"
case "$ENV_FILE" in "$HOME"/.styx-near/*.env) ;; *) echo 'Settings must be under ~/.styx-near/ (*.env)' >&2; exit 1;; esac
[ -f "$ENV_FILE" ] || { echo "No settings at $ENV_FILE. See docs/near/SENTINELS.md, Run it on testnet." >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
N="${1:-5}" AMOUNT="${2:-1}" PORT="${STYX_SENTINEL_UI_PORT:-8790}"
[ "${STYX_NEAR_NETWORK:-testnet}" = testnet ] || { echo 'Testnet only' >&2; exit 1; }
case "${STYX_NEAR_VAULT:-}" in *.testnet) ;; *) echo 'STYX_NEAR_VAULT must be a testnet vault' >&2; exit 1;; esac
: "${STYX_NEAR_STATE_ROOT:?STYX_NEAR_STATE_ROOT is required}"
export STYX_NEAR_CLI="${STYX_NEAR_CLI:-$ROOT/sdk/near/target/release/styx-near-vault}"
[ -x "$STYX_NEAR_CLI" ] || { echo "Build the CLI first: cargo build --release --manifest-path $ROOT/sdk/near/Cargo.toml" >&2; exit 1; }
RPC="${STYX_SENTINEL_RPC:-https://test.rpc.fastnear.com}"
SWARM_HOME="${STYX_SENTINEL_HOME:-$HOME/.styx-near/sentinels}/$STYX_NEAR_VAULT"
EXTRA=(); [ -n "${NEARAI_API_KEY:-}" ] && EXTRA=(--extra judge)
sentinels() { uv run -q --project "$ROOT/sentinels" ${EXTRA[@]+"${EXTRA[@]}"} styx-sentinels "$@"; }
view() {
  curl -fsS --retry 4 --retry-delay 3 --retry-all-errors "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$STYX_NEAR_VAULT\",\"method_name\":\"$1\",\"args_base64\":\"e30=\"}}" \
    | python3 -c 'import json,sys; print(json.dumps(json.loads(bytes(json.load(sys.stdin)["result"]["result"]))))'
}
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# Waits up to $1 seconds for a python expression over `v` (the parsed view result of method $2) to hold.
wait_for_view() {
  local deadline=$((SECONDS + $1)) out
  while [ $SECONDS -lt $deadline ]; do
    out="$(view "$2" 2>/dev/null || echo null)"
    python3 -c 'import json,sys; v=json.loads(sys.argv[1]); sys.exit(0 if ('"$3"') else 1)' "$out" 2>/dev/null && return 0
    sleep 3
  done
  return 1
}

say "1. The vault and the swarm"
python3 - "$(view get_vault)" <<'PY'
import json, sys
v = json.loads(sys.argv[1])
if v.get("contract_version") != 3:
    sys.exit(f"Contract version {v.get('contract_version')}: sentinels need version 3.")
if v.get("paused"):
    sys.exit("The vault is paused. Unpause it in the console (Sentinels panel), then run this again.")
print(f"{v['owner']} owns it; not paused; contract version 3.")
PY
[ -f "$SWARM_HOME/state.json" ] || { echo "No swarm yet. Run scripts/near/demo_sentinels.sh once, or: styx-sentinels init --vault $STYX_NEAR_VAULT" >&2; exit 1; }
python3 - "$(view get_sentinels)" "$SWARM_HOME/state.json" <<'PY'
import json, sys
installed = set(json.loads(sys.argv[1]))
active = [m for m in json.load(open(sys.argv[2]))["members"] if m["status"] == "active"]
for m in active:
    print(f"  {m['id']:18} {'on the vault' if m['public_key'] in installed else 'NOT on the vault'}  {json.dumps(m['params'])}")
sys.exit(0 if any(m["kind"] == "burst" and m["public_key"] in installed for m in active) else "No burst sentinel is installed on the vault; sign the swarm's link first.")
PY
BEFORE="$(python3 -c 'import json,sys; print(" ".join(sorted(m["id"] for m in json.load(open(sys.argv[1]))["members"] if m["status"]=="active")))' "$SWARM_HOME/state.json")"

say "2. The sentinels watch (live page: http://127.0.0.1:$PORT/)"
LOG="$STYX_NEAR_STATE_ROOT/false-alarm.log" PAYLOG="$STYX_NEAR_STATE_ROOT/false-alarm-payments.log"
mkdir -p -m 700 "$STYX_NEAR_STATE_ROOT"
PYTHONUNBUFFERED=1 sentinels run --vault "$STYX_NEAR_VAULT" --cli "$STYX_NEAR_CLI" --rpc "$RPC" --ui "$PORT" \
  --attack-marker "$STYX_NEAR_STATE_ROOT/sentinel-attack.json" >"$LOG" 2>&1 &
RUNNER=$!
trap 'kill $RUNNER 2>/dev/null || true' EXIT
sleep 8
kill -0 $RUNNER 2>/dev/null || { cat "$LOG"; echo 'The runner stopped; see above.' >&2; exit 1; }

say "3. A legitimate burst: a payroll round of $N payments of $AMOUNT, NOT marked as an attack"
STYX_NEAR_NO_ATTACK_MARK=1 "$ROOT/scripts/near/drain_attack.sh" "$N" "$AMOUNT" 2>&1 | tee "$PAYLOG" || true

say "4. Did a sentinel pause it?"
if wait_for_view 45 get_vault 'v.get("paused")'; then
  grep -E 'PAUSED' "$LOG" | sed 's/^/  runner: /' || true
  cat <<NEXT

The vault is PAUSED, and nobody marked an attack, so this is a false alarm if the owner unpauses.
Now, as the owner, in the console (https://styxco.xyz/console/, Sentinels panel):
  1. read the pause reason, then Review unpause, and sign it.
This script waits up to 15 minutes for the unpause.
NEXT
  wait_for_view 900 get_vault 'not v.get("paused")' || { echo 'The vault is still paused. Unpause it, then run this again.' >&2; exit 1; }
  echo "Unpaused."

  say "5. The parent scores the pause and decides"
  for _ in $(seq 1 40); do grep -q 'retired' "$LOG" && break; sleep 3; done
  grep -E 'retired|PAUSED' "$LOG" | sed 's/^/  runner: /' || true
  if grep -q 'retired' "$LOG"; then
    sentinels status --vault "$STYX_NEAR_VAULT"
    cat <<NEXT

The sentinel was retired and its next generation spawned. As the owner, open the link printed above
("All of them in one review"), and sign once: it removes the old key and installs the new one.
This script waits up to 15 minutes for the vault to show it.
NEXT
    # Done when every active sentinel's key is on the vault and no retired sentinel's key still is.
    synced=0
    for _ in $(seq 1 300); do
      python3 - "$(view get_sentinels 2>/dev/null || echo null)" "$SWARM_HOME/state.json" <<'PY' && { synced=1; break; }
import json, sys
installed = json.loads(sys.argv[1])
if not isinstance(installed, list):
    sys.exit(1)
members = json.load(open(sys.argv[2]))["members"]
ok = all(m["public_key"] in installed for m in members if m["status"] == "active") and \
     not any(m["public_key"] in installed for m in members if m["status"] == "retired")
sys.exit(0 if ok else 1)
PY
      sleep 3
    done
    [ "$synced" = 1 ] && echo "The vault now has the new sentinel's key and not the old one." || echo "The key change is not on the vault yet; sign the link, then run \`styx-sentinels status\`."
    sleep 10  # let the runner's state catch up
  else
    echo "No retirement yet: the score is above the retire threshold. See the lineage below."
  fi
else
  echo "The vault was NOT paused: this round stayed inside the sentinels' thresholds."
  grep -E 'PAUSED|failed' "$LOG" | sed 's/^/  runner: /' || true
fi

say "6. Result"
sentinels status --vault "$STYX_NEAR_VAULT"
AFTER="$(python3 -c 'import json,sys; print(" ".join(sorted(m["id"] for m in json.load(open(sys.argv[1]))["members"] if m["status"]=="active")))' "$SWARM_HOME/state.json")"
echo "Active sentinels before: $BEFORE"
echo "Active sentinels now:    $AFTER"
say "Lineage (the last 10 decisions)"
tail -n 10 "$SWARM_HOME/lineage.jsonl"

say "Transactions to record in docs/near/TESTNET_RUN.md (scripts/near/tx_outcome.sh <hash> <signer>)"
python3 - "$PAYLOG" "$SWARM_HOME" "$STYX_NEAR_VAULT" <<'PY'
import json, sys
from pathlib import Path
paylog, home, vault = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
for line in paylog.read_text().splitlines():
    try:
        r = json.loads(line)
    except ValueError:
        continue
    if isinstance(r, dict) and r.get("tx_hash"):
        print(f"  payment ({r.get('method', r.get('state', 'step'))}): tx_outcome.sh {r['tx_hash']} {vault}")
for line in (home / "lineage.jsonl").read_text().splitlines():
    e = json.loads(line)
    if e["action"] == "pause" and e.get("tx"):
        print(f"  {e['member']} pause: tx_outcome.sh {e['tx']} {vault}")
state = json.loads((home / "state.json").read_text())
for e in state.get("events", []):
    if e["type"] == "unpaused":
        print(f"  owner unpause: tx_outcome.sh {e['tx']} <owner account>")
print("  the key change (remove old, install new): its hash is in the owner's wallet history or on NearBlocks")
PY
echo
echo "The live page stays up at http://127.0.0.1:$PORT/ until you press Ctrl+C."
wait $RUNNER
