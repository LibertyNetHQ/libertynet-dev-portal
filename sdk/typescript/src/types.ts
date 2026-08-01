/** Wire types. These mirror `dev-portal/api-spec/libertynet-v1.yaml` exactly. */

/** Publication status of a capability. See {@link https://docs.libertynet.ai/status}. */
export type CapabilityStatus = "implemented" | "not_yet_wired" | "testing" | "planned";

/** A node as the registry stores it. */
export interface NodeRecord {
  did: string;
  public_key: string;
  endpoint: string | null;
  capabilities: string[];
  region: string | null;
  status: string | null;
  last_seen: string | null;
  first_seen: string | null;
  signature: string | null;
  /** Computed by the registry. Absent on older registry versions. */
  reachability?: Reachability;
  /** Whether the record carries a registration signature at all. */
  signature_present?: boolean;
}

/**
 * A node record that has passed id-binding verification.
 *
 * The type exists so "verified" is visible in your editor, not just in a comment.
 * The SDK never hands you an unverified record typed as this.
 */
export interface VerifiedNode extends NodeRecord {
  /** Always `true` — the SDK drops or throws on anything that fails. */
  readonly verified: true;
  /** Milliseconds since `last_seen`, or `null` if the node never reported one. */
  readonly staleness_ms: number | null;
}

/** A node bound to an operator, as returned by `GET /v1/operator/me/nodes`. */
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

export interface CreditsBucket {
  amount: number;
  meaning: string;
}

/**
 * Credits balance envelope.
 *
 * Read `source` before you read any amount. When it is `not_yet_wired`, every
 * amount is a placeholder zero rather than a measurement, and rendering it as a
 * balance would be a lie told through a number.
 */
export interface CreditsBalance {
  operator_did: string;
  /** Always `test-credit`. Not cash. Not redeemable. Not a future claim. */
  unit: string;
  disclaimer?: string;
  settled: CreditsBucket;
  pending: CreditsBucket;
  estimated: CreditsBucket;
  source: "not_yet_wired" | "ledger";
}

export interface EvidenceList {
  operator_did: string;
  count: number;
  evidence: unknown[];
  source: "not_yet_wired" | "ledger";
  note?: string;
}

export interface AuthChallenge {
  challenge: string;
  expires_in: number;
}

export interface OperatorSession {
  session_token: string;
  operator_did: string;
  expires_in: number;
  /** Epoch ms when this session stops working. Computed client-side. */
  expires_at: number;
}

export type BindingState =
  | "INITIATED"
  | "PENDING_OPERATOR"
  | "PENDING_NODE_ACCEPTANCE"
  | "VERIFYING"
  | "ACTIVE"
  | "EXPIRED"
  | "REJECTED_BY_OPERATOR"
  | "REJECTED_BY_NODE"
  | "CANCELLED";

/** States a session can never leave. */
export const TERMINAL_BINDING_STATES: readonly BindingState[] = [
  "ACTIVE",
  "EXPIRED",
  "REJECTED_BY_OPERATOR",
  "REJECTED_BY_NODE",
  "CANCELLED",
];

export interface BindingStatus {
  binding_session_id: string;
  state: BindingState;
  node_did: string;
  operator_did: string | null;
  expires_at: string;
}

export interface BindingRequest {
  binding_session_id: string;
  state: BindingState;
  node_did: string;
  node_public_key: string;
  node_signature: string;
  device_summary: string | null;
  os: string | null;
  region: string | null;
  /** `a1b2:c3d4:e5f6:0718` — show this to a human to compare out-of-band. */
  node_public_key_fingerprint: string;
  requested: {
    task_types: string[];
    single_limit: number | null;
    daily_limit: number | null;
  };
  nonce: string;
  expires_at: string;
}

/**
 * How reachable a node is, computed by the registry at read time.
 *
 * `public` — a routable address or hostname. You can try to reach it.
 * `private` — RFC1918 or loopback. Real to its operator, useless to you.
 * `unroutable` — a `node://hostname` label with no dialable address.
 *
 * Most nodes on the network today are not `public`. That is a fact about the
 * network's current state, not a bug in your code.
 */
export type Reachability = "public" | "private" | "unroutable";
