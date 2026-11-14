"""The judge sentinel: a model on NEAR AI Cloud reads the recent payments and decides whether this
looks like a hijacked agent. The attestation is verified before every completion (agent-near-ai's
client), and the evidence is kept with the verdict, so a reviewer can check which model judged."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

from .events import Payment
from .rules import Verdict, usd

SYSTEM = (
    "You watch the payments an AI agent makes from a vault. Each payment is already within the "
    "owner's limits. Your job is to spot a hijacked agent: for example many small payments draining "
    "the vault, a new recipient suddenly taking most of the budget, or a pattern unlike the history. "
    "Pausing is cheap and safe: the owner can unpause. Answer only JSON: "
    '{"pause": true|false, "reason": "<one short sentence a person can read>"}'
)

# complete(messages) -> (text, evidence). Production: NearAICompleter. Tests: a fake.
Completer = Callable[[list[dict]], tuple[str, dict]]


@dataclass
class Judge:
    complete: Completer
    name: str = "judge"
    window: int = 20
    notes: list[str] = field(default_factory=list)  # lessons from the parent, e.g. past false alarms
    kind: str = "judge"
    last_evidence: dict | None = None
    fresh: bool = False  # True when the last judge() call asked the model; False when it reused the answer
    _asked: tuple | None = field(default=None, repr=False)
    _answer: Verdict | None = field(default=None, repr=False)

    def prompt(self, history: list[Payment], now: float, daily_limit: int | None) -> list[dict]:
        recent = history[-self.window:]
        rows = [f"{int(now - p.time)}s ago: {usd(p.amount)} to {p.recipient}{' (approved exception)' if p.exception else ''}"
                for p in recent]
        lines = [f"Vault daily limit: {usd(daily_limit)}" if daily_limit else "Vault daily limit: unknown",
                 f"Last {len(recent)} payments, newest last:", *rows]
        if self.notes:
            lines += ["", "Notes from your supervisor (past mistakes to avoid):", *[f"- {n}" for n in self.notes]]
        return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "\n".join(lines)}]

    def judge(self, history: list[Payment], now: float, daily_limit: int | None) -> Verdict:
        if not history:
            return Verdict(False)
        # The answer depends on the payments, so ask again only when there is a new one: the swarm
        # polls every second, and the model should not be called a second time for the same payments.
        key = (len(history), history[-1].tx, history[-1].payment_id)
        if key == self._asked and self._answer is not None:
            self.fresh = False
            return self._answer
        self.fresh = False
        try:
            text, evidence = self.complete(self.prompt(history, now, daily_limit))
            self.last_evidence = evidence
            start, end = text.find("{"), text.rfind("}")
            answer = json.loads(text[start:end + 1])
            pause, reason = bool(answer.get("pause")), str(answer.get("reason", ""))[:200]
        except Exception:  # noqa: BLE001 (a judge that cannot answer stays quiet; the rules still watch)
            return Verdict(False)
        self._asked, self._answer, self.fresh = key, Verdict(pause, reason, {"model_evidence": evidence}), True
        return self._answer


def summarize(evidence: dict) -> dict:
    """A short, plain-words summary of what the client checked, for the page and the lineage: the model,
    whether the response signature verified against the attested signer, and which checks ran. The full
    evidence stays in a file."""
    sig = evidence.get("signature") if isinstance(evidence.get("signature"), dict) else {}
    pre = evidence.get("preflight") if isinstance(evidence.get("preflight"), dict) else {}
    tls = pre.get("tls") if isinstance(pre.get("tls"), dict) else None
    return {
        "model": str(evidence.get("model", ""))[:80],
        "verified": sig.get("verified") is True,
        "signature_kind": str(sig.get("signature_kind", ""))[:20],
        "signing_address": str(sig.get("signing_address", ""))[:60],
        "chat_id": str(sig.get("chat_id", ""))[:80],
        "checks": [str(c)[:60] for c in pre.get("checks", [])][:12] if isinstance(pre.get("checks"), list) else [],
        "attested_signers": len(pre.get("signers", [])) if isinstance(pre.get("signers"), list) else 0,
        "tls_bound": bool(tls and tls.get("peer_spki_sha256")),
    }


class NearAICompleter:
    """Verified completions from NEAR AI Cloud, through agent-near-ai's client (attestation checked
    with a fresh nonce before the first completion; each response's signature checked)."""

    def __init__(self, model: str):
        from styx_near_ai.nearai import NearAI  # optional dependency: pip install styx-sentinels[judge]
        self.client = NearAI(model)
        self.model = model
        self.preflight = None

    def __call__(self, messages: list[dict]) -> tuple[str, dict]:
        if self.preflight is None:
            self.preflight = self.client.preflight()
        # max_tokens bounds what one verdict can cost; the answer is one short JSON line.
        parsed, entry = self.client.complete({"model": self.model, "messages": messages, "temperature": 0, "max_tokens": 400}, self.preflight)
        text = parsed["choices"][0]["message"]["content"]
        pre = self.preflight
        return text, {"model": self.model, "signature": entry, "preflight": {
            "checks": [str(c) for c in pre.checks], "signers": [f"{algo}:{address}:{label}" for (algo, address), label in pre.signers.items()],
            "rejected": len(pre.rejected), "nonce": pre.nonce, "url": pre.url, "tls": dict(pre.tls) if pre.tls else None}}


class CappedCompleter:
    """Stops asking the model after `limit` calls in this process, so a long run or a bug cannot spend
    the owner's credits. The judge treats the refusal as an answer it cannot give and stays quiet; the
    rule sentinels keep watching."""

    def __init__(self, inner: Completer, limit: int):
        self.inner, self.limit, self.calls = inner, limit, 0

    def __call__(self, messages: list[dict]) -> tuple[str, dict]:
        if self.calls >= self.limit:
            raise RuntimeError(f"judge call cap of {self.limit} reached")
        self.calls += 1
        return self.inner(messages)
