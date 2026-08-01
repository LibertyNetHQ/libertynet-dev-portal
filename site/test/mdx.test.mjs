/**
 * Renderer tests.
 *
 * These exist because of a bug that failed invisibly: a paragraph beginning with
 * an inline component was treated as a block and dropped entirely. The page still
 * rendered — it was just missing a sentence — which is the worst way for a
 * documentation bug to behave, because nothing looks broken.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { renderBlocks, parseFrontmatter, renderInline } from "../build/mdx.mjs";

const ctx = { strings: { status: { planned: "Planned", implemented: "Implemented" }, callout: {}, nav: {} } };
const render = (src) => renderBlocks(src, ctx).html;

describe("paragraphs beginning with an inline component", () => {
  test("keeps the prose after a <Status/> badge", () => {
    const html = render(`<Status level="planned" /> Reserved and not live yet.`);
    assert.match(html, /Reserved and not live yet/);
    assert.match(html, /pill--planned/);
  });

  test("keeps prose after a badge inside a Card", () => {
    const html = render(
      `<Card title="Discord">\n  <Status level="planned" /> Not live yet, so this link does not resolve.\n</Card>`,
    );
    assert.match(html, /Not live yet, so this link does not resolve/);
  });

  test("still treats a lone component tag as a block", () => {
    const html = render(`<Warning>\nBody text.\n</Warning>`);
    assert.match(html, /callout--warning/);
    assert.match(html, /Body text/);
  });

  test("does not swallow the line after a self-closing block tag", () => {
    const html = render(`<Status level="implemented" />\n\nFollowing paragraph.`);
    assert.match(html, /Following paragraph/);
  });
});

describe("block boundaries still hold", () => {
  for (const [name, src, expect] of [
    ["heading", "## Title", /<h2/],
    ["list", "- one\n- two", /<li>one<\/li>/],
    ["table", "| a | b |\n|---|---|\n| 1 | 2 |", /<table>/],
    ["code fence", "```bash\necho hi\n```", /<pre>/],
    ["blockquote", "> quoted", /<blockquote>/],
    ["rule", "---", /<hr>/],
  ]) {
    test(name, () => assert.match(render(src), expect));
  }
});

describe("frontmatter", () => {
  test("separates meta from body", () => {
    const { meta, body } = parseFrontmatter(`---\ntitle: "T"\ndescription: D\n---\nBody`);
    assert.equal(meta.title, "T");
    assert.equal(meta.description, "D");
    assert.equal(body.trim(), "Body");
  });
});

describe("inline", () => {
  test("code spans are not parsed as markup", () => {
    assert.match(renderInline("use `**not bold**` here", ctx), /<code>\*\*not bold\*\*<\/code>/);
  });

  test("links resolve against the locale prefix", () => {
    const html = renderInline("[x](/status)", { ...ctx, localePrefix: "/ja" });
    assert.match(html, /href="\/ja\/status"/);
  });

  test("escapes html in prose", () => {
    assert.match(renderInline("a < b & c", ctx), /a &lt; b &amp; c/);
  });
});
