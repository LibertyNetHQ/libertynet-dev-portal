# GO / NO-GO — LibertyNet developer portal

Against **LIBERTYNET-DEV-PORTAL-UPGRADE-AIPM-002 §6**, measured 2026-08-01.

Every row below was run, not recalled. Where something is not done it says so.

---

## Verdict

**GO for public launch — with one criterion unmet and unmeetable by me.**

Five of the six §6 criteria pass on measurement. The sixth — three or more real
developers independently completing the loop — cannot be self-certified: a portal
that graded its own usability would be the exact failure this project exists to
avoid. Everything that step needs is built and waiting (§ *Ready for David*).

The portal is a product an outsider can use today: they can discover the network,
verify an identity with arithmetic they perform themselves, call a node and check
its signature — on a machine with nothing installed, following only published
pages. That loop is closed and was executed inside a clean container as evidence
for this report.

---

## §6 criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | External clean machine completes `discover → verify → act`, real signature verification | ✅ **PASS** | `docker run --rm libertynet-p6` — nothing LibertyNet installed. Fetched `/quickstart.md` (12,570 b), `/health` → 28 nodes, `?callable=1` → 1 node, id-binding recomputed to `dbe63a0c`, called `https://libertynet.ai/demo-node` with a self-chosen nonce `7dbe435d7b47dcd6`, **Ed25519 signature verified**. |
| 2 | AI answer eval green and in CI | ✅ **PASS** | 16 golden questions (9 adversarial), 70 assertions, all pass. Wired into `.github/workflows/ci.yml`. |
| 3 | 8–10 examples green in CI | ✅ **PASS** | **11 examples**, 20 checks, live: all green. Four assert *failure* (a crossed DID must exit 1; a forged identity must get 401; a replayed signature must not verify; a wallet request must scaffold nothing). |
| 4 | Change one status → the whole site follows; inconsistency fails the build | ✅ **PASS** | Flipped `GET /nodes` to `planned`. CI reported **6 stale artifacts**; one command regenerated all six; the docs badge, both SDKs, the OpenAPI `x-ln-status`, the API reference page, the scaffolder's vendored matrix and `ai-context.txt` (23 → 22 callable) all followed. The prose-count check caught the now-wrong sentence "23 endpoints you can call today". The live check then flagged the **under-claim** — `claimed: planned, observed: HTTP 200`. Restored. |
| 5 | Honesty badges 100% consistent with live behaviour | ✅ **PASS** | `audit-implemented`: **36 verified, 0 false**; 80 `implemented` badges, **0 without a verifier**. `check-api-sync`: docs and live API agree. |
| 6 | 3+ real developers independently complete the loop | ⬜ **NOT DONE** | Requires real people. Kit is ready; see below. |

---

## What changed this round

**C2 — MCP one-click install.** The server worked; nobody could install it, because
the docs said "clone the repository and paste an absolute path" against a path that
stopped existing when the portal moved repos. Now one `curl` gets a single
self-contained file. Acceptance runs it from an empty temp directory — copying
matters, since in place a bundle still secretly reading `docs-site/` would pass —
and parses the JSON configs printed on the page to launch the server the way Claude
Desktop and Cursor launch it. **19/19**, all six tools called, `claude mcp list`
reports ✔ Connected.

The bundled docs are a snapshot; the capability matrix deliberately is not. It is
fetched live on first use and labelled `matrix_source` when it falls back.

**C4 — plain English to a running agent.** `--describe "watch inference nodes and
tell me when one drops off"` produces a runnable project. No model behind it: the
scaffolder is zero-dependency and must work offline, and choosing between four
agent types does not need an LLM. What it does need is to be right about what
exists, and that is checked against `status.json`. The refusal is the feature —
"an agent that pays other nodes from my wallet" writes nothing and exits 1.

**Bring-your-own-AI.** 253 of 319 markdown twins were leaking raw JSX; now 0.
`llms.txt` listed the home page as `https://docs.libertynet.ai/.md`, which is not a
URL. New `/ai-context.txt` (~4 KB) is the paste-ready primer the docs kept
describing without providing, generated from the matrix so it cannot drift.

**The implemented audit.** Two false `implemented` claims had already shipped here.
The audit now requires every claim to *have a verifier* — a badge on something
nobody wired a check to fails. Both halves were negative-tested rather than assumed.

**Dead links.** Every `github.com/LibertyNetHQ/LibertyNet-hq` link on the site was a
404 for anyone not signed in; the repository is private and the portal moved out of
it. `/api-reference` was a 404 linked from the home page, the changelog and the
footer — the link checker excused it via a whitelist entry for a renderer no longer
in use. Both classes fixed; external links are now fetched with **no credentials**,
because checking as ourselves proves nothing.

**Translations.** All ten quickstart translations were missing the step that proves
the loop closes. Written in all ten languages and verified by running the Japanese
page's snippet against the live network. The builder now distinguishes
*untranslated*, *translated* and *behind* — three pages now say they are behind,
which is three more than were telling the truth before.

---

## Not done, and why

| Item | Status | Blocked on |
|---|---|---|
| 3+ real developer validation | Not done | Real people. Kit ready: `p6/` has the clean-machine Dockerfile (verified working for this report), timing harness, session script, friction-log template and recording guide. |
| Hosted "Ask AI" | `planned`, stated as such on the page | A server-side LLM key. The page carries a `<Warning>` admitting an earlier version of it claimed a ⌘K assistant that never existed. |
| npm / PyPI publishing | Not done — explicitly out of scope this round | David. `@libertynet` on npm belongs to someone else; packages renamed to `libertynet-sdk` / `libertynet` / `libertynet-mcp-server`. |
| Registry strict mode | Not done | David. Registration signature checking is in grace mode; the docs say so. |
| Discord | `planned`, 4 links annotated, not deleted | David registering the server. |
| zh-CN page parity | 7 pages abridged (0.3–0.4 of the English body) | Translation work. Spot-checked that they retain the load-bearing safety content — credits disclaimer, signature ≠ identity, `not_yet_wired`. |
| OpenAPI `DeviceCredential` schema | Defect found, not fixed here | The schema omits `device_id` and `revocation_id`, both of which the registry includes in the signed canonical bytes — following the spec exactly produces a credential that cannot verify. The spec is upstream in the private repo. |

---

## Ready for David

1. **Run the real-developer validation.** `docker build -t libertynet-p6 p6/` then
   `docker run --rm -it libertynet-p6`. Script, timer and friction log are in `p6/`.
2. **Register the Discord server**, then replace the 4 annotated links.
3. **Decide on npm/PyPI publishing** and supply tokens if yes.
4. **Decide on registry strict mode.**
5. **Fix the `DeviceCredential` schema** in the private repo, or authorise me to.

---

## How to re-verify any of this

```bash
node tools/check-all.mjs                    # 18 suites, hermetic
node tools/check-all.mjs --live             # + the live network
node tools/audit-implemented.mjs            # every implemented claim, measured
node tools/check-external-links.mjs         # links as a stranger sees them
docker build -t libertynet-p6 p6/ && docker run --rm -it libertynet-p6
```

Nothing in this document is asserted from memory. If a number here disagrees with a
command above, the command is right and this file is a bug.
