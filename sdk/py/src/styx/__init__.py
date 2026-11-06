"""Python binding for the frozen ``StyxClient`` interface (ARCHITECTURE.md §4).

This package sends arguments to ``sdk/rs`` and returns its results. It does not hash, encode
salts, convert felts, or make protocol decisions. A wrong preimage silently derives an
unused storage slot, so duplicate protocol logic can hide a wrong answer.

This package must not need a known-answer test. Its tests cover transport and response shape.
A computed-value assertion means that Python has become another protocol implementation.

The seam
--------
The project chose a subprocess on 2026-07-30 (ARCHITECTURE.md §3). ``styx-cli`` reads one
JSON request from stdin and writes one JSON envelope to stdout. :class:`styx.Seam` wraps
this exchange.

Requests contain key-file paths, not keys. The Python process runs agent frameworks and
model-driven code but never holds a pool private key. An in-process PyO3 binding would put
the key in the same heap, contrary to CLAUDE.md constraint 6.

The Rust binary also generates entropy. Python does not produce keys or salts.
"""

from importlib.metadata import version as _metadata_version

from styx._network import Network, NetworkPreset, identify_network, network_preset
from styx._disclosure import DisclosureError, DisclosureSeam
from styx._vault import VaultError, VaultSeam
from styx._proving import LocalProvingError, LocalProvingSeam
from styx._access import AccessError, AccessSeam
from styx._metropolis import MetropolisError, MetropolisSeam
from styx._metropolis_wallet import MetropolisWallet, WalletPolicy
from styx._seam import PROTOCOL, StyxError, Seam, SeamConfig, SeamUnavailable

__all__ = [
    "AccessError",
    "AccessSeam",
    "MetropolisError",
    "MetropolisSeam",
    "MetropolisWallet",
    "WalletPolicy",
    "DisclosureError",
    "DisclosureSeam",
    "VaultError",
    "VaultSeam",
    "LocalProvingError",
    "LocalProvingSeam",
    "PROTOCOL",
    "StyxError",
    "Network",
    "NetworkPreset",
    "Seam",
    "SeamConfig",
    "SeamUnavailable",
    "__version__",
    "identify_network",
    "network_preset",
]

# Read from installed metadata rather than hardcoded: this string said 0.0.0 through
# three version bumps because nothing fails when it drifts.
__version__ = _metadata_version("styx-sdk")
