import argparse
import base64
import json
import os
from pathlib import Path

from nacl.public import PrivateKey
from .verifier import RPC, verify


def main():
    parser = argparse.ArgumentParser(description='Verify one disclosed Styx NEAR payment; never submits transactions')
    commands = parser.add_subparsers(dest='command', required=True)
    generate = commands.add_parser('keygen')
    generate.add_argument('path')
    check = commands.add_parser('verify')
    for name in ['key', 'rpc', 'vault', 'tx']:
        check.add_argument('--' + name, required=True)
    check.add_argument('--attestation', help='raw NEAR AI Cloud attestation report saved by the agent runner; re-verified when the record has inference evidence')
    args = parser.parse_args()
    try:
        if args.command == 'keygen':
            private = PrivateKey.generate()
            encode = lambda x: base64.b64encode(bytes(x)).decode()
            data = {'schema': 'styx-near-reviewer-key/1', 'public_key': encode(private.public_key), 'secret_key': encode(private)}
            path = Path(args.path).expanduser()
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
                json.dump(data, output)
                output.write('\n')
            print(data['public_key'])
            return 0
        key = json.loads(Path(args.key).expanduser().read_text())
        report = Path(args.attestation).expanduser().read_bytes() if args.attestation else None
        ok, lines = verify(RPC(args.rpc), args.vault, args.tx, key, report)
        print('\n'.join(lines))
        return 0 if ok else 1
    except Exception as error:
        print('verification: FAIL (' + type(error).__name__ + ')\nFAIL')
        return 1
