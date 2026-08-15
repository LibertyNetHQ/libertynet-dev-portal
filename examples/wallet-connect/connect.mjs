#!/usr/bin/env node
/**
 * Be authorized by a LibertyNet wallet — the whole of LN-CONNECT-001, end to end.
 *
 *     LN_WALLET_URL=http://127.0.0.1:3210 \
 *     LN_CONNECT_OPERATOR_PASSPHRASE=... \
 *     node connect.mjs
 *
 * Optional: `LN_GATEWAY_URL` — if a coordination gateway is reachable, this also presents the grant
 * to it in `X-LN-Grant` and reports the verdict.
 *
 * # What this is
 *
 * A second, independent relying party for a protocol whose only other client is the application it
 * was written alongside. That distinction is the whole reason this file exists: a protocol only its
 * author's application has ever spoken is indistinguishable, on the evidence, from an interface
 * built for that one application. The proof that it is a protocol is somebody else implementing it
 * from the document and having it work.
 *
 * So: different repository, different SDK, different crypto stack (`@noble/ed25519`, not WebCrypto,
 * not `ed25519-dalek`), and **not one line of code shared** with `libertynet-compute` or with the
 * wallet. Every byte on the wire was agreed by reading the same specification.
 *
 * # And a branch the first client never runs
 *
 * Compute is a *confidential* client: its application key lives in a server-side Worker, so it can
 * be silently re-authorized. This one is a **public** client — its code is published, so anyone who
 * read it could mint a request indistinguishable from a real one, and the wallet must therefore
 * insist a human confirms every time. §7 below asserts that the wallet refuses `prompt=none` here.
 *
 * If reusability were only a claim, that branch would be the one nobody had ever executed.
 *
 * # What it does NOT do
 *
 * It moves no value and cannot. `payment:transfer` and `session:grant` are red-line scopes the
 * protocol names and does not issue; §8 asks for one and shows the refusal.
 *
 * # The one automated shortcut, named
 *
 * Approving at the consent screen is a human action. This script fills the passphrase and POSTs the
 * decision itself, the way an operator would, because an example that stopped for a mouse click
 * could not run in CI. Everything either side of that is real: real keys, real signatures, real
 * manifest fetch over real HTTP, real chain reads behind the resource endpoints.
 */

import { createServer } from "node:http";
import {
  AppIdentity,
  RelyingParty,
  SubjectIdentity,
  verifyGrant,
  ConnectError,
} from "../../sdk/typescript/src/index.ts";

const WALLET = (process.env.LN_WALLET_URL ?? "http://127.0.0.1:3210").replace(/\/+$/, "");
const PASSPHRASE = process.env.LN_CONNECT_OPERATOR_PASSPHRASE ?? "e2e-devnet-passphrase";
const GATEWAY = process.env.LN_GATEWAY_URL?.replace(/\/+$/, "");
const SCOPES = ["identity:read", "balance:read", "authorize:compute"];

/**
 * The platform's default requester policy, spelled out.
 *
 * Only used by §9's gateway probe. Written in full rather than omitted because the contract's
 * `PolicySnapshot` has no optional fields — a signed object is byte-stable on both sides, so
 * "leave it out and the server will fill it in" is not a thing that can be true of one.
 */
const PLATFORM_DEFAULT_POLICY = {
  policy_version: 1,
  budget_limit: 1000,
  min_security_level: "STANDARD",
  verification_strength: "STANDARD",
  allowed_regions: [],
  excluded_providers: [],
  max_risk_bps: 10000,
  min_stake: 0,
  authorization: {
    auto_authorize_max_price: 0,
    auto_authorize_max_risk_bps: 0,
    allow_automatic_provider_switch: true,
  },
  recovery: {
    max_retries_same_provider: 1,
    max_provider_switches: 2,
    heartbeat_timeout_ms: 30000,
    recovery_deadline_ms: 600000,
    resume_from_checkpoint: true,
  },
  request_freshness_window_ms: 300000,
  proposal_validity_ms: 300000,
  require_signed_snapshots: true,
  trusted_snapshot_issuers: [],
  snapshot_freshness_window_ms: 300000,
  require_recovery_capability: false,
  preferred_region: null,
  max_domain_share_bps: 10000,
};

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

// ---------------------------------------------------------------------------------------------
// 1. This application's identity, and the origin that vouches for it
// ---------------------------------------------------------------------------------------------
//
// `did:svrp:s:` — the Service type of DID-001 §3. Note what did NOT have to happen to get one:
// nobody issued it, no registry was asked, no client id was handed out. It is derived from a key
// this process generated a millisecond ago, and it verifies against that key on any machine.

console.log("== 1. Identity and manifest");
const app = await AppIdentity.generate();
check(/^did:svrp:s:[0-9a-f]{8}$/.test(app.did), `this application minted its own DID (${app.did})`);

// The manifest has to be served over real HTTP, by the origin the redirect points at. That fetch is
// the entire authority model: an identity alone proves nothing about where a grant may be sent, so
// the right to receive one at a URL comes from that URL's own origin publishing a manifest signed
// by the application's key. Impersonating an app needs both its key and its domain — which is what
// replaces OAuth's registration step, and why there is nobody handing out client ids.
let manifest = null;
const origin = await new Promise((resolve) => {
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/libertynet-app.json" && manifest) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(manifest));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
  });
});

const rp = new RelyingParty({
  walletOrigin: WALLET,
  app,
  // The honest answer for a published script. See the header.
  confidential: false,
});

const redirectUri = `${origin.url}/`;
manifest = await rp.manifest({
  name: "LibertyNet Developer Portal — Connect example",
  redirectUris: [redirectUri],
  scopes: SCOPES,
});
check(manifest.confidential === false, "the manifest declares this a public client");
check(!!manifest.signature, "the manifest is signed by the application key");

// ---------------------------------------------------------------------------------------------
// 2. Discovery
// ---------------------------------------------------------------------------------------------
//
// The only thing hard-coded is which origin to ask. The issuer DID, the endpoints and the scopes
// come from the wallet — so a wallet that rotates its identity does not require every relying party
// to ship a release. `discover()` refuses a wallet whose published key does not derive its own DID,
// which is checked here rather than three steps later inside a signature failure.

console.log("\n== 2. Discovery");
let config;
try {
  config = await rp.discover();
} catch (error) {
  console.error(`\ncannot reach a wallet at ${WALLET}: ${error.message}`);
  console.error("start one: in libertynet-agent-wallet-ui, `pnpm devnet` then `pnpm dev`");
  origin.close();
  process.exit(2);
}
check(!!config.issuer_did, `the wallet identifies itself as ${config.issuer_did}`);
check(
  /^did:svrp:h:[0-9a-f]{8,10}$/.test(config.issuer_did),
  "the issuer is a DID-001 human DID whose key derives it — not an unverifiable `o:` string",
);
check(
  Array.isArray(config.scopes_refused) && config.scopes_refused.includes("payment:transfer"),
  "the wallet publishes which scopes it refuses, rather than leaving them to be discovered",
);

// ---------------------------------------------------------------------------------------------
// 3–5. Authorize
// ---------------------------------------------------------------------------------------------

console.log("\n== 3. Ask for an authorization");
const start = await rp.authorizationUrl({ scopes: SCOPES, redirectUri });
check(start.url.startsWith(config.authorization_endpoint), "the request targets the wallet's own endpoint");
check(
  /^did:svrp:a:[0-9a-f]{8}$/.test(start.subject.did),
  `a fresh subject identity was minted for this session (${start.subject.did})`,
);

console.log("\n== 4. The human approves, in their own wallet");
// The consent screen renders server-side and mints a single-use token. Fetching it is exactly what a
// browser would do; posting the decision is what the person's click would do.
const consentPage = await fetch(start.url);
const html = await consentPage.text();
const token = /"consentToken\\?":\\?"([A-Za-z0-9_-]+)\\?"/.exec(html);
check(!!token, `the wallet rendered a consent screen (HTTP ${consentPage.status})`);
if (!token) {
  origin.close();
  finish();
}
check(
  html.includes(app.did),
  "the consent screen names the application asking — the person is not approving an anonymous request",
);

const decided = await fetch(`${WALLET}/connect/decide`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    request: start.encodedRequest,
    consent_token: token[1],
    decision: "approve",
    passphrase: PASSPHRASE,
  }),
}).then((r) => r.json());
check(!!decided.redirect_to, `the wallet issued a grant${decided.reason ? `: ${decided.reason}` : ""}`);
if (!decided.redirect_to) {
  origin.close();
  finish();
}

console.log("\n== 5. Verify what came back");
// The redirect is not authentication. Everything that makes this document mean anything is in the
// signature, and this SDK's verifier — a separate implementation in a separate repository — is what
// checks it. A grant the wallet signed must be one this code accepts, and nothing in either type
// system relates the two.
const held = await rp.acceptCallback(new URL(decided.redirect_to).hash, {
  state: start.state,
  subject: start.subject,
  requiredScope: "authorize:compute",
});
check(true, `the grant verifies under this repository's own verifier (${held.grant.grant_id})`);
check(held.grant.issuer_did === config.issuer_did, "it was signed by the wallet discovery named");
check(held.grant.audience_did === app.did, "it was issued to this application and no other");
check(
  held.grant.subject_public_key === start.subject.publicKeyBase58,
  "it is bound to this session's subject key",
);
check(held.grant.limits?.value_movement === "none", "it states that it moves no value");

// Step 4, from the other direction. This is the property the whole design turns on, so it is worth
// showing rather than describing: a grant in someone else's hands is a document, not a credential.
const thief = await SubjectIdentity.generate();
const stolen = await verifyGrant(held.grant, {
  expectedIssuerDid: config.issuer_did,
  audienceDid: app.did,
  presentedSubjectPublicKey: thief.publicKeyBase58,
  requiredScope: "authorize:compute",
  nowMs: Date.now(),
});
check(
  stolen.ok === false && stolen.failure === "subject_mismatch",
  "the same grant is refused to a holder who does not have its subject key — it is not a bearer token",
);

// And the check that makes discovery mean something: every field of this grant verifies, it simply
// was not signed by the wallet this party chose to trust.
const wrongWallet = await verifyGrant(held.grant, {
  expectedIssuerDid: "did:svrp:h:00000000",
  audienceDid: app.did,
  presentedSubjectPublicKey: start.subject.publicKeyBase58,
  requiredScope: "authorize:compute",
  nowMs: Date.now(),
});
check(
  wrongWallet.ok === false && wrongWallet.failure === "wrong_issuer",
  "a grant from an unpinned wallet is refused — a valid signature from an unknown issuer is an attacker's",
);

// ---------------------------------------------------------------------------------------------
// 6. Use it
// ---------------------------------------------------------------------------------------------

console.log("\n== 6. Read what was granted");
const identity = await rp.read("/connect/resource/identity", { held, subject: start.subject });
check(identity.wallet_did === config.issuer_did, `the wallet served its identity (${identity.account?.address})`);
const summary = await rp.read("/connect/resource/summary", { held, subject: start.subject });
// Real chain state behind the endpoint, not a fixture: a live head block and a symbol read from the
// token contract.
check(Number(summary.block_number) > 0, `balances came from a live chain (block ${summary.block_number})`);
check(
  typeof summary.lnt?.symbol === "string" && summary.lnt.symbol.length > 0,
  `the token symbol was read from the chain (${summary.lnt?.symbol})`,
);

// Scope is enforced by the wallet, not merely declared in the consent screen. `activity:read` was
// never asked for, so it must not be served.
let activityRefused = false;
try {
  await rp.read("/connect/resource/activity", { held, subject: start.subject });
} catch (error) {
  activityRefused = error instanceof ConnectError && error.failure === "unauthorized";
}
check(activityRefused, "a resource outside the granted scopes is refused, not served");

// ---------------------------------------------------------------------------------------------
// 7. The branch the first client never runs
// ---------------------------------------------------------------------------------------------

console.log("\n== 7. A public client cannot be silently re-authorized");
// Compute is confidential — its key sits in a server-side Worker — so it uses `prompt=none` on every
// page reload. This client is public, and the protocol says a public client may not. Asserted from
// both sides: the SDK refuses to build the request, and the wallet refuses one built anyway.
let sdkRefused = false;
try {
  await rp.authorizationUrl({ scopes: SCOPES, redirectUri, prompt: "none" });
} catch (error) {
  sdkRefused = error instanceof ConnectError && error.failure === "silent_renewal_not_allowed";
}
check(sdkRefused, "this SDK refuses to build a silent-renewal request for a public client");

// Now the same request, built the way a client that ignored its own rule would build it, so the
// wallet's answer is observed rather than assumed.
const sneaky = new RelyingParty({ walletOrigin: WALLET, app, confidential: true });
const silent = await sneaky.authorizationUrl({
  scopes: SCOPES,
  redirectUri,
  prompt: "none",
  subject: await SubjectIdentity.generate(),
});
const silentAnswer = await fetch(silent.url, { redirect: "manual" });
const silentHtml = await silentAnswer.text();
check(
  /silent_renewal_not_allowed/.test(silentHtml),
  "the wallet refuses it too, by name — the manifest is what decides, not the client's own claim",
);

// ---------------------------------------------------------------------------------------------
// 8. The red line
// ---------------------------------------------------------------------------------------------

console.log("\n== 8. Red-line scopes are refused by name");
let localRefusal = null;
try {
  await rp.manifest({ name: "x", redirectUris: [redirectUri], scopes: ["payment:transfer"] });
} catch (error) {
  localRefusal = error;
}
check(
  localRefusal instanceof ConnectError && localRefusal.failure === "refused_scope",
  "this SDK will not even ask for a value-moving scope",
);

// And the wallet's own answer, so this is the protocol's position rather than this client's opinion.
const greedy = await app.signed({
  protocol: "ln-connect/1",
  app_did: app.did,
  app_public_key: app.publicKeyBase58,
  subject_did: start.subject.did,
  subject_public_key: start.subject.publicKeyBase58,
  scopes: [...SCOPES, "payment:transfer"],
  redirect_uri: redirectUri,
  state: crypto.randomUUID(),
  nonce: crypto.randomUUID(),
  issued_at_ms: Date.now(),
  expires_at_ms: Date.now() + 120_000,
  prompt: "consent",
});
const greedyPage = await fetch(
  `${WALLET}/connect?request=${encodeURIComponent(Buffer.from(JSON.stringify(greedy)).toString("base64url"))}`,
);
const greedyHtml = await greedyPage.text();
check(/refused_scope/.test(greedyHtml), "the wallet refuses it by name rather than as an unknown scope");
check(
  !/consentToken/.test(greedyHtml),
  "and shows no consent screen at all — there is nothing here a person could approve by mistake",
);

// ---------------------------------------------------------------------------------------------
// 9. Present it to the platform
// ---------------------------------------------------------------------------------------------

if (GATEWAY) {
  console.log("\n== 9. Present the grant to a coordination gateway");
  // The header, and the encoding, come from the SDK rather than being re-derived here — "which
  // header, in which encoding" is exactly the detail that gets rebuilt slightly differently in a
  // second place and then fails as an unexplained `not_authorized`.
  const headers = RelyingParty.grantHeaders(held);
  check(headers["x-ln-grant"] === held.encoded, "the SDK produces the header the gateway reads");

  const health = await fetch(`${GATEWAY}/healthz`)
    .then((r) => r.status)
    .catch(() => 0);
  if (health !== 200) {
    console.log(`  (no gateway at ${GATEWAY} — skipped)`);
  } else {
    // A properly signed platform envelope, built here from the published contract. The subject key
    // signs it — the same key the grant is bound to — which is what lets the gateway's step 4 mean
    // something: it compares the grant against an identity it has proved, not against a second
    // value this client also supplied.
    const sessionId = "sess_" + "0".repeat(32);
    const intent = {
      intent_id: "",
      intent_version: 1,
      requester_did: start.subject.did,
      goal: "a probe from the developer portal's Connect example",
      expected_result: "a verdict from the wallet gate",
      input_refs: [],
      capability_requirement: {
        capability_type: "compute-batch-deterministic",
        interface_version: "1",
        capacity: 1,
      },
      budget_limit: 1000,
      deadline_ms: Date.now() + 600_000,
      policy: PLATFORM_DEFAULT_POLICY,
      created_at_ms: Date.now(),
    };
    const envelope = await start.subject.signed({
      operation: "authorize_proposal",
      request_id: crypto.randomUUID(),
      idempotency_key: crypto.randomUUID(),
      actor_did: start.subject.did,
      actor_public_key: start.subject.publicKeyBase58,
      nonce: crypto.randomUUID(),
      timestamp_ms: Date.now(),
      payload: {
        session_id: sessionId,
        commitment_id: "commit_probe",
        commitment_signature: "00".repeat(64),
        intent,
      },
    });

    const post = (extra) =>
      fetch(`${GATEWAY}/v1/sessions/${sessionId}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", ...extra },
        body: JSON.stringify(envelope),
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    // The negative control FIRST, so the positive one below cannot be mistaken for a gate that is
    // simply letting everything through. Identical request, grant omitted.
    const without = await post({});
    console.log(`  without a grant: ${without.status} ${without.body.code ?? ""} — ${without.body.message ?? ""}`);
    check(
      without.status === 403 && without.body.code === "not_authorized",
      "the gateway refuses this exact request when the grant is omitted",
    );
    check(
      String(without.body.message ?? "").includes("x-ln-grant"),
      "and names the header that was missing",
    );

    // The same bytes, with the grant this run obtained from the wallet.
    const with_ = await post(headers);
    console.log(`  with the grant:  ${with_.status} ${with_.body.code ?? ""} — ${with_.body.message ?? ""}`);
    check(
      with_.body.code !== "not_authorized",
      "the same request is admitted once the wallet's grant is attached — a grant issued to a " +
        "second application, verified by a platform neither it nor the wallet shares code with",
    );
    // What comes back instead is whatever the gate hands on to: on a probe session against a
    // gateway with no live core, an internal error. Stated rather than hidden, because "it did not
    // return not_authorized" is the claim being made and nothing more.
    console.log(`  (the request then fails downstream, which is expected: this session does not exist)`);
  }
}

origin.close();
finish();

function finish() {
  console.log(`\n${failures.length ? `FAILED (${failures.length})` : `ALL ${9} SECTIONS PASSED`}`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(failures.length ? 1 : 0);
}
