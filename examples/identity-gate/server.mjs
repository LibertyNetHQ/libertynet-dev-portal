/**
 * Reject forged identities at an HTTP boundary.
 *
 *     node server.mjs
 *
 * Zero dependencies. Demonstrates the gate every LibertyNet service needs — and,
 * just as importantly, exactly where that gate stops being enough.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8788);

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

function keyBytes(pk) {
  if (!pk) return null;
  const raw = /^[0-9a-f]{64}$/.test(pk) ? Buffer.from(pk, "hex") : b58decode(pk);
  return raw && raw.length === 32 ? raw : null;
}

function verifyIdBinding(did, publicKey) {
  const key = keyBytes(publicKey);
  if (!key) return false;

  const m = /^did:svrp:(?:([a-z0-9]):)?([0-9a-f]+)$/.exec(did ?? "");
  if (!m) return false;

  const [, tag, body] = m;
  if (body.length === 64) return tag === undefined && body === key.toString("hex");
  if (body.length !== 8 && body.length !== 10) return false;
  return body === createHash("sha256").update(key).digest("hex").slice(0, body.length);
}

function fingerprint(publicKey) {
  const key = keyBytes(publicKey);
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 16).match(/.{1,4}/g).join(":") : "invalid";
}

/**
 * Single-use challenges.
 *
 * In memory here because this is one process; a real deployment needs shared
 * storage, and every entry still needs a short TTL. A long-lived challenge is a
 * replay waiting to happen.
 */
const challenges = new Map();
const CHALLENGE_TTL_MS = 300_000;

function issueChallenge(did) {
  const challenge = randomBytes(24).toString("base64url");
  challenges.set(challenge, { did, expires: Date.now() + CHALLENGE_TTL_MS });
  return challenge;
}

function consumeChallenge(challenge, did) {
  const record = challenges.get(challenge);
  // Delete before checking, so a failed attempt burns the challenge too.
  challenges.delete(challenge);

  if (!record) return "unknown challenge";
  if (record.expires < Date.now()) return "challenge expired";
  if (record.did !== did) return "challenge was issued to a different identity";
  return null;
}

const server = createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  };

  const did = req.headers["x-ln-did"];
  const publicKey = req.headers["x-ln-public-key"];

  if (req.url === "/health") return send(200, { status: "ok" });

  // ---- Gate 1: id-binding ------------------------------------------------
  // Does the claimed identity derive from the key presented with it?
  if (!did || !publicKey) {
    return send(401, { error: "no identity presented", need: ["x-ln-did", "x-ln-public-key"] });
  }
  if (!verifyIdBinding(did, publicKey)) {
    return send(401, {
      error: "id-binding failed",
      detail: "the DID is not derived from the public key sent with it",
      hint: "GET /nodes serves keys as hex; GET /peers serves base58. Decoding one as the other fails every check.",
    });
  }

  if (req.url === "/whoami") {
    return send(200, {
      did,
      fingerprint: fingerprint(publicKey),
      authenticated: false,
      note:
        "id-binding passed, so this identifier is well-formed for this key. That is NOT proof " +
        "you hold the private key — you could have copied both from the public registry. " +
        "Call /challenge and sign it to actually authenticate.",
    });
  }

  if (req.url === "/challenge") {
    return send(200, {
      challenge: issueChallenge(did),
      expires_in: CHALLENGE_TTL_MS / 1000,
      sign: "Ed25519 over the raw challenge bytes; send it back to /work as x-ln-signature.",
    });
  }

  // ---- Gate 2: possession ------------------------------------------------
  if (req.url === "/work") {
    const challenge = req.headers["x-ln-challenge"];
    const signature = req.headers["x-ln-signature"];

    if (!challenge || !signature) {
      return send(401, {
        error: "not authenticated",
        detail: "id-binding is not authentication — you must also prove you hold the key",
        next: "GET /challenge, sign it, retry with x-ln-challenge and x-ln-signature",
      });
    }

    const problem = consumeChallenge(challenge, did);
    if (problem) return send(401, { error: "challenge rejected", detail: problem });

    // Verifying the Ed25519 signature itself needs a crypto library, which this
    // dependency-free example deliberately does not pull in. The ORDER is what
    // this example exists to show, and it is the part people get wrong:
    //
    //   1. id-binding      ← done above, and it must come first
    //   2. challenge is ours, fresh, single-use   ← done above
    //   3. signature verifies against the bound key   ← here
    //
    // See https://docs.libertynet.ai/guides/service-agent for step 3 in full.
    return send(501, {
      error: "signature verification not implemented in this example",
      detail:
        "gates 1 and 2 passed. Step 3 needs an Ed25519 implementation — see " +
        "https://docs.libertynet.ai/guides/service-agent#challengeresponse",
      gates_passed: ["id-binding", "challenge freshness"],
    });
  }

  send(404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Identity gate on http://localhost:${PORT}\n`);
  console.log("  # anonymous → 401");
  console.log(`  curl -s localhost:${PORT}/whoami\n`);
  console.log("  # forged identity → 401");
  console.log(`  curl -s localhost:${PORT}/whoami \\`);
  console.log(`    -H 'x-ln-did: did:svrp:n:deadbeef' \\`);
  console.log(`    -H 'x-ln-public-key: df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d'\n`);
  console.log("  # real identity → 200");
  console.log(`  curl -s localhost:${PORT}/whoami \\`);
  console.log(`    -H 'x-ln-did: did:svrp:df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d' \\`);
  console.log(`    -H 'x-ln-public-key: df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d'`);
});
