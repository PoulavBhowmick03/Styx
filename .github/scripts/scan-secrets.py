"""Scan the actual PR/push range without interpolating event text into shell code."""
import json
import os
import subprocess
import sys

with open(os.environ["GITHUB_EVENT_PATH"]) as source:
    event = json.load(source)
base = event.get("pull_request", {}).get("base", {}).get("sha") or event.get("before")
if not base or set(base) == {"0"}:
    # Manual runs and new branches scan all history rather than silently scanning nothing.
    options = "HEAD"
else:
    if len(base) != 40 or any(char not in "0123456789abcdef" for char in base):
        raise SystemExit("invalid base SHA")
    subprocess.run(["git", "cat-file", "-e", base], check=True)
    options = f"{base}..HEAD"
subprocess.run([sys.argv[1], "git", "--config", ".gitleaks.toml", "--redact", f"--log-opts={options}"], check=True)
