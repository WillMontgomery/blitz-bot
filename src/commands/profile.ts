import { ApplicationCommandOptionType, type APIEmbedField } from 'discord.js'

import {
  isBanActive,
  qualifyId,
  type Ban,
  type Ddb,
  type DdbFailure,
  type DdbResult,
  type GameProfile,
  type PlayerRecord,
} from '../ddb.ts'
import { log } from '../log.ts'
import { TARGET_OPTION, type BotCommand } from './command.ts'

/**
 * `/profile @user` — everything the bot knows about one Discord account.
 *
 * ADMIN-ONLY AND ALWAYS EPHEMERAL, AND THOSE ARE TWO DIFFERENT GUARANTEES.
 * `adminOnly` decides who may RUN it and is enforced by `refusalFor`;
 * `onlyInvoker` decides who SEES the answer and is fixed at the defer. Both are
 * needed and neither substitutes for the other: an admin-only command whose
 * reply landed in the channel would put a member's ban history, their licence
 * list and their name history in front of everybody who happened to be reading,
 * and there is no undo for that. `onlyInvoker` is therefore a constant here
 * rather than a function of anything — see below.
 *
 * SPLIT IN THREE, THE WAY command.ts IS SPLIT. `gatherProfile` does the reads
 * and produces a record; `profileEmbed` turns that record into an embed and is
 * pure; `profileCommand` is four lines of wiring. So the interesting halves —
 * what happens when three of five reads fail, and what happens when the answer
 * is too big for Discord — are exercised against objects written above the
 * assertion, with no AWS and no gateway.
 *
 * NOTHING HERE THROWS ON A FAILED READ. Every `ddb.ts` call returns a result,
 * and a source that could not be reached becomes a NAMED absence in the reply
 * rather than a dead command: an admin who asks about a player during an IAM
 * problem should be told which table went missing and shown the four that
 * answered, not handed `runCommand`'s generic failure line. `br-players` is
 * denied by the role the bot holds today (docs/aws-notes.md), so the partial
 * answer is the EXPECTED one rather than the unlucky one.
 *
 * TWO THINGS THIS FILE CANNOT FINISH ON ITS OWN, both named here because they
 * are visible in the reply rather than hidden in a TODO:
 *
 *   THE REPLY IS TEXT, NOT AN EMBED, UNTIL THE SEAM IS WIDENED. `BotCommand.run`
 *   returns a `string` and `Responder.edit` takes a `string`, so the embed this
 *   file builds is flattened by `flattenEmbed` before it goes out. The embed is
 *   the artifact and the flattening is mechanical — when `run` may return
 *   embeds, `profileCommand` returns `{ embeds: [embed] }` and `flattenEmbed`
 *   is deleted. Both halves of the budget are on the embed, which is why the
 *   flattening has a cap of its own: a message's content limit is 2000 and an
 *   embed's is 6000.
 *
 *   THERE IS NO MATCH-HISTORY READER. `br-players` hangs one `match#…` row off
 *   a player's partition per match, and `Ddb` offers `gamePlayers.profile` and
 *   nothing else — no Query, and no `dynamodb:Query` on `br-players` in the
 *   policy table in docs/aws-notes.md either. `ProfileReads.matches` is
 *   therefore OPTIONAL, and a build without one says so in the reply under
 *   "could not be read" instead of quietly rendering an empty history. The
 *   truncation the history needs is written and tested against an injected
 *   reader; wiring it is one line in `readsFrom`.
 */

/**
 * PLACEHOLDER-FREE, DELIBERATELY, AND THAT IS A DIFFERENT CALL FROM command.ts.
 * The strings in `COPY` there are things a MEMBER reads — a refusal, a failure
 * — and the owner supplies those verbatim. Everything here is read by an admin,
 * in a reply only they can see, and every one of these strings is either a
 * label on a number or one of the three statements the command exists to make:
 * how many licences there are, how much was cut, and what could not be read.
 * A placeholder in any of those is a command that cannot answer its question.
 *
 * ONE RECORD ANYWAY, for the reason command.ts gives: changing the wording is
 * an edit to one object rather than a hunt through the file.
 *
 * `description` AND `userOption` GO TO DISCORD AT REGISTRATION and are what an
 * admin reads in the command picker; Discord will not accept an empty one.
 * Those two are the ones to hand back if the owner wants his own words.
 */
const COPY = {
  /** Discord allows 1-100 characters here. */
  description: 'Look a player up by their Discord account',

  /** Same limit, on the option. */
  userOption: 'Whose profile to show',

  /** Discord guarantees a required option; this is what is said if it ever does not. */
  noTarget: 'No user was given.',

  /** The embed title when no in-game name is known. */
  title: 'Player profile',

  subject: (discordId: string) => `<@${discordId}> \`${discordId}\``,

  /** Not an error. A Discord account that has never played is a normal answer. */
  noRecord: 'No player record for this Discord account.',

  indexUnreadable:
    'The Discord-to-licence index could not be read, so nothing else could be looked up.',

  /**
   * THE SENTENCE THIS COMMAND EXISTS FOR. `ringmaster-player-ids` returns a
   * LIST, and more than one entry means this Discord account has connected
   * under more than one licence — the identifier-reuse signal the console files
   * incidents about. Showing the licences without saying this leaves the reader
   * to notice a count for themselves, which is the same as not saying it.
   */
  oneLicence: 'One licence.',
  manyLicences: (count: number) =>
    `${count} licences — this Discord account has played under more than one.`,

  licences: 'Licences',
  licencesOmitted: (count: number) => `+${count} older licences not shown.`,

  /**
   * What every OTHER field says when its lines did not fit.
   *
   * NOT `licencesOmitted`, WHICH IS THE POINT OF IT BEING A SECOND STRING. The
   * fields below are packed by the same function, and reusing the licence
   * wording would have a career field that overflowed report "+2 older licences
   * not shown" — a sentence about a thing that did not happen, in the one place
   * this file is trying hardest to be honest.
   */
  linesOmitted: (count: number) => `+${count} more not shown.`,

  bans: 'Bans',
  noBans: 'No ban on any licence read.',
  bansSkipped: (count: number) => `${count} older licences were not checked for bans.`,

  career: 'Career',
  noCareer: 'No match record on the game side.',

  registry: 'Server record',
  noRegistry: 'No row in the server registry.',
  alsoKnownAs: (names: string, more: number) =>
    more > 0 ? `Also known as ${names} (+${more} more)` : `Also known as ${names}`,

  matches: 'Recent matches',
  noMatches: 'No matches read.',

  /**
   * TWO DIFFERENT CUTS, AND CONFLATING THEM WOULD BE THE LIE. `read` is how
   * many rows the reader returned, which is bounded by `MATCH_FETCH`; `shown`
   * is how many survived the embed's budget; `total` is how many matches the
   * career row says the player has ever played. Saying "10 omitted" when 300
   * were never fetched is a truncation that reads as complete, so both numbers
   * are said whenever they differ.
   */
  matchesNote: (shown: number, read: number, total: number | null): string | null => {
    const parts: string[] = []

    if (shown < read) parts.push(`${read - shown} of the ${read} read were not shown.`)
    if (total !== null && total > read) parts.push(`${total} matches recorded in all.`)

    return parts.length === 0 ? null : parts.join(' ')
  },

  unreached: 'Could not be read',

  /**
   * Named per source, and the reason is the failure KIND and never its message.
   * `DdbFailure.message` carries table names and AWS request detail and is
   * operator-facing by its own documentation; the kind is a closed set of six
   * words and is the difference between "try again" and "call whoever runs the
   * box". The message goes to the journal, where it belongs.
   */
  unreachedLine: (source: ProfileSource, why: ProfileFault) => `${source}: ${why}`,

  /** The embed did not fit a message. Only reachable while the reply is text. */
  blocksDropped: (count: number) => `${count} further sections did not fit.`,

  /**
   * The last-resort trim in `trimEmbed`. A field of its own rather than a line
   * appended to another one, because the fields it is reporting on are gone and
   * there may be no other one left to append to.
   */
  dropped: 'Not shown',
  fieldsDropped: (count: number) => `${count} further sections did not fit.`,

  unknownTime: 'unknown',
}

/* ------------------------------------------------------------------ *
 * Discord's limits.
 *
 * COUNTED IN UTF-16 CODE UNITS, WHICH IS WHAT DISCORD COUNTS, and that is the
 * one measurement in this file worth getting right on purpose. `fitEmbed` in
 * client.ts used to count code points here and had the failure backwards: the
 * limits apply to the JSON string as it arrives, which is UTF-16, so a
 * code-point count UNDERSTATES every astral character by half — 4096 musical
 * symbols passed a 4096 guard at 8192 units and the post came back 50035.
 * `String#length` is the number Discord is checking against, so `units` is
 * `length` and every cut below measures with it.
 *
 * CUTTING IS A DIFFERENT QUESTION FROM MEASURING, and it goes the other way:
 * `slice` can land inside a surrogate pair and leave half a character in the
 * reply, so `cut` walks CODE POINTS and stops when the UTF-16 total would be
 * exceeded. Measure what Discord measures, cut where a character actually ends.
 * ------------------------------------------------------------------ */

const EMBED_TITLE_CAP = 256
const EMBED_DESCRIPTION_CAP = 4096
const EMBED_FIELD_CAP = 25
const EMBED_FIELD_VALUE_CAP = 1024
const EMBED_TOTAL_CAP = 6000

/** A message's own content limit, which is a third of an embed's. See the header. */
const MESSAGE_CONTENT_CAP = 2000

/**
 * How much of a line of somebody else's text survives.
 *
 * A PER-LINE CAP SO THAT NO SINGLE LINE CAN EXCEED A FIELD. A ban reason is
 * free text an admin typed, so it is the one value here with no natural bound,
 * and a 4000-character reason would otherwise be a field value that cannot be
 * packed at all — `packed` below drops whole lines, and a first line that does
 * not fit leaves it nothing to do. Capping at construction means the packing
 * loop always has a way out.
 */
const LINE_CAP = 240

/**
 * How many licences are ban-checked.
 *
 * A BOUND ON A FAN-OUT AN ADMIN IS WAITING ON. Every licence gets its own
 * GetItem, and they run in parallel, but an unbounded list is an unbounded
 * number of requests on a path with a person at the end of it. Ten is chosen
 * because a Discord account with more than ten licences is already the answer
 * to the question being asked — and the reply says how many were not checked,
 * so the cap is visible rather than silent.
 *
 * THE MOST RECENT TEN, because those are the ones the account is using now.
 * The older ones are the more interesting half of a ban-evasion story, which is
 * exactly why the count of skipped ones is stated rather than dropped.
 */
const LICENCE_CAP = 10

/** How many match rows the reader is asked for. See `COPY.matchesNote`. */
const MATCH_FETCH = 25

/** How many past names are listed before the rest become a count. */
const NAME_HISTORY_CAP = 5

/**
 * The floor under the match field. Below this there is no room for a line AND
 * the note that says how much was cut, and a field carrying only a truncation
 * notice is worse than no field.
 */
const MATCH_FIELD_FLOOR = 120

/* ------------------------------------------------------------------ */

/** What Discord is told, and what `flattenEmbed` reads. Assignable to `APIEmbed`. */
export interface ProfileEmbed {
  readonly title: string
  readonly description: string
  readonly fields: APIEmbedField[]
}

/**
 * One match, reduced to what a line of history says.
 *
 * NOT TRANSCRIBED FROM A KNOWN SHAPE, UNLIKE EVERY ROW TYPE IN ddb.ts, AND
 * THAT IS THE POINT OF IT BEING HERE. The `match#…` rows are written by
 * br_ddb, in Lua, in another repo, and nothing in this repo has ever read one —
 * so the attribute names are not established fact and this file must not
 * pretend otherwise. This is what the RENDERER needs; projecting a game row
 * into it is the reader's job, in ddb.ts, next to `gamePlayers.profile`, which
 * already projects field by field for the same reason. Every field but the sort
 * key is nullable because a field that arrives missing should cost that field
 * and not the line.
 */
export interface MatchSummary {
  /** The row's sort key, `match#…`. The one thing a row certainly has. */
  readonly sk: string
  /** When it was played, ms. */
  readonly at: number | null
  /** Where they finished. */
  readonly placement: number | null
  readonly kills: number | null
}

/** The five things a profile is assembled from, named so an absence can be too. */
export type ProfileSource = 'licences' | 'bans' | 'career' | 'registry' | 'matches'

/**
 * Why a source is missing.
 *
 * `DdbFailureKind` PLUS ONE, and the extra one is not a failure: `unavailable`
 * means this BUILD has no reader for that source, which today is match history
 * and nothing else. Folding it into `error` would tell an operator to go and
 * look at DynamoDB for something DynamoDB was never asked.
 */
export type ProfileFault = DdbFailure['kind'] | 'unavailable'

export interface Unreached {
  readonly source: ProfileSource
  readonly why: ProfileFault
}

/** A licence and the ban row read for it, which is usually null. */
export interface LicenceBan {
  readonly licence: string
  readonly ban: Ban | null
}

/**
 * Everything the reply is built from, with the absences kept rather than
 * flattened away.
 *
 * A PARTIAL READ IS A VALUE HERE, NOT AN EXCEPTION. `career: null` alone cannot
 * distinguish "has never played" from "the table was denied", and those are
 * opposite sentences to tell an admin — so the second one is in `unreached` and
 * the renderer asks.
 */
export interface ProfileData {
  readonly discordId: string

  /**
   * The licences the index holds, IN STORED ORDER: most recent LAST. Kept in
   * that order because it is what the table says; the renderer reverses it for
   * display and says which one is current.
   */
  readonly licences: readonly string[]

  /** The licence every read below was made against: the most recent one. */
  readonly current: string | null

  readonly bans: readonly LicenceBan[]
  /** Licences the cap meant were never ban-checked. Said in the reply. */
  readonly bansSkipped: number

  readonly career: GameProfile | null
  readonly registry: PlayerRecord | null
  readonly matches: readonly MatchSummary[]

  readonly unreached: readonly Unreached[]
}

/**
 * The reads one profile needs, and nothing else this bot can do.
 *
 * NARROWER THAN `Ddb` ON PURPOSE. `Ddb` also writes the audit log and the bot's
 * own state, and a lookup command has no business being handed either — this
 * interface is what a test builds in six lines and what the real thing is
 * adapted down to by `readsFrom`.
 *
 * `matches` IS OPTIONAL BECAUSE NO READER EXISTS YET. See the file header. An
 * absent one is reported as `unavailable`, not as an empty history.
 */
export interface ProfileReads {
  /** By RAW Discord id; qualifying it is this seam's job, not the caller's. */
  licencesFor: (discordId: string) => Promise<DdbResult<string[]>>
  ban: (licence: string) => Promise<DdbResult<Ban | null>>
  career: (licence: string) => Promise<DdbResult<GameProfile | null>>
  registry: (licence: string) => Promise<DdbResult<PlayerRecord | null>>
  matches?: (licence: string, limit: number) => Promise<DdbResult<MatchSummary[]>>
}

/**
 * The real module, adapted down.
 *
 * `qualifyId` HERE AND NOWHERE ELSE. `ringmaster-player-ids` is keyed on the
 * QUALIFIED identifier, so a lookup for `280…` rather than `discord:280…` is a
 * perfectly valid GetItem that returns no row — and "this account has never
 * been here" is a sentence the bot would then say with confidence about
 * somebody who is in the table. Doing it at the seam means no caller can forget.
 *
 * THE LICENCES COME BACK ALREADY QUALIFIED and are passed to the other three
 * reads exactly as stored. Qualifying them a second time would produce
 * `license:license:…` and, again, an empty answer rather than an error.
 */
export function readsFrom(ddb: Ddb): ProfileReads {
  return {
    licencesFor: (discordId) => ddb.playerIds.licensesFor(qualifyId('discord', discordId)),
    ban: (licence) => ddb.bans.get(licence),
    career: (licence) => ddb.gamePlayers.profile(licence),
    registry: (licence) => ddb.players.get(licence),

    // `matches` is deliberately absent: `Ddb` has no match-history reader and
    // the policy in docs/aws-notes.md has no Query on `br-players`. See the
    // file header for the one line that turns it on.
  }
}

/**
 * The same, built on first use rather than at import.
 *
 * THIS EXISTS SO THAT REGISTERING THE COMMAND IS ONE LINE AND COSTS NOTHING.
 * The command list in ./index.ts is a module-level constant, so
 * `profileCommand(readsFrom(createDdb()))` there would construct a DynamoDB
 * client while that module is being IMPORTED — including by commands.test.ts,
 * which is meant to run offline and has no reason to hold an SDK client.
 * `createDdb`'s own comment says it is called "once from the entrypoint rather
 * than from module scope"; this keeps that true without pushing a lazy `let`
 * into a file the command does not own.
 *
 * IT ALSO KEEPS THE GATE IN docs/aws-notes.md HONEST FOR ONE MORE STEP. Nothing
 * in this bot has ever made an AWS call, and blitz-bot#4 is meant to give the
 * bot its own IAM identity BEFORE the first one. Building the client lazily
 * does not spend that gate at boot — the first `/profile` does — but the first
 * `/profile` is exactly where somebody will be watching.
 *
 * ONE `Ddb` FOR THE LIFE OF THE PROCESS, not one per invocation: the SDK client
 * holds the connection pool and the resolved credentials, and rebuilding it per
 * command would re-resolve the instance role on every lookup.
 */
export function lazyReadsFrom(make: () => Ddb): ProfileReads {
  let built: ProfileReads | null = null

  const reads = (): ProfileReads => (built ??= readsFrom(make()))

  return {
    licencesFor: (discordId) => reads().licencesFor(discordId),
    ban: (licence) => reads().ban(licence),
    career: (licence) => reads().career(licence),
    registry: (licence) => reads().registry(licence),

    // Absent for the reason it is absent above, and it has to be absent HERE
    // too: an arrow function delegating to `reads().matches` would be a
    // `matches` that exists, and the reply would show an empty history instead
    // of saying there is no reader.
  }
}

/* ------------------------------------------------------------------ *
 * Measuring and cutting.
 * ------------------------------------------------------------------ */

/** What Discord counts. See the limits block above. */
function units(text: string): number {
  return text.length
}

/**
 * At most `cap` UTF-16 units, ending on a whole character, with an ellipsis
 * when anything was dropped.
 *
 * THE ELLIPSIS IS PART OF THE BUDGET rather than added to it, so the result of
 * this function always satisfies the cap it was given. `cap` below 2 has no
 * room for a character and an ellipsis both; it is clamped rather than
 * special-cased, because every caller derives its cap from a constant and none
 * of them can reach that.
 */
function cut(text: string, cap: number): string {
  if (units(text) <= cap) return text

  const room = Math.max(1, cap - 1)
  let kept = ''

  // Code points, not `slice`: a UTF-16 cut can land in the middle of a
  // surrogate pair and leave half a character in the reply.
  for (const point of text) {
    if (units(kept) + units(point) > room) break
    kept += point
  }

  return `${kept}…`
}

/**
 * Somebody else's text as one line.
 *
 * NEWLINES OUT OF EVERY BORROWED VALUE, for the reason log.ts escapes them: a
 * ban reason or an in-game name is written by a person, a field here is read as
 * one line per fact, and a newline inside a value forges facts that nobody
 * recorded. Collapsing all whitespace also stops a name of forty spaces from
 * spending a field's budget on nothing.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** ISO 8601 in UTC, like every other stamp in this repo, or a word saying there isn't one. */
function stamp(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return COPY.unknownTime

  const at = new Date(ms)
  return Number.isNaN(at.getTime()) ? COPY.unknownTime : at.toISOString()
}

/** Hours and minutes. Not localised: this is read in a log paste as often as in Discord. */
function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * Lines into one field value, dropping from the END until it fits and saying
 * how many went.
 *
 * THE COUNT IS INSIDE THE BUDGET, which is why the note is recomputed on every
 * pass rather than measured once: dropping a line changes the number in the
 * sentence that says how many were dropped, and a note that was measured before
 * the last drop is a field value one digit over the cap.
 *
 * A TRUNCATION THAT SAYS NOTHING IS A LIE, so there is no path here that
 * silently shortens. The last-resort return cannot be reached by any caller —
 * every line is capped at `LINE_CAP` at construction, which is a fifth of the
 * smallest budget this is ever given — and it still ends in an ellipsis rather
 * than in a clean-looking sentence.
 */
function packed(lines: readonly string[], note: (dropped: number) => string, cap: number): string {
  for (let kept = lines.length; kept > 0; kept--) {
    const body = lines.slice(0, kept).join('\n')
    const tail = kept === lines.length ? '' : `\n${note(lines.length - kept)}`

    if (units(body) + units(tail) <= cap) return `${body}${tail}`
  }

  // Never empty, even on the path no caller can reach: Discord refuses a field
  // with an empty value outright, and a reply it refuses is a reply that
  // reaches the admin as `runCommand`'s failure line instead.
  return cut(lines[0] ?? COPY.unknownTime, cap)
}

/* ------------------------------------------------------------------ *
 * The reads.
 * ------------------------------------------------------------------ */

/** Nothing was found, or nothing could be. Both are answers rather than errors. */
function nothing(discordId: string, unreached: readonly Unreached[]): ProfileData {
  return {
    discordId,
    licences: [],
    current: null,
    bans: [],
    bansSkipped: 0,
    career: null,
    registry: null,
    matches: [],
    unreached,
  }
}

/**
 * Read everything about one Discord account, and never throw.
 *
 * THE INDEX IS READ FIRST AND ALONE, because every other read is keyed on what
 * it returns. A failure there is the one failure that costs the whole answer,
 * and it is reported as itself — `licences: unreachable` — rather than as an
 * account with no record, which is the same reply for the opposite reason.
 *
 * THE REST RUN TOGETHER. Four reads against one licence plus one per licence
 * for the bans, all in flight at once, because they are independent and an
 * admin is waiting: `runCommand` has already deferred, but a serial fan-out
 * over ten licences on a two-second deadline each is a minute of spinner in the
 * worst case and about four requests' worth of latency in the ordinary one.
 *
 * EVERY FAILURE IS LOGGED WITH ITS MESSAGE AND REPORTED WITHOUT IT. The kind
 * reaches the admin, the SDK's own text reaches the journal — and, through the
 * sink, the status channel — where table names and request detail belong.
 */
export async function gatherProfile(
  reads: ProfileReads,
  discordId: string,
): Promise<ProfileData> {
  const unreached: Unreached[] = []

  function missed(source: ProfileSource, failure: DdbFailure): void {
    log('warn', 'profile lookup could not read a source', {
      source,
      discord: discordId,
      kind: failure.kind,
      op: failure.op,
      table: failure.table,
      error: failure.message,
    })

    // One entry per source however many reads of it failed: ten denied ban
    // reads are one thing wrong, and ten identical lines in the reply would
    // push the licences off the bottom of it.
    if (!unreached.some((entry) => entry.source === source)) {
      unreached.push({ source, why: failure.kind })
    }
  }

  const found = await reads.licencesFor(discordId)

  if (!found.ok) {
    missed('licences', found.failure)
    return nothing(discordId, unreached)
  }

  const licences = found.value

  // `at(-1)` rather than an index: the list is stored most-recent-LAST, and
  // this also covers the empty case, which is a Discord account that has never
  // connected. That is a normal answer.
  const current = licences.at(-1)
  if (current === undefined) return nothing(discordId, unreached)

  const checked = licences.slice(-LICENCE_CAP)

  const [banRows, career, registry, matches] = await Promise.all([
    Promise.all(checked.map(async (licence) => ({ licence, read: await reads.ban(licence) }))),
    reads.career(current),
    reads.registry(current),
    reads.matches?.(current, MATCH_FETCH) ?? null,
  ])

  const bans: LicenceBan[] = []

  for (const row of banRows) {
    if (row.read.ok) bans.push({ licence: row.licence, ban: row.read.value })
    else missed('bans', row.read.failure)
  }

  if (!career.ok) missed('career', career.failure)
  if (!registry.ok) missed('registry', registry.failure)

  if (matches === null) {
    // Not a failure: this build has no reader. See the file header.
    unreached.push({ source: 'matches', why: 'unavailable' })
  } else if (!matches.ok) {
    missed('matches', matches.failure)
  }

  return {
    discordId,
    licences,
    current,
    bans,
    bansSkipped: licences.length - checked.length,
    career: career.ok ? career.value : null,
    registry: registry.ok ? registry.value : null,
    matches: matches !== null && matches.ok ? matches.value : [],
    unreached,
  }
}

/* ------------------------------------------------------------------ *
 * The embed.
 * ------------------------------------------------------------------ */

function field(name: string, value: string): APIEmbedField {
  return { name, value }
}

/**
 * The licences, newest first, with the current one marked.
 *
 * REVERSED FOR DISPLAY, AND THE REASON IS THE TRUNCATION. The table stores them
 * most-recent-last, so listing them in stored order would put the licence the
 * account is using right now at the bottom — the exact end `packed` drops from
 * when the list is too long for a field. Newest first means the cut can only
 * ever eat history, and the line it leaves behind says how much.
 */
function licencesField(data: ProfileData): APIEmbedField {
  const newestFirst = [...data.licences].reverse()

  const lines = newestFirst.map((licence, index) =>
    cut(index === 0 ? `${licence} (current)` : licence, LINE_CAP),
  )

  return field(COPY.licences, packed(lines, COPY.licencesOmitted, EMBED_FIELD_VALUE_CAP))
}

/** One ban, as the state an admin is deciding on. */
function banLine(licence: string, ban: Ban, now: number): string {
  const state = isBanActive(ban, now)
    ? ban.expiresAt === null
      ? 'ACTIVE, permanent'
      : `ACTIVE until ${stamp(ban.expiresAt)}`
    : ban.liftedAt
      ? `lifted ${stamp(ban.liftedAt)}`
      : `expired ${stamp(ban.expiresAt)}`

  const reason = ban.reason ? ` — ${oneLine(ban.reason)}` : ''

  return cut(
    `${licence}: ${state}, by ${oneLine(ban.byName)} ${stamp(ban.at)}${reason}`,
    LINE_CAP,
  )
}

/**
 * Every ban on every licence that was read, or the sentence saying there are
 * none.
 *
 * ALL OF THEM, NOT THE CURRENT LICENCE'S. An account whose current licence is
 * clean and whose previous one is permanently banned is the whole reason the
 * licence list is worth showing, and a ban field that only looked at the
 * current licence would hide it behind a list the reader has to join by hand.
 */
function bansField(data: ProfileData, now: number): APIEmbedField {
  const lines = [...data.bans]
    .reverse()
    .filter((row): row is LicenceBan & { ban: Ban } => row.ban !== null)
    .map((row) => banLine(row.licence, row.ban, now))

  if (lines.length === 0) lines.push(COPY.noBans)
  if (data.bansSkipped > 0) lines.push(COPY.bansSkipped(data.bansSkipped))

  return field(COPY.bans, packed(lines, COPY.linesOmitted, EMBED_FIELD_VALUE_CAP))
}

/** The game's own numbers, from `br-players` `sk = 'profile'`. */
function careerField(career: GameProfile | null): APIEmbedField {
  if (career === null) return field(COPY.career, COPY.noCareer)

  const lines = [
    `Level ${career.level} · ${career.xp} XP · balance ${career.balance}`,
    `${career.matches} matches · ${career.wins} wins · ${career.top10s} top 10s`,
    `${career.kills} kills · ${career.deaths} deaths · ${career.downs} downs · ` +
      `${career.revives} revives`,
    `${career.damageDealt} damage · ${span(career.playtimeSec * 1000)} in match`,
    `${career.soloMatches} solo · ${career.squadMatches} squad`,
    `Last match ${stamp(career.lastMatchAt)}`,
  ]

  return field(COPY.career, packed(lines, COPY.linesOmitted, EMBED_FIELD_VALUE_CAP))
}

/** The console's registry row: who they are and how long they have been here. */
function registryField(registry: PlayerRecord | null): APIEmbedField {
  if (registry === null) return field(COPY.registry, COPY.noRegistry)

  const lines = [
    cut(oneLine(registry.name), LINE_CAP),
    `First seen ${stamp(registry.firstSeen)} · last seen ${stamp(registry.lastSeen)}`,
    `${registry.sessions} sessions · ${span(registry.playtimeMs)} connected`,
  ]

  if (registry.preferredName) {
    lines.splice(1, 0, cut(`Preferred name ${oneLine(registry.preferredName)}`, LINE_CAP))
  }

  const history = registry.names ?? []

  if (history.length > 0) {
    const shown = history.slice(0, NAME_HISTORY_CAP).map((entry) => oneLine(entry.name))

    lines.push(
      cut(COPY.alsoKnownAs(shown.join(', '), history.length - shown.length), LINE_CAP),
    )
  }

  return field(COPY.registry, packed(lines, COPY.linesOmitted, EMBED_FIELD_VALUE_CAP))
}

function matchLine(match: MatchSummary): string {
  const parts = [stamp(match.at)]

  if (match.placement !== null) parts.push(`#${match.placement}`)
  if (match.kills !== null) parts.push(`${match.kills} kills`)

  // The sort key is what identifies the row when it carried no timestamp, so it
  // is the only thing worth falling back to.
  if (match.at === null) parts.push(oneLine(match.sk))

  return cut(parts.join(' · '), LINE_CAP)
}

/**
 * As much history as the budget allows, and an honest statement of the rest.
 *
 * THE NOTE IS RECOMPUTED EACH PASS, like `packed`'s, and for the same reason.
 * It is also produced when NOTHING was dropped, whenever the career row says
 * there are more matches than the reader was asked for — that is the cut nobody
 * would otherwise see, and it is the larger of the two.
 */
function matchesValue(
  matches: readonly MatchSummary[],
  total: number | null,
  budget: number,
): string {
  const lines = matches.map(matchLine)

  for (let shown = lines.length; shown >= 0; shown--) {
    const note = COPY.matchesNote(shown, lines.length, total)
    const body = [...lines.slice(0, shown), ...(note === null ? [] : [note])].join('\n')

    if (units(body) <= budget) return body
  }

  // Unreachable while `budget` is at or above `MATCH_FIELD_FLOOR`: the caller
  // drops the field entirely below that, and every line is capped at `LINE_CAP`.
  return cut(lines[0] ?? COPY.noMatches, budget)
}

/**
 * Everything Discord counts towards the 6000 an embed is allowed.
 *
 * TITLE, DESCRIPTION AND EVERY FIELD'S NAME AND VALUE — Discord's rule, not a
 * conservative reading of it. There is no footer and no author here; adding
 * either means adding it to this sum in the same edit.
 */
export function embedUnits(embed: ProfileEmbed): number {
  let total = units(embed.title) + units(embed.description)

  for (const entry of embed.fields) total += units(entry.name) + units(entry.value)

  return total
}

/**
 * The last-resort trim: drop whole fields until the embed is one Discord will
 * take, and say how many went.
 *
 * NO INPUT `profileEmbed` CAN PRODUCE REACHES IT TODAY. Six fields, each
 * individually capped at 1024, plus a description that cannot grow past a
 * mention and one sentence — the arithmetic tops out well under 6000, and the
 * match field is handed only what is left over rather than competing for it.
 * The alternative to a guard that never fires is a reply Discord rejects
 * outright, and `runCommand` turns that into a failure line naming nothing. It
 * is EXPORTED so that the guard is exercised against an embed built by hand,
 * because a guard nothing can reach is also a guard nothing can test.
 */
export function trimEmbed(embed: ProfileEmbed): ProfileEmbed {
  if (embed.fields.length <= EMBED_FIELD_CAP && embedUnits(embed) <= EMBED_TOTAL_CAP) return embed

  // A slot held back for the notice, because a trim that used all 25 and then
  // appended its own explanation would hand Discord 26 fields and be refused
  // for the second reason on its way out of being refused for the first.
  const room = embed.fields.length > EMBED_FIELD_CAP ? EMBED_FIELD_CAP - 1 : EMBED_FIELD_CAP

  const kept: APIEmbedField[] = []
  let spent = units(embed.title) + units(embed.description)

  for (const entry of embed.fields.slice(0, room)) {
    const cost = units(entry.name) + units(entry.value)

    // Room for the notice that will have to be added if anything is dropped.
    if (spent + cost > EMBED_TOTAL_CAP - LINE_CAP) break

    kept.push(entry)
    spent += cost
  }

  const dropped = embed.fields.length - kept.length

  if (dropped > 0) kept.push(field(COPY.dropped, COPY.fieldsDropped(dropped)))

  return { title: embed.title, description: embed.description, fields: kept }
}

/**
 * The whole answer, as one embed.
 *
 * PURE, AND `now` IS A PARAMETER FOR THAT REASON: whether a ban is active is a
 * comparison against the clock, and a renderer that read the clock itself could
 * not be asserted against a ban that expires tomorrow.
 *
 * THE MATCH FIELD IS BUILT LAST AND GETS WHAT IS LEFT. Every other field is a
 * bounded fact about the player; history is the one thing that grows without
 * limit, so it is the one thing that absorbs the budget rather than competing
 * for it. Below `MATCH_FIELD_FLOOR` there is no room for a line and the note
 * saying what was cut, and a field carrying only the notice is dropped instead
 * — the notice is not lost, because `trimEmbed` accounts for it.
 */
export function profileEmbed(data: ProfileData, now: number): ProfileEmbed {
  const description: string[] = [COPY.subject(data.discordId)]
  const unreadable = data.unreached.some((entry) => entry.source === 'licences')

  if (unreadable) description.push(COPY.indexUnreadable)
  else if (data.licences.length === 0) description.push(COPY.noRecord)
  else if (data.licences.length === 1) description.push(COPY.oneLicence)
  else description.push(COPY.manyLicences(data.licences.length))

  const title = cut(
    data.registry === null ? COPY.title : oneLine(data.registry.name) || COPY.title,
    EMBED_TITLE_CAP,
  )

  const embed: ProfileEmbed = {
    title,
    description: cut(description.join('\n'), EMBED_DESCRIPTION_CAP),
    fields: [],
  }

  // An account with no licences has nothing keyed on one to show. The
  // description has already said which of the two reasons that is.
  if (data.licences.length > 0) {
    embed.fields.push(
      licencesField(data),
      bansField(data, now),
      careerField(data.career),
      registryField(data.registry),
    )
  }

  if (data.unreached.length > 0) {
    embed.fields.push(
      field(
        COPY.unreached,
        packed(
          data.unreached.map((entry) => COPY.unreachedLine(entry.source, entry.why)),
          COPY.licencesOmitted,
          EMBED_FIELD_VALUE_CAP,
        ),
      ),
    )
  }

  if (data.licences.length > 0) {
    const budget = Math.min(
      EMBED_FIELD_VALUE_CAP,
      EMBED_TOTAL_CAP - embedUnits(embed) - units(COPY.matches),
    )

    if (budget >= MATCH_FIELD_FLOOR) {
      embed.fields.push(
        field(
          COPY.matches,
          data.matches.length === 0
            ? COPY.noMatches
            : matchesValue(data.matches, data.career?.matches ?? null, budget),
        ),
      )
    }
  }

  return trimEmbed(embed)
}

/**
 * The embed as message content.
 *
 * TEMPORARY, AND IT IS THE HALF OF THIS COMMAND THAT IS NOT FINISHED. See the
 * file header: `Responder.edit` takes a string, so this is what goes out until
 * the reply seam carries embeds, at which point this function is deleted rather
 * than kept as a fallback. It is deliberately mechanical — no wording of its
 * own, no second budget policy — so that it cannot drift from the embed.
 *
 * ITS OWN CAP, BECAUSE A MESSAGE'S IS NOT AN EMBED'S. Discord allows 6000 units
 * across an embed and 2000 in a message's content, so an embed that is
 * perfectly legal flattens to something that is not. Whole sections go, newest
 * information first in the field order above, and the count of what went is
 * stated for the same reason every other count here is.
 */
export function flattenEmbed(embed: ProfileEmbed): string {
  const blocks = [
    embed.title,
    embed.description,
    ...embed.fields.map((entry) => `**${entry.name}**\n${entry.value}`),
  ].filter((block) => block.length > 0)

  for (let kept = blocks.length; kept > 0; kept--) {
    const body = blocks.slice(0, kept).join('\n\n')
    const tail = kept === blocks.length ? '' : `\n\n${COPY.blocksDropped(blocks.length - kept)}`

    if (units(body) + units(tail) <= MESSAGE_CONTENT_CAP) return `${body}${tail}`
  }

  return cut(blocks[0] ?? COPY.title, MESSAGE_CONTENT_CAP)
}

/* ------------------------------------------------------------------ */

/**
 * `/profile @user`.
 *
 * A FACTORY RATHER THAN A CONSTANT, unlike `help`, because this one needs
 * DynamoDB and `BotCommand.run` is handed an invocation and a config and
 * nothing else. Closing over the reads keeps the injection at the one place
 * that builds the command list, and keeps every test in this file offline
 * without a module mock.
 *
 * `onlyInvoker` IS A CONSTANT `true` AND MUST STAY ONE. Discord fixes a
 * reply's visibility at the defer, and this reply carries a member's ban
 * history, their licence list and every name they have used. Ephemeral is the
 * only setting under which that is not a disclosure, and a public copy cannot
 * be taken back — deleting the message does not unsee it. There is no
 * invocation that should make this false.
 *
 * `adminOnly` IS THE OTHER HALF AND IS NOT THE SAME QUESTION. It decides who
 * may RUN the command; `refusalFor` in command.ts is what enforces it, because
 * the `defaultMemberPermissions: 0n` that `commandData` derives from this word
 * only HIDES the command in the client and can be re-granted by anybody holding
 * Manage Server.
 */
export function profileCommand(reads: ProfileReads, now: () => number = Date.now): BotCommand {
  return {
    data: {
      name: 'profile',
      description: COPY.description,

      options: [
        {
          type: ApplicationCommandOptionType.User,

          // The name `invocationOf` reads the target out of. See `TARGET_OPTION`.
          name: TARGET_OPTION,
          description: COPY.userOption,

          // Required, unlike /help's: there is no sensible subject for this
          // command other than the person who was named, and falling back to
          // the invoker would be inventing a behaviour nobody asked for.
          required: true,
        },
      ],
    },

    adminOnly: true,
    onlyInvoker: () => true,

    run: async (invocation) => {
      // Discord enforces a required option, so this is a payload that is not
      // what this file expects rather than an admin who forgot.
      if (invocation.targetId === null) return COPY.noTarget

      return flattenEmbed(profileEmbed(await gatherProfile(reads, invocation.targetId), now()))
    },
  }
}
