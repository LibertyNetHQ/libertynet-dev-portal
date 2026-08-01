/**
 * Node discovery. Public, unauthenticated.
 *
 * Every method here verifies id-binding before returning a record. There is no
 * option to skip it. If you need the raw unverified table — to audit it, or to
 * count how many records fail — use {@link Discovery.audit}, which is explicit
 * about what it is giving you.
 */

import { assertIdBinding, verifyIdBinding } from "./did.ts";
import type { Http } from "./http.ts";
import type { NodeRecord, VerifiedNode } from "./types.ts";

/** Default freshness window. A node not seen within this is not "online". */
export const DEFAULT_FRESHNESS_MS = 10 * 60 * 1000;

export interface OnlineOptions {
  /** Freshness window in ms. Default 10 minutes. */
  freshnessMs?: number;
  /** Only nodes advertising every one of these capabilities. */
  capabilities?: string[];
  /** Only nodes in this region. */
  region?: string;
  /**
   * Include nodes you cannot actually reach. Default `false`.
   *
   * Most nodes on the network advertise an RFC1918 address or a
   * `node://someones-laptop` label — real to their operator, unreachable from
   * anywhere else. Returning those by default sent people to endpoints that
   * could never answer, which reads as "the SDK is broken" rather than "that
   * node is not for you".
   *
   * Set `true` if you are on the same network as those nodes, or auditing.
   */
  includeUnreachable?: boolean;
}

export interface AuditResult {
  total: number;
  verified: VerifiedNode[];
  /** Records whose DID does not derive from their public key. */
  rejected: NodeRecord[];
}

export class Discovery {
  private readonly http: Http;

  constructor(http: Http) {
    this.http = http;
  }

  /**
   * Every node in the registry whose identity verifies.
   *
   * Records that fail id-binding are dropped, not returned with a flag — a
   * caller who has to remember to check a flag is a caller who will forget. Use
   * {@link audit} if you specifically want to see the failures.
   */
  async all(): Promise<VerifiedNode[]> {
    const { nodes } = await this.http.get<{ count: number; nodes: NodeRecord[] }>("/nodes");
    return nodes.filter((n) => verifyIdBinding(n.did, n.public_key)).map(decorate);
  }

  /**
   * Verified nodes seen recently.
   *
   * `status: "active"` in the raw record does NOT mean online — a node that
   * stopped heart-beating keeps that string forever. Freshness is computed from
   * `last_seen`, which is the only field that can actually go stale.
   */
  async online(opts: OnlineOptions = {}): Promise<VerifiedNode[]> {
    const freshness = opts.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    const wanted = opts.capabilities ?? [];

    return (await this.all()).filter((n) => {
      if (n.staleness_ms === null || n.staleness_ms > freshness) return false;
      if (opts.region && n.region !== opts.region) return false;

      // Older registries do not report reachability. Treat an absent value as
      // "unknown, include it" rather than silently hiding the whole network from
      // anyone pointed at a registry that has not been updated.
      if (!opts.includeUnreachable && n.reachability && n.reachability !== "public") {
        return false;
      }
      return wanted.every((c) => n.capabilities.includes(c));
    });
  }

  /**
   * Nodes you can actually call: verified, fresh, publicly reachable, and
   * carrying a registration signature.
   *
   * This is the honest answer to "who can I send work to right now", and it is
   * usually a much smaller number than `all()`. If it returns nothing, that is
   * a true statement about the network rather than a failure on your side.
   */
  async callable(opts: OnlineOptions = {}): Promise<VerifiedNode[]> {
    const nodes = await this.online({ ...opts, includeUnreachable: false });
    return nodes.filter((n) => n.signature_present !== false && Boolean(n.signature ?? n.signature_present));
  }

  /** Verified, fresh nodes advertising a capability. */
  async byCapability(capability: string, opts: OnlineOptions = {}): Promise<VerifiedNode[]> {
    return this.online({ ...opts, capabilities: [...(opts.capabilities ?? []), capability] });
  }

  /**
   * One node by DID.
   *
   * Matches across both DID encodings: pass either the short `did:svrp:n:<8hex>`
   * or the full `did:svrp:<64hex>` form and you get the same node, because the
   * match is on the underlying key rather than the spelling.
   */
  async get(did: string): Promise<VerifiedNode | null> {
    const nodes = await this.all();
    return nodes.find((n) => n.did === did || verifyIdBinding(did, n.public_key)) ?? null;
  }

  /**
   * The raw table plus the verification verdict for each record.
   *
   * For monitoring and auditing. If `rejected` is ever non-empty on the
   * production registry, that is a finding worth reporting, not a bad record to
   * quietly skip.
   */
  async audit(): Promise<AuditResult> {
    const { nodes } = await this.http.get<{ count: number; nodes: NodeRecord[] }>("/nodes");
    const verified: VerifiedNode[] = [];
    const rejected: NodeRecord[] = [];

    for (const n of nodes) {
      if (verifyIdBinding(n.did, n.public_key)) verified.push(decorate(n));
      else rejected.push(n);
    }
    return { total: nodes.length, verified, rejected };
  }

  /** Registry liveness and the node count it currently holds. */
  async health(): Promise<{ status: string; service: string; count: number }> {
    return this.http.get("/health");
  }

  /**
   * Assert a node's identity, throwing if it does not hold.
   *
   * Call this before trusting anything a node signed — including before verifying
   * that signature. A valid signature over data from an unbound key proves
   * nothing about who sent it.
   */
  assert(did: string, publicKey: string): void {
    assertIdBinding(did, publicKey);
  }
}

function decorate(n: NodeRecord): VerifiedNode {
  const seen = n.last_seen ? Date.parse(n.last_seen) : Number.NaN;
  return {
    ...n,
    verified: true,
    staleness_ms: Number.isNaN(seen) ? null : Date.now() - seen,
  };
}
