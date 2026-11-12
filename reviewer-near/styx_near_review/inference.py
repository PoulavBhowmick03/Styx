"""Checks of NEAR AI Cloud inference evidence: attestation reports and response signatures.

The functions here are shared by the reviewer (`styx-near-review verify`) and the agent runner
(`agent-near-ai`), so both apply the same rules. Formats follow NEAR AI Cloud's documentation
(docs.near.ai/cloud/verification) and the MIT-licensed nearai/nearai-cloud-verifier: the signed text is
`<model>:<sha256 of the request body>:<sha256 of the response body>`, an ECDSA signature is an
EIP-191 personal-sign signature, an Ed25519 one is detached over the UTF-8 text, and a TDX quote's
64-byte report_data holds the signing address (padded to 32 bytes) then the client's nonce.

Every check fails closed: a missing, malformed or mismatched input raises VerificationError.
Quote and GPU verification need the network (Intel collateral, NVIDIA NRAS) and are injectable so
tests can run offline; the default verifiers are the real ones.
"""
import asyncio
import base64
import hashlib
import json
import urllib.request
from dataclasses import dataclass

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from .verifier import VerificationError, require

EVIDENCE_SCHEMA = 'styx-near-inference/1'
PROVIDER = 'near-ai-cloud'
NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu'
# Intel marks a quote OutOfDate when the platform's TCB is below Intel's current baseline; the
# signature chain is still valid. Anything else (revoked, configuration needed, ...) is refused.
ACCEPTED_TDX_STATUS = ('UpToDate', 'OutOfDate')


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def signed_text(model, request_sha256, response_sha256, kind='provider_tee'):
    """What the signer signs: `<model>:<request>:<response>` from a model TEE, `<request>:<response>` from the gateway."""
    if kind == 'gateway':
        return request_sha256 + ':' + response_sha256
    return model + ':' + request_sha256 + ':' + response_sha256


def hex_bytes(value, length, name):
    require(isinstance(value, str), name + ' must be hex text')
    try:
        raw = bytes.fromhex(value[2:] if value[:2].lower() == '0x' else value)
    except ValueError:
        raise VerificationError(name + ' is not hex') from None
    require(len(raw) == length, name + ' has the wrong length')
    return raw


def check_signature(text, signature, algo, address):
    """Raises unless `signature` over `text` was made by `address`. Returns the algorithm."""
    require(isinstance(text, str) and isinstance(algo, str), 'signature fields are malformed')
    algo = algo.lower()
    if algo == 'ecdsa':
        try:
            from eth_account import Account
            from eth_account.messages import encode_defunct
        except ImportError:
            raise VerificationError("ECDSA signatures need: pip install 'styx-near-review[inference]'") from None
        expected = hex_bytes(address, 20, 'signing address')
        try:
            recovered = Account.recover_message(encode_defunct(text=text), signature=hex_bytes(signature, 65, 'signature'))
        except VerificationError:
            raise
        except Exception:
            raise VerificationError('ECDSA signature does not recover an address') from None
        require(bytes.fromhex(recovered[2:]) == expected, 'ECDSA signature was not made by the signing address')
    elif algo == 'ed25519':
        key = VerifyKey(hex_bytes(address, 32, 'signing address'))
        try:
            key.verify(text.encode(), hex_bytes(signature, 64, 'signature'))
        except BadSignatureError:
            raise VerificationError('Ed25519 signature was not made by the signing address') from None
    else:
        raise VerificationError('unsupported signing algorithm')
    return algo


# ---- attestation ------------------------------------------------------------------------------

@dataclass
class Quote:
    status: str
    report_data: bytes   # 64 bytes, read from the verified quote
    mr_config: bytes
    debug: bool


def verify_quote(quote_hex):
    """Verifies an Intel TDX quote with dcap-qvl, fetching Intel's collateral over the network."""
    try:
        import dcap_qvl
    except ImportError:
        raise VerificationError("TDX quotes need: pip install 'styx-near-review[inference]'") from None
    try:
        result = asyncio.run(dcap_qvl.get_collateral_and_verify(bytes.fromhex(quote_hex)))
        td = json.loads(result.to_json())['report']['TD10']
        attributes = bytes.fromhex(td['td_attributes'])
        return Quote(str(result.status), bytes.fromhex(td['report_data']), bytes.fromhex(td['mr_config_id']),
                     bool(attributes[0] & 1))
    except Exception as error:
        raise VerificationError('TDX quote did not verify (' + type(error).__name__ + ')') from None


def verify_gpu(payload):
    """Sends the GPU evidence to NVIDIA's attestation service and returns its overall verdict.

    The verdict is read from the service's TLS answer; the JWT's own signature is not checked here.
    """
    try:
        request = urllib.request.Request(NRAS_URL, json.dumps(payload).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.load(response)
        part = body[0][1].split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        return claims['x-nvidia-overall-att-result'] is True
    except Exception as error:
        raise VerificationError('GPU attestation service unavailable or malformed (' + type(error).__name__ + ')') from None


def signer_bytes(att):
    algo = str(att.get('signing_algo', '')).lower()
    require(algo in ('ecdsa', 'ed25519'), 'attestation has no usable signing algorithm')
    return algo, hex_bytes(att.get('signing_address'), 20 if algo == 'ecdsa' else 32, 'attested signing address')


def verify_attestation(att, nonce, *, quote_verifier=verify_quote, gpu_verifier=verify_gpu, require_gpu=False):
    """Checks one attestation (the gateway's or one model's) and returns the names of the checks run."""
    require(isinstance(att, dict), 'attestation is malformed')
    names = []
    require(att.get('request_nonce') == nonce and len(hex_bytes(nonce, 32, 'nonce')) == 32, 'attestation does not echo our nonce')
    names.append('report echoes the request nonce')
    quote = quote_verifier(att.get('intel_quote'))
    require(quote.status in ACCEPTED_TDX_STATUS, 'TDX quote status ' + quote.status + ' is not accepted')
    names.append('Intel TDX quote verified, status ' + quote.status)
    require(not quote.debug, 'TDX quote is from a debug-mode guest')
    names.append('TDX debug mode off')
    _, address = signer_bytes(att)
    require(len(quote.report_data) == 64, 'quote report_data is not 64 bytes')
    require(quote.report_data[:32] == address.ljust(32, b'\0'), 'quote does not bind the signing address')
    names.append('quote report_data binds the signing address')
    require(quote.report_data[32:] == bytes.fromhex(nonce), 'quote does not embed our nonce')
    names.append('quote report_data embeds our nonce')
    info = att.get('info') if isinstance(att.get('info'), dict) else {}
    tcb = info.get('tcb_info')
    tcb = json.loads(tcb) if isinstance(tcb, str) else tcb
    compose = tcb.get('app_compose') if isinstance(tcb, dict) else None
    if compose:
        expected = bytes([1]) + hashlib.sha256(compose.encode()).digest()
        require(quote.mr_config[:33] == expected, 'quote MRCONFIGID does not match the app_compose hash')
        names.append('quote MRCONFIGID matches the app_compose hash')
    if att.get('nvidia_payload'):
        payload = json.loads(att['nvidia_payload']) if isinstance(att['nvidia_payload'], str) else att['nvidia_payload']
        require(str(payload.get('nonce', '')).lower() == nonce, 'GPU evidence does not carry our nonce')
        require(gpu_verifier(payload), 'NVIDIA attestation service did not report success')
        names.append('GPU evidence carries our nonce and NVIDIA NRAS reports success')
    else:
        require(not require_gpu, 'attestation has no GPU evidence')
    return names


def verify_report(report, nonce, **verifiers):
    """Verifies the gateway report and every model candidate. Raises if the gateway or no model verifies.

    Returns {(algo, address): label} for each verified signer. A model candidate that fails is left out,
    so nothing it signs is accepted; the failure is listed in the returned `rejected` list.
    """
    require(isinstance(report, dict), 'attestation report is malformed')
    names, signers, rejected = [], {}, []
    gateway = report.get('gateway_attestation')
    for check in verify_attestation(gateway, nonce, **verifiers):
        names.append('gateway: ' + check)
    algo, address = signer_bytes(gateway)
    signers[(algo, address.hex())] = 'gateway'
    candidates = report.get('model_attestations')
    require(isinstance(candidates, list) and candidates, 'report has no model attestations')
    verified = 0
    for candidate in candidates:
        try:
            checks = verify_attestation(candidate, nonce, require_gpu=True, **verifiers)
        except VerificationError as error:
            rejected.append(str(error))
            continue
        algo, address = signer_bytes(candidate)
        signers[(algo, address.hex())] = 'model'
        verified += 1
        names.extend('model ' + address.hex()[:8] + ': ' + check for check in checks)
    require(verified > 0, 'no model attestation verified: ' + '; '.join(rejected))
    return names, signers, rejected


# ---- completions and the evidence file --------------------------------------------------------

def check_completion(entry, model, signers=None):
    """Checks one completion record of the evidence file and returns its signing address.

    Re-derives the signed text from the model and the two hashes, then checks the signature against
    the address. When `signers` (from verify_report) is given, the address must be one of them, with the
    same algorithm.
    """
    require(isinstance(entry, dict), 'completion entry is malformed')
    request_sha, response_sha = entry.get('request_sha256'), entry.get('response_sha256')
    for value in (request_sha, response_sha):
        require(isinstance(value, str) and len(hex_bytes(value, 32, 'hash')) == 32 and value == value.lower(), 'hash is not lowercase hex')
    kind = entry.get('signature_kind', 'provider_tee')
    require(kind in ('provider_tee', 'gateway'), 'unknown signature kind')
    text = signed_text(model, request_sha, response_sha, kind)
    require(entry.get('signed_text', text) == text, 'recorded signed text differs from the recorded hashes')
    algo = check_signature(text, entry.get('signature'), entry.get('signing_algo'), entry.get('signing_address'))
    if signers is not None:
        require((algo, hex_bytes(entry['signing_address'], 20 if algo == 'ecdsa' else 32, 'address').hex()) in signers,
                'completion signer is not an attested signer')
    return entry['signing_address']


def verify_evidence(evidence, record, report_bytes=None, **verifiers):
    """Reviewer-side check of a record's `inference_evidence`. Returns report lines; raises on failure."""
    lines = []
    require(isinstance(evidence, dict) and evidence.get('schema') == EVIDENCE_SCHEMA, 'wrong inference evidence schema')
    require(evidence.get('provider') == PROVIDER, 'unknown inference provider')
    model = evidence.get('model')
    require(isinstance(model, str) and model, 'inference evidence names no model')
    payment = record['payment']
    require(evidence.get('payment_id') == payment['payment_id'], 'inference evidence is for another payment')
    lines.append('7a inference evidence payment id: PASS')
    invoice = base64.b64decode(record['invoice'], validate=True)
    require(evidence.get('invoice_sha256') == sha256_hex(invoice), 'inference evidence is for another invoice')
    lines.append('7b inference evidence invoice hash: PASS')
    calls = evidence.get('tool_calls')
    require(isinstance(calls, list), 'inference evidence has no tool calls')
    require(any(c.get('tool') == 'styx_propose_payment' and c.get('arguments', {}).get('recipient') == payment['recipient']
                and str(c.get('arguments', {}).get('amount')) == str(payment['amount']) for c in calls if isinstance(c, dict)),
            'no recorded model tool call proposes this payment')
    lines.append('7c a recorded model tool call proposes this payment: PASS')
    attestation = evidence.get('attestation')
    require(isinstance(attestation, dict), 'inference evidence has no attestation section')
    completions = evidence.get('completions')
    require(isinstance(completions, list) and completions, 'inference evidence has no completions')
    signers = None
    if report_bytes is not None:
        require(sha256_hex(report_bytes) == attestation.get('report_sha256'), 'attestation report differs from its recorded hash')
        lines.append('7d attestation report hash: PASS')
        names, signers, _ = verify_report(json.loads(report_bytes), attestation.get('nonce'), **verifiers)
        lines.append('7e attestation re-verified (' + str(len(names)) + ' checks): PASS')
    for index, entry in enumerate(completions):
        entry = dict(entry, signing_address=entry.get('signing_address', attestation.get('signing_address')),
                     signing_algo=entry.get('signing_algo'))
        check_completion(entry, model, signers)
    lines.append('7f ' + str(len(completions)) + ' completion signature(s) verify against their signing address: PASS')
    if signers is None:
        lines.append('7g signing address bound to a TEE: NOT CHECKED (no --attestation file); the signatures prove only '
                     'that the holder of that address signed these hashes')
    else:
        lines.append('7g every completion signer is an attested signer in the report: PASS')
    return lines
