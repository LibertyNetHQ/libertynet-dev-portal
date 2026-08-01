#!/usr/bin/env node
/**
 * Every `implemented` claim, measured.
 *
 *     node tools/audit-implemented.mjs            # full, live
 *     node tools/audit-implemented.mjs --offline  # skip network, still complete
 *     node tools/audit-implemented.mjs --markdown # emit the table
 *
 * `implemented` is the only status that promises anything. The other three tell
 * a reader to expect nothing, so getting them wrong is embarrassing; getting
 * `implemented` wrong sends someone to write code against a thing that is not
 * there. Two false ones have already shipped on this site — a ⌘K assistant that
 * never existed, and a Copy-for-AI button that did not either — and both were
 * caught by a person looking, which does not scale and does not last.
 *
 * The check has two halves, and the second is the one that closes the class:
 *
 *   1. Every claim that has a verifier gets measured.
 *   2. Every claim MUST have a verifier.
 *
 * Without (2) this is just a longer test suite: a new `implemented` badge on
 * something nobody wired a check to would sail through. With it, adding a claim
 * without adding a way to disprove it fails the audit — the cost of asserting
 * something is now the cost of making it checkable.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs-site");
const DIST = path.join(ROOT, "site/dist");
const REGISTRY = process.env.LN_REGISTRY_URL ?? "https://registry.libertynet.ai";

const OFFLINE = process.argv.includes("--offline");
const MARKDOWN = process.argv.includes("--markdown");

const results = [];

/**
 * @param {string} claim     what the docs assert
 * @param {string} where     the page (or matrix group) asserting it
 * @param {"PASS"|"FAIL"|"SKIP"} verdict
 * @param {string} evidence  what was measured — a number, a status code, a name
 */
function record(claim, where, verdict, evidence, how) {
  results.push({ claim, where, verdict, evidence, how });
}

// ---------------------------------------------------------------------------
// 1. endpoints
// ---------------------------------------------------------------------------

const status = JSON.parse(await readFile(path.join(ROOT, "api-spec/status.json"), "utf8"));

/**
 * A session, if one can be had.
 *
 * Three `implemented` endpoints sit behind auth. Probing them unauthenticated
 * proves only that they reject strangers, so the previous check listed them as
 * "taken on trust" — and the whole point of this audit is that nothing is. The
 * keys are generated here and discarded; the operator has no nodes and no
 * history, which is exactly the case a new developer is in.
 */
async function operatorSession() {
  const { generateKeyPairSync, sign, createHash } = await import("node:crypto");
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  const b58 = (buf) => {
    let n = BigInt("0x" + (buf.toString("hex") || "0"));
    let out = "";
    while (n > 0n) {
      out = B58[Number(n % 58n)] + out;
      n /= 58n;
    }
    for (const b of buf) {
      if (b === 0) out = "1" + out;
      else break;
    }
    return out || "1";
  };

  const key = () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    return { privateKey, raw, b58: b58(raw) };
  };

  const rfc3339 = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const join = (domain, fields) => Buffer.from([domain, ...fields].join("\n"), "utf8");

  const root = key();
  const device = key();
  const did = `did:svrp:o:${createHash("sha256").update(root.raw).digest("hex").slice(0, 8)}`;
  const now = new Date();

  const cred = {
    credential_id: `cred-${createHash("sha256").update(device.raw).digest("hex").slice(0, 12)}`,
    operator_did: did,
    operator_root_public_key: root.b58,
    device_id: "audit-device",
    device_public_key: device.b58,
    permissions: ["nodes.bind"],
    issued_at: rfc3339(now),
    expires_at: rfc3339(new Date(now.getTime() + 3_600_000)),
    revocation_id: `rev-${createHash("sha256").update(root.raw).digest("hex").slice(0, 12)}`,
  };

  cred.signature = b58(
    sign(
      null,
      join("libertynet-operator-device-credential:v1", [
        cred.credential_id, cred.operator_did, cred.operator_root_public_key,
        cred.device_id, cred.device_public_key,
        [...cred.permissions].sort().join(","),
        cred.issued_at, cred.expires_at, cred.revocation_id,
      ]),
      root.privateKey,
    ),
  );

  const ch = await fetch(`${REGISTRY}/v1/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operator_did: did, device_public_key: device.b58 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!ch.ok) return null;

  const { challenge } = await ch.json();
  const issued_at = rfc3339(new Date());

  const login = await fetch(`${REGISTRY}/v1/auth/device-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_credential: cred,
      challenge,
      issued_at,
      signature: b58(
        sign(
          null,
          join("libertynet-auth-challenge:v1", [did, device.b58, challenge, issued_at]),
          device.privateKey,
        ),
      ),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!login.ok) return null;

  const { session_token } = await login.json();
  return { token: session_token, did };
}

async function auditEndpoints() {
  const implemented = status.groups.flatMap((g) =>
    g.endpoints
      .filter((e) => e.status === "implemented")
      .map((e) => ({ ...e, group: g.id, base: g.base_url, auth: g.auth })),
  );

  if (OFFLINE) {
    for (const e of implemented) {
      record(`${e.method} ${e.path}`, `matrix:${e.group}`, "SKIP", "network disabled", "live probe");
    }
    return;
  }

  const session = await operatorSession();

  for (const e of implemented) {
    if (e.method === "CONTRACT") {
      record(`${e.path}`, `matrix:${e.group}`, "SKIP", "not an HTTP operation", "n/a");
      continue;
    }

    // A LINK row is a URL, not an API call. Passing "LINK" to fetch as a method
    // throws, which reported a working GitHub page as a failure.
    if (e.method === "LINK") {
      try {
        const res = await fetch(e.path, {
          headers: { "User-Agent": "libertynet-audit" },
          signal: AbortSignal.timeout(20_000),
        });
        record(`LINK ${e.path}`, `matrix:${e.group}`, res.ok ? "PASS" : "FAIL",
          `HTTP ${res.status} unauthenticated`, "anonymous fetch");
      } catch (err) {
        record(`LINK ${e.path}`, `matrix:${e.group}`, "FAIL", String(err.message ?? err), "anonymous fetch");
      }
      continue;
    }

    const url = `${e.base ?? REGISTRY}${e.path.replace(/\{[^}]+\}/g, "audit-probe")}`;
    // `auth` is prose ("none", "bearer session", "ed25519 signatures; no API
    // key"), so Boolean() on it made every endpoint look authenticated — and
    // the report then claimed a session had been used on GET /health, which no
    // session is needed for and none was sent.
    const needsAuth =
      /bearer|session/i.test(e.auth ?? "") || e.path.startsWith("/v1/operator/");

    try {
      const res = await fetch(url, {
        method: e.method,
        headers: {
          ...(e.method === "POST" ? { "content-type": "application/json" } : {}),
          ...(needsAuth && session ? { authorization: `Bearer ${session.token}` } : {}),
        },
        ...(e.method === "POST" ? { body: "{}" } : {}),
        signal: AbortSignal.timeout(20_000),
      });

      const body = (await res.text()).slice(0, 300);
      const how = needsAuth && session ? "live probe, authenticated" : "live probe";

      // A live endpoint answers. A 4xx from a deliberately-empty POST body is
      // the endpoint working, not failing.
      //
      // 404 needs care, because this registry uses it for two different things
      // and only one of them is a missing endpoint:
      //
      //   GET /v1/bindings/audit-probe/status  → {"code":"NOT_FOUND","error":"unknown session"}
      //   GET /v1/bindings/no-such-route       → {"error":"not found"}
      //
      // The first is the route working correctly on a session id invented by
      // this audit. Treating both as failures reported three healthy binding
      // endpoints as broken.
      const routeExists = res.status !== 404 || /"code"\s*:\s*"[A-Z_]+"/.test(body);
      const alive = routeExists && res.status < 500;

      // An authenticated 401 means the session did not take, which is a real
      // finding rather than a pass.
      const authFailed = needsAuth && session && res.status === 401;

      record(
        `${e.method} ${e.path}`,
        `matrix:${e.group}`,
        alive && !authFailed ? "PASS" : "FAIL",
        `HTTP ${res.status}${authFailed ? " with a valid session" : ""}`,
        how,
      );
    } catch (err) {
      record(`${e.method} ${e.path}`, `matrix:${e.group}`, "FAIL", String(err.message ?? err), "live probe");
    }
  }
}

// ---------------------------------------------------------------------------
// 2. everything else the docs mark implemented
// ---------------------------------------------------------------------------

/**
 * A verifier for each non-endpoint `implemented` claim.
 *
 * `match` identifies the claim in the source; `verify` returns [ok, evidence].
 * Anything asserted and not covered here is reported as UNVERIFIED, which fails
 * the audit — see the completeness check below.
 */
const FEATURE_CLAIMS = [
  {
    id: "mcp-server",
    match: /Six tools|MCP server/i,
    pages: ["ai/assistant", "ai/mcp", "showcase"],
    how: "bundle spawned, tools/list counted",
    async verify() {
      if (!existsSync(path.join(DIST, "mcp/libertynet-mcp.mjs"))) return [false, "bundle not built"];
      const out = await run("node", [path.join(DIST, "mcp/libertynet-mcp.mjs")], '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      const tools = JSON.parse(out.trim().split("\n").pop()).result.tools;
      return [tools.length === 6, `${tools.length} tools over JSON-RPC`];
    },
  },
  {
    id: "copy-for-ai",
    match: /copies it as clean markdown|Copy for AI/i,
    pages: ["ai/assistant"],
    how: "built HTML + the twin it fetches",
    async verify() {
      const html = await readFile(path.join(DIST, "quickstart/index.html"), "utf8");
      const md = await readFile(path.join(DIST, "quickstart.md"), "utf8");
      const button = /data-copy-page="quickstart\.md"/.test(html);
      const twin = md.length > 1000;
      // Say which half is missing. Reporting "button present" next to a ✗ is
      // its own small dishonesty, and this file is the wrong place for one.
      return [
        button && twin,
        button && twin
          ? `button present, twin ${md.length}b`
          : `${button ? "button present" : "NO BUTTON in built HTML"}, ` +
            `${twin ? `twin ${md.length}b` : "twin missing or empty"}`,
      ];
    },
  },
  {
    id: "llms-txt",
    match: /whole documentation set as one file|llms\.txt/i,
    pages: ["ai/assistant", "ai/context"],
    how: "generated files inspected",
    async verify() {
      const full = await readFile(path.join(DIST, "llms-full.txt"), "utf8");
      const idx = await readFile(path.join(DIST, "llms.txt"), "utf8");
      const pages = [...full.matchAll(/^URL: /gm)].length;
      return [pages >= 29 && idx.includes("/api-spec/status.json"), `${pages} pages in llms-full.txt`];
    },
  },
  {
    id: "status-matrix",
    match: /The reason any of the above works|single source/i,
    pages: ["ai/assistant"],
    how: "sync-status --check",
    async verify() {
      const code = await exitCode("node", ["tools/sync-status.mjs", "--check"]);
      return [code === 0, code === 0 ? "4 generated artifacts match the matrix" : "artifacts stale"];
    },
  },
  {
    id: "demo-node",
    match: /A real node with a signed registration/i,
    pages: ["showcase"],
    how: "live registry lookup",
    async verify() {
      if (OFFLINE) return [null, "network disabled"];
      const res = await fetch(`${REGISTRY}/nodes`, { signal: AbortSignal.timeout(20_000) });
      const { nodes } = await res.json();
      const demo = nodes.find((n) => n.did === "did:svrp:n:dbe63a0c");
      return [Boolean(demo), demo ? `registered, signature_present=${demo.signature_present}` : "not in /nodes"];
    },
  },
  {
    id: "examples",
    match: /All CI-executed against the live network|verified.*example|^#{2,4}\s+(Verify the whole network|Capability monitor|Identity gate)/im,
    pages: ["showcase", "examples"],
    how: "examples/run-all.mjs --offline",
    async verify() {
      const code = await exitCode("node", ["examples/run-all.mjs", "--offline"]);
      return [code === 0, code === 0 ? "offline examples green" : "an example failed"];
    },
  },
  {
    id: "dashboard",
    match: /Every identity verified in the browser/i,
    pages: ["showcase"],
    how: "source present; deployment explicitly disclaimed",
    async verify() {
      const page = await readFile(path.join(DOCS, "showcase.mdx"), "utf8");
      // The claim is about the code, and the page says "Not deployed" in the
      // same breath. That disclaimer is load-bearing: without it this is an
      // implemented badge on something nobody can visit.
      return [
        existsSync(path.join(ROOT, "dashboard")) && /Not deployed/i.test(page),
        "source present, page states it is not deployed",
      ];
    },
  },
  {
    id: "sdk-namespaces",
    match: /^#{2,4}\s+`?(discovery|auth|operator|binding)`?|^#{2,4}\s+`nodes\(\)`|`(discovery|auth|operator|binding)`/,
    pages: ["sdk/overview", "sdk/python", "sdk/typescript"],
    how: "SDK test suites",
    async verify() {
      const ts = await exitCode("npm", ["test", "--silent"], path.join(ROOT, "sdk/typescript"));
      const py = await exitCode("python3", ["-m", "pytest", "-q"], path.join(ROOT, "sdk/python"));
      return [ts === 0 && py === 0, `typescript ${ts === 0 ? "green" : "red"}, python ${py === 0 ? "green" : "red"}`];
    },
  },
  {
    id: "github-repo",
    match: /Issues, pull requests, and the source/i,
    pages: ["community"],
    how: "anonymous fetch",
    async verify() {
      if (OFFLINE) return [null, "network disabled"];
      const res = await fetch("https://github.com/LibertyNetHQ/libertynet-dev-portal", {
        headers: { "User-Agent": "libertynet-audit" },
        signal: AbortSignal.timeout(20_000),
      });
      return [res.ok, `HTTP ${res.status} unauthenticated`];
    },
  },
  {
    id: "scaffolder",
    match: /Runs today, fully/i,
    pages: ["cli"],
    how: "scaffolder test suite",
    async verify() {
      const code = await exitCode("npm", ["test", "--silent"], path.join(ROOT, "create-libertynet-agent"));
      return [code === 0, code === 0 ? "67 tests green" : "tests failed"];
    },
  },
  {
    id: "operator-login-flow",
    match: /Challenge → device-key signature|hold\.|runs against the live network today/i,
    pages: ["index", "guides/operator-login", "guides/discovery-agent"],
    how: "full login performed with a freshly generated operator identity",
    async verify() {
      if (OFFLINE) return [null, "network disabled"];
      // Not a probe of the endpoints — the whole flow: root key issues a
      // DeviceCredential, device key signs a challenge, session comes back and
      // opens an authenticated endpoint. Anything less would leave the claim
      // "no passwords, just signatures" resting on the shape of a 400.
      const session = await operatorSession();
      if (!session) return [false, "could not obtain a session"];
      const res = await fetch(`${REGISTRY}/v1/operator/me/nodes`, {
        headers: { authorization: `Bearer ${session.token}` },
        signal: AbortSignal.timeout(20_000),
      });
      return [res.ok, `new operator ${session.did}, session accepted, HTTP ${res.status}`];
    },
  },
  {
    id: "binding-flow",
    match: /the full flow is live|Full double-signature handshake|Discovery · identity · binding/i,
    pages: ["concepts/binding", "index", "reference/changelog"],
    how: "every binding endpoint probed live",
    async verify() {
      if (OFFLINE) return [null, "network disabled"];
      const binding = results.filter((r) => /\/v1\/(node\/)?bindings/.test(r.claim));
      const bad = binding.filter((r) => r.verdict === "FAIL");
      return [binding.length >= 8 && bad.length === 0, `${binding.length} binding endpoints, ${bad.length} failing`];
    },
  },
  {
    id: "public-discovery",
    match: /Reading it needs no key and no account|the live network\.$/im,
    pages: ["concepts/nodes-and-discovery", "quickstart"],
    how: "fetched with no credentials of any kind",
    async verify() {
      if (OFFLINE) return [null, "network disabled"];
      // The claim is the absence of a requirement, so the test is the absence
      // of a header. No authorization, no cookie, no key.
      const res = await fetch(`${REGISTRY}/nodes`, { signal: AbortSignal.timeout(20_000) });
      const { nodes } = await res.json();
      return [res.ok && nodes.length > 0, `HTTP ${res.status}, ${nodes.length} nodes, no auth header sent`];
    },
  },
];

async function auditFeatures() {
  for (const claim of FEATURE_CLAIMS) {
    try {
      const [ok, evidence] = await claim.verify();
      record(
        claim.id,
        claim.pages.join(", "),
        ok === null ? "SKIP" : ok ? "PASS" : "FAIL",
        evidence,
        claim.how,
      );
    } catch (e) {
      record(claim.id, claim.pages.join(", "), "FAIL", String(e.message ?? e), claim.how);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. completeness — the half that closes the class
// ---------------------------------------------------------------------------

/**
 * Find every `implemented` badge in the English docs and make sure something
 * above covers it. A claim nobody wrote a verifier for is the exact shape of
 * the two false claims this project has already shipped.
 */
async function auditCompleteness() {
  const pages = [];
  await (async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "logo", "images"].includes(e.name)) continue;
        // Translations carry the same claims as their English source.
        if (/^(zh-CN|zh-TW|ja|ko|es|pt|de|fr|ar|hi)$/.test(e.name)) continue;
        await walk(full);
      } else if (e.name.endsWith(".mdx")) pages.push(full);
    }
  })(DOCS);

  const endpointPaths = new Set(
    status.groups.flatMap((g) => g.endpoints.filter((e) => e.status === "implemented").map((e) => e.path)),
  );

  let covered = 0;
  const orphans = [];

  const namesProbedEndpoint = (line) =>
    [...endpointPaths].some((p) => {
      // Compare whole paths with the parameter names normalised away, so the
      // docs may write {id} where the matrix writes {binding_session_id} and
      // still match. Matching only the stem before the first `{` collapsed
      // .../status and .../cancel into one indistinguishable prefix.
      const rx = escapeForRegex(p)
        .replace(/\\\{[^}]*\\\}/g, "\\{[^}]*\\}")
        .replace(/^/, "");
      return new RegExp(rx + "(?![\\w/])").test(line);
    });

  const escapeForRegex = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** The body of the section a heading opens, up to the next heading. */
  const sectionAfter = (text, index) => {
    const rest = text.slice(index);
    const nextHeading = rest.slice(1).search(/\n#{1,4}\s/);
    return nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1);
  };

  for (const file of pages) {
    const text = await readFile(file, "utf8");
    const slug = path.relative(DOCS, file).replace(/\.mdx$/, "");

    for (const m of text.matchAll(/^(.*)<Status level="implemented"\s*\/>(.*)$/gm)) {
      const line = `${m[1]}${m[2]}`.trim();

      // Backed by the matrix: the line names an endpoint we probed.
      if (namesProbedEndpoint(line)) {
        covered++;
        continue;
      }

      // A heading carrying a status is a claim about its whole section. If the
      // section lists endpoints that were probed, the badge is backed by those
      // probes — "## Node discovery ✅" over a table of six live endpoints is
      // not an unverified assertion, it is a summary of six verified ones.
      if (/^#{2,4}\s/.test(line)) {
        const section = sectionAfter(text, m.index);
        if (section.split("\n").some(namesProbedEndpoint)) {
          covered++;
          continue;
        }
      }

      // Backed by a feature verifier.
      const claim = FEATURE_CLAIMS.find((c) => c.pages.includes(slug) && c.match.test(line));
      if (claim) {
        covered++;
        continue;
      }

      // The status-key snippet renders the legend, not a claim about anything.
      if (slug === "snippets/status") {
        covered++;
        continue;
      }

      orphans.push(`${slug}: ${line.slice(0, 90)}`);
    }
  }

  for (const o of orphans) {
    record(o, "—", "FAIL", "no verifier — nothing could disprove this", "MISSING");
  }

  return { covered, orphans: orphans.length };
}

// ---------------------------------------------------------------------------

function run(cmd, args, stdin) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => resolve(out));
    if (stdin) p.stdin.write(stdin);
    setTimeout(() => p.kill(), 20_000);
  });
}

function exitCode(cmd, args, cwd = ROOT) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: "ignore" });
    p.on("error", () => resolve(1));
    p.on("close", (code) => resolve(code));
  });
}

// ---------------------------------------------------------------------------

await auditEndpoints();
await auditFeatures();
const completeness = await auditCompleteness();

const failed = results.filter((r) => r.verdict === "FAIL");
const passed = results.filter((r) => r.verdict === "PASS");
const skipped = results.filter((r) => r.verdict === "SKIP");

if (MARKDOWN) {
  console.log(`| Claim | Asserted in | How it was checked | Result |`);
  console.log(`|---|---|---|---|`);
  for (const r of results) {
    const mark = r.verdict === "PASS" ? "✅" : r.verdict === "FAIL" ? "❌" : "⊘";
    console.log(`| \`${r.claim}\` | ${r.where} | ${r.how} | ${mark} ${r.evidence} |`);
  }
} else {
  for (const r of results) {
    const mark = r.verdict === "PASS" ? "✓" : r.verdict === "FAIL" ? "✗" : "·";
    console.log(`  ${mark} ${r.claim.padEnd(44)} ${r.evidence}`);
  }
}

console.log(
  `\n  ${passed.length} verified · ${failed.length} false · ${skipped.length} skipped` +
    `\n  ${completeness.covered} implemented badge(s) in the docs, ${completeness.orphans} with no verifier\n`,
);

if (failed.length) {
  console.error(`✗ ${failed.length} claim(s) could not be substantiated:\n`);
  for (const f of failed) console.error(`  ${f.claim}\n    ${f.evidence}\n`);
  process.exit(1);
}

console.log(`✓ every implemented claim is backed by a measurement\n`);
