#!/usr/bin/env node
/**
 * DID toolkit — derive, verify and fingerprint LibertyNet identities.
 *
 *     node did.mjs verify did:svrp:n:268d4fe0 7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg
 *     node did.mjs derive 7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg
 *     node did.mjs fingerprint df9d4b9f…02d
 *     node did.mjs explain did:svrp:n:268d4fe0
 *
 * **No network. No dependencies.** That is the entire point: a LibertyNet
 * identity is self-certifying, so every question about one can be answered with
 * arithmetic on your own machine. This tool would still work with the registry
 * offline, the project abandoned and the internet on fire.
 *
 * Exit codes: 0 valid · 1 invalid · 2 usage error. Scriptable.
 */

import { createHash } from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let lead = 0;
  for (const c of s) { if (c === "1") lead++; else break; }
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, "hex")]);
}

function b58encode(raw) {
  let n = BigInt("0x" + (raw.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  let lead = 0;
  for (const b of raw) { if (b === 0) lead++; else break; }
  return "1".repeat(lead) + out;
}

/** Accept a key in either encoding the registry serves. */
function keyBytes(pk) {
  if (!pk) return null;
  const raw = /^[0-9a-f]{64}$/i.test(pk) ? Buffer.from(pk.toLowerCase(), "hex") : b58decode(pk);
  return raw && raw.length === 32 ? raw : null;
}

function parseDid(did) {
  const m = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/.exec(did ?? "");
  if (!m) return null;
  const [, tag, body] = m;
  const form =
    body.length === 64 ? "full-hex" : body.length === 8 ? "short" : body.length === 10 ? "short-fallback" : null;
  if (!form) return null;
  if (form === "full-hex" && tag !== undefined) return null;   // not a shape the protocol emits
  return { tag: tag ?? null, body, form };
}

function fingerprint(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16).match(/.{1,4}/g).join(":");
}

const ROLES = { n: "node", o: "operator", h: "host" };

// ---------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);

function usage(message) {
  if (message) console.error(`\n${message}`);
  console.error(`
  did.mjs — LibertyNet identity arithmetic, entirely offline

    verify <did> <public-key>    does the DID derive from the key?      (0 yes / 1 no)
    derive <public-key> [tag]    the canonical short DID for a key      (tag: n|o|h, default n)
    fingerprint <public-key>     the human-comparable form
    explain <did>                take a DID apart

  Keys are accepted as 64-char hex or base58 — the registry serves both.
`);
  process.exit(2);
}

switch (cmd) {
  case "verify": {
    const [did, pk] = args;
    if (!did || !pk) usage("verify needs a DID and a public key");

    const parsed = parseDid(did);
    const key = keyBytes(pk);

    if (!parsed) {
      console.log(`INVALID  "${did}" is not a well-formed did:svrp identifier`);
      process.exit(1);
    }
    if (!key) {
      console.log(
        `INVALID  the public key is not 32 bytes in hex or base58\n` +
          `         (a base58 key parsed as hex silently produces garbage — check the encoding)`,
      );
      process.exit(1);
    }

    const expected =
      parsed.form === "full-hex"
        ? key.toString("hex")
        : createHash("sha256").update(key).digest("hex").slice(0, parsed.body.length);

    if (parsed.body === expected) {
      console.log(`VALID    ${did}`);
      console.log(`         derives from this key (${parsed.form} form)`);
      console.log(`         fingerprint ${fingerprint(key)}`);
      process.exit(0);
    }

    console.log(`INVALID  ${did}`);
    console.log(`         expected ${expected}`);
    console.log(`         got      ${parsed.body}`);
    console.log(`\n         This key does not belong to this identity. Do not proceed —`);
    console.log(`         a valid signature from an unbound key proves nothing.`);
    process.exit(1);
  }

  case "derive": {
    const [pk, tag = "n"] = args;
    if (!pk) usage("derive needs a public key");
    const key = keyBytes(pk);
    if (!key) usage("the public key is not 32 bytes in hex or base58");
    if (!(tag in ROLES)) usage(`tag must be one of: ${Object.keys(ROLES).join(", ")}`);

    const digest = createHash("sha256").update(key).digest("hex");
    console.log(`short        did:svrp:${tag}:${digest.slice(0, 8)}`);
    console.log(`fallback     did:svrp:${tag}:${digest.slice(0, 10)}    (only on collision)`);
    console.log(`full-hex     did:svrp:${key.toString("hex")}`);
    console.log(`fingerprint  ${fingerprint(key)}`);
    console.log(`role         ${ROLES[tag]}`);
    console.log(`\nkey hex      ${key.toString("hex")}`);
    console.log(`key base58   ${b58encode(key)}`);
    break;
  }

  case "fingerprint": {
    const [pk] = args;
    if (!pk) usage("fingerprint needs a public key");
    const key = keyBytes(pk);
    if (!key) usage("the public key is not 32 bytes in hex or base58");
    console.log(fingerprint(key));
    break;
  }

  case "explain": {
    const [did] = args;
    if (!did) usage("explain needs a DID");
    const parsed = parseDid(did);
    if (!parsed) {
      console.log(`Not a well-formed did:svrp identifier.\n`);
      console.log(`Expected  did:svrp:[<tag>:]<hex>  with 8, 10 or 64 hex characters.`);
      process.exit(1);
    }

    console.log(`${did}\n`);
    console.log(`  method       svrp`);
    console.log(`  role         ${parsed.tag ? `${parsed.tag} (${ROLES[parsed.tag] ?? "unknown"})` : "none — the full-hex form carries no tag"}`);
    console.log(`  form         ${parsed.form}`);
    console.log(`  identifier   ${parsed.body}`);
    console.log(
      `\n  ${
        parsed.form === "full-hex"
          ? "The identifier IS the 32-byte public key, in hex."
          : `The identifier is the first ${parsed.body.length / 2} bytes of sha256(public_key).`
      }`,
    );
    console.log(`\n  This tells you the shape, not that it is genuine.`);
    console.log(`  Run \`verify\` with the key to check that.`);
    break;
  }

  default:
    usage(cmd ? `unknown command: ${cmd}` : null);
}
