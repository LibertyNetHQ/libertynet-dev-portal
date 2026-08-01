#!/usr/bin/env node
/**
 * Every external link on the site, fetched.
 *
 *     node tools/check-external-links.mjs
 *     node tools/check-external-links.mjs --offline   # static rules only
 *
 * The internal link checker in check-docs-drift.mjs only ever knew about pages
 * in this repository, so when the portal moved out of the monorepo, a dozen
 * links to `LibertyNet-hq/tree/main/dev-portal/...` kept passing every check and
 * every one of them was a 404 for anyone who was not signed in. The docs looked
 * fine to us precisely because we had access.
 *
 * Two layers, because they fail differently:
 *
 *   · Static rules run everywhere, including offline and in the required CI job.
 *     They encode what we know: this repository moved, and the repository it
 *     moved out of is private.
 *   · Live fetches run where the network is available. They catch the links
 *     nobody thought to write a rule for.
 *
 * A private repository is the interesting case. GitHub answers 404 rather than
 * 403 for a repository you cannot see, so "does it resolve for me" is not the
 * question — the question is whether it resolves for a reader who has never
 * heard of us. That is why this runs unauthenticated, deliberately.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs-site");
const OFFLINE = process.argv.includes("--offline");

const failures = [];
const notes = [];

/**
 * Links we know are wrong, with the reason. Each of these was live on the
 * public site at some point; the rule is what stops it coming back.
 */
const FORBIDDEN = [
  {
    pattern: /github\.com\/LibertyNetHQ\/LibertyNet-hq(?:\/|["')\s]|$)/,
    why:
      "LibertyNet-hq is private — it answers 404 for every anonymous reader. " +
      "Portal code lives in libertynet-dev-portal; for code that really is in " +
      "the private repository, name the path in prose instead of linking to it.",
  },
  {
    pattern: /libertynet-dev-portal\/(?:tree|blob)\/main\/dev-portal\//,
    why: "the portal is the repository root now, not a dev-portal/ subdirectory",
  },
];

// Links that are allowed to fail a live fetch without failing the build.
const TOLERATED = [
  // Rate-limits and bot-blocks aggressively; a 429 here says nothing about us.
  /^https:\/\/(www\.)?npmjs\.com\//,
  /^https:\/\/pypi\.org\//,
];

/**
 * API endpoints quoted in prose are not links a reader clicks.
 *
 * A GET against a POST-only endpoint is a 404 and an authenticated endpoint is
 * a 401 — both correct, neither a broken link. Whether these agree with the
 * documentation is a real question, and check-api-sync.mjs answers it properly,
 * with the right method and the right credentials. Guessing here would only
 * produce noise that trains people to ignore this check.
 */
const API_HOSTS = [/^https:\/\/registry\.libertynet\.ai\//];

/**
 * URL-shaped *identifiers* that are not web pages.
 *
 * An OIDC issuer is a name, and the only thing a reader does with it is compare
 * it character-for-character against what is in a signing certificate. GitHub's
 * issuer answers 404 to a browser, which is correct and says nothing about the
 * documentation. Fetching it could only ever produce a false alarm.
 */
const IDENTIFIERS = [/^https:\/\/token\.actions\.githubusercontent\.com\/?$/];

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["node_modules", ".git", "logo", "images"].includes(e.name)) continue;
      await walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith(".mdx") || e.name.endsWith(".md")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = [...(await walk(DOCS)), path.join(ROOT, "README.md")];
const links = new Map(); // url → [where]

/**
 * Not every URL-shaped string is a URL.
 *
 * `/reference/verifying-downloads` documents a cosign
 * `--certificate-identity-regexp` whose value is a *regular expression* that
 * begins `https://github\.com/…`. Backslashes cannot appear in a URL, so
 * fetching it could only ever fail — and reporting that as a dead link trains
 * people to ignore this check.
 *
 * Deliberately narrow: code blocks are still harvested in full, because a link
 * inside a snippet a reader is told to run is exactly as broken as one in prose.
 */
const isUrlShapedButNotAUrl = (u) => u.includes("\\");

for (const file of files) {
  const text = await readFile(file, "utf8").catch(() => "");
  const rel = path.relative(ROOT, file);

  for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\]]+/g)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (isUrlShapedButNotAUrl(url)) continue;
    if (!links.has(url)) links.set(url, []);
    links.get(url).push(rel);
  }

  // -- static rules ---------------------------------------------------------
  for (const rule of FORBIDDEN) {
    for (const hit of text.matchAll(new RegExp(rule.pattern, "g"))) {
      const line = text.slice(0, hit.index).split("\n").length;
      failures.push({ where: `${rel}:${line}`, url: hit[0], why: rule.why });
    }
  }
}

notes.push(`${links.size} distinct external links across ${files.length} files`);

// ---------------------------------------------------------------------------

if (!OFFLINE) {
  const isApi = (u) => API_HOSTS.some((re) => re.test(u));
  const isIdentifier = (u) => IDENTIFIERS.some((re) => re.test(u));
  const urls = [...links.keys()].filter(
    (u) => !u.includes("localhost") && !isApi(u) && !isIdentifier(u),
  );
  const apiSkipped = [...links.keys()].filter(isApi).length;
  let checked = 0;
  let tolerated = 0;

  // Small batches: this is someone else's server, and a documentation check is
  // not a reason to hammer it.
  for (let i = 0; i < urls.length; i += 6) {
    await Promise.all(
      urls.slice(i, i + 6).map(async (url) => {
        try {
          // No credentials of any kind — the point is what a stranger sees.
          let res = await fetch(url, {
            method: "HEAD",
            redirect: "follow",
            headers: { "User-Agent": "libertynet-docs-link-check" },
            signal: AbortSignal.timeout(15_000),
          });

          // Plenty of servers dislike HEAD; confirm with GET before accusing.
          if (res.status === 405 || res.status === 403 || res.status === 501) {
            res = await fetch(url, {
              redirect: "follow",
              headers: { "User-Agent": "libertynet-docs-link-check" },
              signal: AbortSignal.timeout(15_000),
            });
          }

          checked++;
          if (res.ok) return;

          if (TOLERATED.some((re) => re.test(url))) {
            tolerated++;
            return;
          }

          failures.push({
            where: links.get(url).join(", "),
            url,
            why: `HTTP ${res.status} for an anonymous reader`,
          });
        } catch (e) {
          if (TOLERATED.some((re) => re.test(url))) {
            tolerated++;
            return;
          }
          failures.push({ where: links.get(url).join(", "), url, why: String(e.message ?? e) });
        }
      }),
    );
  }

  notes.push(
    `${checked} fetched unauthenticated${tolerated ? `, ${tolerated} tolerated` : ""}` +
      `${apiSkipped ? `, ${apiSkipped} API endpoint(s) left to check-api-sync` : ""}`,
  );
} else {
  notes.push("live fetches skipped (--offline)");
}

// ---------------------------------------------------------------------------

for (const n of notes) console.log(`  · ${n}`);

if (failures.length === 0) {
  console.log(`\n✓ no dead external links\n`);
  process.exit(0);
}

console.error(`\n✗ ${failures.length} bad external link(s):\n`);
for (const f of failures) {
  console.error(`  ${f.where}`);
  console.error(`    ${f.url}`);
  console.error(`    ${f.why}\n`);
}
process.exit(1);
