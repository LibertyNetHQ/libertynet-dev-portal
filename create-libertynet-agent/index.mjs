#!/usr/bin/env node
/**
 * create-libertynet-agent
 *
 *     npx create-libertynet-agent my-agent
 *
 * Produces a project that runs immediately: zero dependencies, no install step,
 * talking to the live network. The target is ten seconds from command to output,
 * so the prompts are few and every one of them has a sensible default.
 */

import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { AGENT_TYPES, CAPABILITIES } from "./src/templates.mjs";
import { interpret } from "./src/describe.mjs";
import {
  UsageError,
  VERSION,
  checkTarget,
  helpText,
  parseArgs,
  plan,
  writeProject,
} from "./src/scaffold.mjs";
import { banner, bold, cyan, dim, fail, ok, step, warn } from "./src/ui.mjs";

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const interactive = process.stdin.isTTY && !opts.yes;
  process.stdout.write(banner());

  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;

  try {
    // --describe reads the sentence against the capability matrix before
    // anything is written, so a request for something that does not exist is
    // answered with the truth rather than with a directory full of stubs.
    const read = opts.describe ? await interpretDescription(opts.describe) : null;
    if (read && !reportInterpretation(read)) return 1;

    const name = opts.name ?? read?.name ?? (rl ? await askName(rl) : null);
    if (!name) {
      throw new UsageError(
        "Project name is required.\n  npx create-libertynet-agent my-agent",
      );
    }

    const type = opts.type ?? read?.type ?? (rl ? await askType(rl) : "monitor");
    const capabilities =
      opts.capabilities ?? read?.capabilities ?? (rl ? await askCapabilities(rl, type) : defaultCaps(type));

    // Validate before touching the filesystem, so a typo costs nothing.
    const { ctx, files } = plan({ name, type, capabilities });

    const dir = path.resolve(process.cwd(), ctx.name);
    const target = await checkTarget(dir, { force: opts.force });
    if (!target.ok) {
      process.stderr.write(`\n${fail(target.reason)}\n\n`);
      return 1;
    }
    if (target.overwriting) {
      process.stdout.write(`${warn(`--force: overwriting into ${target.overwriting} existing entries`)}\n`);
    }

    const started = Date.now();
    const written = await writeProject(dir, files);
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);

    report(ctx, written, elapsed);
    return 0;
  } finally {
    rl?.close();
  }
}

// --------------------------------------------------------------- description

/**
 * Load the capability matrix and read the sentence against it.
 *
 * The matrix ships inside the package, so this works with no network. If it is
 * somehow missing the command fails rather than guessing — an interpretation
 * that cannot check itself against the matrix is exactly what --describe exists
 * to avoid.
 */
async function interpretDescription(description) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const raw = await readFile(path.join(here, "src/status.json"), "utf8");
  return interpret(description, JSON.parse(raw));
}

/**
 * Show the reading, then decide whether to continue.
 *
 * Returns false when the description asks for something LibertyNet does not
 * have. Generating "most of it" there would leave the reader with a directory
 * that looks like a payment agent, and the missing part is the part they asked
 * for.
 */
function reportInterpretation(read) {
  process.stdout.write(`${dim("read")} ${bold(`"${read.description}"`)}\n\n`);

  if (read.refusals.length) {
    for (const r of read.refusals) {
      process.stderr.write(`${fail(`No scaffold for ${r.subject}.`)}\n`);
      process.stderr.write(`  ${dim(r.reason)}\n\n`);
    }
    process.stderr.write(
      `  ${dim("What does exist: discovery, identity verification, binding and proof.")}\n` +
        `  ${dim("Try describing what you want to observe or offer instead, or see")}\n` +
        `  ${dim("https://docs.libertynet.ai/api-reference for the whole surface.")}\n\n`,
    );
    return false;
  }

  for (const line of read.reasoning) process.stdout.write(`  ${dim("·")} ${dim(line)}\n`);

  if (read.warnings.length) process.stdout.write("\n");
  for (const w of read.warnings) {
    process.stdout.write(`  ${warn(w.message)}\n`);
  }

  process.stdout.write(
    `\n  ${dim("→")} ${bold(read.name)} ${dim(`(${read.type}${read.capabilities.length ? ", " + read.capabilities.join(", ") : ""})`)}\n\n`,
  );
  return true;
}

// ------------------------------------------------------------------- prompts

async function askName(rl) {
  const answer = (await rl.question(`${bold("Project name")} ${dim("(my-agent)")} `)).trim();
  return answer || "my-agent";
}

async function askType(rl) {
  process.stdout.write(`\n${bold("What are you building?")}\n`);

  AGENT_TYPES.forEach((t, i) => {
    process.stdout.write(`  ${cyan(String(i + 1))} ${t.label.padEnd(17)} ${dim(t.blurb)}\n`);
    process.stdout.write(`    ${dim("  " + t.detail)}\n`);
  });

  const answer = (await rl.question(`\n${dim("1-" + AGENT_TYPES.length + " (1)")} `)).trim();
  const index = Number(answer || "1") - 1;
  return AGENT_TYPES[index]?.id ?? "monitor";
}

async function askCapabilities(rl, type) {
  if (type === "monitor" || type === "custom") return [];

  process.stdout.write(`\n${bold("Which capabilities does it offer?")}\n`);
  CAPABILITIES.forEach((c, i) => {
    const note = c.observed ? cyan("seen on the live network") : dim("not yet seen in the wild");
    process.stdout.write(`  ${cyan(String(i + 1))} ${c.label.padEnd(18)} ${note}\n`);
  });

  const answer = (
    await rl.question(`\n${dim("comma-separated numbers, blank for none")} `)
  ).trim();
  if (!answer) return [];

  return answer
    .split(",")
    .map((n) => CAPABILITIES[Number(n.trim()) - 1]?.id)
    .filter(Boolean);
}

function defaultCaps(type) {
  return type === "service" ? ["inference"] : [];
}

// -------------------------------------------------------------------- report

function report(ctx, written, elapsed) {
  const type = AGENT_TYPES.find((t) => t.id === ctx.type);

  process.stdout.write(`\n${ok(`${bold(ctx.name)} created in ${elapsed}s`)}\n`);
  process.stdout.write(`${dim(`  ${written.length} files · ${type.label} · zero dependencies`)}\n\n`);

  for (const f of written) process.stdout.write(`${step(f)}\n`);

  process.stdout.write(`\n${bold("Run it")}\n`);
  process.stdout.write(`  cd ${ctx.name}\n`);
  process.stdout.write(`  ${cyan("npm start")}      ${dim("# no install needed")}\n`);
  process.stdout.write(`  ${cyan("npm test")}\n`);

  // Say plainly what is and is not real, at the moment it matters most.
  if (ctx.type === "solver") {
    process.stdout.write(
      `\n${warn("The intent system is not built yet — fetchIntents() and submitSolution() throw on purpose.")}\n`,
    );
    process.stdout.write(`${dim("  priceIntent() is pure and testable today. https://docs.libertynet.ai/status")}\n`);
  } else if (ctx.type === "service") {
    process.stdout.write(
      `\n${warn("Runs locally today. Being discoverable on the network needs the ln-node daemon.")}\n`,
    );
    process.stdout.write(`${dim("  https://docs.libertynet.ai/guides/service-agent")}\n`);
  }

  process.stdout.write(`\n${dim("Docs: https://docs.libertynet.ai/quickstart")}\n\n`);
}

// ----------------------------------------------------------------------- run

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`\n${fail(err.message)}\n\n${dim("--help for usage")}\n\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`\n${fail(err.message)}\n\n`);
    process.exitCode = 1;
  }
}
