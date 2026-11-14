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
MAX_CATCH_UP = 200  # blocks one poll may read after a gap; the rest wait for the next poll


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
            self.next_height = height
        out.payments.sort(key=lambda p: p.time)
        out.pauses.sort(key=lambda p: p.time)
        return out
