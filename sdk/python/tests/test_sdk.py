"""Python SDK tests.

Fixtures are real records from https://registry.libertynet.ai/nodes (2026-07-31),
not invented ones. The "honesty guarantees" block is the executable form of the
promises the docs make — if someone later decides a 0 balance is friendlier than
an exception, these fail and say why.

Live-network tests run only with LN_LIVE=1.
"""

from __future__ import annotations

import io
import json
import os
import re
from datetime import datetime, timedelta, timezone

import pytest

from libertynet import (
    ApiError,
    AuthError,
    IdentityError,
    LibertyNet,
    NotYetWiredError,
    TransportError,
    assert_id_binding,
    decode_public_key,
    did_from_public_key,
    fingerprint,
    parse_did,
    same_identity,
    verify_id_binding,
)

# Full-hex form: the DID body IS the key. From GET /nodes.
FULL_DID = "did:svrp:df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d"
FULL_KEY_HEX = "df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d"

# Short form: body is SHA-256(key)[0:4]; key served as base58. From GET /peers.
SHORT_DID = "did:svrp:n:268d4fe0"
SHORT_KEY_B58 = "7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg"


def _now_z(delta_s: float = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_s)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def good_node(**over):
    return {
        "did": FULL_DID,
        "public_key": FULL_KEY_HEX,
        "endpoint": "172.20.10.5:55785",
        "capabilities": ["inference", "health:ready"],
        "region": "asia-southeast",
        "status": "active",
        "last_seen": _now_z(),
        "first_seen": "2026-07-28T11:49:46Z",
        "signature": None,
        **over,
    }


class _FakeResponse(io.BytesIO):
    def __init__(self, status: int, body):
        super().__init__(json.dumps(body).encode())
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def client(routes: dict, *, calls: list | None = None) -> LibertyNet:
    """A client whose transport returns canned responses."""

    def opener(req, timeout=None):
        if calls is not None:
            calls.append(req)
        path = req.full_url.replace("https://registry.libertynet.ai", "")
        if path not in routes:
            import urllib.error

            raise urllib.error.HTTPError(req.full_url, 404, "nf", {}, io.BytesIO(b"{}"))
        status, body = routes[path]
        if status >= 400:
            import urllib.error

            raise urllib.error.HTTPError(
                req.full_url, status, "err", {}, io.BytesIO(json.dumps(body).encode())
            )
        return _FakeResponse(status, body)

    return LibertyNet(retries=0, opener=opener)


# ------------------------------------------------------------------ identity --


class TestParseDid:
    def test_full_hex_form(self):
        p = parse_did(FULL_DID)
        assert p is not None and p.form == "full-hex" and p.tag is None

    def test_tagged_short_form(self):
        p = parse_did(SHORT_DID)
        assert p is not None and p.form == "short" and p.tag == "n" and p.body == "268d4fe0"

    def test_collision_fallback(self):
        p = parse_did("did:svrp:n:268d4fe012")
        assert p is not None and p.form == "short-fallback"

    def test_rejects_tagged_64hex(self):
        # Not a shape the protocol emits.
        assert parse_did(f"did:svrp:n:{FULL_KEY_HEX}") is None

    @pytest.mark.parametrize(
        "bad", ["", "did:svrp:", "did:web:example.com", "did:svrp:n:ZZZZ", "did:svrp:n:abc"]
    )
    def test_rejects_junk(self, bad):
        assert parse_did(bad) is None


class TestDecodePublicKey:
    def test_accepts_hex(self):
        assert len(decode_public_key(FULL_KEY_HEX)) == 32

    def test_accepts_base58(self):
        assert len(decode_public_key(SHORT_KEY_B58)) == 32

    def test_rejects_wrong_length(self):
        assert decode_public_key("deadbeef") is None

    def test_rejects_empty(self):
        assert decode_public_key("") is None


class TestVerifyIdBinding:
    def test_accepts_real_full_hex_identity(self):
        assert verify_id_binding(FULL_DID, FULL_KEY_HEX)

    def test_accepts_real_short_identity_with_base58_key(self):
        assert verify_id_binding(SHORT_DID, SHORT_KEY_B58)

    def test_rejects_crossed_pairs(self):
        assert not verify_id_binding(SHORT_DID, FULL_KEY_HEX)
        assert not verify_id_binding(FULL_DID, SHORT_KEY_B58)

    def test_rejects_single_flipped_character(self):
        tampered = FULL_DID[:-1] + ("e" if FULL_DID.endswith("d") else "d")
        assert not verify_id_binding(tampered, FULL_KEY_HEX)

    def test_rejects_malformed_without_raising(self):
        assert not verify_id_binding("not-a-did", FULL_KEY_HEX)
        assert not verify_id_binding(FULL_DID, "!!!not-base58!!!")

    def test_assert_raises_identity_error(self):
        with pytest.raises(IdentityError) as e:
            assert_id_binding(SHORT_DID, FULL_KEY_HEX)
        assert e.value.code == "ID_BINDING_FAILED"
        assert e.value.docs.startswith("https://docs.libertynet.ai/")


class TestDerivation:
    def test_rederives_short_did(self):
        assert did_from_public_key(SHORT_KEY_B58, "n") == SHORT_DID

    def test_honours_role_tag(self):
        assert did_from_public_key(SHORT_KEY_B58, "o").startswith("did:svrp:o:")

    def test_same_identity_matches_both_spellings(self):
        short = did_from_public_key(FULL_KEY_HEX, "n")
        assert same_identity(short, FULL_DID, FULL_KEY_HEX)
        assert short != FULL_DID  # ...even though the strings look nothing alike

    def test_same_identity_rejects_different_keys(self):
        assert not same_identity(SHORT_DID, FULL_DID, FULL_KEY_HEX)

    def test_fingerprint_is_grouped_for_humans(self):
        assert re.fullmatch(r"[0-9a-f]{4}(:[0-9a-f]{4}){3}", fingerprint(FULL_KEY_HEX))

    def test_fingerprints_differ_between_keys(self):
        assert fingerprint(FULL_KEY_HEX) != fingerprint(SHORT_KEY_B58)


# ----------------------------------------------------------------- discovery --


class TestDiscovery:
    def test_returns_verified_nodes(self):
        ln = client({"/nodes": (200, {"count": 1, "nodes": [good_node()]})})
        nodes = ln.discovery.all()
        assert len(nodes) == 1 and nodes[0].verified

    def test_drops_forged_record(self):
        forged = good_node(did="did:svrp:n:deadbeef")
        ln = client({"/nodes": (200, {"count": 2, "nodes": [good_node(), forged]})})
        nodes = ln.discovery.all()
        assert len(nodes) == 1 and nodes[0].did == FULL_DID

    def test_audit_surfaces_forged_record(self):
        forged = good_node(did="did:svrp:n:deadbeef")
        ln = client({"/nodes": (200, {"count": 2, "nodes": [good_node(), forged]})})
        result = ln.discovery.audit()
        assert result["total"] == 2
        assert len(result["verified"]) == 1
        assert len(result["rejected"]) == 1

    def test_online_excludes_stale_node_despite_active_status(self):
        stale = good_node(last_seen=_now_z(-86400))
        assert stale["status"] == "active"  # the trap
        ln = client({"/nodes": (200, {"count": 1, "nodes": [stale]})})
        assert ln.discovery.online() == []

    def test_online_filters_by_capability(self):
        ln = client({"/nodes": (200, {"count": 1, "nodes": [good_node()]})})
        assert len(ln.discovery.online(capabilities=["inference"])) == 1
        assert len(ln.discovery.online(capabilities=["storage"])) == 0

    def test_online_filters_by_region(self):
        ln = client({"/nodes": (200, {"count": 1, "nodes": [good_node()]})})
        assert len(ln.discovery.online(region="asia-southeast")) == 1
        assert len(ln.discovery.online(region="eu-west")) == 0

    def test_get_finds_by_did_and_misses_others(self):
        ln = client({"/nodes": (200, {"count": 1, "nodes": [good_node()]})})
        assert ln.discovery.get(FULL_DID) is not None
        assert ln.discovery.get("did:svrp:n:deadbeef") is None


# ---------------------------------------------------------------------- auth --


class TestAuth:
    def test_authed_call_without_session_fails_before_network(self):
        calls: list = []
        ln = client({}, calls=calls)
        with pytest.raises(AuthError):
            ln.operator.nodes()
        assert calls == [], "should not touch the network"

    def test_use_session_attaches_bearer(self):
        calls: list = []
        ln = client(
            {"/v1/operator/me/nodes": (200, {"operator_did": "d", "count": 0, "nodes": []})},
            calls=calls,
        )
        ln.auth.use_session("test-token")
        ln.operator.nodes()
        assert calls[0].headers["Authorization"] == "Bearer test-token"

    def test_logout_clears_session(self):
        ln = client({})
        ln.auth.use_session("t")
        assert ln.auth.is_logged_in()
        ln.auth.logout()
        assert not ln.auth.is_logged_in()

    def test_server_401_becomes_auth_error(self):
        ln = client(
            {
                "/v1/operator/me/nodes": (
                    401,
                    {"code": "SESSION_EXPIRED", "error": "login expired"},
                )
            }
        )
        ln.auth.use_session("stale")
        with pytest.raises(AuthError) as e:
            ln.operator.nodes()
        assert e.value.code == "SESSION_EXPIRED"


# --------------------------------------------------------- honesty guarantees --


WIRED_ZERO = {
    "operator_did": "did:svrp:o:1",
    "unit": "test-credit",
    "settled": {"amount": 0, "meaning": ""},
    "pending": {"amount": 0, "meaning": ""},
    "estimated": {"amount": 0, "meaning": ""},
    "source": "not_yet_wired",
}


class TestHonestyGuarantees:
    def test_settled_credits_refuses_not_yet_wired_zero(self):
        ln = client({"/v1/operator/me/credits": (200, WIRED_ZERO)})
        ln.auth.use_session("t")
        with pytest.raises(NotYetWiredError) as e:
            ln.operator.settled_credits()
        assert e.value.level == "not_yet_wired"

    def test_credits_raw_still_returns_envelope(self):
        ln = client({"/v1/operator/me/credits": (200, WIRED_ZERO)})
        ln.auth.use_session("t")
        raw = ln.operator.credits_raw()
        assert raw.source == "not_yet_wired"
        assert not raw.is_wired
        assert raw.settled["amount"] == 0

    def test_settled_credits_works_once_a_ledger_exists(self):
        ln = client(
            {
                "/v1/operator/me/credits": (
                    200,
                    {**WIRED_ZERO, "source": "ledger", "settled": {"amount": 42, "meaning": ""}},
                )
            }
        )
        ln.auth.use_session("t")
        assert ln.operator.settled_credits() == 42

    def test_is_wired_reports_the_truth(self):
        ln = client({"/v1/operator/me/credits": (200, WIRED_ZERO)})
        ln.auth.use_session("t")
        assert ln.operator.is_wired() is False

    @pytest.mark.parametrize(
        "call", ["wallet.create", "wallet.transfer", "dex.quote", "dex.solve"]
    )
    def test_planned_namespaces_raise_typed_error(self, call):
        ln = client({})
        ns, method = call.split(".")
        with pytest.raises(NotYetWiredError) as e:
            getattr(getattr(ln, ns), method)()
        assert e.value.level == "planned"

    def test_oracle_reports_testing_not_planned(self):
        # The contracts genuinely exist; only the deployment is missing.
        ln = client({})
        with pytest.raises(NotYetWiredError) as e:
            ln.oracle.price()
        assert e.value.level == "testing"

    def test_every_error_carries_a_docs_link(self):
        ln = client({})
        with pytest.raises(NotYetWiredError) as e:
            ln.wallet.create()
        assert e.value.docs.startswith("https://docs.libertynet.ai/")
        assert "->" in str(e.value)

    def test_binding_authorize_refuses_rather_than_guessing_canonical_bytes(self):
        ln = client({})
        with pytest.raises(NotYetWiredError):
            ln.binding.authorize()


# ----------------------------------------------------------------- transport --


class TestTransport:
    def test_does_not_retry_4xx(self):
        calls: list = []
        ln = client({"/health": (400, {"code": "BAD", "error": "nope"})}, calls=calls)
        with pytest.raises(ApiError):
            ln.discovery.health()
        assert len(calls) == 1, "a rejected request must not be replayed"

    def test_transport_failure_is_typed(self):
        def opener(req, timeout=None):
            raise OSError("ECONNREFUSED")

        ln = LibertyNet(retries=0, opener=opener)
        with pytest.raises(TransportError):
            ln.discovery.health()

    def test_base_url_is_configurable(self):
        assert LibertyNet("https://registry.example.test/").base_url == (
            "https://registry.example.test"
        )


# --------------------------------------------------------------------- live --


@pytest.mark.skipif(not os.environ.get("LN_LIVE"), reason="set LN_LIVE=1 to run")
class TestLive:
    def test_registry_is_up_and_all_identities_verify(self):
        ln = LibertyNet()
        assert ln.discovery.health()["status"] == "ok"

        audit = ln.discovery.audit()
        assert audit["total"] > 0, "registry should not be empty"
        assert audit["rejected"] == [], "no live record should fail id-binding"

    def test_credits_still_require_auth(self):
        ln = LibertyNet()
        with pytest.raises(AuthError):
            ln.operator.credits_raw()


# ------------------------------------------------------- reachability (B2) --


class TestReachability:
    """Nodes you cannot reach must not be handed to you as if you could.

    Before this, `online()` returned RFC1918 addresses and `node://laptop`
    labels. Callers dutifully tried them, got timeouts, and reasonably concluded
    the SDK was broken rather than that the node was not for them.
    """

    def _client(self, nodes):
        return client({"/nodes": (200, {"count": len(nodes), "total": len(nodes), "nodes": nodes})})

    def test_excludes_private_endpoints_by_default(self):
        ln = self._client([good_node(reachability="private")])
        assert ln.discovery.online() == []

    def test_excludes_unroutable_endpoints_by_default(self):
        ln = self._client([good_node(endpoint="node://someones-laptop", reachability="unroutable")])
        assert ln.discovery.online() == []

    def test_includes_public_endpoints(self):
        ln = self._client([good_node(reachability="public")])
        assert len(ln.discovery.online()) == 1

    def test_include_unreachable_opts_back_in(self):
        ln = self._client([good_node(reachability="private")])
        assert len(ln.discovery.online(include_unreachable=True)) == 1

    def test_absent_reachability_is_unknown_not_excluded(self):
        # An older registry does not report the field. Hiding the entire network
        # from anyone pointed at one would be a worse failure than showing an
        # address that might not answer.
        node = good_node()
        node.pop("reachability", None)
        ln = self._client([node])
        assert len(ln.discovery.online()) == 1

    def test_callable_requires_a_signature(self):
        ln = self._client([good_node(reachability="public", signature_present=False, signature=None)])
        assert len(ln.discovery.online()) == 1
        assert ln.discovery.callable_nodes() == []

    def test_callable_returns_signed_public_nodes(self):
        ln = self._client([good_node(reachability="public", signature_present=True, signature="sig")])
        assert len(ln.discovery.callable_nodes()) == 1
