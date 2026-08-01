/**
 * Who can you actually call?
 *
 *     node callable.mjs
 *
 * Zero dependencies. The registry lists every node that ever checked in, which
 * is not the same as every node you can reach. This shows the difference, and
 * why the honest number is much smaller than the impressive one.
 *
 * The lesson is not "the network is small". It is that a directory of addresses
 * is not a directory of *reachable* addresses, and code that assumes otherwise
 * spends its life timing out.
 */

import { createHash } from "node:crypto";

const REGISTRY = process.env.LN_REGISTRY_URL ?? "https://registry.libertynet.ai";
const FRESHNESS_MS = 10 * 60 * 1000;

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

function keyBytes(pk) {
  if (!pk) return null;
  const raw = /^[0-9a-f]{64}$/.test(pk) ? Buffer.from(pk, "hex") : b58decode(pk);
  return raw && raw.length === 32 ? raw : null;
}

function verifyIdBinding(did, publicKey) {
  const key = keyBytes(publicKey);
  if (!key) return false;
  const m = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/.exec(did ?? "");
  if (!m) return false;
  const [, tag, body] = m;
  if (body.length === 64) return tag === undefined && body === key.toString("hex");
  if (body.length !== 8 && body.length !== 10) return false;
  return body === createHash("sha256").update(key).digest("hex").slice(0, body.length);
}

/**
 * Classify an endpoint the same way the registry does.
 *
 * Reproduced here rather than trusted, so this example still tells you the truth
 * if it is ever pointed at a registry that does not compute the field.
 */
function classify(endpoint) {
  if (!endpoint) return "unroutable";

  let host;
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    host = endpoint.split("://")[1].split("/")[0].split(":")[0];
  } else if (endpoint.includes("://")) {
    return "unroutable";                       // node:// and friends are labels
  } else {
    host = endpoint.includes(":") ? endpoint.slice(0, endpoint.lastIndexOf(":")) : endpoint;
  }
  if (!host) return "unroutable";

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return "public";                    // a resolvable hostname

  const [a, b] = [Number(v4[1]), Number(v4[2])];
  const isPrivate =
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
  return isPrivate ? "private" : "public";
}

const { nodes } = await (await fetch(`${REGISTRY}/nodes`)).json();

const rows = nodes.map((n) => ({
  did: n.did,
  endpoint: n.endpoint,
  reach: n.reachability ?? classify(n.endpoint),   // registry's answer, or ours
  signed: n.signature_present ?? Boolean(n.signature),
  verified: verifyIdBinding(n.did, n.public_key),
  fresh: Boolean(n.last_seen) && Date.now() - Date.parse(n.last_seen) < FRESHNESS_MS,
  caps: n.capabilities ?? [],
}));

const count = (fn) => rows.filter(fn).length;

console.log(`${REGISTRY}\n`);
console.log(`  registered           ${rows.length}`);
console.log(`  identity verifies    ${count((r) => r.verified)}`);
console.log(`  publicly reachable   ${count((r) => r.reach === "public")}`);
console.log(`    private address    ${count((r) => r.reach === "private")}   ← real to its operator, not to you`);
console.log(`    unroutable label   ${count((r) => r.reach === "unroutable")}   ← node://hostname, nothing to dial`);
console.log(`  carries a signature  ${count((r) => r.signed)}`);
console.log(`  seen in last 10 min  ${count((r) => r.fresh)}`);

const callable = rows.filter((r) => r.verified && r.reach === "public" && r.signed && r.fresh);

console.log(`\n  CALLABLE             ${callable.length}   verified + public + signed + fresh\n`);

if (callable.length === 0) {
  // Not an error. A true statement about the network at this moment.
  console.log("  Nobody is reachable right now. That is a real answer, not a failure.");
} else {
  for (const r of callable) {
    console.log(`    ${r.did}`);
    console.log(`      ${r.endpoint}   ${r.caps.join(", ") || "no capabilities"}`);
  }
}

console.log(
  `\n  The registry can also answer this for you:\n` +
    `    curl -s '${REGISTRY}/nodes?callable=1'\n`,
);

// → registered 28 · publicly reachable 11 · signature 5 · CALLABLE 1
