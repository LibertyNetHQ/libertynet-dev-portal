# Examples

Small, complete programs. Every one runs against the **live network** with **zero
dependencies** — `node example.mjs` or `python3 example.py`, nothing to install.

| Example | What it demonstrates | Runs today |
|---|---|---|
| [`verify-network/`](verify-network) | Verify every identity on the network yourself, in ~40 lines | Yes |
| [`capability-monitor/`](capability-monitor) | Watch for a capability appearing or disappearing | Yes |
| [`identity-gate/`](identity-gate) | Reject forged identities at an HTTP boundary | Yes |

## Rules every example here follows

These are checked by `dev-portal/tools/check-examples.mjs`, not left to good intentions:

- **No hard-coded secrets.** Anything sensitive comes from the environment. An example that
  ships a literal key teaches every reader that literal keys are normal.
- **Nothing touches value.** LibertyNet has no wallet, transfer, swap or trading, so no
  example can demonstrate one.
- **Identity verification is always present and never optional.** A beginner's first
  LibertyNet program should verify by default, so that verifying feels ordinary rather than
  advanced.
- **Unbuilt capabilities are never faked.** If something is not built, an example says so
  rather than mocking it convincingly.
- **Real output.** Every `# →` comment in these files was produced by running the code, not
  written from memory.

## Run them

```bash
node examples/verify-network/verify.mjs
python3 examples/verify-network/verify.py
node examples/capability-monitor/monitor.mjs inference
node examples/identity-gate/server.mjs
```

## Want to add one?

Contributions welcome — see [contributing](https://docs.libertynet.ai/contributing). The
bar is: it must run, it must be honest, and it must teach one thing well.
