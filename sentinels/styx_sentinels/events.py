"""The vault's events, read the way the owner console reads them: the indexer lists the vault's
transactions, and RPC confirms each one and returns its receipt logs (EVENT_JSON, standard styx)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

PAYMENT_EVENTS = {"payment_executed", "evm_payment_signed", "x402_authorization_signed"}
PAUSE_EVENTS = {"paused", "sentinel_paused", "unpaused"}


@dataclass(frozen=True)
class Payment:
    payment_id: str
    agent: str
    recipient: str
    amount: int  # token base units (6 decimals)
    time: float  # unix seconds of the block
    tx: str
    kind: str = "payment_executed"
    exception: bool = False
    chain_id: int | None = None
    vault_daily_limit: int | None = None
    vault_day_spent_after: int | None = None


@dataclass(frozen=True)
class PauseEvent:
    kind: str  # paused | sentinel_paused | unpaused
    time: float
    tx: str
    sentinel: str | None = None
    reason: str | None = None


@dataclass
class Batch:
    payments: list[Payment] = field(default_factory=list)
    pauses: list[PauseEvent] = field(default_factory=list)


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_events(tx: dict, vault: str, time: float) -> Batch:
    """Every styx event the vault logged in a successful receipt of this transaction."""
    out = Batch()
    tx_hash = tx.get("transaction", {}).get("hash", "")
    for receipt in tx.get("receipts_outcome", []):
        outcome = receipt.get("outcome", {})
        status = outcome.get("status", {})
        if outcome.get("executor_id") != vault or not ("SuccessValue" in status or "SuccessReceiptId" in status):
            continue
        for line in outcome.get("logs", []):
            if not isinstance(line, str) or not line.startswith("EVENT_JSON:"):
                continue
            try:
                log = json.loads(line[len("EVENT_JSON:"):])
            except ValueError:
                continue
            if log.get("standard") != "styx" or not isinstance(log.get("data"), list):
                continue
            name = log.get("event")
            for data in log["data"]:
                if not isinstance(data, dict):
                    continue
                if name in PAYMENT_EVENTS and isinstance(data.get("recipient"), str) and _int(data.get("amount")) is not None:
                    out.payments.append(Payment(
                        payment_id=str(data.get("payment_id", "")), agent=str(data.get("agent", "")),
                        recipient=data["recipient"].lower(), amount=_int(data["amount"]) or 0, time=time, tx=tx_hash,
                        kind=name, exception=bool(data.get("exception")), chain_id=_int(data.get("chain_id")),
                        vault_daily_limit=_int(data.get("vault_daily_limit")),
                        vault_day_spent_after=_int(data.get("vault_day_spent_after")),
                    ))
                elif name in PAUSE_EVENTS:
                    out.pauses.append(PauseEvent(
                        kind=name, time=time, tx=tx_hash,
                        sentinel=data.get("sentinel") if isinstance(data.get("sentinel"), str) else None,
                        reason=str(data["reason"])[:280] if isinstance(data.get("reason"), str) else None,
                    ))
    return out


class RPC:
    def __init__(self, url: str, post: Callable[..., Any] | None = None):
        import requests
        self.url = url
        self._post = post or (lambda url, **kw: requests.post(url, timeout=20, **kw))

    def call(self, method: str, params: dict) -> Any:
        reply = self._post(self.url, json={"jsonrpc": "2.0", "id": "styx-sentinels", "method": method, "params": params})
        data = reply.json()
        if "error" in data or "result" not in data:
            raise RuntimeError(f"RPC {method} failed")
        return data["result"]

    def view(self, account: str, method: str, args: dict | None = None) -> Any:
        import base64
        result = self.call("query", {"request_type": "call_function", "finality": "final", "account_id": account,
                                     "method_name": method, "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode()})
        return json.loads(bytes(result["result"]).decode())

    def access_keys(self, account: str) -> list[dict]:
        return self.call("query", {"request_type": "view_access_key_list", "finality": "final", "account_id": account})["keys"]

    def tx(self, tx_hash: str, sender: str) -> dict:
        return self.call("tx", {"tx_hash": tx_hash, "sender_account_id": sender, "wait_until": "FINAL"})

    def block_time(self, block_hash: str) -> float:
        header = self.call("block", {"block_id": block_hash})["header"]
        return int(header.get("timestamp_nanosec") or header["timestamp"]) / 1e9


class Watcher:
    """New vault events since the last call. The indexer only lists transactions; every event comes
    from a receipt confirmed through RPC, so the indexer cannot invent a payment or a pause."""

    def __init__(self, rpc: RPC, vault: str, network: str = "testnet", get: Callable[..., Any] | None = None,
                 post: Callable[..., Any] | None = None):
        import requests
        self.rpc, self.vault = rpc, vault
        self.host = "https://api-testnet.nearblocks.io" if network == "testnet" else "https://api.nearblocks.io"
        self.fastnear = "https://tx.test.fastnear.com" if network == "testnet" else "https://tx.main.fastnear.com"
        self._get = get or (lambda url: requests.get(url, timeout=15))
        self._post = post if post is not None else (None if get else (lambda url, body: requests.post(url, json=body, timeout=15)))
        self.seen: set[str] = set()
        self.signers: dict[str, str] = {}
        self.source = ""

    def listed(self) -> Iterable[tuple[str, str]]:
        """(tx hash, signer), newest first. FastNEAR's transaction API lists a transaction within a block
        or two; NearBlocks is the fallback. Either only names hashes: events come from RPC receipts."""
        if self._post:
            try:
                yield from self._fastnear()
                self.source = "fastnear"
                return
            except Exception:  # noqa: BLE001 (fall back to the other indexer)
                pass
        self.source = "nearblocks"
        data = self._get(f"{self.host}/v1/account/{self.vault}/txns?per_page=25").json()
        for t in data.get("txns", []):
            tx_hash = t.get("transaction_hash") or t.get("hash")
            sender = t.get("signer_account_id") or t.get("signer_id") or t.get("predecessor_account_id")
            if isinstance(tx_hash, str) and isinstance(sender, str):
                yield tx_hash, sender

    def _fastnear(self) -> list[tuple[str, str]]:
        reply = self._post(f"{self.fastnear}/v0/account", {"account_id": self.vault, "max_block_height": None})
        reply.raise_for_status()
        rows = [t for t in reply.json()["account_txs"] if isinstance(t.get("transaction_hash"), str)]
        rows.sort(key=lambda t: (t.get("tx_block_height", 0), t.get("tx_index", 0)), reverse=True)
        hashes = [t["transaction_hash"] for t in rows[:50]]
        unknown = [h for h in hashes if h not in self.seen and h not in self.signers]
        if unknown:
            got = self._post(f"{self.fastnear}/v0/transactions", {"tx_hashes": unknown[:20]})
            got.raise_for_status()
            for t in got.json().get("transactions", []):
                tx = t.get("transaction") or {}
                if isinstance(tx.get("hash"), str) and isinstance(tx.get("signer_id"), str):
                    self.signers[tx["hash"]] = tx["signer_id"]
        return [(h, self.signers[h]) for h in hashes if h in self.signers]

    def poll(self) -> Batch:
        out = Batch()
        for tx_hash, sender in reversed(list(self.listed())):  # oldest first
            if tx_hash in self.seen:
                continue
            try:
                tx = self.rpc.tx(tx_hash, sender)
                time = self.rpc.block_time(tx["transaction_outcome"]["block_hash"])
            except Exception:  # noqa: BLE001 (unconfirmed now; try again next poll)
                continue
            self.seen.add(tx_hash)
            batch = parse_events(tx, self.vault, time)
            out.payments += batch.payments
            out.pauses += batch.pauses
        out.payments.sort(key=lambda p: p.time)
        out.pauses.sort(key=lambda p: p.time)
        return out
