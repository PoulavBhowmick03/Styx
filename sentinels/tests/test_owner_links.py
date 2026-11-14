from urllib.parse import parse_qsl, urlsplit

from styx_sentinels.pauser import DryRunPauser
from styx_sentinels.swarm import Swarm

VAULT = "demo.styx-vaults.testnet"


def swarm(tmp_path):
    n = iter(range(100))
    return Swarm(VAULT, tmp_path, DryRunPauser(), keygen=lambda name: (f"ed25519:K{next(n)}", f"/keys/{name}.json"))


def query(link):
    return parse_qsl(urlsplit(link).query)


def test_links_name_the_sentinel_and_one_link_signs_everything(tmp_path):
    s = swarm(tmp_path)
    s.spawn("burst", {"max_payments": 4, "window_seconds": 300})
    s.spawn("concentration", {"share": 0.4, "window_seconds": 3600})
    assert query(s.owner_actions[0]["link"]) == [("vault", VAULT), ("network", "testnet"), ("sentinel_enable", "ed25519:K0"), ("sentinel_label", "burst-g1")]
    assert query(s.sign_all_link())[2:] == [("sentinel_enable", "ed25519:K0"), ("sentinel_label", "burst-g1"),
                                           ("sentinel_enable", "ed25519:K1"), ("sentinel_label", "concentration-g1")]
    assert s.link([]).startswith("https://styxco.xyz/console/?vault=")


def test_sync_ticks_off_signed_changes_and_holds_uninstalled_sentinels(tmp_path):
    s = swarm(tmp_path)
    s.spawn("burst", {"max_payments": 1, "window_seconds": 300})
    s.spawn("concentration", {"share": 0.4, "window_seconds": 3600})
    s.sync_keys(["ed25519:K1"])
    assert [x["done"] if "done" in x else False for x in s.owner_actions] == [False, True]
    assert query(s.sign_all_link())[2:] == [("sentinel_enable", "ed25519:K0"), ("sentinel_label", "burst-g1")]
    assert any(e["action"] == "key_confirmed" for e in s.lineage())
    # burst would fire on two payments, but its key is not installed: it does not try.
    from styx_sentinels.events import Batch, Payment
    pays = [Payment(payment_id=f"p{i}", agent="ed25519:A", recipient="v.testnet", amount=1_000_000, time=s.now() - 10 + i, tx=f"t{i}", vault_daily_limit=100_000_000) for i in range(3)]
    out = s.cycle(Batch(payments=pays))
    assert [m for m, _ in out["fired"]] == [] and s.pauser.calls == []
    s.sync_keys(["ed25519:K0", "ed25519:K1"])
    assert s.sign_all_link() is None
    assert [m for m, _ in s.cycle(Batch())["fired"]] == ["burst-g1"]


def test_retiring_an_uninstalled_sentinel_cancels_its_enable(tmp_path):
    s = swarm(tmp_path)
    m = s.spawn("burst", {"max_payments": 4, "window_seconds": 300})
    from styx_sentinels.swarm import Pause
    m.pauses = [Pause(1.0, "noise", "t", "false_alarm")]
    s.review()
    enable = s.owner_actions[0]
    assert enable["cancelled"] and enable["done"]
    actions = [(k, v) for k, v in query(s.sign_all_link()) if k.startswith("sentinel_")]
    assert ("sentinel_remove", "ed25519:K0") in actions and ("sentinel_enable", "ed25519:K1") in actions
    assert ("sentinel_enable", "ed25519:K0") not in actions
