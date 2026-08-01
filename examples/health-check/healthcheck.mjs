#!/usr/bin/env node
/**
 * Network health check, built to be run by a machine.
 *
 *     node healthcheck.mjs                 human-readable
 *     node healthcheck.mjs --json          for a monitoring agent
 *     node healthcheck.mjs --require-callable 1
 *
 * Zero dependencies. Exit codes are the interface:
 *
 *     0  healthy
 *     1  degraded — reachable, but something documented is not true
 *     2  down — the registry did not answer
 *
 * Drop it in cron, a Kubernetes liveness probe, or a CI step. The checks are
 * chosen so that a failure means something specific rather than "site down":
 * in particular, an identity that stops verifying is a `critical` finding, not a
 * degraded one, because it means a record is corrupt or forged rather than a
 * server being slow.
 */

import { createHash } from "node:crypto";

const REGISTRY = process.env.LN_REGISTRY_URL ?? "https://registry.libertynet.ai";
const TIMEOUT_MS = Number(process.env.LN_TIMEOUT_MS ?? 15_000);
const FRESHNESS_MS = 10 * 60 * 1000;

const asJson = process.argv.includes("--json");
const requireIdx = process.argv.indexOf("--require-callable");
const requireCallable = requireIdx === -1 ? 0 : Number(process.argv[requireIdx + 1] ?? 1);

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

function verifyIdBinding(did, pk) {
  const raw = /^[0-9a-f]{64}$/.test(pk ?? "") ? Buffer.from(pk, "hex") : b58decode(pk ?? "");
  if (!raw || raw.length !== 32) return false;
  const m = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/.exec(did ?? "");
  if (!m) return false;
  const [, tag, body] = m;
  if (body.length === 64) return tag === undefined && body === raw.toString("hex");
  if (body.length !== 8 && body.length !== 10) return false;
  return body === createHash("sha256").update(raw).digest("hex").slice(0, body.length);
}

async function timed(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { name, ok: true, ms: Date.now() - started, value };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - started, error: String(e.message ?? e) };
  }
}

const get = async (path) => {
  const res = await fetch(`${REGISTRY}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// ---------------------------------------------------------------------------

const checks = [];
const findings = [];

const health = await timed("registry /health", () => get("/health"));
checks.push(health);

if (!health.ok) {
  // Nothing else is meaningful if the registry is unreachable.
  const report = { status: "down", registry: REGISTRY, checks, findings: [health.error] };
  console[asJson ? "log" : "error"](
    asJson ? JSON.stringify(report, null, 2) : `DOWN  ${REGISTRY}\n  ${health.error}`,
  );
  process.exit(2);
}

const nodesCheck = await timed("registry /nodes", () => get("/nodes"));
checks.push(nodesCheck);

let verified = 0;
let rejected = [];
let callable = 0;

if (nodesCheck.ok) {
  const nodes = nodesCheck.value.nodes ?? [];
  for (const n of nodes) {
    if (verifyIdBinding(n.did, n.public_key)) verified++;
    else rejected.push(n.did);
  }
  callable = nodes.filter(
    (n) =>
      (n.reachability ?? "public") === "public" &&
      (n.signature_present ?? Boolean(n.signature)) &&
      n.last_seen &&
      Date.now() - Date.parse(n.last_seen) < FRESHNESS_MS &&
      verifyIdBinding(n.did, n.public_key),
  ).length;

  if (rejected.length) {
    // Not "degraded". A record whose DID does not derive from its key is corrupt
    // or forged, and that deserves a louder word than a slow server does.
    findings.push({
      severity: "critical",
      detail: `${rejected.length} record(s) failed id-binding: ${rejected.join(", ")}`,
    });
  }
  if (callable < requireCallable) {
    findings.push({
      severity: "degraded",
      detail: `${callable} callable node(s), required ${requireCallable}`,
    });
  }
} else {
  findings.push({ severity: "degraded", detail: `/nodes failed: ${nodesCheck.error}` });
}

const status = findings.some((f) => f.severity === "critical")
  ? "critical"
  : findings.length
    ? "degraded"
    : "healthy";

const report = {
  status,
  registry: REGISTRY,
  checked_at: new Date().toISOString(),
  registered: nodesCheck.ok ? nodesCheck.value.nodes.length : null,
  verified,
  rejected: rejected.length,
  callable,
  latency_ms: Object.fromEntries(checks.map((c) => [c.name, c.ms])),
  findings,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const label = { healthy: "HEALTHY", degraded: "DEGRADED", critical: "CRITICAL" }[status];
  console.log(`${label}  ${REGISTRY}`);
  console.log(`  registered ${report.registered}   verified ${verified}   callable ${callable}`);
  for (const c of checks) console.log(`  ${c.name.padEnd(22)} ${c.ok ? "ok" : "FAIL"}  ${c.ms}ms`);
  for (const f of findings) console.log(`  [${f.severity}] ${f.detail}`);
}

process.exit(status === "healthy" ? 0 : 1);

// → HEALTHY  registered 28  verified 28  callable 1     (exit 0)
