"""The agent's MCP tools: real stdio calls over a scripted binary, and over the real one on anvil."""

import asyncio
import json
import os
import re
import socket
import stat
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest
from styx import VaultError, VaultSeam
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from styx_mcp.config import ConfigError
from styx_mcp.vault import VaultSettings

ROOT = Path(__file__).resolve().parents[2]
TOOLS = {"styx_propose_payment", "styx_request_owner_approval", "styx_submit_payment", "styx_payment_status"}


def scripted_binary(tmp_path: Path, responses: dict[str, tuple[dict, int]]) -> Path:
    """A stand-in binary that logs each request and replies from a table keyed by method."""
    path = tmp_path / "fake-vault"
    path.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import json, sys
        request = json.load(sys.stdin)
        with open({str(tmp_path / "requests.log")!r}, "a") as log:
            log.write(json.dumps(request) + "\\n")
        table = {json.dumps(responses)!r}
        response, code = json.loads(table).get(request["method"], [{{"status": "ok", "protocol": 1}}, 0])
        print(json.dumps(response))
        sys.exit(code)
    """))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


def result(response):
    return json.loads(response.content[0].text)


def run_session(env: dict[str, str], body):
    parameters = StdioServerParameters(
        command=sys.executable, args=["-m", "styx_mcp.server"], cwd=str(ROOT),
        env={"STYX_BACKEND": "vault", "PATH": os.environ.get("PATH", ""), **env},
    )

    async def run():
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await body(session)

    return asyncio.run(run())


def private_dir(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def test_settings_reject_insecure_directories(monkeypatch, tmp_path):
    monkeypatch.delenv("STYX_VAULT_DIR", raising=False)
    with pytest.raises(ConfigError, match="must name"):
        VaultSettings.from_env()
    monkeypatch.setenv("STYX_VAULT_DIR", str(tmp_path))
    tmp_path.chmod(0o755)
    with pytest.raises(ConfigError, match="owner-only"):
        VaultSettings.from_env()


@pytest.mark.parametrize("name", ["STYX_VAULT_OWNER_KEY_FILE", "STYX_DISCLOSURE_KEY_FILE"])
def test_settings_refuse_other_roles_keys_in_the_agent_environment(monkeypatch, tmp_path, name):
    tmp_path.chmod(0o700)
    monkeypatch.setenv("STYX_VAULT_DIR", str(tmp_path))
    monkeypatch.setenv(name, "/somewhere/key")
    with pytest.raises(ConfigError, match="must not be set"):
        VaultSettings.from_env()


@pytest.mark.parametrize("name", ["../key", "/key", "nested/key", ".", "..", "x" * 97])
def test_artifact_names_cannot_escape_the_directory(tmp_path, name):
    with pytest.raises(VaultError):
        VaultSettings(artifacts=tmp_path).artifact(name)


def test_seam_rejects_unexpected_fields_and_unknown_codes(tmp_path):
    binary = scripted_binary(tmp_path, {
        "status": [{"status": "ok", "private_key": "SECRET"}, 0],
        "submit": [{"status": "error", "code": "SOMETHING_ELSE", "message": "x"}, 1],
    })
    seam = VaultSeam(binary=binary)
    with pytest.raises(VaultError) as leaked:
        seam.call("status", payment_id="0x01")
    assert leaked.value.code == "VERIFICATION_UNAVAILABLE"
    assert "SECRET" not in str(leaked.value)
    with pytest.raises(VaultError) as unknown:
        seam.call("submit", payment_id="0x01", signature_file=None)
    assert unknown.value.code == "VERIFICATION_UNAVAILABLE"
    with pytest.raises(VaultError) as invalid:
        seam.call("status", payment_id="0x01", private_key="x")
    assert invalid.value.code == "INVALID_REQUEST"


def test_seam_reports_a_missing_process_as_unavailable(tmp_path):
    seam = VaultSeam(binary=tmp_path / "missing")
    with pytest.raises(VaultError) as error:
        seam.call("status", payment_id="0x01")
    assert error.value.code == "VERIFICATION_UNAVAILABLE"


def test_tools_expose_exactly_the_agent_surface_and_pass_structured_errors(tmp_path):
    directory = private_dir(tmp_path / "vault")
    binary = scripted_binary(tmp_path, {
        "version": [{"status": "ok", "protocol": 1}, 0],
        "propose": [{"status": "ok", "payment_id": "0x" + "ab" * 32, "payment_hash": "0x" + "cd" * 32,
                     "path": "exception_required"}, 0],
        "request_approval": [{"status": "ok", "pending_file": "/abs/path", "approval_digest": "0x" + "ef" * 32}, 0],
        "submit": [{"status": "error", "code": "OWNER_APPROVAL_REQUIRED", "message": "needs the owner"}, 1],
        "status": [{"status": "error", "code": "VERIFICATION_UNAVAILABLE", "message": "rpc down"}, 1],
    })

    async def body(session):
        tools = {tool.name for tool in (await session.list_tools()).tools}
        assert tools == TOOLS
        proposed = result(await session.call_tool("styx_propose_payment", {
            "recipient": "0x" + "a1" * 20, "amount_usdc": "6", "amount": "6000000", "invoice_name": "invoice.txt",
            "invoice_reference": "INV-1", "valid_until": 1800000000,
        }))
        assert proposed["ok"] and proposed["result"]["path"] == "exception_required"
        assert proposed["result"]["next_action"].startswith("Over the per-payment limit: call styx_request_owner_approval")
        assert proposed["result"]["summary"] == "6 USDC (6000000 base units) to " + "0x" + "a1" * 20
        payment_id = proposed["result"]["payment_id"]

        requested = result(await session.call_tool("styx_request_owner_approval", {
            "payment_id": payment_id, "authorization_expiry": 1800000000,
        }))
        # The agent sees a name inside its directory, not an absolute path.
        assert requested["result"]["pending_file"] == f"pending-{'ab' * 6}.json"

        refused = result(await session.call_tool("styx_submit_payment", {"payment_id": payment_id}))
        assert refused == {"ok": False, "error": {"code": "OWNER_APPROVAL_REQUIRED", "message": "needs the owner",
                                                  "next_action": "Call styx_request_owner_approval with this payment_id, "
                                                                 "then wait for the approver's signature."}}

        unavailable = result(await session.call_tool("styx_payment_status", {"payment_id": payment_id}))
        assert unavailable["error"]["code"] == "VERIFICATION_UNAVAILABLE"

        escape = result(await session.call_tool("styx_propose_payment", {
            "recipient": "0x" + "a1" * 20, "amount_usdc": "0.000001", "amount": "1", "invoice_name": "../outside",
            "invoice_reference": "x", "valid_until": 1,
        }))
        assert escape["error"]["code"] == "INVALID_REQUEST"
        assert escape["error"]["next_action"].startswith("Pass only the file's name")

    run_session({"STYX_VAULT_DIR": str(directory), "STYX_VAULT_CLI": str(binary)}, body)

    requests = [json.loads(line) for line in (tmp_path / "requests.log").read_text().splitlines()]
    assert all("../outside" not in json.dumps(request) for request in requests)
    proposal = next(request for request in requests if request["method"] == "propose")
    assert proposal["invoice_file"] == str(directory.resolve() / "invoice.txt")
    assert proposal["amount"] == "6000000"
    assert next(request for request in requests if request["method"] == "submit").keys() == {"method", "payment_id"}


def test_models_can_leave_the_timestamps_out(tmp_path):
    directory = private_dir(tmp_path / "vault")
    binary = scripted_binary(tmp_path, {
        "propose": [{"status": "ok", "payment_id": "0x" + "ab" * 32, "path": "exception_required"}, 0],
        "request_approval": [{"status": "ok", "pending_file": "/x", "approval_digest": "0x" + "ef" * 32}, 0],
    })

    async def body(session):
        await session.call_tool("styx_propose_payment", {
            "recipient": "0x" + "a1" * 20, "amount_usdc": "0.000001", "amount": "1", "invoice_name": "i.txt", "invoice_reference": "x",
        })
        await session.call_tool("styx_request_owner_approval", {"payment_id": "0x" + "ab" * 32})

    before = int(time.time())
    run_session({"STYX_VAULT_DIR": str(directory), "STYX_VAULT_CLI": str(binary)}, body)
    requests = {json.loads(line)["method"]: json.loads(line) for line in (tmp_path / "requests.log").read_text().splitlines()}
    assert before + 3500 < requests["propose"]["valid_until"] < before + 3700
    assert before + 3500 < requests["request_approval"]["authorization_expiry"] < before + 3700


def test_a_named_approver_reaches_the_binary_on_v2_and_is_refused_on_v1(tmp_path):
    approver = "0x" + "ab" * 20
    for version, expected_ok in ((2, True), (1, False)):
        directory = private_dir(tmp_path / f"v{version}")
        capture = directory / "requests.log"
        script = directory / "fake-vault"
        script.write_text(textwrap.dedent(f"""\
            #!{sys.executable}
            import json, sys
            request = json.load(sys.stdin)
            open({str(capture)!r}, "a").write(json.dumps(request) + "\\n")
            if request["method"] == "version":
                print(json.dumps({{"status": "ok", "protocol": 1, "contract_version": {version}}}))
            else:
                print(json.dumps({{"status": "ok", "pending_file": request.get("pending_file"), "approval_digest": "0x" + "11" * 32}}))
            """))
        script.chmod(0o700)

        async def body(session):
            reply = result(await session.call_tool("styx_request_owner_approval", {"payment_id": "0x" + "cd" * 32, "signer": approver}))
            assert reply["ok"] is expected_ok, reply
            if expected_ok:
                assert reply["result"]["pending_file"] == f"pending-{'cd' * 6}-{'ab' * 4}.json"
            bad = result(await session.call_tool("styx_request_owner_approval", {"payment_id": "0x" + "cd" * 32, "signer": "not-an-address"}))
            assert bad["ok"] is False

        run_session({"STYX_VAULT_DIR": str(directory), "STYX_VAULT_CLI": str(script)}, body)
        forwarded = [json.loads(line) for line in capture.read_text().splitlines()]
        sent = [request for request in forwarded if request["method"] == "request_approval"]
        assert [request.get("signer") for request in sent] == ([approver] if expected_ok else [])


def test_a_registered_agent_asks_the_approver_its_owner_chose_and_reports_when_they_must_link(tmp_path):
    import http.server
    import threading

    approver = "0x" + "ef" * 20
    class Handler(http.server.BaseHTTPRequestHandler):
        def _reply(self, body):
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_GET(self):
            self._reply({"vault": "0x" + "11" * 20, "agent": "0x" + "22" * 20, "approver": approver})
        def do_POST(self):
            self.rfile.read(int(self.headers["content-length"]))
            self._reply({"requestId": "a" * 22, "alerted": False, "needsLink": True})
        def log_message(self, *_):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    directory = private_dir(tmp_path / "agent")
    capture = directory / "requests.log"
    script = directory / "fake-vault"
    script.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import json, sys
        request = json.load(sys.stdin)
        open({str(capture)!r}, "a").write(json.dumps(request) + "\\n")
        if request["method"] == "version":
            print(json.dumps({{"status": "ok", "protocol": 1, "contract_version": 2}}))
        else:
            open(request["pending_file"], "w").write("{{}}")
            print(json.dumps({{"status": "ok", "pending_file": request["pending_file"], "approval_digest": "0x" + "11" * 32}}))
        """))
    script.chmod(0o700)

    async def body(session):
        reply = result(await session.call_tool("styx_request_owner_approval", {"payment_id": "0x" + "cd" * 32}))
        assert reply["ok"] is True, reply
        assert reply["result"]["owner_alerted"] is False
        assert reply["result"]["approver_needs_to_link_telegram"] is True

    try:
        run_session({"STYX_VAULT_DIR": str(directory), "STYX_VAULT_CLI": str(script),
                     "STYX_VAULT_RELAY_URL": f"http://127.0.0.1:{server.server_port}", "STYX_VAULT_RELAY_TOKEN": "t" * 32}, body)
    finally:
        server.shutdown()
    sent = [json.loads(line) for line in capture.read_text().splitlines()]
    assert [request.get("signer") for request in sent if request["method"] == "request_approval"] == [approver]


def test_usdc_and_base_unit_amounts_must_agree(tmp_path):
    """The unit mistake seen live: "30" sent as base units for a 30 USDC invoice is refused."""
    directory = tmp_path / "vault"
    directory.mkdir(mode=0o700)
    (directory / "invoice.txt").write_text("30 USDC")
    binary = scripted_binary(tmp_path, {
        "version": [{"status": "ok", "protocol": 1, "contract_version": 1}, 0],
        "propose": [{"status": "ok", "payment_id": "0x" + "ab" * 32, "payment_hash": "0x" + "cd" * 32, "path": "ordinary"}, 0],
    })

    async def body(session):
        async def propose(usdc, base):
            return result(await session.call_tool("styx_propose_payment", {
                "recipient": "vendor.testnet", "amount_usdc": usdc, "amount": base,
                "invoice_name": "invoice.txt", "invoice_reference": "INV-30"}))
        wrong = await propose("30", "30")
        assert wrong["error"]["code"] == "INVALID_REQUEST" and "30000000" in wrong["error"]["message"]
        assert (await propose("30 USDC", "30000000"))["error"]["code"] == "INVALID_REQUEST"
        assert (await propose("0.1234567", "123456"))["error"]["code"] == "INVALID_REQUEST"
        assert (await propose("30", "30000000"))["ok"]
        assert (await propose("0.5", "500000"))["ok"]

    run_session({"STYX_VAULT_DIR": str(directory), "STYX_VAULT_CLI": str(binary)}, body)
    proposals = [json.loads(line) for line in (tmp_path / "requests.log").read_text().splitlines()
                 if json.loads(line)["method"] == "propose"]
    # Only the two agreeing proposals reached the binary, in base units.
    assert [p["amount"] for p in proposals] == ["30000000", "500000"]


def test_a_near_approver_key_is_accepted_on_any_vault_and_names_its_file(tmp_path):
    approver = "ed25519:mA3qigk1SJQ85o3RGcd32hEHoGM6bjDCvjekyQtNZ2N"
    directory = private_dir(tmp_path / "near")
    capture = directory / "requests.log"
    script = directory / "fake-vault"
    script.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import json, sys
        request = json.load(sys.stdin)
        open({str(capture)!r}, "a").write(json.dumps(request) + "\\n")
        if request["method"] == "version":
            print(json.dumps({{"status": "ok", "protocol": 1, "contract_version": 1}}))
        else:
            print(json.dumps({{"status": "ok", "pending_file": request.get("pending_file"), "approval_digest": "0x" + "11" * 32}}))
        """))
    script.chmod(0o700)

    async def body(session):
        reply = result(await session.call_tool("styx_request_owner_approval", {"payment_id": "0x" + "cd" * 32, "signer": approver}))
        assert reply["ok"], reply
        assert reply["result"]["pending_file"] == f"pending-{'cd' * 6}-mA3qigk1.json"
        assert "Do not propose again" in reply["result"]["next_action"]
        for bad in ("0x" + "ab" * 20, "ed25519:short", "not-a-key"):
            refused = result(await session.call_tool("styx_request_owner_approval", {"payment_id": "0x" + "cd" * 32, "signer": bad}))
            assert refused["ok"] is False and "ed25519" in refused["error"]["message"]

    run_session({"STYX_VAULT_DIR": str(directory), "STYX_VAULT_CLI": str(script)}, body)
    sent = [json.loads(line) for line in capture.read_text().splitlines() if json.loads(line)["method"] == "request_approval"]
    assert [request.get("signer") for request in sent] == [approver]
