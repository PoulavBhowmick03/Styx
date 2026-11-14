import json
import sys
import time
from pathlib import Path

import pytest

from styx_sentinels import plugins
from styx_sentinels.cli import main
from styx_sentinels.events import Payment
from styx_sentinels.pauser import DryRunPauser
from styx_sentinels.swarm import Pause, Swarm

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "new_recipient.py"
VAULT = "demo.styx-vaults.testnet"


def register(tmp_path, monkeypatch, **modules):
    toml = "".join(f'[plugins.{kind}]\nmodule = "{path}"\n' for kind, path in modules.items())
    (tmp_path / "plugins.toml").write_text(toml)
    monkeypatch.setenv("STYX_SENTINEL_PLUGINS", str(tmp_path / "plugins.toml"))


def plugin(tmp_path, name, judge_body, kind=None):
    path = tmp_path / f"{name}.py"
    path.write_text(f'''KIND = "{kind or name}"
DEFAULTS = {{"n": 1}}
class S:
    def judge(self, history, now, daily_limit):
{judge_body}
def build(params, notes):
    return S()
def mutate(params, direction):
    return {{"n": params["n"] + 1}}, "more"
''')
    return path


def pay(i, recipient, t):
    return Payment(payment_id=f"p{i}", agent="ed25519:A", recipient=recipient, amount=1_000_000, time=t, tx=f"t{i}")


def test_the_example_pauses_a_new_recipient_taking_many_payments(tmp_path, monkeypatch):
    register(tmp_path, monkeypatch, new_recipient=EXAMPLE)
    assert plugins.defaults("new_recipient") == {"max_payments": 3, "window_seconds": 600}
    s = plugins.PluginSentinel("new_recipient", EXAMPLE, "new_recipient-g1", {"max_payments": 3, "window_seconds": 600}, [])
    old = [pay(i, "vendor.testnet", 100 + i) for i in range(5)]  # an old recipient, paid often long ago
    assert not s.judge(old + [pay(9, "vendor.testnet", 5000)], 5000, None).pause
    drain = [pay(20 + i, "fresh.testnet", 5000 + i) for i in range(4)]
    v = s.judge(old + drain, 5010, None)
    assert v.pause and "fresh.testnet" in v.reason and "over the 3 allowed" in v.reason and s.error is None


@pytest.mark.skipif(not plugins.sandboxed(), reason="the OS sandbox is macOS sandbox-exec")
def test_a_plugin_cannot_read_the_key_folder_or_see_the_environment(tmp_path, monkeypatch):
    keys = tmp_path / "keys"
    keys.mkdir()
    (keys / "burst.json").write_text("SECRET-KEY-MATERIAL")
    monkeypatch.setenv("STYX_SENTINEL_KEY_DIR", str(keys))
    monkeypatch.setenv("STYX_NEAR_SECRET_FOR_TEST", "ENV-SECRET")
    body = f'''        import os
        seen = []
        try:
            seen.append(open({str(keys / "burst.json")!r}).read())
        except Exception as e:
            seen.append("blocked:" + type(e).__name__)
        seen.append(",".join(k for k in os.environ if k.startswith("STYX")))
        try:
            open("/tmp/styx-plugin-write-test", "w").write("x")
            seen.append("wrote")
        except Exception:
            seen.append("no-write")
        return {{"pause": True, "reason": "|".join(seen)}}'''
    path = plugin(tmp_path, "snoop", body)
    v = plugins.PluginSentinel("snoop", path, "snoop-g1", {"n": 1}, []).judge([], 1.0, None)
    assert "SECRET-KEY-MATERIAL" not in v.reason and "ENV-SECRET" not in v.reason
    assert v.reason.startswith("blocked:") and v.reason.endswith("|no-write")
    assert "STYX" not in v.reason.split("|")[1]


def test_a_plugin_gets_only_public_payment_fields(tmp_path):
    path = plugin(tmp_path, "fields", '        return {"pause": True, "reason": ",".join(sorted(history[0]))}')
    v = plugins.PluginSentinel("fields", path, "fields-g1", {"n": 1}, []).judge([pay(1, "v.testnet", 1)], 2.0, None)
    assert v.reason == "agent,amount,exception,kind,recipient,time,tx"


def test_a_slow_plugin_times_out_quietly(tmp_path, monkeypatch):
    monkeypatch.setattr(plugins, "TIME_LIMIT", 1.0)
    path = plugin(tmp_path, "slow", "        while True:\n            pass")
    s = plugins.PluginSentinel("slow", path, "slow-g1", {"n": 1}, [])
    started = time.time()
    v = s.judge([], 1.0, None)
    assert not v.pause and "timed out" in s.error and time.time() - started < 5


def test_a_crashing_plugin_is_quiet_and_logged_by_the_swarm(tmp_path, monkeypatch):
    path = plugin(tmp_path, "crash", '        raise RuntimeError("boom")')
    register(tmp_path, monkeypatch, crash=path)
    swarm = Swarm(VAULT, tmp_path / "home", DryRunPauser(), keygen=lambda n: (f"ed25519:{n}", "-"))
    swarm.spawn("crash", {"n": 1})
    out = swarm.cycle(type("B", (), {"payments": [pay(1, "v.testnet", 1)], "pauses": []})())
    assert out["fired"] == [] and swarm.pauser.calls == []
    errors = [e for e in swarm.lineage() if e["action"] == "plugin_error"]
    assert len(errors) == 1 and "RuntimeError: boom" in errors[0]["error"]


def test_plugins_are_selected_like_built_ins(tmp_path, monkeypatch):
    register(tmp_path, monkeypatch, new_recipient=EXAMPLE)
    swarm = Swarm(VAULT, tmp_path / "home", DryRunPauser(), keygen=lambda n: (f"ed25519:{n}", "-"))
    m = swarm.spawn("new_recipient", {"max_payments": 3, "window_seconds": 600})
    m.pauses = [Pause(1.0, "payroll", "t", "false_alarm")]
    swarm.review()
    child = next(x for x in swarm.members if x.id == "new_recipient-g2")
    assert m.status == "retired" and child.params["max_payments"] == 5
    assert child.mutation == {"max_payments": [3, 5]} and "Raised the new-recipient threshold to 5" in child.notes[-1]
    child.misses = ["leak-1", "leak-2"]
    swarm.review()
    g3 = next(x for x in swarm.members if x.id == "new_recipient-g3")
    assert g3.params["max_payments"] == 4 and "Lowered" in g3.notes[-1]


def test_an_unregistered_plugin_waits(tmp_path, monkeypatch):
    register(tmp_path, monkeypatch)
    swarm = Swarm(VAULT, tmp_path / "home", DryRunPauser(), keygen=lambda n: (f"ed25519:{n}", "-"))
    swarm.spawn("gone", {"n": 1})
    assert swarm.cycle(type("B", (), {"payments": [pay(1, "v.testnet", 1)], "pauses": []})())["fired"] == []


def test_add_enables_a_plugin_per_vault(tmp_path, monkeypatch, capsys):
    register(tmp_path, monkeypatch, new_recipient=EXAMPLE)
    monkeypatch.setenv("STYX_SENTINEL_HOME", str(tmp_path / "sentinels"))
    assert main(["add", "--vault", VAULT, "--kind", "new_recipient"]) == 0
    out = capsys.readouterr().out
    assert "new_recipient-g1" in out and "sentinel_enable=ed25519:" in out
    state = json.loads((tmp_path / "sentinels" / VAULT / "state.json").read_text())
    assert state["members"][0]["params"] == {"max_payments": 3, "window_seconds": 600}
    assert main(["add", "--vault", VAULT, "--kind", "new_recipient"]) == 1  # one active per kind
    assert main(["add", "--vault", VAULT, "--kind", "nope"]) == 1
    assert sys.platform  # keys went to the vault's key folder under STYX_SENTINEL_HOME, not the repo
    assert not list(Path(__file__).resolve().parents[1].glob("**/new_recipient-g1-*.json"))
