import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { latch, RESTATE_MS } from './latch.ts'
import { log, setSink, type Level } from './log.ts'

/**
 * The latch, offline — a fault that only a person can clear, said once.
 *
 * WHAT EVERY CASE HERE IS REALLY ABOUT. #bot-status was forty minutes of one
 * sentence at thirty-second intervals because the openings poller reads an index
 * that has to be created by hand. The four properties below are the whole of the
 * fix, and each one of them has an opposite failure that is worse than the wall
 * of text:
 *
 *   ONE LINE PER RUN OF THE CONDITION — and not zero, because the first
 *   occurrence is how the owner finds out at all;
 *
 *   ONE LINE WHEN IT ENDS — and exactly one, because a recovery that repeats is
 *   the original disease with a nicer sentence, and a recovery that never fires
 *   leaves him watching for the absence of an error;
 *
 *   NOTHING AT ALL WHEN NOTHING WAS WRONG — a healthy bot calls `clear` twice a
 *   minute forever;
 *
 *   AND OTHER FAULTS UNAFFECTED — a latch that quietened the channel generally
 *   would be an outage, not a fix.
 *
 * THE LINES ARE READ OFF THE REAL STREAMS rather than off a spy on `log()`,
 * because the level and the fields are half of what is being asserted and both
 * of those only exist once the line is rendered. `<3>` is error, `<4>` is warn,
 * `<6>` is info — src/log.ts.
 */

const stdout: string[] = []
const stderr: string[] = []

beforeEach(() => {
  stdout.length = 0
  stderr.length = 0
  setSink(null)

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
  setSink(null)
  vi.restoreAllMocks()
})

const BROKEN = 'the widget index does not exist, so nothing is posted'
const FIXED = 'the widget index answers now, so things are posted'
const OTHER = 'the widget query is denied, so nothing is posted'
const OTHER_FIXED = 'the widget query is allowed now, so things are posted'

const AT = Date.parse('2026-09-01T12:00:00.000Z')

/** A clock a case can move, since `RESTATE_MS` is a day. */
function clock(start = AT): { now: () => number; move: (ms: number) => void } {
  let at = start
  return {
    now: () => at,
    move: (ms) => {
      at += ms
    },
  }
}

/** Every line carrying this message, across both streams. */
function lines(msg: string): string[] {
  return [...stdout, ...stderr].filter((line) => line.includes(`msg=${JSON.stringify(msg)}`))
}

/** What a sink was handed, in order. */
function recorder(): { calls: { level: Level; msg: string }[] } {
  const calls: { level: Level; msg: string }[] = []
  setSink((level, msg) => {
    calls.push({ level, msg })
    return Promise.resolve()
  })
  return { calls }
}

const held = { level: 'error', msg: BROKEN, cleared: FIXED } as const

describe('the latch — the first occurrence, and then silence', () => {
  it('reports the first occurrence exactly as the call site wrote it', () => {
    const one = latch(clock().now)

    one.fault({ ...held, fields: { index: 'widget-index', table: 'ringmaster-widgets' } })

    expect(lines(BROKEN)).toHaveLength(1)
    expect(stderr[0]?.startsWith('<3>')).toBe(true)
    expect(stderr[0]).toContain('index="widget-index"')
    expect(stderr[0]).toContain('table="ringmaster-widgets"')

    // Nothing about how long it has been true, on the line that is telling him
    // it has started being true.
    expect(stderr[0]).not.toContain('since=')
  })

  /**
   * THE CASE THE OWNER ASKED FOR. Eighty passes is forty minutes at `POLL_MS`,
   * which is what he actually sat in front of.
   */
  it('says nothing at all on eighty identical repeats', () => {
    const one = latch(clock().now)

    for (let n = 0; n < 80; n++) one.fault(held)

    expect(lines(BROKEN)).toHaveLength(1)
  })

  /**
   * THE FIELDS DO NOT UNLATCH IT, WHICH IS WHY THE TEST FOR "PERMANENT" IS ABOUT
   * THE FIELDS AT THE CALL SITE AND NOT ABOUT ANYTHING THIS FILE CAN CHECK. A
   * detail string that moves — an SDK message with a request id in it — must not
   * turn one condition back into a wall. Latching a fault whose fields carry real
   * evidence is the caller's mistake to avoid; see src/latch.ts.
   */
  it('is not unlatched by a field that moved', () => {
    const one = latch(clock().now)

    one.fault({ ...held, fields: { detail: 'attempt 1' } })
    one.fault({ ...held, fields: { detail: 'attempt 2' } })

    expect(lines(BROKEN)).toHaveLength(1)
    expect(stderr[0]).toContain('detail="attempt 1"')
  })
})

describe('the latch — the line that says it cleared', () => {
  it('says it once, at info, when the condition stops', () => {
    const one = latch(clock().now)

    one.fault(held)
    one.clear()

    expect(lines(FIXED)).toHaveLength(1)
    expect(lines(FIXED)[0]?.startsWith('<6>')).toBe(true)
  })

  /**
   * `info` AND STILL IN THE CHANNEL, WHICH IS THE COMBINATION NO SINGLE LEVEL
   * EXPRESSES. Nothing is wrong when something recovers, so the journal must not
   * carry it at `warn` — and the owner has no CLI path, so the channel is the
   * only place he can learn that his fix worked. `allClear` in src/log.ts is
   * where the two are reconciled, and this is the case that says both halves
   * hold at once.
   */
  it('reaches the sink even though it is an info', () => {
    const { calls } = recorder()
    const one = latch(clock().now)

    one.fault(held)
    one.clear()

    expect(calls).toEqual([
      { level: 'error', msg: BROKEN },
      { level: 'info', msg: FIXED },
    ])
  })

  it('says how long it was broken', () => {
    const time = clock()
    const one = latch(time.now)

    one.fault(held)
    time.move(3 * 24 * 60 * 60 * 1000)
    one.clear()

    expect(lines(FIXED)[0]).toContain(`since=${JSON.stringify(new Date(AT).toISOString())}`)
  })

  /**
   * ═══ THE ONE THAT MATTERS MOST ON A HEALTHY BOT ═══
   *
   * `clear` is called on every successful pass — twice a minute for the life of
   * the process — and almost every one of those calls has nothing to clear. An
   * all-clear for a fault that never happened would be the original problem
   * rebuilt out of good news.
   */
  it('says nothing when nothing was ever wrong', () => {
    const one = latch(clock().now)

    for (let n = 0; n < 80; n++) one.clear()

    expect(stdout).toEqual([])
    expect(stderr).toEqual([])
  })

  it('says nothing on a second clear', () => {
    const one = latch(clock().now)

    one.fault(held)
    one.clear()
    one.clear()
    one.clear()

    expect(lines(FIXED)).toHaveLength(1)
  })

  /**
   * A SECOND RUN OF THE SAME CONDITION IS A SECOND FAULT. The index was created
   * and then dropped again; that is news, and the latch is for repetition inside
   * one run rather than for saying a sentence once per process.
   */
  it('reports the same fault again after it has cleared', () => {
    const one = latch(clock().now)

    one.fault(held)
    one.clear()
    one.fault(held)
    one.fault(held)

    expect(lines(BROKEN)).toHaveLength(2)
    expect(lines(FIXED)).toHaveLength(1)
  })
})

describe('the latch — a different fault is still a fault', () => {
  /**
   * THE FAILURE THIS RULES OUT IS AN OUTAGE OF THE CHANNEL ITSELF. A missing
   * index must not silence a failed delete; slots are per-condition and hold
   * nothing in common.
   */
  it('does not silence an unrelated fault in another slot', () => {
    const one = latch(clock().now)
    const two = latch(clock().now)

    one.fault(held)
    two.fault({ level: 'warn', msg: OTHER, cleared: OTHER_FIXED })

    expect(lines(BROKEN)).toHaveLength(1)
    expect(lines(OTHER)).toHaveLength(1)
  })

  it('does not silence anything that does not go through it at all', () => {
    const one = latch(clock().now)

    one.fault(held)
    one.fault(held)
    log('error', 'delete failed, message left standing')

    expect(lines('delete failed, message left standing')).toHaveLength(1)
  })

  /**
   * A DIFFERENT SENTENCE IN THE SAME SLOT IS A DIFFERENT STATE OF ONE THING —
   * the index exists now and IAM refuses the Query — and it is reported.
   *
   * AND THE OLD ONE GETS NO ALL-CLEAR, WHICH IS THE HALF THAT COULD LIE. The
   * index really is there now, but the read still does not work, and
   * "the widget index answers now, so things are posted" beside a fresh error
   * saying nothing is posted would be false and would be the more reassuring of
   * the two lines.
   */
  it('reports a different sentence in the same slot, and clears nothing on the way', () => {
    const one = latch(clock().now)

    one.fault(held)
    one.fault({ level: 'error', msg: OTHER, cleared: OTHER_FIXED })

    expect(lines(BROKEN)).toHaveLength(1)
    expect(lines(OTHER)).toHaveLength(1)
    expect(lines(FIXED)).toEqual([])
  })

  it('then clears with the sentence of the fault that was actually holding', () => {
    const one = latch(clock().now)

    one.fault(held)
    one.fault({ level: 'error', msg: OTHER, cleared: OTHER_FIXED })
    one.clear()

    expect(lines(OTHER_FIXED)).toHaveLength(1)
    expect(lines(FIXED)).toEqual([])
  })
})

describe('the latch — it says itself again once a day', () => {
  /**
   * A LINE SAID ONCE AND NEVER AGAIN SCROLLS AWAY, and a feature that has been
   * dead for three weeks with nothing in the channel saying so is a worse
   * failure than the wall of text — it is silent. See `RESTATE_MS` for why the
   * number is a day of the owner's attention rather than a multiple of the poll
   * interval.
   */
  it('stays silent for the whole day, however many passes there are', () => {
    const time = clock()
    const one = latch(time.now)

    one.fault(held)

    for (let n = 0; n < 2000; n++) {
      time.move(RESTATE_MS / 2001)
      one.fault(held)
    }

    expect(lines(BROKEN)).toHaveLength(1)
  })

  it('says the same sentence at the same level once the day is up', () => {
    const time = clock()
    const one = latch(time.now)

    one.fault({ ...held, fields: { index: 'widget-index' } })
    time.move(RESTATE_MS)
    one.fault({ ...held, fields: { index: 'widget-index' } })

    const said = lines(BROKEN)
    expect(said).toHaveLength(2)
    expect(said[1]?.startsWith('<3>')).toBe(true)
    expect(said[1]).toContain('index="widget-index"')
  })

  /**
   * THE ONE FIELD THE RESTATEMENT ADDS, AND THE WHOLE REASON IT IS WORTH ADDING:
   * the difference between "this just broke" and "this broke last Tuesday" is
   * not in the sentence and cannot be, because the sentence must not change.
   */
  it('carries how long it has been true, which the first line does not', () => {
    const time = clock()
    const one = latch(time.now)

    one.fault(held)
    time.move(RESTATE_MS)
    one.fault(held)

    expect(lines(BROKEN)[0]).not.toContain('since=')
    expect(lines(BROKEN)[1]).toContain(`since=${JSON.stringify(new Date(AT).toISOString())}`)
  })

  it('measures the day from the last thing it said, not from the first', () => {
    const time = clock()
    const one = latch(time.now)

    one.fault(held)
    time.move(RESTATE_MS)
    one.fault(held)

    // One tick past a day since the FIRST line, and nowhere near a day since the
    // second. A window measured from the first occurrence would post here.
    time.move(1)
    one.fault(held)

    expect(lines(BROKEN)).toHaveLength(2)
  })

  it('starts the day again after the fault clears and comes back', () => {
    const time = clock()
    const one = latch(time.now)

    one.fault(held)
    time.move(RESTATE_MS / 2)
    one.clear()
    one.fault(held)
    one.fault(held)

    // Three lines: the fault, the all-clear, the fault again. The last `fault`
    // is inside the new run's day and is silent.
    expect(lines(BROKEN)).toHaveLength(2)
    expect(lines(FIXED)).toHaveLength(1)
  })
})
