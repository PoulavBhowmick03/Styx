#!/usr/bin/env bash
# Makes an agent's key on this machine, where it stays, and prints its address for the owner to paste.
# Usage: scripts/agent_setup.sh [directory]
set -euo pipefail
DIR="${1:-$HOME/.styx-agent}"
KEY="$DIR/agent.key"
mkdir -p "$DIR" "$DIR/journal"
chmod 700 "$DIR"
if [ -s "$KEY" ]; then
  echo "Keeping the existing key in $KEY"
else
  (umask 077; cast wallet new --json | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print(d["private_key"])' >"$KEY")
fi
chmod 600 "$KEY"
ADDRESS="$(cast wallet address --private-key "$(tr -d '[:space:]' <"$KEY")")"
cat <<OUT

Agent address, to paste into the setup page:

  $ADDRESS

Send this address a little testnet USDC for gas, about 0.5 USDC: https://faucet.circle.com
Keep the rest of your money in the vault. The vault only protects what is inside it.

For the MCP config:

  STYX_VAULT_AGENT_KEY_FILE=$KEY
  STYX_VAULT_DIR=$DIR
  STYX_VAULT_STATE_ROOT=$DIR/journal

Your key stays in $KEY. Never paste it anywhere.
OUT
