# Discord server setup

**Status: not created.** Creating a Discord server requires signing in to Discord, which
needs David's credentials. Everything that can be prepared without that is here — the
structure, the copy, the rules and the moderation settings — so the actual creation is
about fifteen minutes of clicking rather than a design exercise.

The docs already link to `https://discord.gg/libertynet` in several places. Those links are
dead until this exists. That is the one piece of this portal that currently promises
something untrue, and it is why this document is at the top of the follow-up list.

---

## 1. Create the server

Discord → **+** → *Create My Own* → *For a club or community*.

| Field | Value |
|---|---|
| Name | `LibertyNet` |
| Icon | `docs-site/favicon.svg` rendered to 512×512 PNG |
| Region | Automatic |

Then **Server Settings → Enable Community**. That unlocks rules screening, the welcome
screen and a public invite — all three are needed below.

---

## 2. Reserve the vanity URL

**Server Settings → Vanity URL → `libertynet`**

This requires **Level 3 boosting**, which a new server will not have. Until then:

1. Create a permanent invite on `#welcome`: *Edit Channel → Invites → Create*, set
   **Expire After: Never**, **Max Uses: No limit**.
2. Put that invite link into `community/discord-invite.txt` in this repo.
3. Run `node community/apply-invite.mjs` — it rewrites every `discord.gg/libertynet`
   reference in the docs to the real link and rebuilds the site.

Doing it that way means the documented link is correct from day one, rather than pointing
at a vanity URL that may never be earned.

---

## 3. Channels

Ordered so a newcomer reads top to bottom and lands in the right place.

### INFORMATION *(read-only)*

| Channel | Purpose |
|---|---|
| `#welcome` | What LibertyNet is, in four lines. Links to the quickstart. |
| `#rules` | See §5. |
| `#announcements` | Releases and breaking changes. Announcement channel, so other servers can follow it. |
| `#status` | Automated: capability-matrix changes and drift alerts. See §7. |

### DEVELOPERS

| Channel | Purpose |
|---|---|
| `#developers` | The main room. Questions, help, "why does this return 401". |
| `#showcase` | What people built. Also where "this was harder than it should have been" belongs. |
| `#sdk-typescript` | Language-specific, once `#developers` gets noisy. Create later, not now. |
| `#sdk-python` | Same. |

### OPERATORS

| Channel | Purpose |
|---|---|
| `#node-operators` | Running `ln-node`, binding, hardware, uptime. |
| `#node-support` | Something is broken. |

### META

| Channel | Purpose |
|---|---|
| `#feedback` | The portal itself: unclear pages, wrong examples, missing translations. |
| `#translations` | Coordinating the nine locales that are still English-only. |

<br>

**Do not create empty channels.** A server with fourteen channels and four messages looks
abandoned. Start with `#welcome`, `#rules`, `#announcements`, `#developers`, `#showcase`,
`#node-operators`, `#feedback`. Add the rest when a real conversation is being crowded out.

---

## 4. Roles

| Role | Colour | Who | Permissions |
|---|---|---|---|
| `Core` | `#00E5C7` | David, maintainers | Administrator |
| `Contributor` | `#00A88F` | Anyone with a merged PR | Manage messages in dev channels |
| `Node Operator` | `#FFC98A` | Verified operators (see below) | Access to `#node-operators` |
| `Developer` | default | Everyone who passes rules screening | Send messages |

**Verifying a node operator** is genuinely possible here, unlike most communities: ask them
to sign a challenge with their operator device key, exactly as
[operator login](https://docs.libertynet.ai/guides/operator-login) describes. A role granted
on cryptographic proof rather than a claim is worth having.

Do not build that as a bot before there are operators asking for it. Manual first.

---

## 5. Rules

Paste into `#rules` and into **Community → Rules Screening**.

```text
1. Be straight with people.
   If you do not know, say so. A confident wrong answer costs someone their afternoon.

2. No investment talk.
   Credits are a test unit — not cash, not redeemable, not a claim on future value.
   LibertyNet has no token, no wallet and no trading. Price speculation, "when token",
   and airdrop rumours get removed. This is not negotiable and it is not about tone:
   it is because people lose money to that kind of talk.

3. Never share private keys, seed phrases or session tokens.
   Nobody here will ever ask for one. Anyone who does is scamming you — report them.

4. Report security issues privately.
   Do not post an exploit in a public channel. DM a Core member and ask for a private
   thread.

5. Keep it in the open where you can.
   An answer in #developers helps the next person; the same answer in a DM helps one.

6. No spam, no unsolicited DMs, no recruiting.

7. English or Chinese in the main channels, so moderation actually works.
   Any language is welcome in #translations.
```

Rule 2 and rule 3 are the load-bearing ones. Every network with a token-shaped thing
attracts people who will tell newcomers it is an investment, and people who will ask for a
key "to help debug". Both should get an immediate ban rather than a warning.

---

## 6. Moderation

**Server Settings → Safety Setup**

| Setting | Value | Why |
|---|---|---|
| Verification level | **Medium** (registered >5 min) | Stops drive-by spam without blocking real newcomers. |
| Explicit media filter | **Scan from all members** | |
| DM spam filter | **On** | Rule 3's main enforcement. |
| Raid protection | **On** | |
| 2FA for moderators | **Required** | |
| AutoMod → block | seed phrase / private key / airdrop / presale / "when token" | Rules 2 and 3, enforced before a human sees it. |
| AutoMod → mention spam | 5 | |

Set `#announcements` and `#status` to **read-only for everyone except Core**.

---

## 7. Automation, later

Two bots would earn their keep. Neither is needed on day one, and neither should be built
before the server has people in it.

**Status bot** — posts to `#status` when `api-spec/status.json` changes in a merged PR, and
when the daily [drift watch](../.github/workflows/docs-drift.yml) finds the live API
disagreeing with the docs. The workflow already produces the JSON; this is a webhook away.

**Operator verification bot** — issues a challenge, verifies an Ed25519 signature against
the claimed operator DID, grants `Node Operator`. The verification logic already exists in
`sdk/typescript/src/did.ts`; the bot is a thin wrapper.

<br>

---

## 8. After it exists

```bash
echo "https://discord.gg/YOUR-REAL-INVITE" > community/discord-invite.txt
node community/apply-invite.mjs
./site/deploy.sh
```

That replaces every placeholder link across the docs and redeploys. Until it runs, the
community links in the published site point at nothing — which is the sort of small
dishonesty this portal otherwise works hard to avoid.
