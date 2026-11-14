#!/usr/bin/env bash
# Every test suite in the repo, in one command, offline: no keys, no wallet, no testnet account.
# Needs Rust (with the wasm32-unknown-unknown target and cargo-near for the sandbox tests), uv and
# Node 22+. The first run builds the contracts' wasm and installs packages, so it takes a while.
#
#   scripts/verify.sh            everything
#   scripts/verify.sh --quick    skip the NEAR sandbox and browser tests
#
# Prints one table: suite, result, test count. Exits non-zero if any suite fails.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QUICK=0; [ "${1:-}" = "--quick" ] && QUICK=1
LOG="$(mktemp -d)"; ROWS=(); FAILED=0
row() { ROWS+=("$(printf '%-44s %-6s %s' "$1" "$2" "$3")"); [ "$2" = "FAIL" ] && FAILED=1; return 0; }
need() { command -v "$1" >/dev/null || { echo "Missing $1: $2" >&2; exit 2; }; }
need cargo "install Rust from https://rustup.rs"
need uv "install from https://docs.astral.sh/uv/"
need npm "install Node 22+"

cargo_suite() { # name, dir, cargo args
  local name="$1" dir="$2"; shift 2; local log="$LOG/${name//[^A-Za-z0-9]/_}.log"
  if (cd "$ROOT/$dir" && cargo test "$@" >"$log" 2>&1); then
    row "$name" PASS "$(grep -E '^test result: ok' "$log" | awk '{s+=$4} END {print s+0}') tests"
  else row "$name" FAIL "see $log"; fi
}
node_suite() { # name, dir
  local name="$1" dir="$2"; local log="$LOG/${name//[^A-Za-z0-9]/_}.log"
  if (cd "$ROOT/$dir" && npm ci --silent >"$log" 2>&1 && npx vitest run >>"$log" 2>&1); then
    row "$name" PASS "$(grep -E 'Tests +[0-9]+ passed' "$log" | grep -oE '[0-9]+ passed' | head -1)"
  else row "$name" FAIL "see $log"; fi
}

echo "Running every suite; logs in $LOG"
if [ $QUICK = 1 ]; then
  cargo_suite "Vault contract (unit)" contracts/near/styx-vault --lib
else
  cargo_suite "Vault contract (unit, audit, NEAR sandbox)" contracts/near/styx-vault
  cargo_suite "Vault factory (unit, NEAR sandbox)" contracts/near/styx-factory
fi
cargo_suite "Agent CLI (sdk/near)" sdk/near
if (cd "$ROOT" && uv sync -q --all-packages >"$LOG/python.log" 2>&1 && uv run -q pytest -q >>"$LOG/python.log" 2>&1); then
  row "MCP server + Python SDK" PASS "$(grep -oE '[0-9]+ passed' "$LOG/python.log" | tail -1)"
else row "MCP server + Python SDK" FAIL "see $LOG/python.log"; fi
if (cd "$ROOT/sentinels" && uv run -q --with pytest pytest -q tests >"$LOG/sentinels.log" 2>&1); then
  row "Sentinels runner" PASS "$(grep -oE '[0-9]+ passed' "$LOG/sentinels.log" | tail -1)"
else row "Sentinels runner" FAIL "see $LOG/sentinels.log"; fi
rm -rf "$ROOT/sentinels/styx_sentinels.egg-info"
node_suite "Owner console" owner-console-near
node_suite "Sentinels swarm page" sentinels-ui
node_suite "Relay" relay-near
node_suite "Approval page" approval-page-near
if [ $QUICK = 0 ]; then
  CHROME="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
  if [ -x "$CHROME" ]; then
    if (cd "$ROOT/owner-console-near" && node --input-type=module -e '
      const {createServer}=await import("vite");const {execFile}=await import("node:child_process");const run=(await import("node:util")).promisify(execFile);
      const s=await createServer({root:process.cwd(),server:{port:5174,host:"127.0.0.1",strictPort:true},logLevel:"error"});await s.listen();
      let ok=0;for(const t of ["smoke","wallet-smoke","invite-smoke","sentinel-smoke"]){try{await run("node",[`test/${t}.mjs`],{env:{...process.env,CONSOLE_URL:"http://127.0.0.1:5174"}});ok++;}catch(e){console.log(t,"failed",String(e.stdout||e.stderr).slice(0,500));}}
      await s.close();console.log(`${ok} of 4 browser smokes passed`);process.exit(ok===4?0:1);' >"$LOG/smokes.log" 2>&1); then
      row "Owner console (browser smokes)" PASS "$(tail -1 "$LOG/smokes.log")"
    else row "Owner console (browser smokes)" FAIL "see $LOG/smokes.log"; fi
  else row "Owner console (browser smokes)" SKIP "set CHROME_PATH to run them"; fi
fi

echo
printf '%-44s %-6s %s\n' "Suite" "Result" "Count"
printf '%s\n' "${ROWS[@]}"
echo
echo "Next, with no wallet: uv run --project sentinels styx-sentinels rehearse  (a drain caught, a sentinel retired and bred, on 127.0.0.1:8790)"
exit $FAILED
