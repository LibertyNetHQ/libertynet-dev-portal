/**
 * The zero-dependency LibertyNet client that gets written into every scaffolded
 * project as `src/libertynet.mjs`.
 *
 * Kept as one exported string rather than a file copy so the scaffolder stays a
 * single self-contained package with nothing to resolve at runtime.
 *
 * It is a strict subset of `libertynet-sdk`: same method names, same semantics,
 * same non-optional verification — just discovery and identity, with no
 * dependencies at all. That is what lets a fresh project run with `node
 * src/index.mjs` and zero `npm install`. When the published SDK is available,
 * deleting this file and importing `libertynet-sdk` requires no other change.
 */

export const CLIENT_MJS = String.raw`/**
 * Minimal LibertyNet client — discovery and identity verification.
 *
 * Zero dependencies: only \`node:crypto\`. Checking who is on a public network
 * should never require installing anything.
 *
 * This is a subset of libertynet-sdk with identical semantics. To switch:
 *
 *     npm install libertynet-sdk
 *     // then replace:  import { LibertyNet } from "./libertynet.mjs";
 *     // with:          import { LibertyNet } from "libertynet-sdk";
 *
 * Nothing else in your code needs to change.
 */

import { createHash } from "node:crypto";

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
 * The registry serves keys as hex from /nodes and as base58 from /peers.
 * Same 32 bytes. Parsing a base58 key as hex makes the whole network look forged.
 */
function keyBytes(publicKey) {
  if (!publicKey) return null;
  const raw = /^[0-9a-f]{64}$/.test(publicKey)
    ? Buffer.from(publicKey, "hex")
    : b58decode(publicKey);
  return raw && raw.length === 32 ? raw : null;
}

/**
 * Is this DID actually derived from this public key?
 *
 * The first gate in every trust decision on LibertyNet. A valid signature is NOT
 * a valid identity — verifying a signature against a caller-supplied key proves
 * only that the key's holder signed it, never that the key belongs to the
 * identity being claimed. Check the binding first, always.
 */
export function verifyIdBinding(did, publicKey) {
  const key = keyBytes(publicKey);
  if (!key) return false;

  const m = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/.exec(did || "");
  if (!m) return false;

  const [, tag, body] = m;
  if (body.length === 64) return tag === undefined && body === key.toString("hex");
  if (body.length !== 8 && body.length !== 10) return false;

  return body === createHash("sha256").update(key).digest("hex").slice(0, body.length);
}

/** Human-comparable fingerprint: a1b2:c3d4:e5f6:0718 */
export function fingerprint(publicKey) {
  const key = keyBytes(publicKey);
  if (!key) throw new Error("public key must be 32 bytes, hex or base58");
  return createHash("sha256").update(key).digest("hex").slice(0, 16).match(/.{1,4}/g).join(":");
}

export class LibertyNet {
  constructor({ baseUrl = "https://registry.libertynet.ai", timeoutMs = 15000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.discovery = new Discovery(this);
  }

  async _get(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, { signal: controller.signal });
      if (!res.ok) throw new Error(path + " returned HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

class Discovery {
  constructor(client) {
    this.client = client;
  }

  /** Registry liveness and its current node count. */
  async health() {
    return this.client._get("/health");
  }

  /** Every node whose identity verifies. Failures are dropped, never returned. */
  async all() {
    const { nodes } = await this.client._get("/nodes");
    return nodes
      .filter((n) => verifyIdBinding(n.did, n.public_key))
      .map((n) => ({
        ...n,
        verified: true,
        staleness_ms: n.last_seen ? Date.now() - Date.parse(n.last_seen) : null,
      }));
  }

  /**
   * Verified nodes seen recently.
   *
   * status === "active" does NOT mean online — a node that stopped heart-beating
   * keeps that string forever. Freshness comes from last_seen.
   */
  async online({ freshnessMs = 600000, capabilities = [], region } = {}) {
    return (await this.all()).filter((n) => {
      if (n.staleness_ms === null || n.staleness_ms > freshnessMs) return false;
      if (region && n.region !== region) return false;
      return capabilities.every((c) => n.capabilities.includes(c));
    });
  }

  /** The raw table plus a verification verdict per record. */
  async audit() {
    const { nodes } = await this.client._get("/nodes");
    const verified = [];
    const rejected = [];
    for (const n of nodes) {
      if (verifyIdBinding(n.did, n.public_key)) verified.push(n);
      else rejected.push(n);
    }
    return { total: nodes.length, verified, rejected };
  }
}
`;
