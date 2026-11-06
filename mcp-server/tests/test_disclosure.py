"""Real stdio MCP calls over the built Rust disclosure binary, without a wallet or prover."""

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from styx_mcp.config import ConfigError
from styx_mcp.disclosure import DisclosureSettings

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(os.environ.get("STYX_TEST_DISCLOSURE_BIN", ROOT / "sdk/evm/target/debug/styx-disclosure"))


def test_settings_reject_insecure_directories(monkeypatch, tmp_path):
    monkeypatch.setenv("STYX_DISCLOSURE_DIR", str(tmp_path))
    tmp_path.chmod(0o755)
    with pytest.raises(ConfigError, match="owner-only"):
        DisclosureSettings.from_env()


@pytest.mark.parametrize("name", ["../key", "/key", "nested/key", ".", "..", "x" * 97])
def test_artifact_names_cannot_escape_the_operator_directory(tmp_path, name):
    settings = DisclosureSettings(artifacts=tmp_path, key_file=tmp_path / "auditor.key")
    from styx import DisclosureError
    with pytest.raises(DisclosureError):
        settings.artifact(name)


def test_symlink_directory_is_rejected(monkeypatch, tmp_path):
    actual = tmp_path / "actual"
    actual.mkdir(mode=0o700)
    link = tmp_path / "alias"
    link.symlink_to(actual, target_is_directory=True)
    monkeypatch.setenv("STYX_DISCLOSURE_DIR", str(link))
    with pytest.raises(ConfigError, match="real owner-only"):
        DisclosureSettings.from_env()


@pytest.mark.skipif(not BINARY.exists(), reason="build styx-disclosure to run real MCP tests")
def test_reviewer_stdio_server_uses_rust_keys(tmp_path):
    tmp_path.chmod(0o700)
    parameters = StdioServerParameters(
        command=sys.executable, args=["-m", "styx_mcp.server"], cwd=str(ROOT),
        env={"STYX_BACKEND": "disclosure", "STYX_DISCLOSURE_DIR": str(tmp_path),
             "STYX_DISCLOSURE_CLI": str(BINARY),
             "STYX_DISCLOSURE_VAULT_PINS": json.dumps({"chain_id": 5042002, "rpc_urls": ["http://127.0.0.1:1"], "vault": "0x" + "11" * 20, "vault_code_hash": "0x" + "22" * 32})},
    )

    async def run():
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = {tool.name for tool in (await session.list_tools()).tools}
                assert tools == {"create_disclosure_key", "disclosure_key_info", "verify_vault_payment"}
                def result(response):
                    return response.structured_content or json.loads(response.content[0].text)
                created = result(await session.call_tool("create_disclosure_key", {}))
                assert created["ok"] is True
                key = created["result"]["recipient_public_key"]
                restored = result(await session.call_tool("disclosure_key_info", {}))
                assert restored["result"]["recipient_public_key"] == key
                duplicate = result(await session.call_tool("create_disclosure_key", {}))
                assert duplicate["ok"] is False
                missing = result(await session.call_tool("verify_vault_payment", {
                    "grant_name": "missing.grant", "expected_issuer": "0x" + "11" * 20,
                }))
                assert missing["ok"] is False
                escape = result(await session.call_tool("verify_vault_payment", {
                    "grant_name": "../outside.grant", "expected_issuer": "0x" + "11" * 20,
                }))
                assert escape["ok"] is False
                assert escape["error"]["code"] == "INVALID_ARTIFACT"
                assert "private_key" not in json.dumps(created)
    asyncio.run(run())
