#!/usr/bin/env bash
# Builds styxco.xyz: a landing page at /, the NEAR approval page at /approval/ and the owner console
# at /console/, on one origin. The approval page's default relay is NEAR_RELAY_URL.
# With the settings scripts/near/try_setup.sh writes (VITE_TRY_VAULT, VITE_TRY_RECIPIENT and
# VITE_TRY_AGENT_KEY, a key published on purpose) in the environment, it also builds /try/.
# Usage: scripts/build_site.sh   then deploy dist/styx-site to the Vercel project that serves styxco.xyz.
# Vercel also runs it on every push to the connected repo (vercel.json at the repo root).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/styx-site"
rm -rf "$OUT"; mkdir -p "$OUT"
(cd "$ROOT/approval-page-near" && npm ci --silent && VITE_DEFAULT_RELAY="${NEAR_RELAY_URL:-https://styx-relay-near.fly.dev}" \
  npx vite build --base /approval/ --outDir "$OUT/approval" --emptyOutDir)
(cd "$ROOT/owner-console-near" && npm ci --silent && npx vite build --base /console/ --outDir "$OUT/console" --emptyOutDir)
if [ -n "${VITE_TRY_VAULT:-}" ] && [ -n "${VITE_TRY_RECIPIENT:-}" ] && [ -n "${VITE_TRY_AGENT_KEY:-}" ]; then
  (cd "$ROOT/try-page-near" && npm ci --silent && npx vite build --base /try/ --outDir "$OUT/try" --emptyOutDir)
elif [ -n "${VERCEL:-}" ]; then
  # On Vercel a build without /try/ would replace production with a site missing that page; fail instead,
  # which leaves the current deployment up. Set VITE_TRY_VAULT, VITE_TRY_RECIPIENT and VITE_TRY_AGENT_KEY
  # in the project's environment variables.
  echo "Missing VITE_TRY_* settings in the Vercel project: refusing to deploy a site without /try/." >&2; exit 1
else
  echo "Skipping /try/: load the settings from scripts/near/try_setup.sh to build it."
fi
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
