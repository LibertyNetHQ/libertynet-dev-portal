#!/usr/bin/env node
/**
 * Does the site actually work in a browser?
 *
 *     node site/test/smoke.browser.mjs
 *
 * This exists because of a bug that every other check here missed completely.
 *
 * `site.js` is assembled inside a template literal, and a newline escape meant
 * for the output was consumed by the build instead — leaving a real line break
 * inside a string literal. That is a parse error, and a browser abandons the
 * whole script file on a parse error. So the language switcher, the theme
 * toggle, the search box and the Copy-for-AI button were **all dead on every
 * page, in production**, while twenty test suites stayed green: every one of
 * them asserted about files, HTML and HTTP status, and not one of them ever
 * asked a browser to run the page.
 *
 * Checking that a file exists is not checking that it works. These four
 * assertions are the smallest set that would have caught it:
 *
 *   1. no console errors — the parse error itself
 *   2. the theme toggle changes the DOM and the painted colour
 *   3. the language dropdown really navigates and `lang` really changes
 *   4. Copy-for-AI really produces the page's markdown
 *
 * Playwright is a devDependency and nothing ships it. The site itself stays
 * dependency-free; the test that drives a browser needs a browser.
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.LN_SMOKE_PORT ?? 4173);

// Point at production to check what is actually deployed rather than what this
// checkout builds:  LN_SMOKE_BASE=https://docs.libertynet.ai node …
const BASE = process.env.LN_SMOKE_BASE ?? `http://127.0.0.1:${PORT}`;
const LOCAL = !process.env.LN_SMOKE_BASE;

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// serve the built site
// ---------------------------------------------------------------------------

/**
 * A plain static server over `site/dist`.
 *
 * Deliberately not `build.mjs --serve`: this test must run against the same
 * artifact CI deploys, not against a fresh in-process build that could differ.
 */
const server = !LOCAL ? null : spawn(
  process.execPath,
  [
    "-e",
    `
    const http = require("node:http");
    const fs = require("node:fs");
    const path = require("node:path");
    const root = ${JSON.stringify(path.join(ROOT, "site/dist"))};
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8", ".json": "application/json", ".md": "text/markdown; charset=utf-8",
      ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".xml": "application/xml",
      ".yaml": "text/yaml; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };
    http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      let file = path.join(root, p);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      try {
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
        else if (!fs.existsSync(file) && fs.existsSync(file + "/index.html")) file = file + "/index.html";
        if (!fs.existsSync(file)) { res.writeHead(404).end("not found"); return; }
        res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
        res.end(fs.readFileSync(file));
      } catch (e) { res.writeHead(500).end(String(e)); }
    }).listen(${PORT}, "127.0.0.1");
    `,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let serverErr = "";
server?.stderr.on("data", (d) => (serverErr += d));

// Wait for it rather than sleeping a guessed interval.
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${BASE}/quickstart`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
  if (i === 59) {
    console.error(`\n✗ static server never came up on ${PORT}\n${serverErr}\n`);
    server?.kill();
    process.exit(1);
  }
}

const browser = await chromium.launch();

try {
  // -------------------------------------------------------------------------
  // 1. no console errors anywhere that matters
  // -------------------------------------------------------------------------

  const PAGES = [
    "/",
    "/quickstart",
    "/download",
    "/status",
    "/reference/errors",
    "/zh-CN/quickstart",
    "/ar/quickstart",       // RTL
    "/de/concepts/identity", // English fallback under a locale prefix
  ];

  const errorsByPage = [];

  for (const url of PAGES) {
    const page = await browser.newPage();
    const errors = [];

    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    // An uncaught exception never reaches console.error, so listen for both.
    page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`));

    await page.goto(BASE + url, { waitUntil: "networkidle" });
    if (errors.length) errorsByPage.push(`${url}: ${errors[0]}`);
    await page.close();
  }

  check(
    `no console errors across ${PAGES.length} pages`,
    errorsByPage.length === 0,
    errorsByPage.length ? errorsByPage.join(" | ") : "clean",
  );

  // -------------------------------------------------------------------------
  // 2. the theme toggle really changes the theme
  // -------------------------------------------------------------------------

  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/quickstart`, { waitUntil: "networkidle" });

    const before = await page.getAttribute("html", "data-theme");
    const bgBefore = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.click("[data-theme-toggle]");

    const after = await page.getAttribute("html", "data-theme");
    const bgAfter = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    // Both halves matter. The attribute alone can flip while the stylesheet
    // ignores it, which looks like a working toggle and repaints nothing.
    check(
      "theme toggle changes both the attribute and the painted colour",
      before !== after && bgBefore !== bgAfter,
      `${before}→${after}, ${bgBefore}→${bgAfter}`,
    );

    await page.close();
  }

  // -------------------------------------------------------------------------
  // 3. the languages in the menu really navigate — and the ones not in the
  //    menu are still reachable
  // -------------------------------------------------------------------------

  // The menu offers only locales with translated prose. Nine others still
  // route, still have a translated interface, and still fall back to English
  // with a notice — so both halves get asserted. Dropping the second half when
  // the menu shrank would have quietly stopped testing nine tenths of the
  // locales while the suite still reported green, which is the exact move this
  // file exists to prevent.
  const IN_MENU = [
    { code: "en", prefix: "", lang: "en-US" },
    { code: "zh-CN", prefix: "/zh-CN", lang: "zh-CN" },
  ];

  const NOT_IN_MENU = [
    { code: "zh-TW", prefix: "/zh-TW", lang: "zh-TW" },
    { code: "ja", prefix: "/ja", lang: "ja-JP" },
    { code: "ko", prefix: "/ko", lang: "ko-KR" },
    { code: "es", prefix: "/es", lang: "es-ES" },
    { code: "pt", prefix: "/pt", lang: "pt-BR" },
    { code: "de", prefix: "/de", lang: "de-DE" },
    { code: "fr", prefix: "/fr", lang: "fr-FR" },
    { code: "ar", prefix: "/ar", lang: "ar-SA" },
    { code: "hi", prefix: "/hi", lang: "hi-IN" },
  ];

  const langProblems = [];

  for (const loc of IN_MENU) {
    const page = await browser.newPage();
    await page.goto(`${BASE}/quickstart`, { waitUntil: "networkidle" });

    // Caught rather than thrown: when the handler is dead — which is exactly
    // the failure this file exists for — the navigation simply never happens,
    // and an uncaught timeout aborts the run with a stack trace instead of
    // saying which languages broke.
    try {
      await Promise.all([
        page.waitForURL(`**${loc.prefix}/quickstart`, { timeout: 15_000 }),
        page.selectOption("[data-lang-switch]", loc.code),
      ]);

      const url = new URL(page.url()).pathname;
      const lang = await page.getAttribute("html", "lang");
      const expected = `${loc.prefix}/quickstart`;

      if (url !== expected) langProblems.push(`${loc.code}: went to ${url}, expected ${expected}`);
      else if (lang !== loc.lang) langProblems.push(`${loc.code}: lang="${lang}", expected "${loc.lang}"`);
    } catch (e) {
      langProblems.push(
        `${loc.code}: never navigated (${e.name}) — the switcher's handler did not run`,
      );
    }

    await page.close();
  }

  check(
    `both menu languages navigate and set html lang`,
    langProblems.length === 0,
    langProblems.length ? langProblems.join(" | ") : "en, zh-CN",
  );

  // The menu must not offer a language whose prose is untranslated — that is
  // the promise the whole change is making.
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/quickstart`, { waitUntil: "networkidle" });
    const offered = await page.$$eval("[data-lang-switch] option", (os) => os.map((o) => o.value));
    await page.close();

    check(
      "the menu offers only languages with translated prose",
      offered.join(",") === "en,zh-CN",
      offered.join(", "),
    );
  }

  // Removed from a dropdown is not removed from the site.
  const reachProblems = [];

  for (const loc of NOT_IN_MENU) {
    const page = await browser.newPage();
    const res = await page.goto(`${BASE}${loc.prefix}/quickstart`, { waitUntil: "networkidle" });

    const lang = await page.getAttribute("html", "lang");
    if (res.status() !== 200) reachProblems.push(`${loc.code}: HTTP ${res.status()}`);
    else if (lang !== loc.lang) reachProblems.push(`${loc.code}: lang="${lang}"`);

    // A reader who lands here must be able to see and leave the language they
    // are in, so the current locale is added to the menu even when it is below
    // the line.
    const offered = await page.$$eval("[data-lang-switch] option", (os) => os.map((o) => o.value));
    if (!offered.includes(loc.code)) {
      reachProblems.push(`${loc.code}: not selectable while reading it (${offered.join(",")})`);
    }

    await page.close();
  }

  check(
    `all ${NOT_IN_MENU.length} non-menu locales still open and can be left`,
    reachProblems.length === 0,
    reachProblems.length ? reachProblems.join(" | ") : "reachable by URL, self-selectable",
  );

  // An untranslated page must say so. That notice is the whole reason falling
  // back to English is acceptable rather than a silent bait-and-switch.
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/ja/concepts/identity`, { waitUntil: "networkidle" });
    const notice = await page.$(".i18n-notice");
    const text = notice ? (await notice.innerText()).trim() : "";
    await page.close();

    check(
      "an untranslated page shows the fallback notice",
      Boolean(notice) && text.length > 20,
      text.slice(0, 52).replace(/\s+/g, " ") || "no notice found",
    );
  }

  // Arabic must additionally flip direction, or the layout is only pretending.
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/ar/quickstart`, { waitUntil: "networkidle" });
    const dir = await page.getAttribute("html", "dir");
    check("Arabic sets dir=rtl", dir === "rtl", `dir="${dir}"`);
    await page.close();
  }

  // -------------------------------------------------------------------------
  // 4. Copy-for-AI really produces the page
  // -------------------------------------------------------------------------

  {
    const page = await browser.newPage();
    const context = page.context();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`${BASE}/quickstart`, { waitUntil: "networkidle" });

    await page.click("[data-copy-page]");
    // The handler fetches the .md twin before writing; give it a moment.
    await page.waitForTimeout(1500);

    const copied = await page.evaluate(() => navigator.clipboard.readText());

    check(
      "Copy for AI writes the page's markdown to the clipboard",
      copied.length > 1000 && copied.startsWith("Source: ") && /# Quickstart/.test(copied),
      `${copied.length} bytes, starts "${copied.slice(0, 46).replace(/\n/g, "⏎")}…"`,
    );

    check(
      "…with the source URL on its own line, not glued to the heading",
      /^Source: \S+\n\n# /.test(copied),
      copied.slice(0, 60).replace(/\n/g, "⏎"),
    );

    await page.close();
  }
} finally {
  await browser.close();
  server?.kill();
}

console.log(
  `\n${failures === 0 ? "✓" : "✗"} ${results.length - failures}/${results.length} browser checks passed\n`,
);
process.exit(failures === 0 ? 0 : 1);
