"""Errors shared by the MCP backends."""


class ConfigError(RuntimeError):
    """A required setting is missing or unsafe at startup."""
