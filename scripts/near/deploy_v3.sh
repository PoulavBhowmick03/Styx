#!/usr/bin/env bash
# Rebuild the embedded vault before redeploying an EXISTING testnet factory.
# Settings: ~/.styx-near/v3.env (or STYX_NEAR_DEMO_ENV), FACTORY defaults to styx-vaults.testnet.
# The factory account's deploy key must already be in the external NEAR legacy keychain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${STYX_NEAR_DEMO_ENV:-$HOME/.styx-near/v3.env}"
case "$ENV_FILE" in "$HOME"/.styx-near/*.env) ;; *) echo 'Settings must be under ~/.styx-near/ (*.env)' >&2; exit 1;; esac
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
FACTORY="${FACTORY:-styx-vaults.testnet}"
[ "${NETWORK:-testnet}" = testnet ] && [ "${STYX_NEAR_NETWORK:-testnet}" = testnet ] || { echo 'Testnet only' >&2; exit 1; }
case "$FACTORY" in *.testnet) ;; *) echo 'Factory must be a testnet account' >&2; exit 1;; esac
"$ROOT/contracts/near/build.sh" "$ROOT/contracts/near/styx-vault"
"$ROOT/contracts/near/build.sh" "$ROOT/contracts/near/styx-factory"
near contract deploy "$FACTORY" use-file "$ROOT/contracts/near/styx-factory/target/near/styx_factory.wasm" \
  without-init-call network-config testnet sign-with-legacy-keychain send
cat <<NEXT
Factory redeployed: $FACTORY. Existing vaults are unchanged.
Next:
1. Build the CLI: cargo build --release --manifest-path "$ROOT/sdk/near/Cargo.toml"
2. Create a NEW vault through the owner console's factory flow (version 3).
3. Fund it; configure its agent, recipient, spending limits and sentinel keys as owner.
   Sentinel key files belong in ~/.styx-near/sentinels/ with mode 600.
4. Save STYX_NEAR_VAULT, STYX_NEAR_AGENT_KEY_FILE, STYX_NEAR_STATE_ROOT and VENDOR
   in ~/.styx-near/v3.env; keep state and keys outside the repo. Set STYX_NEAR_NETWORK=testnet.
5. Start the sentinel runner, then run:
   STYX_NEAR_DEMO_ENV=\"\$HOME/.styx-near/v3.env\" "$ROOT/scripts/near/drain_attack.sh" 20 1
   Amount is in whole or decimal token units (6 decimals, like USDC).
NEXT
