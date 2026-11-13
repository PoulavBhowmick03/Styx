"""A stand-in for the Styx MCP server. It records every tool call in $STUB_LOG, so tests can show
which tools the runner did, and did not, run."""
import json
import os

from mcp.server import MCPServer

server = MCPServer(name='styx-stub')
PAYMENT_ID = '0x' + 'ab' * 32


def log(name, arguments):
    with open(os.environ['STUB_LOG'], 'a') as out:
        out.write(json.dumps({'tool': name, 'arguments': arguments}) + '\n')


@server.tool()
async def styx_propose_payment(recipient: str, amount_usdc: str, amount: str, invoice_name: str,
                               invoice_reference: str) -> dict:
    """Journal a payment. Same signature as the real tool: the amount in USDC and in base units."""
    log('styx_propose_payment', {'recipient': recipient, 'amount_usdc': amount_usdc, 'amount': amount})
    return {'ok': True, 'result': {'status': 'ok', 'payment_id': PAYMENT_ID}}


@server.tool()
async def styx_submit_payment(payment_id: str) -> dict:
    """Submit a payment."""
    log('styx_submit_payment', {'payment_id': payment_id})
    return {'ok': True, 'result': {'state': 'settled', 'tx_hash': 'stub'}}


if __name__ == '__main__':
    server.run()
