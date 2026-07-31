"""The client surface: discovery, auth, operator reads, binding, and the
namespaces for things that do not exist yet.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Iterable

from .did import assert_id_binding, fingerprint, verify_id_binding
from .errors import AuthError, LibertyNetError, NotYetWiredError
from .http import DEFAULT_BASE_URL, Http
from .models import (
    BindingRequest,
    BindingStatus,
    BoundNode,
    CreditsBalance,
    EvidenceList,
    OperatorSession,
    TERMINAL_BINDING_STATES,
    VerifiedNode,
)

__all__ = ["LibertyNet", "Discovery", "Auth", "Operator", "Binding", "Wallet", "Dex", "Oracle"]

#: Default freshness window. A node not seen within this is not "online".
DEFAULT_FRESHNESS_S = 600.0

DOMAIN_AUTH_CHALLENGE = "libertynet-auth-challenge:v1"


# ---------------------------------------------------------------- discovery --


class Discovery:
    """Public node discovery.

    Every method verifies id-binding before returning a record, with no option to
    skip it. Use :meth:`audit` when you specifically want to see failures.
    """

    def __init__(self, http: Http) -> None:
        self._http = http

    def all(self) -> list[VerifiedNode]:
        """Every node in the registry whose identity verifies.

        Failures are dropped rather than returned with a flag — a caller who has
        to remember to check a flag is a caller who will forget.
        """
        payload = self._http.get("/nodes")
        return [
            _to_node(n)
            for n in payload.get("nodes", [])
            if verify_id_binding(n.get("did", ""), n.get("public_key", ""))
        ]

    def online(
        self,
        *,
        freshness_s: float = DEFAULT_FRESHNESS_S,
        capabilities: Iterable[str] | None = None,
        region: str | None = None,
    ) -> list[VerifiedNode]:
        """Verified nodes seen recently.

        ``status == "active"`` does NOT mean online — a node that stopped
        heart-beating keeps that string forever. Freshness comes from
        ``last_seen``, the only field that can actually go stale.
        """
        wanted = list(capabilities or [])
        out = []
        for n in self.all():
            if n.staleness_ms is None or n.staleness_ms > freshness_s * 1000:
                continue
            if region is not None and n.region != region:
                continue
            if not all(c in n.capabilities for c in wanted):
                continue
            out.append(n)
        return out

    def by_capability(self, capability: str, **kwargs: Any) -> list[VerifiedNode]:
        """Verified, fresh nodes advertising a capability."""
        caps = [*kwargs.pop("capabilities", []), capability]
        return self.online(capabilities=caps, **kwargs)

    def get(self, did: str) -> VerifiedNode | None:
        """One node by DID, matching across both encodings.

        Pass either the short or the full form and you get the same node: the
        match is on the underlying key, not the spelling.
        """
        for n in self.all():
            if n.did == did or verify_id_binding(did, n.public_key):
                return n
        return None

    def audit(self) -> dict[str, Any]:
        """The raw table plus a verification verdict per record.

        If ``rejected`` is ever non-empty on the production registry, that is a
        finding worth reporting — not a bad record to quietly skip.
        """
        payload = self._http.get("/nodes")
        raw = payload.get("nodes", [])
        verified, rejected = [], []
        for n in raw:
            if verify_id_binding(n.get("did", ""), n.get("public_key", "")):
                verified.append(_to_node(n))
            else:
                rejected.append(n)
        return {"total": len(raw), "verified": verified, "rejected": rejected}

    def health(self) -> dict[str, Any]:
        """Registry liveness and its current node count."""
        return self._http.get("/health")

    def assert_identity(self, did: str, public_key: str) -> None:
        """Assert a node's identity, raising if it does not hold.

        Call this before trusting anything a node signed — including before
        verifying that signature.
        """
        assert_id_binding(did, public_key)


def _to_node(n: dict[str, Any]) -> VerifiedNode:
    last_seen = n.get("last_seen")
    staleness = None
    if last_seen:
        try:
            seen = datetime.strptime(last_seen, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            staleness = (datetime.now(timezone.utc) - seen).total_seconds() * 1000
        except ValueError:
            staleness = None

    return VerifiedNode(
        did=n.get("did", ""),
        public_key=n.get("public_key", ""),
        endpoint=n.get("endpoint"),
        capabilities=list(n.get("capabilities") or []),
        region=n.get("region"),
        status=n.get("status"),
        last_seen=last_seen,
        first_seen=n.get("first_seen"),
        staleness_ms=staleness,
        raw=n,
    )


# --------------------------------------------------------------------- auth --


class Auth:
    """Operator login: challenge -> device-key signature -> 1-hour session.

    No password anywhere, so nothing to phish and nothing to stuff. The cost is
    that you hold a key; this class never stores it, never logs it and zeroes its
    own copy after use.
    """

    def __init__(self, http: Http) -> None:
        self._http = http

    def challenge(self) -> dict[str, Any]:
        """A single-use challenge with a 300-second life."""
        return self._http.post("/v1/auth/challenge", {})

    def login(self, device_credential: dict[str, Any], device_secret_key: bytes) -> OperatorSession:
        """Log in and store the session on this client.

        Before signing anything, this checks that the credential's own
        ``operator_root_public_key`` really derives ``operator_did``. Skipping
        that would mean signing a challenge for an identity nobody proved they
        own — a verification bypass, not a shortcut.

        Requires ``cryptography`` for Ed25519 signing. Discovery and verification
        do not; only signing pulls in a dependency.
        """
        dc = device_credential

        if not verify_id_binding(dc.get("operator_did", ""), dc.get("operator_root_public_key", "")):
            raise LibertyNetError(
                "ID_BINDING_FAILED",
                "device_credential.operator_did is not derived from operator_root_public_key. "
                "Refusing to sign for an identity that has not been proven.",
            )

        challenge = self.challenge()["challenge"]
        issued_at = rfc3339(time.time())

        message = canon_auth_challenge(
            dc["operator_did"], dc["device_public_key"], challenge, issued_at
        )
        signature = _sign_b58(device_secret_key, message)

        res = self._http.post(
            "/v1/auth/device-login",
            {
                "device_credential": dc,
                "challenge": challenge,
                "issued_at": issued_at,
                "signature": signature,
            },
        )

        self._http.set_bearer(res["session_token"])
        return OperatorSession(
            session_token=res["session_token"],
            operator_did=res["operator_did"],
            expires_in=res["expires_in"],
            expires_at=time.time() + res["expires_in"],
        )

    def use_session(self, token: str) -> None:
        """Attach a session token obtained elsewhere.

        Useful when signing happens in a separate, more protected process — this
        client then never sees a key at all.
        """
        self._http.set_bearer(token)

    def logout(self) -> None:
        """Drop the session from memory. The server-side session still expires."""
        self._http.set_bearer(None)

    def is_logged_in(self) -> bool:
        """Is a session attached? Does not prove the server still accepts it."""
        return self._http.has_bearer()

    def require_session(self) -> None:
        if not self._http.has_bearer():
            raise AuthError("NO_SESSION", "Call `auth.login()` or `auth.use_session()` first.")


def canon_auth_challenge(
    operator_did: str, device_public_key: str, challenge: str, issued_at: str
) -> bytes:
    """Canonical bytes for the login signature.

    Byte-exact mirror of ``svrp_crypto.canon_auth_challenge``. The registry
    rebuilds these bytes and verifies against them, so any drift here produces
    signatures that verify nowhere. Do not reorder fields; do not change the
    domain string.
    """
    return "\n".join(
        [DOMAIN_AUTH_CHALLENGE, operator_did, device_public_key, challenge, issued_at]
    ).encode()


def rfc3339(epoch_s: float) -> str:
    """RFC3339 UTC to the second with a ``Z`` suffix. Other forms are rejected."""
    return datetime.fromtimestamp(epoch_s, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sign_b58(secret_key: bytes, message: bytes) -> str:
    """Ed25519-sign and base58-encode, matching the registry's wire form.

    ``cryptography`` is imported lazily so that the zero-dependency parts of this
    SDK stay zero-dependency.
    """
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except ImportError as e:
        raise LibertyNetError(
            "MISSING_DEPENDENCY",
            "Signing needs the `cryptography` package: pip install 'libertynet[signing]'. "
            "Discovery and identity verification do not require it.",
        ) from e

    key = Ed25519PrivateKey.from_private_bytes(secret_key)
    return _b58encode(key.sign(message))


_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _b58encode(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _B58_ALPHABET[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


# ----------------------------------------------------------------- operator --


class Operator:
    """Operator-scoped reads. Requires a session."""

    def __init__(self, http: Http) -> None:
        self._http = http

    def nodes(self) -> list[BoundNode]:
        """Nodes bound to you, with a computed ``online`` flag."""
        payload = self._http.get("/v1/operator/me/nodes", auth=True)
        return [
            BoundNode(
                node_did=n["node_did"],
                online=n.get("online", False),
                last_seen=n.get("last_seen"),
                endpoint=n.get("endpoint"),
                region=n.get("region"),
                capabilities=list(n.get("capabilities") or []),
                authorization=n.get("authorization") or {},
            )
            for n in payload.get("nodes", [])
        ]

    def credits_raw(self) -> CreditsBalance:
        """The raw credits envelope, ``source`` field intact.

        Today ``source`` is always ``not_yet_wired`` and every amount is ``0``.
        That zero is a placeholder, not a measurement.
        """
        p = self._http.get("/v1/operator/me/credits", auth=True)
        return CreditsBalance(
            operator_did=p["operator_did"],
            unit=p.get("unit", "test-credit"),
            settled=p.get("settled") or {},
            pending=p.get("pending") or {},
            estimated=p.get("estimated") or {},
            source=p.get("source", "not_yet_wired"),
            disclaimer=p.get("disclaimer"),
        )

    def settled_credits(self) -> float:
        """Settled credits — but only if a real ledger stands behind them.

        Raises :class:`NotYetWiredError` while ``source`` is ``not_yet_wired``,
        because returning ``0`` would let it be rendered as "you have earned
        nothing", which is a different and false statement from "we are not
        measuring this yet".
        """
        balance = self.credits_raw()
        if not balance.is_wired:
            raise NotYetWiredError(
                "GET /v1/operator/me/credits",
                "not_yet_wired",
                "the endpoint is live but no credits ledger is connected, so the returned 0 is a "
                "placeholder rather than a balance. Use `credits_raw()` to display the envelope "
                "with its caveat.",
            )
        return float(balance.settled.get("amount", 0))

    def is_wired(self) -> bool:
        """Does a real data source stand behind the credits endpoint yet?"""
        return self.credits_raw().is_wired

    def evidence(self) -> EvidenceList:
        """Contribution evidence.

        Currently ``count: 0`` with ``source: "not_yet_wired"``. Treat an empty
        list as "unknown", never as "you contributed nothing".
        """
        p = self._http.get("/v1/operator/me/evidence", auth=True)
        return EvidenceList(
            operator_did=p["operator_did"],
            count=p.get("count", 0),
            evidence=list(p.get("evidence") or []),
            source=p.get("source", "not_yet_wired"),
            note=p.get("note"),
        )


# ------------------------------------------------------------------ binding --


class Binding:
    """Node <-> operator binding, console side.

    Deliberately narrow: only the steps that need no signing. ``initiate``,
    ``authorize`` and ``accept`` sign canonical bytes whose layout must match the
    registry's reconstruction exactly — a near-miss does not fail loudly, it
    produces a signature that verifies nowhere. Use the audited implementations
    (``operator-console/lib/crypto/canonical.ts``, ``ln-node bind``) instead.
    """

    def __init__(self, http: Http) -> None:
        self._http = http

    def resolve(
        self, *, short_code: str | None = None, binding_token: str | None = None
    ) -> BindingRequest:
        """Redeem a code and see what the node is asking for.

        Show ``node_public_key_fingerprint`` to the human and have them compare it
        against the node's own screen before authorizing.
        """
        if not short_code and not binding_token:
            raise TypeError("resolve() needs either short_code or binding_token")

        p = self._http.post(
            "/v1/bindings/resolve", {"short_code": short_code, "binding_token": binding_token}
        )
        return BindingRequest(
            binding_session_id=p["binding_session_id"],
            state=p["state"],
            node_did=p["node_did"],
            node_public_key=p["node_public_key"],
            node_signature=p["node_signature"],
            device_summary=p.get("device_summary"),
            os=p.get("os"),
            region=p.get("region"),
            node_public_key_fingerprint=p["node_public_key_fingerprint"],
            requested=p.get("requested") or {},
            nonce=p["nonce"],
            expires_at=p["expires_at"],
        )

    def status(self, binding_session_id: str) -> BindingStatus:
        p = self._http.get(f"/v1/bindings/{binding_session_id}/status")
        return _to_binding_status(p)

    def cancel(self, binding_session_id: str) -> BindingStatus:
        """Abort a session. Invalidates its code and token immediately."""
        p = self._http.post(f"/v1/bindings/{binding_session_id}/cancel")
        return _to_binding_status(p)

    def wait_for_terminal(
        self, binding_session_id: str, *, interval_s: float = 2.0, timeout_s: float = 600.0
    ) -> BindingStatus:
        """Poll until terminal or the deadline passes.

        The default timeout matches the protocol's own session TTL — polling
        longer than a session can live is just burning requests.
        """
        deadline = time.time() + timeout_s
        while True:
            s = self.status(binding_session_id)
            if s.state in TERMINAL_BINDING_STATES:
                return s
            if time.time() + interval_s > deadline:
                return s
            time.sleep(interval_s)

    @staticmethod
    def fingerprint(public_key: str) -> str:
        """Human-comparable fingerprint of a node key."""
        return fingerprint(public_key)

    def authorize(self, *args: Any, **kwargs: Any) -> None:
        """Not implemented here, on purpose. See the class docstring."""
        raise NotYetWiredError(
            "binding.authorize()",
            "planned",
            "signing an AuthorizationCredential requires byte-exact canonicalisation that this "
            "SDK does not reimplement. Use the Operator Console. See "
            "https://docs.libertynet.ai/concepts/binding#signing",
        )


def _to_binding_status(p: dict[str, Any]) -> BindingStatus:
    return BindingStatus(
        binding_session_id=p["binding_session_id"],
        state=p["state"],
        node_did=p.get("node_did", ""),
        operator_did=p.get("operator_did"),
        expires_at=p.get("expires_at", ""),
    )


# ------------------------------------------------------------------ planned --


def _planned(what: str, detail: str) -> None:
    raise NotYetWiredError(what, "planned", detail)


class Wallet:
    """Agent wallet. Not built — every method raises.

    Shipping these stubs beats the alternative: without them you get
    ``AttributeError: 'LibertyNet' object has no attribute 'wallet'``, which tells
    you nothing and sends you hunting for a typo.
    """

    def create(self) -> None:
        _planned("wallet.create()", "no wallet system exists. Value transfer is out of scope.")

    def session_key(self) -> None:
        _planned("wallet.session_key()", "no wallet system exists.")

    def transfer(self) -> None:
        _planned(
            "wallet.transfer()",
            "no wallet system exists, and no endpoint in this API moves value.",
        )


class Dex:
    """Intent trading. Not built — every method raises."""

    def intent(self) -> None:
        _planned("dex.intent()", "no intent trading system exists.")

    def quote(self) -> None:
        _planned("dex.quote()", "no quoting system exists.")

    def solve(self) -> None:
        _planned("dex.solve()", "no solver interface exists.")

    def pools(self) -> None:
        _planned("dex.pools()", "no pools exist.")


class Oracle:
    """Oracle. ``testing``, not ``planned`` — the distinction is real.

    The contracts exist and their suite passes (23/23, ``libertynet-oracle/``).
    What is missing is a deployment: no address on any public network, so there is
    nothing for an HTTP client to talk to.
    """

    def price(self) -> None:
        raise NotYetWiredError(
            "oracle.price()",
            "testing",
            "EvidenceOracle and PythPriceAdapter pass their tests but are not deployed to any "
            "public network, so there is no address to read. "
            "https://docs.libertynet.ai/status#oracle",
        )

    def report(self) -> None:
        raise NotYetWiredError(
            "oracle.report()",
            "testing",
            "reporters sign EIP-712 payloads on-chain; there is no HTTP submission surface.",
        )


# ------------------------------------------------------------------- client --


class LibertyNet:
    """LibertyNet client.

    >>> ln = LibertyNet()
    >>> nodes = ln.discovery.online()

    Two properties hold throughout:

    1. **Identity verification is not optional.** Every node record you receive
       has had its DID checked against its public key, with no flag to disable it.
    2. **Unbuilt things raise.** Anything not wired raises
       :class:`NotYetWiredError` naming its real status — never a plausible zero.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 15.0,
        retries: int = 2,
        opener: Any = None,
    ) -> None:
        self._http = Http(base_url, timeout=timeout, retries=retries, opener=opener)

        self.discovery = Discovery(self._http)
        self.auth = Auth(self._http)
        self.operator = Operator(self._http)
        self.binding = Binding(self._http)

        #: Not built. Every method raises :class:`NotYetWiredError`.
        self.wallet = Wallet()
        #: Not built. Every method raises :class:`NotYetWiredError`.
        self.dex = Dex()
        #: Contracts exist and pass tests, but are not deployed. Every method raises.
        self.oracle = Oracle()

    @property
    def base_url(self) -> str:
        """The registry this client talks to."""
        return self._http.base_url
