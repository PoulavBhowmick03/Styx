"""Run every Python test. The examples run on their own because a test file there shares a name with one in tests."""
import subprocess

suites = (["mcp-server/tests", "sdk/py/tests"], ["mcp-server/examples"])
raise SystemExit(max(subprocess.run(["uv", "run", "pytest", *suite, "-q"]).returncode for suite in suites))
