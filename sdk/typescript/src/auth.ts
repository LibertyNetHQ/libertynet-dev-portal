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
import { verifyIdBinding } from "./did.ts";
import type { Http } from "./http.ts";
import type { AuthChallenge, OperatorSession } from "./types.ts";

// @noble/ed25519 v2 needs a sync SHA-512 to expose sync sign/verify.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const DOMAIN_AUTH_CHALLENGE = "libertynet-auth-challenge:v1";

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
