#!/usr/bin/env bash
# The reviewer's side, end to end, with your own key: after scripts/near/quickstart.sh.
#
#   scripts/near/reviewer_quickstart.sh [path/to/demo.env]
#
# 1. makes your reviewer key (X25519) next to the quickstart's keys, once;
# 2. the agent pays 5 tUSDC to vendor-a from your quickstart vault;
# 3. the agent seals that payment's record to your public key and posts it (post_record);
# 4. you open it with your private key and check it against the chain with your RPC.
# Nobody else's key is involved, and the record can only be opened with yours.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="${1:-$(ls -t "$HOME"/.styx-near-quickstart/*/demo.env 2>/dev/null | head -1)}"
[ -n "$ENVFILE" ] && [ -f "$ENVFILE" ] || { echo "No demo.env: run scripts/near/quickstart.sh first, or pass its demo.env."; exit 1; }
set -a; . "$ENVFILE"; set +a
RPC="${RPC:-https://test.rpc.fastnear.com}"
DIR="$(dirname "$ENVFILE")"
BIN="$ROOT/sdk/near/target/release/styx-near-vault"
REVIEW=(uv run -q --project "$ROOT/reviewer-near" styx-near-review)
field() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

cargo build -q --release --manifest-path "$ROOT/sdk/near/Cargo.toml"
KEY="$DIR/reviewer.json"
if [ -f "$KEY" ]; then
  PUB=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["public_key"])' "$KEY")
else
  PUB=$("${REVIEW[@]}" keygen "$KEY")
fi
echo "1/4 your reviewer key: $PUB (private part in $KEY, mode 600)"

TAG="review-$(date +%s)"
printf 'Invoice %s: 5 tUSDC to %s, for the reviewer walkthrough\n' "$TAG" "$VENDOR" > "$STYX_NEAR_STATE_ROOT/$TAG.txt"
UNTIL=$(( $(date +%s) + 3600 ))
ID=$(echo "{\"method\":\"propose\",\"recipient\":\"$VENDOR\",\"amount\":\"5000000\",\"invoice_file\":\"$STYX_NEAR_STATE_ROOT/$TAG.txt\",\"invoice_reference\":\"$TAG\",\"valid_until\":$UNTIL}" | "$BIN" | field payment_id)
PAY=$(echo "{\"method\":\"submit\",\"payment_id\":\"$ID\"}" | "$BIN" | field tx_hash)
echo "2/4 paid 5 tUSDC: https://testnet.nearblocks.io/txns/$PAY"

REC=$(echo "{\"method\":\"export_record\",\"payment_id\":\"$ID\",\"record_file\":\"$STYX_NEAR_STATE_ROOT/$TAG-record.json\"}" | STYX_NEAR_REVIEWER_KEY="$PUB" "$BIN" | field tx_hash)
echo "3/4 record sealed to your key and posted: https://testnet.nearblocks.io/txns/$REC"

echo "4/4 you verify it with your own key and RPC:"
"${REVIEW[@]}" verify --key "$KEY" --rpc "$RPC" --vault "$STYX_NEAR_VAULT" --tx "$REC"
