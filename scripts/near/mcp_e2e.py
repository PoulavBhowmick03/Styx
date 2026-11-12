"""End to end on NEAR testnet through the unchanged Styx MCP server and the NEAR relay.

The MCP server's vault tools drive `styx-near-vault`. An exception goes to `relay-near`; the test
approver stands in for the approval page: it reads the request from the relay, signs it with NEP-413
and posts the signature back, exactly as the page does after a wallet signs. The agent then fetches
the signature through the MCP tool and settles.

Needs a running relay (RELAY_URL, RELAY_TOKEN), the built CLI (STYX_NEAR_CLI), and the agent's NEAR
environment (STYX_NEAR_VAULT, STYX_NEAR_AGENT_KEY_FILE, STYX_NEAR_STATE_ROOT, STYX_NEAR_APPROVER),
plus APPROVER_KEY_FILE for the test approver and RECIPIENT and AMOUNT (base units, over the limit).

Usage: uv run --with pynacl --with base58 python scripts/near/mcp_e2e.py
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[2]


def result(reply) -> dict:
    return json.loads(reply.content[0].text)


def relay(path: str, body: dict | None = None, token: bool = False) -> dict:
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {os.environ['RELAY_TOKEN']}"
    request = urllib.request.Request(os.environ["RELAY_URL"] + path, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(request, timeout=20) as reply:  # noqa: S310 (local test relay)
        return json.loads(reply.read())


async def main() -> None:
    work = Path(tempfile.mkdtemp(prefix="styx-mcp-"))
    os.chmod(work, 0o700)
    (work / "invoice-2001.txt").write_text("Invoice 2001: model evaluation run\n")
    env = {
        **os.environ,
        "STYX_BACKEND": "vault",
        "STYX_VAULT_DIR": str(work),
        "STYX_VAULT_CLI": os.environ["STYX_NEAR_CLI"],
        "STYX_VAULT_RELAY_URL": os.environ["RELAY_URL"],
        "STYX_VAULT_RELAY_TOKEN": os.environ["RELAY_TOKEN"],
    }
    parameters = StdioServerParameters(command=sys.executable, args=["-m", "styx_mcp.server"], cwd=str(ROOT), env=env)
    async with stdio_client(parameters) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        tools = sorted(tool.name for tool in (await session.list_tools()).tools)
        print("tools:", ", ".join(tools))
        proposed = result(await session.call_tool("styx_propose_payment", {
            "recipient": os.environ["RECIPIENT"], "amount": os.environ["AMOUNT"],
            "invoice_name": "invoice-2001.txt", "invoice_reference": "INV-2001"}))
        print("propose:", proposed)
        payment_id = proposed["result"]["payment_id"]
        assert proposed["result"]["path"] == "exception_required", proposed
        refused = result(await session.call_tool("styx_submit_payment", {"payment_id": payment_id}))
        print("submit without approval:", refused)
        assert refused["error"]["code"] == "OWNER_APPROVAL_REQUIRED", refused
        asked = result(await session.call_tool("styx_request_owner_approval", {"payment_id": payment_id}))
        print("request approval:", asked)
        stem = payment_id.removeprefix("0x")[:12]
        request_id = (work / f"relay-{stem}.txt").read_text()
        waiting = result(await session.call_tool("styx_check_owner_approval", {"payment_id": payment_id}))
        print("check before signing:", waiting)
        assert waiting["result"]["status"] == "pending", waiting

        # The approval page's part: read the request from the relay, sign, post the signature.
        public = relay(f"/requests/{request_id}")
        pending_file = work / "approver-view.json"
        pending_file.write_text(json.dumps(public["pending"]))
        signature_file = work / "approver-signature.json"
        subprocess.run([sys.executable, str(ROOT / "scripts/near/test_approver.py"), os.environ["APPROVER_KEY_FILE"],
                        str(pending_file), str(signature_file)], check=True, capture_output=True)
        posted = relay(f"/requests/{request_id}/signature", json.loads(signature_file.read_text()))
        print("relay accepted signature:", posted)

        signed = result(await session.call_tool("styx_check_owner_approval", {"payment_id": payment_id}))
        print("check after signing:", signed)
        assert signed["result"]["status"] == "signed", signed
        settled = result(await session.call_tool("styx_submit_payment", {
            "payment_id": payment_id, "signature_name": signed["result"]["signature_name"]}))
        print("submit:", settled)
        assert settled["result"]["state"] == "settled", settled
        status = result(await session.call_tool("styx_payment_status", {"payment_id": payment_id}))
        print("status:", status)


if __name__ == "__main__":
    asyncio.run(main())
