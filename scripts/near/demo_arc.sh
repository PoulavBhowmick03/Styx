#!/usr/bin/env bash
# The Chain Signatures demo: the same agent key, the same NEAR vault rules, a USDC payment on Arc.
# `demo_arc.sh auto` runs without pausing. Reads ~/.styx-near/v2.env (outside the repo):
# STYX_NEAR_VAULT, STYX_NEAR_AGENT_KEY_FILE, STYX_NEAR_STATE_ROOT, STYX_NEAR_APPROVER,
# STYX_NEAR_EVM_CHAIN_ID, STYX_NEAR_EVM_RPC; plus APPROVER_KEY_FILE, APPROVER_ACCOUNT, EVM_VENDOR.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${STYX_NEAR_ARC_ENV:-$HOME/.styx-near/v2.env}"
set -a; . "$ENV_FILE"; set +a
: "${APPROVER_KEY_FILE:=$HOME/.styx-near/approver.json}" "${APPROVER_ACCOUNT:?}" "${EVM_VENDOR:?}"
BIN="${STYX_NEAR_CLI:-$ROOT/sdk/near/target/release/styx-near-vault}"
NETWORK="${NETWORK:-testnet-fastnear}"
AUTO="${1:-}"; S="$STYX_NEAR_STATE_ROOT"
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; [ "$AUTO" = auto ] || read -r -p "   (enter) " _; }
cli() { echo "$1" | "$BIN"; }
field() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
usdc() { cast call 0x3600000000000000000000000000000000000000 'balanceOf(address)(uint256)' "$1" --rpc-url "$STYX_NEAR_EVM_RPC" | awk '{printf "%.6f USDC\n", $1/1e6}'; }
FROM="$(near contract call-function as-read-only v1.signer-prod.testnet derived_public_key json-args "{\"path\":\"styx-evm\",\"predecessor\":\"$STYX_NEAR_VAULT\",\"domain_id\":0}" network-config "$NETWORK" now 2>&1 | grep -oE 'secp256k1:[1-9A-HJ-NP-Za-km-z]+' | head -1)"
FROM_ADDR="0x$(python3 -c "
import sys
a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; n=0
for c in sys.argv[1].split(':')[1]: n=n*58+a.index(c)
print(n.to_bytes(64,'big').hex())" "$FROM" | xargs -I{} cast keccak 0x{} | cut -c27-)"

step "The vault on NEAR owns an address on Arc, derived by NEAR's MPC network: $FROM_ADDR"
echo "vault's Arc balance: $(usdc "$FROM_ADDR")   vendor: $(usdc "$EVM_VENDOR")"
until=$(( $(date +%s) + 3600 )); tag=$(date +%s)
step "The agent pays 3 USDC on Arc, inside its NEAR limits"
printf 'Invoice %s-A: 3 USDC\n' "$tag" > "$S/arc-$tag-a.txt"
id=$(cli "{\"method\":\"propose\",\"recipient\":\"$EVM_VENDOR\",\"amount\":\"3000000\",\"invoice_file\":\"$S/arc-$tag-a.txt\",\"invoice_reference\":\"ARC-$tag-A\",\"valid_until\":$until}" | field payment_id)
cli "{\"method\":\"submit\",\"payment_id\":\"$id\"}"
step "Over the limit: 6 USDC needs the approver's signature, even on another chain"
printf 'Invoice %s-B: 6 USDC\n' "$tag" > "$S/arc-$tag-b.txt"
id=$(cli "{\"method\":\"propose\",\"recipient\":\"$EVM_VENDOR\",\"amount\":\"6000000\",\"invoice_file\":\"$S/arc-$tag-b.txt\",\"invoice_reference\":\"ARC-$tag-B\",\"valid_until\":$until}" | field payment_id)
cli "{\"method\":\"submit\",\"payment_id\":\"$id\"}" || true
cli "{\"method\":\"request_approval\",\"payment_id\":\"$id\",\"authorization_expiry\":$until,\"pending_file\":\"$S/arc-$tag-pending.json\"}" >/dev/null
APPROVER_ACCOUNT="$APPROVER_ACCOUNT" uv run -q --with pynacl --with base58 "$ROOT/scripts/near/test_approver.py" "$APPROVER_KEY_FILE" "$S/arc-$tag-pending.json" "$S/arc-$tag-signature.json" >/dev/null
echo "approver signed this exact payment"
cli "{\"method\":\"submit\",\"payment_id\":\"$id\",\"signature_file\":\"$S/arc-$tag-signature.json\"}"
step "Balances on Arc"
echo "vault's Arc balance: $(usdc "$FROM_ADDR")   vendor: $(usdc "$EVM_VENDOR")"
