"""The attack marker that scripts/near/drain_attack.sh writes to $STYX_NEAR_STATE_ROOT/sentinel-attack.json:
{"attack_id": "drain-<uuid>", "active": true|false, "time": <unix seconds>, "vault": "<account>"}.
While a drain is active the parent treats it as a marked attack, so a pause inside it is a catch.
A killed script can leave an active marker; one older than `stale_seconds` is treated as ended."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class AttackMarker:
    path: Path
    vault: str
    stale_seconds: float = 1800.0
    starts: dict[str, float] = field(default_factory=dict)
    ended: set[str] = field(default_factory=set)

    def read(self) -> dict | None:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict) or data.get("vault") != self.vault or not isinstance(data.get("attack_id"), str):
            return None
        if not isinstance(data.get("time"), (int, float)) or not isinstance(data.get("active"), bool):
            return None
        return data

    def check(self, now: float) -> tuple[float, float, str, bool] | None:
        """The window to mark for the current attack, (start, end, attack_id, final), or None."""
        data = self.read()
        if not data or data["attack_id"] in self.ended:
            return None
        attack, when = data["attack_id"], float(data["time"])
        if data["active"]:
            start = self.starts.setdefault(attack, when)
            if now - start > self.stale_seconds:
                self.ended.add(attack)
                return start, start + self.stale_seconds, attack, True
            return start, now, attack, False
        if attack not in self.starts:
            return None  # it began and ended before we watched; nothing to say when it started
        self.ended.add(attack)
        return self.starts[attack], when, attack, True
