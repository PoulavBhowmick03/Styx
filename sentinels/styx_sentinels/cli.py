"""styx-sentinels: run a sentinel swarm on a Styx vault.

  styx-sentinels init     --vault V [--no-judge]           spawn the swarm, write keys, print enable links
  styx-sentinels quickstart --vault V [--cli PATH]         init, print the one link, wait for the keys, then run
  styx-sentinels run      --vault V --cli PATH [--dry-run] watch the vault block by block, pause it when a sentinel asks
  styx-sentinels rehearse                                  the whole lifecycle on simulated payments
  styx-sentinels status   --vault V                        members, scores, owner actions
  styx-sentinels names    --vault V [--out FILE]           a names file for the console's Import names
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

from .blocks import BlockWatcher, ResilientWatcher
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
    from .judge import CappedCompleter, NearAICompleter
    cap = int(os.environ.get("STYX_JUDGE_MAX_CALLS", "12"))
    print(f"The judge may ask the model at most {cap} times in this run (STYX_JUDGE_MAX_CALLS).")
    return CappedCompleter(NearAICompleter(os.environ.get("STYX_SENTINEL_MODEL", "z-ai/glm-5.3-flash")), cap)


def open_ui(swarm, port: int, lock, extra=None) -> None:
    from .server import serve
    serve(swarm, port, lock, extra)
    url = f"http://127.0.0.1:{port}/"
    print(f"Live swarm page: {url}")
    if os.environ.get("STYX_SENTINEL_NO_BROWSER") != "1":
        webbrowser.open(url)


def quickstart(a, swarm: Swarm, rpc_url: str, sleep=time.sleep) -> int:
    """One command: create the swarm's keys, print the one link that installs them, wait until the vault
    shows every key, then watch the vault and open the page."""
    for kind, params in DEFAULT_SWARM:
        if kind == "judge" and (a.no_judge or not os.environ.get("NEARAI_API_KEY")):
            continue
        if not any(m.kind == kind and m.status == "active" for m in swarm.members):
            swarm.spawn(kind, params)
    swarm.save()
    rpc = RPC(rpc_url)
    printed, last, deadline = False, None, time.time() + a.wait
    while True:
        try:
            keys = rpc.view(a.vault, "get_sentinels")
            swarm.sync_keys(keys if isinstance(keys, list) else [])
        except Exception as error:  # noqa: BLE001
            print(f"could not read get_sentinels yet: {error}")
            if time.time() > deadline:
                return 1
            sleep(3)
            continue
        waiting = [m for m in swarm.active() if m.public_key not in (swarm.installed or set())]
        if not waiting:
            break
        if not printed:
            print(f"\n{len(swarm.active())} sentinel keys were created in ~/.styx-near/sentinels/. Open this link as the vault owner "
                  f"and sign once; it installs all of them:\n\n  {swarm.sign_all_link()}\n")
            printed = True
        names = [m.id for m in waiting]
        if names != last:
            print(f"Waiting for the vault to show: {', '.join(names)}")
            last = names
        if time.time() > deadline:
            print("Timed out waiting for the owner. Run the same command again once the link is signed.")
            return 1
        sleep(3)
    print("Every sentinel key is on the vault. Starting the watch.")
    argv = ["run", "--vault", a.vault, "--network", a.network, "--cli", a.cli, "--ui", str(a.ui)]
    if a.rpc:
        argv += ["--rpc", a.rpc]
    return main(argv)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="styx-sentinels", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("init", "quickstart", "run", "status", "names", "label", "mark-attack"):
        s = sub.add_parser(name)
        s.add_argument("--vault", required=True)
        s.add_argument("--network", default="testnet", choices=["testnet", "mainnet"])
    for name in ("init", "quickstart"):
        sub.choices[name].add_argument("--no-judge", action="store_true")
    q = sub.choices["quickstart"]
    q.add_argument("--cli", default="styx-near-vault", help="the Styx agent CLI that signs sentinel_pause")
    q.add_argument("--rpc")
    q.add_argument("--ui", type=int, default=8790)
    q.add_argument("--wait", type=float, default=900.0, help="seconds to wait for the owner to sign the link")
    r = sub.choices["run"]
    r.add_argument("--cli", default="styx-near-vault", help="the Styx agent CLI that signs sentinel_pause")
    r.add_argument("--rpc")
    r.add_argument("--interval", type=float, help="seconds between polls (default 1.5 for txs, 1 for blocks)")
    r.add_argument("--source", choices=["txs", "blocks"], default="txs",
                   help="txs: FastNEAR's transaction list, confirmed over RPC (default); blocks: neardata block by block, "
                        "which rate-limits anonymous clients to a few requests a minute")
    r.add_argument("--dry-run", action="store_true", help="record pauses instead of sending them")
    r.add_argument("--ui", type=int, default=8790)
    r.add_argument("--attack-marker", help="drain_attack.sh's marker (default $STYX_NEAR_STATE_ROOT/sentinel-attack.json)")
    sub.choices["names"].add_argument("--out", help="where to write it (default: styx-names-<vault>.json here)")
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

    if a.cmd == "quickstart":
        return quickstart(a, swarm, rpc_url)
    if a.cmd == "names":
        if not swarm.members:
            print("This vault has no swarm yet; run `quickstart` or `init` first.")
            return 1
        out = Path(a.out or f"styx-names-{a.vault}.json")
        out.write_text(swarm.names_file())
        print(f"Wrote {len(swarm.members)} names to {out}. In the console, Sentinels panel: Import names.")
        return 0
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
    watcher = (ResilientWatcher(BlockWatcher(RPC(rpc_url), a.vault, a.network), Watcher(RPC(rpc_url), a.vault, a.network))
               if a.source == "blocks" else Watcher(RPC(rpc_url), a.vault, a.network))
    interval = a.interval or (1.0 if a.source == "blocks" else 1.5)
    swarm.judge_background = True
    open_ui(swarm, a.ui, lock, lambda: {"dry_run": isinstance(pauser, DryRunPauser), "source": getattr(watcher, "source", "")})
    marker_path = a.attack_marker or (Path(os.environ["STYX_NEAR_STATE_ROOT"]).expanduser() / "sentinel-attack.json"
                                      if os.environ.get("STYX_NEAR_STATE_ROOT") else None)
    marker = AttackMarker(Path(marker_path), a.vault) if marker_path else None
    if marker:
        print(f"Reading attack markers from {marker_path}")
    print(f"Watching {a.vault} every {interval:g}s ({a.source}). Ctrl+C to stop.")
    rpc = RPC(rpc_url)
    rounds = 0
    last_source = ""
    try:
        while True:
            try:
                batch = watcher.poll()
            except Exception as error:  # noqa: BLE001
                print(f"watch failed this round: {error}")
                batch = Batch()
            if not isinstance(pauser, DryRunPauser) and rounds % max(1, round(5 / interval)) == 0:
                try:
                    keys = rpc.view(a.vault, "get_sentinels")
                    with lock:
                        before = swarm.installed
                        swarm.sync_keys(keys if isinstance(keys, list) else [])
                    access = rpc.access_keys(a.vault)
                    with lock:
                        swarm.sync_allowances(access)
                    if before != swarm.installed:
                        waiting = [m.id for m in swarm.active() if m.public_key not in swarm.installed]
                        print(f"Sentinel keys on the vault: {len(swarm.installed)}." + (f" Waiting for the owner to install: {', '.join(waiting)}." if waiting else ""))
                except Exception as error:  # noqa: BLE001
                    print(f"could not read get_sentinels: {error}")
            rounds += 1
            source = getattr(watcher, "source", "")
            if source != last_source:
                print(f"Reading the chain through {source}.")
                last_source = source
            with lock:
                window = marker.check(time.time()) if marker else None
                if window:
                    swarm.mark_attack(*window)
                out = swarm.cycle(batch)
            for member, reason in out["fired"]:
                lag = next((e.get("decided_after_s") for e in reversed(swarm.lineage()) if e.get("action") == "pause"), None)
                print(f"PAUSED by {member}: {reason}" + (f" (decided {lag}s after the newest payment's block)" if lag is not None else ""))
            for old, new in out["replaced"]:
                print(f"retired {old}, spawned {new}")
            time.sleep(interval)
    except KeyboardInterrupt:
        return 0
