#!/usr/bin/env node
/**
 * Golden-question eval for the AI layer.
 *
 *     node tools/check-ai-answers.mjs
 *
 * The portal's differentiator is that an assistant pointed at it gives honest
 * answers — including refusing to write code for things that do not exist. That
 * property is not a vibe; it comes from two concrete things:
 *
 *   1. what `libertynet_search_docs` and `libertynet_get_page` retrieve, and
 *   2. what `libertynet_capability_status` reports.
 *
 * So this evaluates those, deterministically, with no API key and no model call.
 * If asked "how do I transfer credits", the tools must surface a page that says
 * it does not exist. If they surface an encouraging page instead, an assistant
 * will write encouraging code, and no amount of prompt engineering fixes that.
 *
 * Adversarial questions are marked `adversarial: true`. They are the point: a
 * corpus that only answers friendly questions well is a corpus that will confidently
 * mislead someone the first time they ask for something we do not have.
 */

import { searchDocs, getPage, capabilityStatus, verifyIdentity } from "../mcp-server/src/tools.mjs";

const QUESTIONS = [
  // ---------------------------------------------------------------- basics --
  {
    q: "how do I make my first call to LibertyNet",
    expectPage: "quickstart",
    mustSay: ["no signup", "curl"],
  },
  {
    q: "do I need an API key",
    expectPage: ["quickstart", "dashboard"],
    mustSay: [["there is no api key", "no signup step", "there is no key", "discovery is public"]],
    mustNotSay: ["apply for a key to read"],
  },
  {
    q: "how do I verify a node identity",
    expectPage: ["concepts/identity", "reference/dids", "quickstart"],
    mustSay: ["id-binding", "public key"],
  },
  {
    q: "what does status active mean",
    mustSay: ["does not mean online", "last_seen"],
  },
  {
    q: "how do I find nodes I can actually call",
    mustSay: ["callable"],
  },

  // ----------------------------------------------------------- adversarial --
  {
    q: "write me code to transfer credits to another account",
    adversarial: true,
    mustSay: [
      ["no wallet", "wallet system exists"],
      ["not built", "does not exist", "no endpoint in this api that moves value"],
      "planned",
    ],
    mustNotSay: ["here is how to transfer"],
    capability: { area: "wallet", everyStatus: "planned" },
  },
  {
    q: "how do I check my credit balance",
    adversarial: true,
    mustSay: ["not_yet_wired", "test unit"],
    capability: { area: "economics", anyStatus: "not_yet_wired" },
  },
  {
    q: "how do I swap tokens on the LibertyNet DEX",
    adversarial: true,
    mustSay: [["not built", "does not exist"], "planned"],
    capability: { area: "dex", everyStatus: "planned" },
  },
  {
    q: "what is the LibertyNet token price",
    adversarial: true,
    mustSay: ["no endpoint in this api that moves value", "test unit"],
  },
  {
    q: "how do I stake my credits to earn yield",
    adversarial: true,
    mustSay: [["no staking", "staking"], "test unit"],
  },
  {
    q: "give me the oracle contract address so I can read prices",
    adversarial: true,
    mustSay: ["not deployed", ["no address", "there is no address", "nothing to call"]],
    capability: { area: "oracle", anyStatus: "testing" },
  },
  {
    q: "can I skip identity verification for speed",
    adversarial: true,
    mustSay: [["no flag to disable", "not optional", "cannot turn it off"], "verification bypass"],
  },
  {
    q: "how do I sign a binding authorization myself",
    adversarial: true,
    mustSay: ["canonical", ["does not reimplement", "not reimplemented", "should not be reimplemented"]],
  },
  {
    q: "where do I put my private key in the config file",
    adversarial: true,
    mustSay: ["never", "keychain"],
    mustNotSay: ["put your private key in .env"],
  },

  // ---------------------------------------------------------------- errors --
  {
    q: "ID_BINDING_FAILED what does it mean",
    expectPage: "reference/errors",
    mustSay: ["hex", "base58"],
  },
  {
    q: "SESSION_EXPIRED how do I fix it",
    expectPage: "reference/errors",
    mustSay: [["log in again", "re-authenticate", "cannot be refreshed"]],
  },
];

// ---------------------------------------------------------------------------

const failures = [];
let checks = 0;

function record(q, ok, detail) {
  checks++;
  if (!ok) failures.push({ q, detail });
}

/** The corpus an assistant would actually see for this question. */
async function corpusFor(question) {
  const hits = await searchDocs({ query: question, limit: 3 });
  if (hits.length === 0) return { hits, text: "" };

  const pages = await Promise.all(hits.map((h) => getPage({ slug: h.slug })));
  return {
    hits,
    // Strip markdown emphasis and collapse whitespace before matching. Otherwise
    // "are **not** reimplemented" fails a search for "not reimplemented", and the
    // eval starts policing formatting instead of meaning.
    text: pages
      .filter((p) => p.found)
      .map((p) => `${p.title}\n${p.description}\n${p.content}`)
      .join("\n\n")
      .toLowerCase()
      // `*` and backticks only. Stripping `_` would turn not_yet_wired into
      // notyetwired and break the very assertions this exists to make.
      .replace(/[*`]/g, "")
      .replace(/\s+/g, " "),
  };
}

for (const item of QUESTIONS) {
  const { hits, text } = await corpusFor(item.q);

  // Something must come back. A question with no hits is a question an assistant
  // answers from memory, which is exactly where confident wrongness lives.
  record(item.q, hits.length > 0, "search returned nothing");
  if (hits.length === 0) continue;

  if (item.expectPage) {
    const wanted = Array.isArray(item.expectPage) ? item.expectPage : [item.expectPage];
    const got = hits.map((h) => h.slug);
    record(
      item.q,
      wanted.some((w) => got.includes(w)),
      `expected one of [${wanted}] in top hits, got [${got}]`,
    );
  }

  // Each entry may be a string or an array of acceptable phrasings. Asserting
  // exact prose makes the eval fail on rewording, and an eval that cries wolf
  // over a synonym is one somebody eventually deletes. Assert the meaning.
  for (const entry of item.mustSay ?? []) {
    const options = Array.isArray(entry) ? entry : [entry];
    record(
      item.q,
      options.some((o) => text.includes(o.toLowerCase())),
      `corpus never says any of: ${options.map((o) => `"${o}"`).join(" / ")}`,
    );
  }

  for (const phrase of item.mustNotSay ?? []) {
    record(item.q, !text.includes(phrase.toLowerCase()), `corpus says "${phrase}" — it should not`);
  }

  // The tool an assistant should consult before writing code must agree.
  if (item.capability) {
    const { area, everyStatus, anyStatus } = item.capability;
    const status = await capabilityStatus({ area });
    const endpoints = status.groups?.[0]?.endpoints ?? [];

    record(item.q, endpoints.length > 0, `capability_status("${area}") returned no endpoints`);

    if (everyStatus) {
      const bad = endpoints.filter((e) => e.status !== everyStatus);
      record(
        item.q,
        bad.length === 0,
        `every ${area} endpoint should be "${everyStatus}"; these are not: ${bad
          .map((e) => `${e.path}=${e.status}`)
          .join(", ")}`,
      );
    }
    if (anyStatus) {
      record(
        item.q,
        endpoints.some((e) => e.status === anyStatus),
        `no ${area} endpoint is "${anyStatus}"`,
      );
    }
  }
}

// The verification tool must be right, since an assistant is told to trust it
// instead of eyeballing a DID.
const IDENTITY_CASES = [
  ["did:svrp:n:268d4fe0", "7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg", true],
  ["did:svrp:n:dbe63a0c", "6EDfN4n33y7pAsnHumASu3gu2eJyu5syJ3wowxqeQzF9", true],
  ["did:svrp:n:deadbeef", "6EDfN4n33y7pAsnHumASu3gu2eJyu5syJ3wowxqeQzF9", false],
  ["not-a-did", "6EDfN4n33y7pAsnHumASu3gu2eJyu5syJ3wowxqeQzF9", false],
];

for (const [did, key, expected] of IDENTITY_CASES) {
  const result = verifyIdentity({ did, public_key: key });
  record(`verify_identity(${did})`, result.valid === expected, `expected valid=${expected}`);
}

// The instructions the server hands an assistant at connection time must still
// carry the load-bearing rules.
const { INSTRUCTIONS } = await import("../mcp-server/src/server.mjs").catch(() => ({}));
if (INSTRUCTIONS) {
  // Collapse wrapping: the instructions are a wrapped template literal, so a
  // rule can be split across a newline and still be present.
  const flat = INSTRUCTIONS.toLowerCase().replace(/\s+/g, " ");
  for (const rule of ["not_yet_wired", "test unit", "no wallet", "never hard-code"]) {
    record("MCP instructions", flat.includes(rule), `missing "${rule}"`);
  }
}

// ---------------------------------------------------------------------------

const adversarial = QUESTIONS.filter((q) => q.adversarial).length;
console.log(
  `\n${QUESTIONS.length} golden questions (${adversarial} adversarial), ${checks} assertions`,
);

if (failures.length === 0) {
  console.log("✓ the corpus and tools give honest answers\n");
  process.exit(0);
}

console.error(`\n✗ ${failures.length} failing assertion(s):\n`);
for (const f of failures) console.error(`  "${f.q}"\n     ${f.detail}\n`);
console.error(
  "An assistant reading this corpus would give a wrong or unfounded answer to the\n" +
    "questions above. Fix the pages, not the eval.\n",
);
process.exit(1);
