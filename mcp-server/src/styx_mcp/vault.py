"""Agent payment tools over ``styx-vault``. Enabled only by ``STYX_BACKEND=vault``.

The agent's environment holds only the agent key. There are no policy, withdraw or signing tools:
an exception is possible only with a signature the owner produced elsewhere.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
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
# Models do not know the current time, and a guessed deadline fails the payment.
_DEFAULT_PAYMENT_SECONDS = 3600
_RELAY_TIMEOUT_SECONDS = 15
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
        "Propose and submit payments the vault allows. Amounts are decimal strings in USDC base units: "
        "1 USDC is 1000000. On-chain rules enforce the limits, not these tools. "
        "A payment over the per-payment limit needs the owner's signature; request it and wait. "
        "You cannot approve an exception, change policy or withdraw. "
        "Never retry a failed or unknown payment under a new proposal: "
        "VERIFICATION_UNAVAILABLE and state 'unknown' never mean unpaid, so retry styx_submit_payment "
        "with the same payment_id."
    ))

    async def call(method: str, **parameters: Any) -> dict[str, Any]:
        try:
            return {"ok": True, "result": await asyncio.to_thread(seam.call, method, **parameters)}
        except VaultError as error:
            return {"ok": False, "error": {"code": error.code, "message": error.message}}

    def invalid(error: VaultError) -> dict[str, Any]:
        return {"ok": False, "error": {"code": error.code, "message": error.message}}

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
            return {"owner_alerted": sent.get("alerted") is True}
        except (OSError, ValueError, KeyError):
            return {"owner_alerted": False}

    def fetch_signature(payment_id: str) -> dict[str, Any]:
        stem = payment_id.removeprefix("0x")[:12]
        record = Path(settings.artifact(f"relay-{stem}.txt"))
        if not record.exists():
            return {"ok": False, "error": {"code": _INVALID, "message": "request the owner's approval first"}}
        try:
            result = relay_call(f"/requests/{record.read_text()}/signature")
        except urllib.error.HTTPError as error:
            if error.code == 410:
                return {"ok": True, "result": {"status": "expired"}}
            return {"ok": False, "error": {"code": _RELAY_UNAVAILABLE, "message": "the relay refused this check"}}
        except (OSError, ValueError):
            return {"ok": False, "error": {"code": _RELAY_UNAVAILABLE, "message": "the relay could not be reached"}}
        if result.get("status") != "signed":
            return {"ok": True, "result": {"status": "pending"}}
        name = f"signature-{stem}.json"
        descriptor = os.open(settings.artifact(name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(result.get("signature"), output)
        return {"ok": True, "result": {"status": "signed", "signature_name": name}}

    @server.tool()
    async def styx_propose_payment(
        recipient: str, amount: str, invoice_name: str, invoice_reference: str, valid_until: int | None = None,
    ) -> dict[str, Any]:
        """Journal a new payment from an invoice file in the vault directory. Moves no funds.

        Leave valid_until out unless you were given a time: it defaults to one hour from now.
        """
        try:
            invoice = settings.artifact(invoice_name)
        except VaultError as error:
            return invalid(error)
        return await call("propose", recipient=recipient, amount=amount, invoice_file=invoice,
                          invoice_reference=invoice_reference,
                          valid_until=valid_until if valid_until is not None else int(time.time()) + _DEFAULT_PAYMENT_SECONDS)

    @server.tool()
    async def styx_request_owner_approval(
        payment_id: str, authorization_expiry: int | None = None, signer: str | None = None,
    ) -> dict[str, Any]:
        """Write the approval request the owner opens on their signing page. Moves no funds.

        Leave authorization_expiry out unless you were given a time: it defaults to one hour from now.
        On a v2 vault, signer names the approver who should sign. Leave it out to ask the owner.
        """
        if signer is not None and not is_v2:
            return invalid(VaultError(_INVALID, "this vault only accepts the owner's signature"))
        if signer is not None and not re.fullmatch(r"0x[0-9a-fA-F]{40}", signer, flags=re.ASCII):
            return invalid(VaultError(_INVALID, "signer must be an address"))
        if authorization_expiry is None:
            authorization_expiry = int(time.time()) + _DEFAULT_PAYMENT_SECONDS
        stem = payment_id.removeprefix("0x")[:12]
        # A different approver needs a new file, because the CLI never overwrites one.
        name = f"pending-{stem}-{signer[2:10].lower()}.json" if signer else f"pending-{stem}.json"
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
                name = f"pending-{payment_id.removeprefix('0x')[:32]}-{(signer or 'owner').removeprefix('0x').lower()}-{attempt}.json"
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
        return response

    @server.tool()
    async def styx_submit_payment(payment_id: str, signature_name: str | None = None) -> dict[str, Any]:
        """Submit a proposed payment, or reconcile an earlier attempt under the same ID.

        Pass the owner's signature file name for an exception. A state of 'unknown' is not a failure.
        """
        try:
            signature = settings.artifact(signature_name) if signature_name is not None else None
        except VaultError as error:
            return invalid(error)
        return await call("submit", payment_id=payment_id, signature_file=signature)

    @server.tool()
    async def styx_payment_status(payment_id: str) -> dict[str, Any]:
        """Read a payment's state from the chain: settled, not_settled, or unavailable."""
        return await call("status", payment_id=payment_id)

    if settings.relay_url:
        @server.tool()
        async def styx_check_owner_approval(payment_id: str) -> dict[str, Any]:
            """Check whether the owner has signed. When signed, pass signature_name to styx_submit_payment.

            Pending means wait. Asking the owner again does not make approval arrive sooner.
            """
            try:
                return await asyncio.to_thread(fetch_signature, payment_id)
            except VaultError as error:
                return invalid(error)

    return server
