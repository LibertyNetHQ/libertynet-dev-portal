#!/usr/bin/env node
/**
 * Every external link in the repository, fetched as a stranger.
 *
 *     node tools/check-external-links.mjs
 *     node tools/check-external-links.mjs --offline   # static rules only
 *
 * The point is the word *stranger*. GitHub answers 404 rather than 403 for a
 * repository you cannot see, so a link into a private repo reads as perfectly
 * healthy to anyone on the team and as a dead end to everyone else. That is how
 * a dozen of them shipped: the docs looked fine to us precisely because we had
 * access.
 *
 * So every request here goes out with no credentials at all — no token, no
 * cookie, no `gh auth`. Checking as ourselves would prove nothing, and would
 * prove it very convincingly.
 *
 * Two layers, because they fail differently:
 *
 *   · Static rules run everywhere, including offline and in the required job.
 *     They encode what we already know went wrong.
 *   · Live fetches catch the links nobody thought to write a rule for.
 *
 * A link that cannot be reached at all is reported as unverified and fails too.
 * "We could not check it" is not the same claim as "it works", and a gate that
 * quietly passes on connection errors is a gate that passes on everything the
 * day DNS breaks.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OFFLINE = process.argv.includes("--offline");

const failures = [];
const notes = [];

/** Directories with nothing hand-written in them. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", ".next", "__pycache__",
  ".pytest_cache", "logo", "images", "public",
]);

/** Files a human reads or a package manager publishes. */
const SCAN = /\.(mdx?|json|ya?ml|mjs|ts|tsx|py|sh|toml)$/;

/**
 * Links we know are wrong, with the reason. Each was live on the public site at
 * some point; the rule is what stops it coming back.
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

/** Fails a live fetch without failing the build, and why that is acceptable. */
const TOLERATED = [
  // Rate-limits and bot-blocks aggressively; a 429 says nothing about the link.
  { pattern: /^https:\/\/(www\.)?npmjs\.com\//, why: "rate-limits anonymous clients" },
  { pattern: /^https:\/\/pypi\.org\//, why: "rate-limits anonymous clients" },
];

/**
 * API endpoints quoted in prose are not links a reader clicks.
 *
 * A GET against a POST-only endpoint is 404 and an authenticated endpoint is
 * 401 — both correct, neither a broken link. check-api-sync.mjs answers that
 * question properly, with the right method and the right credentials.
 */
const API_HOSTS = [
  /^https:\/\/registry\.libertynet\.ai\//,
  // The demo node's /echo is POST-only; a GET is correctly a 404.
  /^https:\/\/libertynet\.ai\/demo-node\//,
  // Every coordination operation under /v1 is authenticated, reads included, so an anonymous
  // GET is a 401 by design. Treating that as a broken link would mean the check got greener
  // the day the read path stopped requiring credentials — the reverse of what it is for.
  // The base URL itself is deliberately NOT skipped: it serves the contract, and a developer
  // who pastes it should land somewhere, so it stays a link this check can hold to account.
  /^https:\/\/libertynet\.ai\/coordination\/v1\//,
];

/**
 * URLs that are not links.
 *
 * An XML namespace identifies a vocabulary; whether anything is served there is
 * irrelevant, and several well-known ones deliberately serve nothing. Fetching
 * them would produce noise that teaches people to ignore this check — which
 * costs more than the namespaces are worth.
 */
const NOT_A_LINK = [
  /^https?:\/\/www\.w3\.org\/\d{4}\//,
  /^https?:\/\/www\.sitemaps\.org\/schemas\//,
];

/**
 * Broken URLs quoted on purpose, as evidence of a defect that was fixed.
 *
 * Each needs a reason, and each is a URL the project is *documenting* rather
 * than offering. Without this the honest write-up of a bug becomes a reason to
 * delete the write-up, which is a bad trade for a project whose whole argument
 * is that it says what went wrong.
 */
const QUOTED_AS_BROKEN = [
  {
    pattern: /^https:\/\/docs\.libertynet\.ai\/\.md$/,
    why: "the malformed home-page entry llms.txt used to emit; quoted in the fix's write-up",
  },
  {
    // Singular. The standard namespace is sitemaps.org, plural, and the
    // singular host does not resolve — which is exactly why the sitemap was
    // invalid and exactly why the audit quotes the wrong value verbatim.
    pattern: /^https?:\/\/www\.sitemap\.org\/schemas\//,
    why: "the wrong sitemap namespace, quoted in AUDIT-AIPM-002 as the defect that was fixed",
  },
];

// ---------------------------------------------------------------------------

/**
 * URL-shaped *identifiers* that are not web pages.
 *
 * Both of these come from /download, and neither is something a reader clicks:
 *
 *   · An OIDC issuer is a name. The only thing anyone does with it is compare it
 *     character-for-character against a signing certificate. GitHub's issuer
 *     answers 404 to a browser, which is correct.
 *   · A certificate's signer identity (SAN) is likewise a name that happens to
 *     be URL-shaped — `…/.github/workflows/sign-release.yml@refs/…` addresses a
 *     workflow *run identity*, not a page, and GitHub serves nothing at it.
 *
 * Getting these wrong is worse than noise: the fix a reader would infer is to
 * "correct" the value, and the value is exactly what has to be pinned verbatim
 * for the signature check to mean anything.
 */
const IDENTIFIERS = [
  /^https:\/\/token\.actions\.githubusercontent\.com\/?$/,
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/\.github\/workflows\/[^/]+\.yml@/,
];

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name), out);
    } else if (SCAN.test(e.name) && e.name !== "package-lock.json") {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = await walk(ROOT);
const links = new Map(); // url → [where]

for (const file of files) {
  const text = await readFile(file, "utf8").catch(() => "");
  const rel = path.relative(ROOT, file);

  // The character class excludes `\` on purpose, so a URL-shaped *regular
  // expression* is never mistaken for a link. `/reference/verifying-downloads`
  // documents a cosign `--certificate-identity-regexp` beginning
  // `https://github\.com/…`; backslashes cannot appear in a URL, so fetching it
  // could only ever fail, and reporting that as a dead link would train people
  // to ignore this check.
  //
  // Stopping at the backslash is not enough on its own: it leaves the scheme
  // and bare host in front of it looking like a perfectly good link, which then
  // fails to resolve. A match butting up against a backslash is a fragment of a
  // regex, not a URL somebody can click — skip the whole thing.
  for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\]\\]+/g)) {
    if (text[m.index + m[0].length] === "\\") continue;
    // Trailing punctuation, and the closing brace of a template literal,
    // belong to the surrounding code rather than to the URL.
    const url = m[0].replace(/[.,;:}]+$/, "");
    if (url.includes("localhost") || url.includes("127.0.0.1")) continue;
    // Placeholders and reserved test names. `.test` is reserved by RFC 2606
    // precisely so it never resolves — a test fixture pointing there is correct.
    // Placeholders, template interpolation and shell variables. `$a` in
    // `curl "https://docs.libertynet.ai$a"` is a loop variable, not a path —
    // fetching it can only 404, and reporting that trains people to ignore
    // this check.
    if (/example\.(com|org)|\.test(\/|$)|YOUR|<[^>]*>|\$\{|\$\w|\*/.test(url)) continue;
    if (!links.has(url)) links.set(url, []);
    if (!links.get(url).includes(rel)) links.get(url).push(rel);
  }

  for (const rule of FORBIDDEN) {
    for (const hit of text.matchAll(new RegExp(rule.pattern, "g"))) {
      const line = text.slice(0, hit.index).split("\n").length;
      failures.push({ where: `${rel}:${line}`, url: hit[0], why: rule.why });
    }
  }
}

notes.push(`${links.size} distinct link(s) across ${files.length} scanned files`);

// ---------------------------------------------------------------------------

/** Four attempts with backoff. A blip is not a verdict; a 404 is. */
async function probe(url) {
  let lastError;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // No credentials of any kind. That is the entire point.
      let res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: { "User-Agent": "libertynet-docs-link-check" },
        signal: AbortSignal.timeout(20_000),
      });

      // Plenty of servers dislike HEAD; confirm with GET before accusing.
      if ([403, 405, 501].includes(res.status)) {
        res = await fetch(url, {
          redirect: "follow",
          headers: { "User-Agent": "libertynet-docs-link-check" },
          signal: AbortSignal.timeout(20_000),
        });
      }

      return { status: res.status, ok: res.ok };
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }

  return { unreachable: String(lastError?.message ?? lastError) };
}

if (!OFFLINE) {
  const isApi = (u) => API_HOSTS.some((re) => re.test(u));
  const skip = (u) =>
    isApi(u) ||
    NOT_A_LINK.some((re) => re.test(u)) ||
    IDENTIFIERS.some((re) => re.test(u)) ||
    QUOTED_AS_BROKEN.some((q) => q.pattern.test(u));

  const urls = [...links.keys()].filter((u) => !skip(u));
  const apiSkipped = links.size - urls.length;

  let checked = 0;
  let tolerated = 0;

  // Small batches: this is someone else's server, and a documentation check is
  // not a reason to hammer it.
  for (let i = 0; i < urls.length; i += 5) {
    await Promise.all(
      urls.slice(i, i + 5).map(async (url) => {
        const result = await probe(url);
        const excuse = TOLERATED.find((t) => t.pattern.test(url));

        if (result.ok) {
          checked++;
          return;
        }

        if (excuse) {
          tolerated++;
          return;
        }

        if (result.unreachable) {
          failures.push({
            where: links.get(url).join(", "),
            url,
            why:
              `could not be reached after 4 attempts (${result.unreachable}). ` +
              `Unverified is not the same as working — re-run if this was a network blip.`,
          });
          return;
        }

        failures.push({
          where: links.get(url).join(", "),
          url,
          why:
            result.status === 404
              ? "HTTP 404 for an anonymous reader. On GitHub this is also what a " +
                "private repository returns, so check visibility before assuming a typo."
              : `HTTP ${result.status} for an anonymous reader`,
        });
      }),
    );
  }

  notes.push(
    `${checked} fetched with no credentials` +
      `${tolerated ? `, ${tolerated} tolerated` : ""}` +
      `${apiSkipped ? `, ${apiSkipped} not fetched (API endpoints, XML namespaces, quoted-as-broken)` : ""}`,
  );
} else {
  notes.push("live fetches skipped (--offline)");
}

// ---------------------------------------------------------------------------

for (const n of notes) console.log(`  · ${n}`);

if (failures.length === 0) {
  console.log(`\n✓ every link resolves for someone with no access to anything\n`);
  process.exit(0);
}

console.error(`\n✗ ${failures.length} bad link(s):\n`);
for (const f of failures) {
  console.error(`  ${f.where}`);
  console.error(`    ${f.url}`);
  console.error(`    ${f.why}\n`);
}
process.exit(1);
