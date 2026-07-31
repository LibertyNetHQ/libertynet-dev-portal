/**
 * Operator-scoped reads. Requires a session.
 *
 * Two of these three endpoints are live but have no data source behind them. This
 * module makes that impossible to miss: the honest reader returns the envelope
 * with its `source` field intact, and the convenient accessor throws rather than
 * hand you a zero you might render as an earning.
 */

import { NotYetWiredError } from "./errors.ts";
import type { Http } from "./http.ts";
import type { BoundNode, CreditsBalance, EvidenceList } from "./types.ts";

export class Operator {
  private readonly http: Http;

  constructor(http: Http) {
    this.http = http;
  }

  /**
   * Nodes bound to you, with a computed `online` flag.
   *
   * The registry reconciles the short/full DID encodings for you here, so a
   * binding stored as `did:svrp:n:8545027b` correctly resolves to the daemon
   * announcing itself as `did:svrp:<64hex>`.
   */
  async nodes(): Promise<{ operator_did: string; count: number; nodes: BoundNode[] }> {
    return this.http.get("/v1/operator/me/nodes", { auth: true });
  }

  /**
   * The raw credits envelope, `source` field and all.
   *
   * Today `source` is always `not_yet_wired` and every amount is `0`. That zero
   * is a placeholder, not a measurement. If you display it, display the caveat
   * with it — {@link isWired} tells you which you have.
   */
  async creditsRaw(): Promise<CreditsBalance> {
    return this.http.get("/v1/operator/me/credits", { auth: true });
  }

  /**
   * Settled credits as a number — but only if a real ledger is behind it.
   *
   * Throws {@link NotYetWiredError} while `source` is `not_yet_wired`, because
   * the alternative is returning `0` and letting it be rendered as "you have
   * earned nothing", which is a different and false statement from "we are not
   * measuring this yet".
   */
  async settledCredits(): Promise<number> {
    const balance = await this.creditsRaw();
    if (balance.source !== "ledger") {
      throw new NotYetWiredError(
        "GET /v1/operator/me/credits",
        "not_yet_wired",
        "the endpoint is live but no credits ledger is connected, so the returned 0 is a " +
          "placeholder rather than a balance. Use `creditsRaw()` if you want to display the " +
          "envelope with its caveat.",
      );
    }
    return balance.settled.amount;
  }

  /** Does a real data source stand behind the credits endpoint yet? */
  async isWired(): Promise<boolean> {
    return (await this.creditsRaw()).source === "ledger";
  }

  /**
   * Contribution evidence.
   *
   * Currently returns `count: 0` with `source: "not_yet_wired"`. Treat an empty
   * list as "unknown", never as "you contributed nothing".
   */
  async evidence(): Promise<EvidenceList> {
    return this.http.get("/v1/operator/me/evidence", { auth: true });
  }
}
