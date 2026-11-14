"""Pluggable sentinels.

A plug-in is one Python module that exposes:
- KIND: its kind, a short lowercase name;
- DEFAULTS: its starting params;
- build(params, notes): an object with judge(history, now, daily_limit) -> {"pause": bool, "reason": str},
  where history is a list of payments as dicts (agent, recipient, amount, time, tx, kind, exception);
- mutate(params, direction): (params, note), direction "looser" after false alarms or "stricter" after
  misses, like adjust() in swarm.py.

Plug-ins are listed outside the repo, in ~/.styx-near/sentinels/plugins.toml (STYX_SENTINEL_PLUGINS
overrides):

    [plugins.new_recipient]
    module = "/path/to/new_recipient.py"

and enabled per vault with `styx-sentinels add --vault V --kind new_recipient`.

Isolation. The runner never imports a plug-in. Each call runs in a fresh `python -I -B` process
(plugin_host.py) that gets the module's source and the request on stdin and answers on stdout, with
a wall-clock time limit and CPU and memory limits. Its environment is empty, its working directory a
fresh empty folder. On macOS it also runs under sandbox-exec: no network, no file writes, and no
reads of ~/.styx-near, ~/.near-credentials, the key folder or the swarm's home. A crash, a timeout or
a bad answer is a quiet verdict and a lineage line; a failed mutation keeps the parent's params.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

from .rules import Verdict

HOST = Path(__file__).with_name("plugin_host.py")
TIME_LIMIT = float(os.environ.get("STYX_PLUGIN_TIME_LIMIT", "5"))
SANDBOX_EXEC = "/usr/bin/sandbox-exec"


class PluginError(Exception):
    pass


def plugins_file() -> Path:
    return Path(os.environ.get("STYX_SENTINEL_PLUGINS", Path.home() / ".styx-near" / "sentinels" / "plugins.toml"))


def registry() -> dict[str, Path]:
    """kind -> module path, from plugins.toml. A missing file means no plug-ins."""
    path = plugins_file()
    if not path.exists():
        return {}
    data = tomllib.loads(path.read_text())
    out = {}
    for kind, entry in (data.get("plugins") or {}).items():
        if isinstance(entry, dict) and isinstance(entry.get("module"), str) and kind.replace("_", "").isalnum():
            out[kind] = Path(entry["module"]).expanduser()
    return out


def private_paths() -> list[Path]:
    """What a plug-in must never read."""
    home = Path.home()
    paths = [home / ".styx-near", home / ".near-credentials"]
    for name in ("STYX_SENTINEL_KEY_DIR", "STYX_SENTINEL_HOME", "STYX_NEAR_STATE_ROOT"):
        if os.environ.get(name):
            paths.append(Path(os.environ[name]).expanduser())
    return [p.resolve() for p in paths]


def sandboxed() -> bool:
    return sys.platform == "darwin" and Path(SANDBOX_EXEC).exists()


def _profile(denied: list[Path]) -> str:
    quoted = " ".join(f'(subpath "{str(p)}")' for p in denied)
    return ("(version 1)(allow default)(deny network*)"
            "(deny file-write* (subpath \"/\"))(allow file-write* (literal \"/dev/null\"))"
            f"(deny file-read* {quoted})")


def _limits() -> None:  # runs in the child before exec
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (int(TIME_LIMIT) + 1, int(TIME_LIMIT) + 1))
    try:
        resource.setrlimit(resource.RLIMIT_AS, (512 * 2**20, 512 * 2**20))
    except (ValueError, OSError):
        pass  # macOS does not enforce RLIMIT_AS; the time limit still holds


def call(module: Path, request: dict, time_limit: float | None = None) -> dict:
    """One isolated call into a plug-in. Raises PluginError on a crash, a timeout or a bad answer."""
    try:
        source = module.read_text()
    except OSError as error:
        raise PluginError(f"cannot read the plug-in: {error}") from None
    payload = json.dumps({**request, "source": source})
    command = [sys.executable, "-I", "-B", str(HOST)]
    if sandboxed():
        command = [SANDBOX_EXEC, "-p", _profile(private_paths()), *command]
    workdir = tempfile.mkdtemp(prefix="styx-plugin-")
    try:
        done = subprocess.run(command, input=payload, capture_output=True, text=True, cwd=workdir,
                              env={"PATH": "/usr/bin:/bin", "HOME": workdir}, timeout=time_limit or TIME_LIMIT,
                              preexec_fn=_limits)
    except subprocess.TimeoutExpired:
        raise PluginError(f"timed out after {time_limit or TIME_LIMIT:g} s") from None
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    if done.returncode != 0:
        last = (done.stderr.strip().splitlines() or ["no output"])[-1]
        raise PluginError(f"crashed: {last[:200]}")
    try:
        return json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise PluginError("answered something that is not JSON") from None


def public(history) -> list[dict]:
    """The only payment fields a plug-in sees."""
    return [{"agent": p.agent, "recipient": p.recipient, "amount": p.amount, "time": p.time, "tx": p.tx,
             "kind": p.kind, "exception": p.exception} for p in history]


class PluginSentinel:
    """A sentinel whose judgement runs in an isolated plug-in process."""

    def __init__(self, kind: str, module: Path, name: str, params: dict, notes: list[str]):
        self.kind, self.module, self.name, self.params, self.notes = kind, module, name, params, notes
        self.error: str | None = None

    def judge(self, history, now: float, daily_limit: int | None) -> Verdict:
        try:
            out = call(self.module, {"call": "judge", "params": self.params, "notes": self.notes,
                                     "history": public(history), "now": now, "daily_limit": daily_limit})
            if not isinstance(out.get("pause"), bool):
                raise PluginError("answered without a pause decision")
        except PluginError as error:
            self.error = str(error)
            return Verdict(False)
        self.error = None
        return Verdict(out["pause"], out.get("reason", "") or f"{self.kind} asked to pause", {"plugin": self.kind})


def defaults(kind: str) -> dict:
    module = registry().get(kind) or _missing(kind)
    out = call(module, {"call": "defaults"})
    if out.get("kind") != kind:
        raise PluginError(f"the module's KIND is {out.get('kind')!r}, not {kind!r}")
    return out["defaults"]


def mutate(kind: str, params: dict, direction: str) -> tuple[dict, str]:
    module = registry().get(kind) or _missing(kind)
    out = call(module, {"call": "mutate", "params": params, "direction": direction})
    if not isinstance(out.get("params"), dict):
        raise PluginError("mutate returned no params")
    return out["params"], out.get("note", "")


def _missing(kind: str):
    raise PluginError(f"no plug-in named {kind!r} in {plugins_file()}")
