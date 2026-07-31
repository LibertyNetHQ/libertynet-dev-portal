/**
 * Session handling.
 *
 * The one rule this file exists to enforce: **the session token never leaves
 * memory.** Not `localStorage`, not `sessionStorage`, not a cookie, not the URL.
 *
 * The cost is that a refresh logs you out. That is the correct trade for a
 * bearer token: anything persisted is readable by every script on the origin and
 * survives in profile backups, and a one-hour token is not worth that exposure.
 * If you want to stay logged in, sign in again — it takes one click and a key you
 * already hold.
 */

"use client";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { base58 } from "@scure/base";

import { REGISTRY, verifyIdBinding } from "./libertynet";

// @noble/ed25519 v2 needs a sync SHA-512 for sync signing.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const DOMAIN_AUTH_CHALLENGE = "libertynet-auth-challenge:v1";

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

export interface Session {
  token: string;
  operatorDid: string;
  /** Epoch ms. Sessions last one hour and cannot be refreshed. */
  expiresAt: number;
}

export class LoginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

/**
 * Client-side attempt limiting.
 *
 * There is no password here, so this is not anti-stuffing — it is a guard against
 * a broken loop hammering the registry, and against a user repeatedly signing
 * with a key that is simply wrong. The registry does its own limiting; this just
 * keeps an obvious mistake cheap.
 */
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;

let attempts: number[] = [];

export function attemptsRemaining(): number {
  const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
  attempts = attempts.filter((t) => t > cutoff);
  return Math.max(0, MAX_ATTEMPTS - attempts.length);
}

/** RFC3339 UTC, second precision, `Z`. Other forms are rejected by the registry. */
export function rfc3339(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/**
 * Canonical bytes for the login signature.
 *
 * Byte-exact mirror of `svrp_crypto.canon_auth_challenge`. The registry rebuilds
 * these and verifies against them, so any drift produces signatures that verify
 * nowhere. Do not reorder; do not change the domain string.
 */
export function canonAuthChallenge(
  operatorDid: string,
  devicePublicKey: string,
  challenge: string,
  issuedAt: string,
): Uint8Array {
  return new TextEncoder().encode(
    [DOMAIN_AUTH_CHALLENGE, operatorDid, devicePublicKey, challenge, issuedAt].join("\n"),
  );
}

/**
 * Sign a challenge and exchange it for a session.
 *
 * `deviceSecretKey` is used once and zeroed. It is never transmitted, never
 * stored, and never included in an error — a key in a stack trace is a key in
 * your error reporter.
 */
export async function login(
  credential: DeviceCredential,
  deviceSecretKey: Uint8Array,
): Promise<Session> {
  if (attemptsRemaining() === 0) {
    throw new LoginError(
      "RATE_LIMITED",
      "Too many attempts. Wait a few minutes — repeating a wrong key will not make it right.",
    );
  }
  attempts.push(Date.now());

  try {
    // Before signing anything: does this credential's own root key actually
    // derive the operator identity it claims? Signing for an unproven identity
    // is a verification bypass, not a shortcut.
    if (!verifyIdBinding(credential.operator_did, credential.operator_root_public_key)) {
      throw new LoginError(
        "ID_BINDING_FAILED",
        "This credential's operator_did is not derived from its root public key. " +
          "Refusing to sign for an identity that has not been proven.",
      );
    }

    const challengeRes = await fetch(`${REGISTRY}/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!challengeRes.ok) {
      throw new LoginError("CHALLENGE_FAILED", `Could not get a challenge (HTTP ${challengeRes.status}).`);
    }
    const { challenge } = (await challengeRes.json()) as { challenge: string };

    const issuedAt = rfc3339(new Date());
    const message = canonAuthChallenge(
      credential.operator_did,
      credential.device_public_key,
      challenge,
      issuedAt,
    );

    const signature = base58.encode(ed.sign(message, deviceSecretKey));

    const res = await fetch(`${REGISTRY}/v1/auth/device-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_credential: credential,
        challenge,
        issued_at: issuedAt,
        signature,
      }),
    });

    const body = (await res.json()) as {
      code?: string;
      error?: string;
      session_token?: string;
      operator_did?: string;
      expires_in?: number;
    };

    if (!res.ok || !body.session_token) {
      throw new LoginError(body.code ?? `HTTP_${res.status}`, body.error ?? "Login failed.");
    }

    attempts = []; // success clears the counter

    return {
      token: body.session_token,
      operatorDid: body.operator_did!,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
  } finally {
    // Our copy is gone whether we succeeded or not.
    deviceSecretKey.fill(0);
  }
}

export function isExpired(session: Session | null): boolean {
  return !session || Date.now() >= session.expiresAt;
}

export function minutesRemaining(session: Session): number {
  return Math.max(0, Math.round((session.expiresAt - Date.now()) / 60_000));
}
