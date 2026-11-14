import json
import stat
import sys

import pytest

from styx_sentinels.marker import AttackMarker
from styx_sentinels.pauser import CliPauser, PauseFailed
from styx_sentinels.swarm import Swarm
from styx_sentinels.pauser import DryRunPauser

VAULT = "demo.styx-vaults.testnet"


def write(path, active, time, attack="drain-1", vault=VAULT):
    path.write_text(json.dumps({"attack_id": attack, "active": active, "time": time, "vault": vault}))


def test_marker_follows_an_attack_from_start_to_end(tmp_path):
    path = tmp_path / "sentinel-attack.json"
    m = AttackMarker(path, VAULT)
    assert m.check(100) is None  # no file
    write(path, True, 100)
    assert m.check(110) == (100, 110, "drain-1", False)
    assert m.check(130) == (100, 130, "drain-1", False)
    write(path, False, 140)
    assert m.check(150) == (100, 140, "drain-1", True)
    assert m.check(160) is None  # ended once


def test_marker_ignores_other_vaults_unseen_starts_and_expires_stale(tmp_path):
    path = tmp_path / "sentinel-attack.json"
    m = AttackMarker(path, VAULT, stale_seconds=60)
    write(path, True, 100, vault="other.testnet")
    assert m.check(110) is None
    write(path, False, 140, attack="drain-old")
    assert m.check(150) is None  # we never saw it start
    write(path, True, 200, attack="drain-2")
    assert m.check(300) == (200, 260, "drain-2", True)
    assert m.check(310) is None


def test_marking_the_same_attack_again_extends_it(tmp_path):
    swarm = Swarm(VAULT, tmp_path, DryRunPauser(), keygen=lambda n: (f"ed25519:{n}", "-"))
    swarm.mark_attack(100, 110, "drain-1")
    swarm.mark_attack(100, 130, "drain-1")
    swarm.mark_attack(100, 120, "drain-1")
    assert swarm.attack_windows == [(100, 130, "drain-1")]
    assert sum(1 for e in swarm.lineage() if e["action"] == "attack_marked") == 1


def fake_cli(tmp_path, reply):
    script = tmp_path / "fake-cli"
    script.write_text(f"""#!{sys.executable}
import json, os, sys
req = json.load(sys.stdin)
open({str(tmp_path / 'seen.json')!r}, 'w').write(json.dumps({{"req": req, "env": {{k: os.environ.get(k) for k in
    ("STYX_NEAR_VAULT", "STYX_NEAR_SENTINEL_KEY_FILE", "STYX_NEAR_STATE_ROOT", "STYX_NEAR_NETWORK")}}}}))
print(json.dumps({json.dumps(reply)!s}))
""")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return str(script)


def test_cli_pauser_sends_the_request_task_a_defined(tmp_path):
    pauser = CliPauser(fake_cli(tmp_path, {"status": "ok", "tx_hash": "abc"}), VAULT, str(tmp_path / "state"))
    assert pauser.pause("/keys/burst.json", "x" * 400) == "abc"
    seen = json.loads((tmp_path / "seen.json").read_text())
    assert seen["req"] == {"method": "sentinel_pause", "reason": "x" * 280}
    assert seen["env"] == {"STYX_NEAR_VAULT": VAULT, "STYX_NEAR_SENTINEL_KEY_FILE": "/keys/burst.json",
                           "STYX_NEAR_STATE_ROOT": str(tmp_path / "state"), "STYX_NEAR_NETWORK": "testnet"}


def test_cli_pauser_raises_on_a_refusal(tmp_path):
    pauser = CliPauser(fake_cli(tmp_path, {"status": "error", "code": "POLICY", "message": "NotSentinel"}), VAULT, "s")
    with pytest.raises(PauseFailed, match="NotSentinel"):
        pauser.pause("/k", "burst")


def test_reason_is_cut_to_280_bytes_on_a_character_boundary():
    from styx_sentinels.pauser import fit
    cut = fit("é" * 200)
    assert len(cut.encode()) <= 280 and cut == "é" * 140
