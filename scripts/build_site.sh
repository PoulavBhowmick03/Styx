#!/usr/bin/env bash
# Builds the hosted site: the Arc approval page at /, the Arc setup page at /setup/, and the NEAR
# approval page at /approval/, on one origin. Usage: VITE_RELAY_URL=https://... scripts/build_site.sh
# The NEAR page's default relay is NEAR_RELAY_URL (default https://styx-relay-near.fly.dev).
set -euo pipefail
: "${VITE_RELAY_URL:?}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/styx-approve"
rm -rf "$OUT"; mkdir -p "$OUT"
(cd "$ROOT/owner-page" && npx vite build --outDir "$OUT" --emptyOutDir)
(cd "$ROOT/setup-page" && npm run --silent prepare-artifact && VITE_DEPLOY_CURRENT=1 npx vite build --base /setup/ --outDir "$OUT/setup" --emptyOutDir)
(cd "$ROOT/approval-page-near" && VITE_DEFAULT_RELAY="${NEAR_RELAY_URL:-https://styx-relay-near.fly.dev}" npx vite build --base /approval/ --outDir "$OUT/approval" --emptyOutDir)
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
