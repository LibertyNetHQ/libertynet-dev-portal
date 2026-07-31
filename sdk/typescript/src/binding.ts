/**
 * Node ↔ operator binding, console side.
 *
 * Scope note, deliberately narrow: this module implements the steps that need no
 * signing — resolve, poll, cancel. The signing steps (`initiate`, `authorize`,
 * `accept`) are NOT reimplemented here.
 *
 * That is not laziness. Those steps sign canonical bytes whose layout must match
 * the registry's reconstruction exactly, down to Python's `str()` rendering of
 * booleans as `True`/`False`. A near-miss does not fail loudly; it produces a
 * signature that verifies nowhere, and the error surfaces three hops away from
 * its cause. The two audited implementations that already exist —
 * `operator-console/lib/crypto/canonical.ts` and `ln-node bind` — are the ones to
 * use. {@link Binding.authorize} points you at them instead of guessing.
 */

import { NotYetWiredError } from "./errors.ts";
import { fingerprint } from "./did.ts";
import type { Http } from "./http.ts";
import type { BindingRequest, BindingStatus } from "./types.ts";
import { TERMINAL_BINDING_STATES } from "./types.ts";

export class Binding {
  private readonly http: Http;

  constructor(http: Http) {
    this.http = http;
  }

  /**
   * Redeem a short code (or token) and see what the node is asking for.
   *
   * Show `node_public_key_fingerprint` to the human and have them compare it
   * against the node's own screen before authorizing. That out-of-band comparison
   * is what stops someone from binding a node they do not control.
   *
   * Anti-enumeration is deliberate: five failures on a code within ten minutes
   * gets you a `429`, and invalid / expired / already-used all return the same
   * `404`, so the endpoint cannot be used to hunt for live codes.
   */
  async resolve(input: { shortCode?: string; bindingToken?: string }): Promise<BindingRequest> {
    if (!input.shortCode && !input.bindingToken) {
      throw new TypeError("resolve() needs either shortCode or bindingToken");
    }
    return this.http.post<BindingRequest>("/v1/bindings/resolve", {
      short_code: input.shortCode,
      binding_token: input.bindingToken,
    });
  }

  /** Current state of a session. */
  async status(bindingSessionId: string): Promise<BindingStatus> {
    return this.http.get(`/v1/bindings/${encodeURIComponent(bindingSessionId)}/status`);
  }

  /** Abort a session. Invalidates its code and token immediately. */
  async cancel(bindingSessionId: string): Promise<BindingStatus> {
    return this.http.post(`/v1/bindings/${encodeURIComponent(bindingSessionId)}/cancel`);
  }

  /**
   * Poll until the session reaches a terminal state or the deadline passes.
   *
   * Polls every `intervalMs` (default 2s) up to `timeoutMs` (default 10 minutes,
   * matching the protocol's own session TTL — polling longer than the session can
   * live is just burning requests).
   */
  async waitForTerminal(
    bindingSessionId: string,
    opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<BindingStatus> {
    const interval = opts.intervalMs ?? 2_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000);

    for (;;) {
      const s = await this.status(bindingSessionId);
      if (TERMINAL_BINDING_STATES.includes(s.state)) return s;

      if (Date.now() + interval > deadline) return s;
      if (opts.signal?.aborted) return s;

      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /** Human-comparable fingerprint of a node key. Re-exported for convenience. */
  fingerprint(publicKey: string): string {
    return fingerprint(publicKey);
  }

  /**
   * Not implemented here, on purpose.
   *
   * Authorizing requires signing an AuthorizationCredential with your device key
   * over byte-exact canonical bytes. Use the audited implementation in
   * `operator-console/lib/crypto/canonical.ts`, or the Operator Console UI.
   */
  async authorize(): Promise<never> {
    throw new NotYetWiredError(
      "binding.authorize()",
      "planned",
      "signing an AuthorizationCredential requires byte-exact canonicalisation that this SDK " +
        "does not reimplement. Use the Operator Console, or " +
        "operator-console/lib/crypto/canonical.ts. See " +
        "https://docs.libertynet.ai/concepts/binding#signing",
    );
  }
}
