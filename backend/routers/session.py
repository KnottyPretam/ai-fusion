"""Session cost readout (integrator-owned): process-level running total behind the cost cap."""

from __future__ import annotations

from fastapi import APIRouter

from ..llm import metering

router = APIRouter(prefix="/api/session")


@router.get("/cost")
async def session_cost() -> dict:
    return metering.session_cost_status()
