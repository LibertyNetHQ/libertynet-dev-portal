#!/usr/bin/env node
/**
 * Do both SDKs produce the same canonical bytes?
 *
 *     node tools/check-canonical-parity.mjs
 *
 * Two implementations of a signing format is two chances to be wrong, and the
 * failure is silent: a credential signed by the Python SDK and rejected by a
 * registry that agrees with the TypeScript SDK looks exactly like a bad key.
 * Nobody debugging a `401 DC_BAD_SIGNATURE` guesses "the comma-join sorts
 * differently in the other language".
 *
 * So both are asked for the same credential's bytes and the results compared
 * byte for byte, including the cases where they are most likely to diverge:
 * unsorted permissions, an empty permissions list, and non-ASCII text.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CASES = [
  {
    name: "ordinary credential",
    credential: {
      credential_id: "cred-aaa",
      operator_did: "did:svrp:o:11111111",
      operator_root_public_key: "RootKeyB58",
      device_id: "laptop",
      device_public_key: "DeviceKeyB58",
      permissions: ["nodes.bind"],
      issued_at: "2026-08-01T00:00:00Z",
      expires_at: "2026-11-01T00:00:00Z",
      revocation_id: "rev-bbb",
    },
  },
  {
    // The registry sorts before joining. An SDK that preserved caller order
    // would sign different bytes for the same permissions.
    name: "permissions given out of order",
    credential: {
      credential_id: "cred-aaa",
      operator_did: "did:svrp:o:11111111",
      operator_root_public_key: "RootKeyB58",
      device_id: "laptop",
      device_public_key: "DeviceKeyB58",
      permissions: ["z.last", "a.first", "m.middle"],
      issued_at: "2026-08-01T00:00:00Z",
      expires_at: "2026-11-01T00:00:00Z",
      revocation_id: "rev-bbb",
    },
  },
  {
    // Empty must be "" — not "[]", not absent, not a literal "None".
    name: "no permissions at all",
    credential: {
      credential_id: "cred-aaa",
      operator_did: "did:svrp:o:11111111",
      operator_root_public_key: "RootKeyB58",
      device_id: "laptop",
      device_public_key: "DeviceKeyB58",
      permissions: [],
      issued_at: "2026-08-01T00:00:00Z",
      expires_at: "2026-11-01T00:00:00Z",
      revocation_id: "rev-bbb",
    },
  },
  {
    // A device named in Japanese is a device. UTF-8 encoding must match.
    name: "non-ASCII device id",
    credential: {
      credential_id: "cred-aaa",
      operator_did: "did:svrp:o:11111111",
      operator_root_public_key: "RootKeyB58",
      device_id: "ノートパソコン",
      device_public_key: "DeviceKeyB58",
      permissions: ["nodes.bind"],
      issued_at: "2026-08-01T00:00:00Z",
      expires_at: "2026-11-01T00:00:00Z",
      revocation_id: "rev-bbb",
    },
  },
];

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err || out))));
    if (opts?.stdin) {
      p.stdin.write(opts.stdin);
      p.stdin.end();
    }
  });
}

const TS_DRIVER = `
import { canonDeviceCredential } from "${path.join(ROOT, "sdk/typescript/src/auth.ts")}";
const cases = JSON.parse(process.argv[2]);
console.log(JSON.stringify(cases.map((c) => Buffer.from(canonDeviceCredential(c)).toString("base64"))));
`;

const PY_DRIVER = `
import json, sys, base64
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "sdk/python"))})
from libertynet import canon_device_credential
cases = json.loads(sys.argv[1])
print(json.dumps([base64.b64encode(canon_device_credential(c)).decode() for c in cases]))
`;

const payload = JSON.stringify(CASES.map((c) => c.credential));

// A driver on disk rather than -e, so the TypeScript import resolves relative to
// a real file and type stripping behaves the way it does for the SDK's own tests.
const { writeFile, rm, mkdtemp } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const dir = await mkdtemp(path.join(tmpdir(), "ln-parity-"));

let tsOut;
let pyOut;

try {
  const tsFile = path.join(dir, "driver.ts");
  const pyFile = path.join(dir, "driver.py");
  await writeFile(tsFile, TS_DRIVER);
  await writeFile(pyFile, PY_DRIVER);

  tsOut = JSON.parse(await run("node", ["--experimental-strip-types", tsFile, payload]));
  pyOut = JSON.parse(await run("python3", [pyFile, payload]));
} catch (e) {
  console.error(`\n✗ could not run both SDKs: ${e.message}\n`);
  process.exit(1);
} finally {
  await rm(dir, { recursive: true, force: true });
}

let failures = 0;

for (const [i, c] of CASES.entries()) {
  const same = tsOut[i] === pyOut[i];
  if (!same) failures++;
  console.log(`  ${same ? "✓" : "✗"} ${c.name}`);
  if (!same) {
    console.log(`      typescript: ${Buffer.from(tsOut[i], "base64").toString("utf8").replace(/\n/g, "⏎")}`);
    console.log(`      python:     ${Buffer.from(pyOut[i], "base64").toString("utf8").replace(/\n/g, "⏎")}`);
  }
}

if (failures === 0) {
  console.log(`\n✓ both SDKs produce identical canonical bytes across ${CASES.length} cases\n`);
  process.exit(0);
}

console.error(`\n✗ the two SDKs disagree on ${failures} case(s) — one of them signs credentials nothing will accept\n`);
process.exit(1);
