#!/usr/bin/env bash
# README step 3: the MCP server an agent uses, against the vault quickstart.sh made for you.
#
#   scripts/near/mcp_quickstart.sh [path/to/demo.env]
#
# Uses the newest ~/.styx-near-quickstart/<account>/demo.env unless given one. Installs the Python
# workspace (uv sync --all-packages), starts a local relay on a random token (memory only, stopped
# on exit), then runs scripts/near/mcp_e2e.py: the agent asks for 130 tUSDC to vendor-b (over the
# 100 limit), the MCP tool says it needs approval, the quickstart's test approver signs through the
# relay, and the agent settles. Nothing of ours is used; the keys are the ones quickstart made.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="${1:-$(ls -t "$HOME"/.styx-near-quickstart/*/demo.env 2>/dev/null | head -1)}"
[ -n "$ENVFILE" ] && [ -f "$ENVFILE" ] || { echo "No demo.env: run scripts/near/quickstart.sh first, or pass its demo.env."; exit 1; }
echo "vault settings: $ENVFILE"
set -a; . "$ENVFILE"; set +a

cargo build -q --release --manifest-path "$ROOT/sdk/near/Cargo.toml"
(cd "$ROOT" && uv sync -q --all-packages)
(cd "$ROOT/relay-near" && { [ -d node_modules ] || npm ci --silent; } && npm run -s build >/dev/null)

PORT="${PORT:-8799}"
TOKEN="$(openssl rand -hex 24)"
(cd "$ROOT/relay-near" && RELAY_TOKEN="$TOKEN" PORT="$PORT" exec node dist/main.cjs) >/dev/null 2>&1 &
RELAY_PID=$!
trap 'kill $RELAY_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "local relay did not start"; exit 1; }
echo "local relay on 127.0.0.1:$PORT"

cd "$ROOT"
RELAY_URL="http://127.0.0.1:$PORT" RELAY_TOKEN="$TOKEN" \
STYX_NEAR_CLI="$ROOT/sdk/near/target/release/styx-near-vault" \
RECIPIENT="${RECIPIENT:-$VENDOR_B}" AMOUNT="${AMOUNT:-130000000}" \
  uv run -q --with pynacl --with base58 python scripts/near/mcp_e2e.py
