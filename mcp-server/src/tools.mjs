/**
 * The tools this MCP server exposes, as plain functions.
 *
 * Kept transport-free so they can be unit-tested without speaking MCP, and so the
 * protocol wiring in `server.mjs` stays thin enough to read in one sitting.
 *
 * The design goal is narrower than "give the model access to LibertyNet". It is:
 * **make it hard for an assistant to confidently state something false.** Two
 * tools exist purely for that:
 *
 *   · `capability_status` — the assistant can check whether a feature exists
 *     before writing code against it, instead of inferring from a page title.
 *   · `verify_identity` — the assistant can check a DID/key pair arithmetically
 *     instead of asserting that it looks right.
 *
 * An assistant that has these and still hallucinates an endpoint has chosen to.
 */

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const REGISTRY = process.env.LN_REGISTRY_URL || "https://registry.libertynet.ai";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DOCS_DIR = process.env.LN_DOCS_DIR || path.resolve(HERE, "../../docs-site");
const STATUS_FILE = process.env.LN_STATUS_FILE || path.resolve(HERE, "../../api-spec/status.json");

// ---------------------------------------------------------------------------
// docs
// ---------------------------------------------------------------------------

/** Recursively collect .mdx pages, skipping build output and dependencies. */
async function collectPages(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "snippets", "logo", "images"].includes(entry.name)) continue;
      await collectPages(full, base, out);
    } else if (entry.name.endsWith(".mdx")) {
      out.push({ slug: path.relative(base, full).replace(/\.mdx$/, ""), file: full });
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

let pageCache = null;

async function loadPages() {
  if (pageCache) return pageCache;

  const found = await collectPages(DOCS_DIR);
  pageCache = await Promise.all(
    found.map(async (p) => {
      const raw = await readFile(p.file, "utf8");
      const { meta, body } = stripFrontmatter(raw);
      return { slug: p.slug, title: meta.title ?? p.slug, description: meta.description ?? "", body };
    }),
  );
  return pageCache;
}

/** Reset the cache. Tests use this; the server does not. */
export function _clearCache() {
  pageCache = null;
}

/**
 * Search the documentation.
 *
 * Deliberately a simple scored substring match rather than an embedding index:
 * the corpus is ~30 pages, the caller is a language model that can read, and a
 * dependency-free implementation is one that still works in five years.
 */
export async function searchDocs({ query, limit = 5 }) {
  if (!query || typeof query !== "string") {
    throw new TypeError("query is required");
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pages = await loadPages();

  const scored = pages
    .map((page) => {
      const haystack = `${page.title}\n${page.description}\n${page.body}`.toLowerCase();
      let score = 0;

      for (const term of terms) {
        // Title and description matches are worth far more than body matches:
        // a page *about* the thing beats a page that mentions it in passing.
        if (page.title.toLowerCase().includes(term)) score += 10;
        if (page.description.toLowerCase().includes(term)) score += 5;

        const occurrences = haystack.split(term).length - 1;
        score += Math.min(occurrences, 8);
      }
      return { page, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ page, score }) => ({
    slug: page.slug,
    title: page.title,
    description: page.description,
    url: `https://docs.libertynet.ai/${page.slug}`,
    score,
    excerpt: excerptFor(page.body, terms),
  }));
}

function excerptFor(body, terms) {
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) at = 0;

  const start = Math.max(0, at - 120);
  return (start > 0 ? "…" : "") + body.slice(start, start + 400).trim() + "…";
}

/** Fetch one documentation page in full. */
export async function getPage({ slug }) {
  if (!slug || typeof slug !== "string") throw new TypeError("slug is required");

  const clean = slug.replace(/^\/+|\.mdx$/g, "");
  const pages = await loadPages();
  const page = pages.find((p) => p.slug === clean);

  if (!page) {
    const near = pages
      .filter((p) => p.slug.includes(clean.split("/").pop() ?? ""))
      .map((p) => p.slug)
      .slice(0, 5);
    return {
      found: false,
      error: `No page "${clean}".`,
      did_you_mean: near,
      available: pages.map((p) => p.slug).sort(),
    };
  }

  return {
    found: true,
    slug: page.slug,
    title: page.title,
    description: page.description,
    url: `https://docs.libertynet.ai/${page.slug}`,
    content: page.body,
  };
}

// ---------------------------------------------------------------------------
// capability status — the anti-hallucination tool
// ---------------------------------------------------------------------------

/**
 * What is actually built.
 *
 * An assistant should call this before writing code against any LibertyNet
 * feature. The answer is the same machine-readable matrix that drives every badge
 * in the docs and both SDKs, so there is exactly one source to disagree with.
 */
export async function capabilityStatus({ area } = {}) {
  const status = JSON.parse(await readFile(STATUS_FILE, "utf8"));

  const groups = area
    ? status.groups.filter((g) => g.id === area || g.title.toLowerCase().includes(area.toLowerCase()))
    : status.groups;

  if (area && groups.length === 0) {
    return {
      error: `No capability area "${area}".`,
      available: status.groups.map((g) => g.id),
    };
  }

  return {
    verified_at: status.verified_at,
    verified_against: status.verified_against,
    levels: status.levels,
    guidance:
      "Only 'implemented' capabilities can be called today. 'not_yet_wired' endpoints return " +
      "200 with placeholder zeros and \"source\": \"not_yet_wired\" — never present those numbers " +
      "as measurements. 'testing' means code exists but is not deployed. 'planned' means there " +
      "is nothing behind it; do not write code against it.",
    groups: groups.map((g) => ({
      id: g.id,
      title: g.title,
      base_url: g.base_url,
      auth: g.auth,
      endpoints: g.endpoints,
    })),
  };
}

// ---------------------------------------------------------------------------
// live network
// ---------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let lead = 0;
  for (const c of s) { if (c === "1") lead++; else break; }
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, "hex")]);
}

function keyBytes(publicKey) {
  if (!publicKey) return null;
  const raw = /^[0-9a-f]{64}$/.test(publicKey) ? Buffer.from(publicKey, "hex") : b58decode(publicKey);
  return raw && raw.length === 32 ? raw : null;
}

/**
 * Check a DID/public-key pair arithmetically.
 *
 * So an assistant can *verify* rather than assert. It also returns the reason
 * when the answer is no, which is usually "you decoded a base58 key as hex".
 */
export function verifyIdentity({ did, public_key }) {
  const key = keyBytes(public_key);
  if (!key) {
    return {
      valid: false,
      reason:
        "public_key is not 32 bytes in hex or base58. GET /nodes serves hex; GET /peers serves " +
        "base58 — decoding one as the other silently produces garbage.",
    };
  }

  const m = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/.exec(did || "");
  if (!m) {
    return { valid: false, reason: "did does not match ^did:svrp:[<tag>:]<hex>$" };
  }

  const [, tag, body] = m;
  const digest = createHash("sha256").update(key).digest("hex");

  if (body.length === 64) {
    if (tag !== undefined) {
      return { valid: false, reason: "a tagged 64-hex DID is not a shape this protocol produces" };
    }
    return {
      valid: body === key.toString("hex"),
      form: "full-hex",
      expected: key.toString("hex"),
      reason: body === key.toString("hex") ? "the DID body is the key itself" : "body ≠ hex(key)",
    };
  }

  if (body.length !== 8 && body.length !== 10) {
    return { valid: false, reason: "DID body must be 8, 10 or 64 hex characters" };
  }

  const expected = digest.slice(0, body.length);
  return {
    valid: body === expected,
    form: body.length === 8 ? "short" : "short-fallback",
    expected,
    short_did: `did:svrp:${tag ?? "n"}:${digest.slice(0, 8)}`,
    fingerprint: digest.slice(0, 16).match(/.{1,4}/g).join(":"),
    reason: body === expected ? "matches sha256(key)" : `expected ${expected}`,
  };
}

/**
 * The live network, with every identity verified before it is returned.
 *
 * An assistant answering "how many nodes are online" should get the real number,
 * not one from its training data.
 */
export async function listNodes({ online_only = true, capability } = {}) {
  const res = await fetch(`${REGISTRY}/nodes`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${REGISTRY}/nodes returned HTTP ${res.status}`);

  const { nodes } = await res.json();
  const verified = [];
  const rejected = [];

  for (const n of nodes) {
    if (verifyIdentity({ did: n.did, public_key: n.public_key }).valid) verified.push(n);
    else rejected.push(n.did);
  }

  let result = verified.map((n) => ({
    did: n.did,
    region: n.region,
    capabilities: n.capabilities ?? [],
    last_seen: n.last_seen,
    online: Boolean(n.last_seen) && Date.now() - Date.parse(n.last_seen) < 600_000,
  }));

  if (online_only) result = result.filter((n) => n.online);
  if (capability) result = result.filter((n) => n.capabilities.includes(capability));

  return {
    registry: REGISTRY,
    registered: nodes.length,
    verified: verified.length,
    rejected_id_binding: rejected,
    returned: result.length,
    note:
      'A node\'s "status" field never decays — freshness comes from last_seen only. ' +
      "Any entry in rejected_id_binding is a finding worth reporting, not a record to skip.",
    nodes: result,
  };
}

/** Probe a live endpoint, so "is it up" is answered by measurement. */
export async function checkEndpoint({ path: endpointPath = "/health" }) {
  const url = `${REGISTRY}${endpointPath}`;
  const started = Date.now();

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const text = await res.text();

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }

    return { url, status: res.status, ok: res.ok, elapsed_ms: Date.now() - started, body };
  } catch (e) {
    return { url, error: String(e), elapsed_ms: Date.now() - started };
  }
}
