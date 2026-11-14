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
from .judge import summarize
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
    verdicts: list[dict] = field(default_factory=list)  # a judge's recent answers, with what the client checked

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
        self.installed: set[str] | None = None  # keys get_sentinels reports; None when unknown (rehearsal)
        self.detectors: dict[str, Any] = {}
        # Payments up to the owner's last unpause were reviewed by the owner; sentinels judge only newer ones.
        self.reviewed_until = 0.0
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
        self.reviewed_until = s.get("reviewed_until", 0.0)

    def save(self) -> None:
        state = {
            "vault": self.vault, "network": self.network, "updated": self.now(), "paused": self.paused,
            "daily_limit": self.daily_limit, "reviewed_until": self.reviewed_until, "attack_windows": self.attack_windows, "owner_actions": self.owner_actions, "sign_all": self.sign_all_link(),
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
                                   "link": self.link([("sentinel_enable", public_key), ("sentinel_label", m.id)])})
        self.log("spawn", member=m.id, kind=kind, generation=generation, params=params, notes=m.notes,
                 parent=parent, public_key=public_key)
        return m

    def link(self, changes: list[tuple[str, str]]) -> str:
        """A console link that opens these key changes as one review (owner-console-near readSentinelLink)."""
        from urllib.parse import urlencode
        return f"{self.console_url}?{urlencode([('vault', self.vault), ('network', self.network), *changes], safe=':')}"

    def pending(self) -> list[dict]:
        return [x for x in self.owner_actions if not x.get("done")]

    def sign_all_link(self) -> str | None:
        """One link, one approval, for every key change the owner has not signed yet."""
        changes: list[tuple[str, str]] = []
        for x in self.pending():
            if x["action"] == "enable":
                changes += [("sentinel_enable", x["public_key"]), ("sentinel_label", x["member"])]
            else:
                changes.append(("sentinel_remove", x["public_key"]))
        return self.link(changes) if changes else None

    def sync_keys(self, enabled: list[str]) -> None:
        """The vault's get_sentinels answer: ticks off signed key changes. Until a key is installed its
        sentinel does not try to pause (the vault would refuse it with NotSentinel)."""
        self.installed = set(enabled)
        changed = False
        for x in self.pending():
            if (x["action"] == "enable") == (x["public_key"] in self.installed):
                x["done"] = True
                changed = True
                self.log("key_confirmed", member=x["member"], change=x["action"], public_key=x["public_key"])
        if changed:
            self.save()

    def names_file(self) -> str:
        """The console's names format: {"vault": ..., "labels": {public key: name}}. Public keys and the
        members' ids only; every sentinel the swarm ever made, so a retired key still has its name."""
        labels = {m.public_key: m.id for m in self.members}
        return json.dumps({"vault": self.vault, "labels": labels}, indent=2) + "\n"

    def active(self) -> list[Member]:
        return [m for m in self.members if m.status == "active"]

    def detector(self, m: Member):
        if m.id not in self.detectors:
            self.detectors[m.id] = build(m, self.completer)
        return self.detectors[m.id]

    # ---- labels ----------------------------------------------------------------------------
    def mark_attack(self, start: float, end: float, label: str = "attack") -> None:
        """Marks an attack window. Marking the same label again moves its end (an attack in progress)."""
        known = [i for i, w in enumerate(self.attack_windows) if w[2] == label]
        if known:
            i = known[0]
            if self.attack_windows[i][1] >= end:
                return
            self.attack_windows[i] = (self.attack_windows[i][0], end, label)
        else:
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
                self.reviewed_until = max(self.reviewed_until, e.time)
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

    def record_verdict(self, m: Member, verdict: Verdict, now: float) -> dict | None:
        """A judge answered: keep a short summary in the state and the full evidence in a file under the
        swarm's home (evidence/<member>-<time>.json), served by the page at /api/evidence/<file>."""
        evidence = verdict.evidence.get("model_evidence")
        if not isinstance(evidence, dict) or not evidence:
            return None
        name = f"{m.id}-{int(now * 1000)}.json"
        folder = self.home / "evidence"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text(json.dumps({"member": m.id, "time": now, "pause": verdict.pause, "reason": verdict.reason,
                                               "evidence": evidence}, indent=1, default=str))
        entry = {"time": now, "pause": verdict.pause, "reason": verdict.reason, **summarize(evidence), "file": name}
        m.verdicts.append(entry)
        del m.verdicts[:-10]
        return entry

    def watch(self) -> list[tuple[Member, Verdict]]:
        """Each active sentinel judges the history. The first that asks pauses the vault."""
        fired = []
        if self.paused:
            return fired
        now = self.now()
        unreviewed = [p for p in self.history if p.time > self.reviewed_until]
        for m in self.active():
            if self.installed is not None and m.public_key not in self.installed:
                continue  # its key is not on the vault yet
            try:
                detector = self.detector(m)
            except ValueError:
                continue  # e.g. a judge with no model configured: it waits, it is not removed
            verdict = detector.judge(unreviewed, now, self.daily_limit)
            entry = self.record_verdict(m, verdict, now) if m.kind == "judge" and getattr(detector, "fresh", False) else None
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
            model = {"model": entry["model"], "verified": entry["verified"], "evidence_file": entry["file"]} if entry else {}
            self.log("pause", member=m.id, reason=verdict.reason, tx=tx, **model,
                     evidence={k: v for k, v in verdict.evidence.items() if k != "model_evidence"})
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
            for x in self.pending():
                if x["member"] == m.id and x["action"] == "enable":
                    x["done"], x["cancelled"] = True, True  # never installed: nothing to enable now
            self.owner_actions.append({"action": "remove", "member": m.id, "public_key": m.public_key,
                                       "link": self.link([("sentinel_remove", m.public_key)])})
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
