import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { DdbFailure, DdbResult, MaintenanceState, MaintenanceWindow } from './ddb.ts'
import {
  FRESH_TRANSITION_MS,
  MAINTENANCE_POLL_MS,
  maintenanceMemory,
  maintenancePoster,
  maintenanceStatePath,
  maintenanceWatch,
  RESTART_GRACE_MS,
  watchMaintenance,
  type MaintenanceMemory,
} from './maintenance.ts'

/**
 * The maintenance notices, offline.
 *
 * NOTHING HERE TOUCHES AWS, DISCORD OR A DISK. The row arrives from a fake
 * three lines above the assertion, the channel is an object with a `send` on
 * it, and the memory is a string in a closure — which is possible because
 * `maintenanceWatch` takes all three as options, and is the reason it does.
 *
 * WHAT THIS FILE IS ACTUALLY FOR is not the two sentences the bot posts. It is
 * the far larger set of moments where it must post NOTHING, because every one
 * of those is something the owner said out loud and none of them is visible
 * from reading the happy path:
 *
 *   the planning is never announced — `scheduled`, `draining` and `cancelled`
 *   go past in silence, however much the row moves;
 *
 *   a window that ran while the bot was down is never caught up on — the audit
 *   trail is the record, and "the server is back" four hours late is worse
 *   than nothing;
 *
 *   a restart mid-window does not re-announce — which is the entire job of the
 *   file in the state directory;
 *
 *   an unreadable row is "cannot see", not "no window" — it changes nothing and
 *   says nothing to the channel;
 *
 *   nobody is ever tagged. The name of whoever scheduled the outage is text.
 */

/** The channel from the issue. Recorded so a fake cannot answer for any id. */
const MAINTENANCE_CHANNEL = '1542601972325158992'

/**
 * Warn, error and info lines go to the journal, and several cases below depend
 * on one having been written. A missed maintenance notice is invisible from
 * Discord — that is the whole reason those lines exist, and without these
 * assertions they could be deleted without a test noticing.
 */
const stderr: string[] = []
const stdout: string[] = []

beforeEach(() => {
  stderr.length = 0
  stdout.length = 0

  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString())
    return true
  }) as unknown as typeof process.stderr.write)

  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString())
    return true
  }) as unknown as typeof process.stdout.write)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** The journal, both streams, as one string to search. */
const journal = (): string => [...stdout, ...stderr].join('')

/* ------------------------------------------------------------------ *
 * The fakes.
 * ------------------------------------------------------------------ */

const CREATED_AT = 1_756_512_000_000
const DRAIN_STARTED_AT = CREATED_AT + 300_000
const DEPLOY_STARTED_AT = CREATED_AT + 600_000

/**
 * The clock every case runs against, unless it says otherwise.
 *
 * AN HOUR AFTER THE WINDOW WAS CREATED, WHICH MAKES EVERY FIXTURE ROW STALE BY
 * DEFAULT. Two rules now read the clock — the recency door in
 * `FRESH_TRANSITION_MS` and the grace in `RESTART_GRACE_MS` — and a default
 * `Date.now()` would have made half of this file's answers depend on the real
 * date it ran on. Stale is the conservative default: a case that wants the
 * recency door open has to say so, in the same line as the assertion that
 * depends on it.
 */
const NOW = CREATED_AT + 3_600_000

/**
 * The fields the console writes that ddb.ts's `MaintenanceWindow` does not name.
 *
 * SPELLED OUT HERE BECAUSE THE POINT OF THESE ROWS IS THAT THEY CARRY THEM.
 * ddb.ts's interface is a DECLARED SUBSET and says so; the console writes
 * another twenty attributes and every one of them arrives on the item. A fake
 * built from the interface alone would be testing a row DynamoDB never returns
 * — and six of these are exactly what the drain notice and the completion gate
 * read.
 */
interface RowExtras {
  drainStartedAt?: number | null
  deployStartedAt?: number | null
  /** Written by the driver when a heartbeat from a NEW process arrives. */
  deployConfirmedAt?: number | null
  /** What the deploy verb returned, when it returned a refusal. */
  deployError?: string | null
  deployLandedSha?: string | null
  shownSha?: string | null
  targetSha?: string | null
}

/** A row off `ringmaster-maintenance`. */
function windowRow(
  state: MaintenanceState,
  overrides: Partial<MaintenanceWindow> & RowExtras = {},
): MaintenanceWindow {
  return {
    // `current` on every row there will ever be: it is the table's key, not an
    // identifier for this window. `createdAt` is what tells two windows apart.
    id: 'current',
    state,
    createdAt: CREATED_AT,
    createdByName: 'Admin One',
    note: 'quick patch, back in five',
    drainStartsAt: DRAIN_STARTED_AT,
    drainStartedAt: DRAIN_STARTED_AT,
    deployMode: 'when-empty',
    deployAt: null,
    deployStartedAt: DEPLOY_STARTED_AT,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  } as MaintenanceWindow
}

/**
 * A `complete` row the game has answered on, which is the only kind that
 * produces the back-up notice.
 *
 * `deployConfirmedAt` IS WHAT MAKES IT COMPLETE AS FAR AS THIS BOT IS
 * CONCERNED. The console marks the window complete when its deploy verb
 * returns; the owner's rule is that nothing is said until br_ringmaster has
 * delivered its first heartbeat, and this field is the console's durable record
 * that one arrived from a NEW process.
 */
function confirmedRow(overrides: Partial<MaintenanceWindow> & RowExtras = {}): MaintenanceWindow {
  const completedAt = DEPLOY_STARTED_AT + 30_000

  return windowRow('complete', {
    completedAt,
    deployConfirmedAt: completedAt + 20_000,
    ...overrides,
  })
}

/** The address the back-up notice names, and the line it names it in. */
const CONNECT = 'The game server is back up and maintenance is complete. Connect: fivem://connect/'
const BACK_UP = `${CONNECT}3.130.92.28`

const ok = (window: MaintenanceWindow | null): DdbResult<MaintenanceWindow | null> => ({
  ok: true,
  value: window,
})

const TIMED_OUT: DdbFailure = {
  kind: 'timeout',
  op: 'get',
  table: 'ringmaster-maintenance',
  message: 'ringmaster-maintenance get timed out after 2000ms',
}

const failed = (failure: DdbFailure = TIMED_OUT): DdbResult<MaintenanceWindow | null> => ({
  ok: false,
  failure,
})

/**
 * The row, one answer per poll.
 *
 * THE LAST ANSWER REPEATS rather than running out, because most cases here are
 * "the row said X, then it said Y, and nothing changes after that" and a queue
 * that emptied would make the third poll a different kind of event.
 */
function reader(...answers: DdbResult<MaintenanceWindow | null>[]): {
  read: () => Promise<DdbResult<MaintenanceWindow | null>>
  reads: () => number
} {
  let calls = 0

  return {
    read: () => {
      const answer = answers[Math.min(calls, answers.length - 1)]
      calls += 1
      if (answer === undefined) throw new Error('the reader was given no answers')
      return Promise.resolve(answer)
    },
    reads: () => calls,
  }
}

/**
 * The state file, in memory.
 *
 * ABSENT, UNREADABLE AND UNWRITABLE ARE THREE DIFFERENT ANSWERS and each one
 * has a case below. Absent is the ordinary state of a box this has never run
 * on; unreadable means the state directory is broken; unwritable means the
 * next restart could repeat a notice.
 */
function fakeMemory(options: { seen?: string | Error; unwritable?: boolean } = {}): {
  memory: MaintenanceMemory
  file: () => string | null
  writes: () => number
  reads: () => number
} {
  let file: string | null = typeof options.seen === 'string' ? `${options.seen}\n` : null
  let writes = 0
  let reads = 0

  return {
    memory: {
      seen: () => {
        reads += 1
        if (options.seen instanceof Error) return Promise.reject(options.seen)
        if (file === null) {
          return Promise.reject(
            Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
          )
        }
        return Promise.resolve(file)
      },
      remember: (mark) => {
        writes += 1
        if (options.unwritable === true) {
          return Promise.reject(new Error('EROFS: read-only file system'))
        }
        file = `${mark}\n`
        return Promise.resolve()
      },
    },
    file: () => file,
    writes: () => writes,
    reads: () => reads,
  }
}

/** A post that always works, and remembers what it was handed. */
const poster = (): Mock<(content: string) => Promise<void>> => vi.fn(() => Promise.resolve())

/**
 * A watch with the two live edges faked.
 *
 * The memory defaults to absent, which is a first-ever start: no mark, so the
 * first poll can only adopt.
 */
interface WatcherOptions {
  seen?: string | Error
  unwritable?: boolean
  post?: Mock<(content: string) => Promise<void>>

  /**
   * The clock. A number for the cases that care about one instant, a function
   * for the handful where time has to pass BETWEEN two polls of one watcher —
   * the completion gate holding and then giving up is the whole reason the
   * second form exists.
   */
  now?: number | (() => number)

  /** The IP allowlist, for the one notice that names an address. */
  serverIps?: readonly string[]
}

function watcher(
  answers: DdbResult<MaintenanceWindow | null>[],
  options: WatcherOptions = {},
): {
  check: () => Promise<void>
  stopped: () => boolean
  post: Mock<(content: string) => Promise<void>>
  file: () => string | null
  writes: () => number
  reads: () => number
  fileReads: () => number
} {
  const source = reader(...answers)
  const store = fakeMemory(options)
  const post = options.post ?? poster()

  const clock = options.now ?? NOW
  const now = typeof clock === 'function' ? clock : (): number => clock

  const watch = maintenanceWatch({
    read: source.read,
    post,
    memory: store.memory,
    now,
    serverIps: options.serverIps,
  })

  return {
    check: watch.check,
    stopped: watch.stopped,
    post,
    file: store.file,
    writes: store.writes,
    reads: source.reads,
    fileReads: store.reads,
  }
}

/** A mark as the file holds one, for a case that starts mid-window. */
const mark = (state: MaintenanceState, window = CREATED_AT): string => `${window} ${state}`

/** One captured post, or a loud failure rather than an undefined comparison. */
function at(post: Mock<(content: string) => Promise<void>>, index: number): string {
  const call = post.mock.calls[index]
  if (call === undefined) throw new Error(`nothing was posted at index ${index}`)
  return call[0]
}

/* ------------------------------------------------------------------ *
 * The three posts.
 * ------------------------------------------------------------------ */

describe('the outage — the three things this bot says', () => {
  /**
   * ONE WHOLE WINDOW, POLL BY POLL, AND EXACTLY THREE POSTS COME OUT OF IT.
   * Every other case in this file pins one edge of that; this one is the shape
   * the owner described, start to finish, and it is the case that would notice
   * a change making the three notices four.
   */
  it('says three things across a whole window and nothing else', async () => {
    const watch = watcher([
      ok(windowRow('scheduled')),
      ok(windowRow('draining')),
      ok(windowRow('deploying')),
      ok(confirmedRow()),
    ])

    for (let poll = 0; poll < 4; poll += 1) await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(3)
    expect(at(watch.post, 0)).toBe(
      'A maintenance window has started and the game server is no longer accepting new players or matches.\nscheduled by Admin One',
    )
    expect(at(watch.post, 1)).toBe(
      'the server is going down\nquick patch, back in five\nscheduled by Admin One',
    )
    expect(at(watch.post, 2)).toBe(BACK_UP)
  })

  /**
   * THE SECOND WINDOW IS NOT THE FIRST ONE AGAIN. `ringmaster-maintenance` holds
   * ONE row and the console overwrites it, so the only thing separating this
   * outage from the last one is `createdAt` — and a bot that keyed on `id`
   * would key on the literal string `current` and treat every window after the
   * first as a continuation of it.
   */
  it('announces the next window as well as the one before it', async () => {
    const second = CREATED_AT + 86_400_000
    const watch = watcher([
      ok(windowRow('deploying')),
      ok(windowRow('scheduled', { createdAt: second })),
      ok(windowRow('deploying', { createdAt: second })),
    ])

    for (let poll = 0; poll < 3; poll += 1) await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(watch.file()).toBe(`${mark('deploying', second)}\n`)
  })

  it('says the server is going down when the window reaches deploying', async () => {
    const watch = watcher([ok(windowRow('draining')), ok(windowRow('deploying'))])

    await watch.check()
    expect(watch.post).not.toHaveBeenCalled()

    await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(at(watch.post, 0)).toContain('the server is going down')
  })

  /**
   * THE NOTE IS WHAT PLAYERS WERE TOLD AT THE DOOR. The console shows the same
   * string to anybody refused a connection while the window drains, so the
   * channel post carrying different words about one outage would be a second
   * story about it.
   */
  it('carries the note the admin wrote', async () => {
    const row = windowRow('deploying', { note: 'map rotation fix, ten minutes' })
    const watch = watcher([ok(row)], { seen: mark('draining') })

    await watch.check()

    expect(at(watch.post, 0)).toContain('map rotation fix, ten minutes')
  })

  it('names whoever scheduled it', async () => {
    const row = windowRow('deploying', { createdByName: 'Willow' })
    const watch = watcher([ok(row)], { seen: mark('draining') })

    await watch.check()

    expect(at(watch.post, 0)).toContain('Willow')
  })

  /**
   * A NOTE OR A NAME THAT IS NOT THERE IS AN OMITTED LINE, not a blank one and
   * not a placeholder. The owner's standing rule is that this bot adds no text
   * nobody asked for, and "no note given" is text nobody asked for.
   */
  it('omits the line rather than posting an empty one', async () => {
    const row = windowRow('deploying', { note: '   ', createdByName: '' })
    const watch = watcher([ok(row)], { seen: mark('draining') })

    await watch.check()

    expect(at(watch.post, 0)).toBe('the server is going down')
  })

  /**
   * THE BACK-UP NOTICE, IN HIS WORDS, WITH NO DURATION IN IT.
   *
   * "'The server is back down for 3s' is ridiculous lol." The old notice
   * computed `completedAt - deployStartedAt` and called it an outage; that
   * number measured the console's round trip, because `completedAt` is stamped
   * when the deploy VERB returns and the verb returns as soon as it has
   * detached the restart. It is gone, and it is not replaced with a better
   * number: he asked for it dropped.
   */
  it('says the server is back up, with the address, and no duration', async () => {
    const watch = watcher([ok(confirmedRow())], { seen: mark('deploying') })

    await watch.check()

    expect(at(watch.post, 0)).toBe(
      'The game server is back up and maintenance is complete. Connect: fivem://connect/3.130.92.28',
    )
    expect(at(watch.post, 0)).not.toContain('down for')
  })

  /**
   * THE URL IS BARE AND MUST STAY BARE. Discord restricts MASKED links to the
   * http, https and discord schemes and rejects anything else, in embeds and
   * components alike — so `[Connect](fivem://…)` does not render as a link at
   * all, while a plain-text `fivem://` url in ordinary message content does and
   * launches the game. This assertion exists because the markdown form looks
   * like an obvious improvement to anybody who has not tried it.
   */
  it('posts the connect url as plain text and never as a masked link', async () => {
    const watch = watcher([ok(confirmedRow())], { seen: mark('deploying') })

    await watch.check()

    const notice = at(watch.post, 0)

    expect(notice).toContain('fivem://connect/')
    expect(notice).not.toContain('](fivem:')
    expect(notice).not.toContain('[')
  })

  /**
   * AND THE ADDRESS COMES OFF THE ALLOWLIST RATHER THAN OUT OF THIS FILE. A
   * literal in the notice would be the same string written down twice, and the
   * day the community moves boxes only one of the copies gets updated.
   */
  it('names the head of the server allowlist', async () => {
    const watch = watcher([ok(confirmedRow())], {
      seen: mark('deploying'),
      serverIps: ['10.0.0.7', '10.0.0.8'],
    })

    await watch.check()

    expect(at(watch.post, 0)).toBe(`${CONNECT}10.0.0.7`)
  })
})

/* ------------------------------------------------------------------ *
 * The drain notice.
 * ------------------------------------------------------------------ */

/**
 * THE NOTICE THAT REVERSED A RULE.
 *
 * The owner had said post at `deploying` and `complete` and never announce the
 * planning. He now wants the START of the window announced as well, "whether it
 * came from /drain or from the console", carrying the current commit, the commit
 * it is heading for, and who set it going. Every case here is one clause of
 * that.
 */
describe('the drain notice — the window starting', () => {
  const STARTED =
    'A maintenance window has started and the game server is no longer accepting new players or matches.'

  const TIP = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const PIN = '9876543210fedcba9876543210fedcba98765432'

  it('says the window has started when the row reaches draining', async () => {
    const watch = watcher([ok(windowRow('scheduled')), ok(windowRow('draining'))])

    await watch.check()
    expect(watch.post).not.toHaveBeenCalled()

    await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(at(watch.post, 0)).toContain(STARTED)
  })

  /**
   * THE COMMIT IT IS HEADING FOR, OFF THE ROW AND NOT OFF ANYTHING THIS BOT
   * WORKED OUT. `shownSha` is the destination the console's maintenance page
   * NAMED when somebody pressed the button — see `MaintenanceWindow.shownSha`
   * over there, which exists precisely so the claim survives the card that made
   * it.
   */
  it('names the commit the window is heading for', async () => {
    const watch = watcher([ok(windowRow('draining', { shownSha: TIP }))], {
      seen: mark('scheduled'),
    })

    await watch.check()

    expect(at(watch.post, 0)).toContain('updating to a1b2c3d4')
  })

  /**
   * AND A PINNED SWITCH OUTRANKS IT, WHICH IS THE CONSOLE'S OWN ORDERING.
   * `targetSha` is a commit the game box ENFORCES — `switchref` refuses if the
   * branch has moved and `deploy.sh` refuses again — and the route writes
   * `shownSha` as null for such a window "so a second, weaker commit beside it
   * cannot invite a comparison against the wrong one". A row carrying both is
   * not one the console writes; reading the pin first is what makes that
   * ordering explicit rather than accidental.
   */
  it('prefers the pinned commit over the one the page named', async () => {
    const row = windowRow('draining', { targetSha: PIN, shownSha: TIP })
    const watch = watcher([ok(row)], { seen: mark('scheduled') })

    await watch.check()

    expect(at(watch.post, 0)).toContain('updating to 98765432')
    expect(at(watch.post, 0)).not.toContain('a1b2c3d4')
  })

  /**
   * ABBREVIATED ONLY WHEN IT IS CERTAINLY A COMMIT. Forty hex characters is the
   * only shape the console ever writes into these fields, and eight is what
   * every commit card in the console shows — so the two surfaces name one
   * deploy in one shape. Anything else is printed whole, because a value of an
   * unexpected shape is not one this bot has any business trimming.
   */
  it('prints a value that is not a full commit whole rather than cutting it', async () => {
    const watch = watcher([ok(windowRow('draining', { shownSha: 'origin/main' }))], {
      seen: mark('scheduled'),
    })

    await watch.check()

    expect(at(watch.post, 0)).toContain('updating to origin/main')
  })

  /**
   * ═══ THE CURRENT COMMIT IS BUILT AND IS ABSENT ON EVERY REAL WINDOW ═══
   *
   * `deployLandedSha` is the only commit on this row that was ever OBSERVED on
   * the game box, and the console writes it at deploy CONFIRMATION — so a window
   * that is only just draining has never had one, and `schedule()` writes it as
   * an explicit null besides. The line is built and tested because the day the
   * console records a running commit at scheduling time this reads it with no
   * further change; until then the notice names where the server is going and
   * not where it is.
   */
  it('names the running commit when the row carries one', async () => {
    const watch = watcher([ok(windowRow('draining', { deployLandedSha: PIN, shownSha: TIP }))], {
      seen: mark('scheduled'),
    })

    await watch.check()

    expect(at(watch.post, 0)).toBe(
      `${STARTED}\nrunning 98765432\nupdating to a1b2c3d4\nscheduled by Admin One`,
    )
  })

  /** And an absent commit is an omitted line rather than a blank or a guess. */
  it('omits both commit lines when the row names neither', async () => {
    const watch = watcher([ok(windowRow('draining'))], { seen: mark('scheduled') })

    await watch.check()

    expect(at(watch.post, 0)).toBe(`${STARTED}\nscheduled by Admin One`)
  })

  it('names whoever scheduled it and omits the line when nobody is named', async () => {
    const named = watcher([ok(windowRow('draining', { createdByName: 'Willow' }))], {
      seen: mark('scheduled'),
    })

    await named.check()
    expect(at(named.post, 0)).toContain('scheduled by Willow')

    const anonymous = watcher([ok(windowRow('draining', { createdByName: '  ' }))], {
      seen: mark('scheduled'),
    })

    await anonymous.check()
    expect(at(anonymous.post, 0)).toBe(STARTED)
  })

  /**
   * THE NOTE IS NOT REPEATED HERE. It rides the going-down notice, and a player
   * reading both would be told the same sentence twice about one outage.
   */
  it('does not repeat the door note the going-down notice carries', async () => {
    const watch = watcher([ok(windowRow('draining'))], { seen: mark('scheduled') })

    await watch.check()

    expect(at(watch.post, 0)).not.toContain('quick patch, back in five')
  })

  /**
   * ═══ THE CASE THE WHOLE RECENCY RULE EXISTS FOR ═══
   *
   * `/drain` schedules with the drain starting NOW, and `POST /api/maintenance`
   * ends with `ensureDriver(); void tick()` — the console drives the row it has
   * just written immediately. So `scheduled` lasts well under a second and this
   * bot's first sight of a `/drain` is a row that is already `draining`, with no
   * mark for it. Under the old rule that was silence, and the notice the owner
   * asked for would have fired only for windows somebody scheduled for later.
   */
  it('announces a drain that started moments ago even with no mark for it', async () => {
    const watch = watcher([ok(windowRow('draining'))], { now: DRAIN_STARTED_AT + 9_000 })

    await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(at(watch.post, 0)).toContain(STARTED)
  })

  /**
   * AND THE DOOR IS ONLY THAT WIDE. A drain runs until the last match finishes,
   * which can be hours; a bot restarted in the middle of one must not announce a
   * window an admin watched start forty minutes ago.
   */
  it('says nothing about a drain that started long ago and it never saw', async () => {
    const watch = watcher([ok(windowRow('draining'))], {
      now: DRAIN_STARTED_AT + FRESH_TRANSITION_MS + 1,
    })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * A RESTART MID-DRAIN IS NOT A SECOND DRAIN. The mark off disk says this
   * window was already draining when the process died, so the notice it posted
   * before the restart is not posted again — whatever the recency rule would say
   * about the timestamp on its own.
   */
  it('does not re-announce a drain it had already announced before a restart', async () => {
    const watch = watcher([ok(windowRow('draining'))], {
      seen: mark('draining'),
      now: DRAIN_STARTED_AT + 9_000,
    })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * THE SAME DOOR FOR THE GOING-DOWN NOTICE, AND FOR THE SAME REASON. A window
   * that drains on an empty server can go from written to `deploying` inside one
   * poll, and a bot that refused to speak about it would announce nothing at all
   * about an outage that was happening while it watched.
   */
  it('announces a deploy that started moments ago even with no mark for it', async () => {
    const watch = watcher([ok(windowRow('deploying'))], { now: DEPLOY_STARTED_AT + 9_000 })

    await watch.check()

    expect(at(watch.post, 0)).toContain('the server is going down')
  })
})

/* ------------------------------------------------------------------ *
 * The completion gate.
 * ------------------------------------------------------------------ */

/**
 * "THE MAINTENANCE COMPLETE MESSAGE SHOULD NEVER SHOW UNTIL br_ringmaster HAS
 * DELIVERED ITS FIRST HEARTBEAT."
 *
 * `complete` IS THE CONSOLE FINISHING AND NOT THE GAME ANSWERING. The deploy
 * verb returns as soon as it has detached `systemctl start royale-deploy`, so
 * the row says complete while FXServer is still coming up. The only proof of
 * life that reaches DynamoDB is `deployConfirmedAt`, which the console's driver
 * stamps onto this same row when it sees a push from a NEW boot epoch —
 * `ringmaster-telemetry` has no writer at all and the ingest path is in-memory
 * by design, so there is nothing else to read.
 */
describe('the completion gate — waiting for the game to speak', () => {
  it('says nothing while the row is complete and nothing has confirmed it', async () => {
    const row = windowRow('complete', { completedAt: NOW - 30_000 })
    const watch = watcher([ok(row)], { seen: mark('deploying') })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * AND IT DOES NOT RECORD THE STATE WHILE IT WAITS. Advancing the mark would
   * write the transition down as handled, and the notice would then be
   * suppressed forever as "nothing moved" — the one post whose absence nobody
   * can see, lost to a bookkeeping shortcut.
   */
  it('leaves the mark where it was so the next poll asks again', async () => {
    const row = windowRow('complete', { completedAt: NOW - 30_000 })
    const watch = watcher([ok(row)], { seen: mark('deploying') })

    await watch.check()

    expect(watch.file()).toBe(`${mark('deploying')}\n`)
    expect(watch.writes()).toBe(0)
  })

  it('posts the notice on the poll the heartbeat lands in', async () => {
    const waiting = windowRow('complete', { completedAt: NOW - 30_000 })
    const watch = watcher([ok(waiting), ok(confirmedRow({ completedAt: NOW - 30_000 }))], {
      seen: mark('deploying'),
    })

    await watch.check()
    expect(watch.post).not.toHaveBeenCalled()

    await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(at(watch.post, 0)).toBe(BACK_UP)
    expect(watch.file()).toBe(`${mark('complete')}\n`)
  })

  /**
   * NEWER THAN THE DEPLOY, WHICH IS THE OWNER'S WORD. The console clears this
   * field at `schedule` and again at `markDeploying`, so a value that predates
   * the deploy is a row that should not exist — and the safe reading of one is
   * that nothing has confirmed, which stays quiet rather than announcing a
   * server is up.
   */
  it('ignores a confirmation that is not newer than the deploy', async () => {
    const row = windowRow('complete', {
      completedAt: NOW - 30_000,
      deployConfirmedAt: DEPLOY_STARTED_AT - 1_000,
    })
    const watch = watcher([ok(row)], { seen: mark('deploying') })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * AND WITH NO DEPLOY CLOCK THERE IS NOTHING TO BE NEWER THAN. A row that
   * cannot say when its own deploy began cannot prove anything about a
   * timestamp sitting beside it.
   */
  it('ignores a confirmation on a row with no deploy clock at all', async () => {
    const row = windowRow('complete', {
      deployStartedAt: null,
      completedAt: null,
      deployConfirmedAt: NOW - 1_000,
    })
    const watch = watcher([ok(row)], { seen: mark('deploying') })

    await watch.check()

    // Out of time as well as unprovable, so it says the thing it can stand
    // behind rather than nothing at all. See `graceExpired`.
    expect(at(watch.post, 0)).toContain('PLACEHOLDER')
    expect(at(watch.post, 0)).not.toContain('back up')
  })

  /**
   * ═══ THE WAIT IS BOUNDED, WHICH IS THE OTHER HALF OF WHAT HE ASKED FOR ═══
   *
   * "If no heartbeat arrives within some window, say something rather than
   * staying silent forever — a server that never came back is exactly what an
   * admin needs to know." Five minutes is the console's own `RESTART_GRACE_MS`,
   * and past it the honest thing is to stop offering an excuse.
   */
  it('reports a server that never came back once the grace runs out', async () => {
    const completedAt = NOW - RESTART_GRACE_MS - 1_000
    const watch = watcher([ok(windowRow('complete', { completedAt }))], {
      seen: mark('deploying'),
    })

    await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(at(watch.post, 0)).toContain('has not reported back')
  })

  it('reports it once and not on every poll after that', async () => {
    const completedAt = NOW - RESTART_GRACE_MS - 1_000
    const watch = watcher([ok(windowRow('complete', { completedAt }))], {
      seen: mark('deploying'),
    })

    for (let poll = 0; poll < 4; poll += 1) await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
  })

  /**
   * A STATED FAILURE ENDS THE WAIT AT ONCE. `deployError` is the host refusing —
   * an SSH channel that is not configured, a pin the box would not take, a
   * script that exited non-zero — and the console's `deployPhase` tests it
   * before anything about heartbeats for the same reason: the code never
   * shipped, so no amount of waiting produces a restart to hear from.
   */
  it('does not sit out the grace when the console recorded a deploy error', async () => {
    const row = windowRow('complete', {
      completedAt: NOW - 1_000,
      deployError: 'host refused: no ssh key configured',
    })
    const watch = watcher([ok(row)], { seen: mark('deploying') })

    await watch.check()

    expect(at(watch.post, 0)).toContain('has not reported back')

    // The console's own words, unedited, for the reason /drain shows a refusal
    // verbatim: this bot cannot know better than the thing that tried it.
    expect(at(watch.post, 0)).toContain('host refused: no ssh key configured')
  })

  /**
   * AND AN ALARM IS NOT THE END OF THE STORY. A heartbeat that arrives after the
   * grace has expired is the server coming back, and a channel that said "it has
   * not reported back" and then never mentioned it again is worse than one that
   * said neither.
   */
  it('corrects its own alarm when the game turns up late, exactly once', async () => {
    const completedAt = NOW - RESTART_GRACE_MS - 1_000
    const late = windowRow('complete', { completedAt, deployConfirmedAt: NOW - 500 })

    const watch = watcher([ok(windowRow('complete', { completedAt })), ok(late)], {
      seen: mark('deploying'),
    })

    await watch.check()
    await watch.check()
    await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(2)
    expect(at(watch.post, 0)).toContain('has not reported back')
    expect(at(watch.post, 1)).toBe(BACK_UP)
  })

  /**
   * AND `complete` IS NEVER GIVEN THE RECENCY DOOR. The two live notices are
   * warnings about something happening now; "the server is back up" is a report
   * about something that finished, and a report is exactly what must not arrive
   * about a window this process never watched go down.
   */
  it('says nothing about a window it never watched, however fresh the confirmation', async () => {
    const watch = watcher([ok(confirmedRow({ completedAt: NOW - 5_000 }))], {
      now: NOW,
    })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ *
 * The silences.
 * ------------------------------------------------------------------ */

describe('the planning — the two states nothing is ever said about', () => {
  /**
   * `scheduled` AND `cancelled`, AND THE LIST USED TO HAVE `draining` ON IT.
   *
   * IT WAS TAKEN OFF ON THE OWNER'S INSTRUCTION AND NOT BY DRIFT. He had said
   * post at `deploying` and `complete` and never announce the planning; he has
   * since asked for the START of the window announced too — "A maintenance
   * window has started and the game server is no longer accepting new players
   * or matches" — because that is not the planning, it is the door shutting on
   * players who are trying to get in right now. The rest of the rule stands,
   * and this is what holds it: a window that was scheduled for later, or called
   * off, was never an outage and is never spoken about.
   */
  it.each<[MaintenanceState, MaintenanceState]>([
    ['deploying', 'cancelled'],
    ['draining', 'cancelled'],
    ['complete', 'scheduled'],
    ['scheduled', 'cancelled'],
  ])('says nothing when a window moves from %s to %s', async (from, to) => {
    const watch = watcher([ok(windowRow(to))], { seen: mark(from) })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * A CANCELLED WINDOW IS THE CASE THAT MAKES THE RULE WORTH HAVING. A window
   * scheduled for 3am and called off at 2 says nothing at either end, so the
   * channel never carries two posts about an outage that did not happen — and
   * the next real notice in it is read with full attention.
   *
   * IT IS CANCELLED FROM `scheduled` RATHER THAN FROM `draining`, which is the
   * only shape that stays silent now: a window that reached `draining` DID shut
   * the door, players were turned away, and the notice about that is exactly
   * the one he asked for. `cancel` in the console refuses anything past
   * draining anyway.
   */
  it('says nothing about a window that was scheduled and then cancelled', async () => {
    const watch = watcher([
      ok(windowRow('scheduled')),
      ok(windowRow('cancelled', { cancelledAt: CREATED_AT + 400_000 })),
    ])

    await watch.check()
    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
    expect(watch.file()).toBe(`${mark('cancelled')}\n`)
  })

  it('still records what it watched go past in silence', async () => {
    const watch = watcher([ok(windowRow('draining'))])

    await watch.check()

    // Recorded even though nothing was posted, and that is load-bearing: the
    // posting rule is "this window moved while we were watching", and the
    // states nothing is said about are what establish that we were watching.
    expect(watch.file()).toBe(`${mark('draining')}\n`)
  })

  it('says nothing and records nothing when there is no window at all', async () => {
    const watch = watcher([ok(null)], { seen: mark('complete') })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
    expect(watch.writes()).toBe(0)
    expect(watch.file()).toBe(`${mark('complete')}\n`)
  })
})

describe('no catch-up posts — a window the bot did not see begin', () => {
  /**
   * THE CASE THE WHOLE MEMORY EXISTS FOR. The bot is restarted by every update.
   * A window that ran entirely inside one of those restarts is a `createdAt`
   * this bot has never recorded, and "the server is back" posted hours after
   * the fact is the catch-up the owner ruled out — Ringmaster's audit trail is
   * the record of what happened while the bot was not there.
   */
  it('stays silent about a window that ran and finished while the bot was down', async () => {
    const later = windowRow('complete', {
      createdAt: CREATED_AT + 86_400_000,
      completedAt: CREATED_AT + 86_700_000,
    })
    const watch = watcher([ok(later)], { seen: mark('complete') })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
    expect(watch.file()).toBe(`${mark('complete', CREATED_AT + 86_400_000)}\n`)
  })

  it.each<MaintenanceState>(['deploying', 'complete'])(
    'stays silent on a first-ever start that finds a window already in %s',
    async (state) => {
      const watch = watcher([ok(windowRow(state, { completedAt: DEPLOY_STARTED_AT + 60_000 }))])

      await watch.check()

      expect(watch.post).not.toHaveBeenCalled()
    },
  )

  /**
   * THE BASELINE IS ADOPTED, NOT DISCARDED. A bot that came up mid-outage says
   * nothing about the going-down it slept through — but it is watching now, and
   * the end of that outage is a transition it sees with its own eyes.
   */
  it('announces the end of an outage it came up in the middle of', async () => {
    const watch = watcher([ok(windowRow('deploying')), ok(confirmedRow())])

    await watch.check()
    await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(at(watch.post, 0)).toBe(BACK_UP)
  })

  it('treats a file that does not hold a mark as no memory at all', async () => {
    const watch = watcher([ok(windowRow('deploying'))], { seen: 'a1b2c3d' })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
    expect(journal()).toContain('the maintenance state file does not hold a mark')
  })

  it.each([
    ['a state that is not one of the five', `${CREATED_AT} deployed`],
    ['a window that is not a number', 'current deploying'],
    ['more than a mark', `${CREATED_AT} deploying and then some`],
    ['nothing at all', '   '],
  ])('treats %s as no memory at all', async (_why, contents) => {
    const watch = watcher([ok(windowRow('deploying'))], { seen: contents })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })
})

describe('a restart mid-window — the whole job of the state file', () => {
  /**
   * THE NOTICE WAS ALREADY POSTED BEFORE THE RESTART. `Restart=always` means a
   * crash during an outage brings this process back in seconds, and a second
   * "the server is going down" for the same outage is the noise the owner has a
   * standing rule against.
   */
  it('does not re-announce a going-down it already posted', async () => {
    const watch = watcher([ok(windowRow('deploying'))], { seen: mark('deploying') })

    await watch.check()
    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  it('does not re-announce a completion it already posted', async () => {
    const done = windowRow('complete', { completedAt: DEPLOY_STARTED_AT + 60_000 })
    const watch = watcher([ok(done)], { seen: mark('complete') })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * THE OTHER HALF: the mark says this bot watched the window go down, so the
   * outage it announced is one it may finish announcing even though the
   * `complete` landed while it was restarting.
   */
  it('still announces the end of the outage it announced the start of', async () => {
    const watch = watcher([ok(confirmedRow())], { seen: mark('deploying') })

    await watch.check()

    expect(at(watch.post, 0)).toBe(BACK_UP)
  })

  it('writes the mark only when the state actually moved', async () => {
    const watch = watcher([ok(windowRow('draining'))], { seen: mark('draining') })

    await watch.check()
    await watch.check()
    await watch.check()

    // Three reads, no change, no writes: a poll loop that rewrote the same mark
    // every fifteen seconds would be a write to the state directory five and a
    // half thousand times a day for no information at all.
    expect(watch.reads()).toBe(3)
    expect(watch.writes()).toBe(0)
  })

  /**
   * A STATE DIRECTORY THAT CANNOT BE WRITTEN MUST NOT MAKE THIS PROCESS SHOUT.
   * The mark is advanced in memory first, so the only thing a failed write
   * costs is that a restart before the next transition could repeat the notice
   * once — not the same notice every fifteen seconds for as long as the bot is
   * up.
   */
  it('does not repeat a notice when the mark cannot be written', async () => {
    const watch = watcher([ok(windowRow('deploying'))], {
      seen: mark('draining'),
      unwritable: true,
    })

    await watch.check()
    await watch.check()
    await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(journal()).toContain('could not record the maintenance state')
  })

  it('says so when the mark cannot be read at all', async () => {
    const watch = watcher([ok(windowRow('deploying'))], {
      seen: new Error('EACCES: permission denied'),
    })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('could not read what maintenance state was last seen')
  })

  /**
   * A FIRST-EVER START IS NOT A FAULT. No state file is the ordinary condition
   * of a box nobody has run this on, and a warning about a feature nobody has
   * set up is the noise every other optional path in this bot avoids.
   */
  it('says nothing about a state file that has never existed', async () => {
    const watch = watcher([ok(windowRow('scheduled'))])

    await watch.check()

    expect(journal()).not.toContain('could not read what maintenance state was last seen')
    expect(journal()).not.toContain('does not hold a mark')
  })

  /**
   * THE FILE IS READ ONCE PER PROCESS AND THE MARK IS HELD IN MEMORY. Every
   * decision is made against the in-memory copy; the file exists for exactly
   * one thing, which is surviving a restart. A poll loop that re-read it four
   * times a minute would also be one where a disk that went unreadable
   * mid-window quietly turned the anti-re-announce protection off.
   */
  it('reads the file once per process, not once per poll', async () => {
    const watch = watcher([ok(windowRow('draining'))], { seen: mark('draining') })

    await watch.check()
    await watch.check()
    await watch.check()

    expect(watch.reads()).toBe(3)
    expect(watch.fileReads()).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * Failure.
 * ------------------------------------------------------------------ */

describe('an unreadable row is "cannot see", not "no window"', () => {
  /**
   * THE TWO MUST NOT COLLAPSE INTO EACH OTHER. Treating a timeout as an absent
   * window would clear the mark, and the next successful read would then be a
   * window this bot has never seen — so the outage in progress would go
   * unannounced AND the notice that it ended would be suppressed as a catch-up.
   */
  it('changes nothing and posts nothing', async () => {
    const watch = watcher([failed()], { seen: mark('draining') })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
    expect(watch.writes()).toBe(0)
    expect(watch.file()).toBe(`${mark('draining')}\n`)
  })

  it('leaves the mark intact, so the notice still lands when the row comes back', async () => {
    const watch = watcher([failed(), ok(windowRow('deploying'))], { seen: mark('draining') })

    await watch.check()
    await watch.check()

    expect(at(watch.post, 0)).toContain('the server is going down')
  })

  /**
   * A MISSED NOTICE IS INVISIBLE, which is why the journal line is not
   * optional. Every other failure in this bot leaves something a person can
   * trip over; a maintenance notice that was never posted looks exactly like a
   * maintenance window that never happened, from Discord, forever.
   */
  it('writes a line for every failed read', async () => {
    const watch = watcher([failed()])

    await watch.check()

    expect(journal()).toContain('could not read the maintenance window')
    expect(journal()).toContain('timeout')
  })

  /**
   * ONE FAILED READ IS A POLL, NOT A PROBLEM — log.ts is explicit that a call
   * the next attempt will make again is `info`. A run of them means the bot
   * cannot see maintenance at all, which does need a person, and it is said
   * once rather than four times a minute for as long as it lasts.
   */
  it('escalates to a warning only once the reads have been failing for a while', async () => {
    const watch = watcher([failed()])

    await watch.check()
    expect(stderr.join('')).toBe('')

    await watch.check()
    await watch.check()
    expect(stderr.join('')).toBe('')

    await watch.check()
    expect(stderr.join('')).toContain('an outage may go unannounced')

    stderr.length = 0
    await watch.check()
    await watch.check()
    expect(stderr.join('')).toBe('')
  })

  it('starts the count again once a read succeeds', async () => {
    const watch = watcher([
      failed(),
      failed(),
      failed(),
      ok(windowRow('draining')),
      failed(),
      failed(),
      failed(),
    ])

    for (let poll = 0; poll < 7; poll += 1) await watch.check()

    expect(stderr.join('')).not.toContain('an outage may go unannounced')
  })
})

describe('a channel the bot cannot post in', () => {
  const refused = new DiscordAPIError(
    { code: RESTJSONErrorCodes.MissingPermissions, message: 'Missing Permissions' },
    RESTJSONErrorCodes.MissingPermissions,
    403,
    'POST',
    'https://discord.com/api/v10/channels/0/messages',
    {},
  )

  /**
   * A WRONG ID DOES NOT GET BETTER BY BEING RETRIED, and retrying it costs a
   * request and a journal line every fifteen seconds for as long as the process
   * lives. One line, then silence — the same latch `statusReporter` makes, on
   * the same three Discord codes.
   */
  it('says so once and stops', async () => {
    const post = vi.fn(() => Promise.reject(refused))
    const watch = watcher([ok(windowRow('deploying'))], { seen: mark('draining'), post })

    await watch.check()
    await watch.check()
    await watch.check()

    expect(post).toHaveBeenCalledTimes(1)
    expect(watch.stopped()).toBe(true)
    expect(stderr.join('')).toContain('maintenance channel unusable')
    expect(stderr.join('').match(/maintenance channel unusable/gu)).toHaveLength(1)
  })

  /**
   * A RATE LIMIT IS FIFTEEN SECONDS OF PATIENCE. The mark is NOT advanced on a
   * failed post, so the next poll tries the same transition again — which is
   * the only retry this feature gets, and the one post in the bot whose absence
   * nobody can see.
   */
  it('retries a notice the API refused for a reason that will pass', async () => {
    let attempts = 0
    const post = vi.fn(() => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('rate limited')) : Promise.resolve()
    })

    const watch = watcher([ok(windowRow('deploying'))], { seen: mark('draining'), post })

    await watch.check()
    expect(watch.stopped()).toBe(false)
    expect(watch.writes()).toBe(0)

    await watch.check()

    expect(post).toHaveBeenCalledTimes(2)
    expect(watch.file()).toBe(`${mark('deploying')}\n`)
    expect(journal()).toContain('it will be retried')
  })

  it('does not repeat the notice once the retry has landed', async () => {
    let attempts = 0
    const post = vi.fn(() => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('rate limited')) : Promise.resolve()
    })

    const watch = watcher([ok(windowRow('deploying'))], { seen: mark('draining'), post })

    await watch.check()
    await watch.check()
    await watch.check()

    expect(post).toHaveBeenCalledTimes(2)
  })
})

/* ------------------------------------------------------------------ *
 * The send, and the wiring.
 * ------------------------------------------------------------------ */

/** A client with one channel behind it, and a record of what reached it. */
function channelHarness(options: { sendable?: boolean; missing?: boolean } = {}): {
  client: Client
  send: Mock<(payload: { content: string; allowedMentions: unknown }) => Promise<unknown>>
  sent: string[]
  fetched: string[]
  ready: () => void
} {
  const fetched: string[] = []
  const sent: string[] = []

  const send = vi.fn((payload: { content: string; allowedMentions: unknown }) => {
    sent.push(payload.content)
    return Promise.resolve({})
  })

  const waiting: (() => void)[] = []

  const client = {
    once: (event: unknown, handler: () => void) => {
      if (event === Events.ClientReady) waiting.push(handler)
    },
    channels: {
      // The id is recorded rather than ignored: which channel an outage is
      // announced in is a decision — BLITZ_MAINTENANCE_CHANNEL_ID and not one
      // of the other three — and a fake that answers whatever it is asked
      // cannot tell them apart.
      fetch: (id: string) => {
        fetched.push(id)
        if (options.missing === true) return Promise.resolve(null)
        return Promise.resolve({ isSendable: () => options.sendable ?? true, send })
      },
    },
  } as unknown as Client

  return {
    client,
    send,
    sent,
    fetched,
    ready: () => {
      for (const handler of waiting.splice(0, waiting.length)) handler()
    },
  }
}

describe('the send — named, never tagged', () => {
  /**
   * THE OWNER'S RULE, MADE STRUCTURAL. The content carries two strings typed by
   * a human into the console — a note and a display name — and either can hold
   * `@everyone` or a raw `<@id>`. Naming who scheduled an outage must never
   * ping them, and an announcement channel is the worst possible place to find
   * that out.
   */
  it('suppresses every mention on the post', async () => {
    const { client, send } = channelHarness()

    await maintenancePoster(client, MAINTENANCE_CHANNEL)('the server is going down')

    expect(send).toHaveBeenCalledWith({
      content: 'the server is going down',
      allowedMentions: { parse: [] },
    })
  })

  it('suppresses them for a note and a name that are trying to ping', async () => {
    const { client, send, sent } = channelHarness()
    const row = windowRow('deploying', {
      note: '@everyone get out',
      createdByName: '<@280000000000000000>',
    })

    const watch = maintenanceWatch({
      read: () => Promise.resolve(ok(row)),
      post: maintenancePoster(client, MAINTENANCE_CHANNEL),
      memory: fakeMemory({ seen: mark('draining') }).memory,
    })

    await watch.check()

    expect(send.mock.calls[0]?.[0].allowedMentions).toEqual({ parse: [] })

    // The text is carried through as text — the name is NAMED, which is what
    // was asked for — and it is the `allowedMentions` above, not any rewriting
    // of the content here, that makes it inert.
    expect(sent[0]).toContain('@everyone get out')
    expect(sent[0]).toContain('<@280000000000000000>')
  })

  it('posts to the channel it was given and no other', async () => {
    const { client, fetched } = channelHarness()

    await maintenancePoster(client, MAINTENANCE_CHANNEL)('the server is back')

    expect(fetched).toEqual([MAINTENANCE_CHANNEL])
  })

  it.each([
    ['names no channel', { missing: true }],
    ['names one this bot cannot post in', { sendable: false }],
  ])('refuses permanently when the id %s', async (_why, options) => {
    const { client } = channelHarness(options)
    const post = maintenancePoster(client, MAINTENANCE_CHANNEL)

    const watch = maintenanceWatch({
      read: () => Promise.resolve(ok(windowRow('deploying'))),
      post,
      memory: fakeMemory({ seen: mark('draining') }).memory,
    })

    await watch.check()
    await watch.check()

    // Latched rather than retried: a channel id that names nothing is a
    // variable and a restart, exactly like the three Discord codes.
    expect(watch.stopped()).toBe(true)
    expect(stderr.join('')).toContain('maintenance channel unusable')
  })

  /**
   * DISCORD REJECTS THE WHOLE MESSAGE AT 2000 CHARACTERS, not the overflow. The
   * note is free text typed into the console's schedule form and nothing
   * upstream bounds it, so without a cap the single most important post this
   * feature makes is dropped by the API — invisibly.
   */
  it('caps a note that would take the post past what Discord accepts', async () => {
    const { client, sent } = channelHarness()
    const row = windowRow('deploying', { note: 'x'.repeat(5_000) })

    const watch = maintenanceWatch({
      read: () => Promise.resolve(ok(row)),
      post: maintenancePoster(client, MAINTENANCE_CHANNEL),
      memory: fakeMemory({ seen: mark('draining') }).memory,
    })

    await watch.check()

    const content = sent[0] ?? ''
    expect(content.length).toBeLessThan(2_000)
    expect(content).toContain('…')
  })

  /**
   * CUT BY CODE POINT, like every other cut in this repo. A UTF-16 slice can
   * land inside a surrogate pair and put half a character into an announcement.
   */
  it('cuts a note by code point, never through a surrogate pair', async () => {
    const { client, sent } = channelHarness()
    const row = windowRow('deploying', { note: '🎮'.repeat(2_000), createdByName: '' })

    const watch = maintenanceWatch({
      read: () => Promise.resolve(ok(row)),
      post: maintenancePoster(client, MAINTENANCE_CHANNEL),
      memory: fakeMemory({ seen: mark('draining') }).memory,
    })

    await watch.check()

    const note = (sent[0] ?? '').split('\n')[1] ?? ''
    const points = [...note]

    expect(points.at(-1)).toBe('…')
    expect(points.slice(0, -1).every((point) => point === '🎮')).toBe(true)
  })
})

describe('the poll loop', () => {
  const ddb = (
    answer: DdbResult<MaintenanceWindow | null>,
  ): { maintenance: { current: () => Promise<DdbResult<MaintenanceWindow | null>> } } => ({
    maintenance: { current: () => Promise.resolve(answer) },
  })

  it('starts nothing until the gateway is up', async () => {
    vi.useFakeTimers()
    const { client, send, fetched, ready } = channelHarness()

    watchMaintenance(client, MAINTENANCE_CHANNEL, ddb(ok(windowRow('deploying'))), {
      memory: fakeMemory({ seen: mark('draining') }).memory,
    })

    await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS * 3)
    expect(fetched).toEqual([])

    ready()
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenCalledTimes(1)
  })

  /**
   * THE FIRST POLL IS IMMEDIATE AND ALWAYS SILENT: it is what establishes the
   * baseline. Waiting fifteen seconds to do that would only delay the point
   * from which real transitions are visible.
   */
  it('polls once immediately and then on the interval', async () => {
    vi.useFakeTimers()
    const { client, ready } = channelHarness()
    const current = vi.fn(() => Promise.resolve(ok(windowRow('draining'))))

    watchMaintenance(
      client,
      MAINTENANCE_CHANNEL,
      { maintenance: { current } },
      { memory: fakeMemory().memory },
    )

    ready()
    await vi.advanceTimersByTimeAsync(0)
    expect(current).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS)
    expect(current).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS * 2)
    expect(current).toHaveBeenCalledTimes(4)
  })

  /**
   * A RECONNECT IS NOT A RESTART. `once` rather than `on`, because a second
   * interval on the same client would double every read and race two posts of
   * the same notice against each other.
   */
  it('starts one loop however many times the gateway comes up', async () => {
    vi.useFakeTimers()
    const { client, ready } = channelHarness()
    const current = vi.fn(() => Promise.resolve(ok(windowRow('draining'))))

    watchMaintenance(
      client,
      MAINTENANCE_CHANNEL,
      { maintenance: { current } },
      { memory: fakeMemory().memory },
    )

    ready()
    ready()
    await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS)

    expect(current).toHaveBeenCalledTimes(2)
  })

  /**
   * ONE POLL AT A TIME. The read carries a two-second deadline and the post is
   * a Discord request, so a tick CAN outlast the interval — and two overlapping
   * checks would both read the same transition before either had advanced the
   * mark, and post it twice.
   */
  it('does not start a poll on top of one still running', async () => {
    vi.useFakeTimers()
    const { client, send, ready } = channelHarness()

    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const current = vi.fn(async () => {
      await held
      return ok(windowRow('deploying'))
    })

    watchMaintenance(
      client,
      MAINTENANCE_CHANNEL,
      { maintenance: { current } },
      { memory: fakeMemory({ seen: mark('draining') }).memory },
    )

    ready()
    await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS * 4)

    // Four intervals went past while the first read was still in flight, and
    // not one of them started a second.
    expect(current).toHaveBeenCalledTimes(1)

    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenCalledTimes(1)
  })

  /**
   * `unref` FOR THE REASON EVERY OTHER TIMER IN THIS BOT IS UNREFFED: a poll
   * loop is not a reason for `systemctl stop` to sit through its timeout.
   */
  it('does not hold the process open', async () => {
    vi.useFakeTimers()
    const { client, ready } = channelHarness()
    const unref = vi.fn()

    const interval = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>)

    watchMaintenance(client, MAINTENANCE_CHANNEL, ddb(ok(null)), {
      memory: fakeMemory().memory,
    })
    ready()
    await vi.advanceTimersByTimeAsync(0)

    expect(interval).toHaveBeenCalledTimes(1)
    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('stops polling once the channel has been found unusable', async () => {
    vi.useFakeTimers()
    const { client, ready } = channelHarness({ missing: true })
    const current = vi.fn(() => Promise.resolve(ok(windowRow('deploying'))))

    watchMaintenance(
      client,
      MAINTENANCE_CHANNEL,
      { maintenance: { current } },
      { memory: fakeMemory({ seen: mark('draining') }).memory },
    )

    ready()
    await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS * 5)

    // The latch stops the reads too, not just the posts: a loop that kept
    // reading a table it can never report on is a bill with no output.
    expect(current).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------------ *
 * Properties of the module itself.
 * ------------------------------------------------------------------ */

describe('what this module is allowed to touch', () => {
  const source = (): Promise<string> =>
    readFile(new URL('./maintenance.ts', import.meta.url), 'utf8')

  /**
   * READS ONLY, AND THE PARAMETER TYPE IS THE POLICY. The console owns the
   * maintenance lifecycle and owns the consequences of moving it; a Discord bot
   * that could mark a window complete would be a second, less careful
   * implementation of a path that stops a live server.
   */
  it('asks the data layer for exactly one thing', async () => {
    const current = vi.fn(() => Promise.resolve(ok(windowRow('draining'))))

    // Everything else on the Ddb throws if it is reached at all. The type only
    // offers `maintenance`; this is the second lock, for a cast that got past
    // it.
    const forbidden = (name: string): never => {
      throw new Error(`maintenance.ts must not call ${name}`)
    }

    const ddb = {
      maintenance: { current },
      audit: {
        begin: () => forbidden('audit.begin'),
        resolve: () => forbidden('audit.resolve'),
        recent: () => forbidden('audit.recent'),
      },
      botState: { get: () => forbidden('botState.get'), put: () => forbidden('botState.put') },
      bans: { get: () => forbidden('bans.get') },
    }

    const { client, ready } = channelHarness()
    vi.useFakeTimers()

    watchMaintenance(client, MAINTENANCE_CHANNEL, ddb, { memory: fakeMemory().memory })
    ready()
    await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS * 3)

    expect(current).toHaveBeenCalled()
  })

  it('writes no Ringmaster table', async () => {
    const text = await source()

    // A source assertion because the absence of a write is not observable from
    // a return value, and the fake above can only catch a call it was given a
    // stub for. `audit` is matched as a call and not as a word: the module
    // comment says out loud that Ringmaster's audit TRAIL is the record for
    // everything this bot stays silent about.
    expect(text).not.toMatch(/\.put\(/u)
    expect(text).not.toMatch(/\.update\(/u)
    expect(text).not.toMatch(/audit\s*\.\s*(begin|resolve|recent)/u)
    expect(text).not.toContain('botState')
  })

  /**
   * NOT AN IMPORT OF client.ts, AND A TEST BECAUSE THE COST OF GETTING IT WRONG
   * IS A CYCLE. client.ts is the file that wires this module; importing back
   * out of it would put the two in a loop, which ESM resolves in an order
   * nobody chose.
   */
  it('does not import the file that wires it', async () => {
    const text = await source()

    expect(text).not.toContain("from './client.ts'")
  })
})

describe('where the mark is kept', () => {
  /**
   * THE UNIT'S `StateDirectory=`, for the reason client.ts's reported-commit
   * file is there: the updater owns /opt/blitz-bot and runs `git reset --hard`
   * in it, so a mark kept under the repo is discarded by the next update — and
   * a forgotten mark is a re-announced outage.
   */
  it('is outside the repo the updater resets', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url))

    expect(maintenanceStatePath().startsWith(repo)).toBe(false)
  })

  /**
   * systemd's OWN ANSWER FIRST, so the unit file and this cannot drift apart
   * about where the directory is. `StateDirectory=` exports `STATE_DIRECTORY`,
   * colon-separated when a unit names more than one; the literal is the
   * fallback for a bot started by hand.
   */
  it('takes the directory from systemd when the unit supplies one', () => {
    const expected = join('/var/lib/blitz-bot', 'maintenance-seen')

    try {
      vi.stubEnv('STATE_DIRECTORY', '/var/lib/blitz-bot:/var/lib/other')
      expect(maintenanceStatePath()).toBe(expected)

      vi.stubEnv('STATE_DIRECTORY', '')
      expect(maintenanceStatePath()).toBe(expected)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not share a file with anything else in that directory', () => {
    // A distinct name, so the deploy notice's `reported-commit` and this cannot
    // overwrite each other into a file that parses as neither.
    expect(maintenanceStatePath().endsWith('maintenance-seen')).toBe(true)
    expect(maintenanceStatePath()).not.toContain('reported-commit')
  })

  /**
   * THE SEAM BETWEEN THE RULES ABOVE AND A REAL DISK, which is the one part of
   * this the fakes cannot speak for: a missing file has to reject with the
   * `ENOENT` that `baseline` reads as "never seen anything", and what is
   * written has to come back the way it went in.
   */
  it('rejects with ENOENT when there is no file, and round-trips a mark when there is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blitz-bot-'))

    try {
      const memory = maintenanceMemory(join(dir, 'maintenance-seen'))

      await expect(memory.seen()).rejects.toMatchObject({ code: 'ENOENT' })

      await memory.remember(mark('deploying'))

      // The trailing newline is deliberate, like the reported-commit file
      // beside it: `cat` of this should not run into the next prompt.
      await expect(memory.seen()).resolves.toBe(`${mark('deploying')}\n`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
