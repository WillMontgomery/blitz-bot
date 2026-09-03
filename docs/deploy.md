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
- They share no socket, no file **and no Node binary**. What they do share is
  data and identity rather than process: the console's DynamoDB tables (§15),
  the box's instance role (§15), one Discord application (§4.4), and one secret
  under one name in two dotenv files (`COMMAND_SECRET`, §5). None of those is a
  handle either service holds on the other.
- **Either may be down, and the other will not notice.** The console is what
  admins reach for while something is going wrong; a bot in a crash loop must
  not take it with it. Equally, deploying the console must not stop moderation
  for the ninety seconds of an `npm run build`.
- **They are updated separately.** Two directories, two updates, two
  `systemctl restart`s — and the bot now has an update unit and a timer of its
  own (§6), which is a thing only the bot has. There is no command in this file
  that touches `/opt/ringmaster`, and nothing on that timer knows the console
  exists.

Where the two do talk — the live kick, and `/drain` — they talk over HTTP on the
loopback, with a timeout and a failure path, like strangers. With the console
down the ban is still written and still enforced at the player's next connect;
only the immediate removal is lost. They do not become one unit.

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
file's `ExecStart` in §6, and every `npm` in §3, in `deploy/blitz-bot-update`
and in §16, each of which runs `/opt/node24/bin/node` and hands it npm's own
script as an argument.

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

### 4.1 Turn on the two privileged intents

**Developer Portal → your app → Bot → Privileged Gateway Intents → Message
Content → on, Server Members Intent → on → Save.**

**Both, and the second one is the half this section used to leave out.**
`src/client.ts` connects with five intents — `Guilds`, `GuildMessages`,
`MessageContent`, `GuildModeration` and `GuildMembers` — and two of those are
privileged and have to be ticked:

| Portal switch | Intent | What it carries |
|---|---|---|
| **Message Content** | `MessageContent` | A message's text, embeds, components and attachments — everything the six rules read. |
| **Server Members Intent** | `GuildMembers` | The member-join event. It is how somebody already banned in the game gets the game-ban role when they arrive in the guild. |

`Guilds`, `GuildMessages` and `GuildModeration` need no tick and no review.
`GuildModeration` is what delivers the ban, unban and kick entries the bot
mirrors into the game, and it costs nothing here — but it does need the **View
Audit Log** permission on the bot's role, which is §4.2 and fails silently.

Requesting an intent the application has not been granted is not a warning —
Discord closes the gateway with **close code 4014**, `login()` rejects, and the
process exits 1. With `Restart=always` below, that is a restart loop. **Either
missing tick produces exactly this, and the journal cannot tell you which one**,
so confirm both switches rather than looking for a difference between them. The
journal shows both of these:

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
proof both intents are on.**

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

- **Scopes:** `bot` **and** `applications.commands`. Both. The bot registers
  five guild slash commands on every start — `registerCommands` in
  `src/commands/index.ts` calls `guild.commands.set`, and §4.5 lists what it
  registers. Without the second scope that call is refused, nothing else
  breaks, and not one command ever appears in anybody's client.
- **Bot Permissions**, and there are three of them rather than one:
  - **Manage Messages** — deleting somebody else's message. Without it every
    delete fails and the bot otherwise looks perfectly healthy — see §12.2.
  - **Manage Roles** — putting the game-ban role on and taking it off
    (`src/banrole.ts`). Without it no game ban is ever marked in the guild.
    This one is not silent: the bot checks at start and before every edit and
    names the problem in `#bot-status`.
  - **View Audit Log** — reading the ban, unban and kick entries the bot
    carries into the game (§4.1). This one **is** silent: without it the
    `GuildModeration` intent is still accepted, the gateway still connects, and
    the events simply never arrive, which reads exactly like a guild in which
    nobody has been banned.
- **View Channel** it normally inherits from `@everyone`. In a guild where
  channels are locked down, the bot's role needs it explicitly — it cannot
  moderate a channel it cannot see, and it will not say so.
- The bot also needs **Send Messages** in every channel §5 points a variable at:
  **`#moderation-notifications`**, where `BLITZ_LOG_CHANNEL_ID` points,
  **`#bot-status`**, where `BLITZ_STATUS_CHANNEL_ID` points, and the docs and
  maintenance channels if those are configured. A channel-level override is
  enough; it does not need it guild-wide. **The first two are different channels
  and this document used to swap them** — see the box in §5. The docs channel
  also needs **Read Message History**, because the bot reconciles the manual it
  already posted there rather than posting a second copy.

Open the generated URL, pick the Blitz Royale guild, authorise. Then check the
role Discord created for the bot actually carries Manage Messages in the
channels you care about — a channel-level override that denies it beats the
guild-level grant, silently.

**Then move the bot's role above the game-ban role.** Server Settings → Roles.
Discord refuses a role edit unless the acting member's highest role is above the
role being assigned, and a new role lands at the bottom of the list, so Manage
Roles on its own is not enough — `BLITZ_GAME_BAN_ROLE_ID` (§5) has to sit
*below* the bot. `src/banrole.ts` checks both and names whichever is wrong.

An install done with only the `bot` scope announces nothing in Discord — the
commands are simply not there, which reads as a build that did not ship them.
One line in the journal says otherwise:

```
2026-08-29T18:04:12.883Z level=error msg="slash commands could not be registered" guild="1543345492270915002" error="DiscordAPIError[50001]: Missing Access"
```

Adding the scope to the OAuth2 URL is not enough on its own: the authorisation
already granted does not gain it. Re-open the generated URL with both scopes
ticked and authorise again for the same guild, then restart the bot — §4.5.

### 4.3 Get the guild and channel ids

**Discord client → User Settings → Advanced → Developer Mode → on.** Then
right-click and *Copy Server ID* for `DISCORD_GUILD_ID`, *Copy Channel ID* on
**`#moderation-notifications`** for `BLITZ_LOG_CHANNEL_ID`, and *Copy Channel ID*
on **`#bot-status`** for `BLITZ_STATUS_CHANNEL_ID`. They are 17–20 digit
snowflakes; if what you pasted has letters in it, it is a name and not an id.

Two more channels are optional and are copied the same way when the owner wants
them: `BLITZ_DOCS_CHANNEL_ID`, where the bot keeps `docs/bot-manual.md` posted,
and `BLITZ_MAINTENANCE_CHANNEL_ID`, where players are told the server is back
up. Both are off while their variable is blank — §5.

**Check which channel each id came off before you paste it.** The two are the
easiest thing in this document to swap, they both accept any snowflake, and
neither the bot nor Discord will tell you they are the wrong way round: the
moderation record simply appears in the faults channel and the faults appear
where the moderation record should be. §5 has both ids written out.

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

That has a consequence worth writing down: the scopes and permissions in §4.2
**widen what this application can do**, and the console's own docs still
describe it as a login-only OAuth app. Anyone reading those docs will
underestimate what a leak of these credentials costs — it is no longer "someone
can sign in as our app", it is "someone can delete messages, hand out roles and
register commands in the guild". The console's `.env.local` and this bot's
`.env` now hold pieces of the same identity, and since §5 they hold the same
`COMMAND_SECRET` as well.

Splitting the bot onto its own Discord application, so that the console's
credentials and the bot's are genuinely separate, is **tracked as a known
issue** on the repo — deliberate and open, not an accident of setup, and not
something to attempt during an incident. Until it is done, treat both `.env`
files as carrying the same blast radius, and rotating either one means
re-deploying both services.

### 4.5 The five commands it registers

Registration is a bulk put at every start — `set` replaces the guild's whole
list — so what is registered cannot drift from what is in the repo, and there is
no separate "deploy commands" step to remember. `docs/bot-manual.md` is what the
guild is told about them; this is what the operator needs:

| Command | Who | What it needs beyond the scope |
|---|---|---|
| `/drain start`, `/drain cancel` | admin | `COMMAND_SECRET` and `BLITZ_RINGMASTER_URL` (§5) |
| `/help` | anyone | nothing |
| `/profile` | anyone, for their own; another member's is admin | AWS (§15) |
| `/sticky`, `/unsticky` | admin | nothing |

**Admin** means holding `DISCORD_ADMIN_ROLE_ID`. Left blank, the admin-only
commands refuse everybody rather than admitting everybody — the safe direction,
and why §5 leaves it blank until §9.

Guild-scoped, not global, so a change is live the moment the bot restarts rather
than propagating for an hour. One line at every start says what went out:

```
2026-08-29T18:04:12.883Z level=info msg="slash commands registered" guild="1543345492270915002" commands="drain,help,profile,sticky,unsticky"
```

A registration that fails leaves the guild with whatever list it had before, so
the bot goes on answering the previous deploy's commands and this journal line
is the only thing that says the list is stale.

## 5. The environment file, and the dry run

**`BLITZ_DRY_RUN=true` is the setting this whole section exists for.** With it
on, the bot scans every message, decides exactly what it would remove, writes a
line to the journal and posts a line to `#moderation-notifications` — and deletes
nothing. It is how you find out what this bot does to a live community without
finding out the expensive way.

> ### Correction: these two ids were the wrong way round
>
> Every version of this document before 2026-08-31 carried this line, which is
> wrong: `BLITZ_LOG_CHANNEL_ID=1543345492270915684`, described in the table
> beside it as "`#bot-status`, admin-only". **That snowflake is the status
> channel**, and
> `BLITZ_LOG_CHANNEL_ID` is the moderation record — so following this guide put
> the removal lines, and the embed for every incident filed and closed, into
> the channel meant for the bot's own faults. `docs/bot-manual.md` has had the
> right pairing all along.
>
> | Variable | Channel | Id |
> |---|---|---|
> | `BLITZ_LOG_CHANNEL_ID` | `#moderation-notifications` | `1542603116258525185` |
> | `BLITZ_STATUS_CHANNEL_ID` | `#bot-status` | `1543345492270915684` |
>
> **If you installed from an earlier copy of this guide, `/opt/blitz-bot/.env` on
> the box is still wrong.** Nothing in this repository will fix it for you and
> nothing will warn you: both ids are valid channels the bot can post to, so the
> only symptom is records in the wrong room. Fix the file by hand and
> `sudo systemctl restart blitz-bot`.

**Every variable `src/config.ts` reads is in the block below, including the ones
that are meant to stay blank.** That is deliberate: an operator who can see the
whole list can tell "off on purpose" from "nobody knew about it", and this
document shipped for a while with six of them missing entirely — which is how an
install ends up with no manual, no maintenance announcement and no kick relay,
none of which announce their own absence. `.env.example` is the authority and
this list is checked against it.

Write the file in one block. It contains no secret yet:

```bash
cat > /opt/blitz-bot/.env <<'EOF'
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_ADMIN_ROLE_ID=
BLITZ_LOG_CHANNEL_ID=1542603116258525185
BLITZ_STATUS_CHANNEL_ID=1543345492270915684
BLITZ_DOCS_CHANNEL_ID=
BLITZ_MAINTENANCE_CHANNEL_ID=
BLITZ_EXEMPT_CHANNEL_IDS=
BLITZ_SERVER_IPS=
BLITZ_EXEMPT_ADMINS=true
BLITZ_DRY_RUN=true
COMMAND_SECRET=
BLITZ_RINGMASTER_URL=
BLITZ_GAME_BAN_ROLE_ID=
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

Now fill in the three values that have to be typed in:

```bash
nano /opt/blitz-bot/.env
```

Put the bot token from the Developer Portal after `DISCORD_BOT_TOKEN=`, the
guild id from §4.3 after `DISCORD_GUILD_ID=`, and after `COMMAND_SECRET=` the
value that is **already** in `/opt/ringmaster/.env.local` under that same name.
Copy it; do not generate a new one. It is one secret shared by two services, and
a value that does not match the console's is the same as no value at all —
except that it fails on every kick instead of saying so once at boot. Save with
**Ctrl-O, Enter**, exit with **Ctrl-X**.

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

What the other twelve are set to, and why. **Blank does not mean the same thing
in every row**, which is the reason this table is long: for some of them blank
turns something off, and for three of them blank means a value that lives in
`src/config.ts` rather than in any file on this box. A default kept only in
`.env.example` would be a default systemd never reads, so the source holds them.

| Variable | Value here | Why |
|---|---|---|
| `DISCORD_ADMIN_ROLE_ID` | blank | Blank disables the admin exemption outright, and refuses every admin-only slash command to everybody. Leave it blank through §8 and §9 — **with a role set here, an invite you post yourself would be skipped**, and the smoke test would look like a broken bot. |
| `BLITZ_LOG_CHANNEL_ID` | `1542603116258525185` | **`#moderation-notifications`**, admin-only. The moderation record: every removal, every dry-run would-be removal, and an embed for every incident the game files and every incident closed in the Ringmaster console. This is what makes the dry run readable without an SSH session. |
| `BLITZ_STATUS_CHANNEL_ID` | `1543345492270915684` | **`#bot-status`**, admin-only. The bot's OWN faults and nothing else — a delete that failed, a rate limit, a channel it cannot post in — plus the commit it came up on when that has changed. A different channel from the one above deliberately: one is a record of what the bot did to the guild, the other is a record of what went wrong with the bot. |
| `BLITZ_DOCS_CHANNEL_ID` | blank | Where the bot keeps `docs/bot-manual.md` posted, reconciled at every start. Blank turns the manual off: the file is not read and nothing is posted. Set it when the owner wants the guild to have the manual — and give the bot **Read Message History** there (§4.2), or it cannot find the copy it posted last time. |
| `BLITZ_MAINTENANCE_CHANNEL_ID` | blank | Where players are told the server is back up — one message, after the game server itself reports in. Blank turns the watcher off and the maintenance row is never read. Nothing else is ever posted there. |
| `BLITZ_EXEMPT_CHANNEL_IDS` | blank | No channel is skipped. Add ids later if the owner asks for it. A thread is exempted separately from its channel. |
| `BLITZ_SERVER_IPS` | blank | **Blank means our own servers, not an empty list.** `src/config.ts` holds the addresses; an empty list would make the bot delete the message that names our own server. Order does not matter — the first address used to be the one the maintenance notice told players to connect to, and that clause is gone. A malformed entry stops the bot at boot. |
| `BLITZ_EXEMPT_ADMINS` | `true` | The default. It does nothing at all while `DISCORD_ADMIN_ROLE_ID` is blank. |
| `BLITZ_DRY_RUN` | `true` | **Delete nothing.** §9 is the only place this changes. |
| `COMMAND_SECRET` | the console's | Filled in above. It is what the console's command routes want in the `x-ringmaster-service` header, and it is the only switch that turns the live kick off. Unset, the bans are still written and still enforced at the player's next connect; what is lost is dropping them from the match they are in, and every mirrored ban puts one warning in `#bot-status` saying so. |
| `BLITZ_RINGMASTER_URL` | blank | **Blank is the console's loopback origin, not "off".** `src/config.ts` holds it; the bot is the second service on the console's own box and port 3000 is closed to the internet, which is the whole reason the relay goes over loopback rather than out through Cloudflare and back with the secret on it. Origin only — a stray path is refused at boot rather than becoming a 404 that reads like a console outage. |
| `BLITZ_GAME_BAN_ROLE_ID` | blank | **Blank is the role the owner settled on, not "no role".** `src/config.ts` holds the id. It marks somebody banned in the game but not on Discord, so they keep limited access and can argue their case; lifting or expiring the ban takes it off. It needs Manage Roles and it needs the role to sit below the bot's own — §4.2. A malformed id stops the bot at boot. |

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

Seven files, in six rows. Five of them are put on the box in this section —
four out of `deploy/` with one command, and the sudoers drop-in by hand — and
the other two are written at runtime, one by the update and one by the bot. Those
two are described together, where the difference between them is easiest to see:

| Written in | File | What it is |
|---|---|---|
| §6.1 | `/usr/local/bin/blitz-bot-update` | the update itself, and the only implementation of one |
| §6.2 | `/opt/blitz-bot/.deployed-commit` | written by the script above; the commit the bot reads at startup and reports |
| §6.2 | `/var/lib/blitz-bot/reported-commit` | written by the bot, and by nothing else; the commit it has already announced |
| §6.3 | `/etc/sudoers.d/blitz-bot-update` | the one privileged thing the update does |
| §6.4 | `/etc/systemd/system/blitz-bot.service` | the bot, which now does nothing but run |
| §6.5 | `/etc/systemd/system/blitz-bot-update.service` and `.timer` | the update, and what starts it |

**The script and the three unit files are tracked in the repository**, in
`deploy/`, and `deploy/install.sh` installs all four (§6.1). They used to be
four `sudo tee <<'EOF'` blocks in this document — nearly four hundred lines to
paste into an SSH session, and a shell script that exists only inside a markdown
fence is not code. It cannot be parsed without running it, it cannot be diffed
against what is on the box, and CI has no way to look at it at all. They are
ordinary files now: `bash verify.sh` parses both shell scripts and runs
`systemd-analyze verify` over the three units on every push.

**Their contents are no longer in this document, deliberately.** §6.1, §6.4 and
§6.5 say what each file is and why it is that way; the file itself is the file,
and its own comments are longer than anything here. A unit copied into a runbook
is a unit that drifts away from the one on the box, and this project has been
bitten by that three times.

**Tracked is not deployed.** An update hard-resets `/opt/blitz-bot` onto
`origin/main`, so a push does change `/opt/blitz-bot/deploy/` on the box — and
changes nothing whatever in `/usr/local/bin` or `/etc/systemd/system`, because
nothing copies files there except `deploy/install.sh`, run by hand. §16 says
what each of them needs afterwards. What being tracked buys is the question that
could not be asked before at all: **is what is installed the same as what the
repository says should be installed?**

**The sudoers drop-in (§6.3) is still written by hand, and stays that way.** A
file in `/etc/sudoers.d` that does not parse stops `sudo` working *at all*, on a
box whose only privileged path is `sudo` over SSH — so it is staged in `/tmp`,
checked there with `visudo -c`, and only then installed. That sequence is the
whole point of it, and it does not belong folded into a script that copies four
files.

### 6.1 The four files, and the one command that installs them

§3 cloned the repository, so all four are already on the box, in
`/opt/blitz-bot/deploy`:

| In `deploy/` | Installed as | Mode |
|---|---|---|
| `blitz-bot-update` | `/usr/local/bin/blitz-bot-update` | 755 |
| `blitz-bot.service` | `/etc/systemd/system/blitz-bot.service` | 644 |
| `blitz-bot-update.service` | `/etc/systemd/system/blitz-bot-update.service` | 644 |
| `blitz-bot-update.timer` | `/etc/systemd/system/blitz-bot-update.timer` | 644 |

**`blitz-bot-update` is the update, and the only implementation of one.** It
brings `/opt/blitz-bot` to exactly `origin/main`, installs dependencies if the
lockfile moved, and restarts the bot **only if the commit it is running is not
the commit now on disk**. `blitz-bot-update.service` runs it;
`blitz-bot-update.timer` starts that unit every fifteen minutes; and
`sudo systemctl start blitz-bot-update` starts the same unit by hand — one
script, one unit, one path, with no second implementation of a deploy on this
box for either of them to drift away from. It tags the commit it is leaving
before it overwrites it, it never restarts the bot after an install that failed,
and it has an off switch that is read before anything else (§16). Every one of
those decisions is argued for in its own comments, in the file, which is the
first thing to read before changing it. §6.4 covers the bot's unit and §6.5 the
update's unit and the timer.

Read them before you install them. This is what the four heredocs used to be and
nothing has been retyped, so what is on the screen is what goes on the box — the
three unit files sit alongside it in the same directory:

```bash
less /opt/blitz-bot/deploy/blitz-bot-update
```

**Then install all four:**

```bash
sudo sh /opt/blitz-bot/deploy/install.sh
```

Expected, on a box where none of them are in place yet:

```
install: from /opt/blitz-bot/deploy

  installed  /usr/local/bin/blitz-bot-update
  installed  /etc/systemd/system/blitz-bot.service
  installed  /etc/systemd/system/blitz-bot-update.service
  installed  /etc/systemd/system/blitz-bot-update.timer

  verified   all three unit files parse, and their ExecStart paths exist
  reloaded   systemd now knows about the three units

install: done. NOTHING WAS ENABLED AND NOTHING WAS STARTED.
```

**Read the four verbs, one per file.** A second run says `unchanged` four times
and copies nothing, which makes the same command the answer to "is this box
actually on this commit's units?". `updated` means the file on the box was not
the file in the repository — worth knowing, and not askable at all while the
units lived in a document.

**`verified` is `systemd-analyze verify`**, run against what was just installed,
where it was installed. It reads the three units the way systemd will and
refuses a misspelled directive, a section that is not a section, or a value it
cannot parse — none of which any other check in this repo can see. It also
checks that the paths in `ExecStart=` exist and are executable, which is why the
script is copied before the units that name it. **Any output from it is a
problem to fix before going on**, and the installer stops there, with the files
on disk and nothing enabled.

**`reloaded` is `systemctl daemon-reload`.** Without it, `systemctl start
blitz-bot-update` in §7 answers `Unit blitz-bot-update.service not found` over a
file that is plainly sitting in `/etc/systemd/system`.

**There is no `sh -n` step here any more, and no `chmod` to remember.** Both
existed because this section used to be a paste: `sh -n` caught the one mistake
a four-hundred-line paste actually makes, and the mode had to be set afterwards
because `tee` does not set it. The script arrives through `git clone` now,
`bash verify.sh` parsed it before it could reach `main`, and `install.sh` writes
each file with its mode already on it.

**Nothing was enabled and nothing was started, and that is deliberate.**
Installing and starting are separate decisions: files on a disk are reversible
and dull, and a bot about to delete messages in a live guild is neither. §7
starts the bot, reads the journal after it, and turns the timer on last.

**If it refuses, it refuses before writing anything.** Two ways:

- `no /opt/blitz-bot on this machine` — it is being run on a laptop rather than
  on the box, and it will not scatter root-owned files outside a checkout. §3 is
  what creates that directory.
- `not root, so nothing was installed` — it needs `sudo` for `/usr/local/bin`
  and `/etc/systemd/system`. It prints the exact line to run rather than
  re-launching itself, so a password prompt never appears out of a command you
  did not put `sudo` in front of.

**Do not run `blitz-bot-update` by hand to test it.** By hand it runs outside the
unit's sandbox, with a different `HOME` and no `/var/lib/blitz-bot` — so it
would prove something about a situation that never happens, and would drop a
package cache in your home directory on the way past. §7 runs it for real,
through its unit, and reads the result out of the journal.

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

**The grant is proved at the end of §6.5**, and not here. It could be tried
now — §6.1 has already installed `blitz-bot.service`, and `sudo` reads
`/etc/sudoers.d` per call rather than caching it — but it is the last thing
checked before §7 runs the update for the first time, and the line it proves is
the line that update ends on.

### 6.4 The bot's unit

`deploy/blitz-bot.service`, installed by §6.1 as
`/etc/systemd/system/blitz-bot.service`. **It does nothing but run the bot.**

- **`ExecStart` is `/opt/node24/bin/node` and the source file, and nothing
  else** — no `ExecStartPre`, no `sh -c` smuggling an update in ahead of it. The
  version of this unit that ran the update before every start was reviewed and
  rejected; the three reasons are in the unit's own comments, where somebody
  about to put the line back is standing, and at length at the end of §16.
- **`Restart=always`, `RestartSec=5`, and no start limit.** It is what carries
  the bot through a Discord outage, and it is only safe because the start it
  produces fetches nothing. **A crash restarts the bot on the code already on
  the box and deploys nothing** (§14).
- **A sandbox: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`,
  `ProtectHome`.** `/opt/blitz-bot` is readable and not writable, which is why
  `.deployed-commit` lives there (§6.2) and why there is no `ReadWritePaths=`
  line anywhere in it — that one directive would hand the running bot its own
  source and its own token file.
- **`StateDirectory=blitz-bot`**, the one writable directory it has:
  `/var/lib/blitz-bot`, where it remembers the last commit it announced (§6.2).
  Both units declare it, both run as `ubuntu`, and they write different files in
  it.
- **`EnvironmentFile=/opt/blitz-bot/.env`** — §5's file, read once at start,
  which is why an edit to it needs a restart rather than a deploy (§16).

`User=ubuntu` matches the console rather than improving on it. A dedicated
unprivileged user would stop the bot from being able to read
`/opt/ringmaster/.env.local` — the console's OAuth secret, signing key and the
path to the game host's SSH key — which is a real gain, and it is not taken
here only because it is a change to how the box is administered rather than to
how the bot is deployed.

### 6.5 The update's unit, and the timer that starts it

`deploy/blitz-bot-update.service` and `deploy/blitz-bot-update.timer`, installed
by §6.1 into `/etc/systemd/system`.

**The unit:**

- **`Type=oneshot`, `ExecStart=/usr/local/bin/blitz-bot-update`, running as
  `ubuntu`** — the user that owns the tree. `systemctl status` then shows the
  result of the last run rather than a process that is still going.
- **Its failures are allowed to be failures.** No leading `-` on the
  `ExecStart`, and no `Restart=` at all: a oneshot that restarts itself on
  failure is the fetch loop this design exists to remove. Retrying is the
  timer's job, once, in fifteen minutes.
- **Nothing in it names `blitz-bot.service`** — no `Requires=`, no `BindsTo=`,
  no `After=`, not even a `Wants=`. It restarts the bot by asking systemd to, in
  the script's last line, and an ordering dependency between a unit and a unit
  it restarts is the classic way to wedge a boot.
- **`TimeoutStartSec=600`**, above the sum of the two network steps the script
  bounds itself with, so what gives up is the step that hung, with a line naming
  it.
- **`StateDirectory=blitz-bot` and `CacheDirectory=blitz-bot`**, because
  `ProtectHome=true` leaves npm no home directory to read its config and cache
  from. The cache survives between runs instead of being downloaded again every
  quarter of an hour.
- **No `NoNewPrivileges=`**, and it is the one sandbox line this unit cannot
  have: the last thing the script does is `sudo -n`, and `NoNewPrivileges` is
  exactly what stops `sudo` working. The bot's unit keeps it; this one says so
  out loud in its own comments.

**The timer:**

- **`OnCalendar=*:0/15`** — every fifteen minutes. That is the longest a push
  can sit on `main` without arriving, and also the shortest gap between pushing
  something wrong and the box restarting onto it.
- **`Persistent=true`**, which has an effect *only* on `OnCalendar=` timers: a
  box that was switched off comes back, sees it missed a window, and catches up
  once. Written as `OnUnitActiveSec=15min` the schedule would read identically
  and that line would be accepted and silently do nothing.
- **`RandomizedDelaySec=300`**, or this box fetches on the same second as every
  other thing anybody ever scheduled on the quarter hour — including its own
  catch-up after a reboot.

**Now prove the sudo grant from §6.3**, last, because it is the line the update
ends on and §7 runs the update next. Run it as `ubuntu` — the user the update
runs as. On a fresh box the bot has not been started yet, so `try-restart` does
nothing at all; on a box that is already running one, it restarts it once:

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
invite, or can post to `#moderation-notifications`. In dry run that proof costs
one message and removes nothing.

First get an invite that is definitely **not** for our guild. In Discord: **+ →
Create My Own → For me and my friends**, name it anything, then **Invite People
→ Copy Link**. That gives you a `https://discord.gg/XXXXXXX` for a server that
is not Blitz Royale.

Post that link in any ordinary channel of the Blitz Royale guild that the bot
can see.

**One:** the message stays up. It is a dry run.

**Two:** a line appears in `#moderation-notifications`, within a second or two:

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

If the journal line appeared but the `#moderation-notifications` line did not,
the bot cannot post to that channel — see §12.3. If neither appeared, see §12.1.

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

**Two:** `#moderation-notifications` says so:

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

### 12.3 It cannot post to `#moderation-notifications`

`BLITZ_LOG_CHANNEL_ID` points at a channel that does not exist, was deleted, or
that the bot cannot send in. Moderation is completely unaffected — messages are
still removed — but **the only place a non-technical admin would ever see that
happening is empty**, which reads exactly like a bot that has stopped working.

```bash
journalctl -u blitz-bot -n 200 --no-pager | grep -e 'log channel is missing' -e 'could not post to the log channel'
```

A wrong id, or a channel the bot cannot send in:

```
2026-08-29T18:33:19.006Z level=error msg="log channel is missing or cannot be posted to" channel="1542603116258525185"
```

The send itself was rejected:

```
2026-08-29T18:33:19.006Z level=error msg="could not post to the log channel" error="DiscordAPIError[50013]: Missing Permissions"
```

Fix: check `BLITZ_LOG_CHANNEL_ID` in `/opt/blitz-bot/.env` against *Copy Channel
ID* on `#moderation-notifications`, and give the bot's role **Send Messages**
there (§4.2). Then `sudo systemctl restart blitz-bot` and redo the §8 smoke test.

**Check the id itself before you check the permissions.** If that variable holds
`1543345492270915684` the bot is posting the moderation record into
`#bot-status`, which is the swap §5 corrects — it will not error, because that
channel exists and the bot can send in it. The moderation record is
`1542603116258525185`.

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

**Removals reach admins without an SSH session.** Every removal, and every
dry-run would-be removal, is posted to `#moderation-notifications` through
`BLITZ_LOG_CHANNEL_ID`. That is built and it is what §8 tested.

**So do the bot's own faults, in a different channel.** A delete that failed,
moderation halted at startup, a gateway that will not stay connected: every
`warn` and `error` the bot writes is copied to `#bot-status` through
`BLITZ_STATUS_CHANNEL_ID` (`statusReporter` in `src/client.ts`), scrubbed and
inside a code fence, with a repeating fault folded into one message so a broken
channel is one line rather than one every half minute. `info` never goes there,
deliberately — a channel that also carries `ready` is a channel nobody reads.

> This section used to say that half was "tracked as issue #9 and is not built
> yet". It shipped. What is still true is the reason the journal is below: the
> copy in Discord depends on the gateway being up and on that channel being
> postable, and neither is true in the failures worth reading about most — a
> login that never succeeds has no gateway to post over at all. The journal is
> underneath all of it and is the thing that cannot fail to be written.

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
| `msg="login failed"` with `error="Error: Used disallowed intents"` | A privileged intent is off in the portal — **Message Content, Server Members, or both.** The line is identical either way and never names which. | §4.1. Confirm both switches rather than guessing at one; it will loop until every intent the bot asks for is granted, and the token is fine. |
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

**The bot uses the box's instance role, and it calls AWS on every start.** Both
`@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` are runtime dependencies
in `package.json`, `src/ddb.ts` is a full DynamoDB layer over **eight tables**,
and `createDdb()` is reached from the client and from the command wiring. Bans,
kicks and unbans are written there; `/profile` and the incident record read from
there. A bot that could not reach DynamoDB would go on moderating messages,
keeping the sticky and publishing the manual, and would do almost nothing else:
no ban mirror, no game-ban role, no `/profile`, no incident record and no
maintenance notice.

**There is still nothing to configure here, and that is the problem rather than
the convenience.** No credentials go in `.env` and none should — the SDK's
default provider chain finds the instance role from instance metadata, and
`src/config.ts` has no AWS-shaped variable to set. If you find yourself adding
one, the deployment is wrong.

**The instance role that chain finds belongs to the console.** It carries the
console's DynamoDB access — `ringmaster-*`, every action, `DeleteItem` and
`Scan` included — so every call the bot makes arrives with the admin console's
permissions over the admin console's tables, because of where the bot happens to
be running.

Scoping the bot to its own IAM user with its own policy is tracked as
**issue #4**. It was written down as something to do *before* the first AWS
call; the first AWS call shipped ahead of it, so it is overdue rather than
pending, and the ban write is the first thing a wrong grant could not have made
harmless.

**[`docs/aws-notes.md`](aws-notes.md) is the reference for the rest of it** —
which eight tables, which action on each, the exact policy #4 has to write, and
the region default and why getting it wrong reads as a table that does not
exist. Nothing there is a step to perform, and nothing in this section is
either: on this box, AWS works or it does not, and §13 is where you find out
which.

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
| **A unit file, or the timer** | Nothing gets installed. They live in `deploy/` now, so an update brings the new file as far as `/opt/blitz-bot/deploy/` and copies it nowhere. | Land it on `main`, let the update fetch it, then `sudo sh /opt/blitz-bot/deploy/install.sh` — which does the `sudo systemctl daemon-reload` itself. Then restart what you changed: `blitz-bot`, or `blitz-bot-update.timer`. |
| **`/usr/local/bin/blitz-bot-update`** | Nothing gets installed, for the same reason: `deploy/blitz-bot-update` moves and the installed copy does not. | The same one command, which writes the mode as it writes the file — there is no `chmod` left to forget. No reload is needed for this one; systemd does not cache it, it is exec'd fresh at every run. |
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
