"""Verify every identity on the LibertyNet network yourself.

    python3 verify.py

Zero dependencies — only the standard library. This is the whole point of a
self-certifying identity: you can check the entire network's claims against
arithmetic, offline, without asking any authority for permission or a lookup.
"""

import hashlib
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

REGISTRY = os.environ.get("LN_REGISTRY_URL", "https://registry.libertynet.ai")

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode(s: str) -> bytes | None:
    n = 0
    for c in s:
        i = B58.find(c)
        if i < 0:
            return None
        n = n * 58 + i
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    # base58 drops leading zero bytes; restore one per leading '1'
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw


def key_bytes(public_key: str) -> bytes | None:
    """The registry serves keys as hex (/nodes) and base58 (/peers).

    Same 32 bytes — and parsing one as the other silently produces garbage that
    fails every check, which looks exactly like the whole network being forged.
    """
    if not public_key:
        return None
    raw = bytes.fromhex(public_key) if re.fullmatch(r"[0-9a-f]{64}", public_key) else b58decode(public_key)
    return raw if raw and len(raw) == 32 else None


def verify_id_binding(did: str, public_key: str) -> tuple[bool, str]:
    """Does this DID actually derive from this public key?"""
    key = key_bytes(public_key)
    if key is None:
        return False, "public key is not 32 bytes in hex or base58"

    m = re.fullmatch(r"did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)", did or "")
    if not m:
        return False, "DID does not match did:svrp:[<tag>:]<hex>"

    tag, body = m.group(1), m.group(2)

    # Full-hex form: the DID body IS the key.
    if len(body) == 64:
        if tag is not None:
            return False, "a tagged 64-hex DID is not a real shape"
        return body == key.hex(), "body vs hex(key)"

    # Short (4-byte) and collision-fallback (5-byte) forms.
    if len(body) not in (8, 10):
        return False, "DID body must be 8, 10 or 64 hex characters"

    expected = hashlib.sha256(key).hexdigest()[: len(body)]
    return body == expected, f"expected {expected}"


with urllib.request.urlopen(f"{REGISTRY}/nodes", timeout=15) as response:
    nodes = json.load(response)["nodes"]

verified = 0
failures = []

for node in nodes:
    ok, why = verify_id_binding(node["did"], node["public_key"])
    if ok:
        verified += 1
    else:
        failures.append((node["did"], why))

print(f"{verified}/{len(nodes)} identities verified")

if failures:
    # On a public registry this should be zero, so any failure is a finding
    # worth reporting rather than a record to skip quietly.
    print("\nFAILED:")
    for did, why in failures:
        print(f"  {did}\n    {why}")
    sys.exit(1)

# "status: active" never decays — only last_seen does.
cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)
fresh = [
    n for n in nodes
    if n.get("last_seen")
    and datetime.strptime(n["last_seen"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) > cutoff
]
print(f"{len(fresh)} seen in the last 10 minutes")

# → 27/27 identities verified
# → 2 seen in the last 10 minutes
