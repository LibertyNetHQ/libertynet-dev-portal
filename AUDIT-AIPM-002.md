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
| C1 | "Every page has a Copy for AI button" | 🔴 **did not exist** | 🟢 built + build-time check | [C1](#c1) |
| C2 | MCP install instructions work | 🔴 **path did not exist** | 🟢 one-file install, tested clean | [C2](#c2) |
| C3 | `/api-reference` | 🔴 **404, linked from 3 pages** | 🟢 generated from the matrix | [C3](#c3) |
| C4 | Links to the source repository | 🔴 **all 404 for strangers** | 🟢 fixed + fetched anonymously | [C4](#c4) |
| C5 | Translations described as complete | 🔴 **all 10 behind** | 🟢 step written + "behind" state | [C5](#c5) |

| D1 | OpenAPI `DeviceCredential` schema | 🔴 **could not produce a working credential** | 🟢 nine fields + `x-ln-canonical`, checked live | [D1](#d1) |
| D2 | `install.sh` fail-closed | 🔴 **fixed on the server only** | 🟢 repo synced + 16 behaviour assertions | [D2](#d2) |
| D3 | zh-CN capability page | 🔴 **listed 11 of 22 endpoints** | 🟢 21/21 + parity check | [D3](#d3) |
| D4 | sitemap.xml | 🔴 **invalid XML namespace** | 🟢 fixed, deployed | [D4](#d4) |

**Ten claims were false.** Every one is fixed, and every one now has a check that fails if
it regresses — see `GO-NO-GO.md` for the measured §6 verdict.

---

## Round 3 — what measuring rather than reading found {#d1}

Round 2 was still largely a careful read. Round 3 probed the running system, and
everything below was invisible to reading.

### D1 — the published credential schema could not produce a working credential {#d1}

The OpenAPI file listed seven fields; the registry signs nine. Measured by dropping
one field at a time against the live registry — excluding `device_id`,
`revocation_id` or `permissions` from the signed bytes each returns
`401 DC_BAD_SIGNATURE`. A developer following the documentation exactly produced a
credential that cannot verify, against an error naming no field.

The canonical byte layout was documented **nowhere at all** — not in the spec, not
in the guide. Which is exactly why nothing caught it: neither SDK could issue a
credential, both only accepted pre-built ones, so no code here had ever built one
from the published schema. The documentation was free to say anything.

`tools/check-credential-schema.mjs` now reads `x-ln-canonical` at run time, signs
those fields in that order, and requires the live registry to accept the result.
Reverting the spec to seven fields makes it fail.

**Also found, not fixed:** omitting a required field returns **502**, not a
validation error — an unhandled exception on an unauthenticated endpoint. Private
repo, so it goes to David.

### D2 — the installer fix had only reached the server {#d2}

`libertynet.ai/install.sh` was fail-closed and correct. `scripts/install.sh` in the
repository still had:

```bash
else
    warn "未找到 SHA256 校验文件，跳过完整性校验"
fi
```

An attacker never needed to forge a digest — making `<asset>.sha256` return 404 was
enough to skip verification entirely. And the next deploy from source would have
reinstated it. Nothing compared the two, so the divergence was invisible.

Synced, with 16 behaviour assertions and one that asserts live and repo are
byte-identical. Restoring the old installer turns the 404 case red: exit 0, binary
installed anyway.

### D3 — the Chinese capability page listed half the endpoints {#d3}

11 of 22. The whole binding group, credits, evidence and the oracle report endpoint
were absent — a reader looking up `POST /v1/bindings/resolve` could not find out
whether it works. The page summarised where the English enumerated, which is fine
prose instinct and wrong on a capability page, where the enumeration is the content.

Check 6d now refuses a translated status page that lists fewer endpoints than the
English one. Prose may be shorter in another language; the list of what exists
may not.

### D4 — the sitemap was not a sitemap {#d4}

`xmlns="http://www.sitemap.org/schemas/sitemap/0.9"` — singular. The standard is
`sitemaps.org`, plural, and the singular host does not resolve at all, so no crawler
would have accepted the document. Found by widening the anonymous link check from
49 files to 178.

---

## Round 2 — what a second look found {#c1}

The first audit found two false claims by looking. The second round found four more, which
is the argument for not relying on looking.

### C1 — the Copy-for-AI button did not exist {#c1}

`docs-site/ai/assistant.mdx` claimed *"Every page has a button that copies it as clean
markdown"* and marked it `implemented`. It appeared 0 times in the built site and 0 times in
production — the identical failure to the ⌘K assistant in A1, made on the page written to
correct it. The markdown twins already existed, so the honest fix was to build the missing
half rather than downgrade the claim.

**Why nothing caught it:** claims about endpoints were checked against `status.json`; claims
about the site's own UI were checked by nothing. `check-docs-drift.mjs` check 6b now pins
each self-claim to a marker that must exist in the generator, and `audit-implemented.mjs`
requires *every* `implemented` badge to have a verifier.

### C2 — the MCP install instructions could not work {#c2}

They said to clone the repository and use `dev-portal/mcp-server/src/server.mjs` — a path
that stopped existing when the portal moved to its own repository. Six working tools behind
an impossible instruction.

Now one `curl` fetches a single self-contained file. The acceptance test copies it into an
empty temp directory and drives it over real JSON-RPC, then launches the server using the
JSON configs printed on the page, from `$HOME`, outside any checkout. 19/19.

### C3 — `/api-reference` was a 404 {#c3}

Linked from the home page card, the changelog and the footer. It was to be rendered by
Mintlify from the OpenAPI file; self-hosting never replaced it. The link checker excused it
via a `GENERATED` whitelist entry for a renderer no longer in use — an exception that
existed only to hide the failure it was covering for.

Now generated by `sync-status.mjs` from the matrix plus the OpenAPI summaries, so it flows
through nav, i18n, twins and drift-checking like any other page. The whitelist is gone.

### C4 — every link to the source repository 404'd for strangers {#c4}

`github.com/LibertyNetHQ/LibertyNet-hq` is private. It answers 200 to us and 404 to
everyone else, so the links looked fine to the people who wrote them. Roughly a dozen,
including the "read the source" card on the examples page.

`check-external-links.mjs` now fetches every external link **with no credentials at all**,
because checking as ourselves proves nothing.

### C5 — the translations were quietly behind {#c5}

All ten quickstart translations were missing step 4 — the step that proves the loop closes,
added to the English page when the demo node landed. They rendered as finished translations
because "a file exists" was the only test the builder applied.

The step is now written in all ten languages (verified by running the Japanese page's
snippet against the live network), and the builder distinguishes three states instead of
two: untranslated, translated, and *behind the English original*.

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
PR #560 in the private LibertyNet-hq repository):

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

---

# P3 · P4 · P6 — evidence

Measured 2026-08-01. Same rule as above: run it, do not read it.

## P3 — ten examples, each actually executed

```text
node examples/run-all.mjs

  ✓ verify-network       2 check(s)
  ✓ callable-nodes       1 check(s)
  ✓ full-loop            1 check(s)
  ✓ challenge-response   1 check(s)
  ✓ did-toolkit          4 check(s)
  ✓ health-check         2 check(s)
  ✓ registry-watch       2 check(s)
  ✓ identity-gate        3 check(s)
  ✓ capability-monitor   2 check(s)
  ✓ mcp-client           1 check(s)

19 check(s) across 10 example(s)
✓ every example ran and did what it says it does
```

The runner spawns each example, waits for it, and matches its real output. "It compiled" is
not the bar — examples rot silently, because nobody re-runs the ones they are not currently
reading.

**Four checks assert failure**, and those are the ones worth having:

| Example | Must fail |
|---|---|
| `did-toolkit` | a crossed DID/key pair exits 1 |
| `identity-gate` | a forged identity gets 401 |
| `challenge-response` | a replayed signature does not verify |
| `capability-monitor` | an unavailable capability exits non-zero |

Proved non-vacuous by sabotaging `did-toolkit`'s comparison so a crossed pair passed:

```text
✗ did-toolkit: verify did:svrp:n:268d4fe0 df9d4b9f…
     exit 0 (expected 1) — A crossed DID/key pair MUST fail.
     output never matched /^INVALID/
```

### A real gap the safety checker found

`registry-watch` did not verify identities before recording them, so a forged record would
have been announced as a legitimate `JOINED` event — the tool would have been a megaphone
for whoever forged it. Fixed: it verifies first and reports rejects loudly.

The checker itself was also wrong — it matched one function name, and failed three examples
that verify perfectly well by other means. Narrow checks teach people to silence them.

## P4 — the matrix is authoritative, not aspirational

`tools/sync-status.mjs` regenerates four artifacts from `api-spec/status.json`. `--check`
fails on any hand-edit.

**Acceptance test, run end to end:**

```text
1. flip GET /v1/operator/me/credits  not_yet_wired → implemented
2. node tools/sync-status.mjs --check
     ✗ 4 generated file(s) are stale
3. node tools/sync-status.mjs
     OpenAPI      x-ln-status: implemented
     TS SDK       "GET /v1/operator/me/credits": "implemented"
     Python SDK   "GET /v1/operator/me/credits": "implemented"
     docs table   <Status level="implemented" />
4. restore → all four revert, --check passes
```

### Three bugs this surfaced

1. **`check-api-sync` ignored `base_url`**, probing the demo node's paths against the
   registry — three phantom "overclaim" findings for endpoints that were fine.
2. **No rule for the overclaim that matters most.** Nothing caught "claimed `implemented`
   but the body says `not_yet_wired`" — the dangerous case, because the endpoint returns
   200 and looks healthy. Added. It now also names the endpoints sitting behind auth whose
   data source it *could not* inspect, rather than implying a clean bill of health it did
   not earn.
3. **The generated capability map was keyed flat**, and `GET /health` exists on both the
   registry and the demo node — one silently overwrote the other. Now nested by area. The
   TypeScript compiler caught it; a flat map in a dynamic language would have shipped.

### Workflows

| | |
|---|---|
| `status-sync.yml` | Checks on PR. On main, opens a regeneration PR rather than pushing — the point of this repo is that claims get reviewed. |
| `ai-answer-report.yml` | An `ai-answer` issue triggers the eval and posts what the assistant would have read. |
| `docs-drift.yml` | Now applies **underclaims** and regenerates. Overclaims are left alone: the right fix might be restoring the endpoint rather than downgrading the claim. |

**None of them edit prose.** A capability moving to `implemented` needs a human to write
what it does; a machine inventing that paragraph would manufacture exactly the confidence
this project exists to avoid.

## P6 — ready except for the person

`p6/` contains the walkthrough, the friction-log template, recording guidance, a
dependency-free timer, and a Dockerfile for a genuinely clean machine.

The clean machine is not ceremony. On a maintainer's laptop the venv is built, gcloud is
authenticated and the answers are in shell history — each one silently removes a step a
stranger hits.

The image was built and smoke-tested:

```text
READY  libertynet-p6:latest  557MB

v22.23.2
Python 3.11.2
registry reachable: 200
user: tester
home: WELCOME.txt timer.mjs
libertynet code present? 0        ← correctly clean

$ node timer.mjs start "step 1 - first call"
$ curl -s https://registry.libertynet.ai/health
{"status": "ok", "service": "libertynet-registry-standalone", "count": 28}
✓ step 1 - first call  (1s)
```

The base `node:22-bookworm-slim` genuinely lacks `python3` and `curl`, so the apt layer is
doing real work rather than being cargo-culted — checked rather than assumed.

**Deliberately not automated: finding testers.** Three real strangers beat thirty synthetic
runs, and choosing who represents the audience is a judgement call.

`p6/README.md` states that **an empty friction log means the session failed**, not that the
portal is perfect — and lists what does *not* count as passing, because "three testers
finished, two after asking a maintainer" is the easiest way to mark this green dishonestly.

<br>

**Why this was worth waiting for.** Running P6 before P1 would have wasted somebody's
afternoon: they would have walked `discover → verify`, hit the wall where every node was on
a private address, and found one enormous blocker and nothing else. The walkthrough now has
an end.
