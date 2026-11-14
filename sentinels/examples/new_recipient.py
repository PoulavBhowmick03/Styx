"""A Styx sentinel plug-in: pauses when an account the vault has never paid before suddenly takes
several payments. The usual shape of a drain: a fresh address, paid again and again.

Register it outside the repo, in ~/.styx-near/sentinels/plugins.toml:

    [plugins.new_recipient]
    module = "/absolute/path/to/new_recipient.py"

then `styx-sentinels add --vault <vault> --kind new_recipient`. It runs in its own isolated process
and sees only public payment fields.
"""
KIND = "new_recipient"
DEFAULTS = {"max_payments": 3, "window_seconds": 600}


class NewRecipient:
    def __init__(self, params, notes):
        self.max_payments = int(params.get("max_payments", 3))
        self.window = int(params.get("window_seconds", 600))

    def judge(self, history, now, daily_limit):
        first_seen, recent = {}, {}
        for p in sorted(history, key=lambda p: p["time"]):
            first_seen.setdefault(p["recipient"], p["time"])
            if now - self.window <= p["time"] <= now:
                recent[p["recipient"]] = recent.get(p["recipient"], 0) + 1
        for recipient, count in recent.items():
            new = now - first_seen[recipient] <= self.window
            if new and count > self.max_payments:
                return {"pause": True, "reason": f"{recipient}, first paid {int(now - first_seen[recipient])} s ago, "
                                                 f"took {count} payments, over the {self.max_payments} allowed for a new recipient"}
        return {"pause": False}


def build(params, notes):
    return NewRecipient(params, notes)


def mutate(params, direction):
    p = dict(params)
    n = int(p.get("max_payments", 3))
    p["max_payments"] = n + 2 if direction == "looser" else max(1, n - 1)
    verb = "Raised" if direction == "looser" else "Lowered"
    return p, f"{verb} the new-recipient threshold to {p['max_payments']} payments ({direction})."
