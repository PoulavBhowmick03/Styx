#!/usr/bin/env python3
"""A scripted agent that uses only the vault's MCP tools. It has no model and no owner key.

It pays one routine invoice, asks for an oversized one, waits for the owner's signature, and retries
under the same payment ID when the outcome is unknown. Each line it prints is one JSON event.

Environment: the EREBUS_VAULT_* settings the server needs, including EREBUS_VAULT_DIR, which must hold the
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


def emit(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)


class Agent:
    def __init__(self, session: ClientSession, vendor: str, directory: Path) -> None:
        self.session = session
        self.vendor = vendor
        self.directory = directory

    async def tool(self, name: str, **arguments) -> dict:
        emit("call", tool=name, arguments=arguments)
        response = await self.session.call_tool(name, arguments)
        result = json.loads(response.content[0].text)
        emit("result", tool=name, result=result)
        return result

    async def propose(self, amount: str, invoice: str, reference: str) -> dict:
        return await self.tool("erebus_propose_payment", recipient=self.vendor, amount=amount, invoice_name=invoice,
                               invoice_reference=reference, valid_until=int(time.time()) + 3600)

    async def settle(self, payment_id: str, signature: str | None = None) -> str:
        """Never mints a new payment to retry: an unknown outcome retries under the same ID."""
        for _ in range(UNKNOWN_RETRIES):
            arguments = {"payment_id": payment_id}
            if signature:
                arguments["signature_name"] = signature
            result = await self.tool("erebus_submit_payment", **arguments)
            if not result["ok"]:
                if result["error"]["code"] != "VERIFICATION_UNAVAILABLE":
                    return result["error"]["code"]
            elif result["result"]["state"] != "unknown":
                return result["result"]["state"]
            await asyncio.sleep(3)
        return "unknown"

    async def run(self, wait_seconds: int) -> bool:
        routine = await self.propose(*ROUTINE)
        if not routine["ok"] or await self.settle(routine["result"]["payment_id"]) != "settled":
            emit("failed", step="routine")
            return False

        oversized = await self.propose(*OVERSIZED)
        if not oversized["ok"]:
            emit("failed", step="propose oversized")
            return False
        payment_id = oversized["result"]["payment_id"]
        # The agent tries anyway. The answer has to come from the rules, not from its restraint.
        refused = await self.settle(payment_id)
        emit("refused_without_owner", outcome=refused)
        if refused != "OWNER_APPROVAL_REQUIRED":
            emit("failed", step="expected a refusal")
            return False

        requested = await self.tool("erebus_request_owner_approval", payment_id=payment_id,
                                    authorization_expiry=int(time.time()) + wait_seconds + 600)
        if not requested["ok"]:
            emit("failed", step="request approval")
            return False
        signature = f"signature-{payment_id.removeprefix('0x')[:12]}.json"
        emit("waiting_for_owner", pending_file=requested["result"]["pending_file"], signature_file=signature,
             approval_digest=requested["result"]["approval_digest"], payment_id=payment_id)
        deadline = time.time() + wait_seconds
        while not (self.directory / signature).exists():
            if time.time() > deadline:
                emit("failed", step="the owner did not sign in time")
                return False
            await asyncio.sleep(0.5)

        outcome = await self.settle(payment_id, signature)
        status = await self.tool("erebus_payment_status", payment_id=payment_id)
        emit("done", outcome=outcome, chain_state=status["result"]["state"] if status["ok"] else "unavailable")
        return outcome == "settled"


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vendor")
    parser.add_argument("--wait-seconds", type=int, default=900)
    args = parser.parse_args()
    directory = Path(os.environ["EREBUS_VAULT_DIR"])
    (directory / ROUTINE[1]).write_bytes(b"routine invoice: 0.25 USDC to vendor A\n")
    (directory / OVERSIZED[1]).write_bytes(b"oversized invoice: 6 USDC to vendor A\n")
    server = StdioServerParameters(command=sys.executable, args=["-m", "erebus_mcp.server"],
                                   env={**os.environ, "EREBUS_BACKEND": "vault"})
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = sorted(tool.name for tool in (await session.list_tools()).tools)
            emit("tools", tools=tools)
            return 0 if await Agent(session, args.vendor, directory).run(args.wait_seconds) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
