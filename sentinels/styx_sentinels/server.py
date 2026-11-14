"""The swarm's live page, served on localhost only: GET / (the page), GET /api/state (state and
lineage), POST /api/label and /api/attack (the owner settles pauses). It never sees a key."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from typing import Callable

from .swarm import Swarm


def serve(swarm: Swarm, port: int, lock: threading.Lock, extra: Callable[[], dict] | None = None) -> ThreadingHTTPServer:
    root = resources.files("styx_sentinels").joinpath("ui")
    kinds = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
             ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml"}

    def static(path: str) -> tuple[bytes, str] | None:
        """A file of the built page (sentinels-ui), never anything outside it."""
        parts = [p for p in path.split("?")[0].split("/") if p]
        if not parts:
            parts = ["index.html"]
        if any(p in ("..", ".") or p.startswith(".") for p in parts):
            return None
        node = root
        for p in parts:
            node = node.joinpath(p)
        suffix = "." + parts[-1].rsplit(".", 1)[-1] if "." in parts[-1] else ""
        if suffix not in kinds or not node.is_file():
            return None
        return node.read_bytes(), kinds[suffix]

    class Handler(BaseHTTPRequestHandler):
        def send(self, code: int, body: bytes, kind: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path == "/api/state":
                with lock:
                    state = json.loads(swarm.state_file.read_text()) if swarm.state_file.exists() else {}
                    state["lineage"] = swarm.lineage()[-200:]
                    state.update(extra() if extra else {})
                return self.send(200, json.dumps(state).encode(), "application/json")
            found = static(self.path)
            if found:
                return self.send(200, *found)
            self.send(404, b"not found", "text/plain")

        def do_POST(self):  # noqa: N802
            try:
                body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 4096)) or b"{}")
                with lock:
                    if self.path == "/api/label":
                        swarm.label(str(body["member"]), float(body["time"]), str(body["outcome"]))
                    elif self.path == "/api/attack":
                        swarm.mark_attack(float(body["start"]), float(body["end"]), str(body.get("label", "marked by the owner"))[:120])
                    else:
                        return self.send(404, b"not found", "text/plain")
                self.send(200, b'{"ok":true}', "application/json")
            except (KeyError, ValueError, AssertionError) as error:
                self.send(400, json.dumps({"error": str(error)[:200]}).encode(), "application/json")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
