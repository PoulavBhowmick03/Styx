"""styx-near-ai-agent: run one invoice through a NEAR AI Cloud model that drives the Styx MCP tools."""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from .nearai import InferenceError, NearAI
from .runner import run

ROOT = Path(__file__).resolve().parents[2]
# The model runs only in TEE models on NEAR's own fleet that list `tools`; see docs/near/NEAR_AI.md.
DEFAULT_MODEL = 'z-ai/glm-5.3-flash'
# What the MCP server and the NEAR CLI need. NEARAI_API_KEY is deliberately not passed on.
CLI_VARIABLES = ('STYX_NEAR_VAULT', 'STYX_NEAR_AGENT_KEY_FILE', 'STYX_NEAR_APPROVER', 'STYX_NEAR_RPC_URL',
                 'STYX_NEAR_REVIEWER_KEY', 'STYX_NEAR_NETWORK')


def read_env_file(path):
    values = {}
    for line in Path(path).expanduser().read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.removeprefix('export ').split('=', 1)
            values[key.strip()] = value.strip().strip('"\'')
    return values


def main(argv=None):
    parser = argparse.ArgumentParser(prog='styx-near-ai-agent', description=__doc__)
    parser.add_argument('invoice', help='invoice file')
    parser.add_argument('--instruction', default='', help='a short instruction to the agent')
    parser.add_argument('--env', default=os.environ.get('STYX_NEAR_DEMO_ENV'),
                        help='demo.env from scripts/near/quickstart.sh (or set STYX_NEAR_DEMO_ENV)')
    parser.add_argument('--model', default=DEFAULT_MODEL)
    parser.add_argument('--max-turns', type=int, default=14)
    parser.add_argument('--cli', default=str(ROOT / 'sdk/near/target/release/styx-near-vault'))
    parser.add_argument('--mcp-python', default=str(ROOT / '.venv/bin/python'),
                        help='interpreter with styx_mcp installed (the repo workspace venv)')
    parser.add_argument('--out', help='write the JSON report here (mode 600)')
    args = parser.parse_args(argv)
    if not args.env:
        parser.error('--env (or STYX_NEAR_DEMO_ENV) is required')
    conf = read_env_file(args.env)
    for needed in ('STYX_NEAR_VAULT', 'STYX_NEAR_AGENT_KEY_FILE', 'STYX_NEAR_STATE_ROOT'):
        if needed not in conf:
            parser.error(needed + ' missing from ' + args.env)
    try:
        client = NearAI(args.model)
    except InferenceError as error:
        print('stopped: ' + str(error), file=sys.stderr)
        return 2
    mcp_env = {k: conf[k] for k in CLI_VARIABLES if k in conf}
    mcp_env.update({k: os.environ[k] for k in ('HOME', 'PATH') if k in os.environ})
    mcp_env['STYX_VAULT_CLI'] = args.cli
    report = asyncio.run(run(client=client, invoice_path=args.invoice, instruction=args.instruction,
                             state_dir=conf['STYX_NEAR_STATE_ROOT'], mcp_env=mcp_env, mcp_python=args.mcp_python,
                             mcp_cwd=ROOT, max_turns=args.max_turns))
    text = json.dumps(report, indent=2)
    print(text)
    if args.out:
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as out:
            out.write(text + '\n')
    return 1 if report['stopped'] else 0
