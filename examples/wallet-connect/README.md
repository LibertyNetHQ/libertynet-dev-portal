# Be authorized by a LibertyNet wallet

A wallet holder approves your application in their own wallet. You get back a short-lived document
the wallet signed, which anyone can verify offline, and which is **useless to anyone who steals it**.

```bash
LN_WALLET_URL=http://127.0.0.1:3210 \
LN_CONNECT_OPERATOR_PASSPHRASE=... \
node --experimental-strip-types connect.mjs
```

Set `LN_GATEWAY_URL` as well and it also presents the grant to a coordination gateway, with the
control that makes that meaningful: the same signed request, sent twice, once without the grant.

## What it teaches

**Nobody hands out client ids.** Your application's identity is `did:svrp:s:<id>`, derived from a key
you generate. The authority to receive a grant at a URL comes from that URL's own origin serving a
signed manifest at `/.well-known/libertynet-app.json`. Impersonating an application therefore needs
both its private key *and* its domain — which is what replaces OAuth's registration step.

**A grant is not a bearer token.** It names the public key that must have signed the request
presenting it. §5 shows this directly: the same valid grant, offered by a different key, is refused.
That is why a grant can travel in a URL fragment and be written to a log without either being a
credential leak.

**Pin the issuer or the check is hollow.** The signature only proves the document was signed by
whoever `issuer_did` names, and a DID is free to mint. §5 verifies a perfectly good grant against a
different expected issuer and shows it refused.

**Scope is enforced, not declared.** §6 asks for a resource that was never granted and gets a
refusal rather than the data.

**A public client cannot be silently re-authorized.** This example is one: its code is published, so
anyone who read it could mint a request indistinguishable from a real one. §7 asserts the refusal
from both sides — the SDK will not build the request, and the wallet refuses one built anyway.

**Value-moving scopes are refused by name.** §8 asks for `payment:transfer`. The answer is "this
exists and is not issued", not "unknown scope" — an unknown-scope error would invite you to conclude
you had the spelling wrong and try a variant.

## Why this example exists at all

LN-CONNECT-001 had exactly one client: the application it was written alongside. A protocol only its
author's application has ever spoken is indistinguishable, on the evidence, from an interface built
for that one application.

This is the second one, and it shares no code with the first. Different repository, different SDK,
different crypto stack — `@noble/ed25519` here, WebCrypto in the wallet and in Compute,
`ed25519-dalek` in the platform gateway. Every byte on the wire had to be agreed by reading the same
document.

It worked without the protocol changing. That is the claim, and this file is how you check it.

## The one shortcut, named

Approving at the consent screen is a human action. This script fills the passphrase and posts the
decision itself, the way an operator would, because an example that stopped for a mouse click could
not run unattended. Everything on either side of that is real: real keys, real signatures, a real
manifest fetched over real HTTP, and balances read from a live chain.
