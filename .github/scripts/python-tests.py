"""Run every Python test; tolerate only the explicitly documented missing-source failure."""
import os
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

report = Path("python-results.xml")
result = subprocess.run(["uv", "run", "pytest", "mcp-server/tests", "sdk/py/tests", f"--junitxml={report}"])
if not report.exists():
    raise SystemExit(result.returncode or 1)
root = ET.parse(report).getroot()
failures = [case for case in root.iter("testcase") if case.find("failure") is not None or case.find("error") is not None]
known = "test_every_mapped_message_exists_where_it_is_produced"
# Pytest classname formatting differs by root/import mode: require the exact source path suffix.
allowed = [case for case in failures if case.get("name") == known and
           (case.get("classname") or "").endswith("tests.test_metropolis_agent_flow") and
           not Path("sdk/shielded/src").exists()]
unexpected = [case for case in failures if case not in allowed]
summary = f"Python tests: {len(failures)} failures; {len(allowed)} documented missing-sdk/shielded/src failure; {len(unexpected)} unexpected.\n"
print(summary)
if allowed:
    print(f"::warning::{known} failed: sdk/shielded/src is absent. Test remains enabled; see python-results.xml.")
if os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as out:
        out.write(summary)
# Non-test errors, collection errors and interrupted runs must remain failures.
if result.returncode not in (0, 1) or unexpected or (result.returncode and not allowed) or list(root.iter("error")):
    raise SystemExit(result.returncode or 1)
