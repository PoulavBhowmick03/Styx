#!/usr/bin/env bash
# The owner's setup of a Styx vault on NEAR testnet: vendors, token registrations, funding, and
# the policy. Every call is signed by the owner from the near CLI's local keychain; the agent and
# approver keys are only read for their public keys.
#
# Needs: OWNER (e.g. styx-owner-c87a.testnet), AGENT_PK, APPROVER_PK.
# Optional: NETWORK (a near CLI connection, default testnet), PER_PAYMENT (default 100 USDC), DAILY (250), VAULT_DAILY (500), FUND (1000), in USDC.
set -euo pipefail
: "${OWNER:?}" "${AGENT_PK:?}" "${APPROVER_PK:?}"
VAULT="vault.$OWNER"; TOKEN="usdc.$OWNER"; VENDOR_A="vendor-a.$OWNER"; VENDOR_B="vendor-b.$OWNER"
usdc() { echo "$(( $1 * 1000000 ))"; }
NET=(network-config "${NETWORK:-testnet}" sign-with-legacy-keychain send)

# Runs a near CLI command, retrying transient RPC failures (a fresh key's nonce not visible yet,
# rate limits). Output that says the work is already done counts as success, so nothing repeats.
near_retry() {
  local out
  for attempt in 1 2 3 4 5 6; do
    out="$(near "$@" 2>&1)" || true
    if ! grep -q '^Error' <<<"$out" || grep -qiE 'already exists|succeeded|successfully' <<<"$out"; then
      grep -E 'Transaction ID|succeeded|successfully|transferred|created|panicked' <<<"$out" | head -2
      return 0
    fi
    sleep $((attempt * 3))
  done
  grep -A3 '^Error' <<<"$out" | head -6
  return 1
}
call() { # signer contract method json [deposit]
  near_retry contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas '100 Tgas' \
    attached-deposit "${5:-0 NEAR}" sign-as "$1" "${NET[@]}"
}

for vendor in "$VENDOR_A" "$VENDOR_B"; do
  near account view-account-summary "$vendor" network-config "${NETWORK:-testnet}" now >/dev/null 2>&1 \
    || near_retry account create-account fund-myself "$vendor" '0.5 NEAR' autogenerate-new-keypair \
         save-to-legacy-keychain sign-as "$OWNER" "${NET[@]}"
done
for account in "$VAULT" "$VENDOR_A" "$VENDOR_B"; do
  call "$OWNER" "$TOKEN" storage_deposit "{\"account_id\":\"$account\",\"registration_only\":true}" '0.00125 NEAR'
done
call "$OWNER" "$TOKEN" mint "{\"account_id\":\"$VAULT\",\"amount\":\"$(usdc "${FUND:-1000}")\"}"
until=$(( $(date +%s) + 7 * 86400 ))
call "$OWNER" "$VAULT" configure_agent "{\"agent\":\"$AGENT_PK\",\"per_payment_limit\":\"$(usdc "${PER_PAYMENT:-100}")\",\"daily_limit\":\"$(usdc "${DAILY:-250}")\",\"valid_until\":\"$until\",\"enabled\":true}"
call "$OWNER" "$VAULT" set_recipient "{\"recipient\":\"$VENDOR_A\",\"allowed\":true}"
call "$OWNER" "$VAULT" set_recipient "{\"recipient\":\"$VENDOR_B\",\"allowed\":true}"
call "$OWNER" "$VAULT" set_vault_daily_limit "{\"limit\":\"$(usdc "${VAULT_DAILY:-500}")\"}"
call "$OWNER" "$VAULT" set_approver "{\"approver\":\"$APPROVER_PK\",\"enabled\":true}"
echo "vault $VAULT ready; agent key installed: $(near account list-keys "$VAULT" network-config "${NETWORK:-testnet}" now 2>&1 | grep -c "${AGENT_PK#ed25519:}")"
