#!/usr/bin/env node
/**
 * Example and template safety checker.
 *
 *     node tools/check-examples.mjs
 *
 * Example code is the most-copied code in any project. Whatever habit it shows,
 * readers learn — so these rules are enforced mechanically rather than by review,
 * across `examples/` and the scaffolder's generated templates alike.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");

const failures = [];
const fail = (rule, where, message) => failures.push({ rule, where, message });

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "dist", "out", ".next"].includes(e.name)) continue;
      await walk(full, out);
    } else if (/\.(mjs|js|ts|py)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Anything that looks like a committed secret.
 *
 * The point is not that our examples currently contain one — it is that if
 * someone adds one in a year, this fails rather than shipping it.
 */
const SECRET_PATTERNS = [
  {
    re: /(?:api[_-]?key|secret|password|passwd|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_\-+/]{12,}["']/i,
    why: "looks like a hard-coded credential",
  },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: "contains a PEM private key" },
  { re: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/, why: "contains a provider-style secret key" },
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}/, why: "contains a literal bearer token" },
];

/** Ways to make identity verification optional. None may exist. */
const ESCAPE_HATCHES = [
  { re: /skip[_-]?verif/i, why: "offers a way to skip verification" },
  { re: /\binsecure\s*[:=]\s*true/i, why: "offers an insecure mode" },
  { re: /trust[_-]?all/i, why: "offers a trust-everything mode" },
  { re: /verify\s*[:=]\s*false/i, why: "lets verification be disabled" },
  { re: /rejectUnauthorized\s*:\s*false/, why: "disables TLS verification" },
];

/**
 * Value movement. LibertyNet has none, so example code cannot demonstrate one.
 * Mentioning it in prose to say it does not exist is fine — calling it is not.
 */
const VALUE_MOVEMENT = [
  { re: /\.transfer\s*\([^)]/, why: "calls a transfer method" },
  { re: /sendTransaction\s*\(/, why: "calls sendTransaction" },
  { re: /\.signAndSend\s*\(/, why: "calls signAndSend" },
];

async function checkFile(file) {
  const text = await readFile(file, "utf8");
  const rel = path.relative(ROOT, file);

  for (const { re, why } of SECRET_PATTERNS) {
    if (re.test(text)) fail("secrets", rel, why);
  }

  for (const { re, why } of ESCAPE_HATCHES) {
    if (re.test(text)) fail("verification", rel, why);
  }

  for (const { re, why } of VALUE_MOVEMENT) {
    const m = re.exec(text);
    if (!m) continue;

    // A throwing stub whose whole job is to say "not built" is the point, not a violation.
    const context = text.slice(Math.max(0, m.index - 400), m.index + 400);
    const isRefusal = /notBuilt|NotYetWired|planned|not built|throw|raise/i.test(context);

    if (!isRefusal) fail("value-movement", rel, why);
  }
}

// ---------------------------------------------------------------------------
// Per-example structural rules
// ---------------------------------------------------------------------------

async function checkExampleShape() {
  const dir = path.join(ROOT, "examples");
  const entries = await readdir(dir, { withFileTypes: true });

  for (const e of entries) {
    if (!e.isDirectory()) continue;

    const files = await walk(path.join(dir, e.name));
    if (files.length === 0) {
      fail("shape", `examples/${e.name}`, "contains no runnable file");
      continue;
    }

    // Every example must verify identity somewhere — a LibertyNet example that
    // trusts the registry's word teaches exactly the wrong reflex.
    const combined = (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");

    // The rule is "no example trusts the registry's word about who a node is".
    // There is more than one honest way to honour that: call the helper, do the
    // arithmetic inline, or ask the MCP tool. Matching only one function name
    // failed examples that verify perfectly well, which teaches people to
    // silence the check rather than obey it.
    const verifies = [
      /verify_?[iI]d[_-]?[bB]inding/,           // the named helper
      /verify_identity/,                         // via the MCP tool
      /sha256\((?:key|raw|pk|public)/i,          // the arithmetic, inline
    ].some((re) => re.test(combined));

    if (!verifies) {
      fail("shape", `examples/${e.name}`, "never verifies an identity");
    }
  }
}

// ---------------------------------------------------------------------------
// Scaffolder templates — checked through the generator, not the file on disk
// ---------------------------------------------------------------------------

async function checkGeneratedTemplates() {
  const { AGENT_TYPES, buildProject } = await import(
    path.join(ROOT, "create-libertynet-agent/src/templates.mjs")
  );

  for (const type of AGENT_TYPES) {
    const files = buildProject({
      name: "checked",
      type: type.id,
      capabilities: ["inference"],
      version: "0",
    });

    for (const [name, body] of Object.entries(files)) {
      const where = `template:${type.id}/${name}`;

      for (const { re, why } of SECRET_PATTERNS) {
        if (re.test(body)) fail("secrets", where, why);
      }
      for (const { re, why } of ESCAPE_HATCHES) {
        if (re.test(body)) fail("verification", where, why);
      }
      if (/PLACEHOLDER/.test(body)) {
        fail("shape", where, "contains an unsubstituted placeholder");
      }
    }

    // Every generated project must ship verification and a way to run tests.
    if (!/verifyIdBinding/.test(files["src/libertynet.mjs"] ?? "")) {
      fail("verification", `template:${type.id}`, "client does not verify identities");
    }
    if (!files["test/agent.test.mjs"]) {
      fail("shape", `template:${type.id}`, "generates no tests");
    }
    if (!/test unit/i.test(files["README.md"] ?? "")) {
      fail("shape", `template:${type.id}`, "README omits the Credits test-unit caveat");
    }
  }
}

// ---------------------------------------------------------------------------

const exampleFiles = await walk(path.join(ROOT, "examples"));
for (const f of exampleFiles) await checkFile(f);

await checkExampleShape();
await checkGeneratedTemplates();

console.log(`\nchecked ${exampleFiles.length} example files + every generated template`);

if (failures.length === 0) {
  console.log("✓ example safety checks passed\n");
  process.exit(0);
}

console.error(`\n✗ ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}] ${f.where}: ${f.message}`);
console.error("");
process.exit(1);
