import { ApplicationCommandOptionType } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Config } from '../config.ts'
import type { DevBoxDeps, DevBoxFailure, DevBoxStart, DevBoxStatus } from '../devbox.ts'
import { setSink } from '../log.ts'
import { COPY as COMMAND_COPY, refusalFor, runCommand, type Invocation, type Responder } from './command.ts'
import {
  COPY,
  devCommand,
  DEV_START_SUBCOMMAND,
  DEV_STATUS_SUBCOMMAND,
  devNotice,
  lazyDevBox,
  replyForStart,
  replyForStatus,
  setDevNotice,
  type DevFields,
  type DevNotice,
} from './dev.ts'

/**
 * `/dev`, offline.
 *
 * WHAT IS TESTED HERE IS WHAT AN ADMIN IS TOLD AND WHERE IT IS SAID. Every AWS
 * concern lives in ../devbox.ts and is exercised in ../devbox.test.ts against
 * injected clients; this file's cases are about the gate, the two halves, the one
 * start at a time, and the fact that the RESULT goes to a channel rather than to
 * an interaction that will have expired.
 *
 * THE LAST OF THOSE IS THE ONE THAT CANNOT BE CAUGHT ANY OTHER WAY. A deploy that
 * takes sixteen minutes is a deploy whose `editReply` fails with `Unknown
 * Webhook`, leaving an admin looking at a spinner and no way to find out whether
 * a game box was deployed to. A test that only checked the words would pass on a
 * build that did exactly that, so the assertions below are about which of the two
 * routes carried which sentence.
 */

const GUILD = '111111111111111111'
const ADMIN_ROLE = '222222222222222222'
const OTHER_ROLE = '333333333333333333'
const MEMBER = '444444444444444444'
const CHANNEL = '555555555555555555'

const DEV = 'i-0f79fdfbbe2506dca'
const COMMAND = 'a1b2c3d4-0000-4000-8000-000000000000'
const SHA = 'a1b2c3d'

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

  // Both are module state: the sink in ../log.ts, the notice in ./dev.ts. A test
  // that left either standing would decide the next one's result.
  setSink(null)
  setDevNotice(null)
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
    accessRoleId: '1542596402180530257',
    rulesChannelId: '1542595815833604176',
    devInstanceId: DEV,
    devRegion: 'us-east-2',
    ...over,
  }
}

/** An invocation as `invocationOf` builds one, plus the field this command reads. */
function invocation(over: Partial<Invocation & DevFields> = {}): Invocation & DevFields {
  return {
    commandName: 'dev',
    guildId: GUILD,
    userId: MEMBER,
    roleIds: [ADMIN_ROLE],
    targetId: null,
    channelId: CHANNEL,
    text: null,
    subcommand: DEV_START_SUBCOMMAND,
    ...over,
  }
}

/**
 * The two good outcomes, typed as the branch they are rather than as the union.
 *
 * SO THAT `{ ...DEPLOYED, royale: 'failed' }` STILL TYPE-CHECKS. A spread of a
 * union-typed value is a union, and a union with `royale` on one side of it is not
 * assignable back to the parameter — which is a compile error in a test rather
 * than anything about the code under test.
 */
const DEPLOYED: Extract<DevBoxStart, { outcome: 'deployed' }> = {
  outcome: 'deployed',
  royale: 'active',
  commit: SHA,
  branch: 'dev',
  commandId: COMMAND,
}

const READ: Extract<DevBoxStatus, { outcome: 'read' }> = {
  outcome: 'read',
  state: 'running',
  agent: 'Online',
  royale: 'active',
  commit: SHA,
  branch: 'dev',
  commandId: COMMAND,
}

/** What was posted to the channel, and to whom. */
interface Posted {
  readonly channelId: string
  readonly userId: string
  readonly text: string
}

function notices(fail = false): { posts: Posted[]; notice: DevNotice } {
  const posts: Posted[] = []

  return {
    posts,

    notice: {
      post: (channelId, userId, text) => {
        posts.push({ channelId, userId, text })

        return fail ? Promise.reject(new Error('the channel is gone')) : Promise.resolve()
      },
    },
  }
}

/**
 * The AWS side, as the two functions ../devbox.ts exports would have answered.
 *
 * A DEPS OBJECT IS STILL HANDED OVER so the wiring is exercised: the command asks
 * `devBoxFor(config)` for one per invocation, and what is asserted below is that
 * the instance it carries came out of the config rather than from anywhere else.
 */
function awsFor(deps: DevBoxDeps[]): (config: Config) => DevBoxDeps {
  return (config) => {
    const built = {
      instanceId: config.devInstanceId,
      ec2: {
        describe: () => Promise.resolve({ state: 'running' }),
        start: () => Promise.resolve(),
      },
      ssm: {
        ping: () => Promise.resolve('Online'),
        send: () => Promise.resolve(COMMAND),
        invocation: () => Promise.resolve(null),
      },
    }

    deps.push(built)
    return built
  }
}

/**
 * `/dev` with ../devbox.ts's two calls replaced.
 *
 * MOCKED AT THE MODULE BOUNDARY, which is the one place in this repo where that is
 * the right tool: the command's contract with ../devbox.ts is "call it once and
 * report what it answers", and the alternative — a fourth injection point on the
 * factory — would exist only for this test. Every branch INSIDE those two
 * functions is covered in ../devbox.test.ts against injected clients.
 */
vi.mock('../devbox.ts', async (original) => {
  const real = await original<typeof import('../devbox.ts')>()

  return { ...real, startDevBox: vi.fn(), devBoxStatus: vi.fn(), createDevBoxReach: vi.fn() }
})

const { startDevBox, devBoxStatus, createDevBoxReach } = await import('../devbox.ts')

const starts = vi.mocked(startDevBox)
const statuses = vi.mocked(devBoxStatus)
const reaches = vi.mocked(createDevBoxReach)

beforeEach(() => {
  starts.mockReset()
  statuses.mockReset()
  reaches.mockReset()
  starts.mockResolvedValue(DEPLOYED)
  statuses.mockResolvedValue(READ)
})

/** A responder that writes down what it was asked to say, as ./command.ts's is. */
function responder(): { said: string[]; deferred: boolean[]; respond: Responder } {
  const said: string[] = []
  const deferred: boolean[] = []

  return {
    said,
    deferred,

    respond: {
      defer: (onlyInvoker) => {
        deferred.push(onlyInvoker)
        return Promise.resolve()
      },
      edit: (reply) => {
        said.push(typeof reply === 'string' ? reply : JSON.stringify(reply))
        return Promise.resolve()
      },
      reply: (content) => {
        said.push(content)
        return Promise.resolve()
      },
    },
  }
}

/** The in-flight work is started and not awaited, so a case has to let it land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('/dev start', () => {
  it('acks at once and posts the result in the channel, mentioning whoever asked', async () => {
    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)

    const ack = await dev.run(invocation(), cfg())
    await settle()

    // THE ACK IS THE REPLY AND THE RESULT IS NOT. An interaction token dies after
    // fifteen minutes and a cold start plus a deploy can get close.
    expect(ack).toBe(COPY.starting)

    expect(channel.posts).toEqual([
      {
        channelId: CHANNEL,
        userId: MEMBER,
        text: `<@${MEMBER}> dev is up on ${SHA} (dev)`,
      },
    ])
  })

  it('carries the requester separately so the send can allow exactly them', async () => {
    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)

    await dev.run(invocation(), cfg())
    await settle()

    // `liveDevNotice` in ./index.ts narrows `allowedMentions` to this id: the
    // mention is the point, and allowing the text to decide who gets notified is
    // how an `@everyone` in a borrowed string reaches a guild.
    expect(channel.posts.at(0)?.userId).toBe(MEMBER)
    expect(channel.posts.at(0)?.text.startsWith(`<@${MEMBER}> `)).toBe(true)
  })

  it('answers the interaction with the ack and nothing else, ever', async () => {
    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)
    const said = responder()

    await runCommand(invocation(), cfg(), said.respond, [dev])
    await settle()

    // One sentence through the interaction, and it is not the result. A build
    // that reported the deploy here would work in a test and fail in production
    // on exactly the deploys that took longest.
    expect(said.said).toEqual([COPY.starting])
    expect(said.said.join('')).not.toContain(SHA)
    expect(channel.posts.at(0)?.text).toContain(SHA)
  })

  it('is deferred ephemerally', async () => {
    const channel = notices()
    const said = responder()

    await runCommand(invocation(), cfg(), said.respond, [devCommand(awsFor([]), () => channel.notice)])
    await settle()

    expect(said.deferred).toEqual([true])
  })

  it('acts on the instance the config names', async () => {
    const built: DevBoxDeps[] = []
    const channel = notices()
    const dev = devCommand(awsFor(built), () => channel.notice)

    await dev.run(invocation(), cfg({ devInstanceId: 'i-0aaaaaaaaaaaaaaaa' }))
    await settle()

    expect(built.map((one) => one.instanceId)).toEqual(['i-0aaaaaaaaaaaaaaaa'])
  })

  it('reports a deploy that finished over a game server that did not come back', async () => {
    starts.mockResolvedValue({ ...DEPLOYED, royale: 'failed' })

    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)

    await dev.run(invocation(), cfg())
    await settle()

    expect(channel.posts.at(0)?.text).toBe(
      `<@${MEMBER}> dev deployed ${SHA} (dev) and royale is failed.`,
    )
  })

  it('does not start a second one while the first is still going', async () => {
    let finish = (): void => {}
    starts.mockReturnValue(
      new Promise<DevBoxStart>((resolve) => {
        finish = () => {
          resolve(DEPLOYED)
        }
      }),
    )

    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)

    expect(await dev.run(invocation(), cfg())).toBe(COPY.starting)

    // THE SECOND ONE IS REFUSED AND NOTHING IS SENT. The first deploy is blocking
    // on a git sync; a second landing on top of it is how a half-synced tree gets
    // restarted into.
    expect(await dev.run(invocation(), cfg())).toBe(COPY.alreadyStarting)
    expect(starts).toHaveBeenCalledTimes(1)
    expect(channel.posts).toEqual([])

    finish()
    await settle()

    expect(channel.posts).toHaveLength(1)
  })

  it('lets the next one through once that one has landed', async () => {
    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)

    await dev.run(invocation(), cfg())
    await settle()

    expect(await dev.run(invocation(), cfg())).toBe(COPY.starting)
    await settle()

    expect(starts).toHaveBeenCalledTimes(2)
    expect(channel.posts).toHaveLength(2)
  })

  it('lets the next one through even when the last one threw', async () => {
    starts.mockRejectedValueOnce(new Error('the sky fell'))

    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)

    await dev.run(invocation(), cfg())
    await settle()

    expect(stderr.join('')).toContain('the dev box start could not be reported')
    expect(await dev.run(invocation(), cfg())).toBe(COPY.starting)
  })

  it('journals a result it could not post rather than losing the process', async () => {
    const channel = notices(true)
    const dev = devCommand(awsFor([]), () => channel.notice)

    await dev.run(invocation(), cfg())
    await settle()

    // There is no interaction left to answer on by the time this happens, so the
    // journal is the only place it can be said.
    expect(channel.posts).toHaveLength(1)
    expect(stderr.join('')).toContain('the dev box start could not be reported')
    expect(stderr.join('')).toContain(`channel="${CHANNEL}"`)
  })

  it('starts nothing when there is nowhere to post the result', async () => {
    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)

    expect(await dev.run(invocation({ channelId: null }), cfg())).toBe(COPY.noChannel)
    expect(starts).not.toHaveBeenCalled()
  })

  it('starts nothing when no notice has been installed', async () => {
    const dev = devCommand(awsFor([]), () => null)

    expect(await dev.run(invocation(), cfg())).toBe(COPY.unavailable)
    expect(starts).not.toHaveBeenCalled()
  })

  it('starts nothing when it cannot tell which half was meant', async () => {
    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)

    for (const subcommand of [null, '', 'restart']) {
      expect(await dev.run(invocation({ subcommand }), cfg())).toBe(COPY.noSubcommand)
    }

    expect(starts).not.toHaveBeenCalled()
    expect(statuses).not.toHaveBeenCalled()
  })
})

describe('/dev status', () => {
  it('answers through the interaction, because it is seconds rather than minutes', async () => {
    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)
    const said = responder()

    await runCommand(invocation({ subcommand: DEV_STATUS_SUBCOMMAND }), cfg(), said.respond, [dev])
    await settle()

    expect(said.said).toEqual([`dev is running, the agent is Online, royale is active, on ${SHA} (dev)`])
    expect(channel.posts).toEqual([])
  })

  it('changes nothing', async () => {
    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)

    await dev.run(invocation({ subcommand: DEV_STATUS_SUBCOMMAND }), cfg())

    expect(starts).not.toHaveBeenCalled()
    expect(statuses).toHaveBeenCalledTimes(1)
  })

  it('needs no channel and no notice, because it answers where it was asked', async () => {
    const dev = devCommand(awsFor([]), () => null)

    expect(await dev.run(invocation({ subcommand: DEV_STATUS_SUBCOMMAND, channelId: null }), cfg())).toBe(
      `dev is running, the agent is Online, royale is active, on ${SHA} (dev)`,
    )
  })

  it('says what a stopped box has to say and no more', () => {
    expect(
      replyForStatus({
        outcome: 'read',
        state: 'stopped',
        agent: null,
        royale: null,
        commit: null,
        branch: null,
        commandId: null,
      }),
    ).toBe('dev is stopped')
  })

  it('names an agent that is not online without inventing the rest', () => {
    expect(
      replyForStatus({
        outcome: 'read',
        state: 'running',
        agent: 'ConnectionLost',
        royale: null,
        commit: null,
        branch: null,
        commandId: null,
      }),
    ).toBe('dev is running, the agent is ConnectionLost')
  })
})

describe('the gate', () => {
  /**
   * ADMIN-ONLY, UNCONDITIONALLY, AND THE REFUSAL COMES FROM `refusalFor`. One
   * half starts a game box and deploys onto it; there is no invocation of this
   * command that answers about the caller.
   */
  it('refuses a member who does not hold the admin role, and starts nothing', async () => {
    const channel = notices()
    const dev = devCommand(awsFor([]), () => channel.notice)
    const said = responder()

    await runCommand(invocation({ roleIds: [OTHER_ROLE] }), cfg(), said.respond, [dev])
    await settle()

    expect(said.said).toEqual([COMMAND_COPY.refused])
    expect(said.deferred).toEqual([])
    expect(starts).not.toHaveBeenCalled()
    expect(channel.posts).toEqual([])
  })

  it('refuses the same way when the role is unset, the payload has no member, or there is no guild', () => {
    const dev = devCommand(awsFor([]))

    expect(refusalFor(dev, invocation(), cfg({ adminRoleId: null }))).toBe('admin-role-unset')
    expect(refusalFor(dev, invocation({ roleIds: null }), cfg())).toBe('roles-unreadable')
    expect(refusalFor(dev, invocation({ guildId: null }), cfg())).toBe('not-in-guild')
    expect(refusalFor(dev, invocation(), cfg())).toBeNull()
  })

  it('is hidden in the client as well as gated', () => {
    expect(devCommand(awsFor([])).adminOnly).toBe(true)
    expect(devCommand(awsFor([])).onlyInvoker(invocation())).toBe(true)
  })
})

describe('what Discord is told', () => {
  it('registers the two halves under the names this file declares', () => {
    const data = devCommand(awsFor([])).data

    expect(data.name).toBe('dev')
    expect(data.options?.map((one) => one.name)).toEqual([
      DEV_START_SUBCOMMAND,
      DEV_STATUS_SUBCOMMAND,
    ])

    for (const option of data.options ?? []) {
      expect(option.type).toBe(ApplicationCommandOptionType.Subcommand)
      expect(option.description.length).toBeGreaterThan(0)
    }
  })

  it('takes no options, so there is nothing to point at the wrong box', () => {
    for (const option of devCommand(awsFor([])).data.options ?? []) {
      expect('options' in option ? option.options : undefined).toBeUndefined()
    }
  })
})

/**
 * EVERY STRING THIS COMMAND CAN PUT IN FRONT OF AN ADMIN, in one list.
 *
 * THE WHOLE-REPLY RULES ARE ASSERTED OVER THIS AND NOT OVER THE HAPPY PATH, which
 * is ./drain.test.ts's argument and its history: the four faults that reached the
 * owner reached him through the one branch somebody had looked at. A rule checked
 * on one frame is a rule every other frame is exempt from.
 */
function everyFrame(): string[] {
  const failures: DevBoxFailure[] = [
    'denied',
    'credentials',
    'no-such-instance',
    'unstartable',
    'not-running',
    'agent-offline',
    'command-failed',
    'command-unfinished',
    'unreadable',
    'error',
  ]

  return [
    replyForStart(DEPLOYED),
    replyForStart({ ...DEPLOYED, royale: 'inactive' }),
    replyForStatus(READ),
    replyForStatus({ ...READ, state: 'stopped', agent: null, royale: null, commit: null, branch: null }),

    ...failures.flatMap((failure) => [
      replyForStart({ outcome: 'failed', failure, detail: 'AWS said something', commandId: COMMAND }),
      replyForStatus({ outcome: 'failed', failure, detail: 'AWS said something', commandId: COMMAND }),
    ]),

    COPY.starting,
    COPY.alreadyStarting,
    COPY.noSubcommand,
    COPY.noChannel,
    COPY.unavailable,
  ]
}

describe('every reply', () => {
  it('is one paragraph', () => {
    for (const frame of everyFrame()) {
      expect(frame, frame).not.toContain('\n')
      expect(frame.length).toBeGreaterThan(0)
    }
  })

  it('carries no marker, retired or current', () => {
    for (const frame of everyFrame()) {
      expect(frame, frame).not.toContain('PLACEHOLDER')
      expect(frame, frame).not.toContain('unwritten')
    }
  })

  /**
   * THE DETAIL ENDS EVERY FAILURE THAT QUOTES ONE, AND THE FULL STOP IS ADDED
   * ONLY WHERE AWS DID NOT BRING ITS OWN. ./drain.ts's `ended`, for the same
   * reason: a frame that always appends one puts a period after somebody else's
   * sentence, and one that never does ships an unfinished sentence.
   */
  it('finishes a borrowed sentence exactly once', () => {
    const quoted = (detail: string): string =>
      replyForStart({ outcome: 'failed', failure: 'denied', detail, commandId: null })

    expect(quoted('AWS refused it')).toContain('AWS refused it. An operator')
    expect(quoted('AWS refused it.')).toContain('AWS refused it. An operator')
    expect(quoted('AWS refused it!')).toContain('AWS refused it! An operator')
    expect(quoted('AWS refused it   ')).toContain('AWS refused it. An operator')
  })

  it('names the command id on every failure that has one to name', () => {
    for (const failure of ['command-unfinished', 'unreadable'] as const) {
      expect(
        replyForStart({ outcome: 'failed', failure, detail: 'it was still going', commandId: COMMAND }),
      ).toContain(COMMAND)
    }
  })

  it('says the deploy ran when only the reading of it failed', () => {
    const said = replyForStart({
      outcome: 'failed',
      failure: 'unreadable',
      detail: 'the command printed no readable result line',
      commandId: COMMAND,
    })

    // Reporting this as a deploy that did not happen would send somebody to start
    // another one on a box that has already been deployed to.
    expect(said).toContain('ran')
    expect(said).not.toContain('did not start')
  })

  it('sends the four an operator has to fix to an operator', () => {
    for (const failure of ['denied', 'credentials', 'no-such-instance', 'unstartable'] as const) {
      expect(
        replyForStart({ outcome: 'failed', failure, detail: 'AWS said no', commandId: null }),
      ).toContain('An operator has to look at this.')
    }
  })

  it('says which half failed', () => {
    const start = replyForStart({ outcome: 'failed', failure: 'error', detail: 'x', commandId: null })
    const status = replyForStatus({ outcome: 'failed', failure: 'error', detail: 'x', commandId: null })

    expect(start).toContain(COPY.startLead)
    expect(status).toContain(COPY.statusLead)
  })

  /** The line the whole feature exists to produce, exactly as the issue worded it. */
  it('is the issue own words on the path that worked', () => {
    expect(replyForStart(DEPLOYED)).toBe(`dev is up on ${SHA} (dev)`)
  })
})

describe('the notice seam', () => {
  it('is null until something installs one', () => {
    expect(devNotice()).toBeNull()
  })

  it('is what the command reaches for by default', async () => {
    const channel = notices()
    const dev = devCommand(awsFor([]))

    setDevNotice(channel.notice)

    await dev.run(invocation(), cfg())
    await settle()

    expect(channel.posts).toHaveLength(1)
  })
})

describe('lazyDevBox', () => {
  /**
   * THE ONE PLACE THE INSTANCE ID CROSSES FROM CONFIGURATION INTO THE AWS CALLS,
   * which is why it is asserted rather than assumed: ../devbox.ts holds no
   * instance id of its own, so whatever this function puts on the deps is the box
   * that gets deployed to.
   *
   * `createDevBoxReach` IS MOCKED IN THIS FILE, so no SDK client is built here.
   */
  it('passes the configured instance through on every call', () => {
    reaches.mockReturnValue({
      ec2: { describe: () => Promise.resolve(null), start: () => Promise.resolve() },
      ssm: {
        ping: () => Promise.resolve(null),
        send: () => Promise.resolve(COMMAND),
        invocation: () => Promise.resolve(null),
      },
    })

    const forConfig = lazyDevBox()

    expect(forConfig(cfg()).instanceId).toBe(DEV)
    expect(forConfig(cfg({ devInstanceId: 'i-0bbbbbbbbbbbbbbbb' })).instanceId).toBe(
      'i-0bbbbbbbbbbbbbbbb',
    )

    // ONE PAIR OF CLIENTS FOR THE LIFE OF THE PROCESS, and the instance read
    // fresh from the config every time: a cached reach must never be able to
    // cache a box with it.
    expect(reaches).toHaveBeenCalledTimes(1)
  })
})
