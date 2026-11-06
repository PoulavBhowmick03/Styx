"""Run a real MCP access client against test-provided private paths and endpoint."""

import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


async def run():
    evidence, key, url, service_id, cache, binary = sys.argv[1:7]
    expected = sys.argv[7] if len(sys.argv) > 7 else "retrieved"
    evidence = Path(evidence)
    environment = {
        "STYX_BACKEND": "access", "STYX_ACCESS_EVIDENCE_DIR": str(evidence.parent),
        "STYX_ACCESS_BUYER_KEY_FILE": key, "STYX_ACCESS_SERVICE_URL": url,
        "STYX_ACCESS_SERVICE_ID": service_id, "STYX_ACCESS_CACHE": cache,
        "STYX_ACCESS_CLI": binary, "STYX_ALLOW_LOOPBACK_ACCESS_HTTP": "1",
    }
    if expected == "x402_cached":
        environment["STYX_ACCESS_PAYMENT_RAIL"] = "x402-exact"
    if binary == "installed":
        import styx, styx_mcp
        prefix = Path(sys.prefix).resolve()
        assert all(Path(module.__file__).resolve().is_relative_to(prefix) for module in (styx, styx_mcp))
        del environment["STYX_ACCESS_CLI"]
        environment["PATH"] = str(prefix / "bin") + os.pathsep + "/usr/bin:/bin"
    params = StdioServerParameters(command=sys.executable, args=["-I", "-m", "styx_mcp.server"], cwd=str(evidence.parent), env=environment)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            assert {tool.name for tool in (await session.list_tools()).tools} == {"retrieve_service_access"}
            if expected == "paid_but_undelivered":
                response = await session.call_tool("retrieve_service_access", {"evidence_name": evidence.name})
                output = response.structured_content or json.loads(response.content[0].text)
                assert output["ok"] is False
                assert output["result"]["status"] == expected
                assert output["result"]["seller_reported_payment_finalized"] is True
                assert output["result"]["payment_verified"] is False
                assert output["result"]["resource_verified"] is False
                assert output["result"]["retry_without_payment"] is True
                print(json.dumps({"seller_reported_undelivered": True, "payment_verified": False}))
                return
            for cached in ([True, True] if expected == "x402_cached" else [False, True]):
                response = await session.call_tool("retrieve_service_access", {"evidence_name": evidence.name})
                output = response.structured_content or json.loads(response.content[0].text)
                assert output["ok"] is True, output
                assert output["result"]["status"] == "retrieved"
                receipt = output["result"]["result"]
                assert receipt["resource_verified"] is True
                assert receipt["cached"] is cached
                assert receipt["payment_verified"] is False
                assert receipt["seller_reported_payment_finalized"] is True
                assert receipt["delivery_verified"] is False
                assert "payload_hex" not in receipt
                assert Path(receipt["resource_file"]).is_file()
    print(json.dumps({"mcp_access_verified": True, "cache_reused": True, "payment_verified": False,
                      "source_imports": binary != "installed"}))


if __name__ == "__main__":
    asyncio.run(run())
