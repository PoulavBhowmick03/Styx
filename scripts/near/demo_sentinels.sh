#!/usr/bin/env bash
# The Sentinels demo on testnet: the swarm watches a version 3 vault, a hijacked agent drains it in
# small allowed payments, a sentinel pauses it, and the lineage log shows who did what and why.
#
# Usage: scripts/near/demo_sentinels.sh [n payments, default 20] [amount each, default 1]
# Settings: ~/.styx-near/v3.env (override STYX_NEAR_DEMO_ENV, still under ~/.styx-near/*.env), the
# same file drain_attack.sh reads: STYX_NEAR_VAULT, STYX_NEAR_AGENT_KEY_FILE, STYX_NEAR_STATE_ROOT,
# VENDOR. Optional: NEARAI_API_KEY (adds the judge), STYX_SENTINEL_UI_PORT (default 8790).
# Sentinel keys and the swarm's state live in ~/.styx-near/sentinels/. Nothing here goes in the repo.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${STYX_NEAR_DEMO_ENV:-$HOME/.styx-near/v3.env}"
case "$ENV_FILE" in "$HOME"/.styx-near/*.env) ;; *) echo 'Settings must be under ~/.styx-near/ (*.env)' >&2; exit 1;; esac
[ -f "$ENV_FILE" ] || { echo "No settings at $ENV_FILE. See docs/near/SENTINELS.md, Run it on testnet." >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
N="${1:-20}" AMOUNT="${2:-1}" PORT="${STYX_SENTINEL_UI_PORT:-8790}"
[ "${STYX_NEAR_NETWORK:-testnet}" = testnet ] || { echo 'Testnet only' >&2; exit 1; }
case "${STYX_NEAR_VAULT:-}" in *.testnet) ;; *) echo 'STYX_NEAR_VAULT must be a testnet vault' >&2; exit 1;; esac
: "${STYX_NEAR_STATE_ROOT:?STYX_NEAR_STATE_ROOT is required}"
export STYX_NEAR_CLI="${STYX_NEAR_CLI:-$ROOT/sdk/near/target/release/styx-near-vault}"
[ -x "$STYX_NEAR_CLI" ] || { echo "Build the CLI first: cargo build --release --manifest-path $ROOT/sdk/near/Cargo.toml" >&2; exit 1; }
RPC=https://rpc.testnet.near.org
EXTRA=(); [ -n "${NEARAI_API_KEY:-}" ] && EXTRA=(--extra judge)
sentinels() { uv run -q --project "$ROOT/sentinels" ${EXTRA[@]+"${EXTRA[@]}"} styx-sentinels "$@"; }
view() {
  curl -fsS "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$STYX_NEAR_VAULT\",\"method_name\":\"$1\",\"args_base64\":\"e30=\"}}" \
    | python3 -c 'import json,sys; print(json.dumps(json.loads(bytes(json.load(sys.stdin)["result"]["result"]))))'
}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say "1. The vault"
VAULT_INFO="$(view get_vault)"
python3 - "$VAULT_INFO" <<'PY'
import json, sys
v = json.loads(sys.argv[1])
if v.get("contract_version") != 3:
    sys.exit(f"This vault is contract version {v.get('contract_version')}; sentinels need version 3. Create a new vault in the console.")
if v.get("paused"):
    sys.exit("The vault is paused. Unpause it in the console (Sentinels panel), then run this again.")
print(f"{v['owner']} owns it; daily limit {int(v['vault_daily_limit']) / 1e6:g}; not paused; contract version 3.")
PY

say "2. The swarm"
if [ -n "${NEARAI_API_KEY:-}" ]; then sentinels init --vault "$STYX_NEAR_VAULT"; else sentinels init --vault "$STYX_NEAR_VAULT" --no-judge; fi
WAITING="$(python3 - "$(view get_sentinels)" "${STYX_SENTINEL_HOME:-$HOME/.styx-near/sentinels}/$STYX_NEAR_VAULT/state.json" <<'PY'
import json, sys
installed = set(json.loads(sys.argv[1]))
state = json.load(open(sys.argv[2]))
print(" ".join(m["id"] for m in state["members"] if m["status"] == "active" and m["public_key"] not in installed))
PY
)"
if [ -n "$WAITING" ]; then
  say "Not installed on the vault yet: $WAITING"
  echo "Open the 'All of them in one review' link above as the owner, sign once, then run this again."
  exit 2
fi
echo "Every active sentinel's key is on the vault, allowed only sentinel_pause."

say "3. The sentinels watch (live page: http://127.0.0.1:$PORT/)"
LOG="$STYX_NEAR_STATE_ROOT/sentinels-demo.log"
mkdir -p -m 700 "$STYX_NEAR_STATE_ROOT"
sentinels run --vault "$STYX_NEAR_VAULT" --cli "$STYX_NEAR_CLI" --rpc "$RPC" --interval 3 --ui "$PORT" \
  --attack-marker "$STYX_NEAR_STATE_ROOT/sentinel-attack.json" >"$LOG" 2>&1 &
RUNNER=$!
trap 'kill $RUNNER 2>/dev/null || true' EXIT
sleep 8
kill -0 $RUNNER 2>/dev/null || { cat "$LOG"; echo 'The runner stopped; see above.' >&2; exit 1; }
sed 's/^/  runner: /' "$LOG"

say "4. The hijacked agent drains: $N payments of $AMOUNT, each inside every limit"
"$ROOT/scripts/near/drain_attack.sh" "$N" "$AMOUNT" || true

say "5. What happened"
for _ in $(seq 1 40); do
  python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("paused") else 1)' "$(view get_vault)" && break
  sleep 3
done
python3 - "$(view get_vault)" <<'PY'
import json, sys
print("The vault is PAUSED." if json.loads(sys.argv[1]).get("paused") else "The vault is NOT paused. Check the runner log below.")
PY
sed 's/^/  runner: /' "$LOG" | grep -E 'PAUSED|retired|failed|Waiting' || true
sentinels status --vault "$STYX_NEAR_VAULT"
say "Lineage (the last 8 decisions)"
tail -n 8 "${STYX_SENTINEL_HOME:-$HOME/.styx-near/sentinels}/$STYX_NEAR_VAULT/lineage.jsonl"
cat <<NEXT

Next, as the owner, in the console's Sentinels panel:
  - read the pause reason, then Review unpause;
  - the parent scores the pause as a catch (the drain was a marked attack).
The live page stays up at http://127.0.0.1:$PORT/ until you press Ctrl+C.
NEXT
wait $RUNNER
