"""Python binding for the Styx agent command-line tool (`styx-near-vault`).

Requests name key files and never contain keys. The Rust binary does the signing and holds the protocol logic.
"""

from styx._vault import VaultError, VaultSeam

__all__ = ["VaultError", "VaultSeam"]
