import { z } from 'zod'

/**
 * Configuration, read from the environment and validated before anything
 * connects.
 *
 * THE ENVIRONMENT IS POPULATED BY THE START SCRIPT, NOT BY THIS FILE. `npm
 * start` runs node with `--env-file-if-exists=.env` — Node's own dotenv
 * loader, which is why there is no dotenv dependency and why nothing here
 * opens a file. By the time `loadConfig` runs, `.env` has already become
 * ordinary environment variables, or it has not and the throw below names what
 * is missing.
 *
 * THAT FLAG IS THE FIX FOR A REAL BUG: the start script carried no env-file
 * flag at all, so the only thing that ever populated the environment was
 * systemd's `EnvironmentFile=`. Under systemd the bot booted. Every hand-run —
 * the foreground first start the runbook asks for, a restart to check a config
 * change — read an empty environment and refused to boot with a correctly
 * written `.env` sitting right next to it.
 *
 * `--env-file-if-exists`, NOT `--env-file`, because both of the awkward cases
 * are real. The environment is already populated and `.env` is there as well —
 * a systemd unit with `EnvironmentFile=`, or a variable exported in a shell —
 * and reading the file a second time changes nothing, since what is already
 * set is what wins. Or the environment is supplied some other way and no
 * `.env` was ever put on disk, and that must still boot: `--env-file` exits
 * non-zero on a file that is not there, `--env-file-if-exists` prints one line
 * and carries on. (Node 22.9 and later; `engines` already says >=24.)
 *
 * AN ALREADY-SET VARIABLE WINS OVER THE FILE. `.env` fills in keys the
 * environment does not have and overwrites nothing — which is why systemd's
 * values survive a stale `.env` next to them, and equally why an
 * `export DISCORD_BOT_TOKEN=...` left over in a shell makes editing `.env`
 * appear to do nothing at all. Pinned by a test, because a Node release that
 * quietly flipped it would change which token the bot logs in with.
 *
 * THE `.env` PATH IS RELATIVE TO THE WORKING DIRECTORY, and npm always runs a
 * script from the directory holding package.json — from a subdirectory, or via
 * `--prefix`, it chdirs there first — so `npm start` finds
 * `/opt/blitz-bot/.env` wherever the operator is standing. Running
 * `node src/index.ts` by hand from elsewhere does not get that: npm is what
 * makes the relative path safe.
 *
 * A MISSING REQUIRED VARIABLE THROWS, and that is the whole reason this file
 * exists as a file. A bot that starts without a token does not fail at
 * startup — it fails several seconds later inside discord.js, or worse, comes
 * up half-configured, moderates nothing, and looks perfectly healthy to
 * systemd for as long as nobody checks. Refusing to boot puts the variable's
 * name in `systemctl status blitz-bot`, which is the difference between a
 * two-minute fix and an evening.
 *
 * EVERY MISSING VARIABLE IS NAMED AT ONCE rather than one per restart, which
 * is how a five-minute setup becomes an hour. Copied from the console repo's
 * `lib/env.ts`, which learned it the hard way.
 *
 * NOTHING IS CACHED AND NOTHING READS `process.env` EXCEPT THE DEFAULT
 * ARGUMENT. `loadConfig(env)` is a pure function of the object handed to it,
 * so a test builds the environment it wants and never mutates the real one and
 * hopes the next test tidies up. There is no module-level singleton to reset,
 * which is deliberate: the process reads this once at boot and passes the
 * result down.
 *
 * AN UNRECOGNISED BOOLEAN IS AN ERROR, NOT A `false`. `BLITZ_DRY_RUN=ture` has
 * to stop the process, because the alternative is a bot the operator believes
 * is in dry run deleting real messages, with nothing visible from the outside
 * to say otherwise. The same argument runs the other way for
 * BLITZ_EXEMPT_ADMINS, where a typo starts deleting admins' own messages. Both
 * are cheap to get wrong in a systemd unit file and expensive to notice.
 */
export interface Config {
  discordToken: string
  guildId: string

  /**
   * The role that counts as admin, or null for "there is no such role".
   *
   * IT NOW ANSWERS TWO QUESTIONS AND UNSET MEANS THE OPPOSITE THING IN EACH,
   * which is worth stating here because it reads like an inconsistency and is
   * not one. On the moderation path it turns the admin EXEMPTION on: unset
   * means nobody is skipped and every message is scanned (`decide` in
   * client.ts). On the slash-command path it is the gate: unset means nobody
   * holds the role, so an admin-only command refuses everybody (`refusalFor` in
   * commands/command.ts).
   *
   * BOTH OF THOSE ARE THE CLOSED DIRECTION FOR WHAT THEY GUARD. A filter that
   * cannot identify an admin has to keep filtering, and a door that cannot
   * identify an admin has to stay shut. An unset variable is never the thing
   * that lets somebody through.
   */
  adminRoleId: string | null

  logChannelId: string | null

  /**
   * Where the bot reports its OWN faults, which is a different channel's job
   * from `logChannelId` even when both ids happen to be the same one.
   * `logChannelId` carries the moderation record — what was removed and why.
   * This carries the warnings and errors that would otherwise reach journalctl
   * and nobody, because the owner operates this bot from Discord.
   *
   * IT ALSO CARRIES THE DEPLOY NOTICE, for the same reason: which commit the
   * bot came up on is a fact about the bot and not about a member, and it is
   * only said when that commit CHANGED — see `announceDeployedCommit` in
   * src/client.ts. That is the whole of the informational traffic in this
   * channel; everything else in it is a warning or an error.
   *
   * UNSET IS JOURNAL-ONLY, AND THAT HAS TO KEEP WORKING. The bot is already
   * live; a required variable here would mean the next deploy refuses to boot
   * until somebody sets it.
   */
  statusChannelId: string | null

  /**
   * Where the bot keeps its own manual posted, or null for "do not".
   *
   * UNSET TURNS THE WHOLE FEATURE OFF, and that is the only reason it is
   * optional. The bot is live today with no such channel, and a variable that
   * had to be set would mean the next deploy refuses to boot until somebody
   * SSHes into the box — the interaction every other optional id here exists to
   * avoid. Null is not a degraded mode: nothing is read, nothing is posted, and
   * docs/bot-manual.md is never opened.
   *
   * A THIRD CHANNEL RATHER THAN A REUSE OF EITHER OTHER ONE. `logChannelId`
   * carries the moderation record and `statusChannelId` carries faults; both are
   * append-only records of things that happened. This one holds a document the
   * bot EDITS IN PLACE, so pointing it at either of the others would mean the
   * bot reaching into a channel of evidence and changing messages in it.
   */
  docsChannelId: string | null

  /**
   * Where the outage is announced to players, or null for "do not announce it".
   *
   * UNSET TURNS THE WATCHER OFF ENTIRELY, which is the same rule every other
   * optional id here follows and matters more for this one: with no channel to
   * post to there is nothing to poll for, so `ringmaster-maintenance` is not
   * read at all and the bot makes no AWS call it would otherwise make four times
   * a minute. Null is not a degraded mode.
   *
   * A FOURTH CHANNEL, AND IT IS THE ONLY ONE PLAYERS READ. `logChannelId` is the
   * moderation record, `statusChannelId` is the bot's own faults, `docsChannelId`
   * is a document the bot edits — all three are for whoever runs the server.
   * This one carries two sentences an ordinary member is meant to see: the
   * server is going down, and the server is back. Pointing it at any of the
   * other three would put an announcement in a channel of evidence.
   */
  maintenanceChannelId: string | null

  exemptChannelIds: string[]

  /**
   * The IPv4 addresses this community's own game servers answer on. Every other
   * IPv4-shaped string in a message is somebody else's server — see src/links.ts.
   *
   * CONFIGURATION RATHER THAN A CONSTANT, BECAUSE A THIRD SERVER MUST NOT NEED A
   * DEPLOY. This is the one thing in the link policy that is a fact about this
   * deployment rather than a fact about the internet — the shortener list is the
   * other way round and lives in the code, where it is testable and reviewable.
   *
   * IT DEFAULTS TO THE TWO ADDRESSES RATHER THAN TO AN EMPTY LIST, and unlike
   * every other optional variable here that default is not "the feature is off".
   * An empty allowlist would delete the owner's own server address out of his own
   * guild the first time anybody posted it, so an unset variable has to keep the
   * bot working rather than turn it into a filter that removes the one link the
   * channel is for.
   *
   * EVERY ENTRY IS CHECKED FOR SHAPE, NOT MERELY TRIMMED. A typo here does not
   * announce itself: the bot boots, moderates, and quietly deletes the message
   * that names its own server, which looks exactly like the bot working. And
   * links.ts trusts this list to hold ADDRESSES — it uses it to exempt a
   * `fivem://connect/` target, so a hostname smuggled into this variable would
   * be an allowlisted destination rather than a dead entry.
   */
  serverIps: string[]

  exemptAdmins: boolean
  dryRun: boolean
}

/**
 * A variable the bot cannot run without.
 *
 * `.trim()` BEFORE `.min(1)` so that a systemd `Environment=` line with a
 * stray trailing space, or an `EnvironmentFile` entry left as `KEY=`, is
 * treated as absent rather than as a one-character token. Whitespace is never
 * what anyone meant.
 */
const required = z
  .string({ required_error: 'not set' })
  .trim()
  .min(1, 'set but empty')

/**
 * An optional snowflake id.
 *
 * NULL RATHER THAN UNDEFINED OR '' because the interface says `string | null`
 * and callers should have exactly one absent value to test. Empty and
 * whitespace-only collapse to the same null for the reason above.
 */
const optionalId = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value))

/**
 * A comma-separated id list.
 *
 * EMPTY ENTRIES ARE DROPPED SILENTLY. A trailing comma, or a list broken
 * across a wrapped line, is a formatting accident and not a request to exempt
 * a channel whose id is the empty string — which would match nothing anyway
 * but would sit in the config looking like it did something.
 */
const idList = z
  .string()
  .optional()
  .transform((raw) =>
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )

/**
 * The addresses the bot's own guild runs on, used when the operator names none.
 *
 * THE SAME TWO THE OWNER GAVE, AND THEY ARE IN THE SOURCE ON PURPOSE. A default
 * that lived only in `.env.example` would be a default that a systemd
 * `EnvironmentFile=` — which never reads that file — silently does not have; see
 * this file's header for how that class of bug already bit this repo once.
 */
const DEFAULT_SERVER_IPS = ['3.130.92.28', '18.222.244.205']

/**
 * What an entry in `BLITZ_SERVER_IPS` has to look like.
 *
 * EXACTLY WHAT src/links.ts CALLS IPv4-SHAPED, deliberately: one to three digits
 * per octet and four of them, with no range check on top. An entry this accepts
 * that the matcher could never produce would be an allowlist line that silently
 * exempts nothing, and an entry the matcher can produce that this rejects would
 * be an address the operator cannot allowlist. The two notions have to be the
 * same one.
 */
const IPV4_ENTRY = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * The IP allowlist: a comma-separated list, defaulted and shape-checked.
 *
 * BLANK IS UNSET, LIKE EVERY OTHER OPTIONAL VARIABLE HERE, so a copied-but-
 * unedited `.env` gets the two real addresses rather than an allowlist of
 * nothing. There is deliberately no way to spell "allowlist nothing": the only
 * thing it could achieve is deleting messages that name this community's own
 * server, and a blank line is what a template looks like, not a request.
 *
 * A BAD ENTRY STOPS THE PROCESS instead of being dropped, which is the same
 * argument `flag` makes about `BLITZ_DRY_RUN=ture`. A silently ignored entry
 * here is a bot that boots, looks healthy, and deletes the one link the channel
 * exists for.
 */
const ipList = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    const entries = (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)

    if (entries.length === 0) return [...DEFAULT_SERVER_IPS]

    const malformed = entries.filter((entry) => !IPV4_ENTRY.test(entry))
    if (malformed.length === 0) return entries

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be comma-separated IPv4 addresses, got "${malformed.join('", "')}"`,
    })
    return z.NEVER
  })

/**
 * A "true"/"false" flag with a default.
 *
 * CASE-INSENSITIVE BUT OTHERWISE EXACT. `True` is obviously the same intent;
 * `1`, `yes` and `on` are guesses about intent, and guessing is what makes a
 * typo silently mean `false`. Unset falls back to the documented default;
 * anything else fails the parse and names the variable.
 */
function flag(fallback: boolean) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = raw?.trim().toLowerCase()
      if (value === undefined || value === '') return fallback
      if (value === 'true') return true
      if (value === 'false') return false
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be "true" or "false", got "${raw}"`,
      })
      return z.NEVER
    })
}

/**
 * Keys are the environment variable names verbatim, so zod's issue paths are
 * already the thing an operator has to go and edit. That is the only reason
 * the error assembly below can be three lines long.
 */
const schema = z.object({
  DISCORD_BOT_TOKEN: required,
  DISCORD_GUILD_ID: required,
  DISCORD_ADMIN_ROLE_ID: optionalId,
  BLITZ_LOG_CHANNEL_ID: optionalId,
  BLITZ_STATUS_CHANNEL_ID: optionalId,
  BLITZ_DOCS_CHANNEL_ID: optionalId,
  BLITZ_MAINTENANCE_CHANNEL_ID: optionalId,
  BLITZ_EXEMPT_CHANNEL_IDS: idList,
  BLITZ_SERVER_IPS: ipList,
  BLITZ_EXEMPT_ADMINS: flag(true),
  BLITZ_DRY_RUN: flag(false),
})

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid configuration:\n${problems}\n\nSee .env.example`)
  }

  const parsedEnv = parsed.data

  return {
    discordToken: parsedEnv.DISCORD_BOT_TOKEN,
    guildId: parsedEnv.DISCORD_GUILD_ID,
    adminRoleId: parsedEnv.DISCORD_ADMIN_ROLE_ID,
    logChannelId: parsedEnv.BLITZ_LOG_CHANNEL_ID,
    statusChannelId: parsedEnv.BLITZ_STATUS_CHANNEL_ID,
    docsChannelId: parsedEnv.BLITZ_DOCS_CHANNEL_ID,
    maintenanceChannelId: parsedEnv.BLITZ_MAINTENANCE_CHANNEL_ID,
    exemptChannelIds: parsedEnv.BLITZ_EXEMPT_CHANNEL_IDS,
    serverIps: parsedEnv.BLITZ_SERVER_IPS,
    exemptAdmins: parsedEnv.BLITZ_EXEMPT_ADMINS,
    dryRun: parsedEnv.BLITZ_DRY_RUN,
  }
}
