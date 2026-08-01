#!/usr/bin/env node
/**
 * Clean-environment acceptance for the single-file MCP bundle.
 *
 * The claim on /ai/mcp is that a developer can download one file, point a client
 * at it, and have six working tools — with no clone, no npm install and no
 * repository on disk. This proves that literally: the bundle is copied to an
 * empty temp directory, run as a subprocess from there, and driven over real
 * JSON-RPC exactly as Claude Desktop or Cursor drives it.
 *
 * Copying matters. Running the bundle in place would leave `docs-site/` and
 * `api-spec/` sitting next to it, so a bundle that had silently kept reading
 * from disk would pass anyway. From an empty directory there is nothing to fall
 * back on.
 *
 *   node mcp-server/test/bundle.e2e.mjs            # live network calls
 *   node mcp-server/test/bundle.e2e.mjs --offline  # skip the two network tools
 */

import { spawn } from "node:child_process";
import { mkdtemp, copyFile, rm, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = path.join(ROOT, "site/public/mcp/libertynet-mcp.mjs");
const OFFLINE = process.argv.includes("--offline");

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// a minimal MCP client
// ---------------------------------------------------------------------------

class Client {
  constructor(command, args, cwd) {
    this.proc = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.stderr = "";
    this.nextId = 1;

    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Anything unparseable on stdout is a corrupted protocol stream. Record
        // it rather than ignoring it — that is the bug this catches.
        this.protocolGarbage = line;
        return;
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });

    this.proc.stderr.on("data", (d) => (this.stderr += d));
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Call a tool and parse the JSON the server wraps in MCP text content. */
  async call(name, args = {}) {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg.error) throw new Error(`${name}: ${msg.error.message}`);
    const text = msg.result?.content?.[0]?.text ?? "";
    if (msg.result?.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  }

  close() {
    this.proc.kill();
  }
}

// ---------------------------------------------------------------------------

const dir = await mkdtemp(path.join(tmpdir(), "libertynet-mcp-clean-"));
await copyFile(BUNDLE, path.join(dir, "libertynet-mcp.mjs"));

console.log(`\nClean-environment MCP acceptance`);
console.log(`  bundle → ${dir}/libertynet-mcp.mjs`);
console.log(`  cwd    → ${dir} (no repository, no node_modules)\n`);

const client = new Client("node", ["libertynet-mcp.mjs"], dir);

try {
  // -- handshake ------------------------------------------------------------

  const init = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "acceptance-harness", version: "1.0.0" },
  });

  check(
    "initialize returns a server identity",
    init.result?.serverInfo?.name === "libertynet",
    init.result?.serverInfo ? `${init.result.serverInfo.name} ${init.result.serverInfo.version}` : "no serverInfo",
  );

  check(
    "honesty contract is delivered at connection time",
    /capability_status BEFORE/.test(init.result?.instructions ?? "") &&
      /NO wallet, transfer, swap/.test(init.result?.instructions ?? ""),
    `${(init.result?.instructions ?? "").length} chars of instructions`,
  );

  const list = await client.request("tools/list");
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check("tools/list advertises 6 tools", names.length === 6, names.join(", "));

  // -- the six tools --------------------------------------------------------

  const status = await client.call("libertynet_capability_status");
  check(
    "1/6 libertynet_capability_status returns the matrix",
    Array.isArray(status.groups) && status.groups.length > 0,
    `${status.groups?.length} groups, source=${status.matrix_source}`,
  );

  if (!OFFLINE) {
    check(
      "      …and it fetched the LIVE matrix, not the snapshot",
      status.matrix_source === "live",
      String(status.matrix_source),
    );
  }

  const search = await client.call("libertynet_search_docs", { query: "id-binding verification order" });
  check(
    "2/6 libertynet_search_docs returns ranked hits",
    Array.isArray(search) && search.length > 0 && search[0].slug,
    search[0] ? `top hit: ${search[0].slug}` : "no results",
  );

  const page = await client.call("libertynet_get_page", { slug: "quickstart" });
  check(
    "3/6 libertynet_get_page returns full content from the bundle",
    page.found === true && page.content.length > 1000,
    `${page.title}, ${page.content?.length} chars`,
  );

  check(
    "      …with no MDX machinery leaking into it",
    !/^\s*(import|export)\s/m.test(page.content ?? ""),
    "0 import/export lines",
  );

  // A real node from the live registry: the DID and key must agree arithmetically.
  const good = await client.call("libertynet_verify_identity", {
    did: "did:svrp:n:dbe63a0c",
    public_key: "6EDfN4n33y7pAsnHumASu3gu2eJyu5syJ3wowxqeQzF9",
  });
  check(
    "4/6 libertynet_verify_identity accepts a real pair",
    good.valid === true,
    `${good.form}, fingerprint ${good.fingerprint}`,
  );

  // The same key against a DID that is one character off must be rejected. A
  // verifier that only ever says yes has not been tested.
  const bad = await client.call("libertynet_verify_identity", {
    did: "did:svrp:n:dbe63a0d",
    public_key: "6EDfN4n33y7pAsnHumASu3gu2eJyu5syJ3wowxqeQzF9",
  });
  check(
    "      …and rejects a one-character-off DID",
    bad.valid === false,
    bad.reason,
  );

  if (OFFLINE) {
    console.log("  · libertynet_list_nodes    skipped (--offline)");
    console.log("  · libertynet_check_endpoint skipped (--offline)");
  } else {
    const nodes = await client.call("libertynet_list_nodes", { online_only: false });
    check(
      "5/6 libertynet_list_nodes reads the live registry",
      typeof nodes.registered === "number" && nodes.registered > 0,
      `${nodes.registered} registered, ${nodes.verified} id-binding verified, ${nodes.returned} returned`,
    );

    const probe = await client.call("libertynet_check_endpoint", { path: "/health" });
    check(
      "6/6 libertynet_check_endpoint probes a live endpoint",
      probe.status === 200,
      `HTTP ${probe.status} in ${probe.elapsed_ms}ms`,
    );
  }

  // -- protocol hygiene -----------------------------------------------------

  check(
    "stdout carried protocol traffic only",
    !client.protocolGarbage,
    client.protocolGarbage ? `saw: ${client.protocolGarbage.slice(0, 80)}` : "no stray writes",
  );

  check(
    "diagnostics went to stderr",
    /libertynet-mcp .* ready \(6 tools\)/.test(client.stderr),
    client.stderr.trim().split("\n")[0] ?? "",
  );

  // -- the published client configs ----------------------------------------
  //
  // Claude Desktop and Cursor are GUI applications; a test cannot click their
  // buttons. What it can do is take the JSON printed on /ai/mcp, and launch the
  // server exactly as those clients launch it — spawn(command, args) from the
  // user's home directory, not from the repository. A config with a typo, a
  // stale path or a command that only works inside a checkout dies here.

  const mcpDoc = await readFile(path.join(ROOT, "docs-site/ai/mcp.mdx"), "utf8");
  // The blocks sit inside <Tab> elements, so every line carries the tab's
  // indentation. Capture it and strip exactly that much back off.
  const configs = [...mcpDoc.matchAll(/^([ \t]*)```json\n([\s\S]*?"mcpServers"[\s\S]*?)^\1```/gm)].map(
    (m) => [m[0], m[2].replace(new RegExp(`^${m[1]}`, "gm"), "")],
  );

  check(
    "docs publish at least one client config",
    configs.length > 0,
    `${configs.length} mcpServers block(s) on /ai/mcp`,
  );

  for (const [i, m] of configs.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch (e) {
      check(`published config ${i + 1} is valid JSON`, false, e.message);
      continue;
    }

    const entry = parsed.mcpServers?.libertynet;
    check(
      `published config ${i + 1} names the server and a command`,
      Boolean(entry?.command && Array.isArray(entry.args) && entry.args.length === 1),
      `${entry?.command} ${entry?.args?.join(" ")}`,
    );

    // The documented path is a placeholder for the reader's home directory.
    // Substitute the file we actually downloaded and launch it their way.
    const asClientWouldRun = new Client(
      entry.command,
      [path.join(dir, "libertynet-mcp.mjs")],
      process.env.HOME,
    );

    try {
      const l = await asClientWouldRun.request("tools/list");
      check(
        `published config ${i + 1} launches and serves 6 tools`,
        (l.result?.tools ?? []).length === 6,
        `spawned from ${process.env.HOME} — outside any checkout`,
      );
    } finally {
      asClientWouldRun.close();
    }
  }
} finally {
  client.close();
  await rm(dir, { recursive: true, force: true });
}

console.log(
  `\n${failures === 0 ? "✓" : "✗"} ${results.length - failures}/${results.length} checks passed` +
    `${OFFLINE ? " (offline mode)" : ""}\n`,
);
process.exit(failures === 0 ? 0 : 1);
