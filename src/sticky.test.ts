import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setSink } from './log.ts'
import {
  installStickies,
  REPOST_COOLDOWN_MS,
  setStickies,
  stickies,
  stickyChannels,
  stickyEngine,
  stickyRefusal,
  stickyStatePath,
  stickyStore,
  STICKY_TEXT_CAP,
  type Stickies,
  type StickyChannels,
  type StickyStore,
} from './sticky.ts'

/**
 * The sticky, offline.
 *
 * THE THROTTLE IS THE FEATURE AND IT IS WHAT THIS FILE IS ABOUT. A sticky that
 * reposts is easy; a sticky that reposts twice per user message would pass any
 * test that only asked "is it last again" and would empty the channel's send
 * bucket the first time an outage got people talking. So the assertions below
 * are mostly counts: how many API calls did a burst of twenty cost, how many
 * reposts did it produce, and — the one that is easy to leave out — does a
 * burst that STOPS still bring the sticky back.
 *
 * AND THE OTHER DIRECTION, WHICH IS THE ONE THAT REACHED THE LIVE SERVER. Every
 * count above is also satisfied by a sticky that comes back too rarely, and by
 * one that never comes back at all — a throttle is only interesting next to the
 * thing it is throttling. So the cases come in pairs: one message brings the
 * sticky back, and silence does not; a burst costs one repost, and a message
 * inside a running window is not lost by it. The bug the owner found was a
 * sticky set, one message posted, and nothing after it, which is the smallest
 * pair there is and is the first test here.
 *
 * NOTHING HERE TOUCHES DISCORD OR A REAL CLOCK. The engine is handed two
 * functions for the channel and two for the file, so a delete that is refused,
 * a channel that has been deleted and a message that arrives in the middle of a
 * repost are three lines in a test rather than three states nobody can arrange
 * in a live guild. Time is vitest's fake timers, because a test that waits
 * fifteen real seconds gets deleted by whoever is waiting for CI.
 */

const CHANNEL = '101010101010101010'
const OTHER = '202020202020202020'
const SELF = '303030303030303030'

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
  vi.useRealTimers()
  vi.restoreAllMocks()

  // Both of these are module state, and a case that leaves one set is a case
  // that silently changes the next file to run.
  setSink(null)
  setStickies(null)
})

/** One thing the fake channel was asked to do, in the order it was asked. */
interface Call {
  readonly kind: 'post' | 'remove'
  readonly channelId: string

  /** The text for a post, the message id for a remove. */
  readonly what: string
}

interface FakeChannels extends StickyChannels {
  readonly calls: Call[]

  /** Just the posts, which is what "did the sticky come back" is counted from. */
  readonly posts: () => Call[]

  /**
   * Sends ATTEMPTED, including the ones made to fail.
   *
   * `calls` only holds what succeeded, so it cannot tell a retry loop that is
   * pacing itself from one that never ran at all — and those are the two
   * outcomes a "reported once" assertion has to be able to separate.
   */
  readonly attempts: () => number
}

interface ChannelFaults {
  /** Thrown instead of posting, when set. */
  post?: unknown

  /** Thrown instead of deleting, when set. */
  remove?: unknown

  /** Run at the top of `post`, before the id is handed back. */
  duringPost?: () => void
}

/**
 * A channel that remembers what it was told and can be made to fail.
 *
 * IDS ARE `m1`, `m2`, ... IN ORDER, so an assertion can name the copy it means
 * — "the second post was deleted before the third" is the whole of what a
 * repost is, and it is not visible from a call count.
 */
function fakeChannels(faults: ChannelFaults = {}): FakeChannels {
  const calls: Call[] = []
  let posted = 0
  let attempted = 0

  return {
    calls,
    posts: () => calls.filter((call) => call.kind === 'post'),
    attempts: () => attempted,

    post: (channelId, text) => {
      attempted += 1
      faults.duringPost?.()
      if (faults.post !== undefined) return Promise.reject(faults.post)

      posted += 1
      calls.push({ kind: 'post', channelId, what: text })

      return Promise.resolve(`m${posted}`)
    },

    remove: (channelId, messageId) => {
      if (faults.remove !== undefined) return Promise.reject(faults.remove)

      calls.push({ kind: 'remove', channelId, what: messageId })
      return Promise.resolve()
    },
  }
}

interface FakeStore extends StickyStore {
  /** What was last written, or null when nothing has been. */
  written: () => string | null
}

interface StoreFaults {
  /** Thrown instead of writing, when set. */
  save?: unknown

  /**
   * Run at the top of `save`.
   *
   * THE FILE WRITE IS THE GAP THE REPOST HAS TO SURVIVE. It sits between the
   * send that put the new copy up and the bookkeeping that says what that copy
   * buried, so a message that arrives across it is BELOW the new sticky and is
   * real drift. This hook is how a test puts one there.
   */
  duringSave?: () => void
}

function fakeStore(initial: string | null = null, faults: StoreFaults = {}): FakeStore {
  let held = initial

  return {
    written: () => held,

    load: () => {
      if (held === null) {
        const missing: NodeJS.ErrnoException = new Error('ENOENT: no such file')
        missing.code = 'ENOENT'
        return Promise.reject(missing)
      }

      return Promise.resolve(held)
    },

    save: (raw) => {
      faults.duringSave?.()
      if (faults.save !== undefined) return Promise.reject(faults.save)

      held = raw
      return Promise.resolve()
    },
  }
}

function apiError(code: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: `code ${code}` },
    code,
    code === RESTJSONErrorCodes.UnknownChannel ? 404 : 403,
    'POST',
    'https://discord.com/api/v10/channels/0/messages',
    {},
  )
}

/** `n` ordinary messages from ordinary people, in one channel. */
function chatter(engine: { saw: (channelId: string, fromSelf: boolean) => void }, n: number): void {
  for (let i = 0; i < n; i += 1) engine.saw(CHANNEL, false)
}

/**
 * Let every timer that is due run, and let the promises they started settle.
 *
 * `advanceTimersByTimeAsync` RATHER THAN THE SYNCHRONOUS ONE, because a repost
 * is two awaited round trips: the synchronous version fires the timer and
 * returns before the delete has resolved, so an assertion after it would be
 * looking at a repost that is half done.
 */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('what Discord will take as a sticky', () => {
  it('refuses text with nothing in it, because Discord refuses it too', () => {
    expect(stickyRefusal('')).toBe('empty')

    // The case that would otherwise be accepted, written to the state file, and
    // then rejected by Discord on every send for the life of the process.
    expect(stickyRefusal('   \n\t ')).toBe('empty')
  })

  it('refuses text past the message cap, and takes text exactly at it', () => {
    expect(stickyRefusal('x'.repeat(STICKY_TEXT_CAP))).toBeNull()
    expect(stickyRefusal('x'.repeat(STICKY_TEXT_CAP + 1))).toBe('too-long')
  })

  /**
   * COUNTED IN UTF-16 CODE UNITS, WHICH IS WHAT DISCORD COUNTS. An emoji is two
   * of them, so a sticky of a thousand and one emoji is over the limit even
   * though it is a thousand and one characters to a person.
   */
  it('counts the way Discord counts, not the way a person would', () => {
    expect(stickyRefusal('🎉'.repeat(STICKY_TEXT_CAP / 2))).toBeNull()
    expect(stickyRefusal('🎉'.repeat(STICKY_TEXT_CAP / 2 + 1))).toBe('too-long')
  })
})

describe('the sticky throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('posts once when it is set, and says it replaced nothing', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await expect(engine.set(CHANNEL, 'the server is down')).resolves.toBe(false)

    expect(channels.calls).toEqual([
      { kind: 'post', channelId: CHANNEL, what: 'the server is down' },
    ])
  })

  /**
   * THE BUG THE OWNER FOUND ON THE LIVE SERVER, AS THE SMALLEST TEST THAT SHOWS
   * IT. He set a sticky, one person said one thing, and the sticky never came
   * back — because the repost used to be gated on a message COUNT as well as
   * the cooldown, and one is not five. One message is drift, and undoing drift
   * is the whole of what this feature is.
   */
  it('brings the sticky back for a single message, with nothing else said', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'the server is down')

    // One person, one message, inside the cooldown — which is what `/sticky`
    // and then somebody replying to it actually looks like.
    chatter(engine, 1)

    // And then nothing more is said. The trailing repost has to carry it.
    await tick(REPOST_COOLDOWN_MS)

    expect(channels.calls).toEqual([
      { kind: 'post', channelId: CHANNEL, what: 'the server is down' },
      { kind: 'remove', channelId: CHANNEL, what: 'm1' },
      { kind: 'post', channelId: CHANNEL, what: 'the server is down' },
    ])
  })

  /**
   * THE CHANNEL THE FEATURE IS FOR, AT THE TRAFFIC IT ACTUALLY SEES. An admin
   * channel during an outage is four messages an hour, not four a minute, and
   * that is precisely where "we know the server is down" has to stay last. A
   * rule that waited for a fifth message would leave the notice under all four
   * for the whole hour; each of them earns a repost, because each of them
   * pushed the notice down.
   */
  it('keeps up with a channel that says one thing an hour', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')

    for (let hour = 0; hour < 4; hour += 1) {
      chatter(engine, 1)
      await tick(60 * 60 * 1000)
    }

    // The one from the set, and one for each of the four messages.
    expect(channels.posts()).toHaveLength(5)
  })

  /**
   * AND A CHANNEL WHERE NOBODY SAYS ANYTHING COSTS NOTHING. The counterpart to
   * the test above and the reason the counter is still there at all: a sticky
   * that is still the last message has not drifted, so nothing is scheduled and
   * nothing is retried until somebody speaks. Without this the bot reposts into
   * an empty channel every fifteen seconds for as long as it runs.
   */
  it('does nothing at all while the channel is silent', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')

    // An hour, so that this is "never" rather than "not yet".
    await tick(60 * 60 * 1000)

    expect(channels.posts()).toHaveLength(1)
  })

  it('takes the old copy down before it puts the new one up', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    chatter(engine, 1)
    await tick(0)

    // The old copy comes down before the new one goes up, so the channel never
    // holds two.
    expect(channels.calls).toEqual([
      { kind: 'post', channelId: CHANNEL, what: 'down' },
      { kind: 'remove', channelId: CHANNEL, what: 'm1' },
      { kind: 'post', channelId: CHANNEL, what: 'down' },
    ])
  })

  /**
   * THE WHOLE COST OF THE FEATURE, AS A NUMBER, AND THE ONE THING THE COOLDOWN
   * HAS TO GET RIGHT NOW THAT IT IS THE ONLY GUARD. One message earns a repost,
   * so twenty messages must not earn twenty: that would be twenty deletes and
   * twenty sends into a bucket that holds five sends per five seconds, and the
   * queue behind it is the moderation log. Twenty inside one window is one
   * repost, and so is a thousand.
   */
  it('costs one repost for a burst of twenty, not twenty', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')

    chatter(engine, 20)
    await tick(REPOST_COOLDOWN_MS)

    // One delete and one send on top of the original post, whatever the twenty
    // would have cost on their own.
    expect(channels.posts()).toHaveLength(2)
    expect(channels.calls).toHaveLength(3)
  })

  /**
   * A MESSAGE THAT LANDS DURING THE COOLDOWN IS DELAYED, NEVER DROPPED, and the
   * distinction is what the trailing timer is for. The cooldown is now the only
   * thing standing between a message and a repost, so it is also the only thing
   * that could swallow one: a message whose repost was skipped because a window
   * happened to be running would leave the sticky buried until somebody spoke
   * again after the window closed, which is the owner's bug with an extra step
   * in front of it.
   */
  it('holds a message that lands during the cooldown rather than losing it', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    // The first message is free: the window from the set has closed.
    chatter(engine, 1)
    await tick(0)
    expect(channels.posts()).toHaveLength(2)

    // The second lands a second into the window that repost opened, and then
    // the channel goes quiet for good.
    await tick(1_000)
    chatter(engine, 1)
    await tick(0)
    expect(channels.posts()).toHaveLength(2)

    await tick(REPOST_COOLDOWN_MS)
    expect(channels.posts()).toHaveLength(3)
  })

  /**
   * THE GUARANTEE THE COOLDOWN CANNOT MAKE ON ITS OWN, and the one an
   * implementation that only reposts on a message would fail. Twenty
   * people say something and then stop — the ordinary shape of an outage. There
   * is no later message to carry the repost, so if the trailing timer is not
   * armed the sticky stays buried under all twenty until somebody speaks again,
   * which is exactly when it stopped being read.
   */
  it('brings the sticky back after a burst that ends, with nothing more said', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')

    // Inside the window, so the repost cannot go out when it is earned.
    await tick(2_000)
    chatter(engine, 20)

    expect(channels.posts()).toHaveLength(1)

    // Nobody says anything else. The rest of the window passes.
    await tick(REPOST_COOLDOWN_MS)

    expect(channels.posts()).toHaveLength(2)
  })

  it('holds a burst to one repost per window however long it runs', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')

    // A minute of somebody talking constantly: five messages a second.
    for (let second = 0; second < 60; second += 1) {
      chatter(engine, 5)
      await tick(1_000)
    }

    // One at the set, then one per window for the minute. Four sends a minute
    // against a bucket of five every five seconds.
    expect(channels.posts()).toHaveLength(1 + 60_000 / REPOST_COOLDOWN_MS)
  })

  /**
   * A CHANNEL WITH NO STICKY COSTS NOTHING, which matters because this runs for
   * every message in the guild. Nothing is remembered about `OTHER` and nothing
   * is scheduled for it.
   */
  it('ignores messages in channels that have no sticky', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    for (let i = 0; i < 50; i += 1) engine.saw(OTHER, false)
    await tick(60 * 60 * 1000)

    expect(channels.posts()).toHaveLength(1)
  })

  /**
   * THE BOT'S OWN POSTS ARE NOT DRIFT. Without this the sticky counts its own
   * repost toward the next one and the channel talks to itself for as long as
   * the process lives.
   */
  it('does not count its own messages toward the repost', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    for (let i = 0; i < 50; i += 1) engine.saw(CHANNEL, true)
    await tick(60 * 60 * 1000)

    expect(channels.posts()).toHaveLength(1)
  })

  /**
   * A MESSAGE THAT ARRIVED BEFORE THE NEW COPY IS BURIED BY IT, which is not a
   * detail — Discord orders a channel by time, so a message posted while the
   * send was in the air is ABOVE the sticky that send created and does not push
   * it anywhere. Counting it would repost on nothing.
   */
  it('buries the messages that arrived before the new copy went up', async () => {
    const faults: ChannelFaults = {}
    const channels = fakeChannels(faults)
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    // Five people talk while the repost's send is in the air.
    faults.duringPost = () => {
      chatter(engine, 5)
    }

    chatter(engine, 1)
    await tick(0)

    faults.duringPost = undefined
    expect(channels.posts()).toHaveLength(2)

    // Nothing is owed: those five are under the copy that just went up.
    await tick(60 * 60 * 1000)
    expect(channels.posts()).toHaveLength(2)
  })

  /**
   * AND A MESSAGE THAT ARRIVED AFTER IT IS NOT. This is the same instant from
   * the other side, and it is the one an implementation gets wrong: the state
   * file is written after the send, so anything landing across that write is
   * BELOW the new copy and is real drift. Clearing the counter at the end of
   * the repost instead of at the send loses exactly these, and the symptom is a
   * sticky that sinks a message deeper every window with nothing looking
   * broken.
   */
  it('keeps counting a message that arrives after the new copy went up', async () => {
    const channels = fakeChannels()
    const storeFaults: StoreFaults = {}
    const engine = stickyEngine(channels, fakeStore(null, storeFaults))

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    // Five people talk after the send landed, while the file is being written.
    storeFaults.duringSave = () => {
      storeFaults.duringSave = undefined
      chatter(engine, 5)
    }

    chatter(engine, 1)
    await tick(0)

    expect(channels.posts()).toHaveLength(2)

    // Those five are still owed, so the next window brings the sticky back with
    // nothing more said in the channel.
    await tick(REPOST_COOLDOWN_MS)
    expect(channels.posts()).toHaveLength(3)
  })

  it('never runs two reposts in one channel at once', async () => {
    const faults: ChannelFaults = {}
    const channels = fakeChannels(faults)
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    // Every message that arrives during the repost tries to arm another one.
    faults.duringPost = () => {
      chatter(engine, 100)
    }

    chatter(engine, 1)
    await tick(0)

    faults.duringPost = undefined

    // One repost, not a hundred and one. The hundred are on the counter for the
    // next window, which is the previous test.
    expect(channels.posts()).toHaveLength(2)
  })
})

describe('a sticky that goes wrong', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  /**
   * THE BOT CANNOT DELETE ITS OWN MESSAGE. Posting anyway would leave the old
   * copy standing under a new one, and then two under a third, and so on every
   * fifteen seconds for as long as the outage lasts — a channel filling with
   * stickies, unattended. So the repost stops: the notice stays exactly where
   * it is and simply no longer moves.
   */
  it('leaves the copy where it is rather than posting a second one', async () => {
    const channels = fakeChannels({ remove: apiError(RESTJSONErrorCodes.MissingPermissions) })
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    chatter(engine, 1)
    await tick(0)

    expect(channels.posts()).toHaveLength(1)
    expect(stderr.join('')).toContain('the sticky cannot be moved')
  })

  /**
   * AND IT SAYS SO ONCE. The same refusal happens every window for the life of
   * the process, and these lines reach the status channel as well as the
   * journal — one per attempt is a slow flood into the one channel that has to
   * stay readable.
   */
  it('reports a refused delete once rather than every window', async () => {
    const channels = fakeChannels({ remove: apiError(RESTJSONErrorCodes.MissingPermissions) })
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')

    for (let window = 0; window < 5; window += 1) {
      chatter(engine, 5)
      await tick(REPOST_COOLDOWN_MS)
    }

    const complaints = stderr.join('').match(/the sticky cannot be moved/gu) ?? []
    expect(complaints).toHaveLength(1)

    // And the retries are a window apart rather than one per message, which
    // matters more now that one message is enough to earn a repost: five
    // windows of five messages is five attempts, not twenty-five.
    const attempts = stderr.join('').match(/could not delete the sticky/gu) ?? []
    expect(attempts).toHaveLength(5)
  })

  /**
   * A DELETE THAT COMES BACK `UnknownMessage` IS A SUCCESS. Somebody tidied the
   * sticky away by hand, which is the state the delete was trying to reach.
   * Reading it as a failure would stop the sticky dead the first time an admin
   * did that.
   */
  it('carries on when the copy it meant to delete is already gone', async () => {
    const channels = fakeChannels({ remove: apiError(RESTJSONErrorCodes.UnknownMessage) })
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    chatter(engine, 1)
    await tick(0)

    expect(channels.posts()).toHaveLength(2)
  })

  /**
   * THE CHANNEL WAS DELETED. Nothing about this sticky can ever work again, so
   * it is forgotten rather than retried every fifteen seconds until somebody
   * restarts the bot — and forgotten from the FILE too, or the next start reads
   * it back and starts retrying all over again.
   */
  it('forgets a sticky whose channel has been deleted', async () => {
    const store = fakeStore()
    const faults: ChannelFaults = {}
    const channels = fakeChannels(faults)
    const engine = stickyEngine(channels, store)

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    faults.post = apiError(RESTJSONErrorCodes.UnknownChannel)

    chatter(engine, 1)
    await tick(0)

    expect(stderr.join('')).toContain('the sticky channel is gone')
    expect(store.written()).toBe('[]\n')

    // And it stays forgotten: nothing is attempted for that channel again.
    faults.post = undefined
    const before = channels.calls.length

    chatter(engine, 100)
    await tick(60 * 60 * 1000)

    expect(channels.calls).toHaveLength(before)
  })

  it('forgets a sticky in a channel it may no longer post in', async () => {
    const faults: ChannelFaults = {}
    const channels = fakeChannels(faults)
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    // The bot was removed from the channel between the delete and the send.
    faults.post = apiError(RESTJSONErrorCodes.MissingPermissions)

    chatter(engine, 1)
    await tick(0)

    faults.post = undefined
    const before = channels.calls.length

    chatter(engine, 100)
    await tick(60 * 60 * 1000)

    expect(channels.calls).toHaveLength(before)
  })

  /**
   * A SEND THAT FAILED FOR A MOMENT LEAVES THE CHANNEL WITH NO STICKY AT ALL,
   * because the old copy was deleted first — and that is worse than one which
   * has drifted, since an outage notice has simply vanished. So the retry does
   * not wait for anybody to speak at all: drift is about how far a VISIBLE
   * notice has sunk, and there is nothing visible to sink.
   */
  it('brings a sticky back on its own after a send that failed for a moment', async () => {
    const faults: ChannelFaults = {}
    const channels = fakeChannels(faults)
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    // A 500, a rate limit, a connection that went away — not a Discord error
    // code that says anything is permanently wrong.
    faults.post = new Error('503 Service Unavailable')

    chatter(engine, 1)
    await tick(0)

    expect(channels.posts()).toHaveLength(1)

    faults.post = undefined

    // Nobody says anything else, and it comes back one window later anyway.
    await tick(REPOST_COOLDOWN_MS)
    expect(channels.posts()).toHaveLength(2)
  })

  it('reports a send that keeps failing once, and retries a window apart', async () => {
    const channels = fakeChannels({ post: new Error('503 Service Unavailable') })
    const engine = stickyEngine(channels, fakeStore())

    // Nothing was ever posted, so the first attempt is the set itself.
    await expect(engine.set(CHANNEL, 'down')).rejects.toThrow()

    const stored = JSON.stringify([{ channelId: CHANNEL, text: 'down', messageId: 'm9' }])
    const retried = stickyEngine(channels, fakeStore(stored))

    await retried.restore()

    const before = channels.attempts()

    chatter(retried, 1)
    await tick(REPOST_COOLDOWN_MS * 5)

    // It kept trying — one send per window, which is what the retry is for —
    // and said so exactly once, which is what the status channel needs.
    expect(channels.attempts() - before).toBe(5)

    const complaints = stderr.join('').match(/could not repost the sticky/gu) ?? []
    expect(complaints).toHaveLength(1)
  })

  /**
   * A `/sticky` WHOSE POST FAILS CHANGES NOTHING. The previous sticky is still
   * standing in the channel and is still the one being maintained, because the
   * new copy goes up BEFORE the old one comes down.
   */
  it('leaves the previous sticky in place when the new one cannot be posted', async () => {
    const faults: ChannelFaults = {}
    const channels = fakeChannels(faults)
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')

    faults.post = apiError(RESTJSONErrorCodes.MissingPermissions)
    await expect(engine.set(CHANNEL, 'still down')).rejects.toThrow()
    faults.post = undefined

    // Nothing was deleted, so `m1` is still in the channel, and it is still the
    // text the engine reposts.
    await tick(REPOST_COOLDOWN_MS)
    chatter(engine, 1)
    await tick(0)

    expect(channels.calls).toEqual([
      { kind: 'post', channelId: CHANNEL, what: 'down' },
      { kind: 'remove', channelId: CHANNEL, what: 'm1' },
      { kind: 'post', channelId: CHANNEL, what: 'down' },
    ])
  })

  /**
   * A STATE FILE THAT CANNOT BE WRITTEN IS A WARNING, NOT A REFUSAL. What is
   * lost is the NEXT process's knowledge, not this one's: the sticky in front
   * of the admin works for the life of this process. Turning it into a failed
   * `/sticky` would trade a working sticky for none at all.
   */
  it('still sets a sticky when the state file cannot be written', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore(null, { save: new Error('EROFS: read-only') }))

    await expect(engine.set(CHANNEL, 'down')).resolves.toBe(false)

    expect(channels.posts()).toHaveLength(1)
    expect(stderr.join('')).toContain('could not write the sticky state')
  })
})

describe('setting and clearing a sticky', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  /**
   * `/sticky` TWICE IN ONE CHANNEL REPLACES. Two stickies in one channel is two
   * messages fighting to be last, each reposting on top of the other every
   * fifteen seconds until the bucket is empty.
   */
  it('replaces the sticky already in the channel and says that it did', async () => {
    const store = fakeStore()
    const channels = fakeChannels()
    const engine = stickyEngine(channels, store)

    await engine.set(CHANNEL, 'down')
    await expect(engine.set(CHANNEL, 'back up in ten')).resolves.toBe(true)

    // Post first, then take the old one down: an admin is watching, and a
    // channel briefly holding two is better than one holding none.
    expect(channels.calls).toEqual([
      { kind: 'post', channelId: CHANNEL, what: 'down' },
      { kind: 'post', channelId: CHANNEL, what: 'back up in ten' },
      { kind: 'remove', channelId: CHANNEL, what: 'm1' },
    ])

    // And there is exactly one of them on record, not two.
    expect(JSON.parse(store.written() ?? '[]')).toEqual([
      { channelId: CHANNEL, text: 'back up in ten', messageId: 'm2' },
    ])
  })

  it('reposts the new text, not the one it replaced', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await engine.set(CHANNEL, 'back up in ten')

    await tick(REPOST_COOLDOWN_MS)
    chatter(engine, 1)
    await tick(0)

    expect(channels.posts().at(-1)?.what).toBe('back up in ten')
  })

  it('takes the sticky down and forgets it', async () => {
    const store = fakeStore()
    const channels = fakeChannels()
    const engine = stickyEngine(channels, store)

    await engine.set(CHANNEL, 'down')
    await expect(engine.clear(CHANNEL)).resolves.toBe(true)

    expect(channels.calls.at(-1)).toEqual({ kind: 'remove', channelId: CHANNEL, what: 'm1' })
    expect(store.written()).toBe('[]\n')

    // Nothing comes back afterwards, however much is said.
    chatter(engine, 100)
    await tick(60 * 60 * 1000)

    expect(channels.posts()).toHaveLength(1)
  })

  it('answers false for a channel that has no sticky', async () => {
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore())

    await expect(engine.clear(CHANNEL)).resolves.toBe(false)
    expect(channels.calls).toHaveLength(0)
  })

  /**
   * `/unsticky` DURING A REPOST HAS TO WIN. The window is one round trip and it
   * is easy to reason away, but the consequence is permanent: a copy standing
   * in the channel that nothing remembers posting, which no `/unsticky` can
   * ever remove because nothing knows its id. So a repost that finds itself
   * orphaned takes down what it just posted.
   */
  it('removes the copy a repost posted after the sticky was cleared', async () => {
    const faults: ChannelFaults = {}
    const channels = fakeChannels(faults)
    const engine = stickyEngine(channels, fakeStore())

    await engine.set(CHANNEL, 'down')
    await tick(REPOST_COOLDOWN_MS)

    let cleared: Promise<boolean> | null = null

    // The admin runs /unsticky while the repost's send is in the air.
    faults.duringPost = () => {
      faults.duringPost = undefined
      cleared = engine.clear(CHANNEL)
    }

    chatter(engine, 1)
    await tick(0)
    await cleared

    // `m2` went up and came straight back down, so the channel is empty of
    // stickies rather than holding one nothing remembers.
    expect(channels.calls.filter((call) => call.kind === 'remove').map((call) => call.what)).toEqual(
      ['m1', 'm2'],
    )

    chatter(engine, 100)
    await tick(60 * 60 * 1000)

    expect(channels.posts()).toHaveLength(2)
  })
})

describe('the sticky state across a restart', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('takes the state directory from systemd when the unit supplies one', () => {
    try {
      // Colon-separated, because `StateDirectory=` may name more than one.
      vi.stubEnv('STATE_DIRECTORY', '/var/lib/blitz-bot:/var/lib/other')
      expect(stickyStatePath()).toBe(join('/var/lib/blitz-bot', 'stickies.json'))

      // An empty value is not a directory; the fallback has to hold.
      vi.stubEnv('STATE_DIRECTORY', '')
      expect(stickyStatePath()).toBe(join('/var/lib/blitz-bot', 'stickies.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  /**
   * THE FILE IS THE POINT OF THE FEATURE. This process restarts five seconds
   * after every crash and on every deploy, and a sticky a restart forgot is an
   * outage notice that stopped being maintained without anybody being told.
   */
  it('picks the sticky back up and keeps reposting it', async () => {
    const stored = JSON.stringify([{ channelId: CHANNEL, text: 'down', messageId: 'm9' }])
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore(stored))

    await engine.restore()
    await tick(REPOST_COOLDOWN_MS)

    chatter(engine, 1)
    await tick(0)

    // It knows which copy is standing, so it takes THAT one down rather than
    // leaving an orphan from before the restart.
    expect(channels.calls).toEqual([
      { kind: 'remove', channelId: CHANNEL, what: 'm9' },
      { kind: 'post', channelId: CHANNEL, what: 'down' },
    ])
  })

  /**
   * AND IT SAYS NOTHING AT STARTUP. `Restart=always` means a crash loop is a
   * restart every five seconds; a sticky that reposted on boot would put a
   * message in the channel on each of them, on top of whatever caused the
   * crashes.
   */
  it('does not repost just because the bot restarted', async () => {
    const stored = JSON.stringify([{ channelId: CHANNEL, text: 'down', messageId: 'm9' }])
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore(stored))

    await engine.restore()
    await tick(60 * 60 * 1000)

    expect(channels.calls).toHaveLength(0)
  })

  /**
   * A MISSING FILE IS THE ORDINARY STATE OF A BOX WHERE NOBODY HAS RUN
   * `/sticky`, and gets no line at all — the same rule the deploy notice
   * follows for its own missing file. A warning about a feature nobody set up
   * is noise in the channel that has to stay readable.
   */
  it('starts quietly when there is no state file', async () => {
    const engine = stickyEngine(fakeChannels(), fakeStore())

    await engine.restore()

    expect(stderr.join('')).toBe('')
    expect(stdout.join('')).toBe('')
  })

  /**
   * A CORRUPT FILE IS A FAULT AND THE BOT STILL STARTS. A crash between the
   * `open` and the write leaves a truncated file, which is exactly this case —
   * so the plain `writeFile` in `stickyStore` is safe to be plain, because this
   * is what its failure looks like.
   *
   * THE CONTENT IS NEVER LOGGED, ONLY ITS LENGTH. Whatever sits in a damaged
   * file is not a thing to copy into a Discord channel.
   */
  it('starts with no stickies when the file is not readable, and never quotes it', async () => {
    const engine = stickyEngine(fakeChannels(), fakeStore('[{"channelId": "10101010'))

    await engine.restore()

    const said = stderr.join('')
    expect(said).toContain('the sticky state is not readable')
    expect(said).not.toContain('10101010')
  })

  /**
   * ONE BAD ENTRY REJECTS THE WHOLE FILE. This file is written by nothing but
   * this bot, so anything in it that is not this shape means it was truncated
   * or edited by hand — and a half-trusted record of which messages to DELETE
   * is worse than none.
   */
  it('rejects a file of the wrong shape rather than salvaging half of it', async () => {
    const stored = JSON.stringify([
      { channelId: CHANNEL, text: 'down', messageId: 'm1' },
      { channelId: OTHER, text: 'down', messageId: 7 },
    ])

    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore(stored))

    await engine.restore()
    chatter(engine, 100)
    await tick(60 * 60 * 1000)

    expect(stderr.join('')).toContain('the sticky state is not readable')
    expect(channels.calls).toHaveLength(0)
  })

  it('restores a sticky that has no copy standing, and posts one for it', async () => {
    const stored = JSON.stringify([{ channelId: CHANNEL, text: 'down', messageId: null }])
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore(stored))

    await engine.restore()
    await tick(REPOST_COOLDOWN_MS)

    chatter(engine, 1)
    await tick(0)

    // Nothing to delete, so the repost is one call rather than two.
    expect(channels.calls).toEqual([{ kind: 'post', channelId: CHANNEL, what: 'down' }])
  })

  it('leaves a sticky set in the meantime alone', async () => {
    const stored = JSON.stringify([{ channelId: CHANNEL, text: 'old', messageId: 'm9' }])
    const channels = fakeChannels()
    const engine = stickyEngine(channels, fakeStore(stored))

    await engine.set(CHANNEL, 'new')
    await engine.restore()

    await tick(REPOST_COOLDOWN_MS)
    chatter(engine, 1)
    await tick(0)

    expect(channels.posts().at(-1)?.what).toBe('new')
  })

  /**
   * THE SEAM BETWEEN THE RULES ABOVE AND A REAL DISK, which is the one part the
   * fakes cannot speak for: a missing file has to reject with the `ENOENT` that
   * `restore` reads as silence, and what is written has to come back the way it
   * went in.
   */
  it('rejects with ENOENT for a file that is not there, and round-trips one that is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blitz-bot-'))

    try {
      const path = join(dir, 'stickies.json')
      const store = stickyStore(path)

      await expect(store.load()).rejects.toMatchObject({ code: 'ENOENT' })

      const engine = stickyEngine(fakeChannels(), store)
      await engine.set(CHANNEL, 'down')

      // A trailing newline, so `cat` of it during an outage does not run into
      // the next prompt.
      const raw = await readFile(path, 'utf8')
      expect(raw.endsWith('\n')).toBe(true)
      expect(JSON.parse(raw)).toEqual([{ channelId: CHANNEL, text: 'down', messageId: 'm1' }])

      const next = stickyEngine(fakeChannels(), stickyStore(path))
      await next.restore()

      expect(stdout.join('')).toContain('stickies restored')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a file written by hand exactly as it reads its own', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blitz-bot-'))

    try {
      const path = join(dir, 'stickies.json')
      await writeFile(path, 'not json at all', 'utf8')

      const engine = stickyEngine(fakeChannels(), stickyStore(path))
      await engine.restore()

      expect(stderr.join('')).toContain('the sticky state is not readable')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the engine the commands reach for', () => {
  it('is null until one is installed, and null again when it is taken out', () => {
    expect(stickies()).toBeNull()

    const engine = stickyEngine(fakeChannels(), fakeStore())
    setStickies(engine)
    expect(stickies()).toBe(engine)

    setStickies(null)
    expect(stickies()).toBeNull()
  })
})

/**
 * The live half: the one listener and the two Discord calls.
 *
 * THE CLIENT IS A FAKE THAT ONLY REMEMBERS LISTENERS, the same shape
 * commands.test.ts uses for `installCommands`. What is being checked is which
 * event is subscribed to and what is passed to the engine — not discord.js.
 */
describe('installing the sticky on a client', () => {
  interface Listeners {
    [event: string]: ((...args: never[]) => void) | undefined
  }

  function fakeClient(listeners: Listeners, selfId: string | null = SELF): Client {
    return {
      user: selfId === null ? null : { id: selfId },
      channels: { fetch: () => Promise.resolve(null) },
      on: (event: string, listener: (...args: never[]) => void) => {
        listeners[event] = listener
      },
    } as unknown as Client
  }

  /** An engine that does nothing but write down what the listener told it. */
  function watcher(seen: [string, boolean][]): Stickies {
    return {
      saw: (channelId, fromSelf) => seen.push([channelId, fromSelf]),
      set: () => Promise.resolve(false),
      clear: () => Promise.resolve(false),
      restore: () => Promise.resolve(),
    }
  }

  /** One gateway message, through whatever `installStickies` subscribed. */
  function fire(
    listeners: Listeners,
    message: { channelId: string; author: { id: string } | null },
  ): void {
    const onMessage = listeners[Events.MessageCreate] as unknown as
      | ((message: { channelId: string; author: { id: string } | null }) => void)
      | undefined

    if (onMessage === undefined) throw new Error('installStickies registered no messageCreate')
    onMessage(message)
  }

  /**
   * `messageCreate` AND NOT THE HANDLER client.ts SHARES WITH `messageUpdate`.
   * An edit is not drift: nothing moved and nothing was pushed down, so a
   * sticky that counted edits would repost because somebody fixed a typo.
   */
  it('listens for new messages and not for edits', () => {
    const listeners: Listeners = {}

    installStickies(fakeClient(listeners))

    expect(typeof listeners[Events.MessageCreate]).toBe('function')
    expect(listeners[Events.MessageUpdate]).toBeUndefined()
  })

  it('installs the engine where the commands reach for it, and reads the state file', async () => {
    const restored: true[] = []

    installStickies(fakeClient({}), { ...watcher([]), restore: () => {
      restored.push(true)
      return Promise.resolve()
    } })

    expect(stickies()).not.toBeNull()

    await Promise.resolve()
    expect(restored).toHaveLength(1)
  })

  it('tells the engine which channel a message arrived in', () => {
    const listeners: Listeners = {}
    const seen: [string, boolean][] = []

    installStickies(fakeClient(listeners), watcher(seen))
    fire(listeners, { channelId: CHANNEL, author: { id: '999' } })

    expect(seen).toEqual([[CHANNEL, false]])
  })

  it('calls the bot its own message', () => {
    const listeners: Listeners = {}
    const seen: [string, boolean][] = []

    installStickies(fakeClient(listeners), watcher(seen))
    fire(listeners, { channelId: CHANNEL, author: { id: SELF } })

    expect(seen).toEqual([[CHANNEL, true]])
  })

  /**
   * A MESSAGE THAT CANNOT BE ATTRIBUTED IS DRIFT, NOT OURS, and this is the
   * case a `message.author?.id === client.user?.id` one-liner gets wrong: with
   * neither side known it compares `undefined` to `undefined`, calls the
   * message the bot's own, and stops the sticky in a way nothing reports.
   */
  it('counts a message it cannot attribute rather than calling it its own', () => {
    const listeners: Listeners = {}
    const seen: [string, boolean][] = []

    // No user on the client, and then no author on the payload. Neither is a
    // state this bot really reaches; both are states this rule has to have an
    // answer for.
    installStickies(fakeClient(listeners, null), watcher(seen))
    fire(listeners, { channelId: CHANNEL, author: { id: '999' } })
    fire(listeners, { channelId: CHANNEL, author: null })

    setStickies(null)

    const known: Listeners = {}
    installStickies(fakeClient(known, SELF), watcher(seen))
    fire(known, { channelId: CHANNEL, author: null })

    expect(seen).toEqual([
      [CHANNEL, false],
      [CHANNEL, false],
      [CHANNEL, false],
    ])
  })

  it('says so rather than throwing when the state file cannot be read at all', async () => {
    installStickies(fakeClient({}), {
      ...watcher([]),
      restore: () => Promise.reject(new Error('EACCES')),
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(stderr.join('')).toContain('could not restore the stickies')
  })

  it('refuses a channel id that names nothing this bot can post in', async () => {
    const client = {
      channels: { fetch: () => Promise.resolve(null) },
    } as unknown as Client

    const live = stickyChannels(client)

    await expect(live.post(CHANNEL, 'down')).rejects.toThrow(
      'the sticky channel id names no channel this bot can post in',
    )

    await expect(live.remove(CHANNEL, 'm1')).rejects.toThrow(
      'the sticky channel id names no channel this bot can post in',
    )
  })

  /**
   * NOTHING THIS STICKY SENDS CAN PING ANYONE. The text is an admin's, so it
   * CAN carry a mention, and a message reposted every fifteen seconds is the
   * last thing that should be able to notify a role. The client-wide default
   * says so already; the suppression is repeated at the send because that
   * default is silently replaced by any call passing `allowedMentions` of its
   * own, and this is the call.
   */
  it('sends with mentions suppressed and answers with the new message id', async () => {
    const sent: unknown[] = []
    const deleted: string[] = []

    const client = {
      channels: {
        fetch: () =>
          Promise.resolve({
            isSendable: () => true,
            send: (options: unknown) => {
              sent.push(options)
              return Promise.resolve({ id: 'm7' })
            },
            messages: {
              delete: (id: string) => {
                deleted.push(id)
                return Promise.resolve()
              },
            },
          }),
      },
    } as unknown as Client

    const live = stickyChannels(client)

    await expect(live.post(CHANNEL, 'down')).resolves.toBe('m7')
    expect(sent).toEqual([{ content: 'down', allowedMentions: { parse: [] } }])

    await live.remove(CHANNEL, 'm7')
    expect(deleted).toEqual(['m7'])
  })
})
