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
 * DynamoDB: the tables the bot reads, and the two it writes.
 *
 * THIS IS THE FIRST AWS CALL THIS PROCESS HAS EVER MADE, so everything here is
 * a first decision rather than a convention already in force. The console —
 * fivem-ringmaster, on the same box — has been talking to these tables for
 * months, and where a decision is already made over there this file makes the
 * same one and says so. Where it deliberately differs, it says that too. The
 * one that matters is the audit log, and it is at the foot of this file.
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
  /** Read only. One row per license, lifted bans kept. */
  bans: string
  /** Read only. The console's player registry, keyed on license. */
  players: string
  /** Read only. Reverse index: qualified identifier -> licenses. */
  playerIds: string
  /** Read AND written. The one table the bot appends to. See `begin`. */
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

/** From lib/bans.ts, whole. A ban is a record and lifting one does not remove it. */
export interface Ban {
  /** Partition key. The qualified license, e.g. `license:abc123…`. */
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

/** The audit log's single partition key. From lib/audit.ts. */
const AUDIT_PK = 'AUDIT'

/* ------------------------------------------------------------------ */

/**
 * Everything the bot may ask of DynamoDB. Nothing else is reachable.
 *
 * THE SHAPE OF THIS INTERFACE IS THE ACCESS POLICY, written a second time in a
 * place a compiler reads. Five tables offer a read and nothing else; two offer
 * a write. There is no `bans.issue`, no `players.write`, no `maintenance.
 * schedule` — the console owns those actions and owns the consequences of
 * getting them wrong, and a Discord bot that could ban somebody from a slash
 * command would be a second, less careful implementation of the console's most
 * dangerous path. When the bot genuinely needs one, it goes here with the
 * reason attached.
 */
export interface Ddb {
  /** The settled settings, so a caller can log what it is actually pointed at. */
  readonly region: string
  readonly tables: TableNames
  readonly timeoutMs: number

  bans: {
    /** The ban row for a license — lifted and expired ones included, like the console's. */
    get(license: string): Promise<DdbResult<Ban | null>>
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

export function createDdb(options: DdbOptions = {}): Ddb {
  const region = options.region ?? DEFAULT_REGION
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX
  const gamePrefix = options.gameTablePrefix ?? DEFAULT_GAME_TABLE_PREFIX
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const tables = tableNames(prefix, gamePrefix)

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

  return {
    region,
    tables,
    timeoutMs,

    bans: {
      get(license) {
        return call('get', tables.bans, async (o) => {
          const res = await doc.get({ TableName: tables.bans, Key: { license } }, o)
          return (res.Item as Ban | undefined) ?? null
        })
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
            pk: AUDIT_PK,
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
              Key: { pk: AUDIT_PK, ts: handle.ts },
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
              ExpressionAttributeValues: { ':pk': AUDIT_PK },
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
