# styx-near-ai-agent

Runs the Styx payment agent's model in NEAR AI Cloud and checks the attestation and every response
signature before it acts. Spec: `../docs/near/CODEX_TASK_4.md`. What ran and what the checks do and do
not prove: `../docs/near/NEAR_AI.md`.

```sh
cd agent-near-ai && uv sync            # Python 3.11+; also needs the repo workspace venv (`uv sync --all-packages` at the root)
source ~/.config/styx/nearai.env       # a file outside the repo holding: export NEARAI_API_KEY=...
STYX_NEAR_DEMO_ENV=~/.styx-near-quickstart/<account>/demo.env \
  .venv/bin/python -m styx_near_ai path/to/invoice.txt [--instruction TEXT] [--model ID] [--out report.json]
```

It needs the built agent CLI (`sdk/near/target/release/styx-near-vault`, built by
`scripts/near/quickstart.sh`). The API key is read from `NEARAI_API_KEY` only, goes only to an https
base URL, and is not passed to the MCP server or the CLI. For each payment it submits it writes
`inference-<first 12 hex of the payment id>.json` and `attestation-<same>.json` (mode 600) into
`STYX_NEAR_STATE_ROOT`, so `export_record` seals the evidence into the record. A failed check stops
the run and no tool from that completion runs.

Tests: `.venv/bin/python -m unittest discover -s tests`.
