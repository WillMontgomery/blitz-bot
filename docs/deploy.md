# Deploying blitz-bot

How this runs in production.

**This is the runbook for installing and updating the bot over SSH, and that is
all it is.** It is not how the bot is watched. The journal in §6 is what you
reach for when the bot has stopped being able to tell you anything itself — a
last resort, not a thing to open daily.

## Where it runs

| | |
|---|---|
| **Box** | Ringmaster, `ip-10-0-133-69` (private IP `10.0.133.69`) |
| **Region** | us-east-2 |
| **Directory** | `/opt/blitz-bot` |
| **Unit** | `blitz-bot.service` |
| **Also on this box** | the Next.js admin console — `ringmaster.service`, `User=ubuntu`, `/opt/ringmaster` |

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
- They share no socket, no port, no file and no database handle. The only
  things they have in common are the kernel and the system Node.
- **Either may be down, and the other will not notice.** The console is what
  admins reach for while something is going wrong; a bot in a crash loop must
  not take it with it. Equally, deploying the console must not stop moderation
  for the ninety seconds of an `npm run build`.
- **They are updated separately.** Two directories, two `git pull`s, two
  `systemctl restart`s. There is no command in this file that touches
  `/opt/ringmaster`.

If the two ever do need to talk, they talk over HTTP with a timeout and a
failure path, like strangers. They do not become one unit.

## 1. Node — the one thing they genuinely share

The bot needs **Node 24** and will not run on less: it executes TypeScript
straight from `src/`, and an older major does not warn about a `.ts` file, it
fails to parse it. There is no build step to hide behind.

Both services run the same `/usr/bin/node`. Check what is there before changing
anything:

```bash
node -v
```

If it is already `v24.x`, skip this section. If it is older, **moving the
system Node is a change to both services**, and it is the one moment where the
independence rule above needs a human to hold both halves in their head:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
```

```bash
sudo apt install -y nodejs && node -v
```

Then restart the console and confirm it came back **before** going further:

```bash
sudo systemctl restart ringmaster && systemctl status ringmaster --no-pager
```

> If the console cannot move to Node 24 for some reason, do not force it. Give
> the bot its own runtime instead — install Node 24 under `/opt/node24` and
> point the unit's `ExecStart` at `/opt/node24/bin/node`. That costs one
> absolute path and keeps the two services genuinely independent, which is
> worth more than a tidy `node -v`.

## 2. The code

```bash
sudo mkdir -p /opt/blitz-bot && sudo chown "$USER:$USER" /opt/blitz-bot
```

```bash
git clone https://github.com/WillMontgomery/blitz-bot.git /opt/blitz-bot
```

```bash
cd /opt/blitz-bot && npm ci
```

`npm ci` rather than `npm install`: it installs exactly what
`package-lock.json` pins and fails if the lockfile and `package.json` disagree,
instead of quietly resolving something newer than what was tested.

A separate directory from `/opt/ringmaster` is what makes "updated separately"
true rather than aspirational.

## 3. The environment file

```bash
cd /opt/blitz-bot && cp .env.example .env && nano .env
```

Fill in `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`. Everything else has a
documented default and can stay as it is. `.env.example` explains each one.

Three things about this file, because systemd's `EnvironmentFile` is **not** a
shell and the differences are all silent:

- **No `export`.** systemd would read the variable's name as `export
  DISCORD_BOT_TOKEN` and the bot would refuse to start saying the token is not
  set, which is a confusing way to be right.
- **No quotes around the token**, and no trailing comment on the same line.
  Bot tokens are plain `A-Za-z0-9._-`, so there is nothing to quote.
- **`KEY=` with nothing after it counts as absent**, deliberately —
  `src/config.ts` trims before it checks, so a stray space is not a
  one-character token.

Then lock it down. This file is the bot's Discord identity:

```bash
chmod 600 .env
```

`.env` is gitignored, so `git pull` will never touch it, and the secret cannot
reach the repo by accident.

## 4. Discord — do this before you start the service

None of the above gets you a working bot. The token in `.env` is only half of
it: the application it belongs to has to be configured, invited, and pointed at
the right guild. Get any of the three wrong and the box shows you something
other than the mistake — a restart loop, a bot that looks perfectly healthy and
removes nothing, or a bot that has stopped moderating with `systemctl status`
still green. Each subsection names the line in the journal that tells its own
failure apart from the other two.

### 4.1 Turn on the Message Content intent

**Developer Portal → your app → Bot → Privileged Gateway Intents → Message
Content → on → Save.**

The bot requests this intent at connect time (`src/client.ts`). Requesting an
intent the application has not been granted is not a warning — Discord closes
the gateway with **close code 4014, "Disallowed intent(s)"**, `login()`
rejects, and the process exits 1. With `Restart=always` below, that is a
restart loop. The signature in the journal is a `login failed` line whose
`error=` field says the intents were disallowed:

```
level=error msg="login failed" error="... disallowed intents ..."
```

**There is no quiet version of this failure.** The identify is rejected, so
there is no session: the process never logs `ready`, never receives a message,
and never deletes or fails to delete anything. That cuts both ways, and the
second half is the one worth carrying — **a `ready` line from this boot is
proof the intent is on.** So if invites are being posted and nothing is being
removed, look at what this boot logged: a `ready` means the intent is not your
problem and Manage Messages (§4.2) is the next thing to check, and a boot with
neither a `ready` nor a `login failed` is the halt in §4.3.

> This section used to claim the opposite as the ordinary case: a bot that
> connects, logs a healthy `ready`, receives every message and reads
> `message.content` as the empty string for all of them, deleting nothing and
> looking like a quiet week. That is what a client which never *requests*
> `MessageContent` sees, and `src/client.ts` requests it on every connection,
> so it is not a state this bot can reach — the header comment in that file now
> says so in as many words. The cost of the wrong story was that it sent anyone
> debugging the restart loop off to read the regex in `invites.ts` instead of
> the close code already in their journal.

### 4.2 Invite the bot to the guild

**Developer Portal → your app → OAuth2 → OAuth2 URL Generator.**

- **Scopes:** `bot`. Only `bot` — this bot registers no slash commands, so
  `applications.commands` would be a permission nobody uses.
- **Bot Permissions:** **Manage Messages**. That is the one permission the
  feature needs: it is what allows deleting somebody else's message. Without it
  every delete fails with `Missing Permissions`, the journal fills with
  `msg="delete failed"`, and the bot otherwise looks perfectly healthy.
- **View Channel** it normally inherits from `@everyone`. In a guild where
  channels are locked down, the bot's role needs it explicitly — it cannot
  moderate a channel it cannot see, and it will not say so.
- If `BLITZ_LOG_CHANNEL_ID` is set, the bot also needs **Send Messages** in
  that one channel. A channel override is enough; it does not need it guild-wide.

Open the generated URL, pick the Blitz Royale guild, authorise. Then check the
role Discord created for the bot actually carries Manage Messages in the
channels you care about — a channel-level override that denies it beats the
guild-level grant, silently.

### 4.3 Get the guild and channel ids

**Discord client → User Settings → Advanced → Developer Mode → on.** Then
right-click and *Copy Server ID* for `DISCORD_GUILD_ID`, *Copy Channel ID* for
`BLITZ_LOG_CHANNEL_ID` and `BLITZ_EXEMPT_CHANNEL_IDS`, and *Copy Role ID* on a
role in Server Settings → Roles for `DISCORD_ADMIN_ROLE_ID`. They are all
17–20 digit snowflakes; if what you pasted has letters in it, it is a name and
not an id.

`DISCORD_GUILD_ID` is not decoration. It is the one thing that separates "our
invite, leave it" from "somebody else's invite, delete it", so a wrong one does
not make the bot idle — it makes every invite to *our* server look foreign, and
the bot deletes our own invites in whatever guild it is actually sitting in.

Which is why the startup check does not warn and carry on. If the bot is
connected but is not a member of the configured guild, it **halts moderation
for the life of the process**: it takes its own message listeners back off,
scans nothing, deletes nothing, and writes one line saying so.

```
level=error msg="moderation halted, nothing will be scanned or deleted: DISCORD_GUILD_ID names a guild this bot is not a member of" user="blitz-bot#0001" guild="000000000000000000"
```

`guild=` is the id it was told to moderate — the one to compare against *Copy
Server ID* — and `user=` is the bot it actually connected as, which is the
faster check when one application has been pointed at the wrong server.

There is no way back from that line except fixing `.env` and
`systemctl restart blitz-bot`, deliberately: every route back to moderating
passes through fixing the environment anyway. And miss the line and nothing
else will tell you: the process stays up, `systemctl status` stays green, and
from the outside a halted bot is indistinguishable from a quiet guild. This one
line is the whole of the evidence.

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

## 5. The unit

```bash
sudo nano /etc/systemd/system/blitz-bot.service
```

```ini
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

# Node directly rather than `npm start`, for two reasons. npm adds a process
# whose entire job is to exec node, and it reads its config and cache from the
# home directory that `ProtectHome=true` below hides — a combination that
# produces confusing errors at boot which have nothing to do with this bot. The
# cost is that this line duplicates the `start` script in package.json and the
# two must be changed together; that is one line in one file.
#
# The path is absolute so the unit does not silently depend on WorkingDirectory
# being right. `--disable-warning=ExperimentalWarning` because Node prints an
# experimental warning for type stripping on every single boot, and a healthy
# service that logs a warning every time it starts is a service whose warnings
# nobody reads.
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/blitz-bot/src/index.ts

# `always`, not `on-failure`. A Discord bot that exits 0 is still an outage:
# the gateway can close in a way discord.js does not treat as fatal, and the
# process ends with nothing wrong as far as systemd is concerned. Any exit is a
# bot that has stopped moderating.
Restart=always
RestartSec=5

# The process writes nothing to disk — no build output, no cache, no state. So
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
```

`User=ubuntu` matches the console rather than improving on it. A dedicated
unprivileged user would stop the bot from being able to read
`/opt/ringmaster/.env.local` — the console's OAuth secret, signing key and the
path to the game host's SSH key — which is a real gain, and it is not taken
here only because it is a change to how the box is administered rather than to
how the bot is deployed. Worth doing on the day anything else on this box needs
the same treatment.

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now blitz-bot
```

```bash
systemctl status blitz-bot --no-pager && journalctl -u blitz-bot -n 30 --no-pager
```

A configuration problem shows up here as a refusal to start with the variable's
name in the message, which is the entire reason `src/config.ts` validates
before anything connects. Read the next two sections before you conclude it
came up clean — "starting" and "failing over and over" look the same in
`systemctl status`.

## 6. Logs — the last resort, not the dashboard

**Nothing in this section is a daily habit.** The journal is where you go when
the bot has stopped being able to tell you anything itself: it will not start,
or it is up and moderating nothing, or something happened in the guild that has
no line to match it. Opening `journalctl` to find out whether the bot is
*working* is a symptom of the gap in the next paragraph, not the way this is
meant to be run.

**The bot cannot report its own faults yet.** Removals reach admins through
`BLITZ_LOG_CHANNEL_ID` when it is set — but a delete that failed, moderation
halted at startup, a gateway that will not stay connected: those exist here and
nowhere else, so they are seen only by somebody who already suspected something
and opened an SSH session to check. Sending the bot's own faults to a Discord
channel (`#bot-status`) is **tracked as issue #9 and is not built yet**; until
it is, everything below is the only way those lines are ever read.

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
prints nothing,
that is a quiet day and not a broken filter; confirm with `journalctl -u
blitz-bot -n 20`, which filters nothing.

> This used to be a lie. The priority prefix is new. Before it, `log.ts` and
> this file both claimed the journal could tell warnings from info because
> warnings were written to stderr — journald does not work that way, it stamps
> both streams with the same default priority, and `-p warning` printed an empty
> page no matter how badly the bot was failing. If you are on a box that has not
> been updated since, that command is not evidence of anything.

Nothing ships these anywhere, and nothing reads them but a person at a prompt.
The journal on this box is the log, which is the whole of the case for
issue #9: a fault nobody is looking at is a fault nobody knows about.

## 7. When it will not start: the silent restart loop

**This is the failure that wastes an evening, so read it before you need it.**

The unit has `Restart=always`, `RestartSec=5` and `StartLimitIntervalSec=0`.
The last one deliberately removes systemd's "give up after five failures" rule,
because a Discord outage should not turn into an outage of our own. The cost is
that **a bot that can never start retries forever**, five seconds apart, and
`src/config.ts` exits 1 on a single mistyped variable. One typo in `.env` is
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

Then tell the two cases apart by **what the repeating line says**:

| What repeats | What it is | What to do |
|---|---|---|
| `Invalid configuration:` and a variable name — no timestamp, no `level=` | A bad or missing variable. It never reached Discord. | Fix `/opt/blitz-bot/.env`, `systemctl restart blitz-bot`. §3 lists the three ways that file bites. |
| `level=error msg="login failed"` with `disallowed intents` | The Message Content intent is off in the portal. | §4.1. It will loop until you tick it; the token is fine. |
| `level=error msg="login failed"` with a 401 or an invalid-token message | Wrong, rotated or revoked token. | New token in the portal, into `.env`, restart. |
| `level=error msg="login failed"` with a timeout, DNS or connection error, **or** repeating `level=warn msg="gateway disconnected"` lines from a process that stays up | Discord, or this box's network. Not us. | Nothing to fix here. Check <https://discordstatus.com>. `Restart=always` is doing its job; it will reconnect on its own. |

The short version: **a config or intent problem never gets as far as a
`ready` line, and a Discord outage always does.** If the journal contains a
`ready` from this boot, the bot's own configuration is fine and the problem is
on the other end of the websocket.

To stop the noise while you work on it:

```bash
sudo systemctl stop blitz-bot
```

A stopped bot moderates nothing, which is the same as a crash-looping bot,
except you can read the journal.

## 8. AWS

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

## 9. Deploying an update

```bash
cd /opt/blitz-bot && git pull && npm ci && sudo systemctl restart blitz-bot
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

## Checks

```bash
systemctl is-active blitz-bot ringmaster
```

Two lines, both `active`, and neither one caused the other. If you want to
prove the independence rule rather than trust it, stop either service and watch
the other keep running — nothing in either unit references the other, so there
is nothing to break.
