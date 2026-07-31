"""LibertyNet Python SDK.

    >>> from libertynet import LibertyNet
    >>> ln = LibertyNet()
    >>> for node in ln.discovery.online():
    ...     print(node.did, node.region)

Discovery and identity verification have **no third-party dependencies** — only
``hashlib`` and ``urllib``. Checking who is on a public network should never
require installing anything. Only Ed25519 signing (operator login) pulls in
``cryptography``, and only when you actually call it.
"""

from __future__ import annotations

from .client import (
    Auth,
    Binding,
    Dex,
    Discovery,
    LibertyNet,
    Operator,
    Oracle,
    Wallet,
    canon_auth_challenge,
    rfc3339,
)
from .did import (
    ParsedDid,
    assert_id_binding,
    decode_public_key,
    did_from_public_key,
    fingerprint,
    parse_did,
    same_identity,
    verify_id_binding,
)
from .errors import (
    ApiError,
    AuthError,
    IdentityError,
    LibertyNetError,
    NotYetWiredError,
    TransportError,
)
from .http import DEFAULT_BASE_URL, Http
from .models import (
    TERMINAL_BINDING_STATES,
    BindingRequest,
    BindingStatus,
    BoundNode,
    CreditsBalance,
    EvidenceList,
    OperatorSession,
    VerifiedNode,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # client
    "LibertyNet",
    "Discovery",
    "Auth",
    "Operator",
    "Binding",
    "Wallet",
    "Dex",
    "Oracle",
    "Http",
    "DEFAULT_BASE_URL",
    # identity
    "verify_id_binding",
    "assert_id_binding",
    "parse_did",
    "ParsedDid",
    "decode_public_key",
    "did_from_public_key",
    "same_identity",
    "fingerprint",
    "canon_auth_challenge",
    "rfc3339",
    # errors
    "LibertyNetError",
    "ApiError",
    "AuthError",
    "IdentityError",
    "NotYetWiredError",
    "TransportError",
    # models
    "VerifiedNode",
    "BoundNode",
    "CreditsBalance",
    "EvidenceList",
    "OperatorSession",
    "BindingStatus",
    "BindingRequest",
    "TERMINAL_BINDING_STATES",
]
