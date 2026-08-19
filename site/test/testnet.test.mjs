/**
 * The test-network notice, checked against what actually gets served.
 *
 * These docs teach a reader to call endpoints that return balances and Credits figures. The number
 * they get back looks exactly like a number that means something. The three facts that say it does
 * not — test network, no value, chain can be wiped — have to be on the page before the number, in
 * the reader's language, on every page and not only on the pages whose author remembered.
 *
 * The assertions read `site/dist`, not the source: the claim is about what a reader receives. A
 * string that exists in `site/i18n/ja.json` and never reaches `dist/ja/*.html` is the exact failure
 * this file is here to catch — and it is the failure shape that has bitten this project before,
 * where the fix was merged and the deploy was not.
 *
 * Run the build first: `node site/build.mjs`.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "../dist");
const I18N = path.join(HERE, "../i18n");

const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "pt", "de", "fr", "ar", "hi"];
const FACTS = ["headline", "noValue", "mayReset"];

/** English lives at the root; every other locale under its code. */
function homeOf(locale) {
  return locale === "en" ? path.join(DIST, "index.html") : path.join(DIST, locale, "index.html");
}

function escapeHtml(s) {
  return s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

const strings = {};

describe("test-network notice", () => {
  before(async () => {
    assert.ok(existsSync(DIST), "site/dist is missing — run `node site/build.mjs` first");
    for (const locale of LOCALES) {
      strings[locale] = JSON.parse(await readFile(path.join(I18N, `${locale}.json`), "utf8")).testnet;
    }
  });

  test("every locale states all three facts", () => {
    for (const locale of LOCALES) {
      const t = strings[locale];
      assert.ok(t, `${locale}: no testnet block in i18n/${locale}.json`);
      for (const field of [...FACTS, "label"]) {
        assert.ok(t[field]?.trim(), `${locale}.${field} is empty`);
      }
    }
  });

  // "Present in eleven files" and "translated into eleven languages" are different claims. A table
  // filled by copying English would satisfy the first and fail every reader of the other ten.
  test("the other ten are translated, not English pasted", () => {
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      for (const field of FACTS) {
        assert.notEqual(
          strings[locale][field],
          strings.en[field],
          `${locale}.${field} is byte-identical to English`,
        );
      }
    }
  });

  test("the notice reaches the home page of all eleven locales", async () => {
    for (const locale of LOCALES) {
      const html = await readFile(homeOf(locale), "utf8");
      for (const field of FACTS) {
        assert.ok(
          html.includes(escapeHtml(strings[locale][field])),
          `${locale} home page is missing ${field}`,
        );
      }
    }
  });

  // Not just the landing page: the pages that actually show a balance are the deep ones a reader
  // arrives at from a search result, having never seen the home page.
  test("it is on deep pages too, in the page's own locale", async () => {
    for (const [locale, slug] of [
      ["en", "quickstart"],
      ["ja", "quickstart"],
      ["ar", "quickstart"],
      ["zh-CN", "api-reference"],
    ]) {
      const file =
        locale === "en"
          ? path.join(DIST, slug, "index.html")
          : path.join(DIST, locale, slug, "index.html");
      assert.ok(existsSync(file), `${file} was not built`);
      const html = await readFile(file, "utf8");
      assert.ok(
        html.includes(escapeHtml(strings[locale].mayReset)),
        `${locale}/${slug} is missing the reset warning`,
      );
    }
  });

  // A notice with a close button is a notice that is closed exactly when it matters.
  test("there is no way to dismiss it", async () => {
    const html = await readFile(homeOf("en"), "utf8");
    const block = html.slice(html.indexOf('<aside class="testnet"'));
    const notice = block.slice(0, block.indexOf("</aside>"));
    assert.ok(notice.length > 0, "the notice markup is not on the page");
    assert.ok(!/<button|<a\s/u.test(notice), "the notice contains a control");
  });

  // `Copy for AI` is how a model ingests a page. A model that reads the balances without the three
  // facts reasons about them as money, with more leverage than a person would.
  test("the markdown twin carries it as well", async () => {
    const md = await readFile(path.join(DIST, "quickstart.md"), "utf8");
    assert.ok(md.includes(strings.en.headline), "quickstart.md has no test-network statement");
  });
});
