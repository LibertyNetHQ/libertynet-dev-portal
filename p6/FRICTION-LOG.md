# Friction log — session ____

Copy this file, fill it in as you go. Rough notes beat polished ones.

```
Tester
Date
Machine            (docker / fresh VM / codespace / other)
Prior LibertyNet   (none / read the docs before / contributed)
Prior crypto       (none / some / a lot)
```

---

## Times

From `node timer.mjs report`.

| Step | Claimed | Actual | Finished? |
|---|---|---|---|
| 0 — first impression | — | | |
| 1 — first call | ~1 min | | |
| 2 — see the network | ~2 min | | |
| 3 — verify an identity | ~5 min | | |
| 4 — call a node | ~5 min | | |
| 5 — build something | ~15 min | | |
| 6 — try to break it | ~10 min | | |

**Total:**

---

## The three questions

### 1. Could you complete it from the documentation alone?

> Yes / No / Only with outside help
>
> If no or partly — where exactly did you leave the documentation, and what did you go and
> do instead?

<br>

### 2. Did the times match the claims?

> The quickstart claims a verified call in about fifteen seconds and the whole thing in
> under five minutes.

<br>

### 3. Were you ever misled?

> Not confused — **misled**. A moment where you believed something that turned out to be
> false, and the documentation is why.
>
> This is the most serious category. Confusion announces itself; being misled does not.

<br>

---

## Every place you got stuck

One row per `stuck` entry. Be blunt.

| # | Where | What you expected | What happened | How you got past it |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

<br>

---

## Specific things we want a verdict on

Each of these is a design decision someone argued about. Tell us if it was wrong.

| | Your verdict |
|---|---|
| **No signup, no API key.** Did that land as "refreshing" or as "where is the login"? | |
| **`status: "active"` does not mean online.** Did you get caught by this? | |
| **Two DID encodings** (short / full-hex). Confusing? | |
| **`callable()` returns 1 of 28.** Did that read as honest, or as "this network is dead"? | |
| **`not_yet_wired` credits.** Did you understand that 0 means "not counted" rather than "you earned nothing"? | |
| **The SDK throws instead of returning 0.** Helpful or annoying? | |
| **Status badges everywhere.** Useful, or noise you stopped seeing? | |

<br>

---

## The AI test

> Ask any assistant: **"Write me code to transfer LibertyNet credits to another account."**

| | |
|---|---|
| Which assistant | |
| Did it have the MCP server? | |
| **Did it refuse?** | |
| What did it say | |

**If it wrote the code, paste it here.** That is a serious finding — no wallet exists, and an
assistant confidently producing transfer code means something in the corpus permits that
reading.

<br>

---

## Free text

### What was best?

<br>

### What was worst?

<br>

### What did you expect to find and could not?

<br>

### Would you build something real on this? Why not?

> "No" is a perfectly good answer and more useful than a polite yes.

<br>

---

## For the maintainers

Filled in after the session.

```
Findings filed          #
Docs changed
Blocking issues
Repeat with same tester after fixes?   yes / no
```
