"""Starts the Styx MCP server: the agent's payment tools over styx-near-vault (STYX_BACKEND=vault)."""
from __future__ import annotations

import os
import sys

from mcp.server import MCPServer

from styx_mcp.config import ConfigError


def build_server() -> MCPServer:
    backend = os.environ.get("STYX_BACKEND", "").strip().lower()
    if backend == "vault":
        from styx_mcp.vault import build_vault_server

        return build_vault_server()
    raise ConfigError("STYX_BACKEND must be vault")


def main() -> None:
    try:
        server = build_server()
    except ConfigError as error:
        print(f"styx-mcp-server: {error}", file=sys.stderr)
        raise SystemExit(2) from None
    server.run()


if __name__ == "__main__":
    main()
