#!/usr/bin/env python3
"""Simulates the vault against the real USDC on Arc testnet, without deploying or spending anything.

Each scenario is an `eth_call` on Arc's own node. The vault's bytecode, balance and storage are injected
for that one call through state overrides, so nothing is written to the chain. Keys are generated for
this run and thrown away. Needs anvil, forge and cast. Usage: arc_simulate.py [rpc-url]
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# Arc's documented testnet endpoints. The public ones rate limit, so calls back off and fail over.
RPCS = sys.argv[1:] or ["https://rpc.testnet.arc.io", "https://rpc.drpc.testnet.arc.io",
                        "https://rpc.blockdaemon.testnet.arc.io", "https://rpc.quicknode.testnet.arc.io"]
USDC = "0x3600000000000000000000000000000000000000"
CHAIN = 5042002
VAULT = "0x00000000000000000000000000000000c0ffee01"
VENDOR_A = "0x00000000000000000000000000000000c0ffeea1"
VENDOR_B = "0x00000000000000000000000000000000c0ffeeb2"
ONE = 1_000_000
CONTRACTS = Path(__file__).resolve().parents[1]
PAY = "pay((bytes32,address,address,address,uint256,bytes32,uint256,uint64))"
PAY_EX = "payWithException((bytes32,address,address,address,uint256,bytes32,uint256,uint64),(bytes32,uint256,uint64),bytes)"
PAYMENT_TYPE = "Payment(bytes32 paymentId,address agent,address token,address recipient,uint256 amount,bytes32 evidenceCommitment,uint256 policyVersion,uint64 validUntil)"
AUTH_TYPE = "ExceptionAuthorization(bytes32 paymentHash,uint256 approvalNonce,uint64 authorizationExpiry)"
DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
ERRORS = ["NotAgent", "VaultPaused", "PolicyExpired", "AgentMismatch", "TokenMismatch", "PolicyVersionMismatch", "PaymentExpired",
          "ZeroAmount", "RecipientNotAllowed", "PaymentAlreadyUsed", "DailyLimitExceeded", "PerPaymentLimitExceeded",
          "PaymentHashMismatch", "BadSignature", "ApprovalNonceUsed", "AuthorizationExpired", "TransferFailed", "ZeroAddress", "Reentrancy"]


def cast(*args: str, cwd=None) -> str:
    return subprocess.run(["cast", *args], capture_output=True, text=True, check=True, cwd=cwd).stdout.strip()


def rpc(method: str, params: list):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    last = None
    for attempt in range(8):
        url = RPCS[attempt % len(RPCS)]
        request = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "arc-simulate"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)
            message = str(result.get("error", {}).get("message", "")).lower()
            if "rate" in message or "limit" in message or "too many" in message:
                last = message
            else:
                time.sleep(0.25)
                return result
        except (OSError, ValueError) as error:
            last = error
        time.sleep(1.0 + attempt)
    raise SystemExit(f"Arc RPC unavailable after retries: {last}")


def view(data: str, to: str = "0x3600000000000000000000000000000000000000") -> str:
    return rpc("eth_call", [{"to": to, "data": data}, "latest"])["result"]


def word(value: int) -> str:
    return f"0x{value:064x}"


def map_slot(key_hex: str, slot: int) -> str:
    return cast("keccak", cast("abi-encode", "f(bytes32,uint256)", key_hex, str(slot)))


def pad_addr(address: str) -> str:
    return "0x" + address[2:].lower().rjust(64, "0")


def runtime_code(owner: str) -> str:
    """Deploys to a throwaway local chain to get runtime bytes with the owner and token immutables set."""
    port = "18611"
    node = subprocess.Popen(["anvil", "--port", port, "--silent"], stdout=subprocess.DEVNULL)
    try:
        url = f"http://127.0.0.1:{port}"
        for _ in range(50):
            if subprocess.run(["cast", "chain-id", "--rpc-url", url], capture_output=True).returncode == 0:
                break
            time.sleep(0.1)
        # Anvil's first account, read from the node at runtime, signs this local-only deployment.
        sender = json.loads(cast("rpc", "--rpc-url", url, "eth_accounts"))[0]
        out = subprocess.run(
            ["forge", "create", "src/StyxPolicyVault.sol:StyxPolicyVault", "--broadcast", "--rpc-url", url, "--unlocked",
             "--from", sender, "--constructor-args", owner, USDC],
            cwd=CONTRACTS, capture_output=True, text=True, check=True).stdout
        address = next(line.split()[-1] for line in out.splitlines() if line.startswith("Deployed to:"))
        return cast("code", address, "--rpc-url", url)
    finally:
        node.kill()
        node.wait()


def storage_slots() -> dict:
    out = subprocess.run(["forge", "inspect", "src/StyxPolicyVault.sol:StyxPolicyVault", "storageLayout", "--json"],
                         cwd=CONTRACTS, capture_output=True, text=True, check=True).stdout
    return {item["label"]: (int(item["slot"]), item["offset"]) for item in json.loads(out)["storage"]}


def new_key() -> tuple[str, str]:
    data = json.loads(cast("wallet", "new", "--json"))[0]
    return data["private_key"], data["address"].lower()


owner_key, owner = new_key()
agent_key, agent = new_key()
_, nobody = new_key()
chain_id = int(rpc("eth_chainId", [])["result"], 16)
assert chain_id == CHAIN, f"expected chain {CHAIN}, got {chain_id}"
print(f"chain {chain_id}, USDC decimals {int(view(cast('sig', 'decimals()')), 16)}, "
      f"gas price {int(rpc('eth_gasPrice', [])['result'], 16) / 1e9:.2f} gwei")
code = runtime_code(owner)
slots = storage_slots()
assert slots["paused"][0] == slots["policyValidUntil"][0], "expected paused and policyValidUntil to share a slot"
now = int(rpc("eth_getBlockByNumber", ["latest", False])["result"]["timestamp"], 16)
day = now // 86400
VERSION = 3


def state(balance_usdc: float = 8.0, consumed: str | None = None, spent: int = 0) -> dict:
    diff = {
        word(slots["agent"][0]): pad_addr(agent),
        word(slots["policyVersion"][0]): word(VERSION),
        word(slots["perPaymentLimit"][0]): word(ONE),
        word(slots["dailyLimit"][0]): word(10 * ONE),
        word(slots["policyValidUntil"][0]): word(now + 86400),
        map_slot(pad_addr(VENDOR_A), slots["allowedRecipient"][0]): word(1),
        map_slot(pad_addr(VENDOR_B), slots["allowedRecipient"][0]): word(1),
    }
    if spent:
        diff[map_slot(word(day), slots["spentByDay"][0])] = word(spent)
    if consumed:
        diff[map_slot(consumed, slots["consumedPayment"][0])] = word(1)
    # The native balance has 18 decimals. It is the same money as the 6-decimal ERC-20 balance.
    return {VAULT: {"code": code, "balance": hex(int(balance_usdc * 10**18)), "stateDiff": diff}}


COMMITMENT = cast("keccak", "invoice")


def payment(pid: str, recipient: str, amount: int) -> tuple:
    return (pid, agent, USDC, recipient, amount, COMMITMENT, VERSION, now + 3600)


def tuple_arg(p: tuple) -> str:
    return "(" + ",".join(str(v) for v in p) + ")"


def payment_hash(p: tuple) -> str:
    encoded = cast("abi-encode", "f(bytes32,bytes32,address,address,address,uint256,bytes32,uint256,uint64)", cast("keccak", PAYMENT_TYPE),
                   *[str(v) for v in p])
    return cast("keccak", encoded)


def digest(auth: tuple) -> str:
    domain = cast("keccak", cast("abi-encode", "f(bytes32,bytes32,bytes32,uint256,address)", cast("keccak", DOMAIN_TYPE),
                                 cast("keccak", "ErebusPolicyVault"), cast("keccak", "1"), str(CHAIN), VAULT))
    struct = cast("keccak", cast("abi-encode", "f(bytes32,bytes32,uint256,uint64)", cast("keccak", AUTH_TYPE), *[str(v) for v in auth]))
    return cast("keccak", "0x1901" + domain[2:] + struct[2:])


def sign(key: str, auth: tuple) -> str:
    return cast("wallet", "sign", "--no-hash", "--private-key", key, digest(auth))


SELECTORS = {cast("sig", f"{name}()"): name for name in ERRORS}


def simulate(data: str, overrides: dict, sender: str = agent) -> str:
    response = rpc("eth_call", [{"from": sender, "to": VAULT, "data": data}, "latest", overrides])
    if "error" not in response:
        return "OK"
    payload = response["error"]
    revert = str(payload.get("data") or "")
    return SELECTORS.get(revert[:10], f"reverted: {payload.get('message', '')[:70]} {revert[:12]}")


results = []


def check(label: str, expected: str, actual: str) -> None:
    passed = actual == expected
    results.append(passed)
    print(f"{'PASS' if passed else 'FAIL'}  {label:<46} expected {expected:<26} got {actual}")


small = payment(cast("keccak", "small"), VENDOR_A, ONE // 4)
big = payment(cast("keccak", "big"), VENDOR_A, 6 * ONE)
auth = (payment_hash(big), 7, now + 600)
owner_signature = sign(owner_key, auth)
redirected = (big[0], agent, USDC, VENDOR_B, 6 * ONE, COMMITMENT, VERSION, now + 3600)
pay = lambda p: cast("calldata", PAY, tuple_arg(p))
pay_ex = lambda p, a, s: cast("calldata", PAY_EX, tuple_arg(p), tuple_arg(a), s)

check("0.25 USDC ordinary, real USDC transfer", "OK", simulate(pay(small), state()))
check("A1: 6 USDC direct", "PerPaymentLimitExceeded", simulate(pay(big), state()))
check("A2: exception signed by the agent", "BadSignature", simulate(pay_ex(big, auth, sign(agent_key, auth)), state()))
check("6 USDC owner exception, real USDC transfer", "OK", simulate(pay_ex(big, auth, owner_signature), state()))
check("A3: owner's signature, vendor B", "PaymentHashMismatch", simulate(pay_ex(redirected, auth, owner_signature), state()))
check("A3b: authorization rewritten for vendor B", "BadSignature",
      simulate(pay_ex(redirected, (payment_hash(redirected), 7, now + 600), owner_signature), state()))
check("A4: resubmit a consumed payment", "PaymentAlreadyUsed", simulate(pay_ex(big, auth, owner_signature), state(consumed=big[0])))
check("wrong caller", "NotAgent", simulate(pay(small), state(), sender=nobody))
check("over the daily limit", "DailyLimitExceeded", simulate(pay_ex(big, auth, owner_signature), state(spent=5 * ONE)))
check("vault holds too little", "TransferFailed", simulate(pay_ex(big, auth, owner_signature), state(balance_usdc=1.0)))

print()
for label, data in [("ordinary pay", pay(small)), ("exception pay", pay_ex(big, auth, owner_signature))]:
    response = rpc("eth_estimateGas", [{"from": agent, "to": VAULT, "data": data}, "latest", state()])
    if "result" in response:
        gas = int(response["result"], 16)
        print(f"gas {label}: {gas}, about {gas * 40e9 / 1e18:.5f} USDC at a 40 gwei cap")
    else:
        print(f"gas {label}: estimate unavailable: {response['error'].get('message', '')[:80]}")

# Exact balances and events, where the node supports multi-call simulation.
call = {"from": agent, "to": VAULT, "data": pay_ex(big, auth, owner_signature)}
balance_data = cast("calldata", "balanceOf(address)", VENDOR_A)
vault_balance_data = cast("calldata", "balanceOf(address)", VAULT)
blocks = [{"stateOverrides": state(), "calls": [
    {"from": agent, "to": USDC, "data": vault_balance_data}, call,
    {"from": agent, "to": USDC, "data": balance_data}, {"from": agent, "to": USDC, "data": vault_balance_data}]}]
response = rpc("eth_simulateV1", [{"blockStateCalls": blocks, "validation": False}, "latest"])
if "result" in response:
    calls = response["result"][0]["calls"]
    as_int = lambda c: int(c["returnData"], 16)
    print(f"simulated exception: vault {as_int(calls[0])} -> {as_int(calls[3])}, vendor A -> {as_int(calls[2])}")
    logs = calls[1].get("logs", [])
    print(f"logs from: {[entry['address'] for entry in logs]}")
    check("exception moves exactly 6 USDC", "OK",
          "OK" if (as_int(calls[0]) - as_int(calls[3]), as_int(calls[2])) == (6 * ONE, 6 * ONE) else "wrong amounts")
    vault_events = [entry for entry in logs if entry["address"].lower() == VAULT]
    check("vault emits PaymentExecuted", "OK", "OK" if len(vault_events) == 1 else f"{len(vault_events)} events")
else:
    print(f"eth_simulateV1 unavailable: {response['error'].get('message', '')[:100]}")

print(f"\n{sum(results)}/{len(results)} passed. Simulated on the node: nothing was deployed, signed for the chain, or spent.")
sys.exit(0 if all(results) else 1)
