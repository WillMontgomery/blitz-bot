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

## Where it looks

Message text, embeds, buttons and the links behind them, poll questions and answers, attachment filenames and alt text, and sticker names. A forwarded message is read the same way.

**Edits are scanned**, including on messages posted before the last restart.

## What it never touches

- Its own messages and direct messages.
<!-- when: exempt-channels -->
- Channels that have been exempted: {{exempt-channels}}. **A thread is exempted separately from its channel.**
<!-- end: exempt-channels -->
<!-- when: exempt-admins -->
- Posts by admins, while that exemption is on. **Webhooks are never exempt.**
<!-- end: exempt-admins -->
- An invite code Discord will not answer for: it removes on a confirmed answer, never a guess.

## What the poster is told

The bot **DMs them**, naming the rule that fired. If their DMs are shut it tags them in the channel instead and takes that note down after about half a minute — **the one message the bot sends that pings anybody**.

Nothing it posts quotes the removed text.

## The moderation channel

<#1542603116258525185>. One line per moderation event: who posted it, which channel, which rule, and the invite codes when the rule found any. Never what the message said.

## The status channel

<#1543345492270915684>. The bot's own faults and nothing else: a delete that failed, a rate limit, a channel it cannot post in, a dropped connection. The same fault repeating folds into one line.

It also posts **`Update installed.`** when it starts on a new build. A normal start says nothing.

## Discord bans, kicks and unbans

- **Ban** — a permanent game ban, and they are dropped from the match they are in.
- **Kick** — dropped from the match. Nothing is recorded.
- **Unban** — lifts the game ban and takes <@&1542596612306505808> off.

**A game ban never bans anybody on Discord.** It puts that role on them, so they can argue their case.

Anything done while the bot was down is picked up at the next start.

## Reaction roles

React to a message an admin paired with a role and you are given it. Take the reaction off and it goes.

## The commands

Six. **Admin** means holding the admin role.

- `/drain start [server]` — **admin**. Stops the server letting anybody in, then updates and restarts it, ending every match in progress. `server` is `prod` or `dev`, and `prod` when left out. Private.
- `/drain cancel [server]` — **admin**. Calls that window off. Private.
- `/help [user]` — anyone. Links the player guide. Posted in the channel when aimed at somebody, private otherwise.
- `/profile` — anyone. Your own progression and match record. Private.
- `/profile <user>` — **admin**. Bans, career, registry row, last five matches, and a button to the console. Private.
- `/reactrole <message> <emoji> <role> [channel]` — **admin**. Pairs a reaction with a role. Private.
- `/sticky <text>` — **admin**. Keeps a message at the bottom of this channel. Running it again replaces it.
- `/unsticky` — **admin**. Takes it down.

Some replies are still stand-in text.
