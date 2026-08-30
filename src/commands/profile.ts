import {
  ApplicationCommandOptionType,
  ButtonStyle,
  ComponentType,
  type APIEmbedField,
} from 'discord.js'

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
import {
  TARGET_OPTION,
  type BotCommand,
  type CommandComponentRow,
  type Invocation,
} from './command.ts'

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
 * `selfEmbed` build the player's. They share `cut`, `packed`, `when`, `span`,
 * `oneLine`, `field`, `tile`, `trimEmbed` and the caps — every one of which is
 * about Discord's limits or its layout, and none of which decides what a field
 * says. The alternative was one
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
 *
 * HOW IT IS PRESENTED, WHICH IS FOUR DECISIONS AND ALL FOUR ARE THE OWNER'S.
 *
 *   TIMES ARE DISCORD TIMESTAMPS, NOT ISO STRINGS. `<t:UNIX:R>` renders as "2
 *   hours ago" and `<t:UNIX:f>` as a date, both in the READER'S OWN timezone
 *   and locale — which an ISO string in UTC is not, and cannot be, for a bot
 *   whose players are in several. `when` below is the one place that builds
 *   either, and which style each field uses is a decision recorded there.
 *
 *   THE SHORT NUMBERS ARE COLUMNS. Discord lays out up to three `inline: true`
 *   fields per row, so level, Volts, matches, kills, damage and time in match
 *   are six tiles that read as two rows of a table instead of six lines of
 *   `a · b · c`. Everything that grows — the licence list, the bans, the
 *   registry row, the history — stays full width, because a long value in a
 *   third of the width is a column of two-word lines.
 *
 *   THE BALANCE IS IN VOLTS, which is what the game calls it:
 *   `BR.Config.Market.currency = 'Volts'` in the gamemode repo. It was labelled
 *   `balance` here and that is a word the currency does not have anywhere a
 *   player can see it.
 *
 *   NO RAW DISCORD ID, IN EITHER VIEW. The description used to carry the
 *   mention AND the id in backticks, on the reasoning client.ts uses for the
 *   removals channel: a mention stops rendering once the account leaves. That
 *   is a record somebody reads months later; this is a lookup somebody runs
 *   about an account that is in front of them, the mention's own markup carries
 *   the id for anybody who needs it, and the owner asked for it gone.
 *
 * AND ONE COLOUR DECISION. The embed is blurple normally and RED when the
 * subject is under a ban that is in force right now — one bit, the one an admin
 * is looking for and the one a player needs before they read anything else. It
 * deliberately does not also encode a partial read: `Could not be read` already
 * names every source that went missing, and a second colour for it would
 * compete with the red in exactly the case where both are true.
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

  /**
   * THE MENTION AND NOTHING ELSE. This used to be `<@id> \`id\`` — the mention
   * and the raw snowflake beside it — copied from the removals channel in
   * client.ts, where a mention that stops rendering after somebody leaves the
   * guild would leave a record naming nobody. That argument does not reach
   * here: this reply is ephemeral, it is read once, by somebody who is looking
   * at the account now, and Discord puts the id inside the mention's own markup
   * for anybody who wants to copy it. The owner asked for it gone from both
   * views, and "both" is why it is one string rather than two.
   */
  subject: (discordId: string) => `<@${discordId}>`,

  /**
   * The link button's label, which is the one piece of this reply that is not
   * in the embed at all. Discord allows 80 characters; this is 19.
   */
  openInConsole: 'Open in Ringmaster',

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

  /**
   * The one career field that is still a field: the sentence for a player with
   * no career row at all. The numbers themselves are the six tiles below.
   */
  career: 'Career',
  noCareer: 'No match record on the game side.',

  /**
   * THE SIX COLUMN HEADINGS, AND EVERY ONE OF THEM IS A NOUN. Discord renders a
   * field name in bold small caps above its value, which makes it a column
   * heading whether or not it was written as one — so it says what the number
   * under it is and nothing else. `Volts` is the game's own word for the
   * balance (`BR.Config.Market.currency`), not a label invented here.
   */
  level: 'Level',
  volts: 'Volts',
  matchesPlayed: 'Matches',
  kills: 'Kills',
  damage: 'Damage',
  inMatch: 'In match',

  /** The lines under those headings, where the headline number is bold. */
  levelTile: (level: number, xp: number) => `**${level}**\n${xp} XP`,
  voltsTile: (balance: number) => `**${balance}**`,
  matchesTile: (played: number, wins: number, top10s: number, last: string) =>
    `**${played}**\n${wins} wins · ${top10s} top 10s\nLast match ${last}`,
  killsTile: (kills: number, deaths: number, downs: number, revives: number) =>
    `**${kills}**\n${deaths} deaths · ${downs} downs · ${revives} revives`,
  damageTile: (dealt: number) => `**${dealt}**`,
  inMatchTile: (played: string, solo: number, squad: number) =>
    `**${played}**\n${solo} solo · ${squad} squad`,

  registry: 'Server record',
  noRegistry: 'No row in the server registry.',
  alsoKnownAs: (names: string, more: number) =>
    more > 0 ? `Also known as ${names} (+${more} more)` : `Also known as ${names}`,

  matches: 'Recent matches',
  noMatches: 'No matches read.',

  /**
   * TWO DIFFERENT CUTS, AND CONFLATING THEM WOULD BE THE LIE. `read` is how
   * many rows the reader returned, which is bounded by `RECENT_MATCHES`;
   * `shown` is how many survived that cap and the embed's budget; `total` is
   * how many matches the career row says the player has ever played. Saying "10
   * omitted" when 300 were never fetched is a truncation that reads as
   * complete, so both numbers are said whenever they differ.
   *
   * THE SECOND SENTENCE IS THE ONE THAT NOW EARNS ITS KEEP. The history is five
   * rows long by the owner's instruction, so the ordinary reply shows five out
   * of a career of hundreds and the first clause never fires — a five-line list
   * with nothing under it reads as the whole record, which is exactly the
   * failure this string exists against.
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

  banPermanent: '**Permanent.**',

  /**
   * `f` AND NOT `R` FOR THE ONE DATE A PLAYER IS ACTUALLY GOING TO ACT ON. See
   * `when`: the whole rule is stated there and this is the field it was written
   * for. Bold, because the date is the only thing in this field that is a fact
   * rather than a sentence about one.
   */
  banUntil: (at: string) => `Until **${at}**.`,

  /**
   * The self view's own truncation sentence, and it is ONE number rather than
   * `COPY.matchesNote`'s two.
   *
   * A PLAYER IS NOT AUDITING THE BOT'S FETCH LIMIT. "3 of the 5 read were not
   * shown" is a sentence about how this reply was assembled; "42 matches played
   * in all" is a sentence about them, and it is the one that stops five lines
   * reading as a whole career. The first clause below reuses the wording every
   * other cut in this file uses, and only fires when the budget actually ate a
   * line.
   */
  matchesNote: (shown: number, read: number, total: number | null): string | null => {
    const parts: string[] = []

    if (shown < read) parts.push(COPY.linesOmitted(read - shown))
    if (total !== null && total > read) parts.push(`${total} matches played in all.`)

    return parts.length === 0 ? null : parts.join(' ')
  },
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

/**
 * How many match rows the reader is asked for AND how many are ever rendered.
 *
 * FIVE, BY THE OWNER: "the recent matches is too long. Just include last 5
 * matches." It was twenty-five, which filled the field, pushed everything else
 * up the reply and told nobody anything the top five did not.
 *
 * ONE CONSTANT FOR BOTH, AND THAT IS THE INTERESTING HALF. Fetching 25 to show
 * 5 would put twenty rows of read capacity on a path with a person waiting on
 * it, and — worse — it would make the ordinary reply say "20 of the 25 read
 * were not shown", which is a sentence about this bot's plumbing rather than
 * about the player. Asking for what is displayed makes that clause fall silent
 * in normal operation and leaves `COPY.matchesNote`'s SECOND clause, the honest
 * one, to say how many were actually played.
 *
 * THE RENDERERS SLICE TO IT AS WELL AS PASSING IT. A reader is a seam, and a
 * seam that hands back more than it was asked for — a fixture, a future reader
 * with its own idea of a default — must not quietly become a six-line history.
 * Slicing means the count that is reported as "read" is what arrived, and the
 * count that is shown is this constant, whatever the reader did.
 */
const RECENT_MATCHES = 5

/** How many past names are listed before the rest become a count. */
const NAME_HISTORY_CAP = 5

/**
 * The floor under the match field. Below this there is no room for a line AND
 * the note that says how much was cut, and a field carrying only a truncation
 * notice is worse than no field.
 */
const MATCH_FIELD_FLOOR = 120

/**
 * The bar down the side of the embed, in the two states this reply has.
 *
 * ONE BIT, AND IT IS THE BIT BOTH READERS ARE THERE FOR. An admin running
 * `/profile @someone` is nearly always asking one question — is this person
 * banned right now — and a player who is banned needs to know that before they
 * read a single number. Red says it from across the channel, ahead of the field
 * that says it in words; every other state is the ordinary one.
 *
 * DISCORD'S OWN TWO COLOURS, deliberately, rather than a palette invented here:
 * `0xed4245` is the red Discord uses for danger in its own client and
 * `0x5865f2` is blurple. Both are already what a Discord reader's eye has been
 * trained on in that exact position, and neither needs a legend.
 *
 * NOT COUNTED TOWARDS THE 6000. Discord's embed budget covers title,
 * description, field names and values, the footer and the author — see
 * `embedUnits`, which is the sum it is checked against. A colour is four bytes
 * of JSON and no characters, so it is free, which is the other reason it is a
 * good place to put a fact this reply cannot afford to lose.
 */
const COLOUR = {
  normal: 0x5865f2,
  banned: 0xed4245,
}

/**
 * Where the Ringmaster console lives, so a licence can be a button.
 *
 * A MODULE CONSTANT AND DELIBERATELY NOT IN `Config`, WHICH IS THE CALL
 * `REPO_URL` IN src/client.ts ALREADY MADE and this follows without argument.
 * Everything in config.ts is a thing that DIFFERS between deployments and that
 * an operator has to supply — a token, a guild, four channel ids — and every one
 * of them is a thing they can get wrong. This is not one of those: there is one
 * Ringmaster console, it is the console that owns the very rows this reply is
 * built from, and there is no deployment for which a different value would be
 * right. Making it an environment variable would buy nothing and would
 * introduce a failure this feature cannot otherwise have — a button on a
 * moderation reply that opens somebody else's console, which reads as
 * authoritative and is not.
 *
 * IT IS EVEN MORE CLEARLY NOT CONFIG THAN THE REPO URL WAS. A wrong repo link
 * shows an operator the wrong commit; a wrong console link invites an admin to
 * act on a player record that is not this server's.
 *
 * NO TRAILING SLASH, and `consoleLink` adds its own. `/players/<license>` is
 * the console's own route — src/app/players/[license]/page.tsx over there — and
 * a Next.js dynamic segment is percent-DECODED on arrival, which is what makes
 * the encoding below the right half of the contract rather than a guess.
 */
const CONSOLE_URL = 'https://ringmaster.blitz-royale.com'

/**
 * What Discord will accept as a link button's url.
 *
 * A LICENCE IS 48 CHARACTERS AND THIS IS 512, so no real row comes near it. It
 * is checked anyway because the value being interpolated arrives from DynamoDB
 * rather than from this repo, and the two ways to be wrong are not equal: over
 * the cap Discord refuses the whole reply — the admin gets `runCommand`'s
 * failure line and no profile at all — and a url cut to fit is a button that
 * silently opens the wrong page. So the button is DROPPED instead, and the
 * embed, which is the answer, still goes.
 */
const BUTTON_URL_CAP = 512

/* ------------------------------------------------------------------ */

/**
 * What Discord is told. Assignable to `APIEmbed`, which is what `run` returns.
 */
export interface ProfileEmbed {
  readonly title: string
  readonly description: string

  /**
   * One of `COLOUR`. NOT optional, so that an embed built here always states
   * which of the two it is rather than leaving Discord to draw no bar at all —
   * and so that `trimEmbed`, which rebuilds this record, cannot drop it.
   */
  readonly color: number

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
    // `RECENT_MATCHES` is what THIS reply can render and say it cut, and the
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

/**
 * Which of Discord's two timestamp renderings a field wants.
 *
 * `R` IS "2 hours ago" AND `f` IS "30 August 2026 12:00", and the choice is not
 * cosmetic — it is which question the field is answering.
 */
type Stamp = 'R' | 'f'

/**
 * One moment, as Discord's own timestamp markup, or a word saying there isn't
 * one.
 *
 * THE READER'S TIMEZONE, WHICH IS THE WHOLE POINT AND WHICH AN ISO STRING
 * CANNOT DO. `<t:UNIX:R>` is rendered by each viewer's client, so an admin in
 * Texas and a player in Berlin looking at the same ban see the same instant
 * written in their own local time and their own locale. What was here before
 * was `2026-09-05T00:00:00.000Z` — correct, unambiguous, and read by a person
 * who then has to do the arithmetic themselves.
 *
 * WHICH STYLE GOES WHERE, STATED ONCE SO THAT THE CALL SITES DO NOT EACH INVENT
 * IT. `R` is for anything whose value is HOW LONG — a match played, a last
 * seen, a ban issued, a ban lifted, a ban that has already expired. Every one of
 * those is read as freshness, and "3 hours ago" is the answer while the date it
 * happened to fall on is not. `f` is for the two things somebody has to write
 * down: an ACTIVE ban's expiry, which is a deadline a player plans around and a
 * moderator honours, and first seen, which is a date about the account rather
 * than a duration.
 *
 * SECONDS, NOT MILLISECONDS. Discord's markup takes a unix time in SECONDS, and
 * handing it milliseconds renders a date fifty thousand years out — a wrong
 * answer that looks like a feature working. `Math.floor` rather than rounding,
 * so a stamp never moves forward past the instant it names.
 *
 * THE `Date` CHECK IS NOT REDUNDANT WITH `Number.isFinite`. A finite number
 * larger than 8.64e15 is outside the range a `Date` can hold, and the number
 * this would otherwise interpolate is one Discord renders as garbage rather
 * than one it refuses. `unknownTime` is the honest answer for a row whose
 * timestamp is not a time.
 */
function when(ms: number | null | undefined, style: Stamp): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return COPY.unknownTime
  if (Number.isNaN(new Date(ms).getTime())) return COPY.unknownTime

  return `<t:${String(Math.floor(ms / 1000))}:${style}>`
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
    reads.matches?.(current, RECENT_MATCHES) ?? null,
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
    reads.matches?.(licence, RECENT_MATCHES) ?? null,
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

/** A full-width field: one heading and everything under it, across the embed. */
function field(name: string, value: string): APIEmbedField {
  return { name, value }
}

/**
 * A column.
 *
 * `inline: true` IS THE WHOLE OF DISCORD'S LAYOUT LANGUAGE, and what it means is
 * "put this beside the previous one if it fits". Three fit per row on a desktop
 * client and fewer on a narrow phone, which is why the tiles below are grouped
 * in THREES and why a run of them is broken by a full-width field rather than by
 * a count: a fourth tile does not start a new row because it is the fourth, it
 * starts one because the third filled the row.
 *
 * SHORT VALUES ONLY, WHICH IS NOT A STYLE RULE. A column is a third of the
 * width, so a long value in one is a narrow ribbon of two-word lines that is
 * harder to read than the single line it replaced. The licence list, the bans,
 * the registry row and the history are therefore full-width fields and always
 * will be; what goes in a tile is a number and at most a line under it.
 *
 * SHARED BY BOTH BUILDERS, like `cut` and `packed` and for the same reason: it
 * is about how Discord draws a field and decides nothing about what one says.
 *
 * IT CUTS RATHER THAN PACKS, which is the one place a tile differs from a
 * full-width field. `packed` drops whole LINES and says how many went, which is
 * the right answer for a list; a tile is a number and a caption, and there is no
 * subset of that worth reporting. Every value handed to this is a finite number
 * out of `num` in ddb.ts plus a fixed caption, so the cap is unreachable — it is
 * enforced here anyway because "unreachable" is a claim about today's callers
 * and `EMBED_FIELD_VALUE_CAP` is a claim about Discord.
 */
function tile(name: string, value: string): APIEmbedField {
  return { name, value: cut(value, EMBED_FIELD_VALUE_CAP), inline: true }
}

/**
 * The console's page for one licence.
 *
 * PERCENT-ENCODED, AND THE LINK IS BROKEN WITHOUT IT. A qualified licence is
 * `license:` + forty hex characters, and that colon is the problem: in a URL
 * path a colon is legal but is also the scheme delimiter, so `.../players/
 * license:abc` is a path some parsers read as a relative reference with a
 * scheme in it. Discord validates a button's url before it will accept the
 * message at all, and Next.js hands a dynamic segment to the page already
 * decoded — so `encodeURIComponent` here and nothing at the other end is the
 * whole contract. `%3A` is what arrives, `license:abc` is what the page reads.
 *
 * `encodeURIComponent` AND NOT `encodeURI`, which leaves a colon exactly as it
 * found it: it is the function for a whole URL, and this is one SEGMENT of one.
 */
function consoleLink(licence: string): string {
  return `${CONSOLE_URL}/players/${encodeURIComponent(licence)}`
}

/**
 * The button, in the one row a reply of this shape needs.
 *
 * A LINK BUTTON, WHICH IS THE ONE KIND THAT NEEDS NOTHING LISTENING. It carries
 * a `url` and no `custom_id`, so clicking it opens a page and sends this bot no
 * interaction — see `CommandReply` in ./command.ts. Every other style would
 * need a component handler in ./index.ts, which today ignores everything that
 * is not a chat-input command, and would leave a button that does nothing the
 * day somebody pressed it.
 *
 * IT TAKES A LICENCE, WHICH IS WHY IT CANNOT APPEAR IN THE SELF VIEW. That is
 * the same defence the rest of this file uses rather than a second rule to
 * remember: `SelfData` carries `known: boolean` and no licence at all — there is
 * nothing in scope on the self path to pass to this function, so `selfEmbed`
 * growing a button is a compile error and not a review comment. It matters
 * because the console is a moderator's tool behind a sign-in a player does not
 * have: a button that opens a page they are refused is a dead end, and one on
 * their own reply implies a page about them that they may read.
 *
 * A URL OVER THE CAP DROPS THE BUTTON AND NOT THE REPLY. See `BUTTON_URL_CAP`.
 *
 * EXPORTED SO THE ENCODING IS TESTED WHERE IT HAPPENS. `%3A` in the middle of a
 * path is exactly the kind of thing that reads as correct in a rendered button
 * and is wrong in the one character that matters, and asserting it through a
 * whole `/profile` invocation buries it.
 */
export function consoleRow(licence: string): CommandComponentRow | null {
  const url = consoleLink(licence)

  if (units(url) > BUTTON_URL_CAP) {
    log('warn', 'a licence made a console link too long for a button', {
      licence,
      length: units(url),
    })

    return null
  }

  return {
    type: ComponentType.ActionRow,
    components: [
      { type: ComponentType.Button, style: ButtonStyle.Link, label: COPY.openInConsole, url },
    ],
  }
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

/**
 * One ban, as the state an admin is deciding on.
 *
 * `**ACTIVE**` IS THE ONE BOLD THING IN THIS FIELD, and it is bold because it is
 * the difference between a record and a problem. A ban that is lifted or expired
 * is history and reads as history; the live one has to be findable in a list of
 * ten without reading any of them.
 *
 * FOUR STAMPS AND THREE OF THEM ARE `R`. When it was issued, when it was lifted
 * and when it expired are all freshness — an admin is asking "recently?" — and
 * the expiry of a ban still in force is the deadline, which is the one that has
 * to be a date. See `when`.
 */
function banLine(licence: string, ban: Ban, now: number): string {
  const state = isBanActive(ban, now)
    ? ban.expiresAt === null
      ? '**ACTIVE**, permanent'
      : `**ACTIVE** until ${when(ban.expiresAt, 'f')}`
    : ban.liftedAt
      ? `lifted ${when(ban.liftedAt, 'R')}`
      : `expired ${when(ban.expiresAt, 'R')}`

  const reason = ban.reason ? ` — ${oneLine(ban.reason)}` : ''

  return cut(
    `${licence}: ${state}, by ${oneLine(ban.byName)} ${when(ban.at, 'R')}${reason}`,
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

/**
 * The game's own numbers, from `br-players` `sk = 'profile'`, as two rows of
 * three columns.
 *
 * SIX TILES RATHER THAN ONE FIELD OF SIX LINES, which is the owner's
 * instruction and is also what the data wanted. Every one of these is a short
 * number with a name, which is the definition of a column; run together as
 * `Level 7 · 4500 XP · balance 250` they were a line a reader has to parse
 * before they can find the number they came for.
 *
 * THREE AND THREE, BECAUSE THREE IS WHAT DISCORD FITS. See `tile`. The grouping
 * is by what a reader is asking rather than by arithmetic: progression on the
 * top row — how far along, how rich, how much have they played — and what they
 * do in a match on the bottom.
 *
 * EVERY FIELD OF `GameProfile` IS SOMEWHERE HERE. Wins and top tens sit under
 * the match count they are a fraction of, deaths, downs and revives under the
 * kills they are the other side of, solo and squad under the time. A number
 * dropped for tidiness is a number the reader then cannot get at all.
 *
 * AN ARRAY, SO THE CALLER SPREADS IT. The alternative — one function per tile
 * — is six call sites in a builder that has to keep them in order anyway, and
 * order is what makes them a table.
 *
 * A NULL CAREER IS STILL ONE FIELD SAYING SO. Six empty columns would be a table
 * of nothing; `No match record on the game side.` is a sentence, and a sentence
 * gets the full width.
 */
function careerTiles(career: GameProfile | null): APIEmbedField[] {
  if (career === null) return [field(COPY.career, COPY.noCareer)]

  return [
    tile(COPY.level, COPY.levelTile(career.level, career.xp)),
    tile(COPY.volts, COPY.voltsTile(career.balance)),
    tile(
      COPY.matchesPlayed,
      COPY.matchesTile(
        career.matches,
        career.wins,
        career.top10s,
        when(career.lastMatchAt, 'R'),
      ),
    ),

    tile(
      COPY.kills,
      COPY.killsTile(career.kills, career.deaths, career.downs, career.revives),
    ),
    tile(COPY.damage, COPY.damageTile(career.damageDealt)),
    tile(
      COPY.inMatch,
      COPY.inMatchTile(
        span(career.playtimeSec * 1000),
        career.soloMatches,
        career.squadMatches,
      ),
    ),
  ]
}

/** The console's registry row: who they are and how long they have been here. */
function registryField(registry: PlayerRecord | null): APIEmbedField {
  if (registry === null) return field(COPY.registry, COPY.noRegistry)

  // `f` for first seen and `R` for last seen, which is the rule in `when`
  // applied to two dates that look alike and are not: the first is when this
  // account started, which is a date somebody quotes, and the second is
  // freshness — "yesterday" is the answer, and the date it fell on is not.
  // The name is NOT bolded here, though it is the one borrowed value in the
  // field: it is already the embed's title, and `cut` walks code points to a
  // budget, so wrapping it would be the one place in this file where a
  // truncation could land between a `**` and its partner and leave the markup
  // open. The numbers below are bounded and cannot.
  const lines = [
    cut(oneLine(registry.name), LINE_CAP),
    `First seen ${when(registry.firstSeen, 'f')} · last seen ${when(registry.lastSeen, 'R')}`,
    `**${registry.sessions}** sessions · **${span(registry.playtimeMs)}** connected`,
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

/**
 * One match: when, where they finished, how many they got.
 *
 * `R` FOR THE TIME, AND THIS IS THE FIELD THE STYLE RULE WAS WRITTEN FOR. A list
 * of recent matches is read as a list of "how long ago" — `2 hours ago` above
 * `yesterday` above `3 days ago` is the shape of somebody's playing, and five
 * absolute datestamps are five things to subtract from now.
 *
 * THE PLACEMENT IS THE BOLD ONE. It is what the match was, and it is the number
 * a reader scans the column for; kills is context around it.
 *
 * THE TIMESTAMP AND THE PLACEMENT ARE AT THE FRONT, WHICH IS ALSO WHY `cut`
 * CANNOT BREAK THEM. The only unbounded part of this line is the sort key, and
 * it is last — so a cut takes the end of a key rather than the middle of a piece
 * of markup.
 */
function matchLine(match: MatchSummary): string {
  const parts = [when(match.at, 'R')]

  if (match.placement !== null) parts.push(`**#${match.placement}**`)
  if (match.kills !== null) parts.push(`${match.kills} kills`)

  // The sort key is what identifies the row when it carried no timestamp, so it
  // is the only thing worth falling back to.
  if (match.at === null) parts.push(oneLine(match.sk))

  return cut(parts.join(' · '), LINE_CAP)
}

/**
 * Five matches at most, as much of that as the budget allows, and an honest
 * statement of the rest.
 *
 * THE NOTE IS RECOMPUTED EACH PASS, like `packed`'s, and for the same reason.
 * It is also produced when NOTHING was dropped, whenever the career row says
 * there are more matches than the reader was asked for — that is the cut nobody
 * would otherwise see, and it is the larger of the two.
 *
 * `read` IS WHAT THE READER HANDED OVER AND NOT WHAT SURVIVED THE SLICE, which
 * is the whole reason the slice is here rather than at the call site. Rendering
 * five out of twenty-five and then reporting `5` as the number read would be a
 * truncation describing itself as complete — the exact failure this function's
 * note exists against.
 */
function matchesValue(
  matches: readonly MatchSummary[],
  total: number | null,
  budget: number,
): string {
  const read = matches.length
  const lines = matches.slice(0, RECENT_MATCHES).map(matchLine)

  for (let shown = lines.length; shown >= 0; shown--) {
    const note = COPY.matchesNote(shown, read, total)
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
 *
 * THE COLOUR IS NOT IN THE SUM BECAUSE IT IS NOT IN DISCORD'S. The limit is over
 * the TEXT of an embed, and a colour is an integer with no characters in it — so
 * `ProfileEmbed.color` costs nothing here and needs no line below. That is not
 * an oversight to be tidied up later: adding it would make every reply measure
 * six units it does not spend, and the first thing to be cut for those six is a
 * line of somebody's ban history.
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

  // The colour is carried through rather than recomputed. This function knows
  // nothing about bans and must not learn: it is a budget guard, and the one
  // thing it may do to a reply is take fields off the end of it.
  return {
    title: embed.title,
    description: embed.description,
    color: embed.color,
    fields: kept,
  }
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
 *
 * THE ORDER IS THE LAYOUT AND IT IS ALSO THE SURVIVAL ORDER. Discord fills a row
 * with consecutive `inline` fields and breaks it at the first full-width one, so
 * "licences, bans, then two rows of three tiles, then the long ones" is a
 * paragraph of moderation record above a table of numbers. It happens to be the
 * same order `trimEmbed` would want anyway: it drops from the END, so the two
 * fields an admin ran this command for are the two that cannot be dropped.
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

  // ANY licence, not the current one, which is the same rule `bansField`
  // follows and for the same reason: an account whose current licence is clean
  // and whose previous one is banned is what this command exists to surface,
  // and a colour that only looked at the current licence would say the opposite
  // of the field under it.
  const banned = data.bans.some((row) => row.ban !== null && isBanActive(row.ban, now))

  const embed: ProfileEmbed = {
    title,
    description: cut(description.join('\n'), EMBED_DESCRIPTION_CAP),
    color: banned ? COLOUR.banned : COLOUR.normal,
    fields: [],
  }

  // An account with no licences has nothing keyed on one to show. The
  // description has already said which of the two reasons that is.
  if (data.licences.length > 0) {
    embed.fields.push(
      licencesField(data),
      bansField(data, now),
      ...careerTiles(data.career),
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
 * what stops two readers being forced to agree. `selfCareerTiles` renders the
 * same six columns `careerTiles` renders TODAY, and the day one of them changes —
 * a stat that turns out to be moderation-only, a number the owner wants phrased
 * differently for players — it changes on one side without a flag, a parameter
 * or a branch anybody has to remember. The shared function was the version
 * where that edit silently changes both.
 *
 * WHAT IS SHARED IS `field`, `tile`, `cut`, `oneLine`, `when`, `span`,
 * `packed`, `units`, `embedUnits` and `trimEmbed`. Every one of those is about
 * Discord's limits, its layout, or turning somebody else's text into one safe
 * line. None of them is handed a licence, a `Ban`, or a decision about who may
 * see what — and `consoleRow`, which IS handed a licence, is on the other side
 * of that line and is called from neither builder.
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

  lines.push(
    ban.expiresAt === null ? SELF.banPermanent : SELF.banUntil(when(ban.expiresAt, 'f')),
  )

  return field(SELF.ban, packed(lines, COPY.linesOmitted, EMBED_FIELD_VALUE_CAP))
}

/**
 * The game's own numbers — the progression a player already sees in game — as
 * the same two rows of three the admin view uses.
 *
 * THE SAME SIX TILES, WRITTEN OUT AGAIN, AND THAT IS THE POINT OF THE FILE. See
 * the block comment above: a player's progression and a moderator's read of it
 * are the same six numbers TODAY, and the day one of them stops being — a stat
 * that turns out to be moderation-only, a number the owner wants worded
 * differently for players — it changes on one side, with no flag and no branch
 * anybody has to remember to keep.
 */
function selfCareerTiles(career: GameProfile | null): APIEmbedField[] {
  if (career === null) return [field(COPY.career, COPY.noCareer)]

  return [
    tile(COPY.level, COPY.levelTile(career.level, career.xp)),
    tile(COPY.volts, COPY.voltsTile(career.balance)),
    tile(
      COPY.matchesPlayed,
      COPY.matchesTile(
        career.matches,
        career.wins,
        career.top10s,
        when(career.lastMatchAt, 'R'),
      ),
    ),

    tile(
      COPY.kills,
      COPY.killsTile(career.kills, career.deaths, career.downs, career.revives),
    ),
    tile(COPY.damage, COPY.damageTile(career.damageDealt)),
    tile(
      COPY.inMatch,
      COPY.inMatchTile(
        span(career.playtimeSec * 1000),
        career.soloMatches,
        career.squadMatches,
      ),
    ),
  ]
}

function selfMatchLine(match: MatchSummary): string {
  const parts = [when(match.at, 'R')]

  if (match.placement !== null) parts.push(`**#${match.placement}**`)
  if (match.kills !== null) parts.push(`${match.kills} kills`)

  // The sort key is what identifies the row when it carried no timestamp.
  if (match.at === null) parts.push(oneLine(match.sk))

  return cut(parts.join(' · '), LINE_CAP)
}

/**
 * Five matches at most, as much of that as the budget allows, and how many they
 * have played in all.
 *
 * IT STATES THE TOTAL NOW, AND THAT IS A CHANGE THIS FILE OWED THE PLAYER. This
 * used to be `packed` alone, on the reasoning that the second number in the
 * admin view's note is a statement about the bot's fetch limit rather than about
 * them — true while the reader fetched twenty-five and the field showed as many
 * as fitted. It is a five-row history now, so a player with four hundred matches
 * would have been handed five lines and nothing at all to say they were five;
 * a truncation that says nothing is the one thing this file will not do.
 *
 * `SELF.matchesNote` AND NOT `COPY.matchesNote`, for the reason the two builders
 * exist: "3 of the 5 read were not shown" is bot plumbing, and what a player is
 * owed is the count of their own matches.
 */
function selfMatchesField(
  matches: readonly MatchSummary[],
  total: number | null,
  budget: number,
): APIEmbedField {
  if (matches.length === 0) return field(COPY.matches, COPY.noMatches)

  const read = matches.length
  const lines = matches.slice(0, RECENT_MATCHES).map(selfMatchLine)

  for (let shown = lines.length; shown >= 0; shown--) {
    const note = SELF.matchesNote(shown, read, total)
    const body = [...lines.slice(0, shown), ...(note === null ? [] : [note])].join('\n')

    if (units(body) <= budget) return field(COPY.matches, body)
  }

  // Unreachable while `budget` is at or above `MATCH_FIELD_FLOOR`, exactly as in
  // `matchesValue`: the caller drops the field below that and every line is
  // capped at `LINE_CAP`. Never empty, because Discord refuses an empty value.
  return field(COPY.matches, cut(lines[0] ?? COPY.noMatches, budget))
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
 *
 * RED WHEN THEY ARE BANNED, WHICH IS A ONE-LINE TEST HERE AND A `some` OVER THE
 * LICENCES THERE. `gatherSelf` has already discarded every ban that is not in
 * force, so the presence of the record IS the state — the same reason this
 * function takes no clock.
 *
 * AND NO COMPONENTS, WHICH IS ENFORCED BY THERE BEING NOTHING TO BUILD ONE
 * FROM. The console button needs a licence and `SelfData` has none: it carries
 * `known: boolean`, so a button on a player's own reply is not a thing this
 * function could add without first widening the record it is handed. See
 * `consoleRow`.
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
    color: data.ban === null ? COLOUR.normal : COLOUR.banned,
    fields: [],
  }

  if (data.ban !== null) embed.fields.push(selfBanField(data.ban))
  if (data.known) embed.fields.push(...selfCareerTiles(data.career))
  if (data.unreached.length > 0) embed.fields.push(selfUnreachedField(data.unreached))

  if (data.known) {
    const budget = Math.min(
      EMBED_FIELD_VALUE_CAP,
      EMBED_TOTAL_CAP - embedUnits(embed) - units(COPY.matches),
    )

    if (budget >= MATCH_FIELD_FLOOR) {
      embed.fields.push(selfMatchesField(data.matches, data.career?.matches ?? null, budget))
    }
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
 * THE CONSOLE BUTTON IS ON THE TARGETED HALF ONLY, and the reason is the same
 * one that splits everything else in this file. The Ringmaster console is behind
 * a sign-in that moderators have and players do not, so a button on a player's
 * own reply offers them a page that will refuse them — a dead end that also
 * implies there is a console record of them they are entitled to read. It is not
 * enforced by an `if` here: the self path has no licence value in scope to build
 * a link from, so there is nothing to forget. See `consoleRow`.
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
        // NO `components` ON THIS PATH, and nothing here decides that: there is
        // no licence in scope to link to. See `selfEmbed` and `consoleRow`.
        return { embeds: [selfEmbed(await gatherSelf(reads, invocation.userId, now()))] }
      }

      const data = await gatherProfile(reads, invocation.targetId)
      const embed = profileEmbed(data, now())

      // NO BUTTON WITHOUT A LICENCE TO PUT IN IT. An account the index has never
      // heard of, and an index that could not be read, both arrive here with
      // `current: null` — and the console has no page for either. A button that
      // opens a 404 is worse than no button, because it says there is a record
      // to look at.
      const row = data.current === null ? null : consoleRow(data.current)

      // `profileEmbed` has already fitted this to the 6000 an embed may carry
      // and `trimEmbed` is its last guard, so nothing between here and Discord
      // measures it again — which is the whole of what widening the seam bought.
      // The button is not in that budget at all: components are counted
      // separately by Discord and this reply has one.
      return row === null ? { embeds: [embed] } : { embeds: [embed], components: [row] }
    },
  }
}
