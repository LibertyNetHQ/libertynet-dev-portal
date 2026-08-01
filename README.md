# LibertyNet Developer Portal

Documentation, SDKs, scaffolder, MCP server and dashboard for building on LibertyNet.

Spec: `LIBERTYNET-DEV-PORTAL-AIPM-001 v1.0-FINAL`.

```bash
node tools/check-all.mjs          # every suite, hermetic
node tools/check-all.mjs --live   # + tests against the live registry
```

## What is here

| Directory | What it is |
|---|---|
| `api-spec/status.json` | **The capability matrix.** Every status badge in the docs, both SDKs and the OpenAPI spec derive from this one file. |
| `api-spec/libertynet-v1.yaml` | OpenAPI 3.1 — 19 operations, each carrying `x-ln-status`, each probed against production. |
| `docs-site/` | Mintlify site: 35 pages, English + Chinese, Living Language skin. |
| `sdk/typescript/` | `libertynet-sdk` — 48 tests. |
| `sdk/python/` | `libertynet` — 52 tests, dependency-free core. |
| `create-libertynet-agent/` | CLI scaffolder — 4 templates, 44 tests, zero-dependency output. |
| `mcp-server/` | MCP server for AI assistants — 6 tools, 29 tests, zero dependencies. |
| `dashboard/` | Developer dashboard (Next.js, static export). |
| `examples/` | Runnable examples, verified against the live network. |
| `tools/` | Drift and honesty checkers. |

## The organising principle

Everything here is built around one rule: **never describe something as more finished than
it is.**

Most of LibertyNet's intended surface is not built. A wallet endpoint sounds like it should
work; it does not exist. The credits endpoint returns `200` with a body that looks exactly
like a balance, and every number in it is a placeholder zero. A portal that glossed over
that would produce developers writing confident code against nothing.

So the honesty is structural rather than editorial:

<table>
<tr><th>Layer</th><th>How it enforces the rule</th></tr>
<tr><td><b>One source of truth</b></td><td><code>api-spec/status.json</code> holds every capability's real status. Docs, SDKs and the OpenAPI spec all derive from it.</td></tr>
<tr><td><b>A drift checker</b></td><td><code>tools/check-docs-drift.mjs</code> fails the build if any page, spec or badge disagrees with the matrix — <i>and</i> recomputes every cryptographic value printed in the docs.</td></tr>
<tr><td><b>SDKs that refuse</b></td><td><code>settledCredits()</code> raises rather than return a <code>not_yet_wired</code> zero. <code>wallet.transfer()</code> raises with its real status. There is no flag to disable identity verification.</td></tr>
<tr><td><b>Templates that cannot lie</b></td><td>The scaffolder's test suite asserts no template can grow a hard-coded secret, a value-moving call, or a verification escape hatch.</td></tr>
<tr><td><b>An MCP server that lets AI check</b></td><td><code>libertynet_capability_status</code> means an assistant can find out what exists before generating code against it.</td></tr>
</table>

## Quick tour

<table>
<tr><td>

**Your first call — nothing installed**

```bash
curl -s https://registry.libertynet.ai/health
# {"status":"ok","service":"libertynet-registry-standalone","count":27}
```

</td></tr>
<tr><td>

**Verify the whole network yourself**

```bash
node examples/verify-network/verify.mjs
# 27/27 identities verified
# 2 seen in the last 10 minutes
```

</td></tr>
<tr><td>

**Scaffold a runnable agent**

```bash
node create-libertynet-agent/index.mjs watcher --type monitor -y
cd watcher && npm start     # no npm install needed
```

</td></tr>
</table>

## Development

```bash
# SDKs
cd sdk/typescript && npm install && npm test && npm run typecheck
cd sdk/python && python3 -m pytest -q

# Tooling
cd create-libertynet-agent && npm test
cd mcp-server && npm test

# Dashboard
cd dashboard && npm install && npm run build

# Docs preview
cd docs-site && npx mint dev

# Honesty checks
node tools/check-docs-drift.mjs
node tools/check-examples.mjs
```

## Live

- **The documentation site is live at [docs.libertynet.ai](https://docs.libertynet.ai)**,
  self-hosted behind the same Caddy that already serves `libertynet.ai` and
  `registry.libertynet.ai`. `./site/deploy.sh` builds, ships and then **verifies against
  the real public URL with a real browser** — if the interactive checks fail it rolls back
  to the previous release rather than leaving a broken build up. A scheduled probe repeats
  those checks against production every 15 minutes and opens an issue when they fail.
- **The MCP server is one file**: `curl -fsSL https://docs.libertynet.ai/mcp/libertynet-mcp.mjs`,
  no clone and no npm. See [/ai/mcp](https://docs.libertynet.ai/ai/mcp).
- **Release artifacts are cosign-signed** (keyless, Sigstore + GitHub OIDC). What that
  proves and what it does not is set out at [/download](https://docs.libertynet.ai/download).

## Not yet done

Stated here rather than left for someone to discover:

- **Nothing is published to a package registry.** `libertynet-sdk`, `libertynet` and
  `create-libertynet-agent` are not on npm or PyPI. Every page that shows an install
  command says so, and the MCP server is distributed as a single downloadable file
  instead.
- **Discord does not exist yet.** `discord.gg/libertynet` is referenced throughout and needs
  to be created.
- **Contributor rewards are an interface, not a policy.** No rates, amounts or eligibility
  rules — because none have been decided, and inventing one to make a page look complete is
  exactly what this portal refuses to do.

See `TEST-EVIDENCE.md` for what was verified and how.

## Relationship to the rest of the repository

- **`operator-console/`** — the end-user product for node operators. Manages keys, mnemonics
  and binding. Different job; deliberately not merged with `dashboard/`.
- **`libertynet-oracle/`** — the Solidity oracle. Tests pass; not deployed. Documented as
  `testing`, never as live.
- **`code/portal-daemon/deploy/gce/`** — the registry this portal documents. The canonical
  byte builders there are the authority; the SDKs mirror them and deliberately do not
  reimplement the signing paths.
