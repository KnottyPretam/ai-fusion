"""Mock/replay transport (owner: W1). `reset()` is called by the shared conftest before every test."""

from __future__ import annotations


def reset() -> None:
    """Clear (scenario, role, purpose) counters. No-op until W1 lands."""
    return None
