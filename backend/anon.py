"""Anonymization firewall (owner: W3). Frozen signatures."""

from __future__ import annotations

from .schemas import Conversation, Label, PeerState, SlotId


def labels(conv: Conversation) -> dict[Label, SlotId]:
    raise NotImplementedError("W3: backend.anon.labels")


def label_of(conv: Conversation, slot: SlotId) -> Label:
    raise NotImplementedError("W3: backend.anon.label_of")


def slot_of(conv: Conversation, label: Label) -> SlotId:
    raise NotImplementedError("W3: backend.anon.slot_of")


def render_peer_block(peers: list[PeerState], exclude: Label) -> str:
    raise NotImplementedError("W3: backend.anon.render_peer_block")


def scrub(text: str) -> str:
    raise NotImplementedError("W3: backend.anon.scrub")


def find_leaks(text: str) -> list[str]:
    raise NotImplementedError("W3: backend.anon.find_leaks")
