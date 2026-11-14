"""styx-sentinels: run a sentinel swarm on a Styx vault.

  styx-sentinels init     --vault V [--no-judge]           spawn the swarm, write keys, print enable links
  styx-sentinels run      --vault V --cli PATH [--dry-run] watch the vault, pause it when a sentinel asks
  styx-sentinels rehearse                                  the whole lifecycle on simulated payments
  styx-sentinels status   --vault V                        members, scores, owner actions
  styx-sentinels label    --vault V MEMBER TIME catch|false_alarm
  styx-sentinels mark-attack --vault V START END [LABEL]

The swarm's state lives in ~/.styx-near/sentinels/<vault>/ (state.json, lineage.jsonl), keys in
~/.styx-near/sentinels/keys/<vault>/. --ui PORT serves the live page on 127.0.0.1.
"""
from __future__ import annotations

import argparse
import os
import threading
import time
import webbrowser
from pathlib import Path

from .events import RPC, Batch, Watcher
from .keys import new_key
from .marker import AttackMarker
from .pauser import CliPauser, DryRunPauser
from .swarm import DEFAULT_SWARM, Swarm

RPCS = {"testnet": "https://test.rpc.fastnear.com", "mainnet": "https://free.rpc.fastnear.com"}


def home(vault: str) -> Path:
    return Path(os.environ.get("STYX_SENTINEL_HOME", Path.home() / ".styx-near" / "sentinels")) / vault


def keygen_for(vault: str):
    directory = home(vault).parent / "keys" / vault
    return lambda name: new_key(f"{name}-{int(time.time())}", vault, directory)


def completer_or_none(enabled: bool):
    if not enabled:
        return None
    if not os.environ.get("NEARAI_API_KEY"):
        print("NEARAI_API_KEY is not set: the judge sentinel is skipped.")
        return None
    from .judge import NearAICompleter
    return NearAICompleter(os.environ.get("STYX_SENTINEL_MODEL", "z-ai/glm-5.3-flash"))


def open_ui(swarm, port: int, lock, extra=None) -> None:
    from .server import serve
    serve(swarm, port, lock, extra)
    url = f"http://127.0.0.1:{port}/"
    print(f"Live swarm page: {url}")
    if os.environ.get("STYX_SENTINEL_NO_BROWSER") != "1":
        webbrowser.open(url)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="styx-sentinels", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("init", "run", "status", "label", "mark-attack"):
        s = sub.add_parser(name)
        s.add_argument("--vault", required=True)
        s.add_argument("--network", default="testnet", choices=["testnet", "mainnet"])
    sub.choices["init"].add_argument("--no-judge", action="store_true")
    r = sub.choices["run"]
    r.add_argument("--cli", default="styx-near-vault", help="the Styx agent CLI that signs sentinel_pause")
    r.add_argument("--rpc")
    r.add_argument("--interval", type=float, default=8.0)
    r.add_argument("--dry-run", action="store_true", help="record pauses instead of sending them")
    r.add_argument("--ui", type=int, default=8790)
    r.add_argument("--attack-marker", help="drain_attack.sh's marker (default $STYX_NEAR_STATE_ROOT/sentinel-attack.json)")
    sub.choices["label"].add_argument("member")
    sub.choices["label"].add_argument("time", type=float)
    sub.choices["label"].add_argument("outcome", choices=["catch", "false_alarm"])
    sub.choices["mark-attack"].add_argument("start", type=float)
    sub.choices["mark-attack"].add_argument("end", type=float)
    sub.choices["mark-attack"].add_argument("label", nargs="?", default="marked by the owner")
    h = sub.add_parser("rehearse")
    h.add_argument("--ui", type=int, default=8790)
    h.add_argument("--speed", type=float, default=8.0)
    a = p.parse_args(argv)

    if a.cmd == "rehearse":
        import tempfile
        from . import rehearsal
        swarm = Swarm("rehearsal.styx-vaults.testnet", Path(tempfile.mkdtemp(prefix="styx-rehearsal-")), DryRunPauser(),
                      keygen=lambda name: (f"ed25519:rehearsal-{name}", "(no key: rehearsal)"),
                      now=lambda: rehearsal.START)  # spawns happen on the simulated clock too
        for kind, params in DEFAULT_SWARM[:2]:
            swarm.spawn(kind, params)
        swarm.save()
        lock = threading.Lock()
        captions: list[str] = []
        open_ui(swarm, a.ui, lock, lambda: {"rehearsal": True, "caption": captions[-1] if captions else ""})
        time.sleep(2)

        def say(text):
            if not captions or captions[-1] != text:
                print(text)
            captions.append(text)

        def step_sleep(seconds):
            time.sleep(max(0.2, seconds))

        with lock:
            pass
        rehearsal.run(swarm, step_sleep, a.speed, say)
        say("Rehearsal done. The page stays up; Ctrl+C to quit.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return 0

    rpc_url = getattr(a, "rpc", None) or RPCS[a.network]
    pauser = DryRunPauser() if getattr(a, "dry_run", False) or a.cmd != "run" else CliPauser(
        a.cli, a.vault, str(home(a.vault) / "cli-state"), rpc_url)
    swarm = Swarm(a.vault, home(a.vault), pauser, keygen=keygen_for(a.vault),
                  completer=completer_or_none(a.cmd == "run"), network=a.network)

    if a.cmd == "init":
        if swarm.members:
            print("This vault already has a swarm; see `status`.")
        for kind, params in DEFAULT_SWARM:
            if kind == "judge" and a.no_judge:
                continue
            if not any(m.kind == kind and m.status == "active" for m in swarm.members):
                swarm.spawn(kind, params)
        swarm.save()
    if a.cmd == "label":
        swarm.label(a.member, a.time, a.outcome)
    if a.cmd == "mark-attack":
        swarm.mark_attack(a.start, a.end, a.label)
    if a.cmd in ("init", "status", "label", "mark-attack"):
        for m in swarm.members:
            print(f"{m.id:18} {m.status:8} score {m.score:+d} ({m.catches} caught, {m.false_alarms} false)  {m.public_key}")
        pending = swarm.pending()
        if pending:
            print("\nThe owner signs these key changes in the console:")
            for x in pending:
                print(f"  {x['action']:7} {x['member']:18} {x['public_key']}")
            print(f"\nAll of them in one review and one approval:\n  {swarm.sign_all_link()}")
        return 0

    # run
    if swarm.completer is None and any(m.kind == "judge" for m in swarm.active()):
        print("The judge sentinel waits while NEARAI_API_KEY is unset; the rule sentinels watch.")
    lock = threading.Lock()
    open_ui(swarm, a.ui, lock, lambda: {"dry_run": isinstance(pauser, DryRunPauser)})
    watcher = Watcher(RPC(rpc_url), a.vault, a.network)
    marker_path = a.attack_marker or (Path(os.environ["STYX_NEAR_STATE_ROOT"]).expanduser() / "sentinel-attack.json"
                                      if os.environ.get("STYX_NEAR_STATE_ROOT") else None)
    marker = AttackMarker(Path(marker_path), a.vault) if marker_path else None
    if marker:
        print(f"Reading attack markers from {marker_path}")
    print(f"Watching {a.vault} every {a.interval:g}s. Ctrl+C to stop.")
    rpc = RPC(rpc_url)
    rounds = 0
    try:
        while True:
            try:
                batch = watcher.poll()
            except Exception as error:  # noqa: BLE001
                print(f"watch failed this round: {error}")
                batch = Batch()
            if not isinstance(pauser, DryRunPauser) and rounds % 5 == 0:
                try:
                    keys = rpc.view(a.vault, "get_sentinels")
                    with lock:
                        before = swarm.installed
                        swarm.sync_keys(keys if isinstance(keys, list) else [])
                    if before != swarm.installed:
                        waiting = [m.id for m in swarm.active() if m.public_key not in swarm.installed]
                        print(f"Sentinel keys on the vault: {len(swarm.installed)}." + (f" Waiting for the owner to install: {', '.join(waiting)}." if waiting else ""))
                except Exception as error:  # noqa: BLE001
                    print(f"could not read get_sentinels: {error}")
            rounds += 1
            with lock:
                window = marker.check(time.time()) if marker else None
                if window:
                    swarm.mark_attack(*window)
                out = swarm.cycle(batch)
            for member, reason in out["fired"]:
                print(f"PAUSED by {member}: {reason}")
            for old, new in out["replaced"]:
                print(f"retired {old}, spawned {new}")
            time.sleep(a.interval)
    except KeyboardInterrupt:
        return 0
