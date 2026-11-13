"""A small NEAR AI Cloud client that keeps the exact bytes it sends and receives.

Response signatures cover SHA-256 of the request body and of the response body, so the runner sends
a body it serialised itself and hashes the response bytes as they arrived, never a re-encoding.
The API key comes from the environment and is sent only as a bearer header.
"""
import hashlib
import http.client
import json
import os
import secrets
import socket
import ssl
import time
from dataclasses import dataclass, field
from types import SimpleNamespace
from urllib.parse import urlencode, urlsplit

import requests
from styx_near_review.inference import sha256_hex, signed_text, check_signature, verify_report
from styx_near_review.verifier import VerificationError, require

DEFAULT_BASE = 'https://cloud-api.near.ai'
TIMEOUT = 180


class InferenceError(Exception):
    """An inference or verification step failed. The runner stops and reports it."""


@dataclass
class Preflight:
    nonce: str
    url: str            # the exact request, without the API key
    raw: bytes          # the report as returned
    signers: dict       # {(algo, address): 'gateway' | 'model'} that verified
    checks: list        # names of the checks that ran
    rejected: list      # model candidates that failed verification
    tls: dict = field(default=None)  # the TLS binding, when the connection exposed its certificate


def spki_sha256(der_certificate):
    """SHA-256 of a DER certificate's SubjectPublicKeyInfo, the value NEAR AI's gateway quote binds."""
    from cryptography import x509
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    key = x509.load_der_x509_certificate(der_certificate).public_key()
    return hashlib.sha256(key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)).hexdigest()


class TLSBoundSession:
    """Every request over one TLS connection to the gateway, so the certificate read from it, the
    attestation report and the completions all travel on the connection the quote is checked against.

    If the server closes the connection, the session reconnects only to a peer presenting the same
    SPKI the attestation bound; any other certificate stops the run. (NEAR's flow says to repeat the
    attestation after a reconnect; requiring the same attested key is the check this makes instead.)
    """

    def __init__(self, base, timeout=TIMEOUT):
        parts = urlsplit(base)
        self.host, self.port, self.timeout = parts.hostname, parts.port or 443, timeout
        self.conn, self.peer_spki_sha256, self.pinned = None, None, None
        self.requests, self.reconnects = 0, 0

    def connect(self):
        self.conn = http.client.HTTPSConnection(self.host, self.port, timeout=self.timeout,
                                                context=ssl.create_default_context())
        self.conn.connect()
        spki = spki_sha256(self.conn.sock.getpeercert(binary_form=True))
        if self.pinned is not None and spki != self.pinned:
            self.conn.close()
            raise InferenceError('the gateway presented a certificate other than the attested one after a reconnect')
        self.peer_spki_sha256 = spki
        return spki

    def pin(self, spki):
        """Called once the attestation bound this SPKI: later reconnects must present it."""
        self.pinned = spki

    def _send(self, method, path, body, headers):
        for attempt in range(2):
            if self.conn is None or self.conn.sock is None:
                if self.conn is not None or attempt:
                    self.reconnects += 1
                self.connect()
            try:
                self.conn.request(method, path, body=body, headers=headers)
                reply = self.conn.getresponse()
                content = reply.read()
                self.requests += 1
                return reply.status, content
            except (http.client.RemoteDisconnected, ConnectionError, BrokenPipeError, socket.timeout) as error:
                self.conn.close()
                self.conn = None
                if attempt:
                    raise InferenceError('the connection to NEAR AI Cloud failed: ' + type(error).__name__) from None
        raise InferenceError('the connection to NEAR AI Cloud failed')

    def _reply(self, method, url, params=None, data=None, headers=None, timeout=None):
        parts = urlsplit(url)
        path = parts.path + ('?' + urlencode(params) if params else '')
        status, content = self._send(method, path, data, dict(headers or {}))
        reply = SimpleNamespace(status_code=status, content=content, request=SimpleNamespace(url='https://' + self.host + path))
        reply.json = lambda: json.loads(content)
        return reply

    def get(self, url, params=None, headers=None, timeout=None):
        return self._reply('GET', url, params=params, headers=headers)

    def post(self, url, data=None, headers=None, timeout=None):
        return self._reply('POST', url, data=data, headers=headers)


class NearAI:
    def __init__(self, model, api_key=None, base=None, verifiers=None, session=None):
        self.model = model
        self.key = api_key or os.environ.get('NEARAI_API_KEY', '')
        if not self.key:
            raise InferenceError('NEARAI_API_KEY is not set')
        self.base = (base or os.environ.get('NEARAI_BASE_URL') or DEFAULT_BASE).rstrip('/')
        if urlsplit(self.base).scheme != 'https':
            raise InferenceError('the NEAR AI base URL must be https, because it receives the API key')
        self.verifiers = verifiers or {}
        self.http = session or TLSBoundSession(self.base)

    def headers(self, **extra):
        return {'Authorization': 'Bearer ' + self.key, **extra}

    def preflight(self):
        """Fetches the attestation report with a fresh nonce and verifies it before any completion."""
        nonce = secrets.token_hex(32)
        params = {'model': self.model, 'provider': 'near', 'signing_algo': 'ecdsa', 'nonce': nonce}
        bound = isinstance(self.http, TLSBoundSession)
        if bound:
            # Read the peer certificate first, then ask for the report on the same connection. No API key
            # crosses the connection before the gateway behind it is verified.
            self.http.connect()
            params['include_tls_fingerprint'] = 'true'
            headers = {'x-no-aliasing': 'true'}
        else:
            headers = self.headers(**{'x-no-aliasing': 'true'})
        reply = self.http.get(self.base + '/v1/attestation/report', params=params, timeout=60, headers=headers)
        if reply.status_code != 200:
            raise InferenceError('attestation report unavailable (HTTP %d)' % reply.status_code)
        peer = self.http.peer_spki_sha256 if bound else None
        try:
            checks, signers, rejected = verify_report(json.loads(reply.content), nonce, peer_spki_sha256=peer, **self.verifiers)
        except (VerificationError, ValueError) as error:
            raise InferenceError('attestation did not verify: ' + str(error)) from None
        tls = None
        if bound:
            self.http.pin(peer)
            tls = {'peer_spki_sha256': peer, 'host': self.http.host, 'same_connection': True}
        return Preflight(nonce, reply.request.url, reply.content, signers, checks, rejected, tls)

    def complete(self, body, preflight):
        """One chat completion, verified. Returns (parsed response, evidence entry); raises before returning
        anything the caller could act on if any check fails."""
        raw_request = json.dumps(body).encode()
        reply = self.http.post(self.base + '/v1/chat/completions', data=raw_request, timeout=TIMEOUT,
                               headers=self.headers(**{'Content-Type': 'application/json'}))
        if reply.status_code != 200:
            raise InferenceError('completion failed (HTTP %d)' % reply.status_code)
        raw_response = reply.content
        try:
            parsed = json.loads(raw_response)
            chat_id = parsed['id']
        except (ValueError, KeyError, TypeError):
            raise InferenceError('completion response is malformed') from None
        if parsed.get('model') not in (self.model, None):
            raise InferenceError('response names a different model than the one requested')
        entry = self.verify_signature(chat_id, sha256_hex(raw_request), sha256_hex(raw_response), preflight)
        return parsed, entry

    def verify_signature(self, chat_id, request_sha, response_sha, preflight, attempts=5):
        payload = None
        for attempt in range(attempts):
            reply = self.http.get(self.base + '/v1/signature/' + chat_id, timeout=30, headers=self.headers(),
                                  params={'model': self.model, 'signing_algo': 'ecdsa'})
            if reply.status_code == 200:
                try:
                    payload = reply.json()
                    break
                except ValueError:
                    pass
            time.sleep(1 + attempt)
        if not isinstance(payload, dict):
            raise InferenceError('response signature unavailable')
        kind = payload.get('signature_kind', 'provider_tee')
        try:
            require(kind in ('provider_tee', 'gateway'), 'unknown signature kind')
            expected = signed_text(self.model, request_sha, response_sha, kind)
            require(payload.get('text') == expected, 'signed text does not match the hashes of what we sent and received')
            algo = check_signature(payload['text'], payload.get('signature'), payload.get('signing_algo'), payload.get('signing_address'))
            signer = (algo, payload['signing_address'].lower().removeprefix('0x'))
            label = preflight.signers.get(signer)
            require(label is not None, 'signer is not in the verified attestation')
            require(label == ('gateway' if kind == 'gateway' else 'model'), 'signature kind does not match the attested signer')
        except (VerificationError, KeyError, AttributeError) as error:
            raise InferenceError('response signature did not verify: ' + str(error)) from None
        return {'chat_id': chat_id, 'request_sha256': request_sha, 'response_sha256': response_sha,
                'signature': payload['signature'], 'signing_algo': algo, 'signing_address': payload['signing_address'],
                'signature_kind': kind, 'signed_text': payload['text'], 'verified': True}
