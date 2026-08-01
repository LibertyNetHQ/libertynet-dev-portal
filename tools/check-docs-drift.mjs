#!/usr/bin/env node
/**
 * Documentation honesty checker.
 *
 *     node tools/check-docs-drift.mjs
 *
 * The portal's central promise is that it never describes something as more
 * finished than it is. A promise nothing enforces decays — someone edits a page
 * six months from now, a capability ships, a fingerprint gets copied wrong — so
 * this file turns the promise into a build failure.
 *
 * Six checks:
 *
 *   1. status.json ↔ OpenAPI agree on every shared operation.
 *   2. No page claims a capability is live that status.json says is not.
 *   3. Pages that mention value movement say it does not exist.
 *   4. Every cryptographic value printed in the docs is arithmetically correct.
 *   5. Internal links resolve.
 *   6. docs.json and the .mdx files on disk agree.
 *
 * Check 4 exists because it caught a real error during authoring: a fingerprint
 * that had been written from memory rather than computed. Prose can be reviewed;
 * a hex string can only be recomputed.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { LOCALES } from "../site/build/locales.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const DOCS = path.join(ROOT, "docs-site");

const failures = [];
const notes = [];

function fail(check, message) {
  failures.push({ check, message });
}

// ---------------------------------------------------------------------------

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", ".next", "out", "dist", "snippets"].includes(e.name)) continue;
      await walk(full, out);
    } else if (e.name.endsWith(".mdx")) {
      out.push(full);
    }
  }
  return out;
}

/** Minimal YAML reader for the flat parts of the OpenAPI file we need. */
function operationStatuses(yaml) {
  const found = new Map();
  const lines = yaml.split("\n");

  let currentPath = null;
  let currentMethod = null;

  for (const line of lines) {
    const pathMatch = /^  (\/\S*):\s*$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentMethod = null;
      continue;
    }
    const methodMatch = /^    (get|post|put|delete|patch):\s*$/.exec(line);
    if (methodMatch) {
      currentMethod = methodMatch[1].toUpperCase();
      continue;
    }
    const statusMatch = /^      x-ln-status:\s*(\S+)\s*$/.exec(line);
    if (statusMatch && currentPath && currentMethod) {
      found.set(`${currentMethod} ${currentPath}`, statusMatch[1]);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. status.json ↔ OpenAPI
// ---------------------------------------------------------------------------

async function checkSpecAgreement(status) {
  const yaml = await readFile(path.join(ROOT, "api-spec/libertynet-v1.yaml"), "utf8");
  const spec = operationStatuses(yaml);

  const matrix = new Map();
  for (const group of status.groups) {
    for (const e of group.endpoints) {
      if (e.method === "CONTRACT") continue; // not an HTTP operation
      matrix.set(`${e.method} ${e.path.replace(/\{[^}]+\}/g, (m) => m)}`, e.status);
    }
  }

  for (const [key, specStatus] of spec) {
    const matrixStatus = matrix.get(key);
    if (matrixStatus === undefined) {
      fail("spec-agreement", `OpenAPI documents "${key}" but status.json does not list it`);
    } else if (matrixStatus !== specStatus) {
      fail(
        "spec-agreement",
        `"${key}" is "${specStatus}" in OpenAPI but "${matrixStatus}" in status.json`,
      );
    }
  }

  // The reverse direction is intentionally advisory: status.json lists planned
  // endpoints that have no business appearing in a spec of what exists.
  let missing = 0;
  for (const [key, s] of matrix) {
    if (s !== "planned" && !spec.has(key)) missing++;
  }
  notes.push(`spec: ${spec.size} operations, ${matrix.size} matrix entries, ${missing} non-planned not in spec`);
}

// ---------------------------------------------------------------------------
// 2. No page overclaims a capability
// ---------------------------------------------------------------------------

async function checkNoOverclaims(status, pages) {
  // Endpoints that are NOT implemented, keyed by a distinctive path fragment.
  const unbuilt = new Map();
  for (const group of status.groups) {
    for (const e of group.endpoints) {
      if (e.status === "implemented") continue;
      const fragment = e.path.replace(/^.*\/v1\//, "/v1/").split("{")[0].replace(/\/$/, "");
      if (fragment.length > 6) unbuilt.set(fragment, e.status);
    }
  }

  for (const file of pages) {
    const text = await readFile(file, "utf8");
    const rel = path.relative(ROOT, file);

    for (const [fragment, realStatus] of unbuilt) {
      if (!text.includes(fragment)) continue;

      // The page mentions an unbuilt endpoint. It must also carry that endpoint's
      // real status somewhere, or a plain-language equivalent.
      const declaresStatus =
        text.includes(`level="${realStatus}"`) ||
        text.includes("not_yet_wired") ||
        /\b(planned|not built|does not exist|not deployed|未接|没有做|未部署|规划中)\b/i.test(text);

      if (!declaresStatus) {
        fail(
          "overclaim",
          `${rel} mentions "${fragment}" (${realStatus}) without stating that it is not implemented`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Value movement is always denied where it is mentioned
// ---------------------------------------------------------------------------

async function checkValueMovement(pages) {
  // Pages allowed to discuss it at length — they exist to say it does not exist.
  const EXPECTED = ["guides/tokens", "concepts/intents", "status", "concepts/credits"];

  for (const file of pages) {
    const text = await readFile(file, "utf8");
    const rel = path.relative(ROOT, file);
    const slug = rel.replace(/^docs-site\//, "").replace(/\.mdx$/, "");

    // A page that shows a *call* to a value-moving method must make clear it throws.
    const showsCall = /\b(wallet\.(transfer|create|sessionKey|session_key)|dex\.(solve|quote|intent))\s*\(/.test(text);
    if (!showsCall) continue;

    const deniesIt =
      /NotYetWiredError|planned|not built|does not exist|raises|throws|没有做|不存在|抛异常/i.test(text);

    if (!deniesIt && !EXPECTED.some((e) => slug.endsWith(e))) {
      fail("value-movement", `${rel} shows a value-moving call without saying it is not built`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Every cryptographic value in the docs is actually correct
// ---------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let lead = 0;
  for (const c of s) { if (c === "1") lead++; else break; }
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, "hex")]);
}

function keyBytes(pk) {
  const raw = /^[0-9a-f]{64}$/.test(pk) ? Buffer.from(pk, "hex") : b58decode(pk);
  return raw && raw.length === 32 ? raw : null;
}

/**
 * The known real keys that appear as worked examples across the docs, and the
 * values that must be true of them. Recomputed from the key every run — nothing
 * here is a stored expectation that could drift alongside a mistake.
 */
const KNOWN_KEYS = [
  // did:svrp:df9d…02d / did:svrp:n:8545027b — the worked example throughout.
  "df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d",
  // did:svrp:n:268d4fe0 — the base58-encoded example from GET /peers.
  "7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg",
  // did:svrp:h:2216a202 — appears in pasted live output on several pages.
  "AhvV3bzyjCSfWyxCboCYuhGhRsC8VMsoGkyRqAD5Yy1H",
  // did:svrp:n:dbe63a0c — the canonical demo node at libertynet.ai/demo-node.
  // Public by definition; listing it here is what lets the checker confirm that
  // every DID the quickstart prints really derives from a key we can name.
  "6EDfN4n33y7pAsnHumASu3gu2eJyu5syJ3wowxqeQzF9",
];

async function checkCryptoValues(pages) {
  const truth = new Map(); // value → what it is
  for (const pk of KNOWN_KEYS) {
    const key = keyBytes(pk);
    if (!key) {
      fail("crypto", `KNOWN_KEYS entry is not a valid 32-byte key: ${pk}`);
      continue;
    }
    const digest = createHash("sha256").update(key).digest("hex");
    truth.set(`fingerprint:${pk}`, digest.slice(0, 16).match(/.{1,4}/g).join(":"));
    truth.set(`short:${pk}`, digest.slice(0, 8));
  }

  const validFingerprints = new Set(
    [...truth.entries()].filter(([k]) => k.startsWith("fingerprint:")).map(([, v]) => v),
  );
  const validShorts = new Set(
    [...truth.entries()].filter(([k]) => k.startsWith("short:")).map(([, v]) => v),
  );

  let checked = 0;

  for (const file of pages) {
    const text = await readFile(file, "utf8");
    const rel = path.relative(ROOT, file);

    // Any xxxx:xxxx:xxxx:xxxx literal must be a real fingerprint of a known key.
    for (const m of text.matchAll(/\b([0-9a-f]{4}(?::[0-9a-f]{4}){3})\b/g)) {
      checked++;
      if (!validFingerprints.has(m[1])) {
        fail(
          "crypto",
          `${rel} prints fingerprint "${m[1]}" which is not the fingerprint of any documented key.\n` +
            `        Real fingerprints: ${[...validFingerprints].join(", ")}`,
        );
      }
    }

    // Any did:svrp:<tag>:<8hex> must be the real short DID of a known key.
    for (const m of text.matchAll(/did:svrp:[a-z]:([0-9a-f]{8})\b/g)) {
      checked++;
      // Deliberately-invalid examples used to demonstrate rejection are fine.
      if (m[1] === "deadbeef") continue;
      if (!validShorts.has(m[1])) {
        fail(
          "crypto",
          `${rel} prints short DID "did:svrp:*:${m[1]}" which does not derive from any documented key.\n` +
            `        Real short ids: ${[...validShorts].join(", ")}`,
        );
      }
    }
  }

  notes.push(`crypto: ${checked} cryptographic literals recomputed from source keys`);
}

// ---------------------------------------------------------------------------
// 5. Internal links resolve
// ---------------------------------------------------------------------------

async function checkLinks(pages) {
  const slugs = new Set(
    pages.map((f) => path.relative(DOCS, f).replace(/\.mdx$/, "")),
  );
  // Nothing. This used to hold "api-reference", on the theory that Mintlify
  // would render it from the OpenAPI file — and when the portal moved to a
  // self-hosted build, nothing did. The whitelist kept the link checker quiet
  // while the home page, the changelog and the footer all pointed at a 404.
  //
  // A page is either generated into docs-site/ (where the checker sees it like
  // any other) or it does not exist. There is no third category, and inventing
  // one is how a link checker stops checking links.
  const GENERATED = new Set();

  let checked = 0;

  for (const file of pages) {
    const text = await readFile(file, "utf8");
    const rel = path.relative(ROOT, file);

    for (const m of text.matchAll(/\]\((\/[^)#\s]*)(#[^)\s]*)?\)/g)) {
      const target = m[1].replace(/^\//, "").replace(/\/$/, "");
      checked++;

      if (!target || slugs.has(target) || GENERATED.has(target)) continue;
      if ([...GENERATED].some((g) => target.startsWith(g))) continue;
      if (target.startsWith("snippets/")) continue;

      // Not every valid link is a page. `api-spec/` and `site/public/` are
      // copied in verbatim, and files like `ai-context.txt` are generated
      // during the build — so the built site is the authority on whether a
      // non-page link resolves. Checking the artifact rather than keeping a
      // list of exceptions is the point: the last exception list here quietly
      // excused a 404 that three pages linked to.
      if (
        existsSync(path.join(ROOT, target)) ||
        existsSync(path.join(ROOT, "site/public", target)) ||
        existsSync(path.join(ROOT, "site/dist", target))
      ) {
        continue;
      }

      fail("links", `${rel} links to /${target}, which is neither a page nor a served file`);
    }
  }

  notes.push(`links: ${checked} internal links resolved`);
}

// ---------------------------------------------------------------------------
// 6c. Counts stated in prose
//
// "23 endpoints you can call today" is a claim about the matrix written as a
// number, and a number in prose is the easiest kind of claim to leave behind.
// Badges regenerate; sentences do not. So every count the docs state about the
// matrix or the spec is recomputed here, the same way check 4 recomputes every
// cryptographic literal.
// ---------------------------------------------------------------------------

// Prose wraps. Every pattern below matches against text whose runs of
// whitespace have been collapsed to single spaces — the first version of this
// check silently matched nothing on the one claim it was written for, because
// the sentence happened to break between "call" and "today".
const COUNT_CLAIMS = [
  {
    // "**23** endpoints you can call today"
    pattern: /\*\*(\d+)\*\* endpoints you can call today/g,
    label: "endpoints callable today",
    expected: (status) => countByStatus(status, "implemented"),
  },
  {
    // "OpenAPI 3.1, 19 operations" / "19 operations, each with x-ln-status"
    pattern: /(\d+) operations, each/g,
    label: "OpenAPI operations",
    expected: (_status, spec) => (spec.match(/^\s{4}(get|post|put|patch|delete):/gm) ?? []).length,
  },
];

function countByStatus(status, level) {
  return status.groups.reduce(
    (n, g) => n + g.endpoints.filter((e) => e.status === level).length,
    0,
  );
}

async function checkStatedCounts(status, pages) {
  const spec = await readFile(path.join(ROOT, "api-spec/libertynet-v1.yaml"), "utf8");
  let checked = 0;

  for (const file of pages) {
    // Collapse wrapping so a claim is matched by what it says, not by where the
    // author happened to press return.
    const text = (await readFile(file, "utf8")).replace(/\s+/g, " ");
    const rel = path.relative(ROOT, file);

    for (const claim of COUNT_CLAIMS) {
      for (const m of text.matchAll(claim.pattern)) {
        checked++;
        const stated = Number(m[1]);
        const actual = claim.expected(status, spec);

        if (stated !== actual) {
          fail(
            "counts",
            `${rel} says ${stated} ${claim.label}; the source says ${actual}. ` +
              `Update the sentence, or state no number.`,
          );
        }
      }
    }
  }

  notes.push(`counts: ${checked} number(s) in prose recomputed from source`);
}

// ---------------------------------------------------------------------------
// 6b. Claims the docs make about the site's own UI
//
// Added after the docs shipped "Every page has a Copy for AI button" marked
// implemented, when nothing in the generator emitted such a button. A claim
// about an endpoint is checked against status.json; a claim about the site
// itself had nothing checking it at all. Each entry pins a promise to the
// marker that has to exist for the promise to be true.
// ---------------------------------------------------------------------------

const SITE_FEATURES = [
  {
    what: "Copy for AI button on every page",
    claimedIn: "ai/assistant.mdx",
    // Any phrasing of the promise; matched case-insensitively.
    claim: /copy(?:ies|ing)?\b[^.]{0,60}\bas (?:clean )?markdown|copy for ai/i,
    marker: /data-copy-page=/,
    markerIn: "site/build.mjs",
  },
  {
    what: "markdown twin served next to every page",
    claimedIn: "ai/assistant.mdx",
    claim: /\.md\b[^.]{0,80}\b(?:twin|same (?:url|path)|append)/i,
    marker: /\.md["'`]?\s*[,)\]]|writeFile\([^)]*\.md/,
    markerIn: "site/build.mjs",
  },
];

async function checkSiteFeatures() {
  const builder = await readFile(path.join(ROOT, "site/build.mjs"), "utf8");
  const sources = { "site/build.mjs": builder };
  let checked = 0;

  for (const feat of SITE_FEATURES) {
    const page = path.join(DOCS, feat.claimedIn);
    let text;
    try {
      text = await readFile(page, "utf8");
    } catch {
      fail("site-features", `${feat.claimedIn} is gone — update SITE_FEATURES`);
      continue;
    }

    // Only enforce while the page still makes the promise. Deleting the claim
    // is a legitimate way to resolve this check; quietly keeping it is not.
    if (!feat.claim.test(text)) continue;
    checked++;

    if (!feat.marker.test(sources[feat.markerIn])) {
      fail(
        "site-features",
        `${feat.claimedIn} promises "${feat.what}", but ${feat.markerIn} ` +
          `never emits it. Either build it or drop the claim.`,
      );
    }
  }

  notes.push(`site features: ${checked} self-claim(s) backed by the generator`);
}

// ---------------------------------------------------------------------------
// 6. docs.json ↔ files on disk
// ---------------------------------------------------------------------------

async function checkNavigation(pages) {
  const config = JSON.parse(await readFile(path.join(DOCS, "docs.json"), "utf8"));

  const listed = new Set();
  for (const language of config.navigation.languages ?? []) {
    for (const group of language.groups ?? []) {
      for (const page of group.pages ?? []) listed.add(page);
    }
  }

  // Navigation is declared once, for English. Translations live under
  // docs-site/<locale>/ and are resolved per-locale by the builder, so they are
  // not nav entries and must not be treated as orphans. What we DO check is the
  // reverse: a translation whose English original has been deleted or renamed is
  // now unreachable, and that is worth failing on.
  const localeDirs = new Set(LOCALES.map((l) => l.code).filter((c) => c !== "en"));
  const isTranslation = (slug) => localeDirs.has(slug.split("/")[0]);

  const all = pages.map((f) => path.relative(DOCS, f).replace(/\.mdx$/, ""));
  const english = new Set(all.filter((s) => !isTranslation(s)));
  const translations = all.filter(isTranslation);

  for (const page of listed) {
    if (!english.has(page)) fail("navigation", `docs.json lists "${page}" but no such .mdx exists`);
  }
  for (const page of english) {
    if (!listed.has(page)) fail("navigation", `${page}.mdx exists but is not in docs.json (orphan)`);
  }
  for (const t of translations) {
    const slug = t.split("/").slice(1).join("/");
    if (!english.has(slug)) {
      fail(
        "navigation",
        `${t}.mdx has no English original at ${slug}.mdx — it is unreachable, and its ` +
          `English source was probably renamed`,
      );
    }
  }

  const byLocale = {};
  for (const t of translations) {
    const code = t.split("/")[0];
    byLocale[code] = (byLocale[code] ?? 0) + 1;
  }
  const coverage = Object.entries(byLocale)
    .map(([c, n]) => `${c}:${n}`)
    .join(" ");

  notes.push(`navigation: ${listed.size} listed, ${english.size} English pages`);
  notes.push(`translations: ${translations.length} pages — ${coverage}`);
}

// ---------------------------------------------------------------------------

const status = JSON.parse(await readFile(path.join(ROOT, "api-spec/status.json"), "utf8"));
const pages = await walk(DOCS);

await checkSpecAgreement(status);
await checkNoOverclaims(status, pages);
await checkValueMovement(pages);
await checkCryptoValues(pages);
await checkLinks(pages);
await checkSiteFeatures();
await checkStatedCounts(status, pages);
await checkNavigation(pages);

// ---------------------------------------------------------------------------

console.log(`\nchecked ${pages.length} pages`);
for (const n of notes) console.log(`  · ${n}`);

if (failures.length === 0) {
  console.log("\n✓ docs honesty checks passed\n");
  process.exit(0);
}

console.error(`\n✗ ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.check}] ${f.message}`);
console.error("");
process.exit(1);
