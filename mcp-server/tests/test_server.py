import pytest

from styx_mcp.config import ConfigError
from styx_mcp.server import build_server


def test_an_unknown_backend_is_refused(monkeypatch):
    monkeypatch.setenv("STYX_BACKEND", "something-else")
    with pytest.raises(ConfigError):
        build_server()


def test_a_missing_backend_is_refused(monkeypatch):
    monkeypatch.delenv("STYX_BACKEND", raising=False)
    with pytest.raises(ConfigError):
        build_server()
