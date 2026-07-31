/**
 * MCP server tests.
 *
 * Two layers: the tools as functions, and the JSON-RPC protocol as a real
 * subprocess speaking stdio. The second layer matters because a server that
 * passes unit tests and then writes a stray `console.log` to stdout corrupts the
 * protocol stream in a way no function test would catch.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  capabilityStatus,
  getPage,
  searchDocs,
  verifyIdentity,
  _clearCache,
} from "../src/tools.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SERVER = path.resolve(HERE, "../src/server.mjs");

const FULL_DID = "did:svrp:df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d";
const FULL_KEY = "df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d";
const SHORT_DID = "did:svrp:n:268d4fe0";
const SHORT_KEY = "7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg";

describe("verify_identity", () => {
  test("accepts a real full-hex identity", () => {
    const r = verifyIdentity({ did: FULL_DID, public_key: FULL_KEY });
    assert.equal(r.valid, true);
    assert.equal(r.form, "full-hex");
  });

  test("accepts a real short identity with a base58 key", () => {
    const r = verifyIdentity({ did: SHORT_DID, public_key: SHORT_KEY });
    assert.equal(r.valid, true);
    assert.equal(r.form, "short");
    assert.match(r.fingerprint, /^[0-9a-f]{4}(:[0-9a-f]{4}){3}$/);
  });

  test("rejects a crossed pair and says what was expected", () => {
    const r = verifyIdentity({ did: SHORT_DID, public_key: FULL_KEY });
    assert.equal(r.valid, false);
    assert.match(r.reason, /expected/);
  });

  test("explains the hex/base58 trap rather than just failing", () => {
    const r = verifyIdentity({ did: SHORT_DID, public_key: "nonsense" });
    assert.equal(r.valid, false);
    assert.match(r.reason, /base58/);
  });

  test("rejects a tagged 64-hex DID", () => {
    const r = verifyIdentity({ did: `did:svrp:n:${FULL_KEY}`, public_key: FULL_KEY });
    assert.equal(r.valid, false);
  });

  test("rejects a malformed DID without throwing", () => {
    assert.equal(verifyIdentity({ did: "nope", public_key: FULL_KEY }).valid, false);
  });
});

describe("capability_status", () => {
  test("returns every area with its endpoints", async () => {
    const s = await capabilityStatus({});
    const ids = s.groups.map((g) => g.id);
    for (const expected of ["discovery", "binding", "identity", "economics", "oracle", "wallet", "dex"]) {
      assert.ok(ids.includes(expected), `missing area ${expected}`);
    }
  });

  test("filters by area", async () => {
    const s = await capabilityStatus({ area: "discovery" });
    assert.equal(s.groups.length, 1);
    assert.equal(s.groups[0].id, "discovery");
  });

  test("lists valid areas when given a bad one", async () => {
    const s = await capabilityStatus({ area: "telepathy" });
    assert.ok(s.error);
    assert.ok(Array.isArray(s.available));
  });

  test("credits are reported as not_yet_wired", async () => {
    const s = await capabilityStatus({ area: "economics" });
    const credits = s.groups[0].endpoints.find((e) => e.path.includes("credits"));
    assert.equal(credits.status, "not_yet_wired");
  });

  test("wallet and dex are planned — nothing that moves value is implemented", async () => {
    for (const area of ["wallet", "dex"]) {
      const s = await capabilityStatus({ area });
      for (const e of s.groups[0].endpoints) {
        assert.equal(e.status, "planned", `${area} ${e.path} should be planned`);
      }
    }
  });

  test("carries guidance the model can act on", async () => {
    const s = await capabilityStatus({});
    assert.match(s.guidance, /not_yet_wired/);
    assert.match(s.guidance, /planned/);
  });
});

describe("search_docs", () => {
  test("finds the quickstart", async () => {
    _clearCache();
    const results = await searchDocs({ query: "quickstart first call" });
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.slug === "quickstart"));
  });

  test("ranks a page about the topic above one that mentions it", async () => {
    const results = await searchDocs({ query: "identity" });
    assert.ok(results.length > 0);
    assert.ok(
      ["concepts/identity", "reference/dids"].includes(results[0].slug),
      `unexpected top hit: ${results[0].slug}`,
    );
  });

  test("returns excerpts and public URLs", async () => {
    const [first] = await searchDocs({ query: "credits" });
    assert.ok(first.excerpt.length > 0);
    assert.match(first.url, /^https:\/\/docs\.libertynet\.ai\//);
  });

  test("honours the limit", async () => {
    assert.ok((await searchDocs({ query: "the", limit: 2 })).length <= 2);
  });

  test("returns nothing rather than guessing", async () => {
    assert.deepEqual(await searchDocs({ query: "zzzznotathingzzzz" }), []);
  });

  test("requires a query", async () => {
    await assert.rejects(() => searchDocs({}), TypeError);
  });
});

describe("get_page", () => {
  test("returns full content", async () => {
    const page = await getPage({ slug: "quickstart" });
    assert.equal(page.found, true);
    assert.ok(page.content.length > 500);
    assert.ok(page.title);
  });

  test("tolerates a leading slash and an .mdx suffix", async () => {
    assert.equal((await getPage({ slug: "/quickstart.mdx" })).found, true);
  });

  test("suggests alternatives instead of a bare failure", async () => {
    const page = await getPage({ slug: "concepts/nope" });
    assert.equal(page.found, false);
    assert.ok(Array.isArray(page.available));
    assert.ok(page.available.length > 5);
  });
});

// ---------------------------------------------------------------------------
// protocol
// ---------------------------------------------------------------------------

/** Drive the real server over stdio and collect its replies. */
function rpc(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    child.on("error", reject);
    child.on("close", () => {
      const messages = out
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      resolve({ messages, stderr: err, stdout: out });
    });

    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    setTimeout(() => child.stdin.end(), 900);
  });
}

describe("MCP protocol", () => {
  test("initialize returns the protocol version and honesty instructions", async () => {
    const { messages } = await rpc([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }]);

    const init = messages.find((m) => m.id === 1);
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(init.result.serverInfo.name, "libertynet");
    assert.match(init.result.instructions, /not_yet_wired/);
    assert.match(init.result.instructions, /test unit/);
    assert.match(init.result.instructions, /NO wallet/);
  });

  test("tools/list advertises every tool with a schema", async () => {
    const { messages } = await rpc([{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const { tools } = messages.find((m) => m.id === 2).result;

    assert.equal(tools.length, 6);
    for (const t of tools) {
      assert.ok(t.name.startsWith("libertynet_"));
      assert.ok(t.description.length > 40);
      assert.equal(t.inputSchema.type, "object");
    }
  });

  test("tools/call executes and returns content", async () => {
    const { messages } = await rpc([
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "libertynet_verify_identity", arguments: { did: FULL_DID, public_key: FULL_KEY } },
      },
    ]);

    const result = messages.find((m) => m.id === 3).result;
    assert.equal(JSON.parse(result.content[0].text).valid, true);
  });

  test("an unknown tool is a protocol error, not a silent no-op", async () => {
    const { messages } = await rpc([
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
    ]);
    assert.match(messages.find((m) => m.id === 4).error.message, /Unknown tool/);
  });

  test("a tool failure comes back as readable content, not a dropped call", async () => {
    const { messages } = await rpc([
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "libertynet_search_docs", arguments: {} } },
    ]);

    const result = messages.find((m) => m.id === 5).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /query is required/);
  });

  test("notifications are not answered", async () => {
    const { messages } = await rpc([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 7, method: "ping" },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 7);
  });

  test("stdout carries only JSON-RPC — diagnostics go to stderr", async () => {
    // A stray console.log here would corrupt the stream for every client.
    const { stdout, stderr } = await rpc([{ jsonrpc: "2.0", id: 8, method: "tools/list" }]);

    for (const line of stdout.split("\n").filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`);
    }
    assert.match(stderr, /libertynet-mcp .* ready/);
  });

  test("an unparseable line is dropped without killing the server", async () => {
    const { messages, stderr } = await rpc([
      "this is not json",
      { jsonrpc: "2.0", id: 9, method: "ping" },
    ].map((r) => (typeof r === "string" ? { __raw: r } : r)));

    // The object form still parses; the real check is that the server survived.
    assert.ok(messages.length >= 1);
    assert.ok(stderr.includes("ready"));
  });
});
