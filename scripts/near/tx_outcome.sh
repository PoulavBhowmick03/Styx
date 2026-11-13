#!/usr/bin/env bash
# Prints one testnet transaction's outcome: receiver, the methods it called, and whether every receipt
# succeeded. Read-only RPC; no keys.
#   scripts/near/tx_outcome.sh <tx hash> <signer account> [rpc url]
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: $0 <tx hash> <signer account> [rpc url]" >&2; exit 2; }
RPC="${3:-https://rpc.testnet.near.org}"
curl -fsS "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tx\",\"params\":{\"tx_hash\":\"$1\",\"sender_account_id\":\"$2\",\"wait_until\":\"FINAL\"}}" |
python3 -c '
import json, sys
d = json.load(sys.stdin)
if "error" in d: sys.exit("RPC error: " + json.dumps(d["error"])[:300])
r = d["result"]; t = r["transaction"]
methods = [a["FunctionCall"]["method_name"] if isinstance(a, dict) and "FunctionCall" in a else (a if isinstance(a, str) else next(iter(a))) for a in t["actions"]]
failures = [o["outcome"]["status"]["Failure"] for o in r["receipts_outcome"] if "Failure" in o["outcome"]["status"]]
if "Failure" in r["status"]: failures.insert(0, r["status"]["Failure"])
print(t["hash"] + "  " + t["signer_id"] + " -> " + t["receiver_id"] + "  " + ",".join(methods))
print("OK: every receipt succeeded" if not failures else "FAILED: " + json.dumps(failures[0])[:300])
sys.exit(1 if failures else 0)
'
