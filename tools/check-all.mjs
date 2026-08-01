#!/usr/bin/env node
/**
 * Run everything.
 *
 *     node tools/check-all.mjs           # hermetic — no network
 *     node tools/check-all.mjs --live    # + tests against the live registry
 *
 * This is the gate a pull request has to pass. It fails loudly and reports every
 * failure rather than stopping at the first, so one run tells you everything that
 * is wrong.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");

const live = process.argv.includes("--live");

const SUITES = [
  {
    // Runs first: if the generated artifacts are stale, every downstream check is
    // testing yesterday's matrix.
    name: "status sync",
    cwd: ROOT,
    cmd: "node",
    args: ["tools/sync-status.mjs", "--check"],
  },
  {
    name: "docs honesty",
    cwd: ROOT,
    cmd: "node",
    args: ["tools/check-docs-drift.mjs"],
  },
  {
    name: "example safety",
    cwd: ROOT,
    cmd: "node",
    args: ["tools/check-examples.mjs"],
  },
  {
    // Offline examples only in the required job: the networked ones are exercised
    // by the `live` CI job, which is allowed to go red because a server blipped.
    name: "examples (offline)",
    cwd: ROOT,
    cmd: "node",
    args: ["examples/run-all.mjs", "--offline"],
  },
  {
    name: "site renderer",
    cwd: ROOT,
    cmd: "node",
    args: ["--test", "site/test/mdx.test.mjs"],
  },
  {
    // Builds before asserting, because these checks are about what gets served
    // — the markdown twins, llms.txt, llms-full.txt and the paste-ready primer
    // — not about what a function returns in isolation.
    name: "site build",
    cwd: ROOT,
    cmd: "node",
    args: ["site/build.mjs"],
  },
  {
    name: "published artifacts",
    cwd: ROOT,
    cmd: "node",
    args: ["--test", "site/test/artifacts.test.mjs"],
  },
  {
    // Static rules only in the required job — the live fetches belong in the
    // live job, where a third party's outage cannot fail an unrelated PR.
    name: "external links",
    cwd: ROOT,
    cmd: "node",
    args: ["tools/check-external-links.mjs", "--offline"],
  },
  {
    name: "community links",
    cwd: ROOT,
    cmd: "node",
    args: ["community/apply-invite.mjs", "--check"],
  },
  {
    name: "ai answers",
    cwd: ROOT,
    cmd: "node",
    args: ["tools/check-ai-answers.mjs"],
  },
  {
    name: "sdk/typescript",
    cwd: path.join(ROOT, "sdk/typescript"),
    cmd: "npm",
    args: ["test", "--silent"],
    needs: "node_modules",
  },
  {
    name: "sdk/typescript types",
    cwd: path.join(ROOT, "sdk/typescript"),
    cmd: "npx",
    args: ["tsc", "-p", "tsconfig.json", "--noEmit"],
    needs: "node_modules",
  },
  {
    name: "sdk/python",
    cwd: path.join(ROOT, "sdk/python"),
    cmd: "python3",
    args: ["-m", "pytest", "-q"],
  },
  {
    name: "create-libertynet-agent",
    cwd: path.join(ROOT, "create-libertynet-agent"),
    cmd: "npm",
    args: ["test", "--silent"],
  },
  {
    name: "mcp-server",
    cwd: path.join(ROOT, "mcp-server"),
    cmd: "npm",
    args: ["test", "--silent"],
  },
  {
    // Rebuilds the downloadable single-file server. Runs before the bundle
    // acceptance below so that check always exercises the current sources
    // rather than whatever happened to be committed.
    name: "mcp bundle build",
    cwd: ROOT,
    cmd: "node",
    args: ["tools/bundle-mcp.mjs"],
  },
  {
    // The install instructions on /ai/mcp, executed: one file in an empty
    // directory, six tools over real JSON-RPC.
    name: "mcp bundle (clean env)",
    cwd: ROOT,
    cmd: "node",
    args: ["mcp-server/test/bundle.e2e.mjs", "--offline"],
  },
];

const LIVE_SUITES = [
  {
    name: "external links (live)",
    cwd: ROOT,
    cmd: "node",
    args: ["tools/check-external-links.mjs"],
  },
  {
    name: "mcp bundle (live)",
    cwd: ROOT,
    cmd: "node",
    args: ["mcp-server/test/bundle.e2e.mjs"],
  },
  {
    name: "examples (live)",
    cwd: ROOT,
    cmd: "node",
    args: ["examples/run-all.mjs"],
  },
  {
    name: "sdk/typescript (live)",
    cwd: path.join(ROOT, "sdk/typescript"),
    cmd: "npm",
    args: ["run", "test:live", "--silent"],
    needs: "node_modules",
  },
  {
    name: "sdk/python (live)",
    cwd: path.join(ROOT, "sdk/python"),
    cmd: "python3",
    args: ["-m", "pytest", "-q"],
    env: { LN_LIVE: "1" },
  },
];

function run({ cwd, cmd, args, env }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    child.on("error", (e) => resolve({ code: 1, out: String(e) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const suites = [...SUITES, ...(live ? LIVE_SUITES : [])];
const results = [];

console.log(`\nRunning ${suites.length} suites${live ? " (including live network)" : ""}…\n`);

for (const suite of suites) {
  if (suite.needs && !existsSync(path.join(suite.cwd, suite.needs))) {
    console.log(`  ⊘ ${suite.name.padEnd(28)} skipped — run \`npm install\` in ${path.relative(ROOT, suite.cwd)}`);
    results.push({ ...suite, skipped: true });
    continue;
  }

  const started = Date.now();
  const { code, out } = await run(suite);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (code === 0) {
    console.log(`  ✓ ${suite.name.padEnd(28)} ${elapsed}s`);
  } else {
    console.log(`  ✗ ${suite.name.padEnd(28)} ${elapsed}s`);
  }
  results.push({ ...suite, code, out, elapsed });
}

const failed = results.filter((r) => !r.skipped && r.code !== 0);
const skipped = results.filter((r) => r.skipped);

if (failed.length === 0) {
  console.log(
    `\n✓ all ${results.length - skipped.length} suites passed` +
      (skipped.length ? ` (${skipped.length} skipped)` : "") +
      "\n",
  );
  process.exit(0);
}

// Print full output for every failure, not just the first — one run should tell
// you everything that is broken.
for (const f of failed) {
  console.error(`\n${"─".repeat(72)}\n${f.name}\n${"─".repeat(72)}`);
  console.error(f.out.trimEnd());
}

console.error(`\n✗ ${failed.length} of ${results.length - skipped.length} suites failed\n`);
process.exit(1);
