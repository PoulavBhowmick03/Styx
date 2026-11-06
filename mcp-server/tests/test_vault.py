"""The agent's MCP tools: real stdio calls over a scripted binary, and over the real one on anvil."""

import asyncio
import json
import os
import re
import shutil
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
BINARY = Path(os.environ.get("STYX_TEST_VAULT_BIN", ROOT / "sdk/evm/target/debug/styx-vault"))
DISCLOSURE_BINARY = Path(os.environ.get("STYX_TEST_DISCLOSURE_BIN", ROOT / "sdk/evm/target/debug/styx-disclosure"))
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
            "recipient": "0x" + "a1" * 20, "amount": "6000000", "invoice_name": "invoice.txt",
            "invoice_reference": "INV-1", "valid_until": 1800000000,
        }))
        assert proposed["ok"] and proposed["result"]["path"] == "exception_required"
        payment_id = proposed["result"]["payment_id"]

        requested = result(await session.call_tool("styx_request_owner_approval", {
            "payment_id": payment_id, "authorization_expiry": 1800000000,
        }))
        # The agent sees a name inside its directory, not an absolute path.
        assert requested["result"]["pending_file"] == f"pending-{'ab' * 6}.json"

        refused = result(await session.call_tool("styx_submit_payment", {"payment_id": payment_id}))
        assert refused == {"ok": False, "error": {"code": "OWNER_APPROVAL_REQUIRED", "message": "needs the owner"}}

        unavailable = result(await session.call_tool("styx_payment_status", {"payment_id": payment_id}))
        assert unavailable["error"]["code"] == "VERIFICATION_UNAVAILABLE"

        escape = result(await session.call_tool("styx_propose_payment", {
            "recipient": "0x" + "a1" * 20, "amount": "1", "invoice_name": "../outside",
            "invoice_reference": "x", "valid_until": 1,
        }))
        assert escape["error"]["code"] == "INVALID_REQUEST"

    run_session({"STYX_VAULT_DIR": str(directory), "STYX_VAULT_CLI": str(binary)}, body)

    requests = [json.loads(line) for line in (tmp_path / "requests.log").read_text().splitlines()]
    assert all("../outside" not in json.dumps(request) for request in requests)
    proposal = next(request for request in requests if request["method"] == "propose")
    assert proposal["invoice_file"] == str(directory.resolve() / "invoice.txt")
    assert proposal["amount"] == "6000000"
    assert next(request for request in requests if request["method"] == "submit").keys() == {"method", "payment_id"}


TOOLS_AVAILABLE = BINARY.exists() and all(shutil.which(tool) for tool in ("anvil", "forge", "cast"))


@pytest.mark.skipif(not TOOLS_AVAILABLE, reason="build styx-vault and install Foundry to run this test")
def test_agent_pays_and_is_refused_through_mcp_on_a_real_chain(tmp_path):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    config = tmp_path / "anvil.json"
    anvil = subprocess.Popen(["anvil", "--port", str(port), "--silent", "--config-out", str(config)])
    rpc = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            ready = config.exists() and subprocess.run(
                ["cast", "chain-id", "--rpc-url", rpc], capture_output=True).returncode == 0
            if ready:
                break
            time.sleep(0.1)
        keys = json.loads(config.read_text())["private_keys"]
        owner_key, agent_key = keys[0], keys[1]
        contracts = ROOT / "contracts/evm"

        def create(contract, *arguments):
            output = subprocess.run(
                ["forge", "create", contract, "--broadcast", "--rpc-url", rpc, "--private-key", owner_key,
                 "--constructor-args", *arguments],
                cwd=contracts, capture_output=True, text=True, check=True).stdout
            return re.search(r"Deployed to: (0x[0-9a-fA-F]{40})", output).group(1).lower()

        def send(target, signature, *arguments):
            subprocess.run(["cast", "send", target, signature, *arguments, "--rpc-url", rpc,
                            "--private-key", owner_key], capture_output=True, check=True)

        def address(key):
            return subprocess.run(["cast", "wallet", "address", "--private-key", key], capture_output=True,
                                  text=True, check=True).stdout.strip().lower()

        def balance_of(token, account):
            output = subprocess.run(["cast", "call", token, "balanceOf(address)(uint256)", account, "--rpc-url", rpc],
                                    capture_output=True, text=True, check=True).stdout
            return int(output.split()[0])

        token = create("src/MockERC20.sol:MockERC20", "USD Coin", "USDC")
        vault = create("src/StyxPolicyVault.sol:StyxPolicyVault", address(owner_key), token)
        vendor = "0x00000000000000000000000000000000000000a1"
        now = int(time.time())
        send(vault, "configurePolicy(address,uint256,uint256,uint64)", address(agent_key), "1000000", "10000000",
             str(now + 86400))
        send(vault, "setRecipient(address,bool)", vendor, "true")
        send(token, "mint(address,uint256)", vault, "8000000")

        directory = private_dir(tmp_path / "vault")
        (directory / "invoice.txt").write_bytes(b"invoice body")
        key_file = tmp_path / "agent.key"
        key_file.write_text(agent_key)
        key_file.chmod(0o600)
        env = {
            "STYX_VAULT_DIR": str(directory), "STYX_VAULT_CLI": str(BINARY),
            "STYX_VAULT_CHAIN_ID": "31337", "STYX_VAULT_RPC_URLS": rpc,
            "STYX_VAULT_ADDRESS": vault, "STYX_VAULT_TOKEN": token,
            "STYX_VAULT_STATE_ROOT": str(tmp_path / "journal"), "STYX_VAULT_AGENT_KEY_FILE": str(key_file),
        }

        async def propose(session, amount):
            return result(await session.call_tool("styx_propose_payment", {
                "recipient": vendor, "amount": amount, "invoice_name": "invoice.txt",
                "invoice_reference": "INV-1", "valid_until": now + 3600,
            }))

        async def body(session):
            ordinary = await propose(session, "250000")
            assert ordinary["ok"], ordinary
            assert ordinary["result"]["path"] == "ordinary"
            payment_id = ordinary["result"]["payment_id"]
            settled = result(await session.call_tool("styx_submit_payment", {"payment_id": payment_id}))
            assert settled["result"]["state"] == "settled", settled
            status = result(await session.call_tool("styx_payment_status", {"payment_id": payment_id}))
            assert status["result"]["state"] == "settled"

            oversized = await propose(session, "6000000")
            assert oversized["result"]["path"] == "exception_required"
            refused = result(await session.call_tool("styx_submit_payment", {
                "payment_id": oversized["result"]["payment_id"],
            }))
            assert refused["error"]["code"] == "OWNER_APPROVAL_REQUIRED"

            over_daily = await propose(session, "11000000")
            assert over_daily["error"]["code"] == "POLICY_LIMIT"

        paid = {}

        async def pay_and_capture(session):
            await body(session)
            again = await propose(session, "100000")
            paid["id"] = again["result"]["payment_id"]
            settled = result(await session.call_tool("styx_submit_payment", {"payment_id": paid["id"]}))
            assert settled["result"]["state"] == "settled", settled

        run_session(env, pay_and_capture)
        assert balance_of(token, vendor) == 350000

        # The reviewer's server runs apart from the agent's, with its own key and its own RPC.
        record_file = private_dir(tmp_path / "issuer") / "payment.record"
        exported = subprocess.run(
            [str(BINARY)], input=json.dumps({"method": "export_record", "payment_id": paid["id"],
                                             "record_file": str(record_file)}),
            capture_output=True, text=True,
            env={name: value for name, value in env.items() if name.startswith("STYX_VAULT_")},
        )
        assert exported.returncode == 0, exported.stdout
        issuer_key = tmp_path / "issuer" / "issuer.key"
        issuer_key.write_bytes(bytes([0x42]) * 32)
        issuer_key.chmod(0o600)
        issuer = address("0x" + "42" * 32)
        code = subprocess.run(["cast", "code", vault, "--rpc-url", rpc], capture_output=True, text=True,
                              check=True).stdout.strip()
        code_hash = subprocess.run(["cast", "keccak", code], capture_output=True, text=True, check=True).stdout.strip()

        reviewer_dir = private_dir(tmp_path / "reviewer")
        reviewer_env = {
            "STYX_BACKEND": "disclosure", "STYX_DISCLOSURE_DIR": str(reviewer_dir),
            "STYX_DISCLOSURE_CLI": str(DISCLOSURE_BINARY),
            "STYX_DISCLOSURE_VAULT_PINS": json.dumps({
                "chain_id": 31337, "rpc_urls": [rpc], "vault": vault, "vault_code_hash": code_hash,
            }),
        }
        issuer_dir = private_dir(tmp_path / "issuer")
        issuer_env = {
            "STYX_BACKEND": "disclosure", "STYX_DISCLOSURE_DIR": str(issuer_dir),
            "STYX_DISCLOSURE_CLI": str(DISCLOSURE_BINARY),
            "STYX_DISCLOSURE_VAULT_ISSUER_KEY_FILE": str(issuer_key),
        }

        async def reviewer_key(session):
            assert "export_vault_payment" not in {t.name for t in (await session.list_tools()).tools}
            return result(await session.call_tool("create_disclosure_key", {}))["result"]["recipient_public_key"]

        public_key = run_session(reviewer_env, reviewer_key)

        async def issue(session):
            assert "verify_vault_payment" not in {t.name for t in (await session.list_tools()).tools}
            issued = result(await session.call_tool("export_vault_payment", {
                "record_name": "payment.record", "recipient_public_key": public_key,
                "grant_name": "payment.grant", "expires_at": now + 86400,
            }))
            assert issued["ok"], issued
            assert issued["result"]["issuer"] == issuer

        run_session(issuer_env, issue)
        (reviewer_dir / "payment.grant").write_bytes((issuer_dir / "payment.grant").read_bytes())
        (reviewer_dir / "payment.grant").chmod(0o600)

        async def review(session):
            checked = result(await session.call_tool("verify_vault_payment", {
                "grant_name": "payment.grant", "expected_issuer": issuer, "opened_name": "opened.json",
            }))
            assert checked["ok"], checked
            for name in ("record_integrity", "settlement", "policy_at_execution"):
                assert checked["result"][name] == "verified", checked
            assert checked["result"]["authorization"] == "not_applicable"
            assert "invoice body" not in json.dumps(checked)
            wrong = result(await session.call_tool("verify_vault_payment", {
                "grant_name": "payment.grant", "expected_issuer": "0x" + "11" * 20,
            }))
            assert wrong["error"]["code"] == "DISCLOSURE_UNAVAILABLE"

        run_session(reviewer_env, review)
        opened = json.loads((reviewer_dir / "opened.json").read_text())
        assert bytes.fromhex(opened["evidence"]["invoiceHex"][2:]) == b"invoice body"
    finally:
        anvil.kill()
        anvil.wait()


def test_models_can_leave_the_timestamps_out(tmp_path):
    directory = private_dir(tmp_path / "vault")
    binary = scripted_binary(tmp_path, {
        "propose": [{"status": "ok", "payment_id": "0x" + "ab" * 32, "path": "exception_required"}, 0],
        "request_approval": [{"status": "ok", "pending_file": "/x", "approval_digest": "0x" + "ef" * 32}, 0],
    })

    async def body(session):
        await session.call_tool("styx_propose_payment", {
            "recipient": "0x" + "a1" * 20, "amount": "1", "invoice_name": "i.txt", "invoice_reference": "x",
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
