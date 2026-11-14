"""Sentinels as a service: one process watches many vaults, each with its own swarm.

An owner registers a version 3 vault; the service makes that vault's sentinel keys and answers with
the one console link that installs them. Until the owner signs it, nothing can pause the vault: the
service only holds keys, and NEAR lets each one call `sentinel_pause` on that vault and nothing else.
So running sentinels for someone else asks them to trust the service with a pause, not with money.

HTTP API (JSON):
  POST /api/vaults {"vault": "<account>"}  register; answers {vault, link, members}
  GET  /api/vaults/<account>               that vault's swarm: members, keys installed, pending link
  GET  /api/health                         {"vaults": n, "cap": cap}

State and keys live under the service's root (outside any repo): <root>/<vault>/ and
<root>/keys/<vault>/ (key files 0600). Responses carry public keys only.
"""
from __future__ import annotations

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from .keys import new_key
from .swarm import DEFAULT_SWARM, Swarm

ACCOUNT = re.compile(r"^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$")
SENTINEL_VERSION = 3
MAX_BODY = 1024


class Refused(Exception):
    """A registration the service will not take: (HTTP status, reason in words)."""

    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status, self.reason = status, reason


class Service:
    def __init__(self, root: Path, rpc, pauser_for: Callable[[str, Path], Any], watcher_for: Callable[[str], Any],
                 network: str = "testnet", cap: int = 20, console_url: str = "https://styxco.xyz/console/",
                 now: Callable[[], float] = time.time):
        self.root, self.rpc, self.pauser_for, self.watcher_for = root, rpc, pauser_for, watcher_for
        self.network, self.cap, self.console_url, self.now = network, cap, console_url, now
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.Lock()
        self.swarms: dict[str, Swarm] = {}
        self.watchers: dict[str, Any] = {}
        self.ticks = 0
        for vault in self.registered():
            self.open(vault)

    # ---- the registry ----------------------------------------------------------------------
    @property
    def registry(self) -> Path:
        return self.root / "vaults.json"

    def registered(self) -> list[str]:
        if not self.registry.exists():
            return []
        return [v for v in json.loads(self.registry.read_text()) if isinstance(v, str)]

    def open(self, vault: str) -> Swarm:
        home = self.root / vault
        keys = self.root / "keys" / vault
        swarm = Swarm(vault, home, self.pauser_for(vault, home), network=self.network, console_url=self.console_url,
                      keygen=lambda name: new_key(f"{name}-{int(self.now())}", vault, keys), now=self.now)
        self.swarms[vault] = swarm
        return swarm

    def check(self, vault: str) -> None:
        """The vault must be a real account on this network running contract version 3."""
        suffix = ".testnet" if self.network == "testnet" else ".near"
        if not isinstance(vault, str) or not 2 <= len(vault) <= 64 or not ACCOUNT.match(vault) or not vault.endswith(suffix):
            raise Refused(400, f"Not a NEAR {self.network} account id")
        try:
            info = self.rpc.view(vault, "get_vault")
        except Exception:  # noqa: BLE001 (no such account, no contract, or not a Styx vault)
            raise Refused(422, "That account is not a Styx vault on this network") from None
        if not isinstance(info, dict) or info.get("contract_version") != SENTINEL_VERSION:
            raise Refused(422, f"Sentinels need contract version {SENTINEL_VERSION}; create a new vault in the console")

    def register(self, vault: str) -> dict:
        vault = vault.strip().lower() if isinstance(vault, str) else vault
        with self.lock:
            if vault in self.swarms:
                return self.answer(vault)
        self.check(vault)  # RPC, outside the lock
        with self.lock:
            if vault in self.swarms:
                return self.answer(vault)
            if len(self.swarms) >= self.cap:
                raise Refused(429, f"This service watches at most {self.cap} vaults; run your own with styx-sentinels quickstart")
            swarm = self.open(vault)
            for kind, params in DEFAULT_SWARM:
                if kind != "judge":  # the hosted service runs the rule sentinels; the judge needs the owner's own NEAR AI key
                    swarm.spawn(kind, params)
            swarm.save()
            tmp = self.registry.with_suffix(".tmp")
            tmp.write_text(json.dumps(sorted(self.swarms)))
            tmp.replace(self.registry)
            return self.answer(vault)

    def answer(self, vault: str) -> dict:
        s = self.swarms[vault]
        installed = s.installed
        return {
            "vault": vault, "network": self.network, "paused": s.paused, "link": s.sign_all_link(),
            "keys_known": installed is not None,
            "members": [{"id": m.id, "kind": m.kind, "generation": m.generation, "status": m.status, "score": m.score,
                         "public_key": m.public_key, "installed": None if installed is None else m.public_key in installed}
                        for m in s.members],
            "pending": [{"action": x["action"], "member": x["member"], "public_key": x["public_key"]} for x in s.pending()],
        }

    def state(self, vault: str) -> dict | None:
        with self.lock:
            return self.answer(vault) if vault in self.swarms else None

    # ---- watching ---------------------------------------------------------------------------
    def tick(self, sync_every: int = 10) -> list[tuple[str, str, str]]:
        """One round over every vault: new events, key sync now and then, the swarm's cycle.
        Returns the pauses sent, as (vault, member, reason)."""
        fired = []
        with self.lock:
            vaults = list(self.swarms)
        for vault in vaults:
            swarm = self.swarms[vault]
            watcher = self.watchers.get(vault) or self.watchers.setdefault(vault, self.watcher_for(vault))
            try:
                batch = watcher.poll()
            except Exception:  # noqa: BLE001 (one vault's bad round must not stop the others)
                continue
            if self.ticks % sync_every == 0:
                try:
                    keys = self.rpc.view(vault, "get_sentinels")
                    with self.lock:
                        swarm.sync_keys(keys if isinstance(keys, list) else [])
                except Exception:  # noqa: BLE001
                    pass
            with self.lock:
                out = swarm.cycle(batch)
            fired += [(vault, m, r) for m, r in out["fired"]]
        self.ticks += 1
        return fired


def serve(service: Service, host: str, port: int, allow_origins: list[str]) -> ThreadingHTTPServer:
    """The HTTP API. Only POST /api/vaults changes anything, and it can only add a vault (up to the cap)."""

    class Handler(BaseHTTPRequestHandler):
        def send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            origin = self.headers.get("Origin", "")
            if origin in allow_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):  # noqa: N802 (CORS preflight from the console)
            self.send_response(204)
            origin = self.headers.get("Origin", "")
            if origin in allow_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Vary", "Origin")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            if self.path == "/api/health":
                return self.send(200, {"vaults": len(service.swarms), "cap": service.cap, "network": service.network})
            m = re.fullmatch(r"/api/vaults/([a-z0-9._-]{2,64})", self.path)
            if m:
                found = service.state(m.group(1))
                return self.send(200, found) if found else self.send(404, {"error": "This service does not watch that vault"})
            self.send(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            if self.path != "/api/vaults":
                return self.send(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length > MAX_BODY:
                    return self.send(413, {"error": "Body too large"})
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError
                self.send(200, service.register(body.get("vault")))
            except Refused as r:
                self.send(r.status, {"error": r.reason})
            except ValueError:
                self.send(400, {"error": "Send JSON: {\"vault\": \"<account>\"}"})

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
