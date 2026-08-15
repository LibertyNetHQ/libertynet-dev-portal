/**
 * LibertyNet TypeScript SDK.
 *
 * ```ts
 * import { LibertyNet } from "libertynet-sdk";
 *
 * const ln = new LibertyNet();
 * const nodes = await ln.discovery.online();
 * ```
 *
 * Two properties hold across this whole SDK:
 *
 *   1. **Identity verification is not optional.** Every node record you receive
 *      has had its DID checked against its public key. There is no flag to turn
 *      that off, because a client that trusts unverified identities is not a
 *      client worth shipping.
 *
 *   2. **Unbuilt things throw.** Anything not actually wired raises a typed
 *      {@link NotYetWiredError} naming its real status — never a plausible zero
 *      or an empty list that you might mistake for a measurement.
 */

import { Auth } from "./auth.ts";
import { Binding } from "./binding.ts";
import { Discovery } from "./discovery.ts";
import { Http, type HttpOptions, DEFAULT_BASE_URL } from "./http.ts";
import { Operator } from "./operator.ts";
import { Dex, Oracle, Wallet } from "./planned.ts";

export interface LibertyNetOptions extends HttpOptions {}

export class LibertyNet {
  /** Public node discovery. No authentication. */
  readonly discovery: Discovery;
  /** Operator login by signature. */
  readonly auth: Auth;
  /** Operator-scoped reads. Requires a session. */
  readonly operator: Operator;
  /** Node ↔ operator binding, console side. */
  readonly binding: Binding;

  /** Not built. Every method throws {@link NotYetWiredError}. */
  readonly wallet = new Wallet();
  /** Not built. Every method throws {@link NotYetWiredError}. */
  readonly dex = new Dex();
  /** Contracts exist and pass tests, but are not deployed. Every method throws. */
  readonly oracle = new Oracle();

  private readonly http: Http;

  constructor(options: LibertyNetOptions = {}) {
    this.http = new Http(options);
    this.discovery = new Discovery(this.http);
    this.auth = new Auth(this.http);
    this.operator = new Operator(this.http);
    this.binding = new Binding(this.http);
  }

  /** The registry this client talks to. */
  get baseUrl(): string {
    return this.http.baseUrl;
  }
}

export default LibertyNet;

export { DEFAULT_BASE_URL, Http, type HttpOptions } from "./http.ts";
export { Discovery, DEFAULT_FRESHNESS_MS, type OnlineOptions, type AuditResult } from "./discovery.ts";
export {
  Auth,
  canonAuthChallenge,
  canonDeviceCredential,
  issueDeviceCredential,
  validateDeviceCredential,
  rfc3339,
  type DeviceCredential,
  type UnsignedDeviceCredential,
  type LoginOptions,
} from "./auth.ts";
export { Operator } from "./operator.ts";
export { Binding } from "./binding.ts";
export { Wallet, Dex, Oracle } from "./planned.ts";

// LN-CONNECT-001. Not a namespace on `LibertyNet`, because a relying party is not a client of the
// node registry — it talks to a wallet and to a platform gateway, neither of which this class holds
// a connection to. Bundling it under `ln.connect` would have implied a relationship that does not
// exist and a base URL that does not apply.
export {
  RelyingParty,
  Identity,
  AppIdentity,
  SubjectIdentity,
  ConnectError,
  verifyGrant,
  verifyIdBinding as verifyConnectIdBinding,
  deriveDid as deriveConnectDid,
  canonicalize as connectCanonicalize,
  PROTOCOL_VERSION as CONNECT_PROTOCOL_VERSION,
  ISSUABLE_SCOPES,
  RED_LANE_SCOPES,
  GRANT_MAX_LIFETIME_MS,
  type Grant,
  type HeldGrant,
  type AppManifest,
  type WalletConfiguration,
  type IssuableScope,
  type RedLaneScope,
  type RelyingPartyOptions,
  type AuthorizationStart,
  type GrantVerification,
  type VerifyGrantOptions,
} from "./connect.ts";

export {
  parseDid,
  verifyIdBinding,
  assertIdBinding,
  didFromPublicKey,
  decodePublicKey,
  sameIdentity,
  fingerprint,
  type DidForm,
  type ParsedDid,
} from "./did.ts";

export {
  LibertyNetError,
  ApiError,
  AuthError,
  IdentityError,
  NotYetWiredError,
  TransportError,
} from "./errors.ts";

export type {
  CapabilityStatus,
  NodeRecord,
  VerifiedNode,
  BoundNode,
  CreditsBalance,
  CreditsBucket,
  EvidenceList,
  AuthChallenge,
  OperatorSession,
  BindingState,
  BindingStatus,
  BindingRequest,
} from "./types.ts";
export { TERMINAL_BINDING_STATES } from "./types.ts";
