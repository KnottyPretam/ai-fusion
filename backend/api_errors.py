"""Frozen helpers for pre-stream JSON errors (docs/api-contract.md)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def conflict(error: str, **extra: Any) -> HTTPException:
    """409 with body {"error": <code>, ...extra}. Used for busy / incomplete_send_turn /
    nothing_to_fuse / analyze_degraded."""
    return HTTPException(status_code=409, detail={"error": error, **extra})


def not_found(what: str = "conversation") -> HTTPException:
    return HTTPException(status_code=404, detail={"error": "not_found", "what": what})


def unprocessable(error: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=422, detail={"error": error, **extra})
