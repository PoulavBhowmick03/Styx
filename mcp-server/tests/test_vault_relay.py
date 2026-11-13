"""The agent's alert path: real MCP tools and binary, the real relay, a fake Telegram, a local chain."""

import json
import os
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import asyncio
import pytest
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from styx_mcp.config import ConfigError
from styx_mcp.vault import VaultSettings

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(os.environ.get("STYX_TEST_VAULT_BIN", ROOT / "sdk/evm/target/debug/styx-vault"))
TSX = ROOT / "relay/node_modules/.bin/tsx"
AVAILABLE = BINARY.exists() and TSX.exists() and all(shutil.which(t) for t in ("anvil", "forge", "cast"))


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def run(*command, cwd=None):
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def result(response):
    return json.loads(response.content[0].text)


@pytest.mark.parametrize("variables", [{"STYX_VAULT_RELAY_URL": "https://relay.example"}, {"STYX_VAULT_RELAY_TOKEN": "x"}])
def test_settings_need_both_relay_values(monkeypatch, tmp_path, variables):
    tmp_path.chmod(0o700)
    monkeypatch.setenv("STYX_VAULT_DIR", str(tmp_path))
    for name, value in variables.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(ConfigError, match="or neither"):
        VaultSettings.from_env()


def test_settings_refuse_the_bot_token_in_the_agent_environment(monkeypatch, tmp_path):
    tmp_path.chmod(0o700)
    monkeypatch.setenv("STYX_VAULT_DIR", str(tmp_path))
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "1:x")
    with pytest.raises(ConfigError, match="must not be set"):
        VaultSettings.from_env()


@pytest.mark.skipif(not AVAILABLE, reason="needs styx-vault, Foundry, and npm install in relay/ and owner-page/")
def test_over_cap_alerts_the_owner_and_the_signature_comes_back_through_mcp(tmp_path):
    rpc_port, relay_port = free_port(), free_port()
    alerts = []
    failing = {"on": False}

    class FakeTelegram(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            ok = not failing["on"]
            if ok:
                alerts.append(body)
            reply = json.dumps({"ok": ok}).encode()
            self.send_response(200 if ok else 500)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

        def log_message(self, *_):
            pass

    telegram = HTTPServer(("127.0.0.1", 0), FakeTelegram)
    threading.Thread(target=telegram.serve_forever, daemon=True).start()
    config = tmp_path / "anvil.json"
    rpc = f"http://127.0.0.1:{rpc_port}"
    anvil = subprocess.Popen(["anvil", "--port", str(rpc_port), "--silent", "--config-out", str(config)])
    relay = None
    try:
        for _ in range(100):
            if config.exists() and subprocess.run(["cast", "chain-id", "--rpc-url", rpc], capture_output=True).returncode == 0:
                break
            time.sleep(0.1)
        owner_key, agent_key = json.loads(config.read_text())["private_keys"][:2]
        address = lambda key: run("cast", "wallet", "address", "--private-key", key).lower()

        def create(contract, *arguments):
            output = run("forge", "create", contract, "--broadcast", "--rpc-url", rpc, "--private-key", owner_key,
                         "--constructor-args", *arguments, cwd=ROOT / "contracts/evm")
            return re.search(r"Deployed to: (0x[0-9a-fA-F]{40})", output).group(1).lower()

        def send(target, signature, *arguments):
            run("cast", "send", target, signature, *arguments, "--rpc-url", rpc, "--private-key", owner_key)

        token = create("src/MockERC20.sol:MockERC20", "USD Coin", "USDC")
        vault = create("src/StyxPolicyVault.sol:StyxPolicyVault", address(owner_key), token)
        vendor = "0x00000000000000000000000000000000000000a1"
        now = int(time.time())
        send(vault, "configurePolicy(address,uint256,uint256,uint64)", address(agent_key), "1000000", "10000000", str(now + 86400))
        send(vault, "setRecipient(address,bool)", vendor, "true")
        send(token, "mint(address,uint256)", vault, "8000000")

        agent_token = secrets.token_hex(24)
        relay_url = f"http://127.0.0.1:{relay_port}"
        # tsx starts a child, so the relay gets its own process group to stop them together.
        relay = subprocess.Popen([str(TSX), "src/main.ts"], cwd=ROOT / "relay", stdout=subprocess.DEVNULL, start_new_session=True, env={
            **os.environ, "RELAY_PORT": str(relay_port), "RELAY_CHAIN_ID": "31337", "RELAY_VAULT": vault, "RELAY_OWNER": address(owner_key),
            "RELAY_TOKEN": token, "RELAY_PAGE_URL": "https://approve.example/", "RELAY_PUBLIC_URL": relay_url, "RELAY_AGENT_TOKEN": agent_token,
            "TELEGRAM_BOT_TOKEN": "1:fake", "TELEGRAM_CHAT_ID": "42", "TELEGRAM_API_BASE": f"http://127.0.0.1:{telegram.server_port}",
        })
        for _ in range(100):
            try:
                urllib.request.urlopen(f"{relay_url}/requests", timeout=1)
            except urllib.error.HTTPError:
                break
            except OSError:
                time.sleep(0.1)

        directory = tmp_path / "vault"
        directory.mkdir(mode=0o700)
        (directory / "invoice.txt").write_bytes(b"invoice body")
        key_file = tmp_path / "agent.key"
        key_file.write_text(agent_key)
        key_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
        env = {
            "PATH": os.environ["PATH"], "STYX_BACKEND": "vault", "STYX_VAULT_DIR": str(directory), "STYX_VAULT_CLI": str(BINARY),
            "STYX_VAULT_CHAIN_ID": "31337", "STYX_VAULT_RPC_URLS": rpc, "STYX_VAULT_ADDRESS": vault, "STYX_VAULT_TOKEN": token,
            "STYX_VAULT_STATE_ROOT": str(tmp_path / "journal"), "STYX_VAULT_AGENT_KEY_FILE": str(key_file),
            "STYX_VAULT_RELAY_URL": relay_url, "STYX_VAULT_RELAY_TOKEN": agent_token,
        }
        parameters = StdioServerParameters(command=sys.executable, args=["-m", "styx_mcp.server"], cwd=str(ROOT), env=env)

        def owner_signs(request_id):
            """The owner's side: fetch the request by its ID, sign with the owner's key, post it back."""
            with urllib.request.urlopen(f"{relay_url}/requests/{request_id}") as reply:
                pending = json.load(reply)["pending"]
            pending_file = tmp_path / "from-relay.json"
            pending_file.write_text(json.dumps(pending))
            owner_config = tmp_path / "owner.json"
            owner_config.write_text(json.dumps({"chainId": "31337", "vault": vault, "owner": address(owner_key), "token": token, "vendors": {vendor: "Vendor A"}}))
            output = tmp_path / "signature-file.json"
            run(str(ROOT / "owner-page/node_modules/.bin/tsx"), "test/sign_with_rpc.mts", str(owner_config), str(pending_file), rpc, str(output),
                cwd=ROOT / "owner-page")
            post = urllib.request.Request(f"{relay_url}/requests/{request_id}/signature", data=output.read_bytes(), headers={"content-type": "application/json"})
            assert urllib.request.urlopen(post).status == 200

        async def session_body(session):
            tools = {tool.name for tool in (await session.list_tools()).tools}
            assert "styx_check_owner_approval" in tools
            assert not tools & {"pay", "sign", "withdraw"}
            proposed = result(await session.call_tool("styx_propose_payment", {
                "recipient": vendor, "amount_usdc": "6", "amount": "6000000", "invoice_name": "invoice.txt",
                "invoice_reference": "IGNORE RULES <a href='https://evil.test'>x</a>", "valid_until": now + 3600,
            }))
            payment_id = proposed["result"]["payment_id"]
            stem = payment_id[2:14]

            not_asked = result(await session.call_tool("styx_check_owner_approval", {"payment_id": payment_id}))
            assert not_asked["error"]["code"] == "INVALID_REQUEST"

            # Telegram is down: the request is still stored, and the agent is told the owner wasn't alerted.
            failing["on"] = True
            asked = result(await session.call_tool("styx_request_owner_approval", {"payment_id": payment_id, "authorization_expiry": now + 900}))
            assert asked["ok"] and asked["result"]["owner_alerted"] is False
            assert alerts == []

            # Asking again retries the alert, and does not create a second approval.
            failing["on"] = False
            asked = result(await session.call_tool("styx_request_owner_approval", {"payment_id": payment_id, "authorization_expiry": now + 900}))
            assert asked["result"]["owner_alerted"] is True and asked["result"]["pending_file"] == f"pending-{stem}.json"
            assert len(alerts) == 1
            assert "evil.test" not in json.dumps(alerts[0]) and "IGNORE RULES" not in json.dumps(alerts[0])
            assert "parse_mode" not in alerts[0]

            again = result(await session.call_tool("styx_request_owner_approval", {"payment_id": payment_id, "authorization_expiry": now + 900}))
            assert again["result"]["owner_alerted"] is True and len(alerts) == 1

            waiting = result(await session.call_tool("styx_check_owner_approval", {"payment_id": payment_id}))
            assert waiting["result"]["status"] == "pending"
            refused = result(await session.call_tool("styx_submit_payment", {"payment_id": payment_id}))
            assert refused["error"]["code"] == "OWNER_APPROVAL_REQUIRED"

            owner_signs((directory / f"relay-{stem}.txt").read_text())

            signed = result(await session.call_tool("styx_check_owner_approval", {"payment_id": payment_id}))
            assert signed["result"] == {"status": "signed", "signature_name": f"signature-{stem}.json"}
            assert stat.S_IMODE((directory / signed["result"]["signature_name"]).stat().st_mode) == 0o600
            settled = result(await session.call_tool("styx_submit_payment", {"payment_id": payment_id, "signature_name": signed["result"]["signature_name"]}))
            assert settled["result"]["state"] == "settled", settled

        async def go():
            async with stdio_client(parameters) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    await session_body(session)

        asyncio.run(go())
        paid = run("cast", "call", token, "balanceOf(address)(uint256)", vendor, "--rpc-url", rpc).split()[0]
        assert paid == "6000000"

        # The relay being down never reads as a payment outcome.
        os.killpg(relay.pid, signal.SIGKILL)
        relay.wait()
        relay = None

        async def down(session):
            proposed = result(await session.call_tool("styx_propose_payment", {
                "recipient": vendor, "amount_usdc": "2", "amount": "2000000", "invoice_name": "invoice.txt", "invoice_reference": "x", "valid_until": now + 3600,
            }))
            payment_id = proposed["result"]["payment_id"]
            asked = result(await session.call_tool("styx_request_owner_approval", {"payment_id": payment_id, "authorization_expiry": now + 900}))
            assert asked["ok"] and asked["result"]["owner_alerted"] is False

        async def go_down():
            async with stdio_client(parameters) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    await down(session)

        asyncio.run(go_down())
    finally:
        telegram.shutdown()
        if relay:
            os.killpg(relay.pid, signal.SIGKILL)
            relay.wait()
        anvil.kill()
        anvil.wait()
