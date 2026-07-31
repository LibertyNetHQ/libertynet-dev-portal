#!/usr/bin/env node
/**
 * LibertyNet MCP server.
 *
 * Gives an AI assistant — Claude Desktop, Claude Code, Cursor — direct access to
 * these docs, the capability matrix, and the live network.
 *
 * Protocol wiring only; the tools themselves live in `tools.mjs`. Implemented
 * against the JSON-RPC layer of MCP over stdio rather than the SDK, so this stays
 * dependency-free and auditable in one file.
 */

import { createInterface } from "node:readline";

import {
  capabilityStatus,
  checkEndpoint,
  getPage,
  listNodes,
  searchDocs,
  verifyIdentity,
} from "./tools.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "libertynet", version: "0.1.0" };

/**
 * Tool definitions.
 *
 * The descriptions are written for a model, not a human browsing a list. Where a
 * tool exists to prevent a specific failure — asserting a feature exists,
 * eyeballing a DID — the description says so, because that is what makes the
 * model reach for it at the right moment.
 */
const TOOLS = [
  {
    name: "libertynet_capability_status",
    description:
      "What is actually built in LibertyNet, from the single machine-readable source of truth. " +
      "CALL THIS BEFORE writing any code that uses a LibertyNet feature. Statuses: 'implemented' " +
      "(live, callable now), 'not_yet_wired' (endpoint returns 200 but has no data source — its " +
      "zeros are placeholders, never present them as measurements), 'testing' (code passes tests " +
      "but is not deployed anywhere), 'planned' (nothing exists; do not write code against it). " +
      "LibertyNet has NO wallet, transfer, swap, staking or trading of any kind.",
    inputSchema: {
      type: "object",
      properties: {
        area: {
          type: "string",
          description:
            "Optional filter: discovery, binding, identity, economics, oracle, wallet, dex.",
        },
      },
    },
  },
  {
    name: "libertynet_search_docs",
    description:
      "Search the LibertyNet developer documentation. Returns ranked pages with excerpts and " +
      "URLs. Use this before answering any question about how LibertyNet works.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        limit: { type: "number", description: "Max results (default 5)." },
      },
      required: ["query"],
    },
  },
  {
    name: "libertynet_get_page",
    description:
      "Fetch one documentation page in full, by slug (e.g. 'quickstart', 'concepts/identity', " +
      "'reference/errors'). Use after search when you need complete detail.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Page slug, without extension." } },
      required: ["slug"],
    },
  },
  {
    name: "libertynet_verify_identity",
    description:
      "Check arithmetically whether a LibertyNet DID is derived from a public key (id-binding). " +
      "Use this instead of judging by eye. Handles both key encodings (hex from /nodes, base58 " +
      "from /peers) and all three DID forms (8-hex, 10-hex, 64-hex). Returns the reason when " +
      "the answer is no.",
    inputSchema: {
      type: "object",
      properties: {
        did: { type: "string", description: "e.g. did:svrp:n:268d4fe0" },
        public_key: { type: "string", description: "32 bytes, hex or base58." },
      },
      required: ["did", "public_key"],
    },
  },
  {
    name: "libertynet_list_nodes",
    description:
      "The live LibertyNet network right now, with every identity verified before it is returned. " +
      "Use this for any question about who is on the network — never answer from memory, the " +
      "network changes constantly. Note that a node's 'status' field never decays; freshness " +
      "comes from last_seen.",
    inputSchema: {
      type: "object",
      properties: {
        online_only: { type: "boolean", description: "Only nodes seen in the last 10 min (default true)." },
        capability: { type: "string", description: "Filter by advertised capability, e.g. 'inference'." },
      },
    },
  },
  {
    name: "libertynet_check_endpoint",
    description:
      "Probe a live registry endpoint and return its real status, latency and body. Use this to " +
      "answer 'is it up' or 'what does this actually return' by measurement rather than by claim.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "e.g. /health, /nodes (default /health)." },
      },
    },
  },
];

const HANDLERS = {
  libertynet_capability_status: capabilityStatus,
  libertynet_search_docs: searchDocs,
  libertynet_get_page: getPage,
  libertynet_verify_identity: async (args) => verifyIdentity(args),
  libertynet_list_nodes: listNodes,
  libertynet_check_endpoint: checkEndpoint,
};

/**
 * Guidance handed to the assistant at connection time.
 *
 * This is the honesty contract, stated where the model will actually see it.
 */
const INSTRUCTIONS = `
LibertyNet developer tools.

Rules for using these tools well:

1. Call libertynet_capability_status BEFORE writing code that uses any LibertyNet
   feature. Much of the intended surface is not built. Writing code against a
   'planned' capability produces code that cannot work.

2. Never present a 'not_yet_wired' value as a measurement. Those endpoints return
   200 with zeros and "source": "not_yet_wired". A 0 there means "nothing is
   counting", not "the value is zero".

3. Credits are a test unit: not cash, not redeemable, not a claim on future value.
   Say so whenever you mention them.

4. LibertyNet has NO wallet, transfer, swap, staking or trading. No endpoint moves
   value. Do not generate code that implies otherwise.

5. Use libertynet_verify_identity rather than judging a DID by eye, and
   libertynet_list_nodes rather than answering about the network from memory.

6. In generated code: read secrets from the environment or an OS keychain, never
   hard-code them; never disable identity verification.
`.trim();

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(request) {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case "tools/list":
      return reply(id, { tools: TOOLS });

    case "tools/call": {
      const handler = HANDLERS[params?.name];
      if (!handler) return replyError(id, -32602, `Unknown tool: ${params?.name}`);

      try {
        const result = await handler(params.arguments ?? {});
        return reply(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        // Report the failure as tool content rather than a protocol error, so the
        // model can read it and adapt instead of the call simply vanishing.
        return reply(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    case "ping":
      return reply(id, {});

    default:
      // Notifications carry no id and must not be answered.
      if (id === undefined) return;
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

// stdout is the protocol channel — anything logged there corrupts the stream.
// Diagnostics go to stderr, always.
createInterface({ input: process.stdin }).on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return process.stderr.write(`libertynet-mcp: unparseable line dropped\n`);
  }

  try {
    await handle(request);
  } catch (err) {
    process.stderr.write(`libertynet-mcp: ${err.stack}\n`);
    if (request.id !== undefined) replyError(request.id, -32603, String(err.message));
  }
});

process.stderr.write(`libertynet-mcp ${SERVER_INFO.version} ready (${TOOLS.length} tools)\n`);

export { TOOLS, HANDLERS, INSTRUCTIONS, handle };
