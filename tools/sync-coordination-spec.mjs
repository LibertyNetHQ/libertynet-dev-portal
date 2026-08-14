#!/usr/bin/env node
/**
 * Splice the Coordination API into the published OpenAPI contract.
 *
 *     node tools/sync-coordination-spec.mjs           write the generated block
 *     node tools/sync-coordination-spec.mjs --check   fail if it is out of date
 *     node tools/sync-coordination-spec.mjs --fetch   re-read the contract from the live gateway
 *
 * # Why this is generated and not written
 *
 * The Coordination API has its own authoritative OpenAPI document, and it does not live here: it
 * is compiled into `ln-coordination-gateway` and served by the running process at
 * `/coordination/openapi.json`. In that repository a test asserts the document and the Rust
 * `Operation` enum describe the same operations, so it cannot quietly fall behind the code.
 *
 * Hand-copying those 16 paths and 42 schemas into `libertynet-v1.yaml` would create a second
 * source of truth for the same contract — and the second one is always the one that goes stale.
 * A developer would generate a client from this file, and the gateway would answer according to
 * the other. So the vendored copy in `api-spec/coordination-openapi.json` is fetched from the
 * live deployment, and this script is the only thing that writes the corresponding YAML.
 *
 * # What it does to the document on the way through
 *
 * * **Namespaces every component.** `Error` exists in both documents and means different things.
 *   Coordination components become `CoordinationError`, `CoordinationSignedRequest`, and so on,
 *   so a merge can never silently redefine one contract's schema with the other's.
 * * **Pins a per-path `servers`.** These endpoints are not on `registry.libertynet.ai`, which is
 *   the document-level server. A path-level override is how OpenAPI says "this one is elsewhere",
 *   and without it every generated client would send coordination calls to the registry.
 * * **Carries `x-ln-status` from `api-spec/status.json`**, like every other operation here, so
 *   the badge on a coordination endpoint is decided by the same matrix as everything else.
 *
 * Only the region between the markers is rewritten. The hand-written parts of the YAML are left
 * byte-for-byte alone — reflowing them would turn every regeneration into a diff nobody reads.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");

const checkOnly = process.argv.includes("--check");
const fetchLive = process.argv.includes("--fetch");

const VENDORED = path.join(ROOT, "api-spec/coordination-openapi.json");
const YAML_FILE = path.join(ROOT, "api-spec/libertynet-v1.yaml");
const STATUS_FILE = path.join(ROOT, "api-spec/status.json");

/** The public base URL of the deployed gateway. Also the `base_url` of the matrix group. */
const COORDINATION_BASE =
  process.env.LN_COORDINATION_URL ?? "https://libertynet.ai/coordination";

const PATHS_BEGIN = "  # >>> BEGIN generated coordination paths";
const PATHS_END = "  # <<< END generated coordination paths";
const SCHEMAS_BEGIN = "    # >>> BEGIN generated coordination schemas";
const SCHEMAS_END = "    # <<< END generated coordination schemas";
const PARAMS_BEGIN = "    # >>> BEGIN generated coordination parameters";
const PARAMS_END = "    # <<< END generated coordination parameters";
const RESPONSES_BEGIN = "    # >>> BEGIN generated coordination responses";
const RESPONSES_END = "    # <<< END generated coordination responses";

const NS = "Coordination";

// ---------------------------------------------------------------------------
// Fetch (optional) — the vendored copy comes from the running deployment
// ---------------------------------------------------------------------------

if (fetchLive) {
  const url = `${COORDINATION_BASE}/openapi.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    console.error(`✗ ${url} answered HTTP ${res.status}`);
    process.exit(2);
  }
  const doc = await res.json();
  await writeFile(VENDORED, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`✓ vendored the contract served by ${url} (version ${doc.info?.version})`);
}

const coord = JSON.parse(await readFile(VENDORED, "utf8"));
const status = JSON.parse(await readFile(STATUS_FILE, "utf8"));

// ---------------------------------------------------------------------------
// Namespacing
// ---------------------------------------------------------------------------

/** Rewrite every internal `$ref` so it points at the namespaced component. */
function namespaceRefs(node) {
  if (Array.isArray(node)) return node.map(namespaceRefs);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("#/components/")) {
        const [, , section, name] = v.split("/");
        out[k] = `#/components/${section}/${NS}${name}`;
      } else {
        out[k] = namespaceRefs(v);
      }
    }
    return out;
  }
  return node;
}

// ---------------------------------------------------------------------------
// A minimal, deterministic YAML emitter
// ---------------------------------------------------------------------------
//
// Deliberately not a library. The output has to satisfy the line scanner in
// `tools/sync-status.mjs` — paths at two spaces, methods at four, `x-ln-status` at six — and a
// general emitter is free to fold long strings or reorder keys in ways that silently break it.
// The subset needed here (maps, arrays, strings, numbers, booleans) is small and the constraint
// is worth more than the generality.

function scalar(v) {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  // Always quote. It is never wrong, and it removes every question about `yes`, `1.0`, leading
  // `*`, embedded `:` and the rest of YAML's implicit typing.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function emit(node, indent) {
  const pad = " ".repeat(indent);
  const lines = [];

  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === "object") {
        const sub = emit(item, indent + 2);
        lines.push(`${pad}-${sub[0].slice(indent + 1)}`);
        lines.push(...sub.slice(1));
      } else {
        lines.push(`${pad}- ${scalar(item)}`);
      }
    }
    return lines;
  }

  for (const [k, v] of Object.entries(node)) {
    const key = `${pad}${/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) ? k : `"${k}"`}:`;
    // `x-ln-status` is the one value `tools/sync-status.mjs` rewrites in place, and its line
    // scanner matches a bare token. Emitting it quoted here made the two generators disagree
    // forever: this one wrote `"implemented"`, that one rewrote it to `implemented`, and each
    // then reported the file as out of date with itself.
    if (k === "x-ln-status") {
      lines.push(`${key} ${v}`);
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
      lines.push(`${key} {}`);
    } else if (Array.isArray(v) && v.length === 0) {
      lines.push(`${key} []`);
    } else if (v && typeof v === "object") {
      lines.push(key);
      lines.push(...emit(v, indent + 2));
    } else {
      lines.push(`${key} ${scalar(v)}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Build the paths block
// ---------------------------------------------------------------------------

const matrix = new Map();
for (const group of status.groups) {
  if (group.id !== "coordination") continue;
  for (const e of group.endpoints) matrix.set(`${e.method} ${e.path}`, e.status);
}
if (matrix.size === 0) {
  console.error(
    "✗ api-spec/status.json has no `coordination` group. The matrix decides each badge, so " +
      "generating operations without one would publish endpoints with no status at all.",
  );
  process.exit(2);
}

const pathLines = [];
const missing = [];

for (const [p, item] of Object.entries(coord.paths)) {
  const methods = Object.entries(item).filter(([m]) =>
    ["get", "post", "put", "delete", "patch"].includes(m),
  );
  if (!methods.length) continue;

  const rendered = {};
  for (const [method, op] of methods) {
    const key = `${method.toUpperCase()} ${p}`;
    const level = matrix.get(key);
    if (!level) {
      missing.push(key);
      continue;
    }
    // Key order is fixed and `summary` comes first, because `sync-status.mjs` reads the first
    // `summary:` it sees at six spaces after a method line.
    const ns = namespaceRefs(op);
    rendered[method] = {
      summary: ns.summary ?? key,
      ...(ns.description ? { description: ns.description } : {}),
      "x-ln-status": level,
      operationId: ns.operationId ?? undefined,
      tags: ["Coordination"],
      ...(ns.parameters ? { parameters: ns.parameters } : {}),
      ...(ns.requestBody ? { requestBody: ns.requestBody } : {}),
      ...(ns.responses ? { responses: ns.responses } : {}),
      ...(ns.security ? { security: ns.security } : {}),
    };
    if (rendered[method].operationId === undefined) delete rendered[method].operationId;
  }
  if (!Object.keys(rendered).length) continue;

  // The per-path server override. Without it a generated client sends these to the registry.
  rendered.servers = [{ url: COORDINATION_BASE, description: "Public coordination gateway" }];

  pathLines.push(`  ${p}:`);
  pathLines.push(...emit(rendered, 4));
}

if (missing.length) {
  console.error(
    `✗ the live contract serves operations the matrix does not list:\n    ${missing.join("\n    ")}\n\n` +
      "  Add them to the `coordination` group in api-spec/status.json. An endpoint published " +
      "without a status is exactly the unbadged claim this repo exists to prevent.",
  );
  process.exit(1);
}

// Stale in the other direction: the matrix claims something the contract does not serve.
const served = new Set();
for (const [p, item] of Object.entries(coord.paths)) {
  for (const m of Object.keys(item)) {
    if (["get", "post", "put", "delete", "patch"].includes(m)) served.add(`${m.toUpperCase()} ${p}`);
  }
}
const phantom = [...matrix.keys()].filter((k) => !served.has(k));
if (phantom.length) {
  console.error(
    `✗ api-spec/status.json lists coordination endpoints the deployed contract does not serve:\n` +
      `    ${phantom.join("\n    ")}`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build the schemas block
// ---------------------------------------------------------------------------

function componentBlock(section) {
  const out = [];
  for (const [name, node] of Object.entries(coord.components?.[section] ?? {})) {
    out.push(`    ${NS}${name}:`);
    out.push(...emit(namespaceRefs(node), 6));
  }
  return out;
}

const schemaLines = componentBlock("schemas");
const paramLines = componentBlock("parameters");
const responseLines = componentBlock("responses");

// ---------------------------------------------------------------------------
// Splice
// ---------------------------------------------------------------------------

function splice(src, begin, end, body, label) {
  const lines = src.split("\n");
  const i = lines.indexOf(begin);
  const j = lines.indexOf(end);
  if (i === -1 || j === -1) {
    console.error(
      `✗ api-spec/libertynet-v1.yaml is missing the ${label} markers.\n` +
        `  Expected these two lines:\n    ${begin}\n    ${end}`,
    );
    process.exit(2);
  }
  return [...lines.slice(0, i + 1), ...body, ...lines.slice(j)].join("\n");
}

const original = await readFile(YAML_FILE, "utf8");
let next = splice(original, PATHS_BEGIN, PATHS_END, pathLines, "coordination paths");
next = splice(next, SCHEMAS_BEGIN, SCHEMAS_END, schemaLines, "coordination schemas");
next = splice(next, PARAMS_BEGIN, PARAMS_END, paramLines, "coordination parameters");
next = splice(next, RESPONSES_BEGIN, RESPONSES_END, responseLines, "coordination responses");

if (next === original) {
  console.log(
    `✓ coordination contract in sync (${pathLines.filter((l) => /^ {2}\//.test(l)).length} paths, ` +
      `${Object.keys(coord.components?.schemas ?? {}).length} schemas, contract ${coord.info?.version})`,
  );
  process.exit(0);
}

if (checkOnly) {
  console.error(
    "✗ api-spec/libertynet-v1.yaml is out of date with api-spec/coordination-openapi.json.\n" +
      "  Run: node tools/sync-coordination-spec.mjs",
  );
  process.exit(1);
}

await writeFile(YAML_FILE, next);
console.log(
  `✓ wrote the coordination block into api-spec/libertynet-v1.yaml ` +
    `(contract ${coord.info?.version}, base ${COORDINATION_BASE})`,
);
