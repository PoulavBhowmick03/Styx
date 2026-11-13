#!/usr/bin/env bash
# Prints the one command that gives Claude Code the Styx payment tools for your vault.
#
#   scripts/near/mcp_config.sh [path/to/demo.env]
#
# Uses the newest ~/.styx-near-quickstart/<account>/demo.env unless given one. A demo.env names
# STYX_NEAR_VAULT, STYX_NEAR_AGENT_KEY_FILE, STYX_NEAR_STATE_ROOT and STYX_NEAR_APPROVER; for a vault
# made in the console, write those four lines yourself, with the agent key file the console downloaded.
# Creates a private invoices folder next to it (the MCP tools read invoices only from there), installs
# the Python workspace and builds the agent CLI. Prints the command; it changes no Claude settings.
# Approvals go out through a relay only if you add STYX_VAULT_RELAY_URL and STYX_VAULT_RELAY_TOKEN
# (for example a local relay, as mcp_quickstart.sh starts); without them the approver signs the
# pending file the tools write.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="${1:-$(ls -t "$HOME"/.styx-near-quickstart/*/demo.env 2>/dev/null | head -1)}"
[ -n "$ENVFILE" ] && [ -f "$ENVFILE" ] || { echo "No demo.env: run scripts/near/quickstart.sh first, or pass one." >&2; exit 1; }
set -a; . "$ENVFILE"; set +a
: "${STYX_NEAR_VAULT:?}" "${STYX_NEAR_AGENT_KEY_FILE:?}" "${STYX_NEAR_STATE_ROOT:?}" "${STYX_NEAR_APPROVER:?}"
INVOICES="$(dirname "$ENVFILE")/invoices"
mkdir -p "$INVOICES" && chmod 700 "$INVOICES"
(cd "$ROOT" && uv sync -q --all-packages) >&2
cargo build -q --release --manifest-path "$ROOT/sdk/near/Cargo.toml" >&2
q() { printf "%q" "$1"; }
cat <<EOF
# Gives Claude Code the Styx payment tools for $STYX_NEAR_VAULT. Put invoices in $INVOICES.
claude mcp add styx-vault \\
  -e STYX_BACKEND=vault \\
  -e STYX_VAULT_DIR=$(q "$INVOICES") \\
  -e STYX_VAULT_CLI=$(q "$ROOT/sdk/near/target/release/styx-near-vault") \\
  -e STYX_NEAR_VAULT=$(q "$STYX_NEAR_VAULT") \\
  -e STYX_NEAR_AGENT_KEY_FILE=$(q "$STYX_NEAR_AGENT_KEY_FILE") \\
  -e STYX_NEAR_STATE_ROOT=$(q "$STYX_NEAR_STATE_ROOT") \\
  -e STYX_NEAR_APPROVER=$(q "$STYX_NEAR_APPROVER") \\
  -- $(q "$ROOT/.venv/bin/python") -m styx_mcp.server
EOF
