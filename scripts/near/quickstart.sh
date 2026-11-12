#!/usr/bin/env bash
# Styx on NEAR, from nothing to a funded vault and six refused attacks, on NEAR testnet, with your
# own accounts. Nothing here uses the authors' keys.
#
#   scripts/near/quickstart.sh
#
# What it does:
#   1. builds the vault, the test token and the agent CLI;
#   2. creates a new testnet account for you from the NEAR faucet (key in ~/.near-credentials);
#   3. deploys the token and a vault under it, and generates an agent key and an approver key in
#      ~/.styx-near-quickstart/<account>/ (never in the repo);
#   4. as the owner: registers two vendors, funds the vault, sets the agent's limits (100 tUSDC per
#      payment, 1000 per day) and the approver;
#   5. as the agent: pays 25 inside the limits, is refused 140 alone, settles 140 with the
#      approver's NEP-413 signature, then runs attacks A1 to A6 with its own key.
#
# Needs: near CLI (near-cli-rs), cargo-near >= 0.17, Rust with the wasm32-unknown-unknown target,
# python3 and uv. Optional: NETWORK, a near CLI connection name (default testnet-fastnear when it exists). Set AUTO=0 to
# pause between demo steps.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# near-cli-rs ships a testnet-fastnear connection; its default testnet RPC is often rate-limited.
if [ -z "${NETWORK:-}" ]; then
  # The CLI prints this to stderr. grep -c, not -q: -q closes the pipe early and trips pipefail.
  found="$(near config show-connections 2>&1 | grep -c 'network_connection.testnet-fastnear' || true)"
  [ "${found:-0}" -gt 0 ] && NETWORK=testnet-fastnear || NETWORK=testnet
fi
say() { printf '\n\033[1m>> %s\033[0m\n' "$1"; }
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
# A new account can take a few seconds to appear on a given RPC node.
wait_for() {
  for _ in $(seq 1 20); do
    near account view-account-summary "$1" network-config "$NETWORK" now >/dev/null 2>&1 && return 0
    sleep 3
  done
  echo "account $1 did not appear on $NETWORK"; exit 1
}
need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)"; exit 1; }; }
need near "cargo install near-cli-rs"
need cargo-near "cargo install cargo-near"
need uv "https://docs.astral.sh/uv/"
need python3 "python 3.11+"

echo "using near CLI connection: $NETWORK"
say "1/5 Building the contracts and the agent CLI"
"$ROOT/contracts/near/build.sh" "$ROOT/contracts/near/styx-vault" >/dev/null
"$ROOT/contracts/near/build.sh" "$ROOT/contracts/near/styx-usdc" >/dev/null
cargo build -q --release --manifest-path "$ROOT/sdk/near/Cargo.toml"

OWNER="${OWNER:-styx-qs-$(openssl rand -hex 3).testnet}"
HOME_DIR="$HOME/.styx-near-quickstart/$OWNER"
mkdir -p "$HOME_DIR/state" && chmod 700 "$HOME/.styx-near-quickstart" "$HOME_DIR" "$HOME_DIR/state"
NET=(network-config "$NETWORK" sign-with-legacy-keychain send)

say "2/5 Creating $OWNER from the testnet faucet"
near account create-account sponsor-by-faucet-service "$OWNER" autogenerate-new-keypair \
  save-to-legacy-keychain network-config "$NETWORK" create 2>&1 | grep -E 'created|rror' | head -2
wait_for "$OWNER"

say "3/5 Deploying the token and the vault"
for sub in usdc:2 vault:4; do
  near_retry account create-account fund-myself "${sub%%:*}.$OWNER" "${sub##*:} NEAR" autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$OWNER" "${NET[@]}"
  wait_for "${sub%%:*}.$OWNER"
done
near_retry contract deploy "usdc.$OWNER" use-file "$ROOT/contracts/near/styx-usdc/target/near/styx_usdc.wasm" \
  with-init-call new json-args '{}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' "${NET[@]}"
near_retry contract deploy "vault.$OWNER" use-file "$ROOT/contracts/near/styx-vault/target/near/styx_vault.wasm" \
  with-init-call new json-args "{\"owner\":\"$OWNER\",\"token\":\"usdc.$OWNER\"}" prepaid-gas '50 Tgas' \
  attached-deposit '0 NEAR' "${NET[@]}"
UVK=(uv run -q --with pynacl --with base58)
AGENT_PK=$("${UVK[@]}" "$ROOT/scripts/near/keygen.py" "$HOME_DIR/agent.json")
APPROVER_PK=$("${UVK[@]}" "$ROOT/scripts/near/keygen.py" "$HOME_DIR/approver.json")
echo "agent key $AGENT_PK, approver key $APPROVER_PK"

say "4/5 Owner sets the rules"
OWNER="$OWNER" AGENT_PK="$AGENT_PK" APPROVER_PK="$APPROVER_PK" NETWORK="$NETWORK" DAILY=1000 VAULT_DAILY=2000 \
  "$ROOT/scripts/near/setup_testnet.sh"

cat > "$HOME_DIR/demo.env" <<EOF
STYX_NEAR_VAULT=vault.$OWNER
STYX_NEAR_AGENT_KEY_FILE=$HOME_DIR/agent.json
STYX_NEAR_STATE_ROOT=$HOME_DIR/state
STYX_NEAR_APPROVER=$APPROVER_PK
APPROVER_KEY_FILE=$HOME_DIR/approver.json
APPROVER_ACCOUNT=$OWNER
VENDOR=vendor-a.$OWNER
VENDOR_B=vendor-b.$OWNER
EOF
chmod 600 "$HOME_DIR/demo.env"

say "5/5 The agent pays, asks, and attacks"
STYX_NEAR_DEMO_ENV="$HOME_DIR/demo.env" NETWORK="$NETWORK" DEMO_ATTACKS="A1 A2 A3 A4 A5 A6" \
  "$ROOT/scripts/near/demo.sh" "$([ "${AUTO:-1}" = 0 ] || echo auto)"

say "Done. Your vault: https://testnet.nearblocks.io/address/vault.$OWNER"
echo "Re-run the demo any time: STYX_NEAR_DEMO_ENV=$HOME_DIR/demo.env scripts/near/demo.sh"
