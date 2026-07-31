/**
 * Verify every identity on the LibertyNet network yourself.
 *
 *     node verify.mjs
 *
 * Zero dependencies. This is the whole point of a self-certifying identity: you
 * can check the entire network's claims against arithmetic, offline, without
 * asking any authority for permission or for a lookup.
 */

import { createHash } from "node:crypto";

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

  // base58 drops leading zero bytes; restore one per leading '1'
  let lead = 0;
  for (const c of s) { if (c === "1") lead++; else break; }
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, "hex")]);
}

/**
 * The registry serves keys as hex from /nodes and base58 from /peers.
 * Same 32 bytes — and parsing one as the other silently produces garbage that
 * fails every check, which looks exactly like the whole network being forged.
 */
function keyBytes(publicKey) {
  if (!publicKey) return null;
  const raw = /^[0-9a-f]{64}$/.test(publicKey)
    ? Buffer.from(publicKey, "hex")
    : b58decode(publicKey);
  return raw && raw.length === 32 ? raw : null;
}

/** Does this DID actually derive from this public key? */
function verifyIdBinding(did, publicKey) {
  const key = keyBytes(publicKey);
  if (!key) return { valid: false, why: "public key is not 32 bytes in hex or base58" };

  const m = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/.exec(did ?? "");
  if (!m) return { valid: false, why: "DID does not match did:svrp:[<tag>:]<hex>" };

  const [, tag, body] = m;

  // Full-hex form: the DID body IS the key.
  if (body.length === 64) {
    if (tag !== undefined) return { valid: false, why: "a tagged 64-hex DID is not a real shape" };
    return { valid: body === key.toString("hex"), why: "body vs hex(key)" };
  }

  // Short (4-byte) and collision-fallback (5-byte) forms.
  if (body.length !== 8 && body.length !== 10) {
    return { valid: false, why: "DID body must be 8, 10 or 64 hex characters" };
  }

  const expected = createHash("sha256").update(key).digest("hex").slice(0, body.length);
  return { valid: body === expected, why: `expected ${expected}` };
}

const { nodes } = await (await fetch(`${REGISTRY}/nodes`)).json();

let verified = 0;
const failures = [];

for (const n of nodes) {
  const result = verifyIdBinding(n.did, n.public_key);
  if (result.valid) verified++;
  else failures.push({ did: n.did, why: result.why });
}

console.log(`${verified}/${nodes.length} identities verified`);

if (failures.length) {
  // Not a nuisance to skip quietly — on a public registry this should be zero,
  // so any failure is a finding worth reporting.
  console.log("\nFAILED:");
  for (const f of failures) console.log(`  ${f.did}\n    ${f.why}`);
  process.exitCode = 1;
}

// "status: active" never decays — only last_seen does.
const fresh = nodes.filter(
  (n) => n.last_seen && Date.now() - Date.parse(n.last_seen) < 10 * 60 * 1000,
);
console.log(`${fresh.length} seen in the last 10 minutes`);

// → 27/27 identities verified
// → 2 seen in the last 10 minutes
