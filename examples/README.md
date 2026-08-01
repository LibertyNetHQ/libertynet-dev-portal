# Examples

Ten small, complete programs. Every one runs against the **live network** with **zero
dependencies** — `node x.mjs` or `python3 x.py`, nothing to install.

```bash
node examples/run-all.mjs              # run them all, for real
node examples/run-all.mjs --offline    # only the ones needing no network
node examples/run-all.mjs did-toolkit  # just one
```

The runner **executes** each example and asserts on what it printed. "It compiled" is not
the bar — an example that compiles but no longer works is a broken promise to whoever copies
it, and examples rot silently because nobody re-runs the ones they are not currently reading.

| Example | Teaches | Network |
|---|---|---|
| [`verify-network`](verify-network) | Check the whole network's identity claims with SHA-256 and nothing else | yes |
| [`callable-nodes`](callable-nodes) | A directory of addresses is not a directory of *reachable* addresses | yes |
| [`full-loop`](full-loop) | discover → verify → act, end to end, from any machine | yes |
| [`challenge-response`](challenge-response) | Identity ≠ authentication. Why a replayed signature is worthless | yes |
| [`did-toolkit`](did-toolkit) | Every question about an identity is arithmetic you can do offline | **no** |
| [`health-check`](health-check) | Exit codes a monitoring agent can act on | yes |
| [`registry-watch`](registry-watch) | The registry has no history — change detection is yours to build | yes |
| [`identity-gate`](identity-gate) | Where id-binding stops being enough, and what comes next | **no** |
| [`capability-monitor`](capability-monitor) | "Can anyone do X right now?" beats "how many nodes exist?" | yes |
| [`mcp-client`](mcp-client) | The AI layer is ordinary software you can script and test | yes |
| [`describe-to-agent`](describe-to-agent) | A generator grounded in the matrix builds what exists and refuses what does not | yes |

## The assertions worth having

Several checks assert **failure**, and those are the ones that matter:

```text
did-toolkit         a crossed DID/key pair MUST exit 1
identity-gate       a forged identity MUST get 401
challenge-response  a replayed signature MUST NOT verify
capability-monitor  an unavailable capability MUST exit non-zero
describe-to-agent   a description asking for a wallet MUST scaffold nothing
```

A suite that only checked happy paths would let identity verification break without anyone
noticing. Sabotaging `did-toolkit`'s comparison was tried during development; the runner
caught it immediately.

## Rules every example obeys

Enforced by `tools/check-examples.mjs`, not by good intentions:

| Rule | Why |
|---|---|
| No hard-coded secrets | An example that ships a literal key teaches every reader that literal keys are normal. |
| Nothing touches value | LibertyNet has no wallet, transfer, swap or trading, so no example can demonstrate one. |
| Identity is always verified | Including `registry-watch`, which would otherwise report a forged record as a legitimate join. |
| Unbuilt capabilities are never faked | An exception cannot be mistaken for a result; convincing mock data can. |
| Outputs are real | Every `→` comment was produced by running the code. |

## The honest numbers

`callable-nodes` will tell you something like:

```text
registered           28
publicly reachable   11
carries a signature   5
CALLABLE              1
```

One is a small number. It is also the true one, and every example here is built to show you
the true one rather than the impressive one.

## Adding an example

The bar: **it must run, it must be honest, and it must teach one thing well.**

1. Write it in `examples/your-example/`.
2. Add an entry to [`manifest.json`](manifest.json) — the command, and what its output must
   contain.
3. `node examples/run-all.mjs your-example`
4. `node tools/check-examples.mjs`

See [contributing](https://docs.libertynet.ai/contributing).
