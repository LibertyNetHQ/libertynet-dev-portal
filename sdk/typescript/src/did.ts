/**
 * Self-certifying DID handling.
 *
 * A LibertyNet DID is derived from its public key, so the pairing can be checked
 * offline. This file is the only place that check is implemented, and everything
 * else in the SDK routes through it.
 *
 * Compatible with `code/portal-daemon/deploy/gce/svrp_crypto.py` (DID-001 §5) and
 * with `operator-console/lib/crypto/primitives.ts`, with one deliberate extension:
 * this implementation ALSO accepts the untagged full-hex form
 * `did:svrp:<64hex>`, which the live registry serves from `GET /nodes` and which
 * the console helper rejects. Both forms are real and appear in production data.
 */

import { sha256 } from "@noble/hashes/sha256";
import { base58 } from "@scure/base";
import { IdentityError } from "./errors.ts";

/** The three DID shapes that appear on the wire. */
export type DidForm =
  /** `did:svrp:n:8545027b` — first 4 bytes of SHA-256(key). Used by bindings. */
  | "short"
  /** `did:svrp:n:8545027b12` — 5-byte collision fallback (DID-001 §5). */
  | "short-fallback"
  /** `did:svrp:df9d...02d` — the 32-byte key itself. Announced by daemons. */
  | "full-hex";

export interface ParsedDid {
  readonly did: string;
  readonly form: DidForm;
  /** Role tag: `n` node, `o` operator, `h` host. Absent on the full-hex form. */
  readonly tag: string | null;
  /** The hex body after the prefix and optional tag. */
  readonly body: string;
}

const DID_RE = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/;

/** Parse a DID string. Returns `null` rather than throwing — callers decide. */
export function parseDid(did: string): ParsedDid | null {
  const m = DID_RE.exec(did ?? "");
  if (!m) return null;

  const tag = m[1] ?? null;
  const body = m[2]!;

  let form: DidForm;
  if (body.length === 64) form = "full-hex";
  else if (body.length === 8) form = "short";
  else if (body.length === 10) form = "short-fallback";
  else return null;

  // The full-hex form is the raw key and carries no role tag. A tagged 64-hex
  // value is not a shape this protocol produces, so reject rather than guess.
  if (form === "full-hex" && tag !== null) return null;

  return { did, form, tag, body };
}

/**
 * Decode a public key from either encoding the registry serves.
 *
 * `GET /nodes` returns lowercase hex; `GET /peers` returns base58. Same 32 bytes.
 * Getting this wrong is the classic first bug — a base58 key parsed as hex fails
 * every id-binding check and looks like the whole network is forged.
 */
export function decodePublicKey(publicKey: string): Uint8Array | null {
  try {
    if (/^[0-9a-f]{64}$/.test(publicKey)) {
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) out[i] = Number.parseInt(publicKey.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    const raw = base58.decode(publicKey);
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Is this DID actually bound to this public key?
 *
 * This is the first gate in every trust decision on LibertyNet. A valid signature
 * is NOT a valid identity: verifying a signature against a caller-supplied key
 * proves only that whoever holds that key signed it, never that the key belongs
 * to the identity being claimed. Check the binding first, always.
 */
export function verifyIdBinding(did: string, publicKey: string): boolean {
  const parsed = parseDid(did);
  if (!parsed) return false;

  const key = decodePublicKey(publicKey);
  if (!key) return false;

  if (parsed.form === "full-hex") return parsed.body === toHex(key);

  const digest = toHex(sha256(key));
  return parsed.body === digest.slice(0, parsed.body.length);
}

/** Same check, but throws {@link IdentityError} instead of returning `false`. */
export function assertIdBinding(did: string, publicKey: string): void {
  if (!verifyIdBinding(did, publicKey)) {
    throw new IdentityError(did, "DID is not derived from the supplied public key");
  }
}

/** Derive the canonical short DID for a key. `tag`: `n` node, `o` operator. */
export function didFromPublicKey(publicKey: string, tag = "n"): string {
  const key = decodePublicKey(publicKey);
  if (!key) throw new IdentityError("(none)", "public key must be 32 bytes, hex or base58");
  return `did:svrp:${tag}:${toHex(sha256(key)).slice(0, 8)}`;
}

/**
 * Do two DID strings name the same node?
 *
 * String equality is not enough and will silently split one node into two: the
 * same key is written short in bindings and full-hex in discovery. Given the key,
 * this compares the underlying identity instead of the spelling.
 */
export function sameIdentity(didA: string, didB: string, publicKey: string): boolean {
  return verifyIdBinding(didA, publicKey) && verifyIdBinding(didB, publicKey);
}

/**
 * Human-comparable fingerprint: `a1b2:c3d4:e5f6:0718`.
 *
 * Show this to a person and have them compare it against the other device's
 * screen before they authorize anything. Humans cannot diff 64 hex characters;
 * they can diff four groups of four.
 */
export function fingerprint(publicKey: string): string {
  const key = decodePublicKey(publicKey);
  if (!key) throw new IdentityError("(none)", "public key must be 32 bytes, hex or base58");
  return toHex(sha256(key)).slice(0, 16).match(/.{1,4}/g)!.join(":");
}
