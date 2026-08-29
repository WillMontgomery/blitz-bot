# blitz-bot

The Discord bot for the Blitz Royale community server. It is a single Node
process — discord.js v14, no web server, no database — that runs under systemd
on the Ringmaster box alongside the admin console and shares nothing with it.
See [docs/deploy.md](docs/deploy.md).

## What it does today

**It deletes Discord invites that are not for our guild.** An invite to our own
server is left where it is; every other invite posted in the guild is removed.
That is the whole feature set. Nothing else in this repo moderates anything.

Behaviour is set entirely by the environment, and `.env.example` is the
authority on it:

| Variable | |
|---|---|
| `DISCORD_BOT_TOKEN` | Required. The bot's own token. |
| `DISCORD_GUILD_ID` | Required. Our guild — the one guild whose invites are allowed. |
| `DISCORD_ADMIN_ROLE_ID` | The role treated as admin. Unset disables the admin exemption. |
| `BLITZ_EXEMPT_ADMINS` | Skip messages from holders of that role. Default `true`. |
| `BLITZ_EXEMPT_CHANNEL_IDS` | Comma-separated channels the scanner skips. Default: none. |
| `BLITZ_LOG_CHANNEL_ID` | Channel removals are logged to. Unset means journal only. |
| `BLITZ_DRY_RUN` | Scan and log, delete nothing. Default `false`. |

The process refuses to start if either required variable is missing or blank,
and names every problem at once rather than one per restart (`src/config.ts`).

**The bot does not talk to members.** No DM, no reply, no "your message was
removed", ever. A removal is a line in the journal and, if
`BLITZ_LOG_CHANNEL_ID` is set, one message in a channel admins read. That is a
standing rule and not an omission — do not add user-facing copy to this bot.

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

**A token alone is not enough to get a working bot.** The application needs the
**Message Content** privileged intent turned on, and the bot needs to be in the
guild with **Manage Messages**; without the intent the gateway closes with code
4014 and login fails on every attempt, and without the permission every delete
fails. [docs/deploy.md §4](docs/deploy.md) is the checklist, and it applies to a
laptop exactly as it does to the box.

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
