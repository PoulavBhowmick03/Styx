"""Attacks on a vault's EVM payments (Chain Signatures), sent as real NEAR transactions signed with
the agent's function-call key. Each must be refused for its named reason, so nothing is signed for
the EVM chain.

Run after an EVM exception has settled; its pending and signature files are reused.
Needs: VAULT, AGENT_KEY_FILE, PENDING_FILE, SIGNATURE_FILE, VENDOR_B (an allowed EVM address other
than the settled one). Optional: NETWORK (near CLI connection, default testnet-fastnear); ATTACKS (e.g. "E1 E2") to run a
subset; ATTACK_CHAIN_ID and ATTACK_RECIPIENT to aim E1 and E2 at another chain and allowed address.

Usage: uv run --with pynacl --with base58 scripts/near/attacks_evm.py
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("NETWORK", "testnet-fastnear")
import attacks as base  # noqa: E402  reuses run, view, send and the result checks

PENDING, SIGNATURE = base.PENDING, base.SIGNATURE
AGENT_PK = base.AGENT_PK
STRANGER = "0x" + "c3" * 20  # never allowed by the owner


SELECTED = os.environ.get("ATTACKS", "E1 E2 E3 E4 E5 E6").split()
CHAIN = int(os.environ.get("ATTACK_CHAIN_ID") or PENDING["payment"]["chain_id"])


def evm_payment(recipient: str, amount: int, chain_id: int | None = None) -> dict:
    chain_id = chain_id or PENDING["payment"]["chain_id"]
    policy = base.view("get_agent", {"agent": AGENT_PK})
    state = base.view("get_evm_recipient", {"chain_id": chain_id, "recipient": recipient}) or {"version": 1}
    return {
        "payment_id": "0x" + secrets.token_hex(32),
        "agent": AGENT_PK,
        "chain_id": chain_id,
        "recipient": recipient.lower(),
        "amount": str(amount),
        "evidence_commitment": base64.b64encode(secrets.token_bytes(32)).decode(),
        "policy_version": policy["version"],
        "recipient_version": state["version"],
        "valid_until": str(int(time.time()) + 3600),
    }


def main() -> None:
    per = int(base.view("get_agent", {"agent": AGENT_PK})["per_payment_limit"])
    recipient = os.environ.get("ATTACK_RECIPIENT", PENDING["payment"]["recipient"]).lower()
    on = f" (chain {CHAIN})"
    auth = dict(PENDING["authorization"], callback_url=SIGNATURE.get("callbackUrl"))
    if "E1" in SELECTED:
        base.expect_contract_refusal("E1 over the limit, no signature" + on, "PerPaymentLimitExceeded", "pay_evm",
                                     {"payment": evm_payment(recipient, per + 1, CHAIN)})
    if "E2" in SELECTED:
        base.expect_contract_refusal("E2 an address the owner never allowed" + on, "RecipientNotAllowed", "pay_evm",
                                     {"payment": evm_payment(STRANGER, 1_000_000, CHAIN)})
    if not set(SELECTED) & {"E3", "E4", "E5", "E6"}:
        return
    base.expect_contract_refusal("E3 the approver's signature reused for another address", "PaymentHashMismatch",
                                 "pay_evm_with_exception",
                                 {"payment": evm_payment(os.environ["VENDOR_B"], 1_000_000), "authorization": auth,
                                  "signature": SIGNATURE["signature"]})
    base.expect_contract_refusal("E4 the settled exception sent again", "PaymentAlreadyUsed", "pay_evm_with_exception",
                                 {"payment": PENDING["payment"], "authorization": auth, "signature": SIGNATURE["signature"]})
    base.expect_key_refusal("E5 the agent allows its own address", "set_evm_recipient",
                            {"chain_id": PENDING["payment"]["chain_id"], "recipient": STRANGER, "allowed": True})
    base.expect_key_refusal("E6 the agent raises the gas caps", "set_evm_chain",
                            {"chain_id": PENDING["payment"]["chain_id"], "chain": {
                                "token": "0x3600000000000000000000000000000000000000", "max_fee_per_gas": str(10**15),
                                "max_priority_fee_per_gas": str(10**15), "gas_limit": "10000000", "enabled": True}})


if __name__ == "__main__":
    main()
