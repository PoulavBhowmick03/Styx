#!/usr/bin/env bash
# Sends attacks against a v2 vault as real transactions. Every one must revert. Run after an exception settled.
#
# Needs from the environment, never from this repo:
#   RPC_URL, VAULT, VENDOR_B (an allowlisted recipient other than the approved one),
#   AGENT_KEY_FILE, PENDING_FILE and OWNER_SIGNATURE_FILE (the settled exception's files)
set -euo pipefail
: "${RPC_URL:?}" "${VAULT:?}" "${VENDOR_B:?}" "${AGENT_KEY_FILE:?}" "${PENDING_FILE:?}" "${OWNER_SIGNATURE_FILE:?}"

GAS_ARGS=(--gas-limit 500000 --gas-price 40000000000 --priority-gas-price 1000000000)
PAY='pay((bytes32,address,address,address,uint256,bytes32,uint256,uint256,uint64))'
PAY_EXCEPTION='payWithException((bytes32,address,address,address,uint256,bytes32,uint256,uint256,uint64),(bytes32,address,uint256,uint256,uint64),bytes)'
agent_key="$(tr -d '[:space:]' <"$AGENT_KEY_FILE")"
field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); [d:=d[k] for k in sys.argv[2:]]; print(d)' "$@"; }
p() { field "$PENDING_FILE" payment "$1"; }
a() { field "$PENDING_FILE" authorization "$1"; }

payment() { # paymentId recipient amount recipientVersion
  printf '(%s,%s,%s,%s,%s,%s,%s,%s,%s)' "$1" "$(p agent)" "$(p token)" "$2" "$3" "$(p evidenceCommitment)" "$(p policyVersion)" "$4" "$(p validUntil)"
}
authorization() { printf '(%s,%s,%s,%s,%s)' "$(a paymentHash)" "$1" "$(a signerVersion)" "$(a approvalNonce)" "$(a authorizationExpiry)"; }

expect_revert() { # label signature args...
  local label="$1" result status tx attempt
  shift
  for attempt in 1 2 3 4; do
    result="$(cast send --json --rpc-url "$RPC_URL" --private-key "$agent_key" "${GAS_ARGS[@]}" "$VAULT" "$@" 2>&1)" || true
    status="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
    tx="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("transactionHash",""))' 2>/dev/null || true)"
    [ -n "$status" ] && break
    sleep $((attempt * 4))
  done
  case "$status" in
    0x0 | 0) printf 'PASS %s reverted on chain: %s\n' "$label" "$tx" ;;
    0x1 | 1) printf 'FAIL %s succeeded: %s\n' "$label" "$tx"; exit 1 ;;
    *) printf 'UNKNOWN %s produced no receipt; check the explorer.\n' "$label"; exit 2 ;;
  esac
}

id="$(p paymentId)"; amount="$(p amount)"; vendor_a="$(p recipient)"; version="$(p recipientVersion)"; signer="$(a signer)"
signature="$(field "$OWNER_SIGNATURE_FILE" signature)"; digest="$(field "$OWNER_SIGNATURE_FILE" approvalDigest)"
vendor_b_version="$(cast call "$VAULT" 'recipientVersion(address)(uint256)' "$VENDOR_B" --rpc-url "$RPC_URL" | awk '{print $1}')"
fresh="$(cast keccak "attack-v2-$(date +%s)")"
agent="$(cast wallet address --private-key "$agent_key")"

# A1: the agent pays the exception amount directly, skipping every tool.
expect_revert "A1 over the agent's per-payment limit" "$PAY" "$(payment "$fresh" "$vendor_a" "$amount" "$version")"
# A2: the agent signs the exception itself and names itself as signer.
own="$(cast wallet sign --no-hash --private-key "$agent_key" "$digest")"
expect_revert "A2 the agent is not an approver" "$PAY_EXCEPTION" "$(payment "$fresh" "$vendor_a" "$amount" "$version")" "$(authorization "$agent")" "$own"
# A3: the approver's signature, on a payment to another allowed vendor under a new ID.
expect_revert "A3 signature does not cover this payment" "$PAY_EXCEPTION" "$(payment "$fresh" "$VENDOR_B" "$amount" "$vendor_b_version")" "$(authorization "$signer")" "$signature"
# A4: the settled exception again, with the approver's real signature.
expect_revert "A4 payment ID already used" "$PAY_EXCEPTION" "$(payment "$id" "$vendor_a" "$amount" "$version")" "$(authorization "$signer")" "$signature"
