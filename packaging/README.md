# Native vault tools and MCP installation

The `erebus-cli` wheel contains `erebus-vault` and `erebus-disclosure` executables.
Installation does not invoke Cargo or download executables at runtime. It needs Python 3.11+
and uv. This package does not include the old Starknet CLI.

From a downloaded wheelhouse for your platform, run one command:

```sh
bash packaging/install-mcp.sh /absolute/path/to/wheelhouse
```

This installs the MCP server, SDK, and both native tools in an isolated uv tool environment.
Use `erebus-mcp-server` as the MCP command; configure `EREBUS_BACKEND=vault` and the
vault variables from `docs/mumbai/RUNBOOK.md`. Configuration and key creation remain separate.
`uv tool update-shell` can make the uv executable directory visible to a new shell.
The installer requires local wheels for all three Styx packages and refuses source builds.
Check `SHA256SUMS` against the artifact obtained from a trusted release before installation.
Checksums in the same untrusted download are not proof of provenance.

## Build and verify

Maintainers need Rust, uv, Python and a native build host:

```sh
bash packaging/build-wheels.sh
uv run python packaging/smoke-install.py dist
```

Outputs go into ignored `dist/`: three wheels and `SHA256SUMS`. The CLI wheel has a
platform tag; the two Python wheels are portable. Do not put more than one platform's CLI
wheel in a single install directory. The build hook refuses missing or non-native binaries.
Editable workspace installs deliberately do not bundle binaries: use built binaries on PATH
or explicit CLI configuration during development. `uv lock --check` and `uv sync --all-packages`
continue to work without a Rust compiler.

Locally verified: macOS arm64 release wheel, isolated installation with Cargo and rustc absent
from PATH, real `erebus-vault` version request, disclosure key generation, MCP entry point.
Linux x86_64 and macOS x86_64 builds are defined in CI but have not been run locally.
Linux wheels use the native `linux_x86_64` tag, not an unverified manylinux tag; build-host
libc compatibility applies. Windows is not supported by this build configuration.

The workflow produces downloadable artifacts; it does not publish to PyPI or create a release.
A human must run/review the workflow and distribute the matching wheelhouse. No public package
installation or remote release availability is claimed.

References consulted: [Hatch wheel builder](https://hatch.pypa.io/latest/plugins/builder/wheel/),
[Hatch build hooks](https://hatch.pypa.io/latest/plugins/build-hook/reference/),
[Python wheel tags](https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/),
[uv tools](https://docs.astral.sh/uv/guides/tools/). Local `uv tool install --help` was checked.
