"""Regression against the owned MCP adapter, without changing it or using any key.

Run: uv run pytest sdk/evm/tests/v2_mcp_review.py -q
This test intentionally fails until the adapter refreshes an expired v2 approval.
"""
import asyncio
import json
from contextlib import contextmanager

from styx_mcp import vault


def test_existing_v2_pending_file_must_not_skip_a_requested_refresh(monkeypatch, tmp_path):
    calls = []
    tools = {}
    signer = "0x5000000000000000000000000000000000000005"
    payment_id = "0x" + "12" * 32
    stale = tmp_path / f"pending-{payment_id[2:14]}-{signer[2:10]}.json"
    stale.write_text(json.dumps({"schema": "vault-pending-approval/2",
                                 "authorization": {"authorizationExpiry": "1"}}))

    class FakeSeam:
        def __init__(self, **kwargs):
            pass

        def call(self, method, **parameters):
            calls.append((method, parameters))
            return {"status": "ok", "protocol": 1, "contract_version": 2}

    class FakeServer:
        def __init__(self, **kwargs):
            pass

        def tool(self):
            def register(function):
                tools[function.__name__] = function
                return function
            return register

    @contextmanager
    def reply(*args, **kwargs):
        class Response:
            def read(self, size):
                return json.dumps({"requestId": "a" * 24, "alerted": True}).encode()
        yield Response()

    monkeypatch.setattr(vault, "VaultSeam", FakeSeam)
    monkeypatch.setattr(vault, "MCPServer", FakeServer)
    monkeypatch.setattr(vault.urllib.request, "urlopen", reply)
    settings = vault.VaultSettings(artifacts=tmp_path, binary="unused-test-binary",
                                    relay_url="https://relay.example", relay_token="local-test-credential")
    vault.build_vault_server(settings)
    result = asyncio.run(tools["styx_request_owner_approval"](
        payment_id, authorization_expiry=1_900_000_600, signer=signer))
    assert result["ok"]
    refreshed = [parameters for method, parameters in calls if method == "request_approval"]
    assert refreshed, "adapter re-sent the expired file without asking the SDK to renew it"
    assert refreshed[-1]["authorization_expiry"] == 1_900_000_600
