/**
 * Error types.
 *
 * Design rule: an SDK error must tell you three things — what happened, why, and
 * what to do about it. Every error here carries a `docs` link to the exact page
 * that explains the fix, because "request failed" is not a diagnosis.
 */

const DOCS = "https://docs.libertynet.ai";

/** Base for every error this SDK raises. Catch this to catch them all. */
export class LibertyNetError extends Error {
  /** Stable machine-readable identifier. Switch on this, never on `message`. */
  readonly code: string;
  /** Page explaining the cause and the fix. */
  readonly docs: string;

  constructor(code: string, message: string, docs = `${DOCS}/reference/errors#${code.toLowerCase()}`) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.docs = docs;
  }

  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}\n  → ${this.docs}`;
  }
}

/** The API returned a non-2xx status. `code` is the API's own error code. */
export class ApiError extends LibertyNetError {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(code, message);
    this.status = status;
    this.body = body;
  }
}

/**
 * An identity failed its id-binding check: the DID does not derive from the
 * public key presented alongside it.
 *
 * This is not a transient failure and must never be retried or ignored. It means
 * the record is either corrupt or forged.
 */
export class IdentityError extends LibertyNetError {
  readonly did: string;

  constructor(did: string, detail: string) {
    super("ID_BINDING_FAILED", `${detail} (did: ${did})`, `${DOCS}/concepts/identity#id-binding`);
    this.did = did;
  }
}

/**
 * You called something that exists as an endpoint but has no data source behind
 * it, or that is not built at all.
 *
 * This error is deliberate. The alternative — returning a plausible-looking zero —
 * would let a `not_yet_wired` balance be rendered to a user as an earning, and
 * that is exactly the kind of quiet dishonesty this SDK refuses to participate in.
 */
export class NotYetWiredError extends LibertyNetError {
  /** `not_yet_wired` (live endpoint, no source) or `planned` (does not exist). */
  readonly level: "not_yet_wired" | "planned" | "testing";

  constructor(what: string, level: "not_yet_wired" | "planned" | "testing", detail: string) {
    super("NOT_YET_WIRED", `${what} is ${level}: ${detail}`, `${DOCS}/status`);
    this.level = level;
  }
}

/** The network call itself failed — DNS, TLS, timeout, offline. */
export class TransportError extends LibertyNetError {
  /** The underlying failure — a DNS error, a TLS error, an AbortError. */
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super("TRANSPORT_ERROR", message, `${DOCS}/reference/errors#transport_error`);
    this.reason = reason;
  }
}

/** You are not logged in, or your session has expired. */
export class AuthError extends LibertyNetError {
  constructor(code: "NO_SESSION" | "SESSION_EXPIRED", message: string) {
    super(code, message, `${DOCS}/guides/operator-login`);
  }
}
