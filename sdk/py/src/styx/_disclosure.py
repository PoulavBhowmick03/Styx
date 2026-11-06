"""Path-only subprocess binding for vault payment disclosure. No cryptography happens in Python."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any


class DisclosureError(RuntimeError):
    """Disclosure failed; this does not establish payment or non-payment."""


class DisclosureSeam:
    """Run a local disclosure binary. Python passes paths and never opens key files."""

    _parameters = {
        "version": set(),
        "keygen": {"key_file"},
        "key_info": {"key_file"},
        "export_vault_payment": {"record_file", "issuer_key_file", "recipient_public_key",
                                 "grant_file", "expires_at"},
        "verify_vault_payment": {"grant_file", "key_file", "expected_issuer", "deployment", "opened_file"},
    }
    _public_fields = {
        "status", "protocol", "methods", "recipient_public_key", "grant_saved", "issuer",
        "delivery_verified", "payment_id", "tx_hash", "record_integrity", "authorization",
        "settlement", "policy_at_execution", "reasons",
    }

    def __init__(self, binary: str | Path | None = None, timeout: int = 60) -> None:
        resolved = str(binary) if binary is not None else shutil.which("styx-disclosure")
        if not resolved or timeout <= 0:
            raise DisclosureError("configure a disclosure binary and a positive timeout")
        self._binary = resolved
        self._timeout = timeout

    def call(self, method: str, **parameters: Any) -> dict[str, Any]:
        """Forward one typed request; reject unexpected output rather than exposing it."""
        if method not in self._parameters or set(parameters) != self._parameters[method]:
            raise DisclosureError("invalid disclosure request fields")
        request = {"method": method, **parameters}
        try:
            completed = subprocess.run(
                [self._binary], input=json.dumps(request), capture_output=True,
                text=True, timeout=self._timeout, check=False,
            )
        except (OSError, subprocess.TimeoutExpired, UnicodeError):
            raise DisclosureError("disclosure process unavailable; retain evidence and retry") from None
        try:
            response = json.loads(completed.stdout)
        except (ValueError, TypeError):
            raise DisclosureError("invalid disclosure response") from None
        if completed.returncode != 0 or not isinstance(response, dict) or response.get("status") != "ok":
            raise DisclosureError("disclosure verification or storage failed; retain evidence and retry")
        if completed.stderr or set(response) - self._public_fields:
            raise DisclosureError("unexpected disclosure response fields")
        # No nested plaintext, key material, or private evidence belongs in a model result.
        for name, value in response.items():
            if name == "methods":
                if not isinstance(value, list) or any(
                    not isinstance(item, str) or item not in self._parameters for item in value
                ):
                    raise DisclosureError("invalid disclosure capabilities")
            elif type(value) not in (str, int, bool) or (isinstance(value, str) and len(value) > 256):
                raise DisclosureError("invalid disclosure response shape")
        return response
