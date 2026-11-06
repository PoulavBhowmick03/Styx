#!/usr/bin/env bash
# Builds the hosted site: the approval page at / and the setup page at /setup/, on one origin so they
# share what the owner has confirmed. Usage: VITE_RELAY_URL=https://... scripts/build_site.sh
set -euo pipefail
: "${VITE_RELAY_URL:?}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/styx-approve"
rm -rf "$OUT"; mkdir -p "$OUT"
(cd "$ROOT/owner-page" && npx vite build --outDir "$OUT" --emptyOutDir)
(cd "$ROOT/setup-page" && npx vite build --base /setup/ --outDir "$OUT/setup" --emptyOutDir)
# The request ID is in the approval link, so it must not leak in a referrer. The page must not be framed.
cat >"$OUT/vercel.json" <<'JSON'
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "X-Frame-Options", "value": "DENY" },
      { "key": "Content-Security-Policy", "value": "frame-ancestors 'none'" },
      { "key": "Referrer-Policy", "value": "no-referrer" },
      { "key": "X-Content-Type-Options", "value": "nosniff" }
    ]
  }]
}
JSON
echo "Built $OUT"
