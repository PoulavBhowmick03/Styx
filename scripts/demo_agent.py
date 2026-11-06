#!/usr/bin/env python3
"""Calls one tool on the real MCP server over stdio, as an agent would, and prints its JSON answer."""
import asyncio
import json
import os
import sys

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


async def main(tool: str, arguments: dict) -> None:
    server = StdioServerParameters(command=sys.executable, args=["-m", "styx_mcp.server"], env=dict(os.environ))
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            response = await session.call_tool(tool, arguments)
            print(response.content[0].text)


asyncio.run(main(sys.argv[1], json.loads(sys.argv[2])))
