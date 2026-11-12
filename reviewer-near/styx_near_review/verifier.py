import base64
import hashlib
import json
import struct
import urllib.request

from nacl.public import PrivateKey, SealedBox
from nacl.signing import VerifyKey


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def decode(value, length=None):
    require(isinstance(value, str), 'expected base64 text')
    raw = base64.b64decode(value, validate=True)
    require(length is None or len(raw) == length, 'wrong byte length')
    return raw


def base58(value):
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    n = 0
    for char in value:
        n = n * 58 + alphabet.index(char)
    return b'\x00' * (len(value) - len(value.lstrip('1'))) + n.to_bytes((n.bit_length() + 7) // 8, 'big')


def text(value):
    raw = value.encode('utf-8')
    return struct.pack('<I', len(raw)) + raw


def nep413(message, nonce, vault, callback):
    return hashlib.sha256(struct.pack('<I', 2147484061) + text(message) + decode(nonce, 32)
                          + text(vault) + (b'\0' if callback is None else b'\1' + text(callback))).digest()


class RPC:
    def __init__(self, url):
        require(url.startswith(('https://', 'http://')), 'RPC must be HTTP(S)')
        self.url = url

    def call(self, method, params):
        request = urllib.request.Request(self.url, json.dumps({
            'jsonrpc': '2.0', 'id': 'styx-review', 'method': method, 'params': params,
        }).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        require('error' not in result and 'result' in result, 'RPC returned an error or incomplete result')
        return result['result']

    def transaction(self, tx, vault):
        result = self.call('tx', {'tx_hash': tx, 'sender_account_id': vault, 'wait_until': 'FINAL'})
        require(result.get('final_execution_status') == 'FINAL', 'transaction finality unavailable')
        require('SuccessValue' in result.get('status', {}), 'transaction did not succeed')
        require(result['transaction']['hash'] == tx, 'transaction hash differs')
        require(result['transaction']['signer_id'] == vault and result['transaction']['receiver_id'] == vault,
                'transaction is not from and to the requested vault')
        return result

    def view(self, vault, method, args):
        result = self.call('query', {'request_type': 'call_function', 'finality': 'final',
                                    'account_id': vault, 'method_name': method,
                                    'args_base64': base64.b64encode(json.dumps(args).encode()).decode()})
        return json.loads(bytes(result['result']))


def events(tx, executor, standard, event):
    """Only successful receipts executed by the named contract can supply evidence."""
    found = []
    # Refuse incomplete or unrelated receipts instead of trusting an injected event.
    outcomes = tx['receipts_outcome']
    reachable = set(tx['transaction_outcome']['outcome']['receipt_ids'])
    remaining = list(outcomes)
    while remaining:
        next_round = []
        for receipt in remaining:
            if receipt['id'] not in reachable:
                next_round.append(receipt)
                continue
            outcome = receipt['outcome']
            reachable.update(outcome['receipt_ids'])
            if outcome['executor_id'] != executor:
                continue
            require(any(s in outcome['status'] for s in ['SuccessValue', 'SuccessReceiptId']), 'receipt failed')
            for line in outcome['logs']:
                if not line.startswith('EVENT_JSON:'):
                    continue
                obj = json.loads(line[len('EVENT_JSON:'):])
                if obj.get('standard') == standard and obj.get('event') == event:
                    require(obj.get('version') == '1.0.0', 'unsupported event version')
                    found.extend(obj['data'])
        require(len(next_round) < len(remaining), 'receipt graph is incomplete or unrelated')
        remaining = next_round
    require(reachable.issubset({r['id'] for r in outcomes}), 'receipt graph has missing outcomes')
    return found


def action_args(tx, method):
    actions = tx['transaction']['actions']
    require(len(actions) == 1 and 'FunctionCall' in actions[0], 'expected one function call')
    call = actions[0]['FunctionCall']
    require(call['method_name'] == method, 'transaction method differs')
    return json.loads(decode(call['args']))


def open_record(key, sealed):
    require(key['schema'] == 'styx-near-reviewer-key/1', 'wrong key schema')
    private = PrivateKey(decode(key['secret_key'], 32))
    require(bytes(private.public_key) == decode(key['public_key'], 32), 'key pair differs')
    return json.loads(SealedBox(private).decrypt(decode(sealed)))


def verify(rpc, vault, tx_id, key):
    lines = []
    def passed(name):
        lines.append(name + ': PASS')
    try:
        post = rpc.transaction(tx_id, vault)
        sealed_events = events(post, vault, 'styx', 'record_sealed')
        require(len(sealed_events) == 1, 'expected exactly one record_sealed event')
        event = sealed_events[0]
        args = action_args(post, 'post_record')
        require(args['payment_id'] == event['payment_id'] and args['sealed'] == event['sealed'], 'post_record action differs')
        record = open_record(key, event['sealed'])
        require(record['schema'] == 'styx-near-record/1', 'wrong record schema')
        p = record['payment']
        require(record['vault'] == vault and p['payment_id'] == event['payment_id'], 'vault or payment id differs')
        require(p['agent'] == event['agent'], 'record agent differs')
        passed('1 record identity and sealed box')
        digest = hashlib.sha256(decode(record['salt'], 32) + decode(record['invoice'])).digest()
        require(digest == decode(p['evidence_commitment'], 32), 'invoice commitment differs')
        passed('2 salted invoice commitment')
        hash_value = rpc.view(vault, 'payment_hash', {'payment': p})
        require(decode(hash_value, 32) == decode(record['payment_hash'], 32) == decode(event['payment_hash'], 32), 'payment hashes differ')
        passed('3 contract payment hash')
        require(rpc.view(vault, 'consumed_payment', {'payment_id': p['payment_id']}) == hash_value, 'consumed payment differs or unavailable')
        passed('4 consumed payment')
        settlement = rpc.transaction(record['settlement_tx'], vault)
        executions = events(settlement, vault, 'styx', 'payment_executed')
        require(len(executions) == 1, 'expected one payment_executed event')
        execution = executions[0]
        for field in ['payment_id', 'agent', 'recipient', 'amount']:
            require(execution[field] == p[field], 'settlement ' + field + ' differs')
        require(execution['payment_hash'] == hash_value, 'settlement hash differs')
        transfers = events(settlement, p['token'], 'nep141', 'ft_transfer')
        require(any(t.get('old_owner_id') == vault and t.get('new_owner_id') == p['recipient']
                    and t.get('amount') == p['amount'] and t.get('memo') == 'styx:' + p['payment_id']
                    for t in transfers), 'matching NEP-141 transfer missing')
        is_exception = record['authorization'] is not None
        submitted = action_args(settlement, 'pay_with_exception' if is_exception else 'pay')
        require(submitted['payment'] == p, 'submitted payment differs')
        require(execution['exception'] is is_exception, 'exception flag differs')
        passed('5 final settlement and token transfer')
        if is_exception:
            a = record['authorization']
            require(submitted['authorization'] == a and submitted['signature'] == record['signature'], 'submitted authorization or signature differs')
            require(a['payment_hash'] == hash_value and execution['signer'] == a['signer']
                    and execution['signer_version'] == a['signer_version'], 'exception signer or hash differs')
            message = rpc.view(vault, 'exception_message', {'authorization': a})
            require(a['signer'].startswith('ed25519:'), 'unsupported signer curve')
            public_key = base58(a['signer'][8:])
            require(len(public_key) == 32, 'wrong signer key length')
            digest = nep413(message, a['approval_nonce'], vault, a['callback_url'])
            VerifyKey(public_key).verify(digest, decode(record['signature'], 64))
            require(decode(execution['approval_digest'], 32) == digest, 'event approval digest differs')
            passed('6 exception NEP-413 signature')
        else:
            require(record['signature'] is None and execution.get('signer') is None, 'unexpected signature or signer')
            lines.append('6 exception NEP-413 signature: NOT APPLICABLE (routine payment)')
        lines.append('PASS')
        return True, lines
    except Exception as error:
        # Never print decrypted invoice or key data, including exception strings from dependencies.
        detail = str(error) if isinstance(error, VerificationError) else type(error).__name__
        lines.append('verification: FAIL (' + detail + ')')
        lines.append('FAIL')
        return False, lines
