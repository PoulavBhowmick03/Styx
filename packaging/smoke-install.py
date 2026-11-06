"""Install wheels in isolation and run real tools with Rust absent from PATH."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
wheels = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / "dist"
with tempfile.TemporaryDirectory(prefix="styx-install-") as directory:
    work = Path(directory)
    tools = work / "tools"
    tools.mkdir()
    (tools / "uv").symlink_to(shutil.which("uv"))
    env = dict(os.environ, PATH=f"{tools}:/usr/bin:/bin", UV_TOOL_DIR=str(work / "envs"), UV_TOOL_BIN_DIR=str(tools))
    assert shutil.which("cargo", path=env["PATH"]) is None
    assert shutil.which("rustc", path=env["PATH"]) is None
    subprocess.run(["/bin/bash", str(wheels / "install-mcp.sh"), str(wheels)], env=env, check=True)

    def run(name, request):
        output = subprocess.run([str(tools / name)], input=json.dumps(request), text=True,
                                capture_output=True, env=env, check=True)
        return json.loads(output.stdout)

    assert run("erebus-vault", {"method": "version"})["protocol"] == 1
    key = work / "reviewer.key"
    response = run("erebus-disclosure", {"method": "keygen", "key_file": str(key)})
    assert key.is_file(), response
    assert key.stat().st_mode & 0o077 == 0
    subprocess.run([str(tools / "erebus-mcp-server"), "--help"], env=env, check=True, capture_output=True)
    print("PASS: isolated wheel install, vault version, disclosure keygen, MCP entry point; no cargo/rustc on PATH")
