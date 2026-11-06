"""Agent payment tools over ``erebus-vault``. Enabled only by ``EREBUS_BACKEND=vault``.

The agent's environment holds only the agent key. There are no policy, withdraw or signing tools:
an exception is possible only with a signature the owner produced elsewhere.
"""

from __future__ import annotations

import asyncio
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from erebus import VaultError, VaultSeam
from mcp.server import MCPServer

from erebus_mcp.config import ConfigError

_INVALID = "INVALID_REQUEST"
# A key in the agent's environment would let a compromised agent act as someone else.
_FORBIDDEN_VARIABLES = ("EREBUS_VAULT_OWNER_KEY", "EREBUS_VAULT_OWNER_KEY_FILE", "EREBUS_DISCLOSURE_KEY_FILE")


@dataclass(frozen=True)
class VaultSettings:
    artifacts: Path
    binary: str | None = None

    @classmethod
    def from_env(cls) -> VaultSettings:
        directory = os.environ.get("EREBUS_VAULT_DIR")
        if not directory:
            raise ConfigError("EREBUS_VAULT_DIR must name an existing private directory")
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
        return cls(artifacts=root.resolve(), binary=os.environ.get("EREBUS_VAULT_CLI"))

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
    server = MCPServer(name="erebus-vault", instructions=(
        "Propose and submit payments the vault allows. Amounts are decimal strings in USDC base units: "
        "1 USDC is 1000000. On-chain rules enforce the limits, not these tools. "
        "A payment over the per-payment limit needs the owner's signature; request it and wait. "
        "You cannot approve an exception, change policy or withdraw. "
        "Never retry a failed or unknown payment under a new proposal: "
        "VERIFICATION_UNAVAILABLE and state 'unknown' never mean unpaid, so retry erebus_submit_payment "
        "with the same payment_id."
    ))

    async def call(method: str, **parameters: Any) -> dict[str, Any]:
        try:
            return {"ok": True, "result": await asyncio.to_thread(seam.call, method, **parameters)}
        except VaultError as error:
            return {"ok": False, "error": {"code": error.code, "message": error.message}}

    def invalid(error: VaultError) -> dict[str, Any]:
        return {"ok": False, "error": {"code": error.code, "message": error.message}}

    @server.tool()
    async def erebus_propose_payment(
        recipient: str, amount: str, invoice_name: str, invoice_reference: str, valid_until: int,
    ) -> dict[str, Any]:
        """Journal a new payment from an invoice file in the vault directory. Moves no funds."""
        try:
            invoice = settings.artifact(invoice_name)
        except VaultError as error:
            return invalid(error)
        return await call("propose", recipient=recipient, amount=amount, invoice_file=invoice,
                          invoice_reference=invoice_reference, valid_until=valid_until)

    @server.tool()
    async def erebus_request_owner_approval(payment_id: str, authorization_expiry: int) -> dict[str, Any]:
        """Write the approval request the owner opens on their signing page. Moves no funds."""
        name = f"pending-{payment_id.removeprefix('0x')[:12]}.json"
        try:
            pending = settings.artifact(name)
        except VaultError as error:
            return invalid(error)
        response = await call("request_approval", payment_id=payment_id,
                              authorization_expiry=authorization_expiry, pending_file=pending)
        if response["ok"]:
            response["result"]["pending_file"] = name
        return response

    @server.tool()
    async def erebus_submit_payment(payment_id: str, signature_name: str | None = None) -> dict[str, Any]:
        """Submit a proposed payment, or reconcile an earlier attempt under the same ID.

        Pass the owner's signature file name for an exception. A state of 'unknown' is not a failure.
        """
        try:
            signature = settings.artifact(signature_name) if signature_name is not None else None
        except VaultError as error:
            return invalid(error)
        return await call("submit", payment_id=payment_id, signature_file=signature)

    @server.tool()
    async def erebus_payment_status(payment_id: str) -> dict[str, Any]:
        """Read a payment's state from the chain: settled, not_settled, or unavailable."""
        return await call("status", payment_id=payment_id)

    return server
