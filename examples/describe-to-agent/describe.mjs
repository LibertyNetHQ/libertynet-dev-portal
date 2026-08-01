#!/usr/bin/env node
/**
 * One sentence in, a running agent out.
 *
 *     node describe.mjs
 *     node describe.mjs "serve inference to the network"
 *
 * Runs the whole path end to end: a plain-English description goes into
 * `create-libertynet-agent --describe`, a project comes out, and this then
 * executes that project's own test suite and its discovery pass against the
 * live registry. Nothing is asserted about the scaffolder's *intentions* — only
 * about whether the thing it produced runs.
 *
 * It also runs the case that matters more. A description asking for something
 * LibertyNet does not have must produce no project at all. Every code generator
 * will happily write you a payment agent, because the request sounds reasonable;
 * this one is expected to refuse, and the example fails if it does not.
 *
 * **No dependencies.** Discovery needs the network; `--offline` skips that part
 * and still checks the generation and the refusal.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAFFOLDER = path.resolve(HERE, "../../create-libertynet-agent/index.mjs");
const OFFLINE = process.argv.includes("--offline");

const DESCRIPTION =
  process.argv.slice(2).find((a) => !a.startsWith("-")) ??
  "watch inference nodes on the network and tell me when one drops off";

/** Something LibertyNet has deliberately never built. */
const IMPOSSIBLE = "an agent that pays other nodes from my wallet balance";

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));

    // The monitor runs forever by design. Give it long enough to complete one
    // pass over the registry, then stop it — a watcher that exits on its own
    // would be the wrong shape for the job.
    const timer = opts.killAfter ? setTimeout(() => proc.kill(), opts.killAfter) : null;
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const dir = await mkdtemp(path.join(tmpdir(), "libertynet-describe-"));
let failures = 0;

function check(label, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  // -- 1. the sentence becomes a project -----------------------------------

  console.log(`\nDESCRIBE  "${DESCRIPTION}"\n`);

  const scaffold = await run("node", [SCAFFOLDER, "--describe", DESCRIPTION, "-y"], { cwd: dir });
  const created = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  check("the description produced a project", created.length === 1, created.join(", ") || "nothing");
  check("the scaffolder explained its reading", /·\s+type "/.test(scaffold.out), firstReason(scaffold.out));

  if (created.length !== 1) throw new Error(scaffold.out);
  const project = path.join(dir, created[0]);

  // -- 2. the project's own tests pass --------------------------------------

  const tests = await run("npm", ["test"], { cwd: project });
  const passed = /pass (\d+)/.exec(tests.out)?.[1];
  check("the generated project's tests pass", tests.code === 0, `${passed ?? "?"} passing, zero dependencies installed`);

  // -- 3. it really talks to the network ------------------------------------

  if (OFFLINE) {
    console.log("  · live discovery skipped (--offline)");
  } else {
    const started = await run("npm", ["start"], { cwd: project, killAfter: 25_000 });

    // Every DID it reports has been checked against its key before printing.
    const verified = /(\d+) registered · (\d+) verified/.exec(started.out);
    check(
      "the generated agent discovers the live network",
      Boolean(verified),
      verified ? `${verified[1]} registered, ${verified[2]} id-binding verified` : "no discovery line",
    );
    check(
      "…and verified every identity it reported",
      Boolean(verified) && verified[1] === verified[2],
      verified ? `${verified[2]}/${verified[1]}` : "n/a",
    );
  }

  // -- 4. and it refuses to scaffold a fiction ------------------------------

  console.log(`\nDESCRIBE  "${IMPOSSIBLE}"\n`);

  const refusedDir = await mkdtemp(path.join(tmpdir(), "libertynet-refuse-"));
  const refused = await run("node", [SCAFFOLDER, "--describe", IMPOSSIBLE, "-y"], { cwd: refusedDir });
  const leftBehind = await readdir(refusedDir);

  check("refused, with a non-zero exit", refused.code === 1, `exit ${refused.code}`);
  check("said what does not exist", /LibertyNet has no wallets/.test(refused.out), quoteRefusal(refused.out));
  check("wrote nothing at all", leftBehind.length === 0, `${leftBehind.length} entries left behind`);

  await rm(refusedDir, { recursive: true, force: true });
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "DESCRIBE→AGENT OK" : `DESCRIBE→AGENT FAILED (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);

function firstReason(out) {
  return /·\s+(type "[^"]+"[^\n]*)/.exec(out)?.[1]?.trim() ?? "";
}

function quoteRefusal(out) {
  return /LibertyNet has no [a-z ]+\./.exec(out)?.[0] ?? "";
}
