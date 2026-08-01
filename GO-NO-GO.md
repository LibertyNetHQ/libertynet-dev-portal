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
| 3 | 8–10 examples green in CI | ✅ **PASS** | **12 examples**, 21 checks, live: all green. Five assert *failure* (a crossed DID must exit 1; a forged identity must get 401; a replayed signature must not verify; a wallet request must scaffold nothing; a credential missing a signed field must be rejected). |
| 4 | Change one status → the whole site follows; inconsistency fails the build | ✅ **PASS** | Flipped `GET /nodes` to `planned`. CI reported **6 stale artifacts**; one command regenerated all six; the docs badge, both SDKs, the OpenAPI `x-ln-status`, the API reference page, the scaffolder's vendored matrix and `ai-context.txt` (23 → 22 callable) all followed. The prose-count check caught the now-wrong sentence "23 endpoints you can call today". The live check then flagged the **under-claim** — `claimed: planned, observed: HTTP 200`. Restored. |
| 5 | Honesty badges 100% consistent with live behaviour | ✅ **PASS** | `audit-implemented`: **38 verified, 0 false**; **104** `implemented` badges, **0 without a verifier**. `check-api-sync`: docs and live API agree. |
| 6 | 3+ real developers independently complete the loop | ⬜ **NOT DONE** | Requires real people. Kit is ready; see below. |

---

## Round 3 — hardening after the GO

Six items, all measured. The state check first: the baseline (audit, anonymous
link check, 20 suites) was already green, so nothing was redone.

| # | Item | Result |
|---|---|---|
| 1 | DeviceCredential schema | ✅ The published schema listed **7 fields where the registry signs 9**. Proved by dropping one field at a time against the live registry: excluding `device_id`, `revocation_id` or `permissions` from the signed bytes each returns `401 DC_BAD_SIGNATURE`. The canonical layout was documented **nowhere**, which is why neither SDK could issue a credential. Fixed in OpenAPI (`x-ln-canonical`), both SDKs (`issueDeviceCredential` / `issue_device_credential` + validators), the login guide, and `examples/device-credential`. |
| 2 | Anonymous link rule | ✅ Now a **required CI job** rather than an advisory one — a rule that cannot fail a PR is a preference. Scope widened 49 → 178 files. Found and fixed a wrong sitemap XML namespace (`sitemap.org` vs `sitemaps.org` — the document was not a sitemap to any crawler) and a private-repo link in the audit doc. |
| 3 | zh-CN pages | ✅ The capability page listed **11 of 22 endpoints**; the error dictionary was missing **6 codes** including all three DeviceCredential ones; the quickstart had **no TypeScript at all** and was missing the private-key warning. All restored. No translated page in any of the ten locales is structurally behind English now. |
| 4 | `install.sh` fail-closed | ✅ The fix was already live — but **only on the server**. The repository still had the fail-open branch, so the next deploy from source would have reinstated it. Synced, plus 16 behaviour assertions covering four ways to break the checksum file. |
| 5 | Keyless signing | ✅ Already built and already run — every artifact including `SHA256SUMS` carries a Sigstore bundle. Verified independently as a stranger. What was missing was any mention on the portal; `/download` now carries the command, the OIDC identity to pin, and what the signature does not prove. |
| 6 | Clean-machine chain | ✅ download → cosign verify → discover → verify → act, in a container with nothing installed. `Verified OK`, id-binding `dbe63a0c`, self-chosen nonce, signature verifies. |

### Three findings worth naming

**A fix that only reached the server.** The installer's fail-closed check was
live and correct; the repository was still fail-open. Nothing compared them, so
the divergence was invisible. There is now an assertion that live and repo are
byte-identical — the divergence is the vulnerability, not just its symptom.

**A schema nobody could have followed.** Every credential in this repository was
written by hand against the registry's own source, which a reader cannot see. No
code here had ever built one from the published documentation, so the
documentation was free to be wrong, and was. The check now builds a credential
strictly from `x-ln-canonical` and requires the live registry to accept it.

**A registry-side bug, reported not fixed.** Omitting `device_id`,
`revocation_id`, `credential_id` or `expires_at` from a login request returns
**502**, not a validation error — an unhandled exception on an unauthenticated
endpoint. The registry is in the private repo, so this goes to David. The docs
and both SDKs now warn and validate client-side first.

## What changed in round 2

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
| OpenAPI `DeviceCredential` schema | **Fixed this round.** All nine signed fields are now required and `x-ln-canonical` publishes the signing order; a credential built strictly from the published schema is accepted by the live registry on every CI run. | — |
| Registry returns 502 on a malformed credential | Found, **not** fixed | An unhandled exception on an unauthenticated endpoint. The registry lives in the private repo — David. Client-side validation added in both SDKs meanwhile. |
| `ln-node` release line unsigned | Stated plainly on `/download` | cosign can only sign from a public repo; that build repo is private. SHA256 fail-closed today. |

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
