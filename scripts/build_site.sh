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
cat >"$OUT/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Styx on NEAR</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --bg: #fafaf8; --muted: #555; --line: #ddd; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #121212; --muted: #aaa; --line: #333; } }
  body { margin: 0; font: 16px/1.55 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 640px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 28px; margin: 0 0 8px; } p { color: var(--muted); }
  a.card { display: block; padding: 14px 16px; margin: 12px 0; border: 1px solid var(--line); border-radius: 8px; color: inherit; text-decoration: none; }
  a.card strong { display: block; }
</style>
<main>
  <h1>Styx</h1>
  <p>Contract-level spending caps and signed approvals for AI agents on NEAR. The agent is a function-call key on the vault, allowed only the pay methods; going over a limit needs the approver's NEP-413 signature over that exact payment. Through NEAR Chain Signatures the same vault pays USDC on Arc and Base under the same limits.</p>
  <a class="card" href="/approval/"><strong>Approval page</strong>Open an approval request from the agent and sign it in your NEAR wallet.</a>
  <a class="card" href="/console/"><strong>Owner console</strong>Read a vault from the chain and change its rules from the owner's wallet.</a>
  <a class="card" href="https://github.com/PoulavBhowmick03/Styx"><strong>Source and testnet record</strong>Contracts, agent tools, and every testnet transaction.</a>
</main>
</html>
HTML
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
