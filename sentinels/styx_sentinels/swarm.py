"""The parent: runs the sentinels on every new batch of events, scores them, retires the noisy ones
and respawns them with its notes (the Spawn lifecycle). Everything it decides is appended to a
lineage log, and its whole state is written to state.json for the UI.

Scoring. A sentinel pause is settled when the owner acts on it:
- a catch: the owner marks the pause as an attack (UI or `styx-sentinels label`), or the pause falls
  inside an attack window that a drill or demo script recorded;
- a false alarm: the owner unpauses and marks it a false alarm, or unpauses with no attack marked.
- a miss: an attack window closes with no pause from any sentinel; every active sentinel is charged.
Fitness = catches - 2 x false alarms - misses. At or below the retire score, the sentinel is retired:
it stops judging, and its child is spawned with one mutation, in the direction its record asks for:
looser after false alarms, stricter after misses. Selection is proposed by the parent and ratified on
chain by the owner (or the owner's DAO): only `set_sentinel`, signed by the owner, changes which keys
can pause. A sentinel's key allowance on NEAR is its energy: each pause burns gas from it, and when it
runs low the parent asks the owner to swap in a fresh key.
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
YOCTO = 10**24
FULL_ALLOWANCE = 5 * 10**22  # set_sentinel installs a 0.05 NEAR allowance
LOW_ALLOWANCE = 10**22  # below 0.01 NEAR the parent asks for a fresh key


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
    parent: str | None = None
    mutation: dict = field(default_factory=dict)  # param -> [parent's value, this one's]
    misses: list[str] = field(default_factory=list)  # attack labels that closed with no pause
    allowance: str | None = None  # yoctoNEAR left on its key, read from the chain
    ratified: bool = False  # its key is on the vault (the owner signed set_sentinel)
    next_key: str | None = None  # a fresh key waiting to be installed, when energy runs low
    next_key_file: str | None = None

    @property
    def catches(self) -> int:
        return sum(p.outcome == "catch" for p in self.pauses)

    @property
    def false_alarms(self) -> int:
        return sum(p.outcome == "false_alarm" for p in self.pauses)

    @property
    def score(self) -> int:
        return self.catches - 2 * self.false_alarms - len(self.misses)


def build(member: Member, completer: Callable | None, background: bool = False):
    """The detector a member runs, from its kind, params and notes."""
    if member.kind == "burst":
        return Burst(name=member.id, **member.params)
    if member.kind == "concentration":
        return Concentration(name=member.id, **member.params)
    if member.kind == "judge":
        from .judge import Judge
        if completer is None:
            raise ValueError("the judge needs a model (NEARAI_API_KEY)")
        return Judge(complete=completer, name=member.id, notes=list(member.notes), background=background, **member.params)
    from . import plugins
    module = plugins.registry().get(member.kind)
    if module is None:
        raise ValueError(f"no built-in or plug-in sentinel named {member.kind}")
    return plugins.PluginSentinel(member.kind, module, member.id, dict(member.params), list(member.notes))


BUILT_IN = ("burst", "concentration", "judge")


def adjust(kind: str, params: dict, reason: str, direction: str = "looser") -> tuple[dict, str]:
    if kind not in BUILT_IN:
        from . import plugins
        try:
            child, note = plugins.mutate(kind, params, direction)
            return child, note or f"The {kind} plug-in mutated its params ({direction}) after {reason}."
        except plugins.PluginError as error:
            return dict(params), f"The {kind} plug-in could not mutate ({error}); the child keeps its parent's params."
    return _adjust_built_in(kind, params, reason, direction)


def _adjust_built_in(kind: str, params: dict, reason: str, direction: str = "looser") -> tuple[dict, str]:
    """The one mutation a child inherits, and the note it carries. `looser` after false alarms (the
    parent paused on normal traffic), `stricter` after misses (an attack went by)."""
    p = dict(params)
    looser = direction == "looser"
    if kind == "burst":
        n = p.get("max_payments", 4)
        p["max_payments"] = n + 2 if looser else max(2, n - 1)
        why = f"'{reason}' was a false alarm" if looser else f"it missed {reason}"
        return p, f"{'Raised' if looser else 'Lowered'} the burst threshold to {p['max_payments']} payments: {why}."
    if kind == "concentration":
        x = p.get("share", 0.4)
        p["share"] = round(min(0.9, x + 0.15), 2) if looser else round(max(0.1, x - 0.1), 2)
        why = f"'{reason}' was a false alarm" if looser else f"it missed {reason}"
        return p, f"{'Raised' if looser else 'Lowered'} the concentration share to {int(p['share'] * 100)}%: {why}."
    if looser:
        return p, f"Do not pause for this again, it was a false alarm: '{reason}'."
    return p, f"Pause earlier: an attack went by unpaused ({reason})."


def mutation(old: dict, new: dict) -> dict:
    return {k: [old.get(k), v] for k, v in new.items() if old.get(k) != v}


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
        self.judge_background = False  # the runner sets this: the judge asks the model on its own thread
        self.judge_errors: dict[str, str | None] = {}
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
            "installed_known": self.installed is not None,
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
    def spawn(self, kind: str, params: dict, generation: int = 1, notes: list[str] | None = None, parent: str | None = None,
              changed: dict | None = None) -> Member:
        member_id = f"{kind}-g{generation}"
        public_key, key_file = self.keygen(member_id)
        m = Member(id=member_id, kind=kind, generation=generation, params=params, public_key=public_key,
                   key_file=str(key_file), notes=list(notes or []), born=self.now(), parent=parent, mutation=dict(changed or {}))
        self.members.append(m)
        self.owner_actions.append({"action": "enable", "member": m.id, "public_key": public_key,
                                   "link": self.link([("sentinel_enable", public_key), ("sentinel_label", m.id)])})
        self.log("spawn", member=m.id, kind=kind, generation=generation, params=params, notes=m.notes,
                 parent=parent, mutation=m.mutation, public_key=public_key)
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
        for m in self.members:
            if m.next_key and m.next_key in self.installed:
                self.log("key_swapped", member=m.id, old=m.public_key, new=m.next_key)
                m.public_key, m.key_file, m.next_key, m.next_key_file = m.next_key, m.next_key_file or m.key_file, None, None
                self.detectors.pop(m.id, None)
                changed = True
            ratified = m.public_key in self.installed
            if ratified != m.ratified:
                m.ratified, changed = ratified, True
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
        labels.update({m.next_key: m.id for m in self.members if m.next_key})
        return json.dumps({"vault": self.vault, "labels": labels}, indent=2) + "\n"

    def sync_allowances(self, keys: list[dict]) -> None:
        """The vault's access-key list (RPC view_access_key_list): each sentinel's allowance left. When a
        key's allowance runs low, the parent proposes a fresh key for that sentinel, same genome."""
        left = {}
        for k in keys:
            perm = (k.get("access_key") or {}).get("permission")
            fc = perm.get("FunctionCall") if isinstance(perm, dict) else None
            if fc and fc.get("method_names") == ["sentinel_pause"]:
                left[k.get("public_key")] = fc.get("allowance")
        for m in self.active():
            if m.public_key not in left:
                continue
            m.allowance = left[m.public_key]
            if m.allowance is not None and int(m.allowance) < LOW_ALLOWANCE and not m.next_key:
                fresh, path = self.keygen(f"{m.id}-refresh")
                m.next_key, m.next_key_file = fresh, str(path)
                self.owner_actions.append({"action": "remove", "member": m.id, "public_key": m.public_key,
                                           "link": self.link([("sentinel_remove", m.public_key)]), "why": "energy"})
                self.owner_actions.append({"action": "enable", "member": m.id, "public_key": fresh,
                                           "link": self.link([("sentinel_enable", fresh), ("sentinel_label", m.id)]), "why": "energy"})
                self.log("energy_low", member=m.id, allowance=m.allowance, next_key=fresh)
        self.save()

    def active(self) -> list[Member]:
        return [m for m in self.members if m.status == "active"]

    def detector(self, m: Member):
        if m.id not in self.detectors:
            self.detectors[m.id] = build(m, self.completer, self.judge_background)
        return self.detectors[m.id]

    # ---- labels ----------------------------------------------------------------------------
    def mark_attack(self, start: float, end: float, label: str = "attack", final: bool = True) -> None:
        """Marks an attack window. Marking the same label again moves its end (an attack in progress).
        When the window is final and no sentinel paused inside it, every active sentinel is charged a miss."""
        known = [i for i, w in enumerate(self.attack_windows) if w[2] == label]
        if known:
            i = known[0]
            if self.attack_windows[i][1] < end:
                self.attack_windows[i] = (self.attack_windows[i][0], end, label)
            elif not final:
                return
        else:
            self.attack_windows.append((start, end, label))
            self.log("attack_marked", start=start, end=end, label=label)
        self.settle_by_windows()
        if final:
            a, b = next((w[0], w[1]) for w in self.attack_windows if w[2] == label)
            caught = any(a - 60 <= p.time <= b + 600 for m in self.members for p in m.pauses)
            if not caught:
                for m in self.active():
                    if label not in m.misses:
                        m.misses.append(label)
                        self.log("missed", member=m.id, label=label, why="the attack closed with no pause")
                self.review()
        self.save()

    def import_pause_labels(self, text: str) -> int:
        """The console's verdict file: {"vault", "pause_labels": [{"tx", "outcome"}]}. Each verdict is
        matched to this swarm's pause by its transaction hash. Returns how many were applied."""
        data = json.loads(text)
        if not isinstance(data, dict) or data.get("vault") != self.vault or not isinstance(data.get("pause_labels"), list):
            raise ValueError(f"not a labels file for {self.vault}")
        done = 0
        for entry in data["pause_labels"]:
            if not isinstance(entry, dict) or entry.get("outcome") not in ("catch", "false_alarm"):
                continue
            for m in self.members:
                for p in m.pauses:
                    if p.tx and p.tx == entry.get("tx") and p.outcome != entry["outcome"]:
                        self.label(m.id, p.time, entry["outcome"])
                        done += 1
        return done

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
            error = getattr(detector, "error", None)
            if error != self.judge_errors.get(m.id):
                self.judge_errors[m.id] = error
                if error:
                    self.log("judge_error" if m.kind == "judge" else "plugin_error", member=m.id, error=error)
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
            # How long after the newest payment's block the pause was decided: the watcher's lag.
            lag = round(now - unreviewed[-1].time, 1) if unreviewed else None
            self.log("pause", member=m.id, reason=verdict.reason, tx=tx, **model, decided_after_s=lag, payments_seen=len(unreviewed),
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
            if 2 * m.false_alarms >= len(m.misses):
                direction, last = "looser", next((p.reason for p in reversed(m.pauses) if p.outcome == "false_alarm"), "")
            else:
                direction, last = "stricter", m.misses[-1]
            params, note = adjust(m.kind, m.params, last, direction)
            self.log("retire", member=m.id, score=m.score, catches=m.catches, false_alarms=m.false_alarms,
                     misses=len(m.misses), direction=direction)
            child = self.spawn(m.kind, params, generation=m.generation + 1, notes=[*m.notes, note], parent=m.id,
                               changed=mutation(m.params, params))
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
