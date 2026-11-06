#!/usr/bin/env bash
# Sends attacks A1 to A4 as real transactions, so rehearsal and the live demo behave the same.
# Every attack must revert. Exits nonzero if any transaction succeeds.
#
# Needs from the environment, never from this repo:
#   RPC_URL            the chain's RPC
#   VAULT              the vault address
#   VENDOR_B           an allowlisted recipient other than the approved one
#   AGENT_KEY_FILE     owner-only file holding the agent's hex key
#   OWNER_SIGNATURE_FILE  the vault-owner-signature/1 file for the settled exception
#   PENDING_FILE          the vault-pending-approval/1 file for the settled exception
set -euo pipefail

: "${RPC_URL:?}" "${VAULT:?}" "${AGENT_KEY_FILE:?}" "${VENDOR_B:?}" "${OWNER_SIGNATURE_FILE:?}" "${PENDING_FILE:?}"

# Arc rejects a maxFeePerGas below 20 gwei. The fixed gas limit skips estimation, which would
# otherwise stop the attack before it reached the chain.
GAS_ARGS=(--gas-limit 500000 --gas-price 40000000000 --priority-gas-price 1000000000)
PAY='pay((bytes32,address,address,address,uint256,bytes32,uint256,uint64))'
PAY_EXCEPTION='payWithException((bytes32,address,address,address,uint256,bytes32,uint256,uint64),(bytes32,uint256,uint64),bytes)'

agent_key="$(tr -d '[:space:]' <"$AGENT_KEY_FILE")"
agent="$(cast wallet address --private-key "$agent_key")"

field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); [d:=d[k] for k in sys.argv[2:]]; print(d)' "$@"; }

payment_tuple() { # paymentId recipient amount
  printf '(%s,%s,%s,%s,%s,%s,%s,%s)' "$1" \
    "$(field "$PENDING_FILE" payment agent)" "$(field "$PENDING_FILE" payment token)" "$2" "$3" \
    "$(field "$PENDING_FILE" payment evidenceCommitment)" "$(field "$PENDING_FILE" payment policyVersion)" \
    "$(field "$PENDING_FILE" payment validUntil)"
}

authorization_tuple() { # paymentHash approvalNonce authorizationExpiry
  printf '(%s,%s,%s)' "$1" "$2" "$3"
}

expect_revert() { # label signature args...
  local label="$1"
  shift
  local result status tx
  result="$(cast send --json --rpc-url "$RPC_URL" --private-key "$agent_key" "${GAS_ARGS[@]}" "$VAULT" "$@" 2>&1)" || true
  status="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
  tx="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("transactionHash",""))' 2>/dev/null || true)"
  case "$status" in
    0x0 | 0) printf 'PASS %s reverted on chain: %s\n' "$label" "$tx" ;;
    0x1 | 1)
      printf 'FAIL %s succeeded: %s\n' "$label" "$tx"
      exit 1
      ;;
    *)
      printf 'UNKNOWN %s produced no receipt; check the explorer before trusting this run.\n' "$label"
      exit 2
      ;;
  esac
}

payment_id="$(field "$PENDING_FILE" payment paymentId)"
amount="$(field "$PENDING_FILE" payment amount)"
vendor_a="$(field "$PENDING_FILE" payment recipient)"
payment_hash="$(field "$PENDING_FILE" authorization paymentHash)"
nonce="$(field "$PENDING_FILE" authorization approvalNonce)"
expiry="$(field "$PENDING_FILE" authorization authorizationExpiry)"
owner_signature="$(field "$OWNER_SIGNATURE_FILE" signature)"
digest="$(field "$OWNER_SIGNATURE_FILE" approvalDigest)"
new_id="$(cast keccak "attack-$(date +%s)")"
original="$(payment_tuple "$payment_id" "$vendor_a" "$amount")"
fresh="$(payment_tuple "$new_id" "$vendor_a" "$amount")"
redirected="$(payment_tuple "$payment_id" "$VENDOR_B" "$amount")"

echo "Agent: $agent"

# A1: the agent calls pay() directly for the exception amount, skipping the tools.
expect_revert "A1 over the per-payment limit" "$PAY" "$fresh"

# A2: the agent signs the exception with its own key. Run before the exception settles.
agent_signature="$(cast wallet sign --no-hash --private-key "$agent_key" "$digest")"
expect_revert "A2 signer is not the owner" "$PAY_EXCEPTION" "$original" \
  "$(authorization_tuple "$payment_hash" "$nonce" "$expiry")" "$agent_signature"

# A3: the owner approved vendor A; the agent submits vendor B, also allowed.
expect_revert "A3 digest mismatch" "$PAY_EXCEPTION" "$redirected" \
  "$(authorization_tuple "$payment_hash" "$nonce" "$expiry")" "$owner_signature"

if [[ "${SETTLED:-}" == "1" ]]; then
  # A4: the agent resubmits the exception that already settled.
  expect_revert "A4 payment ID already used" "$PAY_EXCEPTION" "$original" \
    "$(authorization_tuple "$payment_hash" "$nonce" "$expiry")" "$owner_signature"
else
  echo "A4 skipped: run again with SETTLED=1 after the owner-approved payment settles."
fi
