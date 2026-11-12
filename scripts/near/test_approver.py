"""A TEST approver: signs a pending Styx exception with a local key file, the way a NEAR wallet's
signMessage (NEP-413) would. For scripts and attack runs only; real approvers sign in their wallet
on the approval page. Poulav reviews this file like any other signing code.

Usage: uv run --with pynacl --with base58 scripts/near/test_approver.py <key-file> <pending-file> <out-file>

The signature file names the approver's NEAR account. It comes from the key file's account_id, or
APPROVER_ACCOUNT. It is metadata: the signature proves the key, not the account.
"""
import base64, hashlib, json, os, struct, sys
import base58
from nacl.signing import SigningKey

def borsh_string(s: str) -> bytes:
    data = s.encode()
    return struct.pack("<I", len(data)) + data

def nep413_digest(message: str, nonce: bytes, recipient: str, callback_url) -> bytes:
    payload = struct.pack("<I", 2147484061) + borsh_string(message) + nonce + borsh_string(recipient)
    payload += b"\x00" if callback_url is None else b"\x01" + borsh_string(callback_url)
    return hashlib.sha256(payload).digest()

key_file, pending_file, out_file = sys.argv[1:4]
key = json.load(open(key_file))
secret = base58.b58decode(key["private_key"].removeprefix("ed25519:"))
signing = SigningKey(secret[:32])
public = "ed25519:" + base58.b58encode(bytes(signing.verify_key)).decode()
account = key.get("account_id") or os.environ.get("APPROVER_ACCOUNT")
if not account:
    sys.exit("set APPROVER_ACCOUNT or put account_id in the key file")
pending = json.load(open(pending_file))
assert pending["schema"] == "styx-near-pending/1", "not a NEAR pending file"
auth = pending["authorization"]
nonce = base64.b64decode(auth["approval_nonce"])
assert len(nonce) == 32
digest = nep413_digest(pending["message"], nonce, pending["vault"], auth.get("callback_url"))
signature = signing.sign(digest).signature
fd = os.open(out_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"schema": "styx-near-signature/1", "paymentId": pending["payment"]["payment_id"],
               "accountId": account, "publicKey": public,
               "signature": base64.b64encode(signature).decode(), "nonce": auth["approval_nonce"],
               "callbackUrl": auth.get("callback_url")}, f)
print(out_file)
