"""Writes a new ed25519 key file in NEAR's format, owner-only. Never inside the repo.

Usage: uv run --with pynacl --with base58 scripts/near/keygen.py <path>
"""
import json, os, sys
import base58
from nacl.signing import SigningKey

path = sys.argv[1]
if os.path.realpath(path).startswith(os.path.realpath(os.path.join(os.path.dirname(__file__), "..", ".."))):
    sys.exit("refusing to write a key inside the repo")
key = SigningKey.generate()
public = bytes(key.verify_key)
secret = bytes(key) + public  # NEAR's 64-byte secret encoding
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"public_key": "ed25519:" + base58.b58encode(public).decode(),
               "private_key": "ed25519:" + base58.b58encode(secret).decode()}, f)
print("ed25519:" + base58.b58encode(public).decode())
