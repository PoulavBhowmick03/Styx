"""Attacks A1 to A6 against a Styx vault on NEAR, sent as real transactions signed with the agent's
function-call key. Every one must be refused, and refused for the reason it is meant to show.

Two kinds of refusal, reported differently because they are different on NEAR:
  - A1 to A4 reach the vault, which panics with a named error. The transaction is on chain as a
    failed receipt, and the script prints its id.
  - A5 and A6 call owner methods the agent's key is not allowed to call. The network rejects the
    transaction before it is included in a block, so there is no on-chain record; the script
    prints the network's refusal instead.

Run it after an exception has settled (its pending and signature files are reused for A3 and A4),
with the policy version unchanged since, and with more than the per-payment limit left in the
agent's daily limit (so A1 hits the per-payment check, not the daily one).

Needs: VAULT, AGENT_KEY_FILE, PENDING_FILE, SIGNATURE_FILE, VENDOR_B (an allowed recipient other
than the settled one). Optional: ATTACKS="A1 A4" to run a subset; NETWORK (default testnet).

Usage: uv run --with pynacl --with base58 scripts/near/attacks.py
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import subprocess
import sys
import time

VAULT = os.environ["VAULT"]
KEY_FILE = os.environ["AGENT_KEY_FILE"]
PENDING = json.load(open(os.environ["PENDING_FILE"]))
SIGNATURE = json.load(open(os.environ["SIGNATURE_FILE"]))
VENDOR_B = os.environ["VENDOR_B"]
NETWORK = os.environ.get("NETWORK", "testnet")
SELECTED = os.environ.get("ATTACKS", "A1 A2 A3 A4 A5 A6").split()
AGENT_PK = json.load(open(KEY_FILE))["public_key"]


def run(argv: list[str]) -> str:
    """Runs the near CLI, retrying only when the public RPC rate-limits us (nothing was sent)."""
    for attempt in range(6):
        out = subprocess.run(argv, capture_output=True, text=True, timeout=180)
        text = re.sub(r"\x1b\[[0-9;]*m", "", out.stdout + out.stderr)
        if "exceeded the rate limit" not in text and "Too Many Requests" not in text:
            return text
        time.sleep(5 * (attempt + 1))
    sys.exit("the RPC kept rate-limiting; try again later or set a private RPC")


def view(method: str, args: dict):
    text = run(
        ["near", "contract", "call-function", "as-read-only", VAULT, method, "json-args", json.dumps(args),
         "network-config", NETWORK, "now"])
    match = re.search(r"^(\{.*\}|\".*\"|null|\d+|true|false)\s*$", text, flags=re.M | re.S)
    if not match:
        sys.exit(f"view {method} failed: {text[-400:]}")
    return json.loads(match.group(1))


def send(method: str, args: dict) -> str:
    """Sends one agent-signed call. Returns the combined CLI output (never contains the key)."""
    return run(
        ["near", "contract", "call-function", "as-transaction", VAULT, method, "json-args", json.dumps(args),
         "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR", "sign-as", VAULT,
         "network-config", NETWORK, "sign-with-access-key-file", KEY_FILE, "send"])


def expect_contract_refusal(label: str, error: str, method: str, args: dict) -> None:
    text = send(method, args)
    tx = re.search(r"Transaction ID:\s*(\S+)", text)
    if f"Smart contract panicked: {error}" in text or re.search(rf"\b{error}\b", text) and "panicked" in text:
        print(f"PASS {label} refused by the vault with {error}: tx {tx.group(1) if tx else '(id not printed)'}")
        return
    if tx and "succeeded" in text:
        sys.exit(f"FAIL {label} succeeded: {tx.group(1)}")
    sys.exit(f"FAIL {label}: not refused with {error}:\n{text[-600:]}")


def expect_key_refusal(label: str, method: str, args: dict) -> None:
    text = send(method, args)
    if "isn't allowed by the access key" in text or "MethodNameMismatch" in text:
        print(f"PASS {label} refused by the network: the agent key may not call {method}; not included in any block")
        return
    sys.exit(f"FAIL {label}: expected the access key to refuse {method}:\n{text[-600:]}")


def fresh_payment(recipient: str, amount: int) -> dict:
    policy = view("get_agent", {"agent": AGENT_PK})
    state = view("get_recipient", {"recipient": recipient})
    return {
        "payment_id": "0x" + secrets.token_hex(32),
        "agent": AGENT_PK,
        "token": PENDING["token"],
        "recipient": recipient,
        "amount": str(amount),
        "evidence_commitment": base64.b64encode(secrets.token_bytes(32)).decode(),
        "policy_version": policy["version"],
        "recipient_version": state["version"],
        "valid_until": str(int(time.time()) + 3600),
    }


def settled_authorization() -> dict:
    auth = dict(PENDING["authorization"])
    auth["callback_url"] = SIGNATURE.get("callbackUrl")
    return auth


def main() -> None:
    policy = view("get_agent", {"agent": AGENT_PK})
    per = int(policy["per_payment_limit"])
    if "A1" in SELECTED:
        # Over the per-payment limit with no signature.
        expect_contract_refusal("A1", "PerPaymentLimitExceeded", "pay",
                                {"payment": fresh_payment(PENDING["payment"]["recipient"], per + 1)})
    if "A2" in SELECTED:
        # The agent names its own key as the signer of its exception and signs it itself.
        from nacl.signing import SigningKey
        import base58, hashlib, struct
        payment = fresh_payment(PENDING["payment"]["recipient"], per + 1)
        auth = {
            "payment_hash": view("payment_hash", {"payment": payment}),
            "signer": AGENT_PK, "signer_version": 1,
            "approval_nonce": base64.b64encode(secrets.token_bytes(32)).decode(),
            "authorization_expiry": str(int(time.time()) + 600), "callback_url": None,
        }
        message = view("exception_message", {"authorization": auth})
        def s(x: str) -> bytes:
            b = x.encode(); return struct.pack("<I", len(b)) + b
        digest = hashlib.sha256(struct.pack("<I", 2147484061) + s(message) + base64.b64decode(auth["approval_nonce"])
                                + s(VAULT) + b"\x00").digest()
        secret = base58.b58decode(json.load(open(KEY_FILE))["private_key"].removeprefix("ed25519:"))
        signature = base64.b64encode(SigningKey(secret[:32]).sign(digest).signature).decode()
        expect_contract_refusal("A2", "ApproverNotAllowed", "pay_with_exception",
                                {"payment": payment, "authorization": auth, "signature": signature})
    if "A3" in SELECTED:
        # The approver's signature for the settled payment, reused for another recipient.
        expect_contract_refusal("A3", "PaymentHashMismatch", "pay_with_exception",
                                {"payment": fresh_payment(VENDOR_B, 1_000_000), "authorization": settled_authorization(),
                                 "signature": SIGNATURE["signature"]})
    if "A4" in SELECTED:
        # The settled payment, sent again exactly.
        expect_contract_refusal("A4", "PaymentAlreadyUsed", "pay_with_exception",
                                {"payment": PENDING["payment"], "authorization": settled_authorization(),
                                 "signature": SIGNATURE["signature"]})
    if "A5" in SELECTED:
        # The agent raises its own limit.
        expect_key_refusal("A5", "configure_agent", {
            "agent": AGENT_PK, "per_payment_limit": str(10**15), "daily_limit": str(10**15),
            "valid_until": str(int(time.time()) + 86400), "enabled": True})
    if "A6" in SELECTED:
        # The agent makes itself an approver.
        expect_key_refusal("A6", "set_approver", {"approver": AGENT_PK, "enabled": True})


if __name__ == "__main__":
    main()
