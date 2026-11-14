import json
import stat
import urllib.error
import urllib.request

import pytest

from styx_sentinels.events import Batch, Payment
from styx_sentinels.pauser import DryRunPauser
from styx_sentinels.service import Refused, Service, serve

V3 = "acme.styx-vaults.testnet"


class FakeRPC:
    def __init__(self):
        self.vaults = {V3: {"contract_version": 3}, "old.styx-vaults.testnet": {"contract_version": 2}}
        self.sentinels: dict[str, list[str]] = {}

    def view(self, account, method, args=None):
        if method == "get_vault":
            if account not in self.vaults:
                raise RuntimeError("RPC query failed")
            return self.vaults[account]
        if method == "get_sentinels":
            return self.sentinels.get(account, [])
        raise AssertionError(method)


class Feed:
    def __init__(self):
        self.batches = []

    def poll(self):
        return self.batches.pop(0) if self.batches else Batch()


def service(tmp_path, cap=20, rpc=None):
    feeds, pausers = {}, {}

    def pauser_for(vault, home):
        return pausers.setdefault(vault, DryRunPauser())

    def watcher_for(vault):
        return feeds.setdefault(vault, Feed())

    clock = {"t": 1000.0}
    s = Service(tmp_path / "root", rpc or FakeRPC(), pauser_for, watcher_for, cap=cap, now=lambda: clock["t"])
    return s, feeds, pausers, clock


def test_registering_a_v3_vault_makes_its_keys_and_answers_with_one_link_and_public_keys_only(tmp_path):
    s, *_ = service(tmp_path)
    got = s.register(V3)
    assert [m["id"] for m in got["members"]] == ["burst-g1", "concentration-g1"]  # no judge: it needs the owner's NEAR AI key
    assert got["link"].startswith("https://styxco.xyz/console/?vault=acme.styx-vaults.testnet&network=testnet")
    assert got["link"].count("sentinel_enable=ed25519:") == 2
    assert "private" not in json.dumps(got)
    keys = list((tmp_path / "root" / "keys" / V3).glob("*.json"))
    assert len(keys) == 2 and all(stat.S_IMODE(k.stat().st_mode) == 0o600 for k in keys)
    assert s.register(V3)["link"] == got["link"]  # registering again changes nothing


@pytest.mark.parametrize("vault, status", [
    ("Not an account!", 400), ("acme.near", 400), ("missing.styx-vaults.testnet", 422), ("old.styx-vaults.testnet", 422), (None, 400)])
def test_it_refuses_anything_but_a_version_3_vault_on_its_network(tmp_path, vault, status):
    s, *_ = service(tmp_path)
    with pytest.raises(Refused) as e:
        s.register(vault)
    assert e.value.status == status
    assert not s.swarms


def test_the_cap_holds(tmp_path):
    rpc = FakeRPC()
    rpc.vaults["b.styx-vaults.testnet"] = {"contract_version": 3}
    s, *_ = service(tmp_path, cap=1, rpc=rpc)
    s.register(V3)
    with pytest.raises(Refused) as e:
        s.register("b.styx-vaults.testnet")
    assert e.value.status == 429


def test_a_registered_vault_is_watched_and_paused_only_once_its_keys_are_installed(tmp_path):
    rpc = FakeRPC()
    s, feeds, pausers, clock = service(tmp_path, rpc=rpc)
    s.register(V3)
    drain = [Payment(payment_id=f"p{i}", agent="a", recipient="v.testnet", amount=1_000_000, time=1000 + 8 * i, tx=f"T{i}") for i in range(6)]
    s.tick()  # creates the watcher; keys not installed yet
    feeds[V3].batches.append(Batch(payments=drain))
    clock["t"] = 1050
    assert s.tick() == [] and not pausers[V3].calls  # no key on the vault: no pause
    assert s.state(V3)["members"][0]["installed"] is False
    rpc.sentinels[V3] = [m["public_key"] for m in s.state(V3)["members"]]
    s.ticks = 10  # the next round syncs keys
    fired = s.tick()
    assert fired and fired[0][:2] == (V3, "burst-g1") and len(pausers[V3].calls) == 1
    st = s.state(V3)
    assert st["paused"] and st["link"] is None and all(m["installed"] for m in st["members"])


def test_registrations_survive_a_restart(tmp_path):
    s, *_ = service(tmp_path)
    link = s.register(V3)["link"]
    again, *_ = service(tmp_path)
    assert list(again.swarms) == [V3] and again.state(V3)["link"] == link


def test_the_http_api(tmp_path):
    s, *_ = service(tmp_path)
    server = serve(s, "127.0.0.1", 0, ["https://styxco.xyz"])
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def call(path, body=None, origin="https://styxco.xyz"):
        req = urllib.request.Request(base + path, data=None if body is None else body, method="POST" if body is not None else "GET",
                                     headers={"Origin": origin, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read()), r.headers.get("Access-Control-Allow-Origin")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read()), e.headers.get("Access-Control-Allow-Origin")

    try:
        assert call("/api/health")[:2] == (200, {"vaults": 0, "cap": 20, "network": "testnet"})
        code, body, cors = call("/api/vaults", json.dumps({"vault": V3}).encode())
        assert code == 200 and body["vault"] == V3 and cors == "https://styxco.xyz"
        assert call("/api/vaults/" + V3)[1]["members"][0]["id"] == "burst-g1"
        assert call("/api/vaults/other.styx-vaults.testnet")[0] == 404
        assert call("/api/vaults", b"not json")[0] == 400
        assert call("/api/vaults", json.dumps({"vault": "old.styx-vaults.testnet"}).encode())[0] == 422
        assert call("/api/vaults", b"x" * 2000)[0] == 413
        assert call("/api/health", origin="https://evil.example")[2] is None  # other pages get no CORS grant
    finally:
        server.shutdown()
