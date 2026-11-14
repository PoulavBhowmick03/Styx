#!/usr/bin/env bash
# Sentinels off, then on, as numbers. On the v3 vault in ~/.styx-near/v3.env (override STYX_NEAR_DEMO_ENV):
#   1. drain_attack.sh N AMOUNT with no sentinel runner: the "off" run spends that money on purpose;
#   2. wait for the burst window to clear (and for the owner's unpause, if the vault is paused);
#   3. start the swarm and run the same drain.
# Prints one table: payments settled, tUSDC lost, and the time from the first payment to the pause,
# with transaction links. Stops first if the vault's balance, the agent's daily limit or the vault's
# daily limit cannot cover both runs. Testnet only; reads settings, never keys.
#
# Usage: scripts/near/compare_sentinels.sh [N=8] [AMOUNT=1]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${STYX_NEAR_DEMO_ENV:-$HOME/.styx-near/v3.env}"
case "$ENV_FILE" in "$HOME"/.styx-near/*.env) ;; *) echo 'Settings must be under ~/.styx-near/ (*.env)' >&2; exit 1;; esac
[ -f "$ENV_FILE" ] || { echo "No settings at $ENV_FILE (see docs/near/SENTINELS.md)" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
export STYX_NEAR_DEMO_ENV="$ENV_FILE"
export STYX_NEAR_CLI="${STYX_NEAR_CLI:-$ROOT/sdk/near/target/release/styx-near-vault}"
[ -x "$STYX_NEAR_CLI" ] || { echo "Build the CLI first: cargo build --release --manifest-path $ROOT/sdk/near/Cargo.toml" >&2; exit 1; }
exec python3 - "$ROOT" "${1:-8}" "${2:-1}" <<'PY'
import base64, json, os, re, signal, subprocess, sys, time, urllib.request
from pathlib import Path

root, n, amount_text = Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
if not re.fullmatch(r'(0|[1-9][0-9]*)(\.[0-9]{1,6})?', amount_text) or n < 1:
    sys.exit('usage: compare_sentinels.sh [N >= 1] [AMOUNT in tokens, up to 6 decimals]')
whole, _, frac = amount_text.partition('.')
unit = int(whole) * 10**6 + int(frac.ljust(6, '0') or 0)
RPC = os.environ.get('STYX_SENTINEL_RPC', 'https://test.rpc.fastnear.com')
vault, network = os.environ.get('STYX_NEAR_VAULT', ''), os.environ.get('STYX_NEAR_NETWORK', 'testnet')
if network != 'testnet' or not vault.endswith('.testnet'):
    sys.exit('Testnet only: STYX_NEAR_VAULT must be a .testnet vault')
state_root = Path(os.environ['STYX_NEAR_STATE_ROOT']).expanduser()
home = Path(os.environ.get('STYX_SENTINEL_HOME', Path.home() / '.styx-near' / 'sentinels')) / vault
BURST_WINDOW = 300
link = lambda h: f'https://testnet.nearblocks.io/txns/{h}'


def rpc(method, params):
    for attempt in range(5):
        try:
            req = urllib.request.Request(RPC, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(),
                                         {'Content-Type': 'application/json'})
            reply = json.load(urllib.request.urlopen(req, timeout=20))
            if 'result' in reply:
                return reply['result']
        except OSError:
            pass
        time.sleep(2 + attempt * 2)
    sys.exit(f'RPC {method} failed after retries')


def view(account, method, args=None):
    r = rpc('query', {'request_type': 'call_function', 'finality': 'final', 'account_id': account, 'method_name': method,
                      'args_base64': base64.b64encode(json.dumps(args or {}).encode()).decode()})
    return json.loads(bytes(r['result']))


def block_time(tx_hash, sender):
    tx = rpc('tx', {'tx_hash': tx_hash, 'sender_account_id': sender, 'wait_until': 'FINAL'})
    header = rpc('block', {'block_id': tx['transaction_outcome']['block_hash']})['header']
    return int(header['timestamp_nanosec']) / 1e9, header['height']


def agent_key():
    return json.loads(Path(os.environ['STYX_NEAR_AGENT_KEY_FILE']).expanduser().read_text())['public_key']  # public part only


def runner_alive():
    return subprocess.run(['pgrep', '-f', f'styx-sentinels run --vault {vault}'], capture_output=True).returncode == 0


# ---- preflight: both runs must be affordable, nothing else watching ----------------------------
info = view(vault, 'get_vault')
if info.get('contract_version') != 3:
    sys.exit(f"{vault} is contract version {info.get('contract_version')}; sentinels need version 3")
if runner_alive():
    sys.exit('A sentinel runner is already watching this vault: stop it, the "off" run needs none')
need = 2 * n * unit
day = view(vault, 'current_day')
agent = agent_key()
policy = view(vault, 'get_agent', {'agent': agent}) or sys.exit('The agent in the settings has no policy on this vault')
left = {
    'vault balance': int(view(info['token'], 'ft_balance_of', {'account_id': vault})),
    "agent's daily limit": int(policy['daily_limit']) - int(view(vault, 'spent_by_agent', {'agent': agent, 'day': day})),
    "vault's daily limit": int(info['vault_daily_limit']) - int(view(vault, 'spent_by_vault', {'day': day})),
}
short = [f'{k}: {v / 1e6:g} left, both runs need {need / 1e6:g}' for k, v in left.items() if v < need]
if short:
    sys.exit('Stopping before any payment. ' + '; '.join(short))
if unit > int(policy['per_payment_limit']):
    sys.exit('AMOUNT is over the per-payment limit: the drain would need an approval, not a sentinel')
print(f'Budget ok: {need / 1e6:g} tUSDC across both runs; ' + ', '.join(f'{k} {v / 1e6:g}' for k, v in left.items()), flush=True)


def wait_unpaused():
    asked = False
    while view(vault, 'get_vault')['paused']:
        if not asked:
            print('The vault is paused. Unpause it as the owner (console, Sentinels panel); waiting.', flush=True)
            asked = True
        time.sleep(5)


def drain(tag):
    print(f'\n== {tag}: drain_attack.sh {n} {amount_text}', flush=True)
    out = subprocess.run([str(root / 'scripts/near/drain_attack.sh'), str(n), amount_text], capture_output=True, text=True)
    (state_root / f'compare-{tag}.log').write_text(out.stdout + out.stderr)
    settled = re.findall(r'"state":"settled","status":"ok","tx_hash":"([A-Za-z0-9]+)"', out.stdout)
    refused = 'VaultPaused' in out.stdout
    print(f'{len(settled)} settled' + (', then refused with VaultPaused' if refused else ''), flush=True)
    if not settled:
        sys.exit(f'No payment settled in the {tag} run: see {state_root}/compare-{tag}.log')
    return settled, refused, time.time()


def pauses_since(t):
    lineage = home / 'lineage.jsonl'
    if not lineage.exists():
        return []
    rows = [json.loads(line) for line in lineage.read_text().splitlines() if line.strip()]
    return [r for r in rows if r.get('action') == 'pause' and r.get('time', 0) >= t and r.get('tx')]


# ---- 1. sentinels off --------------------------------------------------------------------------
wait_unpaused()
off_txs, off_refused, off_end = drain('off')

# ---- 2. clear the burst window -----------------------------------------------------------------
last_t, _ = block_time(off_txs[-1], vault)
wait = max(0, last_t + BURST_WINDOW + 15 - time.time())
print(f'\nWaiting {wait:.0f} s for the {BURST_WINDOW} s burst window to clear, so the swarm judges only the next run.', flush=True)
time.sleep(wait)
wait_unpaused()

# ---- 3. sentinels on ---------------------------------------------------------------------------
started = time.time()
log = open(state_root / 'compare-runner.log', 'w')
env = {**os.environ, 'PYTHONUNBUFFERED': '1', 'STYX_SENTINEL_NO_BROWSER': '1'}
runner = subprocess.Popen(['uv', 'run', '-q', '--project', str(root / 'sentinels'), 'styx-sentinels', 'run', '--vault', vault,
                           '--cli', os.environ['STYX_NEAR_CLI'], '--rpc', RPC, '--ui', os.environ.get('STYX_SENTINEL_UI_PORT', '8790'),
                           '--attack-marker', str(state_root / 'sentinel-attack.json')],
                          stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
try:
    time.sleep(10)
    if runner.poll() is not None:
        sys.exit(f'The runner stopped: see {state_root}/compare-runner.log')
    on_txs, on_refused, on_end = drain('on')
    deadline = time.time() + 90
    while not pauses_since(started) and time.time() < deadline:
        time.sleep(2)
finally:
    os.killpg(runner.pid, signal.SIGTERM)
pause = (pauses_since(started) or [None])[-1]

# ---- the table ---------------------------------------------------------------------------------
t0_off, _ = block_time(off_txs[0], vault)
t0_on, h0_on = block_time(on_txs[0], vault)
if pause:
    tp, hp = block_time(pause['tx'], vault)
    to_pause = f"{tp - t0_on:.1f} s (blocks {h0_on} to {hp})"
    pause_cell = f"[`{pause['tx'][:8]}…`]({link(pause['tx'])}), by {pause['member']}: {pause['reason']}"
else:
    to_pause, pause_cell = 'no pause within 90 s', 'none'
rows = [
    ('Payments settled', f'{len(off_txs)} of {n}', f'{len(on_txs)} of {n}' + (', the next refused (`VaultPaused`)' if on_refused else '')),
    ('tUSDC lost', f'{len(off_txs) * unit / 1e6:g}', f'{len(on_txs) * unit / 1e6:g}'),
    ('First payment to pause', 'never paused', to_pause),
    ('First payment', f'[`{off_txs[0][:8]}…`]({link(off_txs[0])})', f'[`{on_txs[0][:8]}…`]({link(on_txs[0])})'),
    ('Last payment', f'[`{off_txs[-1][:8]}…`]({link(off_txs[-1])})', f'[`{on_txs[-1][:8]}…`]({link(on_txs[-1])})'),
    ('Pause', 'none', pause_cell),
]
table = ['| | Sentinels off | Sentinels on |', '| --- | --- | --- |', *[f'| {a} | {b} | {c} |' for a, b, c in rows]]
print('\n' + '\n'.join(table))
(state_root / 'compare-result.json').write_text(json.dumps({'vault': vault, 'n': n, 'amount': amount_text, 'off': off_txs, 'on': on_txs,
                                                             'pause': pause, 'table': table}, indent=1))
print(f'\nEvery transaction: {state_root}/compare-result.json. Record them with scripts/near/tx_outcome.sh.')
if view(vault, 'get_vault')['paused']:
    print('The vault is paused by the sentinel: read the reason in the console and unpause as the owner.')
PY
