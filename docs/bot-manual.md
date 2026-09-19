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

Only these six rules are moderated. **There is no word filter.**

## Where it looks

It reads message text, embeds, buttons, polls, upload names and alt text, stickers and forwards. **Edits are scanned**, including old messages.

## What it never touches

- Its own messages and direct messages.
<!-- when: exempt-channels -->
- Channels that have been exempted: {{exempt-channels}}. **A thread is exempted separately from its channel.**
<!-- end: exempt-channels -->
<!-- when: exempt-admins -->
- Posts by admins, while that exemption is on. **Webhooks are never exempt.**
<!-- end: exempt-admins -->
- Invite codes Discord will not resolve: it removes on a confirmed answer, never a guess.

## What the poster is told

The bot **DMs them**, names the rule, and points to Rules and the admin role. If DMs are shut it posts a temporary channel tag. It never quotes the removed text.

## Access and rapid offenses

Membership Screening grants the Rules channel's any-reaction role. Reaction roles still work.

Three deletions in 60 seconds trigger a ten-minute timeout and remove access. The private Rules thread has a **Restore access** button and tags the member again after an hour if needed. It stays active for up to a week. Pressing the button starts one-hour probation, restores access, then locks and archives the thread. Another deletion during probation means a Discord and permanent FiveM ban. Dry run, failed deletes, bots, webhooks, the owner and admins do not count. Restart loses only an unfinished 60-second strike count; recovery, probation and the reminder survive.

## The moderation channel

<#1542603116258525185>. One line per event: who, where, which rule, and confirmed invite codes. Never the message text.

## The status channel

<#1543345492270915684>. Bot faults, folded while they repeat. It also posts **`Update installed.`** once per new build; normal starts are silent.

## Discord bans, kicks and unbans

- **Ban** — a permanent game ban, and they are dropped from the match they are in.
- **Kick** — dropped from the match. Nothing is recorded.
- **Unban** — lifts the game ban and takes <@&1542596612306505808> off.

**A game ban never bans anybody on Discord.** It puts that role on them, so they can argue their case.

Anything done while the bot was down is picked up at the next start.

## Reaction roles

React to a paired message to get its role; remove the reaction to lose it.

## The commands

Six. **Admin** means holding the admin role.

- `/drain start [server]` — **admin**. Drains, updates and restarts `prod` or `dev`; defaults to `prod`. Private.
- `/drain cancel [server]` — **admin**. Calls that window off. Private.
- `/help [user]` — anyone. Links the player guide; public when aimed at somebody, private otherwise.
- `/profile` — anyone. Your own progression and match record. Private.
- `/profile <user>` — **admin**. Bans, career, registry, recent matches and console link. Private.
- `/reactrole <message> <emoji> <role> [channel]` — **admin**. Pairs a reaction with a role. Private.
- `/sticky <text>` — **admin**. Keeps or replaces a message at the channel bottom.
- `/unsticky` — **admin**. Takes it down.
