"""The reviewer's MCP tools, over the local styx-disclosure command."""

from __future__ import annotations

import asyncio
import json
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from styx import DisclosureError, DisclosureSeam
from mcp.server import MCPServer

from styx_mcp.config import ConfigError


@dataclass(frozen=True)
class DisclosureSettings:
    artifacts: Path
    key_file: Path
    binary: str | None = None
    vault_issuer_key_file: str | None = None
    vault_pins: dict[str, Any] | None = field(default=None, repr=False)

    @classmethod
    def from_env(cls) -> DisclosureSettings:
        directory = os.environ.get("STYX_DISCLOSURE_DIR")
        if not directory:
            raise ConfigError("STYX_DISCLOSURE_DIR must name an existing private directory")
        root = Path(directory).expanduser()
        try:
            info = root.lstat()
        except OSError:
            raise ConfigError("disclosure directory is unavailable") from None
        if not stat.S_ISDIR(info.st_mode) or (os.name == "posix" and info.st_mode & 0o077):
            raise ConfigError("disclosure directory must be a real owner-only directory")
        vault_pins = None
        if encoded := os.environ.get("STYX_DISCLOSURE_VAULT_PINS"):
            try:
                vault_pins = json.loads(encoded)
            except ValueError:
                raise ConfigError("invalid disclosure vault pins JSON") from None
            if not isinstance(vault_pins, dict):
                raise ConfigError("disclosure vault pins must be an object")
        root = root.resolve()
        return cls(
            artifacts=root,
            key_file=Path(os.environ.get("STYX_DISCLOSURE_KEY_FILE", str(root / "auditor.key"))),
            binary=os.environ.get("STYX_DISCLOSURE_CLI"),
            vault_issuer_key_file=os.environ.get("STYX_DISCLOSURE_VAULT_ISSUER_KEY_FILE"),
            vault_pins=vault_pins,
        )

    def artifact(self, name: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}", name, flags=re.ASCII):
            raise DisclosureError("artifact name must be a single bounded filename")
        return str(self.artifacts / name)


def build_disclosure_server(settings: DisclosureSettings | None = None) -> MCPServer:
    """No wallet or private file reads in Python."""
    settings = settings or DisclosureSettings.from_env()
    try:
        seam = DisclosureSeam(binary=settings.binary)
        capabilities = seam.call("version")
    except DisclosureError:
        raise ConfigError("configured disclosure binary is unavailable or incompatible") from None
    if type(capabilities.get("protocol")) is not int or capabilities["protocol"] != 1:
        raise ConfigError("disclosure binary protocol mismatch")
    server = MCPServer(name="styx-disclosure", instructions=(
        "Verify or export one vault payment record using a local Rust binary. "
        "Tools do not return plaintext terms or keys, do not make payments, and never prove delivery. "
        "Missing evidence or failed verification does not establish non-payment."
    ))

    async def call(method: str, **parameters: Any) -> dict[str, Any]:
        try:
            response = await asyncio.to_thread(seam.call, method, **parameters)
            return {"ok": True, "result": response}
        except DisclosureError as error:
            return {"ok": False, "error": {"code": "DISCLOSURE_UNAVAILABLE", "message": str(error)}}

    @server.tool()
    async def create_disclosure_key() -> dict[str, Any]:
        """Create the configured auditor key without overwriting a key; return its public key only."""
        return await call("keygen", key_file=str(settings.key_file))

    @server.tool()
    async def disclosure_key_info() -> dict[str, Any]:
        """Recover the public auditor key from its configured local file without regenerating it."""
        return await call("key_info", key_file=str(settings.key_file))

    if settings.vault_issuer_key_file is not None:
        @server.tool()
        async def export_vault_payment(
            record_name: str, recipient_public_key: str, grant_name: str, expires_at: int,
        ) -> dict[str, Any]:
            """Encrypt one vault payment record to a reviewer without exposing its contents or keys."""
            try:
                record, grant = settings.artifact(record_name), settings.artifact(grant_name)
            except DisclosureError as error:
                return {"ok": False, "error": {"code": "INVALID_ARTIFACT", "message": str(error)}}
            return await call("export_vault_payment", record_file=record,
                              issuer_key_file=settings.vault_issuer_key_file,
                              recipient_public_key=recipient_public_key, grant_file=grant,
                              expires_at=expires_at)

    if settings.vault_pins is not None:
        @server.tool()
        async def verify_vault_payment(
            grant_name: str, expected_issuer: str, opened_name: str | None = None,
        ) -> dict[str, Any]:
            """Check one vault payment against the chain using only the reviewer's own RPC and pins.

            Reports record_integrity, authorization, settlement and policy_at_execution separately.
            'unavailable' means the chain could not be read, never unpaid.
            Pass opened_name to save the opened record, invoice included, in the private directory.
            """
            try:
                grant = settings.artifact(grant_name)
                opened = settings.artifact(opened_name) if opened_name is not None else None
            except DisclosureError as error:
                return {"ok": False, "error": {"code": "INVALID_ARTIFACT", "message": str(error)}}
            return await call("verify_vault_payment", grant_file=grant, key_file=str(settings.key_file),
                              expected_issuer=expected_issuer, deployment=settings.vault_pins,
                              opened_file=opened)
    return server
