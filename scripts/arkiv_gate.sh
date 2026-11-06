#!/usr/bin/env bash
# G4: publishes one encrypted grant to Arkiv, then fetches and verifies it with every project process stopped.
#
# Needs: ARKIV_PUBLISHER_KEY_FILE, ARKIV_ACCESS_KEY, GRANT_FILE, REVIEWER_KEY_FILE, EXPECTED_ISSUER, OUT.
# Optional: REVIEWER_RPC_URL (default Arc's primary RPC), VAULT (default the deployed vault).
# To check an entity already published, set LOOKUP_TAG and WRITER, and nothing new is written.
set -euo pipefail

: "${ARKIV_PUBLISHER_KEY_FILE:?}" "${ARKIV_ACCESS_KEY:?}" "${GRANT_FILE:?}" "${REVIEWER_KEY_FILE:?}" "${EXPECTED_ISSUER:?}" "${OUT:?}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REVIEWER_RPC_URL="${REVIEWER_RPC_URL:-https://rpc.testnet.arc.io}"
VAULT="${VAULT:-0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1}"
DISCLOSURE="$ROOT/sdk/evm/target/debug/erebus-disclosure"
RUN="$OUT/run-$(date +%s)"
mkdir -p "$RUN"; chmod 700 "$RUN"

project_processes() { pgrep -fl 'watcher/watcher\.py|relay/src/main\.ts|tsx src/main\.ts|erebus_mcp|vite|anvil' | grep -v "$$" || true; }

running="$(project_processes)"
if [ -n "$running" ]; then
  printf 'Stop these project processes first, so the fetch proves nothing of ours is needed:\n%s\n' "$running" >&2
  exit 1
fi

cd "$ROOT/arkiv"
if [ -n "${LOOKUP_TAG:-}" ] && [ -n "${WRITER:-}" ]; then
  TAG="$LOOKUP_TAG"
  echo "== using the entity already published under $TAG"
else
  echo "== publish"
  npm run --silent publish-grant -- "$GRANT_FILE" | tee "$RUN/published.json"
  field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$RUN/published.json" "$1"; }
  TAG="$(field lookupTag)"; WRITER="$(field writer)"
fi

echo "== fetch as a reviewer, with no access key and nothing of ours running"
env -u ARKIV_ACCESS_KEY -u ARKIV_PUBLISHER_KEY_FILE npm run --silent fetch-grant -- "$TAG" "$WRITER" "$RUN/fetched.grant"
cmp "$GRANT_FILE" "$RUN/fetched.grant"
echo "fetched bytes match the local grant"

echo "== another writer's answer is not accepted"
set +e
env -u ARKIV_ACCESS_KEY npm run --silent fetch-grant -- "$TAG" 0x0000000000000000000000000000000000000001 "$RUN/wrong-writer.grant"
code=$?
set -e
[ "$code" -eq 3 ] || { echo "FAIL: wrong writer exited $code, expected 3"; exit 1; }
[ ! -e "$RUN/wrong-writer.grant" ] || { echo "FAIL: wrong writer produced a file"; exit 1; }
echo "PASS: nothing found for another writer"

CODE_HASH="$(cast keccak "$(cast code "$VAULT" --rpc-url "$REVIEWER_RPC_URL")")"
LOWER="$(printf '%s' "$VAULT" | tr 'A-F' 'a-f')"
verify() {
  printf '{"method":"verify_vault_payment","grant_file":"%s","key_file":"%s","expected_issuer":"%s","deployment":{"chain_id":5042002,"rpc_urls":["%s"],"vault":"%s","vault_code_hash":"%s"},"opened_file":null}' \
    "$1" "$REVIEWER_KEY_FILE" "$EXPECTED_ISSUER" "$REVIEWER_RPC_URL" "$LOWER" "$CODE_HASH" | "$DISCLOSURE"
}

echo "== verify the fetched copy against Arc"
# Public RPCs drop requests under load. Unavailable means not known yet, so it is asked again.
for attempt in 1 2 3 4 5; do
  RESULT="$(verify "$RUN/fetched.grant" || true)"
  printf '%s' "$RESULT" | grep -q '"unavailable"' || break
  echo "the RPC could not answer (attempt $attempt); waiting"
  sleep $((attempt * 5))
done
printf '%s\n' "$RESULT" | tee "$RUN/verified.json"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("status")=="ok" and all(d.get(k)=="verified" for k in ("record_integrity","authorization","settlement","policy_at_execution")) else 1)' "$RESULT" \
  || { echo "FAIL: the fetched copy did not verify"; exit 1; }

echo "== a tampered ciphertext is refused"
python3 - "$RUN/fetched.grant" "$RUN/tampered.grant" <<'PY'
import os, sys
data = bytearray(open(sys.argv[1], "rb").read())
data[len(data) // 2] ^= 1
open(sys.argv[2], "wb").write(data)
os.chmod(sys.argv[2], 0o600)
PY
TAMPERED="$(verify "$RUN/tampered.grant" || true)"
printf '%s\n' "$TAMPERED"
python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("status")!="ok" else 1)' "$TAMPERED" \
  || { echo "FAIL: a tampered grant was accepted"; exit 1; }

echo "G4 passed. Lookup tag $TAG, writer $WRITER. Results in $RUN"
