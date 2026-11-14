"""Watch the chain block by block through FastNEAR's neardata, so a payment is seen in the block it
lands in instead of on the next poll of a transaction list.

A block carries every receipt outcome of its shards, with the logs. A block that holds a vault event
is checked against RPC (the block at that height must have the same hash) before its events count, so
neardata cannot invent a payment or a pause for the vault: a block it altered would not match.
Blocks with no vault receipt need no check."""
from __future__ import annotations

from typing import Any, Callable

from .events import RPC, Batch, parse_logs, succeeded

NEARDATA = {"testnet": "https://testnet.neardata.xyz", "mainnet": "https://mainnet.neardata.xyz"}
MAX_CATCH_UP = 30  # blocks one poll may read after a gap; the rest wait for the next poll


class RateLimited(Exception):
    """neardata answered 429. retry_after is how long it asked us to wait, in seconds."""

    def __init__(self, retry_after: float = 5.0):
        super().__init__(f"neardata rate limit, retry after {retry_after:g}s")
        self.retry_after = retry_after


def vault_events(block: dict, vault: str) -> Batch:
    """The styx events the vault logged in this block's successful receipts."""
    out = Batch()
    header = block["block"]["header"]
    time = int(header["timestamp_nanosec"]) / 1e9
    for shard in block.get("shards", []):
        for item in shard.get("receipt_execution_outcomes", []):
            outcome = item.get("execution_outcome", {}).get("outcome", {})
            if outcome.get("executor_id") == vault and succeeded(outcome):
                parse_logs(outcome.get("logs", []), str(item.get("tx_hash", "")), time, out)
    return out


class BlockWatcher:
    """Same poll() as events.Watcher: new vault events since the last call, oldest first."""

    def __init__(self, rpc: RPC, vault: str, network: str = "testnet", get: Callable[..., Any] | None = None,
                 start_height: int | None = None):
        import requests
        self.rpc, self.vault = rpc, vault
        self.base = NEARDATA[network]
        self._get = get or (lambda url: requests.get(url, timeout=10))
        self.next_height = start_height  # None: begin at the newest final block
        self.source = "neardata"
        self.mismatches = 0
        self.last_height = 0

    def _json(self, url: str) -> Any:
        reply = self._get(url)
        if getattr(reply, "status_code", 200) == 429:
            try:
                wait = float((getattr(reply, "headers", None) or {}).get("Retry-After", 5))
            except (TypeError, ValueError):
                wait = 5.0
            raise RateLimited(wait)
        reply.raise_for_status()
        return reply.json()

    def newest(self) -> dict:
        return self._json(f"{self.base}/v0/last_block/final")

    def block(self, height: int) -> dict | None:
        """None for a height with no block (NEAR skips heights)."""
        return self._json(f"{self.base}/v0/block/{height}")

    def confirmed(self, block: dict) -> bool:
        header = block["block"]["header"]
        got = self.rpc.call("block", {"block_id": header["height"]})["header"]["hash"]
        return got == header["hash"]

    def poll(self) -> Batch:
        out = Batch()
        newest = self.newest()
        top = int(newest["block"]["header"]["height"])
        if self.next_height is None:
            self.next_height = top
        height = self.next_height
        read = 0
        while height <= top and read < MAX_CATCH_UP:
            block = newest if height == top else self.block(height)
            read += 1
            if block is not None:
                batch = vault_events(block, self.vault)
                if batch.payments or batch.pauses:
                    if not self.confirmed(block):  # raises on a network error: retry this height next poll
                        self.mismatches += 1
                        height += 1
                        continue
                    out.payments += batch.payments
                    out.pauses += batch.pauses
                self.last_height = height
            height += 1
        self.next_height = height  # only after the whole poll: an error mid-way re-reads these blocks
        out.payments.sort(key=lambda p: p.time)
        out.pauses.sort(key=lambda p: p.time)
        return out


class ResilientWatcher:
    """neardata first; when it fails or rate-limits, back off and read the vault's transaction list
    (events.Watcher) meanwhile, so a rate limit cannot blind the sentinels. The same event is never
    returned twice, whichever source saw it first. `source` says which one answered last."""

    def __init__(self, primary: BlockWatcher, fallback, clock: Callable[[], float] | None = None, fallback_every: float = 5.0):
        import time
        self.primary, self.fallback = primary, fallback
        self.clock = clock or time.monotonic
        self.fallback_every = fallback_every
        self.until = 0.0  # no neardata request before this time
        self.backoff = 0.0
        self.degraded = False
        self.last_fallback = float("-inf")
        self.source = "neardata"
        self.errors = 0
        self.seen: set[tuple] = set()

    def fresh(self, batch: Batch) -> Batch:
        out = Batch()
        for p in batch.payments:
            if ("p", p.tx, p.payment_id) not in self.seen:
                self.seen.add(("p", p.tx, p.payment_id))
                out.payments.append(p)
        for e in batch.pauses:
            if ("e", e.kind, e.tx, e.reason) not in self.seen:
                self.seen.add(("e", e.kind, e.tx, e.reason))
                out.pauses.append(e)
        return out

    def poll(self) -> Batch:
        now = self.clock()
        if now >= self.until:
            try:
                batch = self.primary.poll()
            except Exception as error:  # noqa: BLE001 (rate limit, network, a bad block: use the fallback)
                self.errors += 1
                self.degraded = True
                wait = error.retry_after if isinstance(error, RateLimited) else 0.0
                self.backoff = min(30.0, max(2.0, self.backoff * 2))
                self.until = now + max(self.backoff, wait)
            else:
                if self.degraded:
                    self.primary.next_height = None  # the transaction list covered the gap: resume at the tip
                    self.degraded = False
                self.backoff = 0.0
                self.source = "neardata"
                return self.fresh(batch)
        if now - self.last_fallback >= self.fallback_every:
            self.last_fallback = now
            self.source = "transactions"
            return self.fresh(self.fallback.poll())
        return Batch()
