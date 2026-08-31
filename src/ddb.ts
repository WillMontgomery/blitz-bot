import { randomUUID } from 'node:crypto'

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb'
import type {
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb'

/**
 * DynamoDB: the tables the bot reads, and the three it writes.
 *
 * THIS IS THE FIRST AWS CALL THIS PROCESS HAS EVER MADE, so everything here is
 * a first decision rather than a convention already in force. The console —
 * fivem-ringmaster, on the same box — has been talking to these tables for
 * months, and where a decision is already made over there this file makes the
 * same one and says so. Where it deliberately differs, it says that too.
 *
 * IT DELIBERATELY DIFFERS TWICE, and both differences are the same shape: the
 * console writes as a WEB APP, where a human clicked once and a request either
 * happened or did not, and the bot writes as an EVENT CONSUMER, where the same
 * event can arrive twice and no user is watching the second one. So the two
 * writes the console does unconditionally — the audit row at the foot of this
 * file, and the ban row in `bans.issue` — are both CONDITIONAL here, and each
 * one carries the paragraph explaining what the unconditional version would
 * have destroyed.
 *
 * NO CREDENTIALS ANYWHERE, AND NONE ARE CONFIGURABLE. The SDK's default
 * provider chain finds the EC2 instance role from instance metadata on its
 * own, which is the same thing the console does and the same thing that makes
 * a leaked `.env` worth nothing. If you ever find yourself adding an access
 * key to this repo, the deployment is wrong. blitz-bot#4 tracks giving the bot
 * an identity of its own rather than sharing the box's.
 *
 * THE REGION IS PASSED EXPLICITLY AND IS NEVER INHERITED. This is the whole
 * reason this file has a settings object at all — see `DEFAULT_REGION`.
 *
 * EVERY CALL RETURNS A RESULT AND NOTHING HERE THROWS. A Discord slash command
 * has three seconds to say anything at all, and a `get` that hangs on a
 * misconfigured security group burns all three and leaves the admin looking at
 * "the application did not respond". So every call carries a wall-clock
 * deadline and comes back as `{ ok: false, failure }` rather than as a
 * rejection the caller has to remember to catch — see `DdbResult`.
 *
 * IT IS A FACTORY, NOT A MODULE SINGLETON, for the reason src/config.ts has no
 * cached config: a test builds the thing it wants, hands it a fake document
 * client, and there is no module state for one test to leave behind for the
 * next. The process calls `createDdb` once at boot and passes the result down.
 * (The console keeps a lazily-constructed global instead, because `next build`
 * imports every module and would otherwise demand a complete production
 * environment to compile. Nothing here is imported by a build step.)
 *
 * THIS MODULE NEVER TALKS TO THE RINGMASTER HTTP API, and the imports at the
 * top of this file are the whole proof: the AWS SDK and `node:crypto`. The bot
 * reads the console's DATA, not the console's web app — so a console that is
 * down, redeploying or mid-migration costs the bot nothing, and the bot cannot
 * take the console down by asking it questions. That property is pinned by a
 * test that reads this file's imports.
 */

/**
 * THE REGION IS A TRAP AND THIS DEFAULT IS THE ANSWER TO IT.
 *
 * Left unset, the SDK resolves a region from the environment and then from
 * instance metadata — the region of the BOX. The box's region and the tables'
 * region are not the same fact and are not required to agree. When they don't,
 * every call fails with `ResourceNotFoundException` against tables that plainly
 * exist and that you are looking at in the console in another tab, which reads
 * as "the table is missing" and sends you to check spelling, IAM and the table
 * list before you think to check the region.
 *
 * The console escapes it by defaulting AWS_REGION explicitly in its env schema
 * (`lib/env.ts`), and has never hit the failure since. Same default here, and
 * `no-such-table` is a failure kind of its own so the one error that means
 * "wrong region" is not buried in the general one.
 *
 * OVERRIDABLE, because a second stack in another region is a `region` option
 * and not a code change. Never inherited: passing this explicitly to the client
 * is what stops instance metadata from ever having an opinion.
 */
const DEFAULT_REGION = 'us-east-2'

/**
 * TABLE NAMES COME FROM A PREFIX AND NEVER FROM A STRING LITERAL.
 *
 * The console derives ten names from one `DDB_TABLE_PREFIX`, so standing up a
 * second environment is one variable rather than ten — and, more to the point,
 * so that a staging bot pointed at a staging stack cannot be one forgotten
 * literal away from writing an audit row into production. Same rule here.
 */
const DEFAULT_TABLE_PREFIX = 'ringmaster-'

/**
 * The GAME's tables, under a prefix of their own because they have a different
 * owner: br_ddb on the game box writes them at the end of every match and the
 * bot only ever reads them. Kept separate so an IAM policy can say exactly
 * that, which is a sentence you cannot write if both sets share a prefix.
 */
const DEFAULT_GAME_TABLE_PREFIX = 'br-'

/**
 * How long any one call may take before it is a failure instead of a wait.
 *
 * MEASURED AGAINST DISCORD'S DEADLINE, NOT AGAINST DYNAMODB'S LATENCY. An
 * interaction must be answered or deferred within three seconds or the
 * gateway closes it and the admin sees "the application did not respond" —
 * which is indistinguishable from the bot being down. Two seconds leaves a
 * second to turn the answer into an embed and send it, and a healthy point
 * lookup in the same region answers in single-digit milliseconds, so this
 * ceiling is only ever reached by something that is actually wrong.
 *
 * ONE MECHANISM, NOT TWO. The SDK's own request and connection timeouts are
 * deliberately left alone: two independent budgets is how you get a call that
 * neither of them cancels, and the wall clock is the only one that maps onto
 * the deadline that actually exists.
 */
const DEFAULT_TIMEOUT_MS = 2_000

/**
 * How many times an audit write may step forward over a taken sort key.
 *
 * Four rather than one because the collision it exists for arrives in bursts
 * (see `begin`), and four rather than forty because each attempt is a round
 * trip. A conflict comes back from DynamoDB as a fast rejection rather than as
 * a timeout, so the cost of the retries is milliseconds and not a share of the
 * deadline above.
 */
const AUDIT_WRITE_ATTEMPTS = 4

export interface DdbOptions {
  /** See `DEFAULT_REGION`. Explicit here or explicit by default; never absent. */
  region?: string
  /** Ringmaster's tables. See `DEFAULT_TABLE_PREFIX`. */
  tablePrefix?: string
  /** The game's tables. See `DEFAULT_GAME_TABLE_PREFIX`. */
  gameTablePrefix?: string
  /** Per-call wall-clock ceiling in ms. See `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number

  /**
   * The audit log's partition key. See `AUDIT_PK` for why this is an option at
   * all and why it is not an environment variable.
   */
  auditPartition?: string

  /**
   * The document client to use, for tests.
   *
   * THE ONLY SEAM, AND IT IS THE RIGHT ONE. Everything above the seam — name
   * derivation, deadlines, failure classification, the audit key dance — is
   * exercised offline against a fake that records what it was asked for. What
   * is below it is the SDK, which is not ours to test.
   */
  document?: DocumentClient

  /**
   * The clock, for tests.
   *
   * Injectable because the audit log's sort key IS the clock, so the one
   * collision this file exists to handle can only be provoked by holding
   * `Date.now()` still.
   */
  now?: () => number
}

/**
 * The four operations this module performs, and therefore the four it can
 * perform at all.
 *
 * THE ABSENCE OF `delete` AND `scan` IS THE POINT. This seam is the module's
 * whole reach into DynamoDB, so a `delete` that nothing here can call is a
 * `delete` no future edit can reach for without widening this interface first
 * and explaining why in the diff. The bot has no business deleting a row in
 * any of these tables — the ban table keeps lifted bans, the audit log is
 * append-only — and a scan of `ringmaster-players` is a bill rather than a
 * feature.
 */
export interface DocumentClient {
  get(input: GetCommandInput, options?: RequestOptions): Promise<GetCommandOutput>
  put(input: PutCommandInput, options?: RequestOptions): Promise<PutCommandOutput>
  update(input: UpdateCommandInput, options?: RequestOptions): Promise<UpdateCommandOutput>
  query(input: QueryCommandInput, options?: RequestOptions): Promise<QueryCommandOutput>
}

/** What `call` hands the SDK so an expired deadline actually releases the socket. */
export interface RequestOptions {
  abortSignal?: AbortSignal
}

/**
 * The real client.
 *
 * `removeUndefinedValues` BECAUSE THE DEFAULT IS TO THROW. An audit row with
 * no `detail` has an undefined field on it, and without this the SDK rejects
 * the whole write rather than omitting the attribute — which would turn "this
 * action had no extra detail" into a failed audit write and, per the rule in
 * `begin`, into an action that must not proceed.
 *
 * `maxAttempts: 2` BECAUSE OF THE DEADLINE ABOVE. The SDK's default of three
 * attempts with backoff can only spend a budget it cannot finish inside; one
 * retry covers the dropped packet this is actually for and leaves the wall
 * clock in charge of everything else.
 */
export function createDocument(region: string): DocumentClient {
  const client = new DynamoDBClient({ region, maxAttempts: 2 })

  return DynamoDBDocument.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  })
}

/** The operation a failure happened during. Part of the failure, for the log. */
export type DdbOp = 'get' | 'put' | 'update' | 'query'

/**
 * Why a call did not produce an answer.
 *
 * A CLOSED SET, SO A CALLER CAN SWITCH ON IT. These are not five spellings of
 * "it broke": each one is a different sentence to a different person. `timeout`
 * is a network or a table under load and the admin should try again;
 * `no-such-table` is almost always the region (see `DEFAULT_REGION`) and is an
 * operator's problem, not the admin's; `denied` and `credentials` are the
 * instance role, which is blitz-bot#4's territory; `conflict` is a write that
 * refused to clobber something and is the interesting one — see `begin`.
 */
export type DdbFailureKind =
  | 'timeout'
  | 'no-such-table'
  | 'denied'
  | 'credentials'
  | 'conflict'
  | 'error'

export interface DdbFailure {
  kind: DdbFailureKind
  op: DdbOp
  /** The table as this module named it, so a wrong prefix is visible in the log. */
  table: string
  /**
   * The SDK's own message, or the deadline statement. Operator-facing.
   *
   * NEVER SHOWN TO A MEMBER OF THE GUILD AND NEVER PART OF A COMMAND'S REPLY
   * WITHOUT SOMEBODY DECIDING SO. It carries table names and AWS request
   * detail; the caller decides what an admin is told, the same way client.ts
   * decides what a removal notice says.
   */
  message: string
}

/**
 * The result of a call.
 *
 * A RESULT RATHER THAN A THROW, and the difference is a forgotten `try` in a
 * command handler at 2am. A rejection is invisible at the call site: the code
 * that reads `const ban = await ddb.bans.get(...)` compiles whether or not
 * anybody catches anything, and the failure surfaces as an unhandled rejection
 * and a silent interaction. A union forces the question at the point where the
 * answer is needed, which is exactly where the caller knows what to say.
 */
export type DdbResult<T> = { ok: true; value: T } | { ok: false; failure: DdbFailure }

/**
 * The names of the exceptions we have a specific answer for.
 *
 * MATCHED EXACTLY, NEVER BY SUBSTRING. An error whose message happens to
 * contain the word "denied" is not an authorisation failure, and a
 * classification that guesses wrong sends an operator to the IAM console over
 * a network blip. Anything not on this list is `error`, which is the honest
 * answer for a failure this module has never seen.
 */
const FAILURE_KINDS: Record<string, DdbFailureKind> = {
  ResourceNotFoundException: 'no-such-table',
  ConditionalCheckFailedException: 'conflict',
  AccessDeniedException: 'denied',
  AccessDenied: 'denied',
  UnrecognizedClientException: 'denied',
  MissingAuthenticationTokenException: 'denied',
  CredentialsProviderError: 'credentials',
  CredentialsError: 'credentials',
  // Ours, from the abort the deadline fires — see `call`. Normally the race
  // reports the timeout first and this never runs, but an SDK that rejects
  // faster than the timer resolves must not come back as a generic error.
  AbortError: 'timeout',
  TimeoutError: 'timeout',
  RequestAbortedException: 'timeout',
}

function classify(error: unknown, op: DdbOp, table: string): DdbFailure {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)

  return { kind: FAILURE_KINDS[name] ?? 'error', op, table, message }
}

/**
 * Every table this module can name.
 *
 * DERIVED, ALWAYS. `tables.bans` is the only spelling of the bans table in
 * this repo; there is no second one to fall out of step.
 */
export interface TableNames {
  /** Read AND written. One row per identifier, lifted bans kept. See `bans.issue`. */
  bans: string
  /** Read only. The console's player registry, keyed on license. */
  players: string
  /** Read only. Reverse index: qualified identifier -> licenses. */
  playerIds: string
  /** Read AND written. The only one the bot APPENDS to. See `begin`. */
  audit: string
  /** Read only. One row, fixed key, the scheduled window. */
  maintenance: string
  /**
   * Read AND written. The bot's own durable state.
   *
   * UNDER THE CONSOLE'S PREFIX RATHER THAN A THIRD ONE, and that is a real
   * decision. A prefix marks a stack, and this table belongs to the same stack
   * as everything above it: one variable still stands up a whole second
   * environment, which is the property the prefix exists for. The argument for
   * splitting it — that a prefix is also an IAM boundary — does not bite yet,
   * because the bot currently shares the box's instance role WITH the console
   * and so has exactly the console's access anyway. When blitz-bot#4 gives the
   * bot its own identity, that policy names tables one at a time; it does not
   * need a prefix to express "this one is the bot's".
   */
  botState: string
  /** Read only, and a different prefix: the GAME's row. `{pk, sk}` keyed. */
  gamePlayers: string
}

export function tableNames(prefix: string, gamePrefix: string): TableNames {
  return {
    bans: `${prefix}bans`,
    players: `${prefix}players`,
    playerIds: `${prefix}player-ids`,
    audit: `${prefix}audit`,
    maintenance: `${prefix}maintenance`,
    botState: `${prefix}bot-state`,
    gamePlayers: `${gamePrefix}players`,
  }
}

/* ------------------------------------------------------------------ *
 * Row shapes.
 *
 * TRANSCRIBED FROM fivem-ringmaster/src/lib, NOT INVENTED HERE, and the file
 * each one came from is named above it. The console writes these rows; the bot
 * mostly reads them, so a shape that drifts is a field that silently reads as
 * `undefined` rather than a compile error. Where the console's interface is
 * larger than anything the bot asks of it, the version here is a SUBSET and
 * says so — extra attributes on the row are simply not in the type, which
 * costs nothing, whereas transcribing thirty fields the bot never reads is
 * thirty more chances to drift.
 *
 * `ringmaster-audit` IS THE EXCEPTION AND IS TRANSCRIBED WHOLE, because the
 * bot WRITES it and a writer that omits a field the console renders produces a
 * row that reads as damaged.
 * ------------------------------------------------------------------ */

/** From lib/players.ts. `ip` is excluded by construction, on the game side. */
export type IdKind = 'license' | 'license2' | 'discord' | 'steam' | 'fivem' | 'xbl' | 'live'

/**
 * A qualified identifier, the way the reverse index stores it.
 *
 * A FUNCTION RATHER THAN AN INTERPOLATION AT EACH CALL SITE, because the
 * failure mode of getting it wrong is not an error. `player-ids` is keyed on
 * the qualified string, so a lookup for `280…` instead of `discord:280…` is a
 * perfectly valid GetItem that returns no row — and "this Discord account has
 * never been here" is a sentence the bot would then say with confidence about
 * someone who is in the table.
 */
export function qualifyId(kind: IdKind, value: string): string {
  return `${kind}:${value}`
}

/**
 * From lib/bans.ts, whole — the bot writes these rows now, so nothing is
 * dropped and the field meanings below are that file's, not this one's.
 *
 * A BAN IS A RECORD, NOT A DELETION, which is lib/bans.ts's own rule and the
 * reason there is no `bans.remove` here and never will be. Lifting stamps
 * `liftedAt`/`liftedBy` onto the row and leaves it exactly where it was,
 * because the question an admin asks six months later is "has this person been
 * banned before, and who let them back in" — which a table that deletes on
 * lift cannot answer at all.
 */
export interface Ban {
  /**
   * Partition key. A QUALIFIED IDENTIFIER — `license:abc123…` for a player the
   * game has seen, and see `bans.issue` for the `discord:…` case.
   *
   * The attribute is called `license` because that is its name on a table the
   * console and the game box already read, and an attribute the bot renamed
   * would simply be a row neither of them can find.
   */
  license: string
  at: number
  /** The issuing admin, by license. Null only for system-issued bans. */
  by: string | null
  byName: string
  /** Shown to the player at connect, so it is written for them. */
  reason: string
  /** Absolute expiry, or null for permanent. */
  expiresAt: number | null
  playerName?: string | null
  /** Presence of `liftedAt` IS the lifted state. */
  liftedAt?: number | null
  liftedBy?: string | null
  liftedByName?: string | null
  liftReason?: string | null

  /**
   * THE ONE ATTRIBUTE ON THIS ROW THE CONSOLE DOES NOT WRITE: the id of the
   * Discord audit log entry this ban came from. Absent on every row the
   * console issued, and on every row written before this existed.
   *
   * It is safe to add BECAUSE the console reads these rows with a cast rather
   * than a projection — `res.Item as Ban` in lib/bans.ts — so an attribute it
   * has no name for is an attribute it never looks at. It costs the console
   * nothing and the game box nothing.
   *
   * WHAT IT IS FOR is the whole of `bans.issue`: it is the bot's answer to
   * "have I already acted on this event", which is a better question than
   * "is this person banned" because it survives a restart, a replay and a
   * lift. Optional in the type because a row that has been overwritten since,
   * or that the console wrote, genuinely does not have one.
   */
  discordEntryId?: string | null
}

/**
 * Is this ban in force right now?
 *
 * A COPY OF `isActive` IN fivem-ringmaster/src/lib/bans.ts, WORD FOR WORD, and
 * the duplication is deliberate rather than lazy. Over there that function is
 * "the one place that decides", so the console and the game's connect gate
 * cannot disagree about what banned means. The bot is a third reader of the
 * same table in a third repo and cannot import it, so its options were one
 * copy here or one ad-hoc `if` per command — and the second option is how
 * `/lookup` ends up calling somebody banned three weeks after their ban
 * expired.
 *
 * IF THE RULE CHANGES OVER THERE IT MUST CHANGE HERE. Nothing enforces that;
 * it is why this comment names the file.
 */
export function isBanActive(ban: Ban, now = Date.now()): boolean {
  if (ban.liftedAt) return false
  if (ban.expiresAt !== null && ban.expiresAt <= now) return false
  return true
}

/**
 * What `bans.issue` needs. The console's `issue` input plus `entryId`.
 *
 * NAMED `id` RATHER THAN `license`, unlike the console's, because the bot
 * writes rows keyed on a `discord:…` identifier as well and a parameter called
 * `license` holding `discord:280…` is a lie the next reader has to discover.
 * The row's ATTRIBUTE is still `license` — see `Ban`.
 */
export interface BanIssueInput {
  /** The partition key: a qualified identifier, from `qualifyId`. */
  id: string
  /** The issuing admin, by license, or null when we cannot resolve one. */
  by: string | null
  byName: string
  /** Shown to the player at connect. Written for them, not for the log. */
  reason: string
  /** Absolute, or null for permanent. Never a duration — see `Ban`. */
  expiresAt: number | null
  playerName?: string | null

  /**
   * The Discord audit log entry id that produced this ban. The idempotency
   * key; see `bans.issue` for what it costs and what it does not cover.
   */
  entryId: string
}

/**
 * What happened, in the three ways it can happen — and a caller has to tell
 * them apart, because they are three different sentences to an admin.
 *
 * `issued` — the row was written.
 * `already-banned` — an ACTIVE ban was already there, from some other event or
 *   from the console, and nothing was written. Not an error: it is the correct
 *   outcome of asking twice, and the ban that stands is the one attached.
 * `duplicate-event` — this exact Discord event has already been acted on. The
 *   attached row is the one it produced, whatever state it is in NOW; it may
 *   have been lifted since, and this outcome is precisely what stops the bot
 *   re-banning over that lift.
 *
 * THERE IS ALWAYS A BAN TO REPORT, in all three cases, so no caller has to
 * handle a success with nothing in it.
 */
export type BanIssueOutcome = 'issued' | 'already-banned' | 'duplicate-event'

export interface BanIssueResult {
  outcome: BanIssueOutcome
  ban: Ban
}

/** What `bans.lift` needs. The console's `lift` input, by qualified id. */
export interface BanLiftInput {
  id: string
  /** The lifting admin, by license, or null. Kept on the row forever. */
  by: string | null
  byName: string
  reason?: string | null
}

/**
 * `no-ban` carries no row BY CONSTRUCTION, so a caller cannot report a lift of
 * something that was never there. The other two carry the row as it now
 * stands: `lifted` the one this call stamped, `already-lifted` the one that
 * was already stamped — with the ORIGINAL lifter's name on it, which is the
 * point of not writing over it.
 */
export type BanLiftResult =
  | { outcome: 'lifted' | 'already-lifted'; ban: Ban }
  | { outcome: 'no-ban'; ban: null }

/** From lib/players.ts. */
export interface IdentifierSighting {
  value: string
  firstSeen: number
  lastSeen: number
}

/**
 * From lib/players.ts, SUBSET. The console's `PlayerRecord` also carries match
 * statistics, progression and party history, all of which are the GAME's
 * numbers — `gamePlayers.profile` is where the bot should read those from,
 * because that row is the one br_ddb actually writes.
 */
export interface PlayerRecord {
  /** Partition key. The qualified license. */
  license: string
  /** Most recent in-game name. */
  name: string
  /** Every name they have used, newest first. */
  names?: Array<{ name: string; firstSeen: number; lastSeen: number }>
  /** Set from the pause menu. Distinct from the name FiveM reports. */
  preferredName?: string | null
  /** kind -> every value seen for it. */
  identifiers?: Partial<Record<IdKind, IdentifierSighting[]>>
  firstSeen: number
  lastSeen: number
  sessions: number
  /** Total connected time across all sessions, ms. */
  playtimeMs: number
  /** The current session's start, when connected. Cleared on disconnect. */
  sessionStartedAt?: number | null
}

/** From lib/players.ts. Partition key is the qualified identifier. */
export interface IdentifierIndexRow {
  id: string
  /** Licenses that have presented it, most recent last. */
  licenses: string[]
  firstSeen: number
  lastSeen: number
}

/**
 * From lib/gameProfile.ts, SUBSET: the career totals and the market.
 *
 * PROJECTED FIELD BY FIELD RATHER THAN CAST, unlike every other read in this
 * file, and for the reason the console gives for doing the same: this row is
 * written by the game server — a different repo, on a different box, in Lua.
 * A field that arrives missing or renamed should cost that field, not produce
 * `undefined` where a number was promised and a `NaN` three lines into
 * whatever the bot was formatting.
 */
export interface GameProfile {
  matches: number
  wins: number
  top10s: number
  kills: number
  deaths: number
  downs: number
  revives: number
  damageDealt: number
  /** In-match seconds. NOT connected time, which the registry holds. */
  playtimeSec: number
  soloMatches: number
  squadMatches: number
  xp: number
  level: number
  balance: number
  /** When the last match was recorded, ms. Null if none ever has been. */
  lastMatchAt: number | null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * The same, but an absent field stays absent.
 *
 * ZERO IS A RESULT AND `num` CANNOT SAY OTHERWISE, which is fine for the career
 * totals — a player with no `kills` attribute really has killed nobody — and is
 * wrong for one match. `#7 · 0 kills` is a sentence about a match that was
 * played; a `match#…` row written by a build of the game that did not record
 * kills would say exactly the same thing and be inventing it. Null lets the
 * renderer drop that part of the line instead.
 */
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * One `match#…` row, projected to what a history line is made of.
 *
 * NOT A TRANSCRIPTION OF `GameMatch` IN lib/gameProfile.ts, AND THAT IS WHY THE
 * FIELDS ARE NAMED DIFFERENTLY. The console's page renders twelve fields off one
 * of these rows — the mode, how many were in the match, XP, volts, whether it
 * was won; a Discord embed shows one LINE per match beside four other fields, so
 * what it can carry is when, where they finished and how many they killed.
 * Transcribing the other eight would be eight more chances to drift for a repo
 * that never reads them.
 *
 * EVERY FIELD BUT THE SORT KEY IS NULLABLE. These rows come out of br_ddb, in
 * Lua, in another repo, and nothing in THIS repo has ever read one — so a field
 * arriving missing or renamed should cost that field and not the line. `sk` is
 * the one thing a row certainly has, because the query selects on it.
 */
export interface GameMatch {
  /** The row's sort key, `match#<endedAt>#<matchId>`. */
  sk: string
  /** When it was played, ms. From `endedAt`, which is also the key's first part. */
  at: number | null
  /** Where they finished. */
  placement: number | null
  kills: number | null
}

/**
 * The sort-key prefix the match rows share, and the whole reason this is a Query
 * rather than a Scan. Same literal as `MATCH_PREFIX` in the console's
 * lib/gameProfile.ts.
 */
const MATCH_PREFIX = 'match#'

/**
 * How many match rows one Query may ask for, whatever the caller says.
 *
 * A CEILING ON A ROW COUNT SOMEBODY ELSE PICKS. The limit is a parameter because
 * the caller knows how many it can render — `/profile` asks for 25 — and a
 * parameter with no ceiling is one bad call away from paging a player with two
 * thousand matches into a two-second deadline. Fifty is the console's own
 * default for the same read (lib/gameProfile.ts) and is already more than twice
 * what anything here displays.
 *
 * IT IS A `Limit`, WHICH IS ROWS READ AND NOT ROWS MATCHED. DynamoDB stops at
 * that many items and answers; there is no pagination here and none is wanted,
 * because "the most recent N" is the whole question.
 */
const MATCH_LIMIT_CAP = 50

/** From lib/maintenance.ts. */
export type MaintenanceState = 'scheduled' | 'draining' | 'deploying' | 'complete' | 'cancelled'

/** From lib/maintenance.ts. */
export type DeployMode = 'when-empty' | 'at-time'

/**
 * From lib/maintenance.ts, SUBSET.
 *
 * The console's row carries another twenty fields about the deploy itself —
 * which ref, which sha, how far behind main, who forced it. Those are the
 * console's own workflow; what the bot needs is whether the server is going
 * down, when, and what to tell somebody who asks why they cannot connect.
 */
export interface MaintenanceWindow {
  id: string
  state: MaintenanceState
  createdAt: number
  createdByName: string
  /** Shown to players refused at the door while draining. */
  note: string
  /** When refusing new connections begins. */
  drainStartsAt: number
  deployMode: DeployMode
  /** Only for `at-time`. Absolute. */
  deployAt: number | null
  completedAt?: number | null
  cancelledAt?: number | null
}

/**
 * States in which the window still governs the server's behaviour.
 *
 * A COPY, like `isBanActive`, of `isLive` in lib/maintenance.ts. Same reason:
 * `state === 'scheduled'` written out at a call site is the version that gets
 * one of the three states wrong.
 */
export function isMaintenanceLive(w: MaintenanceWindow | null): w is MaintenanceWindow {
  if (!w) return false
  return w.state === 'scheduled' || w.state === 'draining' || w.state === 'deploying'
}

/**
 * Is the server refusing connections right now?
 *
 * A copy of `isDraining` in lib/maintenance.ts, including the part that makes
 * it worth copying: the answer is DERIVED FROM THE CLOCK rather than read off
 * the stored state, so a console that was asleep when `drainStartsAt` passed
 * does not leave the bot telling people the server is still open.
 */
export function isMaintenanceDraining(
  w: MaintenanceWindow | null,
  now = Date.now(),
): w is MaintenanceWindow {
  if (!isMaintenanceLive(w)) return false
  if (w.state === 'deploying') return true
  return now >= w.drainStartsAt
}

/**
 * The bot's own durable state. The only table here the console does not own.
 *
 * WHAT IT IS FOR: the handful of things the bot has to remember across a
 * restart and currently keeps in files under `/var/lib/blitz-bot` — the commit
 * it last announced, the id of the message holding its manual. Those survive a
 * restart today and do not survive the box, which is fine until the day
 * something is restored from an image and the bot re-announces a deploy from
 * three weeks ago.
 *
 * THE VALUE IS A STRING AND THAT IS ON PURPOSE. Every one of those is an
 * identifier — a sha, a snowflake — and identifiers are strings. A
 * `Record<string, unknown>` here would be a schema nobody declared, arriving
 * back from the table in whatever shape a previous version of the bot happened
 * to write; a caller that wants structure can stringify it and own the parse,
 * which at least puts the parse somewhere a type can watch it.
 */
export interface BotStateRow {
  /** Partition key. */
  key: string
  value: string
  /** Stamped by this module, so no caller has to remember to. */
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 * The audit log.
 * ------------------------------------------------------------------ */

/**
 * From lib/audit.ts, verbatim.
 *
 * THE SAME VOCABULARY AS THE CONSOLE, NOT A VOCABULARY OF OUR OWN. These rows
 * land in one table that the console's `/audit` page renders, and a verb only
 * this bot spells would render as an unknown action in the one view a
 * moderator actually reads. A new verb is therefore a change in both repos,
 * and this list is the copy that has to be kept honest.
 */
export type AuditAction =
  | 'ban.issue'
  | 'ban.lift'
  | 'player.kick'
  | 'player.spectate'
  | 'maintenance.schedule'
  | 'maintenance.cancel'
  | 'maintenance.drain'
  | 'maintenance.deploy'
  | 'incident.resolve'
  | 'discord.revoked'
  | 'discord.unresolved'

export type AuditOutcome = 'pending' | 'ok' | 'failed'

/** From lib/audit.ts, whole — the bot writes these rows, so nothing is dropped. */
export interface AuditRow {
  /** Partition key. One literal string: the whole log is one partition. */
  pk: string
  /** Sort key: milliseconds since epoch. */
  ts: number
  /** Joins the intent row to the outcome that arrives later. */
  commandId: string
  action: AuditAction
  outcome: AuditOutcome
  /** The acting admin. License is the identity every other table keys on. */
  actorLicense: string | null
  actorName: string
  actorDiscordId: string | null
  targetLicense?: string | null
  targetName?: string | null
  /** Free text supplied by the admin. Never interpolated. */
  reason?: string | null
  /** Set when the outcome lands. */
  resolvedAt?: number
  /** Why it failed. Operator-facing, not a stack trace. */
  error?: string | null
  /** Anything action-specific worth keeping. Small, and never secrets. */
  detail?: Record<string, string | number | boolean | null>
}

/** From lib/audit.ts. */
export interface Actor {
  license: string | null
  name: string
  discordId: string | null
}

/**
 * The handle to an open intent row.
 *
 * BOTH HALVES OF THE PRIMARY KEY PLUS THE ID, and the id is not decoration —
 * `resolve` conditions on it. See `begin`.
 */
export interface AuditHandle {
  commandId: string
  ts: number
}

export interface AuditInput {
  action: AuditAction
  actor: Actor
  targetLicense?: string | null
  targetName?: string | null
  reason?: string | null
  detail?: AuditRow['detail']
}

/**
 * The audit log's single partition key. From lib/audit.ts.
 *
 * A DEFAULT AND NO LONGER A BAKED-IN LITERAL, BECAUSE THE CONSOLE HAS WRITTEN
 * DOWN THAT IT WILL MOVE. `fivem-ringmaster/src/lib/audit.ts` says the whole log
 * lives in one partition today and that the answer to that partition growing is
 * `AUDIT#<yyyy-mm>` — a key derived from the clock, one partition per month.
 *
 * THE FAILURE THAT WOULD CAUSE IS SILENT AND IS THE WHOLE REASON THIS IS AN
 * OPTION. A writer pointed at the old key keeps working (it creates the old
 * partition again), and a READER pointed at it returns zero rows, forever,
 * without an error of any kind — which is exactly what src/banrole.ts's poller
 * consumes. "No new bans" and "the log moved out from under me" are the same
 * empty page. src/banrole.ts closes that with a probe (see `PARTITION_SILENCE_MS`
 * there); this constant is the other half, so that following the migration is one
 * edit in one file rather than four literals in three functions.
 *
 * DELIBERATELY NOT AN ENVIRONMENT VARIABLE, and that is not an oversight. The
 * shape the console describes is derived from the current month, so a value
 * pasted into a dotenv file would be correct until the first of the following
 * month and then wrong in exactly the silent way above. When the migration lands
 * the right change here is a function of the clock, not a string an operator
 * maintains. The option exists so there is one place to write that function, and
 * so a test can drive a moved partition today.
 */
const AUDIT_PK = 'AUDIT'

/**
 * How many audit rows one `since` may return, whatever the caller asks for.
 *
 * A CEILING ON A NUMBER SOMEBODY ELSE PICKS, exactly as `MATCH_LIMIT_CAP` is. The
 * caller decides how much work it can do in a pass; this decides how much the bot
 * will ever pull out of the log in one round trip. A poller that fell behind
 * would otherwise ask for its whole backlog at once and spend the deadline on a
 * page it cannot process anyway — the pass is bounded, so the query has to be.
 */
const AUDIT_QUERY_CAP = 200

/* ------------------------------------------------------------------ */

/**
 * Everything the bot may ask of DynamoDB. Nothing else is reachable.
 *
 * THE SHAPE OF THIS INTERFACE IS THE ACCESS POLICY, written a second time in a
 * place a compiler reads. Four tables offer a read and nothing else; three
 * offer a write. There is still no `players.write` and no
 * `maintenance.schedule` — the console owns those actions and owns the
 * consequences of getting them wrong.
 *
 * `bans.issue` AND `bans.lift` ARE NEW, AND THIS COMMENT USED TO SAY THEY
 * WOULD NEVER BE HERE. The reason it gave was that a Discord bot able to ban
 * somebody would be a second, less careful implementation of the console's
 * most dangerous path, and it added: "when the bot genuinely needs one, it
 * goes here with the reason attached." blitz-bot#16 is that need — moderation
 * from Discord is the point of the bot — so here is the reason, attached.
 *
 * IT IS NOT A COPY OF THE CONSOLE'S WRITE and must not become one. The
 * console's is an unconditional overwrite that would un-lift a lifted ban on a
 * repeated event; this one reads first, refuses when an active ban already
 * stands, and remembers which Discord event produced which row. All of that is
 * in `bans.issue` below, which is the most careful function in this file
 * because it is the most dangerous one.
 *
 * WHAT STILL LIVES ONLY IN THE CONSOLE, so this is a narrower path rather than
 * a second copy of the same one: the duration-to-expiry conversion, the
 * refusal to ban on an already-resolved incident, the immediate kick of
 * somebody mid-match, the incident verdict and the permanent-ban sweep of
 * their other open cases (see the console's `src/app/api/bans/route.ts`). This
 * module writes the ROW. Everything a ban does BESIDES the row is still the
 * console's, and a caller that needs those needs the console.
 */
export interface Ddb {
  /** The settled settings, so a caller can log what it is actually pointed at. */
  readonly region: string
  readonly tables: TableNames
  readonly timeoutMs: number

  bans: {
    /**
     * The ban row for a qualified identifier — lifted and expired ones
     * included, like the console's `banFor`. Ask `isBanActive` whether it is
     * in force; this answers whether it exists.
     */
    get(id: string): Promise<DdbResult<Ban | null>>

    /** Write a ban, unless one already stands or this event already wrote one. */
    issue(input: BanIssueInput): Promise<DdbResult<BanIssueResult>>

    /** Stamp the lifted fields onto a ban. Never deletes; nothing here can. */
    lift(input: BanLiftInput): Promise<DdbResult<BanLiftResult>>
  }

  players: {
    get(license: string): Promise<DdbResult<PlayerRecord | null>>
  }

  playerIds: {
    /** Which licenses have presented this identifier? Qualify it with `qualifyId`. */
    licensesFor(qualifiedId: string): Promise<DdbResult<string[]>>
  }

  gamePlayers: {
    /** The game's career row. `null` means never played, not zeroed. */
    profile(license: string): Promise<DdbResult<GameProfile | null>>

    /**
     * The player's most recent matches, newest first, at most `MATCH_LIMIT_CAP`.
     *
     * AN EMPTY LIST IS AN ANSWER AND NOT AN ABSENCE, and the caller has to keep
     * the two apart: `{ ok: true, value: [] }` means the query ran and this
     * player has no per-match rows — they have never played, or every match they
     * played predates the game recording them individually and is only in the
     * career totals. A read that FAILED is `{ ok: false }` and must never be
     * shown as "no matches". The console's `gameMatchesFor` draws the same line.
     */
    matches(license: string, limit?: number): Promise<DdbResult<GameMatch[]>>
  }

  maintenance: {
    current(): Promise<DdbResult<MaintenanceWindow | null>>
  }

  audit: {
    begin(input: AuditInput): Promise<DdbResult<AuditHandle>>
    resolve(
      handle: AuditHandle,
      outcome: Exclude<AuditOutcome, 'pending'>,
      error?: string | null,
    ): Promise<DdbResult<void>>
    /** The most recent actions, newest first. Everyone's, not just the bot's. */
    recent(limit?: number): Promise<DdbResult<AuditRow[]>>
  }

  botState: {
    get(key: string): Promise<DdbResult<BotStateRow | null>>
    put(key: string, value: string): Promise<DdbResult<BotStateRow>>
  }
}

/**
 * Reading the audit log as a STREAM rather than as a page.
 *
 * A CAPABILITY OF ITS OWN AND NOT THREE MORE MEMBERS ON `Ddb.audit`, which is
 * the same argument the `Pick<Ddb, …>` at every call site makes, one level up.
 * `Ddb`'s own comment says its shape IS the access policy: everything on it is
 * offered to every caller that holds one. `begin` and `resolve` are how an
 * action gets recorded and `recent` is how a page of the log is rendered; this
 * is how a background process CONSUMES the log, which is a different job with a
 * different hazard — a poller that silently reads nothing forever — and exactly
 * one consumer (src/banrole.ts). Keeping it separate means the module that polls
 * cannot write an audit row, and the modules that write one cannot poll.
 *
 * THE PARTITION IS PART OF THE CAPABILITY, not a setting beside it, because a
 * consumer that comes back empty has to be able to say WHICH partition it found
 * nothing in — and, on the day the console splits the log by month, whether the
 * one it is reading is still the one being written. See `AUDIT_PK`.
 */
export interface AuditWindow {
  /** The partition every audit read and write in this module addresses. */
  readonly partition: string

  /**
   * Rows in a closed window of the sort key, OLDEST FIRST.
   *
   * A WINDOW AND NOT AN OPEN-ENDED "EVERYTHING AFTER", which is the shape a
   * cursor-driven poll actually needs and the reason this is not `recent`
   * reversed. `after` is exclusive and `until` is inclusive, so consecutive
   * passes over `(cursor, until]` see every row exactly once and never twice:
   * `ts` is half the primary key, so no two rows in one partition share one.
   *
   * `until` IS WHAT LETS A CALLER REFUSE TO READ ITS OWN TAIL. An audit row is
   * written BEFORE the action it describes (see `begin`), so the newest rows in
   * this table are intents whose consequences have not landed in any other table
   * yet. A reader that treats such a row as a trigger to go and look at
   * `ringmaster-bans` has to hold back far enough that the ban row is there to
   * find; that hold-back is the caller's policy and this parameter is how it
   * expresses it. See `SETTLE_MS` in src/banrole.ts.
   *
   * OLDEST FIRST, UNLIKE `recent`, because a cursor can only be advanced over
   * rows that have been dealt with in order. Newest-first would mean holding the
   * whole page to work out where to resume.
   *
   * AN EMPTY ANSWER IS AN ANSWER AND NOT AN ABSENCE, and here that distinction
   * has teeth: an empty page is also what a reader pointed at a partition that
   * has MOVED gets, forever and without an error. `newest` is what tells the two
   * apart.
   */
  since(after: number, until: number, limit?: number): Promise<DdbResult<AuditRow[]>>

  /**
   * The newest row in the partition, or null when the partition holds nothing.
   *
   * THE MIGRATION PROBE, AND IT IS THE ONLY QUESTION THAT SEPARATES A QUIET LOG
   * FROM A LOST ONE. `since` returning nothing means either "nobody has done
   * anything" or "this partition is not where the log is any more", and those
   * two need opposite responses from an operator. A partition that has never
   * held a single row, on a system that has been moderating for months, is the
   * second one. See `AUDIT_PK`.
   */
  newest(): Promise<DdbResult<AuditRow | null>>
}

/**
 * What `createDdb` actually returns: a `Ddb`, plus the audit stream.
 *
 * AN EXTENSION RATHER THAN A WIDER `Ddb`, so that everything already written
 * against `Ddb` — including the hand-built fakes that deliberately implement it
 * whole — keeps compiling and keeps meaning what it meant. A caller that wants
 * the stream asks for this type or for a `Pick` of it; every other caller goes on
 * taking the narrowest thing it needs.
 */
export interface DdbWithAuditWindow extends Ddb {
  readonly auditWindow: AuditWindow
}

export function createDdb(options: DdbOptions = {}): DdbWithAuditWindow {
  const region = options.region ?? DEFAULT_REGION
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX
  const gamePrefix = options.gameTablePrefix ?? DEFAULT_GAME_TABLE_PREFIX
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const tables = tableNames(prefix, gamePrefix)
  const auditPk = options.auditPartition ?? AUDIT_PK

  // Eagerly, unlike the console's lazy proxy: constructing a client opens no
  // socket and resolves no credentials, and this factory is called once from
  // the entrypoint rather than from module scope during a build.
  const doc = options.document ?? createDocument(region)

  /**
   * One call, with a deadline on it.
   *
   * TWO MECHANISMS FOR ONE DEADLINE, AND BOTH ARE NECESSARY. The abort signal
   * is what tells the SDK to give up — it stops the retries and releases the
   * socket, so a slow table does not leave a connection pinned for a minute
   * after nobody is waiting for it. But an abort only cancels what is
   * listening for it, and the parts of a first-ever AWS call most likely to
   * hang are the ones before the request exists: a credential provider talking
   * to instance metadata that a broken security group is swallowing. So the
   * race against the clock is the actual guarantee, and the signal is the
   * tidying up.
   *
   * THE LOSING PROMISE IS NOT ORPHANED. Its rejection handler is attached
   * before the race, not after, so an SDK call that fails ten seconds after we
   * stopped caring is a dropped value rather than an unhandled rejection —
   * which index.ts would otherwise log as a fault about an operation nobody
   * can place.
   */
  async function call<T>(
    op: DdbOp,
    table: string,
    run: (options: RequestOptions) => Promise<T>,
  ): Promise<DdbResult<T>> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const deadline = new Promise<'timeout'>((settle) => {
      timer = setTimeout(() => {
        controller.abort()
        settle('timeout')
      }, timeoutMs)
    })

    // An async wrapper rather than a bare call, so a fake — or an SDK argument
    // check — that throws synchronously becomes a rejection this can classify
    // instead of an exception thrown past the deadline entirely.
    const attempt = (async () => run({ abortSignal: controller.signal }))().then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )

    try {
      const settled = await Promise.race([attempt, deadline])

      if (settled === 'timeout') {
        return {
          ok: false,
          failure: { kind: 'timeout', op, table, message: `no answer in ${timeoutMs}ms` },
        }
      }

      if (settled.kind === 'error') return { ok: false, failure: classify(settled.error, op, table) }
      return { ok: true, value: settled.value }
    } finally {
      // Or a process that answered in two milliseconds keeps an event-loop
      // handle alive for the rest of the budget.
      clearTimeout(timer)
    }
  }

  /**
   * The last audit sort key this process handed out.
   *
   * The console keeps the same counter for the same reason — `pk` + `ts` is
   * the whole primary key, so two rows in one millisecond are one row. See
   * `begin` for the half of the problem the counter cannot solve.
   */
  let lastTs = 0

  function nextTs(): number {
    const at = now()
    lastTs = at > lastTs ? at : lastTs + 1
    return lastTs
  }

  /**
   * The ban row for a qualified identifier, or null.
   *
   * A NAMED FUNCTION RATHER THAN A METHOD, because `bans.issue` and
   * `bans.lift` both begin by reading the row they are about to change and
   * must read it the same way `bans.get` does — a second spelling of this
   * `Key` is a second chance to key it wrong, and a `GetItem` with the wrong
   * key shape answers "no row" rather than failing.
   */
  function readBan(id: string): Promise<DdbResult<Ban | null>> {
    return call('get', tables.bans, async (o) => {
      const res = await doc.get({ TableName: tables.bans, Key: { license: id } }, o)
      return (res.Item as Ban | undefined) ?? null
    })
  }

  return {
    region,
    tables,
    timeoutMs,

    bans: {
      get: readBan,

      /**
       * Issue a ban.
       *
       * NOT A COPY OF THE CONSOLE'S, AND THAT IS THE WHOLE FUNCTION.
       * `bans.issue` in fivem-ringmaster/src/lib/bans.ts is an unconditional
       * `PutItem` of a complete row, including `liftedAt: null`. For the
       * console that is correct and its comment says why: a human clicked once,
       * and re-banning somebody previously banned and lifted SHOULD replace the
       * record — the write that clears `liftedAt` is the same write that puts
       * them back under a ban.
       *
       * THE BOT DOES NOT GET TO ASSUME "ONCE". It writes from Discord events,
       * and a gateway reconnect can redeliver one. The same unconditional put,
       * on the second delivery, would replace a row an admin had DELIBERATELY
       * LIFTED in between — putting somebody back under a ban nobody re-issued,
       * erasing who let them back in, and reporting exactly the same success as
       * a write that created a row, because a `PutItem` that overwrites is
       * indistinguishable from one that does not. A bot must never un-lift a
       * ban. Everything below is that sentence.
       *
       * IT READS FIRST, AND THE READ IS NOT AN EXTRA ROUND TRIP BOUGHT FOR THE
       * GUARD. The answer is needed anyway: "there is already an active ban"
       * has to name the ban that stands, and the idempotency key lives on the
       * row. One `GetItem` serves all three purposes.
       *
       * IT IS STILL TWO ROUND TRIPS, AND `timeoutMs` IS PER CALL, so a ban
       * write can spend twice the deadline before it gives up — more than the
       * three seconds Discord allows an un-deferred interaction. A caller must
       * have deferred before it gets here. That is not new: a ban is
       * `audit.begin`, then this, then `audit.resolve`, and no per-call ceiling
       * has ever added up to a command budget.
       *
       * THEN THE EVENT ID, BEFORE ANYTHING ELSE. If the row already carries
       * this Discord audit log entry id, this event has been acted on and
       * nothing is written — WHATEVER STATE THE ROW IS IN NOW. That ordering is
       * load-bearing: a replay arriving after an admin lifted the ban finds a
       * lifted row, and a check that asked "are they banned" would answer no
       * and re-ban them. Asking "have I done this" answers yes, and the lift
       * stands.
       *
       * WHY THE EVENT ID IS THE BETTER KEY, and why both checks are kept. "Is
       * this person banned" is a fact about the world that an admin may
       * legitimately change; "have I already acted on event 1234" is a fact
       * about this bot that nothing can change, and it survives a restart and a
       * redelivery alike. It also records WHICH event produced the row, so
       * "why is this person banned" has an answer that is not a guess. It does
       * not replace the active check — that one catches a DIFFERENT event about
       * somebody already banned, which the event id cannot see.
       *
       * WHERE THE LOOKUP LIVES: ON THE ROW, FOUND BY THE KEY WE ARE WRITING.
       * The table is keyed on the identifier and not on the entry id, so there
       * is no way to ask "which row came from event 1234" — but there is no
       * need to, because we already know which row we are about to write and
       * the question is only ever about that one. The effective key is
       * (identifier, entry id), which is also the right grain: one event that
       * bans a Discord account AND a license writes two rows, and those are two
       * independent decisions that can succeed and fail separately.
       *
       * WHAT THAT COSTS, PLAINLY. The memory lives on the row, so it lasts
       * exactly as long as the row does. A full-row overwrite — the console
       * re-banning, or this function issuing a later ban — replaces the
       * attribute, and a replay arriving after that looks like a new event.
       * Replays arrive seconds after the original and overwrites are human
       * paced, so in practice the key is there when it matters; but it is a
       * bounded memory and not a ledger, and it should not be described as one.
       *
       * THE TWO WAYS TO MAKE IT A LEDGER, NOT TAKEN, so the next person does
       * not have to rediscover the choice. A GSI on `discordEntryId` would let
       * the bot ask the question directly — but it is an index on a table
       * another repo owns, that the bot's role cannot create, for a lookup we
       * do not actually need. A claim row per entry id in `ringmaster-bot-state`
       * (the bot's own table, already keyed on a string) would genuinely
       * outlive the ban row — but it is a second write that fails on its own,
       * leaving either a claim with no ban or a ban with no claim, and it needs
       * an expiry story of its own. Both are more machinery than the failure
       * they close.
       *
       * THE WRITE IS GUARDED ON THE ROW WE READ. `at = :seenAt` says "only if
       * this is still the row I looked at" — an optimistic check on a value we
       * actually saw, rather than a condition expression trying to re-derive
       * `isBanActive` in DynamoDB's expression language, which is where the
       * console's rule and the bot's would quietly stop agreeing. Anything that
       * lands in the gap — a console re-ban, a second bot process, a lift —
       * changes or creates the row, the condition fails, and the caller gets a
       * `conflict` with NOTHING WRITTEN. That is the right end: somebody else
       * got there first, and the honest answer is to look again rather than to
       * overwrite whatever they did.
       *
       * `attribute_not_exists(license)` IS THE SAME GUARD FOR THE OTHER CASE.
       * We read no row, so the row we are guarding against is the one that
       * appeared since; "create, do not replace" says exactly that.
       *
       * A `discord:…` KEY IS A REAL ROW AND A PARTIAL ENFORCEMENT, and this is
       * the one caveat a caller must not be allowed to miss. The table is
       * keyed on a qualified identifier, so banning a Discord account with no
       * player record is `qualifyId('discord', id)` and the row is written,
       * listed by the console's moderation page and kept forever like any
       * other. But THE CONNECT GATE ASKS ONE QUESTION AND IT IS ABOUT THE
       * LICENSE: `br_ddb` does a single `GetItem` on the connecting player's
       * license (fivem-ringmaster/docs/aws-setup.md §"the reads it needs"), so
       * a `discord:`-keyed row does not stop anybody joining. It is a RECORD of
       * a decision, not a door. Two further points against ever "fixing" that
       * by widening the gate: FiveM only reports a `discord:` identifier when
       * the player has Discord's activity integration switched on, which is
       * opt-in and therefore evadable by switching it off (aws-setup.md says so
       * about the grants table); and the console's profile link on that row
       * points at `/players/discord:280…`, which resolves to nothing. Pass a
       * `playerName` so the ban list reads as something rather than as a
       * snowflake.
       */
      async issue(input) {
        const seen = await readBan(input.id)
        if (!seen.ok) return seen

        const existing = seen.value

        if (existing && existing.discordEntryId === input.entryId) {
          return { ok: true, value: { outcome: 'duplicate-event', ban: existing } }
        }

        // `isBanActive`, the rule copied from the console, rather than an
        // `if` written out here — see the comment on that function.
        if (existing && isBanActive(existing, now())) {
          return { ok: true, value: { outcome: 'already-banned', ban: existing } }
        }

        // Every field the console writes, including its explicit nulls — and
        // the reason for those is not what it looks like. A `PutItem` replaces
        // the WHOLE item, so a re-ban over a lifted row drops the lift fields
        // whether or not they are named here; the row would be in force again
        // either way. What the nulls buy is a row indistinguishable from one
        // the console wrote, which is what lets a condition expression be
        // written once and hold for both writers — see the two spellings of
        // "not lifted" that `lift` below has to allow for, precisely because
        // rows exist that predate this.
        const ban: Ban = {
          license: input.id,
          at: now(),
          by: input.by,
          byName: input.byName,
          reason: input.reason,
          expiresAt: input.expiresAt,
          playerName: input.playerName ?? null,
          liftedAt: null,
          liftedBy: null,
          liftedByName: null,
          liftReason: null,
          discordEntryId: input.entryId,
        }

        const guard: Pick<PutCommandInput, 'ConditionExpression' | 'ExpressionAttributeValues'> =
          existing
            ? {
                ConditionExpression: 'at = :seenAt',
                ExpressionAttributeValues: { ':seenAt': existing.at },
              }
            : { ConditionExpression: 'attribute_not_exists(license)' }

        const written = await call('put', tables.bans, async (o) => {
          await doc.put({ TableName: tables.bans, Item: ban, ...guard }, o)
        })

        if (!written.ok) return written
        return { ok: true, value: { outcome: 'issued', ban } }
      },

      /**
       * Lift a ban, keeping the row.
       *
       * AN UPDATE AND NEVER A DELETE, and this module could not delete one if
       * it wanted to: `DocumentClient` above has no `delete`, deliberately. The
       * rule is lib/bans.ts's own — a ban is a record — and the fields this
       * stamps are the answer to "who let them back in", which is the half of
       * the record a deletion throws away.
       *
       * IT READS FIRST, LIKE `issue`, AND FOR THE SAME KIND OF REASON: an
       * unban event can be redelivered too. A row that is ALREADY lifted is
       * left completely alone — writing the lift again would replace the
       * original lifter's name and time with this one's, which is the same
       * class of erasure as un-lifting a ban, just quieter. `already-lifted`
       * returns the row with the FIRST lifter still on it.
       *
       * `attribute_exists(license)` IS THE CONSOLE'S CONDITION AND IS KEPT
       * VERBATIM, because `UpdateItem` against a missing key CREATES it: a lift
       * of a ban nobody issued would otherwise write a row carrying lift fields
       * and no ban, which reads forever after as though somebody had been
       * banned. The read above already answers `no-ban` for that case; the
       * condition is what covers the row being removed between the two.
       *
       * THE SECOND HALF OF THE CONDITION IS THE ONE THE CONSOLE DOES NOT HAVE.
       * `attribute_not_exists(liftedAt) OR liftedAt = :unlifted` is "still not
       * lifted", and it needs both spellings because there are two: the console
       * writes `liftedAt: null` explicitly on every ban it issues, so the
       * attribute EXISTS as a null on those rows, while an older or
       * hand-written row may not have it at all. A condition that tested only
       * `attribute_not_exists` would refuse to lift any ban the console ever
       * issued. It closes the gap between our read and our write: a lift that
       * lands in it wins, and ours comes back a `conflict` with nothing
       * written.
       *
       * WHAT THIS DOES NOT COVER, SAID PLAINLY BECAUSE IT IS STILL TRUE. There
       * is no event id on the lift, so the one replay it cannot catch is an
       * unban redelivered AFTER somebody re-banned the same person: the row is
       * active again, `already-lifted` does not fire, and the replay lifts a
       * ban it was never about. It needs a re-ban inside the seconds-wide
       * redelivery window to happen at all. Closing it means a second entry-id
       * attribute for the lift — with the same bounded memory `issue` describes,
       * since a re-ban overwrites the whole row anyway — and that is the change
       * to make if it is ever observed rather than reasoned about.
       */
      async lift(input) {
        const seen = await readBan(input.id)
        if (!seen.ok) return seen

        const existing = seen.value
        if (!existing) return { ok: true, value: { outcome: 'no-ban', ban: null } }

        if (existing.liftedAt) {
          return { ok: true, value: { outcome: 'already-lifted', ban: existing } }
        }

        const liftedAt = now()
        const liftReason = input.reason ?? null

        const written = await call('update', tables.bans, async (o) => {
          await doc.update(
            {
              TableName: tables.bans,
              Key: { license: input.id },
              ConditionExpression:
                'attribute_exists(license) AND (attribute_not_exists(liftedAt) OR liftedAt = :unlifted)',
              // The console's four fields, in the console's order. A lift that
              // set fewer of them would leave the previous lift's reason
              // attached to this one.
              UpdateExpression:
                'SET liftedAt = :t, liftedBy = :b, liftedByName = :n, liftReason = :r',
              ExpressionAttributeValues: {
                ':unlifted': null,
                ':t': liftedAt,
                ':b': input.by,
                ':n': input.byName,
                ':r': liftReason,
              },
            },
            o,
          )
        })

        if (!written.ok) return written

        // The row as it now stands, assembled rather than read back: a second
        // GetItem would cost another round trip out of the same deadline to
        // learn four values we just wrote.
        return {
          ok: true,
          value: {
            outcome: 'lifted',
            ban: {
              ...existing,
              liftedAt,
              liftedBy: input.by,
              liftedByName: input.byName,
              liftReason,
            },
          },
        }
      },
    },

    players: {
      get(license) {
        return call('get', tables.players, async (o) => {
          const res = await doc.get({ TableName: tables.players, Key: { license } }, o)
          return (res.Item as PlayerRecord | undefined) ?? null
        })
      },
    },

    playerIds: {
      licensesFor(qualifiedId) {
        return call('get', tables.playerIds, async (o) => {
          const res = await doc.get({ TableName: tables.playerIds, Key: { id: qualifiedId } }, o)
          return (res.Item as IdentifierIndexRow | undefined)?.licenses ?? []
        })
      },
    },

    gamePlayers: {
      profile(license) {
        return call('get', tables.gamePlayers, async (o) => {
          /**
           * A COMPOSITE KEY, UNLIKE EVERY OTHER READ HERE. The game hangs
           * several rows off one partition — `profile`, `purchases`, and one
           * `match#…` per match — so the key is `{pk: license, sk: 'profile'}`.
           * Getting it wrong returns no row rather than an error, which reads
           * as "this player has never played".
           */
          const res = await doc.get(
            { TableName: tables.gamePlayers, Key: { pk: license, sk: 'profile' } },
            o,
          )

          const row = res.Item as Record<string, unknown> | undefined
          if (!row) return null

          return {
            matches: num(row.matches),
            wins: num(row.wins),
            top10s: num(row.top10s),
            kills: num(row.kills),
            deaths: num(row.deaths),
            downs: num(row.downs),
            revives: num(row.revives),
            damageDealt: num(row.damageDealt),
            playtimeSec: num(row.playtimeSec),
            soloMatches: num(row.soloMatches),
            squadMatches: num(row.squadMatches),
            xp: num(row.xp),
            // The game's floor is 1: a level of 0 is an absent field, not a
            // player below the first level.
            level: num(row.level) || 1,
            balance: num(row.balance),
            lastMatchAt: typeof row.lastMatchAt === 'number' ? row.lastMatchAt : null,
          }
        })
      },

      /**
       * The most recent `match#…` rows off the same partition as the profile.
       *
       * A PLAIN QUERY, NO INDEX AND NO SCAN, and the key design is what makes
       * that possible. The game hangs one row per match off the player's own
       * partition with a sort key of `match#<endedAt>#<matchId>`, so walking the
       * sort key BACKWARDS with a `Limit` already is "the most recent N" — the
       * zero-padded timestamp is what makes the lexicographic order the
       * chronological one. `begins_with` is what keeps `profile` and `purchases`
       * out of the answer rather than fetching them and throwing them away.
       * Copied in shape from `gameMatchesFor` in the console's
       * lib/gameProfile.ts, which is the only code that has ever read these rows.
       *
       * IT IS THE ONLY QUERY THIS MODULE MAKES OUTSIDE `ringmaster-audit`, AND
       * IT NEEDS AN ACTION THE POLICY NOTE DOES NOT LIST. The table in
       * docs/aws-notes.md grants `dynamodb:Query` on `ringmaster-audit` and
       * `dynamodb:GetItem` on `br-players`; this call is a Query on `br-players`
       * and belongs in that table when blitz-bot#4 writes the bot's own policy.
       * Until then a role without it answers `denied`, which the caller shows as
       * a named absence rather than as a broken command — and that same note
       * already records `br-players` as denied outright to the role the bot
       * shares today, so `denied` is the expected answer either way.
       *
       * PROJECTED FIELD BY FIELD RATHER THAN CAST, exactly as `profile` above is
       * and for the same reason: another repo, another box, another language
       * writes these. See `GameMatch`.
       */
      matches(license, limit = MATCH_LIMIT_CAP) {
        return call('query', tables.gamePlayers, async (o) => {
          const res = await doc.query(
            {
              TableName: tables.gamePlayers,
              KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
              ExpressionAttributeValues: { ':pk': license, ':sk': MATCH_PREFIX },

              // Backwards along the sort key, which is how "the latest" comes
              // out of DynamoDB without sorting client-side.
              ScanIndexForward: false,

              // Clamped rather than trusted: the caller decides how many it can
              // render, this decides how many the bot will ever ask for. A
              // caller asking for none gets one row rather than DynamoDB's own
              // reading of `Limit: 0`.
              Limit: Math.max(1, Math.min(Math.floor(limit), MATCH_LIMIT_CAP)),
            },
            o,
          )

          const rows = (res.Items ?? []) as Record<string, unknown>[]

          return rows.map((row) => ({
            sk: typeof row.sk === 'string' ? row.sk : '',
            at: numOrNull(row.endedAt),
            placement: numOrNull(row.placement),
            kills: numOrNull(row.kills),
          }))
        })
      },
    },

    maintenance: {
      current() {
        return call('get', tables.maintenance, async (o) => {
          // One row, fixed key. From lib/maintenance.ts, where the key is the
          // literal string `current`.
          const res = await doc.get({ TableName: tables.maintenance, Key: { id: 'current' } }, o)
          return (res.Item as MaintenanceWindow | undefined) ?? null
        })
      },
    },

    audit: {
      /**
       * Record the intent to do something. Returns the handle `resolve` needs.
       *
       * CALLED BEFORE THE ACTION, ALWAYS, and the console's rule travels with
       * the shape: if this comes back a failure, the action must not proceed.
       * An unlogged admin action is the thing this table exists to make
       * impossible, so a failure to record is a failure to act. That is why it
       * is a result the caller has to unwrap rather than a fire-and-forget.
       *
       * THE BOT IS THE SECOND WRITER TO THIS PARTITION, AND THAT IS THE WHOLE
       * REASON THIS FUNCTION IS NOT A COPY OF THE CONSOLE'S.
       *
       * Every row in `ringmaster-audit` is `pk = 'AUDIT'` with a millisecond
       * `ts` as its sort key, so those two together are the entire primary key
       * and a `PutItem` at a key that already exists REPLACES the row that was
       * there. Silently. On an append-only log whose whole job is that a
       * record cannot go missing. The console keeps a per-process counter
       * (`nextTs`, which this file also has) that pushes a same-millisecond
       * write forward by one, and its own comment is explicit that this can
       * only ever cover one process — "two consoles writing in the same
       * millisecond still collide". The bot is not a second console but it is
       * a second process, and it writes to that partition from a box the
       * console is also running on. Two writers, one millisecond, and the row
       * that loses is gone with nothing logged and nothing to notice.
       *
       * SO THE WRITE IS CONDITIONAL, and that turns the worst outcome into the
       * best available one. `attribute_not_exists(pk)` means "only if there is
       * no item at this exact key" — an item that exists necessarily has its
       * partition key, so this is the standard spelling of "create, do not
       * replace". If somebody is already at this millisecond, DynamoDB refuses
       * the write instead of performing it, `nextTs` steps to the next
       * millisecond, and we try again. The bot therefore CANNOT destroy an
       * audit row: not the console's, and not one of its own.
       *
       * WHAT THIS DOES NOT FIX, STATED PLAINLY BECAUSE IT IS STILL TRUE: the
       * console's own put is unconditional, so a console write landing on a
       * millisecond the bot has already taken still overwrites the bot's row.
       * That direction cannot be closed from this repo. Closing it is one line
       * in fivem-ringmaster/src/lib/audit.ts — the same condition on its put,
       * with its own forward retry — and until somebody makes that change the
       * remaining exposure is bot-row-overwritten-by-console, in the same
       * millisecond, which needs both processes acting at once. `resolve`
       * below detects it after the fact rather than preventing it.
       *
       * THE RETRIES ARE BOUNDED. Four attempts, because the collisions that
       * happen arrive in bursts of two or three (the console closes a player's
       * other cases in a loop after a permanent ban) and not in hundreds; a
       * refusal is a fast round trip, so the retries cost milliseconds rather
       * than a share of the deadline. Exhausting them returns a `conflict`
       * failure, which — per the rule above — stops the action. That is the
       * correct end: something is writing to this partition faster than we can
       * step around it, and acting without a record is not the fallback.
       */
      async begin(input) {
        // Minted once, outside the loop: a retry is the same intended action
        // at a different key, not a different action. The game side echoes
        // this id back, which is what joins the two halves of a command.
        const commandId = randomUUID()

        let last: DdbFailure | null = null

        for (let attempt = 0; attempt < AUDIT_WRITE_ATTEMPTS; attempt++) {
          const ts = nextTs()

          const row: AuditRow = {
            pk: auditPk,
            ts,
            commandId,
            action: input.action,
            outcome: 'pending',
            actorLicense: input.actor.license,
            actorName: input.actor.name,
            actorDiscordId: input.actor.discordId,
            targetLicense: input.targetLicense ?? null,
            targetName: input.targetName ?? null,
            reason: input.reason ?? null,
            detail: input.detail,
          }

          const written = await call('put', tables.audit, (o) =>
            doc.put(
              {
                TableName: tables.audit,
                Item: row,
                ConditionExpression: 'attribute_not_exists(pk)',
              },
              o,
            ),
          )

          if (written.ok) return { ok: true, value: { commandId, ts } }

          // Anything that is not a taken key — a timeout, a denial, the wrong
          // region — is this call's answer. Retrying it would only spend the
          // deadline on the same failure.
          if (written.failure.kind !== 'conflict') return written

          last = written.failure
        }

        return {
          ok: false,
          failure: last ?? {
            kind: 'conflict',
            op: 'put',
            table: tables.audit,
            message: `no free sort key in ${AUDIT_WRITE_ATTEMPTS} attempts`,
          },
        }
      },

      /**
       * Stamp the outcome onto an intent row.
       *
       * TAKES THE WHOLE HANDLE, NOT JUST THE TIMESTAMP, and the `commandId` on
       * it is load-bearing rather than convenient. `ts` is half the primary
       * key, so an update addressed by it alone lands on whatever row is at
       * that millisecond — and per `begin`, the row at our millisecond is not
       * guaranteed to still be ours: a console write can have replaced it.
       * Stamping `outcome: 'ok'` onto somebody else's audit row would be this
       * module corrupting the log it is trying to keep, which is worse than
       * anything it is protecting against. Conditioning on the id we minted
       * means the update applies to OUR row or to nothing.
       *
       * IT ALSO CLOSES THE UPSERT. An `UpdateItem` against a key that does not
       * exist CREATES it — so a lost intent row would otherwise be replaced by
       * a half-row holding an outcome and no action, which reads as corruption
       * rather than as loss. With the condition, that case comes back as a
       * `conflict` failure, which is the log's own alarm: an intent row went
       * missing, and here is the command id it belonged to.
       *
       * A FAILURE HERE MUST NOT FAIL THE ACTION, which is the console's rule
       * and stays true — but it is enforced by the CALLER, not by swallowing
       * it here. A ban that happened and a bookkeeping write that did not is a
       * row stuck at `pending`, which is an honest record; turning it into an
       * error the admin sees would make them retry an action that already
       * succeeded. So this returns the failure for the caller to log and to
       * ignore, rather than deciding for them the way `console.error` does.
       */
      resolve(handle, outcome, error) {
        return call('update', tables.audit, async (o) => {
          await doc.update(
            {
              TableName: tables.audit,
              Key: { pk: auditPk, ts: handle.ts },
              ConditionExpression: 'commandId = :c',
              // `error` is a DynamoDB reserved word. The console aliases it
              // the same way; without the alias the update is a syntax error
              // at runtime and nowhere earlier.
              UpdateExpression: 'SET outcome = :o, resolvedAt = :r, #e = :e',
              ExpressionAttributeNames: { '#e': 'error' },
              ExpressionAttributeValues: {
                ':c': handle.commandId,
                ':o': outcome,
                ':r': now(),
                ':e': error ?? null,
              },
            },
            o,
          )
        })
      },

      recent(limit = 100) {
        return call('query', tables.audit, async (o) => {
          const res = await doc.query(
            {
              TableName: tables.audit,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': auditPk },
              // Backwards along the sort key, which is how "latest" comes out
              // of DynamoDB without sorting client-side.
              ScanIndexForward: false,
              Limit: limit,
            },
            o,
          )
          return (res.Items ?? []) as AuditRow[]
        })
      },
    },

    auditWindow: {
      partition: auditPk,

      /**
       * A closed window of the sort key, oldest first. See `AuditWindow.since`
       * for what the two bounds are for.
       *
       * `BETWEEN` RATHER THAN `ts > :after`, AND THE `+ 1` IS WHY. DynamoDB's
       * `BETWEEN` is inclusive at both ends and there is no exclusive form, so
       * "strictly after the cursor" has to be spelled as "from the next possible
       * key". `ts` is a whole number of milliseconds everywhere it is written —
       * `nextTs` above returns `Date.now()` or `lastTs + 1`, and the console's
       * counter does the same — so `after + 1` is the next key that CAN exist
       * rather than an approximation of one.
       *
       * AN EMPTY WINDOW IS NOT SENT TO DYNAMODB. A caller whose cursor has caught
       * up asks for `(t, t]`, a range that cannot contain anything; the answer is
       * known here without a round trip, and asking anyway would be a billed read
       * on every idle poll for the life of the process.
       *
       * THE LIMIT IS ROWS READ, NOT ROWS MATCHED, and there is no pagination on
       * purpose. A caller that gets a full page has not seen the whole window — it
       * advances its cursor over what it did see and the next pass continues,
       * which is the same shape as "the most recent N" elsewhere in this file and
       * is what keeps one pass bounded.
       */
      since(after, until, limit = AUDIT_QUERY_CAP) {
        if (until <= after) return Promise.resolve({ ok: true as const, value: [] })

        return call('query', tables.audit, async (o) => {
          const res = await doc.query(
            {
              TableName: tables.audit,
              KeyConditionExpression: 'pk = :pk AND ts BETWEEN :from AND :to',
              ExpressionAttributeValues: { ':pk': auditPk, ':from': after + 1, ':to': until },
              // Forwards, because a cursor is only ever advanced in order.
              ScanIndexForward: true,
              Limit: Math.max(1, Math.min(Math.floor(limit), AUDIT_QUERY_CAP)),
            },
            o,
          )
          return (res.Items ?? []) as AuditRow[]
        })
      },

      /**
       * One row off the end of the partition. See `AuditWindow.newest`.
       *
       * `Limit: 1` AND NOT A COUNT. "Is there anything here" needs one item, and
       * a `Select: COUNT` over a partition with a million rows in it is a scan of
       * the partition dressed up as an aggregate.
       */
      newest() {
        return call('query', tables.audit, async (o) => {
          const res = await doc.query(
            {
              TableName: tables.audit,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': auditPk },
              ScanIndexForward: false,
              Limit: 1,
            },
            o,
          )
          return ((res.Items ?? []) as AuditRow[])[0] ?? null
        })
      },
    },

    botState: {
      get(key) {
        return call('get', tables.botState, async (o) => {
          const res = await doc.get({ TableName: tables.botState, Key: { key } }, o)
          return (res.Item as BotStateRow | undefined) ?? null
        })
      },

      /**
       * Write a value, replacing whatever was there.
       *
       * UNCONDITIONAL, UNLIKE THE AUDIT WRITE, because this table has exactly
       * one writer and its rows are current-value rather than history. "The
       * commit I last announced" has no earlier version worth keeping; the
       * whole point is that the new answer replaces the old one.
       *
       * RETURNS THE ROW IT WROTE so a caller does not have to reconstruct
       * `updatedAt` to know what is now in the table.
       */
      put(key, value) {
        const row: BotStateRow = { key, value, updatedAt: now() }

        return call('put', tables.botState, async (o) => {
          await doc.put({ TableName: tables.botState, Item: row }, o)
          return row
        })
      },
    },
  }
}
