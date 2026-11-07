#!/usr/bin/env bash
# The demo on a brand-new vault: asks who approves, makes an agent, opens the website for the owner to create
# and fund the vault, checks the result on Arc, then runs the payments, attacks, reviewer and Arkiv steps.
#
#   scripts/demo_new.sh
#
# To run the steps again on the same vault:
#   DEMO_ENV=~/.styx-mumbai/demo-runs/latest/session.env scripts/demo.sh
#
# Reads the same private settings as scripts/demo.sh. The owner's and approver's keys stay in their wallets:
# this script only ever asks for addresses. It prints no key or token.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_ENV="${DEMO_ENV:-$HOME/.styx-mumbai/demo.env}"
[ -r "$BASE_ENV" ] || { echo "Settings file not found: $BASE_ENV"; exit 2; }
# shellcheck disable=SC1090
source "$BASE_ENV"
: "${DEMO_RPC:?}" "${DEMO_VENDOR_A:?}" "${DEMO_VENDOR_B:?}" "${STYX_VAULT_TOKEN:?}"
RELAY="${STYX_VAULT_RELAY_URL:-https://styx-vault-relay.fly.dev}"
RUNS="$HOME/.styx-mumbai/demo-runs"
RUN="$RUNS/$(date +%Y%m%d-%H%M%S)"
GAS_KEY_FILE="${DEMO_GAS_KEY_FILE:-${STYX_VAULT_AGENT_KEY_FILE:-}}"
EXCEPTION_AMOUNT="${DEMO_EXCEPTION_AMOUNT:-2000000}"
AGENT_GAS=300000
ZERO=0x0000000000000000000000000000000000000000

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; N=$'\033[0m'; else B=; G=; R=; N=; fi
title() { printf '\n%s━━ %s%s\n\n' "$B" "$1" "$N"; }
good() { printf '%s✓ %s%s\n' "$G" "$1" "$N"; }
bad() { printf '%s✕ %s%s\n' "$R" "$1" "$N"; }
info() { printf '  %s\n' "$1"; }
first() { awk '{print $1}'; }
call() { cast call "$@" --rpc-url "$DEMO_RPC" 2>/dev/null; }

ask_address() { # prompt, default
  local answer
  while :; do
    printf '%s%s: ' "$1" "${2:+ [$2]}" >&2
    IFS= read -r answer || exit 2
    answer="${answer:-${2:-}}"
    if [[ "$answer" =~ ^0x[0-9a-fA-F]{40}$ ]] && [ "$answer" != "$ZERO" ]; then cast to-check-sum-address "$answer"; return; fi
    echo "That is not an address. It starts with 0x and has 40 more characters." >&2
  done
}

title "1. Who approves payments over the limit?"
info "Use a wallet you can sign with on your phone. It cannot be the wallet that owns the vault."
APPROVER="$(ask_address "Approver's wallet address")"

title "2. Link the approver to Telegram"
while ! curl -s -m 15 "$RELAY/links/$APPROVER" | grep -q '"linked":true'; do
  info "$APPROVER is not linked yet."
  info "On the approver's phone: open https://t.me/styx_agent_bot, send /start, tap Connect my wallet, and sign."
  printf 'Press Enter to check again, or type skip to use a direct link instead of an alert: '
  IFS= read -r answer || exit 2
  [ "$answer" = skip ] && break
done
curl -s -m 15 "$RELAY/links/$APPROVER" | grep -q '"linked":true' && good "The approver's alerts will go to their own Telegram chat"

title "3. Make the agent's key, on this machine"
mkdir -p "$RUNS"; chmod 700 "$HOME/.styx-mumbai" "$RUNS"
"$ROOT/scripts/agent_setup.sh" "$RUN/agent" >/dev/null || { bad "Could not make the agent's key"; exit 1; }
AGENT_KEY="$RUN/agent/agent.key"
AGENT="$(cast wallet address --private-key "$(tr -d '[:space:]' <"$AGENT_KEY")")"
good "Agent address: $AGENT"
held="$(call "$STYX_VAULT_TOKEN" 'balanceOf(address)(uint256)' "$AGENT" | first)"
if [ -r "$GAS_KEY_FILE" ] && [ "${held:-0}" -lt "$AGENT_GAS" ]; then
  if cast send "$STYX_VAULT_TOKEN" 'transfer(address,uint256)' "$AGENT" "$AGENT_GAS" --rpc-url "$DEMO_RPC" --private-key "$(tr -d '[:space:]' <"$GAS_KEY_FILE")" >/dev/null 2>&1; then
    good "Sent the agent 0.3 USDC for gas. That is all it holds"
  else
    bad "Could not send gas. Send $AGENT about 0.3 USDC yourself"
  fi
else
  info "Send $AGENT about 0.3 USDC for gas."
fi

title "4. Vendors"
VENDOR_A="$(ask_address "Vendor the agent will pay" "$DEMO_VENDOR_A")"

SETUP="https://styxco.xyz/setup/?path=team"
title "5. On the website, with the wallet that will own the vault"
info "$SETUP"
info ""
info "1. Connect the wallet and deploy a new vault."
info "2. Set the vault's daily cap: 10"
info "3. Add this agent: $AGENT"
info "   Limits: 1 per payment, 10 per day, 7 days"
info "4. Add this approver: $APPROVER"
info "5. Allow this vendor: $VENDOR_A"
info "6. Move 5 USDC into the vault."
info "7. On the agent, choose the approver and press Connect this agent."
info "8. Press Copy in the panel that appears. Do this last: the token is shown once."
if command -v open >/dev/null 2>&1 && [ "${DEMO_NO_OPEN:-}" != 1 ]; then open "$SETUP"; fi

read_settings() { # prints the vault, token and code hash, tab-separated, from the copied settings
  local text
  if [ -n "${DEMO_SETTINGS_FILE:-}" ]; then text="$(cat "$DEMO_SETTINGS_FILE" 2>/dev/null)"; else text="$(pbpaste 2>/dev/null)"; fi
  python3 -c '
import json,sys
env=json.loads(sys.argv[1])["mcpServers"]["styx-vault"]["env"]
print(env["STYX_VAULT_ADDRESS"],env["STYX_VAULT_RELAY_TOKEN"],env["STYX_VAULT_CODE_HASH"],sep="\t")' "$text" 2>/dev/null
}

check_vault() { # every rule the demo relies on, read from Arc and the relay
  local ok=0 policy per daily enabled cap funds approver_on allowed me version
  version="$(call "$VAULT" 'contractVersion()(uint256)' | first)"
  [ "$version" = 2 ] || { bad "$VAULT is not a Styx vault"; return 1; }
  policy="$(call "$VAULT" 'agentPolicy(address)(uint256,uint256,uint256,uint64,bool)' "$AGENT" | first | tr '\n' ' ')"
  read -r _ per daily _ enabled <<<"$policy"
  cap="$(call "$VAULT" 'vaultDailyLimit()(uint256)' | first)"
  funds="$(call "$STYX_VAULT_TOKEN" 'balanceOf(address)(uint256)' "$VAULT" | first)"
  approver_on="$(call "$VAULT" 'approverState(address)(uint256,bool)' "$APPROVER" | sed -n 2p)"
  allowed="$(call "$VAULT" 'allowedRecipient(address)(bool)' "$VENDOR_A")"
  me="$(curl -s -m 15 -H "authorization: Bearer $RELAY_TOKEN" "$RELAY/agents/me")"
  if [ "${enabled:-}" = true ] && [ "${per:-0}" -gt 0 ] && [ "${per:-0}" -lt "$EXCEPTION_AMOUNT" ]; then good "Agent is on, and 2 USDC is over its per-payment limit"; else bad "Agent: switch it on with a per-payment limit under 2 USDC"; ok=1; fi
  if [ "${daily:-0}" -gt "$EXCEPTION_AMOUNT" ]; then good "Agent's daily limit has room"; else bad "Agent: set a daily limit above 2 USDC"; ok=1; fi
  if [ "${cap:-0}" -gt "$EXCEPTION_AMOUNT" ]; then good "Vault's daily cap has room"; else bad "Vault: set a daily cap above 2 USDC"; ok=1; fi
  if [ "${funds:-0}" -gt "$EXCEPTION_AMOUNT" ]; then good "Vault is funded"; else bad "Vault: move more than 2 USDC in"; ok=1; fi
  if [ "$approver_on" = true ]; then good "Approver is on the vault"; else bad "Vault: add approver $APPROVER"; ok=1; fi
  if [ "$allowed" = true ]; then good "Vendor is allowed"; else bad "Vault: allow vendor $VENDOR_A"; ok=1; fi
  if python3 -c 'import json,sys; from sys import argv; d=json.loads(argv[1]); raise SystemExit(0 if d.get("approver","").lower()==argv[2].lower() and d.get("agent","").lower()==argv[3].lower() and d.get("vault","").lower()==argv[4].lower() else 1)' "$me" "$APPROVER" "$AGENT" "$VAULT" 2>/dev/null; then good "Agent is connected, with this approver"; else bad "Press Connect this agent again, with approver $APPROVER, then Copy"; ok=1; fi
  return "$ok"
}

title "6. Checking the vault on Arc"
while :; do
  printf 'Press Enter once you have pressed Copy: '
  IFS= read -r _ || exit 2
  settings="$(read_settings)"
  if [ -z "$settings" ]; then bad "The clipboard does not hold the agent's settings. Press Copy on the page."; continue; fi
  IFS=$'\t' read -r VAULT RELAY_TOKEN CODE_HASH <<<"$settings"
  check_vault && break
  info "Fix the items above on the website."
done
command -v pbcopy >/dev/null 2>&1 && [ -z "${DEMO_SETTINGS_FILE:-}" ] && printf '' | pbcopy
good "Vault $VAULT is ready"

(umask 077; cat >"$RUN/session.env" <<EOF
source "$BASE_ENV"
export STYX_VAULT_ADDRESS=$VAULT STYX_VAULT_CODE_HASH=$CODE_HASH
export STYX_VAULT_AGENT_KEY_FILE=$AGENT_KEY STYX_VAULT_DIR=$RUN/agent STYX_VAULT_STATE_ROOT=$RUN/agent/journal
export STYX_VAULT_RELAY_URL=$RELAY STYX_VAULT_RELAY_TOKEN=$RELAY_TOKEN
DEMO_APPROVER=$APPROVER
DEMO_VENDOR_A=$VENDOR_A
DEMO_ARKIV_PUBLISHER_KEY_FILE=${DEMO_ARKIV_PUBLISHER_KEY_FILE:-$HOME/.styx-mumbai/arkiv-publisher.key}
EOF
)
ln -sfn "$RUN" "$RUNS/latest"

export DEMO_ENV="$RUN/session.env"
pause() { [ "${DEMO_AUTO:-}" = 1 ] || { printf '\n[Enter] %s' "$1"; IFS= read -r _; }; }
for step in check pay approve attack review arkiv links; do
  pause "$step"
  "$ROOT/scripts/demo.sh" "$step" || { bad "The $step step did not finish. To retry it: DEMO_ENV=$RUN/session.env scripts/demo.sh $step"; exit 1; }
done
