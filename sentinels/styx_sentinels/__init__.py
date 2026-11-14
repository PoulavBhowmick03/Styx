"""Styx Sentinels: watcher agents for a Styx vault.

Each sentinel reads the vault's payments and may pause the vault, and nothing else: its key is a
NEAR function-call key allowed only `sentinel_pause`. A parent loop scores sentinels (attacks caught
vs false alarms), retires noisy ones and respawns them with its notes.
"""
