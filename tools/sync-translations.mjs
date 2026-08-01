#!/usr/bin/env node
/**
 * Regenerate the translation coverage table from the files on disk.
 *
 *     node tools/sync-translations.mjs           # write
 *     node tools/sync-translations.mjs --check   # fail if it drifted
 *
 * The language dropdown lists eleven languages, which reads as "this site is
 * available in eleven languages". It is not: one language has about a quarter
 * of the pages and the other nine have one page each. Every individual page
 * says so when it falls back, but nobody assembles those notices into the
 * overall number, and the overall number is the impression the dropdown gives.
 *
 * So the figure is published, and it is counted rather than written down —
 * a hand-maintained percentage is a claim that starts true and quietly stops
 * being true the first time anyone adds a page.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES, DEFAULT_LOCALE } from "../site/build/locales.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs-site");
const PAGE = path.join(DOCS, "translations.mdx");

// Markers rather than a snippet import: this site's renderer does not resolve
// `import X from '/snippets/…'`, it just drops the component — so the first
// version of this published a page with the table silently missing, which is
// a particularly bad way to fail on a page whose whole point is honest numbers.
const BEGIN = "{/* BEGIN generated coverage — tools/sync-translations.mjs */}";
const END = "{/* END generated coverage */}";
const CHECK = process.argv.includes("--check");

const LOCALE_DIRS = new Set(LOCALES.map((l) => l.code).filter((c) => c !== DEFAULT_LOCALE));

async function pagesUnder(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["snippets", "logo", "images", "node_modules"].includes(e.name)) continue;
      if (dir === base && LOCALE_DIRS.has(e.name)) continue;   // locale trees counted separately
      await pagesUnder(full, base, out);
    } else if (e.name.endsWith(".mdx")) {
      out.push(path.relative(base, full).replace(/\.mdx$/, ""));
    }
  }
  return out;
}

const english = await pagesUnder(DOCS);
const total = english.length;

const rows = [];
for (const locale of LOCALES) {
  if (locale.code === DEFAULT_LOCALE) continue;
  const translated = await pagesUnder(path.join(DOCS, locale.code));
  const pct = Math.round((translated.length / total) * 100);
  rows.push({ ...locale, count: translated.length, pct });
}

/**
 * A word for the state, so the number does not have to be interpreted.
 *
 * "3%" is precise and tells a reader nothing about what to expect when they
 * click. "Interface only" does: the menus are translated, the pages are not.
 */
function stateOf(pct) {
  if (pct >= 100) return "**Complete**";
  if (pct >= 50) return "Mostly translated";
  if (pct > 3) return "In progress";
  return "Interface only";
}

const table = [
  BEGIN,
  "",
  "| Language | Pages translated | Coverage | What to expect |",
  "|---|---|---|---|",
  `| English | ${total} / ${total} | 100% | **Complete** — this is the source |`,
  ...rows.map(
    (r) => `| ${r.label} | ${r.count} / ${total} | ${r.pct}% | ${stateOf(r.pct)} |`,
  ),
  "",
  END,
].join("\n");

const page = await readFile(PAGE, "utf8");
const start = page.indexOf(BEGIN);
const stop = page.indexOf(END);

if (start === -1 || stop === -1) {
  console.error(`\n✗ ${path.relative(ROOT, PAGE)} has no generated-coverage markers.\n`);
  process.exit(1);
}

const updated = page.slice(0, start) + table + page.slice(stop + END.length);

if (CHECK) {
  if (page !== updated) {
    console.error(
      `\n✗ the translation coverage table in docs-site/translations.mdx is out of date.\n` +
        `  Run: node tools/sync-translations.mjs\n`,
    );
    process.exit(1);
  }
  console.log(`  · translation coverage matches the files on disk (${total} English pages)`);
  process.exit(0);
}

await writeFile(PAGE, updated);
console.log(`✓ wrote translation coverage: ${total} English pages`);
for (const r of rows) console.log(`  ${r.code.padEnd(6)} ${r.count}/${total} (${r.pct}%)`);
