# Deploying blitz-bot

**This is the runbook for installing, first-running and updating the bot over
SSH, and that is all it is.** It is not how the bot is watched day to day.

Read it top to bottom the first time. Every command block is meant to be pasted
whole, one block at a time, and every block below is written so that there is no
decision to make in the middle of it.

Three things govern the whole document:

- **The Ringmaster console runs on this box and must not be touched.** Nothing
  here changes the console's runtime, its unit, or its files.
- **The bot's first run is a dry run.** `BLITZ_DRY_RUN=true` until you have
  watched it report what it *would* have removed. It gets to delete things in a
  live community only in §9, after §8 has proved it does the right thing.
- **Updating happens on a timer, and starting the bot never updates it.** A
  separate unit fetches `main` every fifteen minutes and restarts the bot only
  when the commit changed (§6). A crash restarts the bot on the code already on
  the box and deploys nothing.

## Where it runs

| | |
|---|---|
| **Box** | Ubuntu, `ip-10-0-133-69`, private IP `10.0.133.69` |
| **Region** | us-east-2 |
| **Reached by** | SSH from inside the VPC — the box has **no public IP** |
| **Bot directory** | `/opt/blitz-bot`, owned `ubuntu:ubuntu` |
| **Bot unit** | `blitz-bot.service` |
| **Bot runtime** | `/opt/node24/bin/node` — Node 24, installed for the bot alone |
| **Also on this box** | the Next.js admin console — `ringmaster.service`, `User=ubuntu`, `/opt/ringmaster` |
| **Console runtime** | `/usr/bin/node` — Node 22. **The bot never uses it.** |

The bot is the **second** service on the console's box. It is not part of the
console, not started by it, and not reachable from it.

## The rule that matters: neither one depends on the other

**The bot must never be a hard dependency of the console, and the console must
never be a hard dependency of the bot.** Concretely:

- Nothing in `blitz-bot.service` names `ringmaster.service`, and nothing in
  `ringmaster.service` names `blitz-bot.service`. No `Requires=`, no
  `BindsTo=`, no `After=`, not even a `Wants=`. A `Wants=` looks harmless and
  is how one service ends up starting the other at boot and then being blamed
  for its failures.
- They share no socket, no port, no file, no database handle **and no Node
  binary**. The only thing they have in common is the kernel.
- **Either may be down, and the other will not notice.** The console is what
  admins reach for while something is going wrong; a bot in a crash loop must
  not take it with it. Equally, deploying the console must not stop moderation
  for the ninety seconds of an `npm run build`.
- **They are updated separately.** Two directories, two updates, two
  `systemctl restart`s — and the bot now has an update unit and a timer of its
  own (§6), which is a thing only the bot has. There is no command in this file
  that touches `/opt/ringmaster`, and nothing on that timer knows the console
  exists.

If the two ever do need to talk, they talk over HTTP with a timeout and a
failure path, like strangers. They do not become one unit.

## 0. Getting an SSH prompt on the box

The box has no public IP. Connect the same way you already connect to the
Ringmaster console box — from a machine inside the VPC, or over the route you
already use. There is nothing new to set up here; if that route works for the
console it works for this.

```bash
ssh ubuntu@10.0.133.69
```

Everything below is typed at the prompt that command gives you.

Confirm you are on the right box:

```bash
hostname
```

Expected output, exactly:

```
ip-10-0-133-69
```

Confirm who you are:

```bash
whoami
```

Expected output, exactly:

```
ubuntu
```

**Stay as `ubuntu` for the whole of this document. Do not run `sudo -i`.** The
install directory and the environment file are created owned by whoever runs the
commands. Do them as root and the bot — which runs as `ubuntu` — cannot read its
own token, and the failure it produces says nothing about the real cause.

Confirm `sudo` works without a prompt:

```bash
sudo true && echo "sudo ok"
```

Expected output:

```
sudo ok
```

## 1. Prerequisites: git, curl, and outbound network

**`git` is not in the Ubuntu Server cloud image.** Neither is anything that
would tell you so before the clone in §3 fails.

```bash
sudo apt-get update && sudo apt-get install -y git curl ca-certificates xz-utils
```

`apt-get update` reaching the archive is also the first proof that this box has
outbound internet at all. It does not prove it can reach *nodejs.org*, which is
the next thing needed, so check that separately:

```bash
curl -fsS -o /dev/null https://nodejs.org/dist/v24.20.0/SHASUMS256.txt && echo "outbound network ok"
```

Expected output:

```
outbound network ok
```

If that fails, stop. Nothing after this point can work, and every failure it
produces will look like something else.

## 2. Node 24, installed for the bot alone

The bot needs **Node 24** and will not run on less: it executes TypeScript
straight from `src/`, and an older major does not warn about a `.ts` file, it
fails to parse it. There is no build step to hide behind.

**The bot gets its own Node under `/opt/node24`, and the system Node is left
exactly as it is.** `/usr/bin/node` is the console's runtime. Moving it is a
change to the console — a service this document has no business restarting —
and the bot does not need it moved. One absolute path in the unit file buys
complete independence, which is worth more than a tidy `node -v`.

Record what the console is running now, so you can prove at the end that you did
not disturb it:

```bash
/usr/bin/node -v
```

Expected output:

```
v22.23.2
```

**Check the CPU architecture before downloading anything.** nodejs.org ships a
different tarball per architecture, and the wrong one fails neither at download
nor at unpack. It fails two blocks later, the first time anything tries to run
it, as `cannot execute binary file: Exec format error` — which reads like a
corrupt download and sends you back to the checksum, which will keep saying
`OK`.

```bash
uname -m
```

Expected on this box, exactly:

```
x86_64
```

| `uname -m` says | The tarball is | |
|---|---|---|
| `x86_64` | `node-v24.20.0-linux-x64.tar.xz` | Intel or AMD. This box. |
| `aarch64` | `node-v24.20.0-linux-arm64.tar.xz` | 64-bit Arm — a Graviton instance. |
| anything else | — | **Stop.** Look at <https://nodejs.org/dist/v24.20.0/> for a build that matches. Do not guess. |

The three blocks below derive that name from `uname -m` rather than hardcoding
it, so each one is correct on either box and there is no filename to keep in
step by hand. They repeat the derivation instead of setting a shell variable
once, for the same reason `chmod` in §5 is given an absolute path: a block that
depends on state left behind by an earlier block does the wrong thing, silently,
in a fresh SSH session.

Download the official Node 24 tarball and its checksum file:

```bash
cd /tmp && curl -fsSLO "https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-$(uname -m | sed -e s/x86_64/x64/ -e s/aarch64/arm64/).tar.xz" && curl -fsSLO https://nodejs.org/dist/v24.20.0/SHASUMS256.txt
```

Check the download against the published checksum:

```bash
cd /tmp && grep " node-v24.20.0-linux-$(uname -m | sed -e s/x86_64/x64/ -e s/aarch64/arm64/).tar.xz\$" SHASUMS256.txt | sha256sum -c -
```

Expected output on this box, exactly:

```
node-v24.20.0-linux-x64.tar.xz: OK
```

On an Arm box the name in that line reads `-arm64` instead. The `OK` is the part
being checked either way.

**If it says anything other than `OK`, stop and delete the file.** The checksum
comes from the same server as the tarball, so this proves the download arrived
intact — a truncated or corrupted file — rather than proving nobody tampered
with both. That is the check worth having here: a half-downloaded Node produces
errors that read like bugs in the bot.

Unpack it into `/opt/node24`:

```bash
sudo mkdir -p /opt/node24 && sudo tar -xJf "/tmp/node-v24.20.0-linux-$(uname -m | sed -e s/x86_64/x64/ -e s/aarch64/arm64/).tar.xz" -C /opt/node24 --strip-components=1
```

Confirm the bot's runtime:

```bash
/opt/node24/bin/node -v
```

Expected output:

```
v24.20.0
```

Confirm the console's runtime is untouched:

```bash
/usr/bin/node -v
```

Expected output, unchanged:

```
v22.23.2
```

`/opt/node24/bin` is deliberately **not** added to anybody's `PATH`. Nothing
should be able to pick up Node 24 by accident, and equally nothing should be
able to pick up Node 22 by accident: everything in this document that needs
either one names **the `node` binary itself** by absolute path — the unit
file's `ExecStart` in §6, and every `npm` in §3, §6.1 and §16, each of which
runs `/opt/node24/bin/node` and hands it npm's own script as an argument.

**Naming `npm` by absolute path does not do that**, which this document used to
claim it did. §3 has the retraction and the proof.

## 3. The code

```bash
sudo mkdir -p /opt/blitz-bot && sudo chown ubuntu:ubuntu /opt/blitz-bot
```

`ubuntu:ubuntu` is written out rather than `"$USER:$USER"`. `$USER` is whoever
is running the shell, and a shell that reached this line through `sudo -i` is
root — which produces a directory the bot cannot write and a chain of errors
that never mentions ownership.

```bash
git clone https://github.com/WillMontgomery/blitz-bot.git /opt/blitz-bot
```

```bash
cd /opt/blitz-bot && /opt/node24/bin/node /opt/node24/lib/node_modules/npm/bin/npm-cli.js ci
```

**Naming the `node` binary is the load-bearing part of that line. An absolute
path to `npm` is not — and this document used to say that it was.**

**That claim is withdrawn, and the box is what withdrew it.** Earlier versions
of this section wrote the line as `/opt/node24/bin/npm ci` and argued at length
that the absolute path was what kept the install off the console's runtime. Two
commands on the box disprove it:

- `head -1 "$(readlink -f /opt/node24/bin/npm)"` prints `#!/usr/bin/env node`.
- `/opt/node24/bin/npm exec -- node -v` prints `v22.23.2` — **the console's
  Node**, reached through the bot's own `npm`, by its absolute path.

`/opt/node24/bin/npm` is a symlink to
`/opt/node24/lib/node_modules/npm/bin/npm-cli.js`, and that file is a *script*
whose first line is `#!/usr/bin/env node`. A script is run by the interpreter
its shebang names; that shebang names `env`; and `env` searches `PATH`. **Where
the script lives has no bearing on which `node` runs it.** `/opt/node24/bin` is
deliberately off everyone's `PATH` (§2), so `env` finds `/usr/bin/node`
v22.23.2 — the one runtime this document promises the bot never touches. Every
install run the old way went onto the console's Node.

So the rule is: **run the binary, and hand it the script.**
`/opt/node24/bin/node` is an ELF executable, not a shebang script, so nothing
resolves it through `PATH` and nothing between it and the CLI it is given can
substitute a different runtime. There is no `PATH` lookup left anywhere in that
line.

**A `PATH` entry is the other fix, and it is the wrong one.** Adding
`/opt/node24/bin` to `PATH` would make a bare `npm` resolve the way this
section used to claim an absolute path did — and break something larger: it
would change which `node` the **operator's** shell finds, and the console's own
maintenance commands are run in that shell.

`npm ci` rather than `npm install`: it installs exactly what
`package-lock.json` pins and fails if the lockfile and `package.json` disagree,
instead of quietly resolving something newer than what was tested.

**Prove the tree that just landed runs on the bot's Node**, here, rather than
finding out from a unit that will not start:

```bash
/opt/node24/bin/node /opt/blitz-bot/node_modules/.bin/vitest --version
```

Expected — one line, of this shape:

```
vitest/3.2.7 linux-x64 node-v24.20.0
```

Read the last two fields, not the first. `node-v24…` is the Node that just
loaded the tree `npm ci` wrote, and it must not say `v22`. `linux-x64` is §2's
`uname -m` answer printed back at you. The `vitest/…` number moves with the
lockfile and means nothing here.

That is a check on the installed tree rather than on the command that produced
it — nothing under `node_modules` records which `npm` wrote it, so there is no
honest after-the-fact test for that. Which is exactly why the command above
names the binary instead of trusting `PATH` to come out right.

**That check was already written the right way, and it is the pattern.**
`node_modules/.bin/vitest` is a shebang script too — `#!/usr/bin/env node`,
same as npm's — so `vitest --version` on its own would answer for whatever
`node` happens to be on `PATH`. It is not run on its own: `/opt/node24/bin/node`
comes first and the script is its argument, which is the only reason the
`node-v24.20.0` in that output is evidence of anything. Every tool this box runs
out of a `node_modules` tree gets the same treatment.

If the file itself is missing, the install omitted dev dependencies: `vitest` is
one, and `npm ci` installs it unless something in the environment said not to.
That is worth undoing here rather than discovering the next time anybody tries
to run the checks on the box.

**Confirm the ownership landed right, before anything depends on it:**

```bash
ls -ld /opt/blitz-bot /opt/blitz-bot/node_modules
```

Both lines must show `ubuntu ubuntu`:

```
drwxrwxr-x 5 ubuntu ubuntu 4096 Aug 29 18:01 /opt/blitz-bot
drwxrwxr-x 5 ubuntu ubuntu 4096 Aug 29 18:02 /opt/blitz-bot/node_modules
```

If either says `root root`, something in this section ran as root. Fix it now:

```bash
sudo chown -R ubuntu:ubuntu /opt/blitz-bot
```

A separate directory from `/opt/ringmaster` is what makes "updated separately"
true rather than aspirational.

## 4. Discord — do this before you start the service

None of the above gets you a working bot. The token in `.env` is only half of
it: the application it belongs to has to be configured, invited, and pointed at
the right guild. Get any of the three wrong and the box shows you something
other than the mistake — a restart loop, a bot that looks perfectly healthy and
removes nothing, or a bot that has stopped moderating with `systemctl status`
still green. §12 and §14 name the line in the journal that tells each of those
apart.

### 4.1 Turn on the Message Content intent

**Developer Portal → your app → Bot → Privileged Gateway Intents → Message
Content → on → Save.**

The bot requests this intent at connect time (`src/client.ts`). Requesting an
intent the application has not been granted is not a warning — Discord closes
the gateway with **close code 4014**, `login()` rejects, and the process exits
1. With `Restart=always` below, that is a restart loop. The journal shows both
of these:

```
2026-08-29T18:04:11.104Z level=warn msg="gateway disconnected" shard=0 code=4014
2026-08-29T18:04:11.180Z level=error msg="login failed" error="Error: Used disallowed intents"
```

`Used disallowed intents` is the whole of the string, and it is what to grep
for. (It is discord.js's wording, not ours.)

**There is no quiet version of this failure.** The identify is rejected, so
there is no session: the process never logs `ready`, never receives a message,
and never deletes or fails to delete anything. That cuts both ways, and the
second half is the one worth carrying — **a `ready` line from this boot is
proof the intent is on.**

> This section used to claim the opposite as the ordinary case: a bot that
> connects, logs a healthy `ready`, receives every message and reads
> `message.content` as the empty string for all of them, deleting nothing and
> looking like a quiet week. That is what a client which never *requests*
> `MessageContent` sees, and `src/client.ts` requests it on every connection,
> so it is not a state this bot can reach. The cost of the wrong story was that
> it sent anyone debugging the restart loop off to read the regex in
> `invites.ts` instead of the close code already in their journal.

### 4.2 Invite the bot to the guild

**Developer Portal → your app → OAuth2 → OAuth2 URL Generator.**

- **Scopes:** `bot`. Only `bot` — this bot registers no slash commands, so
  `applications.commands` would be a permission nobody uses.
- **Bot Permissions:** **Manage Messages**. That is the one permission the
  feature needs: it is what allows deleting somebody else's message. Without it
  every delete fails and the bot otherwise looks perfectly healthy — see §12.2.
- **View Channel** it normally inherits from `@everyone`. In a guild where
  channels are locked down, the bot's role needs it explicitly — it cannot
  moderate a channel it cannot see, and it will not say so.
- The bot also needs **Send Messages** in the `#bot-status` channel, because
  `BLITZ_LOG_CHANNEL_ID` points there. A channel-level override is enough; it
  does not need it guild-wide.

Open the generated URL, pick the Blitz Royale guild, authorise. Then check the
role Discord created for the bot actually carries Manage Messages in the
channels you care about — a channel-level override that denies it beats the
guild-level grant, silently.

### 4.3 Get the guild and channel ids

**Discord client → User Settings → Advanced → Developer Mode → on.** Then
right-click and *Copy Server ID* for `DISCORD_GUILD_ID`, and *Copy Channel ID*
on `#bot-status` for `BLITZ_LOG_CHANNEL_ID`. They are 17–20 digit snowflakes;
if what you pasted has letters in it, it is a name and not an id.

`DISCORD_GUILD_ID` is not decoration. It is the one thing that separates "our
invite, leave it" from "somebody else's invite, delete it", so a wrong one does
not make the bot idle — it makes every invite to *our* server look foreign, and
the bot would delete our own invites in whatever guild it is actually sitting
in.

Which is why the startup check does not warn and carry on. If the bot is
connected but is not a member of the configured guild, it **halts moderation
for the life of the process**: it takes its own message listeners back off,
scans nothing, deletes nothing, and writes one line saying so.

```
2026-08-29T18:04:11.512Z level=error msg="moderation halted, nothing will be scanned or deleted: DISCORD_GUILD_ID names a guild this bot is not a member of" user="blitz-bot" guild="000000000000000000"
```

`guild=` is the id it was told to moderate — the one to compare against *Copy
Server ID* — and `user=` is the bot it actually connected as, which is the
faster check when one application has been pointed at the wrong server.

There is no way back from that line except fixing `.env` and
`systemctl restart blitz-bot`, deliberately: every route back to moderating
passes through fixing the environment anyway. **Miss the line and nothing else
will tell you** — see §12.1.

### 4.4 The application is shared with the Ringmaster console

**This is the same Discord application the Ringmaster admin console uses for
its OAuth login.** One application, one set of credentials, two consumers.

That has a consequence worth writing down: adding the `bot` scope and Manage
Messages above **widens what this application can do**, and the console's own
docs still describe it as a login-only OAuth app. Anyone reading those docs
will underestimate what a leak of these credentials costs — it is no longer
"someone can sign in as our app", it is "someone can delete messages in the
guild". The console's `.env.local` and this bot's `.env` now hold pieces of the
same identity.

Splitting the bot onto its own Discord application, so that the console's
credentials and the bot's are genuinely separate, is **tracked as a known
issue** on the repo — deliberate and open, not an accident of setup, and not
something to attempt during an incident. Until it is done, treat both `.env`
files as carrying the same blast radius, and rotating either one means
re-deploying both services.

## 5. The environment file, and the dry run

**`BLITZ_DRY_RUN=true` is the setting this whole section exists for.** With it
on, the bot scans every message, decides exactly what it would remove, writes a
line to the journal and posts a line to `#bot-status` — and deletes nothing. It
is how you find out what this bot does to a live community without finding out
the expensive way.

Write the file in one block. It contains no secret yet:

```bash
cat > /opt/blitz-bot/.env <<'EOF'
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_ADMIN_ROLE_ID=
BLITZ_LOG_CHANNEL_ID=1543345492270915684
BLITZ_EXEMPT_CHANNEL_IDS=
BLITZ_EXEMPT_ADMINS=true
BLITZ_DRY_RUN=true
EOF
```

Lock it down **now**, before the token goes in, so the file is never readable by
anyone else while it holds a secret:

```bash
chmod 600 /opt/blitz-bot/.env
```

The path is absolute deliberately. `chmod 600 .env` depends on the shell still
standing in `/opt/blitz-bot` from some earlier block, and a shell that is
somewhere else silently leaves a Discord token world-readable.

Now fill in the two blank values:

```bash
nano /opt/blitz-bot/.env
```

Put the bot token from the Developer Portal after `DISCORD_BOT_TOKEN=` and the
guild id from §4.3 after `DISCORD_GUILD_ID=`. Save with **Ctrl-O, Enter**, exit
with **Ctrl-X**.

Three things about this file, because systemd's `EnvironmentFile` is **not** a
shell and the differences are all silent:

- **No `export`.** systemd would read the variable's name as `export
  DISCORD_BOT_TOKEN` and the bot would refuse to start saying the token is not
  set, which is a confusing way to be right.
- **No quotes around the token**, no spaces around the `=`, and no trailing
  comment on the same line. Bot tokens are plain `A-Za-z0-9._-`, so there is
  nothing to quote.
- **`KEY=` with nothing after it counts as absent**, deliberately —
  `src/config.ts` trims before it checks, so a stray space is not a
  one-character token.

What the other five are set to, and why:

| Variable | Value here | Why |
|---|---|---|
| `DISCORD_ADMIN_ROLE_ID` | blank | Blank disables the admin exemption outright. Leave it blank through §8 and §9 — **with a role set here, an invite you post yourself would be skipped**, and the smoke test would look like a broken bot. |
| `BLITZ_LOG_CHANNEL_ID` | `1543345492270915684` | `#bot-status`, admin-only. Every removal, and every dry-run would-be removal, is posted there. This is what makes the dry run readable without an SSH session. |
| `BLITZ_EXEMPT_CHANNEL_IDS` | blank | No channel is skipped. Add ids later if the owner asks for it. |
| `BLITZ_EXEMPT_ADMINS` | `true` | The default. It does nothing at all while `DISCORD_ADMIN_ROLE_ID` is blank. |
| `BLITZ_DRY_RUN` | `true` | **Delete nothing.** §9 is the only place this changes. |

Confirm the file reads back the way you meant, without printing the token:

```bash
grep -v DISCORD_BOT_TOKEN /opt/blitz-bot/.env
```

`.env` is gitignored and has never been committed, so nothing this box does to
the code touches it — including the hard reset the update runs on its timer
(§6). The secret cannot reach the repo by accident either. §16 says how both
halves of that were checked rather than assumed.

## 6. The units, and the timer that updates the bot

**The bot does not update itself, and starting it does not fetch anything.**
A separate unit does the update, a timer starts that unit every fifteen
minutes, and the update restarts the bot **only when the commit it is running
is not the commit on disk**. §16 is what that means for deploying.

The one sentence to carry out of this section: **a crash restarts the bot on
the code already on the box, and deploys nothing.**

Six files. Four of them are written here, in this order, because each is
needed by the one after it; the other two are written at runtime — one by the
update, one by the bot — and are described together, where the difference
between them is easiest to see:

| Written in | File | What it is |
|---|---|---|
| §6.1 | `/usr/local/bin/blitz-bot-update` | the update itself, and the only implementation of one |
| §6.2 | `/opt/blitz-bot/.deployed-commit` | written by the script above; the commit the bot reads at startup and reports |
| §6.2 | `/var/lib/blitz-bot/reported-commit` | written by the bot, and by nothing else; the commit it has already announced |
| §6.3 | `/etc/sudoers.d/blitz-bot-update` | the one privileged thing the update does |
| §6.4 | `/etc/systemd/system/blitz-bot.service` | the bot, which now does nothing but run |
| §6.5 | `/etc/systemd/system/blitz-bot-update.service` and `.timer` | the update, and what starts it |

**Nothing in that table is tracked in the repo**, so a push to `main` cannot
deploy a change to any of it. Changing the script, either unit, the timer or
the sudoers file is something somebody does here, by hand, and §16 says which
of them need what afterwards.

### 6.1 The update script

```bash
sudo tee /usr/local/bin/blitz-bot-update > /dev/null <<'EOF'
#!/bin/sh
#
# Bring /opt/blitz-bot to exactly origin/main, install dependencies if the
# lockfile moved, and restart the bot ONLY if the commit it is running is not
# the commit now on disk.
#
# blitz-bot-update.service runs this, as ubuntu. blitz-bot-update.timer starts
# that unit every fifteen minutes, and `sudo systemctl start blitz-bot-update`
# starts the same unit by hand. THE TIMER AND THE COMMAND ARE ONE PATH, which
# is the point of both: there is no second implementation of a deploy on this
# box for one of them to drift away from.
#
# IT IS NO LONGER AN ExecStartPre OF blitz-bot.service, AND THAT IS THE WHOLE
# POINT OF THIS ROUND. When the bot's own start ran it, three things were true
# and all three are gone:
#
#   - Restart=always made every crash a deploy. A bot that died at 3am came
#     back on whatever happened to be on main at 3am.
#   - `npm ci` deletes node_modules BEFORE it installs, so an install that did
#     not finish left no dependencies at all -- on a box that was trying to
#     start the bot again five seconds later, into exactly that tree.
#   - `reset --hard` inside a crash loop overwrote the last-known-good tree
#     with nothing holding a reference to it.
#
# Now nothing restarts the bot except the last line of this script; that line
# is reached only after an install that succeeded; and the commit the box was
# on is tagged before the reset, so it is still reachable afterwards.
#
# FAILURES ARE LOUD, WHICH THEY COULD NOT BE BEFORE. Every path in the old
# version exited 0, because a non-zero exit would have stopped the bot
# starting. Nothing waits on this script any more, so it reports failure
# honestly: `systemctl status blitz-bot-update` goes red, `journalctl -p
# warning` finds the reason, the timer tries again at the next tick, and the
# bot is untouched throughout.
#
# IT IS A FILE AND NOT A LONG `sh -c` IN THE UNIT, for a reason worth keeping:
# systemd expands `%` in unit lines. `%3N` below is a date format, and inline
# it would have to be written `%%` -- a trap every future editor gets to
# rediscover, and one that fails quietly rather than loudly. Out here there is
# no `%` expansion at all, and these comments fit.
#
# It is not in the repo, so it never updates itself. An updater that rewrites
# itself while it is running is a failure nobody needs to own.

set -u

REPO=/opt/blitz-bot
STATE=/var/lib/blitz-bot         # StateDirectory=, owned by ubuntu, survives a reboot
INSTALLED=$STATE/installed-lock  # the lockfile the last good install used
COMMIT=$REPO/.deployed-commit    # the commit the bot reads at startup -- section 6.2
PREVIOUS=blitz-bot-previous      # a local git tag: the way back, with no network
OFF_SWITCH=/etc/blitz-bot-no-update

# $STATE IS SHARED WITH THE BOT, AND THAT IS DELIBERATE. blitz-bot.service
# declares the same StateDirectory=blitz-bot (section 6.4), so systemd creates
# /var/lib/blitz-bot once, owns it to ubuntu, and both units -- both running as
# ubuntu -- can write it. Sharing the DIRECTORY is not sharing a file: nothing
# this script writes in there is read by the bot, and nothing the bot writes in
# there is read by this script. $INSTALLED is a copy of a lockfile that only
# this script ever compares against.
#
# AND THIS SCRIPT MUST NEVER WRITE $STATE/reported-commit. That file is the
# bot's own memory of the last commit it ANNOUNCED in #bot-status, it has
# exactly one writer, and the writer is the bot (section 6.2). Write the NEW
# sha there from here and the bot comes up already believing it has announced
# this deploy, so the notice never fires again. Write the OLD one and it fires
# on every restart for ever. Those are the two failures the whole comparison
# exists to prevent, and neither of them is an error anywhere -- they are a
# channel that went quiet, or a channel that will not shut up.

# npm reads its config and its cache from $HOME, and ProtectHome=true leaves
# this service no home directory to read. Both of these are directories systemd
# creates for the unit -- StateDirectory= and CacheDirectory= in section 6.5 --
# so they exist, they belong to ubuntu, and the cache survives between runs
# instead of being downloaded again every quarter of an hour.
#
# SET HERE AND NOT IN THE UNIT, so that one file says where npm puts things and
# an Environment= line cannot quietly disagree with it.
HOME=$STATE
npm_config_cache=/var/cache/blitz-bot

# Never block on a prompt. The repo is public and needs no credentials, but a
# URL that starts answering 404 makes git ask for a username, and an update
# hung on a question nobody can answer never finishes and never fails.
GIT_TERMINAL_PROMPT=0

export HOME npm_config_cache GIT_TERMINAL_PROMPT

# Timestamped like the bot's own lines so the two journals read as one stream,
# and prefixed <6>/<4> for the same reason src/log.ts does it: journald reads
# the priority off the front, strips it, and `journalctl -p warning` then finds
# a failed update without anyone parsing text (section 13).
#
# Deliberately NOT the msg= shape the bot uses. These lines are not the bot's,
# and every grep in that document which hunts for the bot's messages has to go
# on missing them.
stamped() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { printf '<6>%s blitz-bot-update: %s\n' "$(stamped)" "$1"; }
warn() { printf '<4>%s blitz-bot-update: %s\n' "$(stamped)" "$1" >&2; }

# THE ONLY WAY OUT OF THIS SCRIPT THAT IS NOT SUCCESS, so there is one place
# that decides what a failed update does. It says why at <4>, and it exits
# non-zero so the unit goes red instead of green.
#
# AND IT NEVER RESTARTS THE BOT. Reaching this line means the tree, the
# dependencies or the network is in a state nobody has checked, and a restart
# into that is the outage. The bot goes on running what it is already running,
# which is code that was working a minute ago.
die() { warn "$1"; exit 1; }

cd "$REPO" || die "no $REPO -- nothing to update"

# THE OFF SWITCH, READ FIRST so that it still works when everything below it is
# broken. main is bad and the box has to be left alone: one `sudo touch`, and
# no tick of the timer and no run of the command deploys anything until the
# file is removed (section 16).
if [ -e "$OFF_SWITCH" ]; then
  say "skipped: $OFF_SWITCH exists"
  exit 0
fi

# WHAT THE RUNNING BOT IS ON, which is the question the restart turns on. This
# file is written by this script immediately before it restarts the bot, and
# read by the bot at startup, so it is one fact with one writer.
#
# MISSING OR EMPTY MEANS UNKNOWN, AND UNKNOWN MEANS RESTART. A first install
# has no file; neither has a box somebody rolled back by hand. In neither case
# can "the bot is already on this commit" be claimed, so neither case claims it.
deployed=$(cat "$COMMIT" 2>/dev/null || true)

# ---- 1. what origin has --------------------------------------------------
before=$(git rev-parse --short HEAD) || die "cannot read HEAD -- is $REPO still a git repository?"

timeout 60 git fetch --quiet origin || die 'fetch failed -- nothing was changed'

# ---- 2. the way back, written before anything is overwritten -------------
#
# THIS IS THE LINE THE REVIEW ASKED FOR. `reset --hard` moves the branch and
# leaves the commit the box was on unreferenced -- reachable only through a
# reflog that expires, in a repository that runs `gc` on its own. A tag is a
# reference. After this line the old commit has a name, on this disk, and
# rolling back is one command that never touches github.com:
#
#     git reset --hard blitz-bot-previous
#
# LIGHTWEIGHT (`git tag -f NAME SHA`) AND NOT ANNOTATED. An annotated tag is an
# object with an author, an author needs a user.name and a user.email, and
# ProtectHome=true leaves no home directory to read a .gitconfig from -- so the
# annotated form is the one that fails here, and it would fail at the exact
# moment it was most needed.
#
# -f, because this is "the commit before this update" and not a history.
git tag -f "$PREVIOUS" "$before" >/dev/null 2>&1 ||
  warn "cannot tag $before -- rolling back will need that sha"

# ---- 3. the code, before the dependencies --------------------------------
#
# NOT `git pull`, for three things this box will actually hit: pull refuses
# outright when a tracked file has been edited in place, pull can leave a merge
# commit so the box is no longer at a commit that exists on main, and a merge
# commit wants an identity that ProtectHome=true leaves no home directory to
# read.
#
# `reset --hard origin/main` lands on exactly origin/main, stays on the main
# branch, and DISCARDS local edits to tracked files -- intended on this box,
# and said plainly in section 16 where the operator will read it. Untracked and
# ignored files are not touched, which is what keeps /opt/blitz-bot/.env and
# /opt/blitz-bot/.deployed-commit. There is deliberately no `git clean` anywhere
# here: `git clean -x` is the one command that would delete .env,
# .deployed-commit and node_modules in a single go.
#
# IT RUNS EVEN WHEN THE COMMIT DID NOT MOVE, so a tracked file edited on the
# box is put back at the next tick rather than surviving until the next push.
git reset --hard --quiet origin/main || die "reset failed -- still on $before"

current=$(git rev-parse --short HEAD) || die 'cannot read HEAD after the reset'

if [ "$current" != "$before" ]; then
  say "updated $before -> $current"
else
  say "already on $current"
fi

# ---- 4. the dependencies, and the reason this is not an ExecStartPre -----
#
# `npm ci` DELETES node_modules AND REBUILDS IT FROM NOTHING every time it
# runs. That is the failure the last review found: for the minute it is
# running, and for as long as it stays failed afterwards, /opt/blitz-bot holds
# code and no dependencies.
#
# THE ANSWER IS THIS ORDER -- INSTALL FIRST, RESTART AFTERWARDS, AND ONLY IF
# THE INSTALL SUCCEEDED. Nothing is trying to start the bot during that
# minute: a timer is not a restart trigger, which is exactly what an
# ExecStartPre was. The process that is running already holds its dependencies
# in memory and does not care that the directory underneath it is being
# rebuilt, and a new process is only ever started against a tree that finished
# installing.
#
# THE OTHER ANSWER WAS A SECOND TREE AND A SYMLINK SWAP, installing beside the
# running copy and pointing /opt/blitz-bot at it only once the install had
# worked. It closes the last of the window, and it costs a second copy of the
# repository, a symlink in the middle of every path in every unit and in this
# document, and an operator who can no longer be told "the bot is in
# /opt/blitz-bot". Too much machinery for a window nothing is restarting into.
#
# IT INSTALLS WHEN THE LOCKFILE MOVED, AND WHENEVER IT CANNOT TELL. Missing
# stamp, unreadable stamp, missing lockfile, missing node_modules -- all of
# them take the install branch, because `cmp` exits non-zero on a file it
# cannot read exactly as it does on a difference. Installing when it was not
# needed costs a minute; skipping when it was needed is a bot that cannot
# start.
#
# IT NAMES THE node BINARY AND HANDS IT npm's SCRIPT, WHICH IS NOT THE SAME
# THING AS AN ABSOLUTE PATH TO npm. /opt/node24/bin/npm is a symlink to
# npm-cli.js, whose shebang is `#!/usr/bin/env node`, and env searches PATH --
# which does not carry /opt/node24/bin, on purpose. Run that way this line
# installed the bot's dependencies on the CONSOLE's Node 22, every quarter of
# an hour, silently. Section 3 has the proof and the retraction.
if [ -d node_modules ] && cmp -s package-lock.json "$INSTALLED"; then
  say 'dependencies unchanged'
elif timeout 300 /opt/node24/bin/node /opt/node24/lib/node_modules/npm/bin/npm-cli.js ci --no-audit --no-fund; then
  # Recorded only on success, so a failed install is retried at the next tick
  # instead of being remembered as done.
  cp package-lock.json "$INSTALLED" || warn "cannot write $INSTALLED -- the next run will install again"
  say 'dependencies installed'
else
  die "install failed -- $current is on disk and the bot was NOT restarted"
fi

# ---- 5. the restart, and only when there is something to restart onto ----
#
# NO CHANGE MEANS NO RESTART. The bot's whole job is to hold a websocket open.
# Dropping it every fifteen minutes to arrive back at the same commit is a
# disconnect, a reconnect and a `ready` line, four times an hour, for nothing --
# and it would leave the one log line that means "something was deployed"
# indistinguishable from the noise around it.
#
# THE TEST IS "IS THE BOT ON THIS COMMIT", NOT "DID THIS RUN CHANGE ANYTHING",
# and the difference shows up in exactly one case: a previous run fetched a new
# commit and then failed its install, so it did not restart, so the bot is
# still on the old code while the disk is on the new. The next tick changes no
# commit, installs successfully, and this comparison still says restart -- where
# "did the commit move during this run" would have said no, and left the bot on
# the old code until somebody happened to push again.
if [ "$current" = "$deployed" ]; then
  say "no restart: blitz-bot is already on $current"
  exit 0
fi

# WRITTEN BEFORE THE RESTART, because the bot reads it at startup. The other
# order hands the new process the old commit, every single time.
printf '%s\n' "$current" > "$COMMIT" || die "cannot write $COMMIT"

# `try-restart` AND NOT `restart`: it restarts the bot if it is running and
# does nothing at all if it is not. A bot somebody stopped on purpose -- to
# read the journal without sixty lines a minute landing in it (section 14) --
# stays stopped, and the file above still tells the truth about what it will
# come up on.
#
# `sudo -n` FOR THE ONE PRIVILEGED THING THIS SCRIPT DOES. It runs as ubuntu
# because ubuntu owns the tree; restarting a system unit is root's. Section 6.3
# grants exactly this command and nothing else, and the two have to be spelled
# identically -- sudoers matches the arguments literally, so `blitz-bot` here
# against `blitz-bot.service` there would simply be denied.
sudo -n /usr/bin/systemctl try-restart blitz-bot.service ||
  die "restart failed -- $current is installed but blitz-bot did not come back"

say "deployed $current"
EOF
```

It has to be executable, or every run of the unit fails with a permission
error:

```bash
sudo chmod 755 /usr/local/bin/blitz-bot-update
```

Check it before anything depends on it:

```bash
ls -l /usr/local/bin/blitz-bot-update ; sh -n /usr/local/bin/blitz-bot-update && echo "update script parses"
```

Expected — the mode line, then the word:

```
-rwxr-xr-x 1 root root 8104 Aug 29 18:02 /usr/local/bin/blitz-bot-update
update script parses
```

The size and the date are yours. The two things to read are `-rwxr-xr-x` at the
front and `update script parses` at the end.

`sh -n` parses the file without running it. It is the closest thing this half
of the install has to the `systemd-analyze verify` in §6.5, and it catches the
one mistake a long paste actually makes. **Do not run the script by hand to
test it.** By hand it runs outside the unit's sandbox, with a different `HOME`
and no `/var/lib/blitz-bot` — so it would prove something about a situation
that never happens, and would drop a package cache in your home directory on
the way past. §7 runs it for real, through its unit, and reads the result out
of the journal.

### 6.2 `/opt/blitz-bot/.deployed-commit` — the commit the bot reports

A Node process has no way of knowing which commit it is running, and asking git
at startup would answer a different question — *what is on disk now*, which
after an update is the next deploy and not this one.

So the update writes it down, and the bot reads it.

**Path, exactly:**

```
/opt/blitz-bot/.deployed-commit
```

**Contents, exactly: one line — the short commit sha, then a newline.** The sha
is what `git rev-parse --short HEAD` prints: lowercase hexadecimal, seven
characters unless git needs more of them to keep it unambiguous. Nothing else
is in the file. No key, no quotes, no `commit=`, no trailing spaces, no second
line.

The whole file, as it is on the box today:

```
6bbff70
```

Five things the bot can rely on, and one it must not do:

- **The update script is the only writer**, and it writes the file immediately
  before it restarts the bot (§6.1). So the value a process read at startup is
  the commit that process is running.
- **It is written before the restart, never after**, so there is no start that
  reads a stale value.
- **`git reset --hard` does not touch it.** It is untracked, and the update has
  no `git clean`. It will show in `git status` on the box as an untracked file
  for ever, and that is expected rather than a fault.
- **It is readable under the bot's sandbox, and the bot never writes it.**
  `/opt/blitz-bot` is the bot's `WorkingDirectory`, and `ProtectSystem=strict`
  (§6.4) leaves it read-only to that process — which is all it needs to read
  this. The one directory the bot can write is `/var/lib/blitz-bot`, its
  `StateDirectory=`, and this file is deliberately not in there: the update
  owns this file, and a file the update owns in a directory the bot can write
  is a file two processes disagree about. **Anything else the bot needs to
  write is a change to §6.4**, and to the argument in it that this process gets
  one writable directory and no more.
- **Absent, empty or unreadable means the bot does not know**, and it says so
  rather than guessing. A missing file is the ordinary state of a box that has
  been rolled back by hand, not a fault.
- **It must not fall back to running git.** A bot that reported what is on disk
  would, after a failed install, report a commit it is not running — which is
  the one moment the answer matters.

#### The other commit file: `/var/lib/blitz-bot/reported-commit`

**One file says what the bot is running. This one says what the bot has already
said out loud.** They are two different facts and they have two different
writers, which is why they are two files in two directories:

```
/var/lib/blitz-bot/reported-commit
```

**The bot is its only writer, and it writes nothing else on this box.** After
it posts the commit it is running to `#bot-status`, it records that sha here; on the
next start it compares the two files and stays quiet when they agree. That
comparison is the entire reason `Restart=always` is survivable: a bot that
crash-loops at 3am restarts every five seconds, and without this file each of
those restarts posts the same deploy notice into the one channel that has to
stay readable while it is happening.

**`/var/lib/blitz-bot` is the bot's `StateDirectory=` (§6.4)**, so systemd
creates it, owns it to `ubuntu`, and keeps it writable while
`ProtectSystem=strict` holds the rest of the filesystem read-only. **Both units
declare `StateDirectory=blitz-bot` and both get this directory**, which is
deliberate and costs nothing: they run as the same user, and they share no file
in it. The update writes `installed-lock` and reads nothing the bot wrote.

**The update must never write this file** (§6.1 says so where somebody would be
editing it). Writing the new sha from there would leave the bot believing it had
already announced a deploy it never announced, and the notice would never fire
again; writing the old one would make it fire on every restart. Neither shows up
as an error — one is a channel that went silent, the other is the noise this
file exists to stop.

**Deleting it is harmless and re-announces once.** It is a cache of something
already said, not a record anything depends on. A box that has never run the bot
does not have it, and that is the ordinary first-start case: nothing to compare
against means the notice is new.

### 6.3 The one privileged thing the update does

The update runs as `ubuntu`, because `ubuntu` owns `/opt/blitz-bot` and git and
the install have to write it. Restarting a system unit is root's. That is the
only root thing in the script, so it is the only thing granted.

Write it to a temporary path first and check it there:

```bash
sudo tee /tmp/blitz-bot-update.sudoers > /dev/null <<'EOF'
# blitz-bot-update.service runs as ubuntu, because ubuntu owns /opt/blitz-bot.
# The last line of /usr/local/bin/blitz-bot-update restarts the bot, which is
# root's to do. This grants that one command, with those arguments, and
# nothing else. sudoers matches arguments literally: change either side and
# the update stops being able to restart the bot.
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl try-restart blitz-bot.service
EOF
```

```bash
sudo visudo -c -f /tmp/blitz-bot-update.sudoers && sudo install -o root -g root -m 440 /tmp/blitz-bot-update.sudoers /etc/sudoers.d/blitz-bot-update && sudo rm -f /tmp/blitz-bot-update.sudoers
```

Expected — one line, and the file is in place only if you see it:

```
/tmp/blitz-bot-update.sudoers: parsed OK
```

**The staging path is not fussiness.** A file in `/etc/sudoers.d` that does not
parse makes `sudo` refuse to run **at all** — on a box whose only privileged
path is `sudo` over SSH, with no console to fix it from. Checked in `/tmp`, a
paste that went wrong is a file nothing reads. If the line above stops at
`parsed OK` and goes no further, nothing was installed and nothing is broken:
fix the heredoc and paste both blocks again.

**The grant is proved at the end of §6.5**, and not here — the command it
grants names a unit that does not exist yet.

### 6.4 The bot's unit

Write the unit file in one block. Do not open an editor for this — a fifty-line
paste into `nano` is where a stray character gets in, and the error it produces
names a line number rather than the mistake.

```bash
sudo tee /etc/systemd/system/blitz-bot.service > /dev/null <<'EOF'
[Unit]
Description=Blitz Royale Discord bot
Documentation=https://github.com/WillMontgomery/blitz-bot
After=network-online.target
Wants=network-online.target

# systemd gives up after five restarts in ten seconds by default. For a process
# whose whole job is to hold a websocket open, that default turns a ten-minute
# Discord outage into an indefinite outage of our own that nobody is paged
# about. It should keep trying.
StartLimitIntervalSec=0

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/blitz-bot

# The token and the guild id. systemd reads this at start, so an edit here
# needs a `systemctl restart`, not a `daemon-reload`.
EnvironmentFile=/opt/blitz-bot/.env

# THIS UNIT DOES NOT UPDATE ANYTHING, AND IT USED TO. The version before this
# one carried an ExecStartPre that ran /usr/local/bin/blitz-bot-update before
# every start, including the automatic ones. That was reviewed and rejected:
# with Restart=always it made every crash a deploy, and an `npm ci` that did
# not finish left a tree with no dependencies on a box that was starting the
# bot again five seconds later.
#
# The update is blitz-bot-update.service now, on a timer, and it restarts this
# unit rather than being run by it (sections 6.5 and 16).
#
# REMOVED ALONGSIDE IT, ALL FOR THE SAME REASON -- this process runs no
# install, so it is given nothing an install would need: TimeoutStartSec=
# (there is no install inside this start any more, so the default 90 seconds is
# generous again for something that execs node), ReadWritePaths=/opt/blitz-bot,
# CacheDirectory=, and the two Environment= lines that gave npm a home to work
# in. If you are about to add one of them back, read section 16 first.
#
# StateDirectory= IS NOT ON THAT LIST, AND IT IS NOT A LEFTOVER. It is below,
# it is one line, and it is here for a reason this design has and the rejected
# one did not. Read its own comment before removing it.

# The bot's own Node 24, by absolute path. NOT /usr/bin/node, which is the
# console's runtime: this is the line that keeps the two services independent.
#
# Node directly rather than `npm start`, for two reasons. npm adds a process
# whose entire job is to exec node, and it reads its config and cache from the
# home directory that `ProtectHome=true` below hides -- a combination that
# produces confusing errors at boot which have nothing to do with this bot.
#
# `--disable-warning=ExperimentalWarning` because Node prints an experimental
# warning for type stripping on every single boot, and a healthy service that
# logs a warning every time it starts is a service whose warnings nobody reads.
ExecStart=/opt/node24/bin/node --disable-warning=ExperimentalWarning /opt/blitz-bot/src/index.ts

# `always`, not `on-failure`. A Discord bot that exits 0 is still an outage:
# the gateway can close in a way discord.js does not treat as fatal, and the
# process ends with nothing wrong as far as systemd is concerned. Any exit is a
# bot that has stopped moderating.
#
# AND IT IS NO LONGER A DEPLOYMENT MECHANISM. Every restart this line produces
# relaunches the code already in /opt/blitz-bot. It fetches nothing, installs
# nothing and changes no commit -- so a bot crash-looping at 3am loops on the
# same commit it was on at bedtime.
Restart=always

# Five seconds, because that is a sensible wait before a gateway reconnect, and
# for no other reason now. It used to have to be defended against the update it
# triggered twelve times a minute; there is no update in this start to trigger.
RestartSec=5

# THE HARDENING, WITH ONE DIRECTORY OPEN IN IT AND THE SOURCE TREE SHUT. The
# version that updated itself had to open /opt/blitz-bot for writing and hand
# npm a HOME and a cache -- so the running bot could rewrite its own source and
# its own token file. All of that has gone back where it was.
#
# ProtectSystem=strict makes the whole filesystem read-only to this process,
# apart from the one directory StateDirectory= opens below. It still READS
# /opt/blitz-bot: its own source, and /opt/blitz-bot/.deployed-commit, which is
# why that file is there and not somewhere this unit cannot see (section 6.2).
# Read-only is not invisible.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

# THE ONE WRITABLE DIRECTORY, AND IT IS THE DEPLOY NOTICE'S MEMORY.
#
# THIS IS WHY IT IS HERE NOW, AND IT IS NOT WHY IT WAS HERE BEFORE. The
# rejected design had a StateDirectory= to give npm somewhere to work during an
# install inside this unit's own start; that install is gone and so is that
# reason. This line came back for one thing only: the bot writes
# $STATE_DIRECTORY/reported-commit, the sha of the last deploy it announced in
# #bot-status, and compares it at the next start (section 6.2).
#
# REMOVE IT AND THE NOTICE REPEATS ON EVERY CRASH RESTART. With
# ProtectSystem=strict and no writable path, that write fails, the bot logs a
# warning nobody is watching for, and Restart=always then posts the same
# "running commit <sha>" line into #bot-status every five seconds for as long
# as the crash loop lasts -- on top of the faults explaining the crash, in the
# one channel that has to stay readable while it is happening. So: not scenery.
# If you are tidying this sandbox, this is the line to leave alone.
#
# systemd CREATES IT AND OWNS IT TO User=, and it exports STATE_DIRECTORY, which
# is what the bot reads -- so this line and the code cannot drift apart about
# where the directory is. It survives a restart and a reboot, which a file under
# /tmp would not.
#
# IT DOES NOT WEAKEN THE SANDBOX IN THE WAY THE REJECTED DESIGN DID.
# StateDirectory= opens one directory that systemd created for this unit.
# ReadWritePaths=/opt/blitz-bot would open the bot's own source and its own
# token file, and that is the line that must stay out.
#
# blitz-bot-update.service declares the same StateDirectory=blitz-bot and the
# two share /var/lib/blitz-bot on purpose -- same user, no shared file, and
# nothing but this bot ever writes reported-commit (sections 6.1 and 6.5).
StateDirectory=blitz-bot

StandardOutput=journal
StandardError=journal
SyslogIdentifier=blitz-bot

[Install]
WantedBy=multi-user.target
EOF
```

`User=ubuntu` matches the console rather than improving on it. A dedicated
unprivileged user would stop the bot from being able to read
`/opt/ringmaster/.env.local` — the console's OAuth secret, signing key and the
path to the game host's SSH key — which is a real gain, and it is not taken
here only because it is a change to how the box is administered rather than to
how the bot is deployed.

### 6.5 The update's unit, and the timer that starts it

```bash
sudo tee /etc/systemd/system/blitz-bot-update.service > /dev/null <<'EOF'
[Unit]
Description=Update blitz-bot to origin/main and restart it if the commit changed
Documentation=https://github.com/WillMontgomery/blitz-bot

# NOTHING HERE NAMES blitz-bot.service. No Requires=, no BindsTo=, no After=,
# not even a Wants=. This unit restarts the bot by asking systemd to, in its
# last line; a dependency would additionally mean that stopping or failing one
# of them acts on the other, and an ordering dependency between a unit and a
# unit it restarts is the classic way to wedge a boot.
After=network-online.target
Wants=network-online.target

[Service]
# oneshot: it runs, it finishes, and `systemctl status` shows the result of the
# last run rather than a process. Type=simple would report success the instant
# the script was exec'd, which is the one thing nobody wants to know.
Type=oneshot
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/blitz-bot
ExecStart=/usr/local/bin/blitz-bot-update

# NO LEADING `-` ON THAT LINE, WHICH IS THE INVERSE OF THE UNIT THIS REPLACED.
# There, a failed update had to be ignored or the bot would not have started.
# Here nothing is waiting, so a failed update is allowed to be a failed unit:
# red in `systemctl status blitz-bot-update`, and found by
# `journalctl -u blitz-bot-update -p warning`.
#
# NO Restart= EITHER. A oneshot that restarts itself on failure is the fetch
# loop this whole design exists to remove. The timer is what retries, once, in
# fifteen minutes.

# The script bounds its own two network steps at 60s and 300s. This is above
# their sum, so what gives up is the step that hung, with a line in the journal
# naming it, rather than systemd killing the run and saying only that it timed
# out.
TimeoutStartSec=600

# systemd creates /var/lib/blitz-bot and /var/cache/blitz-bot, owns them to
# User= and makes them writable. The first holds the lockfile stamp, the second
# is the package cache -- worth keeping between runs, because the alternative
# is downloading every dependency again on every update.
#
# THE BOT'S UNIT DECLARES THE SAME StateDirectory=blitz-bot, DELIBERATELY. Both
# units get /var/lib/blitz-bot; systemd creates it once and owns it to ubuntu,
# and both units run as ubuntu, so this is one directory two processes can
# write rather than two directories or a conflict. They share no FILE in it:
# this unit writes installed-lock and reads nothing the bot wrote, and the bot
# writes reported-commit and reads nothing this unit wrote.
#
# THIS UNIT MUST NEVER WRITE reported-commit. It is the bot's memory of
# the last deploy it announced, the bot is its only writer, and a second writer
# makes the notice either fire on every restart or never fire again. The script
# says the same thing at the line that sets $STATE (section 6.1).
#
# CacheDirectory= IS THIS UNIT'S ALONE, and stays that way: the bot runs no
# install, so it has no cache to keep.
StateDirectory=blitz-bot
CacheDirectory=blitz-bot

# ProtectSystem=full, WHERE THE BOT GETS strict, AND THIS IS THE ONE PLACE THE
# TWO UNITS DIFFER ON PURPOSE. `strict` mounts the entire hierarchy read-only
# apart from the directories systemd itself opens, which is exactly right for a
# process that writes one file in its StateDirectory= and exactly wrong for one
# whose whole job is to write /opt/blitz-bot. `full` keeps /usr, /boot
# and /etc read-only -- both unit files, this unit's sudo grant and the off
# switch all live in /etc, so the update cannot rewrite the rules it runs
# under -- and leaves /opt writable, which git and the install need.
#
# NO NoNewPrivileges=true HERE, AND IT IS DELIBERATE. `sudo` is a setuid
# binary and NoNewPrivileges is precisely the flag that stops one raising
# privileges, so the two cannot both be true. The bot's unit keeps it (section
# 6.4); this unit pays for its last line by giving it up.
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

StandardOutput=journal
StandardError=journal
SyslogIdentifier=blitz-bot-update

# NO [Install] SECTION, DELIBERATELY. Nothing should ever `enable` this unit:
# it is started by its timer and by hand, and an enabled oneshot would also run
# once at every boot -- a deploy triggered by a reboot.
EOF
```

```bash
sudo tee /etc/systemd/system/blitz-bot-update.timer > /dev/null <<'EOF'
[Unit]
Description=Check origin/main for a new blitz-bot commit every fifteen minutes
Documentation=https://github.com/WillMontgomery/blitz-bot

[Timer]
# FIFTEEN MINUTES, AND THE NUMBER IS A TRADE BETWEEN TWO THINGS THE OWNER CAN
# FEEL. It is the longest a push can sit on main without arriving, so it is how
# long "I fixed it" takes to become true. It is also the shortest possible gap
# between pushing something wrong and the box restarting onto it. Shorter, and
# an evening's work is a restart every few minutes; longer, and somebody opens
# an SSH session, which is the habit this timer exists to remove. Ninety-six
# fetches a day against a public repository is nothing to anybody.
#
# A CALENDAR EXPRESSION AND NOT OnUnitActiveSec=, FOR ONE CONCRETE REASON:
# Persistent= below has an effect only on OnCalendar= timers. Written as a
# monotonic interval, that line would be accepted and would silently do
# nothing.
OnCalendar=*:0/15

# systemd records when this timer last ran, on disk. A box that was off -- a
# stopped instance, a reboot that took a while -- comes back, sees that it
# missed a window, and runs the update ONCE, straight away, rather than sitting
# on last week's code until the next quarter hour. Once, and not once per
# missed window: it is a catch-up, not a backlog.
Persistent=true

# WITHOUT THIS THE BOX FETCHES AT :00, :15, :30 AND :45 FOR EVER, on the same
# second as every other thing anybody ever scheduled on the quarter hour --
# including this box's own catch-up after a reboot. Five minutes of spread
# costs nothing when the interval is already an approximation.
RandomizedDelaySec=300

# NO Unit= LINE. A timer starts the service with the same name, and naming it
# again is a second place for the name to be wrong.

[Install]
WantedBy=timers.target
EOF
```

**Check all three before enabling any of them.** A typo in a unit file that is
already enabled becomes a boot-time failure on a box nobody is watching:

```bash
sudo systemd-analyze verify /etc/systemd/system/blitz-bot.service /etc/systemd/system/blitz-bot-update.service /etc/systemd/system/blitz-bot-update.timer
```

**Success prints nothing at all.** Any output is a problem to fix before going
on.

It checks the units, not the world they describe. It will not tell you that
`/usr/local/bin/blitz-bot-update` is missing, that `/opt/node24` is empty, or
that the sudoers drop-in is not there. §7 is where those turn up.

```bash
sudo systemctl daemon-reload
```

**Now prove the sudo grant from §6.3**, which could not be tried until
`blitz-bot.service` existed. Run it as `ubuntu` — the user the update runs as.
On a fresh box the bot has not been started yet, so `try-restart` does nothing
at all; on a box that is already running one, it restarts it once:

```bash
sudo -n /usr/bin/systemctl try-restart blitz-bot.service && echo "the update may restart the bot"
```

Expected:

```
the update may restart the bot
```

`sudo: a password is required` means the drop-in is not in place, or is not
spelled the way the script spells it. Left like that, the update gets as far as
installing the new code and then fails at its last line, every time.

## 7. Start it, and confirm it connected

**The first deploy is the same command every later one is.** Run the update
once, by hand, before the bot has ever started. It installs, it writes
`/opt/blitz-bot/.deployed-commit`, and — because the bot is not running yet — it
restarts nothing:

```bash
sudo systemctl start blitz-bot-update
```

```bash
systemctl status blitz-bot-update --no-pager ; journalctl -u blitz-bot-update -n 20 --no-pager
```

Expected — the unit ends `inactive (dead)`, which is what a finished `oneshot`
looks like and not a fault, and the journal ends on three lines. Nothing has
recorded an install yet, so it does one:

```
2026-08-29T18:04:05.101Z blitz-bot-update: already on 6bbff70
2026-08-29T18:04:07.882Z blitz-bot-update: dependencies installed
2026-08-29T18:04:08.114Z blitz-bot-update: deployed 6bbff70
```

`already on` rather than `updated` is right here: §3 cloned `main` a few
minutes ago, so there was nothing new to fetch. A run always ends on one of two
lines — `deployed`, meaning the bot was restarted onto that commit, or
`no restart`, meaning it was already on it.

If the unit is `failed` instead, read the `<4>` line above it and go to §14.
**Do not start the bot on a box where the update has never worked** — a first
deploy that failed is the cheapest one to fix.

```bash
cat /opt/blitz-bot/.deployed-commit
```

Expected — one short sha and nothing else, and it is the commit the bot will
report when it starts:

```
6bbff70
```

Now the bot:

```bash
sudo systemctl enable --now blitz-bot
```

```bash
systemctl status blitz-bot --no-pager ; journalctl -u blitz-bot -n 30 --no-pager
```

**The separator is `;` and not `&&`, and that is not a style choice.**
`systemctl status` exits 3 when the unit is not running, so with `&&` the
`journalctl` half is skipped on exactly the run that failed — the one run where
the journal is the only thing worth reading.

Now the check that matters. A green `systemctl` says a process is alive; it does
not say the bot connected to Discord. This does:

```bash
journalctl -u blitz-bot -n 200 --no-pager | grep 'msg="ready"' | tail -1
```

Expected — one line, with your own ids in it:

```
2026-08-29T18:04:11.512Z level=info msg="ready" user="blitz-bot" userId="1543345492270915010" guild="Blitz Royale" guildId="1543345492270915002" dryRun=true
```

Three things to read off that line:

- **It printed at all.** No `ready` line means the bot never got a session. Go
  to §14.
- **`dryRun=true`.** This is the whole point of §5. If it says `false`, `.env`
  is not what you think it is — fix it and `sudo systemctl restart blitz-bot`.
- **`guild=` is the Blitz Royale server, by name.** That is the guild it is
  actually moderating.

**Last, turn the timer on.** Until this runs, nothing on this box ever updates
itself; the bot works and stays on the commit it started on for ever.

```bash
sudo systemctl enable --now blitz-bot-update.timer
```

```bash
systemctl list-timers blitz-bot-update.timer --no-pager
```

Expected — one row, with a `NEXT` inside the next twenty minutes. `LEFT` counts
down to it, and `UNIT`/`ACTIVATES` name the timer and the unit it starts:

```
NEXT                        LEFT     LAST PASSED UNIT                     ACTIVATES
Sat 2026-08-29 18:18:43 UTC 13min  -    -      blitz-bot-update.timer   blitz-bot-update.service
```

The exact `NEXT` is not the quarter hour, and that is `RandomizedDelaySec=300`
in §6.5 doing its job. `LAST` and `PASSED` are empty until it has fired once.

**An empty table means the timer is not enabled**, whatever `systemctl status`
says about the unit — and a box in that state looks completely healthy and
never deploys anything again.

### Why the quoted lines here start with a timestamp

Every line this bot writes begins with an ISO-8601 UTC timestamp, and before
that, on the way out of the process, a syslog priority prefix — `<3>` error,
`<4>` warn, `<6>` info (`src/log.ts`). journald reads that prefix off the front
of the line and strips it, so it never reaches `journalctl` at all. It is
visible only if you run the process by hand in a terminal, and the one thing it
buys — `journalctl -p warning` actually filtering by severity — is §13.

**Every log line quoted anywhere in this document is quoted the way
`journalctl` prints it: timestamp first, no prefix.** That is one convention for
the whole file, so a line here can be compared against a line on your screen
character by character.

The `blitz-bot-update:` lines above keep that convention and are not the bot's.
They come from the script in §6.1 rather than from `src/log.ts`, and they carry
a timestamp and a priority for the same two reasons everything else does. They
are also in a **different unit**, so `journalctl -u blitz-bot` does not show
them at all and `journalctl -u blitz-bot-update` shows nothing else. What they
deliberately do not carry is the `msg="..."` shape — so on a box where somebody
reads both units at once, every grep in §12 and §13 that hunts for one of the
bot's own messages goes on missing them.

**Never grep for the start of a line.** `grep '^level='` matches nothing this
bot has ever written, on either side of that strip, and `grep '^<3>'` matches
nothing journald ever stored. Grep for the `msg="..."` part, which is the same
in both places.

## 8. The smoke test, in dry run

**Do not skip this.** Up to here you have proved a process is running and
talking to Discord. You have not proved it reads messages, recognises a foreign
invite, or can post to `#bot-status`. In dry run that proof costs one message
and removes nothing.

First get an invite that is definitely **not** for our guild. In Discord: **+ →
Create My Own → For me and my friends**, name it anything, then **Invite People
→ Copy Link**. That gives you a `https://discord.gg/XXXXXXX` for a server that
is not Blitz Royale.

Post that link in any ordinary channel of the Blitz Royale guild that the bot
can see.

**One:** the message stays up. It is a dry run.

**Two:** a line appears in `#bot-status`, within a second or two:

```
Dry run, nothing removed. Author <@000000000000000000> (`your_username`), channel <#000000000000000000>, reason: foreign-invite, invite codes: XXXXXXX
```

That is the text the bot posts. Discord displays `<@id>` as the account's name
and `<#id>` as a channel link, and renders the username between the backticks as
a code span, so what you actually see reads with names where the ids are. The
mention notifies nobody — the bot suppresses that on the send. The username is
posted alongside it because a mention of an account that has since left or been
banned renders as `@unknown-user`, which is exactly when someone scrolls back to
find out who a removal was about.

**Three:** the journal carries the matching record:

```bash
journalctl -u blitz-bot -n 50 --no-pager | grep 'would have deleted'
```

```
2026-08-29T18:11:02.338Z level=warn msg="dry run: would have deleted message carrying a foreign invite" author="000000000000000000" channel="000000000000000000" reason="foreign-invite" found=1 codes="XXXXXXX"
```

If all three happened, the bot works. Delete the test message yourself.

If the journal line appeared but the `#bot-status` line did not, the bot cannot
post to that channel — see §12.3. If neither appeared, see §12.1.

Post an invite to **our own** guild in the same channel as well. Nothing should
happen, in either place: no channel line, no journal line. That is the half of
the feature that is easy to forget to check, and getting it wrong means the bot
deletes our own invites.

## 9. Going live

Only after §8 has passed, all three parts.

```bash
sed -i 's/^BLITZ_DRY_RUN=true$/BLITZ_DRY_RUN=false/' /opt/blitz-bot/.env
```

Confirm the edit landed:

```bash
grep BLITZ_DRY_RUN /opt/blitz-bot/.env
```

Expected output, exactly:

```
BLITZ_DRY_RUN=false
```

`EnvironmentFile` is read at start, so this needs a restart and not a reload:

```bash
sudo systemctl restart blitz-bot
```

Confirm the bot came back **and that it now says so**:

```bash
journalctl -u blitz-bot -n 200 --no-pager | grep 'msg="ready"' | tail -1
```

The last field must now read `dryRun=false`:

```
2026-08-29T18:20:44.907Z level=info msg="ready" user="blitz-bot" userId="1543345492270915010" guild="Blitz Royale" guildId="1543345492270915002" dryRun=false
```

If it still says `true`, the restart read an unchanged file: check the `grep`
above again.

**Repeat the smoke test from §8**, with the same foreign invite link. This time:

**One:** the message disappears.

**Two:** `#bot-status` says so:

```
Removed a message. Author <@000000000000000000> (`your_username`), channel <#000000000000000000>, reason: foreign-invite, invite codes: XXXXXXX
```

**Three:** the journal agrees:

```bash
journalctl -u blitz-bot -n 50 --no-pager | grep 'msg="deleted'
```

```
2026-08-29T18:21:30.115Z level=info msg="deleted message carrying a foreign invite" author="000000000000000000" channel="000000000000000000" reason="foreign-invite" found=1 codes="XXXXXXX"
```

If the message stayed up and the journal says `delete failed`, the bot is
missing Manage Messages in that channel — §12.2.

The bot is now moderating a live community. Everything below is about keeping it
that way.

## 10. Confirm the console is unharmed

Its own step, because it is the one thing on this box that was already working
before you started.

```bash
systemctl is-active ringmaster
```

Expected output, exactly:

```
active
```

```bash
/usr/bin/node -v
```

Expected output, unchanged from §2:

```
v22.23.2
```

Nothing in this document edits `/opt/ringmaster`, `ringmaster.service` or
`/usr/bin/node`. These two commands are how you prove that rather than assume
it.

## 11. Reboot survival

`systemctl start` and `systemctl enable` are different things, and a bot that
was started but not enabled works perfectly until the next reboot and then never
comes back. The timer has the same trap, and it is quieter: a box whose timer
was started but not enabled goes on moderating and silently stops deploying.

```bash
systemctl is-enabled blitz-bot blitz-bot-update.timer
```

Expected output, exactly — two lines:

```
enabled
enabled
```

If either says `disabled`, enable that one: `sudo systemctl enable blitz-bot`
or `sudo systemctl enable blitz-bot-update.timer`.

**`blitz-bot-update.service` is a third answer, and it is the right one.** It
has no `[Install]` section, so `is-enabled` calls it `static` and there is
nothing to fix. An enabled oneshot would run once at every boot, which is a
deploy caused by a reboot — see §6.5.

## 12. The failure that looks like success

**Everything in §14 announces itself. Nothing in this section does.**

The first three below leave the process up, `systemctl` green, and the bot
showing **Online** in Discord — while it moderates nothing, or fails to remove
anything, or reports to nobody, for the life of the process. The fourth is not a
fault in the bot at all: it is a fault in your ability to see one, and it reads
from the outside exactly like a bot that has never written a line.

**A green `systemctl status` is not evidence that this bot is working.** It says
a process exists. Every check in this section is a check on what that process is
actually doing.

### 12.1 It is not in the guild, or the guild id is wrong

The one that costs the most. A mistyped `DISCORD_GUILD_ID`, or a bot that was
never authorised into the server (or was removed from it): the process connects,
authenticates, stays up — and either moderates nothing at all, or would treat
our own invites as foreign. The startup check catches it and halts, which is
the good outcome, and the halt is written down exactly once.

**The one command that tells this apart from a working bot:**

```bash
journalctl -u blitz-bot -n 200 --no-pager | grep -e 'msg="ready"' -e 'moderation halted'
```

Exactly one of two things comes back.

A `ready` line means the bot is in the guild named on it and is moderating:

```
2026-08-29T18:04:11.512Z level=info msg="ready" user="blitz-bot" userId="1543345492270915010" guild="Blitz Royale" guildId="1543345492270915002" dryRun=false
```

A halt line means it connected and is moderating nothing, permanently:

```
2026-08-29T18:04:11.512Z level=error msg="moderation halted, nothing will be scanned or deleted: DISCORD_GUILD_ID names a guild this bot is not a member of" user="blitz-bot" guild="000000000000000000"
```

Fix: compare `guild=` on that line against *Copy Server ID* (§4.3), correct
`/opt/blitz-bot/.env`, then `sudo systemctl restart blitz-bot`. If the id is
right, the bot is not in the server — redo §4.2.

Nothing comes back at all? The bot never connected. §14.

### 12.2 It cannot delete in one channel

The bot's role is missing **Manage Messages** in a channel — usually a
channel-level override that denies what the guild-level grant gave. The invite
simply stays up. There is no retry, no alert, and nothing in Discord to look at:
one journal line per attempt, and that is the whole of the evidence.

```bash
journalctl -u blitz-bot -n 200 --no-pager | grep 'delete failed'
```

```
2026-08-29T18:31:07.442Z level=error msg="delete failed, message left standing" author="000000000000000000" channel="000000000000000000" reason="foreign-invite" found=1 codes="XXXXXXX" error="DiscordAPIError[50013]: Missing Permissions"
```

The whole message is `delete failed, message left standing`. An earlier version
of this document quoted it as `msg="delete failed"`, and a grep for that string
returns nothing — which reads as "it never happened" for the failure it was
meant to find.

`channel=` is the channel to go and fix. Check that channel's permission
overrides for the bot's role, not just the role's guild-level permissions.

### 12.3 It cannot post to `#bot-status`

`BLITZ_LOG_CHANNEL_ID` points at a channel that does not exist, was deleted, or
that the bot cannot send in. Moderation is completely unaffected — messages are
still removed — but **the only place a non-technical admin would ever see that
happening is empty**, which reads exactly like a bot that has stopped working.

```bash
journalctl -u blitz-bot -n 200 --no-pager | grep -e 'log channel is missing' -e 'could not post to the log channel'
```

A wrong id, or a channel the bot cannot send in:

```
2026-08-29T18:33:19.006Z level=error msg="log channel is missing or cannot be posted to" channel="1543345492270915684"
```

The send itself was rejected:

```
2026-08-29T18:33:19.006Z level=error msg="could not post to the log channel" error="DiscordAPIError[50013]: Missing Permissions"
```

Fix: check `BLITZ_LOG_CHANNEL_ID` in `/opt/blitz-bot/.env` against *Copy Channel
ID* on `#bot-status`, and give the bot's role **Send Messages** there (§4.2).
Then `sudo systemctl restart blitz-bot` and redo the §8 smoke test.

### 12.4 You cannot read the journal, and it looks like an empty one

Every `journalctl` in this document is unsudoed. That is correct on the stock
Ubuntu image, where `ubuntu` is in the `adm` group and `adm` is what journald's
ACLs grant read on the system journal. On a box where that is not true — a
rebuilt image, a hardened AMI, a different login — `journalctl -u blitz-bot`
does not refuse. It reads the only journal you are allowed to read, which is
your own, finds nothing in it for a system unit, prints `-- No entries --`, and
**exits 0**. Piped into a `grep`, as most of the commands in this document are,
even that much disappears and you are left looking at a blank line.

Which is indistinguishable, on the screen, from a bot that has logged nothing.
That is this section's failure exactly — a green `systemctl`, an Online bot, no
evidence — except that here it is your access that is missing and the bot may be
in perfect health.

**The one command that tells this apart:**

```bash
id -nG | grep -q adm && echo "in adm: journalctl reads the system journal" || echo "NOT in adm: journalctl -u blitz-bot will print nothing regardless"
```

Some systemd versions print a one-line hint about the `adm` and
`systemd-journal` groups alongside the empty output, and older ones say nothing
at all. Do not go by that: not seeing the hint is not evidence of access.

If it says `NOT in adm`, read the journal with `sudo` — that always works, and
answers the question you actually had:

```bash
sudo journalctl -u blitz-bot -n 50 --no-pager
```

Lines there and nothing without `sudo` is the whole diagnosis. To stop paying
for it on every command, put the login back in the group and start a **new** SSH
session, because group membership is fixed at login:

```bash
sudo usermod -aG adm ubuntu
```

Check §12.1 through §12.3 again afterwards. Anything you concluded from a
`journalctl` that returned nothing was concluded from no data at all.

## 13. Logs — the last resort, not the dashboard

**Nothing in this section is a daily habit.** The journal is where you go when
the bot has stopped being able to tell you anything itself: it will not start,
or it is up and moderating nothing, or something happened in the guild that has
no line to match it.

**Removals do reach admins without an SSH session.** Every removal, and every
dry-run would-be removal, is posted to `#bot-status` through
`BLITZ_LOG_CHANNEL_ID`. That is built and it is what §8 tested.

**The bot's own faults do not.** A delete that failed, moderation halted at
startup, a gateway that will not stay connected: those exist in the journal and
nowhere else, so they are seen only by somebody who already suspected something
and opened an SSH session to check. Sending the bot's own faults to `#bot-status`
is **tracked as issue #9 and is not built yet**; until it is, everything below is
the only way those lines are ever read.

```bash
journalctl -u blitz-bot -f
```

One line per event, logfmt — a timestamp, a level, a message, then `key=value`
pairs, chosen to survive being grepped one at a time (`src/log.ts`).

Every line also carries a syslog priority that journald reads and strips, so
severity filtering works without parsing the line:

| Level | Priority | Matched by |
|---|---|---|
| `error` | `<3>` | `-p err`, and `-p warning` |
| `warn` | `<4>` | `-p warning` |
| `info` | `<6>` | `-p info` — everything this bot emits |

```bash
journalctl -u blitz-bot -p warning --since today
```

`-p warning` means severity 4 **and anything more severe**, so that one command
is "everything that went wrong today" — warnings and errors, no info. If it
prints nothing, that is a quiet day and not a broken filter; confirm with
`journalctl -u blitz-bot -n 20`, which filters nothing.

**The update is a different unit and has its own journal.** Nothing above shows
it, and it shows nothing of the bot's:

```bash
journalctl -u blitz-bot-update -n 50 --no-pager
```

An update that failed is written at `<4>` there, so the same `-p warning`
filter finds it — and unlike the bot, it also leaves the unit `failed`, which
`systemctl status blitz-bot-update` says on its first line:

```bash
journalctl -u blitz-bot-update -p warning --since today
```

For both units at once, interleaved in the order things actually happened —
which is the view that shows an update landing and the bot coming back on it:

```bash
journalctl -u blitz-bot -u blitz-bot-update -f
```

If *that* also prints nothing, do not conclude the bot has been silent — check
§12.4 first. An operator who cannot read the system journal gets an empty page
from every command in this section and no error to say so.

> This used to be a lie. The priority prefix is new. Before it, `log.ts` and
> this file both claimed the journal could tell warnings from info because
> warnings were written to stderr — journald does not work that way, it stamps
> both streams with the same default priority, and `-p warning` printed an empty
> page no matter how badly the bot was failing. If you are on a box that has not
> been updated since, that command is not evidence of anything.

## 14. When it will not start: the silent restart loop

**This is the failure that wastes an evening, so read it before you need it.**

**A crash loop deploys nothing.** Every restart below relaunches the code
already in `/opt/blitz-bot`: the bot's unit fetches nothing and installs
nothing (§6.4), and the update runs on its own timer whatever the bot is doing.
So the commit that is looping is the commit that was there before it started
looping, and it will still be there when you get to it.

The unit has `Restart=always`, `RestartSec=5` and `StartLimitIntervalSec=0`.
The last one deliberately removes systemd's "give up after five failures" rule,
because a Discord outage should not turn into an outage of our own. The cost is
that **a bot that can never start retries forever**, five seconds apart, and a
single mistyped variable is enough to keep it there: `src/config.ts` throws on
one, and `src/index.ts` is what catches that and exits 1. One typo in `.env` is
therefore twelve failed starts a minute, and with systemd's own start, fail and
scheduled-restart lines wrapped around each one, roughly sixty lines a minute
into the journal — indefinitely, or until somebody notices.

What makes it expensive is how it reads:

```
Active: activating (auto-restart) (Result: exit-code)
```

**`activating` does not mean "still starting".** Nothing here takes longer than
a second or two to start. `activating (auto-restart)` means it started, died,
and is in the gap before the next attempt — it will say that for as long as the
box is up. There is no timeout and nothing turns it red.

Look at the journal, not at the status line:

```bash
journalctl -u blitz-bot -n 50 --no-pager
```

Then tell the cases apart by **what the repeating line says**.

### A bad or missing variable

The process never reached Discord. `src/config.ts` builds this message and
throws it; `src/index.ts` catches it and writes it straight to stderr rather
than through `log()`, so unlike every other line this process emits it carries
**no timestamp and no priority prefix** — and there is correspondingly nothing
at the front of it to anchor a grep on:

```
Invalid configuration:
  DISCORD_BOT_TOKEN: not set
  DISCORD_GUILD_ID: set but empty

See .env.example
```

The two sub-messages are the whole diagnosis, and they mean different things:

| Sub-message | What it means |
|---|---|
| `not set` | The variable is not in `/opt/blitz-bot/.env` at all — deleted, or misspelled. |
| `set but empty` | The line is there and there is nothing after the `=` (or only spaces). |

A mistyped `true`/`false` names itself the same way:

```
Invalid configuration:
  BLITZ_DRY_RUN: must be "true" or "false", got "ture"
```

Fix `/opt/blitz-bot/.env`, then `sudo systemctl restart blitz-bot`. §5 lists the
three ways that file bites.

### Everything else

| What repeats | What it is | What to do |
|---|---|---|
| `msg="login failed"` with `error="Error: Used disallowed intents"` | The Message Content intent is off in the portal. | §4.1. It will loop until you tick it; the token is fine. |
| `msg="login failed"` with `error="DiscordjsError [TokenInvalid]: An invalid token was provided."` | Wrong, rotated or revoked token. | New token in the portal, into `.env`, restart. |
| `msg="login failed"` with a timeout, DNS or connection error, **or** repeating `msg="gateway disconnected"` lines from a process that stays up | Discord, or this box's network. Not us. | Nothing to fix here. Check <https://discordstatus.com>. `Restart=always` is doing its job; it will reconnect on its own. |

In full, as the journal shows them:

```
2026-08-29T18:04:11.180Z level=error msg="login failed" error="Error: Used disallowed intents"
```

```
2026-08-29T18:04:11.180Z level=error msg="login failed" error="DiscordjsError [TokenInvalid]: An invalid token was provided."
```

Both of those strings are discord.js's own wording, reproduced verbatim by
`src/index.ts` — grep for `Used disallowed intents` and `An invalid token was
provided.` respectively.

The short version: **a config or intent problem never gets as far as a `ready`
line, and a Discord outage always does.** If the journal contains a `ready` from
this boot, the bot's own configuration is fine and the problem is on the other
end of the websocket.

### An update that failed

**An update failure cannot stop the bot, and a bot failure cannot stop an
update.** They are two units, and neither one is in the other's start. So none
of the below shows up in `systemctl status blitz-bot`, in the bot's journal, or
in Discord — it is all in one place:

```bash
systemctl status blitz-bot-update --no-pager ; journalctl -u blitz-bot-update -n 40 --no-pager
```

A failed update leaves that unit **red**, which the version before this one
could not do: it ran inside the bot's start, so it had to swallow every failure
to avoid taking the bot down with it.

| What the journal says | What it is | What to do |
|---|---|---|
| `blitz-bot-update: fetch failed -- nothing was changed` | github.com was unreachable, or the fetch took longer than 60 seconds. The tree was not touched and the bot was not restarted, which is the correct outcome. | Nothing — the next tick tries again in fifteen minutes. If it repeats for hours, test this box's outbound network the way §1 does. |
| `blitz-bot-update: install failed -- 4a1c9de is on disk and the bot was NOT restarted` | **The tree is ahead of the running process.** `npm ci` deletes `node_modules` before it installs and this one did not finish, so the code on disk is new and its dependencies are missing. The bot is still running the old code out of memory and is completely fine. **A restart right now would not be.** | Nothing at first: the lockfile stamp is written only on success, so the next tick installs again, and it will restart the bot then. If it does not clear, run the install by hand (§16) where you can read its output — and do not restart the bot until it does. |
| `blitz-bot-update: restart failed -- 4a1c9de is installed but blitz-bot did not come back` | The update worked; the bot did not start on the new code. This is a bot failure, not an update one. | The rest of §14. The tree and `/opt/blitz-bot/.deployed-commit` are already on the new commit, so a rollback is §16's, not a re-run of the update. |
| `blitz-bot-update: skipped: /etc/blitz-bot-no-update exists` | Somebody switched updating off (§16) and did not switch it back on. **The box is deploying nothing at all**, on a timer that goes on firing and reporting success. | `sudo rm /etc/blitz-bot-no-update` once `main` is trustworthy again, then `sudo systemctl start blitz-bot-update`. |

**The reason is in the journal, and `-p warning` will not show it to you.**
The script's own lines carry a priority — every failure above is `<4>` — but
the raw output of `git` and of the install does not, and journald stamps an
unprefixed line `info`. So `journalctl -u blitz-bot-update -p warning` tells
you *that* an update failed and never *why*. Drop the `-p warning` and read the
lines above it.

**If the bot is also crash-looping, fix that first.** A bot that cannot start is
the outage; an update that failed is a deploy that did not happen, and the code
that was working an hour ago is still what is running.

To stop the noise while you work on it:

```bash
sudo systemctl stop blitz-bot
```

A stopped bot moderates nothing, which is the same as a crash-looping bot,
except you can read the journal.

## 15. AWS

**The bot uses the box's instance role, and nothing in this slice calls AWS at
all.** No SDK is installed, no credentials are configured, and there is nothing
to set up here today.

That is worth writing down anyway, because of what it would mean the moment it
stopped being true: the instance role on this box belongs to the **console**,
and carries the console's DynamoDB access. Any AWS call the bot ever made would
arrive with the console's permissions over the console's tables — a moderation
bot holding admin-console credentials because of where it happens to be
running.

Scoping the bot to its own IAM user with its own policy is tracked as
**issue #4**. Do that before the first AWS call, not after.

## 16. Deploying an update

**Land the code on `main` and the box picks it up by itself, within about
fifteen minutes.** `blitz-bot-update.timer` starts the update (§6.5); the
update fetches, resets onto `origin/main`, installs if the lockfile moved, and
**restarts the bot only if the commit it is running is not the commit on
disk**. A quarter of an hour in which nothing was pushed costs one fetch and
nothing else — no restart, no reconnect, no line in `#bot-status`.

**To have it now, one command:**

```bash
sudo systemctl start blitz-bot-update
```

That starts the same unit the timer starts. It is not a shortcut past the
timer and it is not a second way of deploying: one script, one unit, one path,
and the timer and the operator are two ways of triggering it. Anything that
goes wrong goes wrong identically at 3pm by hand and at 3am on the timer.

Then read what it did:

```bash
journalctl -u blitz-bot-update -n 20 --no-pager
```

Expected, when something had landed on `main`:

```
2026-08-29T18:31:01.994Z blitz-bot-update: updated 6bbff70 -> 4a1c9de
2026-08-29T18:31:02.480Z blitz-bot-update: dependencies unchanged
2026-08-29T18:31:03.021Z blitz-bot-update: deployed 4a1c9de
```

and when nothing had:

```
2026-08-29T18:46:02.113Z blitz-bot-update: already on 4a1c9de
2026-08-29T18:46:02.402Z blitz-bot-update: dependencies unchanged
2026-08-29T18:46:02.418Z blitz-bot-update: no restart: blitz-bot is already on 4a1c9de
```

**`deployed` is the line that means the bot was restarted.** `no restart` means
it was left alone, on purpose, and is the line you should see three times an
hour. Anything at `<4>` is §14.

**The bot says which commit it is running, in `#bot-status`, when it comes
back.** It reads `/opt/blitz-bot/.deployed-commit` at startup (§6.2) — the file the
update writes immediately before restarting it — so that message is the running
process's own answer and not the disk's.

No build step, by design — Node runs the source. See the header comment in
`tsconfig.json` for what that buys and what it costs.

### Is a shorter command worth it?

**No, and it was considered.** `sudo systemctl start blitz-bot-update` is
already one line to paste, and the alternative — a
`/usr/local/bin/blitz-bot-deploy` that runs it — is a second name for one
action: a second file outside the repo, a second thing to install on the next
box, a second thing for this document to be wrong about, and a second place
somebody will eventually add a step to. The name it would save is the name that
also appears in every `systemctl` and `journalctl` command in this section, so
learning it once is not optional anyway.

A shell alias in somebody's `~/.bashrc` is worse still: it works for one login
on one box, and it is invisible to everybody debugging beside them.

**The command the owner actually wants is one he can type in Discord**, and
that is the bot's work rather than this file's. Nothing here is a substitute
for it, and a wrapper script is not a step towards it.

### What is automatic now, and what is not

| What changed | What happens on its own | What you do |
|---|---|---|
| **New code on `main`** | The timer fetches it within about fifteen minutes, installs if the lockfile moved, and restarts the bot — **because the commit changed, and only then.** | Nothing. `sudo systemctl start blitz-bot-update` if you would rather not wait. |
| **The bot crashed** | systemd restarts it on the code already on disk, five seconds later, for as long as it takes. | Nothing — and note what does *not* happen: **a crash does not deploy.** §14. |
| **`/opt/blitz-bot/.env`** | Nothing. `EnvironmentFile` is read at start. | `sudo systemctl restart blitz-bot`. The update cannot touch `.env` — it is untracked and ignored, which is checked below rather than assumed. |
| **A unit file, or the timer** | Nothing. They are outside the repo, so no push and no update will ever deploy an edit to one. | `sudo systemctl daemon-reload`, then restart what you changed — `blitz-bot`, or `blitz-bot-update.timer`. |
| **`/usr/local/bin/blitz-bot-update`** | Nothing. Also outside the repo. | `sudo chmod 755` if it is new. No `daemon-reload` — systemd is not caching it, it is exec'd fresh at every run. |
| **`/etc/sudoers.d/blitz-bot-update`** | Nothing. | Re-check it with `visudo -c` and re-run §6.3's proof. Nothing to reload; sudo reads it per call. |
| **Node 24 itself** | Nothing. | §2, by hand. `/opt/node24` is set up once and no deploy touches it. |
| **A tracked file you edited on the box** | It is destroyed at the next **update** — up to fifteen minutes away, and not at the next start. | Nothing. It is already gone, or it will be. See directly below. |

### The hard reset discards local edits. That is the intended behaviour.

**Anything under `/opt/blitz-bot` that git tracks, and that you edit in place,
is destroyed at the next run of the update.** Not merged, not warned about
— overwritten with whatever `main` says, silently, by
`git reset --hard origin/main`.

Read that before you fix something in place at 3am. The way to change what runs
on this box is to change `main`; the way to try something on the box without
losing it is to copy the file somewhere outside `/opt/blitz-bot` first. **The
window is fifteen minutes and there is no warning in it**: the update runs on a
timer whether or not anybody is watching, and it resets the tree even on a tick
where the commit did not move.

`reset --hard` rather than `git pull`, for three reasons that all bite here:

- **`git pull` refuses outright** when a tracked file has been modified
  locally: `error: Your local changes to the following files would be
  overwritten by merge`, followed by `Aborting`, and nothing updated. On a
  deploy box that is a failed deploy caused by a stray edit nobody remembers
  making.
- **`git pull` can leave a merge commit**, and then the box sits at a commit
  that exists nowhere else — not on `main`, not in any pull request. What is
  deployed stops being a thing anybody can look up.
- **A merge commit needs a `user.name` and `user.email`**, and under
  `ProtectHome=true` the update has no home directory to read a `.gitconfig`
  from. So the merge case does not merely produce something unwanted, it fails.

`git fetch` plus `git reset --hard origin/main` has none of those: it ends at
exactly `origin/main`, on the `main` branch, with no commit of its own.

**`/opt/blitz-bot/.env` is not one of the files at risk, and that was checked
rather than assumed.** Three checks, all of which anybody can repeat:

- `git ls-files` in this repo lists `.env.example` and no `.env`, and
  `git log --all -- .env` is empty. The file has never been committed, so there
  is no version of it anywhere for a reset to restore over yours.
- `git check-ignore -v .env` answers `.gitignore:9:.env`. It stays untracked no
  matter what lands on `main`.
- On a scratch clone with the same `.gitignore`, a tracked file edited in place
  and an ignored `.env` present: `git pull` refused and changed nothing, and
  then `git fetch origin` plus `git reset --hard origin/main` put the tracked
  file back to `main`'s content, produced no merge commit, left `HEAD` on
  `main` at exactly `origin/main` — and left `.env` byte for byte as it was.

The one thing that *would* overwrite it is somebody committing a `.env` to the
repo, at which point it is a tracked file like any other. Do not; the comment in
`.gitignore` explains what that costs.

`/opt/blitz-bot/.deployed-commit` survives for the same reason: untracked, so
the reset walks past it. It is the update that rewrites it, deliberately, and only when
it deploys.

There is also **no `git clean`** in the update, deliberately. `git clean -x`
would tidy the tree by deleting exactly three things this box cannot lose:
`.env`, `.deployed-commit` and `node_modules`.

### Rolling back, with no network and no good commit to fetch

**Every update tags the commit the box was leaving, before it overwrites it**
(§6.1):

```
git tag -f blitz-bot-previous <the sha the box was on>
```

So the last commit this box was actually running is still in
`/opt/blitz-bot/.git` with a name on it. It does not depend on the reflog, it
does not expire, and getting back to it needs no network at all — which is the
point, because "`main` is bad" and "github.com is unreachable" are both reasons
to be doing this.

**The off switch first, and not optionally.** Without it the next tick of the
timer resets the tree straight back onto `origin/main` and undoes the rollback
within fifteen minutes, silently:

```bash
sudo touch /etc/blitz-bot-no-update
```

```bash
cd /opt/blitz-bot && git reset --hard blitz-bot-previous
```

```bash
cd /opt/blitz-bot && /opt/node24/bin/node /opt/node24/lib/node_modules/npm/bin/npm-cli.js ci
```

```bash
rm -f /opt/blitz-bot/.deployed-commit
```

```bash
sudo systemctl restart blitz-bot
```

**Deleting `.deployed-commit` is part of the rollback and not tidying up.** That file
says which commit the bot is running, and nothing but the update maintains it —
so after a rollback by hand it is a lie. Deleted, the bot reports that it does
not know, which is true and is the honest thing for it to say in `#bot-status`
(§6.2).

**This buys time; it is not the fix.** Revert on `main`, then:

```bash
sudo rm /etc/blitz-bot-no-update
```

```bash
sudo systemctl start blitz-bot-update
```

A box pinned to a commit that exists nowhere in the branch history is a box
whose running code nobody can look up.

**`blitz-bot-previous` only ever names the commit before the last update.** Two
updates and the one you wanted is not on it any more. It is one step back, not
a history.

### Stopping the box from updating itself

**For when `main` is broken and nothing new should reach the box.** The update
script reads one file before it does anything else, so this works even if the
rest of the script is the thing that is broken:

```bash
sudo touch /etc/blitz-bot-no-update
```

The bot goes on running exactly what it is running. Every tick of the timer,
and every `sudo systemctl start blitz-bot-update` anybody types, now does
nothing but say so — at `<6>`, in a unit that reports success, so **a box left
like this looks completely healthy and deploys nothing for ever**:

```
2026-08-29T19:02:44.118Z blitz-bot-update: skipped: /etc/blitz-bot-no-update exists
```

That line is the reason this is a file rather than a flag somebody has to
remember. **Turn it back on** once `main` is trustworthy again — reverting on
`main` is the fix, not leaving the box pinned:

```bash
sudo rm /etc/blitz-bot-no-update
```

```bash
sudo systemctl start blitz-bot-update
```

To roll `main` back, revert on `main` rather than checking out an old commit on
the box. A detached `HEAD` in `/opt/blitz-bot` does not survive here: the next
tick of the timer resets it onto `origin/main` and undoes the rollback without
saying anything.

### Updating by hand

Two cases need it. The first is wanting to see what the install actually says —
the unit throws away the output of a failed install and keeps one line about it.
The second is a box where the update is switched off, above, and the code has
to move anyway.

```bash
cd /opt/blitz-bot && git fetch origin && git reset --hard origin/main
```

```bash
cd /opt/blitz-bot && /opt/node24/bin/node /opt/node24/lib/node_modules/npm/bin/npm-cli.js ci
```

```bash
sudo systemctl restart blitz-bot
```

**`node` is named first, and `npm` is never run through its shebang** — the
reason is §3's. `/opt/node24/bin/npm` is a script that resolves its own
interpreter off `PATH`, so it runs on the console's Node 22 no matter how
absolute the path to it is. **This document used to say that path was enough,
and it was wrong**; a deploy by hand is the moment that mistake is easiest to
make and hardest to see.

**Moving the code by hand leaves `/opt/blitz-bot/.deployed-commit` wrong**, because
nothing but the update writes it. Either delete it, so the bot says it does not
know —

```bash
rm -f /opt/blitz-bot/.deployed-commit
```

— or, if the update is not switched off, skip all of the above and let
`sudo systemctl start blitz-bot-update` move the code and the file together.

### What this section used to say

**Two rounds ago** it argued against a restart ever fetching: that a restart
should relaunch what is on disk, because otherwise `Restart=always` becomes a
deployment mechanism and a crash at 3am ships whatever happens to be on `main`.

**Last round it documented exactly that** — an `ExecStartPre` on the bot's own
unit, running the update before every start. **That was reviewed and rejected,
and it is gone.** Three things were wrong with it, and none of them were fixable
inside it:

- **`npm ci` deletes `node_modules` before it installs**, so an install that
  failed left the bot with no dependencies at all — while systemd was starting
  it again every five seconds, into that tree.
- **`reset --hard` during a crash loop** overwrote the last-known-good tree with
  nothing holding a reference to it.
- **`Restart=always` meant any crash deployed** whatever was on `main` at that
  moment.

The original argument was right, and what it was right about was the coupling:
starting the bot and deploying the bot are two different events, and one unit
cannot do both without one of them triggering the other. They are two units
now. **A crash restarts. Only the timer and the operator deploy.**

What the owner asked for is still what he gets — a bot that updates without an
SSH session — and it now arrives on a schedule he can predict rather than on a
failure he cannot.

**The box tracks `main`.** That is the branch policy (see the README), and it
holds after go-live too.

Node 24 is not reinstalled by a deploy. `/opt/node24` is set up once, in §2, and
nothing here touches it.

## Checks

```bash
systemctl is-active blitz-bot ringmaster
```

Two lines, both `active`, and neither one caused the other. If you want to prove
the independence rule rather than trust it, stop either service and watch the
other keep running — nothing in either unit references the other, and they do
not even share a Node binary.

```bash
systemctl is-active blitz-bot-update.timer
```

One line, `active`. **This is the one nobody would miss.** The bot goes on
moderating perfectly with the timer stopped; it just never picks up another
commit, and nothing anywhere says so.

And once more, because it is the thing this document exists to prevent: **every
line above saying `active` is not evidence that the bot is moderating.** §12 is.
