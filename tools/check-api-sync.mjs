#!/usr/bin/env node
/**
 * API sync check — the mechanism that keeps this repo honest about the live network.
 *
 *     node tools/check-api-sync.mjs           # report
 *     node tools/check-api-sync.mjs --json    # machine-readable, for CI
 *
 * The docs claim things about a system that lives in another repository and runs
 * on a server. Those claims can silently stop being true in three ways:
 *
 *   1. An endpoint we call `implemented` goes away or starts erroring.
 *   2. An endpoint we call `not_yet_wired` gets its data source connected — at
 *      which point we are UNDER-claiming, and developers are being told to
 *      ignore numbers that have become real.
 *   3. A `planned` endpoint quietly ships.
 *
 * All three are drift. This probes the live registry and reports every
 * disagreement, so the fix is a code change rather than someone noticing.
 *
 * Exit codes: 0 in sync · 1 drift detected · 2 could not reach the registry.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const REGISTRY = process.env.LN_REGISTRY_URL ?? "https://registry.libertynet.ai";
const TIMEOUT = 20_000;

const json = process.argv.includes("--json");

async function probe(method, urlPath, base = REGISTRY) {
  // Each group declares its own base_url. Probing the demo node's paths against
  // the registry reported three phantom "overclaim" findings — the endpoints are
  // fine, they just live somewhere else.
  const url = `${base}${urlPath.replace(/\{[^}]+\}/g, "probe-nonexistent")}`;
  try {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(TIMEOUT),
      ...(method === "POST"
        ? { headers: { "content-type": "application/json" }, body: "{}" }
        : {}),
    });
    let body = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      /* non-JSON is fine for /peers */
    }
    return { status: res.status, body };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * Does the observed response look like the endpoint exists?
 *
 * A 404 with the registry's generic `not found` body means no such route. Any
 * other status — including 400 or 401 — means the route exists and is enforcing
 * something, which is what `implemented` claims.
 */
function routeExists(result) {
  if (result.error) return null;                      // unknown, not absent
  if (result.status !== 404) return true;
  const body = result.body ?? {};
  // The dispatcher's "no such route" body is exactly {"error": "not found"};
  // a 404 carrying a `code` is a real handler saying the thing was not found.
  return Boolean(body.code);
}

const findings = [];
const unverifiable = [];

const status = JSON.parse(await readFile(path.join(ROOT, "api-spec/status.json"), "utf8"));

// Reachability first — otherwise every endpoint "fails" and the report is noise.
const health = await probe("GET", "/health");
if (health.error || health.status !== 200) {
  const message = `Cannot reach ${REGISTRY}: ${health.error ?? `HTTP ${health.status}`}`;
  if (json) console.log(JSON.stringify({ reachable: false, message }, null, 2));
  else console.error(`\n✗ ${message}\n`);
  process.exit(2);
}

for (const group of status.groups) {
  if (!group.base_url) continue;                      // contracts, not HTTP

  for (const endpoint of group.endpoints) {
    if (endpoint.method === "CONTRACT") continue;

    const result = await probe(endpoint.method, endpoint.path, group.base_url);
    const exists = routeExists(result);

    if (exists === null) {
      findings.push({
        severity: "unknown",
        endpoint: `${endpoint.method} ${endpoint.path}`,
        claimed: endpoint.status,
        detail: `probe failed: ${result.error}`,
      });
      continue;
    }

    // (1) claimed live, but the route is gone
    if ((endpoint.status === "implemented" || endpoint.status === "not_yet_wired") && !exists) {
      findings.push({
        severity: "overclaim",
        endpoint: `${endpoint.method} ${endpoint.path}`,
        claimed: endpoint.status,
        observed: `HTTP ${result.status}, no such route`,
        detail: "status.json says this is live. It is not. Fix the matrix or the deployment.",
      });
    }

    // (3) claimed not built, but the route answers
    if (endpoint.status === "planned" && exists) {
      findings.push({
        severity: "underclaim",
        endpoint: `${endpoint.method} ${endpoint.path}`,
        claimed: "planned",
        observed: `HTTP ${result.status}`,
        detail: "This shipped without the matrix being updated. Update status.json.",
      });
    }

    // (4) claimed live, but the response admits it has no data source. This is
    // the overclaim that matters most: the endpoint answers 200 and looks
    // healthy, so nothing else notices.
    if (endpoint.status === "implemented" && result.body?.source === "not_yet_wired") {
      findings.push({
        severity: "overclaim",
        endpoint: `${endpoint.method} ${endpoint.path}`,
        claimed: "implemented",
        observed: 'source: "not_yet_wired"',
        detail:
          "The endpoint returns 200 but says its own data source is not connected. " +
          "Marking it implemented tells developers to trust numbers that are placeholders.",
      });
    }

    // Endpoints behind auth hide their body from an unauthenticated probe, so
    // rules (2) and (4) cannot see them. Say so rather than reporting a clean
    // bill of health we did not actually earn.
    if (result.status === 401 && (endpoint.status === "not_yet_wired" || endpoint.status === "implemented")) {
      unverifiable.push(`${endpoint.method} ${endpoint.path}`);
    }

    // (2) claimed unwired, but the source is connected
    if (endpoint.status === "not_yet_wired" && result.body?.source && result.body.source !== "not_yet_wired") {
      findings.push({
        severity: "underclaim",
        endpoint: `${endpoint.method} ${endpoint.path}`,
        claimed: "not_yet_wired",
        observed: `source: "${result.body.source}"`,
        detail:
          "A real data source is connected now. The docs are telling developers to ignore " +
          "numbers that have become real. Update status.json to `implemented`.",
      });
    }
  }
}

// Identity drift: every record on the live registry must still verify. If this
// ever fails it is far more serious than a stale badge.
const nodes = await probe("GET", "/nodes");
let identitySummary = null;

if (!nodes.error && nodes.body?.nodes) {
  const { createHash } = await import("node:crypto");
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  const b58 = (s) => {
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
  };

  const rejected = [];
  for (const n of nodes.body.nodes) {
    const key = /^[0-9a-f]{64}$/.test(n.public_key ?? "")
      ? Buffer.from(n.public_key, "hex")
      : b58(n.public_key ?? "");
    const m = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/.exec(n.did ?? "");

    let ok = false;
    if (key && key.length === 32 && m) {
      const [, tag, body] = m;
      ok =
        body.length === 64
          ? tag === undefined && body === key.toString("hex")
          : (body.length === 8 || body.length === 10) &&
            body === createHash("sha256").update(key).digest("hex").slice(0, body.length);
    }
    if (!ok) rejected.push(n.did);
  }

  identitySummary = { total: nodes.body.nodes.length, rejected };

  if (rejected.length) {
    findings.push({
      severity: "critical",
      endpoint: "GET /nodes",
      claimed: "all identities verify",
      observed: `${rejected.length} failed id-binding`,
      detail: `Report immediately: ${rejected.join(", ")}`,
    });
  }
}

// ---------------------------------------------------------------------------

if (json) {
  console.log(JSON.stringify({ reachable: true, registry: REGISTRY, identitySummary, unverifiable, findings }, null, 2));
} else {
  console.log(`\nprobed ${REGISTRY}`);
  if (identitySummary) {
    console.log(
      `  identities: ${identitySummary.total - identitySummary.rejected.length}/${identitySummary.total} verify`,
    );
  }
  console.log(`  registry reports ${health.body.count} nodes`);
  if (unverifiable.length) {
    // Not a finding — a limit on what this check can honestly claim to have checked.
    console.log(
      `\n  ${unverifiable.length} endpoint(s) sit behind auth, so their data source could not\n` +
        `  be inspected without a session. Their status is taken on trust:`,
    );
    for (const e of unverifiable) console.log(`    ${e}`);
  }

  if (findings.length === 0) {
    console.log("\n✓ docs and live API agree\n");
  } else {
    console.error(`\n✗ ${findings.length} drift finding(s):\n`);
    for (const f of findings) {
      console.error(`  [${f.severity}] ${f.endpoint}`);
      console.error(`     claimed: ${f.claimed}${f.observed ? `  observed: ${f.observed}` : ""}`);
      console.error(`     ${f.detail}\n`);
    }
  }
}

process.exit(findings.some((f) => f.severity !== "unknown") ? 1 : 0);
