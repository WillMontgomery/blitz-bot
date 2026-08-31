import { ApplicationCommandOptionType } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Config } from '../config.ts'
import { setSink } from '../log.ts'
import { DRAIN_NOTE_CAP, type CancelResult, type Drainer, type DrainResult } from '../ringmaster.ts'
import { refusalFor, runCommand, type Invocation, type Responder } from './command.ts'
import {
  COPY,
  drainCommand,
  DRAIN_CANCEL_SUBCOMMAND,
  DRAIN_NOTE_OPTION,
  DRAIN_START_SUBCOMMAND,
  lazyDrainer,
  replyForCancel,
  replyForSchedule,
  type DrainFields,
} from './drain.ts'

/**
 * `/drain`, offline.
 *
 * WHAT IS BEING TESTED HERE IS WHAT AN ADMIN IS TOLD AND WHAT THE CONSOLE IS
 * ASKED FOR — nothing else. Every HTTP concern lives in ../ringmaster.ts and is
 * exercised in ../ringmaster.test.ts against an injected `fetch`; the relay here
 * is an object literal that writes down what it was handed, so these cases are
 * about the gate, the two halves, the note, and which of the eight replies comes
 * back.
 *
 * THE REFUSALS MATTER MORE THAN THE HAPPY PATH, AND MORE THAN THEY DO ANYWHERE
 * ELSE IN THIS BOT. A `/drain` that guesses wrong does not post the wrong
 * message: it restarts the game server and ends every match on the box. So the
 * cases that matter most below are the ones where NOTHING is asked for — no
 * subcommand, no credential — and the ones that check the console's own reason
 * reaches the admin unedited, because the bot cannot see what the console
 * looked at and must not paraphrase it.
 */

const GUILD = '111111111111111111'
const ADMIN_ROLE = '222222222222222222'
const OTHER_ROLE = '333333333333333333'
const MEMBER = '444444444444444444'
const CHANNEL = '555555555555555555'

/** The console's own words, transcribed rather than invented. See ../ringmaster.test.ts. */
const NOTHING_TO_DEPLOY =
  'The server is already running the latest code — there is nothing to deploy.'
const ALREADY = 'A maintenance window is already scheduled. Cancel it first.'

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

  // The sink is module state in log.ts, the same trap client.test.ts closes.
  setSink(null)
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
    commandSecret: 'a-shared-secret',
    ringmasterUrl: 'http://127.0.0.1:3000',
    gameBanRoleId: '1542596612306505808',
    ...over,
  }
}

/**
 * An invocation as it arrives today, plus the two fields this command needs.
 *
 * `subcommand` AND `note` ARE SPREAD IN rather than named in the base, which is
 * the shape the command reads them with and the reason it can be written before
 * ./command.ts carries them: an invocation without either is a case below, not
 * a compile error.
 */
function invocation(over: Partial<Invocation & DrainFields> = {}): Invocation & DrainFields {
  return {
    commandName: 'drain',
    guildId: GUILD,
    userId: MEMBER,
    roleIds: [ADMIN_ROLE],
    targetId: null,
    channelId: CHANNEL,
    text: null,
    subcommand: DRAIN_START_SUBCOMMAND,
    note: null,
    ...over,
  }
}

/** A window the console really answers with. */
const WINDOW = {
  state: 'scheduled',
  note: 'a server update',
  drainStartsAt: 1_700_000_000_000,
  deployMode: 'when-empty',
  deployAt: null,
}

const SCHEDULED: DrainResult = { outcome: 'scheduled', status: 201, window: WINDOW }

/** What the relay was asked to do, in order. */
interface RelayCall {
  readonly kind: 'schedule' | 'cancel'
  readonly actorDiscordId: string
  readonly note: string | null | undefined
}

interface FakeRelay extends Drainer {
  readonly calls: RelayCall[]
}

function relay(
  schedule: DrainResult = SCHEDULED,
  cancel: CancelResult = { outcome: 'cancelled', status: 200 },
): FakeRelay {
  const calls: RelayCall[] = []

  return {
    calls,

    schedule: (input) => {
      calls.push({ kind: 'schedule', actorDiscordId: input.actorDiscordId, note: input.note })
      return Promise.resolve(schedule)
    },

    cancel: (input) => {
      calls.push({ kind: 'cancel', actorDiscordId: input.actorDiscordId, note: null })
      return Promise.resolve(cancel)
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
      edited.push(typeof reply === 'string' ? reply : JSON.stringify(reply))
      return Promise.resolve()
    },

    reply: (content, onlyInvoker) => {
      replied.push([content, onlyInvoker])
      return Promise.resolve()
    },
  }
}

/** Run the command and hand back the one thing the admin was shown. */
async function answerFor(
  fake: Drainer | null,
  over: Partial<Invocation & DrainFields> = {},
  config = cfg(),
): Promise<string> {
  const respond = responder()

  await runCommand(invocation(over), config, respond, [drainCommand(() => fake)])

  const shown = respond.edited[0] ?? respond.replied[0]?.[0]
  if (shown === undefined) throw new Error('the admin was shown nothing at all')
  return shown
}

describe('/drain — how it is registered, which is half of the guard', () => {
  const drain = drainCommand(() => relay())

  /**
   * ADMIN-ONLY, UNCONDITIONALLY, AND EPHEMERAL. There is no half of this command
   * that answers about the caller and no invocation of it that is harmless, so
   * the gate is a boolean rather than a predicate — which is also what makes
   * `commandData` hide it from every member's picker.
   */
  it('is admin-only and answers only the person who ran it', () => {
    expect(drain.adminOnly).toBe(true)
    expect(drain.onlyInvoker(invocation())).toBe(true)
  })

  it('is refused for a member who does not hold the admin role', () => {
    expect(refusalFor(drain, invocation({ roleIds: [OTHER_ROLE] }), cfg())).toBe('not-admin')
  })

  /**
   * AND AN UNSET DISCORD_ADMIN_ROLE_ID REFUSES RATHER THAN OPENING THE DOOR.
   * Pinned here as well as in commands.test.ts because this is the command where
   * the direction of that failure costs a game server.
   */
  it('is refused for everybody when no admin role is configured', () => {
    expect(refusalFor(drain, invocation(), cfg({ adminRoleId: null }))).toBe('admin-role-unset')
  })

  it('offers two named halves rather than one toggle', () => {
    const names = (drain.data.options ?? []).map((one) => one.name)

    expect(names).toEqual([DRAIN_START_SUBCOMMAND, DRAIN_CANCEL_SUBCOMMAND])
    expect(DRAIN_CANCEL_SUBCOMMAND).toBe('cancel')

    for (const option of drain.data.options ?? []) {
      expect(option.type).toBe(ApplicationCommandOptionType.Subcommand)
    }
  })

  /**
   * THE NOTE IS OPTIONAL AND IS CAPPED IN THE CLIENT. Optional because
   * `scheduleSchema` says a note is usually absent and the console writes its
   * own; capped at the console's own limit so an admin is stopped from typing
   * an over-long one rather than having it silently cut afterwards.
   */
  it('declares the note as an optional string at the console`s own limit', () => {
    const start = (drain.data.options ?? []).find(
      (one) => one.name === DRAIN_START_SUBCOMMAND,
    )

    if (start === undefined || !('options' in start)) throw new Error('no start subcommand')

    const note = (start.options ?? [])[0]

    expect(note?.name).toBe(DRAIN_NOTE_OPTION)
    expect(note?.type).toBe(ApplicationCommandOptionType.String)
    expect(note && 'required' in note ? note.required : undefined).toBe(false)
    expect(note && 'maxLength' in note ? note.maxLength : undefined).toBe(DRAIN_NOTE_CAP)
  })

  /** Cancelling takes nothing. There is only ever one window to call off. */
  it('gives the cancel half no options at all', () => {
    const cancel = (drain.data.options ?? []).find(
      (one) => one.name === DRAIN_CANCEL_SUBCOMMAND,
    )

    if (cancel === undefined) throw new Error('no cancel subcommand')
    expect('options' in cancel ? cancel.options : undefined).toBeUndefined()
  })
})

describe('/drain — what the console is asked for, and by whom', () => {
  it('asks for a window when the start half was invoked', async () => {
    const fake = relay()
    await answerFor(fake)

    expect(fake.calls).toEqual([{ kind: 'schedule', actorDiscordId: MEMBER, note: null }])
  })

  /**
   * THE WINDOW IS ATTRIBUTED TO THE ADMIN WHO TYPED IT, NEVER TO THIS BOT. The
   * console puts this id through the SAME Discord role gate the browser path
   * runs and writes the audit row against them — their license, their name,
   * their id. A row naming `blitz-bot` would answer the wrong question.
   */
  it('attributes the window to the admin who ran the command', async () => {
    const fake = relay()
    await answerFor(fake, { userId: '999999999999999999' })

    expect(fake.calls[0]?.actorDiscordId).toBe('999999999999999999')
  })

  /** The admin's words, unedited. Players at the door are shown them. */
  it('passes the note through exactly as it was typed', async () => {
    const fake = relay()
    const note = 'back in ~10 min — shipping the loot fix. sorry!'
    await answerFor(fake, { note })

    expect(fake.calls[0]?.note).toBe(note)
  })

  /**
   * AN ABSENT NOTE IS ABSENT, NOT A SENTENCE THIS FILE MADE UP. The console
   * generates one — that wording belongs to whoever wrote the console — and a
   * default invented here would be a second wording for the same silence, shown
   * to players.
   */
  it('sends no note at all when none was typed, rather than inventing one', async () => {
    const fake = relay()
    await answerFor(fake, { note: null })

    expect(fake.calls[0]?.note).toBeNull()
  })

  it('treats an option supplied blank as no note', async () => {
    const fake = relay()
    await answerFor(fake, { note: '' })

    expect(fake.calls[0]?.note).toBeNull()
  })

  it('calls the window off when the cancel half was invoked', async () => {
    const fake = relay()
    await answerFor(fake, { subcommand: DRAIN_CANCEL_SUBCOMMAND })

    expect(fake.calls).toEqual([{ kind: 'cancel', actorDiscordId: MEMBER, note: null }])
  })

  /**
   * ═══ THE CASE THAT MATTERS MOST IN THIS FILE ═══
   *
   * A `/drain` whose subcommand cannot be read must reach NOTHING. Discord
   * requires a subcommand on a command declared with them, so an invocation
   * without one is a payload that is not what this bot expects — and the safe
   * reading of a `/drain` we cannot parse is never "probably the one that
   * restarts the game server".
   */
  it('asks for nothing at all when it cannot tell which half was meant', async () => {
    for (const subcommand of [null, undefined, '', 'start ', 'DRAIN', 'schedule']) {
      const fake = relay()
      const shown = await answerFor(fake, { subcommand })

      expect(fake.calls).toEqual([])
      expect(shown).toBe(COPY.noSubcommand)
    }
  })

  /**
   * AND WITH NO CREDENTIAL THERE IS NO DOOR TO KNOCK ON. Saying so is better
   * than a request that comes back 401 and reads to an admin like the console
   * is broken.
   */
  it('says the bot has no credential rather than sending a request that cannot work', async () => {
    expect(await answerFor(null)).toBe(COPY.noCredential)
  })

  /**
   * `lazyDrainer` IS THE REAL WIRING AND IT ANSWERS THE SAME WAY. Null without
   * a secret; a relay with one, built once and kept — see ./index.ts for why it
   * cannot be built at import.
   */
  it('builds no relay at all without a COMMAND_SECRET, and one otherwise', () => {
    const drainerFor = lazyDrainer()

    expect(drainerFor(cfg({ commandSecret: null }))).toBeNull()

    const first = drainerFor(cfg())
    expect(first).not.toBeNull()
    expect(drainerFor(cfg())).toBe(first)
  })
})

describe('/drain — the reply says what is happening and when, not that it asked', () => {
  /**
   * THE DISCORD TIMESTAMP IS MARKUP AND NOT A WORDING CHOICE. `<t:SECONDS:R>`
   * renders in the READER's timezone, so the bot never has to decide whose
   * clock a maintenance window is stated in — which, decided wrongly, is the
   * bug the console fixed in this very route.
   *
   * SECONDS AND NOT MILLISECONDS, which is the one way to get this wrong: the
   * millisecond form renders a date fifty thousand years out and reads as a
   * broken server rather than a broken message.
   */
  it('states when the door closes, in the reader`s own clock', () => {
    const shown = replyForSchedule(SCHEDULED)

    expect(shown).toContain(`<t:${WINDOW.drainStartsAt / 1000}:R>`)
    expect(shown).not.toContain(String(WINDOW.drainStartsAt))
  })

  it('states that the restart waits for the last match, and takes it', () => {
    expect(replyForSchedule(SCHEDULED)).toContain(COPY.deployWhenEmpty)
  })

  /** The other mode the console has. It ends matches that are still running. */
  it('states the time instead when the console named one', () => {
    const shown = replyForSchedule({
      outcome: 'scheduled',
      status: 201,
      window: { ...WINDOW, deployMode: 'at-time', deployAt: 1_700_000_600_000 },
    })

    expect(shown).toContain('<t:1700000600:R>')
  })

  /** So the admin sees what players will see without opening the console. */
  it('shows the note players at the door are given', () => {
    expect(replyForSchedule(SCHEDULED)).toContain('a server update')
  })

  /**
   * A WINDOW WITH UNREADABLE FIELDS IS STILL A WINDOW, and the server is still
   * going down. Each field it cannot state is named rather than guessed — a
   * fallback to the local clock would be a made-up promise about a live server.
   */
  it('names what the console did not say rather than inventing it', () => {
    const shown = replyForSchedule({
      outcome: 'scheduled',
      status: 201,
      window: { state: null, note: null, drainStartsAt: null, deployMode: null, deployAt: null },
    })

    expect(shown).toContain(COPY.doorClosesUnknown)
    expect(shown).toContain(COPY.deployModeUnknown)
    expect(shown).toContain(COPY.doorNoteUnknown)
    expect(shown).not.toContain('NaN')
    expect(shown).not.toContain('undefined')
  })

  /** `at-time` with no time on it is a row we cannot read, not a time of zero. */
  it('does not state a restart time the console did not give', () => {
    const shown = replyForSchedule({
      outcome: 'scheduled',
      status: 201,
      window: { ...WINDOW, deployMode: 'at-time', deployAt: null },
    })

    expect(shown).toContain(COPY.deployModeUnknown)
    expect(shown).not.toContain('<t:0:')
  })

  /**
   * NOT ONE STRING THE ADMIN CAN SEE STILL CARRIES THE MARKER.
   *
   * THIS ASSERTION WAS INVERTED RATHER THAN DELETED, and the inversion is the
   * whole record of the owner's instruction: "remove PLACEHOLDER: from all text
   * please. The verbiage otherwise looks great." It used to require the marker
   * on every frame; it now refuses it on every one, so a later edit that
   * reintroduces the prefix — by copying a neighbouring stand-in, or by
   * reverting this change — fails here instead of shipping the word to a
   * channel he has already asked to have it out of.
   *
   * THE FACTS INSIDE THE FRAMES ARE REAL AND ALWAYS WERE, which is what the
   * cases above check.
   */
  it('carries no PLACEHOLDER marker in any frame of the reply', () => {
    const frames = [
      replyForSchedule(SCHEDULED),
      replyForCancel({ outcome: 'cancelled', status: 200 }),
      replyForSchedule({ outcome: 'refused', failure: 'refused', detail: 'x', status: 409 }),
      replyForSchedule({ outcome: 'refused', failure: 'denied', detail: 'auth', status: 401 }),
      replyForSchedule({ outcome: 'refused', failure: 'not-configured', detail: 'x', status: 503 }),
      replyForSchedule({ outcome: 'refused', failure: 'unreachable', detail: 'x', status: null }),
      replyForSchedule({ outcome: 'refused', failure: 'unavailable', detail: 'x', status: 503 }),
      replyForSchedule({ outcome: 'refused', failure: 'unknown', detail: 'x', status: 502 }),
      COPY.noCredential,
      COPY.noSubcommand,
    ]

    // Not a vacuous pass: the frames are non-empty sentences, and none of them
    // says the word.
    for (const frame of frames) {
      expect(frame.length).toBeGreaterThan(0)
      expect(frame).not.toContain('PLACEHOLDER')
    }

    // And the whole record, including the strings Discord is registered with,
    // so a description or a subcommand name cannot carry it either.
    for (const [key, value] of Object.entries(COPY)) {
      if (typeof value === 'string') expect(value, key).not.toContain('PLACEHOLDER')
    }
  })

  /**
   * AND IT NEVER REPORTS AN ACKNOWLEDGEMENT. The console answers done or
   * failed — `lib/commandOutcome.ts` exists over there for exactly this — and a
   * reply saying the drain was "requested" or "sent" would be the bot inventing
   * a third outcome the console does not have.
   */
  it('never tells an admin the drain was merely asked for', () => {
    for (const shown of [
      replyForSchedule(SCHEDULED),
      replyForSchedule({ outcome: 'refused', failure: 'refused', detail: 'x', status: 409 }),
      replyForCancel({ outcome: 'cancelled', status: 200 }),
    ]) {
      expect(shown.toLowerCase()).not.toContain('requested')
      expect(shown.toLowerCase()).not.toContain('acknowledged')
    }
  })
})

describe('/drain — a refusal is shown, in the console`s own words', () => {
  /**
   * THE OWNER'S "FAIL IF NO UPDATES ARE AVAILABLE" RULE, ARRIVING AS A 409 WITH
   * A REASON. It is enforced in the route and nowhere else, which is the whole
   * argument for going through the API — and the reason has to reach the admin
   * verbatim, because this bot cannot see what the console looked at.
   */
  it('shows "there is nothing to deploy" exactly as the console said it', async () => {
    const shown = await answerFor(
      relay({ outcome: 'refused', failure: 'refused', detail: NOTHING_TO_DEPLOY, status: 409 }),
    )

    expect(shown).toContain(NOTHING_TO_DEPLOY)
  })

  /** And the other 409, which is the console refusing to stamp over a live window. */
  it('shows "a window is already scheduled" exactly as the console said it', async () => {
    const shown = await answerFor(
      relay({ outcome: 'refused', failure: 'refused', detail: ALREADY, status: 409 }),
    )

    expect(shown).toContain(ALREADY)
  })

  it('shows the cancel route`s refusal too', async () => {
    const reason = 'The deploy has already started. It cannot be cancelled now.'
    const shown = await answerFor(
      relay(SCHEDULED, { outcome: 'refused', failure: 'refused', detail: reason, status: 409 }),
      { subcommand: DRAIN_CANCEL_SUBCOMMAND },
    )

    expect(shown).toContain(reason)
  })

  /**
   * A DOOR REFUSAL IS NOT THE ADMIN'S PROBLEM AND THE REPLY SAYS SO. A stale
   * secret, a route off the allowlist, a call carrying no human, a revoked
   * role: every one of them means `/drain` is broken for everybody until an
   * operator acts, and an admin who is told only "refused" would keep trying.
   */
  it('sends a door refusal to an operator rather than reading as a normal no', async () => {
    const shown = await answerFor(
      relay({ outcome: 'refused', failure: 'denied', detail: 'scope', status: 403 }),
    )

    // The console's own machine code travels with it, so the journal and the
    // reply say which of the four it was.
    expect(shown).toContain('scope')
    expect(shown).toBe(COPY.denied('scope'))
  })

  it('names an unset credential on the console as its own thing', async () => {
    const shown = await answerFor(
      relay({ outcome: 'refused', failure: 'not-configured', detail: 'not-configured', status: 503 }),
    )

    expect(shown).toBe(COPY.notConfigured)
  })

  /**
   * NOTHING IS KNOWN TO HAVE HAPPENED, AND THAT IS WHAT IS SAID. The relay asks
   * exactly once — the route is not idempotent, so a second try would be asking
   * the console to restart the server on the strength of a guess — so the reply
   * is where "run it again" belongs, aimed at a human who can also look at the
   * console.
   */
  it('says nothing is known to have happened when the console did not answer', async () => {
    const shown = await answerFor(
      relay({
        outcome: 'refused',
        failure: 'unreachable',
        detail: 'no answer from the console in 20000ms',
        status: null,
      }),
    )

    expect(shown).toBe(COPY.unreachable('no answer from the console in 20000ms'))
  })

  it('tells the console being up-but-broken from it not answering', async () => {
    const unavailable = await answerFor(
      relay({ outcome: 'refused', failure: 'unavailable', detail: 'store', status: 503 }),
    )

    const unknown = await answerFor(
      relay({ outcome: 'refused', failure: 'unknown', detail: 'a body that is not JSON', status: 502 }),
    )

    expect(unavailable).toBe(COPY.unavailable('store'))
    expect(unknown).toBe(COPY.unknown('a body that is not JSON'))
    expect(unavailable).not.toBe(unknown)
  })
})

describe('/drain — through runCommand, the way Discord reaches it', () => {
  /** Deferred before the relay is touched, and deferred ephemeral. */
  it('defers ephemerally and then fills the reply in', async () => {
    const respond = responder()

    await runCommand(invocation(), cfg(), respond, [drainCommand(() => relay())])

    expect(respond.deferred).toEqual([true])
    expect(respond.edited).toHaveLength(1)
    expect(respond.replied).toEqual([])
  })

  /**
   * A REFUSED INVOCATION REACHES NO RELAY AT ALL, which is the gate doing its
   * job one layer above this command. Asserted here because the cost of it
   * failing is not a message somebody did not want.
   */
  it('never reaches the console for a member who may not run it', async () => {
    const fake = relay()
    const respond = responder()

    await runCommand(invocation({ roleIds: [OTHER_ROLE] }), cfg(), respond, [
      drainCommand(() => fake),
    ])

    expect(fake.calls).toEqual([])
    expect(respond.deferred).toEqual([])
    expect(respond.replied[0]?.[1]).toBe(true)
  })

  /**
   * A HANDLER THAT THROWS STILL ANSWERS. Without `runCommand`'s catch the admin
   * is left looking at "The application did not respond" over a game server
   * whose state they now cannot guess at.
   */
  it('answers even when the relay itself comes apart', async () => {
    const respond = responder()

    const broken: Drainer = {
      schedule: () => Promise.reject(new Error('boom')),
      cancel: () => Promise.reject(new Error('boom')),
    }

    await runCommand(invocation(), cfg(), respond, [drainCommand(() => broken)])

    expect(respond.edited).toHaveLength(1)
    expect(respond.edited[0]).toContain('PLACEHOLDER')
    expect(stderr.join('')).toContain('level=error')
  })
})
