"""Rule sentinels. Each looks at the recent payments and either stays quiet or asks to pause, with a
reason a person can read. They only see what is public on chain: agent, recipient, amount, time."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from .events import Payment


@dataclass(frozen=True)
class Verdict:
    pause: bool
    reason: str = ""
    evidence: dict = field(default_factory=dict)


class Sentinel(Protocol):
    name: str
    kind: str

    def judge(self, history: list[Payment], now: float, daily_limit: int | None) -> Verdict: ...


def usd(base_units: int) -> str:
    whole, frac = divmod(base_units, 1_000_000)
    return f"{whole}.{frac:06d}".rstrip("0").rstrip(".")


@dataclass
class Burst:
    """Too many payments too fast: the shape of a drain in small, allowed amounts."""
    name: str = "burst"
    max_payments: int = 4
    window_seconds: int = 300
    kind: str = "burst"

    def judge(self, history: list[Payment], now: float, daily_limit: int | None) -> Verdict:
        recent = [p for p in history if now - self.window_seconds <= p.time <= now]
        if len(recent) <= self.max_payments:
            return Verdict(False)
        total = sum(p.amount for p in recent)
        return Verdict(True, f"{len(recent)} payments in {self.window_seconds // 60} min "
                             f"({usd(total)} total), over the {self.max_payments} allowed",
                       {"count": len(recent), "total": total, "txs": [p.tx for p in recent]})


@dataclass
class Concentration:
    """One recipient taking a large share of the vault's daily limit in a short window."""
    name: str = "concentration"
    share: float = 0.4
    window_seconds: int = 3600
    kind: str = "concentration"

    def judge(self, history: list[Payment], now: float, daily_limit: int | None) -> Verdict:
        limit = daily_limit or next((p.vault_daily_limit for p in reversed(history) if p.vault_daily_limit), None)
        if not limit:
            return Verdict(False)
        per: dict[str, int] = {}
        for p in history:
            if now - self.window_seconds <= p.time <= now:
                per[p.recipient] = per.get(p.recipient, 0) + p.amount
        if not per:
            return Verdict(False)
        recipient, total = max(per.items(), key=lambda kv: kv[1])
        if total < self.share * limit:
            return Verdict(False)
        return Verdict(True, f"{recipient} took {usd(total)} ({round(100 * total / limit)}% of the "
                             f"{usd(limit)} daily limit) in {self.window_seconds // 60} min",
                       {"recipient": recipient, "total": total, "limit": limit})
