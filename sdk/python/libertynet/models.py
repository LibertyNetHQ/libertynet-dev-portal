"""Wire types, mirroring ``dev-portal/api-spec/libertynet-v1.yaml``."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

__all__ = [
    "CapabilityStatus",
    "VerifiedNode",
    "BoundNode",
    "CreditsBalance",
    "EvidenceList",
    "OperatorSession",
    "BindingStatus",
    "BindingRequest",
    "TERMINAL_BINDING_STATES",
]

CapabilityStatus = Literal["implemented", "not_yet_wired", "testing", "planned"]

#: Binding states a session can never leave.
TERMINAL_BINDING_STATES = frozenset(
    {"ACTIVE", "EXPIRED", "REJECTED_BY_OPERATOR", "REJECTED_BY_NODE", "CANCELLED"}
)


@dataclass(frozen=True)
class VerifiedNode:
    """A node record that has passed id-binding verification.

    The SDK never hands you an unverified record as one of these.
    """

    did: str
    public_key: str
    endpoint: str | None
    capabilities: list[str]
    region: str | None
    status: str | None
    last_seen: str | None
    first_seen: str | None
    #: Milliseconds since ``last_seen``, or ``None`` if never reported.
    staleness_ms: float | None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def verified(self) -> bool:
        """Always ``True``. Present so the guarantee is visible at the call site."""
        return True


@dataclass(frozen=True)
class BoundNode:
    node_did: str
    online: bool
    last_seen: str | None
    endpoint: str | None
    region: str | None
    capabilities: list[str]
    authorization: dict[str, Any]


@dataclass(frozen=True)
class CreditsBalance:
    """Credits balance envelope.

    Read ``source`` before reading any amount. When it is ``not_yet_wired`` every
    amount is a placeholder zero rather than a measurement.
    """

    operator_did: str
    unit: str
    settled: dict[str, Any]
    pending: dict[str, Any]
    estimated: dict[str, Any]
    source: str
    disclaimer: str | None = None

    @property
    def is_wired(self) -> bool:
        """Is a real ledger behind these numbers?"""
        return self.source == "ledger"


@dataclass(frozen=True)
class EvidenceList:
    operator_did: str
    count: int
    evidence: list[Any]
    source: str
    note: str | None = None


@dataclass(frozen=True)
class OperatorSession:
    session_token: str
    operator_did: str
    expires_in: int
    #: Unix seconds when this session stops working. Computed client-side.
    expires_at: float


@dataclass(frozen=True)
class BindingStatus:
    binding_session_id: str
    state: str
    node_did: str
    operator_did: str | None
    expires_at: str

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL_BINDING_STATES


@dataclass(frozen=True)
class BindingRequest:
    binding_session_id: str
    state: str
    node_did: str
    node_public_key: str
    node_signature: str
    device_summary: str | None
    os: str | None
    region: str | None
    #: ``a1b2:c3d4:e5f6:0718`` — show to a human to compare out-of-band.
    node_public_key_fingerprint: str
    requested: dict[str, Any]
    nonce: str
    expires_at: str
