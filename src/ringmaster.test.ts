import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setSink } from './log.ts'
import {
  classify,
  COMMAND_SECRET_HEADER,
  createRingmaster,
  KICK_ATTEMPTS,
  KICK_PATH,
  KICK_RETRY_MS,
  KICK_TIMEOUT_MS,
  KICK_TTL_MS,
  LICENSE,
  SERVICE_ACTOR_HEADER,
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
