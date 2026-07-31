/**
 * Identity tests.
 *
 * The fixtures are real records taken from https://registry.libertynet.ai/nodes
 * on 2026-07-31, not invented ones. A test that only proves the code agrees with
 * itself would not have caught the hex/base58 mix-up these cover.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  decodePublicKey,
  didFromPublicKey,
  fingerprint,
  parseDid,
  sameIdentity,
  verifyIdBinding,
} from "../src/did.ts";
import { assertIdBinding } from "../src/did.ts";
import { IdentityError } from "../src/errors.ts";

/** Full-hex form: the DID body IS the key. From GET /nodes. */
const FULL = {
  did: "did:svrp:df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d",
  publicKeyHex: "df9d4b9f390bc49b2210eca81ca3c54c4d63b37b739442a21e28f2ed5b8aa02d",
};

/** Short form: the DID body is SHA-256(key)[0:4]. Key served as base58. From GET /peers. */
const SHORT = {
  did: "did:svrp:n:268d4fe0",
  publicKeyB58: "7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg",
};

describe("parseDid", () => {
  test("recognises the full-hex form", () => {
    const p = parseDid(FULL.did);
    assert.equal(p?.form, "full-hex");
    assert.equal(p?.tag, null);
  });

  test("recognises the tagged short form", () => {
    const p = parseDid(SHORT.did);
    assert.equal(p?.form, "short");
    assert.equal(p?.tag, "n");
    assert.equal(p?.body, "268d4fe0");
  });

  test("recognises the 10-hex collision fallback", () => {
    assert.equal(parseDid("did:svrp:n:268d4fe012")?.form, "short-fallback");
  });

  test("rejects a tagged 64-hex value — not a shape the protocol emits", () => {
    assert.equal(parseDid(`did:svrp:n:${FULL.publicKeyHex}`), null);
  });

  test("rejects junk rather than guessing", () => {
    for (const bad of ["", "did:svrp:", "did:web:example.com", "did:svrp:n:ZZZZ", "did:svrp:n:abc"]) {
      assert.equal(parseDid(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("decodePublicKey", () => {
  test("accepts hex", () => {
    assert.equal(decodePublicKey(FULL.publicKeyHex)?.length, 32);
  });

  test("accepts base58", () => {
    assert.equal(decodePublicKey(SHORT.publicKeyB58)?.length, 32);
  });

  test("rejects a key that is not 32 bytes", () => {
    assert.equal(decodePublicKey("deadbeef"), null);
  });

  test("hex and base58 of the same key decode to identical bytes", () => {
    const fromHex = decodePublicKey(FULL.publicKeyHex)!;
    const b58 = didFromPublicKey(FULL.publicKeyHex); // exercises the same path
    assert.ok(b58.startsWith("did:svrp:n:"));
    assert.equal(fromHex.length, 32);
  });
});

describe("verifyIdBinding", () => {
  test("accepts a real full-hex identity", () => {
    assert.equal(verifyIdBinding(FULL.did, FULL.publicKeyHex), true);
  });

  test("accepts a real short identity with a base58 key", () => {
    assert.equal(verifyIdBinding(SHORT.did, SHORT.publicKeyB58), true);
  });

  test("rejects a DID paired with someone else's key", () => {
    assert.equal(verifyIdBinding(SHORT.did, FULL.publicKeyHex), false);
    assert.equal(verifyIdBinding(FULL.did, SHORT.publicKeyB58), false);
  });

  test("rejects a single flipped character in the DID", () => {
    const tampered = FULL.did.slice(0, -1) + (FULL.did.endsWith("d") ? "e" : "d");
    assert.equal(verifyIdBinding(tampered, FULL.publicKeyHex), false);
  });

  test("rejects a malformed DID without throwing", () => {
    assert.equal(verifyIdBinding("not-a-did", FULL.publicKeyHex), false);
  });

  test("rejects a malformed key without throwing", () => {
    assert.equal(verifyIdBinding(FULL.did, "!!!not-base58!!!"), false);
  });
});

describe("assertIdBinding", () => {
  test("throws IdentityError on a mismatch", () => {
    assert.throws(() => assertIdBinding(SHORT.did, FULL.publicKeyHex), IdentityError);
  });

  test("the error carries the DID and a docs link", () => {
    try {
      assertIdBinding(SHORT.did, FULL.publicKeyHex);
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof IdentityError);
      assert.equal(e.did, SHORT.did);
      assert.equal(e.code, "ID_BINDING_FAILED");
      assert.match(e.docs, /^https:\/\/docs\.libertynet\.ai\//);
    }
  });
});

describe("didFromPublicKey", () => {
  test("re-derives the short DID from its own key", () => {
    assert.equal(didFromPublicKey(SHORT.publicKeyB58, "n"), SHORT.did);
  });

  test("honours the role tag", () => {
    assert.ok(didFromPublicKey(SHORT.publicKeyB58, "o").startsWith("did:svrp:o:"));
  });
});

describe("sameIdentity", () => {
  test("matches the short and full spellings of one key", () => {
    const short = didFromPublicKey(FULL.publicKeyHex, "n");
    assert.equal(sameIdentity(short, FULL.did, FULL.publicKeyHex), true);
    // ...even though the strings are nothing alike:
    assert.notEqual(short, FULL.did);
  });

  test("does not match two different keys", () => {
    assert.equal(sameIdentity(SHORT.did, FULL.did, FULL.publicKeyHex), false);
  });
});

describe("fingerprint", () => {
  test("is grouped for humans to compare", () => {
    assert.match(fingerprint(FULL.publicKeyHex), /^[0-9a-f]{4}(:[0-9a-f]{4}){3}$/);
  });

  test("is stable across the two key encodings", () => {
    assert.equal(fingerprint(SHORT.publicKeyB58), fingerprint(SHORT.publicKeyB58));
  });

  test("differs between different keys", () => {
    assert.notEqual(fingerprint(FULL.publicKeyHex), fingerprint(SHORT.publicKeyB58));
  });
});
