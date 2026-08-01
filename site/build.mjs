#!/usr/bin/env node
/**
 * Static site builder.
 *
 *     node site/build.mjs            # build to site/dist
 *     node site/build.mjs --serve    # build, then serve on :4000
 *
 * Renders the `docs-site/**.mdx` sources into a self-contained static site — no
 * vendor account, no build service, no runtime. That matters for more than cost:
 * it means `docs.libertynet.ai` can go live the moment DNS points at a box we
 * already run, rather than waiting on somebody to sign into a dashboard.
 *
 * `docs.json` stays the navigation source of truth, and the `.mdx` sources keep
 * their original component syntax, so moving to a hosted renderer later is a
 * configuration change rather than a rewrite.
 *
 * Locale handling: English lives at the root (`/quickstart`), every other locale
 * under its code (`/ja/quickstart`). A page with no translation falls back to the
 * English body with a visible notice — never a 404, and never stale content
 * pretending to be current.
 */

import { readFile, readdir, mkdir, writeFile, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { DEFAULT_LOCALE, LOCALES, byCode } from "./build/locales.mjs";
import { parseFrontmatter, renderBlocks, toPlainText } from "./build/mdx.mjs";
import { escapeHtml } from "./build/highlight.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const DOCS = path.join(ROOT, "docs-site");
const OUT = path.join(HERE, "dist");
const SITE_URL = "https://docs.libertynet.ai";

const warnings = [];

/**
 * Content-hashed asset URLs, filled in before any page is rendered.
 *
 * `/site.js` and `/theme.css` used to be served from stable URLs with
 * `max-age=3600`. That meant a visitor who loaded a broken build kept it for up
 * to an hour *after* the server was fixed — fresh HTML, stale script — so a
 * server-side check and a real returning user could honestly disagree about
 * whether the site worked. Every measurement was correct; they were measuring
 * different things.
 *
 * With the hash in the filename a new build is a new URL, so a cached copy can
 * never be reused for changed content, and the file can then be cached hard
 * rather than for a nervous hour.
 */
const assets = { js: "/site.js", css: "/theme.css" };

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

const LOCALE_CODES = new Set(LOCALES.map((l) => l.code));

async function walk(dir, base = dir, out = []) {
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
      await walk(full, base, out);
    } else if (e.name.endsWith(".mdx")) {
      out.push(path.relative(base, full).replace(/\.mdx$/, ""));
    }
  }
  return out;
}

/**
 * Build the page table: slug → { locale → source path }.
 *
 * Root-level `.mdx` files are English. A top-level directory whose name is a
 * locale code holds that locale's translations.
 */
async function collectPages() {
  const all = await walk(DOCS);
  const pages = new Map();

  for (const rel of all) {
    const parts = rel.split("/");
    const maybeLocale = parts[0];

    const locale = LOCALE_CODES.has(maybeLocale) && maybeLocale !== DEFAULT_LOCALE ? maybeLocale : DEFAULT_LOCALE;
    const slug = locale === DEFAULT_LOCALE ? rel : parts.slice(1).join("/");

    if (!pages.has(slug)) pages.set(slug, {});
    pages.get(slug)[locale] = path.join(DOCS, `${rel}.mdx`);
  }
  return pages;
}

/** Navigation, from docs.json, per locale, falling back to the English tree. */
async function loadNavigation() {
  const config = JSON.parse(await readFile(path.join(DOCS, "docs.json"), "utf8"));
  const groups = [];

  const langs = config.navigation?.languages ?? [];
  const en = langs.find((l) => l.language === "en") ?? langs[0];

  for (const group of en?.groups ?? []) {
    if (!group.pages) continue;   // OpenAPI-generated groups have no .mdx pages
    groups.push({ title: group.group, pages: group.pages });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function localePrefix(locale) {
  return locale === DEFAULT_LOCALE ? "" : `/${locale}`;
}

function href(slug, locale) {
  const prefix = localePrefix(locale);
  return slug === "index" ? `${prefix}/` : `${prefix}/${slug}`;
}

const MARK = `<svg class="mark" width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round"><path d="M16 5.5 A10.5 10.5 0 0 1 25.7 12" stroke-width="2"/><path d="M16 26.5 A10.5 10.5 0 0 1 6.3 20" stroke-width="2"/><path d="M23.4 8.6 A10.5 10.5 0 0 1 22 23.9" stroke-width="1.4" opacity=".6"/></g><circle cx="16" cy="16" r="3" fill="currentColor"/></svg>`;

function sidebar(nav, slug, locale, pages, strings) {
  let out = "";
  for (const group of nav) {
    const items = group.pages.filter((p) => pages.has(p));
    if (!items.length) continue;

    // Group titles come from docs.json, which is English. They were rendered
    // untranslated in every locale while /translations claimed navigation was
    // fully translated — an overclaim on the page whose entire job is not
    // overclaiming. Falls back to the English title if a locale lacks one,
    // rather than rendering an empty heading.
    const title = strings.navGroups?.[group.title] ?? group.title;
    out += `<div class="side__group"><div class="side__title">${escapeHtml(title)}</div>`;
    for (const p of items) {
      const meta = pages.get(p);
      out += `<a href="${href(p, locale)}"${p === slug ? ' aria-current="page"' : ""}><bdi>${escapeHtml(meta.navTitle)}</bdi></a>`;
    }
    out += "</div>";
  }
  return out;
}

function tocHtml(headings, strings) {
  const items = headings.filter((h) => h.level >= 2);
  if (items.length < 2) return "";

  let out = `<div class="toc__title">${escapeHtml(strings.nav.onThisPage)}</div>`;
  for (const h of items) {
    out += `<a href="#${h.id}" class="${h.level === 3 ? "lvl3" : ""}"><bdi>${escapeHtml(h.text)}</bdi></a>`;
  }
  return out;
}

function languageSwitcher(slug, locale, pages, strings) {
  // Options for languages that have no translation of *this* page say so, in
  // words, in the reader's current language.
  //
  // The marker used to be a bare "·", which is information only to whoever
  // wrote it. Naming the fallback outright — "Deutsch (auf Englisch)" — means
  // the reader knows what they will get before they choose, and the control
  // needs no legend to explain itself.
  const options = LOCALES.map((l) => {
    const has = Boolean(pages.get(slug)?.sources?.[l.code]);
    const label = escapeHtml(l.label) + (has ? "" : escapeHtml(strings.nav.untranslatedSuffix));
    return `<option value="${l.code}"${l.code === locale ? " selected" : ""}>${label}</option>`;
  }).join("");

  return (
    `<select class="control" data-lang-switch aria-label="${escapeHtml(strings.nav.language)}" ` +
    `title="${escapeHtml(strings.nav.languageHint)}" ` +
    `data-slug="${escapeHtml(slug)}">${options}</select>`
  );
}

/**
 * How many top-level sections the English page has that this translation does
 * not.
 *
 * Counting `##` headings rather than diffing prose: a translation is allowed to
 * be shorter — languages differ, and a good translator cuts padding — but it is
 * not allowed to be missing a step. Comparing structure catches "the English
 * page grew a section" while staying quiet about ordinary length differences.
 */
function sectionsBehind(english, translation) {
  if (!english || english === translation) return 0;
  // Both levels. The error dictionary lists each code as an h3, so counting
  // only h2 said "complete" about a page missing seven error codes.
  const count = (src) => (src.body.match(/^#{2,3}\s+\S/gm) ?? []).length;
  return Math.max(0, count(english) - count(translation));
}

function shell({ slug, locale, meta, body, headings, nav, pages, strings, prev, next, translated, behind = 0 }) {
  const l = byCode[locale];
  const prefix = localePrefix(locale);
  const canonical = `${SITE_URL}${href(slug, locale)}`;

  const alternates = LOCALES.map(
    (x) => `<link rel="alternate" hreflang="${x.intl}" href="${SITE_URL}${href(slug, x.code)}">`,
  ).join("") + `<link rel="alternate" hreflang="x-default" href="${SITE_URL}${href(slug, DEFAULT_LOCALE)}">`;

  const contribute = "https://github.com/LibertyNetHQ/libertynet-dev-portal/tree/main/docs-site";

  // Three states, not two. A page can be untranslated, translated, or — the
  // case this site had no word for — translated a while ago and since left
  // behind by the English original.
  //
  // Every one of the ten quickstart translations was missing the step that
  // proves the loop closes, added to the English page in a later pass. They
  // rendered as finished translations, because "has a file" was the only test.
  const notice = !translated
    ? `<div class="i18n-notice"><strong>${escapeHtml(strings.translation.missingTitle)}</strong>` +
      `${escapeHtml(strings.translation.missingBody.replace("{language}", l.label))} ` +
      `<a href="${contribute}">${escapeHtml(strings.translation.helpTranslate)}</a> · ` +
      // Link the overall picture from the individual notice. Read one at a
      // time these notices look like exceptions; for nine of the ten languages
      // they are the normal case, and the reader deserves to find that out
      // here rather than by opening page after page.
      `<a href="${href("translations", locale)}">${escapeHtml(strings.translation.statusLink)}</a></div>`
    : behind > 0
      ? `<div class="i18n-notice"><strong>${escapeHtml(strings.translation.staleTitle)}</strong>` +
        `${escapeHtml(strings.translation.staleBody.replace("{n}", String(behind)))} ` +
        `<a href="${href(slug, DEFAULT_LOCALE)}">${escapeHtml(strings.translation.viewOriginal)}</a> · ` +
        `<a href="${contribute}">${escapeHtml(strings.translation.helpTranslate)}</a></div>`
      : "";

  const pager =
    prev || next
      ? `<nav class="pager">` +
        (prev ? `<a href="${href(prev.slug, locale)}"><small>${escapeHtml(strings.nav.previous)}</small>${escapeHtml(prev.title)}</a>` : "<span></span>") +
        (next ? `<a class="next" href="${href(next.slug, locale)}"><small>${escapeHtml(strings.nav.next)}</small>${escapeHtml(next.title)}</a>` : "<span></span>") +
        `</nav>`
      : "";

  const toc = tocHtml(headings, strings);

  return `<!doctype html>
<html lang="${l.intl}" dir="${l.dir}" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(meta.title)} — ${escapeHtml(strings.meta.siteName)}</title>
<meta name="description" content="${escapeHtml(meta.description ?? strings.meta.tagline)}">
<link rel="canonical" href="${canonical}">
${alternates}
<meta property="og:site_name" content="${escapeHtml(strings.meta.siteName)}">
<meta property="og:title" content="${escapeHtml(meta.title)}">
<meta property="og:description" content="${escapeHtml(meta.description ?? strings.meta.tagline)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${assets.css}">
<script>
/* Applied before first paint: no theme flash, no direction flash.
   Dark is the default rather than "system": the pure-black ground is the brand,
   not a preference. Light is one click away and the choice is remembered. */
(function(){try{
  var m=document.cookie.match(/(?:^|; )LN_THEME=([^;]*)/);
  var pref=m?decodeURIComponent(m[1]):"dark";
  var t=(pref==="light"||pref==="dark")?pref:(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");
  document.documentElement.setAttribute("data-theme",t);
}catch(e){}})();
</script>
</head>
<body>
<header class="top">
  <div class="top__inner">
    <button class="control menu-toggle" data-menu aria-label="${escapeHtml(strings.nav.menu)}">☰</button>
    <a class="brand" href="${prefix || "/"}">${MARK}<span>Liberty<b>Net</b></span><span class="brand__tag">${escapeHtml(strings.meta.siteName)}</span></a>
    <div class="top__spacer"></div>
    <div class="search">
      <input type="search" data-search placeholder="${escapeHtml(strings.nav.searchPlaceholder)}" aria-label="${escapeHtml(strings.nav.search)}" autocomplete="off">
      <div class="search__results" data-search-results></div>
    </div>
    ${languageSwitcher(slug, locale, pages, strings)}
    <button class="control" data-theme-toggle aria-label="${escapeHtml(strings.nav.theme)}">◐</button>
  </div>
</header>

<div class="layout">
  <nav class="side" data-side>${sidebar(nav, slug, locale, localeIndex(pages, locale), strings)}</nav>
  <main>
    ${notice}
    <article${articleDir(locale, translated)}>
      <div class="page-head">
        <h1>${escapeHtml(meta.title)}</h1>
        <button class="control copy-page" data-copy-page="${escapeHtml(slug === "index" ? "index" : slug)}.md"
                title="${escapeHtml(strings.nav.copyForAITitle)}">${escapeHtml(strings.nav.copyForAI)}</button>
      </div>
      ${meta.description ? `<p class="lead">${escapeHtml(meta.description)}</p>` : ""}
      ${body}
    </article>
    ${pager}
  </main>
  <aside class="toc">${toc}</aside>
</div>

<footer class="site">
  <div class="footer__inner">
    <div class="footer__note">${MARK}<p>${escapeHtml(strings.footer.builtWith)}</p></div>
    <div>
      <h4>${escapeHtml(strings.footer.developers)}</h4>
      <a href="${prefix}/quickstart">Quickstart</a>
      <a href="${prefix}/status">Status</a>
      <a href="${prefix}/reference/errors">Errors</a>
    </div>
    <div>
      <h4>${escapeHtml(strings.footer.community)}</h4>
      <a href="https://github.com/LibertyNetHQ/libertynet-dev-portal">GitHub</a>
      <a href="${prefix}/community">Community</a>
      <a href="https://github.com/LibertyNetHQ/libertynet-dev-portal/issues">${escapeHtml(strings.footer.reportIssue)}</a>
    </div>
  </div>
</footer>

<script src="${assets.js}" defer></script>
</body>
</html>`;
}

/**
 * Direction for the article body.
 *
 * When an RTL locale falls back to the English original, the *chrome* is still
 * Arabic and stays RTL, but the prose is English and must declare itself LTR.
 * Without this the bidi algorithm relocates trailing punctuation — a paragraph
 * ending "no dependencies." renders as ".no dependencies" — which looks like a
 * typesetting bug to every reader who can read it.
 */
function articleDir(locale, translated) {
  if (translated || byCode[locale].dir !== "rtl") return "";
  return ` lang="${byCode[DEFAULT_LOCALE].intl}" dir="ltr" class="fallback-ltr"`;
}

/** Sidebar needs title + availability per locale. */
function localeIndex(pages, locale) {
  const index = new Map();
  for (const [slug, entry] of pages) {
    index.set(slug, { navTitle: entry.titles[locale] ?? entry.titles[DEFAULT_LOCALE] ?? slug });
  }
  return index;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

async function build() {
  const started = Date.now();

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const strings = {};
  for (const l of LOCALES) {
    strings[l.code] = JSON.parse(await readFile(path.join(HERE, `i18n/${l.code}.json`), "utf8"));
  }

  // Hash the assets before anything renders — every page's <script> and <link>
  // is written from `assets`, so this has to be settled first.
  //
  // Parse the client script before writing it. site.js is assembled inside a
  // template literal, which means an escape sequence written for the *output*
  // is silently interpreted by the *build* instead. That shipped once: a `\n`
  // became a real newline inside a string literal, and since a browser abandons
  // a whole script file on a parse error, the language switcher, the theme
  // toggle, the search box and the copy button were all dead on every page —
  // while every test passed, because nothing asked whether the generated file
  // was JavaScript. `new Function` compiles without executing, which is exactly
  // the question.
  try {
    new Function(CLIENT_JS);
  } catch (err) {
    throw new Error(
      `site.js is not valid JavaScript: ${err.message}\n` +
        `  The usual cause is an escape sequence in CLIENT_JS that the outer ` +
        `template literal consumed.`,
    );
  }

  const cssSource = await readFile(path.join(HERE, "build/theme.css"), "utf8");
  const cssHash = createHash("sha256").update(cssSource).digest("hex").slice(0, 10);
  const jsHash = createHash("sha256").update(CLIENT_JS).digest("hex").slice(0, 10);

  assets.css = `/theme.${cssHash}.css`;
  assets.js = `/site.${jsHash}.js`;

  await writeFile(path.join(OUT, `theme.${cssHash}.css`), cssSource);
  await writeFile(path.join(OUT, `site.${jsHash}.js`), CLIENT_JS);

  // The unhashed names stay as copies. An HTML page cached by a browser before
  // this change still asks for /site.js and /theme.css, and a 404 there would
  // break exactly the readers this change exists to protect.
  await writeFile(path.join(OUT, "theme.css"), cssSource);
  await writeFile(path.join(OUT, "site.js"), CLIENT_JS);

  const nav = await loadNavigation();
  const sources = await collectPages();

  // Pre-read every source so titles are available for navigation in all locales.
  const pages = new Map();
  for (const [slug, bySource] of sources) {
    const titles = {};
    const metas = {};
    for (const [locale, file] of Object.entries(bySource)) {
      const { meta, body } = parseFrontmatter(await readFile(file, "utf8"));
      titles[locale] = meta.sidebarTitle ?? meta.title ?? slug;
      metas[locale] = { meta, body };
    }
    pages.set(slug, { titles, metas, sources: bySource });
  }

  // Page order for prev/next, taken from the navigation.
  const order = nav.flatMap((g) => g.pages).filter((p) => pages.has(p));

  const searchIndex = {};
  let written = 0;

  for (const l of LOCALES) {
    const locale = l.code;
    const s = strings[locale];
    searchIndex[locale] = [];

    for (const [slug, entry] of pages) {
      const translated = Boolean(entry.metas[locale]);
      const source = entry.metas[locale] ?? entry.metas[DEFAULT_LOCALE];
      if (!source) continue;

      const ctx = {
        strings: s,
        rtl: l.dir === "rtl",
        localePrefix: localePrefix(locale),
        locale,
      };

      const { html, headings } = renderBlocks(source.body, ctx);

      const pos = order.indexOf(slug);
      const prev = pos > 0 ? { slug: order[pos - 1], title: entry.titles[locale] ?? order[pos - 1] } : null;
      const next =
        pos !== -1 && pos < order.length - 1
          ? { slug: order[pos + 1], title: pages.get(order[pos + 1]).titles[locale] ?? order[pos + 1] }
          : null;

      if (prev) prev.title = pages.get(order[pos - 1]).titles[locale] ?? order[pos - 1];

      const page = shell({
        slug,
        locale,
        meta: source.meta,
        body: html,
        headings,
        nav,
        pages,
        strings: s,
        prev,
        next,
        translated,
        behind: translated ? sectionsBehind(entry.metas[DEFAULT_LOCALE], source) : 0,
      });

      const outPath =
        slug === "index"
          ? path.join(OUT, localePrefix(locale), "index.html")
          : path.join(OUT, localePrefix(locale), slug, "index.html");

      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, page);
      written++;

      // Markdown twin, for `curl page.md`, the Copy-for-AI button and any client
      // that would rather read prose than HTML.
      const markdown = toMarkdown(source, strings[locale]);

      const mdPath = path.join(OUT, localePrefix(locale), `${slug}.md`);
      await mkdir(path.dirname(mdPath), { recursive: true });
      await writeFile(mdPath, markdown + "\n");

      searchIndex[locale].push({
        s: slug,
        t: source.meta.title,
        d: source.meta.description ?? "",
        b: toPlainText(source.body).slice(0, 1400),
        u: href(slug, locale),
      });
    }

    await writeFile(
      path.join(OUT, localePrefix(locale), "search.json"),
      JSON.stringify(searchIndex[locale]),
    );
  }

  // Static assets were hashed and written at the top of build().


  const favicon = path.join(DOCS, "favicon.svg");
  if (existsSync(favicon)) await cp(favicon, path.join(OUT, "favicon.svg"));
  if (existsSync(path.join(DOCS, "logo"))) {
    await cp(path.join(DOCS, "logo"), path.join(OUT, "logo"), { recursive: true });
  }

  // Machine-readable surfaces
  await writeFile(path.join(OUT, "llms.txt"), llmsTxt(pages, strings[DEFAULT_LOCALE]));
  await writeFile(
    path.join(OUT, "ai-context.txt"),
    aiContext(JSON.parse(await readFile(path.join(ROOT, "api-spec/status.json"), "utf8"))),
  );
  await writeFile(path.join(OUT, "llms-full.txt"), await llmsFull(pages, strings[DEFAULT_LOCALE]));
  await writeFile(path.join(OUT, "sitemap.xml"), sitemap(pages));
  await writeFile(
    path.join(OUT, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
  );

  const spec = path.join(ROOT, "api-spec");
  if (existsSync(spec)) await cp(spec, path.join(OUT, "api-spec"), { recursive: true });

  // Generated downloads — currently the single-file MCP bundle, which the docs
  // tell people to curl. Built by `node tools/bundle-mcp.mjs`; if it is missing
  // the build says so loudly rather than shipping a page whose install command
  // 404s, which is the same class of lie as an unbacked status badge.
  const publicDir = path.join(HERE, "public");
  if (existsSync(publicDir)) {
    await cp(publicDir, OUT, { recursive: true });
  } else {
    console.warn("  ! site/public missing — run `node tools/bundle-mcp.mjs` before deploying");
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  console.log(`\n✓ built ${written} pages across ${LOCALES.length} locales in ${elapsed}s`);
  console.log(`  ${pages.size} unique slugs → ${OUT}`);

  const translatedCount = LOCALES.map((l) => {
    const n = [...pages.values()].filter((p) => p.metas[l.code]).length;
    return `${l.code}:${n}`;
  }).join("  ");
  console.log(`  translated pages — ${translatedCount}`);

  for (const w of warnings) console.warn(`  ! ${w}`);
  return { written, pages: pages.size };
}

/**
 * MDX → markdown, for the `.md` twin of every page.
 *
 * Stripping `import` lines was not enough. The twins still carried raw JSX —
 * `<Status level="implemented" />`, `<Note>`, `<Card>`, `<Steps>` — 253 of the
 * 319 files had some. It parses, so nothing broke; it is simply the wrong thing
 * to hand a reader who asked for the prose. Worse, `<Status level="planned" />`
 * dropped into a sentence reads like decoration, when it is the single most
 * important word on the line.
 *
 * So components are not deleted, they are translated into the plainest markdown
 * that keeps their meaning: a status becomes bold text, a callout becomes a
 * blockquote with its kind named, a card becomes a link. Everything an
 * assistant needs, nothing it has to decode.
 */
function toMarkdown(source, strings) {
  const status = strings?.status ?? {};
  const callout = strings?.callout ?? {};

  const body = source.body
    // Build machinery.
    .replace(/^\s*(import|export)\s.*$/gm, "")

    // A status is the load-bearing word in the sentence it sits in. Bold, and
    // localised, so the twin says the same thing the page says.
    .replace(/<Status\s+level="([a-z_]+)"\s*\/>/g, (_, level) => `**${status[level] ?? level}**`)
    .replace(/<StatusKey\s*\/>/g, "")

    // Callouts: keep the kind, because "Warning" and "Tip" are not the same
    // claim, and quote the whole body. Matching the pair and quoting every line
    // is the point — quoting only the opening line leaves the reader unable to
    // see where a safety warning stops, which for this project's callouts is
    // the difference between "Credits are not money" and a stray sentence.
    .replace(
      /<(Note|Tip|Info|Warning|Danger|Check)>\n?([\s\S]*?)\n?<\/\1>/g,
      (_, kind, inner) => {
        const label = callout[kind.toLowerCase()] ?? kind;
        const quoted = inner
          .trim()
          .split("\n")
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n");
        return `\n> **${label}**\n>\n${quoted}\n`;
      },
    )

    // A card is a link with a title.
    .replace(/<Card\s+title="([^"]*)"[^>]*href="([^"]*)"[^>]*>/g, "\n**[$1]($2)**\n")
    .replace(/<Card\s+title="([^"]*)"[^>]*>/g, "\n**$1**\n")
    .replace(/<\/Card>/g, "")

    // An accordion is a heading over its content; hiding it in the HTML does
    // not make it less relevant to someone reading the text.
    .replace(/<Accordion\s+title="([^"]*)"[^>]*>/g, "\n**$1**\n")
    .replace(/<\/Accordion>/g, "")

    // A step is an ordered item; a tab is a labelled variant.
    .replace(/<Step\s+title="([^"]*)"[^>]*>/g, "\n**$1**\n")
    .replace(/<\/Step>/g, "")
    .replace(/<Tab\s+title="([^"]*)"[^>]*>/g, "\n**$1**\n")
    .replace(/<\/Tab>/g, "")

    // Pure layout. Nothing survives that a reader would miss.
    .replace(/<\/?(Steps|Tabs|CodeGroup|Columns|AccordionGroup|Frame|Update)(\s[^>]*)?>/g, "")

    // Self-closing anything we did not name.
    .replace(/<[A-Z]\w*[^>]*\/>/g, "")

    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");

  return [
    `# ${source.meta.title}`,
    source.meta.description ? `\n> ${source.meta.description}` : "",
    `\n${body}`,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function llmsTxt(pages, s) {
  let out = `# LibertyNet Developer Documentation\n\n> ${s.meta.tagline}\n\n`;
  out += `Honesty contract: every capability carries one of four statuses — implemented, `;
  out += `not_yet_wired, testing, planned. Most of the intended surface is NOT built. `;
  out += `There is no wallet, transfer, swap, staking or trading. Credits are a test unit, `;
  out += `not cash. Check /api-spec/status.json before writing code against anything.\n\n## Pages\n\n`;

  for (const [slug, entry] of pages) {
    const meta = entry.metas.en?.meta;
    if (!meta) continue;
    // The home page's href is "" — appending ".md" to that produced
    // `https://docs.libertynet.ai/.md`, which is not a URL at all. The twin on
    // disk is `/index.md`, and the one page every reader starts from was the
    // one entry in this file that went nowhere.
    out += `- [${meta.title}](${SITE_URL}${mdHref(slug)}): ${meta.description ?? ""}\n`;
  }

  // A model that reads only prose will confidently describe endpoints from the
  // page it happened to land on. These are the sources that settle it.
  out += `\n## Machine-readable sources\n\n`;
  out += `- [${SITE_URL}/api-spec/status.json](${SITE_URL}/api-spec/status.json): the capability matrix. Every badge on this site, both SDKs and the MCP server derive from this one file. Read it before asserting that anything works.\n`;
  out += `- [${SITE_URL}/api-spec/libertynet-v1.yaml](${SITE_URL}/api-spec/libertynet-v1.yaml): OpenAPI 3.1. Every operation carries \`x-ln-status\` from the same matrix.\n`;
  out += `- [${SITE_URL}/llms-full.txt](${SITE_URL}/llms-full.txt): every page above, concatenated, for a single fetch.\n`;
  out += `- [${SITE_URL}/mcp/libertynet-mcp.mjs](${SITE_URL}/mcp/libertynet-mcp.mjs): a zero-dependency MCP server. Six tools, including one that verifies a DID against its key arithmetically instead of by eye.\n`;
  out += `- \`https://registry.libertynet.ai/nodes\`: the live network. Answering "how many nodes are online" from any other source will be wrong.\n`;

  out += `\nEvery page above is also available as HTML at the same URL without \`.md\`.\n`;
  return out;
}

/**
 * A paste-ready primer for an assistant with no MCP and no tools.
 *
 * The advice "give your model context" is useless without the context itself,
 * and the honest version of it cannot be written by hand: a primer listing what
 * is implemented is a claim about the system, and a hand-written claim is one
 * that starts drifting the moment the matrix changes. So the capability table
 * here is generated from `status.json` at build time, exactly like every badge
 * on the site.
 *
 * Deliberately short. This is meant to be pasted into a chat window, and a
 * primer nobody pastes protects nobody.
 */
function aiContext(status) {
  const line = (e) => `  ${e.status.padEnd(14)} ${(e.method ?? "GET").padEnd(5)} ${e.path}`;

  const implemented = [];
  const unwired = [];
  const unbuilt = [];

  for (const g of status.groups) {
    for (const e of g.endpoints) {
      const row = line(e);
      if (e.status === "implemented") implemented.push(row);
      else if (e.status === "not_yet_wired") unwired.push(row);
      else unbuilt.push(row);
    }
  }

  return `LibertyNet — context for an AI assistant.
Generated from ${SITE_URL}/api-spec/status.json on ${status.verified_at}.
Paste this before asking about LibertyNet, or fetch the sources at the bottom.

WHAT THIS IS
LibertyNet is a peer-to-peer network of nodes with self-certifying identities.
Discovery is public: no API key, no signup, no account. Most of the intended
surface is NOT built, and the four statuses below are the whole truth about it.

THE STATUSES
  implemented    live on a public endpoint; you can call it right now
  not_yet_wired  the endpoint answers 200, but nothing is behind it; it returns
                 zeros and says "source": "not_yet_wired". Those zeros mean
                 "nothing is counting" — NOT "the value is zero"
  testing        code exists and its tests pass; nothing public serves it
  planned        designed, not built; there is nothing behind it

CALLABLE TODAY (${implemented.length})
${implemented.join("\n")}

ANSWERS, BUT THE NUMBERS ARE PLACEHOLDERS (${unwired.length})
${unwired.join("\n") || "  (none)"}

DO NOT WRITE CODE AGAINST THESE (${unbuilt.length})
${unbuilt.join("\n") || "  (none)"}

FACTS THAT ARE EASY TO GET WRONG
· LibertyNet has NO wallet, transfer, swap, staking, DEX or trading. No endpoint
  moves value. That is scope, not a gap — do not generate code implying otherwise.
· Credits are a TEST UNIT: not cash, not redeemable, not a claim on future value.
· A node's "status": "active" does NOT mean online. It never decays. Only
  last_seen tells you anything about freshness.
· A valid signature is NOT a valid identity. Verify id-binding FIRST — that the
  public key hashes to the DID — then the signature, then everything else.
· A DID appears as short (did:svrp:n:<8hex>) and full (did:svrp:<64hex>) for the
  same key. Comparing DID strings will split one node into two.
· Public keys arrive as hex from /nodes and base58 from /peers. Decoding one as
  the other silently produces garbage.
· There is no LibertyNet API key. Code that asks a user for one is wrong.

WHEN YOU ARE UNSURE, FETCH RATHER THAN GUESS
  ${SITE_URL}/api-spec/status.json    the capability matrix (this file's source)
  ${SITE_URL}/llms.txt                every page, with descriptions
  ${SITE_URL}/llms-full.txt           every page, in full, one fetch
  ${SITE_URL}/<page>.md               any single page as markdown
  https://registry.libertynet.ai/nodes  the live network right now

If you have MCP, use it instead of this file: ${SITE_URL}/ai/mcp
`;
}

/** The markdown twin of a page — `/index.md` for home, `/<slug>.md` otherwise. */
function mdHref(slug) {
  return slug === "index" ? "/index.md" : `${href(slug, "en")}.md`;
}

async function llmsFull(pages, strings) {
  let out = `# LibertyNet Developer Documentation (full)\n\n`;
  out += `> Every page, concatenated. Statuses are load-bearing: **implemented** can be\n`;
  out += `> called today, **not yet wired** answers with placeholder zeros, **testing** is\n`;
  out += `> not deployed anywhere public, **planned** has nothing behind it.\n`;

  for (const [slug, entry] of pages) {
    const src = entry.metas.en;
    if (!src) continue;
    // The same conversion the twins get. Emitting raw MDX here would hand the
    // single most-fetched file on the site to a model as JSX soup.
    out += `\n\n---\n\nURL: ${SITE_URL}${href(slug, "en")}\n\n${toMarkdown(src, strings)}`;
  }
  return out;
}

function sitemap(pages) {
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`;
  for (const [slug] of pages) {
    for (const l of LOCALES) {
      out += `  <url><loc>${SITE_URL}${href(slug, l.code)}</loc>\n`;
      for (const alt of LOCALES) {
        out += `    <xhtml:link rel="alternate" hreflang="${alt.intl}" href="${SITE_URL}${href(slug, alt.code)}"/>\n`;
      }
      out += `  </url>\n`;
    }
  }
  return out + "</urlset>\n";
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

const CLIENT_JS = `/* Docs site behaviour. No dependencies, no framework, no tracking. */
(function () {
  "use strict";

  var doc = document.documentElement;
  var locales = ["zh-CN","zh-TW","ja","ko","es","pt","de","fr","ar","hi"];

  function setCookie(name, value) {
    document.cookie = name + "=" + encodeURIComponent(value) + ";path=/;max-age=31536000;samesite=lax";
  }

  /* theme --------------------------------------------------------------- */
  var themeBtn = document.querySelector("[data-theme-toggle]");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = doc.getAttribute("data-theme") === "dark" ? "light" : "dark";
      doc.setAttribute("data-theme", next);
      setCookie("LN_THEME", next);
    });
  }

  /* language ------------------------------------------------------------ */
  var langSel = document.querySelector("[data-lang-switch]");
  if (langSel) {
    langSel.addEventListener("change", function () {
      var code = langSel.value;
      var slug = langSel.getAttribute("data-slug");
      setCookie("LN_LOCALE", code);
      var prefix = code === "en" ? "" : "/" + code;
      location.href = slug === "index" ? (prefix || "/") : prefix + "/" + slug;
    });
  }

  /* mobile menu --------------------------------------------------------- */
  var menuBtn = document.querySelector("[data-menu]");
  var side = document.querySelector("[data-side]");
  if (menuBtn && side) {
    menuBtn.addEventListener("click", function () {
      side.setAttribute("data-open", side.getAttribute("data-open") === "true" ? "false" : "true");
    });
  }

  /* copy the whole page as markdown, for pasting into an assistant -------- */
  var pageBtn = document.querySelector("[data-copy-page]");
  if (pageBtn) {
    pageBtn.addEventListener("click", function () {
      var prefix = locales.indexOf(location.pathname.split("/")[1]) !== -1
        ? "/" + location.pathname.split("/")[1]
        : "";
      var url = prefix + "/" + pageBtn.getAttribute("data-copy-page");
      var old = pageBtn.textContent;

      fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error("no markdown twin");
          return r.text();
        })
        /* Prepend the source URL: an assistant given a page with no address
           cannot cite it, and cannot tell the reader where to look. */
        .then(function (md) {
          return navigator.clipboard.writeText(
            // Double-escaped on purpose. This file is emitted from a template
            // literal, so a newline escape written the ordinary way is consumed
            // by the build and becomes a real line break inside the generated
            // string literal — a syntax error that takes the whole of site.js
            // down with it, and every interactive feature on the site with that.
            // Doubling the backslash is what survives into the output.
            //
            // (Said carefully rather than shown: the first version of this very
            // comment spelled the escape out literally and reintroduced the bug
            // it was explaining.)
            "Source: " + location.origin + location.pathname + "\\n\\n" + md
          );
        })
        .then(function () {
          pageBtn.textContent = "✓";
          setTimeout(function () { pageBtn.textContent = old; }, 1400);
        })
        .catch(function () {
          pageBtn.textContent = "✗";
          setTimeout(function () { pageBtn.textContent = old; }, 1400);
        });
    });
  }

  /* copy buttons -------------------------------------------------------- */
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.closest(".code").querySelector("code");
      navigator.clipboard.writeText(code.innerText).then(function () {
        var old = btn.textContent;
        btn.textContent = "✓";
        setTimeout(function () { btn.textContent = old; }, 1200);
      });
    });
  });

  /* tabs ---------------------------------------------------------------- */
  document.querySelectorAll("[data-tabs]").forEach(function (group) {
    var tabs = group.querySelectorAll(".tabs__tab");
    var panels = group.querySelectorAll(".tabs__panel");
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (t, j) { t.setAttribute("aria-selected", String(i === j)); });
        panels.forEach(function (p, j) { p.hidden = i !== j; });
      });
    });
  });

  /* table of contents: highlight the section in view --------------------- */
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    tocLinks.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = byId[entry.target.id];
        if (!link) return;
        if (entry.isIntersecting) {
          tocLinks.forEach(function (a) { a.classList.remove("is-active"); });
          link.classList.add("is-active");
        }
      });
    }, { rootMargin: "-80px 0px -75% 0px" });

    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) observer.observe(el);
    });
  }

  /* search -------------------------------------------------------------- */
  var input = document.querySelector("[data-search]");
  var results = document.querySelector("[data-search-results]");
  if (!input || !results) return;

  var index = null;
  var prefix = doc.getAttribute("lang") && location.pathname.split("/")[1];
  var base = locales.indexOf(prefix) !== -1 ? "/" + prefix : "";

  function load() {
    if (index) return Promise.resolve(index);
    return fetch(base + "/search.json").then(function (r) { return r.json(); }).then(function (data) {
      index = data;
      return index;
    });
  }

  function score(page, terms) {
    var hay = (page.t + " " + page.d + " " + page.b).toLowerCase();
    var total = 0;
    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      if (page.t.toLowerCase().indexOf(term) !== -1) total += 10;
      if (page.d.toLowerCase().indexOf(term) !== -1) total += 5;
      var n = hay.split(term).length - 1;
      if (!n) return 0;                 /* every term must appear somewhere */
      total += Math.min(n, 6);
    }
    return total;
  }

  var timer;
  input.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var q = input.value.trim().toLowerCase();
      if (q.length < 2) { results.innerHTML = ""; return; }

      load().then(function (pages) {
        var terms = q.split(/\\s+/).filter(Boolean);
        var hits = pages
          .map(function (p) { return { p: p, s: score(p, terms) }; })
          .filter(function (h) { return h.s > 0; })
          .sort(function (a, b) { return b.s - a.s; })
          .slice(0, 8);

        if (!hits.length) {
          results.innerHTML = '<div class="search__hit"><span>' + input.dataset.empty + "</span></div>";
          return;
        }
        results.innerHTML = hits.map(function (h) {
          return '<a class="search__hit" href="' + h.p.u + '"><b>' + h.p.t + "</b><span>" + h.p.d + "</span></a>";
        }).join("");
      });
    }, 120);
  });

  input.dataset.empty = ${JSON.stringify("No results")};

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".search")) results.innerHTML = "";
  });

  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); input.focus(); }
    if (e.key === "Escape") { results.innerHTML = ""; input.blur(); }
  });
})();
`;

// ---------------------------------------------------------------------------

const result = await build();

if (process.argv.includes("--serve")) {
  const { createServer } = await import("node:http");
  const PORT = 4000;

  const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
    ".md": "text/markdown; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
  };

  createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(OUT, p);
    if (p.endsWith("/")) file = path.join(file, "index.html");
    else if (!path.extname(file)) file = path.join(file, "index.html");

    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("404");
    }
  }).listen(PORT, () => console.log(`  serving http://localhost:${PORT}\n`));
} else {
  process.exit(result.written > 0 ? 0 : 1);
}
