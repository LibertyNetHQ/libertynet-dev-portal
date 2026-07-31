/**
 * Namespaces for capabilities that do not exist yet.
 *
 * Why ship code for unbuilt features at all? Because the alternative is worse.
 * Without these, `ln.wallet.create()` is a `TypeError: undefined is not a
 * function` — a message that tells you nothing and sends you hunting for a typo.
 * With them, you get a typed error naming the capability, its real status, and
 * the page that tracks it.
 *
 * These will never silently start working. When a capability ships, its methods
 * are replaced by real implementations in the same release that flips its badge
 * on {@link https://docs.libertynet.ai/status}.
 */

import { NotYetWiredError } from "./errors.ts";

function planned(what: string, detail: string): never {
  throw new NotYetWiredError(what, "planned", detail);
}

/**
 * Agent wallet. <planned>
 *
 * Nothing here is built. Value transfer is outside the current network scope, and
 * key-handling for autonomous agents has not been through security review — so
 * there is deliberately not even a stub you could accidentally ship against.
 */
export class Wallet {
  async create(): Promise<never> {
    return planned("wallet.create()", "no wallet system exists. Value transfer is out of scope.");
  }
  async sessionKey(): Promise<never> {
    return planned("wallet.sessionKey()", "no wallet system exists.");
  }
  async transfer(): Promise<never> {
    return planned(
      "wallet.transfer()",
      "no wallet system exists, and no endpoint in this API moves value.",
    );
  }
}

/**
 * Intent trading. <planned>
 *
 * Not built. No endpoint, no contract, no matching engine.
 */
export class Dex {
  async intent(): Promise<never> {
    return planned("dex.intent()", "no intent trading system exists.");
  }
  async quote(): Promise<never> {
    return planned("dex.quote()", "no quoting system exists.");
  }
  async solve(): Promise<never> {
    return planned("dex.solve()", "no solver interface exists.");
  }
  async pools(): Promise<never> {
    return planned("dex.pools()", "no pools exist.");
  }
}

/**
 * Oracle. <testing>
 *
 * Different from the others: the contracts genuinely exist and their suite passes
 * (23/23, `libertynet-oracle/`). What is missing is a deployment — there is no
 * address on any public network to call, so there is nothing for an HTTP client
 * to talk to. The error says `testing` rather than `planned` to keep that
 * distinction honest.
 */
export class Oracle {
  async price(): Promise<never> {
    throw new NotYetWiredError(
      "oracle.price()",
      "testing",
      "EvidenceOracle and PythPriceAdapter exist and pass their tests, but are not deployed to " +
        "any public network, so there is no address to read. Track this at " +
        "https://docs.libertynet.ai/status#oracle",
    );
  }
  async report(): Promise<never> {
    throw new NotYetWiredError(
      "oracle.report()",
      "testing",
      "reporters sign EIP-712 payloads on-chain; there is no HTTP submission surface, and no " +
        "deployment to submit to.",
    );
  }
}
