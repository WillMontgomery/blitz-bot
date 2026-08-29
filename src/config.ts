import { z } from 'zod'

/**
 * Configuration, read from the environment and validated before anything
 * connects.
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
  adminRoleId: string | null
  logChannelId: string | null
  exemptChannelIds: string[]
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
  BLITZ_EXEMPT_CHANNEL_IDS: idList,
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
    exemptChannelIds: parsedEnv.BLITZ_EXEMPT_CHANNEL_IDS,
    exemptAdmins: parsedEnv.BLITZ_EXEMPT_ADMINS,
    dryRun: parsedEnv.BLITZ_DRY_RUN,
  }
}
