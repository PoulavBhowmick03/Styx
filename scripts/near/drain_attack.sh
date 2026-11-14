#!/usr/bin/env bash
# Sequential allowed NEAR payments, no sleeps or retries. Usage: drain_attack.sh <n> <amount>
# Amount is USDC units (e.g. 1 or 0.25), converted exactly to 6-decimal base units.
# Reads ~/.styx-near/v3.env (override STYX_NEAR_DEMO_ENV); requires VENDOR and CLI settings.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${STYX_NEAR_DEMO_ENV:-$HOME/.styx-near/v3.env}"
case "$ENV_FILE" in "$HOME"/.styx-near/*.env) ;; *) echo 'Settings must be under ~/.styx-near/ (*.env)' >&2; exit 1;; esac
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
[ "$#" -eq 2 ] || { echo 'Usage: drain_attack.sh <n> <amount in USDC>' >&2; exit 1; }
export STYX_NEAR_CLI="${STYX_NEAR_CLI:-$ROOT/sdk/near/target/release/styx-near-vault}"
export STYX_NEAR_NETWORK="${STYX_NEAR_NETWORK:-testnet}"
python3 - "$ROOT" "$1" "$2" <<'PY'
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

root = Path(sys.argv[1]).resolve()
if not re.fullmatch(r'[1-9][0-9]*', sys.argv[2]):
    sys.exit('n must be a positive integer')
if not re.fullmatch(r'(0|[1-9][0-9]*)(\.[0-9]{1,6})?', sys.argv[3]):
    sys.exit('amount must be positive USDC with at most 6 decimals')
whole, _, fraction = sys.argv[3].partition('.')
amount = int(whole) * 1_000_000 + int(fraction.ljust(6, '0') or '0')
if not 0 < amount < 2**128:
    sys.exit('amount out of range')
if os.environ['STYX_NEAR_NETWORK'] != 'testnet' or os.getenv('NETWORK', 'testnet') != 'testnet':
    sys.exit('Testnet only')
for name in ('STYX_NEAR_VAULT', 'VENDOR'):
    if not os.environ.get(name, '').endswith('.testnet'):
        sys.exit(f'{name} must be a NEAR testnet account')
# Pin a public testnet RPC; do not inherit an arbitrary endpoint from payment settings.
# FastNEAR's: rpc.testnet.near.org rate-limited a 20-payment run after four payments (429).
os.environ['STYX_NEAR_RPC_URL'] = 'https://test.rpc.fastnear.com'
for name in ('STYX_NEAR_STATE_ROOT', 'STYX_NEAR_AGENT_KEY_FILE'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
    path = Path(os.environ[name]).expanduser().resolve()
    if path == root or root in path.parents:
        sys.exit(f'{name} must be outside the repo')
    os.environ[name] = str(path)
state = Path(os.environ['STYX_NEAR_STATE_ROOT'])
state.mkdir(parents=True, exist_ok=True, mode=0o700)
os.umask(0o077)
tag = 'drain-' + uuid.uuid4().hex
marker = state / 'sentinel-attack.json'
# A runner can read this marker; always end it, including on refusal or uncertain outcome.
def mark(active):
    tmp = state / (tag + '-marker.tmp')
    tmp.write_text(json.dumps({'attack_id': tag, 'active': active, 'time': int(time.time()),
                               'vault': os.environ['STYX_NEAR_VAULT']}))
    tmp.replace(marker)

def call(request):
    result = subprocess.run([os.environ['STYX_NEAR_CLI']], input=json.dumps(request),
                            text=True, capture_output=True)
    print(result.stdout.strip(), flush=True)
    try:
        response = json.loads(result.stdout)
    except ValueError:
        sys.exit('CLI returned no valid outcome; stop and reconcile before another run')
    if result.returncode or response.get('status') == 'error':
        if 'VaultPaused' in response.get('message', ''):
            print('Stopped: VaultPaused (sentinel or owner paused the vault).', flush=True)
            sys.exit(0)
        sys.exit('Stopped on first refusal or unknown outcome; inspect the printed response before retrying')
    return response

mark(True)
try:
    for i in range(int(sys.argv[2])):
        reference = f'{tag}-{i + 1}'
        invoice = state / (reference + '.txt')
        invoice.write_text(f'Sentinel drain demonstration {reference}: {sys.argv[3]} USDC\n')
        proposal = call({'method': 'propose', 'recipient': os.environ['VENDOR'],
                         'amount': str(amount), 'invoice_file': str(invoice),
                         'invoice_reference': reference, 'valid_until': int(time.time()) + 3600})
        print(f'Payment {i + 1}/{sys.argv[2]}', flush=True)
        outcome = call({'method': 'submit', 'payment_id': proposal['payment_id']})
        if outcome.get('state') != 'settled':
            sys.exit('Stopped: payment did not settle; reconcile before another run')
    print('Completed requested payments without a refusal.', flush=True)
finally:
    mark(False)
PY
