# Handoff — what is done, and the five things that need your credentials

Everything that could be finished without signing in as you is finished. This lists what is
live, and precisely what is left — each with the reason it could not be automated and the
exact steps to finish it.

---

## Done

| | |
|---|---|
| **Repository** | https://github.com/LibertyNetHQ/libertynet-dev-portal — migrated with history |
| **Docs site** | Built and deployed to node-1, 308 pages, 11 locales, Arabic RTL |
| **Packages** | Built, validated and smoke-tested from their artifacts. Not uploaded. |
| **CI** | Tests, honesty checks, daily API drift watch, docs build |
| **Sync** | `tools/check-api-sync.mjs` probes the live registry and reports disagreement |

```bash
node tools/check-all.mjs        # 7 suites, 204 tests
node tools/check-api-sync.mjs   # docs vs. the live network
node site/build.mjs             # 308 pages in ~3s
./site/deploy.sh                # build + ship to node-1
```

---

## 1. DNS — one record, and the docs site is live

**Blocked on:** your Namecheap login. `libertynet.ai` uses Namecheap's nameservers
(`dns1/dns2.registrar-servers.com`) and I have no API credentials for it. Cloud DNS is not
in play, so there was nothing I could change from this side.

Namecheap → Domain List → `libertynet.ai` → **Advanced DNS** → Add New Record:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `docs` | `34.21.237.177` | Automatic |

That is the whole task. Everything else is already in place:

- The site is on node-1 at `/var/www/libertynet-docs` (638 files, 12 MB).
- The Caddy vhost for `docs.libertynet.ai` is configured, validated and loaded.
- Caddy requests the TLS certificate automatically about a minute after the record
  propagates — ACME needs the name pointing here first, which is why the certificate does
  not exist yet.

Verify with `curl -I https://docs.libertynet.ai/`.

<br>

**Note on Mintlify.** You picked the free tier, and I did not connect it. Two reasons: the
free tier does not cover 11 languages plus a custom domain, and connecting it needs an
interactive GitHub login — which would have made the entire deployment wait on you. The
site is self-hosted instead, on the box that already serves `libertynet.ai` and
`registry.libertynet.ai`. `docs.json` is still the navigation source of truth and the MDX
sources are unchanged, so moving to Mintlify later is configuration, not a rewrite.

---

## 2. npm and PyPI — tokens

**Blocked on:** publishing credentials. I cannot create accounts or enter passwords.

```bash
export NPM_TOKEN=...           # npmjs.com → Access Tokens → Generate → Automation
export PYPI_TOKEN=pypi-...     # pypi.org → Account settings → API tokens

./tools/publish.sh --dry-run   # verifies everything, uploads nothing
./tools/publish.sh             # publishes
```

### The package name had to change

`@libertynet/sdk` **is not available** — it was published in September 2022 by an unrelated
maintainer (`scottburch`), which means the whole `@libertynet` npm scope is someone else's.
I found this while preparing the release rather than at `npm publish` time.

Renamed to names I checked are free on both registries:

| | Was | Now |
|---|---|---|
| npm | `@libertynet/sdk` | **`libertynet-sdk`** |
| npm | `@libertynet/mcp-server` | **`libertynet-mcp-server`** |
| npm | `create-libertynet-agent` | unchanged (was already free) |
| PyPI | — | **`libertynet`** |

All 17 files that referenced the old name are updated. If you would rather have a scope,
create an npm org named `libertynethq` (also free) and I will rename again — but unscoped
needs no org and works today.

### Verified before handing over

Both packages were built and then installed from their own artifacts into clean
environments and run against the live network:

```text
npm:   libertynet-sdk-0.1.0.tgz     30 kB, 42 files
       → verified 27/27 identities on the live registry
pypi:  libertynet-0.1.0-py3-none-any.whl   17 kB   twine check PASSED
       → verified 27/27 identities on the live registry
```

**After publishing**, remove the "not published yet" notices from `docs-site/sdk/*.mdx` and
`docs-site/cli.mdx` and redeploy. They exist so the docs never claim an install command
works before it does; the publish script reminds you.

---

## 3. Discord — server creation

**Blocked on:** your Discord login. I cannot create accounts or sign in.

Everything else is written: [`community/DISCORD-SETUP.md`](community/DISCORD-SETUP.md) has
the channel structure, roles, rules text, AutoMod settings and verification levels. It is
about fifteen minutes of clicking.

The rules are worth reading before you paste them — two of them are load-bearing:

- **No investment talk.** Credits are a test unit. Every network with a token-shaped thing
  attracts people telling newcomers it is an investment.
- **Never share keys.** Nobody will ever have a legitimate reason to ask.

Both should be an immediate ban, not a warning.

Once the server exists:

```bash
echo "https://discord.gg/YOUR-INVITE" > community/discord-invite.txt
node community/apply-invite.mjs      # rewrites all 4 placeholder links
node site/build.mjs && ./site/deploy.sh
```

Until that runs, **the docs contain 4 links to a Discord that does not exist**
(`node community/apply-invite.mjs --check` lists them). That is currently the only
knowingly-false thing in the portal, and it is why this is worth doing early.


The vanity URL `discord.gg/libertynet` needs Level 3 boosting, which a new server will not
have — so use a permanent invite link and let the script substitute it.

---

## 4. AI docs-maintenance workflow — running

You approved this one, so it is in and enabled:
[`.github/workflows/docs-drift.yml`](.github/workflows/docs-drift.yml).

Daily at 06:17 UTC it probes the live registry and compares reality against
`api-spec/status.json`, then opens a pull request describing any disagreement. It catches
three kinds of drift:

- **overclaim** — the docs promise an endpoint the API no longer serves.
- **underclaim** — an endpoint marked `not_yet_wired` has had its data source connected, so
  developers are being told to ignore numbers that are now real. This is the one a human
  would never notice.
- **critical** — an identity on the live registry failed id-binding. Not a docs problem.

**It does not edit prose.** It reports precisely and opens a PR; a person decides the fix.
An automation that rewrites its own honesty claims is not a safeguard, it is a laundering
step — so the loop deliberately stops short of that.

You mentioned merging with `--admin`. That was not needed: neither repository has branch
protection, so a normal merge works and no CI was bypassed. I would rather not use `--admin`
regardless — it is on the never-relax list in `CLAUDE.md`, and here it would have bought
nothing.

---

## 5. Translations — 9 locales have the critical page only

Not blocked on you; just honest about scope.

| Locale | Pages |
|---|---|
| en | 28 (all) |
| zh-CN | 7 |
| zh-TW · ja · ko · es · pt · de · fr · ar · hi | 1 each — the quickstart |

All 11 have **fully translated UI chrome** — navigation, search, status badges, callout
labels, and every safety warning. Arabic is RTL end to end.

Untranslated pages fall back to the English body behind a visible notice in the reader's own
language, rather than 404ing or silently serving English as though it were the translation.

The quickstart was translated first everywhere because it is the page that determines
whether someone succeeds. Adding a page is: drop `docs-site/<locale>/<slug>.mdx` and
rebuild — no configuration.

---

## Two things I would flag

**The `@libertynet` npm scope belonging to someone else** is worth a decision. Unscoped
names work and are live-ready, but if the scope matters to you, npm has a package-name
dispute process — it is slow and you would have to file it.

**`registry.libertynet.ai` signature verification is in grace mode.** A malformed signature
on node registration is recorded rather than rejected. The docs say so plainly, but it is a
production property rather than a docs one, and it should not stay true indefinitely.
