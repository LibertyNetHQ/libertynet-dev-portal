/**
 * Scaffolder tests.
 *
 * Two things are being defended here. The obvious one is that the CLI parses
 * arguments and writes files. The one that matters more is the "generated code
 * safety" block: it asserts that no template can ever grow a hard-coded secret,
 * a value-moving call, or an opt-out of identity verification. Those are
 * properties of the output, so only a test over the output can hold them.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  UsageError,
  checkTarget,
  helpText,
  parseArgs,
  plan,
  writeProject,
} from "../src/scaffold.mjs";
import { AGENT_TYPES, CAPABILITIES, buildProject } from "../src/templates.mjs";

const ALL_TYPES = AGENT_TYPES.map((t) => t.id);

function scratch() {
  return mkdtemp(path.join(tmpdir(), "ln-scaffold-"));
}

describe("parseArgs", () => {
  test("takes a bare name", () => {
    assert.equal(parseArgs(["my-agent"]).name, "my-agent");
  });

  test("supports both flag spellings", () => {
    assert.equal(parseArgs(["a", "--type", "monitor"]).type, "monitor");
    assert.equal(parseArgs(["a", "--type=monitor"]).type, "monitor");
  });

  test("splits capabilities", () => {
    assert.deepEqual(parseArgs(["a", "--caps=inference,storage"]).capabilities, [
      "inference",
      "storage",
    ]);
  });

  test("tolerates whitespace in the capability list", () => {
    assert.deepEqual(parseArgs(["a", "--caps", "inference, storage "]).capabilities, [
      "inference",
      "storage",
    ]);
  });

  test("rejects an unknown flag rather than ignoring it", () => {
    assert.throws(() => parseArgs(["a", "--wat"]), UsageError);
  });

  test("rejects a stray second positional", () => {
    assert.throws(() => parseArgs(["a", "b"]), UsageError);
  });

  test("recognises the non-interactive flags", () => {
    const o = parseArgs(["a", "-y", "--force"]);
    assert.equal(o.yes, true);
    assert.equal(o.force, true);
  });
});

describe("validation", () => {
  test("rejects names that would break npm or the filesystem", () => {
    for (const bad of ["", "My-Agent", "../escape", "a b", "-lead", "agent/sub"]) {
      assert.throws(() => plan({ name: bad, type: "custom" }), UsageError, `should reject ${bad}`);
    }
  });

  test("a path traversal in the name cannot reach outside the target", () => {
    assert.throws(() => plan({ name: "../../etc", type: "custom" }), UsageError);
  });

  test("rejects an unknown agent type", () => {
    assert.throws(() => plan({ name: "a", type: "nope" }), UsageError);
  });

  test("rejects an unknown capability instead of silently dropping it", () => {
    assert.throws(
      () => plan({ name: "a", type: "service", capabilities: ["telepathy"] }),
      UsageError,
    );
  });

  test("accepts every declared type and capability", () => {
    for (const type of ALL_TYPES) {
      const caps = CAPABILITIES.map((c) => c.id);
      assert.ok(plan({ name: "a", type, capabilities: caps }).files);
    }
  });
});

describe("checkTarget", () => {
  test("accepts a directory that does not exist", async () => {
    const dir = path.join(await scratch(), "new");
    assert.equal((await checkTarget(dir)).ok, true);
  });

  test("accepts an empty directory", async () => {
    assert.equal((await checkTarget(await scratch())).ok, true);
  });

  test("refuses a non-empty directory", async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, "important.txt"), "do not clobber me");

    const result = await checkTarget(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /not empty/);
  });

  test("--force allows it, and says how much is at stake", async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, "a.txt"), "x");
    await writeFile(path.join(dir, "b.txt"), "y");

    const result = await checkTarget(dir, { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.overwriting, 2);
  });

  test("a lone .git directory does not count as occupied", async () => {
    const dir = await scratch();
    await mkdir(path.join(dir, ".git"));
    assert.equal((await checkTarget(dir)).ok, true);
  });
});

describe("writeProject", () => {
  test("writes every planned file", async () => {
    const dir = await scratch();
    const { files } = plan({ name: "w", type: "monitor" });
    const written = await writeProject(dir, files);

    assert.deepEqual(written, Object.keys(files).sort());
    for (const f of written) {
      assert.ok((await readFile(path.join(dir, f), "utf8")).length > 0, `${f} should not be empty`);
    }
  });

  test("creates nested directories", async () => {
    const dir = await scratch();
    const { files } = plan({ name: "w", type: "monitor" });
    await writeProject(dir, files);
    assert.ok(await readFile(path.join(dir, "src/index.mjs"), "utf8"));
    assert.ok(await readFile(path.join(dir, "test/agent.test.mjs"), "utf8"));
  });
});

describe("generated project shape", () => {
  for (const type of ALL_TYPES) {
    test(`${type}: has the files a project needs to run and be tested`, () => {
      const { files } = plan({ name: "p", type });
      for (const required of [
        "package.json",
        "README.md",
        ".gitignore",
        ".env.example",
        "src/index.mjs",
        "src/libertynet.mjs",
        "test/agent.test.mjs",
        "libertynet.config.json",
      ]) {
        assert.ok(files[required], `${type} is missing ${required}`);
      }
    });

    test(`${type}: package.json is valid and dependency-free`, () => {
      const { files } = plan({ name: "p", type });
      const pkg = JSON.parse(files["package.json"]);

      assert.equal(pkg.type, "module");
      assert.equal(pkg.scripts.start, "node src/index.mjs");
      assert.ok(pkg.scripts.test);
      assert.deepEqual(pkg.dependencies, {}, "a scaffold must run without installing anything");
    });

    test(`${type}: config records what it was generated as`, () => {
      const { files } = plan({ name: "p", type, capabilities: ["inference"] });
      const cfg = JSON.parse(files["libertynet.config.json"]);
      assert.equal(cfg.type, type);
      assert.equal(cfg.name, "p");
      assert.equal(cfg.generated.by, "create-libertynet-agent");
    });
  }

  test("service agents get their declared capabilities inlined", () => {
    const { files } = plan({ name: "p", type: "service", capabilities: ["inference", "storage"] });
    assert.match(files["src/index.mjs"], /\["inference","storage"\]/);
    assert.doesNotMatch(files["src/index.mjs"], /CAPABILITIES_PLACEHOLDER/);
  });

  test("no template leaves a placeholder unsubstituted", () => {
    for (const type of ALL_TYPES) {
      const { files } = plan({ name: "p", type, capabilities: ["inference"] });
      for (const [name, body] of Object.entries(files)) {
        assert.doesNotMatch(body, /PLACEHOLDER/, `${type}/${name} has an unsubstituted placeholder`);
      }
    }
  });
});

describe("generated code safety", () => {
  const everyFile = function* () {
    for (const type of ALL_TYPES) {
      const { files } = plan({ name: "p", type, capabilities: ["inference"] });
      for (const [name, body] of Object.entries(files)) yield { type, name, body };
    }
  };

  test("no template hard-codes anything that looks like a secret", () => {
    // Catches the habit before it is learned: a scaffold that ships a literal key
    // teaches every reader that literal keys are normal.
    const secretish = [
      /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
    ];

    for (const { type, name, body } of everyFile()) {
      for (const pattern of secretish) {
        assert.doesNotMatch(body, pattern, `${type}/${name} looks like it embeds a secret`);
      }
    }
  });

  test(".env is git-ignored in every template", () => {
    for (const type of ALL_TYPES) {
      const { files } = plan({ name: "p", type });
      assert.match(files[".gitignore"], /^\.env$/m, `${type} does not ignore .env`);
    }
  });

  test(".env.example carries no real value, only guidance", () => {
    const { files } = plan({ name: "p", type: "service" });
    const env = files[".env.example"];
    assert.match(env, /NEVER put a private key/i);
    // Every non-comment line must be an empty assignment or commented out.
    for (const line of env.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      assert.match(line, /^[A-Z_]+=\S*$/, `unexpected line in .env.example: ${line}`);
      const [, value] = line.split("=");
      if (value) {
        assert.match(value, /^https?:\/\//, `.env.example assigns a non-URL value: ${line}`);
      }
    }
  });

  test("no template calls anything that moves value", () => {
    // LibertyNet has no wallet, transfer or trading. A scaffold that references
    // one is either broken or teaching a capability that does not exist.
    for (const { type, name, body } of everyFile()) {
      if (name === "README.md" || name === "src/index.mjs") continue; // may *mention* them to say they do not exist
      for (const forbidden of [/\.transfer\(/, /sendTransaction/, /privateKey\s*=/]) {
        assert.doesNotMatch(body, forbidden, `${type}/${name} references value movement`);
      }
    }
  });

  test("every template verifies identity, and none offers a way to skip it", () => {
    for (const type of ALL_TYPES) {
      const { files } = plan({ name: "p", type });
      const client = files["src/libertynet.mjs"];

      assert.match(client, /verifyIdBinding/, `${type} client lost its verification`);
      // The filter is what makes verification non-optional rather than advisory.
      assert.match(client, /\.filter\(\(n\) => verifyIdBinding/, `${type} stopped filtering`);

      for (const escapeHatch of [/skipVerif/i, /insecure/i, /trustAll/i, /verify\s*[:=]\s*false/i]) {
        assert.doesNotMatch(client, escapeHatch, `${type} client has a verification escape hatch`);
      }
    }
  });

  test("the solver template refuses to fake data for unbuilt endpoints", () => {
    const { files } = plan({ name: "p", type: "solver" });
    const src = files["src/index.mjs"];

    assert.match(src, /planned, not built/);
    assert.match(src, /notBuilt\("GET \/v1\/dex\/intent"\)/);
    assert.match(src, /notBuilt\("POST \/v1\/dex\/solve"\)/);
  });

  test("templates that reference unbuilt features link to the status page", () => {
    for (const type of ["solver", "service"]) {
      const { files } = plan({ name: "p", type });
      const all = files["src/index.mjs"] + files["README.md"];
      assert.match(all, /docs\.libertynet\.ai\/(status|guides)/, `${type} should link out`);
    }
  });

  test("READMEs state that credits are a test unit, not money", () => {
    for (const type of ALL_TYPES) {
      const { files } = plan({ name: "p", type });
      assert.match(files["README.md"], /test unit/i, `${type} README omits the credits caveat`);
    }
  });
});

describe("help", () => {
  test("lists every type and capability the CLI accepts", () => {
    const help = helpText();
    for (const t of ALL_TYPES) assert.match(help, new RegExp(t));
    for (const c of CAPABILITIES) assert.match(help, new RegExp(c.id));
  });

  test("shows a copy-pasteable example", () => {
    assert.match(helpText(), /npx create-libertynet-agent \S+/);
  });
});

describe("buildProject", () => {
  test("falls back to the custom template for an unrecognised type", () => {
    // Defence in depth: plan() validates, but buildProject must not produce a
    // project with no entrypoint if it is ever called directly.
    const files = buildProject({ name: "x", type: "nonexistent", capabilities: [], version: "0" });
    assert.ok(files["src/index.mjs"]);
  });
});
