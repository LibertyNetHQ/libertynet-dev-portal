#!/usr/bin/env node
/**
 * Run every example, for real, and check what it printed.
 *
 *     node examples/run-all.mjs              everything
 *     node examples/run-all.mjs --offline    only examples that need no network
 *     node examples/run-all.mjs did-toolkit  one of them
 *
 * The bar is deliberately "it ran and did the right thing", not "it parsed".
 * An example that compiles but no longer works is a broken promise to whoever
 * copies it — and examples rot silently, because nobody re-runs the ones they
 * are not currently reading.
 *
 * Several expectations assert *failure*: a crossed DID/key pair must exit 1, a
 * forged identity must be refused, a replayed signature must not verify. Those
 * are the assertions worth having. An example suite that only checks happy paths
 * would let verification break without anyone noticing.
 */

import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const manifest = JSON.parse(await readFile(path.join(HERE, "manifest.json"), "utf8"));

const args = process.argv.slice(2);
const offlineOnly = args.includes("--offline");
const only = args.filter((a) => !a.startsWith("--"));

const PYTHON = process.env.LN_PYTHON ?? "python3";
const TIMEOUT_MS = 90_000;

const results = [];

function run(cmd, { cwd, timeout = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const [bin, ...rest] = cmd;
    const child = spawn(bin === "python3" ? PYTHON : bin, rest, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out: out + "\n[timed out]" });
    }, timeout);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** Assert every expected pattern appears, and the exit code matches if declared. */
function check(step, result, label) {
  const problems = [];

  if (step.exit !== undefined && result.code !== step.exit) {
    problems.push(
      `exit ${result.code} (expected ${step.exit})` + (step.why ? ` — ${step.why}` : ""),
    );
  } else if (step.exit === undefined && result.code !== 0) {
    problems.push(`exit ${result.code}`);
  }

  for (const pattern of step.expect ?? []) {
    if (!new RegExp(pattern, "m").test(result.out)) {
      problems.push(`output never matched /${pattern}/`);
    }
  }

  results.push({ label, ok: problems.length === 0, problems, out: result.out });
  return problems.length === 0;
}

/** Boot a server example, probe it over HTTP, shut it down. */
async function runServer(example, cwd) {
  const { server } = example;
  const [bin, ...rest] = server.cmd;
  const child = spawn(bin, rest, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(server.port) } });

  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));

  try {
    // Wait for the readiness line rather than sleeping a fixed amount — a fixed
    // sleep is either slow or flaky, usually both.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !out.includes(server.ready)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!out.includes(server.ready)) {
      results.push({ label: `${example.dir}: start`, ok: false, problems: ["never became ready"], out });
      return;
    }

    for (const probe of server.probes) {
      const res = await fetch(`http://localhost:${server.port}${probe.path}`, {
        headers: probe.headers ?? {},
        signal: AbortSignal.timeout(10_000),
      }).catch((e) => ({ status: 0, text: async () => String(e.message) }));

      const body = await res.text();
      const problems = [];

      if (probe.expect_status !== undefined && res.status !== probe.expect_status) {
        problems.push(
          `HTTP ${res.status} (expected ${probe.expect_status})` + (probe.why ? ` — ${probe.why}` : ""),
        );
      }
      for (const pattern of probe.expect ?? []) {
        if (!new RegExp(pattern, "m").test(body)) problems.push(`body never matched /${pattern}/`);
      }

      const identity = probe.headers?.["x-ln-did"] ?? "anonymous";
      results.push({
        label: `${example.dir}: ${probe.path} (${identity.slice(0, 22)})`,
        ok: problems.length === 0,
        problems,
        out: body,
      });
    }
  } finally {
    child.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------

const selected = manifest.examples.filter((e) => {
  if (only.length && !only.includes(e.dir)) return false;
  // A networked example may declare a reduced run that needs no network. That
  // part still gets exercised in the required CI job, where the full version
  // cannot go because a blipping server would fail an unrelated pull request.
  if (offlineOnly && e.network && !e.offline) return false;
  return true;
});

console.log(
  `\nRunning ${selected.length} example(s)${offlineOnly ? " (offline only)" : ""}\n`,
);

for (const example of selected) {
  let cwd = path.join(HERE, example.dir);
  let scratch = null;

  // Examples that write state run somewhere disposable, so a test run never
  // leaves droppings in the repository.
  if (example.scratch) {
    scratch = await mkdtemp(path.join(tmpdir(), "ln-example-"));
    cwd = scratch;
  }

  try {
    if (example.server) {
      await runServer(example, path.join(HERE, example.dir));
    } else {
      const steps = offlineOnly && example.offline ? [example.offline] : example.runs;
      for (const step of steps) {
        const cmd = example.scratch
          ? [step.cmd[0], path.join(HERE, example.dir, step.cmd[1]), ...step.cmd.slice(2)]
          : step.cmd;
        const result = await run(cmd, { cwd });
        check(step, result, `${example.dir}: ${step.cmd.slice(1).join(" ")}`);
      }
    }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }

  const mine = results.filter((r) => r.label.startsWith(`${example.dir}:`));
  const failed = mine.filter((r) => !r.ok).length;
  console.log(
    `  ${failed ? "✗" : "✓"} ${example.dir.padEnd(20)} ${mine.length} check(s)${failed ? `, ${failed} failed` : ""}`,
  );
}

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);

console.log(`\n${results.length} check(s) across ${selected.length} example(s)`);

if (failed.length === 0) {
  console.log("✓ every example ran and did what it says it does\n");
  process.exit(0);
}

console.error(`\n✗ ${failed.length} failing check(s):\n`);
for (const f of failed) {
  console.error(`  ${f.label}`);
  for (const p of f.problems) console.error(`     ${p}`);
  console.error(`     ---\n${f.out.split("\n").slice(-12).map((l) => `     ${l}`).join("\n")}\n`);
}
process.exit(1);
