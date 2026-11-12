#!/usr/bin/env bash
# Prints the EVM address NEAR's MPC network derives for a vault account (path styx-evm, domain 0).
# Usage: derived_address.sh <vault account> [mpc signer, default v1.signer-prod.testnet]
set -euo pipefail
key="$(near contract call-function as-read-only "${2:-v1.signer-prod.testnet}" derived_public_key \
  json-args "{\"path\":\"styx-evm\",\"predecessor\":\"$1\",\"domain_id\":0}" network-config "${NETWORK:-testnet-fastnear}" now 2>&1 \
  | grep -oE 'secp256k1:[1-9A-HJ-NP-Za-km-z]+' | head -1)"
hex="$(python3 -c "
import sys
a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; n=0
for c in sys.argv[1].split(':')[1]: n=n*58+a.index(c)
print(n.to_bytes(64,'big').hex())" "$key")"
echo "0x$(cast keccak "0x$hex" | cut -c27-)"
