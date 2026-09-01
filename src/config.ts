import { z } from 'zod'

import { IPV4_ADDRESS } from './links.ts'

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

  /**
   * The credential the Ringmaster console's command routes want, or null for
   * "the bot cannot reach the console".
   *
   * UNPREFIXED, AND THAT IS DELIBERATE RATHER THAN AN OVERSIGHT. Every other
   * setting here is `BLITZ_`-prefixed because it belongs to this bot alone; this
   * one is the SAME VALUE that sits in `/opt/ringmaster/.env.local` under the
   * same name, so prefixing our copy would make one secret look like two. The
   * console's own `.env.example` says the same thing from the other side.
   *
   * NULL DOES NOT DISABLE MODERATION, ONLY THE LIVE KICK. The DynamoDB ban row
   * is durable the moment it is written and needs no console at all; the kick is
   * the one thing that has to go through a box that can talk to the game host.
   * So an unset secret costs a live removal and nothing else — see
   * `mirrorEntry` in src/client.ts, which reports it and carries on.
   *
   * IT IS NEVER LOGGED AND NEVER RENDERED. `loadConfig` names variables in its
   * failure message and never their values, and src/ringmaster.ts puts this in a
   * header and nowhere else.
   */
  commandSecret: string | null

  /**
   * Where the Ringmaster console answers, for the kick relay.
   *
   * IT DEFAULTS TO THE LOOPBACK, AND UNLIKE ALMOST EVERYTHING ELSE HERE THE
   * DEFAULT IS NOT "OFF". The bot is the second service on the console's own box
   * (docs/deploy.md), and the console listens on 127.0.0.1:3000 there — so the
   * address is a fact about this deployment that an operator should not have to
   * restate, in the same way `serverIps` is. What turns the relay off is
   * `commandSecret` being unset, which is one switch rather than two.
   *
   * LOOPBACK RATHER THAN THE PUBLIC HOSTNAME ON PURPOSE. Going out through
   * Cloudflare and back would put the shared secret on the public internet and
   * the console's availability behind a CDN, to reach a process on the same
   * machine. Port 3000 is closed to the internet (docs/deploy.md) precisely so
   * that this address is the private one.
   *
   * ORIGIN ONLY — scheme, host, port. A path, a query or a fragment is refused
   * at boot rather than silently concatenated into `…/api/kick`, because a
   * base URL with a stray trailing path is a 404 that looks exactly like a
   * console that is down.
   */
  ringmasterUrl: string

  /**
   * WHERE A PERSON REACHES THE CONSOLE IS NOT HERE, AND THAT IS THE ANSWER
   * RATHER THAN AN OMISSION. It is `CONSOLE_URL` in src/console.ts, a module
   * constant, for the reason `REPO_URL` in src/client.ts is one: there is one
   * Ringmaster console and no deployment for which a different value would be
   * right, so a variable would buy nothing and would add a way to get a
   * moderation link wrong. A `BLITZ_RINGMASTER_PUBLIC_URL` was drafted here and
   * dropped before it shipped, once the constant it duplicated was found.
   *
   * `ringmasterUrl` ABOVE IS NOT THAT ADDRESS AND NOTHING MAY BUILD A LINK FROM
   * IT. It is the server-to-server loopback on a port closed to the internet; a
   * button built from it opens `127.0.0.1` on the clicker's own machine, which
   * looks like a working link and fails like a console that is down.
   */

  /**
   * The role that marks somebody as banned in the GAME but not from Discord.
   *
   * THE POLICY IT IMPLEMENTS IS THE OWNER'S AND IS ASYMMETRIC ON PURPOSE. A
   * Discord ban means banned in the game, permanently. A game ban never means a
   * Discord ban: it assigns this role, so the person keeps limited access to the
   * server and can argue their case. Lifting or expiring the game ban takes the
   * role off again.
   *
   * THE ID IS IN THE SOURCE AS A DEFAULT, FOR `DEFAULT_SERVER_IPS`'S REASON. A
   * value that lived only in `.env.example` is a value systemd's
   * `EnvironmentFile=` never reads, and the failure would be silent: the ban is
   * mirrored, the role is not touched, and the policy is half-implemented in a
   * way nothing in the guild shows. Overridable so a second guild is a variable
   * rather than a code change.
   *
   * IT IS THE ONE ID HERE THAT CANNOT BE TURNED OFF BY BLANKING IT, again like
   * `serverIps`: a blank line is what an unedited template looks like, and the
   * only thing "no role" could mean is a policy the owner settled being quietly
   * skipped.
   */
  gameBanRoleId: string
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
 * A Discord snowflake.
 *
 * COPIED FROM THE CONSOLE'S `SNOWFLAKE` IN lib/service.ts, DIGIT RULE AND ALL —
 * `[0-9]{1,32}` rather than the seventeen-to-nineteen ids are today. That file
 * explains why at length and the reasoning carries over unchanged: the format is
 * documented to grow, and a second, stricter opinion about the same value in the
 * same system is a bug waiting for the year the digit count changes.
 *
 * IT NOW APPLIES TO EVERY ID IN THIS FILE, AND USED TO APPLY TO ONE.
 * `idWithDefault` ran it; `optionalId` and `idList` took any non-empty string. So
 * `BLITZ_DOCS_CHANNEL_ID=#bot-docs` — or the same id with a stray space around it,
 * or a smart quote picked up somewhere between a phone and an SSH session — loaded
 * as a perfectly good non-null value and failed much later at `channels.fetch`, as
 * an error about a channel that cannot be read. That sends the operator into
 * Discord's permission settings for a fault that is in his own `.env`.
 *
 * THE HAND-TYPED VALUE IS THE ORDINARY CASE HERE, NOT THE EXOTIC ONE. The `.env`
 * on the box is filled in by hand: docs/deploy.md ships a heredoc that a person
 * copies and then completes by reading ids off a Discord client, and it leaves
 * most of these lines blank for him to do exactly that. A mention, a stray space
 * or a smart quote is what a value typed or pasted that way looks like when it
 * goes wrong — not a fault an operator has to be unlucky to hit.
 *
 * `DISCORD_GUILD_ID` IS STILL CHECKED ONLY FOR PRESENCE, and that is a different
 * case rather than the one this misses. A guild id that is wrong already stops the
 * bot moderating with the variable's own name in the message — `haltModeration`
 * in src/client.ts — which is the outcome the check below exists to produce.
 */
const SNOWFLAKE = /^[0-9]{1,32}$/

/**
 * An optional snowflake id.
 *
 * NULL RATHER THAN UNDEFINED OR '' because the interface says `string | null`
 * and callers should have exactly one absent value to test. Empty and
 * whitespace-only collapse to the same null for `required`'s reason above:
 * whitespace is never what anyone meant.
 *
 * SET-BUT-MISSHAPEN IS NOT ABSENT, AND IT IS NOT A VALUE EITHER. It stops the
 * process with the variable named, for the reason `SNOWFLAKE` above gives: a
 * config fault that names the variable beats a runtime error that blames Discord.
 */
const optionalId = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    const value = raw?.trim()
    if (value === undefined || value === '') return null
    if (SNOWFLAKE.test(value)) return value

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be a Discord id, got "${value}"`,
    })
    return z.NEVER
  })

/**
 * An optional shared secret.
 *
 * IT USED TO BE `optionalId`'S TRANSFORM UNDER A SECOND NAME, AND THE SEPARATION
 * IS WHAT MADE THE DIVERGENCE SAFE. The name existed because `optionalId:
 * optionalId` reads as "this is a snowflake" to the next person editing the
 * schema, and the one thing that must never happen to this value is somebody
 * deciding it can be shape-checked and putting a fragment of it in an error
 * message. `optionalId` has since been shape-checked, exactly as feared, and this
 * one did not follow it there because it was already a separate declaration.
 *
 * NO `.min()`, NO PATTERN, NOTHING THAT COULD ECHO IT. `loadConfig`'s failure
 * message is written to stderr and to `systemctl status`; a zod issue that
 * quoted the value the way `ipList` quotes a bad address would put the console's
 * command credential in the journal.
 */
const optionalSecret = z
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
 *
 * A MISSHAPEN ENTRY IS NOT A FORMATTING ACCIDENT AND STOPS THE PROCESS, the same
 * split `ipList` makes below. `#general` in this list is the quietest of all the
 * ids here when it is wrong: nothing ever fetches an exempt channel, so there is
 * no later error at all — the scanner simply compares it against a real
 * `channelId`, never matches, and moderates the channel the operator believed he
 * had exempted. See `SNOWFLAKE`.
 */
const idList = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    const entries = (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)

    const malformed = entries.filter((entry) => !SNOWFLAKE.test(entry))
    if (malformed.length === 0) return entries

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must be comma-separated Discord ids, got "${malformed.join('", "')}"`,
    })
    return z.NEVER
  })

/**
 * The address the community connects to, and the head of the allowlist.
 *
 * NAMED SEPARATELY BECAUSE TWO THINGS NEED IT AND ONLY ONE OF THEM IS A FILTER.
 * The allowlist below answers "may this message name this address"; `connectIp`
 * answers "which address do we tell somebody to type", which is a question the
 * maintenance notice asks when it says the server is back up. Both are this same
 * string, and naming it once is what stops the second reader from pasting a
 * literal into a sentence — where a server move would leave the notice pointing
 * players at a box that is not there while the allowlist quietly moved on.
 */
const PRIMARY_SERVER_IP = '3.130.92.28'

/**
 * The addresses the bot's own guild runs on, used when the operator names none.
 *
 * THE SAME TWO THE OWNER GAVE, AND THEY ARE IN THE SOURCE ON PURPOSE. A default
 * that lived only in `.env.example` would be a default that a systemd
 * `EnvironmentFile=` — which never reads that file — silently does not have; see
 * this file's header for how that class of bug already bit this repo once.
 *
 * EXPORTED SINCE THE MAINTENANCE NOTICE NEEDED AN ADDRESS. src/maintenance.ts is
 * wired by src/client.ts, which does not hand it a `Config` — so its default has
 * to come from somewhere, and the only acceptable somewhere is the list an
 * operator actually configures. See `connectIp`.
 */
export const DEFAULT_SERVER_IPS = [PRIMARY_SERVER_IP, '18.222.244.205']

/**
 * WHICH ADDRESS A PLAYER IS TOLD TO CONNECT TO.
 *
 * THE FIRST ENTRY OF THE ALLOWLIST, AND NOT A CONSTANT OF ITS OWN. The owner's
 * back-up notice ends by naming an address — "fivem://connect/3.130.92.28" — and
 * the allowlist already holds that string because links.ts needs it to know which
 * `fivem://connect/` target is this community's own. A second literal in the
 * notice would be a copy that nothing keeps in step: move the server, update
 * `BLITZ_SERVER_IPS`, and the announcement that follows the next restart sends
 * every player to the old box.
 *
 * THE BARE URL IS THE NOTICE'S REAL ENDING AND THE MASKED FORM IS NOT. The
 * `[Click here to connect](…)` spelling shipped for one cycle and printed as
 * literal brackets; `connectLink` in src/maintenance.ts holds the live message
 * that settled it and the reading taken from it. Nothing here depends on which
 * form it is — the address is the address — which is exactly why this quote sat
 * a cycle out of date without anything failing.
 *
 * FIRST RATHER THAN ANY OTHER RULE, because the allowlist is ordered and the
 * documented order is the community's own: the head is the address people are
 * given, the rest are the other boxes whose links must not be deleted. There is
 * nothing on the list that says which is "primary" and inventing a marker would
 * be a second setting to get wrong.
 *
 * THE FALLBACK IS THE SAME STRING THE ALLOWLIST FALLS BACK TO, so a caller with
 * no list in hand and an operator who never set the variable land on one value.
 * An allowlist cannot be empty — `ipList` refuses to produce one — so this arm is
 * unreachable through `loadConfig` and exists because the parameter is a plain
 * array that a caller can hand over empty.
 */
export function connectIp(serverIps: readonly string[] = DEFAULT_SERVER_IPS): string {
  return serverIps[0] ?? PRIMARY_SERVER_IP
}

/**
 * What an entry in `BLITZ_SERVER_IPS` has to look like.
 *
 * EXACTLY WHAT src/links.ts CALLS IPv4-SHAPED, AND NOW LITERALLY THE SAME
 * REGEX. An entry this accepts that the matcher could never produce is an
 * allowlist line that silently exempts nothing, and an entry the matcher can
 * produce that this rejects is an address the operator cannot allowlist. The two
 * notions have to be the same one.
 *
 * THEY WERE NOT, AND THE COMMENT HERE SAID THEY WERE. This used to be
 * `/^\d{1,3}(?:\.\d{1,3}){3}$/` — one to three digits per octet with no range
 * and no leading-zero rule — while links.ts has rejected an octet over 255 and a
 * padded octet since the ShadowPlay clips forced the question. So
 * `BLITZ_SERVER_IPS=999.1.1.1` and `BLITZ_SERVER_IPS=014.22.5.3` booted, and
 * each put a line in the allowlist that no matched address could ever equal:
 * protection in the config file, nothing at all in the process. Importing the
 * pattern is the only version of "the same one" that a later edit cannot undo.
 */
const IPV4_ENTRY = IPV4_ADDRESS

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
 * Where the console answers when nobody says otherwise. See `Config.ringmasterUrl`.
 *
 * IN THE SOURCE RATHER THAN IN `.env.example` ONLY, for `DEFAULT_SERVER_IPS`'s
 * reason: a systemd `EnvironmentFile=` never reads that file, so a default that
 * lives there alone is a default production does not have.
 */
const DEFAULT_RINGMASTER_URL = 'http://127.0.0.1:3000'

/**
 * The role the owner settled on for a game ban. See `Config.gameBanRoleId`.
 *
 * A LITERAL, BECAUSE THE POLICY IS SETTLED AND THE GUILD IS ONE GUILD. The same
 * argument as `DEFAULT_SERVER_IPS`: an operator who has to discover this from a
 * template is an operator whose next deploy quietly stops enforcing half of a
 * rule the owner wrote down.
 */
const DEFAULT_GAME_BAN_ROLE_ID = '1542596612306505808'

/**
 * `BLITZ_RINGMASTER_URL`: scheme, host, port, and nothing after them.
 *
 * ═══ IT IS ONE TRANSFORM AGAIN, AND THAT IS THE POINT ═══
 *
 * THE BODY BELOW WAS BRIEFLY A SEPARATE `asOrigin(value, ctx)` WITH ONE CALLER.
 * It was pulled out so that a second variable could share it — a
 * `BLITZ_RINGMASTER_PUBLIC_URL` for `incidentRow`'s button — and that variable
 * was dropped before it shipped, once `CONSOLE_URL` was found already in
 * src/commands/profile.ts: there is one Ringmaster console, so a second variable
 * bought nothing and added a boot failure on a malformed value (see
 * src/console.ts). Neither the helper nor the variable ever reached a commit and
 * NEITHER IS IN THE HISTORY — a `git log -S` for either finds nothing, and that
 * is stated here because the version of this comment that dated them to a
 * particular week was inventing a provenance for an argument that does not need
 * one. The argument is what survives: a function whose only caller is the next
 * four lines is a name and an indirection with nothing on the other end of it,
 * so it is folded back in. Pulling it out again beside a second caller is a
 * smaller change than keeping it against one.
 *
 * ═══ THE CHECKS THEMSELVES ═══
 *
 * PARSED WITH `URL` RATHER THAN MATCHED WITH A REGEX, because the thing that
 * has to agree is not this file's idea of a URL but the one `fetch` will build
 * the request from — src/ringmaster.ts concatenates `/api/kick` onto whatever
 * comes out of here, so the check and the use must be the same parser.
 *
 * A PATH, QUERY OR FRAGMENT IS REFUSED RATHER THAN TRIMMED. `…:3000/console`
 * concatenated with `/api/kick` is a 404, and a 404 out of the console is
 * indistinguishable from a console that is down — an evening spent on the wrong
 * service. The trailing slash `URL` always produces is the one exception and is
 * removed, because that spelling IS just the origin.
 *
 * http AND https ONLY. `file:` and `data:` parse perfectly well and would send
 * the command credential somewhere no console is listening.
 */
const originUrl = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    const value = raw?.trim()
    if (value === undefined || value === '') return DEFAULT_RINGMASTER_URL

    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be a URL, got "${value}"`,
      })
      return z.NEVER
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be an http or https URL, got "${value}"`,
      })
      return z.NEVER
    }

    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be an origin with no path, query or fragment, got "${value}"`,
      })
      return z.NEVER
    }

    // `URL.origin` rather than the input, so `HTTP://Localhost:3000` and
    // `http://localhost:3000/` become one spelling before anything concatenates
    // a path onto them.
    return parsed.origin
  })

/**
 * An id that has a default and cannot be blanked away. See `gameBanRoleId`.
 */
const idWithDefault = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = raw?.trim()
      if (value === undefined || value === '') return fallback
      if (SNOWFLAKE.test(value)) return value

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be a Discord id, got "${value}"`,
      })
      return z.NEVER
    })

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

  // Unprefixed, because the same value with the same name is in the console's
  // own dotenv file. See `Config.commandSecret`.
  COMMAND_SECRET: optionalSecret,
  BLITZ_RINGMASTER_URL: originUrl,
  BLITZ_GAME_BAN_ROLE_ID: idWithDefault(DEFAULT_GAME_BAN_ROLE_ID),
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
    commandSecret: parsedEnv.COMMAND_SECRET,
    ringmasterUrl: parsedEnv.BLITZ_RINGMASTER_URL,
    gameBanRoleId: parsedEnv.BLITZ_GAME_BAN_ROLE_ID,
  }
}
