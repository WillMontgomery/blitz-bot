import { ApplicationCommandOptionType, type APIEmbedField } from 'discord.js'

import {
  isBanActive,
  qualifyId,
  type Ban,
  type Ddb,
  type DdbFailure,
  type DdbResult,
  type GameMatch,
  type GameProfile,
  type PlayerRecord,
} from '../ddb.ts'
import { log } from '../log.ts'
import { TARGET_OPTION, type BotCommand, type Invocation } from './command.ts'

/**
 * `/profile` — one command, TWO AUDIENCES, and two of nearly everything below.
 *
 * `/profile @someone` IS THE MODERATION VIEW and is admin-only. `/profile` with
 * no target is the SELF view: anybody may run it and it answers about the
 * person who ran it. "No target means me" is the whole rule, which also means
 * an ADMIN with no target gets the self view — they cannot see their own
 * licence list this way, and that is a decision rather than an oversight. An
 * admin who wants the moderation view of themselves tags themselves.
 *
 * THE TWO VIEWS SHARE NO FIELD-ASSEMBLY CODE, AND THAT IS THE POINT.
 * `gatherProfile`/`profileEmbed` build the admin answer; `gatherSelf`/
 * `selfEmbed` build the player's. They share `cut`, `packed`, `stamp`, `span`,
 * `oneLine`, `trimEmbed` and the caps — every one of which is about Discord's
 * limits and none of which decides what a field says. The alternative was one
 * builder with an `isSelf` flag, and that is one forgotten branch away from a
 * moderation field reappearing in a player's reply the day somebody adds the
 * next one. A flag has to be remembered at every future edit; a separate
 * function cannot be forgotten into.
 *
 * THE LICENCE LIST IS NEVER FETCHED ON THE SELF PATH, rather than fetched and
 * omitted. `SelfReads` is a NARROWER type than `ProfileReads` and has no
 * `licencesFor` on it at all, so `gatherSelf` calling it is a compile error
 * rather than a review comment. This matters because more than one licence on
 * one Discord account is the ban-evasion signal, and showing a player that
 * count tells a ban evader exactly how many of their alts the system has
 * already joined up. Ban HISTORY — lifted and expired rows — is a moderation
 * record about the subject rather than the subject's own data, so it is
 * discarded in `gatherSelf` and `SelfData` has no shape that could carry it.
 *
 * ALWAYS EPHEMERAL, WHICHEVER VIEW IT IS. `onlyInvoker` decides who SEES the
 * answer and is fixed at the defer, before the handler has run. The admin view
 * carries a member's ban history, their licence list and their name history;
 * the self view carries somebody's own ban, which is theirs to show and not
 * the channel's to read. `onlyInvoker` is therefore a constant `true`.
 *
 * SPLIT IN THREE PER PATH, THE WAY command.ts IS SPLIT. A `gather*` does the
 * reads and produces a record; an `*Embed` turns that record into an embed and
 * is pure; `profileCommand` is the wiring. So the interesting halves — what
 * happens when three of five reads fail, and what happens when the answer is
 * too big for Discord — are exercised against objects written above the
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
 * THE REPLY IS THE EMBED, AND THE WHOLE 6000 IS ITS BUDGET. `BotCommand.run` may
 * answer with embeds — see `CommandReply` in ./command.ts — so this file returns
 * `{ embeds: [embed] }` and nothing between here and Discord reshapes it. It did
 * not used to: the seam took a `string`, so the embed was flattened to message
 * content under a THIRD of the budget it had just been fitted to, by a second
 * cut with a second set of rules. Both are deleted rather than kept as a
 * fallback — two budget policies drift, and the one that drifts is the one
 * nothing exercises.
 *
 * THE MATCH HISTORY IS READ BY `ddb.gamePlayers.matches`, a Query with a
 * `begins_with` on the sort key, wired in `readsFrom` below.
 * `ProfileReads.matches` stays OPTIONAL, which is now about the SEAM rather than
 * about a missing reader: a `ProfileReads` built without one — every fixture in
 * profile.test.ts that is not about history — reports `matches: unavailable` and
 * never renders an empty history it cannot vouch for. `unavailable` and a
 * DynamoDB failure are two different sentences and stay two.
 */

/**
 * PLACEHOLDER-FREE, DELIBERATELY, AND THAT IS A DIFFERENT CALL FROM command.ts.
 * The strings in `COPY` there are things a MEMBER reads — a refusal, a failure
 * — and the owner supplies those verbatim. Every one of these is either a label
 * on a number or one of the three statements the command exists to make: how
 * many licences there are, how much was cut, and what could not be read. A
 * placeholder in any of those is a command that cannot answer its question.
 *
 * A MEMBER NOW READS SOME OF THESE, which was not true when this record was
 * written: the self view reuses the labels and the two honest-absence
 * sentences. They are labels on facts rather than prose written at anybody, so
 * they ship as they are — but the wording is the owner's to take back, and
 * `SELF` below is the record to hand him first.
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
  unreachedLine: (source: ProfileSource | SelfSource, why: ProfileFault) => `${source}: ${why}`,

  /**
   * The last-resort trim in `trimEmbed`. A field of its own rather than a line
   * appended to another one, because the fields it is reporting on are gone and
   * there may be no other one left to append to.
   */
  dropped: 'Not shown',
  fieldsDropped: (count: number) => `${count} further sections did not fit.`,

  unknownTime: 'unknown',
}

/**
 * The strings that exist only for the self view, kept apart from `COPY` for the
 * reason the builders are kept apart.
 *
 * THREE STRINGS, AND ALL THREE ARE ABOUT THE ONE THING THE SELF VIEW SAYS THAT
 * THE PLAYER DOES NOT ALREADY SEE IN GAME. Everything else the self view shows
 * is progression and match history under the same labels the admin view uses,
 * so it borrows those from `COPY`; a ban needs its own words because the admin
 * wording — `licence: ACTIVE until …, by An Admin …` — names a licence and the
 * moderator who issued it, and neither belongs in a reply to the person banned.
 *
 * WHAT IS SAID HERE IS WHAT THE CONNECT GATE ALREADY SAYS: the reason, and when
 * it runs out. Nothing is revealed that the player was not told the last time
 * they tried to join, which is the test any line added here has to pass.
 */
const SELF = {
  /** Singular: the self view shows at most one ban, and only an active one. */
  ban: 'Ban',

  banPermanent: 'Permanent.',
  banUntil: (at: string) => `Until ${at}.`,
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

/**
 * What Discord is told. Assignable to `APIEmbed`, which is what `run` returns.
 */
export interface ProfileEmbed {
  readonly title: string
  readonly description: string
  readonly fields: APIEmbedField[]
}

/**
 * One match, reduced to what a line of history says.
 *
 * AN ALIAS RATHER THAN A SECOND DECLARATION OF THE SAME FOUR FIELDS. This is the
 * RENDERER's requirement and `GameMatch` is the READER's projection of a
 * `match#…` row, which is ddb.ts's job for the reason `gamePlayers.profile`
 * projects field by field: those rows are written by br_ddb, in Lua, in another
 * repo, so a field that arrives missing must cost that field and not the line.
 * Today they are the same four fields, and writing them out twice would be two
 * lists with nothing to make them agree — a field renamed in ddb.ts would then
 * compile here and render `undefined`. The alias makes that a type error.
 */
export type MatchSummary = GameMatch

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

/**
 * The sources a SELF profile is assembled from. Three, and none of them is the
 * licence list.
 *
 * `lookup` RATHER THAN `licences`, AND THE NAME IS THE POINT. The admin view
 * says `licences: denied` and, one field up, `The Discord-to-licence index
 * could not be read` — both of which tell the reader that a Discord account is
 * indexed to licences and that the bot went looking. That is exactly the fact
 * the self view is built not to disclose, so the one read the self path makes
 * against that table reports under a name that describes what it was FOR
 * rather than what it read.
 *
 * `ban` IS SINGULAR HERE AND `bans` IS PLURAL THERE, for the same reason: the
 * admin path fans out over every licence and the self path reads exactly one.
 */
export type SelfSource = 'lookup' | 'ban' | 'career' | 'matches'

export interface SelfUnreached {
  readonly source: SelfSource
  readonly why: ProfileFault
}

/**
 * A ban as the person under it is allowed to see it.
 *
 * A PROJECTION AND NOT A `Ban`, WHICH IS THE WHOLE DEFENCE. `Ban` carries
 * `license` — the licence itself — plus `by`, `byName`, `liftedAt`, `liftedBy`
 * and `liftReason`, which are the moderation record rather than the subject's
 * data. Handing the self builder a `Ban` and trusting it to render two fields
 * off it is the "careful" version; handing it a record that has nothing else on
 * it means the licence cannot appear in a player's reply however the rendering
 * is edited later. `gatherSelf` is the one place that narrows, and it narrows
 * where the row is read.
 *
 * THERE IS NO `liftedAt` OR `at` HERE BECAUSE THERE IS NO STATE TO SHOW. Only
 * an ACTIVE ban reaches this type at all — see `gatherSelf` — so "when does it
 * end" is the only question left, and `expiresAt: null` is permanent.
 */
export interface SelfBan {
  readonly reason: string
  readonly expiresAt: number | null
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
 * Everything the SELF reply is built from. Note what is not here.
 *
 * NO `licences`, NO `current`, NO `bansSkipped`, NO `registry`. Those are not
 * omitted from the rendering — there is no field on this record for the self
 * builder to reach for, so a licence cannot be rendered by a later edit to
 * `selfEmbed` without first adding it here, which is a change nobody makes by
 * accident. `ProfileData` and this are two records rather than one with
 * optional halves for exactly that reason.
 *
 * `known` RATHER THAN A NULLABLE LICENCE. The self path does resolve one
 * licence in order to key its three reads on it — there is no other route from
 * a Discord account to a career row — but that licence is a local in
 * `gatherSelf` and it stops there. What the reply needs to know is only whether
 * there was one, which is a boolean, and a boolean cannot be printed by mistake.
 */
export interface SelfData {
  readonly discordId: string

  /** Whether this Discord account resolved to a licence at all. */
  readonly known: boolean

  /** An ACTIVE ban, or null. A lifted or expired one never reaches this record. */
  readonly ban: SelfBan | null

  readonly career: GameProfile | null
  readonly matches: readonly MatchSummary[]

  readonly unreached: readonly SelfUnreached[]
}

/**
 * The reads one profile needs, and nothing else this bot can do.
 *
 * NARROWER THAN `Ddb` ON PURPOSE. `Ddb` also writes the audit log and the bot's
 * own state, and a lookup command has no business being handed either — this
 * interface is what a test builds in six lines and what the real thing is
 * adapted down to by `readsFrom`.
 *
 * `matches` IS OPTIONAL BECAUSE THE SEAM ALLOWS ONE WITHOUT IT, not because
 * none exists — `readsFrom` wires the real one. An absent reader is reported as
 * `unavailable`, which is not a DynamoDB failure and must never be shown as an
 * empty history. See the file header.
 */
export interface ProfileReads {
  /**
   * By RAW Discord id; qualifying it is this seam's job, not the caller's.
   *
   * THE ADMIN PATH'S READ, AND ONLY THE ADMIN PATH'S. It is the reverse
   * identifier index — the thing that answers "how many licences has this
   * Discord account played under" — and that answer is the ban-evasion signal
   * the moderation view leads with. `SelfReads` below deliberately does not
   * include it.
   */
  licencesFor: (discordId: string) => Promise<DdbResult<string[]>>

  /**
   * The ONE licence this Discord account is on now, or null for an account
   * that has never connected. The self path's only route from a Discord id to
   * anything.
   *
   * A SECOND, NARROWER SEAM RATHER THAN `licencesFor(…).at(-1)` AT THE CALL
   * SITE, and the narrowness is the feature. The self path needs a licence —
   * `br-players` and `ringmaster-bans` are keyed on one and there is no other
   * way in — but it must never be handed the LIST, because a list is a count
   * and the count is the disclosure. Returning `string | null` means the list
   * does not exist as a value anywhere the self view can reach: not in
   * `SelfData`, not in `selfEmbed`, not in a future field somebody adds.
   *
   * THE NARROWING HAPPENS ONCE, IN `readsFrom`, IN ONE EXPRESSION. That is the
   * one place in this repo where both shapes are in scope at the same time,
   * and it is four lines long — see there for why it cannot yet be pushed
   * down into `ddb.ts` as a projection.
   */
  currentLicenceFor: (discordId: string) => Promise<DdbResult<string | null>>

  ban: (licence: string) => Promise<DdbResult<Ban | null>>
  career: (licence: string) => Promise<DdbResult<GameProfile | null>>
  registry: (licence: string) => Promise<DdbResult<PlayerRecord | null>>
  matches?: (licence: string, limit: number) => Promise<DdbResult<MatchSummary[]>>
}

/**
 * What the SELF path is allowed to read, which is `ProfileReads` minus two.
 *
 * A TYPE AND NOT A CONVENTION. `gatherSelf` takes this rather than
 * `ProfileReads`, so `reads.licencesFor(...)` inside it is a COMPILE ERROR
 * rather than a thing a reviewer has to notice. The command hands the same
 * object to both paths — one seam, one wiring, one client — and structural
 * typing is what makes handing a wider object to a narrower parameter free.
 *
 * `registry` IS OUT TOO, and for a second reason on top of the first. The
 * registry row carries `names` — every in-game name the licence has used — and
 * `identifiers`, which is the same reuse signal as the licence list arriving by
 * a different road. The self view shows progression and match record; it does
 * not need a name history, so it does not get a seam to read one.
 */
export type SelfReads = Pick<ProfileReads, 'currentLicenceFor' | 'ban' | 'career' | 'matches'>

/**
 * A `ProfileReads` that certainly has a match reader on it.
 *
 * THE RETURN TYPE OF THE TWO FUNCTIONS BELOW, AND THAT IS THE WHOLE POINT OF IT.
 * `ProfileReads.matches` is optional so a fixture can leave it out; a REAL build
 * leaving it out is a `/profile` quietly reporting `unavailable` about a table
 * it was never going to ask — a regression that looks exactly like the honest
 * answer. Naming the wired shape makes dropping the line a compile error.
 */
export type WiredReads = ProfileReads & Required<Pick<ProfileReads, 'matches'>>

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
export function readsFrom(ddb: Ddb): WiredReads {
  return {
    licencesFor: (discordId) => ddb.playerIds.licensesFor(qualifyId('discord', discordId)),

    /**
     * THE ONE PLACE THE LIST BECOMES A LICENCE, AND IT IS ONE EXPRESSION LONG.
     * `ddb.playerIds.licensesFor` is the only reader this bot has for that
     * table, so the row does arrive whole here and `at(-1)` — most recent LAST,
     * which is how the index stores them — is what leaves this function. The
     * value returned is a `string | null`, so nothing downstream of this line
     * has a list to render, to count, or to leak.
     *
     * WHY THIS IS NOT PUSHED INTO ddb.ts, WHICH IS WHERE IT BELONGS. The narrow
     * read wants a `ProjectionExpression` so DynamoDB itself returns one
     * element, and `Ddb` exposes no such reader — adding
     * `playerIds.currentLicenseFor` is an edit to a file this change does not
     * own. Until then the narrowing is here, at the seam, where it is one line
     * that no caller can bypass rather than a rule every caller has to keep.
     */
    currentLicenceFor: async (discordId) => {
      const found = await ddb.playerIds.licensesFor(qualifyId('discord', discordId))

      // A failure is passed through as itself: `null` means "this account has
      // never connected", and reporting a denied table as that would be the
      // same confident wrong answer `qualifyId` exists to prevent.
      return found.ok ? { ok: true, value: found.value.at(-1) ?? null } : found
    },

    ban: (licence) => ddb.bans.get(licence),
    career: (licence) => ddb.gamePlayers.profile(licence),
    registry: (licence) => ddb.players.get(licence),

    // The limit is passed through rather than left to the reader's default:
    // `MATCH_FETCH` is what THIS reply can render and say it cut, and the
    // reader's own cap is a ceiling over it rather than a substitute for it.
    matches: (licence, limit) => ddb.gamePlayers.matches(licence, limit),
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
export function lazyReadsFrom(make: () => Ddb): WiredReads {
  let built: WiredReads | null = null

  const reads = (): WiredReads => (built ??= readsFrom(make()))

  return {
    licencesFor: (discordId) => reads().licencesFor(discordId),
    currentLicenceFor: (discordId) => reads().currentLicenceFor(discordId),
    ban: (licence) => reads().ban(licence),
    career: (licence) => reads().career(licence),
    registry: (licence) => reads().registry(licence),
    matches: (licence, limit) => reads().matches(licence, limit),
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

/** Nothing resolved, or nothing could be. Both are answers rather than errors. */
function nobody(discordId: string, unreached: readonly SelfUnreached[]): SelfData {
  return { discordId, known: false, ban: null, career: null, matches: [], unreached }
}

/**
 * Read what a player is allowed to see about themselves, and never throw.
 *
 * THREE READS AND A RESOLUTION, AGAINST `gatherProfile`'S FIVE-PLUS-A-FAN-OUT.
 * The difference is not efficiency, it is reach: this function is handed a
 * `SelfReads`, which has no `licencesFor` and no `registry` on it, so the two
 * sources that carry the ban-evasion signal are not merely unread here — they
 * are unreachable from here, and `tsc` is what enforces that.
 *
 * `now` IS A PARAMETER BECAUSE THE FILTER IS HERE AND NOT IN THE RENDERER.
 * Whether a ban is in force is a comparison against the clock, and the choice
 * that matters is WHERE it happens: a renderer handed every ban row and trusted
 * to print only the active one is one `if` away from printing a lifted one, and
 * lifted and expired bans are moderation history rather than the subject's
 * data. Discarding them at the read means `SelfData` has no shape that could
 * carry one — see `SelfBan`.
 *
 * ONE LICENCE'S BAN, NOT EVERY LICENCE'S, WHICH IS THE OTHER HALF OF THE SAME
 * RULE. `bansField` deliberately reports a ban on ANY licence because an
 * account whose current licence is clean and whose previous one is banned is
 * the thing the admin view exists to surface. Doing that here would disclose
 * that there IS a previous licence. What this reads is the ban on the licence
 * the player is connecting with, which is word for word what the connect gate
 * already tells them.
 */
export async function gatherSelf(
  reads: SelfReads,
  discordId: string,
  now: number,
): Promise<SelfData> {
  const unreached: SelfUnreached[] = []

  function missed(source: SelfSource, failure: DdbFailure): void {
    log('warn', 'self profile could not read a source', {
      source,
      discord: discordId,
      kind: failure.kind,
      op: failure.op,
      table: failure.table,
      error: failure.message,
    })

    unreached.push({ source, why: failure.kind })
  }

  const found = await reads.currentLicenceFor(discordId)

  // Reported as itself rather than as an account with no record: those are the
  // same reply for opposite reasons, and only one of them is true.
  if (!found.ok) {
    missed('lookup', found.failure)
    return nobody(discordId, unreached)
  }

  const licence = found.value

  // Not an error. A Discord account that has never played is a normal answer,
  // and it is the answer a brand-new member gets the first time they try this.
  if (licence === null) return nobody(discordId, unreached)

  const [banRead, careerRead, matchesRead] = await Promise.all([
    reads.ban(licence),
    reads.career(licence),
    reads.matches?.(licence, MATCH_FETCH) ?? null,
  ])

  if (!banRead.ok) missed('ban', banRead.failure)
  if (!careerRead.ok) missed('career', careerRead.failure)

  if (matchesRead === null) {
    // Not a failure: this build has no reader. See the file header.
    unreached.push({ source: 'matches', why: 'unavailable' })
  } else if (!matchesRead.ok) {
    missed('matches', matchesRead.failure)
  }

  const row = banRead.ok ? banRead.value : null

  return {
    discordId,
    known: true,

    // The narrowing, and the only place it happens: an inactive row becomes
    // null and an active one becomes two fields. Nothing past this line holds
    // a `Ban`.
    ban:
      row !== null && isBanActive(row, now)
        ? { reason: row.reason, expiresAt: row.expiresAt }
        : null,

    career: careerRead.ok ? careerRead.value : null,
    matches: matchesRead !== null && matchesRead.ok ? matchesRead.value : [],
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

/* ------------------------------------------------------------------ *
 * The SELF embed: a second builder, sharing nothing above that decides what a
 * field says.
 *
 * THE DUPLICATION BELOW IS DELIBERATE RATHER THAN LAZY, and ddb.ts's own
 * `isBanActive` is the precedent: some things are copied because the copy is
 * what stops two readers being forced to agree. `selfCareerField` renders the
 * same six lines `careerField` renders TODAY, and the day one of them changes —
 * a stat that turns out to be moderation-only, a number the owner wants phrased
 * differently for players — it changes on one side without a flag, a parameter
 * or a branch anybody has to remember. The shared function was the version
 * where that edit silently changes both.
 *
 * WHAT IS SHARED IS `field`, `cut`, `oneLine`, `stamp`, `span`, `packed`,
 * `units`, `embedUnits` and `trimEmbed`. Every one of those is about Discord's
 * limits or about turning somebody else's text into one safe line. None of them
 * is handed a licence, a `Ban`, or a decision about who may see what.
 * ------------------------------------------------------------------ */

/**
 * The player's own ban, as the connect gate states it: why, and until when.
 *
 * TAKES A `SelfBan` AND NOT A `Ban`. There is no licence on the record it is
 * given, no issuing admin and no lift, so this function could not disclose one
 * if it were rewritten carelessly. See `SelfBan`.
 */
function selfBanField(ban: SelfBan): APIEmbedField {
  const lines: string[] = []
  const reason = oneLine(ban.reason)

  // A ban row with an empty reason is a row the console should not have
  // written, but it is not this reply's job to invent one — the expiry line
  // below is always present, so the field is never empty either way.
  if (reason) lines.push(cut(reason, LINE_CAP))

  lines.push(ban.expiresAt === null ? SELF.banPermanent : SELF.banUntil(stamp(ban.expiresAt)))

  return field(SELF.ban, packed(lines, COPY.linesOmitted, EMBED_FIELD_VALUE_CAP))
}

/** The game's own numbers — the progression a player already sees in game. */
function selfCareerField(career: GameProfile | null): APIEmbedField {
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

function selfMatchLine(match: MatchSummary): string {
  const parts = [stamp(match.at)]

  if (match.placement !== null) parts.push(`#${match.placement}`)
  if (match.kills !== null) parts.push(`${match.kills} kills`)

  // The sort key is what identifies the row when it carried no timestamp.
  if (match.at === null) parts.push(oneLine(match.sk))

  return cut(parts.join(' · '), LINE_CAP)
}

/**
 * As much history as the budget allows.
 *
 * `packed` RATHER THAN `matchesValue`'S TWO-NUMBER NOTE. The admin view
 * distinguishes what the reader fetched from what the career row says exists,
 * because an admin is deciding whether they have seen everything. A player is
 * reading their own recent matches; "+N more not shown" is the honest sentence
 * and the second number is a statement about the bot's fetch limit rather than
 * about them.
 */
function selfMatchesField(matches: readonly MatchSummary[], budget: number): APIEmbedField {
  if (matches.length === 0) return field(COPY.matches, COPY.noMatches)

  return field(COPY.matches, packed(matches.map(selfMatchLine), COPY.linesOmitted, budget))
}

/**
 * What could not be read, named by SOURCE and never by SDK message — the same
 * rule the admin view follows, over the source names in `SelfSource`.
 *
 * KEPT RATHER THAN SWALLOWED. A denied `br-players` rendered as an absent
 * career row is a player told they have never played, which is worse than a
 * word they have to ask about.
 */
function selfUnreachedField(unreached: readonly SelfUnreached[]): APIEmbedField {
  return field(
    COPY.unreached,
    packed(
      unreached.map((entry) => COPY.unreachedLine(entry.source, entry.why)),
      COPY.linesOmitted,
      EMBED_FIELD_VALUE_CAP,
    ),
  )
}

/**
 * The whole self answer, as one embed.
 *
 * PURE, AND WITH NO CLOCK. `profileEmbed` takes `now` because it decides
 * whether each ban is active while rendering it; this one cannot, because
 * `gatherSelf` has already discarded every ban that is not. That is the same
 * separation stated twice — the clock belongs where the discarding happens.
 *
 * THE BAN GOES FIRST, WHICH IS BOTH THE RIGHT ORDER AND THE SAFE ONE. It is the
 * one thing in this reply a player needs before anything else, and `trimEmbed`
 * drops fields from the END — so the field that must never be lost is the field
 * that cannot be. Match history, the one thing here that grows, goes last and
 * takes what the budget leaves.
 *
 * NO TITLE FROM THE REGISTRY. `profileEmbed` titles itself with the in-game
 * name off the registry row; the self path never reads that row, so the title
 * is the constant. That is a consequence of the narrower seam rather than a
 * separate decision.
 */
export function selfEmbed(data: SelfData): ProfileEmbed {
  const description: string[] = [COPY.subject(data.discordId)]
  const unreadable = data.unreached.some((entry) => entry.source === 'lookup')

  // "No record" is said only when the lookup actually answered. When it failed,
  // the field below names it and the description stays quiet rather than
  // telling somebody who has played for a year that they have never been here.
  if (!unreadable && !data.known) description.push(COPY.noRecord)

  const embed: ProfileEmbed = {
    title: COPY.title,
    description: cut(description.join('\n'), EMBED_DESCRIPTION_CAP),
    fields: [],
  }

  if (data.ban !== null) embed.fields.push(selfBanField(data.ban))
  if (data.known) embed.fields.push(selfCareerField(data.career))
  if (data.unreached.length > 0) embed.fields.push(selfUnreachedField(data.unreached))

  if (data.known) {
    const budget = Math.min(
      EMBED_FIELD_VALUE_CAP,
      EMBED_TOTAL_CAP - embedUnits(embed) - units(COPY.matches),
    )

    if (budget >= MATCH_FIELD_FLOOR) embed.fields.push(selfMatchesField(data.matches, budget))
  }

  return trimEmbed(embed)
}

/* ------------------------------------------------------------------ */

/**
 * Is THIS invocation of `/profile` the admin-only one?
 *
 * THE GATE, AS A FUNCTION OF THE INVOCATION, WHICH IS THE ONLY SHAPE THAT CAN
 * STATE THIS COMMAND'S RULE. Asking about somebody else is a moderation lookup
 * and requires the role; asking about yourself is not, and requires nothing.
 * There is exactly one bit of the invocation that decides it, and it is the one
 * Discord already fills in.
 *
 * A PREDICATE HERE RATHER THAN AN `if` IN `run`, EVEN THOUGH `run` IS WHERE IT
 * WOULD BE EASIEST. `refusalFor` in command.ts is the gate — the one that fails
 * closed on an unset `DISCORD_ADMIN_ROLE_ID`, on a payload with no member on it
 * and on a missing guild, all three of which a hand-rolled check in a command
 * file gets wrong on the first try. Re-implementing four refusal reasons here
 * to make one of them conditional is how a command ends up with a gate that
 * agrees with the framework's on the day it is written and not after. So this
 * file states the CONDITION and command.ts keeps the enforcement.
 *
 * WHAT IT IS WIRED TO. `BotCommand.adminOnly` is an `AdminGate`, so this
 * function IS the command's gate — `profileCommand` below passes it by name and
 * `refusalFor` resolves it against the invocation before it refuses anything.
 * There is no second copy of this rule anywhere: `run` reads `targetId` to
 * decide which VIEW to build, and this reads it to decide who may ask for one,
 * and the two agree because they are the same question asked of the same field.
 */
export function profileAdminOnly(invocation: Invocation): boolean {
  return invocation.targetId !== null
}

/**
 * `/profile` and `/profile @user`.
 *
 * A FACTORY RATHER THAN A CONSTANT, unlike `help`, because this one needs
 * DynamoDB and `BotCommand.run` is handed an invocation and a config and
 * nothing else. Closing over the reads keeps the injection at the one place
 * that builds the command list, and keeps every test in this file offline
 * without a module mock. ONE `ProfileReads` FOR BOTH PATHS: the self path is
 * handed the same object narrowed to `SelfReads` by the parameter type, so
 * there is still one client, one wiring and one thing to inject.
 *
 * `onlyInvoker` IS A CONSTANT `true` AND MUST STAY ONE. Discord fixes a
 * reply's visibility at the defer. The admin view carries a member's ban
 * history, their licence list and every name they have used; the self view
 * carries somebody's own active ban, which is theirs and not the channel's.
 * A public copy cannot be taken back — deleting the message does not unsee it.
 * There is no invocation that should make this false.
 *
 * `adminOnly` IS `profileAdminOnly` AND NOT A CONSTANT, WHICH IS THE WHOLE
 * SHAPE OF THIS COMMAND. Gated when a target is given, open when it is not —
 * see that function above for why the condition is stated here and enforced in
 * command.ts. Neither constant was ever the rule: `true` refuses the self view
 * to the members it exists for, and `false` would let any member look anybody
 * else up, which is the one thing that must not happen.
 *
 * IT IS REGISTERED VISIBLE IN THE CLIENT, AND THAT IS NOT A HOLE. `commandData`
 * in ./index.ts derives `defaultMemberPermissions` from this field and gives a
 * conditionally gated command `null` — everybody sees `/profile` in the picker,
 * because a member who cannot see it cannot run the half of it that is theirs.
 * What stops them running the other half is `refusalFor` and only ever was:
 * `0n` is a DEFAULT that anybody holding Manage Server can re-grant, so the
 * targeted call has always had to be refused by the handler check against a
 * caller whose interaction looks exactly like an admin's.
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

          // OPTIONAL, AND THAT IS THE FEATURE RATHER THAN A RELAXATION. It used
          // to be required because there was no sensible subject other than the
          // person named; now the absence of one IS a subject — the caller. A
          // required option would make the self view unaskable.
          required: false,
        },
      ],
    },

    adminOnly: profileAdminOnly,
    onlyInvoker: () => true,

    run: async (invocation) => {
      // NO TARGET MEANS ME, and this is the whole of that rule. It reads
      // `userId` and never `targetId`, so there is no path on which a caller
      // chooses whose self view they get.
      //
      // AN ADMIN LANDS HERE TOO WHEN THEY GIVE NO TARGET, which means an admin
      // cannot see their own licence list this way. That is deliberate: "no
      // target means me" is one rule for everybody, and a second reading of it
      // for admins would be a branch on the caller's role inside the half of
      // this file that is meant not to know about roles. An admin who wants the
      // moderation view of their own account tags themselves.
      if (invocation.targetId === null) {
        return { embeds: [selfEmbed(await gatherSelf(reads, invocation.userId, now()))] }
      }

      const embed = profileEmbed(await gatherProfile(reads, invocation.targetId), now())

      // `profileEmbed` has already fitted this to the 6000 an embed may carry
      // and `trimEmbed` is its last guard, so nothing between here and Discord
      // measures it again — which is the whole of what widening the seam bought.
      return { embeds: [embed] }
    },
  }
}
