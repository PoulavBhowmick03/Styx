"""Wheel assembly only. Consumers never compile Rust or fetch executables at runtime."""
import os
import platform
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if version == "editable":
            # uv workspace development uses sdk/evm/target/debug or explicit CLI paths.
            return
        system, machine = platform.system(), platform.machine().lower()
        if system == "Darwin" and machine in {"arm64", "aarch64"}:
            tag = "macosx_11_0_arm64"
        elif system == "Darwin" and machine == "x86_64":
            tag = "macosx_10_15_x86_64"
        elif system == "Linux" and machine in {"x86_64", "aarch64"}:
            # Native Linux tag: no unverified manylinux compatibility claim.
            tag = f"linux_{machine}"
        else:
            raise RuntimeError(f"No wheel target defined for {system}/{machine}")
        source = os.environ.get("EREBUS_CLI_BIN_DIR")
        if not source:
            raise RuntimeError("Set EREBUS_CLI_BIN_DIR to the directory containing built native tools")
        scripts = {}
        for name in ("erebus-vault", "erebus-disclosure"):
            binary = Path(source).resolve() / name
            if not binary.is_file() or not os.access(binary, os.X_OK):
                raise RuntimeError(f"Missing executable: {name}")
            magic = binary.read_bytes()[:4]
            expected = {"Darwin": (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe"), "Linux": (b"\x7fELF",)}
            if magic not in expected[system]:
                raise RuntimeError(f"Not a native {system} executable: {name}")
            scripts[str(binary)] = name
        build_data["shared_scripts"] = scripts
        build_data["pure_python"] = False
        build_data["tag"] = f"py3-none-{tag}"
