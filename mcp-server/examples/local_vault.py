#!/usr/bin/env python3
"""Starts a local chain with a configured, funded vault and prints how to point an agent at it.

For rehearsal only: no wallet, no real funds, no live network. It creates random keys in a private
directory, deploys a test token (set to 6 decimals like Arc's USDC) and the vault, allows two vendors, and
funds the vault with 8 USDC. The owner's key lives only inside the local Anvil process, which also signs
approvals for rehearsal. The agent gets a key file and nothing else.

Needs anvil, forge and cast, and a built styx-vault. Runs until Ctrl-C, then deletes everything.
Usage: local_vault.py [--port N]
"""
from __future__ import annotations

import argparse
import json
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "sdk/evm/target/debug/styx-vault"
VENDOR_A = "0x00000000000000000000000000000000000000a1"
VENDOR_B = "0x00000000000000000000000000000000000000b2"
LIMITS = {"per_payment": "1000000", "daily": "10000000", "funded": "8000000"}  # 1, 10 and 8 USDC


def sh(*args: str, cwd: Path | None = None) -> str:
    done = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if done.returncode != 0:
        raise SystemExit(f"{args[0]} {args[1] if len(args) > 1 else ''} failed: {done.stderr.strip()[:500]}")
    return done.stdout.strip()


def build(work: Path, port: int) -> tuple[subprocess.Popen, dict[str, str]]:
    """Returns the running Anvil process and the environment an agent needs. `work` must be private."""
    rpc = f"http://127.0.0.1:{port}"
    config = work / "anvil.json"
    anvil = subprocess.Popen(["anvil", "--port", str(port), "--silent", "--mnemonic-random", "--config-out", str(config)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if config.exists() and subprocess.run(["cast", "chain-id", "--rpc-url", rpc], capture_output=True).returncode == 0:
            break
        time.sleep(0.1)
    else:
        anvil.terminate()
        raise SystemExit(f"anvil did not start on port {port} (is one already running?)")
    owner_key, agent_key = json.loads(config.read_text())["private_keys"][:2]
    config.unlink()  # the config lists every key; only the agent's is written back below
    owner = sh("cast", "wallet", "address", "--private-key", owner_key)
    agent = sh("cast", "wallet", "address", "--private-key", agent_key)
    contracts = ROOT / "contracts/evm"

    def create(contract: str, *constructor: str) -> str:
        out = sh("forge", "create", contract, "--broadcast", "--rpc-url", rpc, "--private-key", owner_key,
                 "--constructor-args", *constructor, cwd=contracts)
        return next(line.split()[-1] for line in out.splitlines() if line.startswith("Deployed to:"))

    def send(to: str, signature: str, *params: str) -> None:
        sh("cast", "send", to, signature, *params, "--rpc-url", rpc, "--private-key", owner_key)

    token = create("src/MockERC20.sol:MockERC20", "USD Coin", "USDC")
    # The mock has 18 decimals and Arc's USDC has 6: set the decimals slot so the rehearsal matches.
    sh("cast", "rpc", "anvil_setStorageAt", token, "0x2", "0x" + "6".rjust(64, "0"), "--rpc-url", rpc)
    vault = create("src/StyxPolicyVault.sol:StyxPolicyVault", owner, token)
    until = str(int(time.time()) + 86400)
    send(vault, "configurePolicy(address,uint256,uint256,uint64)", agent, LIMITS["per_payment"], LIMITS["daily"], until)
    send(vault, "setRecipient(address,bool)", VENDOR_A, "true")
    send(vault, "setRecipient(address,bool)", VENDOR_B, "true")
    send(token, "mint(address,uint256)", vault, LIMITS["funded"])

    vault_dir = work / "vault"
    vault_dir.mkdir(mode=0o700, exist_ok=True)
    key_file = work / "agent.key"
    key_file.write_text(agent_key)
    key_file.chmod(0o600)
    (work / "owner.json").write_text(json.dumps({
        "chainId": "31337", "vault": vault, "owner": owner, "token": token,
        "vendors": {VENDOR_A: "Vendor A", VENDOR_B: "Vendor B"}}))
    env = {
        "STYX_VAULT_DIR": str(vault_dir), "STYX_VAULT_CLI": str(CLI), "STYX_VAULT_CHAIN_ID": "31337",
        "STYX_VAULT_RPC_URLS": rpc, "STYX_VAULT_ADDRESS": vault, "STYX_VAULT_TOKEN": token,
        "STYX_VAULT_STATE_ROOT": str(work / "journal"), "STYX_VAULT_AGENT_KEY_FILE": str(key_file),
    }
    return anvil, env


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=18861)
    args = parser.parse_args()
    if not CLI.exists():
        raise SystemExit(f"missing {CLI}: run `(cd sdk/evm && cargo build --bins)`")
    work = Path(tempfile.mkdtemp(prefix="local-vault-")).resolve()
    work.chmod(0o700)
    anvil, env = build(work, args.port)
    (work / "env.sh").write_text("".join(f"export {k}='{v}'\n" for k, v in env.items()))
    print(f"Local vault ready in {work}\n")
    print(f"  source {work}/env.sh                        # the agent's environment: no owner key")
    print(f"  owner config for signing: {work}/owner.json")
    print(f"  vendors: {VENDOR_A} (A), {VENDOR_B} (B)")
    print("  limits: 1 USDC per payment, 10 USDC per day. The vault holds 8 USDC.")
    print("  to sign an approval as the owner (rehearsal only), from owner-page:")
    print(f"    npx tsx test/sign_with_rpc.mts {work}/owner.json <pending-file> {env['STYX_VAULT_RPC_URLS']} <signature-file>")
    print("\nCtrl-C to stop and delete everything.", flush=True)
    # A shell starts background jobs with SIGINT ignored, so Ctrl-C and `kill -INT` need an explicit handler.
    for stop in (signal.SIGINT, signal.SIGTERM):
        signal.signal(stop, lambda *_: sys.exit(0))
    try:
        anvil.wait()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        anvil.terminate()
        try:
            anvil.wait(timeout=5)
        except subprocess.TimeoutExpired:
            anvil.kill()  # a terminate that is ignored would leave the chain running
            anvil.wait()
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
