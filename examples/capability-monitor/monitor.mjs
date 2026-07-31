/**
 * Watch for a capability appearing on, or disappearing from, the network.
 *
 *     node monitor.mjs inference
 *     node monitor.mjs storage --once
 *
 * Zero dependencies. Useful as a health check: "is there anyone who can do X
 * right now?" is a different and far more useful question than "how many nodes
 * are registered?".
 */

import { createHash } from "node:crypto";

const REGISTRY = process.env.LN_REGISTRY_URL ?? "https://registry.libertynet.ai";
const INTERVAL_MS = Number(process.env.LN_POLL_INTERVAL_MS ?? 30_000);
const FRESHNESS_MS = 10 * 60 * 1000;

const args = process.argv.slice(2);
const capability = args.find((a) => !a.startsWith("--")) ?? "inference";
const once = args.includes("--once");

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

/** Verified AND fresh. Both halves matter. */
async function providers() {
  const { nodes } = await (await fetch(`${REGISTRY}/nodes`)).json();

  return nodes.filter((n) => {
    // A forged record advertising a capability is worse than no record at all.
    if (!verifyIdBinding(n.did, n.public_key)) return false;

    // "status: active" never decays — only last_seen does.
    if (!n.last_seen || Date.now() - Date.parse(n.last_seen) > FRESHNESS_MS) return false;

    return (n.capabilities ?? []).includes(capability);
  });
}

let previous = null;

async function check() {
  const current = await providers();
  const dids = new Set(current.map((n) => n.did));
  const stamp = new Date().toISOString();

  if (previous !== null) {
    for (const did of dids) {
      if (!previous.has(did)) console.log(`${stamp}  GAINED  ${did}`);
    }
    for (const did of previous) {
      if (!dids.has(did)) console.log(`${stamp}  LOST    ${did}`);
    }
  }

  // Zero is a real answer about the network, not an error. Most declared
  // capabilities have never been advertised by anyone.
  const state = current.length === 0 ? "NONE AVAILABLE" : `${current.length} available`;
  console.log(`${stamp}  ${capability}: ${state}`);

  previous = dids;
  return current.length;
}

const count = await check();

if (once) {
  // Exit non-zero when nobody can serve the capability, so this works as a
  // health check in CI or a cron job without any extra plumbing.
  process.exitCode = count > 0 ? 0 : 1;
} else {
  console.log(`\nPolling every ${INTERVAL_MS / 1000}s. Ctrl-C to stop.\n`);
  setInterval(() => {
    check().catch((e) => console.error("poll failed:", e.message));
  }, INTERVAL_MS);
}

// → 2026-08-01T00:12:44.031Z  inference: 1 available
