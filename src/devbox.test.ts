import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BRANCH_PIN,
  DEPLOY_UNIT,
  deployScript,
  devBoxStatus,
  GAME_UNIT,
  MARKER,
  readMarker,
  reportScript,
  SERVER_USER,
  SRC_DIR,
  startDevBox,
  type CommandLook,
  type DevBoxDeps,
  type Ec2Reach,
  type SsmReach,
} from './devbox.ts'
import { setSink } from './log.ts'

/**
 * The dev box, offline.
 *
 * NO AWS, NO CREDENTIALS AND NO CLOCK. The five calls this module makes arrive
 * through `DevBoxDeps` as two object literals, and the clock and the sleep come
 * in the same way — so a two-hundred-second wall is reached in microseconds and
 * a poll loop that never terminated would fail here rather than hang a deploy.
 *
 * ═══ WHAT THESE CASES ARE ACTUALLY FOR ═══
 *
 * THE FAILURES MATTER MORE THAN THE HAPPY PATH. On the day this ships the
 * likeliest outcome by far is `denied`: the policy that grants
 * `ec2:StartInstances` and `ssm:SendCommand` is not attached to the bot's
 * instance role yet, so the first real `/dev start` gets AWS's refusal and an
 * admin has to be able to read what to do about it.
 *
 * AND THE ONE INVARIANT THAT IS NOT ABOUT WORDING: EVERY CALL GOES TO THE
 * INSTANCE THAT WAS HANDED IN, and src/devbox.ts names no instance at all. The
 * prod game box is an id of the same shape in the same region and the same
 * account, and `systemctl start royale-deploy` there would end every match on it.
 * Two cases below hold that line: one sweeps a whole start and a whole status and
 * asserts nothing was asked about any other instance, and one reads this repo's
 * own source and asserts the only instance id in it is the dev one.
 */

const DEV = 'i-0f79fdfbbe2506dca'
const COMMAND = 'a1b2c3d4-0000-4000-8000-000000000000'
const SHA = 'a1b2c3d'
const BRANCH = 'dev'

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

/** An AWS-shaped exception: the SDK identifies these by `name`, and so does src/devbox.ts. */
function awsError(name: string, message = 'from the fake'): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/** What the fake was asked, in order, with the instance it was asked about. */
interface Asked {
  readonly api: string
  readonly instanceId: string
  readonly commands?: readonly string[]
}

/** One answer, or a throw. An array is consumed one per call and then repeats its last. */
type Answers<T> = readonly (T | Error)[]

/**
 * The marker line the real shell prints, so the parser under test is fed the
 * bytes it will actually see rather than a shape this file invented.
 */
function marked(
  fields: { royale?: string; commit?: string; branch?: string } = {},
): string {
  const royale = fields.royale ?? 'active'
  const commit = fields.commit ?? SHA
  const branch = fields.branch ?? BRANCH

  return `${MARKER} royale=${royale} commit=${commit} branch=${branch}`
}

/** An invocation SSM reports as finished, printing whatever it was given. */
function finished(stdoutText: string, status = 'Success', stderrText = ''): CommandLook {
  return { status, stdout: stdoutText, stderr: stderrText }
}

interface Fake {
  readonly asked: Asked[]
  readonly deps: DevBoxDeps
}

/**
 * The two reaches, plus a clock that only moves when the code under test sleeps.
 *
 * THE CLOCK IS THE SLEEP, WHICH IS WHAT MAKES A WALL TESTABLE AT ALL. Every poll
 * in src/devbox.ts asks the clock, decides, and then sleeps; advancing time by
 * exactly the sleep means a wall of forty with a poll of ten is reached on the
 * fifth ask, deterministically, with no timers and no waiting.
 *
 * AN ANSWER LIST IS CONSUMED ONE PER CALL AND THEN REPEATS ITS LAST, so "stopped,
 * then pending, then running" is three entries and "never gets there" is one.
 */
function fake(
  answers: {
    states?: Answers<string | null>
    describes?: Answers<{ state: string | null } | null>
    pings?: Answers<string | null>
    send?: string | Error
    invocations?: Answers<CommandLook | null>
  } = {},
  over: Partial<DevBoxDeps> = {},
): Fake {
  const asked: Asked[] = []
  let clock = 0

  function at<T>(list: Answers<T> | undefined, index: number, fallback: T): T {
    if (list === undefined || list.length === 0) return fallback

    const answer = list[Math.min(index, list.length - 1)]

    if (answer instanceof Error) throw answer
    return answer as T
  }

  let describes = 0
  let pings = 0
  let invocations = 0

  const ec2: Ec2Reach = {
    describe: (instanceId) => {
      asked.push({ api: 'DescribeInstances', instanceId })

      if (answers.describes !== undefined) {
        return Promise.resolve(at(answers.describes, describes++, { state: 'running' }))
      }

      return Promise.resolve({ state: at(answers.states, describes++, 'running') })
    },

    start: (instanceId) => {
      asked.push({ api: 'StartInstances', instanceId })
      return Promise.resolve()
    },
  }

  const ssm: SsmReach = {
    ping: (instanceId) => {
      asked.push({ api: 'DescribeInstanceInformation', instanceId })
      return Promise.resolve(at(answers.pings, pings++, 'Online'))
    },

    send: (instanceId, commands) => {
      asked.push({ api: 'SendCommand', instanceId, commands })

      if (answers.send instanceof Error) throw answers.send
      return Promise.resolve(answers.send ?? COMMAND)
    },

    invocation: (instanceId, commandId) => {
      asked.push({ api: 'GetCommandInvocation', instanceId })

      // The id every poll asks about is the one the send answered with, which is
      // asserted here rather than in each case: a poll against some other
      // invocation would report a stranger's deploy as this one's.
      expect(commandId).toBe(typeof answers.send === 'string' ? answers.send : COMMAND)

      return Promise.resolve(at(answers.invocations, invocations++, finished(marked())))
    },
  }

  return {
    asked,

    deps: {
      instanceId: DEV,
      ec2,
      ssm,
      now: () => clock,
      sleep: (ms) => {
        clock += ms
        return Promise.resolve()
      },
      pollMs: 10,
      runningWaitMs: 40,
      agentWaitMs: 40,
      deployWaitMs: 40,
      reportWaitMs: 40,
      ...over,
    },
  }
}

/** Which APIs were called, in order, for the assertions that are about sequence. */
function apis(asked: readonly Asked[]): string[] {
  return asked.map((one) => one.api)
}

describe('startDevBox, on a box that is already up', () => {
  it('does not start it again and reports the commit it deployed', async () => {
    const world = fake({ states: ['running'] })

    const result = await startDevBox(world.deps)

    expect(result).toEqual({
      outcome: 'deployed',
      royale: 'active',
      commit: SHA,
      branch: BRANCH,
      commandId: COMMAND,
    })

    // THE ASSERTION THAT MATTERS ON THIS PATH: no StartInstances anywhere. A
    // start of a running box is a call nobody asked for.
    expect(apis(world.asked)).not.toContain('StartInstances')
    expect(apis(world.asked)).toEqual([
      'DescribeInstances',
      'DescribeInstanceInformation',
      'SendCommand',
      'GetCommandInvocation',
    ])
  })

  it('sends the deploy and the reading as one invocation', async () => {
    const world = fake()

    await startDevBox(world.deps)

    const sent = world.asked.find((one) => one.api === 'SendCommand')?.commands ?? []
    const script = sent.join('\n')

    expect(world.asked.filter((one) => one.api === 'SendCommand')).toHaveLength(1)
    expect(script).toContain(`systemctl start ${DEPLOY_UNIT}`)
    expect(script).toContain(`systemctl is-active ${GAME_UNIT}`)
    expect(script).toContain(SRC_DIR)
    expect(script).toContain(BRANCH_PIN)
    expect(script).toContain(MARKER)
  })

  it('says in the journal which commit the box came up on', async () => {
    const world = fake()

    await startDevBox(world.deps)

    // Info, so nothing is posted to #bot-status: an admin asked for exactly this.
    expect(stdout.join('')).toContain('level=info')
    expect(stdout.join('')).toContain(`commit="${SHA}"`)
    expect(stderr.join('')).toBe('')
  })

  it('waits on a box somebody else has just started rather than nudging it', async () => {
    const world = fake({ states: ['pending', 'pending', 'running'] })

    const result = await startDevBox(world.deps)

    expect(result.outcome).toBe('deployed')
    expect(apis(world.asked)).not.toContain('StartInstances')
  })
})

describe('startDevBox, on a box that is off', () => {
  it('starts it, waits for running, waits for the agent, then deploys', async () => {
    const world = fake({
      states: ['stopped', 'stopped', 'running'],
      pings: [null, 'ConnectionLost', 'Online'],
    })

    const result = await startDevBox(world.deps)

    expect(result.outcome).toBe('deployed')

    expect(apis(world.asked)).toEqual([
      'DescribeInstances',
      'StartInstances',
      'DescribeInstances',
      'DescribeInstances',
      'DescribeInstanceInformation',
      'DescribeInstanceInformation',
      'DescribeInstanceInformation',
      'SendCommand',
      'GetCommandInvocation',
    ])

    // Once, not once per poll.
    expect(world.asked.filter((one) => one.api === 'StartInstances')).toHaveLength(1)
  })

  it('gives up when it never reaches running, and sends nothing', async () => {
    const world = fake({ states: ['stopped'] })

    const result = await startDevBox(world.deps)

    expect(result).toEqual({
      outcome: 'failed',
      failure: 'not-running',
      detail: 'the instance was still stopped after 0s',
      commandId: null,
    })

    // NOTHING WAS DEPLOYED, which is the half of this that matters: a box that
    // is not running cannot be asked to do anything, and a SendCommand here
    // would be a deploy aimed at a box in an unknown state.
    expect(apis(world.asked)).not.toContain('SendCommand')
    expect(stderr.join('')).toContain('the dev box did not come up')
    expect(stderr.join('')).toContain('failure="not-running"')
  })

  it('names the wall it waited out', async () => {
    const world = fake({ states: ['stopped'] }, { runningWaitMs: 90_000, pollMs: 30_000 })

    const result = await startDevBox(world.deps)

    expect(result.outcome === 'failed' && result.detail).toBe(
      'the instance was still stopped after 90s',
    )
  })

  it('gives up when the agent never comes online, and sends nothing', async () => {
    const world = fake({ pings: ['ConnectionLost'] })

    const result = await startDevBox(world.deps)

    expect(result).toEqual({
      outcome: 'failed',
      failure: 'agent-offline',
      detail: 'the SSM agent was ConnectionLost after 0s',
      commandId: null,
    })

    expect(apis(world.asked)).not.toContain('SendCommand')
  })

  it('reports an agent that never registered as an absence rather than a state', async () => {
    const world = fake({ pings: [null] })

    const result = await startDevBox(world.deps)

    expect(result.outcome === 'failed' && result.detail).toContain('not registered')
  })
})

describe('startDevBox, when AWS says no', () => {
  /**
   * THE DAY-ONE FAILURE. The policy in infradocs `ops/devbox/iam-bot-devbox.json`
   * is not attached to the bot's instance role yet, so this is what a real
   * `/dev start` does first: everything works until the one call that needs the
   * new permission.
   */
  it('reports a denied SendCommand and never sends a second one', async () => {
    const world = fake({
      send: awsError(
        'AccessDeniedException',
        'User: arn:aws:sts::1:assumed-role/blitz-bot is not authorized to perform: ssm:SendCommand',
      ),
    })

    const result = await startDevBox(world.deps)

    expect(result.outcome).toBe('failed')
    expect(result.outcome === 'failed' && result.failure).toBe('denied')
    expect(result.outcome === 'failed' && result.detail).toContain('SendCommand:')
    expect(result.outcome === 'failed' && result.detail).toContain('ssm:SendCommand')
    expect(result.outcome === 'failed' && result.commandId).toBeNull()

    // NEVER RETRIED. A second deploy landing on top of a failed one is worse
    // than a clear failure, which is the same rule the dev patch runbook pins.
    expect(world.asked.filter((one) => one.api === 'SendCommand')).toHaveLength(1)
    expect(apis(world.asked)).not.toContain('GetCommandInvocation')

    // An operator's fault, so it is loud enough to reach #bot-status.
    expect(stderr.join('')).toContain('failure="denied"')
  })

  it("reports EC2's own word for the same refusal", async () => {
    const world = fake({ states: [awsError('UnauthorizedOperation')] })

    const result = await startDevBox(world.deps)

    expect(result.outcome === 'failed' && result.failure).toBe('denied')
    expect(result.outcome === 'failed' && result.detail).toContain('DescribeInstances:')
  })

  it('tells a missing identity apart from a missing permission', async () => {
    const world = fake({ states: [awsError('CredentialsProviderError')] })

    // Two different afternoons: the role is missing a permission, or the process
    // has no role at all. src/ddb.ts splits them for the same reason.
    expect(await startDevBox(world.deps)).toEqual({
      outcome: 'failed',
      failure: 'credentials',
      detail: 'DescribeInstances: from the fake',
      commandId: null,
    })
  })

  it('reports an id that names nothing in this region', async () => {
    const world = fake({ describes: [null] })

    const result = await startDevBox(world.deps)

    expect(result.outcome === 'failed' && result.failure).toBe('no-such-instance')
    expect(result.outcome === 'failed' && result.detail).toContain(DEV)
  })

  it("reports a state EC2 will not start from, rather than waiting it out", async () => {
    const world = fake({ states: ['stopping'] })

    // The refusal comes from `StartInstances` itself: this module has no stop and
    // no terminate, so there is nothing it could do about it either way.
    const stopping: Ec2Reach = {
      describe: world.deps.ec2.describe,
      start: () => {
        throw awsError('IncorrectInstanceState', 'The instance i-… is not in a state from which it can be started')
      },
    }

    const result = await startDevBox({ ...world.deps, ec2: stopping })

    expect(result.outcome === 'failed' && result.failure).toBe('unstartable')
  })

  it('falls back to a named unknown rather than guessing', async () => {
    const world = fake({ states: [awsError('SomethingNobodyHasSeen', 'the sky fell')] })

    const result = await startDevBox(world.deps)

    expect(result.outcome === 'failed' && result.failure).toBe('error')
    expect(result.outcome === 'failed' && result.detail).toContain('the sky fell')
  })
})

describe('startDevBox, on what the invocation came back with', () => {
  it('reports a command that ended badly, with the unit output and the command id', async () => {
    const world = fake({
      invocations: [finished('', 'Failed', 'deploy.sh: fatal: could not read from remote')],
    })

    const result = await startDevBox(world.deps)

    expect(result).toEqual({
      outcome: 'failed',
      failure: 'command-failed',
      detail: 'the command ended Failed: deploy.sh: fatal: could not read from remote',
      commandId: COMMAND,
    })
  })

  it('flattens a multi-line failure into one line', async () => {
    const world = fake({
      invocations: [finished('', 'Failed', 'first line\nsecond line\n\nthird')],
    })

    const result = await startDevBox(world.deps)

    // The detail ends up in a Discord message, and a borrowed newline is how a
    // one-paragraph reply becomes four lines nobody typed.
    expect(result.outcome === 'failed' && result.detail).not.toContain('\n')
    expect(result.outcome === 'failed' && result.detail).toContain('first line second line third')
  })

  it("quotes stdout when the failure said nothing on stderr", async () => {
    const world = fake({ invocations: [finished('it went wrong', 'TimedOut')] })

    const result = await startDevBox(world.deps)

    expect(result.outcome === 'failed' && result.detail).toBe(
      'the command ended TimedOut: it went wrong',
    )
  })

  it('says the deploy ran when its result could not be read, and names the command id', async () => {
    const world = fake({ invocations: [finished('Job for royale-deploy.service started')] })

    const result = await startDevBox(world.deps)

    expect(result).toEqual({
      outcome: 'failed',
      failure: 'unreadable',
      detail: 'the command printed no readable result line',
      commandId: COMMAND,
    })
  })

  it('treats a marker with an empty field as unreadable rather than as an empty commit', async () => {
    const world = fake({ invocations: [finished(marked({ commit: '' }))] })

    const result = await startDevBox(world.deps)

    expect(result.outcome === 'failed' && result.failure).toBe('unreadable')
    expect(result.outcome === 'failed' && result.commandId).toBe(COMMAND)
  })

  it('waits out an invocation SSM has not got yet', async () => {
    const world = fake({
      invocations: [awsError('InvocationDoesNotExist'), { status: 'InProgress', stdout: '', stderr: '' }, finished(marked())],
    })

    const result = await startDevBox(world.deps)

    expect(result.outcome).toBe('deployed')
    expect(world.asked.filter((one) => one.api === 'GetCommandInvocation')).toHaveLength(3)
  })

  it('reports a command still running at the wall, with the id to look it up by', async () => {
    const world = fake({ invocations: [{ status: 'InProgress', stdout: '', stderr: '' }] })

    const result = await startDevBox(world.deps)

    expect(result).toEqual({
      outcome: 'failed',
      failure: 'command-unfinished',
      detail: 'the command was still InProgress after 0s',
      commandId: COMMAND,
    })
  })

  it('reports the game server as the word systemctl gave rather than as a boolean', async () => {
    const world = fake({ invocations: [finished(marked({ royale: 'failed' }))] })

    const result = await startDevBox(world.deps)

    expect(result).toEqual({
      outcome: 'deployed',
      royale: 'failed',
      commit: SHA,
      branch: BRANCH,
      commandId: COMMAND,
    })
  })
})

describe('devBoxStatus', () => {
  it('reports a stopped box and asks SSM nothing at all', async () => {
    const world = fake({ states: ['stopped'] })

    const result = await devBoxStatus(world.deps)

    expect(result).toEqual({
      outcome: 'read',
      state: 'stopped',
      agent: null,
      royale: null,
      commit: null,
      branch: null,
      commandId: null,
    })

    // READ-ONLY, AND IT STOPS AT WHAT IT FINDS. No start, and no waiting five
    // minutes for an agent on a box nobody asked to start.
    expect(apis(world.asked)).toEqual(['DescribeInstances'])
  })

  it('reports an agent that is not online and sends nothing', async () => {
    const world = fake({ pings: ['ConnectionLost'] })

    const result = await devBoxStatus(world.deps)

    expect(result).toEqual({
      outcome: 'read',
      state: 'running',
      agent: 'ConnectionLost',
      royale: null,
      commit: null,
      branch: null,
      commandId: null,
    })

    expect(apis(world.asked)).toEqual(['DescribeInstances', 'DescribeInstanceInformation'])
  })

  it('reports all four facts off a running box', async () => {
    const world = fake()

    const result = await devBoxStatus(world.deps)

    expect(result).toEqual({
      outcome: 'read',
      state: 'running',
      agent: 'Online',
      royale: 'active',
      commit: SHA,
      branch: BRANCH,
      commandId: COMMAND,
    })
  })

  it('never deploys anything', async () => {
    const world = fake()

    await devBoxStatus(world.deps)

    const sent = world.asked.find((one) => one.api === 'SendCommand')?.commands ?? []

    expect(sent.join('\n')).not.toContain(DEPLOY_UNIT)
    expect(sent.join('\n')).toContain(`systemctl is-active ${GAME_UNIT}`)
  })

  it('reports a refusal as a failure rather than as a box with nothing to say', async () => {
    const world = fake({ send: awsError('AccessDeniedException') })

    const result = await devBoxStatus(world.deps)

    expect(result.outcome === 'failed' && result.failure).toBe('denied')
  })
})

describe('the instance it acts on', () => {
  /**
   * THE LINE THIS WHOLE FILE EXISTS TO HOLD. Every call carries the instance that
   * was handed in and no call carries anything else — so a `/dev` pointed at the
   * dev box cannot reach the prod game box through any path here, including the
   * ones that run after a start and a poll.
   */
  it('asks about nothing but the instance it was given', async () => {
    const start = fake({ states: ['stopped', 'running'], pings: [null, 'Online'] })
    const status = fake()

    await startDevBox(start.deps)
    await devBoxStatus(status.deps)

    const everything = [...start.asked, ...status.asked]

    // Not a vacuous pass on a run that made no calls.
    expect(everything.length).toBeGreaterThan(8)
    expect([...new Set(everything.map((one) => one.instanceId))]).toEqual([DEV])
  })

  /**
   * AND THE SOURCE NAMES NO INSTANCE AT ALL. src/devbox.ts takes the id from
   * `DevBoxDeps` precisely so that no literal in it can be the wrong box; the
   * only id in this repo is src/config.ts's dev default.
   *
   * THE PATTERN IS ASSERTED RATHER THAN THE PROD ID, deliberately. A test that
   * named the prod instance id in order to check for its absence would be putting
   * that id in this repo, which is the thing being prevented — and asserting that
   * the ONLY id anywhere is the dev one is the stronger claim anyway.
   */
  it('names no instance id in the module and only the dev one in the repo', () => {
    const source = readFileSync(new URL('./devbox.ts', import.meta.url), 'utf8')
    const config = readFileSync(new URL('./config.ts', import.meta.url), 'utf8')

    const ids = (text: string): string[] => [...text.matchAll(/\bi-[0-9a-f]{8,17}\b/gu)].map((m) => m[0])

    expect(ids(source)).toEqual([])
    expect([...new Set(ids(config))]).toEqual([DEV])
  })
})

describe('the shell the box is sent', () => {
  it('fails the invocation when the deploy fails, rather than reading a commit anyway', () => {
    const script = deployScript().join('\n')

    // `set -eu` is what makes a failed `systemctl start` end the script before
    // the marker is printed, which is what turns a failed deploy into a failed
    // invocation instead of a commit read off a tree that was not updated.
    expect(deployScript()[0]).toBe('set -eu')
    expect(script.indexOf(`systemctl start ${DEPLOY_UNIT}`)).toBeLessThan(script.indexOf(MARKER))
  })

  it('keeps the deploy out of the output the commit is read from', () => {
    // SSM returns the first 2500 characters of stdout, so a chatty deploy could
    // push the marker line off the end of the only place the commit comes from.
    expect(deployScript().join('\n')).toContain(`systemctl start ${DEPLOY_UNIT} >/dev/null`)
  })

  it('guards every reading so a missing file is an empty field and not a dead script', () => {
    for (const line of reportScript().filter((one) => one.includes('$('))) {
      expect(line).toContain('|| true')
    }
  })

  it('is the deploy script without the deploy', () => {
    expect(reportScript()).toEqual(deployScript().filter((one) => !one.includes(DEPLOY_UNIT)))
  })

  it('reads the commit as the user who owns the tree, not as root', () => {
    // FOUND IN REVIEW, AND IT WOULD HAVE FAILED ON EVERY SINGLE RUN.
    // AWS-RunShellScript runs as root; .gamemode-src is owned by SERVER_USER;
    // git refuses a repository owned by somebody else ("detected dubious
    // ownership"). The `|| true` would have swallowed it, so every post would
    // have said the deploy could not be read, for deploys that worked.
    //
    // royale-deploy.service in the gamemode repo records the same failure
    // against the same clone, and answers it the same way.
    const commit = reportScript().find((line) => line.includes('rev-parse'))

    expect(commit).toContain(`runuser -u ${SERVER_USER} -- git -C ${SRC_DIR}`)
    expect(commit).not.toMatch(/(?<!-- )git -C/)
  })
})

describe('readMarker', () => {
  it('reads the three fields', () => {
    expect(readMarker(marked())).toEqual({ royale: 'active', commit: SHA, branch: BRANCH })
  })

  it('is null when there is no marker line', () => {
    expect(readMarker('')).toBeNull()
    expect(readMarker('Job for royale-deploy.service failed')).toBeNull()
  })

  it('ignores everything around it, on either side', () => {
    const noise = `syncing\n${MARKER} was asked for\n${marked()}\ndone\n`

    expect(readMarker(noise)).toEqual({ royale: 'active', commit: SHA, branch: BRANCH })
  })

  it('takes the last marker line, so an echoed one cannot be read as the answer', () => {
    const twice = `${marked({ commit: 'old1234' })}\n${marked({ commit: 'new5678' })}`

    expect(readMarker(twice)?.commit).toBe('new5678')
  })

  it('reads an empty field as absent rather than as a value', () => {
    expect(readMarker(marked({ commit: '', branch: '' }))).toEqual({
      royale: 'active',
      commit: null,
      branch: null,
    })
  })

  it('survives a line whose fields arrived in another order or with extra ones', () => {
    expect(readMarker(`${MARKER} branch=main extra=1 commit=abc1234 royale=inactive`)).toEqual({
      royale: 'inactive',
      commit: 'abc1234',
      branch: 'main',
    })
  })

  it('reads a carriage return as the end of the line', () => {
    expect(readMarker(`${marked()}\r\n`)?.branch).toBe(BRANCH)
  })
})
