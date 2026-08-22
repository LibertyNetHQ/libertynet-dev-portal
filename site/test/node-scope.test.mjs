/**
 * "What this node does" — checked against what actually gets served.
 *
 * A5 external verification, 2026-08-20: a stranger followed these docs on a clean machine,
 * installed a node, bound it, watched it go active in the registry — and it could not receive a
 * compute task and never would. Nothing on this site said so, and several pages invite you to
 * install a node and contribute. The scope note is the correction.
 *
 * The assertions read `site/dist`, not the source, for the same reason the testnet ones do: a
 * string that exists in `i18n/ar.json` and never reaches `dist/ar/download.html` is precisely the
 * failure being guarded against.
 *
 * Two properties beyond "it is present":
 *
 *   - **Every locale gets its own wording.** These pages are English-only in the body; a reader
 *     following them in Arabic must still get this in Arabic. So each locale must carry its own
 *     text and must NOT fall back to the English.
 *   - **It is not a footnote.** The note must appear before the install command it qualifies.
 *     A correction placed after the instructions is read by nobody who followed them.
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
const FACTS = ["headline", "does", "doesNot", "planned"];

/** The pages that tell someone to run a node. Kept explicit: this note belongs where the
 *  instruction is, not on the API reference. */
const SCOPED = ["download", "guides/service-agent", "concepts/nodes-and-discovery"];

/** The build emits directory-style URLs: `download/index.html`, not `download.html`. */
function pageOf(locale, slug) {
  const base = locale === "en" ? DIST : path.join(DIST, locale);
  return path.join(base, slug, "index.html");
}

function escapeHtml(s) {
  return s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

const strings = {};

before(async () => {
  if (!existsSync(DIST)) {
    throw new Error("site/dist is missing — run `node site/build.mjs` before the tests");
  }
  for (const l of LOCALES) {
    strings[l] = JSON.parse(await readFile(path.join(I18N, `${l}.json`), "utf8"));
  }
});

describe("the node scope note reaches the reader", () => {
  test("every locale defines all four facts", () => {
    for (const l of LOCALES) {
      const ns = strings[l].nodeScope;
      assert.ok(ns, `${l}.json has no nodeScope block`);
      for (const f of [...FACTS, "label"]) {
        assert.ok(ns[f] && ns[f].trim().length > 0, `${l}.json nodeScope.${f} is empty`);
      }
    }
  });

  for (const slug of SCOPED) {
    for (const locale of LOCALES) {
      test(`${locale} · ${slug} carries it, in ${locale}`, async () => {
        const file = pageOf(locale, slug);
        assert.ok(existsSync(file), `${file} was not built`);
        const html = await readFile(file, "utf8");

        for (const f of FACTS) {
          assert.ok(
            html.includes(escapeHtml(strings[locale].nodeScope[f])),
            `${locale} ${slug}: nodeScope.${f} is not on the served page`,
          );
        }

        // Not the English one, unless this IS the English one. Falling back silently is the
        // failure mode that makes a translated site look finished while saying nothing.
        if (locale !== "en") {
          assert.ok(
            !html.includes(escapeHtml(strings.en.nodeScope.headline)),
            `${locale} ${slug}: fell back to the English headline`,
          );
        }
      });
    }
  }

  test("on the download page it comes before the install command", async () => {
    const html = await readFile(pageOf("en", "download"), "utf8");
    const note = html.indexOf(escapeHtml(strings.en.nodeScope.headline));
    const install = html.indexOf("install.sh");
    assert.ok(note > -1, "the scope note is not on the download page at all");
    assert.ok(install > -1, "install.sh is not on the download page — has it moved?");
    assert.ok(
      note < install,
      "the scope note appears after the install command; a correction nobody reads first is not a correction",
    );
  });

  test("the markdown twin carries it too", async () => {
    // `Copy for AI` and `curl page.md`. An assistant given the install instructions without this
    // will answer "yes, your node will earn" from the instructions alone.
    const md = await readFile(path.join(DIST, "download.md"), "utf8");
    for (const f of FACTS) {
      assert.ok(md.includes(strings.en.nodeScope[f]), `download.md is missing nodeScope.${f}`);
    }
  });

  test("pages that are not about running a node do not carry it", async () => {
    // Scope discipline: if this ends up on every page it becomes chrome, and chrome is not read.
    const html = await readFile(pageOf("en", "api-reference"), "utf8");
    assert.ok(
      !html.includes(escapeHtml(strings.en.nodeScope.headline)),
      "the scope note leaked onto the API reference",
    );
  });
});
