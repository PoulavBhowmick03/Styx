#!/usr/bin/env bash
# The whole Styx-on-NEAR demo in one run, against the live testnet deployment:
#
#   0. preflight: tools, settings, relay and page up, your wallet key registered, balances
#   1. the agent's rules and its function-call key, read from the chain
#   2. NEAR: a payment inside the limits settles
#   3. NEAR: over the limit, refused, then approved by YOU: Telegram alert, approval page, your wallet
#   4. NEAR: attacks A5, A1, A4 with the agent's own key, all refused
#   5. Arc and Base: the same agent key pays on two chains through Chain Signatures; an over-limit
#      Base payment approved by you again; over-limit attempts refused on both chains
#   6. NEAR AI Cloud (if NEARAI_API_KEY is in .env): the agent's model in an attested TEE pays an
#      invoice; its sealed record passes the reviewer
#   7. every transaction, with links
#
#   scripts/near/demo_full.sh          pause before each step (for recording)
#   scripts/near/demo_full.sh auto     no pauses; still waits for your signatures
#
# Reads (all outside the repo): ~/.styx-near/demo.env (vault v1), ~/.styx-near/v2.env (vault-v2),
# ~/.styx-near/relay-token-fly, ~/.styx-near/reviewer.json, and NEARAI_API_KEY from the repo's
# git-ignored .env. Your wallet key: APPROVER_PK (default: poulav.testnet's full-access key).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AUTO="${1:-}"
BIN="$ROOT/sdk/near/target/release/styx-near-vault"
NETWORK="${NETWORK:-testnet-fastnear}"
RELAY="${RELAY:-https://styx-relay-near.fly.dev}"
PAGE="${PAGE:-https://styxco.xyz/approval}"
TOKEN_FILE="${RELAY_TOKEN_FILE:-$HOME/.styx-near/relay-token-fly}"
APPROVER_PK="${APPROVER_PK:-ed25519:mA3qigk1SJQ85o3RGcd32hEHoGM6bjDCvjekyQtNZ2N}"
OWNER="${OWNER:-styx-owner-c87a.testnet}"
V1="vault.$OWNER"; V2="vault-v2.$OWNER"; TOKEN="usdc.$OWNER"
EVM_VENDOR=0xf4D88218d13333247BF7616AFFb45F24a21E07cc
ARC=5042002; BASE=84532
ARC_RPC=https://rpc.testnet.arc.network; BASE_RPC=https://sepolia.base.org
ARC_USDC=0x3600000000000000000000000000000000000000; BASE_USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
WAIT_SECONDS="${WAIT_SECONDS:-900}"
RUN="demo-$(date +%s)"
LOG="$HOME/.styx-near/$RUN.log"
UV=(uv run -q --with pynacl --with base58)

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
step() { bold "== $1"; [ "$AUTO" = auto ] || read -r -p "   (enter) " _; }
ok() { printf '   \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '   \033[31m✗ %s\033[0m\n' "$1"; exit 1; }
note() { printf '   %s\n' "$1"; }
record() { printf '%s\n' "$1" >> "$LOG"; }
field() { python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
cli() { echo "$2" | env $(grep -v '^#' "$1" | xargs) "$BIN"; }
view() { near contract call-function as-read-only "$1" "$2" json-args "$3" network-config "$NETWORK" now 2>&1 | awk '/^[{"0-9tn]/{f=1} f&&/^$/{exit} f' | tr -d '\n '; }
erc20() { cast call "$2" 'balanceOf(address)(uint256)' "$3" --rpc-url "$1" 2>/dev/null | awk '{print $1}'; }
in_usdc() { python3 -c "import sys; print(f'{int(sys.argv[1])/1e6:g}')" "${1:-0}"; }

# Proposes an over-limit payment, asks the approver through the relay (Telegram alert), waits for
# the signature from the page, then submits. Usage: approve_and_pay <envfile> <recipient> <amount> <usdc> <tag>
approve_and_pay() {
  local envfile="$1" recipient="$2" amount="$3" usdc="$4" tag="$5" S id until reply request alerted
  S="$(grep '^STYX_NEAR_STATE_ROOT=' "$envfile" | cut -d= -f2)"; until=$(( $(date +%s) + 3600 ))
  printf 'Invoice %s: %s USDC\n' "$tag" "$usdc" > "$S/$tag.txt"
  id=$(cli "$envfile" "{\"method\":\"propose\",\"recipient\":\"$recipient\",\"amount\":\"$amount\",\"invoice_file\":\"$S/$tag.txt\",\"invoice_reference\":\"$tag\",\"valid_until\":$until}" | field payment_id)
  reply=$(cli "$envfile" "{\"method\":\"submit\",\"payment_id\":\"$id\"}" || true)
  echo "$reply" | grep -q OWNER_APPROVAL_REQUIRED && ok "the agent alone is refused: OWNER_APPROVAL_REQUIRED" || bad "expected a refusal, got: $reply"
  cli "$envfile" "{\"method\":\"request_approval\",\"payment_id\":\"$id\",\"authorization_expiry\":$until,\"pending_file\":\"$S/$tag-pending.json\",\"signer\":\"$APPROVER_PK\"}" >/dev/null
  posted=$(python3 - "$S/$tag-pending.json" "$RELAY" "$(cat "$TOKEN_FILE")" <<'PY'
import json, sys, urllib.request
req = urllib.request.Request(sys.argv[2] + "/requests", data=json.dumps({"pending": json.load(open(sys.argv[1]))}).encode(),
                             headers={"content-type": "application/json", "authorization": "Bearer " + sys.argv[3]})
r = json.load(urllib.request.urlopen(req, timeout=20)); print(r["requestId"], "yes" if r.get("alerted") else "no")
PY
)
  request="${posted% *}"; alerted="${posted#* }"
  [ "$alerted" = yes ] && ok "Telegram alert sent to the approver" || note "no Telegram alert (send /start to the bot); use the link below"
  bold "   Approve it in your wallet: $PAGE/?relay=$RELAY&request=$request"
  note "waiting for your signature (up to $(( WAIT_SECONDS / 60 )) minutes)…"
  python3 - "$RELAY" "$(cat "$TOKEN_FILE")" "$request" "$S/$tag-signature.json" "$WAIT_SECONDS" <<'PY' || bad "no signature arrived"
import json, os, sys, time, urllib.request, urllib.error
relay, token, rid, out, wait = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
deadline = time.time() + wait
while time.time() < deadline:
    try:
        r = json.load(urllib.request.urlopen(urllib.request.Request(f"{relay}/requests/{rid}/signature",
                                             headers={"authorization": "Bearer " + token}), timeout=20))
    except urllib.error.HTTPError as e:
        sys.exit(f"relay refused: {e.code}")
    except OSError:
        time.sleep(3); continue
    if r.get("status") == "signed":
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f: json.dump(r["signature"], f)
        print(f"   \033[32m✓\033[0m signed by {r['signature'].get('accountId')} with {r['signature'].get('publicKey')}")
        sys.exit(0)
    time.sleep(3)
sys.exit("timed out")
PY
  reply=$(cli "$envfile" "{\"method\":\"submit\",\"payment_id\":\"$id\",\"signature_file\":\"$S/$tag-signature.json\"}")
  echo "$reply" | grep -q '"settled"' || bad "the approved payment did not settle: $reply"
  ok "settled with your signature: $(echo "$reply" | field tx_hash)"
  record "$tag exception $usdc USDC to $recipient: $(echo "$reply" | field tx_hash)"
  LAST_PENDING="$S/$tag-pending.json"; LAST_SIGNATURE="$S/$tag-signature.json"
}

pay() { # envfile recipient amount usdc tag
  local S id until reply; S="$(grep '^STYX_NEAR_STATE_ROOT=' "$1" | cut -d= -f2)"; until=$(( $(date +%s) + 3600 ))
  printf 'Invoice %s: %s USDC\n' "$5" "$4" > "$S/$5.txt"
  id=$(cli "$1" "{\"method\":\"propose\",\"recipient\":\"$2\",\"amount\":\"$3\",\"invoice_file\":\"$S/$5.txt\",\"invoice_reference\":\"$5\",\"valid_until\":$until}" | field payment_id)
  reply=$(cli "$1" "{\"method\":\"submit\",\"payment_id\":\"$id\"}")
  echo "$reply" | grep -q '"settled"' || bad "payment did not settle: $reply"
  ok "$4 USDC settled: $(echo "$reply" | field tx_hash)"; record "$5 $4 USDC to $2: $(echo "$reply" | field tx_hash)"
}

# ---- 0. preflight ----------------------------------------------------------------------------
bold "Styx on NEAR: full demo ($RUN)"; : > "$LOG"; chmod 600 "$LOG"
for t in near cast uv python3 curl; do command -v "$t" >/dev/null || bad "missing tool: $t"; done
for f in "$HOME/.styx-near/demo.env" "$HOME/.styx-near/v2.env" "$TOKEN_FILE"; do [ -f "$f" ] || bad "missing $f"; done
[ -x "$BIN" ] || cargo build -q --release --manifest-path "$ROOT/sdk/near/Cargo.toml"
[ "$(curl -s -m 15 "$RELAY/health")" = '{"ok":true}' ] && ok "relay up: $RELAY" || bad "relay not answering at $RELAY"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$PAGE/")" = 200 ] && ok "approval page up: $PAGE" || bad "approval page not answering at $PAGE"
for v in "$V1" "$V2"; do
  view "$v" get_approver "{\"approver\":\"$APPROVER_PK\"}" | grep -q '"enabled":true' && ok "your wallet key is an approver on $v" \
    || bad "your key is not an approver on $v: run scripts/near/wallet_test.sh approver $APPROVER_PK"
done
bal=$(view "$TOKEN" ft_balance_of "{\"account_id\":\"$V1\"}" | tr -d '"')
if [ "${bal:-0}" -lt 300000000 ]; then
  near contract call-function as-transaction "$TOKEN" mint json-args "{\"account_id\":\"$V1\",\"amount\":\"1000000000\"}" prepaid-gas '30 Tgas' \
    attached-deposit '0 NEAR' sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send >/dev/null 2>&1 && ok "topped up the NEAR vault with 1000 test tUSDC"
else ok "NEAR vault holds $(in_usdc "$bal") tUSDC"; fi
VAULT_EVM="$("$ROOT/scripts/near/derived_address.sh" "$V2")"
arc=$(erc20 $ARC_RPC $ARC_USDC "$VAULT_EVM"); base=$(erc20 $BASE_RPC $BASE_USDC "$VAULT_EVM"); eth=$(cast balance "$VAULT_EVM" --rpc-url $BASE_RPC 2>/dev/null)
note "vault's EVM address $VAULT_EVM: Arc $(in_usdc "$arc") USDC, Base $(in_usdc "$base") USDC, Base ETH $(cast from-wei "${eth:-0}")"
# EVM amounts follow vault-v2's own per-payment limit P: P/2 inside it, P + 1 USDC for the exception.
AGENT_PK="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["public_key"])' "$HOME/.styx-near/agent.json")"
P=$(view "$V2" get_agent "{\"agent\":\"$AGENT_PK\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["per_payment_limit"])')
EVM_IN=$(( P / 2 )); EVM_OVER=$(( P + 1000000 ))
need_arc=$EVM_IN; need_base=$(( EVM_IN + EVM_OVER ))
note "vault-v2 per-payment limit $(in_usdc $P) USDC: paying $(in_usdc $EVM_IN) inside it, $(in_usdc $EVM_OVER) with your signature"
[ "${arc:-0}" -ge "$need_arc" ] || bad "fund $VAULT_EVM with at least $(in_usdc $need_arc) USDC on Arc testnet (faucet.circle.com)"
[ "${base:-0}" -ge "$need_base" ] || bad "fund $VAULT_EVM with at least $(in_usdc $need_base) USDC on Base Sepolia (faucet.circle.com)"
[ "${eth:-0}" -ge 1000000000000000 ] || bad "fund $VAULT_EVM with at least 0.001 ETH on Base Sepolia"
ok "EVM balances are enough for this run"

# ---- 1. rules --------------------------------------------------------------------------------
step "1. The owner's rules for the agent, read from the chain"
note "agent: $AGENT_PK"
note "NEAR vault: $(view "$V1" get_agent "{\"agent\":\"$AGENT_PK\"}")"
note "keys on $V1:"
near account list-keys "$V1" network-config "$NETWORK" now 2>&1 | grep -E 'ed25519' | sed -E 's/ +/ /g; s/^/     /' | cut -c1-150

# ---- 2–4. NEAR -------------------------------------------------------------------------------
step "2. Inside the limits on NEAR: 25 tUSDC"
pay "$HOME/.styx-near/demo.env" "vendor-a.$OWNER" 25000000 25 "$RUN-near-a"
step "3. Over the 100 tUSDC limit: 120 tUSDC needs your signature"
approve_and_pay "$HOME/.styx-near/demo.env" "vendor-a.$OWNER" 120000000 120 "$RUN-near-b"
step "4. The agent attacks with its own key: raise its limit, pay over the limit, replay"
ATTACKS="A5 A1 A4" VAULT="$V1" AGENT_KEY_FILE="$HOME/.styx-near/agent.json" PENDING_FILE="$LAST_PENDING" \
  SIGNATURE_FILE="$LAST_SIGNATURE" VENDOR_B="vendor-b.$OWNER" NETWORK="$NETWORK" "${UV[@]}" "$ROOT/scripts/near/attacks.py" | tee -a "$LOG"

# ---- 5. two chains ---------------------------------------------------------------------------
step "5. The same agent key on Arc and Base, through NEAR Chain Signatures ($VAULT_EVM)"
pay "$HOME/.styx-near/v2.env" "eip155:$ARC:$EVM_VENDOR" $EVM_IN "$(in_usdc $EVM_IN)" "$RUN-arc-a"
pay "$HOME/.styx-near/v2.env" "eip155:$BASE:$EVM_VENDOR" $EVM_IN "$(in_usdc $EVM_IN)" "$RUN-base-a"
note "over vault-v2's $(in_usdc $P) USDC limit on Base: $(in_usdc $EVM_OVER) USDC needs your signature"
approve_and_pay "$HOME/.styx-near/v2.env" "eip155:$BASE:$EVM_VENDOR" $EVM_OVER "$(in_usdc $EVM_OVER)" "$RUN-base-b"
for chain in $ARC $BASE; do
  VAULT="$V2" AGENT_KEY_FILE="$HOME/.styx-near/agent.json" PENDING_FILE="$LAST_PENDING" SIGNATURE_FILE="$LAST_SIGNATURE" \
    VENDOR_B=0x14E823AE14720657A7B90429797A5Ea4636e1291 NETWORK="$NETWORK" ATTACKS=E1 ATTACK_CHAIN_ID=$chain ATTACK_RECIPIENT=$EVM_VENDOR \
    "${UV[@]}" "$ROOT/scripts/near/attacks_evm.py" | tee -a "$LOG"
done

# ---- 6. NEAR AI ------------------------------------------------------------------------------
NEARAI_API_KEY="$(sed -n 's/^\(export \)\{0,1\}NEARAI_API_KEY=//p' "$ROOT/.env" 2>/dev/null | head -1)"
if [ -n "$NEARAI_API_KEY" ]; then
  step "6. The agent's model in a NEAR AI Cloud TEE pays an invoice; a reviewer checks the record"
  S="$(grep '^STYX_NEAR_STATE_ROOT=' "$HOME/.styx-near/demo.env" | cut -d= -f2)"
  printf 'Invoice %s from Vendor A\nPay to: vendor-a.%s\nAmount: 15 USDC (15000000 base units)\nFor: model evaluation\n' "$RUN-ai" "$OWNER" > "$S/$RUN-ai.txt"
  (cd "$ROOT/agent-near-ai" && NEARAI_API_KEY="$NEARAI_API_KEY" STYX_NEAR_DEMO_ENV="$HOME/.styx-near/demo.env" \
     uv run -q styx-near-ai-agent "$S/$RUN-ai.txt" --out "$S/$RUN-ai-report.json" 2>&1 | grep -E '^(attestation verified|evidence written|stopped)' | sed 's/^/   /')
  ai=$(python3 - "$S/$RUN-ai-report.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])); pid = tx = ""
for c in r["tool_calls"]:
    res = (c.get("result") or {}).get("result") or {}
    if c["tool"] == "styx_propose_payment" and res.get("payment_id"): pid = res["payment_id"]
    if c["tool"] == "styx_submit_payment" and res.get("state") == "settled": tx = res["tx_hash"]
print(pid or "-", tx or "-")
PY
)
  ai_id="${ai% *}"; ai_tx="${ai#* }"
  if [ "$ai_tx" != "-" ]; then
    ok "settled by the TEE-attested agent: $ai_tx"; record "$RUN-ai 15 USDC (NEAR AI agent): $ai_tx"
    export STYX_NEAR_REVIEWER_KEY="$(python3 -c "import json;print(json.load(open('$HOME/.styx-near/reviewer.json'))['public_key'])")"
    rtx=$(cli "$HOME/.styx-near/demo.env" "{\"method\":\"export_record\",\"payment_id\":\"$ai_id\",\"record_file\":\"$S/$RUN-ai-record.json\"}" | field tx_hash)
    ok "sealed record posted: $rtx"; record "$RUN-ai sealed record: $rtx"
    (cd "$ROOT/reviewer-near" && uv run -q --extra inference styx-near-review verify --key "$HOME/.styx-near/reviewer.json" \
       --rpc https://test.rpc.fastnear.com --vault "$V1" --tx "$rtx" --attestation "$S/attestation-${ai_id:2:12}.json" | sed 's/^/   /')
  else
    note "the TEE agent did not settle (see $S/$RUN-ai-report.json); the rest of the demo stands"
  fi
else
  note "6. skipped: no NEARAI_API_KEY in .env"
fi

# ---- 7. summary ------------------------------------------------------------------------------
bold "== Done. Every transaction from this run (also in $LOG):"
sed 's/^/   /' "$LOG"
note "NEAR transactions: https://testnet.nearblocks.io/txns/<hash>   Base: https://sepolia.basescan.org/tx/<hash>"
