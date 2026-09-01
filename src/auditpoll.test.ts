import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cursorAt,
  MAX_STAMP,
  pollAuditWindow,
  POLL_LIMIT,
  SETTLE_MS,
  type AuditPollMessages,
  type AuditPollSpec,
  type RowStep,
} from './auditpoll.ts'
import { CURSOR_KEY as BAN_CURSOR_KEY, TAGS_KEY } from './banrole.ts'
import { AUDIT_CURSOR_KEY } from './client.ts'
import type { AuditRow, BotStateRow, DdbResult } from './ddb.ts'
import {
  CURSOR_KEY as INCIDENT_CURSOR_KEY,
  OPEN_CURSOR_KEY as INCIDENT_OPEN_CURSOR_KEY,
} from './incidents.ts'

/**
 * The walk over `ringmaster-audit`, on its own.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM ITS TWO CONSUMERS. src/banrole.test.ts and
 * src/incidents.test.ts drive this code through everything a ban and an incident
 * mean, and between them they cover most of it — but they cover it as a means to
 * an end, so the cases that are ABOUT THE BOOKKEEPING have nowhere natural to
 * live over there and were the parts that used to exist twice and drift. Every
 * case here is one the consumers cannot state without inventing a fake verb.
 *
 * WHAT THE WALK PROMISES, and it is one sentence: the cursor only ever moves over
 * rows a consumer said it dealt with. Everything below is that sentence read
 * against one failure each.
 */

const NOW = 1_700_000_000_000
const KEY = 'a-test-cursor'
const OPEN = NOW - 3_600_000

const stdout: string[] = []
const stderr: string[] = []

beforeEach(() => {
  stdout.length = 0
  stderr.length = 0

  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString())
    return true
  }) as unknown as typeof process.stdout.write)

  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString())
    return true
  }) as unknown as typeof process.stderr.write)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const ok = <T,>(value: T): DdbResult<T> => ({ ok: true, value })

const failed = <T,>(): DdbResult<T> => ({
  ok: false,
  failure: { kind: 'timeout', op: 'get', table: 'ringmaster-bot-state', message: 'from the fake' },
})

/**
 * The seventh sentence, held separately because it is the OPTIONAL one.
 *
 * `MESSAGES.consumerThrew` is `string | undefined` through the interface, and
 * `said` takes a string — so the cases below read it from here rather than
 * asserting against a value the type says might not be there.
 */
const CONSUMER_THREW = 'test: a consumer hook threw'

/** Seven sentences a consumer would supply. Distinct, so a swap is visible. */
const MESSAGES: AuditPollMessages = {
  cursorUnreadable: 'test: the cursor could not be read',
  noCursorYet: 'test: there is no cursor yet',
  cursorUnusable: 'test: the cursor is not a position in the log',
  windowUnreadable: 'test: the window could not be read',
  cursorUnsaved: 'test: the cursor could not be saved',
  rowWithoutSortKey: 'test: a row carries no sort key',
  consumerThrew: CONSUMER_THREW,
}

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    pk: 'AUDIT',
    ts: NOW - 60_000,
    commandId: 'command-1',
    action: 'ban.issue',
    outcome: 'pending',
    actorLicense: 'license:admin1',
    actorName: 'Admin One',
    actorDiscordId: null,
    targetLicense: 'license:abc123',
    ...over,
  }
}

interface Harness {
  readonly state: Map<string, string>
  /** Every value the cursor was WRITTEN with, in order. */
  readonly writes: string[]
  /** Every `since` call, so the hold-back window can be asserted. */
  readonly windows: Array<{ after: number; until: number; limit: number | undefined }>
  run(spec: Partial<AuditPollSpec> & Pick<AuditPollSpec, 'onRow'>): Promise<void>
  cursor(): number | null
}

function harness(
  over: {
    rows?: AuditRow[]
    state?: Record<string, string>
    statePut?: (key: string, value: string) => Promise<DdbResult<BotStateRow>>
    stateGet?: (key: string) => Promise<DdbResult<BotStateRow | null>>
    since?: () => Promise<DdbResult<AuditRow[]>>
    /**
     * A CLOCK THAT CAN MOVE BETWEEN PASSES, which every case but one has no use
     * for. The first-start cases need it: the whole bug there is that a second
     * pass reads a DIFFERENT `now` and records that instead of where this
     * process actually came in, so a fixed clock cannot see it.
     */
    now?: () => number
  } = {},
): Harness {
  const state = new Map<string, string>(Object.entries(over.state ?? {}))
  const writes: string[] = []
  const windows: Array<{ after: number; until: number; limit: number | undefined }> = []

  return {
    state,
    writes,
    windows,
    run: (spec) =>
      pollAuditWindow(
        {
          now: over.now ?? (() => NOW),
          ddb: {
            botState: {
              get:
                over.stateGet ??
                ((key) => {
                  const value = state.get(key)
                  return Promise.resolve(
                    ok(value === undefined ? null : { id: key, value, updatedAt: NOW - 1 }),
                  )
                }),
              /**
               * THE MAP FOLLOWS THE ANSWER, WHOEVER GIVES IT. An override
               * decides whether the write lands; this decides what that means.
               * A `statePut` that replaced the whole function would leave
               * `state` seeded and untouched, and `cursor()` would then hand
               * back the starting value however the pass had actually gone —
               * true before the walk ran, and therefore about nothing.
               */
              put: async (key, value) => {
                writes.push(value)

                const written = over.statePut
                  ? await over.statePut(key, value)
                  : ok<BotStateRow>({ id: key, value, updatedAt: NOW })

                if (written.ok) state.set(key, value)
                return written
              },
            },
            auditWindow: {
              partition: 'AUDIT',
              since: (after, until, limit) => {
                windows.push({ after, until, limit })
                if (over.since) return over.since()
                return Promise.resolve(
                  ok((over.rows ?? []).filter((r) => r.ts > after && r.ts <= until)),
                )
              },
              newest: () => Promise.resolve(ok(null)),
            },
          },
        },
        { cursorKey: KEY, messages: MESSAGES, ...spec },
      ),
    cursor: () => {
      const raw = state.get(KEY)
      return raw === undefined ? null : Number(raw)
    },
  }
}

/** Did any line carry this message? `msg=` so a field cannot match by accident. */
function said(lines: string[], msg: string): boolean {
  return lines.some((line) => line.includes(`msg=${JSON.stringify(msg)}`))
}

describe('where the walk reads from', () => {
  it('holds back from its own tail and asks for a bounded page', async () => {
    const h = harness({ state: { [KEY]: String(OPEN) } })

    await h.run({ onRow: () => Promise.resolve('done') })

    expect(h.windows).toEqual([{ after: OPEN, until: NOW - SETTLE_MS, limit: POLL_LIMIT }])
  })

  it('records where it came in on its first ever pass and walks nothing', async () => {
    const seen: AuditRow[] = []
    const h = harness({ rows: [row()] })

    await h.run({
      onRow: (r) => {
        seen.push(r)
        return Promise.resolve('done')
      },
    })

    expect(seen).toEqual([])
    expect(h.cursor()).toBe(NOW - SETTLE_MS)
    expect(said(stdout, MESSAGES.noCursorYet)).toBe(true)
  })

  /**
   * ═══ THE FIRST-START GAP: A WINDOW SKIPPED FOR GOOD, NOT A WRITE RETRIED ═══
   *
   * WHAT IT DID. The no-cursor branch recorded `now - SETTLE_MS` and returned.
   * If that `botState.put` failed, the next pass found no cursor AGAIN and
   * recorded the THEN-current instant — so everything the log gained in between
   * was already behind the bookmark the moment a write finally landed, and
   * nothing in this file ever goes back. Half a minute of closed cases per
   * failed pass, gone, with only a `cursorUnsaved` line to show for it — and
   * that line says a bookmark did not land, not that a window was skipped.
   *
   * IT IS FIRST-START ONLY AND IT IS STILL WORTH FIXING. Every other branch
   * holds the cursor behind what it has not dealt with; this one is the single
   * place where a failed write silently moves the starting line forward.
   *
   * THE CLOCK HAS TO MOVE, WHICH IS THE WHOLE FIXTURE. With a fixed `now` all
   * three passes compute the same mark and a broken implementation passes.
   */
  it('records where it FIRST came in, however many passes the write takes to land', async () => {
    let clock = NOW
    let lands = false

    const h = harness({
      now: () => clock,
      statePut: (key, value) =>
        Promise.resolve(lands ? ok<BotStateRow>({ id: key, value, updatedAt: clock }) : failed()),
    })

    const cameIn = NOW - SETTLE_MS

    await h.run({ onRow: () => Promise.resolve('done') })

    clock = NOW + 60_000
    await h.run({ onRow: () => Promise.resolve('done') })

    clock = NOW + 120_000
    lands = true
    await h.run({ onRow: () => Promise.resolve('done') })

    // Three attempts at ONE value: where this process actually came in. The bug
    // wrote three different ones and kept the last.
    expect(h.writes).toEqual([String(cameIn), String(cameIn), String(cameIn)])
    expect(h.cursor()).toBe(cameIn)
    expect(said(stderr, MESSAGES.cursorUnsaved)).toBe(true)
  })

  /**
   * AND THE MARK IS FORGOTTEN THE MOMENT IT LANDS, which is the other half: a
   * row emptied by hand later is a NEW first start, and reusing a mark from an
   * hour ago would replay every case since it into the moderation channel. That
   * is the disaster the empty-cursor branch exists to prevent, so it must not be
   * reintroduced by remembering too much.
   */
  it('marks a later first start at the later instant, not the one it already wrote', async () => {
    let clock = NOW
    const h = harness({ now: () => clock })

    await h.run({ onRow: () => Promise.resolve('done') })

    // The row is emptied by hand — one of the shapes `cursorAt` refuses.
    h.state.set(KEY, '')
    clock = NOW + 3_600_000
    await h.run({ onRow: () => Promise.resolve('done') })

    expect(h.writes).toEqual([String(NOW - SETTLE_MS), String(NOW + 3_600_000 - SETTLE_MS)])
  })

  it('does nothing at all when the cursor row cannot be read', async () => {
    const h = harness({ rows: [row()], stateGet: () => Promise.resolve(failed()) })

    await h.run({ onRow: () => Promise.resolve('done') })

    expect(h.windows).toEqual([])
    expect(h.writes).toEqual([])
    expect(said(stderr, MESSAGES.cursorUnreadable)).toBe(true)
  })

  /**
   * ═══ THE VALUES THAT USED TO BECOME A BOOKMARK IN 1970 ═══
   *
   * EVERY ONE OF THESE WAS FINITE THROUGH `Number()`, which is the whole of the
   * bug: the old guard was `raw === null ? null : Number(raw)` rejected by
   * `!Number.isFinite`, so `''` → 0 → finite → a cursor at the epoch, and the
   * next line asked the audit log for everything since. The incident poller
   * turned that into ten ancient closed cases in the moderation channel per
   * pass.
   *
   * THE LIST IS WHAT A HAND-MADE ROW CAN ACTUALLY HOLD, not a set of strings
   * somebody imagined. `BotStateRow.value` is typed `string` and src/ddb.ts
   * casts `res.Item` rather than parsing it, over a table docs/aws-notes.md says
   * was created by hand — so a DynamoDB boolean and a list are not exotic, they
   * are two of the six types that attribute can be, and `Number([5])` is `5`.
   */
  it('reads only a positive finite stamp as a bookmark', () => {
    for (const rejected of [
      null,
      undefined,
      '',
      ' ',
      '\t\n ',
      '0',
      '  0  ',
      '-1',
      '-1700000000000',
      'yesterday',
      '1e400',
      'NaN',
      false,
      true,
      0,
      1_700_000_000_000,
      [],
      [1_700_000_000_000],
      {},
    ]) {
      expect(cursorAt(rejected), JSON.stringify(rejected) ?? String(rejected)).toBeNull()
    }

    // And a real one still reads as itself, padding and all.
    expect(cursorAt(String(NOW))).toBe(NOW)
    expect(cursorAt(`  ${String(NOW)}  `)).toBe(NOW)
    expect(cursorAt('1')).toBe(1)
  })

  /**
   * A NUMBER IS REJECTED TOO, AND THAT IS NOT AN OVERSIGHT. `saveCursor` writes
   * `String(to)`, so every bookmark this repo has ever written is a string; a
   * numeric attribute in that row was put there by something else and this
   * function has no business trusting where.
   */
  it('starts from now rather than from the epoch, whatever the row holds', async () => {
    for (const stored of ['', ' ', '0', '-1']) {
      const h = harness({ state: { [KEY]: stored }, rows: [row({ ts: 1 })] })

      const seen: AuditRow[] = []
      await h.run({
        onRow: (r) => {
          seen.push(r)
          return Promise.resolve('done')
        },
      })

      // The log is never read on this branch, so there is nothing to walk.
      expect(h.windows, stored).toEqual([])
      expect(seen, stored).toEqual([])
      expect(h.cursor(), stored).toBe(NOW - SETTLE_MS)
      expect(said(stderr, MESSAGES.cursorUnusable), stored).toBe(true)
    }
  })

  /**
   * ═══ THE OTHER END OF THE SAME RULE, AND THE ONE WITH NO SYMPTOM AT ALL ═══
   *
   * TOO FAR BACK FILLS A CHANNEL; TOO FAR FORWARD EMPTIES ONE AND SAYS NOTHING.
   * `pollAuditWindow` asks `auditWindow.since` for `(cursor, now - SETTLE_MS]`, so
   * a bookmark ahead of the clock is not a position that will be reached in a
   * moment — it is a range with nothing in it, on this pass and on every pass
   * after it, for the life of the process.
   *
   * `'1000000000000000000'` IS THE VALUE THAT ACTUALLY GOT IN THERE, and it is a
   * positive finite number spelled as a string — which is everything the guard
   * used to ask. It was written by this file, out of a row whose `ts` was `1e18`,
   * and then accepted back by this file forever.
   */
  it('refuses a bookmark past the horizon, which is a window nothing can fall in', () => {
    expect(cursorAt(String(MAX_STAMP))).toBe(MAX_STAMP)

    for (const ahead of ['1000000000000000000', '1e18', String(MAX_STAMP + 1), '1e300']) {
      // Positive, finite, and a string: everything the old rule asked for.
      expect(Number.isFinite(Number(ahead)) && Number(ahead) > 0, ahead).toBe(true)
      expect(cursorAt(ahead), ahead).toBeNull()
    }
  })

  /**
   * AND END TO END, BECAUSE THE COST IS A PASS THAT DOES NOTHING RATHER THAN A
   * VALUE THAT IS NULL. A bookmark in the future used to be read back as a
   * position: the log was queried over an empty range, no row was ever seen, no
   * cursor was ever written, and not one line went to the owner's status channel.
   * Refused, it lands on the branch that restarts from now and says so.
   */
  it('restarts from now rather than going silent behind a bookmark in the future', async () => {
    const h = harness({ state: { [KEY]: '1000000000000000000' }, rows: [row()] })

    const seen: AuditRow[] = []
    await h.run({
      onRow: (r) => {
        seen.push(r)
        return Promise.resolve('done')
      },
    })

    // Never read at all, which is what the restart branch does.
    expect(h.windows).toEqual([])
    expect(seen).toEqual([])
    expect(h.state.get(KEY)).toBe(String(NOW - SETTLE_MS))
    expect(said(stderr, MESSAGES.cursorUnusable)).toBe(true)
  })

  it('writes nothing when the window could not be read', async () => {
    const h = harness({ state: { [KEY]: String(OPEN) }, since: () => Promise.resolve(failed()) })

    await h.run({ onRow: () => Promise.resolve('done') })

    expect(h.writes).toEqual([])
    expect(said(stderr, MESSAGES.windowUnreadable)).toBe(true)
  })
})

describe('what the cursor is allowed to move over', () => {
  /**
   * `stop` MEANS THE ROW WAS NOT DEALT WITH, so the walk ends behind it and the
   * next pass sees it again. Every "could not read", "could not post" and "could
   * not save" path in both consumers answers this, and it is the difference
   * between a retry and a hole in a permanent record.
   */
  it('stays behind the first row a consumer could not deal with', async () => {
    const h = harness({
      state: { [KEY]: String(OPEN) },
      rows: [row({ ts: NOW - 60_000 }), row({ ts: NOW - 50_000 }), row({ ts: NOW - 40_000 })],
    })

    const seen: number[] = []
    await h.run({
      onRow: (r): Promise<RowStep> => {
        seen.push(r.ts)
        return Promise.resolve(r.ts === NOW - 50_000 ? 'stop' : 'done')
      },
    })

    // The third row was never even offered.
    expect(seen).toEqual([NOW - 60_000, NOW - 50_000])
    expect(h.cursor()).toBe(NOW - 60_000)
  })

  /**
   * A ROW WITH NO SORT KEY CANNOT BE PLACED IN THE LOG, so the walk stops loudly
   * rather than skipping it — a silent `break` is the quiet halt both consumers
   * are written against. The type says it cannot happen and the table is another
   * repository's, so it can.
   *
   * ═══ THE GOOD ROW AFTER THE BROKEN ONE IS THE WHOLE CASE ═══
   *
   * With the broken row LAST, stopping and skipping are indistinguishable: the
   * loop ends either way, nothing else is offered either way, and the cursor
   * lands on the same number either way. Changing that `break` to a `continue` —
   * the row skipped and the cursor sailing over it, which is the one outcome
   * this guard exists to refuse — passed the version of this case that ordered
   * the fixture that way. So there is a row BEHIND the broken one, and the two
   * assertions that separate the two behaviours are that it was never offered
   * and that the cursor did not reach it.
   */
  it('stops loudly at a row it cannot place, without offering it or the rows behind it', async () => {
    const broken = { ...row({ ts: NOW - 50_000 }), ts: undefined as unknown as number }
    const after = row({ ts: NOW - 40_000 })
    const h = harness({
      state: { [KEY]: String(OPEN) },
      since: () => Promise.resolve(ok([row(), broken, after])),
    })

    const seen: AuditRow[] = []
    await h.run({
      onRow: (r) => {
        seen.push(r)
        return Promise.resolve('done')
      },
    })

    // Only the row before it. A skip would have offered `after` as well.
    expect(seen.map((r) => r.ts)).toEqual([NOW - 60_000])
    // And behind the row that could not be placed, so the next pass sees it
    // again. A skip would have left the cursor at `after`, past a row nothing
    // ever dealt with.
    expect(h.cursor()).toBe(NOW - 60_000)
    expect(said(stderr, MESSAGES.rowWithoutSortKey)).toBe(true)
  })

  /**
   * ═══ A TYPE CHECK IS NOT A RANGE CHECK, AND THE BOOKMARK IS WHERE IT SHOWED ═══
   *
   * THE GUARD WAS `typeof row.ts !== 'number'` AND `typeof NaN` IS `'number'`.
   * `NaN` therefore passed it, was handed to the consumer, was dealt with, and
   * became `advanced` — so `saveCursor` wrote the literal string `'NaN'` into
   * `ringmaster-bot-state`. The next pass read that back, `cursorAt` answered
   * `null`, the walk restarted from now, and every row written in between was
   * behind the new bookmark and never looked at again. One line, then silence.
   *
   * `1e18` WAS THE SAME MECHANISM WITH NO LINE AT ALL, which is why it is in this
   * list twice over. It was written as `'1000000000000000000'` and `cursorAt`
   * ACCEPTED it back as a valid bookmark on every later pass, so the log was
   * queried over `(1e18, now]` — empty forever. Nothing restarted, nothing was
   * logged, and the feed simply stopped.
   *
   * ═══ WHY THE BROKEN ROW IS LAST HERE AND FIRST IN THE CASE ABOVE ═══
   *
   * THE ASSERTION IS ABOUT WHAT LANDS IN `ringmaster-bot-state`, and a bad `ts`
   * can only become the bookmark if nothing good follows it — which is the
   * ordinary case, since the newest row is the one at the end of the window. With
   * a good row behind it the walk would have advanced past the bad value and
   * written a sane number, and the case would have passed with the bug live. The
   * case above orders it the other way and asserts the other half.
   *
   * `state` AND NOT `cursor()`, BECAUSE `cursor()` GOES THROUGH `Number()`. The
   * bug's whole shape is the STRING that was stored, and `Number('NaN')` is `NaN`
   * — which is not `toBe`-equal to anything, including itself. Reading the raw
   * attribute is the only way to say what a restarted bot would find there.
   */
  it('writes no bookmark out of a sort key that is not a position in the log', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e18, -1]) {
      stderr.length = 0

      const good = row({ ts: NOW - 60_000 })
      const broken = row({ ts: bad })
      const h = harness({
        state: { [KEY]: String(OPEN) },
        since: () => Promise.resolve(ok([good, broken])),
      })

      const seen: AuditRow[] = []
      await h.run({
        onRow: (r) => {
          seen.push(r)
          return Promise.resolve('done')
        },
      })

      const label = String(bad)

      // The row was never offered to the consumer, and the one in front of it was.
      expect(seen.map((r) => r.ts), label).toEqual([NOW - 60_000])

      // AND THE BOOKMARK IS THE GOOD ROW'S, spelled the way a bookmark is spelled.
      // Before the fix this attribute held 'NaN', 'Infinity', '-Infinity' or
      // '1000000000000000000' — or, for the two negatives, was never written at
      // all because `advanced > saved` was false.
      expect(h.writes, label).toEqual([String(NOW - 60_000)])
      expect(h.state.get(KEY), label).toBe(String(NOW - 60_000))

      expect(said(stderr, MESSAGES.rowWithoutSortKey), label).toBe(true)
    }
  })

  /**
   * AND THE ORDERING HOLDS FOR A RANGE-REFUSED ROW EXACTLY AS IT DOES FOR A
   * MISSING ONE. `MAX_STAMP` itself is still a position and is walked over; one
   * millisecond past it is not, and the walk stops there rather than sailing over
   * it — which is the difference a `continue` would erase.
   */
  it('walks over the horizon itself and stops at the millisecond past it', async () => {
    const at = harness({
      state: { [KEY]: String(OPEN) },
      since: () => Promise.resolve(ok([row({ ts: MAX_STAMP })])),
    })
    await at.run({ onRow: () => Promise.resolve('done') })
    expect(at.state.get(KEY)).toBe(String(MAX_STAMP))

    const past = harness({
      state: { [KEY]: String(OPEN) },
      since: () =>
        Promise.resolve(ok([row({ ts: MAX_STAMP + 1 }), row({ ts: MAX_STAMP + 2_000 })])),
    })

    const seen: AuditRow[] = []
    await past.run({
      onRow: (r) => {
        seen.push(r)
        return Promise.resolve('done')
      },
    })

    expect(seen).toEqual([])
    expect(past.writes).toEqual([])
    expect(past.state.get(KEY)).toBe(String(OPEN))
    expect(said(stderr, MESSAGES.rowWithoutSortKey)).toBe(true)
  })

  it('leaves the cursor alone over an empty window, and says nothing', async () => {
    const empty: number[] = []
    const h = harness({ state: { [KEY]: String(OPEN) }, rows: [] })

    await h.run({
      onRow: () => Promise.resolve('done'),
      onEmpty: (at) => {
        empty.push(at)
      },
    })

    expect(empty).toEqual([NOW])
    expect(h.writes).toEqual([])
    expect(h.cursor()).toBe(OPEN)
  })

  /**
   * `onRows` ANSWERING FALSE ABANDONS THE PASS BEFORE ANY ROW IS LOOKED AT, which
   * is what src/banrole.ts does with a tag list it could not read: every decision
   * below would otherwise be made against nothing.
   */
  it('abandons the pass when the consumer is not ready for the rows', async () => {
    const h = harness({ state: { [KEY]: String(OPEN) }, rows: [row()] })

    const seen: AuditRow[] = []
    await h.run({
      onRows: () => false,
      onRow: (r) => {
        seen.push(r)
        return Promise.resolve('done')
      },
    })

    expect(seen).toEqual([])
    expect(h.writes).toEqual([])
  })

  /**
   * `onFinish` ANSWERING FALSE LEAVES THE CURSOR WHERE IT WAS. src/banrole.ts
   * uses it for the one write that makes a pass's decisions durable: a cursor
   * moved past decisions that did not stick is a pass that will never make them
   * again.
   */
  it('does not move the cursor when the consumer could not make the pass durable', async () => {
    const h = harness({ state: { [KEY]: String(OPEN) }, rows: [row()] })

    await h.run({ onRow: () => Promise.resolve('done'), onFinish: () => false })

    expect(h.writes).toEqual([])
    expect(h.cursor()).toBe(OPEN)
  })

  it('stops asking for rows once the consumer says it is out of room', async () => {
    const h = harness({
      state: { [KEY]: String(OPEN) },
      rows: [row({ ts: NOW - 60_000 }), row({ ts: NOW - 50_000 }), row({ ts: NOW - 40_000 })],
    })

    let dealt = 0
    await h.run({
      room: () => dealt < 2,
      onRow: () => {
        dealt++
        return Promise.resolve('done')
      },
    })

    expect(dealt).toBe(2)
    // On the last row it dealt with, so the rest come back next pass.
    expect(h.cursor()).toBe(NOW - 50_000)
  })
})

describe('a consumer whose work cannot be undone', () => {
  /**
   * ═══ `persist` IS WHAT STOPS TEN RECORDS BECOMING TWENTY ═══
   *
   * src/incidents.ts posts to a channel, and a post cannot be un-posted. One
   * write at the end of a pass means a crash between the last send and that write
   * replays every record the pass posted. So `persist` writes the cursor before
   * the next row is looked at, and a restart resumes after the last row that
   * actually completed.
   */
  it('writes the cursor after each row that says so, before the next one', async () => {
    const h = harness({
      state: { [KEY]: String(OPEN) },
      rows: [row({ ts: NOW - 60_000 }), row({ ts: NOW - 50_000 }), row({ ts: NOW - 40_000 })],
    })

    // What the table held as each row was handed over.
    const before: Array<number | null> = []

    await h.run({
      onRow: (r) => {
        before.push(h.cursor())
        return Promise.resolve(r.ts === NOW - 50_000 ? 'done' : 'persist')
      },
    })

    expect(before).toEqual([OPEN, NOW - 60_000, NOW - 60_000])
    expect(h.cursor()).toBe(NOW - 40_000)
  })

  /**
   * NO SECOND WRITE OF A VALUE ALREADY ON THE TABLE. A pass that persisted its
   * last row would otherwise finish by writing the same number again — one
   * pointless DynamoDB write per pass, on the busiest passes there are.
   */
  it('does not rewrite the cursor at the end of a pass that already persisted it', async () => {
    const h = harness({
      state: { [KEY]: String(OPEN) },
      rows: [row({ ts: NOW - 60_000 }), row({ ts: NOW - 50_000 })],
    })

    await h.run({ onRow: () => Promise.resolve('persist') })

    expect(h.writes).toEqual([String(NOW - 60_000), String(NOW - 50_000)])
  })

  /**
   * THE ROWS AFTER THE LAST `persist` ARE STILL COVERED, by the one write at the
   * end. A consumer mixes the two — a record posted, then three rows filtered out
   * — and the filtered rows must not come back next pass.
   */
  it('covers the rows dealt with after the last persisted one', async () => {
    const h = harness({
      state: { [KEY]: String(OPEN) },
      rows: [row({ ts: NOW - 60_000 }), row({ ts: NOW - 50_000 }), row({ ts: NOW - 40_000 })],
    })

    await h.run({
      onRow: (r) => Promise.resolve(r.ts === NOW - 60_000 ? 'persist' : 'done'),
    })

    expect(h.writes).toEqual([String(NOW - 60_000), String(NOW - 40_000)])
  })

  /**
   * ═══ A BOOKMARK THAT DID NOT LAND ENDS THE PASS ═══
   *
   * `ringmaster-bot-state` NOT ANSWERING DOES NOT STOP THIS PROCESS FROM
   * POSTING, which is the whole danger. A pass that reported the failure and
   * carried on would send all ten records with all ten bookmarks failing, and
   * the next pass — reading a cursor that never moved — would replay every one
   * of them into the channel. That is exactly the replay `persist` was added to
   * prevent, so the walk stops at the first write that did not land: the records
   * already sent are already sent, and going on only widens what comes back.
   *
   * AND NOTHING IS WRITTEN AFTER IT. Retrying the same value at the end of the
   * pass is one more request to a table that has just failed, for an outcome the
   * next pass produces anyway.
   */
  it('stops the walk at the first bookmark that did not land', async () => {
    const h = harness({
      state: { [KEY]: String(OPEN) },
      rows: [row({ ts: NOW - 60_000 }), row({ ts: NOW - 50_000 })],
      statePut: () => Promise.resolve(failed()),
    })

    const seen: number[] = []
    let finished = 0

    await h.run({
      onRow: (r) => {
        seen.push(r.ts)
        return Promise.resolve('persist')
      },
      onFinish: () => {
        finished++
        return true
      },
    })

    // The second row was never offered, and one write was attempted: the one
    // that failed. No second attempt at the end.
    expect(seen).toEqual([NOW - 60_000])
    expect(h.writes).toEqual([String(NOW - 60_000)])
    expect(said(stderr, MESSAGES.cursorUnsaved)).toBe(true)
    // Nothing landed, so the next pass reads the same window again.
    expect(h.cursor()).toBe(OPEN)

    // THE CONSUMER'S OWN DURABLE STATE IS STILL FLUSHED. Stopping the walk is
    // about not posting more; it is not a reason to drop what the pass already
    // decided on its way out.
    expect(finished).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * A consumer that throws.
 * ------------------------------------------------------------------ */

/**
 * ═══ "NEVER THROWS; EVERY FAILURE IS A LINE AND A RETURN" WAS TRUE OF THIS FILE
 * AND NOT OF THE PASS ═══
 *
 * WHAT WAS AWAITED BARE, AND WHY THAT IS NOT A THEORETICAL WORRY. `onRows`,
 * `onRow` and `onFinish` are the consumer's own code, and what both consumers
 * spend their time on is values off another repository's rows — a
 * `subjectLicense` typed `string` that arrives absent, a `detail` map typed as
 * scalars that holds an object. src/incidents.ts had exactly that bug: a
 * `TypeError` out of `banKey.startsWith` in src/banrole.ts, on the one borrowed
 * value it had not guarded.
 *
 * AND THE THROW COST MORE THAN THE ROW. It skipped `onFinish` — the flush that
 * makes a consumer's own decisions durable, which src/banrole.ts relies on for
 * its tag write — and it skipped the cursor write covering every row the pass
 * had ALREADY dealt with. So one bad row in the middle of a window undid the
 * whole pass rather than just itself, and the next pass redid all of it.
 *
 * EVERY CASE HERE ASSERTS THE SAME THREE THINGS: the walk resolved rather than
 * rejected, the cursor moved over exactly what was dealt with and no further,
 * and the fault was said out loud.
 */
describe('a hook that throws', () => {
  it('reads a throwing onRow as stop, keeping the rows before it and dropping none', async () => {
    const h = harness({
      state: { [KEY]: String(OPEN) },
      rows: [row({ ts: NOW - 60_000 }), row({ ts: NOW - 50_000 }), row({ ts: NOW - 40_000 })],
    })

    const seen: number[] = []
    let finished = 0

    await expect(
      h.run({
        onRow: (r) => {
          seen.push(r.ts)
          if (r.ts === NOW - 50_000) throw new TypeError('banKey.startsWith is not a function')
          return Promise.resolve('done')
        },
        onFinish: () => {
          finished++
          return true
        },
      }),
    ).resolves.toBeUndefined()

    // It stopped AT the row it threw on, and the third was never offered.
    expect(seen).toEqual([NOW - 60_000, NOW - 50_000])
    // The cursor covers the row that WAS dealt with and stays behind the one
    // that was not, which is what `stop` has always meant.
    expect(h.cursor()).toBe(NOW - 60_000)
    // And the durable flush still ran, which the bare await skipped entirely.
    expect(finished).toBe(1)
    expect(said(stderr, CONSUMER_THREW)).toBe(true)
  })

  it('abandons the pass without moving the cursor when onRows throws', async () => {
    const h = harness({ state: { [KEY]: String(OPEN) }, rows: [row()] })

    const seen: number[] = []

    await expect(
      h.run({
        onRows: () => {
          throw new Error('the tag list could not be read')
        },
        onRow: (r) => {
          seen.push(r.ts)
          return Promise.resolve('done')
        },
      }),
    ).resolves.toBeUndefined()

    expect(seen).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.cursor()).toBe(OPEN)
    expect(said(stderr, CONSUMER_THREW)).toBe(true)
  })

  /**
   * A THROWING `onFinish` IS READ AS `false`, WHICH IS THE ANSWER THAT LOSES
   * NOTHING. The hook exists so a consumer can say "my own durable state did not
   * land"; a throw is that answer arrived at less politely, and moving the
   * cursor over decisions that did not stick is a pass that will never make them
   * again.
   */
  it('leaves the cursor where it was when onFinish throws', async () => {
    const h = harness({ state: { [KEY]: String(OPEN) }, rows: [row()] })

    await expect(
      h.run({
        onRow: () => Promise.resolve('done'),
        onFinish: () => {
          throw new Error('the tags could not be written')
        },
      }),
    ).resolves.toBeUndefined()

    expect(h.writes).toEqual([])
    expect(h.cursor()).toBe(OPEN)
    expect(said(stderr, CONSUMER_THREW)).toBe(true)
  })

  it('ends the walk on what it had, when room throws', async () => {
    const h = harness({
      state: { [KEY]: String(OPEN) },
      rows: [row({ ts: NOW - 60_000 }), row({ ts: NOW - 50_000 })],
    })

    let asked = 0

    await expect(
      h.run({
        room: () => {
          asked++
          if (asked === 2) throw new Error('a budget that cannot be counted')
          return true
        },
        onRow: () => Promise.resolve('done'),
      }),
    ).resolves.toBeUndefined()

    expect(h.cursor()).toBe(NOW - 60_000)
    expect(said(stderr, CONSUMER_THREW)).toBe(true)
  })

  it('survives an onEmpty that throws, over a window with nothing in it', async () => {
    const h = harness({ state: { [KEY]: String(OPEN) } })

    await expect(
      h.run({
        onEmpty: () => {
          throw new Error('the partition probe blew up')
        },
        onRow: () => Promise.resolve('done'),
      }),
    ).resolves.toBeUndefined()

    expect(h.writes).toEqual([])
    expect(said(stderr, CONSUMER_THREW)).toBe(true)
  })

  /**
   * A CONSUMER THAT NEVER WROTE THE SEVENTH SENTENCE STILL GETS A LINE, and it
   * still says WHICH poll: the message is generic, the `cursor` field is not.
   * The alternative — a required field — would have made wording it a condition
   * of compiling for two consumers that were already written.
   */
  it('says something naming the poll even when the consumer supplied no sentence', async () => {
    const h = harness({ state: { [KEY]: String(OPEN) }, rows: [row()] })

    const six: AuditPollMessages = { ...MESSAGES, consumerThrew: undefined }

    await h.run({
      messages: six,
      onRow: () => {
        throw new Error('anything at all')
      },
    })

    expect(
      said(stderr, 'a consumer of the audit walk threw, so the walk stopped there'),
    ).toBe(true)
    expect(stderr.some((line) => line.includes(JSON.stringify(KEY)))).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * The rows this bot keeps in `ringmaster-bot-state`.
 * ------------------------------------------------------------------ */

/**
 * ═══ EVERY BOOKMARK IS A ROW IN ONE TABLE, AND NO TWO OF THEM MAY BE THE SAME
 * ROW ═══
 *
 * WHAT A COLLISION DOES, AND IT IS SILENT AT EVERY LAYER. Two consumers sharing
 * a cursor row means each one advances the other's bookmark past rows it never
 * looked at: the game-ban poll writes where IT got to, the incident poll reads
 * that as where IT got to and asks for the window after it, and the rows in
 * between are gone. Bans left unmarked, moderation records never posted, no
 * error anywhere — the walk is doing exactly what it promises with a number that
 * means something else.
 *
 * WHY THE CONSTANTS ALONE CANNOT SAY THIS. Each consumer's own test file imports
 * `CURSOR_KEY` from its own module and asserts against whatever that module
 * happens to say, so setting both modules to the SAME string passed all 1794
 * tests. The literal has to be written out somewhere that is not the module, and
 * the names have to be compared to each other somewhere that can see both.
 *
 * IT IS A LIST AND A SET RATHER THAN A PAIR OF COMPARISONS, which is what made
 * blitz-bot#19's case-opened half one line here instead of a rewrite. Adding a
 * consumer is adding one line, and forgetting to is a failing test rather than a
 * green suite.
 */
describe('the rows this bot keeps in ringmaster-bot-state', () => {
  /**
   * Every row, as the name DynamoDB holds it under beside the constant the code
   * reaches it by. Both halves are deliberate: a test that compared constants
   * only to each other would be just as happy after a rename that orphans a
   * live bookmark and quietly restarts a poller from nothing.
   */
  const ROWS: ReadonlyArray<readonly [name: string, key: string]> = [
    ['game-ban-audit-cursor', BAN_CURSOR_KEY],
    ['incident-resolve-audit-cursor', INCIDENT_CURSOR_KEY],
    /**
     * THE THIRD CONSUMER, AND THE FIRST WHOSE CURSOR IS NOT A POSITION IN
     * `ringmaster-audit` AT ALL. It is an `openedAt` out of
     * `ringmaster-incidents`, read through `kind-openedAt-index` — so a collision
     * with either of the two above would not merely skip rows, it would resume a
     * poller from a millisecond that is a valid number and means nothing in its
     * own table.
     */
    ['incident-open-index-cursor', INCIDENT_OPEN_CURSOR_KEY],
    ['game-ban-role-tags', TAGS_KEY],
    ['discord-audit-cursor', AUDIT_CURSOR_KEY],
  ]

  it('keeps each one under the name the table already holds it under', () => {
    for (const [name, key] of ROWS) expect(key).toBe(name)
  })

  it('gives every one of them a row of its own', () => {
    const keys = ROWS.map(([, key]) => key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
