# P6 — real developer validation

Everything needed to run a session is here. **The only missing ingredient is a person**,
and finding one is deliberately not automated: three real strangers beat thirty synthetic
runs, and picking them is a judgement call about who represents your actual audience.

---

## Why now and not sooner

Running this before P1 would have been a waste of somebody's afternoon. Until the demo node
existed, an external tester walked `discover → verify` and then hit a wall — every node on
the network advertised a private address or a laptop hostname. They would have found one
enormous blocker and nothing else.

That wall is gone, so the walkthrough now has an end. This is worth doing.

---

## What is here

| File | What it is |
|---|---|
| [`SCRIPT.md`](SCRIPT.md) | The tester's walkthrough. Seven steps, ~45 min, with targets to check the claims against. |
| [`FRICTION-LOG.md`](FRICTION-LOG.md) | The template they fill in. Three headline questions plus a verdict on each contested design decision. |
| [`RECORDING.md`](RECORDING.md) | Screen recording setup, and what not to capture. |
| [`Dockerfile`](Dockerfile) | A genuinely clean machine. |
| [`timer.mjs`](timer.mjs) | Timing and friction log. Zero dependencies. |

---

## Running one

<Steps>

**1. Pick testers.** Three to five. Aim for a spread:

| | Why |
|---|---|
| Someone who has never touched decentralised identity | Most of the audience |
| Someone fluent in it | Will notice where we are unconventional |
| Someone who works mostly in Python | Both SDKs get exercised |
| Someone who will use an AI assistant throughout | Tests the layer we claim as a differentiator |

**Do not pick someone who has read this repository.** They cannot un-know it, and their
session will quietly skip the steps that trip everyone else.

**2. Send them three things**, and nothing else:

- `SCRIPT.md`
- `FRICTION-LOG.md`
- `p6/` (for the Dockerfile and timer)

Not the repository. Not a walkthrough call. The point is what the *documentation* teaches.

**3. Leave them alone.** Do not sit in. Do not answer questions during the session —
"I asked someone" is itself the finding, and a helpful maintainer in the room destroys the
measurement.

**4. Collect** the recording, `session.json`, and the friction log.

**5. Triage within a week.** File each finding as an issue. A tester who sees nothing change
does not do a second session, and the second session — after fixes — is where you learn
whether you actually fixed it.

</Steps>

---

## The clean machine

```bash
docker build -t libertynet-p6 p6/
docker run --rm -it libertynet-p6
```

Debian, `curl`, Node 22, Python 3, a non-root user. **No LibertyNet code, no credentials,
nothing cached.**

That matters more than it sounds. On a maintainer's laptop the venv is already built, gcloud
is authenticated and the answers are in shell history — every one of those silently removes
a step the stranger hits. The image exists so nothing is skipped by accident.

Alternatives that work as well: a fresh cloud VM, or GitHub Codespaces on an empty repo.

---

## What counts as passing

From `AIPM-002 §6`: **three or more testers independently complete `discover → verify → act`
within the claimed times, with the blocker list at zero.**

Worth being precise about what "passing" means here, because it is easy to mark this green
dishonestly:

| Not passing | Passing |
|---|---|
| Three testers finished, two after asking a maintainer | Three finished from the docs alone |
| Everyone finished but took 4× the claimed time | Times roughly match, or the claims were corrected |
| Nobody hit a blocker because nobody tried step 6 | Step 6 was attempted and the docs held up |
| The friction log is empty | The friction log is full and the issues are filed |

**An empty friction log means the session failed**, not that the portal is perfect.
Something always chafes; a tester reporting nothing usually means they were too polite or
too experienced.

---

## The question this really answers

Everything else in this portal is measured by things I can run. The drift checker proves
the docs match the API. The example runner proves the code works. The golden-question eval
proves the corpus supports honest answers.

None of that proves a stranger can succeed. Only a stranger can.

---

## After a session

```bash
node timer.mjs report --json > session.json
```

File findings as issues on
[libertynet-dev-portal](https://github.com/LibertyNetHQ/libertynet-dev-portal/issues),
labelled `p6`. Record the outcome in `AUDIT-AIPM-002.md` — including if it went badly.
A validation exercise whose bad results are not written down is a marketing exercise.
