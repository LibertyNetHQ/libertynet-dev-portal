/**
 * LN-CONNECT-001, checked without a wallet in the room.
 *
 * These run offline. They cannot prove interoperability — for that, `examples/wallet-connect` drives
 * a real wallet and a real gateway, and it is the only thing that can, because the disagreement this
 * protocol is vulnerable to produces no error until a signature fails somewhere that names neither
 * the field nor the cause.
 *
 * What these prove is the half a live run cannot: that each refusal is reached *for its own reason*.
 * A live happy path is silent about whether the expiry check exists at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AppIdentity,
  SubjectIdentity,
  Identity,
  RelyingParty,
  ConnectError,
  verifyGrant,
  verifyConnectIdBinding,
  deriveConnectDid,
  connectCanonicalize,
  GRANT_MAX_LIFETIME_MS,
  type Grant,
} from "../src/index.ts";

const NOW = 1_800_000_000_000;

/** A wallet, standing in for one. It is only ever an Ed25519 key — that is the whole trust root. */
async function wallet(): Promise<Identity> {
  return Identity.fromSeed("h", crypto.getRandomValues(new Uint8Array(32)));
}

async function issue(
  issuer: Identity,
  audience: string,
  subject: Identity,
  overrides: Record<string, unknown> = {},
): Promise<Grant> {
  const body = {
    protocol: "ln-connect/1",
    grant_id: "grant_test",
    issuer_did: issuer.did,
    issuer_public_key: issuer.publicKeyBase58,
    audience_did: audience,
    subject_did: subject.did,
    subject_public_key: subject.publicKeyBase58,
    scopes: ["identity:read", "authorize:compute"],
    limits: { authorizations_max: 1, value_movement: "none" },
    issued_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 600_000,
    ...overrides,
  };
  return (await issuer.signed(body)) as unknown as Grant;
}

function options(audience: string, subject: Identity, issuer: Identity) {
  return {
    expectedIssuerDid: issuer.did,
    audienceDid: audience,
    presentedSubjectPublicKey: subject.publicKeyBase58,
    requiredScope: "authorize:compute",
    nowMs: NOW,
  };
}

// ---------------------------------------------------------------------------------------------
// Canonical bytes
// ---------------------------------------------------------------------------------------------

test("canonical JSON sorts keys and emits no insignificant whitespace", () => {
  assert.equal(connectCanonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(connectCanonicalize([1, { z: "x", a: "y" }]), '[1,{"a":"y","z":"x"}]');
});

test("backspace and form feed use their short escapes", () => {
  // `` is valid JSON and the wrong bytes. A different canonical string is a different
  // signature, and this is the exact shape of bug that surfaces as an unexplained refusal.
  assert.equal(connectCanonicalize("a\bb\fc"), '"a\\bb\\fc"');
});

test("a float is refused rather than rounded", () => {
  assert.throws(() => connectCanonicalize({ price: 0.1 }), ConnectError);
});

test("an unsafe integer is refused rather than written out already-corrupted", () => {
  assert.throws(() => connectCanonicalize({ n: 18_446_744_073_709_551_615 }), ConnectError);
});

test("undefined is refused, because JSON.stringify would silently drop the property", () => {
  assert.throws(() => connectCanonicalize({ a: undefined }), ConnectError);
});

test("non-ASCII is emitted literally, not \\u-escaped", () => {
  assert.equal(connectCanonicalize("授权"), '"授权"');
});

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

test("a DID derives from its key, and both legal id lengths verify", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const identity = await Identity.fromSeed("s", key);
  assert.match(identity.did, /^did:svrp:s:[0-9a-f]{8}$/);
  assert.ok(verifyConnectIdBinding(identity.did, identity.publicKeyBase58));

  // The 10-hex collision fallback is legal too. Hard-coding only the 4-byte form is a bug that
  // stays dormant until the day two keys collide on their first four bytes.
  const fallback = deriveConnectDid("s", identity.publicKey, true);
  assert.match(fallback, /^did:svrp:s:[0-9a-f]{10}$/);
  assert.ok(verifyConnectIdBinding(fallback, identity.publicKeyBase58));
});

test("a key that does not derive the claimed DID fails the binding", async () => {
  const a = await AppIdentity.generate();
  const b = await AppIdentity.generate();
  assert.equal(verifyConnectIdBinding(a.did, b.publicKeyBase58), false);
});

test("the `o:` DID the registry contains is not a DID this protocol accepts", () => {
  // Not a hypothetical: `did:svrp:o:f39Fd6e5` exists in the live DID registry, derives from
  // nothing, and cannot be checked by anyone. Accepting one would make every check below
  // decorative — which is why this SDK's Connect verifier is stricter than its registry reader.
  assert.equal(verifyConnectIdBinding("did:svrp:o:f39Fd6e5", "11111111111111111111111111111111"), false);
});

test("an identity never serializes its seed", async () => {
  const identity = await AppIdentity.generate();
  assert.equal(JSON.stringify(identity).includes("redacted"), true);
  assert.equal(Object.keys(identity).includes("seed"), false);
});

// ---------------------------------------------------------------------------------------------
// Grant verification — one test per step, so a passing suite means each step exists
// ---------------------------------------------------------------------------------------------

test("a well-formed grant verifies", async () => {
  const issuer = await wallet();
  const app = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();
  const grant = await issue(issuer, app.did, subject);
  const result = await verifyGrant(grant, options(app.did, subject, issuer));
  assert.equal(result.ok, true);
});

test("step 1 — a signature made with a key that does not derive the issuer DID is refused", async () => {
  // The bypass this order exists to prevent: a real key, a real signature over the real bytes, and
  // someone else's DID on the front. A valid signature is not a valid identity.
  const issuer = await wallet();
  const imposter = await wallet();
  const app = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();

  const body = {
    protocol: "ln-connect/1",
    grant_id: "g",
    issuer_did: issuer.did,
    issuer_public_key: imposter.publicKeyBase58,
    audience_did: app.did,
    subject_did: subject.did,
    subject_public_key: subject.publicKeyBase58,
    scopes: ["authorize:compute"],
    issued_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 600_000,
  };
  const forged = (await imposter.signed(body)) as unknown as Grant;
  const result = await verifyGrant(forged, options(app.did, subject, issuer));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.failure, "id_binding_failed");
});

test("step 2 — a field edited after signing breaks the signature", async () => {
  const issuer = await wallet();
  const app = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();
  const grant = await issue(issuer, app.did, subject);
  const tampered = { ...grant, scopes: [...grant.scopes, "payment:transfer"] } as Grant;
  const result = await verifyGrant(tampered, options(app.did, subject, issuer));
  assert.equal(result.ok === false && result.failure, "signature_invalid");
});

test("an unpinned issuer is refused even though every field verifies", async () => {
  const issuer = await wallet();
  const stranger = await wallet();
  const app = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();
  const grant = await issue(stranger, app.did, subject);
  const result = await verifyGrant(grant, options(app.did, subject, issuer));
  assert.equal(result.ok === false && result.failure, "wrong_issuer");
});

test("step 3 — an expired grant is refused", async () => {
  const issuer = await wallet();
  const app = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();
  const grant = await issue(issuer, app.did, subject, {
    issued_at_ms: NOW - 700_000,
    expires_at_ms: NOW - 1,
  });
  const result = await verifyGrant(grant, options(app.did, subject, issuer));
  assert.equal(result.ok === false && result.failure, "expired");
});

test("step 3 — the protocol's lifetime ceiling is enforced by the verifier, not just the issuer", async () => {
  // Otherwise one careless wallet sets the ceiling for every party that honours its grants.
  const issuer = await wallet();
  const app = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();
  const grant = await issue(issuer, app.did, subject, {
    issued_at_ms: NOW - 1_000,
    expires_at_ms: NOW + GRANT_MAX_LIFETIME_MS + 60_000,
  });
  const result = await verifyGrant(grant, options(app.did, subject, issuer));
  assert.equal(result.ok === false && result.failure, "lifetime_too_long");
});

test("step 3 — a grant issued to another application does not work here", async () => {
  const issuer = await wallet();
  const app = await AppIdentity.generate();
  const other = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();
  const grant = await issue(issuer, other.did, subject);
  const result = await verifyGrant(grant, options(app.did, subject, issuer));
  assert.equal(result.ok === false && result.failure, "wrong_audience");
});

test("step 4 — a stolen grant is useless to whoever stole it", async () => {
  // The one that makes this not a bearer token. Every field of this document is genuine.
  const issuer = await wallet();
  const app = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();
  const thief = await SubjectIdentity.generate();
  const grant = await issue(issuer, app.did, subject);
  const result = await verifyGrant(grant, options(app.did, thief, issuer));
  assert.equal(result.ok === false && result.failure, "subject_mismatch");
});

test("step 4 — a resource server passing audienceDid: null still enforces the subject binding", async () => {
  // `null` disables the audience check on purpose, for a verifier that cannot know which application
  // is calling. It must not disable step 4 as a side effect.
  const issuer = await wallet();
  const app = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();
  const thief = await SubjectIdentity.generate();
  const grant = await issue(issuer, app.did, subject);
  const result = await verifyGrant(grant, {
    ...options(app.did, thief, issuer),
    audienceDid: null,
  });
  assert.equal(result.ok === false && result.failure, "subject_mismatch");
});

test("step 5 — an operation outside the granted scopes is refused", async () => {
  const issuer = await wallet();
  const app = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();
  const grant = await issue(issuer, app.did, subject, { scopes: ["identity:read"] });
  const result = await verifyGrant(grant, options(app.did, subject, issuer));
  assert.equal(result.ok === false && result.failure, "scope_not_granted");
});

test("step 6 — a revoked grant is refused when the caller looked it up", async () => {
  const issuer = await wallet();
  const app = await AppIdentity.generate();
  const subject = await SubjectIdentity.generate();
  const grant = await issue(issuer, app.did, subject);
  const result = await verifyGrant(grant, { ...options(app.did, subject, issuer), revoked: true });
  assert.equal(result.ok === false && result.failure, "revoked");
});

// ---------------------------------------------------------------------------------------------
// The relying party's own refusals
// ---------------------------------------------------------------------------------------------

test("a red-line scope is refused locally, by name, before any round trip", async () => {
  const rp = new RelyingParty({ walletOrigin: "https://wallet.invalid", app: await AppIdentity.generate() });
  await assert.rejects(
    () => rp.manifest({ name: "x", redirectUris: ["https://x.test/"], scopes: ["payment:transfer" as never] }),
    (error: unknown) => error instanceof ConnectError && error.failure === "refused_scope",
  );
});

test("a public client will not build a silent-renewal request", async () => {
  const rp = new RelyingParty({ walletOrigin: "https://wallet.invalid", app: await AppIdentity.generate() });
  await assert.rejects(
    () =>
      rp.authorizationUrl({
        scopes: ["identity:read"],
        redirectUri: "https://x.test/",
        prompt: "none",
      }),
    (error: unknown) => error instanceof ConnectError && error.failure === "silent_renewal_not_allowed",
  );
});

test("discovery refuses a wallet whose published key does not derive its own DID", async () => {
  const real = await wallet();
  const other = await wallet();
  const rp = new RelyingParty({
    walletOrigin: "https://wallet.invalid",
    app: await AppIdentity.generate(),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          protocol: "ln-connect/1",
          issuer_did: real.did,
          issuer_public_key: other.publicKeyBase58,
          authorization_endpoint: "https://wallet.invalid/connect",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(
    () => rp.discover(),
    (error: unknown) => error instanceof ConnectError && error.failure === "id_binding_failed",
  );
});

test("a callback whose state does not match this authorization is refused", async () => {
  const rp = new RelyingParty({ walletOrigin: "https://wallet.invalid", app: await AppIdentity.generate() });
  const subject = await SubjectIdentity.generate();
  await assert.rejects(
    () => rp.acceptCallback("#grant=abc&state=someone-elses", { state: "mine", subject }),
    (error: unknown) => error instanceof ConnectError && error.failure === "state_mismatch",
  );
});
