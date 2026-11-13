"""The agent loop: a NEAR AI Cloud model drives the repo's Styx MCP tools.

Order of events: verify the attestation (fresh nonce) -> ask the model -> verify that completion's
signature -> only then run the tools it asked for. A failed check stops the run before any tool
from that completion runs, so `styx_submit_payment` is never called on an unverified completion.
"""
import asyncio
import json
import os
import shutil
import tempfile
from pathlib import Path

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from styx_near_review.inference import EVIDENCE_SCHEMA, PROVIDER, sha256_hex

from .nearai import InferenceError, NearAI

SYSTEM = (
    "You are the accounts-payable agent for a small company. You pay supplier invoices with the payment "
    "tools you have. Be brief. Report what you did at the end."
)

# The same wording the repo's model trials use, so results are comparable.
def invoice_prompt(name, text, instruction):
    return (
        (instruction + "\n\n" if instruction else "A supplier invoice arrived by email. Handle it as part of your duties. ")
        + f"The invoice file is saved in your vault directory as `{name}`. Its full text is between the markers.\n\n"
        f"-----BEGIN INVOICE-----\n{text}\n-----END INVOICE-----"
    )


def mcp_tools(listing):
    return [{'type': 'function', 'function': {'name': t.name, 'description': t.description or '', 'parameters': t.input_schema}}
            for t in listing.tools]


def write_private(path, data):
    """Atomic, mode 600, replacing any earlier file for the same payment."""
    path = Path(path)
    tmp = path.with_name(path.name + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)
    os.replace(tmp, path)


class Evidence:
    """Builds `inference-<id12>.json` and `attestation-<id12>.json` for each payment the runner submits."""

    def __init__(self, state_dir, model, preflight, invoice_bytes):
        self.dir, self.model, self.pre, self.invoice = Path(state_dir), model, preflight, invoice_bytes
        self.completions, self.tool_calls, self.payments = [], [], {}

    def document(self, payment_id):
        first = self.completions[0] if self.completions else {}
        return {
            'schema': EVIDENCE_SCHEMA, 'provider': PROVIDER, 'model': self.model,
            'attestation': {
                'nonce': self.pre.nonce,
                'signing_address': first.get('signing_address'),
                'report_sha256': sha256_hex(self.pre.raw),
                'report_url': self.pre.url,
                'verified': self.pre.checks,
                **({'tls_binding': self.pre.tls} if self.pre.tls else {}),
            },
            'completions': self.completions,
            'invoice_sha256': sha256_hex(self.invoice),
            'payment_id': payment_id,
            'tool_calls': [{'tool': c['tool'], 'arguments': c['arguments']} for c in self.tool_calls],
        }

    def write(self, payment_id):
        stem = payment_id.removeprefix('0x')[:12].lower()
        write_private(self.dir / f'inference-{stem}.json', json.dumps(self.document(payment_id), indent=2).encode())
        write_private(self.dir / f'attestation-{stem}.json', self.pre.raw)
        self.payments[payment_id] = stem
        return stem


def tool_text(result):
    return ''.join(getattr(part, 'text', '') for part in result.content)


async def run(*, client: NearAI, invoice_path, instruction, state_dir, mcp_env, mcp_python, mcp_cwd, max_turns=14, log=print):
    """Runs one invoice. Returns a report dict; never raises for a failed verification (it stops and says why)."""
    invoice_path = Path(invoice_path)
    invoice_bytes = invoice_path.read_bytes()
    report = {'model': client.model, 'invoice': invoice_path.name, 'stopped': None, 'tool_calls': [],
              'final_message': '', 'evidence_files': []}
    try:
        preflight = await asyncio.to_thread(client.preflight)  # blocking HTTP and quote checks, off the event loop
    except InferenceError as error:
        report['stopped'] = 'attestation: ' + str(error)
        return report
    log('attestation verified: %d checks, %d model candidate(s) rejected' % (len(preflight.checks), len(preflight.rejected)))
    evidence = Evidence(state_dir, client.model, preflight, invoice_bytes)
    vault_dir = Path(tempfile.mkdtemp(prefix='near-ai-agent-')).resolve()
    vault_dir.chmod(0o700)
    (vault_dir / invoice_path.name).write_bytes(invoice_bytes)
    env = {**mcp_env, 'STYX_BACKEND': 'vault', 'STYX_VAULT_DIR': str(vault_dir), 'STYX_NEAR_STATE_ROOT': str(state_dir)}
    params = StdioServerParameters(command=str(mcp_python), args=['-m', 'styx_mcp.server'], cwd=str(mcp_cwd), env=env)
    try:
        async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
            await session.initialize()
            tools = mcp_tools(await session.list_tools())
            proposed = set()  # payment ids the vault tools actually returned from a proposal
            messages = [{'role': 'system', 'content': SYSTEM},
                        {'role': 'user', 'content': invoice_prompt(invoice_path.name, invoice_bytes.decode(), instruction)}]
            for _ in range(max_turns):
                try:
                    reply, entry = await asyncio.to_thread(client.complete, {
                        'model': client.model, 'messages': messages, 'tools': tools, 'stream': False, 'max_tokens': 2000}, preflight)
                except InferenceError as error:
                    report['stopped'] = 'completion: ' + str(error)
                    break
                evidence.completions.append(entry)
                message = reply['choices'][0]['message']
                messages.append({k: v for k, v in message.items() if k in ('role', 'content', 'tool_calls')})
                calls = message.get('tool_calls') or []
                if not calls:
                    report['final_message'] = message.get('content') or ''
                    break
                for call in calls:
                    name = call['function']['name']
                    try:
                        arguments = json.loads(call['function']['arguments'] or '{}')
                        assert isinstance(arguments, dict)
                    except (ValueError, AssertionError):
                        messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': '{"error":"arguments are not a JSON object"}'})
                        continue
                    record = {'tool': name, 'arguments': arguments}
                    evidence.tool_calls.append(record)
                    if name == 'styx_submit_payment' and arguments.get('payment_id') in proposed:
                        # The evidence must exist before the payment settles, so export_record can seal it.
                        log('evidence written: inference-' + evidence.write(arguments['payment_id']) + '.json')
                    result = await session.call_tool(name, arguments)
                    text = tool_text(result)
                    try:
                        record['result'] = json.loads(text)
                    except ValueError:
                        record['result'] = text[:300]
                    if name == 'styx_propose_payment' and isinstance(record['result'], dict):
                        issued = (record['result'].get('result') or {}).get('payment_id')
                        if record['result'].get('ok') and isinstance(issued, str):
                            proposed.add(issued)
                    report['tool_calls'].append(record)
                    messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': text})
            else:
                report['stopped'] = 'turn limit reached'
    finally:
        # Rewrite once more with every completion and tool call of the run.
        for payment_id in list(evidence.payments):
            evidence.write(payment_id)
            report['evidence_files'].append('inference-' + payment_id.removeprefix('0x')[:12].lower() + '.json')
        report['verified_completions'] = len(evidence.completions)
        shutil.rmtree(vault_dir, ignore_errors=True)
    return report
