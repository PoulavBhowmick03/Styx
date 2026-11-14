"""A scripted rehearsal of the whole lifecycle, through the real parent loop with a dry-run pauser:
normal traffic; an honest but bursty payroll that the burst sentinel wrongly pauses (a false alarm: it
is retired and its child gets a looser threshold); two slow leaks that every sentinel lets through
(misses: the parents are retired and their children get stricter); then an injected drain the
newest generation catches. The
payments are simulated; the page says so. Nothing touches a chain."""
from __future__ import annotations

from typing import Callable, Iterator

from .events import Batch, Payment, PauseEvent

LIMIT = 50_000_000  # a 50 USDC vault daily limit


def scenario(start: float) -> Iterator[tuple[float, str, Batch | None, str]]:
    """(time, caption, batch, action). action: '' | 'unpause' | 'attack_start' | 'attack_end'."""
    t, n = start, 0

    def pay(recipient: str, amount: float) -> Batch:
        nonlocal n
        n += 1
        return Batch(payments=[Payment(payment_id=f"r{n}", agent="ed25519:Agent", recipient=recipient, amount=int(amount * 1e6),
                                       time=t, tx=f"rehearsal-{n}", vault_daily_limit=LIMIT)])

    for recipient, amount in [("vendor-a.testnet", 3), ("cloud-gpu.testnet", 5), ("vendor-a.testnet", 2)]:
        t += 90
        yield t, "Normal traffic: a few invoices, well apart.", pay(recipient, amount), ""
    for round_ in range(2):
        for i in range(5):
            t += 15
            yield t, f"Payroll run {round_ + 1}: five contractors paid in a minute (honest, but bursty).", pay(f"contractor-{i}.testnet", 1.5), ""
        t += 40
        yield t, "", Batch(pauses=[PauseEvent("unpaused", t, f"rehearsal-unpause-{round_}")]), "unpause"
        t += 400
    for leak in range(2):
        t += 60
        yield t, f"Slow leak {leak + 1}: 4 USDC every two minutes to a new account. Too slow for any sentinel.", None, "leak_start"
        for i in range(4):
            t += 120
            yield t, f"Slow leak {leak + 1}: 4 USDC every two minutes to a new account. Too slow for any sentinel.", pay("leak-9c1e.testnet", 4), ""
        t += 60
        yield t, ("The owner finds the leak and marks it an attack: no sentinel paused, so each is charged a miss."
                  if leak == 0 else "A second miss: the parent retires them, and their children are stricter."), None, "leak_end"
        t += 3700  # past the concentration window, so the next leak starts clean
    t += 60
    yield t, "An injected agent starts draining: many small payments, each within the limits.", None, "attack_start"
    for i in range(8):
        t += 12
        yield t, "Drain in progress: 2 USDC at a time to one new recipient.", pay("drain-4f2a.testnet", 2), ""
    t += 30
    yield t, "The owner confirms it was an attack.", None, "attack_end"


START = 1_800_000_000.0  # the rehearsal's simulated clock starts here


def run(swarm, sleep: Callable[[float], None], speed: float = 8.0, caption: Callable[[str], None] = print) -> None:
    attack_start, leaks = None, 0
    clock_holder = {"t": None}
    swarm.now = lambda: clock_holder["t"]
    previous = None
    for t, text, batch, action in scenario(START):
        if previous is not None:
            sleep(min(3.0, (t - previous) / speed / 10))
        previous = t
        clock_holder["t"] = t
        if text:
            caption(text)
        if action in ("attack_start", "leak_start"):
            attack_start = t
        elif action == "leak_end":
            leaks += 1
            swarm.mark_attack(attack_start, t, f"slow leak {leaks}")
        elif action == "attack_end":
            swarm.mark_attack(attack_start, t, "rehearsal: injected drain")
        if action == "unpause":
            if swarm.paused:
                caption("The owner checks, sees it was payroll, and unpauses: a false alarm.")
                swarm.cycle(batch)
            else:
                caption("Payroll went through: the new generation learned it is normal.")
                swarm.save()
            continue
        if batch is not None:
            swarm.cycle(batch)
