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

function sidebar(nav, slug, locale, pages) {
  let out = "";
  for (const group of nav) {
    const items = group.pages.filter((p) => pages.has(p));
    if (!items.length) continue;

    out += `<div class="side__group"><div class="side__title">${escapeHtml(group.title)}</div>`;
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
  const options = LOCALES.map((l) => {
    const has = Boolean(pages.get(slug)?.sources?.[l.code]);
    return `<option value="${l.code}"${l.code === locale ? " selected" : ""}>${escapeHtml(l.label)}${has ? "" : " ·"}</option>`;
  }).join("");

  return (
    `<select class="control" data-lang-switch aria-label="${escapeHtml(strings.nav.language)}" ` +
    `data-slug="${escapeHtml(slug)}">${options}</select>`
  );
}

function shell({ slug, locale, meta, body, headings, nav, pages, strings, prev, next, translated }) {
  const l = byCode[locale];
  const prefix = localePrefix(locale);
  const canonical = `${SITE_URL}${href(slug, locale)}`;

  const alternates = LOCALES.map(
    (x) => `<link rel="alternate" hreflang="${x.intl}" href="${SITE_URL}${href(slug, x.code)}">`,
  ).join("") + `<link rel="alternate" hreflang="x-default" href="${SITE_URL}${href(slug, DEFAULT_LOCALE)}">`;

  const notice = translated
    ? ""
    : `<div class="i18n-notice"><strong>${escapeHtml(strings.translation.missingTitle)}</strong>` +
      `${escapeHtml(strings.translation.missingBody.replace("{language}", l.label))} ` +
      `<a href="https://github.com/LibertyNetHQ/libertynet-dev-portal/tree/main/docs-site">${escapeHtml(strings.translation.helpTranslate)}</a></div>`;

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
<link rel="stylesheet" href="/theme.css">
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
  <nav class="side" data-side>${sidebar(nav, slug, locale, localeIndex(pages, locale))}</nav>
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

<script src="/site.js" defer></script>
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
      });

      const outPath =
        slug === "index"
          ? path.join(OUT, localePrefix(locale), "index.html")
          : path.join(OUT, localePrefix(locale), slug, "index.html");

      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, page);
      written++;

      // Markdown twin, for `curl page.md`, the Copy-for-AI button and any client
      // that would rather read prose than HTML. MDX `import`/`export` lines are
      // stripped: they are build machinery, and leaving them in spends an
      // assistant's attention on syntax that is not part of the answer.
      const markdown = [
        `# ${source.meta.title}`,
        source.meta.description ? `\n> ${source.meta.description}` : "",
        `\n${source.body.replace(/^\s*(import|export)\s.*$/gm, "").replace(/\n{3,}/g, "\n\n")}`,
      ]
        .filter(Boolean)
        .join("\n")
        .trim();

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

  // Static assets
  await cp(path.join(HERE, "build/theme.css"), path.join(OUT, "theme.css"));
  await writeFile(path.join(OUT, "site.js"), CLIENT_JS);

  const favicon = path.join(DOCS, "favicon.svg");
  if (existsSync(favicon)) await cp(favicon, path.join(OUT, "favicon.svg"));
  if (existsSync(path.join(DOCS, "logo"))) {
    await cp(path.join(DOCS, "logo"), path.join(OUT, "logo"), { recursive: true });
  }

  // Machine-readable surfaces
  await writeFile(path.join(OUT, "llms.txt"), llmsTxt(pages, strings[DEFAULT_LOCALE]));
  await writeFile(path.join(OUT, "llms-full.txt"), await llmsFull(pages));
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

function llmsTxt(pages, s) {
  let out = `# LibertyNet Developer Documentation\n\n> ${s.meta.tagline}\n\n`;
  out += `Honesty contract: every capability carries one of four statuses — implemented, `;
  out += `not_yet_wired, testing, planned. Most of the intended surface is NOT built. `;
  out += `There is no wallet, transfer, swap, staking or trading. Credits are a test unit, `;
  out += `not cash. Check /api-spec/status.json before writing code against anything.\n\n## Pages\n\n`;

  for (const [slug, entry] of pages) {
    const meta = entry.metas.en?.meta;
    if (!meta) continue;
    out += `- [${meta.title}](${SITE_URL}${href(slug, "en")}.md): ${meta.description ?? ""}\n`;
  }
  return out;
}

async function llmsFull(pages) {
  let out = `# LibertyNet Developer Documentation (full)\n\n`;
  for (const [slug, entry] of pages) {
    const src = entry.metas.en;
    if (!src) continue;
    out += `\n\n---\n\n# ${src.meta.title}\n\nURL: ${SITE_URL}${href(slug, "en")}\n\n${src.body}`;
  }
  return out;
}

function sitemap(pages) {
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`;
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
            "Source: " + location.origin + location.pathname + "\n\n" + md
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
