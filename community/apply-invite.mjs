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
  console.log(`\n${total} placeholder Discord link(s) across ${hits.length} file(s)`);
  for (const h of hits) console.log(`  ${h.count}×  ${h.file}`);
  console.log(
    total
      ? `\nThese point at a server that does not exist yet.\nSee community/DISCORD-SETUP.md\n`
      : "\n✓ no placeholders left\n",
  );
  process.exit(0);
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
