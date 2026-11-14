import json

from styx_sentinels.events import Payment, Watcher, parse_events
from styx_sentinels.rules import Burst, Concentration

VAULT = "acme.styx-vaults.testnet"


def log(event, data):
    return "EVENT_JSON:" + json.dumps({"standard": "styx", "version": "1.0.0", "event": event, "data": [data]})


def tx(hash_, logs, executor=VAULT, ok=True):
    return {"transaction": {"hash": hash_}, "transaction_outcome": {"block_hash": "B" + hash_},
            "receipts_outcome": [{"outcome": {"executor_id": executor, "logs": logs,
                                              "status": {"SuccessValue": ""} if ok else {"Failure": {}}}}]}


def pay(i, amount=2_000_000, recipient="vendor-a.testnet", t=None):
    return Payment(payment_id=f"p{i}", agent="ed25519:A", recipient=recipient, amount=amount,
                   time=1000 + 30 * i if t is None else t, tx=f"T{i}", vault_daily_limit=50_000_000)


def test_parses_payments_and_pauses_only_from_successful_vault_receipts():
    t = tx("H1", [log("payment_executed", {"payment_id": "p1", "agent": "ed25519:A", "recipient": "Vendor.testnet",
                                           "amount": "5000000", "vault_daily_limit": "500000000", "exception": True}),
                  log("sentinel_paused", {"sentinel": "ed25519:S", "reason": "burst"}),
                  "not an event", log("agent_configured", {"agent": "x"})])
    b = parse_events(t, VAULT, 123.0)
    assert [(p.recipient, p.amount, p.exception, p.vault_daily_limit) for p in b.payments] == [("vendor.testnet", 5_000_000, True, 500_000_000)]
    assert [(e.kind, e.sentinel, e.reason) for e in b.pauses] == [("sentinel_paused", "ed25519:S", "burst")]
    assert not parse_events(tx("H2", [log("payment_executed", {"recipient": "x", "amount": "1"})], ok=False), VAULT, 0).payments
    assert not parse_events(tx("H3", [log("payment_executed", {"recipient": "x", "amount": "1"})], executor="evil.testnet"), VAULT, 0).payments


def test_evm_and_x402_payments_count_too():
    b = parse_events(tx("H", [log("x402_authorization_signed", {"payment_id": "x", "agent": "a", "recipient": "0xAB", "amount": "10", "chain_id": 84532})]), VAULT, 1)
    assert (b.payments[0].kind, b.payments[0].recipient, b.payments[0].chain_id) == ("x402_authorization_signed", "0xab", 84532)


class FakeRPC:
    def __init__(self, txs):
        self.txs = txs

    def tx(self, h, sender):
        return self.txs[h]

    def block_time(self, block_hash):
        return {"BH1": 10.0, "BH2": 20.0}[block_hash]


class Reply:
    def __init__(self, data):
        self.data = data

    def json(self):
        return self.data


def test_watcher_returns_each_confirmed_event_once_oldest_first():
    txs = {"H1": tx("H1", [log("payment_executed", {"recipient": "a", "amount": "1"})]),
           "H2": tx("H2", [log("payment_executed", {"recipient": "b", "amount": "2"})])}
    listing = {"txns": [{"transaction_hash": "H2", "signer_account_id": VAULT}, {"transaction_hash": "H1", "signer_account_id": VAULT}]}
    w = Watcher(FakeRPC(txs), VAULT, get=lambda url: Reply(listing))
    first = w.poll()
    assert [p.recipient for p in first.payments] == ["a", "b"]
    assert w.poll().payments == []


def test_burst_pauses_a_fast_run_of_small_payments_and_ignores_a_normal_pace():
    drain = [pay(i) for i in range(6)]  # 6 payments, 30 s apart
    v = Burst(max_payments=4, window_seconds=300).judge(drain, now=drain[-1].time, daily_limit=None)
    assert v.pause and v.reason.startswith("6 payments in 5 min (12 total)")
    calm = [pay(i, t=1000 + 600 * i) for i in range(6)]  # one every 10 min
    assert not Burst(max_payments=4, window_seconds=300).judge(calm, now=calm[-1].time, daily_limit=None).pause


def test_concentration_pauses_one_recipient_taking_a_large_share():
    drain = [pay(i, amount=4_000_000) for i in range(6)]  # 24 of a 50 daily limit to one recipient
    v = Concentration(share=0.4, window_seconds=3600).judge(drain, now=drain[-1].time, daily_limit=None)
    assert v.pause and "vendor-a.testnet took 24 (48% of the 50 daily limit)" in v.reason
    spread = [pay(i, amount=4_000_000, recipient=f"v{i}.testnet") for i in range(6)]
    assert not Concentration(share=0.4).judge(spread, now=spread[-1].time, daily_limit=None).pause
