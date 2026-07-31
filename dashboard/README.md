# Developer Dashboard

The developer-facing view of your operator account and the live network, in Living Language.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # static export to out/
npm test
```

## A note on "API key management"

The AIPM specification for this portal asks for **API key management** — issue, revoke,
show usage, store hashed at rest, never log.

**LibertyNet has no API keys.** Discovery is public and needs no credential at all;
operator access is a signature-based challenge–response that yields a 1-hour session token.
There is no key to issue, nothing to store, and nothing to rotate.

Building a key-management UI anyway would have meant inventing a concept the network does
not have, and teaching developers to look for a key that does not exist. So this dashboard
does not have one. What the security requirement was protecting against is instead handled
structurally:

| Requirement | How it is met here |
|---|---|
| API keys never reach the frontend | There are no API keys. |
| API keys never reach logs | There are no API keys. |
| Keys encrypted at rest | Nothing is stored at rest. The session token lives in memory only — not in `localStorage`, not in a cookie, not in `sessionStorage`. |
| Login resistant to credential stuffing | There is no password to stuff. Authentication is an Ed25519 signature over a single-use, 300-second challenge. |
| Rate limiting | Applied client-side to signing attempts; the registry rate-limits and expires challenges server-side. |

The private key is used in the browser to sign one challenge and is **zeroed immediately
afterwards**. It is never transmitted, never persisted, and never written to a log.

If a future version of LibertyNet introduces API keys, this page gets a key manager and a
security review at the same time — not before.

## What it shows

| Page | Data | Status |
|---|---|---|
| **Network** | Live nodes, every identity verified client-side | Real, public, no login |
| **Nodes** | Your bound nodes with computed `online` | Real, needs a session |
| **Credits** | Balance envelope with its `source` field | Live endpoint, **no ledger behind it** |
| **Login** | Signature-based operator login | Real |

The Credits page renders the caveat, never a bare `0`. A zero from a `not_yet_wired` source
means "nothing is counting", not "you earned nothing", and the UI says which.

## Relationship to `operator-console/`

Different jobs, deliberately not merged:

- **`operator-console/`** is the end-user product for node operators: identity creation,
  mnemonic recovery, device binding, multi-account vaults. It manages keys.
- **`dev-portal/dashboard/`** (this) is the developer view: what my account looks like
  through the public API, what the network looks like, and what is actually wired. It
  manages nothing.

If you need to bind a node, use the Console. This dashboard deliberately does not implement
binding — the signing involved
[should not be reimplemented](https://docs.libertynet.ai/sdk/overview#what-the-sdks-deliberately-do-not-do).

## Deployment

**Not deployed.** It builds to a static export (`out/`) with no server component, so it can
be hosted anywhere — but choosing a host, a domain and a TLS setup is a call for David to
make, not something to do silently as part of a docs PR.

Nothing here needs a secret to run: every call is either public or authenticated by a token
the user's own browser obtained.
