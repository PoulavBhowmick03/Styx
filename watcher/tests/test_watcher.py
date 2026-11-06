"""Real Anvil transactions and a fake relay implementing relay/README.md."""
import importlib.util
import json
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

spec = importlib.util.spec_from_file_location("styx_watcher", Path(__file__).parents[1] / "watcher.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Watcher, Unknown = module.Watcher, module.Unknown
ROOT = Path(__file__).resolve().parents[2]
VENDOR = "0x00000000000000000000000000000000000000a1"


def run(args, cwd=ROOT):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


@pytest.fixture
def chain():
    for program in ("anvil", "cast", "forge"):
        assert shutil.which(program), f"{program} is required; these tests must run on Anvil"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    process = subprocess.Popen(["anvil", "--port", str(port), "--silent"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def rpc(method, params):
        response = module.post(url, dict(jsonrpc="2.0", id=1, method=method, params=params))
        assert "error" not in response, response.get("error")
        return response["result"]

    try:
        for _ in range(100):
            try:
                rpc("eth_chainId", [])
                break
            except (Unknown, AssertionError):
                time.sleep(.05)
        else:
            raise AssertionError("Anvil did not start")
        # Keys are fresh randomness for each fixture, never Anvil's published test keys.
        owner_key, agent_key = ["0x" + secrets.token_hex(32) for _ in range(2)]
        owner, agent = [run(["cast", "wallet", "address", "--private-key", key]).lower()
                        for key in (owner_key, agent_key)]
        for address in (owner, agent):
            rpc("anvil_setBalance", [address, hex(10**21)])

        def deploy(contract, *args):
            result = run(["forge", "create", contract, "--broadcast", "--json", "--rpc-url", url,
                          "--private-key", owner_key, "--constructor-args", *args], ROOT / "contracts/evm")
            return json.loads(result)["deployedTo"].lower()

        token = deploy("src/MockERC20.sol:MockERC20", "USD Coin", "USDC")
        vault = deploy("src/ErebusPolicyVault.sol:ErebusPolicyVault", owner, token)

        def send(to, signature, *args, agent_call=False):
            result = run(["cast", "send", to, signature, *args, "--async", "--gas-limit", "500000",
                          "--rpc-url", url, "--private-key", agent_key if agent_call else owner_key])
            for _ in range(100):
                if rpc("eth_getTransactionReceipt", [result]):
                    return result.lower()
                time.sleep(.02)
            raise AssertionError("local transaction receipt missing")

        send(vault, "configurePolicy(address,uint256,uint256,uint64)", agent, "5", "10", str(int(time.time()) + 864000))
        send(vault, "setRecipient(address,bool)", VENDOR, "true")
        send(token, "mint(address,uint256)", vault, "100")
        start = int(rpc("eth_blockNumber", []), 16)

        def pay(amount, agent_call=True):
            payment = f"(0x{secrets.token_hex(32)},{agent},{token},{VENDOR},{amount},0x{'00'*32},2,{int(time.time())+800000})"
            return send(vault, "pay((bytes32,address,address,address,uint256,bytes32,uint256,uint64))", payment, agent_call=agent_call)

        yield dict(url=url, rpc=rpc, vault=vault, agent=agent, start=start, pay=pay)
    finally:
        process.terminate()
        process.wait(timeout=5)


@pytest.fixture
def relay():
    notices = []
    token = secrets.token_urlsafe(32)
    settings = {"alerted": True, "redirect": False}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            assert self.path == "/alerts"
            assert self.headers.get("Authorization") == "Bearer " + token
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if settings["redirect"]:
                self.send_response(307)
                self.send_header("Location", self.server.url + "/stolen")
                self.end_headers()
                return
            notices.append(payload)
            response = json.dumps({"alerted": settings["alerted"]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.url = f"http://127.0.0.1:{server.server_port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield dict(url=server.url, token=token, notices=notices, settings=settings)
    server.shutdown()
    server.server_close()
    thread.join()


def watch(chain, relay, tmp_path, **options):
    return Watcher(chain["url"], relay["url"], relay["token"], tmp_path / "state.json", 31337,
                   chain["vault"], chain["agent"], options.pop("threshold", 2), chain["start"],
                   options.pop("confirmations", 0), **options)


def test_reverts_without_events_and_daily_threshold_survive_restart(chain, relay, tmp_path):
    reverted = chain["pay"](6)
    ignored = chain["pay"](1, agent_call=False)
    settled = chain["pay"](3)
    assert chain["rpc"]("eth_getTransactionReceipt", [reverted])["logs"] == []
    watcher = watch(chain, relay, tmp_path)
    watcher.tick()
    assert sorted(item["kind"] for item in relay["notices"]) == ["agent_revert", "daily_spend"]
    assert any(reverted in item["text"] for item in relay["notices"])
    assert not any(ignored in item["text"] or settled in item["text"] for item in relay["notices"])
    watcher.close()
    watcher = watch(chain, relay, tmp_path)
    watcher.tick()
    assert len(relay["notices"]) == 2
    assert not watcher.state["pending"] and not watcher.state["outbox"]
    assert (tmp_path / "state.json").stat().st_mode & 0o077 == 0
    watcher.close()


def test_missing_receipt_stays_unknown_then_alerts_after_restart(chain, relay, tmp_path):
    tx = chain["pay"](6)
    watcher = watch(chain, relay, tmp_path)
    actual = watcher.rpc
    watcher.rpc = lambda method, params: None if method == "eth_getTransactionReceipt" else actual(method, params)
    watcher.tick()
    assert not relay["notices"]
    assert tx in watcher.state["pending"]
    watcher.close()
    watcher = watch(chain, relay, tmp_path)
    watcher.tick()
    assert len(relay["notices"]) == 1 and tx in relay["notices"][0]["text"]
    watcher.close()


def test_failed_rpc_does_not_advance_cursor_or_claim_revert(chain, relay, tmp_path):
    chain["pay"](6)
    watcher = watch(chain, relay, tmp_path)
    actual = watcher.rpc
    def fail(method, params):
        if method == "eth_call":
            raise Unknown("injected unavailable RPC")
        return actual(method, params)
    watcher.rpc = fail
    with pytest.raises(Unknown):
        watcher.tick()
    assert watcher.state["next_block"] == chain["start"]
    assert not relay["notices"]
    watcher.close()


def test_rate_limited_relay_retains_outbox_and_retries(chain, relay, tmp_path):
    chain["pay"](6)
    relay["settings"]["alerted"] = False
    watcher = watch(chain, relay, tmp_path)
    watcher.tick()
    assert len(watcher.state["outbox"]) == 1
    watcher.close()
    relay["settings"]["alerted"] = True
    watcher = watch(chain, relay, tmp_path)
    watcher.tick()
    assert not watcher.state["outbox"]
    assert len(relay["notices"]) == 2
    watcher.close()


def test_confirmations_and_exact_threshold(chain, relay, tmp_path):
    chain["pay"](3)
    watcher = watch(chain, relay, tmp_path, threshold=3, confirmations=2)
    watcher.tick()
    assert not relay["notices"]
    chain["rpc"]("anvil_mine", [2])
    watcher.tick()
    assert not relay["notices"]  # Equality is not passing the threshold.
    chain["pay"](1)
    chain["rpc"]("anvil_mine", [2])
    watcher.tick()
    assert [item["kind"] for item in relay["notices"]] == ["daily_spend"]
    watcher.close()


def test_reorg_stops_instead_of_silently_skipping_history(chain, relay, tmp_path):
    snapshot = chain["rpc"]("evm_snapshot", [])
    chain["pay"](1)
    watcher = watch(chain, relay, tmp_path)
    watcher.tick()
    chain["rpc"]("evm_revert", [snapshot])
    chain["pay"](2)
    with pytest.raises(Unknown, match="reorganization"):
        watcher.tick()
    assert not relay["notices"]
    watcher.close()


def test_configuration_and_concurrent_processes_fail_closed(chain, relay, tmp_path):
    watcher = watch(chain, relay, tmp_path)
    with pytest.raises(ValueError, match="another watcher"):
        watch(chain, relay, tmp_path)
    watcher.close()
    with pytest.raises(ValueError, match="configuration"):
        watch(chain, relay, tmp_path, threshold=99)
    watcher = watch(chain, relay, tmp_path)
    watcher.binding["chain_id"] = 1
    with pytest.raises(Unknown, match="different chain"):
        watcher.tick()
    assert not relay["notices"]
    watcher.close()


def test_redirect_never_forwards_watcher_token(chain, relay, tmp_path):
    chain["pay"](6)
    relay["settings"]["redirect"] = True
    watcher = watch(chain, relay, tmp_path)
    watcher.tick()
    assert not relay["notices"]
    assert len(watcher.state["outbox"]) == 1
    watcher.close()


def test_daily_threshold_resets_at_utc_day_boundary(chain, relay, tmp_path):
    chain["pay"](3)
    watcher = watch(chain, relay, tmp_path)
    watcher.tick()
    day = int(chain["rpc"]("eth_getBlockByNumber", ["latest", False])["timestamp"], 16) // 86400
    chain["rpc"]("evm_setNextBlockTimestamp", [(day + 1) * 86400])
    chain["pay"](3)
    watcher.tick()
    assert [item["kind"] for item in relay["notices"]] == ["daily_spend", "daily_spend"]
    assert watcher.state["threshold_days"] == [day, day + 1]
    watcher.close()


def test_partial_receipt_is_not_a_revert(chain, relay, tmp_path):
    tx = chain["pay"](6)
    watcher = watch(chain, relay, tmp_path)
    actual = watcher.rpc
    def partial(method, params):
        response = actual(method, params)
        if method == "eth_getTransactionReceipt" and response:
            del response["status"]
        return response
    watcher.rpc = partial
    watcher.tick()
    assert not relay["notices"] and tx in watcher.state["pending"]
    watcher.close()


def test_requests_do_not_use_python_default_user_agent():
    # Arc's public RPC answers 403 to urllib's default agent, which stopped the watcher on Arc.
    seen = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            seen["agent"] = self.headers.get("User-Agent", "")
            body = b"{}"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        module.post(f"http://127.0.0.1:{server.server_port}/", {})
    finally:
        server.shutdown()
    assert seen["agent"] and not seen["agent"].startswith("Python-urllib")


def test_scanning_many_blocks_stays_ahead_of_a_fast_chain(chain, relay, tmp_path, monkeypatch):
    # Arc makes about 2 blocks a second and a public RPC answers about 3 requests a second,
    # so a scan needs far fewer than one request per block or it falls behind for good.
    tx = chain["pay"](6)
    chain["rpc"]("anvil_mine", [hex(60)])
    watcher = watch(chain, relay, tmp_path)
    actual, requests = module.post, []

    def counted(url, body, token=None):
        requests.append(url)
        return actual(url, body, token)

    monkeypatch.setattr(module, "post", counted)
    watcher.tick()
    assert watcher.state["next_block"] == chain["start"] + 62
    assert len([url for url in requests if url == chain["url"]]) <= 20
    assert any(tx in item["text"] for item in relay["notices"])
    watcher.close()


def test_a_failed_block_in_a_batch_does_not_advance_the_cursor(chain, relay, tmp_path, monkeypatch):
    chain["pay"](6)
    chain["rpc"]("anvil_mine", [hex(3)])
    watcher = watch(chain, relay, tmp_path)
    actual = module.post

    def broken(url, body, token=None):
        response = actual(url, body, token)
        if isinstance(response, list):
            response[1] = {"jsonrpc": "2.0", "id": response[1]["id"], "error": {"code": -32005, "message": "limit"}}
        return response

    monkeypatch.setattr(module, "post", broken)
    with pytest.raises(Unknown):
        watcher.tick()
    assert watcher.state["next_block"] == chain["start"]
    assert not relay["notices"]
    watcher.close()
