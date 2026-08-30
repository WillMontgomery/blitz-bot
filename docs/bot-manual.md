# What this bot does

It removes Discord invites to other servers from this one. An invite to this
server is left alone; every other invite posted here is deleted.

That is the whole feature set. It does not warn, mute, kick, ban, filter words,
or moderate anything else.

# Where it looks for an invite

Not only the message text. It reads the message content, embeds (title,
description, fields, footer, author), buttons and every other component
including the link a button points at, poll questions and answers, attachment
filenames and their alt text, and sticker names.

It reads forwarded messages the same way, because a forward keeps the original
text somewhere the message text is not.

It reads edits. A message edited to add an invite after it was posted is scanned
again, including a message posted before the bot last restarted.

Ten distinct invite codes per message are looked up. A message carrying more
than that is removed on those grounds alone, because the codes past the tenth
cannot be checked and no ordinary message has eleven.

# What it never touches

Its own messages. Direct messages. Messages in any other server it happens to be
in. Messages in the channels listed in `BLITZ_EXEMPT_CHANNEL_IDS`. Threads are
not covered by an exempt channel: a thread has its own id and must be listed
itself.

An invite code Discord will not answer for — expired, revoked, mistyped — is
left alone. The bot deletes on a confirmed answer, never on a guess.

# The admin exemption

If `DISCORD_ADMIN_ROLE_ID` names a role and `BLITZ_EXEMPT_ADMINS` is true, a
message from a holder of that role is not scanned at all. Unsetting the role id
turns the exemption off.

Webhooks are never exempt. A webhook cannot hold a role, so a webhook post is
always scanned.

If the bot cannot read an author's roles, it scans the message anyway. The cost
of that is one admin post scanned; the cost of the other choice is anyone who
looks unreadable getting a free pass.

# Dry run

With `BLITZ_DRY_RUN` set to true the bot does everything except delete. It
scans, it decides, it writes the journal line, and it posts to the removals
channel with "Dry run, nothing removed" as the first words.

Whether it is on right now is not something this file can say: it is an
environment variable on the box, not part of the repository. The removals
channel is where you can see which of the two the bot is doing.

# The removals channel

`BLITZ_LOG_CHANNEL_ID`. One message per removal: who posted it, which channel,
the reason, and the invite codes. Nothing else, and nothing about what the
message said.

Two reasons appear there. `foreign-invite` means a code was resolved and points
at another server. `over-lookup-cap` means the message carried more codes than
the scan will resolve, so nothing was confirmed about the ones past the tenth —
that line reports a count and no codes.

The author is named as a mention and again in plain text, because a mention
stops rendering once that account leaves.

# The status channel

`BLITZ_STATUS_CHANNEL_ID`. The bot's own faults, so they do not sit unread in
the journal on the box: a delete that failed, a rate limit, a channel it cannot
post in, a gateway disconnect.

Warnings and errors only, plus the deploy notice below. It never posts a
removal there, and a start that goes normally says nothing at all.

The same fault repeating folds into one message with a count on it rather than
filling the channel.

# The deploy notice

When the bot starts on a commit different from the one it last reported, it
posts `running commit` and the short sha to the status channel.

It restarts on every deploy and on every crash. A restart on the same commit
says nothing, which is why a crash loop does not fill the channel.

# This manual

`BLITZ_DOCS_CHANNEL_ID`. This channel is a rendering of `docs/bot-manual.md` in
the bot's repository, one embed per top-level heading.

On every start the bot compares the channel against that file and edits only
what differs. A section that did not change is not touched and its footer keeps
the date it last did. A section removed from the file has its message deleted; a
message deleted by hand is posted again on the next start.

The file is the source of truth. Editing a message here is undone the next time
the bot restarts.

# What it does not have

No slash commands. There are none registered and none planned in this version.

The bot never contacts a member: no DM, no reply, no "your message was removed".
A removal is a journal line and a line in the removals channel, and that is all.

There is nothing to type at it. Everything it does is decided by its
environment variables and by `docs/bot-manual.md`.
