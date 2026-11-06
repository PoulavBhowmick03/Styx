#!/usr/bin/env bash
# Rehearses scripts/run_gates.sh on a local chain with a mock token. Anvil answers the owner page's
# signing request, so no wallet is needed and no key is stored. Needs Foundry and built binaries.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$(cd "$(mktemp -d)" && pwd -P)"; chmod 700 "$W"
PORT="${PORT:-18555}"; RPC="http://127.0.0.1:$PORT"
anvil --port "$PORT" --silent --config-out "$W/anvil.json" >/dev/null &
ANVIL=$!
trap 'kill "$ANVIL" 2>/dev/null || true; [ -n "${WATCH:-}" ] && kill "$WATCH" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && [ -f "$W/anvil.json" ] && break; sleep 0.2; done
key() { python3 -c "import json;print(json.load(open('$W/anvil.json'))['private_keys'][$1])"; }
OWNER_KEY="$(key 0)"; AGENT_KEY="$(key 1)"
OWNER="$(cast wallet address --private-key "$OWNER_KEY" | tr 'A-F' 'a-f')"
AGENT="$(cast wallet address --private-key "$AGENT_KEY" | tr 'A-F' 'a-f')"
A=0x00000000000000000000000000000000000000a1; B=0x00000000000000000000000000000000000000b2
create() { local c="$1"; shift; (cd "$ROOT/contracts/evm" && forge create "$c" --broadcast --rpc-url "$RPC" --private-key "$OWNER_KEY" --constructor-args "$@" 2>/dev/null) | sed -n 's/^Deployed to: //p' | tr 'A-F' 'a-f'; }
TOKEN="$(create src/MockERC20.sol:MockERC20 "USD Coin" USDC)"
VAULT_ADDRESS="$(create src/StyxPolicyVault.sol:StyxPolicyVault "$OWNER" "$TOKEN")"
send() { cast send "$@" --rpc-url "$RPC" --private-key "$OWNER_KEY" >/dev/null; }
send "$VAULT_ADDRESS" 'configurePolicy(address,uint256,uint256,uint64)' "$AGENT" 1000000 10000000 $(( $(date +%s) + 86400 ))
send "$VAULT_ADDRESS" 'setRecipient(address,bool)' "$A" true
send "$VAULT_ADDRESS" 'setRecipient(address,bool)' "$B" true
send "$TOKEN" 'mint(address,uint256)' "$VAULT_ADDRESS" 8000000
printf '%s' "$AGENT_KEY" > "$W/agent.key"; chmod 600 "$W/agent.key"
python3 -c 'import os,sys; sys.stdout.buffer.write(os.urandom(32))' > "$W/issuer.key"; chmod 600 "$W/issuer.key"
cat > "$W/owner.json" <<JSON
{"chainId":"31337","vault":"$VAULT_ADDRESS","owner":"$OWNER","token":"$TOKEN","vendors":{"$A":"Vendor A"}}
JSON
export OUT="$W/run" STYX_VAULT_CHAIN_ID=31337 STYX_VAULT_RPC_URLS="$RPC" STYX_VAULT_ADDRESS="$VAULT_ADDRESS" STYX_VAULT_TOKEN="$TOKEN"
export STYX_VAULT_AGENT_KEY_FILE="$W/agent.key" VENDOR_A="$A" VENDOR_B="$B" ISSUER_KEY_FILE="$W/issuer.key" WAIT_SECONDS=60

# Plays the owner: the page's logic reviews each pending file, and Anvil signs as the wallet would.
(
  while :; do
    for pending in "$OUT"/pending-*.json; do
      [ -s "$pending" ] || continue
      if [ ! -s "$OUT/signature.json" ]; then
        (cd "$ROOT/owner-page" && npx --no-install tsx test/sign_with_rpc.mts "$W/owner.json" "$pending" "$RPC" "$OUT/signature.tmp")
        mv "$OUT/signature.tmp" "$OUT/signature.json"
      fi
    done
    sleep 0.3
  done
) &
WATCH=$!
"$ROOT/scripts/run_gates.sh"
