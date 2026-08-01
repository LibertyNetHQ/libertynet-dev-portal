#!/usr/bin/env node
/**
 * Watch the registry and record what changed.
 *
 *     node watch.mjs                 one pass, diff against the last snapshot
 *     node watch.mjs --interval 60   keep watching
 *     node watch.mjs --history       replay what has been recorded so far
 *
 * Zero dependencies. State is a JSONL file — append-only, greppable, and
 * replayable with `tail`, which is worth more than a database for something this
 * small.
 *
 * Why this is useful rather than cute: the registry is a directory with no
 * history. It tells you what is true now and nothing about what changed. A node
 * that swaps its endpoint from a public address to `node://laptop` disappears
 * from everyone's reach with no announcement — and that is exactly the kind of
 * change worth noticing.
 */

import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const REGISTRY = process.env.LN_REGISTRY_URL ?? "https://registry.libertynet.ai";
const STATE_DIR = process.env.LN_STATE_DIR ?? path.join(process.cwd(), ".registry-watch");
const SNAPSHOT = path.join(STATE_DIR, "snapshot.json");
const HISTORY = path.join(STATE_DIR, "history.jsonl");

const args = process.argv.slice(2);
const intervalIdx = args.indexOf("--interval");
const intervalS = intervalIdx === -1 ? 0 : Number(args[intervalIdx + 1] ?? 60);

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

/**
 * Does this DID derive from this key?
 *
 * A watcher that skips this would happily report a forged record as a legitimate
 * JOINED event — announcing an impostor as news. Verify before you report.
 */
function verifyIdBinding(did, publicKey) {
  const raw = /^[0-9a-f]{64}$/.test(publicKey ?? "")
    ? Buffer.from(publicKey, "hex")
    : b58decode(publicKey ?? "");
  if (!raw || raw.length !== 32) return false;

  const m = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/.exec(did ?? "");
  if (!m) return false;

  const [, tag, body] = m;
  if (body.length === 64) return tag === undefined && body === raw.toString("hex");
  if (body.length !== 8 && body.length !== 10) return false;
  return body === createHash("sha256").update(raw).digest("hex").slice(0, body.length);
}

/** The fields whose change is worth reporting. Everything else is noise. */
function fingerprintOf(node) {
  return {
    endpoint: node.endpoint ?? null,
    reachability: node.reachability ?? null,
    capabilities: [...(node.capabilities ?? [])].sort().join(","),
    signed: node.signature_present ?? Boolean(node.signature),
    region: node.region ?? null,
  };
}

async function snapshot() {
  const res = await fetch(`${REGISTRY}/nodes`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`/nodes → HTTP ${res.status}`);

  const { nodes } = await res.json();
  const out = {};
  const rejected = [];

  for (const n of nodes) {
    // Verify before recording. Otherwise a forged record shows up as a JOINED
    // event and this tool becomes a megaphone for whoever forged it.
    if (verifyIdBinding(n.did, n.public_key)) out[n.did] = fingerprintOf(n);
    else rejected.push(n.did);
  }

  if (rejected.length) {
    console.error(`  ! ${rejected.length} record(s) failed id-binding and were NOT recorded:`);
    for (const did of rejected) console.error(`      ${did}`);
    console.error(`    On the production registry this should be zero. Report it.`);
  }
  return out;
}

function diff(before, after) {
  const events = [];

  for (const did of Object.keys(after)) {
    if (!(did in before)) {
      events.push({ kind: "joined", did, now: after[did] });
      continue;
    }
    for (const field of Object.keys(after[did])) {
      const from = before[did][field];
      const to = after[did][field];
      if (String(from) !== String(to)) {
        events.push({ kind: "changed", did, field, from, to });
      }
    }
  }
  for (const did of Object.keys(before)) {
    if (!(did in after)) events.push({ kind: "left", did, was: before[did] });
  }
  return events;
}

function describe(e) {
  const short = e.did.length > 30 ? `${e.did.slice(0, 27)}…` : e.did;

  if (e.kind === "joined") {
    return `JOINED   ${short}  ${e.now.endpoint ?? "(no endpoint)"}  [${e.now.reachability ?? "?"}]`;
  }
  if (e.kind === "left") {
    return `LEFT     ${short}`;
  }
  // A node going from reachable to unreachable is the interesting one — it
  // vanishes from everyone's usable set without any announcement.
  const notable = e.field === "reachability" && e.to !== "public" ? "  ← no longer reachable" : "";
  return `CHANGED  ${short}  ${e.field}: ${e.from} → ${e.to}${notable}`;
}

async function pass() {
  await mkdir(STATE_DIR, { recursive: true });

  const after = await snapshot();
  const stamp = new Date().toISOString();

  if (!existsSync(SNAPSHOT)) {
    await writeFile(SNAPSHOT, JSON.stringify(after, null, 2));
    console.log(`${stamp}  baseline recorded: ${Object.keys(after).length} nodes`);
    console.log(`  state in ${STATE_DIR}`);
    return 0;
  }

  const before = JSON.parse(await readFile(SNAPSHOT, "utf8"));
  const events = diff(before, after);

  if (events.length === 0) {
    console.log(`${stamp}  no change  (${Object.keys(after).length} nodes)`);
  } else {
    console.log(`${stamp}  ${events.length} change(s)`);
    for (const e of events) console.log(`  ${describe(e)}`);
    for (const e of events) {
      await appendFile(HISTORY, JSON.stringify({ at: stamp, ...e }) + "\n");
    }
  }

  await writeFile(SNAPSHOT, JSON.stringify(after, null, 2));
  return events.length;
}

// ---------------------------------------------------------------------------

if (args.includes("--history")) {
  if (!existsSync(HISTORY)) {
    console.log("No history recorded yet. Run without --history first.");
    process.exit(0);
  }
  const lines = (await readFile(HISTORY, "utf8")).trim().split("\n").filter(Boolean);
  console.log(`${lines.length} recorded event(s)\n`);
  for (const line of lines) {
    const e = JSON.parse(line);
    console.log(`  ${e.at}  ${describe(e)}`);
  }
  process.exit(0);
}

await pass();

if (intervalS > 0) {
  console.log(`\nWatching every ${intervalS}s. Ctrl-C to stop.\n`);
  setInterval(() => {
    pass().catch((e) => console.error(`poll failed: ${e.message}`));
  }, intervalS * 1000);
}

// → baseline recorded: 28 nodes
