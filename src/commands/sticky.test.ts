import { ApplicationCommandOptionType } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Config } from '../config.ts'
import { setSink } from '../log.ts'
import { setStickies, STICKY_TEXT_CAP, type Stickies } from '../sticky.ts'
import {
  COPY as COMMAND_COPY,
  refusalFor,
  runCommand,
  type Invocation,
  type Responder,
} from './command.ts'
import { sticky, STICKY_TEXT_OPTION, unsticky, type StickyFields, COPY } from './sticky.ts'

/**
 * `/sticky` and `/unsticky`, offline.
 *
 * WHAT IS BEING TESTED HERE IS WHAT THE ADMIN IS TOLD, and nothing else. The
 * throttle, the state file and every Discord call live in ../sticky.ts and are
 * exercised in ../sticky.test.ts against fakes; the engine here is three
 * functions that write down what they were handed, so these cases are about the
 * gate, the two option shapes and which of the eight replies comes back.
 *
 * THE REFUSALS MATTER MORE THAN THE HAPPY PATH. A `/sticky` that cannot tell
 * which channel it is in, or that was given two thousand and one characters,
 * must answer the admin and reach nothing — a bad sticky that gets as far as
 * the state file is retried every fifteen seconds by a process with nobody left
 * to tell.
 */

const GUILD = '111111111111111111'
const ADMIN_ROLE = '222222222222222222'
const OTHER_ROLE = '333333333333333333'
const MEMBER = '444444444444444444'
const CHANNEL = '555555555555555555'

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

  // Both are module state, and a case that leaves either set changes the next
  // file to run rather than failing here.
  setSink(null)
  setStickies(null)
})

function cfg(over: Partial<Config> = {}): Config {
  return {
    discordToken: 'token',
    guildId: GUILD,
    adminRoleId: ADMIN_ROLE,
    logChannelId: null,
    statusChannelId: null,
    docsChannelId: null,
    maintenanceChannelId: null,
    exemptChannelIds: [],
    serverIps: ['3.130.92.28'],
    exemptAdmins: true,
    dryRun: false,
    commandSecret: null,
    ringmasterUrl: 'http://127.0.0.1:3000',
    gameBanRoleId: '1542596612306505808',
    ...over,
  }
}

/**
 * An invocation as it arrives today, plus the two fields these commands need.
 *
 * `channelId` AND `text` ARE SPREAD IN RATHER THAN NAMED IN THE BASE, which is
 * the same shape the commands read them with and the reason they can be written
 * before ./command.ts carries them: an invocation without either is a case
 * below, not a compile error.
 */
function invocation(over: Partial<Invocation & StickyFields> = {}): Invocation & StickyFields {
  return {
    commandName: 'sticky',
    guildId: GUILD,
    userId: MEMBER,
    roleIds: [ADMIN_ROLE],
    targetId: null,
    channelId: CHANNEL,
    text: 'the server is down',
    ...over,
  }
}

/** What the engine was asked to do, in order. */
interface EngineCall {
  readonly kind: 'set' | 'clear'
  readonly channelId: string
  readonly text: string | null
}

interface FakeEngine extends Stickies {
  readonly calls: EngineCall[]
}

function fakeEngine(answer = false): FakeEngine {
  const calls: EngineCall[] = []

  return {
    calls,
    saw: () => undefined,
    restore: () => Promise.resolve(),

    set: (channelId, text) => {
      calls.push({ kind: 'set', channelId, text })
      return Promise.resolve(answer)
    },

    clear: (channelId) => {
      calls.push({ kind: 'clear', channelId, text: null })
      return Promise.resolve(answer)
    },
  }
}

/** `runCommand`'s three outputs, remembered rather than sent. */
function responder(): Responder & {
  deferred: boolean[]
  edited: string[]
  replied: [string, boolean][]
} {
  const deferred: boolean[] = []
  const edited: string[] = []
  const replied: [string, boolean][] = []

  return {
    deferred,
    edited,
    replied,
    defer: (onlyInvoker) => {
      deferred.push(onlyInvoker)
      return Promise.resolve()
    },
    edit: (reply) => {
      // `Responder.edit` takes a string OR embeds since /profile stopped
      // flattening its own. Neither of these two commands has anything but a
      // sentence to say, so an embed arriving here is a case worth failing on
      // rather than one to render.
      if (typeof reply !== 'string') throw new Error('a sticky command answered with an embed')

      edited.push(reply)
      return Promise.resolve()
    },
    reply: (content, onlyInvoker) => {
      replied.push([content, onlyInvoker])
      return Promise.resolve()
    },
  }
}

describe('what Discord is told about the two commands', () => {
  /**
   * `/sticky`, NOT `/pin`. Discord's own pin is a different feature with a
   * different list and a different permission, and a message that reposts
   * itself is not one. Two features under one name is a support conversation
   * every time somebody new joins the admin role.
   */
  it('is not called pin', () => {
    expect(sticky.data.name).toBe('sticky')
    expect(unsticky.data.name).toBe('unsticky')
  })

  it('takes its text in the option invocationOf has to read', () => {
    const [option] = sticky.data.options ?? []

    expect(option?.name).toBe(STICKY_TEXT_OPTION)
    expect(option?.type).toBe(ApplicationCommandOptionType.String)

    // Required, because there is no sensible sticky with no text in it.
    expect(option).toMatchObject({ required: true })
  })

  /** `/unsticky` acts on the channel it was run in and takes nothing. */
  it('gives unsticky no options at all', () => {
    expect(unsticky.data.options ?? []).toHaveLength(0)
  })

  /** Discord allows 1-100 characters on a command and on an option. */
  it('describes both commands within what Discord will accept', () => {
    for (const description of [
      sticky.data.description,
      unsticky.data.description,
      String(sticky.data.options?.[0]?.description),
    ]) {
      expect(description.length).toBeGreaterThan(0)
      expect(description.length).toBeLessThanOrEqual(100)
    }
  })

  /**
   * SIX OF THESE ARE HIS AND TWO ARE NOT, AND ALL EIGHT ARE PINNED BY CONSTANT.
   *
   * IT USED TO ASSERT THAT THE TWO SAID `PLACEHOLDER`. They led with the word so
   * that shipping one was obvious in the channel, and he then read one on
   * `/drain` and asked for the marker out of the product. It is a tag in the doc
   * comment now, `scripts/check-placeholders.ts` prints both on every verify,
   * and this case compares against the record — which is what src/client.ts's
   * COPY says to do, and says using this file as the example of the alternative:
   * nine assertions there held fragments of draft prose and all nine broke on
   * the day the real wording arrived.
   *
   * SO NOTHING HERE FAILS WHEN HE SUPPLIES THE LAST TWO, which is the point. It
   * fails when a reply stops being the string the record says it is.
   */
  it('answers out of the record, for the six he supplied and the two he has not', async () => {
    const engine = fakeEngine()
    setStickies(engine)

    const replies = [
      await sticky.run(invocation(), cfg()),
      await sticky.run(invocation({ text: '  ' }), cfg()),
      await sticky.run(invocation({ text: 'x'.repeat(STICKY_TEXT_CAP + 1) }), cfg()),
      await sticky.run(invocation({ channelId: null }), cfg()),
      await unsticky.run(invocation(), cfg()),
    ]

    // His words, verbatim, for the six he supplied.
    expect(replies[0]).toBe(COPY.set)
    expect(replies[3]).toBe(COPY.noChannel)
    expect(replies[4]).toBe(COPY.nothingToClear)

    // `empty` and `tooLong` are the two he has NOT supplied. Pinned by constant,
    // so supplying them is one edit to ./sticky.ts and nothing here moves.
    expect(replies[1]).toBe(COPY.empty)
    expect(replies[2]).toBe(COPY.tooLong)

    // And neither carries a marker into the channel, which is the fault that
    // reached him on /drain. The tag lives in the doc comment; see
    // scripts/check-placeholders.ts, which refuses this repo-wide.
    for (const reply of replies) {
      expect(reply).not.toContain('PLACEHOLDER')
      expect(reply).not.toContain('@unwritten')
    }
  })
})

describe('who may run them', () => {
  /**
   * THE OWNER'S DESCRIPTION IS "AN ADMIN-ONLY MESSAGE", and `adminOnly` is the
   * whole of that in both halves: the role check in `refusalFor` and the
   * `defaultMemberPermissions: 0n` that `commandData` derives from it. A
   * sticky is a message the bot reposts every fifteen seconds under the bot's
   * own name, which is not a thing to leave open to a guild.
   */
  it('refuses a member who does not hold the admin role', () => {
    const member = invocation({ roleIds: [OTHER_ROLE] })

    expect(refusalFor(sticky, member, cfg())).toBe('not-admin')
    expect(refusalFor(unsticky, member, cfg())).toBe('not-admin')
  })

  it('lets an admin through', () => {
    expect(refusalFor(sticky, invocation(), cfg())).toBeNull()
    expect(refusalFor(unsticky, invocation(), cfg())).toBeNull()
  })

  /** An unset admin role means nobody is an admin, so nobody may stick. */
  it('refuses everybody when no admin role is configured', () => {
    expect(refusalFor(sticky, invocation(), cfg({ adminRoleId: null }))).toBe('admin-role-unset')
  })

  /**
   * THE REPLY IS EPHEMERAL, AND NOT ONLY FOR TIDINESS. A visible reply is a
   * message in the channel, so the bot would push its own sticky down by
   * confirming that it had put it up — and then repost over the confirmation.
   */
  it('answers only the admin who ran it', () => {
    expect(sticky.onlyInvoker(invocation())).toBe(true)
    expect(unsticky.onlyInvoker(invocation())).toBe(true)
  })
})

describe('putting a sticky up', () => {
  it('hands the engine the channel it was run in and the text as typed', async () => {
    const engine = fakeEngine()
    setStickies(engine)

    const reply = await sticky.run(invocation({ text: '  the server is down  ' }), cfg())

    expect(engine.calls).toEqual([
      { kind: 'set', channelId: CHANNEL, text: '  the server is down  ' },
    ])

    expect(reply).toBe(COPY.set)
  })

  /**
   * `/sticky` TWICE IN ONE CHANNEL REPLACES, and the admin is told which of the
   * two happened. Two stickies in one channel would be two messages fighting to
   * be last, each reposting over the other every fifteen seconds.
   */
  it('says so when it replaced a sticky that was already there', async () => {
    setStickies(fakeEngine(true))

    await expect(sticky.run(invocation(), cfg())).resolves.toBe(COPY.replaced)
  })

  /**
   * TEXT PAST DISCORD'S CAP IS REFUSED BEFORE ANYTHING IS WRITTEN DOWN. A
   * sticky Discord will not accept is not a failed command if it reaches the
   * state file: it is a 50035 raised every fifteen seconds by a process with
   * nobody left to tell about it.
   */
  it('refuses text past the message cap and reaches nothing', async () => {
    const engine = fakeEngine()
    setStickies(engine)

    const reply = await sticky.run(invocation({ text: 'x'.repeat(STICKY_TEXT_CAP + 1) }), cfg())

    expect(reply).toContain(`longer than ${STICKY_TEXT_CAP}`)
    expect(engine.calls).toHaveLength(0)
  })

  it('takes text of exactly the cap', async () => {
    const engine = fakeEngine()
    setStickies(engine)

    await sticky.run(invocation({ text: 'x'.repeat(STICKY_TEXT_CAP) }), cfg())

    expect(engine.calls).toHaveLength(1)
  })

  it('refuses text that is only whitespace, which Discord would reject', async () => {
    const engine = fakeEngine()
    setStickies(engine)

    const reply = await sticky.run(invocation({ text: ' \n\t ' }), cfg())

    expect(reply).toContain('no text in it')
    expect(engine.calls).toHaveLength(0)
  })

  /**
   * THE TWO FIELDS `Invocation` DOES NOT CARRY YET. Until ./command.ts grows
   * them and `invocationOf` fills them in, these commands have to refuse in a
   * way an admin can read rather than throw, stick to the wrong channel, or
   * post an empty message. Both of these cases delete themselves the day the
   * wiring lands.
   */
  it('refuses rather than guessing when the invocation carries no channel', async () => {
    const engine = fakeEngine()
    setStickies(engine)

    for (const missing of [{ channelId: null }, { channelId: undefined }, { channelId: '' }]) {
      const reply = await sticky.run(invocation(missing), cfg())

      expect(reply).toBe(COPY.noChannel)
    }

    expect(engine.calls).toHaveLength(0)
  })

  it('refuses rather than posting nothing when the invocation carries no text', async () => {
    const engine = fakeEngine()
    setStickies(engine)

    const reply = await sticky.run(invocation({ text: undefined }), cfg())

    expect(reply).toContain('no text in it')
    expect(engine.calls).toHaveLength(0)
  })

  /**
   * NO ENGINE IS A SENTENCE, NOT A CRASH. It means `installStickies` never ran
   * — a client built without it, or a test that injected nothing — and what
   * Discord shows for a handler that throws is a reply saying the command
   * failed, which tells an operator nothing about which half is missing.
   */
  it('says so when no engine has been installed', async () => {
    await expect(sticky.run(invocation(), cfg())).resolves.toBe(COPY.unavailable)
    await expect(unsticky.run(invocation(), cfg())).resolves.toBe(COPY.unavailable)
  })
})

describe('taking a sticky down', () => {
  it('clears the channel it was run in', async () => {
    const engine = fakeEngine(true)
    setStickies(engine)

    const reply = await unsticky.run(invocation({ commandName: 'unsticky' }), cfg())

    expect(engine.calls).toEqual([{ kind: 'clear', channelId: CHANNEL, text: null }])
    expect(reply).toBe(COPY.cleared)
  })

  /**
   * A CHANNEL WITH NO STICKY IS AN ANSWER, NOT A FAILURE. An admin who ran
   * `/unsticky` twice needs to be told the second one did nothing rather than
   * shown the same confirmation again and left wondering.
   */
  it('says there was nothing there rather than confirming twice', async () => {
    setStickies(fakeEngine(false))

    await expect(unsticky.run(invocation(), cfg())).resolves.toBe(COPY.nothingToClear)
  })

  it('refuses when the invocation carries no channel', async () => {
    const engine = fakeEngine()
    setStickies(engine)

    await expect(unsticky.run(invocation({ channelId: null }), cfg())).resolves.toBe(COPY.noChannel)

    expect(engine.calls).toHaveLength(0)
  })
})

/**
 * THE WHOLE PATH, THROUGH THE FOUNDATION THAT ACTUALLY RUNS THEM. Everything
 * above calls `run` directly, which skips the gate, the defer and the failure
 * handling — the three things that decide what an admin sees.
 */
describe('through runCommand', () => {
  it('refuses a member without ever reaching the engine', async () => {
    const engine = fakeEngine()
    setStickies(engine)

    const respond = responder()

    await runCommand(invocation({ roleIds: [OTHER_ROLE] }), cfg(), respond, [sticky])

    expect(engine.calls).toHaveLength(0)
    expect(respond.deferred).toHaveLength(0)
    expect(respond.replied[0]?.[1]).toBe(true)
  })

  it('defers to the invoker alone and fills the reply in', async () => {
    setStickies(fakeEngine())

    const respond = responder()

    await runCommand(invocation(), cfg(), respond, [sticky])

    expect(respond.deferred).toEqual([true])
    expect(respond.edited[0]).toBe(COPY.set)
  })

  /**
   * AN ENGINE THAT REJECTS BECOMES A REPLY. `set` rejects when the channel
   * cannot be posted to, and the alternative Discord shows the admin is "The
   * application did not respond" — which describes a bot that is down, when
   * what happened is one command failing for a reason already in the journal.
   */
  it('turns a channel that cannot be posted to into an answer', async () => {
    setStickies({
      ...fakeEngine(),
      set: () => Promise.reject(new Error('the sticky channel id names no channel')),
    })

    const respond = responder()

    await runCommand(invocation(), cfg(), respond, [sticky])

    // ../command.ts's `COPY.failed`, pinned by constant. It is that file's
    // string and this case is only asserting which of them arrives.
    expect(respond.edited[0]).toBe(COMMAND_COPY.failed)
    expect(stderr.join('')).toContain('slash command handler failed')
  })
})
