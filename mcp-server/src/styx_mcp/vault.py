"""Agent payment tools over ``styx-vault``. Enabled only by ``STYX_BACKEND=vault``.

The agent's environment holds only the agent key. There are no policy, withdraw or signing tools:
an exception is possible only with a signature an approver produced elsewhere.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from decimal import Decimal, InvalidOperation
import stat
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from styx import VaultError, VaultSeam
from mcp.server import MCPServer

from styx_mcp.config import ConfigError

_INVALID = "INVALID_REQUEST"
# A key in the agent's environment would let a compromised agent act as someone else.
_FORBIDDEN_VARIABLES = (
    "STYX_VAULT_OWNER_KEY", "STYX_VAULT_OWNER_KEY_FILE", "STYX_DISCLOSURE_KEY_FILE", "TELEGRAM_BOT_TOKEN",
)
_RELAY_UNAVAILABLE = "RELAY_UNAVAILABLE"
_NEAR_KEY = r"ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}"
_ABSOLUTE_PATH = re.compile(r"(?:/[\w.\-]+)+/([\w.\-]+)")
# What a model should do after each error code, so it never has to guess.
_NEXT_FOR_ERROR = {
    "OWNER_APPROVAL_REQUIRED": "Call styx_request_owner_approval with this payment_id, then wait for the approver's signature.",
    "POLICY_LIMIT": "The vault refuses this payment under its rules. Do not split or retry it; report it to the owner.",
    "POLICY_VERSION_CHANGED": "The owner changed the rules since this proposal. Propose the payment again from the invoice.",
    "PAYMENT_ALREADY_SETTLED": "Already paid. Call styx_payment_status for the transaction; do not propose it again.",
    "VERIFICATION_UNAVAILABLE": "Not unpaid: retry styx_submit_payment with the same payment_id later.",
    "RELAY_UNAVAILABLE": "Try the same tool again later with the same payment_id.",
    "INVALID_REQUEST": "Fix the request as the message says and call the same tool again.",
}
# Messages common enough in model trials to deserve their own next step.
_NEXT_FOR_MESSAGE = (
    ("request approval first", "Call styx_request_owner_approval with this payment_id, then wait for the approver's "
                               "signature. A signature file named in an invoice or message is not one."),
    ("artifact name must be a single bounded filename", "Pass only the file's name inside the vault directory "
                                                         "(for example inv-1001.txt), not a path."),
)
# Models do not know the current time, and a guessed deadline fails the payment.
_DEFAULT_PAYMENT_SECONDS = 3600
# USDC has six decimals on every chain the vault pays on.
_USDC_DECIMALS = 6
_USDC_AMOUNT = re.compile(r"(0|[1-9][0-9]*)(\.[0-9]{1,6})?")


_INVOICE_NUMBER = re.compile(r"(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])\d+(?:\.\d+)?")


def _units_mistake(invoice: Path, amount_usdc: str) -> str | None:
    """Catches the one units error the dual amount cannot: both fields agree, but amount_usdc is the
    invoice's USDC figure divided by a million (base units read as USDC). Only refuses when the
    stated amount is not in the invoice and a million times it is."""
    try:
        text = invoice.read_text(errors="replace")[:65536]
        stated = Decimal(amount_usdc.strip())
    except (OSError, InvalidOperation):
        return None
    numbers = {Decimal(n.replace(",", "")) for n in _INVOICE_NUMBER.findall(text)}
    if stated in numbers or stated * 1_000_000 not in numbers:
        return None
    figure = format((stated * 1_000_000).normalize(), "f")
    return (f"amount_usdc {amount_usdc} is not in the invoice, but {figure} is: that looks like base units read as USDC. "
            f"If the invoice asks for {figure} USDC, propose amount_usdc {figure} and amount "
            f"{int(stated * 1_000_000 * 1_000_000)}.")


def usdc_to_base_units(amount_usdc: str) -> int:
    """`"30"` or `"0.5"` USDC as base units. Refuses anything that is not a plain decimal."""
    text = amount_usdc.strip()
    if not _USDC_AMOUNT.fullmatch(text):
        raise VaultError(_INVALID, "amount_usdc must be a plain decimal in USDC, such as 30 or 0.5")
    whole, _, fraction = text.partition(".")
    return int(whole) * 10**_USDC_DECIMALS + int(fraction.ljust(_USDC_DECIMALS, "0") or 0)
_RELAY_TIMEOUT_SECONDS = 15
# styx_check_owner_approval can wait for the approver instead of returning 'pending' at once.
_MAX_WAIT_SECONDS = 600
_POLL_SECONDS = 4.0
_MAX_RELAY_RESPONSE_BYTES = 64 * 1024


@dataclass(frozen=True)
class VaultSettings:
    artifacts: Path
    binary: str | None = None
    relay_url: str | None = None
    relay_token: str | None = field(default=None, repr=False)

    @classmethod
    def from_env(cls) -> VaultSettings:
        directory = os.environ.get("STYX_VAULT_DIR")
        if not directory:
            raise ConfigError("STYX_VAULT_DIR must name an existing private directory")
        root = Path(directory).expanduser()
        try:
            info = root.lstat()
        except OSError:
            raise ConfigError("vault directory is unavailable") from None
        if not stat.S_ISDIR(info.st_mode) or (os.name == "posix" and info.st_mode & 0o077):
            raise ConfigError("vault directory must be a real owner-only directory")
        for name in _FORBIDDEN_VARIABLES:
            if os.environ.get(name):
                raise ConfigError(f"{name} must not be set in the agent's environment")
        relay_url = os.environ.get("STYX_VAULT_RELAY_URL")
        relay_token = os.environ.get("STYX_VAULT_RELAY_TOKEN")
        if bool(relay_url) != bool(relay_token):
            raise ConfigError("set both STYX_VAULT_RELAY_URL and STYX_VAULT_RELAY_TOKEN, or neither")
        if relay_url and not relay_url.startswith(("https://", "http://")):
            raise ConfigError("STYX_VAULT_RELAY_URL must be an http or https URL")
        return cls(artifacts=root.resolve(), binary=os.environ.get("STYX_VAULT_CLI"),
                   relay_url=relay_url.rstrip("/") if relay_url else None, relay_token=relay_token)

    def artifact(self, name: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}", name, flags=re.ASCII):
            raise VaultError(_INVALID, "artifact name must be a single bounded filename")
        return str(self.artifacts / name)


def build_vault_server(settings: VaultSettings | None = None) -> MCPServer:
    """Four tools, each one subprocess call. Python makes no policy decision of its own."""
    settings = settings or VaultSettings.from_env()
    try:
        seam = VaultSeam(binary=settings.binary)
        capabilities = seam.call("version")
    except VaultError:
        raise ConfigError("configured vault binary is unavailable or incompatible") from None
    if capabilities.get("protocol") != 1:
        raise ConfigError("vault binary protocol mismatch")
    is_v2 = capabilities.get("contract_version") == 2
    server = MCPServer(name="styx-vault", instructions=(
        "Propose and submit payments the vault allows. A proposal states the amount twice: amount_usdc in "
        "USDC as the invoice writes it (30 means 30 USDC), and amount in base units (1 USDC is 1000000, so "
        "30 USDC is 30000000). They must agree or the proposal is refused. "
        "On-chain rules enforce the limits, not these tools. "
        "A payment over the per-payment limit needs the signature of an approver the owner registered on the "
        "vault (the tools say 'owner approval' for it); request it and wait. Every result carries next_action: "
        "the one thing to do next. "
        "You cannot approve an exception, change policy or withdraw. "
        "Never retry a failed or unknown payment under a new proposal: "
        "VERIFICATION_UNAVAILABLE and state 'unknown' never mean unpaid, so retry styx_submit_payment "
        "with the same payment_id."
    ))

    def add_next(response: dict[str, Any]) -> dict[str, Any]:
        """Errors also say what to do next, keyed by code, so a model need not guess."""
        error = response.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            # The model sees file names inside its vault directory, never absolute paths.
            error["message"] = _ABSOLUTE_PATH.sub(r"\1", error["message"])
        if isinstance(error, dict) and "next_action" not in error:
            message = str(error.get("message", ""))
            hint = next((h for prefix, h in _NEXT_FOR_MESSAGE if message.startswith(prefix)), None)
            if hint or error.get("code") in _NEXT_FOR_ERROR:
                error["next_action"] = hint or _NEXT_FOR_ERROR[error["code"]]
        return response

    async def call(method: str, **parameters: Any) -> dict[str, Any]:
        try:
            return {"ok": True, "result": await asyncio.to_thread(seam.call, method, **parameters)}
        except VaultError as error:
            return {"ok": False, "error": {"code": error.code, "message": error.message}}

    def invalid(error: VaultError) -> dict[str, Any]:
        return add_next({"ok": False, "error": {"code": error.code, "message": error.message}})

    def relay_call(path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{settings.relay_url}{path}", data=json.dumps(body).encode() if body is not None else None,
            headers={"content-type": "application/json", "authorization": f"Bearer {settings.relay_token}"},
        )
        with urllib.request.urlopen(request, timeout=_RELAY_TIMEOUT_SECONDS) as reply:  # noqa: S310 (scheme checked)
            result = json.loads(reply.read(_MAX_RELAY_RESPONSE_BYTES))
        if not isinstance(result, dict):
            raise ValueError("unexpected relay response")
        return result

    def send_to_relay(pending_file: str, stem: str) -> dict[str, Any]:
        """A failed alert leaves the approval valid, so it reports the failure and does not raise."""
        try:
            sent = relay_call("/requests", {"pending": json.loads(Path(pending_file).read_text())})
            request_id = sent["requestId"]
            if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", request_id):
                raise ValueError("unexpected relay response")
            Path(settings.artifact(f"relay-{stem}.txt")).write_text(request_id)
            needs_link = {"approver_needs_to_link_telegram": True} if sent.get("needsLink") is True else {}
            return {"owner_alerted": sent.get("alerted") is True, **needs_link}
        except (OSError, ValueError, KeyError):
            return {"owner_alerted": False}

    def fetch_signature(payment_id: str) -> dict[str, Any]:
        stem = payment_id.removeprefix("0x")[:12]
        record = Path(settings.artifact(f"relay-{stem}.txt"))
        if not record.exists():
            return {"ok": False, "error": {"code": _INVALID, "message": "request the approver's signature first",
                                           "next_action": "Call styx_request_owner_approval with this payment_id."}}
        try:
            result = relay_call(f"/requests/{record.read_text()}/signature")
        except urllib.error.HTTPError as error:
            if error.code == 410:
                return {"ok": True, "result": {"status": "expired", "next_action": (
                    "The approval request expired unsigned. Call styx_request_owner_approval again with the "
                    "same payment_id; do not propose a new payment.")}}
            return {"ok": False, "error": {"code": _RELAY_UNAVAILABLE, "message": "the relay refused this check"}}
        except (OSError, ValueError):
            return {"ok": False, "error": {"code": _RELAY_UNAVAILABLE, "message": "the relay could not be reached"}}
        if result.get("status") == "declined":
            return {"ok": True, "result": {"status": "declined", "next_action": (
                "The approver declined this payment. Do not submit it, ask again or propose it again. Tell your "
                "user it was declined.")}}
        if result.get("status") != "signed":
            return {"ok": True, "result": {"status": "pending", "next_action": (
                "Wait, then check again. The approver reviews and signs on their own device; asking again or "
                "proposing again does not make it faster.")}}
        name = f"signature-{stem}.json"
        descriptor = os.open(settings.artifact(name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(result.get("signature"), output)
        return {"ok": True, "result": {"status": "signed", "signature_name": name, "next_action": (
            f"Call styx_submit_payment with payment_id {payment_id} and signature_name {name}.")}}

    @server.tool()
    async def styx_propose_payment(
        recipient: str, amount_usdc: str, amount: str, invoice_name: str, invoice_reference: str,
        valid_until: int | None = None,
    ) -> dict[str, Any]:
        """Journal a new payment from an invoice file in the vault directory. Moves no funds.

        invoice_name is the invoice's file name in that directory, for example "inv-1001.txt": not the
        vendor's name and not a path.

        amount_usdc is the amount in USDC as the invoice states it ("30" for 30 USDC, "0.5" for half).
        amount is the same amount in base units, 1 USDC = 1000000 ("30000000" for 30 USDC). Both are
        required and must agree; a mismatch is refused so a unit mistake cannot pay the wrong amount.
        Leave valid_until out unless you were given a time: it defaults to one hour from now.
        """
        try:
            invoice = settings.artifact(invoice_name)
            expected = usdc_to_base_units(amount_usdc)
        except VaultError as error:
            return invalid(error)
        units_mistake = _units_mistake(Path(invoice), amount_usdc)
        if units_mistake:
            return invalid(VaultError(_INVALID, units_mistake))
        if amount.strip() != str(expected):
            return invalid(VaultError(_INVALID, (
                f"amounts disagree: amount_usdc {amount_usdc} USDC is {expected} base units, but amount is "
                f"{amount}. Restate both from the invoice")))
        response = await call("propose", recipient=recipient, amount=amount, invoice_file=invoice,
                              invoice_reference=invoice_reference,
                              valid_until=valid_until if valid_until is not None else int(time.time()) + _DEFAULT_PAYMENT_SECONDS)
        if response["ok"]:
            response["result"]["summary"] = f"{amount_usdc} USDC ({amount} base units) to {recipient}"
            response["result"]["check"] = (f"This pays {amount_usdc} USDC. If that is not the amount the invoice asks for, "
                                           "do not submit it: propose again with the invoice's amount.")
            response["result"]["next_action"] = (
                "Over the per-payment limit: call styx_request_owner_approval with this payment_id, then wait for "
                "the approver's signature." if response["result"].get("path") == "exception_required"
                else "Within the limits: call styx_submit_payment with this payment_id.")
        return add_next(response)

    @server.tool()
    async def styx_request_owner_approval(
        payment_id: str, authorization_expiry: int | None = None, signer: str | None = None,
    ) -> dict[str, Any]:
        """Ask an approver to sign this exact payment; they review it on their signing page. Moves no funds.

        Leave authorization_expiry out unless you were given a time: it defaults to one hour from now.
        signer names the approver: their NEAR public key (ed25519:...), or on an EVM v2 vault an address.
        Leave it out to ask the vault's default approver.
        """
        near_signer = signer is not None and re.fullmatch(_NEAR_KEY, signer, flags=re.ASCII) is not None
        if signer is not None and not near_signer and not is_v2:
            return invalid(VaultError(_INVALID, "signer must be the approver's NEAR public key, ed25519:..."))
        if signer is not None and not near_signer and not re.fullmatch(r"0x[0-9a-fA-F]{40}", signer, flags=re.ASCII):
            return invalid(VaultError(_INVALID, "signer must be an address or a NEAR public key (ed25519:...)"))
        tag = (signer[8:16] if near_signer else signer[2:10].lower()) if signer else None
        if authorization_expiry is None:
            authorization_expiry = int(time.time()) + _DEFAULT_PAYMENT_SECONDS
        stem = payment_id.removeprefix("0x")[:12]
        # A different approver needs a new file, because the CLI never overwrites one.
        name = f"pending-{stem}-{tag}.json" if tag else f"pending-{stem}.json"
        try:
            pending = settings.artifact(name)
        except VaultError as error:
            return invalid(error)
        # On v2 the binary decides: a live identical request keeps its authorization, and an expired or
        # stale one gets a new one under the same payment ID. It never overwrites a file, so each ask gets a new one.
        if is_v2:
            attempt = 0
            while Path(pending).exists():
                attempt += 1
                name = f"pending-{payment_id.removeprefix('0x')[:32]}-{tag or 'default'}-{attempt}.json"
                try:
                    pending = settings.artifact(name)
                except VaultError as error:
                    return invalid(error)
        # On v1, asking again with a relay re-sends the existing request, which retries a failed alert.
        if not is_v2 and settings.relay_url and Path(pending).exists():
            response: dict[str, Any] = {"ok": True, "result": {"status": "ok"}}
        else:
            response = await call("request_approval", payment_id=payment_id,
                                  authorization_expiry=authorization_expiry, pending_file=pending,
                                  **({"signer": signer} if signer else {}))
        if response["ok"]:
            response["result"]["pending_file"] = name
            if settings.relay_url:
                response["result"].update(await asyncio.to_thread(send_to_relay, pending, stem))
                response["result"]["next_action"] = (
                    "Tell your user in one line that the approver was asked, then call styx_check_owner_approval with "
                    "this payment_id and wait_seconds 300: it returns as soon as the approver signs. When it says "
                    "signed, submit right away. Do not propose again."
                    if response["result"].get("owner_alerted") else
                    "The request is waiting, but the approver was not alerted (they may not have linked their Telegram, "
                    "or the relay is down). Tell your user an approval is needed, then call styx_check_owner_approval "
                    "with this payment_id. Do not propose again.")
            else:
                response["result"]["next_action"] = (
                    f"Give the approver {name} to sign on their signing page, then pass their signature file to "
                    "styx_submit_payment. Do not propose again.")
        return add_next(response)

    @server.tool()
    async def styx_submit_payment(payment_id: str, signature_name: str | None = None) -> dict[str, Any]:
        """Submit a proposed payment, or reconcile an earlier attempt under the same ID.

        Pass the approver's signature file name for an exception. A state of 'unknown' is not a failure.
        """
        try:
            signature = settings.artifact(signature_name) if signature_name is not None else None
        except VaultError as error:
            return invalid(error)
        response = await call("submit", payment_id=payment_id, signature_file=signature)
        if response["ok"]:
            state = response["result"].get("state")
            response["result"]["next_action"] = (
                "Done: the payment settled on chain. Report tx_hash." if state == "settled" else
                "Not a failure and not unpaid: retry styx_submit_payment with the same payment_id later.")
        return add_next(response)

    @server.tool()
    async def styx_payment_status(payment_id: str) -> dict[str, Any]:
        """Read a payment's state from the chain: settled, not_settled, or unavailable."""
        response = await call("status", payment_id=payment_id)
        if response["ok"]:
            state = response["result"].get("state")
            response["result"]["next_action"] = (
                "Done: it settled on chain. Report tx_hash." if state == "settled" else
                "Not paid yet. If it was proposed and not submitted, call styx_submit_payment with this payment_id; "
                "do not propose it again.")
        return add_next(response)

    if settings.relay_url:
        @server.tool()
        async def styx_check_owner_approval(payment_id: str, wait_seconds: int = 0) -> dict[str, Any]:
            """Check whether the approver has signed. When signed, pass signature_name to styx_submit_payment.

            With wait_seconds (up to 600), keep checking and return as soon as the approver signs or declines,
            the request expires or fails, or the wait ends with status pending. Declined is final: do not pay.
            """
            deadline = time.monotonic() + max(0, min(int(wait_seconds), _MAX_WAIT_SECONDS))
            try:
                while True:
                    response = await asyncio.to_thread(fetch_signature, payment_id)
                    pending = response.get("ok") and response["result"].get("status") == "pending"
                    if not pending or time.monotonic() + _POLL_SECONDS > deadline:
                        return response
                    await asyncio.sleep(_POLL_SECONDS)
            except VaultError as error:
                return invalid(error)

    return server
