import type { AuditRow, AuditWindow, Ddb } from './ddb.ts'
import { log } from './log.ts'

/* ------------------------------------------------------------------ *
 * ONE WALK OVER `ringmaster-audit`, SHARED BY EVERY CONSUMER OF IT.
 * ------------------------------------------------------------------ */

/**
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * src/banrole.ts AND src/incidents.ts HELD THE SAME FORTY LINES TWICE. Read the
 * cursor out of `ringmaster-bot-state`; decide what an absent or unparseable
 * value means; ask `auditWindow.since` for one bounded page ending a settle
 * window short of now; give up loudly if that read failed; return without
 * writing if the window was empty; walk the rows oldest-first accumulating how
 * far the cursor may move; refuse to place a row with no sort key; write the
 * cursor at the end. Only the strings, the key and what happens to each row
 * differed.
 *
 * A THIRD CONSUMER IS ALREADY SPECIFIED. blitz-bot#19 wants a post when a case
 * OPENS as well, and that half arrives as soon as fivem-ringmaster#46 lands the
 * GSI it needs. Extracting after there are three copies means fixing every bug
 * found in this walk three times, in three files, and the two that have already
 * been found here — a cursor moved over a row nobody dealt with, and a silent
 * `break` on a row that could not be placed — are exactly the kind that get
 * fixed in one copy and left in the others.
 *
 * ═══ WHAT IS DELIBERATELY NOT IN HERE ═══
 *
 * ANY OPINION ABOUT WHAT A ROW MEANS. This file does not know what a ban is or
 * what an incident is; it does not read `action`, `detail`, `outcome` or
 * `targetLicense`. It hands each row to its consumer and does exactly what the
 * consumer's answer tells it to. The moment it grows a filter, the two callers
 * start sharing a decision instead of a mechanism.
 *
 * THE PARTITION-SILENCE PROBE. Only src/banrole.ts has one, deliberately — one
 * fault should not become two messages in the status channel — so it is an
 * `onEmpty` hook rather than a feature here. See trap 5 in that file.
 *
 * ANYTHING THAT WRITES AN AUDIT ROW. The `Pick` below can read the audit stream
 * and read and write `ringmaster-bot-state`; it cannot write an audit row, and
 * neither consumer can gain that ability through this file.
 *
 * THAT IS THE WHOLE TABLE AND NOT ONE ROW, WHICH THIS COMMENT USED TO CLAIM. It
 * said "the ONE bot-state row named by `cursorKey`", and `Pick<Ddb, 'botState'>`
 * grants no such thing — `botState.get`/`put` take a key, so the type hands over
 * every row in `ringmaster-bot-state` and it is this function's discipline, not
 * the compiler's, that only ever touches `spec.cursorKey`. The other rows are
 * `game-ban-role-tags` (src/banrole.ts) and `discord-audit-cursor`
 * (src/client.ts); an access policy stated in a comment that the type does not
 * enforce is the kind that gets believed and then relied on.
 */

/**
 * How often a consumer polls the audit log.
 *
 * THE SAME HALF-MINUTE FOR BOTH CONSUMERS, AND FOR TWO DIFFERENT REASONS THAT
 * ARRIVE AT THE SAME NUMBER. The ban role is measured against how long a banned
 * player should go unmarked; the incident record is not on the path of
 * enforcement at all — the case is already closed in the console when the row is
 * written — and is measured against an admin closing a case and looking at the
 * channel. Half a minute satisfies both, and an idle bot makes two DynamoDB
 * reads a minute per consumer.
 */
export const POLL_MS = 30_000

/**
 * How far behind the clock a poll stops reading.
 *
 * TWO CLOCKS, ONE NUMBER. An audit row is written BEFORE the ban row it
 * describes, so the newest rows are intents whose consequences have not landed;
 * a reader that treated one as a trigger and found no ban would read that as
 * "the ban failed", move past it, and never mark that ban. And `nextTs` in
 * src/ddb.ts steps a colliding write forward by a millisecond, so a burst can
 * stamp a row slightly AHEAD of the wall clock. Five seconds is one DynamoDB
 * round trip and thousands of collisions of headroom.
 *
 * THE TWO CLOCKS ARE THE SAME CLOCK TODAY. The console and the bot are two
 * processes on one box (docs/deploy.md). If the bot is ever moved off it, this
 * number has to cover the skew between them as well.
 */
export const SETTLE_MS = 5_000

/**
 * How much of the audit log one poll may pull back.
 *
 * A BOUND AND NOT A CAPACITY. A caught-up poller reads a handful of rows a day;
 * this number only matters after an outage, and there it is the answer to "how
 * much are we willing to spend catching up in one pass". Passes repeat every
 * `POLL_MS` and the cursor advances over what was actually dealt with, so a long
 * backlog is drained across passes rather than in one.
 *
 * THE PER-CONSUMER BUDGETS ARE NOT FOLDED IN HERE, AND THAT IS NOT AN
 * OVERSIGHT. `MAX_BAN_READS` and `MAX_INCIDENT_READS` happen to be 25 and
 * `MAX_ROLE_EDITS` and `MAX_POSTS` happen to be 10, but they count different
 * things against different limits — DynamoDB reads of two different tables, and
 * Discord's per-route rate limits on two different routes. One name for two
 * numbers that agree by coincidence is how a change to one of them silently
 * changes the other.
 */
export const POLL_LIMIT = 50

/**
 * The furthest ahead of the epoch a stamp in this log may be — 2100-01-01, in
 * milliseconds.
 *
 * ═══ IT IS ABOUT THE FEED GOING SILENT, AND NOT ABOUT WHAT A `Date` HOLDS ═══
 *
 * A SORT KEY BECOMES A BOOKMARK, WHICH IS WHY A RANGE IS NEEDED WHERE A TYPE
 * CHECK USED TO DO. The row guard below was `typeof row.ts !== 'number'`, and
 * `typeof NaN` is `'number'`: `NaN` passed it, the row was dealt with, `advanced`
 * became `NaN` and `saveCursor` wrote the literal string `'NaN'` into
 * `ringmaster-bot-state`. The next pass read it back, `cursorAt` answered `null`,
 * the walk restarted from now, and every row between the two passes was skipped
 * and never looked at again. One `cursorUnusable` line, and then silence.
 *
 * AND `1e18` WAS WORSE, BECAUSE NOTHING REFUSED IT AT EITHER END. It was written
 * as `'1000000000000000000'`, and `cursorAt` — positive, finite, a string —
 * accepted it back as a bookmark on every later pass. `auditWindow.since` was
 * then asked for `(1e18, now - SETTLE_MS]`, a range whose lower bound is past
 * its upper bound, which is empty however long the bot runs. The feed stopped
 * permanently with NO line at all, in either direction.
 *
 * WHY A HORIZON RATHER THAN `Date`'S ±8.64e15. That range is about what can be
 * rendered; this one is about what can be a clock reading in a log the console
 * stamps with `Date.now()`. Every value that has actually gone wrong here is a
 * number that stopped being a time — `NaN`, both infinities, `1e18`,
 * `Number.MAX_SAFE_INTEGER`, a negative — and all of them are far outside any
 * horizon a person would pick. 2100 is well past anything this bot will see and
 * well short of all of them: it is a sanity bound on a borrowed number, not a
 * date limit on the program.
 */
export const MAX_STAMP = 4_102_444_800_000

/**
 * Is this a position in the log — a millisecond stamp, and not a broken number?
 *
 * ONE RULE FOR THE SORT KEY AND FOR THE BOOKMARK, BECAUSE THEY ARE THE SAME
 * NUMBER. `saveCursor` writes a row's `ts` and `cursorAt` reads that same value
 * back on the next pass, so a guard on one side and not the other is exactly how
 * `'NaN'` and `'1000000000000000000'` got into `ringmaster-bot-state`: refused as
 * a bookmark, admitted as a sort key, and written as a bookmark by this file.
 *
 * `> 0` AND `<= MAX_STAMP` SUBSUME FINITENESS RATHER THAN LOSING IT. `NaN` is
 * neither greater than nor less than anything, `Infinity` fails the upper bound
 * and `-Infinity` fails the lower, so the `Number.isFinite` test this replaces is
 * not dropped — it is implied by both comparisons, the same way `Math.abs` covers
 * the three of them in src/incidents.ts.
 */
function placeable(ts: unknown): ts is number {
  return typeof ts === 'number' && ts > 0 && ts <= MAX_STAMP
}

/**
 * The stored bookmark as a place in the log, or `null` for "there isn't one".
 *
 * ═══ WHAT THIS REPLACED, AND WHAT IT COST ═══
 *
 * IT WAS `raw === null ? null : Number(raw)` GUARDED BY `!Number.isFinite`, AND
 * AN EMPTY STRING WENT STRAIGHT PAST IT. `Number('')` is `0`, `0` is finite, so
 * a bot-state row holding `''` was not "no cursor, start from now" — it was a
 * cursor at the epoch, and the very next line asked `auditWindow.since(0, …)`
 * for the whole audit log. The incident poller then posted the ten OLDEST closed
 * cases into the moderation channel and ten more every half minute until it
 * caught up. That is the loudest failure this feature has and it needed no
 * attacker, no outage and no bad deploy: one row with an empty value.
 *
 * ═══ WHY IT IS A LIST OF VALUES AND NOT A TIGHTER `Number()` ═══
 *
 * `BotStateRow.value` IS TYPED `string` AND THE TYPE IS A CLAIM, NOT A FACT. The
 * accessor in src/ddb.ts reads the item and casts — `res.Item as BotStateRow` —
 * over a table docs/aws-notes.md says was created by hand, so what actually
 * arrives here is whatever is in that attribute. Run through `Number()`, every
 * one of these is a finite number: `''` → 0, `' '` → 0, `'0'` → 0, a DynamoDB
 * boolean `false` → 0, `true` → 1, an empty list → 0, and a one-element list
 * `[5]` → 5. Six shapes and a typo all fold to a position in 1970.
 *
 * SO THE RULE IS A POSITION IN THE LOG, SPELLED AS A STRING. A cursor is a
 * millisecond stamp written by `saveCursor` and nothing else; this system did
 * not exist in 1970, so `0` is not a bookmark somebody left — it is the absence
 * of one, arrived at by arithmetic. Anything that is not a position means "no
 * cursor", which lands on the branch that starts from now and
 * says so, and the worst case of getting THAT wrong is one pass that records
 * where it came in rather than a channel full of ancient cases.
 *
 * AND THE BOUND AT THE TOP IS THE SAME FAILURE READ THE OTHER WAY ROUND. Being
 * too far back fills a channel; being too far FORWARD empties it and says
 * nothing. `pollAuditWindow` asks `auditWindow.since` for
 * `(cursor, now - SETTLE_MS]`, so a bookmark ahead of the clock is not a
 * position that will be reached in a moment — it is a range with nothing in it,
 * on this pass and on every pass after it. `'1000000000000000000'` is positive,
 * finite and a string, and it silenced the feed for the life of the process
 * without one line in the status channel. See `placeable` and `MAX_STAMP`.
 *
 * `typeof raw !== 'string'` FIRST AND IT IS LOAD-BEARING. `Number([5])` is `5`,
 * so without it a one-element list smuggles a bookmark through a check about
 * numbers. Mutation-tested: removing this line alone puts the walk back at an
 * arbitrary position in the log.
 *
 * AND THERE IS NO `.trim()` HERE, WHICH IS WORTH A LINE BECAUSE THE FIRST DRAFT
 * HAD ONE. It was written with a `raw.trim()` and an `if (text === '')` in front
 * of the `Number`, and both were dead: `Number` already skips leading and
 * trailing whitespace, so `' 5 '` is `5` without help, and `''` and `' '` both
 * come out as `0` and are refused by the positive test below rather than by an
 * empty check. A mutation that deleted the trim changed no test — which is what
 * a dead guard looks like — so it is gone rather than kept with a comment
 * claiming it does something.
 */
export function cursorAt(raw: unknown): number | null {
  if (typeof raw !== 'string') return null

  const value = Number(raw)
  return placeable(value) ? value : null
}

/**
 * What a consumer decided about one row.
 *
 * `stop` IS THE ONE THAT CARRIES THE INVARIANT. It means the row was NOT dealt
 * with, so the walk ends and the cursor stays behind it and the next pass sees
 * it again. Every "could not read", "could not post", "could not save" path in
 * both consumers answers `stop`, which is what makes a transient failure a retry
 * rather than a hole in a permanent record.
 *
 * `persist` IS `done` PLUS DURABILITY, AND IT IS FOR WORK THAT CANNOT BE UNDONE.
 * A pass may post up to ten moderation records and a crash or a deploy restart
 * between the last one and a single write at the end would replay every one of
 * them into the channel. Answering `persist` writes the cursor before the next
 * row is looked at, so a restart resumes after the last record actually POSTED
 * rather than after the last completed pass. It costs one small write per record
 * and buys the difference between one duplicate and ten. A `persist` WRITE THAT
 * DOES NOT LAND ENDS THE WALK, for the same reason it exists at all — see
 * `saveCursor`.
 *
 * `done` IS FOR EVERYTHING IDEMPOTENT. A row that was filtered out, a decision
 * that changed nothing, a role edit that can be made twice with the same result:
 * the cursor moves over it in memory and one write at the end covers the lot.
 */
export type RowStep = 'done' | 'persist' | 'stop'

/** Everything the walk needs from the world. Read the stream, move one bookmark. */
export interface AuditPollDeps {
  readonly ddb: Pick<Ddb, 'botState'> & { readonly auditWindow: AuditWindow }
  readonly now: () => number
}

/**
 * The sentences one consumer says. Seven lines, in one object, per consumer —
 * six required and the seventh optional, for the reason it gives.
 *
 * SEPARATE STRINGS RATHER THAN ONE TEMPLATED SENTENCE WITH THE CONSUMER'S NAME
 * SUBSTITUTED IN. Every one of these is grepped for verbatim by a test, and SIX
 * OF THE SEVEN reach the owner's status channel — where "the game-ban poll" and
 * "the incident poll" are the two things he actually needs told apart. A
 * generated `the ${what} poll …` would make both of those a match for neither.
 *
 * SIX AND NOT THREE, WHICH IS WHAT THIS SAID AND IS CHECKABLE EITHER WAY.
 * `report` in src/log.ts is called on every level that is not `info`, so every
 * `warn` and every `error` here goes to the sink: only `noCursorYet` stays out
 * of the channel, and it is the one line that is not about something going
 * wrong.
 */
export interface AuditPollMessages {
  /** The cursor row could not be read, so nothing was polled. `warn`. */
  readonly cursorUnreadable: string
  /** There is no cursor at all: the first ever start. `info`. */
  readonly noCursorYet: string
  /**
   * There is a stored value and it is not a place in the log, so the pass
   * restarts from now. `warn`. See `cursorAt` for what that covers.
   *
   * IT IS NOT NAMED `cursorNotANumber` ANY MORE, AND THE SENTENCES CHANGED WITH
   * IT. `''`, `' '` and `'0'` all reach this branch now, and the last of those
   * plainly IS a number — a line in the owner's status channel telling him it is
   * not would be the same class of confident-and-wrong statement the rest of
   * this change is undoing. What is rejected is a POSITION, not a numeral.
   */
  readonly cursorUnusable: string
  /** The audit window could not be read, so this pass did nothing. `warn`. */
  readonly windowUnreadable: string
  /** The work was done and the bookmark was not. `warn`. */
  readonly cursorUnsaved: string
  /** A row arrived with no sort key, so the walk stopped. `error`. */
  readonly rowWithoutSortKey: string

  /**
   * One of this consumer's own hooks threw. `error`. See `CONSUMER_THREW`.
   *
   * THE ONE OPTIONAL SENTENCE, AND IT IS OPTIONAL FOR A REASON THAT IS NOT
   * STYLE. The other six are required because every consumer has always had to
   * say them; this one was added underneath two consumers that were already
   * written, and a required field would make wording it a condition of
   * compiling rather than of being understood. `CONSUMER_THREW` is what a
   * consumer that has not written its own gets, and `hook` and `cursor` are on
   * the line either way — so the fault is never anonymous, only less well
   * worded. A consumer that reaches the owner's status channel should say its
   * own sentence here, for the reason this whole interface exists.
   */
  readonly consumerThrew?: string
}

/**
 * What the walk says when a consumer's hook throws and it has no sentence.
 *
 * DELIBERATELY NAMES NEITHER CONSUMER, because a generic line pretending to be
 * a specific one is worse than a generic line. The structured `cursor` field
 * carries which poll it was.
 */
const CONSUMER_THREW = 'a consumer of the audit walk threw, so the walk stopped there'

/** What one consumer plugs into the walk. */
export interface AuditPollSpec {
  /** The bot-state row this consumer's place is kept in. Never shared. */
  readonly cursorKey: string
  readonly messages: AuditPollMessages

  /**
   * Is there room in this pass for another row?
   *
   * ASKED BEFORE EACH ROW AND NOT AFTER, so a pass that has spent its budget
   * stops with the cursor on the last row it dealt with rather than one past it.
   * Absent means unbounded, which no consumer today is.
   */
  readonly room?: () => boolean

  /** Nothing in the window. The pass is over; nothing has been written. */
  readonly onEmpty?: (at: number) => Promise<void> | void

  /**
   * Rows arrived, before any of them is looked at. Answering false abandons the
   * pass without moving the cursor — src/banrole.ts uses it for a tag list it
   * could not read, where every decision below would be made against nothing.
   */
  readonly onRows?: (at: number) => Promise<boolean> | boolean

  /** One row. See `RowStep`. */
  readonly onRow: (row: AuditRow) => Promise<RowStep>

  /**
   * The walk is over and the cursor is about to be written. Answering false
   * leaves it where it was — src/banrole.ts uses it for the one write that
   * makes this pass's decisions durable, because a cursor moved past decisions
   * that did not stick is a pass that will never make them again.
   */
  readonly onFinish?: () => Promise<boolean> | boolean
}

/**
 * WHERE EACH CONSUMER FIRST FOUND NO CURSOR, until that fact is written down.
 *
 * ═══ THE GAP THIS CLOSES, WHICH IS FIRST-START ONLY AND IS STILL REAL ═══
 *
 * THE NO-CURSOR BRANCH RECORDS WHERE IT CAME IN AND RETURNS, and it used to
 * record the CURRENT clock every time it ran. So a `botState.put` that fails on
 * the very first pass is not one lost write: the next pass finds no cursor
 * again, records the THEN-current instant, and every case closed in between is
 * behind the bookmark the moment one finally lands. Nothing ever goes back for
 * it. A minute of failing writes is a minute of moderation records that will
 * never be posted, and the only trace is the `cursorUnsaved` line — which says
 * a bookmark did not land, not that a window was skipped.
 *
 * SO THE INSTANT IS FIXED ON THE FIRST PASS AND REUSED. Every later pass that
 * still finds no cursor writes THAT mark rather than a fresh one, so a run of
 * failed writes costs nothing once one succeeds. The entry is deleted the
 * moment it does, which is the only way it is ever emptied.
 *
 * PER PROCESS AND PER CONSUMER, AND IT DELIBERATELY DOES NOT SURVIVE A RESTART,
 * for the reason src/incidents.ts gives about its own two bounds: a mark
 * written to DynamoDB is a mark that outlives the reason for it. A bot that
 * restarts before any write lands starts from its new arrival time, which is
 * the same answer a genuinely first start gives — there is no bookmark anywhere
 * and nothing to be behind.
 *
 * KEYED BY `cursorKey`, so the two consumers can neither share nor clear each
 * other's mark, and it holds at most one entry per consumer — and only while
 * that consumer has a first-start write outstanding, which is the rarest state
 * this file has.
 */
const firstStart = new Map<string, number>()

/**
 * The walk. Never throws; every failure is a line and a return.
 *
 * AND THAT FIRST SENTENCE IS NOW TRUE OF THE CONSUMER'S CODE TOO. It was a
 * promise about this file only: `onRows`, `onRow` and `onFinish` were awaited
 * bare, so a `TypeError` in a consumer — over a value off another repository's
 * row, which is what both consumers spend their time on — came straight out of
 * here. What that cost is not the throw, it is what the throw SKIPPED: the
 * `onFinish` flush that makes a consumer's own decisions durable, and the
 * cursor write covering every row the pass had already dealt with. One bad row
 * therefore undid a whole pass's work rather than just its own. Every hook is
 * wrapped now, and a hook that throws is read as the most conservative answer
 * it could have given — see `guarded`.
 *
 * OLDEST FIRST AND EXACTLY ONCE. `auditWindow.since` answers `(cursor, until]`
 * ordered by the sort key, and `ts` is half the primary key, so consecutive
 * passes see every row exactly once and never twice — provided the cursor only
 * ever moves over rows a consumer said it dealt with. That proviso is the whole
 * of this function.
 */
export async function pollAuditWindow(deps: AuditPollDeps, spec: AuditPollSpec): Promise<void> {
  const at = deps.now()
  const until = at - SETTLE_MS

  /**
   * Write the bookmark. `false` means it did not land.
   *
   * EVERY CALLER TREATS `false` AS THE END OF THE PASS, and the one that matters
   * is the `persist` write inside the walk. `ringmaster-bot-state` not answering
   * does not stop this process from posting: without this the pass carries on
   * through all ten records with all ten bookmarks failing, and the next pass —
   * reading a cursor that never moved — replays every one of them into the
   * channel. That is the exact replay `persist` exists to prevent, so a bookmark
   * that did not land ends the walk. The records already sent are already sent;
   * going on only widens the replay.
   */
  /**
   * Run one of the consumer's hooks; answer `whenItThrows` if it threw.
   *
   * ═══ WHY A THROW IS AN ANSWER AND NOT A RETHROW ═══
   *
   * THIS FUNCTION HAS ONE PROMISE AND A RETHROW BREAKS IT. The walk's caller is
   * a `setInterval` tick in each consumer's wiring, so a rejection there is a
   * line and nothing else — the cursor unwritten, `onFinish` unrun, and the
   * pass's completed work re-done on the next pass. The hooks are the only code
   * in this file that this file did not write, and they are the ones handling
   * another repository's rows.
   *
   * EACH FALLBACK IS THE MOST CONSERVATIVE THING THE HOOK COULD HAVE SAID, and
   * they are chosen rather than defaulted. `onRow` gets `stop`, which means the
   * row was NOT dealt with, so the cursor stays behind it and the next pass sees
   * it again — the same answer every "could not read" and "could not post" path
   * in both consumers gives, and the one that cannot lose a record. `onRows` and
   * `onFinish` get `false`, which abandons the pass and leaves the bookmark
   * where it was. `room` gets `false`, which ends the walk with the cursor on
   * the last row actually dealt with. Not one of them advances the cursor over
   * anything.
   *
   * IT IS `error` AND NOT `warn`. A consumer hook throwing is a bug in this
   * process, not a table declining to answer, and the owner's status channel is
   * where the difference between "AWS was slow" and "the bot is broken" has to
   * be visible.
   */
  async function guarded<T>(hook: string, whenItThrows: T, run: () => T | Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      log('error', spec.messages.consumerThrew ?? CONSUMER_THREW, {
        cursor: spec.cursorKey,
        hook,
        error,
      })
      return whenItThrows
    }
  }

  async function saveCursor(to: number): Promise<boolean> {
    const written = await deps.ddb.botState.put(spec.cursorKey, String(to))
    if (!written.ok) {
      // The work was done; only the bookmark was not. The next pass reads the
      // same window again — which is why every consumer's decisions have to be
      // idempotent, and is why this is reported rather than swallowed.
      log('warn', spec.messages.cursorUnsaved, {
        cursor: to,
        failure: written.failure.kind,
        detail: written.failure.message,
      })
      return false
    }
    return true
  }

  const stored = await deps.ddb.botState.get(spec.cursorKey)
  if (!stored.ok) {
    log('warn', spec.messages.cursorUnreadable, {
      failure: stored.failure.kind,
      detail: stored.failure.message,
    })
    return
  }

  // `unknown`, deliberately, and the cast in src/ddb.ts is why: the attribute is
  // typed `string` and the table is hand-made, so the type is a claim about what
  // was written and not a check on what came back. `cursorAt` is the check.
  const raw: unknown = stored.value?.value ?? null
  const cursor = cursorAt(raw)

  if (cursor === null) {
    /**
     * NO CURSOR MEANS START HERE, NOT START AT THE BEGINNING, AND THAT IS BOTH
     * CONSUMERS' IDEMPOTENCE STORY IN ONE BRANCH. The bot restarts on every
     * deploy and every crash; a poller that began at the start of the log would
     * re-derive months of triggers to arrive at a state the console's own tables
     * already hold, and — for the consumer that posts — would re-announce every
     * closed case into the moderation channel each time. The cursor is what makes
     * a restart resume, and this branch is only ever taken ONCE, on the first
     * start after a consumer ships, where it records where it came in and does
     * nothing else.
     *
     * THE COST IS STATED RATHER THAN HIDDEN: whatever happened before that first
     * start is never acted on. There is no backfill and there should not be one.
     *
     * IT IS NO LONGER ONLY REACHED ONCE, WHICH IS THE POINT OF THE REWRITE.
     * `''`, `' '`, `'0'`, a boolean and a list all arrive here now instead of
     * folding to a bookmark at the epoch, and each of them is a `warn` naming
     * the value — the difference between one line in the status channel and a
     * moderation channel filling with cases from the day the console shipped.
     *
     * AND THE MARK IS THE FIRST PASS'S, NOT THIS PASS'S, WHENEVER A WRITE IS
     * STILL OUTSTANDING. See `firstStart`: this branch returns without walking
     * anything, so getting it wrong is not a lost write but a silently skipped
     * window.
     */
    const from = firstStart.get(spec.cursorKey) ?? until
    firstStart.set(spec.cursorKey, from)

    log(
      raw === null ? 'info' : 'warn',
      raw === null ? spec.messages.noCursorYet : spec.messages.cursorUnusable,
      { cursor: raw, from },
    )

    if (await saveCursor(from)) firstStart.delete(spec.cursorKey)
    return
  }

  /** Where the bookmark stands in the table right now. */
  let saved = cursor

  const page = await deps.ddb.auditWindow.since(cursor, until, POLL_LIMIT)
  if (!page.ok) {
    log('warn', spec.messages.windowUnreadable, {
      partition: deps.ddb.auditWindow.partition,
      failure: page.failure.kind,
      detail: page.failure.message,
    })
    return
  }

  const rows = page.value

  // Every hook, read once, held as a local. `guarded` takes a closure, and a
  // closure over `spec.onRow?.()` is one the compiler cannot see is defined —
  // so they are narrowed here rather than at five call sites.
  const { onEmpty, onRows, onRow, onFinish, room } = spec

  /**
   * THE CURSOR IS DELIBERATELY NOT MOVED OVER AN EMPTY WINDOW, and it costs
   * nothing to leave it where it is. The next pass asks about a WIDER window
   * with the same lower bound, which is a superset — so nothing can be skipped
   * by not writing — and a key-range query over a range with nothing in it is
   * one seek however wide the range is. Advancing anyway would be a DynamoDB
   * write every `POLL_MS` for the life of an idle bot.
   */
  if (rows.length === 0) {
    if (onEmpty !== undefined) await guarded<void>('onEmpty', undefined, () => onEmpty(at))
    return
  }

  if (onRows !== undefined && !(await guarded<boolean>('onRows', false, () => onRows(at)))) return

  let advanced = cursor

  /** A `persist` bookmark that did not land. See `saveCursor`. */
  let stalled = false

  for (const row of rows) {
    if (room !== undefined && !(await guarded<boolean>('room', false, room))) break

    if (!placeable(row.ts)) {
      // The type says this cannot happen and the table is another repo's, so it
      // can. Stopping rather than skipping keeps the cursor behind a row that
      // could not be placed, and a silent `break` is the exact kind of quiet
      // halt both consumers are written against.
      //
      // A RANGE AND NOT A TYPE, WHICH IS THE CORRECTION. This read
      // `typeof row.ts !== 'number'`, and `typeof NaN` is `'number'` — so `NaN`
      // was dealt with as a position and written back out as the bookmark
      // `'NaN'`, and `1e18` was written back out as a bookmark this walk then
      // accepted forever. A `ts` that is not a position in the log is a row that
      // cannot be placed, which is this branch. See `placeable`.
      //
      // `ts` IS ON THE LINE BECAUSE THE VALUE IS THE WHOLE DIAGNOSIS. `NaN`, a
      // negative and `1e18` all reach here now and they are three different
      // faults in the console's writer; the sentence cannot tell them apart and
      // the field can.
      log('error', spec.messages.rowWithoutSortKey, { action: row.action, ts: row.ts })
      break
    }

    const step = await guarded<RowStep>('onRow', 'stop', () => onRow(row))
    if (step === 'stop') break

    advanced = row.ts

    if (step === 'persist') {
      if (!(await saveCursor(advanced))) {
        stalled = true
        break
      }
      saved = advanced
    }
  }

  if (onFinish !== undefined && !(await guarded<boolean>('onFinish', false, onFinish))) return

  /**
   * NOTHING MORE IS WRITTEN AFTER A BOOKMARK THAT DID NOT LAND, and `onFinish`
   * above still runs: the durable state a consumer keeps of its own is the one
   * thing that must be flushed on the way out. Retrying the same value here
   * against a table that has just failed buys nothing — the pass ended for that
   * exact reason — and the next pass repeats the window either way.
   */
  if (stalled) return

  // `saved` rather than `cursor`, so a pass that persisted as it went does not
  // rewrite the same value at the end. It is behind `advanced` only when the
  // rows after the last `persist` were dealt with in memory alone.
  if (advanced > saved) await saveCursor(advanced)
}
