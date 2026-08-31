# Blitz bot

This post is rebuilt on every restart, so an edit to it is undone.

## What it removes

Six rules.

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

Rename the file and post it again.

## Where it looks

Message text, embeds, buttons and the links behind them, poll questions and answers, attachment filenames and alt text, and sticker names. A forwarded message is read the same way.

**Edits are scanned**, including on messages posted before the last restart.

## What it never touches

- Its own messages, direct messages, and any other server it is in.
- Channels that have been exempted. **A thread is exempted separately from its channel.**
- Posts by admins, while that exemption is on. **Webhooks are never exempt.**
- An invite code Discord will not answer for: it removes on a confirmed answer, never a guess.

## What the poster is told

The bot **DMs them**, naming the rule that fired. If their DMs are shut it tags them in the channel instead and takes that note down after about half a minute — **the one message the bot sends that pings anybody**.

Nothing it posts quotes the removed text.

## The removals channel

<#1542603116258525185>. One line per removal: who posted it, which channel, which rule, and the invite codes when the rule found any. Never what the message said.

## The status channel

<#1543345492270915684>. The bot's own faults and nothing else: a delete that failed, a rate limit, a channel it cannot post in, a dropped connection. The same fault repeating folds into one line.

It also posts **`Update installed.`** when it starts on a new build. A normal start says nothing.

## Discord bans, kicks and unbans

- **Ban** — a permanent game ban, and they are dropped from the match they are in.
- **Kick** — dropped from the match. Nothing is recorded.
- **Unban** — lifts the game ban and takes <@&1542596612306505808> off.

**A game ban never bans anybody on Discord.** It puts that role on them, so they can argue their case.

Anything done while the bot was down is picked up at the next start.

## The commands

Five. **Admin** means holding the admin role.

- `/drain start [note]` — **admin**. Stops the server letting anybody in, then updates and restarts it, ending every match in progress. `note` is what players who try to join are shown. Private.
- `/drain cancel` — **admin**. Calls that window off. The console does not offer that route yet, so it is refused. Private.
- `/help [user]` — anyone. Links the player guide. Posted in the channel when aimed at somebody, private otherwise.
- `/profile` — anyone. Your own progression and match record. Private.
- `/profile <user>` — **admin**. Bans, career, registry row, last five matches, and a button to the console. Private.
- `/sticky <text>` — **admin**. Keeps a message at the bottom of this channel. Running it again replaces it.
- `/unsticky` — **admin**. Takes it down.

Some replies are still placeholder text and say so.
