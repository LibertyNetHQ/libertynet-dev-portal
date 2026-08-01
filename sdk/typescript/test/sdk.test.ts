/**
 * Behavioural tests, driven by a stub fetch so they are hermetic and fast.
 *
 * The interesting ones are under "honesty guarantees": they are the executable
 * form of the promises the docs make. If someone later decides a `0` balance is
 * friendlier than an exception, these fail and say why.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { LibertyNet } from "../src/index.ts";
import { ApiError, AuthError, NotYetWiredError, TransportError } from "../src/errors.ts";

const GOOD_NODE = {
  did: "did:svrp:df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d",
  public_key: "df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d",
  endpoint: "172.20.10.5:55785",
  capabilities: ["inference", "health:ready"],
  region: "asia-southeast",
  status: "active",
  last_seen: new Date().toISOString().slice(0, 19) + "Z",
  first_seen: "2026-07-28T11:49:46Z",
  signature: null,
};

/** Same shape, but the DID does not derive from the key. A forged record. */
const FORGED_NODE = {
  ...GOOD_NODE,
  did: "did:svrp:n:deadbeef",
  last_seen: new Date().toISOString().slice(0, 19) + "Z",
};

/** Verifies fine, but has not been heard from in a day. */
const STALE_NODE = {
  ...GOOD_NODE,
  last_seen: new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19) + "Z",
};

/** Build a client whose transport returns canned responses. */
function client(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];

  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, init });

    const path = u.replace("https://registry.libertynet.ai", "");
    const route = routes[path];
    if (!route) return new Response("not found", { status: 404 });

    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  return { ln: new LibertyNet({ fetch: fetchImpl, retries: 0 }), calls };
}

describe("discovery", () => {
  test("returns verified nodes", async () => {
    const { ln } = client({ "/nodes": { body: { count: 1, nodes: [GOOD_NODE] } } });
    const nodes = await ln.discovery.all();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.verified, true);
  });

  test("silently drops a forged record from all()", async () => {
    const { ln } = client({ "/nodes": { body: { count: 2, nodes: [GOOD_NODE, FORGED_NODE] } } });
    const nodes = await ln.discovery.all();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.did, GOOD_NODE.did);
  });

  test("audit() surfaces the forged record instead of hiding it", async () => {
    const { ln } = client({ "/nodes": { body: { count: 2, nodes: [GOOD_NODE, FORGED_NODE] } } });
    const result = await ln.discovery.audit();
    assert.equal(result.total, 2);
    assert.equal(result.verified.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]!.did, FORGED_NODE.did);
  });

  test("online() excludes a stale node even though status says active", async () => {
    const { ln } = client({ "/nodes": { body: { count: 1, nodes: [STALE_NODE] } } });
    assert.equal(STALE_NODE.status, "active"); // the trap
    assert.equal((await ln.discovery.online()).length, 0);
  });

  test("online() filters by capability", async () => {
    const { ln } = client({ "/nodes": { body: { count: 1, nodes: [GOOD_NODE] } } });
    assert.equal((await ln.discovery.online({ capabilities: ["inference"] })).length, 1);
    assert.equal((await ln.discovery.online({ capabilities: ["storage"] })).length, 0);
  });

  test("online() filters by region", async () => {
    const { ln } = client({ "/nodes": { body: { count: 1, nodes: [GOOD_NODE] } } });
    assert.equal((await ln.discovery.online({ region: "asia-southeast" })).length, 1);
    assert.equal((await ln.discovery.online({ region: "eu-west" })).length, 0);
  });

  test("get() matches across both DID encodings", async () => {
    const { ln } = client({ "/nodes": { body: { count: 1, nodes: [GOOD_NODE] } } });
    const short = "did:svrp:n:" + "";
    // Full form finds it directly.
    assert.ok(await ln.discovery.get(GOOD_NODE.did));
    // A DID that is neither spelling of this key does not.
    assert.equal(await ln.discovery.get("did:svrp:n:deadbeef"), null);
    assert.equal(short, "did:svrp:n:");
  });
});

describe("auth", () => {
  test("an authed call without a session throws AuthError, not a 401 round-trip", async () => {
    const { ln, calls } = client({});
    await assert.rejects(() => ln.operator.nodes(), AuthError);
    assert.equal(calls.length, 0, "should fail before touching the network");
  });

  test("useSession() attaches a bearer header", async () => {
    const { ln, calls } = client({
      "/v1/operator/me/nodes": { body: { operator_did: "did:svrp:o:1", count: 0, nodes: [] } },
    });
    ln.auth.useSession("test-token");
    await ln.operator.nodes();

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer test-token");
  });

  test("logout() clears the session", async () => {
    const { ln } = client({});
    ln.auth.useSession("t");
    assert.equal(ln.auth.isLoggedIn(), true);
    ln.auth.logout();
    assert.equal(ln.auth.isLoggedIn(), false);
  });

  test("a 401 from the server surfaces as AuthError", async () => {
    const { ln } = client({
      "/v1/operator/me/nodes": {
        status: 401,
        body: { code: "SESSION_EXPIRED", error: "login expired" },
      },
    });
    ln.auth.useSession("stale");
    await assert.rejects(() => ln.operator.nodes(), (e: unknown) => {
      assert.ok(e instanceof AuthError);
      assert.equal(e.code, "SESSION_EXPIRED");
      return true;
    });
  });
});

describe("honesty guarantees", () => {
  const wiredZero = {
    operator_did: "did:svrp:o:1",
    unit: "test-credit",
    settled: { amount: 0, meaning: "" },
    pending: { amount: 0, meaning: "" },
    estimated: { amount: 0, meaning: "" },
    source: "not_yet_wired",
  };

  test("settledCredits() refuses to return a not_yet_wired zero", async () => {
    const { ln } = client({ "/v1/operator/me/credits": { body: wiredZero } });
    ln.auth.useSession("t");

    await assert.rejects(() => ln.operator.settledCredits(), (e: unknown) => {
      assert.ok(e instanceof NotYetWiredError);
      assert.equal(e.level, "not_yet_wired");
      return true;
    });
  });

  test("creditsRaw() still returns the envelope, source intact", async () => {
    const { ln } = client({ "/v1/operator/me/credits": { body: wiredZero } });
    ln.auth.useSession("t");

    const raw = await ln.operator.creditsRaw();
    assert.equal(raw.source, "not_yet_wired");
    assert.equal(raw.settled.amount, 0);
  });

  test("settledCredits() works the moment a real ledger is behind it", async () => {
    const { ln } = client({
      "/v1/operator/me/credits": { body: { ...wiredZero, source: "ledger", settled: { amount: 42, meaning: "" } } },
    });
    ln.auth.useSession("t");
    assert.equal(await ln.operator.settledCredits(), 42);
  });

  test("isWired() reports the truth", async () => {
    const { ln } = client({ "/v1/operator/me/credits": { body: wiredZero } });
    ln.auth.useSession("t");
    assert.equal(await ln.operator.isWired(), false);
  });

  test("planned namespaces throw a typed error naming their status", async () => {
    const { ln } = client({});

    for (const call of [
      () => ln.wallet.create(),
      () => ln.wallet.transfer(),
      () => ln.dex.quote(),
      () => ln.dex.solve(),
    ]) {
      await assert.rejects(call, (e: unknown) => {
        assert.ok(e instanceof NotYetWiredError, "must be NotYetWiredError");
        assert.equal(e.level, "planned");
        return true;
      });
    }
  });

  test("oracle reports `testing`, not `planned` — the contracts do exist", async () => {
    const { ln } = client({});
    await assert.rejects(() => ln.oracle.price(), (e: unknown) => {
      assert.ok(e instanceof NotYetWiredError);
      assert.equal(e.level, "testing");
      return true;
    });
  });

  test("every SDK error carries a docs link", async () => {
    const { ln } = client({});
    try {
      await ln.wallet.create();
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof NotYetWiredError);
      assert.match(e.docs, /^https:\/\/docs\.libertynet\.ai\//);
      assert.match(String(e), /→ https:\/\/docs\.libertynet\.ai\//);
    }
  });
});

describe("transport", () => {
  test("does not retry a 4xx", async () => {
    let hits = 0;
    const fetchImpl = (async () => {
      hits++;
      return new Response(JSON.stringify({ code: "BAD", error: "nope" }), { status: 400 });
    }) as unknown as typeof globalThis.fetch;

    const ln = new LibertyNet({ fetch: fetchImpl, retries: 3 });
    await assert.rejects(() => ln.discovery.health(), ApiError);
    assert.equal(hits, 1, "a rejected request must not be replayed");
  });

  test("retries a 503 and succeeds", async () => {
    let hits = 0;
    const fetchImpl = (async () => {
      hits++;
      if (hits < 3) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ status: "ok", service: "s", count: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const ln = new LibertyNet({ fetch: fetchImpl, retries: 3 });
    assert.equal((await ln.discovery.health()).count, 1);
    assert.equal(hits, 3);
  });

  test("a dead network becomes TransportError, not an opaque TypeError", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const ln = new LibertyNet({ fetch: fetchImpl, retries: 0 });
    await assert.rejects(() => ln.discovery.health(), TransportError);
  });

  test("the base URL is configurable for self-hosted registries", () => {
    const ln = new LibertyNet({ baseUrl: "https://registry.example.test/" });
    assert.equal(ln.baseUrl, "https://registry.example.test");
  });
});

describe("live network", { skip: !process.env["LN_LIVE"] && "set LN_LIVE=1 to run" }, () => {
  test("the real registry is up and every identity on it verifies", async () => {
    const ln = new LibertyNet();

    const health = await ln.discovery.health();
    assert.equal(health.status, "ok");

    const audit = await ln.discovery.audit();
    assert.ok(audit.total > 0, "registry should not be empty");
    assert.deepEqual(audit.rejected, [], "no record on the live registry should fail id-binding");
  });

  test("credits are still not wired — if this fails, update status.json", async () => {
    // Deliberately unauthenticated: we only need the shape of the refusal.
    const ln = new LibertyNet();
    await assert.rejects(() => ln.operator.creditsRaw(), AuthError);
  });
});

describe("reachability", () => {
  // Before this, online() returned RFC1918 addresses and node://laptop labels.
  // Callers tried them, got timeouts, and reasonably concluded the SDK was
  // broken rather than that the node was not for them.
  const node = (over: Record<string, unknown> = {}) => ({ ...GOOD_NODE, ...over });
  const withNodes = (nodes: unknown[]) =>
    client({ "/nodes": { body: { count: nodes.length, total: nodes.length, nodes } } });

  test("excludes private endpoints by default", async () => {
    const { ln } = withNodes([node({ reachability: "private" })]);
    assert.equal((await ln.discovery.online()).length, 0);
  });

  test("excludes unroutable node:// labels by default", async () => {
    const { ln } = withNodes([node({ endpoint: "node://laptop", reachability: "unroutable" })]);
    assert.equal((await ln.discovery.online()).length, 0);
  });

  test("includes public endpoints", async () => {
    const { ln } = withNodes([node({ reachability: "public" })]);
    assert.equal((await ln.discovery.online()).length, 1);
  });

  test("includeUnreachable opts back in", async () => {
    const { ln } = withNodes([node({ reachability: "private" })]);
    assert.equal((await ln.discovery.online({ includeUnreachable: true })).length, 1);
  });

  test("an absent field is unknown, not unreachable", async () => {
    // Older registries do not report it. Hiding the whole network from anyone
    // pointed at one is a worse failure than showing an address that may not answer.
    const { ln } = withNodes([node()]);
    assert.equal((await ln.discovery.online()).length, 1);
  });

  test("callable() requires a registration signature", async () => {
    const { ln } = withNodes([
      node({ reachability: "public", signature: null, signature_present: false }),
    ]);
    assert.equal((await ln.discovery.online()).length, 1);
    assert.equal((await ln.discovery.callable()).length, 0);
  });

  test("callable() returns signed public nodes", async () => {
    const { ln } = withNodes([
      node({ reachability: "public", signature: "sig", signature_present: true }),
    ]);
    assert.equal((await ln.discovery.callable()).length, 1);
  });
});
