/**
 * LN-CONNECT-001 — make your application a relying party.
 *
 * A LibertyNet wallet holder can authorize your application to read their account and to act for
 * them, without handing you anything you could spend. They approve it in their own wallet; you get
 * back a short-lived **Grant** the wallet signed, which any verifier can check offline.
 *
 * ```ts
 * const app = await AppIdentity.generate();                 // or .fromSeed(seed)
 * const rp  = new RelyingParty({ walletOrigin: "https://wallet.libertynet.ai", app });
 *
 * // 1. Publish this at <your-origin>/.well-known/libertynet-app.json
 * const manifest = await rp.manifest({ name: "My App", redirectUris: ["https://my.app/"] });
 *
 * // 2. Send the person to their wallet
 * const { url, state, subject } = await rp.authorizationUrl({ scopes: ["identity:read"] });
 *
 * // 3. They come back to your redirect_uri with #grant=...&state=...
 * const grant = await rp.acceptCallback(window.location.hash, { state, subject });
 *
 * // 4. Read what you were granted
 * const identity = await rp.read("/connect/resource/identity", { grant, subject });
 * ```
 *
 * # Why this is written from the specification rather than imported
 *
 * This is the protocol's second independent implementation, and that is the point of it. A protocol
 * that only its author's application has ever spoken is indistinguishable, on the evidence, from an
 * interface built for that one application. Sharing a library between the two would have proved
 * that the library is self-consistent — not that the specification is enough to build against.
 *
 * So nothing here is shared with `libertynet-compute` or `libertynet-agent-wallet-ui`. Different
 * repository, different crypto stack (`@noble/ed25519` rather than WebCrypto), different language
 * runtime from the gateway's `ed25519-dalek`. Every byte on the wire had to be agreed by reading
 * the same document. Where it disagreed, the specification was the arbiter and it was the
 * implementation that changed — the protocol has not been modified to admit this client.
 *
 * # Public client by default
 *
 * `confidential` defaults to `false`, which is the honest setting for anything whose code a person
 * can read — a browser bundle, an open-source CLI, an npm package. A public client cannot be
 * silently re-authorized: anyone who read its source could mint a request that looks exactly like
 * the real one, so the wallet insists a human confirms each time. Set it to `true` only if the
 * application's private key genuinely lives somewhere the public cannot reach, such as a server.
 *
 * # What this will never do
 *
 * There is no method here that moves value, and there cannot be: `payment:transfer` and
 * `session:grant` are red-line scopes this version of the protocol does not issue, and asking for
 * one gets a refusal naming it rather than an unknown-scope error. {@link RelyingParty} refuses
 * them locally too, so the round trip is not even attempted.
 */

import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { base58 } from "@scure/base";
import { LibertyNetError } from "./errors.ts";

// @noble/ed25519 v2 needs a sync SHA-512 for its sync entry points, as `auth.ts` also sets up.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export const PROTOCOL_VERSION = "ln-connect/1";

/** Scopes a wallet will issue (spec §4.6). */
export const ISSUABLE_SCOPES = [
  "identity:read",
  "balance:read",
  "activity:read",
  "authorize:compute",
] as const;
export type IssuableScope = (typeof ISSUABLE_SCOPES)[number];

/**
 * Scopes that exist in the protocol and are **not** issued in v1.
 *
 * Named rather than omitted, so asking for one produces "this exists and is refused" instead of
 * "unknown scope" — an unknown-scope error invites the reader to conclude they had the name wrong
 * and try a variant.
 */
export const RED_LANE_SCOPES = ["payment:transfer", "session:grant"] as const;
export type RedLaneScope = (typeof RED_LANE_SCOPES)[number];

/** A grant may not outlive an hour (spec §6.3), and a verifier enforces that itself. */
export const GRANT_MAX_LIFETIME_MS = 60 * 60 * 1000;

/** How long a ConnectRequest stays valid. Kept well under the wallet's ceiling. */
const REQUEST_LIFETIME_MS = 120_000;

export class ConnectError extends LibertyNetError {
  /**
   * The protocol-level reason, matching the failure names in the specification.
   *
   * Switch on this rather than on the message. The two implementations this one interoperates with
   * report their failures in different languages, and a caller that matched on prose would work
   * against one of them and not the other.
   */
  readonly failure: string;
  constructor(failure: string, message: string) {
    super(`CONNECT_${failure.toUpperCase()}`, message);
    this.failure = failure;
  }
}

// ---------------------------------------------------------------------------------------------
// Canonical bytes
// ---------------------------------------------------------------------------------------------

/**
 * Canonical JSON — the exact bytes every signature in this protocol is taken over.
 *
 * Written from the specification's five rules, not ported: keys sorted ascending by code point,
 * integers only, no insignificant whitespace, the escape set below, non-ASCII emitted literally as
 * UTF-8.
 *
 * This is the one place where a disagreement produces no compile error and no clear runtime error —
 * just a signature that mysteriously fails to verify on the other side, on a boundary that names
 * neither the field nor the cause. Two details earn their comments:
 *
 * * **`\b` and `\f` have short escapes.** Writing them as `` and `` is valid JSON and
 *   the wrong bytes. A different canonical string is a different signature.
 * * **Floats are refused, not rounded.** `0.1` has no exact binary form; serialize and re-parse it
 *   and you can get a different bit pattern, which hashes differently, which invalidates a
 *   signature that was perfectly good. Every quantity on this boundary is an integer with an
 *   explicit unit.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new ConnectError(
      "malformed",
      "undefined cannot be signed: JSON.stringify would drop the property, so the verifier " +
        "would canonicalize a document with one fewer field and blame the signature",
    );
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new ConnectError("malformed", `floating-point value ${value} cannot be canonicalized`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new ConnectError(
        "malformed",
        `integer ${value} has already lost precision as a JS number; pass a BigInt`,
      );
    }
    return String(value);
  }
  if (typeof value === "string") return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${canonicalString(k)}:${canonicalize(record[k])}`)
      .join(",")}}`;
  }
  throw new ConnectError("malformed", `cannot canonicalize a ${typeof value}`);
}

function canonicalString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

const encoder = new TextEncoder();

/** The bytes a signature covers: the document with its `signature` property removed. */
function signingBytes(document: Record<string, unknown>): Uint8Array {
  const { signature: _omitted, ...body } = document;
  return encoder.encode(canonicalize(body));
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/**
 * The six DID types of DID-001 §3, and no others.
 *
 * Deliberately stricter than this SDK's own {@link parseDid} in `did.ts`, which also accepts the
 * untagged 64-hex form and whatever role letter the live node registry happens to serve. That
 * leniency is right for reading registry data as it exists; it is wrong here. A wallet identified
 * as `did:svrp:o:f39Fd6e5` — which the DID registry does contain — derives from nothing and cannot
 * be checked by anyone, and accepting one would make every verification below decorative.
 */
const DID_TYPES = ["h", "a", "d", "r", "n", "s"] as const;
export type DidType = (typeof DID_TYPES)[number];

const DID_RE = /^did:svrp:([hadrns]):([0-9a-f]{8}|[0-9a-f]{10})$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive a DID from a raw Ed25519 public key.
 *
 * `HEX(SHA256(key)[0..4])`, or the 10-hex `[0..5]` collision fallback. Both lengths are legal and a
 * verifier must accept either — hard-coding only the 4-byte form is a bug that lies dormant until
 * the day two keys collide.
 */
export function deriveDid(type: DidType, publicKey: Uint8Array, collisionFallback = false): string {
  const digest = sha256(publicKey);
  return `did:svrp:${type}:${toHex(digest.slice(0, collisionFallback ? 5 : 4))}`;
}

/**
 * Step 1 of every verification: does this key actually derive this DID?
 *
 * This performs no signature check. It is the precondition for one, not a substitute. Skip it and
 * anyone can sign as anyone: they present their own key, their own valid signature, and someone
 * else's DID — and the signature checks out, because it was never asked whose key it was. **A valid
 * signature is not a valid identity.**
 */
export function verifyIdBinding(did: string, publicKeyBase58: string): boolean {
  const match = DID_RE.exec(did);
  if (!match) return false;
  let key: Uint8Array;
  try {
    key = base58.decode(publicKeyBase58);
  } catch {
    return false;
  }
  if (key.length !== 32) return false;
  const id = match[2]!;
  return id === toHex(sha256(key).slice(0, id.length === 10 ? 5 : 4));
}

/** Steps 1 and 2, in the order the specification fixes and callers may not reorder. */
async function verifySignedDocument(
  did: string,
  publicKeyBase58: string,
  document: Record<string, unknown>,
  signatureHex: string,
): Promise<{ ok: true } | { ok: false; failure: "id_binding_failed" | "signature_invalid" }> {
  if (!verifyIdBinding(did, publicKeyBase58)) return { ok: false, failure: "id_binding_failed" };
  try {
    const ok = await ed.verifyAsync(
      signatureHex,
      signingBytes(document),
      base58.decode(publicKeyBase58),
    );
    return ok ? { ok: true } : { ok: false, failure: "signature_invalid" };
  } catch {
    return { ok: false, failure: "signature_invalid" };
  }
}

/**
 * A keypair with a DID derived from it.
 *
 * Used for both identities an application holds: its own long-lived `did:svrp:s:` service identity,
 * and the short-lived subject identity a grant is bound to.
 */
export class Identity {
  readonly did: string;
  readonly publicKey: Uint8Array;
  readonly publicKeyBase58: string;
  /** Kept private and never serialized. There is deliberately no accessor. */
  readonly #seed: Uint8Array;

  private constructor(type: DidType, seed: Uint8Array, publicKey: Uint8Array) {
    this.#seed = seed;
    this.publicKey = publicKey;
    this.publicKeyBase58 = base58.encode(publicKey);
    this.did = deriveDid(type, publicKey);
  }

  static async fromSeed(type: DidType, seed: Uint8Array): Promise<Identity> {
    if (seed.length !== 32) {
      throw new ConnectError("malformed", `an Ed25519 seed is 32 bytes, got ${seed.length}`);
    }
    return new Identity(type, seed, await ed.getPublicKeyAsync(seed));
  }

  static async generate(type: DidType): Promise<Identity> {
    return Identity.fromSeed(type, ed.utils.randomPrivateKey());
  }

  /** Sign a document's canonical bytes, returning hex. The `signature` property is excluded. */
  async sign(document: Record<string, unknown>): Promise<string> {
    return toHex(await ed.signAsync(signingBytes(document), this.#seed));
  }

  /** The document with its signature attached — what actually goes on the wire. */
  async signed<T extends Record<string, unknown>>(document: T): Promise<T & { signature: string }> {
    return { ...document, signature: await this.sign(document) };
  }

  /** Redacted, so a log line that formats this object cannot leak the seed. */
  toJSON(): Record<string, string> {
    return { did: this.did, public_key: this.publicKeyBase58, seed: "<redacted>" };
  }
}

/** An application's own service identity. `did:svrp:s:` — DID-001's Service type. */
export const AppIdentity = {
  generate: () => Identity.generate("s"),
  fromSeed: (seed: Uint8Array) => Identity.fromSeed("s", seed),
};

/**
 * The identity a grant is bound to.
 *
 * Short-lived on purpose. Generate one per session and throw it away: the grant is useless without
 * it, so a discarded subject key is a revoked authorization that needed no network call.
 */
export const SubjectIdentity = {
  generate: () => Identity.generate("a"),
  fromSeed: (seed: Uint8Array) => Identity.fromSeed("a", seed),
};

// ---------------------------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------------------------

export interface WalletConfiguration {
  readonly protocol: string;
  readonly issuer_did: string;
  readonly issuer_public_key: string;
  readonly authorization_endpoint: string;
  readonly scopes_supported?: readonly string[];
  readonly [key: string]: unknown;
}

export interface AppManifest {
  readonly protocol: string;
  readonly app_did: string;
  readonly app_public_key: string;
  readonly name: string;
  readonly logo_uri?: string;
  readonly redirect_uris: readonly string[];
  readonly scopes_requested: readonly string[];
  readonly confidential: boolean;
  readonly signature: string;
}

export interface Grant {
  readonly protocol: string;
  readonly grant_id: string;
  readonly issuer_did: string;
  readonly issuer_public_key: string;
  readonly audience_did: string;
  readonly subject_did: string;
  readonly subject_public_key: string;
  readonly scopes: readonly string[];
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
  readonly revocation_uri?: string;
  readonly signature: string;
  readonly [key: string]: unknown;
}

/** A grant plus the exact encoded form it arrived in — the form that must be re-sent verbatim. */
export interface HeldGrant {
  readonly grant: Grant;
  readonly encoded: string;
}

// ---------------------------------------------------------------------------------------------
// base64url documents
// ---------------------------------------------------------------------------------------------

function encodeDocument(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Decode a base64url document.
 *
 * The cap is not decoration: these arrive in a URL fragment and an HTTP header, both attacker
 * controlled, and both are parsed before anything about the sender has been established.
 */
function decodeDocument<T>(text: string, maxBytes = 16 * 1024): T {
  if (text.length > maxBytes) {
    throw new ConnectError("malformed", `encoded document is ${text.length} bytes, over the cap`);
  }
  return JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as T;
}

// ---------------------------------------------------------------------------------------------
// Grant verification — spec §4.4
// ---------------------------------------------------------------------------------------------

export interface VerifyGrantOptions {
  /**
   * The wallet this verifier chose to trust, pinned.
   *
   * Without it the whole check is hollow. The signature only proves the document was signed by
   * whoever `issuer_did` names, and a DID is self-certifying and free to mint — anyone can stand up
   * a wallet, name themselves, and sign a grant in which every single field verifies.
   */
  readonly expectedIssuerDid: string;
  /**
   * This verifier's own DID, or `null` when the audience is not what authorizes the call.
   *
   * A relying party passes its own: a grant issued to a different application must not work here. A
   * *resource server* passes `null`, because it authenticates the caller by the subject key and has
   * no way to prove which application is in front of it. Writing `audienceDid: grant.audience_did`
   * to fill the slot would be a check that cannot fail — worse than an absent one, because it reads
   * as protection in every review that follows.
   */
  readonly audienceDid: string | null;
  /** The public key on the envelope the presenter signed. Step 4 compares against this. */
  readonly presentedSubjectPublicKey: string;
  readonly requiredScope: string;
  readonly nowMs: number;
  /** Only when the caller chose to look it up (spec §6.3). */
  readonly revoked?: boolean;
}

export type GrantVerification =
  | { readonly ok: true; readonly grant: Grant }
  | { readonly ok: false; readonly failure: string; readonly reason: string };

/**
 * The seven steps, in the order the specification fixes.
 *
 * **Step 4 is the design.** `subject_public_key` must equal the key of whoever is presenting the
 * grant. That is what makes it not a bearer token: possession is useless without the matching
 * private key, which is why a grant can travel in a URL fragment and be written to a log without
 * either being a credential leak. Omit step 4 and this is OAuth with extra steps.
 */
export async function verifyGrant(
  grant: Grant,
  options: VerifyGrantOptions,
): Promise<GrantVerification> {
  const no = (failure: string, reason: string): GrantVerification => ({ ok: false, failure, reason });

  if (!grant || typeof grant !== "object") return no("malformed", "grant is not an object");
  if (grant.protocol !== PROTOCOL_VERSION) {
    return no("wrong_protocol", `protocol is ${String(grant.protocol)}`);
  }
  for (const field of [
    "grant_id",
    "issuer_did",
    "issuer_public_key",
    "audience_did",
    "subject_did",
    "subject_public_key",
    "signature",
  ] as const) {
    if (typeof grant[field] !== "string" || (grant[field] as string).length === 0) {
      return no("malformed", `missing or non-string field: ${field}`);
    }
  }
  if (!Array.isArray(grant.scopes)) return no("malformed", "scopes must be an array");

  // Steps 1 and 2.
  const verified = await verifySignedDocument(
    grant.issuer_did,
    grant.issuer_public_key,
    grant as unknown as Record<string, unknown>,
    grant.signature,
  );
  if (!verified.ok) {
    return verified.failure === "id_binding_failed"
      ? no("id_binding_failed", "issuer_public_key does not derive issuer_did")
      : no("signature_invalid", "the issuer's Ed25519 signature does not verify");
  }
  if (grant.issuer_did !== options.expectedIssuerDid) {
    return no(
      "wrong_issuer",
      `issued by ${grant.issuer_did}, but this party trusts ${options.expectedIssuerDid}`,
    );
  }

  // Step 3.
  if (!Number.isSafeInteger(grant.issued_at_ms) || !Number.isSafeInteger(grant.expires_at_ms)) {
    return no("malformed", "timestamps must be integer milliseconds");
  }
  if (grant.expires_at_ms <= options.nowMs) return no("expired", "the grant has expired");
  if (grant.issued_at_ms > options.nowMs + 60_000) {
    return no("not_yet_valid", "issued_at_ms is in the future");
  }
  // Enforced here, not merely by the issuer: a signed document cannot be un-signed, so its lifetime
  // is the only bound on what a leaked-and-usable grant could do. If only wallets enforced this,
  // one careless wallet would set the ceiling for every relying party that honours its grants.
  if (grant.expires_at_ms - grant.issued_at_ms > GRANT_MAX_LIFETIME_MS) {
    return no("lifetime_too_long", `a grant may not outlive ${GRANT_MAX_LIFETIME_MS / 1000}s`);
  }
  if (options.audienceDid !== null && grant.audience_did !== options.audienceDid) {
    return no("wrong_audience", `issued to ${grant.audience_did}, not ${options.audienceDid}`);
  }

  // Step 4.
  if (grant.subject_public_key !== options.presentedSubjectPublicKey) {
    return no(
      "subject_mismatch",
      "the key presenting this grant is not the key it is bound to — holding it is not using it",
    );
  }

  // Step 5.
  if (!grant.scopes.includes(options.requiredScope)) {
    return no(
      "scope_not_granted",
      `this needs ${options.requiredScope}; the grant carries [${grant.scopes.join(", ")}]`,
    );
  }

  // Step 6, when the caller looked it up.
  if (options.revoked === true) return no("revoked", "the wallet reports this grant as revoked");

  return { ok: true, grant };
}

// ---------------------------------------------------------------------------------------------
// The relying party
// ---------------------------------------------------------------------------------------------

export interface RelyingPartyOptions {
  /** Origin of the wallet, e.g. `https://wallet.libertynet.ai`. */
  readonly walletOrigin: string;
  /** This application's service identity. */
  readonly app: Identity;
  /**
   * Whether this application's private key is genuinely unreachable by the public.
   *
   * `false` — the default, and the honest answer for a browser bundle, a CLI, or anything published
   * as source. A public client is refused `prompt=none`, because anyone who read its code could
   * mint a request indistinguishable from a real one.
   */
  readonly confidential?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export interface AuthorizationStart {
  /** Send the person here. */
  readonly url: string;
  /** Your own CSRF value. Check it when they come back; do not skip this. */
  readonly state: string;
  /** The identity the grant will be bound to. Keep it, or the grant is worthless. */
  readonly subject: Identity;
  readonly encodedRequest: string;
}

export class RelyingParty {
  readonly walletOrigin: string;
  readonly app: Identity;
  readonly confidential: boolean;
  readonly #fetch: typeof fetch;
  #configuration: WalletConfiguration | null = null;

  constructor(options: RelyingPartyOptions) {
    this.walletOrigin = options.walletOrigin.replace(/\/+$/, "");
    this.app = options.app;
    this.confidential = options.confidential ?? false;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /**
   * Read the wallet's self-description.
   *
   * Fetched rather than configured. The only thing an application hard-codes is *which origin* to
   * ask; the issuer DID and the endpoints come from the wallet, so a wallet that rotates its
   * identity or moves an endpoint does not require every relying party to ship a release.
   *
   * The issuer's key must derive its DID before anything else here is believed. Failing that check
   * at discovery is far more legible than failing it three steps later inside a signature check —
   * and it is the check a `did:svrp:o:…` wallet does not pass.
   */
  async discover(): Promise<WalletConfiguration> {
    if (this.#configuration) return this.#configuration;
    const response = await this.#fetch(`${this.walletOrigin}/.well-known/ln-connect-configuration`);
    if (response.status === 503) {
      const body = (await response.json().catch(() => ({}))) as { reason?: string };
      throw new ConnectError(
        "unconfigured",
        body.reason ?? "the wallet has not finished configuring itself",
      );
    }
    if (!response.ok) {
      throw new ConnectError("unreachable", `the wallet answered ${response.status}`);
    }
    const config = (await response.json()) as WalletConfiguration;
    if (!verifyIdBinding(config.issuer_did, config.issuer_public_key)) {
      throw new ConnectError(
        "id_binding_failed",
        `the wallet's published key does not derive its DID (${config.issuer_did})`,
      );
    }
    this.#configuration = config;
    return config;
  }

  /**
   * Build this application's signed manifest.
   *
   * Serve it at `<origin>/<base path>/.well-known/libertynet-app.json`. It is what gives the
   * application authority to receive a grant at a URL: the identity is self-derived and therefore
   * proves nothing on its own, so the authority comes from the manifest being served by the
   * redirect's own origin. Impersonating an application needs both its key and its domain.
   */
  async manifest(options: {
    name: string;
    redirectUris: readonly string[];
    scopes?: readonly IssuableScope[];
    logoUri?: string;
  }): Promise<AppManifest> {
    const scopes = options.scopes ?? (["identity:read"] as const);
    assertNoRedLaneScopes(scopes);
    const body = {
      protocol: PROTOCOL_VERSION,
      app_did: this.app.did,
      app_public_key: this.app.publicKeyBase58,
      name: options.name,
      ...(options.logoUri ? { logo_uri: options.logoUri } : {}),
      redirect_uris: [...options.redirectUris],
      scopes_requested: [...scopes],
      confidential: this.confidential,
    };
    return (await this.app.signed(body)) as unknown as AppManifest;
  }

  /**
   * Begin an authorization.
   *
   * A fresh subject key each time, unless one is supplied. Reusing one across authorizations would
   * make an old grant keep working after the person thought they had walked away from it.
   */
  async authorizationUrl(options: {
    scopes: readonly IssuableScope[];
    redirectUri: string;
    subject?: Identity;
    /** `none` asks for a silent renewal. A public client is refused it — see the class docs. */
    prompt?: "consent" | "none";
    state?: string;
  }): Promise<AuthorizationStart> {
    assertNoRedLaneScopes(options.scopes);
    if (options.prompt === "none" && !this.confidential) {
      throw new ConnectError(
        "silent_renewal_not_allowed",
        "a public client cannot be silently re-authorized: anyone who read this application's " +
          "code could mint a request indistinguishable from a real one, so the wallet requires a " +
          "human each time. Set `confidential: true` only if the key is genuinely off the client.",
      );
    }
    const config = await this.discover();
    const subject = options.subject ?? (await SubjectIdentity.generate());
    const state = options.state ?? crypto.randomUUID();
    const now = Date.now();

    const request = await this.app.signed({
      protocol: PROTOCOL_VERSION,
      app_did: this.app.did,
      app_public_key: this.app.publicKeyBase58,
      subject_did: subject.did,
      subject_public_key: subject.publicKeyBase58,
      scopes: [...options.scopes],
      redirect_uri: options.redirectUri,
      state,
      nonce: crypto.randomUUID(),
      issued_at_ms: now,
      expires_at_ms: now + REQUEST_LIFETIME_MS,
      prompt: options.prompt ?? "consent",
    });

    const encodedRequest = encodeDocument(request);
    return {
      url: `${config.authorization_endpoint}?request=${encodeURIComponent(encodedRequest)}`,
      state,
      subject,
      encodedRequest,
    };
  }

  /**
   * Take the wallet's answer out of the redirect fragment and verify it.
   *
   * Verified rather than trusted because it arrived from the wallet's own redirect, and a redirect
   * is not authentication — everything that makes this grant mean anything is in the signature.
   */
  async acceptCallback(
    fragment: string,
    options: { state: string; subject: Identity; requiredScope?: IssuableScope },
  ): Promise<HeldGrant> {
    const params = new URLSearchParams(fragment.replace(/^#/, ""));
    const error = params.get("error");
    if (error) throw new ConnectError(error, describeError(error));

    // The application's own CSRF check: it proves this answer belongs to the authorization *this
    // process* started, not one an attacker started and sent someone here to finish.
    if (params.get("state") !== options.state) {
      throw new ConnectError("state_mismatch", "this answer belongs to a different authorization");
    }
    const encoded = params.get("grant");
    if (!encoded) throw new ConnectError("malformed", "no grant in the redirect fragment");

    const grant = decodeDocument<Grant>(encoded);
    const config = await this.discover();
    const verification = await verifyGrant(grant, {
      expectedIssuerDid: config.issuer_did,
      audienceDid: this.app.did,
      presentedSubjectPublicKey: options.subject.publicKeyBase58,
      requiredScope: options.requiredScope ?? grant.scopes[0] ?? "identity:read",
      nowMs: Date.now(),
    });
    if (!verification.ok) {
      throw new ConnectError(verification.failure, verification.reason);
    }
    return { grant, encoded };
  }

  /**
   * Read a protected resource.
   *
   * Two headers: the grant, and an envelope signed by the subject key proving this caller holds it.
   * `resource` is *inside* the signed bytes — without it, an envelope signed for one endpoint could
   * be replayed against another and the signature would verify, because it never said which.
   */
  async read<T = unknown>(
    resource: string,
    options: { held: HeldGrant; subject: Identity },
  ): Promise<T> {
    const envelope = await options.subject.signed({
      protocol: PROTOCOL_VERSION,
      resource,
      grant_id: options.held.grant.grant_id,
      subject_did: options.subject.did,
      subject_public_key: options.subject.publicKeyBase58,
      nonce: crypto.randomUUID(),
      timestamp_ms: Date.now(),
    });

    const response = await this.#fetch(`${this.walletOrigin}${resource}`, {
      headers: {
        "x-ln-grant": options.held.encoded,
        "x-ln-envelope": encodeDocument(envelope),
      },
    });
    if (response.status === 401 || response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as { reason?: string };
      // A state, not a failure: the fix is to authorize again rather than to retry. Reporting it as
      // an error would send someone to check their connection when nothing is wrong with it.
      throw new ConnectError("unauthorized", body.reason ?? "this authorization is not valid");
    }
    if (!response.ok) {
      throw new ConnectError("error", `the wallet answered ${response.status}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Ask the wallet whether a grant is still live (spec §6.3).
   *
   * Unauthenticated by design: it exposes a status and nothing else. Optional by design too — the
   * caller decides, because the cost of being wrong differs enormously between a balance read and
   * an authorization, and baking one answer in here would apply it to both.
   */
  async revocationStatus(held: HeldGrant): Promise<string> {
    const uri = held.grant.revocation_uri;
    if (!uri) return "unknown";
    const response = await this.#fetch(uri);
    if (!response.ok) return "unknown";
    const body = (await response.json()) as { status?: string };
    return body.status ?? "unknown";
  }

  /**
   * The header a platform gateway expects when this grant accompanies a call (spec §6.3).
   *
   * Named as a method rather than left to each caller to remember, because "which header, and in
   * which encoding" is exactly the kind of detail that gets re-derived slightly differently in a
   * second place and then fails as an unexplained `not_authorized`.
   */
  static grantHeaders(held: HeldGrant): Record<string, string> {
    return { "x-ln-grant": held.encoded };
  }
}

function assertNoRedLaneScopes(scopes: readonly string[]): void {
  for (const scope of scopes) {
    if ((RED_LANE_SCOPES as readonly string[]).includes(scope)) {
      throw new ConnectError(
        "refused_scope",
        `${scope} is a red-line scope this version of the protocol does not issue. It is named ` +
          "rather than unknown so nobody concludes they had the spelling wrong. Opening it is a " +
          "governance decision, not a client-side one.",
      );
    }
  }
}

function describeError(code: string): string {
  switch (code) {
    case "access_denied":
      return "the authorization was declined in the wallet";
    case "consent_required":
      return "the wallet needs the account holder to approve this before it can be renewed";
    default:
      return "the wallet refused the request";
  }
}
