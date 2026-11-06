"""Path-only subprocess binding for ``erebus-vault``. No cryptography and no keys in Python."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

UNAVAILABLE = "VERIFICATION_UNAVAILABLE"
INVALID = "INVALID_REQUEST"
KNOWN_CODES = {
    "POLICY_LIMIT",
    "OWNER_APPROVAL_REQUIRED",
    "POLICY_VERSION_CHANGED",
    "PAYMENT_ALREADY_SETTLED",
    UNAVAILABLE,
    INVALID,
}


class VaultError(RuntimeError):
    """A coded vault failure. ``VERIFICATION_UNAVAILABLE`` never means unpaid."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class VaultSeam:
    """Run the local vault binary. Python passes paths and never opens key or invoice files."""

    _parameters = {
        "version": set(),
        "propose": {"recipient", "amount", "invoice_file", "invoice_reference", "valid_until"},
        "request_approval": {"payment_id", "authorization_expiry", "pending_file"},
        "submit": {"payment_id", "signature_file"},
        "status": {"payment_id"},
        "export_record": {"payment_id", "record_file"},
    }
    _public_fields = {
        "status", "protocol", "payment_id", "payment_hash", "path", "pending_file",
        "approval_digest", "tx_hash", "state", "record_file",
    }

    def __init__(self, binary: str | Path | None = None, timeout: int = 180) -> None:
        resolved = str(binary) if binary is not None else shutil.which("erebus-vault")
        if not resolved or timeout <= 0:
            raise VaultError(INVALID, "configure the erebus-vault binary")
        self._binary = resolved
        self._timeout = timeout

    def call(self, method: str, **parameters: Any) -> dict[str, Any]:
        """Forward one typed request; reject unexpected output rather than passing it to a model."""
        allowed = self._parameters.get(method)
        if allowed is None or set(parameters) - allowed:
            raise VaultError(INVALID, "invalid vault request fields")
        request = {
            "method": method,
            **{name: value for name, value in parameters.items() if value is not None},
        }
        try:
            completed = subprocess.run(
                [self._binary], input=json.dumps(request), capture_output=True,
                text=True, timeout=self._timeout, check=False,
            )
        except (OSError, subprocess.TimeoutExpired, UnicodeError):
            # The transaction may have been sent. The caller retries under the same payment ID.
            raise VaultError(UNAVAILABLE, "the vault process did not finish; retry with the same payment ID") from None
        try:
            response = json.loads(completed.stdout)
        except (ValueError, TypeError):
            raise VaultError(UNAVAILABLE, "invalid vault response; retry with the same payment ID") from None
        if not isinstance(response, dict):
            raise VaultError(UNAVAILABLE, "invalid vault response; retry with the same payment ID")
        if response.get("status") == "error":
            code = response.get("code")
            message = response.get("message")
            if code not in KNOWN_CODES or not isinstance(message, str) or set(response) != {"status", "code", "message"}:
                raise VaultError(UNAVAILABLE, "invalid vault error; retry with the same payment ID")
            raise VaultError(code, message[:512])
        if completed.returncode != 0 or response.get("status") != "ok":
            raise VaultError(UNAVAILABLE, "invalid vault response; retry with the same payment ID")
        if set(response) - self._public_fields or any(
            type(value) not in (str, int) or (isinstance(value, str) and len(value) > 4096)
            for value in response.values()
        ):
            raise VaultError(UNAVAILABLE, "unexpected vault response fields")
        return response
