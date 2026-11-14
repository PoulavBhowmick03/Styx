import json
import stat

from styx_sentinels.events import Batch, Payment, PauseEvent
from styx_sentinels.judge import Judge
from styx_sentinels.keys import b58, new_key
from styx_sentinels.pauser import DryRunPauser
from styx_sentinels.swarm import Swarm

VAULT = "acme.styx-vaults.testnet"


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


def pay(i, t, amount=2_000_000, recipient="vendor-a.testnet"):
    return Payment(payment_id=f"p{i}", agent="ed25519:A", recipient=recipient, amount=amount, time=t, tx=f"T{i}", vault_daily_limit=50_000_000)


def swarm(tmp_path, clock, completer=None, kinds=(("burst", {"max_payments": 4, "window_seconds": 300}),)):
    keys = iter(range(100))
    s = Swarm(VAULT, tmp_path / "swarm", DryRunPauser(), keygen=lambda name: (f"ed25519:K{next(keys)}", f"/keys/{name}.json"),
              completer=completer, now=clock)
    for kind, params in kinds:
        s.spawn(kind, params)
    return s


def test_a_drain_is_paused_by_the_burst_sentinel_and_counts_as_a_catch_when_marked(tmp_path):
    clock = Clock()
    s = swarm(tmp_path, clock)
    for i in range(6):
        clock.t = 1000 + 20 * i
        out = s.cycle(Batch(payments=[pay(i, clock.t)]))
    assert s.paused and len(s.pauser.calls) == 1
    assert s.pauser.calls[0][1].startswith("[burst-g1] 5 payments in 5 min")
    s.mark_attack(1000, 1120, "drill: injected drain")
    m = s.members[0]
    assert (m.catches, m.false_alarms, m.score) == (1, 0, 1)
    assert [e["action"] for e in s.lineage()][:3] == ["spawn", "pause", "attack_marked"]


def test_false_alarms_retire_a_sentinel_and_respawn_it_with_a_higher_threshold_and_a_note(tmp_path):
    clock = Clock()
    s = swarm(tmp_path, clock)
    t = 1000
    for round_ in range(2):  # two busy-but-honest bursts, each unpaused by the owner
        for i in range(5):
            t += 10
            clock.t = t
            s.cycle(Batch(payments=[pay(f"{round_}-{i}", t)]))
        t += 30
        clock.t = t
        s.cycle(Batch(pauses=[PauseEvent("unpaused", t, f"U{round_}")]))
        t += 400
    old, new = s.members
    assert (old.status, old.false_alarms, old.score) == ("retired", 2, -4)
    assert (new.id, new.generation, new.params["max_payments"], new.status) == ("burst-g2", 2, 6, "active")
    assert "Raised the burst threshold to 6" in new.notes[0]
    actions = [a["action"] for a in s.owner_actions]
    assert actions == ["enable", "remove", "enable"] and "sentinel_remove=ed25519:K0" in s.owner_actions[1]["link"]
    assert [e["action"] for e in s.lineage()].count("retire") == 1


def test_state_survives_a_restart(tmp_path):
    clock = Clock()
    s = swarm(tmp_path, clock)
    s.cycle(Batch(payments=[pay(1, 1000)]))
    again = Swarm(VAULT, tmp_path / "swarm", DryRunPauser(), keygen=lambda n: ("k", "f"), now=clock)
    assert [m.id for m in again.members] == ["burst-g1"] and len(again.history) == 1
    state = json.loads((tmp_path / "swarm" / "state.json").read_text())
    assert state["members"][0]["score"] == 0 and state["vault"] == VAULT


def test_the_judge_pauses_on_the_model_answer_and_keeps_its_evidence(tmp_path):
    seen = {}

    def model(messages):
        seen["prompt"] = messages[-1]["content"]
        return 'sure: {"pause": true, "reason": "six 2-token payments to one new recipient in 2 minutes"}', {"model": "m", "signature": {"ok": True}}

    clock = Clock()
    s = swarm(tmp_path, clock, completer=model, kinds=(("judge", {"window": 20}),))
    s.cycle(Batch(payments=[pay(1, 1000)]))
    assert s.paused and "six 2-token payments" in s.pauser.calls[0][1]
    assert "2 to vendor-a.testnet" in seen["prompt"] and "Vault daily limit: 50" in seen["prompt"]


def test_a_judge_that_cannot_answer_stays_quiet():
    def broken(messages):
        raise RuntimeError("attestation did not verify")

    assert not Judge(complete=broken).judge([pay(1, 1000)], 1000, None).pause
    assert not Judge(complete=lambda m: ("not json", {})).judge([pay(1, 1000)], 1000, None).pause


def test_notes_from_the_parent_reach_the_judge_prompt():
    j = Judge(complete=lambda m: ('{"pause": false}', {}), notes=["Payroll on Fridays is normal."])
    assert "Payroll on Fridays is normal." in j.prompt([pay(1, 1000)], 1000, None)[-1]["content"]


def test_key_files_are_private_and_in_near_format(tmp_path):
    pk, path = new_key("burst-g1", VAULT, tmp_path / "keys")
    assert pk.startswith("ed25519:") and stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE((tmp_path / "keys").stat().st_mode) == 0o700
    data = json.loads(path.read_text())
    assert data["public_key"] == pk and data["account_id"] == VAULT and data["private_key"].startswith("ed25519:")
    assert b58(b"\0\x01") == "12"
