# Deploying blitz-bot

**This is the runbook for installing, first-running and updating the bot over
SSH, and that is all it is.** It is not how the bot is watched day to day.

Read it top to bottom the first time. Every command block is meant to be pasted
whole, one block at a time, and every block below is written so that there is no
decision to make in the middle of it.

Two things govern the whole document:

- **The Ringmaster console runs on this box and must not be touched.** Nothing
  here changes the console's runtime, its unit, or its files.
- **The bot's first run is a dry run.** `BLITZ_DRY_RUN=true` until you have
  watched it report what it *would* have removed. It gets to delete things in a
  live community only in §9, after §8 has proved it does the right thing.

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
- **They are updated separately.** Two directories, two `git pull`s, two
  `systemctl restart`s. There is no command in this file that touches
  `/opt/ringmaster`.

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
either one names it by absolute path — the unit file's `ExecStart` in §6, and
every `npm` in §3 and §16.

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
cd /opt/blitz-bot && /opt/node24/bin/npm ci
```

**The absolute path to `npm` is the load-bearing part of that line.**
`/opt/node24/bin` is deliberately off everyone's `PATH` (§2), so a bare `npm`
here is not the bot's npm at all — it is the console's, running on
`/usr/bin/node` v22.23.2, which is the one runtime this document promises the
bot never touches. Adding `/opt/node24/bin` to `PATH` would fix this line and
break something larger: it would change which `node` the **operator's** shell
finds, and the console's own maintenance commands are run in that shell.

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
spells the path out instead of trusting `PATH` to come out right.

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

`.env` is gitignored, so `git pull` will never touch it, and the secret cannot
reach the repo by accident.

## 6. The unit

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
Restart=always
RestartSec=5

# The process writes nothing to disk -- no build output, no cache, no state. So
# `ProtectSystem=strict` needs no `ReadWritePaths` at all, and the running
# service cannot modify its own source. Deploys happen outside the unit, as
# ubuntu.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

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

**Check the unit before enabling it.** A typo in a unit file that is already
enabled becomes a boot-time failure on a box nobody is watching:

```bash
sudo systemd-analyze verify /etc/systemd/system/blitz-bot.service
```

**Success prints nothing at all.** Any output is a problem to fix before going
on.

```bash
sudo systemctl daemon-reload
```

## 7. Start it, and confirm it connected

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
comes back.

```bash
systemctl is-enabled blitz-bot
```

Expected output, exactly:

```
enabled
```

If it says `disabled`, run `sudo systemctl enable blitz-bot`.

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

```bash
cd /opt/blitz-bot && git pull && /opt/node24/bin/npm ci && sudo systemctl restart blitz-bot
```

Then confirm it came back, every time:

```bash
journalctl -u blitz-bot -n 200 --no-pager | grep 'msg="ready"' | tail -1
```

No build step, by design — Node runs the source. See the header comment in
`tsconfig.json` for what that buys and what it costs.

The restart is a separate word on the line for a reason: a restart should
relaunch what is on disk, not silently fetch new code. Otherwise the unit's
`Restart=always` becomes a deployment mechanism, and a crash at 3am ships
whatever happened to be on `main` at that moment.

**The box tracks `main`.** That is the branch policy (see the README), and it
holds after go-live too — `dev` is where work lands, `main` is what is
deployed, and the pull request between them is the review.

To roll back, revert on `main` and pull, rather than checking out an old commit
on the box. A detached HEAD in `/opt/blitz-bot` is a box that no longer matches
any branch, and the next person to run the line above will silently undo the
rollback.

Node 24 is not reinstalled by a deploy. `/opt/node24` is set up once, in §2, and
a `git pull` never touches it. `npm` is spelled out in full here for the reason
§3 gives: a bare `npm` on this box is the console's, on Node 22, and a deploy is
the moment that mistake is easiest to make and hardest to see.

## Checks

```bash
systemctl is-active blitz-bot ringmaster
```

Two lines, both `active`, and neither one caused the other. If you want to prove
the independence rule rather than trust it, stop either service and watch the
other keep running — nothing in either unit references the other, and they do
not even share a Node binary.

And once more, because it is the thing this document exists to prevent: **both
lines saying `active` is not evidence that the bot is moderating.** §12 is.
