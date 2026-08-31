import {
  DiscordAPIError,
  Events,
  PermissionsBitField,
  RESTJSONErrorCodes,
  type Client,
  type Guild,
} from 'discord.js'

import type { Config } from './config.ts'
import {
  isBanActive,
  qualifyId,
  type AuditAction,
  type AuditRow,
  type Ban,
  type DdbWithAuditWindow,
  type PlayerRecord,
} from './ddb.ts'
import { log } from './log.ts'

/* ------------------------------------------------------------------ *
 * THE GAME-BAN ROLE — blitz-bot#2.
 *
 * The direction blitz-bot#16 does not cover: a ban issued in the CONSOLE,
 * carried into Discord as a role.
 * ------------------------------------------------------------------ */

/**
 * ═══ THE POLICY, WHICH IS THE OTHER HALF OF #16'S ═══
 *
 * A GAME BAN ASSIGNS `config.gameBanRoleId` AND NOTHING ELSE. The person keeps
 * limited access to the guild and can argue their case with a human. Lifting the
 * ban takes the role off, and so does the ban EXPIRING.
 *
 * A GAME BAN NEVER CAUSES A DISCORD BAN, ever, by any path. Nothing in this file
 * can ban, kick or remove anybody from the guild: the only two writes it makes to
 * Discord are adding and removing one role id, and the only two writes it makes
 * to AWS are to the bot's own state table. That is the asymmetry #16's header
 * describes, enforced here by there being no other verb available.
 *
 * A BANNED PLAYER WHO JOINS THE DISCORD GETS THE ROLE. Somebody game-banned who
 * was never in the guild, or who left and came back, has to arrive marked —
 * otherwise the role means "banned AND was already here", which is not the
 * policy. That is the `guildMemberAdd` listener at the foot of this file, and it
 * is the reason the `GuildMembers` privileged intent is now asked for (see
 * `createClient` in src/client.ts, and README/`.env.example` for the tick in the
 * Developer Portal that has to be on BEFORE this ships).
 *
 * ═══ WHY THIS IS HARDER THAN #16, IN ONE SENTENCE ═══
 *
 * #16 had a Discord event to hang off. A game ban happens in the console and
 * Discord is told nothing at all — no event, no webhook, no callback — so the
 * only way to learn about one is to watch the console's own data. Everything
 * below follows from that, and from five properties of that data that make the
 * obvious implementation quietly wrong.
 *
 * ═══ TRAP 1: AN AUDIT ROW IS AN INTENT, NOT A FACT ═══
 *
 * `audit.begin()` writes its row with `outcome: 'pending'` BEFORE the action, and
 * `resolve()` updates THE SAME KEY afterwards — `pk` and `ts` never change. So a
 * poll of `ts > cursor` sees every row EXACTLY ONCE, in its pending state, and
 * never sees the outcome land on it. A poller that waited to see `outcome: 'ok'`
 * before acting would wait forever.
 *
 * SO A `ban.issue` OR `ban.lift` ROW IS A TRIGGER TO GO AND READ THE BAN ROW, and
 * is never the fact itself. `ringmaster-bans` is where the truth is, `isBanActive`
 * is the question, and this file never reads `outcome` at all — a ban that failed
 * has no active row, which is the same answer by a shorter road.
 *
 * IT IS ALSO WHY THE POLL HOLDS BACK. See `SETTLE_MS`.
 *
 * ═══ TRAP 2: ONE BAN WRITES SEVERAL ROWS ═══
 *
 * A single ban writes `ban.issue`, then a `player.kick` carrying
 * `detail.becauseOf = 'ban.issue'`, and — for a permanent ban — a burst of
 * `incident.resolve` rows with the same marker as the console closes the player's
 * other open cases. Acting on "anything the log says about this player right now"
 * would mean four role edits for one ban.
 *
 * THE FILTER IS ON THE ACTION AND NOTHING ELSE. `TRIGGERS` holds the two verbs
 * that mean a ban changed; `detail.becauseOf` is never read, because a row that
 * is not one of those two verbs never gets far enough for its detail to matter.
 * The marker is written down here only so the next person knows why filtering by
 * target, or by time, would have been wrong.
 *
 * ═══ TRAP 3: AN EXPIRING BAN WRITES NO ROW AT ALL ═══
 *
 * There is no `ban.expire` verb in `AuditAction` and there is no process that
 * would write one: a temporary ban stops being in force because a timestamp
 * passed, and nothing anywhere notices. A poller alone would therefore leave the
 * role on every temp-banned player FOREVER — the single worst outcome available
 * here, because the role is a restriction and nobody would ever come and take it
 * off by hand.
 *
 * SO THERE IS A RECONCILE, AND IT IS NOT OPTIONAL. See `reconcile` below, and
 * `TAGS_KEY` for why it walks the bot's own record rather than the ban table.
 *
 * ═══ TRAP 4: THE BOT IS A SECOND WRITER TO `pk = 'AUDIT'` ═══
 *
 * `nextTs` in src/ddb.ts breaks a same-millisecond tie per PROCESS, and the bot
 * is a second process writing to the console's partition. Nothing in this file
 * writes an audit row — its `Pick` of the module deliberately cannot — so the
 * hazard is not this file's. What it inherits from it is the shape of the sort
 * key: a burst can push `ts` a little AHEAD of the wall clock, which is one of the
 * two things `SETTLE_MS` is sized against.
 *
 * ═══ TRAP 5: `pk = 'AUDIT'` IS DOCUMENTED AS MOVING ═══
 *
 * The console's own note says the answer to that partition growing is
 * `AUDIT#<yyyy-mm>`. The day that lands, a reader with `'AUDIT'` baked into it
 * returns zero rows — not an error, not a warning, just an empty page, forever,
 * and the role sync stops with nothing to show that it has.
 *
 * TWO THINGS GUARD IT. The partition is a setting of the module rather than a
 * literal in three places (`AUDIT_PK` in src/ddb.ts), and silence is CHECKED
 * rather than assumed: after `PARTITION_SILENCE_MS` with nothing seen, the poller
 * asks whether the partition holds any row at all, and says so at `error` when it
 * does not. A quiet guild and a moved log stop looking the same.
 */

/**
 * The two audit verbs that mean a ban changed. See trap 2.
 *
 * A `Set` OF `AuditAction` RATHER THAN TWO STRING COMPARISONS, so that a verb
 * renamed in src/ddb.ts is a compile error here instead of a filter that silently
 * matches nothing — which is the same silence trap 5 is about, arriving by
 * another door.
 */
const TRIGGERS: ReadonlySet<AuditAction> = new Set<AuditAction>(['ban.issue', 'ban.lift'])

/**
 * Is this row one that means a ban changed?
 *
 * THE WHOLE OF TRAP 2'S ANSWER, IN ONE LINE, and exported so a test can pin that
 * the rows a single ban drags along behind it — the `player.kick` and the burst of
 * `incident.resolve`, both carrying `detail.becauseOf = 'ban.issue'` — are refused
 * by the same filter that lets the ban itself through. Nothing reads
 * `detail.becauseOf`; the verb is sufficient, and this is where that is stated.
 */
export function isBanTrigger(row: Pick<AuditRow, 'action'>): boolean {
  return TRIGGERS.has(row.action)
}

/**
 * Where the bot remembers which bans it has put the role on for.
 *
 * IT IS A RECORD OF THE BOT'S OWN ACTIONS AND NOT A CLAIM ABOUT THE GUILD, and
 * that distinction is the whole reason this row exists rather than the reconcile
 * reading the guild's role holders. The rule this file keeps is THE BOT ONLY
 * TAKES OFF WHAT IT PUT ON — the same rule `liftableBy` keeps in src/client.ts,
 * where a game ban the bot did not create is left standing. An admin who gives
 * somebody this role by hand has made a decision, and a sweep over "everybody
 * holding the role" would silently undo it on the next pass.
 *
 * WHY NOT WALK `ringmaster-bans` INSTEAD, which is the obvious reading of "a
 * periodic reconcile over the ban table": that table is keyed on one identifier
 * with no sort key, so walking it means a Scan — and src/ddb.ts has no `scan` and
 * must never gain one (its `DocumentClient` omits it deliberately; a scan of the
 * console's tables is a bill rather than a feature). Walking the bot's own record
 * is a bounded list of `GetItem`s on keys it already knows.
 *
 * WHAT IT COSTS, PLAINLY. Losing this row means the bot forgets what it tagged:
 * no role is ever removed by the reconcile again, and every role already applied
 * stays until a `ban.lift` trigger arrives for it or somebody clears it by hand.
 * That is the safe direction to fail in — a restriction that outstays its ban is
 * visible to the person wearing it and fixable by an admin, whereas the opposite
 * failure quietly un-marks people who are still banned — but it is a real cost and
 * it is why a value that will not parse is left alone rather than overwritten.
 *
 * IT IS ALSO WHY THERE IS NO BACKFILL. On the first ever start the bot has tagged
 * nobody, and it cannot ask "who is banned right now" without the Scan above. So
 * bans that predate this feature are never marked; only bans issued from now on
 * are. That is the same limitation `reconcileModeration` states about Discord bans
 * that predate #16, and the same answer: a one-off migration with a decision
 * attached, not something a boot path does quietly.
 */
export const TAGS_KEY = 'game-ban-role-tags'

/**
 * Where the poller's place in `ringmaster-audit` is kept.
 *
 * A SECOND ROW AND NOT A FIELD ON THE FIRST, because the two are written on
 * different schedules and a failure to save one must not lose the other. It is
 * also a different KIND of value — a position in somebody else's log, versus this
 * bot's own record of what it did.
 *
 * DISTINCT FROM `AUDIT_CURSOR_KEY` IN src/client.ts, WHICH IS A DIFFERENT LOG.
 * That one is a Discord audit log entry id (a snowflake); this one is a
 * millisecond sort key in DynamoDB. Two cursors, two logs, two names — putting
 * either value in the other's row would be a poller that resumes from a number
 * with no meaning in its own table.
 */
export const CURSOR_KEY = 'game-ban-audit-cursor'

/**
 * How often the audit log is polled.
 *
 * MEASURED AGAINST HOW LONG A BANNED PLAYER SHOULD GO UNMARKED, which is the only
 * thing this number is really about — the ban itself is already in force at the
 * game's door the instant the console writes the row, so nothing here is on the
 * path of enforcement. Half a minute is fast enough that an admin who bans
 * somebody and then looks at the guild sees the role, and slow enough that an idle
 * bot makes two DynamoDB reads a minute.
 */
export const POLL_MS = 30_000

/**
 * How often the bot re-checks the bans it has already marked. Trap 3's timer.
 *
 * FIVE MINUTES, WHICH IS THE LATENCY OF AN EXPIRY AND NOTHING ELSE. A ban that
 * runs out at 21:00 has its role removed by 21:05, and nobody is harmed by the
 * five minutes. Making it a minute would multiply the read cost of the one pass
 * here that reads rows nothing asked about.
 */
export const RECONCILE_MS = 300_000

/**
 * How far behind the clock the poll stops reading. Trap 1's hold-back.
 *
 * AN AUDIT ROW IS WRITTEN BEFORE THE BAN ROW IT DESCRIBES, so the newest rows in
 * the log are intents whose ban row may not exist yet. Reading one of those and
 * finding no ban would be read as "the ban failed", the cursor would move past it,
 * and that ban would never be marked — a silent miss on the exact event this file
 * exists for. Holding back five seconds means the console's next write has landed
 * long before we look: the gap between the two is one DynamoDB round trip.
 *
 * IT IS ALSO SIZED AGAINST TRAP 4. `nextTs` steps a colliding write forward by a
 * millisecond, so a burst can stamp a row slightly AHEAD of the wall clock; five
 * seconds is thousands of collisions of headroom.
 *
 * THE TWO CLOCKS ARE THE SAME CLOCK. The console and the bot are two processes on
 * one box (docs/deploy.md), so comparing the console's `ts` against this process's
 * `Date.now()` is comparing one machine to itself. If the bot is ever moved off
 * that box, this number has to cover the skew between them as well.
 */
export const SETTLE_MS = 5_000

/**
 * How much of the audit log one poll may pull back.
 *
 * A BOUND AND NOT A CAPACITY. A caught-up poller reads a handful of rows a day;
 * this number only matters after an outage, and there it is the answer to "how
 * much are we willing to spend catching up in one pass". Passes repeat every
 * `POLL_MS`, and the cursor advances over what was actually dealt with, so a long
 * backlog is drained across passes rather than in one.
 */
export const POLL_LIMIT = 50

/**
 * How many distinct ban rows one poll may read, and how many one reconcile may.
 *
 * THE POLL'S BOUND IS SEPARATE FROM `POLL_LIMIT` BECAUSE THE TWO COUNT DIFFERENT
 * THINGS. Fifty audit rows can be fifty rows about four people (trap 2 again, and
 * a re-ban), or fifty rows about fifty people. The read budget is what stops the
 * second case from turning one pass into fifty round trips.
 */
export const MAX_BAN_READS = 25

/** The reconcile's read budget per pass. See `MAX_BAN_READS`. */
export const RECONCILE_READS = 20

/**
 * How many role edits one pass may make.
 *
 * DISCORD'S RATE LIMITS ARE PER ROUTE AND ARE NOT GENEROUS, and a burst of role
 * edits is the shape of traffic that hits them: a mass ban in the console, or a
 * reconcile finding twenty expiries at once after the bot was down for a week.
 * Ten a pass drains that in minutes instead of in one 429 storm, and every
 * decision here is idempotent, so a pass that stops early costs a wait and
 * nothing else.
 *
 * THE CURSOR ONLY MOVES OVER ROWS ACTUALLY DEALT WITH, which is what makes
 * stopping early safe rather than lossy — the same rule `reconcileModeration` in
 * src/client.ts keeps for the same reason.
 */
export const MAX_ROLE_EDITS = 10

/**
 * How many tags the bot will remember at once.
 *
 * A BOUND ON A DYNAMODB ITEM, WHICH IS WHERE THE REAL LIMIT IS. One row holds the
 * whole list and an item may not exceed 400KB; an entry serialises to roughly 120
 * bytes (see `renderTags`), so a thousand is about 120KB — comfortably inside it,
 * and far more simultaneous game bans than this community has ever had.
 *
 * REACHING IT IS A FAULT AND IS REPORTED AS ONE. The list only grows while bans
 * are in force, and every ending ban removes an entry, so a thousand live tags
 * means either an unimaginable ban wave or a reconcile that has stopped draining.
 * The oldest-checked entry is dropped to make room — losing the bot's memory of
 * one tag, which leaves that role on — and the line names whom, so it can be
 * taken off by hand. Refusing the new tag instead would fail in the other
 * direction: a banned player left unmarked.
 */
export const TAG_LIMIT = 1000

/**
 * How long the log may be silent before the poller asks whether it still exists.
 *
 * TRAP 5'S ALARM, AND THE NUMBER IS CHOSEN SO IT CANNOT CRY WOLF. A guild can
 * genuinely go a day without a moderation action, but `ringmaster-audit` carries
 * EVERY console action — maintenance windows, spectates, incident verdicts — so
 * six hours with not one row is already unusual. When it happens the poller asks
 * one cheap question (`auditWindow.newest`), and only a partition holding
 * literally nothing raises the alarm.
 *
 * SIX HOURS RATHER THAN SIX MINUTES because the probe is not free and a false
 * alarm in the status channel is worse than a late true one: the migration this
 * guards against is a planned change somebody makes, not a fault that arrives at
 * 3am.
 */
export const PARTITION_SILENCE_MS = 21_600_000

/**
 * How many pending joins the queue will hold.
 *
 * A RAID IS THE CASE THIS EXISTS FOR. Every join costs up to three DynamoDB reads,
 * and a hundred people arriving in a minute is a real thing that happens to a
 * Discord server. Beyond this the extras are dropped with a line naming them —
 * dropped rather than queued, because a check that runs twenty minutes late is a
 * role applied to somebody who has already been in the guild unmarked for twenty
 * minutes, and the queue would still be growing.
 *
 * WHAT A DROP COSTS: that person is not marked until their next join, or until the
 * console re-issues or lifts their ban. It is a hole and it is named here rather
 * than hidden, because the alternative — an unbounded queue — turns a raid into an
 * unbounded read bill.
 */
export const JOIN_BACKLOG = 100

/**
 * The reasons the bot stamps on its own role edits, in the guild's audit log.
 *
 * MACHINE-SHAPED ON PURPOSE, AND THAT IS WHY NEITHER IS A PLACEHOLDER — the same
 * decision `ROLE_AUDIT_REASON` in src/client.ts records. These are read by an
 * admin scrolling the guild's audit log and their whole job is to say which
 * process did this and why, in the same vocabulary as the journal line. They are
 * not prose addressed to anybody. They are one string each, in one place, if the
 * owner ever wants to word them.
 */
export const ROLE_REASON_TAGGED = 'blitz-bot: a game ban was issued'
export const ROLE_REASON_CLEARED = 'blitz-bot: the game ban this role marked has ended'

/* ------------------------------------------------------------------ *
 * The bot's memory of what it tagged.
 * ------------------------------------------------------------------ */

/**
 * One ban the bot has put the role on for.
 *
 * KEYED ON THE BAN ROW, NOT ON THE PERSON, and that is deliberate. One Discord
 * account can carry two ban rows at once — a `license:…` one and a `discord:…`
 * one, which is exactly what #16 writes when the game has never seen the account
 * — and those are two independent decisions that end at different times. Keying
 * on the ban means each is tracked and answered on its own; `othersFor` below is
 * what stops the first one ending from un-marking somebody the second still bans.
 */
export interface TaggedBan {
  /** The `ringmaster-bans` partition key. A qualified identifier. */
  readonly key: string
  /** The Discord account the role went on. */
  readonly discordId: string
  /** The ban's expiry as of `checkedAt`, or null for permanent. */
  readonly expiresAt: number | null
  /** When the ban row behind this tag was last read. */
  readonly checkedAt: number
}

/** What `parseTags` answers. See its comment for why a failure is not an empty list. */
export type TagsRead =
  | { readonly ok: true; readonly tags: TaggedBan[] }
  | { readonly ok: false; readonly why: string }

/** The stored envelope's version. Bumped when the entry shape changes. */
const TAGS_VERSION = 1

/**
 * Read the stored list.
 *
 * A FAILURE IS NOT AN EMPTY LIST, AND THAT IS THE ONE THING THIS FUNCTION IS FOR.
 * `BotStateRow.value` is a string and src/ddb.ts is explicit that a caller wanting
 * structure owns the parse; owning it means deciding what an unreadable value
 * means. "No tags" would be a catastrophic reading: the very next pass would write
 * a fresh empty list over the row, and every role the bot has ever applied would
 * be orphaned in one step, with nothing left to say who was wearing one. So a
 * value that will not parse stops the pass and leaves the row exactly as it was,
 * for a person to look at.
 *
 * AN ENTRY THAT WILL NOT PARSE IS DROPPED, WHICH IS THE OPPOSITE CHOICE AND IS
 * NOT AN INCONSISTENCY. An entry missing its key or its Discord id is not a tag
 * that can be acted on by anything — there is no row to read and nobody to take a
 * role off — so keeping it would only mean carrying an unusable record forever.
 * It is dropped with a line, and the line is what makes it recoverable.
 */
export function parseTags(raw: string | null | undefined): TagsRead {
  if (raw === null || raw === undefined || raw.trim() === '') return { ok: true, tags: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, why: 'not JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null) return { ok: false, why: 'not an object' }

  const envelope = parsed as { v?: unknown; tags?: unknown }
  if (envelope.v !== TAGS_VERSION) return { ok: false, why: `version ${String(envelope.v)}` }
  if (!Array.isArray(envelope.tags)) return { ok: false, why: 'no tag list' }

  const tags: TaggedBan[] = []
  let dropped = 0

  for (const item of envelope.tags as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      dropped++
      continue
    }

    const row = item as { k?: unknown; d?: unknown; x?: unknown; c?: unknown }

    if (typeof row.k !== 'string' || row.k === '' || typeof row.d !== 'string' || row.d === '') {
      dropped++
      continue
    }

    tags.push({
      key: row.k,
      discordId: row.d,
      expiresAt: typeof row.x === 'number' && Number.isFinite(row.x) ? row.x : null,
      // A missing `checkedAt` reads as "never checked", which puts the entry at
      // the front of the reconcile's queue. That is the right end of the queue
      // for a record this file cannot vouch for.
      checkedAt: typeof row.c === 'number' && Number.isFinite(row.c) ? row.c : 0,
    })
  }

  if (dropped > 0) {
    log('warn', 'some game-ban role tags could not be read and were dropped', {
      dropped,
      kept: tags.length,
    })
  }

  return { ok: true, tags }
}

/**
 * Write the list back.
 *
 * ONE-LETTER FIELD NAMES, WHICH IS THE ONE PLACE IN THIS REPO THAT WOULD OTHERWISE
 * BE INDEFENSIBLE. The whole list is ONE DynamoDB item and an item may not exceed
 * 400KB, so every byte of every field name is paid a thousand times over. `key`,
 * `discordId`, `expiresAt`, `checkedAt` would cost about a third of the budget to
 * say what `parseTags` above already says in prose. The types are the
 * documentation; this is the wire.
 */
export function renderTags(tags: readonly TaggedBan[]): string {
  return JSON.stringify({
    v: TAGS_VERSION,
    tags: tags.map((tag) => ({
      k: tag.key,
      d: tag.discordId,
      x: tag.expiresAt,
      c: tag.checkedAt,
    })),
  })
}

/**
 * The order the reconcile works through the list in.
 *
 * DUE FIRST, WHICH IS TRAP 3'S WHOLE POINT. An entry whose stored expiry has
 * passed is the one case nothing else in this file will ever hear about, so it
 * goes to the front — soonest expiry first, so a backlog is drained in the order
 * it accumulated.
 *
 * THEN LEAST RECENTLY CHECKED, WHICH IS THE OTHER HALF AND IS NOT DECORATION. It
 * is what makes a bounded pass into a rotating sweep of the WHOLE list, and that
 * sweep is the backstop for every way the poll can go blind: a lost cursor, a
 * partition that moved (trap 5), a ban row edited straight in the AWS console. A
 * pass reads `RECONCILE_READS` entries, so a list of fifty is swept end to end
 * every few passes whether or not anything has expired.
 *
 * THE STORED EXPIRY IS ONLY EVER USED TO ORDER THIS QUEUE, NEVER TO DECIDE. It is
 * a remembered fact and trap 1 is about acting on remembered facts: the ban row is
 * read before anything is done, every time, because the console may have extended
 * or replaced the ban since.
 */
export function dueFirst(tags: readonly TaggedBan[], now: number): TaggedBan[] {
  const due: TaggedBan[] = []
  const rest: TaggedBan[] = []

  for (const tag of tags) {
    if (tag.expiresAt !== null && tag.expiresAt <= now) due.push(tag)
    else rest.push(tag)
  }

  due.sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0))
  rest.sort((a, b) => a.checkedAt - b.checkedAt)

  return [...due, ...rest]
}

/**
 * The Discord account a game ban should be marked on, out of the player registry.
 *
 * THE NEWEST SIGHTING BY `lastSeen`, NOT THE LAST ARRAY ELEMENT. `licensesFor` in
 * src/client.ts can take `at(-1)` because `lib/players.ts` documents that list as
 * most-recent-last; the per-kind sighting arrays carry no such promise, and
 * "whichever the array happens to end with" is how somebody's old, abandoned
 * Discord account ends up wearing a ban role. The field is on the row for exactly
 * this question, so it is the field that gets asked.
 *
 * DEFENSIVE ABOUT THE ROW'S SHAPE, like `gamePlayers.profile` in src/ddb.ts and
 * for a related reason: this row is written by the console and by the game, and a
 * sighting that arrives without a `lastSeen` should cost that sighting rather than
 * produce a `NaN` comparison that silently picks the wrong account.
 *
 * SHAPE-CHECKED BEFORE IT IS RETURNED. `SNOWFLAKE` is the console's own digit rule
 * (see src/config.ts, which copies it and says why). Anything else in that field
 * is not a Discord id, and handing it to `members.addRole` would be one REST
 * error per ban with an unhelpful message attached.
 */
export function newestDiscordId(record: PlayerRecord | null): string | null {
  const sightings = record?.identifiers?.discord ?? []

  let best: { value: string; lastSeen: number } | null = null

  for (const sighting of sightings) {
    const value: unknown = sighting?.value
    if (typeof value !== 'string' || !SNOWFLAKE.test(value)) continue

    const lastSeen =
      typeof sighting.lastSeen === 'number' && Number.isFinite(sighting.lastSeen)
        ? sighting.lastSeen
        : 0

    if (best === null || lastSeen > best.lastSeen) best = { value, lastSeen }
  }

  return best?.value ?? null
}

/** The console's digit rule for a Discord id. Copied from src/config.ts. */
const SNOWFLAKE = /^[0-9]{1,32}$/

/**
 * The Discord id a `discord:`-keyed ban row is about, or null for any other key.
 *
 * `qualifyId('discord', id)` READ BACKWARDS, and a function rather than a
 * `slice(8)` at the call site for that reason: the prefix is decided in one place
 * in src/ddb.ts and read back in one place here.
 */
export function discordIdIn(banKey: string): string | null {
  const prefix = qualifyId('discord', '')
  if (!banKey.startsWith(prefix)) return null

  const id = banKey.slice(prefix.length)
  return SNOWFLAKE.test(id) ? id : null
}

/* ------------------------------------------------------------------ *
 * Can the bot actually assign this role?
 * ------------------------------------------------------------------ */

/**
 * Why the role cannot be assigned. Each one is a different thing to go and fix.
 *
 * `role-too-high` IS THE ONE THIS CHECK EXISTS FOR. Discord refuses a role edit
 * unless the acting member's HIGHEST role sits above the role being assigned, and
 * a role list is dragged into order by hand in a settings page — so this is not an
 * exotic misconfiguration, it is the default outcome of creating a role and not
 * thinking about where it landed. The failure is a 403 per edit and nothing in the
 * guild to explain it.
 */
export type RoleProblem =
  | 'no-guild'
  | 'no-role'
  | 'no-self'
  | 'no-permission'
  | 'managed-role'
  | 'role-too-high'

export type RoleReadiness =
  | { readonly ok: true }
  | { readonly ok: false; readonly why: RoleProblem }

/**
 * What the check needs to know, as plain data.
 *
 * PLAIN DATA RATHER THAN A `Guild`, for the reason `ModerationEntry` in
 * src/client.ts is plain data: a `Guild` is a live object hanging off a client, a
 * REST handle and three caches, and taking one here would mean every test of this
 * ordering either builds one or mocks a class with fifty members.
 *
 * `above` IS COMPUTED BY THE ADAPTER AND NOT FROM THE TWO POSITIONS, and that is
 * the one thing deliberately NOT decided in this function. Two roles can share a
 * raw position, and Discord breaks that tie on the role id; `comparePositionTo` is
 * discord.js's implementation of that rule and re-deriving it from two numbers
 * here would be a second opinion about somebody else's ordering. The positions are
 * carried anyway, for the log line that tells an operator what to drag.
 */
export interface RoleStanding {
  readonly guild: boolean
  readonly role: { readonly managed: boolean; readonly position: number } | null
  readonly self: {
    readonly manageRoles: boolean
    readonly highestPosition: number
    readonly above: boolean
  } | null
}

/**
 * The boot check, and the same check before every edit.
 *
 * THE ORDER IS STRUCTURAL, cheapest and most fundamental first, so that a later
 * answer is never reported about a guild or a role that is not there. It is the
 * same shape as the guard order in `mirrorEntry`.
 *
 * IT IS RE-ASKED BEFORE EVERY EDIT AND NOT ONLY AT BOOT. All of it reads caches
 * the gateway keeps up to date, so it costs nothing — and it means an owner who
 * drags the role into place while the bot is running has a working feature within
 * one poll instead of after a restart. A boot-only check would have made "fix the
 * order" a two-step job with a restart in the middle.
 */
export function roleReadiness(standing: RoleStanding): RoleReadiness {
  if (!standing.guild) return { ok: false, why: 'no-guild' }
  if (standing.role === null) return { ok: false, why: 'no-role' }
  if (standing.self === null) return { ok: false, why: 'no-self' }
  if (!standing.self.manageRoles) return { ok: false, why: 'no-permission' }

  // A role Discord manages for an integration cannot be given to anybody by
  // anybody, whatever the position and whatever the permission.
  if (standing.role.managed) return { ok: false, why: 'managed-role' }

  if (!standing.self.above) return { ok: false, why: 'role-too-high' }

  return { ok: true }
}

/**
 * What an operator is told, per problem.
 *
 * A `Record<RoleProblem, string>` SO A SEVENTH PROBLEM IS A COMPILE ERROR rather
 * than an `undefined` printed where the sentence goes. These are journal lines and
 * status-channel lines — the bot describing its own state to whoever runs it — and
 * are written the way every other `log()` message in this repo is.
 */
export const ROLE_PROBLEM: Record<RoleProblem, string> = {
  'no-guild': 'the guild is not in the cache, so the game-ban role cannot be checked',
  'no-role': 'BLITZ_GAME_BAN_ROLE_ID names no role in this guild, so no game ban can be marked',
  'no-self': "the bot's own membership is not in the cache, so the game-ban role cannot be checked",
  'no-permission': 'the bot does not hold Manage Roles, so it cannot mark or unmark a game ban',
  'managed-role': 'the game-ban role belongs to an integration, so nobody can be given it',
  'role-too-high':
    "the game-ban role sits above the bot's own role, so the bot cannot assign it — move it below in Server Settings, Roles",
}

/**
 * Putting the role on and taking it off. The seam, so everything above runs offline.
 *
 * A SEAM OF ITS OWN RATHER THAN A REUSE OF `roleTaker` IN src/client.ts, and the
 * reason is not tidiness. That one is bound to #16's unban path and to #16's audit
 * reason, which says the ban was lifted — wrong on the two paths here, where a ban
 * expired or has just been issued. Sharing it would mean either a wrong sentence
 * in the guild's audit log or a parameter added to somebody else's function; and
 * importing it would make src/client.ts and this file import each other, since
 * src/client.ts is what wires this one on.
 */
export interface GameBanRoles {
  /** Whether an edit could succeed right now. Reads caches; makes no request. */
  readonly standing: () => RoleReadiness
  readonly add: (discordId: string) => Promise<void>
  readonly remove: (discordId: string) => Promise<void>
}

/**
 * The real one.
 *
 * `members.addRole` / `members.removeRole` RATHER THAN `member.roles.add`, and the
 * difference is a REST call. The second needs a `GuildMember` object, which means
 * fetching the member first; these take a user id and issue the one PATCH. It
 * matters most on the untag path, where the member usually is not there to fetch.
 */
export function guildRoles(client: Client, guildId: string, roleId: string): GameBanRoles {
  function cached(): Guild | null {
    return client.guilds.cache.get(guildId) ?? null
  }

  return {
    standing() {
      const guild = cached()
      if (guild === null) return roleReadiness({ guild: false, role: null, self: null })

      const role = guild.roles.cache.get(roleId) ?? null
      const me = guild.members.me

      return roleReadiness({
        guild: true,
        role: role === null ? null : { managed: role.managed, position: role.position },
        self:
          me === null
            ? null
            : {
                manageRoles: me.permissions.has(PermissionsBitField.Flags.ManageRoles),
                highestPosition: me.roles.highest.position,
                // discord.js's own comparison. See `RoleStanding`.
                above: role !== null && me.roles.highest.comparePositionTo(role) > 0,
              },
      })
    },

    async add(discordId) {
      const guild = await client.guilds.fetch(guildId)
      await guild.members.addRole({ user: discordId, role: roleId, reason: ROLE_REASON_TAGGED })
    },

    async remove(discordId) {
      const guild = await client.guilds.fetch(guildId)
      await guild.members.removeRole({ user: discordId, role: roleId, reason: ROLE_REASON_CLEARED })
    },
  }
}

/* ------------------------------------------------------------------ *
 * The sync itself.
 * ------------------------------------------------------------------ */

/**
 * Everything the sync needs from the world.
 *
 * `Pick<…>` IS THE ACCESS POLICY WRITTEN WHERE A COMPILER READS IT, the same way
 * `MirrorDeps` states #16's. This one can read bans, read the player registry,
 * read the identifier index, read the audit STREAM and read and write the bot's
 * own state — and it cannot write a ban, cannot write an audit row, and cannot
 * reach the maintenance window or the game's tables, however it is edited later.
 *
 * NOT BEING ABLE TO WRITE A BAN IS THE IMPORTANT ONE. This whole file is
 * downstream of somebody else's moderation decision; the day it can write to
 * `ringmaster-bans` it stops being a mirror and becomes a second, unreviewed
 * opinion about who is banned.
 */
export interface BanRoleDeps {
  readonly ddb: Pick<
    DdbWithAuditWindow,
    'bans' | 'players' | 'playerIds' | 'botState' | 'auditWindow'
  >
  readonly roles: GameBanRoles
  readonly now?: () => number
}

/**
 * What the sync has done since it started.
 *
 * A ROLE EDIT THAT FAILS IS OTHERWISE COMPLETELY SILENT, WHICH IS WHY THIS EXISTS.
 * Nothing in the guild shows a role that was not applied: the person looks
 * unbanned, the ban row says otherwise, and there is no reply to edit and no
 * member to tell. Each failure is a `warn` — which reaches the status channel
 * through the sink in src/log.ts — and the running total goes on the line with it,
 * because the status channel FOLDS a repeating fault into one message. Folding is
 * what keeps the channel readable; the total is what tells the owner whether he is
 * looking at one 429 or at every edit since boot having failed.
 */
export interface BanRoleStats {
  /** Roles successfully put on. */
  readonly tagged: number
  /** Roles successfully taken off. */
  readonly cleared: number
  /** Edits that failed for a reason that needs somebody. */
  readonly failed: number
  /** Edits not even attempted because the role is not assignable. */
  readonly blocked: number
  /** When the last failure happened, or null. */
  readonly lastFailureAt: number | null
}

/**
 * What one `release` did to the role, in the four ways it can end.
 *
 * `cleared` — the role came off, and the tag went with it.
 *
 * `kept` — this bot's own record for the lifted ban was dropped and the ROLE
 *   STAYED ON, because the same Discord account is tagged for another game ban.
 *   The invariant is "the role is on while ANY game ban stands", so this is a
 *   correct outcome and not a partial failure — and it is the one an admin most
 *   needs told, because they will otherwise read the role still being there as
 *   the command not having worked.
 *
 * `not-tagged` — the bot held no record for these keys, so there was nothing of
 *   its to take off. An ordinary answer: most people carrying a game ban were
 *   never in the guild to be marked in the first place.
 *
 * `failed` — the tag row could not be read or written, or the role edit did not
 *   go through. The reconcile pass will try again within five minutes; what
 *   matters here is that the caller does not report success.
 */
export type ReleaseOutcome = 'cleared' | 'kept' | 'not-tagged' | 'failed'

export interface BanRoleSync {
  /** The boot check on the role. Loud when the role cannot be assigned. */
  check(): void
  /** The boot check on the audit partition. Trap 5. */
  probe(): Promise<void>
  /** One pass over the audit log. */
  poll(): Promise<void>
  /** One pass over the bot's own tags. Trap 3. */
  reconcile(): Promise<void>
  /** Somebody joined the guild: mark them if a game ban stands. */
  join(discordId: string): Promise<void>
  /** A ban has just been lifted by hand: take the role off. See `ReleaseOutcome`. */
  release(keys: readonly string[]): Promise<ReleaseOutcome>
  stats(): BanRoleStats
}

/** What one decision did, so a pass can budget and a test can assert. */
type Step = 'edited' | 'quiet' | 'stop'

export function createBanRoleSync(deps: BanRoleDeps): BanRoleSync {
  const now = deps.now ?? Date.now

  let tagged = 0
  let cleared = 0
  let failed = 0
  let blocked = 0
  let lastFailureAt: number | null = null

  /**
   * When a row was last seen in the audit partition. Trap 5's timer.
   *
   * STARTED AT BOOT RATHER THAN AT ZERO, so a bot that has only just come up does
   * not immediately conclude that a partition it has not looked at yet is empty.
   */
  let lastRowAt = now()

  /* -------------------------------------------------------------- *
   * The tag book: the in-memory view of one DynamoDB row.
   * -------------------------------------------------------------- */

  function book(initial: TaggedBan[]) {
    let tags = [...initial]
    let dirty = false

    return {
      all: (): readonly TaggedBan[] => tags,
      find: (key: string): TaggedBan | null => tags.find((tag) => tag.key === key) ?? null,

      /**
       * Is this Discord account tagged for some OTHER ban as well?
       *
       * THE INVARIANT IS "THE ROLE IS ON WHILE ANY GAME BAN STANDS", and this is
       * what states it. One account can carry two ban rows (see `TaggedBan`), and
       * the first of them ending must drop its own record without touching the
       * role — otherwise a lifted `discord:` ban un-marks somebody whose license
       * ban is still in force.
       *
       * IT IS DELIBERATELY NOT "IS THE OTHER BAN STILL ACTIVE". The other entry
       * may be about to be dropped by its own turn in this same pass; leaving the
       * role on until then costs one reconcile cycle and errs toward the
       * restriction staying, which is the recoverable direction.
       */
      othersFor: (discordId: string, exceptKey: string): boolean =>
        tags.some((tag) => tag.key !== exceptKey && tag.discordId === discordId),

      add(entry: TaggedBan): void {
        tags = [...tags, entry]
        dirty = true
      },

      drop(key: string): void {
        tags = tags.filter((tag) => tag.key !== key)
        dirty = true
      },

      refresh(key: string, expiresAt: number | null, checkedAt: number): void {
        tags = tags.map((tag) => (tag.key === key ? { ...tag, expiresAt, checkedAt } : tag))
        dirty = true
      },

      /**
       * Make room, loudly. See `TAG_LIMIT`.
       *
       * THE LEAST RECENTLY CHECKED GOES, because it is the entry this file knows
       * least about — and because dropping the soonest-to-expire would throw away
       * the one the reconcile was about to act on.
       */
      evictOldest(): TaggedBan | null {
        let oldest: TaggedBan | null = null
        for (const tag of tags) {
          if (oldest === null || tag.checkedAt < oldest.checkedAt) oldest = tag
        }
        if (oldest === null) return null

        tags = tags.filter((tag) => tag !== oldest)
        dirty = true
        return oldest
      },

      dirty: (): boolean => dirty,
      clean(): void {
        dirty = false
      },
    }
  }

  type Book = ReturnType<typeof book>

  /**
   * Read the row, or say why the pass must not run.
   *
   * A READ FAILURE AND A PARSE FAILURE BOTH STOP THE PASS, and neither writes
   * anything. See `parseTags` for why an unreadable value is left alone rather
   * than replaced.
   */
  async function openBook(): Promise<Book | null> {
    const row = await deps.ddb.botState.get(TAGS_KEY)

    if (!row.ok) {
      log('warn', 'could not read the game-ban role tags, so this pass did nothing', {
        failure: row.failure.kind,
        detail: row.failure.message,
      })
      return null
    }

    const read = parseTags(row.value?.value)
    if (!read.ok) {
      log('error', 'the stored game-ban role tags could not be read and were left untouched', {
        why: read.why,
      })
      return null
    }

    return book(read.tags)
  }

  /** Write the row back, if anything changed. Answers whether the write held. */
  async function saveBook(tags: Book): Promise<boolean> {
    if (!tags.dirty()) return true

    const written = await deps.ddb.botState.put(TAGS_KEY, renderTags(tags.all()))
    if (!written.ok) {
      log('warn', 'the game-ban role tags could not be saved', {
        failure: written.failure.kind,
        detail: written.failure.message,
        tags: tags.all().length,
      })
      return false
    }

    tags.clean()
    return true
  }

  /* -------------------------------------------------------------- *
   * The role edits, and the counting of them.
   * -------------------------------------------------------------- */

  /** Is this the error that means the role is definitively not on them? */
  function absent(error: unknown): boolean {
    return (
      error instanceof DiscordAPIError &&
      (error.code === RESTJSONErrorCodes.UnknownMember ||
        error.code === RESTJSONErrorCodes.UnknownRole)
    )
  }

  function noteFailure(): void {
    failed++
    lastFailureAt = now()
  }

  /**
   * Put the role on. Never throws; answers whether it went on.
   *
   * A MEMBER WHO IS NOT IN THE GUILD IS THE ORDINARY CASE AND IS `info`. Most
   * people the console bans are not in the Discord server at all, so `Unknown
   * Member` here is not a fault — it is the reason the `guildMemberAdd` listener
   * exists. Reporting it as a failure would put a warning in the status channel
   * for every ban of somebody who has never joined.
   */
  async function putRoleOn(entry: TaggedBan): Promise<boolean> {
    const standing = deps.roles.standing()
    if (!standing.ok) {
      blocked++
      log('warn', ROLE_PROBLEM[standing.why], {
        action: 'mark',
        key: entry.key,
        member: entry.discordId,
        blocked,
      })
      return false
    }

    try {
      await deps.roles.add(entry.discordId)
      tagged++
      log('info', 'game-ban role applied', { key: entry.key, member: entry.discordId })
      return true
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember) {
        log('info', 'the banned player is not in the guild, so there was nobody to mark', {
          key: entry.key,
          member: entry.discordId,
        })
        return false
      }

      noteFailure()
      log('warn', 'the game-ban role could not be applied', {
        key: entry.key,
        member: entry.discordId,
        failures: failed,
        error,
      })
      return false
    }
  }

  /**
   * Take the role off. Never throws; answers whether the tag may now be forgotten.
   *
   * "MAY BE FORGOTTEN" IS NOT "WAS REMOVED", and the difference is the whole
   * return value. `Unknown Member` and `Unknown Role` both mean the role is
   * certainly not on anybody as a result of this tag, so the record has done its
   * job and can go. Anything else — a 429, a 403, a network fault — leaves the
   * record in place so the next pass tries again, which is what stops a transient
   * failure from turning into a role nobody remembers to remove.
   */
  async function takeRoleOff(entry: TaggedBan): Promise<boolean> {
    const standing = deps.roles.standing()
    if (!standing.ok) {
      blocked++
      log('warn', ROLE_PROBLEM[standing.why], {
        action: 'unmark',
        key: entry.key,
        member: entry.discordId,
        blocked,
      })
      return false
    }

    try {
      await deps.roles.remove(entry.discordId)
      cleared++
      log('info', 'game-ban role removed', { key: entry.key, member: entry.discordId })
      return true
    } catch (error) {
      if (absent(error)) {
        log('info', 'nobody to take the game-ban role off, so the tag was dropped', {
          key: entry.key,
          member: entry.discordId,
        })
        return true
      }

      noteFailure()
      log('warn', 'the game-ban role could not be removed', {
        key: entry.key,
        member: entry.discordId,
        failures: failed,
        error,
      })
      return false
    }
  }

  /* -------------------------------------------------------------- *
   * Reading the console's data.
   * -------------------------------------------------------------- */

  /**
   * The ban row an audit trigger is about, under the key it is really stored at.
   *
   * THE AUDIT LOG AND THE BAN TABLE HAVE TO AGREE ABOUT THE KEY, AND NOTHING
   * ENFORCES THAT. `AuditRow.targetLicense` is written by the console and
   * `ringmaster-bans` is keyed on a QUALIFIED identifier (`license:abc…`); if the
   * console ever writes the bare license there, every lookup is a valid `GetItem`
   * that returns no row, and the whole feature is dead in the quietest way
   * available — "no ban found" for every ban ever issued.
   *
   * SO AN UNQUALIFIED ID GETS ONE SECOND LOOK, AND IT SAYS SO. A key with no `:`
   * in it cannot be a `ringmaster-bans` key, so qualifying it is the one other
   * shape it could have been rather than a guess among many. The `warn` is the
   * point of the exercise: it names the mismatch the first time a ban is issued,
   * instead of leaving somebody to work out why a working bot marks nobody.
   *
   * THE COST IS ONE EXTRA `GetItem` AND ONLY ON A MISS. A correctly qualified key
   * that finds no row is not retried, because there is no other shape to try.
   */
  async function readBanRow(
    target: string,
  ): Promise<{ ok: true; key: string; ban: Ban | null } | { ok: false }> {
    const first = await deps.ddb.bans.get(target)
    if (!first.ok) {
      log('warn', 'could not read a ban row, so no role decision was made', {
        key: target,
        failure: first.failure.kind,
        detail: first.failure.message,
      })
      return { ok: false }
    }

    if (first.value !== null) return { ok: true, key: target, ban: first.value }
    if (target.includes(':')) return { ok: true, key: target, ban: null }

    const qualified = qualifyId('license', target)
    const second = await deps.ddb.bans.get(qualified)
    if (!second.ok) {
      log('warn', 'could not read a ban row, so no role decision was made', {
        key: qualified,
        failure: second.failure.kind,
        detail: second.failure.message,
      })
      return { ok: false }
    }

    if (second.value === null) return { ok: true, key: target, ban: null }

    log('warn', "the audit log's target is not the bans table's key shape, so it was qualified", {
      target,
      key: qualified,
    })
    return { ok: true, key: qualified, ban: second.value }
  }

  /**
   * The Discord account behind a ban key. `'failed'` means the read did not answer.
   *
   * A `discord:` KEY CARRIES THE ANSWER AND COSTS NO READ. Every other key is a
   * license, and the registry row is the only place that says which Discord
   * account has played on it.
   */
  async function discordIdFor(key: string): Promise<string | null | 'failed'> {
    const direct = discordIdIn(key)
    if (direct !== null) return direct

    const record = await deps.ddb.players.get(key)
    if (!record.ok) {
      log('warn', 'could not read the player registry, so this ban was not marked', {
        key,
        failure: record.failure.kind,
        detail: record.failure.message,
      })
      return 'failed'
    }

    return newestDiscordId(record.value)
  }

  /* -------------------------------------------------------------- *
   * The two decisions.
   * -------------------------------------------------------------- */

  /**
   * Mark somebody: the record FIRST, then the role.
   *
   * THE ORDER IS THE INVARIANT AND IT IS THE ONLY ORDER THAT FAILS SAFELY. What
   * this file must never do is put a role on somebody and forget it did, because
   * nothing else in this system will ever take that role off. Writing the record
   * first means the two failures are: a record with no role (the reconcile finds
   * the ban is over, tries to remove a role that is not there, gets `Unknown
   * Member`, drops the record — harmless), or a record and a role (correct). The
   * other order buys a stuck restriction.
   *
   * SO THE STORED SET IS ALWAYS A SUPERSET OF THE ROLES ACTUALLY APPLIED, and
   * every other function here may rely on that.
   */
  async function mark(tags: Book, key: string, ban: Ban): Promise<Step> {
    const discordId = await discordIdFor(key)
    if (discordId === 'failed') return 'stop'

    if (discordId === null) {
      log('info', 'the game has no Discord account for this player, so nothing was marked', { key })
      return 'quiet'
    }

    if (tags.all().length >= TAG_LIMIT) {
      const evicted = tags.evictOldest()
      log('error', 'the game-ban role tag list is full, so the oldest tag was forgotten', {
        limit: TAG_LIMIT,
        forgotten: evicted?.key ?? null,
        member: evicted?.discordId ?? null,
      })
    }

    // Built once rather than at each use, so the record written and the record
    // logged are the same record and cannot differ by a millisecond.
    const entry: TaggedBan = { key, discordId, expiresAt: ban.expiresAt, checkedAt: now() }

    tags.add(entry)

    if (!(await saveBook(tags))) {
      // The record did not stick, so the role must not go on: see the order above.
      tags.drop(key)
      tags.clean()
      return 'stop'
    }

    await putRoleOn(entry)
    return 'edited'
  }

  /**
   * Unmark somebody: the role FIRST, then the record.
   *
   * THE MIRROR IMAGE OF `mark`, AND THE SAME ARGUMENT READ BACKWARDS. Dropping the
   * record first and then failing to remove the role would leave a role nothing
   * remembers. This way the two failures are: role gone, record kept (the next
   * pass removes it again, gets `Unknown Member`, drops it — harmless), or both
   * gone (correct).
   *
   * THE RECORD IS NOT WRITTEN HERE. The caller flushes the book once at the end of
   * its pass, so a reconcile that drops six tags is one DynamoDB write rather than
   * six.
   */
  async function unmark(tags: Book, entry: TaggedBan): Promise<Step> {
    if (tags.othersFor(entry.discordId, entry.key)) {
      log('info', 'another game ban still stands for this account, so the role was kept', {
        key: entry.key,
        member: entry.discordId,
      })
      tags.drop(entry.key)
      return 'quiet'
    }

    if (!(await takeRoleOff(entry))) return 'quiet'

    tags.drop(entry.key)
    return 'edited'
  }

  /**
   * One ban key, decided from the ban row as it stands right now. Trap 1.
   *
   * THE AUDIT ROW'S OWN `outcome` IS NEVER CONSULTED, HERE OR ANYWHERE. It says
   * `pending` on every row this poller will ever see, and the ban row answers the
   * only question that matters — is this person banned, right now — for a failed
   * ban, a successful one and a lifted one alike.
   */
  async function settle(tags: Book, target: string, trigger: AuditAction): Promise<Step> {
    const read = await readBanRow(target)
    if (!read.ok) return 'stop'

    const { key, ban } = read
    const held = tags.find(key)
    const active = ban !== null && isBanActive(ban, now())

    if (ban === null && trigger === 'ban.issue') {
      /**
       * A BAN WAS ISSUED AND THERE IS NO BAN ROW. Either the console's write
       * failed — which is a real outcome and would leave the row at `failed` —
       * or the key in the audit log is not the key in the bans table and this
       * feature is marking nobody. `readBanRow` has already tried the other
       * shape, so this line is what is left, and it is a `warn` because the
       * second explanation is silent in every other way.
       */
      log('warn', 'a ban was issued but no ban row could be found for it', { key: target })
    }

    if (active && held === null) return mark(tags, key, ban)

    if (active && held !== null) {
      // Still standing, and already marked. The stored expiry is refreshed
      // because the console may have replaced the ban with a longer one, and
      // that is what orders the reconcile's queue.
      tags.refresh(key, ban.expiresAt, now())
      return 'quiet'
    }

    if (!active && held !== null) return unmark(tags, held)

    return 'quiet'
  }

  /* -------------------------------------------------------------- *
   * The cursor.
   * -------------------------------------------------------------- */

  async function saveCursor(at: number): Promise<void> {
    const written = await deps.ddb.botState.put(CURSOR_KEY, String(at))
    if (!written.ok) {
      // The work was done; only the bookmark was not. The next pass reads the
      // same window again, and every decision in it is idempotent.
      log('warn', 'the game-ban poll finished but its cursor could not be saved', {
        cursor: at,
        failure: written.failure.kind,
        detail: written.failure.message,
      })
    }
  }

  /* -------------------------------------------------------------- *
   * The passes.
   * -------------------------------------------------------------- */

  function check(): void {
    const standing = deps.roles.standing()

    if (standing.ok) {
      log('info', 'the game-ban role can be assigned', {})
      return
    }

    /**
     * `error` AND NOT `warn`, BECAUSE THE BOT CANNOT DO THE THING IT IS FOR. The
     * whole of blitz-bot#2 is putting one role on and taking it off; a role it
     * cannot touch is the feature being off with nothing in the guild to say so.
     * `error` is this bot's level for exactly that (src/log.ts), and it reaches
     * the status channel where the owner will see it.
     */
    log('error', ROLE_PROBLEM[standing.why], { role: 'game-ban' })
  }

  async function probe(): Promise<void> {
    const newest = await deps.ddb.auditWindow.newest()

    if (!newest.ok) {
      log('warn', 'could not read the audit log, so the game-ban poller is unverified', {
        partition: deps.ddb.auditWindow.partition,
        failure: newest.failure.kind,
        detail: newest.failure.message,
      })
      return
    }

    if (newest.value !== null) {
      log('info', 'the audit log is where the game-ban poller expects it', {
        partition: deps.ddb.auditWindow.partition,
        newest: newest.value.ts,
      })
      return
    }

    /**
     * TRAP 5, CAUGHT. An empty partition on a system that has been moderating for
     * months is the console having moved the log — `AUDIT#<yyyy-mm>` is what its
     * own note says it will move to — and the symptom of missing it is that this
     * poller returns zero rows forever with no error at any layer.
     */
    log('error', 'the audit partition holds no rows at all, so no game ban will be noticed', {
      partition: deps.ddb.auditWindow.partition,
    })
  }

  async function poll(): Promise<void> {
    const at = now()
    const until = at - SETTLE_MS

    const stored = await deps.ddb.botState.get(CURSOR_KEY)
    if (!stored.ok) {
      log('warn', 'could not read the game-ban poll cursor, so nothing was polled', {
        failure: stored.failure.kind,
        detail: stored.failure.message,
      })
      return
    }

    const raw = stored.value?.value ?? null
    const parsed = raw === null ? null : Number(raw)

    if (parsed === null || !Number.isFinite(parsed)) {
      /**
       * NO CURSOR MEANS START HERE, NOT START AT THE BEGINNING. Walking the whole
       * log would re-read months of triggers to arrive at the state the bans
       * table already holds, and it still would not tag anybody whose ban predates
       * the log — see `TAGS_KEY` on why there is no backfill at all. So the first
       * ever start records where it came in and marks bans from then on.
       */
      log(
        raw === null ? 'info' : 'warn',
        raw === null
          ? 'no game-ban poll cursor yet, so bans from now on will be marked and earlier ones will not'
          : 'the game-ban poll cursor is not a number, so polling restarts from now',
        { cursor: raw },
      )
      await saveCursor(until)
      return
    }

    const cursor = parsed

    const page = await deps.ddb.auditWindow.since(cursor, until, POLL_LIMIT)
    if (!page.ok) {
      log('warn', 'could not read the audit log, so no game ban was marked this pass', {
        partition: deps.ddb.auditWindow.partition,
        failure: page.failure.kind,
        detail: page.failure.message,
      })
      return
    }

    const rows = page.value

    if (rows.length === 0) {
      // Trap 5's continuous half. A quiet log is ordinary; a log that has been
      // quiet for a very long time is worth one question.
      if (at - lastRowAt >= PARTITION_SILENCE_MS) {
        lastRowAt = at
        await probe()
      }

      /**
       * THE CURSOR IS DELIBERATELY NOT MOVED OVER AN EMPTY WINDOW, and it costs
       * nothing to leave it where it is. The next pass asks about a WIDER window
       * with the same lower bound, which is a superset — so nothing can be
       * skipped by not writing — and a key-range query over a range with nothing
       * in it is one seek however wide the range is. Advancing anyway would be a
       * DynamoDB write every `POLL_MS` for the life of an idle bot, which is
       * thousands of writes a day to record that nothing happened.
       */
      return
    }

    lastRowAt = at

    const tags = await openBook()
    if (tags === null) return

    let edits = 0
    let reads = 0
    let advanced = cursor
    const decided = new Set<string>()

    for (const row of rows) {
      if (edits >= MAX_ROLE_EDITS || reads >= MAX_BAN_READS) break

      if (typeof row.ts !== 'number') {
        // The type says this cannot happen and the table is another repo's, so
        // it can. Stopping here rather than skipping keeps the cursor behind a
        // row we could not place — and a silent `break` is the exact kind of
        // quiet halt this whole file is written against.
        log('error', 'an audit row carries no sort key, so the game-ban poll stopped', {
          action: row.action,
        })
        break
      }

      if (!isBanTrigger(row)) {
        // Trap 2: `player.kick` and `incident.resolve` rows follow a ban and are
        // about the same person. Nothing here reads `detail.becauseOf`, because
        // nothing that is not one of the two verbs gets this far.
        advanced = row.ts
        continue
      }

      const target = row.targetLicense
      if (typeof target !== 'string' || target === '') {
        log('warn', 'a ban audit row names no target, so no role decision was made', {
          ts: row.ts,
          action: row.action,
        })
        advanced = row.ts
        continue
      }

      // One decision per key per pass. A re-ban and its lift in the same window
      // are two rows about one row in `ringmaster-bans`, and the ban row already
      // holds the answer both of them are asking about.
      if (decided.has(target)) {
        advanced = row.ts
        continue
      }
      decided.add(target)
      reads++

      const step = await settle(tags, target, row.action)
      if (step === 'stop') break
      if (step === 'edited') edits++

      advanced = row.ts
    }

    /**
     * THE CURSOR MOVES ONLY OVER WORK THAT WAS ACTUALLY RECORDED. Every drop this
     * pass made lives in that one write; if it did not land, the decisions behind
     * it are not durable, and a cursor moved past them would mean re-deriving
     * them never happens. Repeating the window is free — every decision in it is
     * idempotent — so the strict order is the cheap one.
     */
    if (!(await saveBook(tags))) return
    if (advanced > cursor) await saveCursor(advanced)
  }

  async function reconcile(): Promise<void> {
    const tags = await openBook()
    if (tags === null) return
    if (tags.all().length === 0) return

    const at = now()
    const worklist = dueFirst(tags.all(), at).slice(0, RECONCILE_READS)

    let edits = 0

    for (const entry of worklist) {
      if (edits >= MAX_ROLE_EDITS) break

      const read = await deps.ddb.bans.get(entry.key)
      if (!read.ok) {
        // The pass stops rather than skipping ahead: a table that is not
        // answering makes every remaining answer a guess, and the entries left
        // unchecked keep their place at the front of the queue.
        log('warn', 'could not re-read a ban row, so the reconcile stopped', {
          key: entry.key,
          failure: read.failure.kind,
          detail: read.failure.message,
        })
        break
      }

      const ban = read.value

      if (ban !== null && isBanActive(ban, at)) {
        tags.refresh(entry.key, ban.expiresAt, at)
        continue
      }

      /**
       * TRAP 3, CAUGHT. A ban that expired wrote nothing anywhere — there is no
       * `ban.expire` verb and no process that would write one — so this read is
       * the only thing in the system that will ever notice. A ban lifted while
       * the poller was blind arrives here too, by the same road.
       */
      log('info', 'a game ban has ended, so its role is coming off', {
        key: entry.key,
        member: entry.discordId,
        expired: ban !== null,
      })

      const step = await unmark(tags, entry)
      if (step === 'edited') edits++
    }

    await saveBook(tags)
  }

  /**
   * Somebody joined. Mark them if a game ban stands.
   *
   * THE ROLE IS RE-APPLIED EVEN WHEN THE TAG IS ALREADY THERE, and that is the
   * case this whole listener exists for. Leaving a guild strips every role; a
   * banned player who leaves and rejoins arrives unmarked while the bot's record
   * says otherwise, so a "do we already know about them" shortcut here would make
   * rejoining the way to shed the role.
   *
   * TWO KEYS, AND THEY ARE THE ONLY TWO A BAN CAN BE UNDER FOR ONE ACCOUNT: the
   * license they play on, and their `discord:` identifier. That is the same pair
   * `mirrorEntry` checks on an unban in src/client.ts, bounded the same way and
   * for the same reason — the reverse index can hold several licenses and only the
   * most recent is ever written to.
   */
  async function join(discordId: string): Promise<void> {
    if (!SNOWFLAKE.test(discordId)) return

    const found = await deps.ddb.playerIds.licensesFor(qualifyId('discord', discordId))
    if (!found.ok) {
      log('warn', 'could not read the identifier index, so a joining member was not checked', {
        member: discordId,
        failure: found.failure.kind,
        detail: found.failure.message,
      })
      return
    }

    const keys = [...new Set([found.value.at(-1), qualifyId('discord', discordId)])].filter(
      (key): key is string => key !== undefined,
    )

    const tags = await openBook()
    if (tags === null) return

    for (const key of keys) {
      const read = await deps.ddb.bans.get(key)
      if (!read.ok) {
        log('warn', 'could not read a ban row, so a joining member was not fully checked', {
          member: discordId,
          key,
          failure: read.failure.kind,
          detail: read.failure.message,
        })
        break
      }

      const ban = read.value
      if (ban === null || !isBanActive(ban, now())) continue

      const held = tags.find(key)
      if (held === null) {
        tags.add({ key, discordId, expiresAt: ban.expiresAt, checkedAt: now() })
        if (!(await saveBook(tags))) break
      }

      await putRoleOn({ key, discordId, expiresAt: ban.expiresAt, checkedAt: now() })
    }

    await saveBook(tags)
  }

  /**
   * A ban an admin has just lifted by hand: take the role off, and forget it.
   *
   * ═══ WHY /unban COMES THROUGH HERE RATHER THAN CALLING `roles.remove` ═══
   *
   * The owner's instruction, and it is the whole reason this method exists:
   * "reuse banrole's own untag path so the role and the bot's tag record stay in
   * step — do not remove the role behind banrole's back or its book will think
   * the role is still on." A command that took the role off directly would leave
   * a tag in `game-ban-role-tags` for a ban that is no longer in force, and the
   * next reconcile would notice the ban had ended, try to remove a role that is
   * already gone, get `Unknown Member` or nothing at all, and drop the tag —
   * harmless in the ordinary case and wrong in the one that matters, because
   * between the two the book asserts a restriction that is not there.
   *
   * `unmark` IS THE PATH, UNCHANGED, so this inherits the two rules that are
   * easy to get wrong from outside: the role comes off BEFORE the record does
   * (the mirror image of `mark`, so the failure modes are "role gone, record
   * kept" and never "record gone, role kept"), and `othersFor` keeps the role on
   * an account that is tagged for a SECOND game ban that still stands. That
   * second rule is why this takes a LIST of keys: an account can be banned under
   * its license and under `discord:<id>` both, /unban lifts both, and asking
   * about them one at a time in two separate books would let the first call
   * decide the role must stay because of a tag the second call was about to
   * drop.
   *
   * NOTHING HERE READS OR WRITES A BAN ROW. The lift is the caller's, through
   * `ddb.bans.lift`, and `BanRoleDeps` deliberately cannot write to
   * `ringmaster-bans` at all — see there. This method is downstream of a
   * decision somebody else has already recorded.
   *
   * THE BOOK IS OPENED FRESH FROM DYNAMODB, exactly as every other pass does, so
   * a second `BanRoleSync` built by a command and the background one built at
   * boot cannot hold two divergent copies of the same row.
   */
  async function release(keys: readonly string[]): Promise<ReleaseOutcome> {
    const tags = await openBook()
    if (tags === null) return 'failed'

    const held = keys
      .map((key) => tags.find(key))
      .filter((entry): entry is TaggedBan => entry !== null)

    if (held.length === 0) return 'not-tagged'

    let cleared = false
    let kept = false
    let broke = false

    for (const entry of held) {
      /**
       * ASKED BEFORE `unmark` RATHER THAN INFERRED FROM ITS ANSWER. `unmark`
       * returns `quiet` for two different things — "another ban holds the role"
       * and "the edit did not go through" — and those are opposite sentences to
       * an admin. The book already knows which one this is, so it is asked.
       */
      const others = tags.othersFor(entry.discordId, entry.key)
      const step = await unmark(tags, entry)

      if (others) kept = true
      else if (step === 'edited') cleared = true
      else broke = true
    }

    if (!(await saveBook(tags))) broke = true

    // WORST FIRST. A run that both cleared one tag and failed on another has not
    // finished, and reporting the half that worked would tell an admin the role
    // is off somebody it is still on.
    if (broke) return 'failed'
    if (cleared) return 'cleared'

    return kept ? 'kept' : 'not-tagged'
  }

  return {
    check,
    probe,
    poll,
    reconcile,
    join,
    release,
    stats: () => ({ tagged, cleared, failed, blocked, lastFailureAt }),
  }
}

/* ------------------------------------------------------------------ *
 * Wiring.
 * ------------------------------------------------------------------ */

/**
 * Wire the game-ban role onto the gateway.
 *
 * NO OFF SWITCH, THE SAME AS #16 AND FOR THE SAME REASON. This is not a thing the
 * bot SAYS, so there is no channel id to hang it off; it is the bot carrying a
 * decision an admin already made in the console into the guild. The role id has a
 * default rather than an absence (src/config.ts), and everything that can go wrong
 * with it is reported rather than switched off.
 *
 * THE GUILD IS CHECKED ON EVERY JOIN. One guild is a fact about today's invite
 * list and not a property of the process.
 *
 * BOTH TIMERS ARE UNREF'D AND GUARDED AGAINST RE-ENTRY, exactly as
 * `watchMaintenance` is: a pass that is still running must not have a second one
 * started on top of it, and a pending timer must not be the thing that keeps the
 * process alive through a shutdown.
 */
export function installGameBanRole(
  client: Client,
  config: Config,
  ddb: BanRoleDeps['ddb'],
  options: {
    pollMs?: number
    reconcileMs?: number
    sync?: BanRoleSync
  } = {},
): void {
  const sync =
    options.sync ??
    createBanRoleSync({
      ddb,
      roles: guildRoles(client, config.guildId, config.gameBanRoleId),
    })

  /**
   * The join queue: one at a time, with a bounded backlog. See `JOIN_BACKLOG`.
   *
   * SERIAL RATHER THAN PARALLEL, because two joins can be about one ban row and
   * because a raid arriving as fifty concurrent DynamoDB reads is how a background
   * feature becomes the reason a slash command times out.
   */
  const pending: string[] = []
  let draining = false

  async function drain(): Promise<void> {
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      const member = next
      await sync.join(member).catch((error: unknown) => {
        // `join` is written not to throw; this is the guarantee that it did.
        log('error', 'the game-ban join check threw', { member, error })
      })
    }
  }

  client.on(Events.GuildMemberAdd, (member) => {
    if (member.guild.id !== config.guildId) return

    if (pending.length >= JOIN_BACKLOG) {
      log('warn', 'too many joins at once, so this one was not checked for a game ban', {
        member: member.id,
        backlog: pending.length,
      })
      return
    }

    pending.push(member.id)
    if (draining) return

    draining = true
    void drain().finally(() => {
      draining = false
    })
  })

  client.once(Events.ClientReady, () => {
    // Loud and first: everything below is pointless if the role cannot be moved.
    sync.check()

    void sync.probe().catch((error: unknown) => {
      log('warn', 'the game-ban audit probe failed', { error })
    })

    const start = (run: () => Promise<void>, everyMs: number, what: string): void => {
      let running = false

      const tick = (): void => {
        if (running) return
        running = true

        void run()
          .catch((error: unknown) => {
            // Both passes are written not to throw. The `finally` below is the
            // structural guarantee that an edit which makes one of them throw
            // cannot latch `running` on and stop the loop for the life of the
            // process.
            log('error', 'a game-ban role pass threw', { pass: what, error })
          })
          .finally(() => {
            running = false
          })
      }

      const timer = setInterval(tick, everyMs)
      timer.unref()
      tick()
    }

    start(() => sync.poll(), options.pollMs ?? POLL_MS, 'poll')
    start(() => sync.reconcile(), options.reconcileMs ?? RECONCILE_MS, 'reconcile')
  })
}
