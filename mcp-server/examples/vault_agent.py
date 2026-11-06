#!/usr/bin/env python3
"""A scripted agent that uses only the vault's MCP tools. It has no model and no owner key.

It pays one routine invoice, asks for an oversized one, waits for the owner's signature, and retries
under the same payment ID when the outcome is unknown. Each line it prints is one JSON event.

Restarts: every payment ID is written to `vault_agent_state.json` in the vault directory before it is
submitted. A rerun looks up each kept ID on the chain before it proposes anything, retries an unsettled one
under the same ID, and proposes nothing while the chain cannot be read, because an unreadable answer never means
unpaid. The state file belongs to one pair of invoices: delete it only after checking the chain yourself.

Environment: the STYX_VAULT_* settings the server needs, including STYX_VAULT_DIR, which must hold the
invoice files. Usage: vault_agent.py <vendor-address> [--wait-seconds N]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROUTINE = ("250000", "routine-invoice.txt", "INV-ROUTINE")
OVERSIZED = ("6000000", "oversized-invoice.txt", "INV-OVERSIZED")
UNKNOWN_RETRIES = 5
STATE_FILE = "vault_agent_state.json"


def emit(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)


class StateError(Exception):
    """The state file exists but cannot be trusted. Carrying on would mean minting a new payment ID."""


class Agent:
    def __init__(self, session: ClientSession, vendor: str, directory: Path) -> None:
        self.session = session
        self.vendor = vendor
        self.directory = directory
        self.state_path = directory / STATE_FILE
        self.state = self._load_state()

    def _load_state(self) -> dict:
        try:
            raw = self.state_path.read_text()
        except FileNotFoundError:
            return {}
        try:
            state = json.loads(raw)
            if not isinstance(state, dict) or not all(isinstance(v, dict) for v in state.values()):
                raise ValueError("unexpected shape")
        except ValueError as error:
            raise StateError(f"{self.state_path} is unreadable ({error}). Check the chain for the payment IDs "
                             "you proposed, then fix or delete the file. Nothing was proposed.") from None
        return state

    def keep(self, step: str, **fields) -> None:
        """Writes the state atomically and privately. Called before a payment is first submitted."""
        self.state[step] = {**self.state.get(step, {}), **fields}
        temporary = self.state_path.with_suffix(".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(self.state, output)
        os.replace(temporary, self.state_path)

    async def tool(self, name: str, **arguments) -> dict:
        emit("call", tool=name, arguments=arguments)
        response = await self.session.call_tool(name, arguments)
        result = json.loads(response.content[0].text)
        emit("result", tool=name, result=result)
        return result

    async def propose(self, amount: str, invoice: str, reference: str) -> dict:
        return await self.tool("styx_propose_payment", recipient=self.vendor, amount=amount, invoice_name=invoice,
                               invoice_reference=reference, valid_until=int(time.time()) + 3600)

    async def settle(self, payment_id: str, signature: str | None = None) -> str:
        """Never mints a new payment to retry: an unknown outcome retries under the same ID."""
        for _ in range(UNKNOWN_RETRIES):
            arguments = {"payment_id": payment_id}
            if signature:
                arguments["signature_name"] = signature
            result = await self.tool("styx_submit_payment", **arguments)
            if not result["ok"]:
                if result["error"]["code"] != "VERIFICATION_UNAVAILABLE":
                    return result["error"]["code"]
            elif result["result"]["state"] != "unknown":
                return result["result"]["state"]
            await asyncio.sleep(3)
        return "unknown"

    async def reconcile(self, payment_id: str, signature: str | None = None) -> str:
        """Settles a kept payment ID without ever minting a new one: read the chain first, then retry the same ID."""
        status = await self.tool("styx_payment_status", payment_id=payment_id)
        if not status["ok"]:
            # VERIFICATION_UNAVAILABLE never means unpaid, so submitting blind is not safe either.
            return "unknown"
        state = status["result"].get("state")
        if state == "settled":
            return "settled"
        if state == "unavailable":
            return "unknown"
        return await self.settle(payment_id, signature)

    def unknown(self, step: str, payment_id: str) -> None:
        emit("unknown_outcome", step=step, payment_id=payment_id,
             note="not failed and not unpaid: rerun this script and it will reconcile this ID before proposing anything")

    async def pay_routine(self) -> bool:
        kept = self.state.get("routine", {})
        if kept.get("settled"):
            emit("already_settled", step="routine", payment_id=kept["payment_id"])
            return True
        if kept.get("payment_id"):
            payment_id = kept["payment_id"]
            emit("reconciling", step="routine", payment_id=payment_id)
            outcome = await self.reconcile(payment_id)
        else:
            routine = await self.propose(*ROUTINE)
            if not routine["ok"]:
                emit("failed", step="routine")
                return False
            payment_id = routine["result"]["payment_id"]
            self.keep("routine", payment_id=payment_id, settled=False)  # before the first submit
            outcome = await self.settle(payment_id)
        if outcome == "settled":
            self.keep("routine", settled=True)
            return True
        if outcome == "unknown":
            self.unknown("routine", payment_id)
        emit("failed", step="routine")
        return False

    async def pay_oversized(self, wait_seconds: int) -> bool:
        kept = self.state.get("oversized", {})
        if kept.get("settled"):
            emit("already_settled", step="oversized", payment_id=kept["payment_id"])
            return True
        if kept.get("payment_id"):
            payment_id = kept["payment_id"]
            emit("reconciling", step="oversized", payment_id=payment_id)
            status = await self.tool("styx_payment_status", payment_id=payment_id)
            if not status["ok"] or status["result"].get("state") == "unavailable":
                self.unknown("oversized", payment_id)
                emit("failed", step="oversized")
                return False
            if status["result"].get("state") == "settled":
                self.keep("oversized", settled=True)
                emit("done", outcome="settled", chain_state="settled")
                return True
        else:
            oversized = await self.propose(*OVERSIZED)
            if not oversized["ok"]:
                emit("failed", step="propose oversized")
                return False
            payment_id = oversized["result"]["payment_id"]
            self.keep("oversized", payment_id=payment_id, settled=False)  # before the first submit

        signature = f"signature-{payment_id.removeprefix('0x')[:12]}.json"
        if not (self.directory / signature).exists():
            # The agent tries anyway. The answer has to come from the rules, not from its restraint.
            refused = await self.settle(payment_id)
            emit("refused_without_owner", outcome=refused)
            if refused != "OWNER_APPROVAL_REQUIRED":
                emit("failed", step="expected a refusal")
                return False
            requested = await self.tool("styx_request_owner_approval", payment_id=payment_id,
                                        authorization_expiry=int(time.time()) + wait_seconds + 600)
            if not requested["ok"]:
                emit("failed", step="request approval")
                return False
            emit("waiting_for_owner", pending_file=requested["result"]["pending_file"], signature_file=signature,
                 approval_digest=requested["result"]["approval_digest"], payment_id=payment_id)
            deadline = time.time() + wait_seconds
            while not (self.directory / signature).exists():
                if time.time() > deadline:
                    emit("failed", step="the owner did not sign in time")
                    return False
                await asyncio.sleep(0.5)

        outcome = await self.reconcile(payment_id, signature)
        status = await self.tool("styx_payment_status", payment_id=payment_id)
        chain_state = status["result"]["state"] if status["ok"] else "unavailable"
        emit("done", outcome=outcome, chain_state=chain_state)
        if outcome == "settled":
            self.keep("oversized", settled=True)
            return True
        if outcome == "unknown":
            self.unknown("oversized", payment_id)
        return False

    async def run(self, wait_seconds: int) -> bool:
        if not await self.pay_routine():
            return False
        return await self.pay_oversized(wait_seconds)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vendor")
    parser.add_argument("--wait-seconds", type=int, default=900)
    args = parser.parse_args()
    directory = Path(os.environ["STYX_VAULT_DIR"])
    (directory / ROUTINE[1]).write_bytes(b"routine invoice: 0.25 USDC to vendor A\n")
    (directory / OVERSIZED[1]).write_bytes(b"oversized invoice: 6 USDC to vendor A\n")
    server = StdioServerParameters(command=sys.executable, args=["-m", "styx_mcp.server"],
                                   env={**os.environ, "STYX_BACKEND": "vault"})
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = sorted(tool.name for tool in (await session.list_tools()).tools)
            emit("tools", tools=tools)
            try:
                agent = Agent(session, args.vendor, directory)
            except StateError as error:
                emit("failed", step="state file", detail=str(error))
                return 2
            return 0 if await agent.run(args.wait_seconds) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
