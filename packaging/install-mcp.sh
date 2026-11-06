#!/usr/bin/env bash
# Install only from a supplied wheelhouse; fail rather than compile a source distribution.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'Usage: bash packaging/install-mcp.sh /absolute/path/to/wheelhouse' >&2
  exit 2
fi
WHEELS="$(cd "$1" && pwd)"
for name in erebus_cli erebus_sdk erebus_mcp_server; do
  compgen -G "$WHEELS/${name}-0.3.0-*.whl" >/dev/null || { echo "Missing wheel: $name" >&2; exit 2; }
done
CLI_WHEELS=( "$WHEELS"/erebus_cli-0.3.0-*.whl )
if [ "${#CLI_WHEELS[@]}" -ne 1 ]; then
  echo 'Use one platform wheelhouse per install.' >&2
  exit 2
fi
uv tool install --no-build --find-links "$WHEELS" \
  --with-executables-from erebus-cli \
  "$WHEELS/erebus_mcp_server-0.3.0-py3-none-any.whl" \
  --with "$WHEELS/erebus_sdk-0.3.0-py3-none-any.whl" \
  --with "${CLI_WHEELS[0]}"
