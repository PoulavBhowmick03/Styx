"""Tests for inference evidence checks.

Fixtures in agent-near-ai/tests/fixtures were recorded live from NEAR AI Cloud on 13 Nov 2026 with
model z-ai/glm-5.3-flash: the attestation report (gateway and model), the exact request and response
bytes of one tool-calling completion, and the signature endpoint's answer for it.

Offline, the TDX quote and the GPU verdict are stubbed: the stub reads report_data, MRCONFIGID and
the debug bit straight out of the real quote bytes, so the binding checks run on real data, but the
quote's Intel signature chain and NVIDIA's verdict are NOT exercised here (they need the network;
the live run in docs/near/NEAR_AI.md did exercise them).
"""
import base64
import copy
import json
import unittest
from pathlib import Path

from styx_near_review.inference import (
    Quote, check_completion, check_signature, sha256_hex, verify_attestation, verify_evidence, verify_report,
)
from styx_near_review.verifier import VerificationError, verify
from test_verifier import CannedRPC, VAULT

FIXTURES = Path(__file__).resolve().parents[2] / 'agent-near-ai/tests/fixtures'
MODEL = 'z-ai/glm-5.3-flash'
REPORT_BYTES = (FIXTURES / 'attestation-report.json').read_bytes()
REPORT = json.loads(REPORT_BYTES)
NONCE = REPORT['gateway_attestation']['request_nonce']
REQUEST, RESPONSE = (FIXTURES / 'request.bin').read_bytes(), (FIXTURES / 'response.bin').read_bytes()
SIGNATURE = json.loads((FIXTURES / 'signature.json').read_text())


def stub_quote(quote_hex, status='UpToDate'):
    """TDX quote v4: 48-byte header, then the TD report body (MRCONFIGID at 184, attributes at 120, report_data at 520)."""
    raw = bytes.fromhex(quote_hex)
    body = raw[48:48 + 584]
    return Quote(status, body[520:584], body[184:232], bool(body[120] & 1))


def gpu_ok(payload):
    return True


VERIFIERS = {'quote_verifier': stub_quote, 'gpu_verifier': gpu_ok}


def entry(**changes):
    value = {'chat_id': 'c', 'request_sha256': sha256_hex(REQUEST), 'response_sha256': sha256_hex(RESPONSE),
             'signature': SIGNATURE['signature'], 'signing_algo': SIGNATURE['signing_algo'],
             'signing_address': SIGNATURE['signing_address'], 'signature_kind': SIGNATURE['signature_kind'],
             'signed_text': SIGNATURE['text'], 'verified': True}
    value.update(changes)
    return value


class SignatureTests(unittest.TestCase):
    def test_recorded_hashes_match_what_the_service_signed(self):
        self.assertEqual(SIGNATURE['text'], MODEL + ':' + sha256_hex(REQUEST) + ':' + sha256_hex(RESPONSE))

    def test_real_ecdsa_signature_passes(self):
        check_signature(SIGNATURE['text'], SIGNATURE['signature'], 'ecdsa', SIGNATURE['signing_address'])
        self.assertEqual(check_completion(entry(), MODEL), SIGNATURE['signing_address'])

    def test_bad_signature_fails(self):
        flipped = SIGNATURE['signature'][:-4] + ('0000' if SIGNATURE['signature'][-4:] != '0000' else '1111')
        with self.assertRaises(VerificationError):
            check_completion(entry(signature=flipped), MODEL)

    def test_wrong_signer_fails(self):
        with self.assertRaises(VerificationError):
            check_completion(entry(signing_address='0x' + '11' * 20), MODEL)

    def test_hash_mismatch_fails(self):
        # A response that was altered after signing has a different hash than the one signed.
        with self.assertRaises(VerificationError):
            check_completion(entry(response_sha256=sha256_hex(RESPONSE + b' ')), MODEL)
        with self.assertRaises(VerificationError):
            check_completion(entry(request_sha256=sha256_hex(REQUEST + b' ')), MODEL)

    def test_other_model_name_fails(self):
        with self.assertRaises(VerificationError):
            check_completion(entry(), 'other/model')

    def test_signer_must_be_attested(self):
        signers = {('ecdsa', '11' * 20): 'model'}
        with self.assertRaises(VerificationError):
            check_completion(entry(), MODEL, signers)


class AttestationTests(unittest.TestCase):
    def test_real_report_passes_and_names_both_signers(self):
        names, signers, rejected = verify_report(REPORT, NONCE, **VERIFIERS)
        self.assertEqual(rejected, [])
        self.assertEqual(sorted(signers.values()), ['gateway', 'model'])
        self.assertIn(('ecdsa', SIGNATURE['signing_address'][2:]), signers)
        self.assertTrue(any('MRCONFIGID' in n for n in names) and any('GPU' in n for n in names))

    def test_other_nonce_fails(self):
        with self.assertRaises(VerificationError):
            verify_report(REPORT, '00' * 32, **VERIFIERS)

    def test_quote_status_and_debug_mode_fail(self):
        candidate = REPORT['model_attestations'][0]
        with self.assertRaises(VerificationError):
            verify_attestation(candidate, NONCE, quote_verifier=lambda q: stub_quote(q, 'Revoked'), gpu_verifier=gpu_ok)
        debug = lambda q: Quote('UpToDate', *[getattr(stub_quote(q), f) for f in ('report_data', 'mr_config')], True)
        with self.assertRaises(VerificationError):
            verify_attestation(candidate, NONCE, quote_verifier=debug, gpu_verifier=gpu_ok)

    def test_signer_not_bound_by_the_quote_fails(self):
        report = copy.deepcopy(REPORT)
        report['model_attestations'][0]['signing_address'] = '0x' + '22' * 20
        with self.assertRaises(VerificationError):
            verify_report(report, NONCE, **VERIFIERS)

    def test_gpu_verdict_and_missing_gpu_evidence_fail(self):
        with self.assertRaises(VerificationError):
            verify_report(REPORT, NONCE, quote_verifier=stub_quote, gpu_verifier=lambda p: False)
        report = copy.deepcopy(REPORT)
        del report['model_attestations'][0]['nvidia_payload']
        with self.assertRaises(VerificationError):
            verify_report(report, NONCE, **VERIFIERS)

    def test_compose_hash_mismatch_fails(self):
        report = copy.deepcopy(REPORT)
        candidate = report['model_attestations'][0]
        tcb = candidate['info']['tcb_info']
        candidate['info']['tcb_info'] = (json.dumps({**json.loads(tcb), 'app_compose': 'tampered'})
                                         if isinstance(tcb, str) else {**tcb, 'app_compose': 'tampered'})
        with self.assertRaises(VerificationError):
            verify_report(report, NONCE, **VERIFIERS)


def evidence_for(record, **changes):
    payment = record['payment']
    value = {
        'schema': 'styx-near-inference/1', 'provider': 'near-ai-cloud', 'model': MODEL,
        'attestation': {'nonce': NONCE, 'signing_address': SIGNATURE['signing_address'],
                        'report_sha256': sha256_hex(REPORT_BYTES), 'report_url': 'https://cloud-api.near.ai/v1/attestation/report',
                        'verified': ['fixture']},
        'completions': [entry()],
        'invoice_sha256': sha256_hex(base64.b64decode(record['invoice'])),
        'payment_id': payment['payment_id'],
        'tool_calls': [{'tool': 'styx_propose_payment',
                        'arguments': {'recipient': payment['recipient'], 'amount': payment['amount']}}],
    }
    value.update(changes)
    return value


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.rpc = CannedRPC(exception=False)
        self.record = self.rpc.record

    def check(self, evidence, report=REPORT_BYTES):
        return verify_evidence(evidence, self.record, report, **VERIFIERS)

    def test_passes_with_and_without_the_report(self):
        evidence = evidence_for(self.record)
        with_report = self.check(evidence)
        self.assertTrue(any(l.startswith('7e') for l in with_report))
        self.assertTrue(any(l.startswith('7g') and 'PASS' in l for l in with_report))
        without = self.check(evidence, None)
        self.assertTrue(any('NOT CHECKED' in l for l in without))

    def test_each_mismatch_fails(self):
        cases = {
            'payment': evidence_for(self.record, payment_id='other'),
            'invoice': evidence_for(self.record, invoice_sha256='00' * 32),
            'tool call': evidence_for(self.record, tool_calls=[{'tool': 'styx_propose_payment', 'arguments': {'recipient': 'mallory.testnet', 'amount': '1'}}]),
            'schema': evidence_for(self.record, schema='styx-near-inference/2'),
            'no completions': evidence_for(self.record, completions=[]),
            'bad signature': evidence_for(self.record, completions=[entry(signature='0x' + '00' * 65)]),
        }
        for name, evidence in cases.items():
            with self.subTest(name), self.assertRaises(VerificationError):
                self.check(evidence)

    def test_report_that_differs_from_its_hash_fails(self):
        with self.assertRaises(VerificationError):
            self.check(evidence_for(self.record), REPORT_BYTES + b' ')

    def test_signer_outside_the_report_fails(self):
        report = copy.deepcopy(REPORT)
        report['model_attestations'][0]['signing_address'] = '0x' + '33' * 20
        raw = json.dumps(report).encode()
        evidence = evidence_for(self.record)
        evidence['attestation']['report_sha256'] = sha256_hex(raw)
        with self.assertRaises(VerificationError):
            self.check(evidence, raw)


class ReviewerIntegrationTests(unittest.TestCase):
    def test_absent_evidence_is_reported_not_failed(self):
        rpc = CannedRPC(exception=False)
        ok, lines = verify(rpc, VAULT, 'post', rpc.key)
        self.assertTrue(ok, lines)
        self.assertIn('7 inference evidence: NONE in this record (not a failure)', lines)

    def test_present_evidence_is_checked_inside_verify(self):
        rpc = CannedRPC(exception=False)
        rpc.record['inference_evidence'] = evidence_for(rpc.record)
        rpc.refresh()
        ok, lines = verify(rpc, VAULT, 'post', rpc.key, REPORT_BYTES, **VERIFIERS)
        self.assertTrue(ok, lines)
        self.assertEqual(lines[-1], 'PASS')
        self.assertTrue(any(l.startswith('7g') and 'PASS' in l for l in lines))

    def test_tampered_evidence_fails_the_record(self):
        rpc = CannedRPC(exception=False)
        rpc.record['inference_evidence'] = evidence_for(rpc.record, completions=[entry(response_sha256='11' * 32)])
        rpc.refresh()
        ok, lines = verify(rpc, VAULT, 'post', rpc.key, REPORT_BYTES, **VERIFIERS)
        self.assertFalse(ok, lines)
        self.assertEqual(lines[-1], 'FAIL')


if __name__ == '__main__':
    unittest.main()
