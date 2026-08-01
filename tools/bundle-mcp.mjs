#!/usr/bin/env node
/**
 * Bundle the MCP server into one self-contained file.
 *
 * The server is zero-dependency, but it reads `docs-site/` and `api-spec/` off
 * disk — so installing it meant cloning the repository and pasting an absolute
 * path into a client config. That is not an install, it is a chore, and it is
 * the reason nobody was running it.
 *
 * This produces a single .mjs the site serves, with the documentation and the
 * capability matrix embedded. Download one file, point a client at it, done.
 *
 * Staleness is the obvious objection to embedding, so the bundle does not rely
 * on the embedded matrix: on first use it fetches the live status.json and only
 * falls back to the snapshot if the network is unavailable — and when it falls
 * back it says so in the response. A snapshot that can silently drift from the
 * live network is exactly the failure this portal exists to prevent.
 */

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs-site");
const OUT_DIR = path.join(ROOT, "site/public/mcp");
const OUT = path.join(OUT_DIR, "libertynet-mcp.mjs");

const LOCALE_DIRS = new Set(["zh-CN", "zh-TW", "ja", "ko", "es", "pt", "de", "fr", "ar", "hi"]);

// ---------------------------------------------------------------------------
// collect the corpus
// ---------------------------------------------------------------------------

async function collect(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "snippets", "logo", "images"].includes(entry.name)) continue;
      await collect(path.join(dir, entry.name), base, out);
    } else if (entry.name.endsWith(".mdx")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function stripFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * Strip the MDX machinery. The bundle is read by a language model, and an
 * `import { Status } from '/snippets/status.mdx'` line is pure noise to it —
 * worse, it invites the model to treat the component syntax as API surface.
 */
function toPlainText(body) {
  return body
    .replace(/^\s*(import|export)\s.*$/gm, "")
    .replace(/<Status\s+level="([a-z_]+)"[^>]*\/>/g, "[status: $1]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const files = await collect(DOCS);
const pages = [];

for (const file of files) {
  const slug = path.relative(DOCS, file).replace(/\.mdx$/, "");
  // English only. Translations would triple the bundle to serve a caller that
  // can read the English perfectly well, and searchDocs defaults to English.
  if (LOCALE_DIRS.has(slug.split("/")[0])) continue;

  const { meta, body } = stripFrontmatter(await readFile(file, "utf8"));
  pages.push({
    slug,
    title: meta.title ?? slug,
    description: meta.description ?? "",
    body: toPlainText(body),
  });
}

pages.sort((a, b) => a.slug.localeCompare(b.slug));

const status = JSON.parse(await readFile(path.join(ROOT, "api-spec/status.json"), "utf8"));
// The sources carry their own shebangs; concatenated, the second one lands in
// the middle of the file and is a syntax error rather than a comment.
const stripShebang = (s) => s.replace(/^#!.*\n/, "");

const tools = stripShebang(await readFile(path.join(ROOT, "mcp-server/src/tools.mjs"), "utf8"));
const server = stripShebang(await readFile(path.join(ROOT, "mcp-server/src/server.mjs"), "utf8"));

// ---------------------------------------------------------------------------
// rewrite the two modules into one file
// ---------------------------------------------------------------------------

// tools.mjs reads from disk; the bundle carries its corpus. Replace the loaders
// rather than the whole module, so search, ranking and verification stay the
// single implementation that the test suite covers.
let bundledTools = tools
  .replace(/^import \{ readFile, readdir \} from "node:fs\/promises";$/m, "")
  .replace(/^import path from "node:path";$/m, "")
  .replace(
    /^const HERE = .*$\n^const DOCS_DIR = .*$\n^const STATUS_FILE = .*$/m,
    "",
  );

// Excise the on-disk page loader and the collect/frontmatter helpers it uses.
bundledTools = bundledTools
  .replace(/\/\*\* Recursively collect[\s\S]*?\n}\n/, "")
  .replace(/function stripFrontmatter\(text\) \{[\s\S]*?\n}\n/, "")
  .replace(/let pageCache = null;\n\nasync function loadPages\(\) \{[\s\S]*?\n}\n/, "async function loadPages() {\n  return EMBEDDED_PAGES;\n}\n")
  .replace(/export function _clearCache\(\) \{[\s\S]*?\n}\n/, "export function _clearCache() {}\n");

// capabilityStatus reads STATUS_FILE. Give it the live-first loader instead.
bundledTools = bundledTools.replace(
  /const status = JSON\.parse\(await readFile\(STATUS_FILE, "utf8"\)\);/,
  "const { status, source } = await loadStatus();",
);
bundledTools = bundledTools.replace(
  /  return \{\n    verified_at: status\.verified_at,/,
  "  return {\n    matrix_source: source,\n    verified_at: status.verified_at,",
);

if (!bundledTools.includes("EMBEDDED_PAGES")) throw new Error("page loader not replaced");
if (!bundledTools.includes("loadStatus()")) throw new Error("status loader not replaced");
if (bundledTools.includes("readFile(STATUS_FILE")) throw new Error("STATUS_FILE read survived");

const bundledServer = server
  .replace(/^import \{[^}]*\} from "\.\/tools\.mjs";$/m, "")
  .replace(/^import .*$/gm, (line) => (line.includes("node:") ? line : ""));

const built = new Date().toISOString().slice(0, 10);

const preamble = `#!/usr/bin/env node
// LibertyNet MCP server — single-file build, zero dependencies.
//
// Generated by tools/bundle-mcp.mjs on ${built}. Do not edit; edit the sources
// in mcp-server/src/ and rebuild.
//
//   https://docs.libertynet.ai/ai/mcp
//
// The documentation below is a snapshot taken at build time. The capability
// matrix is NOT: it is fetched live on first use, because a stale claim about
// what works is the one error this project refuses to ship.

const BUNDLE_BUILT_AT = ${JSON.stringify(built)};
const DOCS_ORIGIN = process.env.LN_DOCS_ORIGIN || "https://docs.libertynet.ai";

const EMBEDDED_PAGES = ${JSON.stringify(pages)};
const EMBEDDED_STATUS = ${JSON.stringify(status)};

/**
 * The capability matrix, live if the network allows it.
 *
 * Falls back to the build-time snapshot and *says so* — a caller that cannot
 * tell whether it is reading today's truth or last month's has been given
 * nothing worth trusting.
 */
let statusCache = null;

async function loadStatus() {
  if (statusCache) return statusCache;

  try {
    const res = await fetch(\`\${DOCS_ORIGIN}/api-spec/status.json\`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      statusCache = { status: await res.json(), source: "live" };
      return statusCache;
    }
  } catch {
    // Offline, or the site is down. The snapshot is better than refusing to
    // answer, as long as the answer is labelled.
  }

  statusCache = {
    status: EMBEDDED_STATUS,
    source: \`bundled snapshot from \${BUNDLE_BUILT_AT} — could not reach \${DOCS_ORIGIN}; \` +
      "treat every status here as possibly out of date and re-check before relying on it",
  };
  return statusCache;
}

`;

const output = `${preamble}${bundledTools}\n${bundledServer}\n`;

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT, output, { mode: 0o755 });

const bytes = (await stat(OUT)).size;
console.log(`✓ bundled ${OUT.replace(ROOT + "/", "")}`);
console.log(`  ${pages.length} pages · ${status.groups.length} capability groups · ${(bytes / 1024).toFixed(0)} KB`);
