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
    assert (old.status, old.false_alarms, old.score) == ("retired", 1, -2)  # retired after one; the second burst passes
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


def test_after_the_owner_unpauses_the_same_payments_do_not_pause_again(tmp_path):
    clock = Clock()
    s = swarm(tmp_path, clock, kinds=(("burst", {"max_payments": 4, "window_seconds": 300}), ))
    for i in range(5):
        clock.t = 1000 + 10 * i
        s.cycle(Batch(payments=[pay(i, clock.t)]))
    assert s.paused and len(s.pauser.calls) == 1
    clock.t = 1060
    s.cycle(Batch(pauses=[PauseEvent("unpaused", 1060, "U")]))
    assert not s.paused and len(s.pauser.calls) == 1  # no instant re-pause on what the owner reviewed


EVIDENCE = {"model": "z-ai/test", "signature": {"verified": True, "signature_kind": "provider_tee", "signing_address": "0xabc",
                                                  "chat_id": "chat-1", "signature": "SIG"},
            "preflight": {"checks": ["gateway quote", "model quote"], "signers": ["ecdsa:abc:model"], "nonce": "N",
                          "tls": {"peer_spki_sha256": "ff", "same_connection": True}}}


def test_every_judge_verdict_keeps_a_summary_in_state_and_the_full_evidence_in_a_file(tmp_path):
    answers = iter(['{"pause": false, "reason": "normal traffic"}', '{"pause": true, "reason": "drain"}'])
    s = swarm(tmp_path, Clock(), completer=lambda m: (next(answers), EVIDENCE), kinds=(("judge", {"window": 20}),))
    s.cycle(Batch(payments=[pay(1, 1000)]))
    assert not s.paused
    s.cycle(Batch(payments=[pay(2, 1010)]))
    judge = s.members[0]
    assert [v["pause"] for v in judge.verdicts] == [False, True]
    v = judge.verdicts[-1]
    assert (v["model"], v["verified"], v["signature_kind"], v["chat_id"], v["attested_signers"], v["tls_bound"]) == \
        ("z-ai/test", True, "provider_tee", "chat-1", 1, True)
    assert v["checks"] == ["gateway quote", "model quote"]
    full = json.loads((s.home / "evidence" / v["file"]).read_text())
    assert full["evidence"]["signature"]["signature"] == "SIG" and full["pause"] is True
    pause = next(e for e in s.lineage() if e["action"] == "pause")
    assert (pause["model"], pause["verified"], pause["evidence_file"]) == ("z-ai/test", True, v["file"])
    assert "SIG" not in json.dumps(json.loads(s.state_file.read_text())["members"])  # state holds the summary only


def test_the_judge_asks_the_model_once_per_new_payment_not_once_per_poll():
    calls = []

    def model(messages):
        calls.append(1)
        return '{"pause": false, "reason": "fine"}', EVIDENCE

    j = Judge(complete=model)
    history = [pay(1, 1000)]
    j.judge(history, 1000, None)
    assert j.fresh
    j.judge(history, 1001, None)
    j.judge(history, 1002, None)
    assert len(calls) == 1 and not j.fresh
    j.judge(history + [pay(2, 1010)], 1010, None)
    assert len(calls) == 2 and j.fresh


def test_the_call_cap_stops_the_judge_from_spending_more_and_it_stays_quiet():
    from styx_sentinels.judge import CappedCompleter
    calls = []
    capped = CappedCompleter(lambda m: (calls.append(1) or '{"pause": false, "reason": "ok"}', EVIDENCE), limit=2)
    j = Judge(complete=capped)
    history = []
    for i in range(1, 5):
        history.append(pay(i, 1000 + i))
        assert not j.judge(history, 1010, None).pause
    assert len(calls) == 2 and capped.calls == 2  # payments 3 and 4 never reached the model
    assert not j.fresh


def test_a_slow_model_never_holds_up_the_rule_sentinels():
    import threading
    import time as _t
    gate = threading.Event()

    def slow(messages):
        gate.wait(5)
        return '{"pause": true, "reason": "drain"}', EVIDENCE

    j = Judge(complete=slow, background=True)
    history = [pay(1, 1000)]
    started = _t.monotonic()
    v = j.judge(history, 1000, None)
    assert _t.monotonic() - started < 0.5 and not v.pause and not j.fresh  # returned at once, still thinking
    assert not j.judge(history, 1001, None).pause  # still thinking: no second model call is started
    gate.set()
    j._worker.join(2)
    v = j.judge(history, 1002, None)
    assert v.pause and v.reason == "drain" and j.fresh  # the answer lands on the next poll
    assert j.judge(history, 1003, None).pause and not j.fresh  # same payments: reused, not asked again


def test_a_judge_that_fails_says_why_in_the_lineage_once(tmp_path):
    def broken(messages):
        raise RuntimeError("attestation did not verify: quote too old")

    s = swarm(tmp_path, Clock(), completer=broken, kinds=(("judge", {"window": 20}),))
    s.cycle(Batch(payments=[pay(1, 1000)]))
    s.cycle(Batch(payments=[pay(2, 1010)]))
    errors = [e for e in s.lineage() if e["action"] == "judge_error"]
    assert len(errors) == 1 and "quote too old" in errors[0]["error"]
    assert not s.paused


def test_a_pause_records_how_long_after_the_newest_payment_it_was_decided(tmp_path):
    clock = Clock(1000)
    s = swarm(tmp_path, clock)
    for i in range(5):
        clock.t = 1000 + 8 * i + 3  # the watcher sees each payment 3 s after its block
        s.cycle(Batch(payments=[pay(i, 1000 + 8 * i)]))
    pause = next(e for e in s.lineage() if e["action"] == "pause")
    assert (pause["decided_after_s"], pause["payments_seen"]) == (3.0, 5)


def test_a_model_reply_with_no_content_is_a_clear_error_not_a_crash():
    from styx_sentinels.judge import NearAICompleter

    class Client:
        def complete(self, body, preflight):
            assert body["max_tokens"] == 1200
            return {"choices": [{"message": {"content": None}, "finish_reason": "length"}]}, {}

    c = NearAICompleter.__new__(NearAICompleter)
    c.client, c.model, c.preflight = Client(), "m", object()
    try:
        c([{"role": "user", "content": "x"}])
        assert False
    except RuntimeError as e:
        assert "no answer (finish_reason length)" in str(e)


def test_the_consoles_verdicts_reach_the_parent_by_pause_transaction(tmp_path):
    clock = Clock(1000)
    s = swarm(tmp_path, clock)
    for i in range(5):
        clock.t = 1000 + 8 * i
        s.cycle(Batch(payments=[pay(i, 1000 + 8 * i)]))
    burst = s.members[0]
    tx = burst.pauses[0].tx
    file = json.dumps({"vault": VAULT, "pause_labels": [{"tx": tx, "outcome": "false_alarm"}, {"tx": "unknown", "outcome": "catch"},
                                                         {"tx": tx, "outcome": "nonsense"}]})
    assert s.import_pause_labels(file) == 1
    assert burst.pauses[0].outcome == "false_alarm" and burst.score == -2 and burst.status == "retired"
    assert s.import_pause_labels(file) == 0  # already applied
    import pytest
    with pytest.raises(ValueError):
        s.import_pause_labels(json.dumps({"vault": "other.testnet", "pause_labels": []}))
