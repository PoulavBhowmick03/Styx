import json
import threading
import urllib.request

from styx_sentinels import rehearsal
from styx_sentinels.cli import main
from styx_sentinels.pauser import DryRunPauser
from styx_sentinels.server import serve
from styx_sentinels.swarm import DEFAULT_SWARM, Swarm


def rehearsed(tmp_path):
    s = Swarm("rehearsal.testnet", tmp_path / "r", DryRunPauser(), keygen=lambda n: (f"ed25519:{n}", "-"))
    for kind, params in DEFAULT_SWARM[:2]:
        s.spawn(kind, params)
    captions = []
    rehearsal.run(s, sleep=lambda _: None, caption=captions.append)
    return s, captions


def test_the_rehearsal_tells_the_whole_lifecycle(tmp_path):
    s, captions = rehearsed(tmp_path)
    by_id = {m.id: m for m in s.members}
    # Generation 1 paused honest payroll, was unpaused (a false alarm), and was retired: its child is looser.
    assert (by_id["burst-g1"].status, by_id["burst-g1"].false_alarms) == ("retired", 1)
    g2 = by_id["burst-g2"]
    assert g2.params["max_payments"] == 6 and g2.mutation == {"max_payments": [4, 6]} and g2.parent == "burst-g1"
    assert "Raised the burst threshold to 6" in g2.notes[-1]
    # Two slow leaks went by unpaused: both active sentinels were charged two misses and retired; children are stricter.
    assert (g2.status, len(g2.misses)) == ("retired", 2)
    c1 = by_id["concentration-g1"]
    assert (c1.status, len(c1.misses), c1.score) == ("retired", 2, -2)
    c2 = by_id["concentration-g2"]
    assert c2.mutation == {"share": [0.4, 0.3]} and "Lowered the concentration share to 30%" in c2.notes[-1]
    g3 = by_id["burst-g3"]
    assert g3.mutation == {"max_payments": [6, 5]} and "Lowered the burst threshold to 5" in g3.notes[-1]
    # The newest burst generation caught the drain.
    assert (g3.status, g3.catches, g3.false_alarms, g3.score) == ("active", 1, 0, 1)
    assert s.paused and len(s.pauser.calls) == 2
    assert any("new generation learned" in c for c in captions)
    actions = [e["action"] for e in s.lineage()]
    assert actions.count("retire") == 3 and actions.count("missed") == 4 and actions.count("pause") == 2


def test_the_page_and_its_api(tmp_path):
    s, _ = rehearsed(tmp_path)
    lock = threading.Lock()
    server = serve(s, 0, lock, lambda: {"rehearsal": True})
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        page = urllib.request.urlopen(base + "/").read().decode()
        assert "<title>Styx: sentinels</title>" in page
        script = page.split('src="./assets/')[1].split('"')[0]
        assert "api/state" in urllib.request.urlopen(f"{base}/assets/{script}").read().decode()
        assert urllib.request.urlopen(base + "/fonts/geist.woff2").headers["Content-Type"] == "font/woff2"
        for bad in ("/../pyproject.toml", "/%2e%2e/swarm.py", "/.hidden", "/swarm.py"):
            try:
                urllib.request.urlopen(base + bad)
                assert False, bad
            except urllib.error.HTTPError as e:
                assert e.code == 404
        state = json.loads(urllib.request.urlopen(base + "/api/state").read())
        assert state["rehearsal"] and {m["id"] for m in state["members"]} >= {"burst-g1", "burst-g2"}
        assert any(e["action"] == "retire" for e in state["lineage"])
        g2 = next(m for m in state["members"] if m["id"] == "burst-g3")
        req = urllib.request.Request(base + "/api/label", data=json.dumps({"member": "burst-g3", "time": g2["pauses"][0]["time"], "outcome": "false_alarm"}).encode(), method="POST")
        assert json.loads(urllib.request.urlopen(req).read()) == {"ok": True}
        assert next(m for m in s.members if m.id == "burst-g3").false_alarms == 1
        bad = urllib.request.Request(base + "/api/label", data=b'{"member":"x"}', method="POST")
        try:
            urllib.request.urlopen(bad)
            assert False
        except urllib.error.HTTPError as e:
            assert e.code == 400
    finally:
        server.shutdown()


def test_init_spawns_the_swarm_with_private_keys_and_prints_the_enable_links(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("STYX_SENTINEL_HOME", str(tmp_path / "home"))
    assert main(["init", "--vault", "acme.styx-vaults.testnet", "--no-judge"]) == 0
    out = capsys.readouterr().out
    assert "burst-g1" in out and "concentration-g1" in out and "judge" not in out
    assert out.count("sentinel_enable=ed25519:") == 2
    keys = list((tmp_path / "home" / "keys" / "acme.styx-vaults.testnet").glob("*.json"))
    assert len(keys) == 2 and all((k.stat().st_mode & 0o777) == 0o600 for k in keys)
    assert main(["status", "--vault", "acme.styx-vaults.testnet"]) == 0


def test_the_page_serves_a_verdicts_full_evidence_and_nothing_outside_the_folder(tmp_path):
    import json as _json
    import threading
    import urllib.error
    import urllib.request
    from pathlib import Path
    from styx_sentinels.pauser import DryRunPauser
    from styx_sentinels.server import serve
    from styx_sentinels.swarm import Swarm

    s = Swarm("acme.styx-vaults.testnet", tmp_path / "swarm", DryRunPauser(), keygen=lambda n: ("ed25519:K", "/k"))
    (s.home / "evidence").mkdir()
    (s.home / "evidence" / "judge-g1-1.json").write_text('{"ok": true}')
    (s.home / "secret.json").write_text('{"no": true}')
    server = serve(s, 0, threading.Lock())
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        assert _json.loads(urllib.request.urlopen(base + "/api/evidence/judge-g1-1.json").read()) == {"ok": True}
        for bad in ("/api/evidence/..%2Fsecret.json", "/api/evidence/secret.json", "/api/evidence/../secret.json"):
            try:
                urllib.request.urlopen(base + bad)
                assert False, bad
            except urllib.error.HTTPError as e:
                assert e.code == 404
    finally:
        server.shutdown()


def test_quickstart_prints_one_link_waits_for_the_keys_then_starts_the_watch(tmp_path, monkeypatch, capsys):
    from styx_sentinels import cli
    monkeypatch.setenv("STYX_SENTINEL_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("NEARAI_API_KEY", raising=False)
    answers = iter([[], ["__burst__"], ["__burst__", "__conc__"]])
    started = []

    class FakeRPC:
        def __init__(self, url):
            pass

        def view(self, account, method, args=None):
            wanted = next(answers)
            keys = {m.id: m.public_key for m in swarm_of[0].members}
            return [keys["burst-g1"] if k == "__burst__" else keys["concentration-g1"] for k in wanted]

    swarm_of = []
    real_swarm = cli.Swarm

    def spy(*args, **kwargs):
        s = real_swarm(*args, **kwargs)
        swarm_of.append(s)
        return s

    real_main = cli.main
    monkeypatch.setattr(cli, "RPC", FakeRPC)
    monkeypatch.setattr(cli, "Swarm", spy)
    monkeypatch.setattr(cli.time, "sleep", lambda s: None)
    monkeypatch.setattr(cli, "main", lambda argv=None: started.append(argv) or 0 if argv and argv[0] == "run" else real_main(argv))
    assert real_main(["quickstart", "--vault", "acme.styx-vaults.testnet", "--cli", "/bin/cli", "--ui", "9999"]) == 0
    out = capsys.readouterr().out
    assert out.count("https://styxco.xyz/console/?vault=acme.styx-vaults.testnet") == 1  # one link, printed once
    assert "Waiting for the vault to show: burst-g1, concentration-g1" in out and "Waiting for the vault to show: concentration-g1" in out
    assert "judge" not in out  # no NEARAI_API_KEY: no judge sentinel
    assert started == [["run", "--vault", "acme.styx-vaults.testnet", "--network", "testnet", "--cli", "/bin/cli", "--ui", "9999"]]
    keys = list((tmp_path / "home" / "keys" / "acme.styx-vaults.testnet").glob("*.json"))
    assert len(keys) == 2 and all((k.stat().st_mode & 0o777) == 0o600 for k in keys)


def test_quickstart_gives_up_with_a_clear_message_when_nobody_signs(tmp_path, monkeypatch, capsys):
    from styx_sentinels import cli
    monkeypatch.setenv("STYX_SENTINEL_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(cli, "RPC", lambda url: type("R", (), {"view": lambda self, a, m, args=None: []})())
    monkeypatch.setattr(cli.time, "sleep", lambda s: None)
    assert cli.main(["quickstart", "--vault", "acme.styx-vaults.testnet", "--wait", "0"]) == 1
    assert "Timed out waiting for the owner" in capsys.readouterr().out


def test_names_exports_the_console_names_file_with_every_member_and_no_secret(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("STYX_SENTINEL_HOME", str(tmp_path / "home"))
    vault = "acme.styx-vaults.testnet"
    assert main(["names", "--vault", vault, "--out", str(tmp_path / "n.json")]) == 1  # no swarm yet
    assert main(["init", "--vault", vault, "--no-judge"]) == 0
    capsys.readouterr()
    assert main(["names", "--vault", vault, "--out", str(tmp_path / "n.json")]) == 0
    data = json.loads((tmp_path / "n.json").read_text())
    assert data["vault"] == vault and sorted(data["labels"].values()) == ["burst-g1", "concentration-g1"]
    assert all(k.startswith("ed25519:") for k in data["labels"])
    assert "secret" not in (tmp_path / "n.json").read_text().lower()
