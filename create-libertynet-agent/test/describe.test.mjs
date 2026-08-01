/**
 * Tests for the plain-English reader.
 *
 * The type-selection cases are cheap and mostly guard against regressions in the
 * vocabulary. The tests worth reading are the last two groups: that a request
 * for something LibertyNet has never built is refused rather than stubbed, and
 * that the warnings come from the real matrix rather than from strings typed
 * here. A test that hard-codes "credits are not_yet_wired" would keep passing
 * on the day credits get wired, and would then be a lie.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { interpret, nameFromDescription } from "../src/describe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const status = JSON.parse(await readFile(path.join(HERE, "../src/status.json"), "utf8"));

const read = (s) => interpret(s, status);

describe("agent type", () => {
  test("watching the network is a monitor", () => {
    assert.equal(read("watch the network and alert me when a node goes offline").type, "monitor");
    assert.equal(read("track how many nodes are online").type, "monitor");
  });

  test("offering something is a service", () => {
    assert.equal(read("serve inference to other agents").type, "service");
    assert.equal(read("expose an endpoint that answers questions").type, "service");
  });

  test("intents are a solver", () => {
    assert.equal(read("solve intents posted by other agents").type, "solver");
  });

  test("an unclear sentence gets custom, and says why", () => {
    const r = read("something to do with LibertyNet");
    assert.equal(r.type, "custom");
    assert.match(r.reasoning.join(" "), /nothing in the description pointed at/);
  });

  test("a service always offers something", () => {
    // A service declaring no capability is not a service.
    assert.deepEqual(read("serve other agents").capabilities, ["inference"]);
  });
});

describe("capabilities", () => {
  test("named capabilities are picked up", () => {
    assert.deepEqual(read("offer inference and storage").capabilities.sort(), ["inference", "storage"]);
  });

  test("capabilities are not invented", () => {
    assert.deepEqual(read("watch the network").capabilities, []);
  });
});

describe("names", () => {
  test("reads as a directory name", () => {
    assert.equal(
      nameFromDescription("watch inference nodes and tell me when one drops off"),
      "watch-inference-nodes",
    );
  });

  test("keeps the verb that describes the job", () => {
    // "watch" carries the meaning; stripping it as a stopword produced names
    // like "inference-nodes-network", which say nothing about what it does.
    assert.match(nameFromDescription("watch the network"), /^watch/);
  });

  test("falls back rather than emitting an invalid name", () => {
    assert.equal(nameFromDescription("a an the it"), "libertynet-agent");
    assert.equal(nameFromDescription("!!! ???"), "libertynet-agent");
  });

  test("never exceeds the length the validator accepts", () => {
    const long = nameFromDescription("extraordinarily complicated distributed inference orchestration");
    assert.ok(long.length <= 40, long);
  });
});

describe("refusals — the point of the feature", () => {
  const impossible = [
    ["an agent that pays nodes from my wallet", "wallets"],
    ["transfer credits to another operator", "value transfer"],
    ["swap my tokens for another asset", "swapping or trading"],
    ["stake tokens to earn yield", "staking"],
    ["charge users for each request", "payments"],
  ];

  for (const [sentence, subject] of impossible) {
    test(`refuses: ${sentence}`, () => {
      const r = read(sentence);
      assert.ok(r.refusals.length > 0, "expected a refusal");
      assert.ok(
        r.refusals.some((x) => x.subject === subject),
        `expected a refusal about ${subject}, got ${r.refusals.map((x) => x.subject).join(", ")}`,
      );
      assert.match(r.refusals[0].reason, /No endpoint in this protocol moves value/);
    });
  }

  test("an ordinary request is not refused", () => {
    assert.deepEqual(read("watch the network for new nodes").refusals, []);
  });

  test("each subject is refused once, not once per synonym", () => {
    const r = read("pay, paying and payments for everything");
    assert.equal(r.refusals.filter((x) => x.subject === "payments").length, 1);
  });
});

describe("warnings are read from the matrix, not hard-coded", () => {
  test("an area whose endpoints are all planned is flagged as planned", () => {
    // Find such a group in the real matrix rather than assuming which one it is.
    const allPlanned = status.groups.find(
      (g) => g.endpoints.length && g.endpoints.every((e) => e.status === "planned"),
    );

    if (!allPlanned) {
      // Nothing is fully unbuilt any more — good news, and nothing to assert.
      return;
    }

    const word = { oracle: "oracle prices", intents: "intents" }[allPlanned.id];
    if (!word) return; // no vocabulary for this group yet

    const r = read(`use ${word} in my agent`);
    const w = r.warnings.find((x) => x.area === allPlanned.id);
    assert.ok(w, `expected a warning for ${allPlanned.id}`);
    assert.equal(w.status, "planned");
  });

  test("credits carry whatever status the matrix currently gives them", () => {
    const economics = status.groups.find((g) => g.id === "economics");
    const statuses = economics.endpoints.map((e) => e.status);
    const r = read("show me my credits balance");
    const w = r.warnings.find((x) => x.area === "economics");

    if (statuses.includes("implemented")) {
      // Wired up: there is nothing left to warn about, and a stale warning here
      // would be its own kind of dishonesty.
      assert.equal(w, undefined);
    } else {
      assert.ok(w, "expected a warning while economics is unwired");
      assert.match(w.message, /never show one of those zeros as a measurement/i);
    }
  });

  test("a fully live area produces no warning", () => {
    const r = read("list the nodes on the network");
    assert.equal(r.warnings.find((x) => x.area === "discovery"), undefined);
  });
});

describe("input handling", () => {
  test("an empty description is an error, not a default", () => {
    assert.throws(() => read(""), TypeError);
    assert.throws(() => read("   "), TypeError);
  });

  test("the reading is explained", () => {
    assert.ok(read("watch the network").reasoning.length > 0);
  });
});
