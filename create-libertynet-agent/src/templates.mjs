/**
 * Project templates.
 *
 * Security rules these templates obey, without exception:
 *   · No secret is ever written into a source file. Keys come from the
 *     environment, and `.env` is git-ignored before it can exist.
 *   · Nothing touches real value. There is no wallet, no transfer, no key
 *     generation for spending — because none of that is built, and a scaffold
 *     that pretends otherwise teaches a habit before it teaches a task.
 *   · Identity verification is present in every template and is never optional.
 *     A beginner's first LibertyNet program should verify by default, so that
 *     verifying feels normal rather than advanced.
 */

import { CLIENT_MJS } from "./vendored-client.mjs";

/** The agent kinds the scaffolder can produce. */
export const AGENT_TYPES = [
  {
    id: "monitor",
    label: "Network monitor",
    blurb: "Watches the live network, verifies every identity, reports what changed.",
    detail: "Runs against the live network today with no setup at all.",
    runnable: true,
  },
  {
    id: "service",
    label: "Service agent",
    blurb: "Offers a capability to the network and verifies who is calling.",
    detail: "The local service runs today; joining the network as a servable node needs ln-node.",
    runnable: true,
  },
  {
    id: "solver",
    label: "Intent solver",
    blurb: "Skeleton for solving user intents.",
    detail: "The intent system is not built yet — this generates the shape, not a working solver.",
    runnable: true,
  },
  {
    id: "custom",
    label: "Custom",
    blurb: "Just the client, verified discovery and a test. Build your own thing on top.",
    detail: "Runs today.",
    runnable: true,
  },
];

/** Capability strings a node can advertise. `observed` ones exist on the live network. */
export const CAPABILITIES = [
  { id: "inference", label: "Inference", observed: true },
  { id: "storage", label: "Storage", observed: false },
  { id: "verification", label: "Verification", observed: false },
  { id: "proof", label: "Proof generation", observed: false },
  { id: "solver", label: "Intent solving", observed: false },
  { id: "oracle", label: "Oracle reporting", observed: false },
];

const GITIGNORE = `node_modules/
dist/
.env
.env.*
!.env.example
*.log
.DS_Store
`;

const ENV_EXAMPLE = `# Copy to .env and fill in. .env is git-ignored — keep it that way.
#
# Nothing in this file is required to run the project against the live network:
# discovery is public. These matter only once you are acting as an operator.

# The registry to talk to. Override to point at a self-hosted one.
LN_REGISTRY_URL=https://registry.libertynet.ai

# Operator session token, if you have one. Short-lived (1 hour) by design.
# Obtain it by signing a challenge — see https://docs.libertynet.ai/guides/operator-login
# LN_SESSION_TOKEN=

# NEVER put a private key in this file, or in any file in this repository.
# Read key material from your OS keychain at the point of use. A key in a .env is
# a key in your shell history, your backups and your crash dumps.
`;

/** Files every project gets, whatever its type. */
function commonFiles(ctx) {
  return {
    ".gitignore": GITIGNORE,
    ".env.example": ENV_EXAMPLE,
    "src/libertynet.mjs": CLIENT_MJS,
    "libertynet.config.json": JSON.stringify(
      {
        name: ctx.name,
        type: ctx.type,
        capabilities: ctx.capabilities,
        registry: "https://registry.libertynet.ai",
        // Written by the scaffolder so the project can say, honestly, what it was
        // generated against rather than what it hopes is true now.
        generated: {
          by: "create-libertynet-agent",
          version: ctx.version,
          api_status: "https://docs.libertynet.ai/status",
        },
      },
      null,
      2,
    ) + "\n",
    "package.json": packageJson(ctx),
    "README.md": readme(ctx),
    "test/agent.test.mjs": testFile(ctx),
  };
}

function packageJson(ctx) {
  return (
    JSON.stringify(
      {
        name: ctx.name,
        version: "0.1.0",
        private: true,
        type: "module",
        description: `A LibertyNet ${ctx.type} agent.`,
        engines: { node: ">=20" },
        scripts: {
          start: "node src/index.mjs",
          test: "node --test test/*.test.mjs",
        },
        // Deliberately empty. The project runs with zero installs.
        dependencies: {},
      },
      null,
      2,
    ) + "\n"
  );
}

// ---------------------------------------------------------------- entrypoints

const MONITOR = String.raw`/**
 * Network monitor.
 *
 * Polls the live LibertyNet registry, verifies every identity it is handed, and
 * reports what changed since the last pass.
 *
 * Nothing here is simulated — this talks to the real network.
 */

import { LibertyNet, fingerprint } from "./libertynet.mjs";

const REGISTRY = process.env.LN_REGISTRY_URL || "https://registry.libertynet.ai";
const INTERVAL_MS = Number(process.env.LN_POLL_INTERVAL_MS || 30000);

const ln = new LibertyNet({ baseUrl: REGISTRY });

/** DIDs seen on the previous pass, so we can report arrivals and departures. */
let previous = new Set();

async function pass() {
  const { total, verified, rejected } = await ln.discovery.audit();

  // A record that fails id-binding is a finding, not a nuisance to skip
  // quietly. Report it loudly every single time.
  for (const bad of rejected) {
    console.error("REJECTED  " + bad.did + "  identity does not derive from its key");
  }

  const fresh = verified.filter(
    (n) => n.last_seen && Date.now() - Date.parse(n.last_seen) < 600000,
  );
  const current = new Set(fresh.map((n) => n.did));

  for (const did of current) {
    if (!previous.has(did)) {
      const node = fresh.find((n) => n.did === did);
      console.log(
        "JOINED    " + short(did) +
        "  " + (node.region || "region:?") +
        "  " + (node.capabilities.join(",") || "no capabilities") +
        "  fp=" + fingerprint(node.public_key),
      );
    }
  }
  for (const did of previous) {
    if (!current.has(did)) console.log("LEFT      " + short(did));
  }

  previous = current;

  console.log(
    "[" + new Date().toISOString() + "] " +
    total + " registered · " + verified.length + " verified · " +
    fresh.length + " online" + (rejected.length ? " · " + rejected.length + " REJECTED" : ""),
  );
}

function short(did) {
  return did.length > 28 ? did.slice(0, 25) + "..." : did.padEnd(28);
}

console.log("Watching " + REGISTRY + " every " + INTERVAL_MS / 1000 + "s. Ctrl-C to stop.\n");

await pass();
setInterval(() => {
  pass().catch((e) => console.error("poll failed:", e.message));
}, INTERVAL_MS);
`;

const SERVICE = String.raw`/**
 * Service agent.
 *
 * Offers a capability over HTTP and verifies the identity of whoever calls.
 *
 * Honest scope: this runs a local service you can call today. Being *discoverable
 * on the network* — so others can find and reach this capability — requires
 * running the ln-node daemon, which registers and heartbeats on your behalf. This
 * scaffold does not fake that step. See
 * https://docs.libertynet.ai/guides/service-agent
 */

import { createServer } from "node:http";
import { LibertyNet, verifyIdBinding } from "./libertynet.mjs";

const PORT = Number(process.env.PORT || 8787);
const REGISTRY = process.env.LN_REGISTRY_URL || "https://registry.libertynet.ai";
const CAPABILITIES = CAPABILITIES_PLACEHOLDER;

const ln = new LibertyNet({ baseUrl: REGISTRY });

/**
 * Identify the caller before doing any work for them.
 *
 * The caller presents a DID and the public key it claims. We check that the DID
 * actually derives from that key. That is necessary but NOT sufficient for
 * trust: it proves the identifier is well-formed, not that the caller holds the
 * private key. For that you must also verify a signature over a challenge you
 * chose — see the docs link above. Anonymous callers are allowed here; they just
 * do not get an identity.
 */
function identify(req) {
  const did = req.headers["x-ln-did"];
  const key = req.headers["x-ln-public-key"];
  if (!did || !key) return { identified: false, reason: "no identity presented" };
  if (!verifyIdBinding(did, key)) return { identified: false, reason: "id-binding failed" };
  return { identified: true, did };
}

const server = createServer(async (req, res) => {
  const caller = identify(req);
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  };

  if (req.url === "/health") {
    return send(200, { status: "ok", capabilities: CAPABILITIES });
  }

  if (req.url === "/peers") {
    // Proxy the verified view of the network, so callers inherit our checks.
    const nodes = await ln.discovery.online();
    return send(200, { count: nodes.length, nodes: nodes.map((n) => n.did) });
  }

  if (req.url === "/work") {
    if (!caller.identified) return send(401, { error: caller.reason });

    // Replace with whatever your capability actually does. Keep it pure and
    // bounded — an unbounded handler is a denial-of-service waiting to be found.
    return send(200, { served: caller.did, result: "replace me" });
  }

  send(404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log("Service listening on http://localhost:" + PORT);
  console.log("Capabilities: " + (CAPABILITIES.join(", ") || "(none declared)"));
  console.log("");
  console.log("  curl -s localhost:" + PORT + "/health");
  console.log("  curl -s localhost:" + PORT + "/peers");
  console.log("");
  console.log("Not yet discoverable on the network — that needs ln-node. See");
  console.log("https://docs.libertynet.ai/guides/service-agent");
});
`;

const SOLVER = String.raw`/**
 * Intent solver — skeleton.
 *
 * Read this before building on it: **the intent system does not exist yet.**
 * There is no intent endpoint, no quoting engine and no settlement path. Every
 * status is 'planned' at https://docs.libertynet.ai/status
 *
 * So this file generates the *shape* of a solver — the loop, the boundaries, the
 * place your pricing logic goes — with the network calls clearly marked as not
 * yet real. It will not silently start working; when the API ships, the marked
 * functions are the ones to replace.
 *
 * What DOES work today is everything below the line: discovering and verifying
 * the nodes you would be competing with and settling against.
 */

import { LibertyNet } from "./libertynet.mjs";

const ln = new LibertyNet({
  baseUrl: process.env.LN_REGISTRY_URL || "https://registry.libertynet.ai",
});

// ---------------------------------------------------------------------------
// NOT YET REAL — these throw rather than return a plausible-looking answer.
// A stub that returns fake quotes is how you end up shipping fake quotes.
// ---------------------------------------------------------------------------

function notBuilt(what) {
  throw new Error(
    what + " is planned, not built. There is no endpoint behind it. " +
    "Track it at https://docs.libertynet.ai/status",
  );
}

/** Fetch open intents. @throws always, until the intent system ships. */
export async function fetchIntents() {
  notBuilt("GET /v1/dex/intent");
}

/** Submit a solution. @throws always, until the intent system ships. */
export async function submitSolution(_intentId, _solution) {
  notBuilt("POST /v1/dex/solve");
}

/**
 * Your pricing logic. This part you can write and unit-test today — it is pure,
 * and it does not need a network that does not exist yet.
 */
export function priceIntent(intent) {
  if (!intent || typeof intent.amount !== "number") {
    throw new TypeError("intent.amount must be a number");
  }
  // Replace with your real model. Deliberately trivial so it is obviously a
  // placeholder rather than something you might mistake for a strategy.
  return { intentId: intent.id, quote: intent.amount, confidence: 0 };
}

// ---------------------------------------------------------------------------
// Works today.
// ---------------------------------------------------------------------------

export async function surveyNetwork() {
  const health = await ln.discovery.health();
  const nodes = await ln.discovery.online();

  console.log("Registry: " + health.count + " registered, " + nodes.length + " online now");
  for (const n of nodes) {
    console.log("  " + n.did.slice(0, 24) + "  " + (n.capabilities.join(",") || "-"));
  }
  return nodes;
}

// Only run when executed directly. Importing this file — which the tests do, to
// reach priceIntent() — must not fire network calls, or the suite stops being
// offline and starts being flaky.
if (import.meta.url === "file://" + process.argv[1]) {
  await surveyNetwork();

  console.log("");
  console.log("Solver loop not started: the intent system is not built yet.");
  console.log("Write and test priceIntent() now; wire fetchIntents() when it ships.");
}
`;

const CUSTOM = String.raw`/**
 * Your LibertyNet agent.
 *
 * Starts with the one thing every LibertyNet program should do: discover the
 * network and verify what it is told. Build from here.
 */

import { LibertyNet, fingerprint } from "./libertynet.mjs";

const ln = new LibertyNet({
  baseUrl: process.env.LN_REGISTRY_URL || "https://registry.libertynet.ai",
});

const health = await ln.discovery.health();
console.log("Registry is " + health.status + " with " + health.count + " nodes registered.\n");

// Every record below has had its DID checked against its public key. Records
// that failed were dropped — use ln.discovery.audit() if you want to see them.
const nodes = await ln.discovery.online();

if (nodes.length === 0) {
  console.log("No nodes have reported in within the last 10 minutes.");
  console.log("That is a real answer about the network, not an error.");
} else {
  console.log("Online now:");
  for (const n of nodes) {
    console.log(
      "  " + n.did.slice(0, 30) +
      "  " + (n.region || "?") +
      "  " + (n.capabilities.join(",") || "-") +
      "  fp=" + fingerprint(n.public_key),
    );
  }
}

console.log("\nNext: https://docs.libertynet.ai/concepts/overview");
`;

const ENTRYPOINTS = {
  monitor: MONITOR,
  service: SERVICE,
  solver: SOLVER,
  custom: CUSTOM,
};

// ---------------------------------------------------------------------- tests

function testFile(ctx) {
  const extra =
    ctx.type === "solver"
      ? String.raw`
describe("pricing", () => {
  test("prices a well-formed intent", () => {
    const quote = priceIntent({ id: "i1", amount: 100 });
    assert.equal(quote.intentId, "i1");
    assert.equal(quote.quote, 100);
  });

  test("rejects a malformed intent instead of guessing", () => {
    assert.throws(() => priceIntent({}), TypeError);
  });

  test("unbuilt endpoints throw rather than return fake data", async () => {
    await assert.rejects(() => fetchIntents(), /planned, not built/);
    await assert.rejects(() => submitSolution("i1", {}), /planned, not built/);
  });
});
`
      : "";

  const imports =
    ctx.type === "solver"
      ? `import { verifyIdBinding, fingerprint } from "../src/libertynet.mjs";\nimport { priceIntent, fetchIntents, submitSolution } from "../src/index.mjs";`
      : `import { verifyIdBinding, fingerprint } from "../src/libertynet.mjs";`;

  return String.raw`/**
 * Tests for ${ctx.name}.
 *
 * These run offline and finish in milliseconds — no network, no fixtures to
 * refresh. The identities below are real records from the live registry, so the
 * verification logic is tested against data the network actually produced rather
 * than against data invented to make it pass.
 *
 *     npm test
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

${imports}

// Real records from https://registry.libertynet.ai/nodes
const FULL_DID = "did:svrp:df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d";
const FULL_KEY = "df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d";
const SHORT_DID = "did:svrp:n:268d4fe0";
const SHORT_KEY = "7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg";

describe("identity verification", () => {
  test("accepts a real full-hex identity", () => {
    assert.equal(verifyIdBinding(FULL_DID, FULL_KEY), true);
  });

  test("accepts a real short identity with a base58 key", () => {
    assert.equal(verifyIdBinding(SHORT_DID, SHORT_KEY), true);
  });

  test("rejects a DID paired with someone else's key", () => {
    assert.equal(verifyIdBinding(SHORT_DID, FULL_KEY), false);
    assert.equal(verifyIdBinding(FULL_DID, SHORT_KEY), false);
  });

  test("rejects a single tampered character", () => {
    const tampered = FULL_DID.slice(0, -1) + (FULL_DID.endsWith("d") ? "e" : "d");
    assert.equal(verifyIdBinding(tampered, FULL_KEY), false);
  });

  test("rejects malformed input without throwing", () => {
    assert.equal(verifyIdBinding("", FULL_KEY), false);
    assert.equal(verifyIdBinding("not-a-did", FULL_KEY), false);
    assert.equal(verifyIdBinding(FULL_DID, "!!!"), false);
  });
});

describe("fingerprint", () => {
  test("is grouped so a human can compare it", () => {
    assert.match(fingerprint(FULL_KEY), /^[0-9a-f]{4}(:[0-9a-f]{4}){3}$/);
  });

  test("differs between different keys", () => {
    assert.notEqual(fingerprint(FULL_KEY), fingerprint(SHORT_KEY));
  });
});
${extra}`;
}

// --------------------------------------------------------------------- readme

function readme(ctx) {
  // `plan()` validates the type, but buildProject() is exported and may be called
  // directly. Fall back rather than crash: a project with a slightly generic
  // README beats a scaffolder that dies halfway through writing files.
  const type =
    AGENT_TYPES.find((t) => t.id === ctx.type) ?? AGENT_TYPES.find((t) => t.id === "custom");
  const caps = ctx.capabilities.length ? ctx.capabilities.join(", ") : "(none declared)";

  const typeNote =
    ctx.type === "service"
      ? `\n## Becoming discoverable\n\nThe service runs locally right now. Being *findable on the network* is a separate\nstep: the \`ln-node\` daemon registers your node and heartbeats for it. This\nproject does not fake that — until you run \`ln-node\`, nobody else can find this\nservice.\n\nSee [Service agent guide](https://docs.libertynet.ai/guides/service-agent).\n`
      : ctx.type === "solver"
        ? `\n## Read this first\n\nThe intent system **does not exist yet**. \`fetchIntents()\` and\n\`submitSolution()\` throw on purpose rather than returning invented data.\n\nWhat you can do today: write and test \`priceIntent()\`, which is pure and needs\nno network. Check [capability status](https://docs.libertynet.ai/status) before\nplanning around any of it.\n`
        : "";

  return `# ${ctx.name}

A LibertyNet **${type.label.toLowerCase()}**. ${type.blurb}

Declared capabilities: ${caps}

## Run it

\`\`\`bash
npm start
\`\`\`

No \`npm install\` needed — this project has zero dependencies and talks to the
live network out of the box.

## Test it

\`\`\`bash
npm test
\`\`\`

Offline, milliseconds, no fixtures to refresh.
${typeNote}
## What is in here

| Path | What it is |
|---|---|
| \`src/index.mjs\` | Your agent. Start here. |
| \`src/libertynet.mjs\` | Zero-dependency LibertyNet client. Discovery + identity verification. |
| \`test/agent.test.mjs\` | Tests, using real records from the live registry. |
| \`libertynet.config.json\` | What this project was generated as. |
| \`.env.example\` | Copy to \`.env\`. Never put a private key in it. |

## Using the published SDK instead

\`src/libertynet.mjs\` is a strict subset of \`@libertynet/sdk\` with identical
method names and semantics. To switch:

\`\`\`bash
npm install @libertynet/sdk
\`\`\`

Then change \`from "./libertynet.mjs"\` to \`from "@libertynet/sdk"\` and delete
the local file. Nothing else changes.

## Two things worth knowing early

**\`status: "active"\` does not mean online.** A node that stopped heart-beating
keeps that string forever. Freshness comes from \`last_seen\` — which is why
\`discovery.online()\` exists and \`discovery.all()\` is not what you usually want.

**Verify identities, always.** Every record this client hands you has had its DID
checked against its public key, and there is no flag to turn that off. A valid
signature is not a valid identity.

## Security

- Secrets come from the environment, never from a source file. \`.env\` is
  git-ignored.
- Nothing here touches real value. LibertyNet has no wallet, no transfer and no
  trading — see [capability status](https://docs.libertynet.ai/status).
- Credits are a **test unit**: not cash, not redeemable, not a claim on future
  value.

## Docs

- [Quickstart](https://docs.libertynet.ai/quickstart)
- [Core concepts](https://docs.libertynet.ai/concepts/overview)
- [API reference](https://docs.libertynet.ai/api-reference)
- [Capability status](https://docs.libertynet.ai/status) — what is real, right now
- [Discord](https://discord.gg/libertynet)
`;
}

/** Build the full file map for a project. */
export function buildProject(ctx) {
  const files = commonFiles(ctx);
  const entry = ENTRYPOINTS[ctx.type] ?? ENTRYPOINTS.custom;

  files["src/index.mjs"] = entry.replace(
    "CAPABILITIES_PLACEHOLDER",
    JSON.stringify(ctx.capabilities),
  );

  return files;
}
