"""Tests for the runner and the NEAR AI client, with fixtures recorded live (see reviewer-near/tests/test_inference.py)
and a stub MCP server. The live run is documented in docs/near/NEAR_AI.md."""
import asyncio
import copy
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from styx_near_ai import nearai
from styx_near_ai.nearai import InferenceError, NearAI, Preflight
from styx_near_ai.runner import run
from styx_near_review.inference import Quote, sha256_hex, verify_report

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / 'fixtures'
MODEL = 'z-ai/glm-5.3-flash'
REPORT_BYTES = (FIXTURES / 'attestation-report.json').read_bytes()
REPORT = json.loads(REPORT_BYTES)
NONCE = REPORT['gateway_attestation']['request_nonce']
REQUEST, RESPONSE = (FIXTURES / 'request.bin').read_bytes(), (FIXTURES / 'response.bin').read_bytes()
SIGNATURE = json.loads((FIXTURES / 'signature.json').read_text())
PAYMENT_ID = '0x' + 'ab' * 32


def stub_quote(quote_hex):
    body = bytes.fromhex(quote_hex)[48:48 + 584]
    return Quote('UpToDate', body[520:584], body[184:232], bool(body[120] & 1))


VERIFIERS = {'quote_verifier': stub_quote, 'gpu_verifier': lambda payload: True}


class Reply:
    def __init__(self, content, status=200, url='https://cloud-api.near.ai/x'):
        self.content, self.status_code = content, status
        self.request = mock.Mock(url=url)

    def json(self):
        return json.loads(self.content)


class FakeSession:
    """Serves the recorded report and signature; records what was requested."""
    def __init__(self, signature=SIGNATURE, report=REPORT_BYTES):
        self.signature, self.report, self.gets = signature, report, []

    def get(self, url, **kwargs):
        self.gets.append((url, kwargs))
        if url.endswith('/v1/attestation/report'):
            return Reply(self.report, url=url + '?nonce=' + kwargs['params']['nonce'])
        return Reply(json.dumps(self.signature).encode())


def preflight():
    _, signers, _ = verify_report(REPORT, NONCE, **VERIFIERS)
    return Preflight(NONCE, 'https://cloud-api.near.ai/v1/attestation/report?nonce=' + NONCE, REPORT_BYTES, signers, ['fixture'], [])


class ClientTests(unittest.TestCase):
    def client(self, **kwargs):
        return NearAI(MODEL, api_key='test-key', verifiers=VERIFIERS, session=FakeSession(**kwargs))

    def test_preflight_verifies_the_recorded_report_with_our_nonce(self):
        client = self.client()
        with mock.patch.object(nearai.secrets, 'token_hex', return_value=NONCE):
            pre = client.preflight()
        self.assertEqual(pre.raw, REPORT_BYTES)
        self.assertEqual(sorted(pre.signers.values()), ['gateway', 'model'])
        url, kwargs = client.http.gets[0]
        self.assertEqual(kwargs['params']['provider'], 'near')
        self.assertNotIn('test-key', pre.url)

    def test_preflight_refuses_a_report_for_another_nonce(self):
        with self.assertRaises(InferenceError):
            self.client().preflight()  # a fresh random nonce, which the recorded report does not echo

    def test_signature_passes_for_the_exact_bytes(self):
        entry = self.client().verify_signature('id', sha256_hex(REQUEST), sha256_hex(RESPONSE), preflight())
        self.assertTrue(entry['verified'])
        self.assertEqual(entry['signing_address'], SIGNATURE['signing_address'])

    def test_hash_mismatch_is_refused(self):
        with self.assertRaises(InferenceError):
            self.client().verify_signature('id', sha256_hex(REQUEST), sha256_hex(RESPONSE + b'x'), preflight(), attempts=1)

    def test_bad_signature_is_refused(self):
        bad = {**SIGNATURE, 'signature': '0x' + '00' * 65}
        with self.assertRaises(InferenceError):
            self.client(signature=bad).verify_signature('id', sha256_hex(REQUEST), sha256_hex(RESPONSE), preflight())

    def test_unattested_signer_is_refused(self):
        pre = preflight()
        pre.signers = {k: v for k, v in pre.signers.items() if v == 'gateway'}
        with self.assertRaises(InferenceError):
            self.client().verify_signature('id', sha256_hex(REQUEST), sha256_hex(RESPONSE), pre)

    def test_key_goes_only_to_https(self):
        with self.assertRaises(InferenceError):
            NearAI(MODEL, api_key='k', base='http://example.com')
        with mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(InferenceError):
            NearAI(MODEL)


def completion(*calls, content=None):
    message = {'role': 'assistant', 'content': content,
               'tool_calls': [{'id': f'call{i}', 'type': 'function', 'function': {'name': n, 'arguments': json.dumps(a)}}
                              for i, (n, a) in enumerate(calls)] or None}
    return {'id': 'chat', 'model': MODEL, 'choices': [{'index': 0, 'message': message}]}


class ScriptedClient(NearAI):
    """Real NearAI object, scripted completions: each item is a reply dict or an InferenceError to raise."""
    def __init__(self, script):
        super().__init__(MODEL, api_key='test-key', verifiers=VERIFIERS, session=FakeSession())
        self.script = list(script)

    def preflight(self):
        return preflight()

    def complete(self, body, pre):
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item, {'chat_id': 'chat', 'request_sha256': '11' * 32, 'response_sha256': '22' * 32, 'signature': '0x00',
                      'signing_algo': 'ecdsa', 'signing_address': SIGNATURE['signing_address'],
                      'signature_kind': 'provider_tee', 'signed_text': 'x', 'verified': True}


PROPOSE = ('styx_propose_payment', {'recipient': 'vendor-a.testnet', 'amount': '25000000', 'invoice_name': 'inv.txt', 'invoice_reference': 'INV-1'})
SUBMIT = ('styx_submit_payment', {'payment_id': PAYMENT_ID})


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='runner-test-')).resolve()
        self.state = self.tmp / 'state'
        self.state.mkdir(mode=0o700)
        self.invoice = self.tmp / 'inv.txt'
        self.invoice.write_text('Invoice INV-1\nPay to: vendor-a.testnet\nAmount: 25 USDC\n')
        self.log = self.tmp / 'calls.jsonl'
        self.env = {'STUB_LOG': str(self.log), 'HOME': str(self.tmp), 'PATH': os.environ['PATH']}

    def run_with_stub(self, script):
        client = ScriptedClient(script)
        with mock.patch('styx_near_ai.runner.StdioServerParameters') as params:
            from mcp.client.stdio import StdioServerParameters as Real
            params.side_effect = lambda **kw: Real(**{**kw, 'args': [str(HERE / 'stub_mcp_server.py')]})
            return asyncio.run(run(client=client, invoice_path=self.invoice, instruction='', state_dir=self.state,
                                   mcp_env=self.env, mcp_python=sys.executable, mcp_cwd=HERE, log=lambda *_: None, max_turns=6))

    def calls(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_verified_run_pays_and_writes_evidence(self):
        report = self.run_with_stub([completion(PROPOSE), completion(SUBMIT), completion(content='paid')])
        self.assertIsNone(report['stopped'], report)
        self.assertEqual([c['tool'] for c in self.calls()], ['styx_propose_payment', 'styx_submit_payment'])
        stem = PAYMENT_ID[2:14]
        path = self.state / f'inference-{stem}.json'
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.state / f'attestation-{stem}.json').stat().st_mode), 0o600)
        doc = json.loads(path.read_text())
        self.assertEqual(doc['schema'], 'styx-near-inference/1')
        self.assertEqual(doc['payment_id'], PAYMENT_ID)
        self.assertEqual(doc['invoice_sha256'], sha256_hex(self.invoice.read_bytes()))
        self.assertEqual(doc['attestation']['report_sha256'], sha256_hex(REPORT_BYTES))
        self.assertEqual((self.state / f'attestation-{stem}.json').read_bytes(), REPORT_BYTES)
        self.assertEqual(len(doc['completions']), 3)
        self.assertEqual([c['tool'] for c in doc['tool_calls']], ['styx_propose_payment', 'styx_submit_payment'])
        self.assertNotIn('test-key', path.read_text())

    def test_failed_check_on_the_submitting_completion_submits_nothing(self):
        report = self.run_with_stub([completion(PROPOSE), InferenceError('response signature did not verify: boom'),
                                     completion(SUBMIT)])
        self.assertIn('did not verify', report['stopped'])
        self.assertEqual([c['tool'] for c in self.calls()], ['styx_propose_payment'])
        self.assertEqual(list(self.state.glob('inference-*.json')), [])

    def test_failed_attestation_runs_no_tool_at_all(self):
        client = ScriptedClient([completion(PROPOSE)])
        client.preflight = mock.Mock(side_effect=InferenceError('attestation did not verify: boom'))
        report = asyncio.run(run(client=client, invoice_path=self.invoice, instruction='', state_dir=self.state,
                                 mcp_env=self.env, mcp_python=sys.executable, mcp_cwd=HERE, log=lambda *_: None))
        self.assertIn('attestation', report['stopped'])
        self.assertEqual(self.calls(), [])

    def test_submit_of_an_id_the_vault_never_issued_writes_no_evidence(self):
        report = self.run_with_stub([completion(('styx_submit_payment', {'payment_id': '0x' + 'cd' * 32})), completion(content='done')])
        self.assertIsNone(report['stopped'])
        self.assertEqual(list(self.state.glob('inference-*.json')), [])


if __name__ == '__main__':
    unittest.main()
