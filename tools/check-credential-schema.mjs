#!/usr/bin/env node
/**
 * Build a DeviceCredential strictly from the published schema, and make the
 * live registry accept it.
 *
 *     node tools/check-credential-schema.mjs
 *     node tools/check-credential-schema.mjs --offline   # structure only
 *
 * The published OpenAPI schema used to list seven fields where the registry
 * signs over nine. Nobody noticed, because every credential in this repository
 * was written by hand from the registry's own source — the one place a reader
 * cannot look. The documentation could say anything at all and every test would
 * still pass.
 *
 * So this reads `x-ln-canonical` out of the spec at run time, signs exactly
 * those fields in exactly that order, sends only the fields the spec marks
 * required, and requires a session token back. If someone edits the spec into
 * something that cannot work, this fails — which is the only way a schema can
 * be said to be correct rather than merely plausible.
 */

import { readFile } from "node:fs/promises";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = process.env.LN_REGISTRY_URL ?? "https://registry.libertynet.ai";
const OFFLINE = process.argv.includes("--offline");

const failures = [];
const notes = [];

// ---------------------------------------------------------------------------
// read the schema — deliberately not by importing a YAML library
// ---------------------------------------------------------------------------

const yaml = await readFile(path.join(ROOT, "api-spec/libertynet-v1.yaml"), "utf8");

/** The `DeviceCredential:` block, up to the next sibling schema. */
const block = /^    DeviceCredential:\n([\s\S]*?)(?=^    [A-Z]\w+:\n)/m.exec(yaml);
if (!block) {
  console.error("✗ DeviceCredential schema not found in api-spec/libertynet-v1.yaml\n");
  process.exit(1);
}

const schema = block[1];

/** `required:` as a block sequence. */
const requiredBlock = /^      required:\n((?:^ {8}- .*\n)+)/m.exec(schema);
const required = requiredBlock
  ? [...requiredBlock[1].matchAll(/^ {8}- (\S+)/gm)].map((m) => m[1])
  : [];

/** `x-ln-canonical:` — the domain string and the signed field order. */
const canonBlock = /^      x-ln-canonical:\n((?:^ {8}.*\n)+)/m.exec(schema);
const domain = canonBlock ? /domain:\s*'([^']+)'/.exec(canonBlock[1])?.[1] : null;
const canonFields = canonBlock
  ? [...canonBlock[1].matchAll(/^ {10}- (\w+)/gm)].map((m) => m[1])
  : [];

notes.push(`required: ${required.length} field(s)`);
notes.push(`signed:   ${canonFields.length} field(s) under ${domain ?? "(no domain)"}`);

if (!domain) failures.push("x-ln-canonical.domain is missing — a reader cannot know what to sign");
if (canonFields.length === 0) failures.push("x-ln-canonical.fields is missing or empty");

// Every signed field except `permissions` must also be required: signing over a
// field the caller is allowed to omit produces a signature nobody can reproduce.
for (const f of canonFields) {
  if (f === "permissions") continue;
  if (!required.includes(f)) {
    failures.push(`"${f}" is signed over but not in required — a credential built from this schema cannot verify`);
  }
}

// ---------------------------------------------------------------------------
// build one, and see whether the registry agrees
// ---------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out || "1";
}

function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { privateKey, raw, b58: b58(raw) };
}

const rfc3339 = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** One retry layer: a cold connection timing out is not a schema verdict. */
async function post(url, body) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

if (!OFFLINE && failures.length === 0) {
  const root = newKey();
  const device = newKey();
  const did = `did:svrp:o:${createHash("sha256").update(root.raw).digest("hex").slice(0, 8)}`;
  const now = new Date();

  // Values for every field the schema names. Nothing here is hard-coded to an
  // order — the order comes from the spec, below.
  const values = {
    credential_id: `cred-${createHash("sha256").update(device.raw).digest("hex").slice(0, 12)}`,
    operator_did: did,
    operator_root_public_key: root.b58,
    device_id: "schema-check",
    device_public_key: device.b58,
    permissions: ["nodes.bind"],
    issued_at: rfc3339(now),
    expires_at: rfc3339(new Date(now.getTime() + 3_600_000)),
    revocation_id: `rev-${createHash("sha256").update(root.raw).digest("hex").slice(0, 12)}`,
  };

  const missing = canonFields.filter((f) => values[f] === undefined);
  if (missing.length) {
    failures.push(`the spec signs over field(s) this check cannot produce: ${missing.join(", ")}`);
  } else {
    const canonical = [
      domain,
      ...canonFields.map((f) =>
        f === "permissions" ? [...values.permissions].sort().join(",") : values[f],
      ),
    ].join("\n");

    const credential = { signature: b58(sign(null, Buffer.from(canonical, "utf8"), root.privateKey)) };

    // Send every field that was signed, plus anything else marked required.
    //
    // The first version of this check sent only `required`, which excludes the
    // optional `permissions` — while still signing over "nodes.bind". The
    // registry then rebuilt the canonical bytes with an empty permissions
    // string and rejected it, correctly. An issuer sends what it signed; the
    // "" rule is for a credential that genuinely grants nothing, and it gets
    // its own assertion below rather than being smuggled in here.
    for (const f of [...new Set([...canonFields, ...required])]) {
      if (f !== "signature") credential[f] = values[f];
    }

    const ch = await post(`${REGISTRY}/v1/auth/challenge`, {
      operator_did: did,
      device_public_key: device.b58,
    });

    if (!ch.ok) {
      failures.push(`could not obtain a challenge: HTTP ${ch.status}`);
    } else {
      const { challenge } = await ch.json();
      const issued_at = rfc3339(new Date());

      const res = await post(`${REGISTRY}/v1/auth/device-login`, {
        device_credential: credential,
        challenge,
        issued_at,
        signature: b58(
          sign(
            null,
            Buffer.from(
              ["libertynet-auth-challenge:v1", did, device.b58, challenge, issued_at].join("\n"),
              "utf8",
            ),
            device.privateKey,
          ),
        ),
      });

      const body = await res.text();

      if (res.ok && JSON.parse(body).session_token) {
        notes.push(`live: a credential built from the published schema was accepted (${did})`);

        // The schema says an omitted `permissions` must be signed as "". That
        // sentence is either true of the running registry or it is decoration.
        if (canonFields.includes("permissions") && !required.includes("permissions")) {
          const r2 = newKey();
          const d2 = newKey();
          const did2 = `did:svrp:o:${createHash("sha256").update(r2.raw).digest("hex").slice(0, 8)}`;
          const t = new Date();
          const v2 = {
            ...values,
            operator_did: did2,
            operator_root_public_key: r2.b58,
            device_public_key: d2.b58,
            issued_at: rfc3339(t),
            expires_at: rfc3339(new Date(t.getTime() + 3_600_000)),
          };

          const canon2 = [
            domain,
            ...canonFields.map((f) => (f === "permissions" ? "" : v2[f])),
          ].join("\n");

          const cred2 = { signature: b58(sign(null, Buffer.from(canon2, "utf8"), r2.privateKey)) };
          for (const f of required) if (f !== "signature") cred2[f] = v2[f];

          const ch2 = await post(`${REGISTRY}/v1/auth/challenge`, {
            operator_did: did2,
            device_public_key: d2.b58,
          });
          const { challenge: c2 } = await ch2.json();
          const at2 = rfc3339(new Date());

          const res2 = await post(`${REGISTRY}/v1/auth/device-login`, {
            device_credential: cred2,
            challenge: c2,
            issued_at: at2,
            signature: b58(
              sign(
                null,
                Buffer.from(
                  ["libertynet-auth-challenge:v1", did2, d2.b58, c2, at2].join("\n"),
                  "utf8",
                ),
                d2.privateKey,
              ),
            ),
          });

          if (res2.ok) {
            notes.push('live: omitting `permissions` and signing over "" was accepted, as documented');
          } else {
            failures.push(
              'the schema says an omitted `permissions` is signed as "", but the live registry ' +
                `rejected exactly that: HTTP ${res2.status} ${(await res2.text()).slice(0, 120)}`,
            );
          }
        }
      } else {
        failures.push(
          `the live registry REJECTED a credential built strictly from the published schema: ` +
            `HTTP ${res.status} ${body.slice(0, 160)}`,
        );
      }
    }
  }
} else if (OFFLINE) {
  notes.push("live check skipped (--offline)");
}

// ---------------------------------------------------------------------------

for (const n of notes) console.log(`  · ${n}`);

if (failures.length === 0) {
  console.log(`\n✓ the published DeviceCredential schema is sufficient to build a working credential\n`);
  process.exit(0);
}

console.error(`\n✗ ${failures.length} problem(s) with the published schema:\n`);
for (const f of failures) console.error(`  ${f}`);
console.error("");
process.exit(1);
