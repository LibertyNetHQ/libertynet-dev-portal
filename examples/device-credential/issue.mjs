#!/usr/bin/env node
/**
 * Issue a DeviceCredential and log in with it.
 *
 *     node issue.mjs
 *     node issue.mjs --offline    # build and self-verify, no network
 *
 * The root key signs exactly one thing, ever: this credential. It happens
 * offline — no network call in that step — and then the root key goes back into
 * cold storage. Everything afterwards is the device key, so a stolen laptop
 * costs a device rather than an identity.
 *
 * This exists because the published schema was wrong and nothing caught it. The
 * OpenAPI file listed seven fields where the registry signs over nine, and every
 * credential in this repository had been written by hand against the registry's
 * own source — the one place a reader cannot look. No code here ever built one
 * from the documentation, so the documentation was free to be wrong.
 *
 * **No dependencies.** Node's own crypto does Ed25519.
 */

import { generateKeyPairSync, sign, verify, createHash, randomBytes } from "node:crypto";

const REGISTRY = process.env.LN_REGISTRY_URL ?? "https://registry.libertynet.ai";
const OFFLINE = process.argv.includes("--offline");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}

function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { privateKey, publicKey, raw, b58: b58encode(raw) };
}

const rfc3339 = (d) => `${d.toISOString().slice(0, 19)}Z`;

/**
 * The nine fields the root key signs, in order.
 *
 * Order is part of the signature. So is the sort on `permissions`: the registry
 * rebuilds these bytes and compares, so reordering anything here produces a
 * credential that verifies nowhere.
 */
function canonicalBytes(c) {
  return Buffer.from(
    [
      "libertynet-operator-device-credential:v1",
      c.credential_id,
      c.operator_did,
      c.operator_root_public_key,
      c.device_id,
      c.device_public_key,
      [...(c.permissions ?? [])].sort().join(","),
      c.issued_at,
      c.expires_at,
      c.revocation_id,
    ].join("\n"),
    "utf8",
  );
}

// -- 1. two keys, and an identity that follows from one of them ---------------

const root = newKeypair();
const device = newKeypair();

// The operator DID is derived, not chosen: sha256(root public key), first 4 bytes.
const operatorDid = `did:svrp:o:${createHash("sha256").update(root.raw).digest("hex").slice(0, 8)}`;

console.log("\n1  KEYS");
console.log(`   operator DID   ${operatorDid}`);
console.log(`   root key       ${root.b58.slice(0, 16)}…  (signs once, then cold)`);
console.log(`   device key     ${device.b58.slice(0, 16)}…  (does everything after)`);

// -- 2. the credential, signed offline ---------------------------------------

const now = new Date();
const credential = {
  credential_id: `cred-${randomBytes(6).toString("hex")}`,
  operator_did: operatorDid,
  operator_root_public_key: root.b58,
  device_id: "example-laptop",
  device_public_key: device.b58,
  permissions: ["nodes.bind"],
  issued_at: rfc3339(now),
  expires_at: rfc3339(new Date(now.getTime() + 90 * 24 * 3600 * 1000)),
  revocation_id: `rev-${randomBytes(6).toString("hex")}`,
};

const bytes = canonicalBytes(credential);
credential.signature = b58encode(sign(null, bytes, root.privateKey));

console.log("\n2  CREDENTIAL");
console.log(`   ${Object.keys(credential).length} fields, ${bytes.length} canonical bytes signed`);
console.log(`   first line     libertynet-operator-device-credential:v1`);
console.log(`   signature      ${credential.signature.slice(0, 24)}…`);

// Verify our own signature before sending it anywhere. If this fails the bug is
// here, and finding that out from a 401 later is a worse afternoon.
const selfOk = verify(null, bytes, root.publicKey, Buffer.from(b58decode(credential.signature)));
console.log(`   self-verifies  ${selfOk}`);
if (!selfOk) process.exit(1);

// -- 3. exchange it for a session --------------------------------------------

if (OFFLINE) {
  console.log("\n3  LOGIN skipped (--offline)\n");
  console.log("CREDENTIAL OK\n");
  process.exit(0);
}

const chRes = await fetch(`${REGISTRY}/v1/auth/challenge`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ operator_did: operatorDid, device_public_key: device.b58 }),
  signal: AbortSignal.timeout(30_000),
});

if (!chRes.ok) {
  console.error(`\nchallenge failed: HTTP ${chRes.status}\n`);
  process.exit(1);
}

const { challenge } = await chRes.json();
const issuedAt = rfc3339(new Date());

// A different domain string, and signed by the DEVICE key — the root key is
// already back in the safe and is not involved in logging in.
const loginBytes = Buffer.from(
  ["libertynet-auth-challenge:v1", operatorDid, device.b58, challenge, issuedAt].join("\n"),
  "utf8",
);

const loginRes = await fetch(`${REGISTRY}/v1/auth/device-login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    device_credential: credential,
    challenge,
    issued_at: issuedAt,
    signature: b58encode(sign(null, loginBytes, device.privateKey)),
  }),
  signal: AbortSignal.timeout(30_000),
});

const body = await loginRes.text();

if (!loginRes.ok) {
  console.error(`\n3  LOGIN REJECTED — HTTP ${loginRes.status}\n   ${body}\n`);
  process.exit(1);
}

const session = JSON.parse(body);
console.log("\n3  SESSION");
console.log(`   operator       ${session.operator_did}`);
console.log(`   expires in     ${session.expires_in}s`);

// -- 4. use it ----------------------------------------------------------------

const nodesRes = await fetch(`${REGISTRY}/v1/operator/me/nodes`, {
  headers: { authorization: `Bearer ${session.session_token}` },
  signal: AbortSignal.timeout(30_000),
});
const nodes = await nodesRes.json();

console.log("\n4  AUTHENTICATED READ");
console.log(`   GET /v1/operator/me/nodes  HTTP ${nodesRes.status}, ${nodes.count} bound node(s)`);
console.log(`   (zero is correct — this operator was created a second ago)`);

console.log("\nCREDENTIAL ACCEPTED\n");

function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}
