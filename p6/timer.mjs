#!/usr/bin/env node
/**
 * Timing and friction log for a P6 session.
 *
 *     node timer.mjs start "step 1 - health check"
 *     node timer.mjs done  "step 1 - health check"
 *     node timer.mjs stuck "docs never say where to get a device credential"
 *     node timer.mjs note  "the fingerprint format surprised me"
 *     node timer.mjs report
 *     node timer.mjs report --json > session.json
 *
 * Zero dependencies. State is a JSONL file in the working directory.
 *
 * The `stuck` entries matter more than the times. A five-minute step is a fact;
 * "I could not tell whether this had worked" is a defect, and it is the kind that
 * never shows up in a stopwatch.
 *
 * Do not sanitise your notes. "This is confusing and I hate it" is a more useful
 * report than "minor clarity issue".
 */

import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const LOG = process.env.LN_P6_LOG ?? path.join(process.cwd(), "p6-session.jsonl");

const [kind, ...rest] = process.argv.slice(2);
const text = rest.filter((a) => !a.startsWith("--")).join(" ");

async function entries() {
  if (!existsSync(LOG)) return [];
  const raw = await readFile(LOG, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function record(entry) {
  await appendFile(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

function minutes(ms) {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

switch (kind) {
  case "start":
    if (!text) { console.error("start needs a step name"); process.exit(2); }
    await record({ kind: "start", step: text });
    console.log(`▶ ${text}`);
    break;

  case "done": {
    if (!text) { console.error("done needs a step name"); process.exit(2); }
    const all = await entries();
    const started = [...all].reverse().find((e) => e.kind === "start" && e.step === text);
    await record({ kind: "done", step: text });
    if (started) {
      console.log(`✓ ${text}  (${minutes(Date.now() - Date.parse(started.at))})`);
    } else {
      console.log(`✓ ${text}  (no matching start — timing unknown)`);
    }
    break;
  }

  case "stuck":
    if (!text) { console.error("stuck needs a description"); process.exit(2); }
    await record({ kind: "stuck", detail: text });
    console.log(`✗ recorded: ${text}`);
    console.log(`  Keep going if you can. If you cannot, that is the most important finding of all.`);
    break;

  case "note":
    await record({ kind: "note", detail: text });
    console.log(`· noted`);
    break;

  case "report": {
    const all = await entries();
    if (all.length === 0) {
      console.log("Nothing recorded yet.");
      break;
    }

    const steps = [];
    for (const e of all.filter((x) => x.kind === "done")) {
      const started = all.find((x) => x.kind === "start" && x.step === e.step);
      steps.push({
        step: e.step,
        ms: started ? Date.parse(e.at) - Date.parse(started.at) : null,
      });
    }

    const stuck = all.filter((e) => e.kind === "stuck");
    const notes = all.filter((e) => e.kind === "note");
    const total = Date.parse(all[all.length - 1].at) - Date.parse(all[0].at);

    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ total_ms: total, steps, stuck, notes }, null, 2));
      break;
    }

    console.log(`\nP6 session — ${minutes(total)} total\n`);
    console.log("  Steps");
    for (const s of steps) {
      console.log(`    ${s.ms === null ? "  ?  " : minutes(s.ms).padStart(7)}  ${s.step}`);
    }

    const unfinished = all
      .filter((e) => e.kind === "start")
      .filter((e) => !all.some((d) => d.kind === "done" && d.step === e.step));
    if (unfinished.length) {
      console.log("\n  NEVER FINISHED  ← the most important line in this report");
      for (const u of unfinished) console.log(`    ${u.step}`);
    }

    if (stuck.length) {
      console.log(`\n  Stuck (${stuck.length})`);
      for (const s of stuck) console.log(`    · ${s.detail}`);
    }
    if (notes.length) {
      console.log(`\n  Notes (${notes.length})`);
      for (const n of notes) console.log(`    · ${n.detail}`);
    }

    console.log(`\n  Full log: ${LOG}`);
    console.log(`  Send it back with:  node timer.mjs report --json > session.json\n`);
    break;
  }

  default:
    console.error(`
  timer.mjs — P6 session log

    start <step>   begin timing a step
    done  <step>   finish it
    stuck <what>   something blocked or confused you  ← the valuable one
    note  <what>   anything else worth saying
    report         summary        (--json for the machine-readable form)
`);
    process.exit(2);
}
