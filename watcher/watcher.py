#!/usr/bin/env python3
"""Read-only vault watcher. No wallet keys and no transaction submission."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class Unknown(RuntimeError):
    """The observation is unavailable; it is not evidence of non-payment."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the watcher bearer token to a redirected destination.


def post(url, body, token=None):
    # Arc's public RPC answers 403 to urllib's default agent.
    headers = {"Content-Type": "application/json", "User-Agent": "vault-watcher/0.1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with build_opener(NoRedirect()).open(request, timeout=15) as response:
            payload = response.read(4 * 1024 * 1024 + 1)
            if len(payload) > 4 * 1024 * 1024:
                raise Unknown("response exceeds size limit")
            return json.loads(payload)
    except (OSError, URLError, ValueError):
        raise Unknown("HTTP request unavailable") from None


def quantity(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)", value):
        raise Unknown("invalid RPC quantity")
    return int(value, 16)


def fixed(value, size):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{%d}" % (size * 2), value):
        raise Unknown("invalid RPC address or hash")
    return value.lower()


def http_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("use an HTTP(S) URL without embedded credentials")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("remote URLs must use HTTPS")
    return value


class Watcher:
    def __init__(self, rpc_url, relay_url, token, state_file, chain_id, vault, agent,
                 threshold, start_block, confirmations=2):
        self.rpc_url = http_url(rpc_url)
        self.relay_url = http_url(relay_url).rstrip("/")
        if not token:
            raise ValueError("WATCHER_TOKEN is required (separate from the agent token)")
        if min(chain_id, threshold) <= 0 or min(start_block, confirmations) < 0:
            raise ValueError("positive chain/threshold and nonnegative block/confirmations required")
        self.token = token
        self.path = Path(state_file)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.binding = dict(chain_id=chain_id, vault=fixed(vault, 20), agent=fixed(agent, 20),
                            threshold=str(threshold), start_block=start_block, confirmations=confirmations)
        self.lock_fd = os.open(str(self.path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.lock_fd)
            raise ValueError("another watcher owns this state file") from None
        try:
            if self.path.is_symlink():
                raise ValueError("state file must not be a symlink")
            if self.path.exists():
                self.state = json.loads(self.path.read_text())
                if self.state["version"] != 1 or self.state["binding"] != self.binding:
                    raise ValueError("state belongs to another watch configuration")
            else:
                self.state = dict(version=1, binding=self.binding, next_block=start_block,
                                  last_hash=None, pending={}, outbox={}, threshold_days=[])
                self.save()
        except Exception:
            self.close()
            raise

    def close(self):
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None

    def save(self):
        with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, delete=False) as output:
            temporary = output.name
            try:
                json.dump(self.state, output)
                output.flush()
                os.fsync(output.fileno())
            except Exception:
                os.unlink(temporary)
                raise
        os.replace(temporary, self.path)
        directory = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def rpc(self, method, params):
        response = post(self.rpc_url, dict(jsonrpc="2.0", id=1, method=method, params=params))
        if not isinstance(response, dict) or response.get("id") != 1 or "error" in response or "result" not in response:
            raise Unknown("RPC read unavailable")
        return response["result"]

    def rpc_batch(self, calls):
        """One HTTP request for many reads. Any missing or failed answer fails the whole batch."""
        replies = post(self.rpc_url, [dict(jsonrpc="2.0", id=index, method=method, params=params)
                                      for index, (method, params) in enumerate(calls)])
        if not isinstance(replies, list) or any(not isinstance(reply, dict) for reply in replies):
            raise Unknown("RPC batch unavailable")
        results = {reply.get("id"): reply for reply in replies if "error" not in reply and "result" in reply}
        if any(index not in results for index in range(len(calls))):
            raise Unknown("RPC batch unavailable")
        return [results[index]["result"] for index in range(len(calls))]

    def block(self, number, full=False):
        block = self.rpc("eth_getBlockByNumber", [hex(number), full])
        if not isinstance(block, dict) or quantity(block.get("number")) != number:
            raise Unknown("block unavailable")
        fixed(block.get("hash"), 32)
        return block

    def check_chain(self):
        if quantity(self.rpc("eth_chainId", [])) != self.binding["chain_id"]:
            raise Unknown("RPC serves a different chain")

    def flush(self):
        for identity, alert in list(self.state["outbox"].items()):
            try:
                response = post(self.relay_url + "/alerts", alert, self.token)
                if not isinstance(response, dict) or response.get("alerted") is not True:
                    continue  # Includes the relay's rate-limit and notifier-failure responses.
            except Unknown:
                continue
            del self.state["outbox"][identity]
            self.save()

    def resolve_receipts(self):
        for tx_hash, expected in list(self.state["pending"].items()):
            receipt = self.rpc("eth_getTransactionReceipt", [tx_hash])
            if receipt is None:
                continue
            if not isinstance(receipt, dict) or receipt.get("status") not in {"0x0", "0x1"}:
                continue  # Partial receipts remain unknown and are retried.
            if (fixed(receipt.get("transactionHash"), 32) != tx_hash or
                fixed(receipt.get("blockHash"), 32) != expected["hash"] or
                quantity(receipt.get("blockNumber")) != expected["number"] or
                fixed(receipt.get("from"), 20) != self.binding["agent"] or
                fixed(receipt.get("to"), 20) != self.binding["vault"]):
                raise Unknown("receipt does not match the watched transaction")
            if self.block(expected["number"])["hash"].lower() != expected["hash"]:
                raise Unknown("reorganization detected; operator review required")
            if receipt["status"] == "0x0":
                self.state["outbox"]["revert:" + tx_hash] = dict(kind="agent_revert", text=(
                    f"Chain {self.binding['chain_id']}: agent {self.binding['agent']} transaction {tx_hash} "
                    f"to vault {self.binding['vault']} reverted in block {expected['number']}."))
            del self.state["pending"][tx_hash]
            self.save()

    def scan(self, numbers):
        """Commits a run of blocks together, so a failed read leaves the cursor where it was."""
        replies = self.rpc_batch([("eth_getBlockByNumber", [hex(number), True]) for number in numbers])
        last_hash, pending, last_block_of_day = self.state["last_hash"], {}, {}
        for number, block in zip(numbers, replies):
            if not isinstance(block, dict) or quantity(block.get("number")) != number:
                raise Unknown("block unavailable")
            block_hash = fixed(block.get("hash"), 32)
            if last_hash and fixed(block.get("parentHash"), 32) != last_hash:
                raise Unknown("parent hash mismatch; operator review required")
            transactions = block.get("transactions")
            if not isinstance(transactions, list) or any(not isinstance(tx, dict) for tx in transactions):
                raise Unknown("full transaction list unavailable")
            for tx in transactions:
                if (isinstance(tx.get("to"), str) and tx["to"].lower() == self.binding["vault"] and
                    isinstance(tx.get("from"), str) and tx["from"].lower() == self.binding["agent"]):
                    pending[fixed(tx.get("hash"), 32)] = dict(number=number, hash=block_hash)
            last_block_of_day[quantity(block.get("timestamp")) // 86400] = number
            last_hash = block_hash
        # A day's spend only rises, so its last block in this run shows whether the threshold was passed.
        # Selector taken from the contract ABI: cast sig 'spentByDay(uint256)'.
        spent_by_day = {day: int(fixed(self.rpc("eth_call", [{"to": self.binding["vault"],
            "data": "0x" + SPENT_SELECTOR + f"{day:064x}"}, hex(number)]), 32), 16)
            for day, number in last_block_of_day.items()}
        if self.block(numbers[-1])["hash"].lower() != last_hash:
            raise Unknown("block changed while reading; retry required")
        self.state["pending"].update(pending)
        for day, spent in spent_by_day.items():
            if spent > int(self.binding["threshold"]) and day not in self.state["threshold_days"]:
                self.state["outbox"][f"daily:{day}"] = dict(kind="daily_spend", text=(
                    f"Chain {self.binding['chain_id']}: vault {self.binding['vault']} spent {spent} token base units "
                    f"on UTC day {day}, above threshold {self.binding['threshold']}; observed at block "
                    f"{last_block_of_day[day]}."))
                self.state["threshold_days"].append(day)
        self.state["next_block"] = numbers[-1] + 1
        self.state["last_hash"] = last_hash
        self.save()

    def tick(self, max_blocks=100):
        self.check_chain()
        # Recheck the cursor before delivering alerts derived from its history.
        cursor = self.state["next_block"]
        if self.state["last_hash"] and self.block(cursor - 1)["hash"].lower() != self.state["last_hash"]:
            raise Unknown("reorganization detected; operator review required")
        target = quantity(self.rpc("eth_blockNumber", [])) - self.binding["confirmations"]
        last = min(target + 1, cursor + max_blocks)
        for start in range(cursor, last, BLOCKS_PER_REQUEST):
            self.scan(range(start, min(start + BLOCKS_PER_REQUEST, last)))
        self.resolve_receipts()
        self.flush()


SPENT_SELECTOR = '224e86fe'
BLOCKS_PER_REQUEST = 25


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc", required=True)
    parser.add_argument("--relay", required=True)
    parser.add_argument("--chain-id", type=int, required=True)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--threshold", type=int, required=True, help="ERC-20 base units, strictly exceeded")
    parser.add_argument("--start-block", type=int, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--confirmations", type=int, default=2)
    parser.add_argument("--poll-seconds", type=float, default=5)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if args.poll_seconds <= 0:
        parser.error("poll-seconds must be positive")
    watcher = Watcher(args.rpc, args.relay, os.environ.get("WATCHER_TOKEN"), args.state, args.chain_id,
                      args.vault, args.agent, args.threshold, args.start_block, args.confirmations)
    try:
        while True:
            try:
                watcher.tick()
            except (Unknown, OSError) as error:
                print(f"watcher: unknown/unavailable ({error}); retaining state", file=sys.stderr)
                if args.once:
                    return 1
            if args.once:
                return 0
            time.sleep(args.poll_seconds)
    finally:
        watcher.close()


if __name__ == "__main__":
    raise SystemExit(main())
