#!/usr/bin/env bash
# Builds styxco.xyz: a landing page at /, the NEAR approval page at /approval/ and the owner console
# at /console/, on one origin. The approval page's default relay is NEAR_RELAY_URL.
# Usage: scripts/build_site.sh   then deploy dist/styx-site to the Vercel project that serves styxco.xyz.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/styx-site"
rm -rf "$OUT"; mkdir -p "$OUT"
(cd "$ROOT/approval-page-near" && npm ci --silent && VITE_DEFAULT_RELAY="${NEAR_RELAY_URL:-https://styx-relay-near.fly.dev}" \
  npx vite build --base /approval/ --outDir "$OUT/approval" --emptyOutDir)
(cd "$ROOT/owner-console-near" && npm ci --silent && npx vite build --base /console/ --outDir "$OUT/console" --emptyOutDir)
# The landing page, shared stylesheet, fonts and logo live in site/ (the pages get the same assets via Vite publicDir).
cp "$ROOT/site/index.html" "$ROOT/site/styx.css" "$ROOT/site/landing.js" "$OUT/"
cp -R "$ROOT/site/public/." "$OUT/"
# The request ID is in the approval link, so it must not leak in a referrer. The pages must not be framed.
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
