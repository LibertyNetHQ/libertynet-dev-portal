#!/usr/bin/env node
/**
 * Drive the LibertyNet MCP server from code.
 *
 *     node mcp.mjs                              run every tool once
 *     node mcp.mjs search "how do I verify"
 *     node mcp.mjs status wallet
 *
 * Zero dependencies. MCP is usually spoken by an assistant, which makes it look
 * like something you cannot inspect. It is not: it is JSON-RPC over stdin and
 * stdout, and this is a client in about eighty lines.
 *
 * Worth doing for two reasons. It shows the AI layer is ordinary software you can
 * test and script — and it is the fastest way to see what your assistant will be
 * told before you trust what it says back.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const SERVER =
  process.env.LN_MCP_SERVER ??
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../mcp-server/src/server.mjs");

/** A minimal MCP client: spawn the server, speak JSON-RPC over its pipes. */
class McpClient {
  #child;
  #pending = new Map();
  #nextId = 1;

  async start() {
    this.#child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });

    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;                       // the server never writes non-JSON to stdout
      }
      const waiting = this.#pending.get(message.id);
      if (!waiting) return;
      this.#pending.delete(message.id);
      message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result);
    });

    // stderr is diagnostics, not protocol. Surface it only if something breaks.
    this.#child.stderr.on("data", (d) => {
      const text = String(d);
      if (!/ready/.test(text)) process.stderr.write(`[server] ${text}`);
    });

    return this.request("initialize", {});
  }

  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  /** Call a tool and unwrap the JSON its content block carries. */
  async call(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = result.content?.[0]?.text ?? "{}";
    if (result.isError) throw new Error(text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  stop() {
    this.#child?.stdin.end();
    this.#child?.kill();
  }
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const client = new McpClient();

try {
  const init = await client.start();
  console.log(`connected to ${init.serverInfo.name} ${init.serverInfo.version}\n`);

  if (cmd === "search") {
    const query = rest.join(" ");
    for (const hit of await client.call("libertynet_search_docs", { query, limit: 5 })) {
      console.log(`  ${hit.slug}`);
      console.log(`    ${hit.title} — ${hit.description}`);
    }
  } else if (cmd === "status") {
    const status = await client.call("libertynet_capability_status", rest[0] ? { area: rest[0] } : {});
    for (const group of status.groups ?? []) {
      console.log(`  ${group.title}`);
      for (const e of group.endpoints) {
        console.log(`    ${String(e.status).padEnd(14)} ${e.method} ${e.path}`);
      }
    }
  } else {
    // No command: exercise every tool, which doubles as a smoke test.
    const { tools } = await client.request("tools/list", {});
    console.log(`${tools.length} tools available\n`);

    const status = await client.call("libertynet_capability_status", { area: "wallet" });
    const wallet = status.groups[0].endpoints;
    console.log(`capability_status(wallet)   every endpoint "${wallet[0].status}" (${wallet.length} of them)`);

    const hits = await client.call("libertynet_search_docs", { query: "verify identity", limit: 3 });
    console.log(`search_docs                 ${hits.map((h) => h.slug).join(", ")}`);

    const page = await client.call("libertynet_get_page", { slug: "quickstart" });
    console.log(`get_page(quickstart)        ${page.content.length} chars`);

    const good = await client.call("libertynet_verify_identity", {
      did: "did:svrp:n:268d4fe0",
      public_key: "7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg",
    });
    const bad = await client.call("libertynet_verify_identity", {
      did: "did:svrp:n:deadbeef",
      public_key: "7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg",
    });
    console.log(`verify_identity             genuine=${good.valid}  forged=${bad.valid}`);

    const net = await client.call("libertynet_list_nodes", { online_only: false });
    console.log(`list_nodes                  ${net.verified}/${net.registered} verified, ${net.rejected_id_binding.length} rejected`);

    const probe = await client.call("libertynet_check_endpoint", { path: "/health" });
    console.log(`check_endpoint(/health)     HTTP ${probe.status} in ${probe.elapsed_ms}ms`);

    console.log(`\nThis is what your assistant is told. It is checkable, which is the point.`);
  }
} finally {
  client.stop();
}

// → 6 tools available · wallet every endpoint "planned" · verify genuine=true forged=false
