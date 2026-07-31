"""Error types.

Design rule, same as the TypeScript SDK: an error must say what happened, why,
and what to do about it. Every error carries a ``docs`` link to the page with the
fix, because "request failed" is not a diagnosis.
"""

from __future__ import annotations

__all__ = [
    "LibertyNetError",
    "ApiError",
    "AuthError",
    "IdentityError",
    "NotYetWiredError",
    "TransportError",
]

DOCS = "https://docs.libertynet.ai"


class LibertyNetError(Exception):
    """Base for every error this SDK raises. Catch this to catch them all."""

    def __init__(self, code: str, message: str, docs: str | None = None) -> None:
        super().__init__(message)
        #: Stable machine-readable identifier. Branch on this, never on the text.
        self.code = code
        self.message = message
        self.docs = docs or f"{DOCS}/reference/errors#{code.lower()}"

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}\n  -> {self.docs}"


class ApiError(LibertyNetError):
    """The API returned a non-2xx status. ``code`` is the API's own error code."""

    def __init__(self, status: int, code: str, message: str, body: object = None) -> None:
        super().__init__(code, message)
        self.status = status
        self.body = body


class IdentityError(LibertyNetError):
    """A DID does not derive from the public key presented alongside it.

    Not transient. Never retry it and never ignore it — the record is either
    corrupt or forged.
    """

    def __init__(self, did: str, detail: str) -> None:
        super().__init__(
            "ID_BINDING_FAILED",
            f"{detail} (did: {did})",
            f"{DOCS}/concepts/identity#id-binding",
        )
        self.did = did


class NotYetWiredError(LibertyNetError):
    """You called something with no data source behind it, or that is not built.

    Deliberate. Returning a plausible zero instead would let a ``not_yet_wired``
    balance be rendered to a user as an earning.
    """

    def __init__(self, what: str, level: str, detail: str) -> None:
        super().__init__("NOT_YET_WIRED", f"{what} is {level}: {detail}", f"{DOCS}/status")
        #: ``not_yet_wired``, ``planned`` or ``testing``.
        self.level = level


class TransportError(LibertyNetError):
    """The network call itself failed — DNS, TLS, timeout, offline."""

    def __init__(self, message: str, reason: object = None) -> None:
        super().__init__("TRANSPORT_ERROR", message, f"{DOCS}/reference/errors#transport_error")
        self.reason = reason


class AuthError(LibertyNetError):
    """You are not logged in, or your session has expired."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message, f"{DOCS}/guides/operator-login")
