#!/usr/bin/env node
/**
 * Replace the placeholder Discord link across the docs with the real one.
 *
 *     echo "https://discord.gg/abc123" > community/discord-invite.txt
 *     node community/apply-invite.mjs
 *
 * The docs currently link to `discord.gg/libertynet`, which does not exist yet —
 * a vanity URL needs Level 3 boosting that a new server will not have. Rather
 * than ship a dead link and hope, this rewrites every reference to whatever real
 * invite is in `discord-invite.txt`.
 *
 * Run with --check to find out where the placeholder still appears without
 * changing anything. CI uses that to keep the count visible.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const INVITE_FILE = path.join(HERE, "discord-invite.txt");

const PLACEHOLDER = "https://discord.gg/libertynet";
const checkOnly = process.argv.includes("--check");

const EXTENSIONS = [".mdx", ".md", ".json", ".ts", ".mjs", ".py", ".tsx"];
const SKIP_DIRS = ["node_modules", ".git", "dist", "out", ".next", "__pycache__", "community"];

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (EXTENSIONS.includes(path.extname(e.name))) out.push(full);
  }
  return out;
}

const files = await walk(ROOT);
const hits = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  const count = text.split(PLACEHOLDER).length - 1;
  if (count) hits.push({ file: path.relative(ROOT, file), count, text });
}

const total = hits.reduce((n, h) => n + h.count, 0);

if (checkOnly) {
  // What matters is not that the placeholder exists — it is reserved on purpose,
  // and deleting it would mean re-finding every spot later. What matters is that
  // no reference to it pretends the server is live. So this checks labelling.
  const MARKERS = [
    /planned/i,
    /not live/i,
    /does not exist/i,
    /not yet/i,
    /\$discordNote/,          // docs.json carries its explanation in a sibling key
  ];

  const unlabelled = [];
  for (const h of hits) {
    for (const line of h.text.split("\n")) {
      if (!line.includes(PLACEHOLDER)) continue;

      // A reference is labelled if the line itself says so, or — for JSX and
      // JSON, where the URL and its label are on neighbouring lines — if the
      // surrounding few lines do.
      const at = h.text.indexOf(line);
      const context = h.text.slice(Math.max(0, at - 400), at + 400);
      if (!MARKERS.some((m) => m.test(context))) {
        unlabelled.push({ file: h.file, line: line.trim().slice(0, 90) });
      }
    }
  }

  console.log(`\n${total} reference(s) to the reserved Discord address across ${hits.length} file(s)`);
  for (const h of hits) console.log(`  ${h.count}×  ${h.file}`);

  if (unlabelled.length === 0) {
    console.log(
      "\n✓ every reference is labelled as planned — nothing here claims the server is live" +
        "\n  run without --check once it exists, to swap in the real invite\n",
    );
    process.exit(0);
  }

  console.error(`\n✗ ${unlabelled.length} reference(s) do NOT say the server is unbuilt:\n`);
  for (const u of unlabelled) console.error(`  ${u.file}\n    ${u.line}\n`);
  console.error(
    "A link that silently goes nowhere is the kind of small dishonesty this portal exists\n" +
      "to avoid. Mark it planned, or remove it.\n",
  );
  process.exit(1);
}

if (!existsSync(INVITE_FILE)) {
  console.error(`\n✗ ${path.relative(ROOT, INVITE_FILE)} does not exist.\n`);
  console.error(`  Create the server first — community/DISCORD-SETUP.md walks through it —`);
  console.error(`  then:\n`);
  console.error(`    echo "https://discord.gg/YOUR-INVITE" > community/discord-invite.txt\n`);
  process.exit(1);
}

const invite = (await readFile(INVITE_FILE, "utf8")).trim();

if (!/^https:\/\/discord\.gg\/[A-Za-z0-9-]+$/.test(invite)) {
  console.error(`\n✗ "${invite}" is not a Discord invite URL.`);
  console.error(`  Expected: https://discord.gg/<code>\n`);
  process.exit(1);
}

if (invite === PLACEHOLDER) {
  console.error(`\n✗ That is still the placeholder. Put the real invite in the file.\n`);
  process.exit(1);
}

for (const h of hits) {
  await writeFile(path.join(ROOT, h.file), h.text.replaceAll(PLACEHOLDER, invite));
}

console.log(`\n✓ replaced ${total} link(s) across ${hits.length} file(s)`);
console.log(`  → ${invite}\n`);
console.log(`  Next: node site/build.mjs && ./site/deploy.sh\n`);
