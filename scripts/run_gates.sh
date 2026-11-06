#!/usr/bin/env bash
# Runs the demo end to end against a deployed, funded vault: routine payment, attacks, owner exception,
# replay, then the reviewer. The same script runs locally (scripts/local_demo.sh) and on Arc.
#
# Needs EREBUS_VAULT_CHAIN_ID, EREBUS_VAULT_RPC_URLS, EREBUS_VAULT_ADDRESS, EREBUS_VAULT_TOKEN and
# EREBUS_VAULT_AGENT_KEY_FILE, plus VENDOR_A, VENDOR_B (both allowlisted) and ISSUER_KEY_FILE
# (owner-only, 32 raw bytes). Optional: REVIEWER_RPC_URL, OUT (default ./gate-run).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${EREBUS_VAULT_CHAIN_ID:?}" "${EREBUS_VAULT_RPC_URLS:?}" "${EREBUS_VAULT_ADDRESS:?}" "${EREBUS_VAULT_TOKEN:?}"
: "${EREBUS_VAULT_AGENT_KEY_FILE:?}" "${VENDOR_A:?}" "${VENDOR_B:?}" "${ISSUER_KEY_FILE:?}"
VAULT_BIN="${VAULT_BIN:-$ROOT/sdk/evm/target/debug/erebus-vault}"
DISCLOSURE_BIN="${DISCLOSURE_BIN:-$ROOT/sdk/evm/target/debug/erebus-disclosure}"
OUT="${OUT:-$PWD/gate-run}"
FIRST_RPC="${EREBUS_VAULT_RPC_URLS%%,*}"
REVIEWER_RPC_URL="${REVIEWER_RPC_URL:-$FIRST_RPC}"
WAIT_SECONDS="${WAIT_SECONDS:-900}"
mkdir -p "$OUT"; chmod 700 "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
export EREBUS_VAULT_STATE_ROOT="${EREBUS_VAULT_STATE_ROOT:-$OUT/journal}"
LOG="$OUT/results.txt"
[ -n "${RESUME_EXCEPTION:-}" ] || : > "$LOG"

say() { printf '%s\n' "$*" | tee -a "$LOG"; }
step() { say ""; say "== $*"; }
die() { say "STOP: $*"; exit 1; }
vault() { "$VAULT_BIN" <<<"$1" || true; }
disclosure() { env -i "$DISCLOSURE_BIN" <<<"$1" || true; }
get() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2],""))' "$1" "$2"; }
now() { date +%s; }
usdc() { cast call "$EREBUS_VAULT_TOKEN" 'balanceOf(address)(uint256)' "$1" --rpc-url "$FIRST_RPC" | awk '{print $1}'; }
balances() { say "balances (base units): vault $(usdc "$EREBUS_VAULT_ADDRESS"), vendor A $(usdc "$VENDOR_A"), vendor B $(usdc "$VENDOR_B")"; }

step "Preflight"
[ "$(cast chain-id --rpc-url "$FIRST_RPC")" = "$EREBUS_VAULT_CHAIN_ID" ] || die "the RPC serves another chain"
AGENT="$(cast wallet address --private-key "$(tr -d '[:space:]' <"$EREBUS_VAULT_AGENT_KEY_FILE")")"
say "vault $EREBUS_VAULT_ADDRESS, agent $AGENT, agent gas balance $(cast balance "$AGENT" --rpc-url "$FIRST_RPC") wei"
balances

printf 'routine invoice: 0.25 USDC\n' > "$OUT/routine-invoice.txt"
printf 'oversized invoice: 6 USDC\n' > "$OUT/oversized-invoice.txt"

# Resuming keeps the same payment IDs, so a run that stopped for the owner never mints a new payment.
# Set RESUME_ROUTINE, RESUME_EXCEPTION and PENDING_FILE, with the signature already at $OUT/signature.json.
if [ -n "${RESUME_EXCEPTION:-}" ]; then
  ROUTINE="${RESUME_ROUTINE:?}"; EXCEPTION="$RESUME_EXCEPTION"
  export PENDING_FILE="${PENDING_FILE:?}" OWNER_SIGNATURE_FILE="$OUT/signature.json"
  [ -s "$OWNER_SIGNATURE_FILE" ] || die "no signature at $OWNER_SIGNATURE_FILE"
  say "resuming payment $EXCEPTION"
else
step "G1: routine 0.25 USDC payment"
R="$(vault "{\"method\":\"propose\",\"recipient\":\"$VENDOR_A\",\"amount\":\"250000\",\"invoice_file\":\"$OUT/routine-invoice.txt\",\"invoice_reference\":\"INV-ROUTINE\",\"valid_until\":$(( $(now) + 3600 ))}")"
ROUTINE="$(get "$R" payment_id)"; [ -n "$ROUTINE" ] || die "propose failed: $R"
R="$(vault "{\"method\":\"submit\",\"payment_id\":\"$ROUTINE\"}")"
say "state $(get "$R" state), tx $(get "$R" tx_hash)"
[ "$(get "$R" state)" = settled ] || die "the routine payment did not settle: $R. Retry submit with the same ID: $ROUTINE"
balances

step "G2: 6 USDC exception request"
R="$(vault "{\"method\":\"propose\",\"recipient\":\"$VENDOR_A\",\"amount\":\"6000000\",\"invoice_file\":\"$OUT/oversized-invoice.txt\",\"invoice_reference\":\"INV-OVERSIZED\",\"valid_until\":$(( $(now) + 3600 ))}")"
EXCEPTION="$(get "$R" payment_id)"; [ -n "$EXCEPTION" ] || die "propose failed: $R"
say "path $(get "$R" path), payment $EXCEPTION"
R="$(vault "{\"method\":\"submit\",\"payment_id\":\"$EXCEPTION\"}")"
say "submit without the owner: $(get "$R" code)"
export PENDING_FILE="$OUT/pending-$(date +%H%M%S).json"
R="$(vault "{\"method\":\"request_approval\",\"payment_id\":\"$EXCEPTION\",\"authorization_expiry\":$(( $(now) + WAIT_SECONDS + 600 )),\"pending_file\":\"$PENDING_FILE\"}")"
[ "$(get "$R" status)" = ok ] || die "request_approval failed: $R"
export OWNER_SIGNATURE_FILE="$OUT/signature.json"
rm -f "$OWNER_SIGNATURE_FILE"
say "OWNER: open owner-page, load your owner config and $PENDING_FILE, sign, and save the file as:"
say "  $OWNER_SIGNATURE_FILE"
for _ in $(seq 1 "$WAIT_SECONDS"); do [ -s "$OWNER_SIGNATURE_FILE" ] && break; sleep 1; done
[ -s "$OWNER_SIGNATURE_FILE" ] || die "no owner signature arrived"
say "owner signature received"
fi

export RPC_URL="$FIRST_RPC" VAULT="$EREBUS_VAULT_ADDRESS" AGENT_KEY_FILE="$EREBUS_VAULT_AGENT_KEY_FILE" VENDOR_B
ALREADY="$(get "$(vault "{\"method\":\"status\",\"payment_id\":\"$EXCEPTION\"}")" state)"
if [ "$ALREADY" = settled ]; then
  say "the exception already settled, so the earlier attacks are not repeated"
else
  step "Attacks A1, A2, A3, as real transactions. Each costs the agent gas."
  SETTLED=0 bash "$ROOT/contracts/evm/script/attacks.sh" | tee -a "$LOG"

  step "G2: owner-approved exception"
  R="$(vault "{\"method\":\"submit\",\"payment_id\":\"$EXCEPTION\",\"signature_file\":\"$OWNER_SIGNATURE_FILE\"}")"
  say "state $(get "$R" state), tx $(get "$R" tx_hash)"
  [ "$(get "$R" state)" = settled ] || die "the exception did not settle: $R. Retry with the same ID: $EXCEPTION"
  balances
fi

step "Attack A4: resubmit the settled exception"
SETTLED=1 bash "$ROOT/contracts/evm/script/attacks.sh" | tee -a "$LOG"
balances

step "G3: reviewer"
mkdir -p "$OUT/reviewer" "$OUT/other-reviewer"; chmod 700 "$OUT/reviewer" "$OUT/other-reviewer"
rm -f "$OUT/reviewer/key" "$OUT/other-reviewer/key" "$OUT"/*.grant "$OUT"/*.record "$OUT/reviewer/opened.json"
R1="$(disclosure "{\"method\":\"keygen\",\"key_file\":\"$OUT/reviewer/key\"}")"
R2="$(disclosure "{\"method\":\"keygen\",\"key_file\":\"$OUT/other-reviewer/key\"}")"
PUBLIC="$(get "$R1" recipient_public_key)"; OTHER="$(get "$R2" recipient_public_key)"
[ -n "$PUBLIC" ] && [ -n "$OTHER" ] || die "could not create the reviewer keys: $R1 $R2"
vault "{\"method\":\"export_record\",\"payment_id\":\"$EXCEPTION\",\"record_file\":\"$OUT/exception.record\"}" >/dev/null
vault "{\"method\":\"export_record\",\"payment_id\":\"$ROUTINE\",\"record_file\":\"$OUT/routine.record\"}" >/dev/null
EXPIRES=$(( $(now) + 86400 ))
ISSUED="$(disclosure "{\"method\":\"export_vault_payment\",\"record_file\":\"$OUT/exception.record\",\"issuer_key_file\":\"$ISSUER_KEY_FILE\",\"recipient_public_key\":\"$PUBLIC\",\"grant_file\":\"$OUT/exception.grant\",\"expires_at\":$EXPIRES}")"
ISSUER="$(get "$ISSUED" issuer)"; [ -n "$ISSUER" ] || die "export failed: $ISSUED"
disclosure "{\"method\":\"export_vault_payment\",\"record_file\":\"$OUT/routine.record\",\"issuer_key_file\":\"$ISSUER_KEY_FILE\",\"recipient_public_key\":\"$OTHER\",\"grant_file\":\"$OUT/routine.grant\",\"expires_at\":$EXPIRES}" >/dev/null
CODE_HASH="$(cast keccak "$(cast code "$EREBUS_VAULT_ADDRESS" --rpc-url "$REVIEWER_RPC_URL")")"
VAULT_LOWER="$(printf '%s' "$EREBUS_VAULT_ADDRESS" | tr 'A-F' 'a-f')"
pins() { printf '{"chain_id":%s,"rpc_urls":["%s"],"vault":"%s","vault_code_hash":"%s"}' "$EREBUS_VAULT_CHAIN_ID" "$1" "$VAULT_LOWER" "$CODE_HASH"; }
verify() { disclosure "{\"method\":\"verify_vault_payment\",\"grant_file\":\"$1\",\"key_file\":\"$OUT/reviewer/key\",\"expected_issuer\":\"$ISSUER\",\"deployment\":$(pins "$2"),\"opened_file\":${3:-null}}"; }
report() { python3 -c '
import json,sys
d=json.loads(sys.argv[1])
print("  refused: "+str(d.get("error")) if d.get("status")!="ok" else "  integrity=%s authorization=%s settlement=%s policy=%s"%(d["record_integrity"],d["authorization"],d["settlement"],d["policy_at_execution"]))' "$1" | tee -a "$LOG"; }
say "their record:"; report "$(verify "$OUT/exception.grant" "$REVIEWER_RPC_URL" "\"$OUT/reviewer/opened.json\"")"
python3 - "$OUT/exception.grant" "$OUT/tampered.grant" <<'PY'
import os, sys
data = bytearray(open(sys.argv[1], "rb").read())
data[len(data) // 2] ^= 1
open(sys.argv[2], "wb").write(data)
os.chmod(sys.argv[2], 0o600)
PY
say "a tampered copy:"; report "$(verify "$OUT/tampered.grant" "$REVIEWER_RPC_URL")"
say "a second record, sealed to someone else:"; report "$(verify "$OUT/routine.grant" "$REVIEWER_RPC_URL")"
say "with their RPC unreachable:"; report "$(verify "$OUT/exception.grant" "http://127.0.0.1:1")"
say ""
say "For a real second-machine G3, copy exception.grant and give the reviewer: issuer $ISSUER, code hash $CODE_HASH"
say "Results saved to $LOG"
