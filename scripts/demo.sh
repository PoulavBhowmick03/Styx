#!/usr/bin/env bash
# The live demo, one key press at a time, through the real MCP tools on Arc testnet.
#
#   scripts/demo.sh            every step, pausing before each
#   scripts/demo.sh check      one step: setup, check, pay, approve, attack, review, arkiv, links
#
# Settings come from the .env file at the repo root (git ignores it, so it never gets committed).
# Set DEMO_ENV to read a different file. Without either, ~/.styx-mumbai/demo.env is tried.
# .env.example lists every name. Most have a default read from the chain, so a short file is enough.
#
#   scripts/demo.sh auto       the whole demo with no pauses (it still waits for the phone signature)
#
# Nothing here prints a key or token.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${DEMO_ENV:-}" ]; then ENV_FILE="$DEMO_ENV"
elif [ -r "$ROOT/.env" ]; then ENV_FILE="$ROOT/.env"
else ENV_FILE="$HOME/.styx-mumbai/demo.env"; fi
[ -r "$ENV_FILE" ] || { echo "No settings file. Copy .env.example to .env at the repo root and fill it in."; exit 2; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Defaults that can be read from the chain or are public.
DEMO_RPC="${DEMO_RPC:-$(printf '%s' "${STYX_VAULT_RPC_URLS:-https://rpc.testnet.arc.io}" | cut -d, -f1)}"
STYX_VAULT_CHAIN_ID="${STYX_VAULT_CHAIN_ID:-5042002}"
STYX_VAULT_RPC_URLS="${STYX_VAULT_RPC_URLS:-$DEMO_RPC}"
STYX_VAULT_DIR="${STYX_VAULT_DIR:-${STYX_VAULT_STATE_ROOT:-}}"
STYX_VAULT_RELAY_URL="${STYX_VAULT_RELAY_URL:-https://styx-vault-relay.fly.dev}"
DEMO_ARKIV_TAG="${DEMO_ARKIV_TAG:-32d6d9b6f1b63d3e8856ed1bc23eee2b}"
DEMO_ARKIV_WRITER="${DEMO_ARKIV_WRITER:-0xbF21009ffB20f219513EAAE6E19DeC69d73cf258}"

missing=""
for name in STYX_VAULT_ADDRESS STYX_VAULT_AGENT_KEY_FILE STYX_VAULT_DIR STYX_VAULT_RELAY_TOKEN DEMO_VENDOR_A DEMO_VENDOR_B; do
  [ -n "${!name:-}" ] || missing="$missing $name"
done
[ -z "$missing" ] || { echo "Missing in $ENV_FILE:$missing"; exit 2; }
[ -r "$STYX_VAULT_AGENT_KEY_FILE" ] || { echo "Agent key file not readable: $STYX_VAULT_AGENT_KEY_FILE"; exit 2; }
mkdir -p "$STYX_VAULT_DIR" && chmod 700 "$STYX_VAULT_DIR"

# Read from the vault itself when not set: the token, the approver (the owner), and the code hash.
chain() { cast call "$STYX_VAULT_ADDRESS" "$@" --rpc-url "$DEMO_RPC" 2>/dev/null | awk '{print $1}'; }
STYX_VAULT_TOKEN="${STYX_VAULT_TOKEN:-$(chain 'token()(address)')}"
DEMO_APPROVER="${DEMO_APPROVER:-$(chain 'owner()(address)')}"
STYX_VAULT_CODE_HASH="${STYX_VAULT_CODE_HASH:-$(cast keccak "$(cast code "$STYX_VAULT_ADDRESS" --rpc-url "$DEMO_RPC" 2>/dev/null)" 2>/dev/null)}"
for name in STYX_VAULT_TOKEN DEMO_APPROVER STYX_VAULT_CODE_HASH; do
  [ -n "${!name:-}" ] || { echo "Could not read $name from the chain at $DEMO_RPC. Check the vault address and the network."; exit 2; }
done

# Demo-only key files for the issuer and the two reviewers, made on first use inside the state directory.
KEYS="$STYX_VAULT_DIR/demo-keys"
ISSUER_KEY_FILE="${ISSUER_KEY_FILE:-$KEYS/issuer.key}"
REVIEWER_KEY_FILE="${REVIEWER_KEY_FILE:-$KEYS/reviewer.key}"
OTHER_REVIEWER_KEY_FILE="${OTHER_REVIEWER_KEY_FILE:-$KEYS/other-reviewer.key}"
DEMO_ISSUER="${DEMO_ISSUER:-}"
export STYX_BACKEND=vault STYX_VAULT_VERSION=2 STYX_VAULT_DIR STYX_VAULT_TOKEN STYX_VAULT_CODE_HASH STYX_VAULT_CHAIN_ID STYX_VAULT_RPC_URLS STYX_VAULT_RELAY_URL
export STYX_VAULT_CLI="$ROOT/sdk/evm/target/debug/styx-vault"
DISCLOSURE="$ROOT/sdk/evm/target/debug/styx-disclosure"
EXPLORER="https://explorer.testnet.arc.io"
STUDIO="https://studio.arc.io/app/038ffe00-c21d-4804-99f6-90c3d44f5e16"
LAST="$STYX_VAULT_DIR/demo-last-exception.txt"
ROUTINE_AMOUNT="${DEMO_ROUTINE_AMOUNT:-100000}"
EXCEPTION_AMOUNT="${DEMO_EXCEPTION_AMOUNT:-2000000}"

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'; else B=; D=; G=; R=; Y=; N=; fi
title() { printf '\n%s━━ %s%s\n\n' "$B" "$1" "$N"; }
good() { printf '%s✓ %s%s\n' "$G" "$1" "$N"; }
bad() { printf '%s✕ %s%s\n' "$R" "$1" "$N"; }
info() { printf '  %s\n' "$1"; }
usdc() { python3 -c 'import sys; v=int(sys.argv[1]); print(f"{v//10**6}.{v%10**6:06d}".rstrip("0").rstrip(".")+" USDC")' "$1"; }
pause() { [ "${DEMO_AUTO:-}" = 1 ] || { printf '\n%s[Enter] %s%s' "$D" "$1" "$N"; read -r _; }; }
view() { cast call "$STYX_VAULT_ADDRESS" "$@" --rpc-url "$DEMO_RPC" 2>/dev/null | awk '{print $1}'; }
balance() { cast call "$STYX_VAULT_TOKEN" 'balanceOf(address)(uint256)' "$1" --rpc-url "$DEMO_RPC" 2>/dev/null | awk '{print $1}'; }
tool() { (cd "$ROOT" && uv run --quiet python "$ROOT/scripts/demo_agent.py" "$1" "$2"); }
get() { python3 -c 'import json,sys; d=json.loads(sys.argv[1]); [d:=d.get(k,{}) if isinstance(d,dict) else {} for k in sys.argv[2:]]; print(d if d!={} else "")' "$@"; }
vault_cli() { "$STYX_VAULT_CLI"; }
disclose() { "$DISCLOSURE"; }

step_setup() {
  title "Set the rules: the owner's wallet, on the website"
  local url="https://styxco.xyz/setup/?path=team&vault=$STYX_VAULT_ADDRESS"
  info "$url"
  info "Connect the vault owner's wallet, then review limits, vendors and approvers."
  if [ "${DEMO_AUTO:-}" != 1 ]; then
    if command -v open >/dev/null 2>&1; then open "$url"; else info "Open the link above in your browser."; fi
  fi
  pause "when the vault is set up"
}

step_check() {
  title "Check: the vault, as the chain reports it"
  local agent day policy
  agent="$(cast wallet address --private-key "$(tr -d '[:space:]' <"$STYX_VAULT_AGENT_KEY_FILE")")"
  day=$(( $(date +%s) / 86400 ))
  policy="$(cast call "$STYX_VAULT_ADDRESS" 'agentPolicy(address)(uint256,uint256,uint256,uint64,bool)' "$agent" --rpc-url "$DEMO_RPC" 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
  read -r _ per daily _ enabled <<<"$policy"
  [ "${enabled:-}" = true ] || { bad "Could not read an enabled agent. Check the network, then try again."; return 1; }
  info "Vault         $STYX_VAULT_ADDRESS"
  info "Balance       $(usdc "$(balance "$STYX_VAULT_ADDRESS")")"
  info "Agent         $agent"
  info "Agent limits  $(usdc "$per") a payment, $(usdc "$daily") a day"
  local spent; spent="$(view 'spentByAgentDay(address,uint256)(uint256)' "$agent" "$day")"
  info "Spent today   $(usdc "${spent:-0}")"
  info "Approver      $DEMO_APPROVER"
  local room=$(( daily - ${spent:-0} ))
  if [ "$room" -lt $(( ROUTINE_AMOUNT + EXCEPTION_AMOUNT )) ]; then bad "Only $(usdc "$room") left today, which is not enough for one more run"; return 1; fi
  good "Room for $(( room / (ROUTINE_AMOUNT + EXCEPTION_AMOUNT) )) more runs today"
  curl -s -m 15 -o /dev/null -w '%{http_code}' https://styx-vault-relay.fly.dev/requests/check | grep -q 404 && good "Relay is up" || bad "Relay did not answer"
  # Not fatal: an unlinked approver on the configured vault falls back to the relay's own chat.
  if curl -s -m 15 "https://styx-vault-relay.fly.dev/links/$DEMO_APPROVER" | grep -q '"linked":true'; then
    good "Approver is linked to Telegram"
  else
    bad "Approver is not linked to Telegram, so their phone will not get an alert. Link: https://t.me/styx_agent_bot"
  fi
}

invoice() { # reference text
  printf '%s\n' "$2" >"$STYX_VAULT_DIR/$1.txt"
  chmod 600 "$STYX_VAULT_DIR/$1.txt"
}

step_pay() {
  title "A routine payment: within the agent's limit"
  local ref answer id sent tx
  ref="INV-$(date +%H%M%S)-R"; invoice "$ref" "Invoice $ref: routine supplies"
  info "Agent proposes $(usdc "$ROUTINE_AMOUNT") to vendor A"
  answer="$(tool styx_propose_payment "{\"recipient\":\"$DEMO_VENDOR_A\",\"amount\":\"$ROUTINE_AMOUNT\",\"invoice_name\":\"$ref.txt\",\"invoice_reference\":\"$ref\"}")"
  id="$(get "$answer" result payment_id)"
  [ -n "$id" ] || { bad "The tool refused: $(get "$answer" error message)"; return 1; }
  info "Vault's answer: $(get "$answer" result path)"
  sent="$(tool styx_submit_payment "{\"payment_id\":\"$id\"}")"
  tx="$(get "$sent" result tx_hash)"
  [ "$(get "$sent" result state)" = settled ] || { bad "Not settled yet. Retry with the same ID: $id"; return 1; }
  good "Settled, with no approval needed"
  info "$EXPLORER/tx/$tx"
}

step_approve() {
  title "An exception: over the agent's limit"
  local ref answer id asked check name sent tx before after
  ref="INV-$(date +%H%M%S)-X"; invoice "$ref" "Invoice $ref: urgent order"
  before="$(balance "$DEMO_VENDOR_A")"
  info "Agent proposes $(usdc "$EXCEPTION_AMOUNT") to vendor A"
  answer="$(tool styx_propose_payment "{\"recipient\":\"$DEMO_VENDOR_A\",\"amount\":\"$EXCEPTION_AMOUNT\",\"invoice_name\":\"$ref.txt\",\"invoice_reference\":\"$ref\"}")"
  id="$(get "$answer" result payment_id)"
  [ -n "$id" ] || { bad "The tool refused: $(get "$answer" error message)"; return 1; }
  printf '  %sVault says: %s%s\n' "$Y" "$(get "$answer" result path)" "$N"
  asked="$(tool styx_request_owner_approval "{\"payment_id\":\"$id\",\"signer\":\"$DEMO_APPROVER\"}")"
  [ -n "$(get "$asked" result pending_file)" ] || { bad "The tool refused: $(get "$asked" error message)"; return 1; }
  if [ "$(get "$asked" result owner_alerted)" = True ]; then
    good "Approver alerted on Telegram. Approve on the phone."
  else
    # The request is still waiting on the relay, so Telegram failing does not have to stop the demo.
    local relay_url="${STYX_VAULT_RELAY_URL:-https://styx-vault-relay.fly.dev}" request
    request="$(cat "$STYX_VAULT_DIR/relay-${id:2:12}.txt" 2>/dev/null)"
    [ -n "$request" ] || { bad "The relay did not take the request. Run this step again."; return 1; }
    bad "The Telegram alert did not go out. Open this link in the approver's wallet instead:"
    info "https://styxco.xyz/?relay=$relay_url&request=$request"
  fi
  printf '  %sWaiting for the signature%s' "$D" "$N"
  for _ in $(seq 1 120); do
    check="$(tool styx_check_owner_approval "{\"payment_id\":\"$id\"}")"
    name="$(get "$check" result signature_name)"
    [ -n "$name" ] && break
    printf '.'
    sleep 3
  done
  printf '\n'
  [ -n "${name:-}" ] || { bad "No signature yet. Nothing was paid. Payment ID: $id"; return 1; }
  good "Signature received through the relay"
  sent="$(tool styx_submit_payment "{\"payment_id\":\"$id\",\"signature_name\":\"$name\"}")"
  tx="$(get "$sent" result tx_hash)"
  [ "$(get "$sent" result state)" = settled ] || { bad "Not settled yet. Retry with the same ID: $id"; return 1; }
  after="$(balance "$DEMO_VENDOR_A")"
  good "Settled. Vendor A received $(usdc $(( after - before )))"
  info "$EXPLORER/tx/$tx"
  printf '%s\n' "$id" >"$LAST"
}

last_exception() { [ -s "$LAST" ] && cat "$LAST"; }

step_attack() {
  title "A compromised agent skips the tools and calls the contract"
  local id stem pending
  id="$(last_exception)" || { bad "Run the approve step first."; return 1; }
  stem="${id:2:12}"
  pending="$(ls -t "$STYX_VAULT_DIR"/pending-"$stem"*.json 2>/dev/null | head -1)"
  RPC_URL="$DEMO_RPC" VAULT="$STYX_VAULT_ADDRESS" VENDOR_B="$DEMO_VENDOR_B" AGENT_KEY_FILE="$STYX_VAULT_AGENT_KEY_FILE" \
    PENDING_FILE="$pending" OWNER_SIGNATURE_FILE="$STYX_VAULT_DIR/signature-$stem.json" ATTACKS="${DEMO_ATTACKS:-A5 A1 A4}" \
    bash "$ROOT/contracts/evm/script/attacks_v2.sh" | while read -r verdict label; do
      case "$verdict" in
        PASS) good "${label%%:*}"; info "$EXPLORER/tx/${label##*: }" ;;
        *) bad "$verdict $label" ;;
      esac
    done
  info "Vault balance $(usdc "$(balance "$STYX_VAULT_ADDRESS")")"
  pgrep -f "watcher.py.*$STYX_VAULT_ADDRESS" >/dev/null 2>&1 && info "The watcher is sending a notice to Telegram for each revert"
}

report() { python3 -c '
import json,sys
d=json.loads(sys.argv[1])
if d.get("status")!="ok": print("  refused: "+str(d.get("error"))); raise SystemExit
for k,l in (("record_integrity","Record integrity"),("authorization","Authorization"),("settlement","Settlement"),("policy_at_execution","Policy at execution")): print(f"  {l:<20} {d.get(k)}")
' "$1"; }

step_review() {
  title "A reviewer checks one record against the chain"
  local id dir record grant public expires pins answer sealed
  id="$(last_exception)" || { bad "Run the approve step first."; return 1; }
  dir="$STYX_VAULT_DIR/demo-review-${id:2:12}-$(date +%s)"; mkdir -p "$dir"; chmod 700 "$dir"
  record="$dir/record"; grant="$dir/grant"
  printf '{"method":"export_record","payment_id":"%s","record_file":"%s"}' "$id" "$record" | vault_cli >/dev/null
  public="$(printf '{"method":"key_info","key_file":"%s"}' "$REVIEWER_KEY_FILE" | disclose | python3 -c 'import json,sys; print(json.load(sys.stdin)["recipient_public_key"])')"
  expires=$(( $(date +%s) + 86400 ))
  sealed="$(printf '{"method":"export_vault_payment","record_file":"%s","issuer_key_file":"%s","recipient_public_key":"%s","grant_file":"%s","expires_at":%s}' \
    "$record" "$ISSUER_KEY_FILE" "$public" "$grant" "$expires" | disclose)"
  DEMO_ISSUER="${DEMO_ISSUER:-$(get "$sealed" issuer)}"
  good "Record sealed to one reviewer's key"
  local lower; lower="$(printf '%s' "$STYX_VAULT_ADDRESS" | tr 'A-F' 'a-f')"
  pins="{\"chain_id\":5042002,\"rpc_urls\":[\"$DEMO_RPC\"],\"vault\":\"$lower\",\"vault_code_hash\":\"$STYX_VAULT_CODE_HASH\"}"
  info "The reviewer's key, checked against the reviewer's own RPC:"
  for _ in 1 2 3 4; do
    answer="$(printf '{"method":"verify_vault_payment","grant_file":"%s","key_file":"%s","expected_issuer":"%s","deployment":%s,"opened_file":null}' "$grant" "$REVIEWER_KEY_FILE" "$DEMO_ISSUER" "$pins" | disclose)"
    printf '%s' "$answer" | grep -q '"unavailable"' || break
    sleep 4
  done
  report "$answer"
  info ""
  info "Someone else's key:"
  answer="$(printf '{"method":"verify_vault_payment","grant_file":"%s","key_file":"%s","expected_issuer":"%s","deployment":%s,"opened_file":null}' "$grant" "$OTHER_REVIEWER_KEY_FILE" "$DEMO_ISSUER" "$pins" | disclose)"
  report "$answer"
  rm -f "$record"
  printf '%s\n' "$grant" >"$STYX_VAULT_DIR/demo-last-grant.txt"
}

step_arkiv() {
  title "The same kind of record, from Arkiv, with nothing of ours running"
  local out; out="$(mktemp -d)/fetched.grant"
  # A new vault publishes the record just made, then reads it back and verifies what came back.
  local grant_file; grant_file="$(cat "$STYX_VAULT_DIR/demo-last-grant.txt" 2>/dev/null)"
  if [ -n "${DEMO_ARKIV_PUBLISHER_KEY_FILE:-}" ] && [ -s "$grant_file" ]; then
    local published tag lower pins answer
    published="$(cd "$ROOT/arkiv" && ARKIV_PUBLISHER_KEY_FILE="$DEMO_ARKIV_PUBLISHER_KEY_FILE" npm run --silent publish-grant -- "$grant_file" 2>/dev/null)"
    tag="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["lookupTag"])' "$published" 2>/dev/null)"
    [ -n "$tag" ] || { bad "Arkiv did not take the record. That says nothing about the payment."; return 1; }
    good "Published this payment's encrypted record to Arkiv, tag $tag"
    (cd "$ROOT/arkiv" && npm run --silent fetch-grant -- "$tag" "$DEMO_ARKIV_WRITER" "$out" >/dev/null 2>&1) || { bad "Arkiv did not answer. That says nothing about the payment."; return 1; }
    chmod 600 "$out"
    good "Fetched $(wc -c <"$out" | tr -d ' ') encrypted bytes back from Arkiv"
    lower="$(printf '%s' "$STYX_VAULT_ADDRESS" | tr 'A-F' 'a-f')"
    pins="{\"chain_id\":5042002,\"rpc_urls\":[\"$DEMO_RPC\"],\"vault\":\"$lower\",\"vault_code_hash\":\"$STYX_VAULT_CODE_HASH\"}"
    info "The copy from Arkiv, opened with the reviewer's key and checked against Arc:"
    for _ in 1 2 3 4; do
      answer="$(printf '{"method":"verify_vault_payment","grant_file":"%s","key_file":"%s","expected_issuer":"%s","deployment":%s,"opened_file":null}' "$out" "$REVIEWER_KEY_FILE" "$DEMO_ISSUER" "$pins" | disclose)"
      printf '%s' "$answer" | grep -q '"unavailable"' || break
      sleep 4
    done
    report "$answer"
    return 0
  fi
  if (cd "$ROOT/arkiv" && npm run --silent fetch-grant -- "$DEMO_ARKIV_TAG" "$DEMO_ARKIV_WRITER" "$out" 2>/dev/null); then
    good "Fetched $(wc -c <"$out" | tr -d ' ') encrypted bytes from Arkiv"
  else
    bad "Arkiv did not answer. That says nothing about the payment."
  fi
}

step_links() {
  title "Where to look"
  info "Vault      $EXPLORER/address/$STYX_VAULT_ADDRESS"
  info "Studio     $STUDIO"
  info "Setup      https://styxco.xyz/setup/?vault=$STYX_VAULT_ADDRESS"
}

build() {
  [ -x "$STYX_VAULT_CLI" ] && [ -x "$DISCLOSURE" ] && return 0
  echo "Building the tools once"
  (cd "$ROOT/sdk/evm" && cargo build --bins >/dev/null 2>&1) || { echo "Could not build the tools"; exit 2; }
}

make_keys() {
  mkdir -p "$KEYS" && chmod 700 "$KEYS"
  [ -s "$ISSUER_KEY_FILE" ] || { python3 -c 'import os,sys; sys.stdout.buffer.write(os.urandom(32))' >"$ISSUER_KEY_FILE"; chmod 600 "$ISSUER_KEY_FILE"; }
  local f
  for f in "$REVIEWER_KEY_FILE" "$OTHER_REVIEWER_KEY_FILE"; do
    [ -s "$f" ] || printf '{"method":"keygen","key_file":"%s"}' "$f" | disclose >/dev/null
  done
}

build
make_keys
[ "${1:-}" = auto ] && { DEMO_AUTO=1; set -- all; }
case "${1:-all}" in
  setup | check | pay | approve | attack | review | arkiv | links) "step_$1" ;;
  all)
    step_setup
    step_check || exit 1
    pause "routine payment"; step_pay
    pause "exception"; step_approve
    pause "attack"; step_attack
    pause "reviewer"; step_review
    pause "Arkiv"; step_arkiv
    pause "links"; step_links
    ;;
  *) echo "usage: scripts/demo.sh [setup|check|pay|approve|attack|review|arkiv|links]"; exit 2 ;;
esac
