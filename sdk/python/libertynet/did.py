"""Self-certifying DID handling.

A LibertyNet DID is derived from its public key, so the pairing can be checked
offline. This module is the only place that check is implemented; everything else
routes through it.

Byte-compatible with ``code/portal-daemon/deploy/gce/svrp_crypto.py`` (DID-001
§5), with one deliberate extension: it also accepts the untagged full-hex form
``did:svrp:<64hex>`` that the live registry serves from ``GET /nodes``.

Zero dependencies — only ``hashlib`` and ``re``. Verifying an identity must never
require installing anything.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Literal

from .errors import IdentityError

__all__ = [
    "DidForm",
    "ParsedDid",
    "parse_did",
    "decode_public_key",
    "verify_id_binding",
    "assert_id_binding",
    "did_from_public_key",
    "same_identity",
    "fingerprint",
]

#: ``short`` = SHA-256(key)[0:4]; ``short-fallback`` = [0:5]; ``full-hex`` = the key.
DidForm = Literal["short", "short-fallback", "full-hex"]

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_DID_RE = re.compile(r"^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$")
_HEX32_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class ParsedDid:
    did: str
    form: DidForm
    #: Role tag: ``n`` node, ``o`` operator, ``h`` host. ``None`` on the full-hex form.
    tag: str | None
    #: The hex body after the prefix and optional tag.
    body: str


def parse_did(did: str) -> ParsedDid | None:
    """Parse a DID. Returns ``None`` rather than raising — callers decide."""
    m = _DID_RE.match(did or "")
    if not m:
        return None

    tag, body = m.group(1), m.group(2)

    if len(body) == 64:
        form: DidForm = "full-hex"
    elif len(body) == 8:
        form = "short"
    elif len(body) == 10:
        form = "short-fallback"
    else:
        return None

    # The full-hex form is the raw key and carries no role tag. A tagged 64-hex
    # value is not a shape this protocol produces, so reject rather than guess.
    if form == "full-hex" and tag is not None:
        return None

    return ParsedDid(did=did, form=form, tag=tag, body=body)


def _b58decode(s: str) -> bytes | None:
    n = 0
    for c in s:
        i = _B58.find(c)
        if i < 0:
            return None
        n = n * 58 + i
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    # base58 drops leading zero bytes; restore one per leading '1'
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw


def decode_public_key(public_key: str) -> bytes | None:
    """Decode a key from either encoding the registry serves.

    ``GET /nodes`` returns lowercase hex; ``GET /peers`` returns base58. Same 32
    bytes. Getting this wrong is the classic first bug — a base58 key parsed as
    hex fails every check and makes the whole network look forged.
    """
    if not public_key:
        return None
    try:
        raw = bytes.fromhex(public_key) if _HEX32_RE.match(public_key) else _b58decode(public_key)
    except ValueError:
        return None
    return raw if raw is not None and len(raw) == 32 else None


def verify_id_binding(did: str, public_key: str) -> bool:
    """Is this DID actually bound to this public key?

    The first gate in every trust decision on LibertyNet. A valid signature is NOT
    a valid identity: verifying a signature against a caller-supplied key proves
    only that the key's holder signed, never that the key belongs to the identity
    being claimed. Check the binding first, always.
    """
    parsed = parse_did(did)
    if parsed is None:
        return False

    key = decode_public_key(public_key)
    if key is None:
        return False

    if parsed.form == "full-hex":
        return parsed.body == key.hex()

    digest = hashlib.sha256(key).hexdigest()
    return parsed.body == digest[: len(parsed.body)]


def assert_id_binding(did: str, public_key: str) -> None:
    """Same check, raising :class:`IdentityError` instead of returning ``False``."""
    if not verify_id_binding(did, public_key):
        raise IdentityError(did, "DID is not derived from the supplied public key")


def did_from_public_key(public_key: str, tag: str = "n") -> str:
    """Derive the canonical short DID for a key. ``tag``: ``n`` node, ``o`` operator."""
    key = decode_public_key(public_key)
    if key is None:
        raise IdentityError("(none)", "public key must be 32 bytes, hex or base58")
    return f"did:svrp:{tag}:{hashlib.sha256(key).hexdigest()[:8]}"


def same_identity(did_a: str, did_b: str, public_key: str) -> bool:
    """Do two DID strings name the same node?

    String equality is not enough and will silently split one node into two: the
    same key is written short in bindings and full-hex in discovery.
    """
    return verify_id_binding(did_a, public_key) and verify_id_binding(did_b, public_key)


def fingerprint(public_key: str) -> str:
    """Human-comparable fingerprint: ``a1b2:c3d4:e5f6:0718``.

    Show this to a person and have them compare it against the other device's
    screen. Humans cannot diff 64 hex characters; they can diff four groups of four.
    """
    key = decode_public_key(public_key)
    if key is None:
        raise IdentityError("(none)", "public key must be 32 bytes, hex or base58")
    h = hashlib.sha256(key).hexdigest()[:16]
    return ":".join(h[i : i + 4] for i in range(0, 16, 4))
