"""The scripted agent, end to end on a local chain, with the owner signing outside its environment."""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path(os.environ.get("EREBUS_TEST_VAULT_BIN", ROOT / "sdk/evm/target/debug/erebus-vault"))
AVAILABLE = BINARY.exists() and all(shutil.which(tool) for tool in ("anvil", "forge", "cast"))


def run(*command, cwd=None):
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


@pytest.mark.skipif(not AVAILABLE, reason="build erebus-vault and install Foundry to run this test")
def test_scripted_agent_pays_is_refused_then_settles_with_the_owners_signature(tmp_path):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    config = tmp_path / "anvil.json"
    anvil = subprocess.Popen(["anvil", "--port", str(port), "--silent", "--config-out", str(config)])
    rpc = f"http://127.0.0.1:{port}"
    agent_process = None
    try:
        for _ in range(100):
            if config.exists() and subprocess.run(["cast", "chain-id", "--rpc-url", rpc], capture_output=True).returncode == 0:
                break
            time.sleep(0.1)
        owner_key, agent_key = json.loads(config.read_text())["private_keys"][:2]
        address = lambda key: run("cast", "wallet", "address", "--private-key", key).lower()
        contracts = ROOT / "contracts/evm"

        def create(contract, *arguments):
            output = run("forge", "create", contract, "--broadcast", "--rpc-url", rpc, "--private-key", owner_key,
                         "--constructor-args", *arguments, cwd=contracts)
            return re.search(r"Deployed to: (0x[0-9a-fA-F]{40})", output).group(1).lower()

        def send(target, signature, *arguments):
            run("cast", "send", target, signature, *arguments, "--rpc-url", rpc, "--private-key", owner_key)

        token = create("src/MockERC20.sol:MockERC20", "USD Coin", "USDC")
        vault = create("src/ErebusPolicyVault.sol:ErebusPolicyVault", address(owner_key), token)
        vendor = "0x00000000000000000000000000000000000000a1"
        send(vault, "configurePolicy(address,uint256,uint256,uint64)", address(agent_key), "1000000", "10000000",
             str(int(time.time()) + 86400))
        send(vault, "setRecipient(address,bool)", vendor, "true")
        send(token, "mint(address,uint256)", vault, "8000000")

        directory = tmp_path / "vault"
        directory.mkdir(mode=0o700)
        key_file = tmp_path / "agent.key"
        key_file.write_text(agent_key)
        key_file.chmod(0o600)
        env = {
            "PATH": os.environ["PATH"], "EREBUS_VAULT_DIR": str(directory), "EREBUS_VAULT_CLI": str(BINARY),
            "EREBUS_VAULT_CHAIN_ID": "31337", "EREBUS_VAULT_RPC_URLS": rpc, "EREBUS_VAULT_ADDRESS": vault,
            "EREBUS_VAULT_TOKEN": token, "EREBUS_VAULT_STATE_ROOT": str(tmp_path / "journal"),
            "EREBUS_VAULT_AGENT_KEY_FILE": str(key_file),
        }
        agent_process = subprocess.Popen(
            [sys.executable, str(ROOT / "mcp-server/examples/vault_agent.py"), vendor, "--wait-seconds", "60"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        events = []
        for line in agent_process.stdout:
            event = json.loads(line)
            events.append(event)
            if event["event"] == "waiting_for_owner":
                # The owner signs on their own side. The agent only ever sees the finished file.
                signature = run("cast", "wallet", "sign", "--no-hash", "--private-key", owner_key, event["approval_digest"])
                (directory / event["signature_file"]).write_text(json.dumps({
                    "schema": "vault-owner-signature/1", "paymentId": event["payment_id"],
                    "approvalDigest": event["approval_digest"], "signature": signature,
                }))
        assert agent_process.wait(timeout=60) == 0, events[-1]

        by_name = {event["event"]: event for event in events}
        assert by_name["tools"]["tools"] == sorted([
            "erebus_propose_payment", "erebus_request_owner_approval", "erebus_submit_payment", "erebus_payment_status",
        ])
        assert by_name["refused_without_owner"]["outcome"] == "OWNER_APPROVAL_REQUIRED"
        assert by_name["done"] == {"event": "done", "outcome": "settled", "chain_state": "settled"}
        paid = run("cast", "call", token, "balanceOf(address)(uint256)", vendor, "--rpc-url", rpc).split()[0]
        assert paid == "6250000"
    finally:
        if agent_process and agent_process.poll() is None:
            agent_process.kill()
        anvil.kill()
        anvil.wait()
