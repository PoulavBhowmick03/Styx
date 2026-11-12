#!/usr/bin/env bash
# One agent key, one NEAR vault, two chains. The invoice names the chain (CAIP-10 recipient);
# the vault applies the same limits on both and has NEAR's MPC network sign for its own address.
# `demo_multichain.sh auto` runs without pausing.
#
# Reads ~/.styx-near/v2.env (outside the repo): STYX_NEAR_VAULT, STYX_NEAR_AGENT_KEY_FILE,
# STYX_NEAR_STATE_ROOT, STYX_NEAR_APPROVER, STYX_NEAR_EVM_RPCS (both chains), APPROVER_KEY_FILE,
# APPROVER_ACCOUNT, EVM_VENDOR, EVM_VENDOR_B.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; . "${STYX_NEAR_ARC_ENV:-$HOME/.styx-near/v2.env}"; set +a
: "${STYX_NEAR_EVM_RPCS:?}" "${EVM_VENDOR:?}" "${EVM_VENDOR_B:?}" "${APPROVER_ACCOUNT:?}"
BIN="${STYX_NEAR_CLI:-$ROOT/sdk/near/target/release/styx-near-vault}"
NETWORK="${NETWORK:-testnet-fastnear}"; AUTO="${1:-}"; S="$STYX_NEAR_STATE_ROOT"
ARC=5042002; BASE=84532
ARC_USDC=0x3600000000000000000000000000000000000000; BASE_USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
rpc() { tr ',' '\n' <<<"$STYX_NEAR_EVM_RPCS" | sed -n "s/^ *$1=//p" | head -1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; [ "$AUTO" = auto ] || read -r -p "   (enter) " _; }
cli() { echo "$1" | "$BIN"; }
field() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
usdc() { cast call "$2" 'balanceOf(address)(uint256)' "$3" --rpc-url "$(rpc "$1")" | awk '{printf "%.6f", $1/1e6}'; }
VAULT_EVM="$("$ROOT/scripts/near/derived_address.sh" "$STYX_NEAR_VAULT")"
balances() {
  echo "Arc  (chain $ARC): vault $(usdc $ARC $ARC_USDC "$VAULT_EVM") USDC, vendor $(usdc $ARC $ARC_USDC "$EVM_VENDOR") USDC"
  echo "Base (chain $BASE): vault $(usdc $BASE $BASE_USDC "$VAULT_EVM") USDC, vendor $(usdc $BASE $BASE_USDC "$EVM_VENDOR") USDC"
}
until=$(( $(date +%s) + 3600 )); tag=$(date +%s)
pay() { # chain amount label [signature]
  printf 'Invoice %s %s\n' "$tag" "$3" > "$S/mc-$tag-$3.txt"
  local id; id=$(cli "{\"method\":\"propose\",\"recipient\":\"eip155:$1:$EVM_VENDOR\",\"amount\":\"$2\",\"invoice_file\":\"$S/mc-$tag-$3.txt\",\"invoice_reference\":\"MC-$tag-$3\",\"valid_until\":$until}" | field payment_id)
  echo "$id" > "$S/mc-$tag-$3.id"
  cli "{\"method\":\"submit\",\"payment_id\":\"$id\"}" || true
}

step "One vault on NEAR, one address on every EVM chain: $VAULT_EVM"
balances
step "Inside the limits on Arc: 2 USDC"
pay $ARC 2000000 arc-a
step "Inside the limits on Base, same agent key: 3 USDC"
pay $BASE 3000000 base-a
step "Over the 5 USDC limit on Base: 7 USDC is refused until the approver signs"
pay $BASE 7000000 base-b
id=$(cat "$S/mc-$tag-base-b.id")
cli "{\"method\":\"request_approval\",\"payment_id\":\"$id\",\"authorization_expiry\":$until,\"pending_file\":\"$S/mc-$tag-pending.json\"}" >/dev/null
uv run -q --with pynacl --with base58 "$ROOT/scripts/near/test_approver.py" "$APPROVER_KEY_FILE" "$S/mc-$tag-pending.json" "$S/mc-$tag-signature.json" >/dev/null
echo "approver signed this exact payment, chain id included"
cli "{\"method\":\"submit\",\"payment_id\":\"$id\",\"signature_file\":\"$S/mc-$tag-signature.json\"}"
step "The agent attacks the vault directly with its own key, on both chains"
attack() { VAULT="$STYX_NEAR_VAULT" AGENT_KEY_FILE="$STYX_NEAR_AGENT_KEY_FILE" PENDING_FILE="$S/mc-$tag-pending.json" \
  SIGNATURE_FILE="$S/mc-$tag-signature.json" VENDOR_B="$EVM_VENDOR_B" NETWORK="$NETWORK" "$@" \
  uv run -q --with pynacl --with base58 "$ROOT/scripts/near/attacks_evm.py"; }
attack env ATTACKS="E1" ATTACK_CHAIN_ID=$ARC ATTACK_RECIPIENT="$EVM_VENDOR"
attack env ATTACKS="E1 E2 E3 E4 E5 E6" ATTACK_CHAIN_ID=$BASE ATTACK_RECIPIENT="$EVM_VENDOR"
step "Balances after"
balances
