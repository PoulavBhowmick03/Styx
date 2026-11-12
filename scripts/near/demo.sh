#!/usr/bin/env bash
# The NEAR demo, step by step: the vault's rules read from the chain, a payment inside them, a
# payment over the per-payment limit settled with the approver's NEP-413 signature, then attacks.
# `demo.sh auto` runs every step without pausing.
#
# Reads ~/.styx-near/demo.env (outside the repo) for: STYX_NEAR_VAULT, STYX_NEAR_AGENT_KEY_FILE,
# STYX_NEAR_STATE_ROOT, STYX_NEAR_APPROVER, APPROVER_KEY_FILE, APPROVER_ACCOUNT, VENDOR, VENDOR_B.
# Optional: DEMO_ATTACKS (default "A5 A1 A4"), NETWORK for the near CLI (default testnet-fastnear).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${STYX_NEAR_DEMO_ENV:-$HOME/.styx-near/demo.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
: "${STYX_NEAR_VAULT:?}" "${STYX_NEAR_AGENT_KEY_FILE:?}" "${STYX_NEAR_STATE_ROOT:?}" "${APPROVER_KEY_FILE:?}" "${VENDOR:?}" "${VENDOR_B:?}"
BIN="${STYX_NEAR_CLI:-$ROOT/sdk/near/target/release/styx-near-vault}"
NETWORK="${NETWORK:-testnet-fastnear}"
AUTO="${1:-}"
S="$STYX_NEAR_STATE_ROOT"
AGENT_PK="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["public_key"])' "$STYX_NEAR_AGENT_KEY_FILE")"
UV=(uv run -q --with pynacl --with base58)

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; [ "$AUTO" = auto ] || read -r -p "   (enter) " _; }
cli() { echo "$1" | "$BIN"; }
field() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
view() { near contract call-function as-read-only "$STYX_NEAR_VAULT" "$1" json-args "$2" network-config "$NETWORK" now 2>&1 | awk '/^[{"0-9]/{f=1} f&&/^$/{exit} f'; }

step "The vault's rules for this agent, read from the chain"
echo "agent key: $AGENT_PK"
view get_agent "{\"agent\":\"$AGENT_PK\"}"
echo "keys on the vault account (the agent's is a function-call key, pay methods only):"
near account list-keys "$STYX_NEAR_VAULT" network-config "$NETWORK" now 2>&1 | grep -E 'ed25519' | sed 's/^/  /'

until=$(( $(date +%s) + 3600 )); tag=$(date +%s)
step "A payment inside the limits: 25 tUSDC"
printf 'Invoice %s-A: 25 USDC, API credits\n' "$tag" > "$S/demo-$tag-a.txt"
p=$(cli "{\"method\":\"propose\",\"recipient\":\"$VENDOR\",\"amount\":\"25000000\",\"invoice_file\":\"$S/demo-$tag-a.txt\",\"invoice_reference\":\"DEMO-$tag-A\",\"valid_until\":$until}")
echo "$p"; id=$(echo "$p" | field payment_id)
cli "{\"method\":\"submit\",\"payment_id\":\"$id\"}"

step "Over the per-payment limit: 140 tUSDC. The agent cannot pay it alone"
printf 'Invoice %s-B: 140 USDC, GPU hours\n' "$tag" > "$S/demo-$tag-b.txt"
p=$(cli "{\"method\":\"propose\",\"recipient\":\"$VENDOR\",\"amount\":\"140000000\",\"invoice_file\":\"$S/demo-$tag-b.txt\",\"invoice_reference\":\"DEMO-$tag-B\",\"valid_until\":$until}")
echo "$p"; id=$(echo "$p" | field payment_id)
cli "{\"method\":\"submit\",\"payment_id\":\"$id\"}" || true

step "The agent asks the approver; the approver signs this exact payment (NEP-413)"
cli "{\"method\":\"request_approval\",\"payment_id\":\"$id\",\"authorization_expiry\":$until,\"pending_file\":\"$S/demo-$tag-pending.json\"}"
"${UV[@]}" "$ROOT/scripts/near/test_approver.py" "$APPROVER_KEY_FILE" "$S/demo-$tag-pending.json" "$S/demo-$tag-signature.json" >/dev/null
echo "signed: $S/demo-$tag-signature.json"

step "The agent submits with the signature; the vault checks it and pays"
cli "{\"method\":\"submit\",\"payment_id\":\"$id\",\"signature_file\":\"$S/demo-$tag-signature.json\"}"

step "Attacks with the agent's own key: ${DEMO_ATTACKS:-A5 A1 A4}"
ATTACKS="${DEMO_ATTACKS:-A5 A1 A4}" VAULT="$STYX_NEAR_VAULT" AGENT_KEY_FILE="$STYX_NEAR_AGENT_KEY_FILE" \
  PENDING_FILE="$S/demo-$tag-pending.json" SIGNATURE_FILE="$S/demo-$tag-signature.json" VENDOR_B="$VENDOR_B" NETWORK="$NETWORK" \
  "${UV[@]}" "$ROOT/scripts/near/attacks.py"

step "The rules are unchanged"
view get_agent "{\"agent\":\"$AGENT_PK\"}"
