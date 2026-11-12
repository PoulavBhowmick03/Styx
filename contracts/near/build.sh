#!/usr/bin/env bash
# Builds a NEAR contract crate to wasm and checks the result can name its refusals.
#
# near-sdk 5.30 calls the host's panic_utf8 only when compiled with `--cfg near`. cargo-near
# 0.17 and later append that flag; older versions do not, and every `require!` then surfaces
# as a bare "unreachable" wasm trap with no message. The import check below catches that.
#
# Usage: contracts/near/build.sh <crate-dir>   (prints the wasm path)
set -euo pipefail
dir="${1:?crate dir}"
cd "$dir"
cargo near build non-reproducible-wasm >&2
wasm="$(ls target/near/*.wasm)"
if command -v wasm-objdump >/dev/null; then
  # grep -c reads the whole stream; grep -q would close the pipe early and trip pipefail.
  imports="$(wasm-objdump -x "$wasm" 2>/dev/null | grep -c 'env.panic_utf8' || true)"
else
  # Without wabt, fall back to the cargo-near version: 0.17 and later pass --cfg near.
  minor="$(cargo near --version 2>/dev/null | sed -E 's/.* 0\.([0-9]+).*/\1/')"
  imports=$([ "${minor:-0}" -ge 17 ] && echo 1 || echo 0)
fi
if [ "$imports" = "0" ]; then
  echo "build.sh: $wasm does not import panic_utf8. Upgrade cargo-near (cargo install cargo-near --locked --force)." >&2
  exit 1
fi
echo "$wasm"
