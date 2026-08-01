/**
 * Proof of possession, and why a replay is not one.
 *
 *     node challenge.mjs
 *
 * Zero dependencies — Ed25519 verification uses node:crypto directly.
 *
 * Three claims get progressively stronger, and only the third is worth anything:
 *
 *   1. "I am did:svrp:n:…"                 — anyone can say this
 *   2. "…and here is the matching key"     — anyone can copy this from /nodes
 *   3. "…and here is a signature over a
 *       nonce YOU just invented"           — only the key holder can do this
 *
 * Step 3 is the only one that proves anything, and the nonce is what makes it
 * work. This runs all three against the live demo node, then demonstrates that
 * a replayed signature fails the moment you change the nonce.
 */

import { createPublicKey, verify as edVerify } from "node:crypto";
import { randomBytes } from "node:crypto";

const REGISTRY = process.env.LN_REGISTRY_URL ?? "https://registry.libertynet.ai";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let lead = 0;
  for (const c of s) { if (c === "1") lead++; else break; }
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, "hex")]);
}

/**
 * Verify a raw Ed25519 signature with only the standard library.
 *
 * node:crypto wants a KeyObject, and the shortest honest route from 32 raw bytes
 * to one is to wrap them in the fixed DER prefix for an Ed25519 SPKI. No
 * dependency, and nothing hand-rolled about the cryptography itself.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyEd25519(rawPublicKey, message, signature) {
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
    format: "der",
    type: "spki",
  });
  return edVerify(null, message, key, signature);
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// --- find someone who can actually answer ----------------------------------

const { nodes } = await (await fetch(`${REGISTRY}/nodes?callable=1`)).json();
if (!nodes.length) {
  console.log("No callable node on the network right now — nothing to challenge.");
  process.exit(0);
}
const node = nodes[0];
console.log(`Challenging ${node.did}\n  at ${node.endpoint}\n`);

// --- claim 1: an identifier -------------------------------------------------

console.log("1  It claims an identity");
console.log(`     ${node.did}`);
console.log("     Worth nothing on its own — anyone can type that string.\n");

// --- claim 2: an identifier that matches a key ------------------------------

const { createHash } = await import("node:crypto");
const key = b58decode(node.public_key);
const derived = createHash("sha256").update(key).digest("hex").slice(0, 8);
const claimed = node.did.split(":").pop();

console.log("2  The identifier really derives from the key it presents");
console.log(`     sha256(key)[0:4] = ${derived}   claimed = ${claimed}   ${derived === claimed ? "match" : "MISMATCH"}`);
console.log("     Better — but still copyable. Both halves are public in /nodes.\n");

// --- claim 3: a signature over something we just invented -------------------

const nonce = randomBytes(12).toString("hex");
console.log("3  It signs a nonce we invented one millisecond ago");
console.log(`     nonce = ${nonce}`);

const reply = await post(`${node.endpoint}/echo`, { nonce });

if (reply.nonce !== nonce) {
  console.error("     REJECT — it signed a different nonce than we sent");
  process.exit(1);
}
if (reply.public_key !== node.public_key) {
  console.error("     REJECT — the responder is not the node we discovered");
  process.exit(1);
}

const message = Buffer.from(reply.signed_bytes, "utf8");
const signature = b58decode(reply.signature);
const ok = verifyEd25519(key, message, signature);

console.log(`     signature verifies: ${ok}`);
if (!ok) {
  console.error("     REJECT — signature does not verify");
  process.exit(1);
}
console.log("     This one means something: only the private key holder could produce it.\n");

// --- and now the part that matters: a replay must fail ----------------------

console.log("4  A replayed signature is worthless the moment the nonce changes");

const somebodyElsesNonce = randomBytes(12).toString("hex");
const forgedMessage = Buffer.from(
  reply.signed_bytes.replace(nonce, somebodyElsesNonce),
  "utf8",
);
const replayAccepted = verifyEd25519(key, forgedMessage, signature);

console.log(`     same signature, different nonce → verifies: ${replayAccepted}`);
if (replayAccepted) {
  console.error("     ALARM — a replayed signature was accepted. That must never happen.");
  process.exit(1);
}
console.log("     Correctly rejected.\n");

console.log("Possession proved. That is the difference between identity and authentication.");

// → 1 identity claimed · 2 id-binding matches · 3 signature verifies · 4 replay rejected
