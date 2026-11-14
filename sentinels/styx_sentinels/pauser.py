"""How a sentinel pauses the vault. CliPauser signs sentinel_pause with the sentinel's own key
through the Styx agent CLI (styx-near-vault), as the vault account; NEAR lets that key call nothing
else. DryRunPauser only records, for rehearsals and tests."""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field


class PauseFailed(Exception):
    pass


@dataclass
class CliPauser:
    cli: str
    vault: str
    rpc_url: str | None = None

    def pause(self, key_file: str, reason: str) -> str:
        env = {**os.environ, "STYX_NEAR_VAULT": self.vault, "STYX_NEAR_SENTINEL_KEY_FILE": key_file}
        if self.rpc_url:
            env["STYX_NEAR_RPC_URL"] = self.rpc_url
        done = subprocess.run([self.cli], input=json.dumps({"method": "sentinel_pause", "reason": reason[:280]}),
                              capture_output=True, text=True, timeout=120, env=env)
        try:
            reply = json.loads(done.stdout)
        except ValueError:
            raise PauseFailed("the CLI gave no answer") from None
        if reply.get("status") != "ok":
            raise PauseFailed(str(reply.get("message", "refused"))[:200])
        return str(reply.get("tx_hash", ""))


@dataclass
class DryRunPauser:
    calls: list[tuple[str, str]] = field(default_factory=list)

    def pause(self, key_file: str, reason: str) -> str:
        self.calls.append((key_file, reason))
        return f"dry-run-{len(self.calls)}"
