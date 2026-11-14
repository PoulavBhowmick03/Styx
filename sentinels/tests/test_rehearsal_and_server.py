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
    # Generation 1 paused honest payroll, was unpaused (a false alarm), and was retired.
    assert (by_id["burst-g1"].status, by_id["burst-g1"].false_alarms) == ("retired", 1)
    # Generation 2 let the second payroll through, then caught the drain.
    g2 = by_id["burst-g2"]
    assert (g2.status, g2.catches, g2.false_alarms, g2.params["max_payments"]) == ("active", 1, 0, 6)
    assert "Raised the burst threshold to 6" in g2.notes[-1]
    assert s.paused and len(s.pauser.calls) == 2
    assert any("new generation learned" in c for c in captions)
    actions = [e["action"] for e in s.lineage()]
    assert actions.index("retire") < actions.index("attack_marked") and actions.count("pause") == 2


def test_the_page_and_its_api(tmp_path):
    s, _ = rehearsed(tmp_path)
    lock = threading.Lock()
    server = serve(s, 0, lock, lambda: {"rehearsal": True})
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        page = urllib.request.urlopen(base + "/").read().decode()
        assert "Styx Sentinels" in page and "/api/state" in page
        state = json.loads(urllib.request.urlopen(base + "/api/state").read())
        assert state["rehearsal"] and {m["id"] for m in state["members"]} >= {"burst-g1", "burst-g2"}
        assert any(e["action"] == "retire" for e in state["lineage"])
        g2 = next(m for m in state["members"] if m["id"] == "burst-g2")
        req = urllib.request.Request(base + "/api/label", data=json.dumps({"member": "burst-g2", "time": g2["pauses"][0]["time"], "outcome": "false_alarm"}).encode(), method="POST")
        assert json.loads(urllib.request.urlopen(req).read()) == {"ok": True}
        assert next(m for m in s.members if m.id == "burst-g2").false_alarms == 1
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
