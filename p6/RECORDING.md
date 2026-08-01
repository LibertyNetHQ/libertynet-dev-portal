# Recording a session

Thirty seconds of setup. The recording is worth more than the notes, because it captures the
pauses — and a five-second pause before someone clicks is a finding they will never think to
write down.

## Record

| Platform | How |
|---|---|
| macOS | <kbd>⌘⇧5</kbd> → Record Entire Screen. Built in. |
| Windows | <kbd>⊞ Win</kbd>+<kbd>G</kbd> → Record. Built in. |
| Linux | `sudo apt install simplescreenrecorder`, or OBS |
| Any | [OBS Studio](https://obsproject.com) — free |

**Include audio and think out loud.** "Hmm, where's the…" is data. Silence is not.

## Before you hit record

Close anything you would not want to publish. The recording will be watched by the
maintainers and may be quoted in an issue.

- Close password managers, email, messaging.
- Use a fresh browser profile with no autofill.
- Nothing in this session needs a credential — if a page asks you for one, **that itself is
  a finding**, because it should not.

<Warning>
Never type a real private key, seed phrase or password during a P6 session. Nothing in the
walkthrough requires one. If you find yourself about to, stop and log it:

```bash
node timer.mjs stuck "the docs asked me for a private key at <step>"
```
</Warning>

## What to capture

- The **whole screen**, not just the browser — terminal switches are where people get lost.
- **Both monitors** if you use two, or note which one the docs were on.
- Roughly 45 minutes. Do not edit it down; the boring parts are where the friction is.

## While recording

Say what you are doing and, more importantly, **what you expected**:

> "OK so I'm running the verify script… it says 28 of 28… I *think* that's good? I don't
> actually know what it proved."

That last sentence is the most valuable thing in the whole session. Say it out loud rather
than resolving it silently.

## Sending it back

Files: the recording, `session.json`, and your filled-in `FRICTION-LOG.md`.

Large files: any share link is fine. Attach the JSON and the log to a
[GitHub issue](https://github.com/LibertyNetHQ/libertynet-dev-portal/issues/new) labelled
`p6`, or send them directly if you would rather they were not public.

<br>

**We are not evaluating you.** If you get stuck, that is the documentation failing, and the
whole point of the exercise is to find where.
