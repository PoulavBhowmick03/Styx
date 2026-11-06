"""Disclosure binding tests: paths cross the seam, private material does not."""

import json
import subprocess

import pytest

from styx import DisclosureError, DisclosureSeam


def reply(monkeypatch, payload, *, returncode=0, stderr=""):
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, returncode, json.dumps(payload), stderr)

    monkeypatch.setattr(subprocess, "run", run)
    return calls


def test_undecodable_disclosure_output_is_redacted(monkeypatch):
    def run(*args, **kwargs):
        raise UnicodeDecodeError("utf-8", b"private-grant-marker\xff", 20, 21, "invalid byte")
    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(DisclosureError) as error:
        DisclosureSeam(binary="local-rust").call("key_info", key_file="/operator/auditor.key")
    assert "private-grant-marker" not in str(error.value)
    assert "retain evidence" in str(error.value)


def test_only_paths_are_forwarded_and_no_key_is_read(monkeypatch):
    calls = reply(monkeypatch, {"status": "ok", "recipient_public_key": "ab" * 32})
    result = DisclosureSeam(binary="local-rust").call("key_info", key_file="/does/not/exist.key")
    assert result["recipient_public_key"] == "ab" * 32
    assert json.loads(calls[0][1]["input"]) == {"method": "key_info", "key_file": "/does/not/exist.key"}
    assert calls[0][0] == ["local-rust"]


@pytest.mark.parametrize("parameters", [{"key": "SECRET"}, {"key_file": "x", "method": "export"}])
def test_unknown_or_secret_request_fields_never_run(monkeypatch, parameters):
    calls = reply(monkeypatch, {"status": "ok"})
    with pytest.raises((DisclosureError, TypeError)):
        DisclosureSeam(binary="local-rust").call("key_info", **parameters)
    assert calls == []


@pytest.mark.parametrize("payload", [
    {"status": "ok", "private_key": "SECRET"},
    {"status": "ok", "issuer": {"private": "SECRET"}},
    {"status": "error", "error": "SECRET"},
    ["SECRET"],
    {"status": "ok", "methods": [{}]},
])
def test_private_or_malformed_response_is_not_exposed(monkeypatch, payload):
    reply(monkeypatch, payload)
    with pytest.raises(DisclosureError) as caught:
        DisclosureSeam(binary="local-rust").call("key_info", key_file="key.path")
    assert "SECRET" not in str(caught.value)


def test_timeout_does_not_expose_request_or_raw_output(monkeypatch):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("SECRET", 1, output="SECRET")

    monkeypatch.setattr(subprocess, "run", timeout)
    with pytest.raises(DisclosureError) as caught:
        DisclosureSeam(binary="local-rust").call("key_info", key_file="key.path")
    assert "SECRET" not in str(caught.value)


def verify_payment():
    return DisclosureSeam(binary="local-rust").call(
        "verify_payment", grant_file="grant.path", key_file="key.path",
        expected_issuer="public", deployment={},
    )
