# libertynet

Python SDK for [LibertyNet](https://docs.libertynet.ai) — discovery, self-certifying
identity, operator login and node binding.

```bash
pip install libertynet
pip install 'libertynet[signing]'   # adds Ed25519 signing
```

```python
from libertynet import LibertyNet

ln = LibertyNet()
for node in ln.discovery.online():   # verified, fresh nodes only
    print(node.did, node.region)
```

**The core has no third-party dependencies** — only `hashlib` and `urllib`. Checking who is
on a public network should not require installing anything. Only signing pulls in
`cryptography`, and only when you call it.

## Two guarantees

**Identity verification is not optional.** Every node record has had its DID checked
against its public key, with no flag to disable it.

**Unbuilt things raise.** Anything not wired raises a typed `NotYetWiredError` naming its
real status — never a plausible zero.

```python
ln.operator.settled_credits()
# → NotYetWiredError: the endpoint is live but no credits ledger is connected,
#   so the returned 0 is a placeholder rather than a balance.
```

Most of LibertyNet's surface is **not built**: no wallet, transfer, swap, staking or
trading, and Credits are a test unit rather than money. See
[capability status](https://docs.libertynet.ai/status).

## Documentation

- [Quickstart](https://docs.libertynet.ai/quickstart)
- [SDK reference](https://docs.libertynet.ai/sdk/python)
- [Error dictionary](https://docs.libertynet.ai/reference/errors)

Apache-2.0
