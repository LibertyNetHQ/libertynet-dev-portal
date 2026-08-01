/**
 * Argument parsing, validation and writing files to disk.
 *
 * Kept separate from `index.mjs` so all of it is testable without a TTY, and so
 * the destructive part (writing files) is one small function that is easy to
 * read carefully.
 */

import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { AGENT_TYPES, CAPABILITIES, buildProject } from "./templates.mjs";

export const VERSION = "0.1.0";

/** npm's own package-name rules, minus the scoped form. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export class UsageError extends Error {}

/**
 * Parse argv into options.
 *
 * Every interactive prompt has a flag equivalent, so the whole scaffolder is
 * scriptable — by CI, and by an AI assistant that cannot answer a prompt.
 */
export function parseArgs(argv) {
  const opts = {
    name: null,
    type: null,
    capabilities: null,
    describe: null,
    yes: false,
    help: false,
    version: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--version" || arg === "-v") opts.version = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--type") opts.type = argv[++i];
    else if (arg?.startsWith("--type=")) opts.type = arg.slice(7);
    else if (arg === "--describe") opts.describe = argv[++i];
    else if (arg?.startsWith("--describe=")) opts.describe = arg.slice(11);
    else if (arg === "--caps") opts.capabilities = splitCaps(argv[++i]);
    else if (arg?.startsWith("--caps=")) opts.capabilities = splitCaps(arg.slice(7));
    else if (arg?.startsWith("-")) throw new UsageError(`Unknown option: ${arg}`);
    else if (opts.name === null) opts.name = arg;
    else throw new UsageError(`Unexpected argument: ${arg}`);
  }

  return opts;
}

function splitCaps(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

export function validateName(name) {
  if (!name) throw new UsageError("Project name is required.");
  if (!NAME_RE.test(name)) {
    throw new UsageError(
      `"${name}" is not a usable project name.\n` +
        "Use lowercase letters, digits, dots, hyphens and underscores, starting with a letter or digit.",
    );
  }
  return name;
}

export function validateType(type) {
  if (!AGENT_TYPES.some((t) => t.id === type)) {
    throw new UsageError(
      `Unknown agent type "${type}".\nChoose one of: ${AGENT_TYPES.map((t) => t.id).join(", ")}`,
    );
  }
  return type;
}

export function validateCapabilities(caps) {
  const known = new Set(CAPABILITIES.map((c) => c.id));
  const unknown = caps.filter((c) => !known.has(c));
  if (unknown.length) {
    throw new UsageError(
      `Unknown capabilit${unknown.length > 1 ? "ies" : "y"}: ${unknown.join(", ")}\n` +
        `Known: ${[...known].join(", ")}`,
    );
  }
  return caps;
}

/**
 * Is this directory safe to scaffold into?
 *
 * Refuses a non-empty directory unless `--force`. Overwriting someone's work
 * because they reused a name is not a recoverable mistake for them, and the cost
 * of asking is one flag.
 */
export async function checkTarget(dir, { force = false } = {}) {
  if (!existsSync(dir)) return { ok: true, created: true };

  const entries = await readdir(dir);
  const meaningful = entries.filter((e) => e !== ".git" && e !== ".DS_Store");

  if (meaningful.length === 0) return { ok: true, created: false };
  if (force) return { ok: true, created: false, overwriting: meaningful.length };

  return {
    ok: false,
    reason:
      `${dir} already exists and is not empty (${meaningful.length} entries).\n` +
      "Pick another name, or pass --force if you are certain.",
  };
}

/** Write the project. Returns the list of relative paths written. */
export async function writeProject(dir, files) {
  const written = [];

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
    written.push(relative);
  }

  return written.sort();
}

/** Everything except the disk write, so tests can inspect the plan. */
export function plan({ name, type, capabilities }) {
  const ctx = {
    name: validateName(name),
    type: validateType(type),
    capabilities: validateCapabilities(capabilities ?? []),
    version: VERSION,
  };
  return { ctx, files: buildProject(ctx) };
}

export function helpText() {
  const types = AGENT_TYPES.map(
    (t) => `    ${t.id.padEnd(9)} ${t.label.padEnd(18)} ${t.blurb}`,
  ).join("\n");

  const caps = CAPABILITIES.map(
    (c) => `    ${c.id.padEnd(13)} ${c.observed ? "(seen on the live network)" : ""}`,
  ).join("\n");

  return `
  create-libertynet-agent — scaffold a runnable LibertyNet agent.

  USAGE
    npx create-libertynet-agent <name> [options]

  OPTIONS
    --describe "..."   Say what you want in plain English; the rest is inferred
                       and checked against the capability matrix.
    --type <id>        Agent type. Prompted if omitted.
    --caps <a,b,c>     Comma-separated capabilities to declare.
    -y, --yes          Accept defaults, ask nothing. For CI and AI assistants.
    --force            Scaffold into a non-empty directory.
    -h, --help         This.
    -v, --version      Print the version.

  AGENT TYPES
${types}

  CAPABILITIES
${caps}

  EXAMPLES
    npx create-libertynet-agent my-agent
    npx create-libertynet-agent watcher --type monitor -y
    npx create-libertynet-agent infer-svc --type service --caps inference -y
    npx create-libertynet-agent --describe "watch inference nodes and tell me
      when one drops off" -y

  The generated project has zero dependencies and runs against the live network
  immediately — no install, no signup, no API key.

  Docs: https://docs.libertynet.ai
`;
}
