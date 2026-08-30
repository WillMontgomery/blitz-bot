# Blitz bot

What the bot does to this server, and what it does on its own. This channel renders `docs/bot-manual.md`; an edit to these messages is undone on the next restart.

## What it removes

Six rules. Each removal is reported under the rule that fired.

- **foreign-invite** — an invite to another Discord server.
- **over-lookup-cap** — more invite codes in one message than it will check.
- **fivem-connect** — a `fivem://connect/` link to another game server.
- **server-listing** — a `cfx.re/join` or `servers.fivem.net` listing.
- **foreign-ip** — an IP address that is not ours.
- **link-shortener** — bit.ly, dsc.gg, t.co and the like. The destination is hidden, so it is never followed.

Nothing else is moderated. **No word filter, no warnings, no mutes.**

## Why a clip or version number vanished

**Four numbers separated by dots read as an IP address**, wherever they sit — prose, a filename, an attachment.

- Kept: **our own server address**, whatever punctuation follows it.
- Kept: a filename ending in one extension, `... 14.22.35.13.mp4`, and a zero-padded clock, `14.22.05.03`.
- Removed: `version 1.2.3.4` in a sentence, and any name with two more parts after the numbers, `clip-1.2.3.4.tar.gz`.

Rename the file and post it again.

## Where it looks

Message text, embeds, buttons and the links behind them, poll questions and answers, attachment filenames and alt text, and sticker names. A forwarded message is read the same way.

**Edits are scanned**, including on messages posted before the last restart.

## What it never touches

- Its own messages, direct messages, and any other server it is in.
- Channels listed in `BLITZ_EXEMPT_CHANNEL_IDS`. **A thread has its own id and must be listed itself.**
- Posts by holders of `DISCORD_ADMIN_ROLE_ID`, while `BLITZ_EXEMPT_ADMINS` is on. **Webhooks are never exempt.**
- An invite code Discord will not answer for: it removes on a confirmed answer, never a guess.

## What the poster is told

The bot **DMs them**, naming the rule that fired. If their DMs are shut it tags them in the channel instead and takes that note down after about half a minute — **the one message the bot sends that pings anybody**.

Nothing it posts quotes the removed text.

## The removals channel

`BLITZ_LOG_CHANNEL_ID`. One line per removal: who posted it, which channel, which rule, and the invite codes when the rule found any. Never what the message said.

## The status channel

`BLITZ_STATUS_CHANNEL_ID`. The bot's own faults and nothing else: a delete that failed, a rate limit, a channel it cannot post in, a dropped connection. The same fault repeating folds into one line.

It also posts **`Update installed.`** with a link to the commit when it starts on a new one. A normal start says nothing.

## Dry run

With `BLITZ_DRY_RUN` on, the bot scans and reports but **deletes nothing and tells nobody**. Those lines open with `Dry run, nothing removed`.

Whether it is on is set on the box, not here; the removals channel shows which it is doing.

## Discord bans, kicks and unbans

Read from the audit log and carried into the game.

- **Ban** — a permanent game ban, and they are dropped from the match they are in.
- **Kick** — dropped from the match. Nothing is recorded.
- **Unban** — lifts the game ban and takes the game-ban role off.

**A game ban never bans anybody on Discord.** It puts the game-ban role on them, so they can argue their case.

Anything done while the bot was down is picked up at the next start.

## The commands

Four, re-registered on every start. **Admin** means holding `DISCORD_ADMIN_ROLE_ID`; with that unset, nothing admin-only runs.

- `/help [user]` — anyone. Links the player guide. Posted in the channel when aimed at somebody, private otherwise.
- `/profile` — anyone. Your own progression and match record. Private.
- `/profile <user>` — **admin**. Bans, career, registry row, last five matches, and a button to the console. Private.
- `/sticky <text>` — **admin**. Keeps a message at the bottom of this channel. Running it again replaces it.
- `/unsticky` — **admin**. Takes it down.

Some replies are still placeholder text and say so.

## Maintenance notices

`BLITZ_MAINTENANCE_CHANNEL_ID`. Two posts per window, from what the console schedules: the server is going down, and it is back, with how long it was gone.

A window that is scheduled, draining or cancelled is not announced.
