#!/usr/bin/env bash
# Maintainer build; Rust is needed here, never on the installer's machine.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
if [ "$(uname -m)" = x86_64 ]; then export MACOSX_DEPLOYMENT_TARGET=10.15; fi
cargo build --locked --release --manifest-path sdk/evm/Cargo.toml --bin erebus-vault --bin erebus-disclosure
export EREBUS_CLI_BIN_DIR="$ROOT/sdk/evm/target/release"
uv build --wheel --package erebus-cli --out-dir "$ROOT/dist"
uv build --wheel --package erebus-sdk --out-dir "$ROOT/dist"
uv build --wheel --package erebus-mcp-server --out-dir "$ROOT/dist"
cp packaging/install-mcp.sh dist/install-mcp.sh
cp packaging/README.md dist/README.md
python3 - <<'PY'
import hashlib
from pathlib import Path
root = Path('dist')
with (root / 'SHA256SUMS').open('w') as out:
    for wheel in sorted(root.glob('*.whl')):
        out.write(f'{hashlib.sha256(wheel.read_bytes()).hexdigest()}  {wheel.name}\n')
PY
