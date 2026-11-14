"""Sentinel keys: NEAR ed25519 key files kept outside the repo (default ~/.styx-near/sentinels/),
owner-only. Only the public key is ever shown or shared; the owner installs it on the vault."""
from __future__ import annotations

import json
import os
from pathlib import Path

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(data: bytes) -> str:
    n, out = int.from_bytes(data, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def key_dir() -> Path:
    return Path(os.environ.get("STYX_SENTINEL_KEY_DIR", Path.home() / ".styx-near" / "sentinels"))


def new_key(name: str, vault: str, directory: Path | None = None) -> tuple[str, Path]:
    """Creates a key file (0600, in a 0700 directory) and returns (public key, path)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization as s
    directory = directory or key_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    secret = Ed25519PrivateKey.generate()
    seed = secret.private_bytes(s.Encoding.Raw, s.PrivateFormat.Raw, s.NoEncryption())
    public = secret.public_key().public_bytes(s.Encoding.Raw, s.PublicFormat.Raw)
    pk = "ed25519:" + b58(public)
    path = directory / f"{name}.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"account_id": vault, "public_key": pk, "private_key": "ed25519:" + b58(seed + public)}, f)
    return pk, path
