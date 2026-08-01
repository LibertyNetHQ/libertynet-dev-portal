# Audit — claimed vs. measured

`LIBERTYNET-DEV-PORTAL-UPGRADE-AIPM-002` P0. Every row was tested, not read.
Measured 2026-08-01 against production.

---

## Summary

| # | Claim | Before | After | Evidence |
|---|---|---|---|---|
| A1 | In-docs "Ask AI" (⌘K) | 🔴 **did not exist** | 🟢 page corrected + eval in CI | [A1](#a1) |
| A2 | Scaffold: 10s, 4 templates, zero deps | 🟢 true | 🟢 re-measured | [A2](#a2) |
| A3 | MCP server, 6 tools | 🟡 untested over the wire | 🟢 tested end to end | [A3](#a3) |
| A4 | Private-network nodes | 🔴 **worse than reported** | 🟢 classified + demo node | [A4](#a4) |
| B1 | "Call a live node" is true externally | 🔴 **impossible** | 🟢 loop closes | [B1](#b1) |

**Two claims were false.** Both are fixed and both now have a test that fails if they regress.

---

## A1 — the "Ask AI" chat box did not exist {#a1}

**Claimed:** `docs-site/ai/assistant.mdx` opened with *"Press ⌘K (or click Ask AI) anywhere
in these docs."*

**Measured:**

```bash
curl -s https://docs.libertynet.ai/ | grep -ci "ask ai"
# → 0
```

There was no such feature and there never had been. The page described a widget belonging to
a hosted documentation platform, written before the decision to self-host — and the decision
to self-host is what made 11 languages and a custom domain possible at all.

This is the portal's own failure mode, in the portal. Documentation that describes an
unbuilt feature is precisely what every other page on the site is engineered to prevent.

**Fixed:**

- The page now describes what exists — MCP server, Copy-for-AI, `llms.txt`, honest corpus —
  and states plainly, in a `<Warning>`, that the earlier version was wrong. Corrected rather
  than quietly deleted.
- A hosted assistant needs an LLM key on a server, which is a bill and a secret. That is
  David's decision, so it is marked `planned` rather than silently dropped.
- `tools/check-ai-answers.mjs` now runs **16 golden questions, 9 adversarial, 70 assertions**
  in CI.

That eval found four further real defects on its first run, listed under [A5](#a5).

---

## A2 — scaffolder {#a2}

| Template | Scaffold | Tests | Deps |
|---|---|---|---|
| `monitor` | 0.01s | 7/7 | 0 |
| `service` | 0.01s | 7/7 | 0 |
| `solver` | 0.01s | 10/10 | 0 |
| `custom` | 0.01s | 7/7 | 0 |

Against a 10-second target. Generated projects run with no `npm install` at all.

The service template's identity gate was exercised against live traffic — anonymous `401`,
forged identity `401`, real identity `200`. 🟢 **claim holds**

---

## A3 — MCP server {#a3}

Driven over real JSON-RPC as a subprocess, not just unit-tested:

```text
initialize        → protocol 2024-11-05, instructions carry the honesty rules
tools/list        → 6 tools, all schema-valid
capability_status → wallet/dex all "planned", economics "not_yet_wired", oracle "testing"
search_docs       → see A5, this was broken
get_page          → full content, suggests alternatives on a miss
verify_identity   → 4/4 including a forged pair and a malformed DID
list_nodes        → live: 28 registered, 28 verified, 0 rejected
check_endpoint    → live probe
stdout hygiene    → only JSON-RPC; diagnostics to stderr
```

29/29 tests. 🟢 **claim holds**, with one tool found broken — next section.

---

## A5 — what the eval found {#a5}

Four defects, none of which a human review would plausibly have caught:

**1. Search failed on error codes.** Asking *"ID_BINDING_FAILED what does it mean"* returned
`concepts/credits`, `status`, `ai/assistant` — not the error dictionary. The query's common
words (`what`, `does`, `it`, `mean`) appear on every page and drowned out the one term that
mattered. Fixed with stopword removal, inverse-frequency weighting and a heading bonus:

```text
before  ID_BINDING_FAILED …  → concepts/credits, status, ai/assistant
after   ID_BINDING_FAILED …  → reference/errors, reference/changelog, …
```

**2. Search returned translations as duplicates.** An English query returned
`reference/errors` *and* `zh-CN/reference/errors`, spending the result budget on a page the
caller could not read. Search is now locale-scoped.

**3. `status: "active"` had no landing page.** Someone asking what that field means landed on
`/status` — the *capability* status page, an entirely different thing with a confusingly
similar name — which never explained it. Added a disambiguating note where they actually land.

**4. No key-handling warning where it was needed.** Asking *"where do I put my private key in
the config file"* returned `dashboard`, `examples`, `quickstart` — **none of which warned
against it.** The keychain guidance existed only on pages that question does not reach. This
is the one with real consequences, and it is now a `<Warning>` in the quickstart.

---

## A4 — the private-node problem was worse than reported {#a4}

The AIPM flagged one node on `172.20.10.5` with `signature: null`. The measurement:

```text
total                                  28
  public endpoint                      11
  RFC1918 private                        4
  unroutable (node://hostname)          13
  carrying any signature                 5
  publicly reachable AND signed          0     ← before this work
```

All **three** nodes that were fresh at audit time were unreachable:

| DID | endpoint | signature |
|---|---|---|
| `did:svrp:df9d4b9f…` | `172.20.10.5:55785` | null |
| `did:svrp:h:0b9d4eb8` | `node://dududeMacBook-Pro` | null |
| `did:svrp:h:2216a202` | `node://libertynet-node-1` | null |

**Verdict: discovery was not broken — it was faithfully reporting nodes that are real to
their operators and useless to everyone else.** The defect was that nothing said so, and the
docs sent people to those addresses.

**Fixed** by classifying rather than hiding (`registry-standalone.py`, genesis
[PR #560](https://github.com/LibertyNetHQ/LibertyNet-hq/pull/560)):

```text
reachability       "public" | "private" | "unroutable"
signature_present  bool
?callable=1        publicly reachable AND signed
```

Additive on purpose: `ln-node`, the Operator Console and both SDKs read this endpoint, and
silently dropping records would break them in ways that are hard to trace back. Verified
before and after restart — all seven consumer paths identical, same 28 nodes.

Both SDKs now exclude unreachable nodes by default (`includeUnreachable` opts back in) and
gained `callable()` / `callable_nodes()`.

---

## B1 — the loop now closes from outside {#b1}

Before: an external developer could discover and verify, then hit a wall. The front page's
promise was not literally true for anyone outside the project.

A canonical demo node now runs at `https://libertynet.ai/demo-node` — real Ed25519 identity,
**signed** registration and heartbeats, publicly reachable, and it signs a caller-supplied
nonce so the reply is proof of possession rather than a replayable recording.

```text
[demo-node] identity did:svrp:n:dbe63a0c
[demo-node] registered signed=True id_bound=True
```

`signed=True` matters: it is the first node on the network whose registration the registry
actually verified rather than accepted in grace mode.

Full loop, from a clean machine, public URLs only, stdlib plus one crypto library:

```text
1 DISCOVER  28 nodes, 1 publicly callable AND signed
            -> did:svrp:n:dbe63a0c  https://libertynet.ai/demo-node
2 VERIFY    id-binding holds: sha256(key)[:4] == dbe63a0c
            registration signature verifies
3 ACT       called https://libertynet.ai/demo-node/echo
            response signed over OUR nonce, verifies against the discovered key

LOOP CLOSED — discover -> verify -> act, all cryptographically checked
```

Reproduce with `examples/full-loop/`.

<br>

**One number worth sitting with: 1 of 28.** That is the honest state of the network, and the
quickstart now says so rather than implying a busy marketplace. It is also why P6 — real
developers walking the path — is worth doing now that there is a path to walk.

---

## Still true, still worth saying

- **`registry.libertynet.ai` accepts unsigned registrations** (grace mode). 23 of 28 records
  carry no signature. The demo node proves signed registration works end to end, so strict
  mode is now a decision rather than a blocker — but flipping it would evict most of the
  current table, which makes it David's call.
- **Nothing is published to npm or PyPI.** Unchanged, and deliberate per AIPM-002 §P5.
- **Discord does not exist**, so 4 links in the docs point at nothing. Still the only
  knowingly-false thing left in the portal.
