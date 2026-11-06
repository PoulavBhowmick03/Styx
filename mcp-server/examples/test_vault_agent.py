"""Restart behaviour of the scripted vault agent, driven through its real `Agent` class.

The project rule is that a payment ID is never replaced to retry. After an `unknown` outcome the first payment
may still land, so a rerun must look up the ID it kept before it proposes anything. The tools are faked: this
tests the agent's decisions, not the vault.

Run: uv run pytest mcp-server/examples -q   (CI's testpaths do not include this folder yet)
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

SPEC = importlib.util.spec_from_file_location("vault_agent", Path(__file__).with_name("vault_agent.py"))
vault_agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vault_agent)

VENDOR = "0x00000000000000000000000000000000000000a1"


class FakeVault:
    """The four tools, with a settled set standing in for the chain and scripted submit outcomes."""

    def __init__(self) -> None:
        self.settled: set[str] = set()
        self.proposed: list[tuple[str, str]] = []  # (invoice reference, payment ID)
        self.calls: list[tuple[str, dict]] = []
        self.submit_outcome = "unknown"  # what an unsigned or signed submit returns: unknown | settle | crash
        self.status_outcome = "chain"  # chain | unavailable
        self.over_limit_ids: set[str] = set()

    async def call_tool(self, name: str, arguments: dict):
        self.calls.append((name, dict(arguments)))
        result = self.dispatch(name, arguments)
        return SimpleNamespace(content=[SimpleNamespace(text=json.dumps(result))])

    def dispatch(self, name: str, a: dict) -> dict:
        ok = lambda **r: {"ok": True, "result": r}  # noqa: E731
        error = lambda code: {"ok": False, "error": {"code": code, "message": code}}  # noqa: E731
        if name == "styx_propose_payment":
            payment_id = f"0x{len(self.proposed) + 1:064x}"
            self.proposed.append((a["invoice_reference"], payment_id))
            if a["amount"] == "6000000":
                self.over_limit_ids.add(payment_id)
            return ok(payment_id=payment_id, status="ok")
        if name == "styx_submit_payment":
            payment_id = a["payment_id"]
            if payment_id in self.over_limit_ids and not a.get("signature_name"):
                return error("OWNER_APPROVAL_REQUIRED")
            if payment_id in self.settled:
                return error("PAYMENT_ALREADY_SETTLED")
            if self.submit_outcome == "crash":
                raise RuntimeError("the process died while submitting")
            if self.submit_outcome == "settle":
                self.settled.add(payment_id)
                return ok(state="settled", status="ok", tx_hash="0x01")
            return ok(state="unknown", status="ok")
        if name == "styx_payment_status":
            if self.status_outcome == "unavailable":
                return error("VERIFICATION_UNAVAILABLE")
            return ok(state="settled" if a["payment_id"] in self.settled else "not_settled")
        if name == "styx_request_owner_approval":
            return ok(pending_file=f"pending-{a['payment_id'][2:14]}.json", approval_digest="0x02", status="ok")
        raise AssertionError(f"unexpected tool {name}")

    def routine_ids(self) -> list[str]:
        return [pid for ref, pid in self.proposed if ref == "INV-ROUTINE"]


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    async def instant(_seconds):
        return None
    monkeypatch.setattr(vault_agent.asyncio, "sleep", instant)


@pytest.fixture
def directory(tmp_path):
    directory = tmp_path / "vault"
    directory.mkdir(mode=0o700)
    return directory


def run_agent(fake: FakeVault, directory: Path, wait_seconds: int = 0) -> bool:
    """A new Agent every time, as a restarted process would be."""
    return asyncio.run(vault_agent.Agent(fake, VENDOR, directory).run(wait_seconds))


def test_restart_after_unknown_reconciles_the_kept_id_before_proposing(directory):
    fake = FakeVault()
    assert run_agent(fake, directory) is False  # every submit came back unknown
    first = fake.routine_ids()
    assert len(first) == 1

    fake.settled.add(first[0])  # the first payment lands after the agent gave up
    calls_before = len(fake.calls)
    run_agent(fake, directory)

    assert fake.routine_ids() == first, "a restart must not mint a second routine payment"
    second_run = [name for name, _ in fake.calls[calls_before:]]
    assert second_run[0] == "styx_payment_status", "the kept ID is looked up before anything else"
    assert fake.calls[calls_before][1]["payment_id"] == first[0]


def test_restart_with_the_payment_not_settled_retries_the_same_id(directory):
    fake = FakeVault()
    run_agent(fake, directory)
    first = fake.routine_ids()
    fake.submit_outcome = "settle"  # the retry now goes through
    calls_before = len(fake.calls)
    run_agent(fake, directory)

    assert fake.routine_ids() == first
    assert first[0] in fake.settled
    resubmitted = [a["payment_id"] for name, a in fake.calls[calls_before:] if name == "styx_submit_payment"]
    assert resubmitted and resubmitted[0] == first[0]


def test_restart_while_the_chain_is_unreadable_proposes_nothing_and_keeps_the_id(directory, capsys):
    fake = FakeVault()
    run_agent(fake, directory)
    first = fake.routine_ids()
    fake.status_outcome = "unavailable"  # VERIFICATION_UNAVAILABLE never means unpaid
    proposals_before = len(fake.proposed)
    capsys.readouterr()

    assert run_agent(fake, directory) is False
    assert len(fake.proposed) == proposals_before
    assert fake.routine_ids() == first
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    assert any(e.get("event") == "unknown_outcome" and e.get("payment_id") == first[0] for e in events), "uncertainty is stated, not hidden"


def test_the_id_is_kept_before_submitting_so_a_crash_cannot_lose_it(directory):
    fake = FakeVault()
    fake.submit_outcome = "crash"
    with pytest.raises(RuntimeError):
        run_agent(fake, directory)
    first = fake.routine_ids()
    assert len(first) == 1

    fake.submit_outcome = "settle"
    run_agent(fake, directory)
    assert fake.routine_ids() == first, "after the crash the next run found the ID it had kept"
    assert first[0] in fake.settled


def test_the_state_file_is_private(directory):
    fake = FakeVault()
    run_agent(fake, directory)
    state = directory / "vault_agent_state.json"
    assert state.exists()
    assert state.stat().st_mode & 0o077 == 0


def test_a_finished_run_proposes_nothing_when_run_again(directory):
    fake = FakeVault()
    fake.submit_outcome = "settle"
    # The owner's signature is already in place for the oversized payment (its name follows the agent's rule).
    oversized_id = f"0x{2:064x}"
    (directory / f"signature-{oversized_id[2:14]}.json").write_text("{}")
    assert run_agent(fake, directory, wait_seconds=1) is True
    proposed = list(fake.proposed)
    assert len(proposed) == 2

    assert run_agent(fake, directory, wait_seconds=1) is True
    assert fake.proposed == proposed, "nothing new is proposed once every payment is settled"


def test_an_unreadable_state_file_stops_the_run_before_anything_is_proposed(directory):
    # Ignoring it would mean minting a new ID while an older payment may still land.
    (directory / "vault_agent_state.json").write_text("{not json")
    fake = FakeVault()
    with pytest.raises(vault_agent.StateError) as raised:
        run_agent(fake, directory)
    assert "Nothing was proposed" in str(raised.value)
    assert fake.proposed == [] and fake.calls == []
    (directory / "vault_agent_state.json").write_text('["a list, not a mapping"]')
    with pytest.raises(vault_agent.StateError):
        run_agent(fake, directory)
