"""The parent: runs the sentinels on every new batch of events, scores them, retires the noisy ones
and respawns them with its notes (the Spawn lifecycle). Everything it decides is appended to a
lineage log, and its whole state is written to state.json for the UI.

Scoring. A sentinel pause is settled when the owner acts on it:
- a catch: the owner marks the pause as an attack (UI or `styx-sentinels label`), or the pause falls
  inside an attack window that a drill or demo script recorded;
- a false alarm: the owner unpauses and marks it a false alarm, or unpauses with no attack marked.
Score = catches - 2 x false alarms. At or below the retire score, the sentinel is retired: its process
stops judging, the owner gets a link to remove its key, and a new generation is spawned with notes.
"""
from __future__ import annotations

import json
import time as clock
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

from .events import Batch, Payment, PauseEvent
from .rules import Burst, Concentration, Verdict

RETIRE_SCORE = -2


@dataclass
class Pause:
    time: float
    reason: str
    tx: str
    outcome: str = "open"  # open | catch | false_alarm


@dataclass
class Member:
    id: str
    kind: str  # burst | concentration | judge
    generation: int
    params: dict
    public_key: str
    key_file: str
    status: str = "active"  # active | retired
    notes: list[str] = field(default_factory=list)
    pauses: list[Pause] = field(default_factory=list)
    born: float = 0.0
    retired: float | None = None

    @property
    def catches(self) -> int:
        return sum(p.outcome == "catch" for p in self.pauses)

    @property
    def false_alarms(self) -> int:
        return sum(p.outcome == "false_alarm" for p in self.pauses)

    @property
    def score(self) -> int:
        return self.catches - 2 * self.false_alarms


def build(member: Member, completer: Callable | None):
    """The detector a member runs, from its kind, params and notes."""
    if member.kind == "burst":
        return Burst(name=member.id, **member.params)
    if member.kind == "concentration":
        return Concentration(name=member.id, **member.params)
    if member.kind == "judge":
        from .judge import Judge
        if completer is None:
            raise ValueError("the judge needs a model (NEARAI_API_KEY)")
        return Judge(complete=completer, name=member.id, notes=list(member.notes), **member.params)
    raise ValueError(member.kind)


def adjust(kind: str, params: dict, reason: str) -> tuple[dict, str]:
    """What the parent changes in a respawn, and the note it passes on."""
    p = dict(params)
    if kind == "burst":
        p["max_payments"] = p.get("max_payments", 4) + 2
        return p, f"Raised the burst threshold to {p['max_payments']} payments: '{reason}' was a false alarm."
    if kind == "concentration":
        p["share"] = round(min(0.9, p.get("share", 0.4) + 0.15), 2)
        return p, f"Raised the concentration share to {int(p['share'] * 100)}%: '{reason}' was a false alarm."
    return p, f"Do not pause for this again, it was a false alarm: '{reason}'."


class Swarm:
    def __init__(self, vault: str, home: Path, pauser, keygen: Callable[[str], tuple[str, str]],
                 completer: Callable | None = None, now: Callable[[], float] = clock.time,
                 console_url: str = "https://styxco.xyz/console/", network: str = "testnet"):
        self.vault, self.home, self.pauser, self.keygen, self.completer, self.now = vault, home, pauser, keygen, completer, now
        self.console_url, self.network = console_url, network
        self.home.mkdir(parents=True, exist_ok=True)
        self.members: list[Member] = []
        self.history: list[Payment] = []
        self.events: list[dict] = []  # chain events seen, for the UI timeline
        self.paused = False
        self.daily_limit: int | None = None
        self.attack_windows: list[tuple[float, float, str]] = []
        self.owner_actions: list[dict] = []  # links the owner needs to sign (enable / remove keys)
        self.detectors: dict[str, Any] = {}
        self.load()

    # ---- persistence ----------------------------------------------------------------------
    @property
    def state_file(self) -> Path:
        return self.home / "state.json"

    @property
    def lineage_file(self) -> Path:
        return self.home / "lineage.jsonl"

    def load(self) -> None:
        if not self.state_file.exists():
            return
        s = json.loads(self.state_file.read_text())
        fields = set(Member.__dataclass_fields__)
        self.members = [Member(**{**{k: v for k, v in m.items() if k in fields}, "pauses": [Pause(**p) for p in m["pauses"]]}) for m in s["members"]]
        self.history = [Payment(**p) for p in s.get("history", [])]
        self.events = s.get("events", [])
        self.paused = s.get("paused", False)
        self.daily_limit = s.get("daily_limit")
        self.attack_windows = [tuple(w) for w in s.get("attack_windows", [])]
        self.owner_actions = s.get("owner_actions", [])

    def save(self) -> None:
        state = {
            "vault": self.vault, "network": self.network, "updated": self.now(), "paused": self.paused,
            "daily_limit": self.daily_limit, "attack_windows": self.attack_windows, "owner_actions": self.owner_actions,
            "members": [{**asdict(m), "score": m.score, "catches": m.catches, "false_alarms": m.false_alarms} for m in self.members],
            "history": [asdict(p) for p in self.history[-200:]], "events": self.events[-300:],
        }
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=1))
        tmp.replace(self.state_file)

    def log(self, action: str, **fields) -> None:
        with self.lineage_file.open("a") as f:
            f.write(json.dumps({"time": self.now(), "action": action, **fields}) + "\n")

    def lineage(self) -> list[dict]:
        if not self.lineage_file.exists():
            return []
        return [json.loads(line) for line in self.lineage_file.read_text().splitlines() if line.strip()]

    # ---- members ---------------------------------------------------------------------------
    def spawn(self, kind: str, params: dict, generation: int = 1, notes: list[str] | None = None, parent: str | None = None) -> Member:
        member_id = f"{kind}-g{generation}"
        public_key, key_file = self.keygen(member_id)
        m = Member(id=member_id, kind=kind, generation=generation, params=params, public_key=public_key,
                   key_file=str(key_file), notes=list(notes or []), born=self.now())
        self.members.append(m)
        self.owner_actions.append({"action": "enable", "member": m.id, "public_key": public_key,
                                   "link": f"{self.console_url}?vault={self.vault}&network={self.network}&sentinel_enable={public_key}"})
        self.log("spawn", member=m.id, kind=kind, generation=generation, params=params, notes=m.notes,
                 parent=parent, public_key=public_key)
        return m

    def active(self) -> list[Member]:
        return [m for m in self.members if m.status == "active"]

    def detector(self, m: Member):
        if m.id not in self.detectors:
            self.detectors[m.id] = build(m, self.completer)
        return self.detectors[m.id]

    # ---- labels ----------------------------------------------------------------------------
    def mark_attack(self, start: float, end: float, label: str = "attack") -> None:
        self.attack_windows.append((start, end, label))
        self.log("attack_marked", start=start, end=end, label=label)
        self.settle_by_windows()
        self.save()

    def label(self, member_id: str, pause_time: float, outcome: str) -> None:
        assert outcome in ("catch", "false_alarm")
        for m in self.members:
            for p in m.pauses:
                if m.id == member_id and abs(p.time - pause_time) < 1e-6:
                    p.outcome = outcome
                    self.log("labelled", member=m.id, pause_time=pause_time, outcome=outcome)
        self.review()
        self.save()

    def settle_by_windows(self) -> None:
        for m in self.members:
            for p in m.pauses:
                if p.outcome == "open" and any(a - 60 <= p.time <= b + 600 for a, b, _ in self.attack_windows):
                    p.outcome = "catch"
                    self.log("settled", member=m.id, pause_time=p.time, outcome="catch", why="inside a marked attack")

    # ---- the cycle -------------------------------------------------------------------------
    def ingest(self, batch: Batch) -> None:
        for p in batch.payments:
            if all(h.tx != p.tx or h.payment_id != p.payment_id for h in self.history):
                self.history.append(p)
                self.daily_limit = p.vault_daily_limit or self.daily_limit
                self.events.append({"type": "payment", "time": p.time, "tx": p.tx, "recipient": p.recipient, "amount": p.amount, "agent": p.agent})
        for e in batch.pauses:
            self.events.append({"type": e.kind, "time": e.time, "tx": e.tx, "sentinel": e.sentinel, "reason": e.reason})
            if e.kind in ("paused", "sentinel_paused"):
                self.paused = True
            elif e.kind == "unpaused":
                self.paused = False
                self.owner_unpaused(e)
        self.history.sort(key=lambda p: p.time)

    def owner_unpaused(self, e: PauseEvent) -> None:
        """An unpause settles every open pause before it: an attack if marked, otherwise a false alarm."""
        self.settle_by_windows()
        for m in self.members:
            for p in m.pauses:
                if p.outcome == "open" and p.time <= e.time:
                    p.outcome = "false_alarm"
                    self.log("settled", member=m.id, pause_time=p.time, outcome="false_alarm", why="owner unpaused, no attack marked")

    def watch(self) -> list[tuple[Member, Verdict]]:
        """Each active sentinel judges the history. The first that asks pauses the vault."""
        fired = []
        if self.paused:
            return fired
        now = self.now()
        for m in self.active():
            verdict = self.detector(m).judge(self.history, now, self.daily_limit)
            if not verdict.pause:
                continue
            try:
                tx = self.pauser.pause(m.key_file, f"[{m.id}] {verdict.reason}")
            except Exception as error:  # noqa: BLE001
                self.log("pause_failed", member=m.id, reason=verdict.reason, error=str(error)[:200])
                continue
            m.pauses.append(Pause(time=now, reason=verdict.reason, tx=tx))
            self.paused = True
            self.events.append({"type": "sentinel_pause_sent", "time": now, "tx": tx, "sentinel": m.id, "reason": verdict.reason})
            self.log("pause", member=m.id, reason=verdict.reason, tx=tx, evidence={k: v for k, v in verdict.evidence.items() if k != "model_evidence"})
            fired.append((m, verdict))
            break  # one pause is enough
        return fired

    def review(self) -> list[tuple[Member, Member]]:
        """Retire every active sentinel at or below the retire score and spawn its next generation."""
        replaced = []
        for m in list(self.active()):
            if m.score > RETIRE_SCORE:
                continue
            m.status, m.retired = "retired", self.now()
            self.detectors.pop(m.id, None)
            self.owner_actions.append({"action": "remove", "member": m.id, "public_key": m.public_key,
                                       "link": f"{self.console_url}?vault={self.vault}&network={self.network}&sentinel_remove={m.public_key}"})
            last = next((p.reason for p in reversed(m.pauses) if p.outcome == "false_alarm"), "")
            params, note = adjust(m.kind, m.params, last)
            self.log("retire", member=m.id, score=m.score, catches=m.catches, false_alarms=m.false_alarms)
            child = self.spawn(m.kind, params, generation=m.generation + 1, notes=[*m.notes, note], parent=m.id)
            replaced.append((m, child))
        return replaced

    def cycle(self, batch: Batch) -> dict:
        self.ingest(batch)
        fired = self.watch()
        replaced = self.review()
        self.save()
        return {"fired": [(m.id, v.reason) for m, v in fired], "replaced": [(a.id, b.id) for a, b in replaced]}


DEFAULT_SWARM = [("burst", {"max_payments": 4, "window_seconds": 300}),
                 ("concentration", {"share": 0.4, "window_seconds": 3600}),
                 ("judge", {"window": 20})]
