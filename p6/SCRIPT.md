# P6 — the tester's script

**Read this, then do not read anything else in this repository.** Working from the source
would defeat the point: you are here to find out what the *documentation* teaches, not what
the code does.

Budget about **45 minutes**. Finishing early is a good result. Not finishing is also a
result — arguably the more useful one.

---

## Before you start

**You need a clean machine.** Not your laptop: your laptop already has Node, Python, maybe a
cached credential and definitely the answers in your shell history, and every one of those
quietly removes a step a stranger would hit.

Pick one:

```bash
# Docker — nothing installed but a shell, curl, Node and Python
docker build -t libertynet-p6 p6/
docker run --rm -it libertynet-p6
```

Or a fresh cloud VM, or GitHub Codespaces on an empty repository. Anything where you have
never run LibertyNet code.

Start a screen recording. [Guidance](RECORDING.md) — thirty seconds of setup.

---

## The rules

<br>

**1. Follow the documentation literally.** If it says run a command, run that command. Do not
improve it, do not fix its obvious typo silently, do not use the knowledge you have from
somewhere else.

**2. When you get stuck, log it and keep going.**

```bash
node timer.mjs stuck "no idea what a device credential is or where to get one"
```

Then work it out however you like — search, ask an AI, guess. **Log the fact that you had
to.** That entry is worth more than the time it cost you.

**3. Do not sanitise.** "This is confusing and I hate it" is a better report than "minor
clarity issue". You are the only person who will ever see this with fresh eyes.

**4. If a step is impossible, stop and say so.** Do not go and read the source to unblock
yourself. A step you could not complete from the documentation is the single most valuable
thing you can find.

---

## The walkthrough

Time each step. `start` before, `done` after.

<br>

### Step 0 — first impression (2 min)

```bash
node timer.mjs start "step 0 - first impression"
```

Open **https://docs.libertynet.ai/**. Do not click anything for thirty seconds.

Then answer, out loud into the recording:

- What is LibertyNet, in your own words?
- Could you tell what actually works versus what is planned?
- What would you click first?

```bash
node timer.mjs done "step 0 - first impression"
```

<br>

### Step 1 — the first call (target: under 1 min)

Go to **Quickstart**. Do step 1 exactly as written.

```bash
node timer.mjs start "step 1 - first call"
# ...
node timer.mjs done "step 1 - first call"
```

**Did you know it had worked?** If you were unsure, that is a finding:

```bash
node timer.mjs stuck "got JSON back but could not tell if that was the right answer"
```

<br>

### Step 2 — see the network (target: 2 min)

Quickstart step 2. Then answer:

- How many nodes are there?
- Can you tell which ones you could actually use?
- What does `status: "active"` mean?

That last one has a specific right answer. If you got it wrong, say so — being misled is the
finding, and you will not be the last.

<br>

### Step 3 — verify an identity (target: 5 min) ← the important one

Quickstart step 3. Copy the script, run it.

This is the step the whole portal is built around, so be harsh:

- Did you understand *why* you were doing it, or did you just paste and run?
- Could you explain what id-binding proves, to someone else?
- Did the two DID encodings confuse you?

```bash
node timer.mjs stuck "ran it, got 28/28, no idea what that proved"
```

is an extremely valuable entry. Log it if it is true.

<br>

### Step 4 — call a node (target: 5 min)

Quickstart step 4. You should end up calling a real node and verifying its signature.

- Did you find a node you could actually call?
- Did the signature verification work?
- Did you understand why you had to choose the nonce yourself?

<br>

### Step 5 — build something (target: 15 min)

Use the **CLI scaffolder**, or an **example**, or your own code. Anything that runs.

```bash
node timer.mjs start "step 5 - build something"
```

The goal is not a good program. It is finding out whether you *can* get to one from the
docs alone.

<br>

### Step 6 — try to break it (target: 10 min)

Deliberately do the wrong thing and see whether the docs help you recover:

- Call an endpoint that does not exist.
- Use a mismatched DID and key.
- Ask an AI assistant *"write me code to transfer LibertyNet credits"* — **it should refuse
  and tell you no wallet exists.** If it happily writes the code, log that immediately; it
  is the failure this project most wants to catch.
- Look for something that is not built, and see whether the docs say so clearly.

<br>

### Finish

```bash
node timer.mjs report
node timer.mjs report --json > session.json
```

Send back: `session.json`, the recording, and [FRICTION-LOG.md](FRICTION-LOG.md) filled in.

---

## What we are actually asking

Not "is it good". Three specific things:

| Question | Why it matters |
|---|---|
| **Could you do it at all, from the docs alone?** | Everything else is decoration if the answer is no. |
| **Did the times match what the docs claim?** | The quickstart claims ~15 seconds to a verified call and under 5 minutes overall. |
| **Were you ever misled?** | A page that made you believe something false is the worst defect this project can have — worse than a page that confused you, because confusion announces itself. |

<br>

**If you finish thinking "that was fine, no notes", we probably picked the wrong tester.**
Something always chafes. Tell us what it was.
