#!/usr/bin/env python3
"""LibertyNet canonical demo node.

The portal's front page says you can discover a node on the live network, verify
its identity, and call it. Until this existed, the third step was not true for
anyone outside the project: every node reporting in was on a private address
(`172.20.10.5`) or a machine-local hostname (`node://someones-macbook`), and none
carried a signature. An external developer could discover and verify, then hit a
wall.

This is a small, real node that closes that loop:

  · a real Ed25519 identity, generated here, whose DID derives from its key
  · a **signed** registration and signed heartbeats — not grace-mode unsigned
  · a publicly reachable HTTPS endpoint
  · responses signed over a caller-supplied nonce, so the caller can verify with
    the same arithmetic the quickstart teaches

It deliberately does nothing valuable. It holds no funds, accepts no work that
costs anything, and its key signs only its own registration and demo responses.
If it were compromised the worst outcome is a lying demo endpoint, which is why
it is safe to run unattended.

    python3 server.py --port 3100 --endpoint https://libertynet.ai/demo-node
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import stat
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
        Ed25519PublicKey,
    )
    from cryptography.hazmat.primitives import serialization
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "This needs `cryptography`:  python3 -m venv venv && venv/bin/pip install cryptography\n"
    )
    raise SystemExit(2)

# Byte-for-byte the domains the registry rebuilds and verifies against
# (registry-standalone.py:57). Changing either produces signatures that verify
# nowhere, and the failure surfaces far from its cause.
REGISTER_DOMAIN = "libertynet-node-register:v1"
HEARTBEAT_DOMAIN = "libertynet-node-heartbeat:v1"

DEMO_DOMAIN = "libertynet-demo-node-response:v1"

REGISTRY = os.environ.get("LN_REGISTRY_URL", "https://registry.libertynet.ai")
HEARTBEAT_INTERVAL_S = 60
CAPABILITIES = ["demo", "echo", "health:ready"]

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


def b58decode(s: str) -> bytes | None:
    n = 0
    for c in s:
        i = B58.find(c)
        if i < 0:
            return None
        n = n * 58 + i
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw


# ---------------------------------------------------------------------------
# identity
# ---------------------------------------------------------------------------


class Identity:
    """The node's Ed25519 identity, persisted at 0600.

    Generated on first run and never transmitted. The DID is derived from the
    public key exactly as DID-001 §5 specifies, so anyone can check the pairing
    offline — which is the property the whole quickstart is about.
    """

    def __init__(self, path: str) -> None:
        self.path = path

        if os.path.exists(path):
            with open(path, "rb") as fh:
                seed = fh.read()
            if len(seed) != 32:
                raise SystemExit(f"{path} is not a 32-byte seed — refusing to guess")
        else:
            seed = secrets.token_bytes(32)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            # Written 0600 before any bytes land in it.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR)
            with os.fdopen(fd, "wb") as fh:
                fh.write(seed)
            sys.stderr.write(f"[demo-node] generated a new identity at {path}\n")

        self._key = Ed25519PrivateKey.from_private_bytes(seed)
        self.public_raw = self._key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        self.public_b58 = b58encode(self.public_raw)
        self.did = "did:svrp:n:" + hashlib.sha256(self.public_raw).hexdigest()[:8]

    def sign_b58(self, message: bytes) -> str:
        return b58encode(self._key.sign(message))

    @property
    def fingerprint(self) -> str:
        h = hashlib.sha256(self.public_raw).hexdigest()[:16]
        return ":".join(h[i : i + 4] for i in range(0, 16, 4))


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------


def canon_register(did: str, public_key: str, endpoint: str, caps: list[str], region: str) -> bytes:
    return "\n".join(
        [REGISTER_DOMAIN, did, public_key, endpoint, ",".join(sorted(caps)), region or ""]
    ).encode()


def canon_heartbeat(did: str, ts: int) -> bytes:
    return "\n".join([HEARTBEAT_DOMAIN, did, str(ts)]).encode()


def post(path: str, payload: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{REGISTRY}{path}",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status, json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except json.JSONDecodeError:
            return e.code, {}
    except Exception as e:  # network
        return 0, {"error": str(e)}


class Registrar:
    """Keeps the node registered and heart-beating, both signed.

    Signed rather than grace-mode unsigned on purpose: an unsigned registration
    is exactly what makes the existing nodes unverifiable, and a demo node that
    reproduced that problem would be teaching the wrong thing.
    """

    def __init__(self, identity: Identity, endpoint: str, region: str) -> None:
        self.identity = identity
        self.endpoint = endpoint
        self.region = region
        self.registered = False
        self.last_heartbeat: str | None = None
        self.last_error: str | None = None

    def register(self) -> bool:
        payload = {
            "did": self.identity.did,
            "public_key": self.identity.public_b58,
            "endpoint": self.endpoint,
            "capabilities": CAPABILITIES,
            "region": self.region,
        }
        payload["signature"] = self.identity.sign_b58(
            canon_register(
                payload["did"], payload["public_key"], payload["endpoint"],
                CAPABILITIES, self.region,
            )
        )

        status, body = post("/register", payload)
        self.registered = status == 200 and body.get("registered") is True

        if self.registered:
            # `signed: true` is the bit that matters. If the registry reports
            # false, our signature was ignored rather than verified, and the node
            # is no better than the ones it exists to replace.
            sys.stderr.write(
                f"[demo-node] registered {self.identity.did} "
                f"signed={body.get('signed')} id_bound={body.get('id_bound')}\n"
            )
            if not body.get("signed"):
                sys.stderr.write("[demo-node] WARNING: registry did not count this as signed\n")
        else:
            self.last_error = f"register failed: HTTP {status} {body}"
            sys.stderr.write(f"[demo-node] {self.last_error}\n")

        return self.registered

    def heartbeat(self) -> bool:
        ts = int(time.time())
        payload = {
            "did": self.identity.did,
            "ts": ts,
            "signature": self.identity.sign_b58(canon_heartbeat(self.identity.did, ts)),
        }
        status, body = post("/heartbeat", payload)

        if status == 200 and body.get("ok"):
            self.last_heartbeat = body.get("last_seen")
            return True

        # An unknown DID means the registry lost us — re-register rather than
        # heart-beating into the void until someone notices.
        if body.get("code") == "UNKNOWN_DID":
            sys.stderr.write("[demo-node] registry does not know us — re-registering\n")
            self.register()
            return False

        self.last_error = f"heartbeat failed: HTTP {status} {body}"
        sys.stderr.write(f"[demo-node] {self.last_error}\n")
        return False

    def run_forever(self) -> None:
        self.register()
        while True:
            time.sleep(HEARTBEAT_INTERVAL_S)
            try:
                self.heartbeat()
            except Exception as e:  # never let the loop die
                sys.stderr.write(f"[demo-node] heartbeat loop error: {e}\n")


# ---------------------------------------------------------------------------
# http
# ---------------------------------------------------------------------------

STARTED_AT = time.time()


def make_handler(identity: Identity, registrar: Registrar, public_url: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "libertynet-demo-node/1.0"

        def log_message(self, fmt, *args):  # quieter than the default
            sys.stderr.write("[demo-node] %s\n" % (fmt % args))

        def _send(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, indent=2).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            # Called from browsers and from other origins' tooling; it is a
            # public read-only demo, so this is safe and saves a class of
            # confusing failures.
            self.send_header("access-control-allow-origin", "*")
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _path(self) -> str:
            p = self.path.split("?", 1)[0]
            # Reachable both directly and behind a /demo-node prefix.
            return p[len("/demo-node"):] or "/" if p.startswith("/demo-node") else p

        def do_GET(self) -> None:
            path = self._path()

            if path in ("/", "/health"):
                return self._send(200, {
                    "status": "ok",
                    "service": "libertynet-demo-node",
                    "did": identity.did,
                    "uptime_s": int(time.time() - STARTED_AT),
                    "registered": registrar.registered,
                    "last_heartbeat": registrar.last_heartbeat,
                    "capabilities": CAPABILITIES,
                    "what_this_is": (
                        "A real, publicly reachable LibertyNet node that exists so the "
                        "quickstart's discover -> verify -> act loop is true for people "
                        "outside the project. It holds nothing of value."
                    ),
                    "try": {
                        "identity": f"{public_url}/identity",
                        "echo": f"POST {public_url}/echo  {{\"nonce\":\"anything\"}}",
                        "verify": f"{public_url}/verify-instructions",
                    },
                })

            if path == "/identity":
                return self._send(200, {
                    "did": identity.did,
                    "public_key": identity.public_b58,
                    "public_key_hex": identity.public_raw.hex(),
                    "fingerprint": identity.fingerprint,
                    "id_binding": (
                        "sha256(public_key)[0:4] hex == the part after did:svrp:n: — "
                        "check it yourself, no lookup required"
                    ),
                })

            if path == "/verify-instructions":
                return self._send(200, {
                    "step_1_discover": f"curl -s {REGISTRY}/nodes | grep {identity.did}",
                    "step_2_verify_identity": (
                        "sha256(base58_decode(public_key))[0:4].hex() == "
                        f"'{identity.did.split(':')[-1]}'"
                    ),
                    "step_3_act": (
                        f"curl -s -X POST {public_url}/echo -d '{{\"nonce\":\"hello\"}}' "
                        "then verify `signature` with Ed25519 over `signed_bytes` using the "
                        "same public_key you just verified"
                    ),
                    "signed_bytes_format": f"{DEMO_DOMAIN}\\n<nonce>\\n<timestamp>",
                    "docs": "https://docs.libertynet.ai/quickstart",
                })

            self._send(404, {"error": "not found", "try": ["/health", "/identity", "/echo"]})

        def do_POST(self) -> None:
            if self._path() != "/echo":
                return self._send(404, {"error": "not found"})

            length = int(self.headers.get("content-length") or 0)
            # Bounded: an unbounded read on a public endpoint is a denial of
            # service waiting to be found.
            if length > 4096:
                return self._send(413, {"error": "body too large (max 4096 bytes)"})

            try:
                body = json.loads(self.rfile.read(length).decode() or "{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                return self._send(400, {"error": "body must be JSON"})

            nonce = str(body.get("nonce") or "")[:256]
            if not nonce:
                return self._send(400, {
                    "error": "nonce required",
                    "why": (
                        "You choose the nonce so the signature you get back cannot be a "
                        "replay of one we prepared earlier. That is what makes this proof "
                        "of possession rather than a recording."
                    ),
                    "example": '{"nonce": "anything-you-like"}',
                })

            ts = int(time.time())
            signed_bytes = f"{DEMO_DOMAIN}\n{nonce}\n{ts}".encode()

            self._send(200, {
                "did": identity.did,
                "public_key": identity.public_b58,
                "nonce": nonce,
                "timestamp": ts,
                "signed_bytes": signed_bytes.decode(),
                "signature": identity.sign_b58(signed_bytes),
                "verify": (
                    "Ed25519-verify `signature` (base58) against `signed_bytes` (utf-8) using "
                    "`public_key` (base58). It will only pass if this node holds the private "
                    "key for the DID you discovered — which is the whole point."
                ),
            })

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            self.send_header("access-control-allow-headers", "content-type")
            self.end_headers()

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description="LibertyNet canonical demo node")
    ap.add_argument("--port", type=int, default=3100)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--key", default="/var/lib/libertynet-demo-node/identity.key")
    ap.add_argument("--endpoint", required=True, help="publicly reachable URL to advertise")
    ap.add_argument("--region", default="asia-southeast")
    ap.add_argument("--no-register", action="store_true", help="serve without touching the registry")
    args = ap.parse_args()

    identity = Identity(args.key)
    sys.stderr.write(
        f"[demo-node] identity {identity.did}\n"
        f"[demo-node] fingerprint {identity.fingerprint}\n"
        f"[demo-node] endpoint {args.endpoint}\n"
    )

    registrar = Registrar(identity, args.endpoint, args.region)
    if not args.no_register:
        threading.Thread(target=registrar.run_forever, daemon=True).start()

    server = ThreadingHTTPServer(
        (args.host, args.port), make_handler(identity, registrar, args.endpoint)
    )
    sys.stderr.write(f"[demo-node] listening on {args.host}:{args.port}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
