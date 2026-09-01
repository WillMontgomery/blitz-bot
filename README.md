# blitz-bot

The Discord bot for the Blitz Royale community server. It is a single Node
process — discord.js v14, no web server — that runs under systemd on the
Ringmaster box alongside the admin console. It runs independently of the
console, but it is not isolated from it: it reads and writes the console's
DynamoDB tables, with the console's instance role, and calls the console over
the loopback for the two things it cannot do itself — dropping somebody from a
match, and draining the server. See
[docs/deploy.md](docs/deploy.md).

## What it does today

**It moderates messages, mirrors Discord's moderation into the game, and answers
five slash commands.**

Six rules remove a message, and nothing else does: an invite to another Discord
server, more invite codes in one message than it will check, a
`fivem://connect/` link to another game server, a `cfx.re/join` or
`servers.fivem.net` listing, an IP address that is not ours, and a link
shortener. **No word filter, no warnings, no mutes.**

Around that: a ban, unban or kick in Discord is carried into the game and
written to DynamoDB; a ban issued in the console puts the game-ban role on the
player here and takes it off again when it is lifted or expires; an incident
becomes an embed in the moderation channel when it is filed and again when it is
closed in the console; `/sticky` keeps a
message at the bottom of a channel; and `docs/bot-manual.md` is published to a
channel and reconciled at every start.

Behaviour is set entirely by the environment, and `.env.example` is the
authority on it. All fourteen, in the order `src/config.ts` reads them:

| Variable | |
|---|---|
| `DISCORD_BOT_TOKEN` | Required. The bot's own token. |
| `DISCORD_GUILD_ID` | Required. Our guild — the one guild whose invites are allowed. |
| `DISCORD_ADMIN_ROLE_ID` | The role treated as admin. Unset disables the admin exemption and refuses every admin-only command to everybody. |
| `BLITZ_LOG_CHANNEL_ID` | The moderation record: removals, and an embed per incident filed and per incident closed. Unset means journal only. |
| `BLITZ_STATUS_CHANNEL_ID` | The bot's own faults, and the commit it came up on when that changed. Unset means journal only. |
| `BLITZ_DOCS_CHANNEL_ID` | Where `docs/bot-manual.md` is published. Unset turns the manual off. |
| `BLITZ_MAINTENANCE_CHANNEL_ID` | Where players are told the server is back up. Unset turns the watcher off. |
| `BLITZ_EXEMPT_CHANNEL_IDS` | Comma-separated channels the scanner skips. Default: none. |
| `BLITZ_SERVER_IPS` | Our own servers' addresses. Blank means the two in `src/config.ts`, not an empty list. |
| `BLITZ_EXEMPT_ADMINS` | Skip messages from holders of the admin role. Default `true`. |
| `BLITZ_DRY_RUN` | Scan and log, delete nothing. Default `false`. |
| `COMMAND_SECRET` | The secret the console's command routes want — the same value under the same name in the console's own dotenv file. Unset turns the live kick off and nothing else. |
| `BLITZ_RINGMASTER_URL` | Where the console answers. Blank means its loopback origin, not "off". |
| `BLITZ_GAME_BAN_ROLE_ID` | The role a game ban puts on somebody. Blank means the id in `src/config.ts`, not "no role". |

The process refuses to start if either required variable is missing or blank,
and names every problem at once rather than one per restart (`src/config.ts`).

**The bot does talk to members, in exactly one place.** When it removes a
message it DMs the poster naming the rule that fired, and if their DMs are shut
it tags them in the channel instead and takes that note down after about half a
minute — the one message it sends that pings anybody. Nothing it posts quotes
the removed text. Everything else it says goes to admins:
`BLITZ_LOG_CHANNEL_ID`, `BLITZ_STATUS_CHANNEL_ID` and the journal. The
member-facing wording is the owner's; do not add copy of your own.

## Running it locally

Node 24, and only Node 24. There is no build step and no `dist/`: Node runs the
TypeScript directly and strips the types itself, which is why `tsconfig.json`
carries the three flags it does. An older major does not warn about a `.ts`
file, it fails to parse it.

```bash
npm ci
cp .env.example .env
```

Fill in `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`, then:

```bash
node --env-file=.env --disable-warning=ExperimentalWarning src/index.ts
```

**A token alone is not enough to get a working bot.** The application needs
**both** privileged intents turned on — **Message Content** and **Server
Members** — and the bot needs to be in the guild, invited with the `bot` and
`applications.commands` scopes, holding **Manage Messages**, **Manage Roles**
and **View Audit Log**, with its own role above the game-ban role. Miss an
intent and the gateway closes with code 4014 and login fails on every attempt.
Miss a scope or a permission and the process still starts and still looks
healthy: no command is ever registered, or every delete fails, or no game ban is
marked, or Discord's bans never reach the game.
[docs/deploy.md §4](docs/deploy.md) is the checklist, and it applies to a laptop
exactly as it does to the box.

**AWS is not optional either.** `src/ddb.ts` reads and writes eight DynamoDB
tables, and on a laptop the SDK will find whatever credentials your environment
gives it. See [docs/aws-notes.md](docs/aws-notes.md).

`npm start` is the same command without `--env-file`, because in production
systemd's `EnvironmentFile` has already put those variables in the process
environment. Use `npm start` locally only if you have exported them into your
shell yourself; otherwise you will get the config error above and it will be
telling the truth.

`.env` is gitignored, along with every other dotenv file except the template.

## Checking your work

```bash
bash verify.sh
```

Runs `npm run typecheck`, then `npm run lint`, then `npm test`, in that order,
and stops at the first failure with the failed step named in a banner. Run the
three npm scripts directly if you want a subset.

`bash verify.sh` rather than `./verify.sh`, here and in CI, and it is worth one
sentence: this repo is developed on Windows with `core.filemode=false`, so the
executable bit is not carried in git and `./verify.sh` fails with "Permission
denied" — exit 126, before a single check runs — for anyone who cloned it.
Naming the interpreter does not consult the mode bit. (`verify.sh` is POSIX sh,
so `sh verify.sh` works too.)

CI runs **this same file** on every push and pull request touching `main` or
`dev` (`.github/workflows/ci.yml`). There is deliberately no second list of
checks in the workflow to keep in step with this one.

Every test runs offline. No live Discord, no AWS, no network of any kind —
fakes are injected. CI is given no secrets because there is nothing for a
secret to be for; a test that needs a credential is a broken test.

## Branch policy

**Only `main` and `dev` may ever exist on origin.** No feature branches, no
personal branches, nothing long-lived on the side. Two names, and anyone
looking at the repo can see the whole of it.

- **Today:** everything lands on `main`, and the box runs `main`.
- **After go-live:** work lands on `dev`, and `dev` reaches `main` by pull
  request. The box still runs `main`.

The box running `main` is the point of the whole arrangement. `main` is what
the working copy on the box tracks, so anything pushed to it is one `git pull`
away from moderating a live server, with no further review anywhere. Before
go-live that is fine — a broken bot deletes nothing and bothers nobody. After
go-live it makes a push to `main` a deployment decision, and the pull request
from `dev` is where that decision gets made and written down.
