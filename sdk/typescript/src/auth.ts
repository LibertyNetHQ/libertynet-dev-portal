/**
 * Operator login: challenge → device-key signature → 1-hour session.
 *
 * There is no password in this flow, so there is nothing to phish, nothing to
 * stuff and nothing to leak in a breach. The cost is that you hold a key, and
 * this module is careful with it:
 *
 *   · the secret seed is never stored, logged, or attached to an error;
 *   · it is zeroed after use;
 *   · the resulting session token lives in memory only.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { base58 } from "@scure/base";
import { AuthError, LibertyNetError } from "./errors.ts";
import { didFromPublicKey, verifyIdBinding } from "./did.ts";
import type { Http } from "./http.ts";
import type { AuthChallenge, OperatorSession } from "./types.ts";

// @noble/ed25519 v2 needs a sync SHA-512 to expose sync sign/verify.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const DOMAIN_AUTH_CHALLENGE = "libertynet-auth-challenge:v1";
const DOMAIN_DEVICE_CREDENTIAL = "libertynet-operator-device-credential:v1";

/**
 * A DeviceCredential, issued once by the operator's root key.
 *
 * The root key signs this offline and then goes back in the safe. Everything
 * afterwards is done by the device key, so a compromised laptop costs you a
 * device, not your identity.
 */
export interface DeviceCredential {
  credential_id: string;
  operator_did: string;
  operator_root_public_key: string;
  device_id: string;
  device_public_key: string;
  permissions: string[];
  issued_at: string;
  expires_at: string;
  revocation_id: string;
  signature: string;
}

export interface LoginOptions {
  deviceCredential: DeviceCredential;
  /**
   * The 32-byte Ed25519 seed for `deviceCredential.device_public_key`.
   *
   * Read it from your OS keychain or an environment variable at the call site.
   * Never hard-code it, never commit it, never send it anywhere — this SDK does
   * not transmit it and neither should you.
   */
  deviceSecretKey: Uint8Array;
}

export class Auth {
  private readonly http: Http;

  constructor(http: Http) {
    this.http = http;
  }

  /** A single-use challenge with a 300-second life. */
  async challenge(): Promise<AuthChallenge> {
    return this.http.post<AuthChallenge>("/v1/auth/challenge", {});
  }

  /**
   * Log in and store the session on this client.
   *
   * Before signing anything, this checks that the credential's own
   * `operator_root_public_key` really derives `operator_did`. Skipping that check
   * would mean happily signing a challenge for an identity nobody proved they
   * own — a verification bypass, not a shortcut.
   */
  async login(opts: LoginOptions): Promise<OperatorSession> {
    const dc = opts.deviceCredential;

    if (!verifyIdBinding(dc.operator_did, dc.operator_root_public_key)) {
      throw new LibertyNetError(
        "ID_BINDING_FAILED",
        "device_credential.operator_did is not derived from operator_root_public_key. " +
          "Refusing to sign for an identity that has not been proven.",
      );
    }
    const { challenge } = await this.challenge();
    const issuedAt = rfc3339(new Date());

    const message = canonAuthChallenge(
      dc.operator_did,
      dc.device_public_key,
      challenge,
      issuedAt,
    );

    let signature: string;
    try {
      signature = base58.encode(ed.sign(message, opts.deviceSecretKey));
    } finally {
      // The caller may still hold a reference, but ours is gone.
      opts.deviceSecretKey.fill(0);
    }

    const res = await this.http.post<{
      session_token: string;
      operator_did: string;
      expires_in: number;
    }>("/v1/auth/device-login", {
      device_credential: dc,
      challenge,
      issued_at: issuedAt,
      signature,
    });

    this.http.setBearer(res.session_token);

    return { ...res, expires_at: Date.now() + res.expires_in * 1000 };
  }

  /**
   * Attach a session token you obtained elsewhere.
   *
   * Useful when the signing happens in a separate, more protected process. This
   * client then never sees a key at all.
   */
  useSession(token: string): void {
    this.http.setBearer(token);
  }

  /** Drop the session from memory. The server-side session still expires on its own. */
  logout(): void {
    this.http.setBearer(null);
  }

  /** Is a session attached? Does not prove the server still accepts it. */
  isLoggedIn(): boolean {
    return this.http.hasBearer();
  }

  /** Throw a helpful {@link AuthError} if no session is attached. */
  requireSession(): void {
    if (!this.http.hasBearer()) {
      throw new AuthError("NO_SESSION", "Call `auth.login()` or `auth.useSession()` first.");
    }
  }
}

/**
 * Canonical bytes for the login signature.
 *
 * Byte-exact mirror of `svrp_crypto.canon_auth_challenge` (and of
 * `operator-console/lib/crypto/canonical.ts`). The registry rebuilds these bytes
 * and verifies against them, so any drift here produces signatures that verify
 * nowhere. Do not reorder the fields and do not change the domain string.
 */
export function canonAuthChallenge(
  operatorDid: string,
  devicePublicKey: string,
  challenge: string,
  issuedAt: string,
): Uint8Array {
  const joined = [DOMAIN_AUTH_CHALLENGE, operatorDid, devicePublicKey, challenge, issuedAt].join(
    "\n",
  );
  return new TextEncoder().encode(joined);
}

/** RFC3339 UTC to the second, `Z` suffix. The registry rejects other forms. */
export function rfc3339(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/**
 * Canonical bytes for a DeviceCredential.
 *
 * Nine fields, in this order, joined with `\n`. `permissions` is sorted and
 * comma-joined; an absent list is the empty string.
 *
 * Byte-exact mirror of `svrp_crypto.canon_device_credential`. Two of these
 * fields — `device_id` and `revocation_id` — were missing from the published
 * OpenAPI schema, so a credential built from the documentation could not verify
 * against the registry. Nobody noticed for months, because no code in this
 * repository ever built one: the SDK accepted credentials and never issued
 * them, which meant the documentation could say anything at all.
 */
export function canonDeviceCredential(c: UnsignedDeviceCredential): Uint8Array {
  const joined = [
    DOMAIN_DEVICE_CREDENTIAL,
    c.credential_id,
    c.operator_did,
    c.operator_root_public_key,
    c.device_id,
    c.device_public_key,
    [...(c.permissions ?? [])].sort().join(","),
    c.issued_at,
    c.expires_at,
    c.revocation_id,
  ].join("\n");
  return new TextEncoder().encode(joined);
}

/** A DeviceCredential before the root key has signed it. */
export type UnsignedDeviceCredential = Omit<DeviceCredential, "signature">;

/**
 * Issue a DeviceCredential: the one thing the root key ever signs.
 *
 * Runs entirely offline — nothing here touches the network, which is the point.
 * The root key should be somewhere cold, used once, and put back; the device key
 * does everything afterwards, and revoking a device never touches the root
 * identity.
 *
 * The `operator_did` is derived here rather than accepted, because a credential
 * whose DID does not follow from its own root key is not a credential, and
 * letting the caller supply both invites exactly that mismatch.
 */
export function issueDeviceCredential(opts: {
  /** 32-byte Ed25519 seed for the operator root key. Zeroed before returning. */
  rootSecretKey: Uint8Array;
  /** Names the device this credential is for. */
  deviceId: string;
  /** Base58 public key of the device this credential authorises. */
  devicePublicKey: string;
  /** `nodes.bind` is required to bind a node. Defaults to none. */
  permissions?: string[];
  /** How long the credential is valid. Default 90 days. */
  ttlSeconds?: number;
  credentialId?: string;
  revocationId?: string;
  now?: Date;
}): DeviceCredential {
  const rootPublic = ed.getPublicKey(opts.rootSecretKey);
  const rootPublicB58 = base58.encode(rootPublic);
  const operatorDid = didFromPublicKey(rootPublicB58, "o");

  const issued = opts.now ?? new Date();
  const ttl = opts.ttlSeconds ?? 90 * 24 * 60 * 60;

  const unsigned: UnsignedDeviceCredential = {
    credential_id: opts.credentialId ?? `cred-${randomId()}`,
    operator_did: operatorDid,
    operator_root_public_key: rootPublicB58,
    device_id: opts.deviceId,
    device_public_key: opts.devicePublicKey,
    permissions: opts.permissions ?? [],
    issued_at: rfc3339(issued),
    expires_at: rfc3339(new Date(issued.getTime() + ttl * 1000)),
    revocation_id: opts.revocationId ?? `rev-${randomId()}`,
  };

  try {
    return {
      ...unsigned,
      signature: base58.encode(ed.sign(canonDeviceCredential(unsigned), opts.rootSecretKey)),
    };
  } finally {
    opts.rootSecretKey.fill(0);
  }
}

/**
 * Check a credential is well-formed before spending a challenge on it.
 *
 * Returns the problems rather than throwing, so a caller can show all of them.
 * The registry answers a malformed credential with `502` rather than a
 * validation error, so "it broke and I do not know why" is the default
 * experience without this.
 */
export function validateDeviceCredential(dc: Partial<DeviceCredential>): string[] {
  const problems: string[] = [];

  const REQUIRED: (keyof DeviceCredential)[] = [
    "credential_id",
    "operator_did",
    "operator_root_public_key",
    "device_id",
    "device_public_key",
    "issued_at",
    "expires_at",
    "revocation_id",
    "signature",
  ];

  for (const f of REQUIRED) {
    if (dc[f] === undefined || dc[f] === null || dc[f] === "") {
      problems.push(`${String(f)} is missing — the registry signs over it and returns 502 without it`);
    }
  }

  if (dc.operator_did && dc.operator_root_public_key) {
    if (!verifyIdBinding(dc.operator_did, dc.operator_root_public_key)) {
      problems.push("operator_did is not derived from operator_root_public_key");
    }
  }

  if (dc.expires_at && Date.parse(dc.expires_at) < Date.now()) {
    problems.push(`expired at ${dc.expires_at}`);
  }

  for (const f of ["issued_at", "expires_at"] as const) {
    const v = dc[f];
    if (v && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)) {
      problems.push(`${f} must be RFC3339 UTC to the second with a Z suffix, got "${v}"`);
    }
  }

  return problems;
}

function randomId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
