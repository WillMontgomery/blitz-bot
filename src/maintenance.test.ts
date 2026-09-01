import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { DdbFailure, DdbResult, MaintenanceState, MaintenanceWindow } from './ddb.ts'
import {
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
 * The maintenance notice, offline.
 *
 * NOTHING HERE TOUCHES AWS, DISCORD OR A DISK. The row arrives from a fake
 * three lines above the assertion, the channel is an object with a `send` on
 * it, and the memory is a string in a closure — which is possible because
 * `maintenanceWatch` takes all three as options, and is the reason it does.
 *
 * ═══ THERE IS ONE POST NOW, AND THIS FILE IS MOSTLY ABOUT THE SILENCES ═══
 *
 * "Let's not log any drain action in discord actually… And same for when the
 * server shuts down. Just post when the server comes back up." So four of the
 * five states say NOTHING, and that is not a happy path anybody can read off the
 * one sentence this bot still speaks — it is a set of rules the owner stated out
 * loud, each of which needs a case:
 *
 *   the drain is not announced, and neither is the shutdown — the two notices
 *   that used to fire there are gone, along with the admin's note, the tag for
 *   whoever scheduled it, the drain timestamp and the second commit;
 *
 *   the planning is not announced either — `scheduled` and `cancelled` go past
 *   in silence, which was true before the cut and stays true after it;
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
 *   nothing routine reaches #bot-status. That channel is fed by log.ts's copy of
 *   `warn` and `error`, so the LEVEL of every line here is a decision about
 *   which channel an outage is reported in, and it is asserted as one.
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
const DRAIN_STARTS_AT = CREATED_AT + 300_000
const DEPLOY_STARTED_AT = CREATED_AT + 600_000

/**
 * The clock every case runs against, unless it says otherwise.
 *
 * AN HOUR AFTER THE WINDOW WAS CREATED, WHICH MAKES EVERY FIXTURE ROW STALE BY
 * DEFAULT. The grace in `RESTART_GRACE_MS` reads the clock, and a default
 * `Date.now()` would have made those answers depend on the real date the suite
 * ran on.
 */
const NOW = CREATED_AT + 3_600_000

/**
 * The fields the console writes that ddb.ts's `MaintenanceWindow` does not name.
 *
 * SPELLED OUT HERE BECAUSE THE POINT OF THESE ROWS IS THAT THEY CARRY THEM.
 * ddb.ts's interface is a DECLARED SUBSET and says so; the console writes
 * another twenty attributes and every one of them arrives on the item. A fake
 * built from the interface alone would be testing a row DynamoDB never returns
 * — and five of these are exactly what the notice and the completion gate read.
 */
interface RowExtras {
  deployStartedAt?: number | null
  /** Written by the driver when a heartbeat from a NEW process arrives. */
  deployConfirmedAt?: number | null
  /** What the deploy verb returned, when it returned a refusal. */
  deployError?: string | null
  /** What the deploy actually put on the box. See `runningSha`. */
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
    drainStartsAt: DRAIN_STARTS_AT,
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
 * produces a post at all.
 *
 * `deployConfirmedAt` IS WHAT MAKES IT COMPLETE AS FAR AS THIS BOT IS
 * CONCERNED. The console marks the window complete when its deploy verb
 * returns; the owner's rule is that nothing is said until br_ringmaster has
 * delivered its first heartbeat, and this field is the console's durable record
 * that one arrived from a NEW process.
 *
 * NO COMMIT ON IT BY DEFAULT, so `BACK_UP` below is the shortest true form of
 * the notice and the cases that care about the hash add one.
 */
function confirmedRow(overrides: Partial<MaintenanceWindow> & RowExtras = {}): MaintenanceWindow {
  const completedAt = DEPLOY_STARTED_AT + 30_000

  return windowRow('complete', {
    completedAt,
    deployConfirmedAt: completedAt + 20_000,
    ...overrides,
  })
}

/**
 * The notice, in his words, as the pieces of it.
 *
 * SPELLED OUT HERE AND NOT ASSEMBLED FROM THE MODULE'S OWN CONSTANTS, because
 * the whole property being tested is that the wording is HIS and unedited. A
 * string imported from maintenance.ts would agree with whatever that file
 * happened to say, including a version somebody rephrased.
 */
const BACK = 'The game server is back up and maintenance is complete.'
const connectTo = (ip: string): string => `fivem://connect/${ip}`
const BACK_UP = `${BACK} ${connectTo('3.130.92.28')}.`

/** Where a commit in a maintenance notice has to point. NOT this bot's repo. */
const GAME_COMMIT = 'https://github.com/WillMontgomery/fivem-br-gamemode/commit/'

/** Forty hex characters, which is the only shape the console writes. */
const LANDED = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const PIN = '9876543210fedcba9876543210fedcba98765432'
const SHOWN = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c'

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

  /** The IP allowlist, for the address the notice names. */
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
 * The one post.
 * ------------------------------------------------------------------ */

describe('the outage — the one thing this bot says', () => {
  /**
   * ONE WHOLE WINDOW, POLL BY POLL, AND EXACTLY ONE POST COMES OUT OF IT.
   *
   * THIS CASE USED TO EXPECT THREE. "Let's not log any drain action in discord
   * actually… We can have the commands but we don't need to post anything when it
   * happens. And same for when the server shuts down. Just post when the server
   * comes back up." Every other case in this file pins one edge of that; this one
   * is the shape he described, start to finish, and it is the case that would
   * notice a change making the one notice two.
   */
  it('says one thing across a whole window and nothing else', async () => {
    const watch = watcher([
      ok(windowRow('scheduled')),
      ok(windowRow('draining')),
      ok(windowRow('deploying')),
      ok(confirmedRow({ deployLandedSha: LANDED })),
    ])

    for (let poll = 0; poll < 4; poll += 1) await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(at(watch.post, 0)).toBe(
      'The game server is back up and maintenance is complete. ' +
        `The server is now running [a1b2c3d4](${GAME_COMMIT}${LANDED}). ` +
        'fivem://connect/3.130.92.28.',
    )
  })

  /**
   * ═══ ONE FLOWING PARAGRAPH. THE NEWLINES ARE NOT TO BE PUT BACK ═══
   *
   * He asked twice why the notices were "wrapped on multiple lines. That looks so
   * weird." His wording is flowing sentences, so flowing text is the request
   * rather than a formatting taste. This is the assertion that fails if somebody
   * tidies the source by breaking the template literal, or reaches for
   * `lines.join('\n')` because it reads more neatly in a diff.
   */
  it('is one flowing paragraph and carries no newline at all', async () => {
    const watch = watcher([ok(confirmedRow({ deployLandedSha: LANDED }))], {
      seen: mark('deploying'),
    })

    await watch.check()

    expect(at(watch.post, 0)).not.toContain('\n')
  })

  /**
   * ═══ THE CONNECT LINK IS A BARE URL, AND A REAL MESSAGE IS WHY ═══
   *
   * HE WROTE IT AS A MASKED LINK — "[Click here to connect](fivem:// hyperlink)"
   * — so that is what shipped, and the owner posted what came out of it:
   *
   *   The game server is back up and maintenance is complete. The server is now
   *   running 2e880268. [Click here to connect](fivem://connect/3.130.92.28).
   *
   * The brackets and parentheses printed as characters. `2e880268` in the same
   * sentence was a working link, built the same `[text](url)` way by
   * `commitLink` — so markdown is fine in plain message content and the scheme
   * is the whole of the difference. Discord's masked-link allowlist is not a
   * rule about embeds and buttons only; it covers message content too.
   *
   * SO THIS PINS THE BARE FORM AND FAILS IF ANYONE WRAPS IT BACK UP. The second
   * assertion is a shape and not the old label: a re-wrap under any text at all
   * is the same mistake, and it is one nobody should have to learn from a second
   * live cycle.
   */
  it('offers the connect link as a bare url, never masked', async () => {
    const watch = watcher([ok(confirmedRow())], { seen: mark('deploying') })

    await watch.check()

    expect(at(watch.post, 0)).toContain('fivem://connect/3.130.92.28')
    expect(at(watch.post, 0)).not.toMatch(/\[[^\]]*\]\(fivem:/u)
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

    expect(at(watch.post, 0)).toBe(`${BACK} ${connectTo('10.0.0.7')}.`)
  })

  /**
   * THE DURATION IS GONE AND IS NOT REPLACED. "'The server is back down for 3s'
   * is ridiculous lol." The old notice computed `completedAt - deployStartedAt`
   * and called it an outage; that number measured the console's round trip,
   * because `completedAt` is stamped when the deploy VERB returns and the verb
   * returns as soon as it has detached the restart. He asked for it dropped, so a
   * truer number is still a number he did not ask for.
   */
  it('carries no duration', async () => {
    const watch = watcher([ok(confirmedRow())], { seen: mark('deploying') })

    await watch.check()

    expect(at(watch.post, 0)).toBe(BACK_UP)
    expect(at(watch.post, 0)).not.toContain('down for')
  })

  /**
   * ═══ WHAT THE DELETED NOTICES CARRIED IS NOT APPENDED TO THIS ONE ═══
   *
   * The drain notice held a timestamp and a destination commit; the going-down
   * notice held the admin's free-text note and a tag for whoever scheduled the
   * window. He cut both posts, so those four facts have nowhere left to be — and
   * a fact that was in a message he deleted is not a clause this bot may fold
   * into the message he kept.
   *
   * THE ROW STILL CARRIES THE NOTE AND THE NAME, which is why this is worth
   * asserting rather than assuming: they are two fields away from any reader in
   * the file, and a future edit that "restores" either would be reversing a
   * decision instead of fixing an omission.
   */
  it('carries neither the door note nor who scheduled it', async () => {
    const row = confirmedRow({ note: 'map rotation fix, ten minutes', createdByName: 'Willow' })
    const watch = watcher([ok(row)], { seen: mark('deploying') })

    await watch.check()

    expect(at(watch.post, 0)).toBe(BACK_UP)
    expect(at(watch.post, 0)).not.toContain('map rotation fix')
    expect(at(watch.post, 0)).not.toContain('Willow')
    expect(at(watch.post, 0)).not.toContain('scheduled by')
    expect(at(watch.post, 0)).not.toContain('<@')
  })
})

/* ------------------------------------------------------------------ *
 * The commit in the notice.
 * ------------------------------------------------------------------ */

/**
 * "THE SERVER IS NOW RUNNING [hash as hyperlink]", WHICH IS HIS MIDDLE CLAUSE.
 *
 * ONE COMMIT, WHERE THE DELETED NOTICES CARRIED A FROM/TO PAIR. The drain notice
 * named where the window was heading and the going-down notice sat beside it; his
 * sentence names one thing, and `runningSha` reads the row in the order that
 * answers it — what LANDED first, then the destination it was pinned or shown to
 * be going to.
 */
describe('the commit — what the box is running now', () => {
  const confirmed = (extras: RowExtras): ReturnType<typeof watcher> =>
    watcher([ok(confirmedRow(extras))], { seen: mark('deploying') })

  /**
   * `deployLandedSha` IS THE ONLY ONE THAT IS A REPORT RATHER THAN A PLAN, so it
   * wins. The console nulls it at `schedule` and again at `markDeploying`, so a
   * value on a `complete` row was written by THIS window's deploy landing — and
   * `ringmaster-maintenance` holds one row that `schedule` overwrites whole, so
   * there is nowhere for a stale value from last week to have survived.
   */
  it('prefers what landed over where the window was heading', async () => {
    const watch = confirmed({ deployLandedSha: LANDED, targetSha: PIN, shownSha: SHOWN })

    await watch.check()

    expect(at(watch.post, 0)).toContain(`The server is now running [a1b2c3d4](${GAME_COMMIT}${LANDED}).`)
    expect(at(watch.post, 0)).not.toContain('98765432')
  })

  /**
   * AND A PINNED SWITCH OUTRANKS THE PAGE'S OWN READING, which is the console's
   * ordering. `targetSha` is a commit the game box ENFORCES — `switchref` refuses
   * if the branch has moved and `deploy.sh` refuses again — and
   * `POST /api/maintenance` writes `shownSha` as null whenever `targetRef` is set,
   * precisely so the weaker record cannot be mistaken for the stronger one.
   */
  it('falls back to the pinned commit before the one the page named', async () => {
    const watch = confirmed({ targetSha: PIN, shownSha: SHOWN })

    await watch.check()

    expect(at(watch.post, 0)).toContain(`[98765432](${GAME_COMMIT}${PIN})`)
    expect(at(watch.post, 0)).not.toContain('0f1e2d3c')
  })

  it('falls back to the commit the console showed when there is nothing else', async () => {
    const watch = confirmed({ shownSha: SHOWN })

    await watch.check()

    expect(at(watch.post, 0)).toContain(`[0f1e2d3c](${GAME_COMMIT}${SHOWN})`)
  })

  /**
   * ═══ AND THE LINK GOES TO THE GAME'S REPO, WHICH IS NOT THIS ONE ═══
   *
   * Every sha on a maintenance row is a commit in `fivem-br-gamemode` — it is what
   * the game box runs and what `royale-deploy` fetches — and this repo has its own
   * `REPO_URL` pointing at `blitz-bot` for the deploy notice, three files away.
   * Building this link on that one produces a URL that resolves, renders and shows
   * an admin an unrelated commit in a codebase with nothing to do with the deploy
   * they are reading about, which is worse than no link at all.
   */
  it('links the commit into the game repo and never into the bot repo', async () => {
    const watch = confirmed({ deployLandedSha: LANDED })

    await watch.check()

    expect(at(watch.post, 0)).toContain(`(${GAME_COMMIT}${LANDED})`)
    expect(at(watch.post, 0)).not.toContain('blitz-bot')
  })

  /**
   * THE TEXT IS THE SHORT SHA AND THE HREF IS THE FULL ONE. GitHub resolves
   * either, so the link is built from the unambiguous value and the reader is
   * shown the eight characters every commit card in the console shows.
   */
  it('shows eight characters and links the whole commit', async () => {
    const watch = confirmed({ deployLandedSha: LANDED })

    await watch.check()

    expect(at(watch.post, 0)).toContain(`[${LANDED.slice(0, 8)}](`)
    expect(at(watch.post, 0)).toContain(LANDED)
  })

  /**
   * ABBREVIATED ONLY WHEN IT IS CERTAINLY A COMMIT, AND LINKED ONLY THEN EITHER.
   * Forty hex characters is the only shape the console ever writes into these
   * fields. Anything else is printed whole and BARE: `…/commit/origin/main` is not
   * a commit URL, and a link that 404s is a promise this bot did not have to make.
   */
  it('prints a value that is not a full commit whole, and does not link it', async () => {
    const watch = confirmed({ deployLandedSha: 'origin/main' })

    await watch.check()

    expect(at(watch.post, 0)).toContain('The server is now running origin/main.')
    expect(at(watch.post, 0)).not.toContain('github.com')
  })

  /**
   * AN ABSENT COMMIT COSTS ITS OWN CLAUSE AND NOT THE NOTICE. An automatic
   * 72-hour window nobody was looking at, or a console whose branch reading was
   * too old to stand behind, carries no commit at all — and "the game server is
   * back up and maintenance is complete" followed by the connect link is still the
   * whole of what he asked to be told.
   */
  it('drops the middle clause when the row names no commit', async () => {
    const watch = confirmed({})

    await watch.check()

    expect(at(watch.post, 0)).toBe(BACK_UP)
    expect(at(watch.post, 0)).not.toContain('now running')
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
 *
 * THIS IS THE HALF OF THE OLD FEATURE THE CUT DID NOT TOUCH, and it is why the
 * one surviving message is worth having: without it the bot would be announcing
 * that a server is joinable at the moment a deploy script was launched.
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
   * AND IT IS ONE LINE, like the notice it stands in for. The alarm joined its
   * two halves with a `\n` while the going-down notice was still stacking lines
   * above it; "why is anything wrapped on multiple lines" was not a remark about
   * one post, and this was the last multi-line message in the file.
   */
  it('says it on one line, with the reason flowing after it', async () => {
    const row = windowRow('complete', {
      completedAt: NOW - 1_000,
      deployError: 'host refused: no ssh key configured',
    })
    const watch = watcher([ok(row)], { seen: mark('deploying') })

    await watch.check()

    expect(at(watch.post, 0)).not.toContain('\n')
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
   * AND `complete` IS NEVER ANNOUNCED FOR A WINDOW THIS PROCESS DID NOT WATCH.
   * "The server is back up" is a report about something that finished, and a
   * report is exactly what must not arrive about an outage that ran while the bot
   * was being updated. The deleted notices had a recency door — a transition the
   * ROW timestamped inside the last two minutes was announced by a process that
   * had not seen it begin — and it was never opened for this one, so it went with
   * them.
   */
  it('says nothing about a window it never watched, however fresh the confirmation', async () => {
    const watch = watcher([ok(confirmedRow({ completedAt: NOW - 5_000 }))], {
      now: NOW,
    })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * DISCORD REJECTS THE WHOLE MESSAGE AT 2000 CHARACTERS, not the overflow, and
   * `deployError` is the one value left in a post that this repo does not bound:
   * another codebase writes it out of whatever a shell script or an SSH library
   * said. The cap moved here off the admin's note when the going-down notice went.
   */
  it('caps a console reason that would take the post past what Discord accepts', async () => {
    const row = windowRow('complete', {
      completedAt: NOW - 1_000,
      deployError: 'x'.repeat(5_000),
    })
    const watch = watcher([ok(row)], { seen: mark('deploying') })

    await watch.check()

    expect(at(watch.post, 0).length).toBeLessThan(2_000)
    expect(at(watch.post, 0)).toContain('…')
  })

  /**
   * CUT BY CODE POINT, like every other cut in this repo. A UTF-16 slice can land
   * inside a surrogate pair and put half a character into an announcement.
   */
  it('cuts that reason by code point, never through a surrogate pair', async () => {
    const row = windowRow('complete', {
      completedAt: NOW - 1_000,
      deployError: '🎮'.repeat(2_000),
    })
    const watch = watcher([ok(row)], { seen: mark('deploying') })

    await watch.check()

    const reason = at(watch.post, 0).split('the console said: ')[1] ?? ''
    const points = [...reason]

    expect(points.at(-1)).toBe('…')
    expect(points.slice(0, -1).every((point) => point === '🎮')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * The silences.
 * ------------------------------------------------------------------ */

/**
 * ═══ FOUR OF THE FIVE STATES SAY NOTHING, AND HE CUT TWO OF THEM HIMSELF ═══
 *
 * `scheduled` and `cancelled` were always silent: he did not want the planning
 * announced, and a window that was planned and called off was never an outage.
 *
 * `draining` AND `deploying` JOINED THEM AFTER HE WATCHED A FULL CYCLE. "Let's
 * not log any drain action in discord actually. Sorry for the confusion. We can
 * have the commands but we don't need to post anything when it happens. And same
 * for when the server shuts down. Just post when the server comes back up." The
 * `/drain` command is untouched — it is the POSTING that went — which is why
 * these cases assert on the channel and not on the row.
 */
describe('the four states nothing is ever said about', () => {
  it.each<MaintenanceState>(['scheduled', 'draining', 'deploying', 'cancelled'])(
    'says nothing when a window this bot is watching reaches %s',
    async (state) => {
      const watch = watcher([ok(windowRow(state))], { seen: mark('scheduled') })

      await watch.check()

      expect(watch.post).not.toHaveBeenCalled()
    },
  )

  /**
   * THE DRAIN IS THE ONE HE CHANGED HIS MIND ABOUT, AND THIS IS THE CASE THAT
   * HOLDS THE SECOND ANSWER. It had a notice of its own — "the server stopped
   * accepting players and matches", with the moment the door shut and the commit
   * it was heading for — and a recency door built specifically so a `/drain` the
   * bot had never seen `scheduled` still produced it. All of that is gone: a fresh
   * drain with no mark for it now says exactly nothing.
   */
  it('says nothing about a drain that started moments ago', async () => {
    const watch = watcher([ok(windowRow('draining'))], { now: DRAIN_STARTS_AT + 9_000 })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /** And the same for the shutdown, which had the same door for the same reason. */
  it('says nothing about a deploy that started moments ago', async () => {
    const watch = watcher([ok(windowRow('deploying'))], { now: DEPLOY_STARTED_AT + 9_000 })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * A CANCELLED WINDOW STILL SAYS NOTHING AT EITHER END, so the channel never
   * carries a post about an outage that did not happen — and the next real notice
   * in it is read with full attention.
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

  /**
   * AND IT STILL RECORDS EVERY ONE OF THEM, WHICH IS LOAD-BEARING AND EASY TO
   * DELETE. Nothing is posted at `draining`, so a reader could reasonably ask why
   * the mark is written there at all. The answer is the notice at the other end:
   * the posting rule is "this window reached `complete` while we were watching",
   * and the four silent states are the whole of the evidence that we were.
   */
  it('still records what it watched go past in silence', async () => {
    const watch = watcher([ok(windowRow('draining'))])

    await watch.check()

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
   * this bot has never recorded, and "the server is back up" posted hours after
   * the fact is the catch-up the owner ruled out — Ringmaster's audit trail is
   * the record of what happened while the bot was not there.
   */
  it('stays silent about a window that ran and finished while the bot was down', async () => {
    const later = confirmedRow({
      createdAt: CREATED_AT + 86_400_000,
      completedAt: CREATED_AT + 86_700_000,
    })
    const watch = watcher([ok(later)], { seen: mark('complete') })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
    expect(watch.file()).toBe(`${mark('complete', CREATED_AT + 86_400_000)}\n`)
  })

  it('stays silent on a first-ever start that finds a window already complete', async () => {
    const watch = watcher([ok(confirmedRow())])

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * THE BASELINE IS ADOPTED, NOT DISCARDED. A bot that came up mid-outage says
   * nothing about the shutdown it slept through — it would say nothing about it
   * anyway now — but it is watching, and the end of that outage is a transition
   * it sees with its own eyes.
   */
  it('announces the end of an outage it came up in the middle of', async () => {
    const watch = watcher([ok(windowRow('deploying')), ok(confirmedRow())])

    await watch.check()
    await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(at(watch.post, 0)).toBe(BACK_UP)
  })

  it('treats a file that does not hold a mark as no memory at all', async () => {
    const watch = watcher([ok(confirmedRow())], { seen: 'a1b2c3d' })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
    expect(journal()).toContain('the maintenance state file does not hold a mark')
  })

  it.each([
    ['a state that is not one of the five', `${CREATED_AT} deployed`],
    ['a window that is not a number', 'current complete'],
    ['more than a mark', `${CREATED_AT} deploying and then some`],
    ['nothing at all', '   '],
  ])('treats %s as no memory at all', async (_why, contents) => {
    const watch = watcher([ok(confirmedRow())], { seen: contents })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * THE SECOND WINDOW IS NOT THE FIRST ONE AGAIN. `ringmaster-maintenance` holds
   * ONE row and the console overwrites it, so the only thing separating this
   * outage from the last one is `createdAt` — and a bot that keyed on `id` would
   * key on the literal string `current` and treat every window after the first as
   * a continuation of it.
   */
  it('announces the next window as well as the one before it', async () => {
    const second = CREATED_AT + 86_400_000
    const watch = watcher([
      ok(confirmedRow()),
      ok(windowRow('deploying', { createdAt: second })),
      ok(confirmedRow({ createdAt: second })),
    ])

    for (let poll = 0; poll < 3; poll += 1) await watch.check()

    // Silent on the first, which it never watched begin; the second it did.
    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(watch.file()).toBe(`${mark('complete', second)}\n`)
  })
})

describe('a restart mid-window — the whole job of the state file', () => {
  it('does not re-announce a completion it already posted', async () => {
    const watch = watcher([ok(confirmedRow())], { seen: mark('complete') })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
  })

  /**
   * THE OTHER HALF: the mark says this bot watched the window go down, so the
   * outage it was watching is one it may finish announcing even though the
   * `complete` landed while it was restarting.
   */
  it('still announces the end of the outage it was watching', async () => {
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
    const watch = watcher([ok(confirmedRow())], {
      seen: mark('deploying'),
      unwritable: true,
    })

    await watch.check()
    await watch.check()
    await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(journal()).toContain('could not record the maintenance state')
  })

  it('says so when the mark cannot be read at all', async () => {
    const watch = watcher([ok(confirmedRow())], {
      seen: new Error('EACCES: permission denied'),
    })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
    expect(journal()).toContain('could not read what maintenance state was last seen')
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
   * window this bot has never seen — so the notice that the outage ended would
   * be suppressed as a catch-up.
   */
  it('changes nothing and posts nothing', async () => {
    const watch = watcher([failed()], { seen: mark('deploying') })

    await watch.check()

    expect(watch.post).not.toHaveBeenCalled()
    expect(watch.writes()).toBe(0)
    expect(watch.file()).toBe(`${mark('deploying')}\n`)
  })

  it('leaves the mark intact, so the notice still lands when the row comes back', async () => {
    const watch = watcher([failed(), ok(confirmedRow())], { seen: mark('deploying') })

    await watch.check()
    await watch.check()

    expect(at(watch.post, 0)).toBe(BACK_UP)
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
    const watch = watcher([ok(confirmedRow())], { seen: mark('deploying'), post })

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

    const watch = watcher([ok(confirmedRow())], { seen: mark('deploying'), post })

    await watch.check()
    expect(watch.stopped()).toBe(false)
    expect(watch.writes()).toBe(0)

    await watch.check()

    expect(post).toHaveBeenCalledTimes(2)
    expect(watch.file()).toBe(`${mark('complete')}\n`)
    expect(journal()).toContain('it will be retried')
  })

  it('does not repeat the notice once the retry has landed', async () => {
    let attempts = 0
    const post = vi.fn(() => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('rate limited')) : Promise.resolve()
    })

    const watch = watcher([ok(confirmedRow())], { seen: mark('deploying'), post })

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

describe('the send — nobody is pinged', () => {
  /**
   * ═══ THE SUPPRESSION OUTLIVED THE REASON IT WAS ADDED, ON PURPOSE ═══
   *
   * It went in when the going-down notice carried two strings a human had typed
   * into the console — an admin's note and a display name — and stayed when the
   * initiator was tagged. Neither exists now: the surviving notice is a fixed
   * sentence, a commit and an address, and nothing in it is meant to notify
   * anybody.
   *
   * WHICH IS EXACTLY WHY IT IS KEPT RATHER THAN DELETED WITH THEM. It is what
   * holds the property true whatever a later edit puts in the content, and an
   * announcement channel is the worst possible place to discover that something
   * pings.
   */
  it('suppresses every mention on the post', async () => {
    const { client, send } = channelHarness()

    await maintenancePoster(client, MAINTENANCE_CHANNEL)(BACK_UP)

    expect(send).toHaveBeenCalledWith({
      content: BACK_UP,
      allowedMentions: { parse: [] },
    })
  })

  /**
   * AND IT HOLDS FOR THE ONE STRING IN A POST THAT ANOTHER CODEBASE WROTE. The
   * console's `deployError` is carried verbatim into the alarm, so it is the one
   * place text this repo never saw can reach an announcement channel.
   */
  it('suppresses them for a console error that is trying to ping', async () => {
    const { client, send, sent } = channelHarness()
    const row = windowRow('complete', {
      completedAt: NOW - 1_000,
      deployError: '@everyone the deploy failed',
    })

    const watch = maintenanceWatch({
      read: () => Promise.resolve(ok(row)),
      post: maintenancePoster(client, MAINTENANCE_CHANNEL),
      memory: fakeMemory({ seen: mark('deploying') }).memory,
      now: () => NOW,
    })

    await watch.check()

    expect(send.mock.calls[0]?.[0].allowedMentions).toEqual({ parse: [] })

    // The text is carried through as text — the console's own words, unedited —
    // and it is the `allowedMentions` above, not any rewriting of the content
    // here, that makes it inert.
    expect(sent[0]).toContain('@everyone the deploy failed')
  })

  it('posts to the channel it was given and no other', async () => {
    const { client, fetched } = channelHarness()

    await maintenancePoster(client, MAINTENANCE_CHANNEL)(BACK_UP)

    expect(fetched).toEqual([MAINTENANCE_CHANNEL])
  })

  it.each([
    ['names no channel', { missing: true }],
    ['names one this bot cannot post in', { sendable: false }],
  ])('refuses permanently when the id %s', async (_why, options) => {
    const { client } = channelHarness(options)
    const post = maintenancePoster(client, MAINTENANCE_CHANNEL)

    const watch = maintenanceWatch({
      read: () => Promise.resolve(ok(confirmedRow())),
      post,
      memory: fakeMemory({ seen: mark('deploying') }).memory,
      now: () => NOW,
    })

    await watch.check()
    await watch.check()

    // Latched rather than retried: a channel id that names nothing is a
    // variable and a restart, exactly like the three Discord codes.
    expect(watch.stopped()).toBe(true)
    expect(stderr.join('')).toContain('maintenance channel unusable')
  })
})

describe('the poll loop', () => {
  /**
   * The one read `watchMaintenance` wires, and nothing else.
   *
   * IT BRIEFLY WIRED TWO. `players.get` was here to turn the initiator's licence
   * into a Discord tag for the going-down notice; nobody is named in the notice
   * that survives, so the `Pick` narrowed back — see the block at the foot of this
   * file, which is where that is asserted rather than assumed.
   */
  const ddb = (
    answer: DdbResult<MaintenanceWindow | null>,
  ): Parameters<typeof watchMaintenance>[2] => ({
    maintenance: { current: () => Promise.resolve(answer) },
  })

  it('starts nothing until the gateway is up', async () => {
    vi.useFakeTimers()
    const { client, send, fetched, ready } = channelHarness()

    watchMaintenance(client, MAINTENANCE_CHANNEL, ddb(ok(confirmedRow())), {
      memory: fakeMemory({ seen: mark('deploying') }).memory,
      now: () => NOW,
    })

    await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS * 3)
    expect(fetched).toEqual([])

    ready()
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenCalledTimes(1)
  })

  /**
   * THE FIRST POLL IS IMMEDIATE AND IS WHAT ESTABLISHES THE BASELINE. Waiting
   * fifteen seconds to do that would only delay the point from which a real
   * transition is visible.
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
      return ok(confirmedRow())
    })

    watchMaintenance(
      client,
      MAINTENANCE_CHANNEL,
      { maintenance: { current } },
      { memory: fakeMemory({ seen: mark('deploying') }).memory, now: () => NOW },
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
    const current = vi.fn(() => Promise.resolve(ok(confirmedRow())))

    watchMaintenance(
      client,
      MAINTENANCE_CHANNEL,
      { maintenance: { current } },
      { memory: fakeMemory({ seen: mark('deploying') }).memory, now: () => NOW },
    )

    ready()
    await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS * 5)

    // The latch stops the reads too, not just the posts: a loop that kept
    // reading a table it can never report on is a bill with no output.
    expect(current).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------------ *
 * Which channel a maintenance window is allowed to appear in.
 * ------------------------------------------------------------------ */

/**
 * ═══ "A MAINTENANCE WINDOW DOES NOT NEED TO WRITE TO #bot-status" ═══
 *
 * "…since it's already writing to #maintenance-notifications." He said it after
 * watching a full drain cycle, and the mechanism is log.ts: `warn` and `error`
 * are COPIED to the status channel and `info` is not, so the level of a line in
 * this module is a decision about which Discord channel it lands in. That is why
 * these are assertions about `stderr` and `stdout` rather than about text — the
 * journal keeps every line either way, and the stream is the part that decides
 * whether it also reaches him.
 *
 * THE THREE LINES AT `info` ARE THE BOT'S OWN BOOKKEEPING about the state file:
 * unreadable, unparseable, unwritable. None of them is the bot failing at what it
 * is FOR — it can still see the window and still post the notice — and the whole
 * consequence is that a restart in the next few minutes could repeat ONE notice.
 *
 * TWO STAY ABOVE IT, AND THEY ARE THE TWO HE NAMED AS EXCEPTIONS: a window this
 * bot could not READ, and a notice it could not POST. Neither is maintenance
 * progress. Both mean an outage may go unannounced, which is the one failure in
 * this feature that is completely invisible from Discord — a notice that never
 * landed looks exactly like a window that never happened.
 */
describe('the status channel — what a maintenance window may put in front of him', () => {
  it('says nothing to the status channel across a whole window', async () => {
    const watch = watcher(
      [
        ok(windowRow('scheduled')),
        ok(windowRow('draining')),
        ok(windowRow('deploying')),
        ok(confirmedRow()),
      ],
      // Unwritable, which is the condition that used to make this the noisiest
      // path in the module: one warn per transition, three per window.
      { unwritable: true },
    )

    for (let poll = 0; poll < 4; poll += 1) await watch.check()

    expect(watch.post).toHaveBeenCalledTimes(1)
    expect(stderr.join('')).toBe('')
  })

  it.each([
    [
      'the state file cannot be written',
      { unwritable: true } as WatcherOptions,
      'could not record the maintenance state',
    ],
    [
      'the state file cannot be read',
      { seen: new Error('EACCES: permission denied') } as WatcherOptions,
      'could not read what maintenance state was last seen',
    ],
    [
      'the state file holds something that is not a mark',
      { seen: 'a1b2c3d' } as WatcherOptions,
      'does not hold a mark',
    ],
  ])('keeps the journal and not the channel when %s', async (_why, options, line) => {
    const watch = watcher([ok(windowRow('draining')), ok(windowRow('deploying'))], {
      seen: mark('scheduled'),
      ...options,
    })

    await watch.check()
    await watch.check()

    expect(stdout.join('')).toContain(line)
    expect(stderr.join('')).toBe('')
  })

  /**
   * THE FIRST OF THE TWO EXCEPTIONS. A minute of failed reads means the bot
   * cannot see maintenance at all, and the outage it is blind to is one nobody
   * will notice went unannounced.
   */
  it('reaches the channel when it cannot read the window at all', async () => {
    const watch = watcher([failed()])

    // Four, which is a minute of them. One failed read is a poll rather than a
    // problem and stays on `info`; see `MAINTENANCE_BLIND_POLLS`.
    for (let poll = 0; poll < 4; poll += 1) await watch.check()

    expect(stderr.join('')).toContain('an outage may go unannounced')
  })

  /**
   * THE SECOND. A channel this bot cannot post in has stopped the whole feature
   * permanently, and it is the one fault that cannot be reported in the channel
   * it is about.
   */
  it('reaches the channel when it cannot post the notice at all', async () => {
    const { client } = channelHarness({ missing: true })

    const watch = maintenanceWatch({
      read: () => Promise.resolve(ok(confirmedRow())),
      post: maintenancePoster(client, MAINTENANCE_CHANNEL),
      memory: fakeMemory({ seen: mark('deploying') }).memory,
      now: () => NOW,
    })

    await watch.check()

    expect(stderr.join('')).toContain('maintenance channel unusable')
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
   *
   * ONE READ AGAIN, AND `players` IS BACK ON THE FORBIDDEN LIST. It was legitimate
   * for exactly as long as the going-down notice tagged whoever scheduled the
   * window; nobody is named in the notice that survives, so a lookup against the
   * player registry from this file would be a read with nothing to answer.
   */
  it('asks the data layer for exactly one thing', async () => {
    const current = vi.fn(() => Promise.resolve(ok(windowRow('draining'))))

    const forbidden = (name: string): never => {
      throw new Error(`maintenance.ts must not call ${name}`)
    }

    const ddb = {
      maintenance: { current },
      players: { get: () => forbidden('players.get') },
      audit: {
        begin: () => forbidden('audit.begin'),
        resolve: () => forbidden('audit.resolve'),
        recent: () => forbidden('audit.recent'),
      },
      botState: { get: () => forbidden('botState.get'), put: () => forbidden('botState.put') },
      bans: { get: () => forbidden('bans.get') },
      playerIds: { licensesFor: () => forbidden('playerIds.licensesFor') },
      gamePlayers: {
        profile: () => forbidden('gamePlayers.profile'),
        matches: () => forbidden('gamePlayers.matches'),
      },
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

      await memory.remember(mark('complete'))

      // The trailing newline is deliberate, like the reported-commit file
      // beside it: `cat` of this should not run into the next prompt.
      await expect(memory.seen()).resolves.toBe(`${mark('complete')}\n`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
