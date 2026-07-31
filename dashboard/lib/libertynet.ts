/**
 * Browser client for the dashboard.
 *
 * A trimmed mirror of `@libertynet/sdk` with the same non-negotiables: identity
 * verification is not optional, and a `not_yet_wired` value is never returned as
 * if it were a measurement.
 *
 * It is duplicated here rather than imported because the SDK is not published
 * yet and a `file:` dependency across the repo would make this app unbuildable
 * for anyone who cloned only part of it. When `@libertynet/sdk` ships, this file
 * is deleted and the import changes.
 */

import { sha256 } from "@noble/hashes/sha256";
import { base58 } from "@scure/base";

export const REGISTRY =
  process.env.NEXT_PUBLIC_LN_REGISTRY_URL ?? "https://registry.libertynet.ai";

export interface NodeRecord {
  did: string;
  public_key: string;
  endpoint: string | null;
  capabilities: string[];
  region: string | null;
  status: string | null;
  last_seen: string | null;
  first_seen: string | null;
}

export interface VerifiedNode extends NodeRecord {
  verified: true;
  online: boolean;
  staleness_ms: number | null;
}

export interface BoundNode {
  node_did: string;
  online: boolean;
  last_seen: string | null;
  endpoint: string | null;
  region: string | null;
  capabilities: string[];
  authorization: {
    task_types: string[] | null;
    single_limit: number | null;
    daily_limit: number | null;
    revocation_id: string | null;
    activated_at: string | null;
  };
}

export interface CreditsBalance {
  operator_did: string;
  unit: string;
  disclaimer?: string;
  settled: { amount: number; meaning: string };
  pending: { amount: number; meaning: string };
  estimated: { amount: number; meaning: string };
  /** Check this before rendering any amount. */
  source: "not_yet_wired" | "ledger";
}

// ---------------------------------------------------------------- identity --

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Decode a key from either encoding the registry serves (hex or base58). */
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

/**
 * Is this DID derived from this public key?
 *
 * Runs in the browser, on the visitor's own machine. Nothing displayed by this
 * dashboard was taken on trust from the server that served it.
 */
export function verifyIdBinding(did: string, publicKey: string): boolean {
  const m = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/.exec(did ?? "");
  if (!m) return false;

  const key = decodePublicKey(publicKey);
  if (!key) return false;

  const tag = m[1];
  const body = m[2]!;

  if (body.length === 64) return tag === undefined && body === toHex(key);
  if (body.length !== 8 && body.length !== 10) return false;

  return body === toHex(sha256(key)).slice(0, body.length);
}

/** Human-comparable fingerprint: `a1b2:c3d4:e5f6:0718`. */
export function fingerprint(publicKey: string): string {
  const key = decodePublicKey(publicKey);
  if (!key) return "invalid";
  return toHex(sha256(key)).slice(0, 16).match(/.{1,4}/g)!.join(":");
}

/** Freshness window matching the SDK default. */
export const FRESHNESS_MS = 10 * 60 * 1000;

export function isFresh(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  const t = Date.parse(lastSeen);
  return !Number.isNaN(t) && Date.now() - t < FRESHNESS_MS;
}

// ------------------------------------------------------------------- calls --

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${REGISTRY}${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) },
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to the status-based error below */
  }

  if (!res.ok) {
    const b = (body ?? {}) as { code?: string; error?: string };
    throw new ApiError(res.status, b.code ?? `HTTP_${res.status}`, b.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export interface Audit {
  total: number;
  verified: VerifiedNode[];
  /** Records whose DID does not derive from their key. Should always be empty. */
  rejected: NodeRecord[];
}

/**
 * The live node table, verified in the browser.
 *
 * Failures are returned in `rejected` rather than dropped: on a dashboard, a
 * record that fails id-binding is the single most interesting thing on the page.
 */
export async function fetchNodes(): Promise<Audit> {
  const { nodes } = await call<{ count: number; nodes: NodeRecord[] }>("/nodes");

  const verified: VerifiedNode[] = [];
  const rejected: NodeRecord[] = [];

  for (const n of nodes) {
    if (verifyIdBinding(n.did, n.public_key)) {
      const t = n.last_seen ? Date.parse(n.last_seen) : Number.NaN;
      verified.push({
        ...n,
        verified: true,
        online: isFresh(n.last_seen),
        staleness_ms: Number.isNaN(t) ? null : Date.now() - t,
      });
    } else {
      rejected.push(n);
    }
  }

  return { total: nodes.length, verified, rejected };
}

export async function fetchHealth(): Promise<{ status: string; count: number }> {
  return call("/health");
}

export async function fetchMyNodes(token: string): Promise<{ operator_did: string; nodes: BoundNode[] }> {
  return call("/v1/operator/me/nodes", { headers: { authorization: `Bearer ${token}` } });
}

export async function fetchCredits(token: string): Promise<CreditsBalance> {
  return call("/v1/operator/me/credits", { headers: { authorization: `Bearer ${token}` } });
}
