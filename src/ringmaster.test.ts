import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setSink } from './log.ts'
import {
  classify,
  COMMAND_SECRET_HEADER,
  createDrainer,
  createRingmaster,
  DRAIN_DEPLOY_MODE,
  DRAIN_IN_MINUTES,
  DRAIN_NOTE_CAP,
  DRAIN_TIMEOUT_MS,
  KICK_ATTEMPTS,
  KICK_PATH,
  KICK_RETRY_MS,
  KICK_TIMEOUT_MS,
  KICK_TTL_MS,
  LICENSE,
  MAINTENANCE_CANCEL_PATH,
  MAINTENANCE_PATH,
  SERVICE_ACTOR_HEADER,
  type Drainer,
  type DrainerOptions,
  type Fetcher,
  type HttpResponse,
  type KickInput,
} from './ringmaster.ts'

/**
 * THE RELAY, DRIVEN ENTIRELY OFFLINE. `fetch`, the clock and the backoff are all
 * injected, so every case below — each refusal the console can answer with, the
 * retry, both ways of giving up, the per-attempt deadline — runs with no
 * network, no console and no wall-clock waiting.
 *
 * THE CASES ARE WRITTEN AGAINST THE CONSOLE'S REAL ANSWER SHAPES, transcribed
 * from fivem-ringmaster/src/app/api/kick/route.ts and lib/service.ts rather than
 * invented here. A test that asserts against a body the console does not send is
 * a test that passes while the integration is broken, which is the failure this
 * whole file is trying to prevent.
 */

const BASE = 'http://127.0.0.1:3000'
const SECRET = 'a-shared-secret'
const ADMIN = '444444444444444444'
const LICENCE = 'license:0123456789abcdef'

let stdout: string[]
let stderr: string[]

beforeEach(() => {
  stdout = []
  stderr = []

  // `log()` writes straight to the streams, and the retry path logs. Captured
  // rather than left to scroll past every other test in the run.
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
  // The sink is module state in log.ts; the same trap client.test.ts closes.
  setSink(null)
})

/** An answer, as the console would send it. */
function answer(status: number, body: unknown): HttpResponse {
  return { status, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) }
}

/** A `fetch` that hands back the given answers in order, recording every call. */
function replies(...pages: HttpResponse[]) {
  const calls: { url: string; init: Parameters<Fetcher>[1] }[] = []
  let at = 0

  const fetch: Fetcher = (url, init) => {
    calls.push({ url, init })
    const page = pages[Math.min(at, pages.length - 1)]
    at += 1
    if (page === undefined) throw new Error('no answer configured')
    return Promise.resolve(page)
  }

  return { fetch, calls }
}

function input(over: Partial<KickInput> = {}): KickInput {
  return { license: LICENCE, at: 1_000_000, actorDiscordId: ADMIN, ...over }
}

/**
 * A relay whose clock is held still and whose backoff resolves immediately, so a
 * retry costs a tick rather than a minute.
 */
function relay(fetch: Fetcher, over: Partial<Parameters<typeof createRingmaster>[0]> = {}) {
  const waited: number[] = []

  const ringmaster = createRingmaster({
    baseUrl: BASE,
    secret: SECRET,
    fetch,
    now: () => 1_000_000,
    wait: (ms) => {
      waited.push(ms)
      return Promise.resolve()
    },
    ...over,
  })

  return { ringmaster, waited }
}

/** The success the console really sends. */
const DISPATCHED = { ok: true, outcome: 'dispatched', confirmed: false, commandId: 'cmd-1' }

describe('the request the console actually receives', () => {
  it('posts to /api/kick under the base url', async () => {
    const { fetch, calls } = replies(answer(200, DISPATCHED))
    await relay(fetch).ringmaster.kick(input())

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE}${KICK_PATH}`)
    expect(calls[0]?.init.method).toBe('POST')
  })

  /**
   * THE TWO HEADERS ARE THE WHOLE OF THE CONSOLE'S DOOR. The secret proves the
   * caller and the actor names the human; `serviceGate` refuses without either,
   * and a rename on this side would be a 401 or a 400 that reads like an outage.
   */
  it('presents the secret and the acting admin in the headers the console reads', async () => {
    const { fetch, calls } = replies(answer(200, DISPATCHED))
    await relay(fetch).ringmaster.kick(input())

    expect(calls[0]?.init.headers[COMMAND_SECRET_HEADER]).toBe(SECRET)
    expect(calls[0]?.init.headers[SERVICE_ACTOR_HEADER]).toBe(ADMIN)
    expect(calls[0]?.init.headers['content-type']).toBe('application/json')
  })

  /** The header names are a deployed contract, so they are pinned as literals. */
  it('spells the header names the way the console spells them', () => {
    expect(COMMAND_SECRET_HEADER).toBe('x-ringmaster-service')
    expect(SERVICE_ACTOR_HEADER).toBe('x-ringmaster-actor')
    expect(KICK_PATH).toBe('/api/kick')
  })

  /**
   * THE SECRET IS A HEADER AND NOTHING ELSE. A credential in a URL ends up in
   * an access log and in a proxy's error page; one in a body ends up wherever
   * the body is echoed.
   */
  it('never puts the secret in the url or the body', async () => {
    const { fetch, calls } = replies(answer(200, DISPATCHED))
    await relay(fetch).ringmaster.kick(input({ reason: 'cheating' }))

    expect(calls[0]?.url).not.toContain(SECRET)
    expect(calls[0]?.init.body).not.toContain(SECRET)
  })

  it('sends the licence, and the reason and name when there are any', async () => {
    const { fetch, calls } = replies(answer(200, DISPATCHED))
    await relay(fetch).ringmaster.kick(input({ reason: 'cheating', playerName: 'Nate' }))

    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({
      license: LICENCE,
      playerName: 'Nate',
      reason: 'cheating',
    })
  })

  /**
   * OMITTED RATHER THAN NULL, so the body stays a subset of the one the browser
   * sends — and so the console's own default wording for a reasonless kick is
   * the one that fires, instead of a second default invented on this side.
   */
  it('omits the reason and the name entirely when there are none', async () => {
    const { fetch, calls } = replies(answer(200, DISPATCHED))
    await relay(fetch).ringmaster.kick(input({ reason: null, playerName: null }))

    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ license: LICENCE })
  })

  /**
   * Discord allows a 512-character audit reason and the console's schema accepts
   * 300. Truncating keeps the kick; sending it whole would lose the kick over
   * the length of a sentence.
   */
  it('truncates a reason too long for the console rather than losing the kick', async () => {
    const { fetch, calls } = replies(answer(200, DISPATCHED))
    await relay(fetch).ringmaster.kick(input({ reason: 'x'.repeat(400) }))

    const body = JSON.parse(calls[0]?.init.body ?? '{}') as { reason: string }
    expect(body.reason).toHaveLength(300)
  })

  it('truncates an over-long player name for the same reason', async () => {
    const { fetch, calls } = replies(answer(200, DISPATCHED))
    await relay(fetch).ringmaster.kick(input({ playerName: 'n'.repeat(200) }))

    const body = JSON.parse(calls[0]?.init.body ?? '{}') as { playerName: string }
    expect(body.playerName).toHaveLength(120)
  })

  it('drops a whitespace-only reason instead of sending one', async () => {
    const { fetch, calls } = replies(answer(200, DISPATCHED))
    await relay(fetch).ringmaster.kick(input({ reason: '   ' }))

    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ license: LICENCE })
  })
})

describe('a licence the console would reject', () => {
  /**
   * THE CONSOLE WOULD ANSWER A ZOD MESSAGE AND A 400, which this file would
   * classify, report as a failure and correctly never retry. Checking here turns
   * that into the sentence a reader actually needs.
   */
  it('is refused without a request', async () => {
    const { fetch, calls } = replies(answer(200, DISPATCHED))
    const result = await relay(fetch).ringmaster.kick(input({ license: 'discord:44444' }))

    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ outcome: 'failed', failure: 'refused', attempts: 0 })
  })

  it('accepts exactly what the console accepts', () => {
    expect(LICENSE.test('license:0123456789abcdef')).toBe(true)
    expect(LICENSE.test('license2:0123456789abcdef')).toBe(true)
    expect(LICENSE.test('license:ABCDEF0123456789')).toBe(true)
    expect(LICENSE.test('discord:444444444444444444')).toBe(false)
    expect(LICENSE.test('license:xyz')).toBe(false)
    expect(LICENSE.test('license:abc')).toBe(false)
  })
})

describe('what the console said, in the console`s own vocabulary', () => {
  it('reports a dispatch, unconfirmed, with the audit row it named', async () => {
    const { fetch } = replies(answer(200, DISPATCHED))
    const result = await relay(fetch).ringmaster.kick(input())

    expect(result).toEqual({
      outcome: 'dispatched',
      confirmed: false,
      commandId: 'cmd-1',
      attempts: 1,
    })
  })

  /**
   * `dispatched` IS NOT `done` AND THE TYPE SAYS SO. Nothing in this system
   * reports whether a player was really removed, so a caller that reads this as
   * success is wrong. Pinned because it is the one field a later edit would be
   * tempted to drop as noise.
   */
  it('never claims a kick was confirmed', async () => {
    const { fetch } = replies(answer(200, { ok: true, outcome: 'dispatched', confirmed: false }))
    const result = await relay(fetch).ringmaster.kick(input())

    expect(result).toMatchObject({ outcome: 'dispatched', confirmed: false, commandId: null })
  })

  it('tells a game box that answered no from one that never answered', async () => {
    const refused = await relay(
      replies(answer(502, { ok: false, outcome: 'failed', failure: 'refused', detail: 'no such player' })).fetch,
    ).ringmaster.kick(input())

    const unreachable = await relay(
      replies(answer(502, { ok: false, outcome: 'failed', failure: 'unreachable', detail: 'connect ETIMEDOUT' })).fetch,
      { attempts: 1 },
    ).ringmaster.kick(input())

    expect(refused).toMatchObject({ outcome: 'failed', failure: 'refused', detail: 'no such player' })
    expect(unreachable).toMatchObject({ outcome: 'dropped', why: 'exhausted' })
  })

  it('passes the game host`s own words through unedited', async () => {
    const { fetch } = replies(
      answer(502, { ok: false, outcome: 'failed', failure: 'refused', detail: 'that is not a license' }),
    )
    const result = await relay(fetch).ringmaster.kick(input())

    expect(result).toMatchObject({ detail: 'that is not a license' })
  })

  it('reports an unconfigured command channel as itself', async () => {
    const { fetch, calls } = replies(
      answer(503, {
        ok: false,
        outcome: 'failed',
        failure: 'not-configured',
        detail: 'The command channel to the game server is not configured.',
      }),
    )
    const result = await relay(fetch).ringmaster.kick(input())

    // An operator fixes this and no number of retries will.
    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({ outcome: 'failed', failure: 'not-configured', status: 503 })
  })

  /**
   * THE SHAPE THAT IS EASIEST TO MISS. The service gate and `errorResponse`
   * answer `{ ok: false, error: '<machine code>' }` with no `outcome` at all,
   * and it is the shape a stale secret produces — the single most likely thing
   * to be wrong with this integration on the day it is wired up.
   */
  it('recognises every refusal from the console`s door as denied', async () => {
    const doors: [number, string][] = [
      [401, 'auth'],
      [403, 'scope'],
      [400, 'actor'],
      [403, 'role-revoked'],
    ]

    for (const [status, error] of doors) {
      const { fetch, calls } = replies(answer(status, { ok: false, error }))
      const result = await relay(fetch).ringmaster.kick(input())

      expect(result).toMatchObject({ outcome: 'failed', failure: 'denied', status, detail: error })
      // Asking the same question again after being told the answer.
      expect(calls).toHaveLength(1)
    }
  })

  /** The gate's two transient refusals, which are worth asking again. */
  it('retries the console`s own transient failures', async () => {
    for (const error of ['store', 'role-error']) {
      const { fetch, calls } = replies(answer(503, { ok: false, error }), answer(200, DISPATCHED))
      const result = await relay(fetch).ringmaster.kick(input())

      expect(result).toMatchObject({ outcome: 'dispatched', attempts: 2 })
      expect(calls).toHaveLength(2)
    }
  })

  it('treats a body that is not JSON as unreadable rather than as a refusal', async () => {
    const { fetch } = replies(answer(404, '<html>404 not found</html>'))
    const result = await relay(fetch).ringmaster.kick(input())

    expect(result).toMatchObject({ outcome: 'failed', failure: 'unknown', status: 404 })
    expect(result).toMatchObject({ detail: expect.stringContaining('not JSON') as unknown as string })
  })

  /** A 200 whose body does not say `dispatched` is not a success. */
  it('refuses to read a 200 with no dispatch in it as a dispatch', async () => {
    const { fetch } = replies(answer(200, { ok: true }))
    const result = await relay(fetch).ringmaster.kick(input())

    expect(result).toMatchObject({ outcome: 'failed', failure: 'unknown' })
  })

  it('classifies a body we cannot place by its status', () => {
    expect(classify(500, 'boom')).toMatchObject({ retry: true })
    expect(classify(418, 'boom')).toMatchObject({ retry: false })
  })
})

describe('the transport, when nothing on the far side answers', () => {
  it('reports a rejected request as unreachable', async () => {
    const fetch: Fetcher = () => Promise.reject(new Error('ECONNREFUSED'))
    const result = await relay(fetch, { attempts: 1 }).ringmaster.kick(input())

    expect(result).toMatchObject({ outcome: 'dropped', why: 'exhausted' })
    expect(result).toMatchObject({ detail: expect.stringContaining('ECONNREFUSED') as unknown as string })
  })

  /**
   * THE DEADLINE IS A RACE AND NOT ONLY A SIGNAL, which is src/ddb.ts's
   * reasoning: an abort cancels what listens for it, and this fake deliberately
   * does not listen. Without the race the call would hang for ever.
   */
  it('gives up on a request that never answers, signal or no signal', async () => {
    const fetch: Fetcher = () => new Promise<HttpResponse>(() => {})
    const result = await relay(fetch, { attempts: 1, timeoutMs: 5 }).ringmaster.kick(input())

    expect(result).toMatchObject({ outcome: 'dropped', why: 'exhausted' })
    expect(result).toMatchObject({ detail: expect.stringContaining('no answer') as unknown as string })
  })

  it('aborts the request it gave up on rather than leaving the socket pinned', async () => {
    let signal: AbortSignal | undefined
    const fetch: Fetcher = (_url, init) => {
      signal = init.signal
      return new Promise<HttpResponse>(() => {})
    }

    await relay(fetch, { attempts: 1, timeoutMs: 5 }).ringmaster.kick(input())
    expect(signal?.aborted).toBe(true)
  })

  it('treats an answer whose body cannot be read as unreachable', async () => {
    const fetch: Fetcher = () =>
      Promise.resolve({ status: 200, text: () => Promise.reject(new Error('socket hang up')) })
    const result = await relay(fetch, { attempts: 1 }).ringmaster.kick(input())

    expect(result).toMatchObject({ outcome: 'dropped', why: 'exhausted' })
  })
})

describe('backing off, and stopping', () => {
  it('waits a minute between tries and then reports the success', async () => {
    const { fetch, calls } = replies(
      answer(502, { ok: false, outcome: 'failed', failure: 'unreachable', detail: 'down' }),
      answer(200, DISPATCHED),
    )
    const { ringmaster, waited } = relay(fetch)
    const result = await ringmaster.kick(input())

    expect(calls).toHaveLength(2)
    expect(waited).toEqual([KICK_RETRY_MS])
    expect(result).toMatchObject({ outcome: 'dispatched', attempts: 2 })
  })

  /**
   * IT STOPS. A console that is down for a week must not leave one timer per ban
   * running until the bot is restarted.
   */
  it('gives up after a bounded number of attempts', async () => {
    const { fetch, calls } = replies(
      answer(502, { ok: false, outcome: 'failed', failure: 'unreachable', detail: 'down' }),
    )
    // The clock is held still, so only the attempt count can end this.
    const { ringmaster, waited } = relay(fetch, { ttlMs: Number.MAX_SAFE_INTEGER })
    const result = await ringmaster.kick(input())

    expect(calls).toHaveLength(KICK_ATTEMPTS)
    expect(waited).toHaveLength(KICK_ATTEMPTS - 1)
    expect(result).toMatchObject({ outcome: 'dropped', why: 'exhausted', attempts: KICK_ATTEMPTS })
  })

  it('does not wait at all after a failure that will never change', async () => {
    const { fetch, calls } = replies(answer(401, { ok: false, error: 'auth' }))
    const { ringmaster, waited } = relay(fetch)
    await ringmaster.kick(input())

    expect(calls).toHaveLength(1)
    expect(waited).toEqual([])
  })
})

describe('a stale kick is dropped rather than delivered', () => {
  /**
   * THE OWNER'S OWN EXAMPLE: a kick queued at 21:00 and delivered at 21:40 hits
   * a different session than the one it was aimed at. The age is measured from
   * when the moderator acted, which is what makes the boot replay safe.
   */
  it('sends nothing at all for an entry that is already too old', async () => {
    const { fetch, calls } = replies(answer(200, DISPATCHED))
    const { ringmaster } = relay(fetch)
    const result = await ringmaster.kick(input({ at: 1_000_000 - KICK_TTL_MS - 1 }))

    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ outcome: 'dropped', why: 'stale', attempts: 0 })
  })

  /**
   * AND IT DOES NOT SLEEP A MINUTE TO WAKE UP AND FIND OUT. The check at the top
   * of the loop would catch it a minute later, having held a timer for nothing
   * and delayed a report of an outcome that was already decided.
   */
  it('refuses to wait out a backoff that would land past the limit', async () => {
    const { fetch, calls } = replies(
      answer(502, { ok: false, outcome: 'failed', failure: 'unreachable', detail: 'down' }),
    )
    // One attempt's worth of window left, and the backoff is longer than it.
    const { ringmaster, waited } = relay(fetch, { ttlMs: KICK_RETRY_MS / 2 })
    const result = await ringmaster.kick(input())

    expect(calls).toHaveLength(1)
    expect(waited).toEqual([])
    expect(result).toMatchObject({ outcome: 'dropped', why: 'stale', attempts: 1 })
  })

  /** A kick that goes stale WHILE it is retrying, which is the case the mirror`s
   * own pre-check cannot see. */
  it('stops mid-retry once the clock has moved past the window', async () => {
    let clock = 1_000_000
    const { fetch, calls } = replies(
      answer(502, { ok: false, outcome: 'failed', failure: 'unreachable', detail: 'down' }),
    )

    const ringmaster = createRingmaster({
      baseUrl: BASE,
      secret: SECRET,
      fetch,
      now: () => clock,
      wait: (ms) => {
        clock += ms
        return Promise.resolve()
      },
      // THE ATTEMPT COUNT IS LIFTED OUT OF THE WAY ON PURPOSE. With both limits
      // in play the count is what ends a five-minute window of one-minute
      // backoffs, and this case is about the OTHER limit — so the count is
      // raised until the clock is the only thing that can stop it.
      attempts: 20,
    })

    const result = await ringmaster.kick(input({ at: clock }))

    // Four waits of a minute put the fifth attempt at four minutes; a fifth wait
    // would land exactly on the five-minute limit, so it is not taken.
    expect(calls).toHaveLength(KICK_TTL_MS / KICK_RETRY_MS)
    expect(result).toMatchObject({ outcome: 'dropped', why: 'stale' })
  })
})

describe('the settings, which are arithmetic rather than taste', () => {
  /**
   * THE PER-REQUEST DEADLINE HAS TO OUTLAST THE CONSOLE'S OWN WORK. Its Discord
   * role re-check waits up to five seconds and the SSH dispatch has a six-second
   * wall, so a ceiling under eleven would abandon kicks that were about to
   * succeed — and then retry them, which is how one kick becomes three.
   */
  it('leaves room for the console`s five-second role check and six-second ssh wall', () => {
    expect(KICK_TIMEOUT_MS).toBeGreaterThan(5_000 + 6_000)
  })

  it('backs off a minute and gives up inside a handful of them', () => {
    expect(KICK_RETRY_MS).toBe(60_000)
    expect(KICK_TTL_MS).toBe(5 * 60_000)
    expect(KICK_ATTEMPTS).toBeGreaterThan(1)
    // The window is the outer bound and the count is the inner one, so a clock
    // that jumps backwards cannot turn "until it is stale" into "forever".
    expect(KICK_ATTEMPTS * KICK_RETRY_MS).toBeGreaterThanOrEqual(KICK_TTL_MS)
  })
})

/**
 * `/drain` — THE MAINTENANCE RELAY, DRIVEN ENTIRELY OFFLINE.
 *
 * SAME DISCIPLINE AS THE KICK ABOVE AND THE SAME REASON FOR IT: every case here
 * is written against an answer shape transcribed from
 * fivem-ringmaster/src/app/api/maintenance/route.ts, its cancel route,
 * lib/service.ts and `errorResponse` in lib/actions.ts — never invented. A test
 * that asserts against a body the console does not send passes while the
 * integration is broken, and this integration RESTARTS A GAME SERVER.
 *
 * THE SENTENCES BELOW ARE THE CONSOLE'S, COPIED. `nothingToDeploy`'s reason and
 * `maint.schedule`'s "Cancel it first" are quoted verbatim so that the
 * assertion "we show the console's words" is checked against the actual words.
 */

/** What the maintenance route really answers on success: 201 and the window. */
const WINDOW = {
  state: 'scheduled',
  note: 'a server update',
  drainStartsAt: 1_700_000_000_000,
  deployMode: 'when-empty',
  deployAt: null,
}

const SCHEDULED = { ok: true, window: { ...WINDOW, id: 'current', createdByName: 'Nate' } }

/** `nothingToDeploy().reason`, from the console's lib/maintenance.ts. */
const NOTHING_TO_DEPLOY =
  'The server is already running the latest code — there is nothing to deploy.'

/** `maint.schedule`'s throw, which the route turns into a 409. */
const ALREADY = 'A maintenance window is already scheduled. Cancel it first.'

function drainer(fetch: Fetcher, over: Partial<DrainerOptions> = {}): Drainer {
  return createDrainer({ baseUrl: BASE, secret: SECRET, fetch, ...over })
}

function sent(calls: { init: Parameters<Fetcher>[1] }[]): Record<string, unknown> {
  return JSON.parse(calls[0]?.init.body ?? '{}') as Record<string, unknown>
}

describe('/drain — the request the console actually receives', () => {
  it('posts to /api/maintenance under the base url', async () => {
    const { fetch, calls } = replies(answer(201, SCHEDULED))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE}${MAINTENANCE_PATH}`)
    expect(calls[0]?.init.method).toBe('POST')
  })

  /**
   * THE PATHS ARE PINNED AS LITERALS, exactly as the kick's is, and for a
   * sharper reason: `SERVICE_ROUTES` is an EXACT-match allowlist and
   * `/api/maintenance/force` — the button that skips the drain and restarts the
   * box now — lives under the same prefix and is deliberately not on it.
   */
  it('spells the two maintenance paths the way the console spells them', () => {
    expect(MAINTENANCE_PATH).toBe('/api/maintenance')
    expect(MAINTENANCE_CANCEL_PATH).toBe('/api/maintenance/cancel')
    expect(MAINTENANCE_PATH).not.toContain('force')
  })

  it('presents the secret and the acting admin in the headers the console reads', async () => {
    const { fetch, calls } = replies(answer(201, SCHEDULED))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(calls[0]?.init.headers[COMMAND_SECRET_HEADER]).toBe(SECRET)
    expect(calls[0]?.init.headers[SERVICE_ACTOR_HEADER]).toBe(ADMIN)
    expect(calls[0]?.init.headers['content-type']).toBe('application/json')
  })

  it('never puts the secret in the url or the body', async () => {
    const { fetch, calls } = replies(answer(201, SCHEDULED))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN, note: 'shipping the loot fix' })

    expect(calls[0]?.url).not.toContain(SECRET)
    expect(calls[0]?.init.body).not.toContain(SECRET)
  })

  /**
   * THE DOOR CLOSES NOW AND THE RESTART WAITS FOR THE LAST MATCH. Both are what
   * `/drain` means, and both are asserted because the route requires them and
   * the alternative — `at-time` — ends matches that are still running.
   */
  it('closes the door immediately and lets the last match finish', async () => {
    const { fetch, calls } = replies(answer(201, SCHEDULED))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(sent(calls)).toEqual({ drainInMinutes: 0, deployMode: 'when-empty' })
    expect(DRAIN_IN_MINUTES).toBe(0)
    expect(DRAIN_DEPLOY_MODE).toBe('when-empty')
  })

  /**
   * NO `targetRef` OR `targetSha`, EVER. The route pairs them — both or
   * neither — and the sha is a promise the game box enforces twice. A Discord
   * command has no page reading to pin one from, so a branch switch is not a
   * thing this relay can ask for.
   */
  it('never asks for a branch switch', async () => {
    const { fetch, calls } = replies(answer(201, SCHEDULED))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN, note: 'x' })

    const body = sent(calls)
    expect(body).not.toHaveProperty('targetRef')
    expect(body).not.toHaveProperty('targetSha')
  })

  /**
   * THE NOTE IS THE ADMIN'S WORDS. Players turned away at the door are shown
   * it, so it goes out exactly as typed — not trimmed into a house style, not
   * capitalised, not summarised.
   */
  it('sends the note verbatim when there is one', async () => {
    const note = 'back in ~10 min — shipping the loot fix. sorry!'
    const { fetch, calls } = replies(answer(201, SCHEDULED))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN, note })

    expect(sent(calls)).toEqual({ drainInMinutes: 0, deployMode: 'when-empty', note })
  })

  /**
   * OMITTED RATHER THAN NULL OR INVENTED, which is the same rule the kick's
   * `reason` follows and matters more here. `scheduleSchema` says the console
   * GENERATES this when it is absent, because a maintenance window is always
   * the same thing; a default written on this side would be a second wording
   * for the same silence, shown to players, written by nobody who was asked.
   */
  it('omits the note entirely when there is none, so the console writes its own', async () => {
    const { fetch, calls } = replies(answer(201, SCHEDULED))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN, note: null })

    expect(sent(calls)).not.toHaveProperty('note')
  })

  it('drops a whitespace-only note rather than putting blanks on the door', async () => {
    const { fetch, calls } = replies(answer(201, SCHEDULED))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN, note: '   ' })

    expect(sent(calls)).not.toHaveProperty('note')
  })

  /**
   * The console's `scheduleSchema` accepts 200. Truncating keeps the drain; a
   * zod message back would lose it over the length of a sentence. Discord also
   * refuses the input at this length in the client, so this is the belt behind
   * that.
   */
  it('truncates a note too long for the console rather than losing the drain', async () => {
    const { fetch, calls } = replies(answer(201, SCHEDULED))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN, note: 'x'.repeat(400) })

    expect(sent(calls).note).toHaveLength(DRAIN_NOTE_CAP)
    expect(DRAIN_NOTE_CAP).toBe(200)
  })
})

describe('/drain — what the console said, shown as it was said', () => {
  it('reports a scheduled window and reads the row it was handed', async () => {
    const { fetch } = replies(answer(201, SCHEDULED))
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toEqual({ outcome: 'scheduled', status: 201, window: WINDOW })
  })

  /**
   * THE 409 THAT IS THE OWNER'S "FAIL IF NO UPDATES ARE AVAILABLE" RULE. It is
   * enforced in the route and nowhere else, which is the whole argument for
   * going through the API — and the reason it carries has to reach the admin
   * unedited, because this bot cannot see what the console looked at.
   */
  it('carries "there is nothing to deploy" through word for word', async () => {
    const { fetch } = replies(answer(409, { ok: false, error: NOTHING_TO_DEPLOY }))
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toEqual({
      outcome: 'refused',
      failure: 'refused',
      detail: NOTHING_TO_DEPLOY,
      status: 409,
    })
  })

  /**
   * AND THE OTHER 409, WHICH IS `maint.schedule` REFUSING TO STAMP OVER A LIVE
   * WINDOW. A raw PutItem would have overwritten it — one fixed key, one full
   * put — mid-drain, on a server already turning players away.
   */
  it('carries "a window is already scheduled" through word for word', async () => {
    const { fetch } = replies(answer(409, { ok: false, error: ALREADY }))
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toMatchObject({ outcome: 'refused', failure: 'refused', detail: ALREADY })
  })

  /** A zod message from `scheduleSchema`, which `errorResponse` sends as a 400. */
  it('treats a 400 with a sentence as a refusal with that sentence', async () => {
    const { fetch } = replies(answer(400, { ok: false, error: 'Choose a time for the deploy.' }))
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toMatchObject({ failure: 'refused', detail: 'Choose a time for the deploy.' })
  })

  /**
   * THE SERVICE GATE'S SHAPE, WHICH IS THE ONE EASIEST TO MISS: no `outcome`,
   * no sentence, a machine code. It is what a stale secret produces, which is
   * the single most likely thing to be wrong on the day this is wired up.
   */
  it('recognises every refusal from the console`s door as denied', async () => {
    const doors: [number, string][] = [
      [401, 'auth'],
      [403, 'scope'],
      [400, 'actor'],
      [403, 'role-revoked'],
    ]

    for (const [status, error] of doors) {
      const { fetch, calls } = replies(answer(status, { ok: false, error }))
      const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

      expect(result).toMatchObject({ failure: 'denied', detail: error, status })
      expect(calls).toHaveLength(1)
    }
  })

  /** An operator's job, and kept apart from a stale secret on purpose. */
  it('tells an unset COMMAND_SECRET on the console from a wrong one', async () => {
    const { fetch } = replies(answer(503, { ok: false, error: 'not-configured' }))
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toMatchObject({ failure: 'not-configured', status: 503 })
  })

  /** The gate's two transient refusals, and any other 5xx, are the console`s fault. */
  it('reports the console`s own outages as unavailable rather than as a refusal', async () => {
    for (const error of ['store', 'role-error']) {
      const { fetch } = replies(answer(503, { ok: false, error }))
      const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

      expect(result).toMatchObject({ failure: 'unavailable', detail: error })
    }

    // `errorResponse`'s catch-all, which carries a sentence at 500. It is the
    // console falling over, not a refusal of anything.
    const { fetch } = replies(
      answer(500, { ok: false, error: 'Something went wrong. It has been logged.' }),
    )

    expect(await drainer(fetch).schedule({ actorDiscordId: ADMIN })).toMatchObject({
      failure: 'unavailable',
      status: 500,
    })
  })

  it('treats a body that is not JSON as unreadable rather than as a refusal', async () => {
    const { fetch } = replies(answer(502, '<html>502 Bad Gateway</html>'))
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toMatchObject({ failure: 'unknown', status: 502 })
    expect(result).toMatchObject({ detail: expect.stringContaining('not JSON') as unknown as string })
  })

  /** `typeof null === 'object'`, which is how a body of `null` becomes a crash. */
  it('does not come apart on a body that parses to null', async () => {
    const { fetch } = replies(answer(200, 'null'))
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toMatchObject({ outcome: 'refused', failure: 'unknown' })
  })

  it('refuses to read an answer that never said ok as a scheduled window', async () => {
    const { fetch } = replies(answer(200, { window: WINDOW }))
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toMatchObject({ outcome: 'refused', failure: 'unknown' })
  })

  /**
   * A SUCCESS WITH NO READABLE WINDOW IS STILL A SUCCESS. `ok: true` means the
   * row is written and the driver will act on it — the server IS going down —
   * so reporting "we could not read the answer" over a missing field would tell
   * an admin nothing happened while the box drains underneath them.
   */
  it('reports a schedule whose window it could not read, with the fields null', async () => {
    const { fetch } = replies(answer(201, { ok: true }))
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toEqual({
      outcome: 'scheduled',
      status: 201,
      window: {
        state: null,
        note: null,
        drainStartsAt: null,
        deployMode: null,
        deployAt: null,
      },
    })
  })

  /**
   * `1e999` PARSES TO `Infinity`, AND A TIMESTAMP OF `Infinity` RENDERS AS A
   * DATE NOBODY CAN READ. Absence is the honest reading of it, and the reply
   * says so in words rather than promising an instant.
   */
  it('reads a non-finite timestamp as absent rather than passing it on', async () => {
    const { fetch } = replies(answer(201, '{"ok":true,"window":{"drainStartsAt":1e999}}'))
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toMatchObject({ outcome: 'scheduled', window: { drainStartsAt: null } })
  })
})

/**
 * ONE ATTEMPT, AND THE OPPOSITE OF THE KICK'S RULE.
 *
 * The route's work is not idempotent — an audit row and a window — so a request
 * that timed out MAY HAVE LANDED, and sending it again asks the console to
 * restart the game server a second time on the strength of a guess. A human is
 * watching a deferred reply and can simply run it again.
 */
describe('/drain — it asks exactly once, whatever comes back', () => {
  it('does not retry an outage the kick would have retried', async () => {
    const { fetch, calls } = replies(answer(503, { ok: false, error: 'store' }))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(calls).toHaveLength(1)
  })

  it('does not retry a request nothing answered', async () => {
    const calls: string[] = []
    const fetch: Fetcher = (url) => {
      calls.push(url)
      return Promise.reject(new Error('ECONNREFUSED'))
    }

    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({ outcome: 'refused', failure: 'unreachable', status: null })
    expect(result).toMatchObject({
      detail: expect.stringContaining('ECONNREFUSED') as unknown as string,
    })
  })

  /**
   * THE DEADLINE IS A RACE AND NOT ONLY A SIGNAL — src/ddb.ts's reasoning, and
   * `post`'s. This fake deliberately does not listen to the abort, so without
   * the race the call would hang for ever.
   */
  it('gives up on a request that never answers, signal or no signal', async () => {
    let signal: AbortSignal | undefined
    const fetch: Fetcher = (_url, init) => {
      signal = init.signal
      return new Promise<HttpResponse>(() => {})
    }

    const result = await drainer(fetch, { timeoutMs: 5 }).schedule({ actorDiscordId: ADMIN })

    expect(result).toMatchObject({ failure: 'unreachable' })
    expect(result).toMatchObject({ detail: expect.stringContaining('no answer') as unknown as string })
    // And the socket is released rather than pinned for the life of the process.
    expect(signal?.aborted).toBe(true)
  })

  it('treats an answer whose body cannot be read as unreachable', async () => {
    const fetch: Fetcher = () =>
      Promise.resolve({ status: 201, text: () => Promise.reject(new Error('socket hang up')) })
    const result = await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(result).toMatchObject({ outcome: 'refused', failure: 'unreachable', status: 201 })
  })

  /**
   * THE DEADLINE OUTLASTS THE CONSOLE'S OWN WORK, which for this route is more
   * than the kick's: a five-second Discord role re-check, then one SSH round
   * trip to the game box under a six-second wall, then a grants read, the audit
   * write and the window's PutItem.
   */
  it('leaves room for the role check, the ssh refresh and three dynamo calls', () => {
    expect(DRAIN_TIMEOUT_MS).toBeGreaterThan(5_000 + 6_000)
    expect(DRAIN_TIMEOUT_MS).toBeGreaterThan(KICK_TIMEOUT_MS)
  })
})

describe('/drain cancel — which the console does not open to this bot yet', () => {
  it('posts to the cancel route, not to the scheduling one', async () => {
    const { fetch, calls } = replies(answer(200, { ok: true }))
    await drainer(fetch).cancel({ actorDiscordId: ADMIN })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE}${MAINTENANCE_CANCEL_PATH}`)
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers[SERVICE_ACTOR_HEADER]).toBe(ADMIN)
  })

  it('reports a cancel the console accepted', async () => {
    const { fetch } = replies(answer(200, { ok: true }))

    expect(await drainer(fetch).cancel({ actorDiscordId: ADMIN })).toEqual({
      outcome: 'cancelled',
      status: 200,
    })
  })

  /**
   * ═══ TODAY'S REAL ANSWER, PINNED SO IT CANNOT BE MISTAKEN FOR A BUG ═══
   *
   * `SERVICE_ROUTES` in the console is `/api/bans`, `/api/kick` and
   * `/api/maintenance` — an exact-match allowlist that does not include the
   * cancel path — and that route authorises with `authorize('process', 'write')`,
   * which is session-bound. So the gate answers 403 `scope` and nothing is
   * cancelled. This asserts the bot classifies that honestly rather than
   * pretending, and it is the case to delete when the console opens the route.
   */
  it('reports the console`s scope refusal as denied rather than pretending', async () => {
    const { fetch } = replies(answer(403, { ok: false, error: 'scope' }))
    const result = await drainer(fetch).cancel({ actorDiscordId: ADMIN })

    expect(result).toEqual({
      outcome: 'refused',
      failure: 'denied',
      detail: 'scope',
      status: 403,
    })
  })

  /** The route's own two refusals, both of which are sentences for a person. */
  it('carries the cancel route`s own refusals through unedited', async () => {
    const none = 'There is no maintenance window to cancel.'
    const deploying = 'The deploy has already started. It cannot be cancelled now.'

    expect(
      await drainer(replies(answer(404, { ok: false, error: none })).fetch).cancel({
        actorDiscordId: ADMIN,
      }),
    ).toMatchObject({ failure: 'refused', detail: none, status: 404 })

    expect(
      await drainer(replies(answer(409, { ok: false, error: deploying })).fetch).cancel({
        actorDiscordId: ADMIN,
      }),
    ).toMatchObject({ failure: 'refused', detail: deploying, status: 409 })
  })
})

/**
 * THE JOURNAL, WHICH IS THE ONLY PLACE A RESTART IS EXPLAINED AFTERWARDS.
 *
 * A scheduled window is `info`: it is the line that answers "why did the server
 * go down and everybody's match end", so it has to be written -- but it is the
 * SUCCESS branch of a command an admin just typed, and `log()` posts every
 * non-info line to #bot-status. The door's refusals stay `error`, because they
 * mean `/drain` is broken for every admin until an operator acts.
 *
 * SO THE LEVEL IS LOAD-BEARING AND IS ASSERTED AS SUCH. Owner, 2026-09-04, with
 * a screenshot of the line in Discord: "please get the bot to stop posting this
 * line when a drain starts". `log` sends info to stdout and everything else to
 * stderr, which is what these assert against -- stderr is the channel.
 */
describe('/drain — what reaches the journal', () => {
  it('records a scheduled window without interrupting anybody about it', async () => {
    const { fetch } = replies(answer(201, SCHEDULED))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    // NOTHING ON STDERR IS THE ASSERTION. `log()` hands every non-info line to
    // the status sink, so a warn here is a post in #bot-status -- which is what
    // the owner asked to stop. A drain he typed himself is not a fault.
    expect(stderr.join('')).toBe('')

    const line = stdout.join('')
    expect(line).toContain('level=info')
    expect(line).toContain('restart')
    expect(line).toContain(ADMIN)
    // ...but it is still WRITTEN, because it is the first thing anyone asks
    // after an unexpected restart: who scheduled it, and when it starts.
    expect(line).toContain('drainStartsAt')
    // And never the credential, on any path.
    expect(line).not.toContain(SECRET)
  })

  it('says nothing loud about a refusal the console reasoned about', async () => {
    const { fetch } = replies(answer(409, { ok: false, error: NOTHING_TO_DEPLOY }))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(stderr.join('')).toBe('')
    expect(stdout.join('')).toContain('level=info')
  })

  it('treats the door`s refusals as an operator`s problem', async () => {
    const { fetch } = replies(answer(401, { ok: false, error: 'auth' }))
    await drainer(fetch).schedule({ actorDiscordId: ADMIN })

    expect(stderr.join('')).toContain('level=error')
  })
})
