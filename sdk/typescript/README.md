# libertynet-sdk

TypeScript SDK for [LibertyNet](https://docs.libertynet.ai) — discovery, self-certifying
identity, operator login and node binding.

```bash
npm install libertynet-sdk
```

```ts
import { LibertyNet } from "libertynet-sdk";

const ln = new LibertyNet();
const nodes = await ln.discovery.online();   // verified, fresh nodes only
```

## Two guarantees

**Identity verification is not optional.** Every node record has had its DID checked
against its public key. There is no flag to disable it, and the test suite asserts that no
escape hatch can appear.

**Unbuilt things throw.** Anything not actually wired raises a typed `NotYetWiredError`
naming its real status — never a plausible zero you might render as a measurement.

```ts
await ln.operator.settledCredits();
// → NotYetWiredError: the endpoint is live but no credits ledger is connected,
//   so the returned 0 is a placeholder rather than a balance.
```

Most of LibertyNet's surface is **not built**: there is no wallet, transfer, swap, staking
or trading, and Credits are a test unit rather than money. See
[capability status](https://docs.libertynet.ai/status) before writing code against
anything.

## Documentation

- [Quickstart](https://docs.libertynet.ai/quickstart) — first verified call in ~15 seconds
- [SDK reference](https://docs.libertynet.ai/sdk/typescript)
- [Error dictionary](https://docs.libertynet.ai/reference/errors)

Apache-2.0
