import base64
import copy
import hashlib
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from nacl.public import PrivateKey, SealedBox
from nacl.signing import SigningKey
from styx_near_review.verifier import verify, nep413, open_record, RPC
from styx_near_review.cli import main


def b64(b):
    return base64.b64encode(bytes(b)).decode()


def b58(raw):
    raw = bytes(raw)
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    value = int.from_bytes(raw, 'big')
    out = ''
    while value:
        value, n = divmod(value, 58)
        out = alphabet[n] + out
    return '1' * (len(raw) - len(raw.lstrip(b'\0'))) + out


VAULT = 'vault.styx-owner-c87a.testnet'


def log(standard, event, data):
    return 'EVENT_JSON:' + json.dumps({'standard': standard, 'version': '1.0.0', 'event': event, 'data': [data]})


def transaction(tx, method, args, logs):
    return {'final_execution_status': 'FINAL', 'status': {'SuccessValue': ''},
            'transaction': {'hash': tx, 'signer_id': VAULT, 'receiver_id': VAULT, 'actions': [
                {'FunctionCall': {'method_name': method, 'args': b64(json.dumps(args).encode())}}]},
            'transaction_outcome': {'outcome': {'receipt_ids': ['receipt-0']}},
            'receipts_outcome': [{'id': 'receipt-' + str(i), 'outcome': {
                'executor_id': executor, 'status': {'SuccessValue': ''},
                'receipt_ids': ['receipt-' + str(i+1)] if i < len(logs)-1 else [], 'logs': lines}}
                for i, (executor, lines) in enumerate(logs)]}


class CannedRPC:
    def __init__(self, exception=True):
        private = PrivateKey.generate()
        self.key = {'schema': 'styx-near-reviewer-key/1', 'public_key': b64(private.public_key), 'secret_key': b64(private)}
        salt = os.urandom(32)
        self.record = {'schema': 'styx-near-record/1', 'network': 'testnet', 'vault': VAULT,
                       'payment': {'payment_id': 'test-payment', 'agent': 'ed25519:agent',
                                   'token': 'usdc.styx-owner-c87a.testnet', 'recipient': 'vendor-a.styx-owner-c87a.testnet',
                                   'amount': '140000000', 'evidence_commitment': b64(hashlib.sha256(salt+b'invoice').digest())},
                       'payment_hash': b64(os.urandom(32)), 'invoice': b64(b'invoice'), 'salt': b64(salt),
                       'invoice_reference': 'TEST', 'settlement_tx': 'settlement', 'authorization': None, 'signature': None}
        self.message = 'exact contract message fixture'
        if exception:
            signer = SigningKey.generate()
            a = {'signer': 'ed25519:' + b58(signer.verify_key), 'payment_hash': self.record['payment_hash'],
                 'signer_version': 2, 'approval_nonce': b64(os.urandom(32)), 'authorization_expiry': '123456',
                 'callback_url': 'https://example.com/callback'}
            self.record['authorization'] = a
            self.record['signature'] = b64(signer.sign(nep413(self.message, a['approval_nonce'], VAULT, a['callback_url'])).signature)
        self.refresh()

    def refresh(self):
        r = self.record
        p = r['payment']
        sealed = b64(SealedBox(PrivateKey(base64.b64decode(self.key['secret_key'])).public_key).encrypt(json.dumps(r).encode()))
        event = {'payment_id': p['payment_id'], 'agent': p['agent'], 'payment_hash': r['payment_hash'], 'sealed': sealed}
        self.post = transaction('post', 'post_record', {'payment_id': p['payment_id'], 'sealed': sealed}, [(VAULT, [log('styx', 'record_sealed', event)])])
        a = r['authorization']
        execution = {**p, 'payment_hash': r['payment_hash'], 'exception': a is not None,
                     'signer': a['signer'] if a else None, 'signer_version': a['signer_version'] if a else None,
                     'approval_digest': b64(nep413(self.message, a['approval_nonce'], VAULT, a['callback_url'])) if a else None}
        args = {'payment': p, **({'authorization': a, 'signature': r['signature']} if a else {})}
        transfer = {'old_owner_id': VAULT, 'new_owner_id': p['recipient'], 'amount': p['amount'], 'memo': 'styx:'+p['payment_id']}
        self.settlement = transaction('settlement', 'pay_with_exception' if a else 'pay', args,
                                      [(p['token'], [log('nep141', 'ft_transfer', transfer)]), (VAULT, [log('styx', 'payment_executed', execution)])])
        self.hash = r['payment_hash']
        self.consumed = self.hash

    def transaction(self, tx, vault):
        value = self.post if tx == 'post' else self.settlement
        # Match the actual RPC boundary checks too.
        with patch.object(RPC, 'call', return_value=value):
            return RPC('https://example.com').transaction(tx, vault)

    def view(self, vault, method, args):
        return {'payment_hash': self.hash, 'consumed_payment': self.consumed, 'exception_message': self.message}[method]


class VerificationTests(unittest.TestCase):
    def assert_fail(self, rpc):
        ok, lines = verify(rpc, VAULT, 'post', rpc.key)
        self.assertFalse(ok, lines)
        self.assertEqual(lines[-1], 'FAIL')

    def test_routine_and_exception_pass(self):
        for exception in [False, True]:
            rpc = CannedRPC(exception)
            ok, lines = verify(rpc, VAULT, 'post', rpc.key)
            self.assertTrue(ok, lines)
            self.assertEqual(lines[-1], 'PASS')

    def test_seal_opens_only_for_reviewer(self):
        rpc = CannedRPC()
        args = json.loads(base64.b64decode(rpc.post['transaction']['actions'][0]['FunctionCall']['args']))
        self.assertEqual(open_record(rpc.key, args['sealed']), rpc.record)
        rpc.key['secret_key'] = b64(PrivateKey.generate())
        self.assert_fail(rpc)

    def test_each_record_failure(self):
        for field, value in [('vault', 'other.testnet'), ('invoice', b64(b'tampered')), ('salt', b64(b'short')),
                             ('payment_hash', b64(os.urandom(32))), ('signature', b64(os.urandom(64)))]:
            with self.subTest(field=field):
                rpc = CannedRPC(); rpc.record[field] = value; rpc.refresh()
                if field == 'payment_hash':
                    rpc.hash = b64(os.urandom(32))
                self.assert_fail(rpc)

    def test_consumed_missing_and_hash_mismatch(self):
        for value in [None, b64(os.urandom(32))]:
            rpc = CannedRPC(); rpc.consumed = value; self.assert_fail(rpc)

    def test_settlement_failure_and_missing_finality(self):
        for patch_value in [{'status': {'Failure': 'bad'}}, {'final_execution_status': 'EXECUTED'}]:
            rpc = CannedRPC(); rpc.settlement.update(patch_value); self.assert_fail(rpc)

    def test_execution_fields_and_origin(self):
        for field, value in [('payment_id', 'wrong'), ('agent', 'wrong'), ('recipient', 'wrong'), ('amount', '1'),
                             ('payment_hash', 'wrong'), ('signer', 'wrong'), ('signer_version', 999),
                             ('exception', False), ('approval_digest', b64(os.urandom(32)))]:
            rpc = CannedRPC()
            out = rpc.settlement['receipts_outcome'][1]['outcome']
            event = json.loads(out['logs'][0][11:]); event['data'][0][field] = value
            out['logs'][0] = 'EVENT_JSON:' + json.dumps(event)
            self.assert_fail(rpc)
        rpc = CannedRPC(); rpc.settlement['receipts_outcome'][1]['outcome']['executor_id'] = 'fake.testnet'; self.assert_fail(rpc)

    def test_missing_or_wrong_transfer(self):
        for field, value in [('old_owner_id', 'other.testnet'), ('new_owner_id', 'other.testnet'), ('amount', '1')]:
            rpc = CannedRPC(); out = rpc.settlement['receipts_outcome'][0]['outcome']
            event = json.loads(out['logs'][0][11:]); event['data'][0][field] = value; out['logs'][0] = 'EVENT_JSON:' + json.dumps(event)
            self.assert_fail(rpc)
        rpc = CannedRPC(); rpc.settlement['receipts_outcome'][0]['outcome']['logs'] = []; self.assert_fail(rpc)

    def test_callback_message_nonce_and_submitted_payload_tampering(self):
        for field, value in [('callback_url', None), ('approval_nonce', b64(os.urandom(32))), ('signer', 'ed25519:'+b58(os.urandom(32)))]:
            rpc = CannedRPC(); rpc.record['authorization'][field] = value; rpc.refresh(); self.assert_fail(rpc)
        rpc = CannedRPC(); rpc.message = 'tampered'; self.assert_fail(rpc)
        rpc = CannedRPC(); call = rpc.settlement['transaction']['actions'][0]['FunctionCall']; call['args'] = b64(json.dumps({'payment': {}}).encode()); self.assert_fail(rpc)

    def test_rpc_error_and_unrelated_receipt(self):
        rpc = CannedRPC()
        rpc.view = lambda *args: (_ for _ in ()).throw(OSError('offline'))
        self.assert_fail(rpc)
        rpc = CannedRPC(); rpc.post['receipts_outcome'][0]['id'] = 'unrelated'; self.assert_fail(rpc)

    def test_keygen_permissions_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'reviewer.json')
            with patch('sys.argv', ['styx-near-review', 'keygen', path]), patch('builtins.print'):
                self.assertEqual(main(), 0)
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
                self.assertEqual(main(), 1)
