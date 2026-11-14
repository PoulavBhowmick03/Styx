"""Runs one plug-in call in its own process. Started by plugins.py as `python -I -B plugin_host.py`.

Reads one JSON request on stdin: {"source": "<the plug-in module's code>", "call": "judge" |
"mutate" | "defaults", ...}. It answers one JSON line on stdout. It never receives a key, a key path
or the swarm's home: only the payment list (public fields), the time, the daily limit, and the
plug-in's own params and notes. The parent applies the OS sandbox and the time limit; this file
imports nothing of the runner's.
"""
import json
import sys
import types


def main() -> None:
    request = json.loads(sys.stdin.read())
    module = types.ModuleType("styx_plugin")
    exec(compile(request["source"], "<plugin>", "exec"), module.__dict__)  # noqa: S102 (that is the point)
    call = request["call"]
    if call == "defaults":
        out = {"kind": str(module.KIND), "defaults": dict(module.DEFAULTS)}
    elif call == "mutate":
        params, note = module.mutate(dict(request["params"]), request["direction"])
        out = {"params": dict(params), "note": str(note)}
    elif call == "judge":
        sentinel = module.build(dict(request["params"]), list(request.get("notes", [])))
        verdict = sentinel.judge(request["history"], float(request["now"]), request.get("daily_limit"))
        out = {"pause": bool(verdict.get("pause")), "reason": str(verdict.get("reason", ""))[:280]}
    else:
        raise ValueError(call)
    sys.stdout.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
