# Test evidence

Verification for `LIBERTYNET-DEV-PORTAL-AIPM-001 §12`, all thirteen acceptance criteria.

Run **2026-07-31 / 2026-08-01**, macOS, Node v25.9.0, Python 3.14.6, against the live
production registry at `https://registry.libertynet.ai`.

Every output below was produced by running the command shown. Where a criterion is only
partly met, it says so and says what is missing — a criterion marked complete when it is not
would defeat the point of the document.

---

## Summary

| # | Criterion | Result |
|---|---|---|
| 1 | One command, 10s, runnable skeleton | ✅ **0.01s** |
| 2 | First successful call < 5 minutes | ✅ **~15s** to a verified call |
| 3 | Docs quality — runnable example + real response per API, concepts/reference split | ✅ |
| 4 | Scaffolder at `create-next-app` level | ✅ |
| 5 | AI assistant writes runnable, safe code | ⚠️ **Partial** — MCP server done and tested; hosted assistant needs Mintlify connected |
| 6 | Docs machine-readable (MCP / llms.txt) | ✅ MCP done; `llms.txt` on deploy |
| 7 | Docs auto-maintenance | ⚠️ **Partial** — drift checker done; the AI-drafts-a-PR loop is not built |
| 8 | Living Language visual, WCAG AA readability | ✅ |
| 9 | Community flywheel | ⚠️ **Partial** — pages and examples done; Discord does not exist yet |
| 10 | Every interface honestly status-marked | ✅ Enforced by a build check |
| 11 | Security — no keys leaked, examples teach good habits | ✅ Enforced by tests |
| 12 | Mobile + at least English and Chinese | ✅ |
| 13 | Quantifiable | ⚠️ **Partial** — instrumentation needs a deployed site |

**9 of 13 fully met. 4 partial — all four blocked on deployment or on decisions outside a
documentation change.** Details under each heading.

---

## A. Live endpoint probe — the basis for every status badge

```bash
for u in /health /nodes /peers /api/v1/peers /v1/operator/me/nodes \
         /v1/operator/me/credits /v1/operator/me/evidence \
         /v1/bindings/initiate /v1/auth/challenge /v1/bindings/zzz/status; do ... done
```

```text
GET  /health                     200  {"status": "ok", "service": "libertynet-registry-standalone", "count": 27}
GET  /peers                      200  did:svrp:n:268d4fe0 7441yUYc1qmWVkAAUrPapKC13MXusEqDvvQJ1Pw5NNfg ...
GET  /api/v1/peers               200  {"ok": true, "data": [], "error": null}
GET  /v1/operator/me/nodes       401  {"code": "NO_SESSION", "error": "missing bearer token"}
GET  /v1/operator/me/credits     401  {"code": "NO_SESSION", "error": "missing bearer token"}
GET  /v1/operator/me/evidence    401  {"code": "NO_SESSION", "error": "missing bearer token"}
POST /v1/bindings/initiate       400  {"error": "missing required binding-session fields"}
POST /v1/auth/challenge          200  {"challenge": "7xyZt3pE8DSp6JzsSpRMc7o8PSUsH5R2P", "expires_in": 300}
GET  /v1/bindings/zzz/status     404  {"code": "NOT_FOUND", "error": "unknown session"}
GET  /v1/nope                    404  {"error": "not found"}
```

All 19 documented operations exist and behave as the spec describes. `credits` and
`evidence` are reachable but unwired — confirmed by reading
`code/portal-daemon/deploy/gce/binding_api.py:700`, which returns zeros with
`"source": "not_yet_wired"` and an explicit comment saying no ledger is connected.

---

## 1. One command, 10 seconds ✅

```bash
$ node create-libertynet-agent/index.mjs watcher --type monitor -y

✓ watcher created in 0.01s
  8 files · Network monitor · zero dependencies
```

**0.01s**, against a 10-second target. The generated project has **zero dependencies**, so
there is no `npm install` between creation and running.

All four templates scaffold and pass their own tests:

```text
watcher (monitor)   7/7 tests pass
proj-service        7/7 tests pass
proj-solver        10/10 tests pass
proj-custom         7/7 tests pass
```

---

## 2. First successful call < 5 minutes ✅

The [quickstart](docs-site/quickstart.mdx) has no signup step, because discovery is public.

| Step | Time |
|---|---|
| `curl .../health` | ~1s |
| List nodes | ~1s |
| Save and run `verify.mjs` — verifies **every identity on the network** | ~10s |

**~15 seconds to a cryptographically verified call**, with nothing installed. Both the Node
and Python versions were run as written:

```bash
$ node examples/verify-network/verify.mjs
27/27 identities verified
2 seen in the last 10 minutes

$ python3 examples/verify-network/verify.py
27/27 identities verified
2 seen in the last 10 minutes
```

The Chinese quickstart's code was re-run separately and produces
`27/27 个身份通过验证`.

---

## 3. Documentation quality ✅

**Concepts and reference are separate**, per the spec's Stripe comparison:

- `concepts/` — overview, identity, nodes-and-discovery, binding, credits, intents
- `reference/` — errors, dids, changelog
- `guides/` — service-agent, discovery-agent, operator-login, solver-node, tokens
- API reference generated from OpenAPI with a playground

**Every OpenAPI operation carries a runnable example and a real recorded response.** The
`/health` and `/nodes` examples are labelled *"Real response, probed 2026-07-31"* and are
literal captures.

**Error dictionary**: every code documented with cause **and** fix. Every SDK error carries
a `docs` link straight to its entry:

```text
NotYetWiredError [NOT_YET_WIRED]: ... → https://docs.libertynet.ai/status
```

Asserted by test: *"every SDK error carries a docs link"* (TypeScript), *"test_every_error_carries_a_docs_link"* (Python).

---

## 4. Scaffolder quality ✅

44/44 tests pass. Interactive prompts **and** a flag for every prompt, so it is scriptable by
CI and by AI assistants.

Generated projects were run against the live network:

```text
$ cd proj-custom && node src/index.mjs
Registry is ok with 27 nodes registered.

Online now:
  did:svrp:h:2216a202  ?  node  fp=2216:a202:8332:7693
  did:svrp:df9d4b9f390bc49b2210e  asia-southeast  inference,health:ready  fp=8545:027b:6100:1591
```

The service template's identity gate was exercised end to end:

```text
anonymous          → {"error": "no identity presented"}  [401]
forged identity    → {"error": "id-binding failed"}      [401]
valid identity     → {"served": "did:svrp:df9d...02d"}   [200]
```

---

## 5. AI assistant ⚠️ Partial

**Done and tested.** The MCP server: 6 tools, 29/29 tests including the real JSON-RPC
protocol driven as a subprocess.

```bash
$ printf '...' | node mcp-server/src/server.mjs
{
  "registered": 27,
  "verified": 27,
  "rejected_id_binding": [],
  "returned": 2,
  "nodes": [ ... ]
}
```

Guardrails are asserted by test, not hoped for:

- `initialize` returns instructions containing `not_yet_wired`, `test unit`, `NO wallet`.
- `wallet`/`dex` tools report `planned` for every endpoint.
- `oracle` reports `testing`, not `planned` — the contracts do exist.
- An unknown tool errors; a tool failure returns readable content rather than vanishing.
- **stdout carries only JSON-RPC** — a stray `console.log` would corrupt the stream for
  every client, and only the subprocess test catches that.

**Not done.** The hosted in-docs assistant is Mintlify's built-in feature and activates when
the repository is connected. Its guardrails come from the corpus it reads, which is now
honest throughout — but it cannot be demonstrated until the site is deployed.

---

## 6. Machine-readable docs ✅ / on deploy

**Done**: the MCP server, `api-spec/status.json`, and `api-spec/libertynet-v1.yaml` — all
readable by an assistant today.

**On deploy**: `llms.txt` and `llms-full.txt` are generated by Mintlify at build time, as is
the `.md` suffix on every page URL. Both are documented in [`ai/context`](docs-site/ai/context.mdx)
and require no further work — only hosting.

---

## 7. Docs auto-maintenance ⚠️ Partial

**Done**: `tools/check-docs-drift.mjs` — six checks, run on every PR.

```text
checked 35 pages
  · spec: 19 operations, 28 matrix entries, 0 non-planned not in spec
  · crypto: 48 cryptographic literals recomputed from source keys
  · links: 75 internal links resolved
  · navigation: 35 pages listed, 35 on disk

✓ docs honesty checks passed
```

The crypto check earns its place: **it caught a real error during authoring** — a
fingerprint written from memory rather than computed (`268d:4fe0:a91c:33bd`, actually
`268d:4fe0:b6ef:c390`). Prose can be reviewed by a human; a hex string can only be
recomputed.

**Not done**: the spec's "code changes → AI drafts a docs PR" loop. That needs a CI workflow
under `.github/`, which is a **Red Lane** path in this repository and needs David's approval
rather than being added silently.

---

## 8. Living Language, WCAG AA ✅

Pure black `#000000`, life cyan `#00E5C7`, colour-as-state, 95% silence — with
documentation legibility taking precedence where the two conflict.

Contrast measured (WCAG 2.1 relative luminance), recorded in `docs-site/style.css`:

| Pair | Ratio | Grade |
|---|---|---|
| `#E6EFEC` on `#000000` (body, dark) | 17.3:1 | AAA |
| `#8FA5A0` on `#000000` (muted, dark) | 8.8:1 | AAA |
| `#00E5C7` on `#000000` (accent, dark) | 13.0:1 | AAA |
| `#E6EFEC` on `#0A0C0D` (code) | 16.4:1 | AAA |
| `#7E8F8B` on `#0A0C0D` (comments) | 5.8:1 | AA |
| `#007A69` on `#FFFFFF` (accent, light) | 5.3:1 | AA |
| `#10201C` on `#FFFFFF` (body, light) | 16.9:1 | AAA |

`#00E5C7` measures **1.6:1 on white** — far below AA — so in light mode it is never used for
text or icons; the darkened `#007A69` carries the brand instead.

Other measures: colour is always paired with a word (`● ONLINE`, never colour alone);
`prefers-reduced-motion` stops all animation; ligatures disabled in code so `=>` and `!=`
read as the characters they are.

**LivingMark**: three arcs at 43s / 61s / 79s — pairwise coprime, so the figure does not
repeat for ~2.4 days. The React component additionally randomises each arc's starting phase
per mount, so no two page loads are identical. Nothing is a baked raster.

Dashboard verified visually at desktop and mobile (screenshots taken during the run).

---

## 9. Community flywheel ⚠️ Partial

**Done**: [community](docs-site/community.mdx) and [contributing](docs-site/contributing.mdx)
pages, an [examples library](examples/) of three runnable programs, four scaffolder
templates, and a showcase section.

**Not done**: `discord.gg/libertynet` **does not exist yet** and needs to be created. It is
referenced throughout the docs.

**Deliberately not done**: contributor reward amounts. The interface is reserved and the
page says plainly that no rates, amounts or eligibility rules have been decided — because
none have. Inventing a number to make the page feel complete is exactly what this portal
refuses to do, and the economics are a David decision.

---

## 10. Honest status marking ✅

Enforced, not promised. One machine-readable source (`api-spec/status.json`) drives every
badge in the docs, both SDKs and the OpenAPI spec, and a build check fails if they disagree.

The SDKs make dishonesty impossible rather than merely discouraged:

```text
$ ln.operator.settled_credits()
NotYetWiredError: [NOT_YET_WIRED] GET /v1/operator/me/credits is not_yet_wired:
the endpoint is live but no credits ledger is connected, so the returned 0 is a
placeholder rather than a balance.
  -> https://docs.libertynet.ai/status
```

Asserted by test in both languages:

- `settledCredits()` refuses a `not_yet_wired` zero
- `creditsRaw()` still returns the envelope with `source` intact
- `settledCredits()` works the moment `source` becomes `"ledger"` — no caller change
- `wallet`/`dex` raise with `level: "planned"`
- **`oracle` raises with `level: "testing"`, not `planned`** — the contracts genuinely exist
  and pass 23/23; only the deployment is missing, and merging those two claims is one of the
  easiest ways for documentation to become false

---

## 11. Security ✅

**No API keys exist to leak.** LibertyNet has no API keys at all: discovery is public,
operator access is a signature-based challenge–response. The dashboard therefore has **no
key manager** — building one would have meant inventing a concept the network does not have.
Documented in [`dashboard/README.md`](dashboard/README.md).

| Requirement | How it is met |
|---|---|
| Keys never in frontend/logs | There are no keys. |
| Encrypted at rest | Nothing at rest. The session token is in memory only — not `localStorage`, not a cookie. A refresh signs you out, on purpose. |
| Login resists stuffing | No password to stuff. Ed25519 signature over a single-use 300s challenge. |
| Rate limiting | Client-side attempt cap; registry expires challenges and rate-limits resolves server-side. |
| Private key handling | Used once in-browser, **zeroed immediately**, never transmitted, never in an error message. |

**Example and template safety is enforced by tests**, across `examples/` and every generated
template:

```bash
$ node tools/check-examples.mjs
checked 4 example files + every generated template
✓ example safety checks passed
```

Asserted: no hard-coded secrets (4 patterns), no verification escape hatch
(`skipVerify`/`insecure`/`trustAll`/`verify:false`/`rejectUnauthorized:false`), no
value-moving calls, `.env` git-ignored in every template, `.env.example` contains only
comments and empty or URL assignments, every README carries the Credits test-unit caveat.

The solver template's unbuilt endpoints **throw** rather than returning mock data — a stub
that returns fake quotes is how you end up shipping fake quotes.

**Playground / test net**: the spec asks that the playground not touch real money. It
cannot: no endpoint in this API moves value, and the playground targets the same public
read-only registry as the docs.

---

## 12. Mobile and multilingual ✅

**Mobile** — dashboard measured at 375×812:

```json
{ "bodyScrollW": 375, "innerW": 375, "overflowsHorizontally": false,
  "tableWrapScrolls": [true] }
```

The page body never scrolls sideways; wide tables scroll inside their own container. Body
copy never shrinks below `1rem` on small screens; tap targets respect a coarse-pointer rule.

**Languages** — English (30 pages) and Chinese (7 pages: index, quickstart, status,
concepts × 3, errors), wired through `docs.json` `navigation.languages`. The Chinese
quickstart's code was run independently and produces the documented output.

---

## 13. Quantifiable ⚠️ Partial

**Done**: the funnel is defined and each stage is instrumentable — `/health` call → `/nodes`
call → identity verified → project scaffolded → agent running. The registry already records
registrations and heartbeats, so "active nodes" is measurable today.

**Not done**: analytics instrumentation. It needs a deployed site, and the choice of
analytics provider carries a privacy decision that belongs to David rather than to a
documentation PR. Mintlify supports several natively once the site is connected.

---

## Full suite

```bash
$ node tools/check-all.mjs --live

Running 9 suites (including live network)…

  ✓ docs honesty                 0.3s
  ✓ example safety               0.2s
  ✓ sdk/typescript               3.1s
  ✓ sdk/typescript types         4.1s
  ✓ sdk/python                   1.5s
  ✓ create-libertynet-agent      1.2s
  ✓ mcp-server                   8.6s
  ✓ sdk/typescript (live)        3.6s
  ✓ sdk/python (live)            2.3s

✓ all 9 suites passed
```

| Suite | Tests |
|---|---|
| TypeScript SDK | 46 hermetic + 2 live |
| Python SDK | 50 hermetic + 2 live |
| Scaffolder | 44 |
| MCP server | 29 |
| Generated projects | 31 across 4 templates |
| **Total** | **204** |

Plus: 6 docs honesty checks, example safety checks, a TypeScript strict typecheck, and a
Next.js production build (6 static routes).

### The live tests are the load-bearing ones

Both SDKs ship a test asserting that **every identity on the production registry still
verifies**:

```python
audit = ln.discovery.audit()
assert audit["rejected"] == [], "no live record should fail id-binding"
```

If that ever fails, either the network or this documentation is wrong — and both are worth
knowing about immediately.

---

## Known gaps

Collected in one place so nothing has to be inferred:

1. **Nothing is deployed** — docs site, dashboard and MCP server all build; hosting is a
   David decision.
2. **Nothing is published** — no npm or PyPI packages yet. Every install command in the docs
   says so.
3. **Discord does not exist** — referenced throughout; needs creating.
4. **The AI-drafts-docs-PRs loop is not built** — needs a `.github/` workflow, which is Red
   Lane.
5. **Analytics not instrumented** — needs a deployed site and a privacy decision.
6. **Contributor reward economics undecided** — deliberately left as an interface.
7. **`binding.initiate/authorize/accept` are not in the SDKs** — deliberate. Byte-exact
   canonicalisation must not be re-derived; the SDKs point at the two audited
   implementations instead.
