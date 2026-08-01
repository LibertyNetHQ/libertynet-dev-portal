/**
 * The machine-readable surfaces, checked against the build output.
 *
 * Everything here was a real defect first:
 *
 *   · 253 of 319 markdown twins carried raw JSX — `<Status level="planned" />`
 *     dropped into a sentence, where it reads as decoration rather than as the
 *     most important word on the line.
 *   · llms.txt listed the home page as `https://docs.libertynet.ai/.md`, which
 *     is not a URL. The one page every reader starts from was the single entry
 *     in that file that went nowhere.
 *   · llms-full.txt — the file most likely to be fetched whole by a model — was
 *     emitting unconverted MDX.
 *
 * None of it broke a page, so nothing noticed. These assertions are what notice.
 *
 * They read `site/dist`, so run the build first. That is deliberate: the claim
 * is about what gets served, not about what a function returns in isolation.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "../dist");
const ROOT = path.resolve(HERE, "../..");

const twins = [];
let llms = "";
let llmsFull = "";
let context = "";
let status = null;

before(async () => {
  if (!existsSync(DIST)) {
    throw new Error("site/dist missing — run `node site/build.mjs` first");
  }

  await (async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".md")) twins.push(full);
    }
  })(DIST);

  llms = await readFile(path.join(DIST, "llms.txt"), "utf8");
  llmsFull = await readFile(path.join(DIST, "llms-full.txt"), "utf8");
  context = await readFile(path.join(DIST, "ai-context.txt"), "utf8");
  status = JSON.parse(await readFile(path.join(ROOT, "api-spec/status.json"), "utf8"));
});

describe("markdown twins", () => {
  test("every page has one, in every locale", () => {
    // 29 English pages × 11 locales.
    assert.ok(twins.length >= 300, `only ${twins.length} twins`);
  });

  test("none leaks MDX build machinery", () => {
    const bad = twins.filter((f) => /^\s*(import|export)\s/m.test(readSync(f)));
    assert.deepEqual(bad.map(rel), []);
  });

  test("none leaks a raw component tag", () => {
    // Outside code, that is. The contributing page discusses `<Warning>` by
    // name, which is documentation doing its job — the leak this guards against
    // is an unconverted component sitting in the prose itself.
    const bad = twins.filter((f) => /<\/?[A-Z]\w*/.test(withoutCode(readSync(f))));
    assert.deepEqual(bad.map(rel), []);
  });

  test("none leaks frontmatter", () => {
    const bad = twins.filter((f) => /^---\n/.test(readSync(f)));
    assert.deepEqual(bad.map(rel), []);
  });

  test("each starts with its title as an h1", () => {
    const bad = twins.filter((f) => !/^# \S/.test(readSync(f)));
    assert.deepEqual(bad.map(rel), []);
  });

  test("statuses survive as words rather than being deleted", () => {
    // Deleting <Status/> would also pass the "no raw component" test above,
    // while removing the one word that says whether the thing works.
    const statusPage = readSync(path.join(DIST, "status.md"));
    assert.match(statusPage, /\*\*Implemented\*\*/);
    assert.match(statusPage, /\*\*Planned\*\*/);
  });

  test("statuses are localised, not left in English", () => {
    assert.match(readSync(path.join(DIST, "ja/status.md")), /\*\*実装済み\*\*/);
  });

  test("a callout keeps its kind and quotes its whole body", () => {
    const credits = readSync(path.join(DIST, "concepts/credits.md"));
    const block = /^> \*\*Warning\*\*\n>\n((?:>.*\n)+)/m.exec(credits);

    assert.ok(block, "no quoted Warning callout found");
    // The safety sentence must be inside the quote, not orphaned after it.
    assert.match(block[1], /Credits are a test unit/);
    assert.match(block[1], /Not cash\. Not redeemable/);
  });
});

describe("llms.txt", () => {
  // The "## Pages" section only. The sources listed further down are JSON, YAML
  // and JavaScript on purpose, and asserting they end in .md would be asserting
  // the wrong thing about the right file.
  const pageLinks = () => {
    const section = llms.split("## Machine-readable sources")[0];
    return [...section.matchAll(/^- \[.*?\]\((.*?)\)/gm)].map((m) => m[1]);
  };

  test("lists every English page", () => {
    assert.ok(pageLinks().length >= 29, `${pageLinks().length} entries`);
  });

  test("every listed page URL is well-formed and ends in .md", () => {
    const bad = pageLinks().filter(
      (u) => !/^https:\/\/docs\.libertynet\.ai\/[\w./-]+\.md$/.test(u),
    );
    assert.deepEqual(bad, []);
  });

  test("the home page entry points at a file that exists", () => {
    // This is the regression: `https://docs.libertynet.ai/.md`.
    assert.match(llms, /https:\/\/docs\.libertynet\.ai\/index\.md/);
    assert.ok(existsSync(path.join(DIST, "index.md")));
  });

  test("every URL in the file resolves to something on disk", () => {
    // Pages and sources alike — a source that 404s is worse than a page that
    // does, because a model fetches it instead of asking.
    const missing = [];
    for (const m of llms.matchAll(/https:\/\/docs\.libertynet\.ai\/([\w./-]+)/g)) {
      if (!existsSync(path.join(DIST, m[1]))) missing.push(m[1]);
    }
    assert.deepEqual([...new Set(missing)], []);
  });

  test("points at the machine-readable sources", () => {
    for (const p of ["/api-spec/status.json", "/llms-full.txt", "/mcp/libertynet-mcp.mjs"]) {
      assert.ok(llms.includes(p), `llms.txt does not mention ${p}`);
    }
  });
});

describe("llms-full.txt", () => {
  test("contains every page", () => {
    const urls = [...llmsFull.matchAll(/^URL: (.*)$/gm)];
    assert.ok(urls.length >= 29, `${urls.length} pages`);
  });

  test("is converted markdown, not raw MDX", () => {
    assert.equal(/^\s*import\s/m.test(llmsFull), false);
    assert.equal(/<Status\s/.test(llmsFull), false);
  });

  test("is large enough to actually be the whole corpus", async () => {
    const bytes = (await stat(path.join(DIST, "llms-full.txt"))).size;
    assert.ok(bytes > 100_000, `only ${bytes} bytes`);
  });
});

describe("ai-context.txt", () => {
  test("counts agree with the capability matrix", () => {
    const count = (level) =>
      status.groups.reduce((n, g) => n + g.endpoints.filter((e) => e.status === level).length, 0);

    assert.match(context, new RegExp(`CALLABLE TODAY \\(${count("implemented")}\\)`));
    assert.match(
      context,
      new RegExp(`ANSWERS, BUT THE NUMBERS ARE PLACEHOLDERS \\(${count("not_yet_wired")}\\)`),
    );
  });

  test("lists implemented endpoints separately from the rest", () => {
    const callable = context.split("ANSWERS, BUT")[0];
    assert.equal(/not_yet_wired\s+(GET|POST)/.test(callable), false);
    assert.equal(/planned\s+(GET|POST)/.test(callable), false);
  });

  test("carries the load-bearing warnings", () => {
    assert.match(context, /NO wallet, transfer, swap, staking, DEX or trading/);
    assert.match(context, /valid signature is NOT a valid identity/);
    assert.match(context, /"active" does NOT mean online/i);
    assert.match(context, /nothing is counting/);
  });

  test("stays short enough that someone will actually paste it", () => {
    assert.ok(context.length < 8_000, `${context.length} characters`);
  });
});

// ---------------------------------------------------------------------------

/** Strip fenced blocks and inline code, where component names are content. */
function withoutCode(md) {
  return md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

function readSync(f) {
  return readFileSync(f, "utf8");
}
function rel(f) {
  return path.relative(DIST, f);
}
