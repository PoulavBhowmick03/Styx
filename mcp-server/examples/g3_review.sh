#!/usr/bin/env bash
# The reviewer's side of gate G3, in one script. It only reads: it sends no transaction and needs no funds.
#
#   g3_review.sh <first.grant> <second.grant> <issuer-address>
#
# Needs erebus-disclosure, cast and python3. The reviewer key must already exist (keygen) and stay private.
# Settings, all optional:
#   REVIEW_KEY       the reviewer's key file             (default ~/styx-g3-reviewer/key)
#   RPC              the reviewer's own RPC              (default https://rpc.testnet.arc.io)
#   VAULT            the vault, lowercase or checksummed (default 0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1)
#   CHAIN_ID         the chain                           (default 5042002)
#   EXPECTED_ISSUER  the issuer you were told to expect  (default 0x35879a311848b924cce79d788e102de499546a4e)
#   DISCLOSURE_BIN   the reviewer tool                   (default sdk/evm/target/debug/erebus-disclosure)
#   OUT              where this run keeps its files      (default ~/styx-g3-reviewer/run-<time>)
#
# Exit 0 only if every outcome was the expected one. That is still not G3: the gate also needs a machine that has
# never held a Styx key, and the code hash compared with the one the team recorded.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ "$#" -eq 3 ] || { sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
GRANT1="$1"; GRANT2="$2"; ISSUER="$(printf '%s' "$3" | tr 'A-F' 'a-f')"
KEY="${REVIEW_KEY:-$HOME/styx-g3-reviewer/key}"
RPC="${RPC:-https://rpc.testnet.arc.io}"
VAULT="$(printf '%s' "${VAULT:-0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1}" | tr 'A-F' 'a-f')"
CHAIN_ID="${CHAIN_ID:-5042002}"
EXPECTED_ISSUER="$(printf '%s' "${EXPECTED_ISSUER:-0x35879a311848b924cce79d788e102de499546a4e}" | tr 'A-F' 'a-f')"
BIN="${DISCLOSURE_BIN:-$ROOT/sdk/evm/target/debug/erebus-disclosure}"
OUT="${OUT:-$HOME/styx-g3-reviewer/run-$(date +%Y%m%d-%H%M%S)}"

say() { printf '%s\n' "$*"; }
stop() { say "STOP: $*"; exit 1; }
mode_of() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }

[ -x "$BIN" ] || stop "build the reviewer tool first: (cd sdk/evm && cargo build --bin erebus-disclosure)"
mkdir -p "$OUT" && chmod 700 "$OUT"

say "== Inputs"
for f in "$KEY" "$GRANT1" "$GRANT2"; do
  [ -f "$f" ] || stop "$f does not exist"
  m="$(mode_of "$f")"
  [ "$m" = 600 ] || [ "$m" = 400 ] || stop "$f has mode $m. Save grants and the key with mode 600: chmod 600 \"$f\""
done
say "key and both grants are owner-only"

say; say "== Issuer"
say "you were given:   $ISSUER"
say "you expected:     $EXPECTED_ISSUER"
if [ "$ISSUER" != "$EXPECTED_ISSUER" ]; then
  stop "the issuer DIFFERS from the one expected. Do not verify against it. Tell the team and ask which is right."
fi
say "the issuer matches"

say; say "== Vault code hash, from your own RPC (not from anything the issuer sent)"
[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" = "$CHAIN_ID" ] || stop "your RPC does not serve chain $CHAIN_ID"
CODE="$(cast code "$VAULT" --rpc-url "$RPC" 2>/dev/null)"
[ "${#CODE}" -gt 10 ] || stop "there is no code at $VAULT on your RPC"
CODE_HASH="$(cast keccak "$CODE")"
say "vault:      $VAULT on chain $CHAIN_ID"
say "RPC:        $RPC"
say "code hash:  $CODE_HASH"
say "(compare it with the hash the team wrote down. If they wrote none, say so in your report.)"

pins() { printf '{"chain_id":%s,"rpc_urls":["%s"],"vault":"%s","vault_code_hash":"%s"}' "$CHAIN_ID" "$1" "$VAULT" "$CODE_HASH"; }
request() { printf '{"method":"verify_vault_payment","grant_file":"%s","key_file":"%s","expected_issuer":"%s","deployment":%s}' "$1" "$KEY" "$ISSUER" "$(pins "$2")"; }
verify() { local req; req="$(request "$1" "$2")"; printf '%s\n' "$req" >> "$OUT/requests.log"; env -i "$BIN" <<<"$req" || true; }

python3 - "$GRANT1" "$OUT/tampered.grant" <<'PY'
import os, sys
data = bytearray(open(sys.argv[1], "rb").read())
data[len(data) // 2] ^= 1
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "wb") as out:
    out.write(data)
PY

# Prints one line and exits 0 only if the outcome is the expected one.
judge() { python3 - "$1" "$2" "$3" <<'PY'
import json, sys
name, kind, raw = sys.argv[1:4]
try:
    d = json.loads(raw)
except ValueError:
    print(f"  {name}: DIFFERS - the tool printed no JSON: {raw[:120]!r}"); sys.exit(1)
four = [d.get(k) for k in ("record_integrity", "authorization", "settlement", "policy_at_execution")]
shown = "integrity=%s authorization=%s settlement=%s policy=%s" % tuple(four)
if kind != "refused" and "error" in d:
    print(f"  {name}: DIFFERS - the tool refused instead of reporting: {d.get('error')}"); sys.exit(1)
ok = False
if kind == "all-verified":
    ok = d.get("status") == "ok" and all(v == "verified" for v in four)
    print(f"  {name}: {'as expected' if ok else 'DIFFERS'} - {shown}")
elif kind == "refused":
    ok = d.get("status") != "ok" and "error" in d
    print(f"  {name}: {'as expected, refused' if ok else 'DIFFERS'} - " + (f"error: {d.get('error')}" if "error" in d else shown))
elif kind == "unavailable":
    ok = d.get("status") == "ok" and four[0] == "verified" and all(v == "unavailable" for v in four[1:])
    unpaid = any(v == "failed" for v in four[1:])
    print(f"  {name}: {'as expected' if ok else 'DIFFERS'} - {shown}" + ("  (A FAILED RESULT: an unreachable chain must read unavailable, never unpaid)" if unpaid else ""))
sys.exit(0 if ok else 1)
PY
}

say; say "== The checks (exact requests are in $OUT/requests.log)"
fails=0
r1="$(verify "$GRANT1" "$RPC")";                 judge "first grant, your RPC          " all-verified "$r1" || fails=$((fails+1))
say "     reasons: $(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("reasons",""))' "$r1" 2>/dev/null)"
r2="$(verify "$OUT/tampered.grant" "$RPC")";     judge "one byte changed               " refused      "$r2" || fails=$((fails+1))
r3="$(verify "$GRANT2" "$RPC")";                 judge "the second grant               " refused      "$r3" || fails=$((fails+1))
r4="$(verify "$GRANT1" "http://127.0.0.1:1")";   judge "first grant, RPC unreachable   " unavailable  "$r4" || fails=$((fails+1))

say; say "== Result"
if [ "$fails" -eq 0 ]; then
  say "Every outcome was the expected one on this machine."
  say "That is not the same as G3 passing. G3 also needs: a machine or profile that has never held a Styx key, and the code hash compared with the team's record. Report both honestly."
  exit 0
fi
say "$fails outcome(s) DIFFERED from what was expected. Do not claim G3 passed."
exit 1
