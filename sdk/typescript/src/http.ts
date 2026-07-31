/**
 * HTTP transport.
 *
 * Small on purpose: one fetch wrapper, one error mapping, one retry rule. No
 * interceptor stack, no plugin system — a transport layer you have to learn is a
 * transport layer that hides bugs.
 */

import { ApiError, AuthError, TransportError } from "./errors.ts";

export interface HttpOptions {
  baseUrl?: string;
  /** Per-request timeout. Default 15s. */
  timeoutMs?: number;
  /**
   * Retries for transient failures only — network errors, 429 and 5xx. Never
   * retries a 4xx, because replaying a rejected signature just gets it rejected
   * again more expensively. Default 2.
   */
  retries?: number;
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

export const DEFAULT_BASE_URL = "https://registry.libertynet.ai";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Headers whose values must never be logged or serialised into an error. */
const SECRET_HEADERS = new Set(["authorization", "cookie", "x-api-key"]);

export class Http {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly extraHeaders: Record<string, string>;

  /** Bearer token, held in memory only. Never written to storage by the SDK. */
  private bearer: string | null = null;

  constructor(opts: HttpOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 2;
    this.extraHeaders = opts.headers ?? {};

    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new TransportError(
        "No fetch implementation available. Use Node 20+, or pass one via `fetch`.",
      );
    }
    this.fetchImpl = f;
  }

  /**
   * Store a session token for subsequent requests.
   *
   * In memory, for the life of this object. The SDK deliberately does not persist
   * it: a token on disk is a token in a backup, a crash dump and a log shipper.
   */
  setBearer(token: string | null): void {
    this.bearer = token;
  }

  hasBearer(): boolean {
    return this.bearer !== null;
  }

  async get<T>(path: string, opts: { auth?: boolean } = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, opts);
  }

  async post<T>(path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
    return this.request<T>("POST", path, body, opts);
  }

  /** Raw text response, for endpoints like `/peers` that are not JSON. */
  async getText(path: string): Promise<string> {
    const res = await this.raw("GET", path, undefined, false);
    return res.text();
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    opts: { auth?: boolean },
  ): Promise<T> {
    if (opts.auth && !this.bearer) {
      throw new AuthError(
        "NO_SESSION",
        "This call needs an operator session. Call `auth.login()` first.",
      );
    }

    const res = await this.raw(method, path, body, opts.auth ?? false);
    const text = await res.text();

    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON body from a JSON endpoint is itself the diagnosis.
        if (res.ok) {
          throw new ApiError(res.status, "BAD_RESPONSE", `Expected JSON from ${path}`, text);
        }
      }
    }

    if (!res.ok) throw toApiError(res.status, parsed, path);
    return parsed as T;
  }

  private async raw(
    method: string,
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: "application/json", ...this.extraHeaders };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth && this.bearer) headers["authorization"] = `Bearer ${this.bearer}`;

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter, so a fleet of agents recovering from
        // an outage does not re-create the outage by retrying in lockstep.
        const base = 250 * 2 ** (attempt - 1);
        await sleep(base + Math.random() * base);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const init: RequestInit = { method, headers, signal: controller.signal };
        if (body !== undefined) init.body = JSON.stringify(body);

        const res = await this.fetchImpl(url, init);

        if (RETRYABLE_STATUS.has(res.status) && attempt < this.retries) {
          lastError = new ApiError(res.status, "RETRYING", `HTTP ${res.status}`, null);
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (attempt === this.retries) break;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new TransportError(
      `${method} ${redactUrl(url)} failed after ${this.retries + 1} attempt(s)`,
      lastError,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip anything query-shaped from a URL before it reaches a log line. */
function redactUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : `${url.slice(0, q)}?<redacted>`;
}

function toApiError(status: number, body: unknown, path: string): Error {
  const b = (body ?? {}) as { code?: string; error?: string };
  const code = b.code ?? `HTTP_${status}`;
  const message = b.error ?? `${path} returned HTTP ${status}`;

  if (status === 401 && (code === "NO_SESSION" || code === "SESSION_EXPIRED")) {
    return new AuthError(code, message);
  }
  return new ApiError(status, code, message, body);
}

/** Exported for tests and for anyone auditing what we consider secret. */
export const _internal = { SECRET_HEADERS, redactUrl, toApiError };
