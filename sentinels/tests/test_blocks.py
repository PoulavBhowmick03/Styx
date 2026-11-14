import json

import pytest

from styx_sentinels.blocks import BlockWatcher, vault_events

VAULT = "acme.styx-vaults.testnet"


def log(event, data):
    return "EVENT_JSON:" + json.dumps({"standard": "styx", "version": "1.0.0", "event": event, "data": [data]})


def block(height, outcomes=(), hash_=None):
    """A neardata block: outcomes is [(executor, logs, ok, tx_hash)] spread over one shard."""
    return {"block": {"header": {"height": height, "hash": hash_ or f"H{height}", "timestamp_nanosec": str(1_000_000_000_000 + height * 1_000_000_000)}},
            "shards": [{"receipt_execution_outcomes": [
                {"tx_hash": tx, "receipt": {}, "execution_outcome": {"outcome": {
                    "executor_id": ex, "logs": logs, "status": {"SuccessValue": ""} if ok else {"Failure": {}}}}}
                for ex, logs, ok, tx in outcomes]}]}


def payment(i):
    return (VAULT, [log("payment_executed", {"payment_id": f"p{i}", "agent": "ed25519:A", "recipient": "vendor-a.testnet", "amount": "1000000"})], True, f"T{i}")


class Reply:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


class Chain:
    """neardata and RPC over fixture blocks; `top` is the newest final height."""

    def __init__(self, blocks, top):
        self.blocks, self.top, self.fetched = blocks, top, []

    def get(self, url):
        if url.endswith("/v0/last_block/final"):
            return Reply(self.blocks[self.top])
        height = int(url.rsplit("/", 1)[1])
        self.fetched.append(height)
        return Reply(self.blocks.get(height))

    def call(self, method, params):
        assert method == "block"
        return {"header": {"hash": self.blocks[params["block_id"]]["block"]["header"]["hash"]}}


def watcher(chain, **kw):
    w = BlockWatcher(chain, VAULT, get=chain.get, **kw)
    return w


def test_reads_vault_events_from_successful_vault_receipts_only():
    b = block(5, [payment(1), ("evil.testnet", payment(2)[1], True, "T2"), (VAULT, payment(3)[1], False, "T3"),
                  (VAULT, [log("sentinel_paused", {"sentinel": "ed25519:S", "reason": "burst"})], True, "T4")])
    got = vault_events(b, VAULT)
    assert [(p.payment_id, p.tx, p.time) for p in got.payments] == [("p1", "T1", 1005.0)]
    assert [(e.kind, e.reason, e.tx) for e in got.pauses] == [("sentinel_paused", "burst", "T4")]


def test_starts_at_the_newest_block_and_sees_a_payment_in_the_block_it_lands():
    chain = Chain({10: block(10), 11: block(11, [payment(1)])}, top=10)
    w = watcher(chain)
    assert not w.poll().payments and w.next_height == 11
    chain.top = 11
    assert [p.payment_id for p in w.poll().payments] == ["p1"]
    assert not w.poll().payments  # the same block is not read twice


def test_reads_every_block_in_a_gap_and_skips_heights_with_no_block():
    chain = Chain({10: block(10), 11: block(11, [payment(1)]), 12: None, 13: block(13, [payment(2)]), 14: block(14)}, top=14)
    w = watcher(chain, start_height=11)
    assert [p.payment_id for p in w.poll().payments] == ["p1", "p2"]
    assert chain.fetched == [11, 12, 13]  # the newest block is not fetched twice


def test_a_block_whose_hash_does_not_match_rpc_is_ignored():
    forged = block(11, [payment(1)], hash_="FORGED")
    chain = Chain({11: forged, 12: block(12, [payment(2)])}, top=12)
    real = dict(chain.blocks)
    real[11] = block(11, [payment(1)], hash_="REAL")
    chain.call = lambda method, params: {"header": {"hash": real[params["block_id"]]["block"]["header"]["hash"]}}
    w = watcher(chain, start_height=11)
    assert [p.payment_id for p in w.poll().payments] == ["p2"]
    assert w.mismatches == 1


def test_a_network_error_on_the_check_retries_the_same_block():
    chain = Chain({11: block(11, [payment(1)])}, top=11)
    ok = chain.call
    chain.call = lambda *a: (_ for _ in ()).throw(RuntimeError("rpc down"))
    w = watcher(chain, start_height=11)
    with pytest.raises(RuntimeError):
        w.poll()
    assert w.next_height == 11
    chain.call = ok
    assert [p.payment_id for p in w.poll().payments] == ["p1"]


def test_one_poll_reads_a_bounded_number_of_blocks():
    chain = Chain({h: block(h) for h in range(1, 1000)}, top=999)
    w = watcher(chain, start_height=1)
    w.poll()
    assert w.next_height == 201
