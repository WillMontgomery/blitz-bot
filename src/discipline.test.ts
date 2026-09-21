import { describe, expect, it, vi } from 'vitest'

import {
  BAN_ESCALATION_WINDOW_MS,
  createDiscipline,
  ddbDisciplineStore,
  DISCIPLINE_ACCESS_REASON,
  DISCIPLINE_BAN_REASON,
  DISCIPLINE_STATE_PREFIX,
  DISCIPLINE_TIMEOUT_REASON,
  discordDisciplineActions,
  memoryDisciplineStore,
  parseDisciplineState,
  RAPID_OFFENSE_WINDOW_MS,
  RAPID_TIMEOUT_MS,
  renderDisciplineState,
  type AccessReset,
  type DisciplineActions,
  type DisciplineOffense,
  type DisciplineStore,
  type DisciplineTiming,
  type DurableDisciplineState,
} from './discipline.ts'
import type { Config } from './config.ts'
import { ACCESS_ROLE_PROBLEM } from './rules.ts'
import type { Client } from 'discord.js'

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'
const USER = '333333333333333333'
const ROLE = '444444444444444444'
const ADMIN_ROLE = '555555555555555555'
const RULES = '666666666666666666'
const COMMUNITY_RULES = '777777777777777777'
const OTHER_ACCESS = '888888888888888888'

function offense(messageId: string, over: Partial<DisciplineOffense> = {}): DisciplineOffense {
  return {
    messageId,
    userId: USER,
    channelId: CHANNEL,
    reason: 'foreign-ip',
    webhookId: null,
    fromBot: false,
    isOwner: false,
    administrator: false,
    ...over,
  }
}

interface World {
  at(value: number): void
  desk: ReturnType<typeof createDiscipline>
  timedOut: string[]
  reset: string[]
  banned: string[]
  notified: string[]
  timings: DisciplineTiming[]
  reported: string[]
}

function world(
  over: Partial<DisciplineActions> = {},
  store: DisciplineStore = memoryDisciplineStore(),
): World {
  let now = 1_000_000
  const timedOut: string[] = []
  const reset: string[] = []
  const banned: string[] = []
  const notified: string[] = []
  const timings: DisciplineTiming[] = []
  const reported: string[] = []

  const access: AccessReset = {
    did: 'removed',
    roleId: ROLE,
    rulesChannelId: CHANNEL,
  }

  const actions: DisciplineActions = {
    eligible: () => Promise.resolve(true),
    timeout: (event) => {
      timedOut.push(event.messageId)
      return Promise.resolve()
    },
    resetAccess: async (event, beforeRemove) => {
      await beforeRemove(access.roleId)
      reset.push(event.messageId)
      return access
    },
    ban: (event) => {
      banned.push(event.messageId)
      return Promise.resolve()
    },
    notifyTimeout: (event, _access, timing) => {
      notified.push(event.messageId)
      timings.push(timing)
      return Promise.resolve()
    },
    report: (line) => {
      reported.push(line)
      return Promise.resolve()
    },
    ...over,
  }

  return {
    at(value) {
      now = value
    },
    desk: createDiscipline(actions, { now: () => now, store }),
    timedOut,
    reset,
    banned,
    notified,
    timings,
    reported,
  }
}

describe('rapid-offense escalation', () => {
  it('times out and removes access on the third unique deletion in 60 seconds', async () => {
    const w = world()

    await expect(w.desk.record(offense('m1'))).resolves.toEqual({ did: 'strike', count: 1 })
    await expect(w.desk.record(offense('m2'))).resolves.toEqual({ did: 'strike', count: 2 })
    const third = await w.desk.record(offense('m3'))

    expect(third).toMatchObject({ did: 'timed-out', access: { did: 'removed' } })
    expect(w.timedOut).toEqual(['m3'])
    expect(w.reset).toEqual(['m3'])
    expect(w.notified).toEqual(['m3'])
    expect(w.timings).toEqual([
      {
        timeoutUntil: 1_000_000 + RAPID_TIMEOUT_MS,
        probation: 'after-recovery',
      },
    ])
    expect(w.banned).toEqual([])
  })

  it('starts the one-hour ban window when access is restored', async () => {
    const w = world()

    await w.desk.record(offense('m1'))
    await w.desk.record(offense('m2'))
    await w.desk.record(offense('m3'))
    await expect(w.desk.record(offense('before-recovery'))).resolves.toEqual({
      did: 'restricted',
    })

    w.at(2_000_000)
    await expect(w.desk.startProbation(USER)).resolves.toEqual({
      until: 2_000_000 + BAN_ESCALATION_WINDOW_MS,
      started: true,
    })
    w.at(2_000_000 + BAN_ESCALATION_WINDOW_MS - 1)

    await expect(w.desk.record(offense('m4'))).resolves.toEqual({ did: 'banned' })
    expect(w.banned).toEqual(['m4'])
  })

  it('starts a fresh strike window at the recovery-based one-hour boundary', async () => {
    const w = world()

    await w.desk.record(offense('m1'))
    await w.desk.record(offense('m2'))
    await w.desk.record(offense('m3'))
    w.at(2_000_000)
    await w.desk.startProbation(USER)
    w.at(2_000_000 + BAN_ESCALATION_WINDOW_MS)

    await expect(w.desk.record(offense('m4'))).resolves.toEqual({ did: 'strike', count: 1 })
    expect(w.banned).toEqual([])
  })

  it('starts probation when the removed Rules role is restored by reaction', async () => {
    const w = world()

    await w.desk.record(offense('m1'))
    await w.desk.record(offense('m2'))
    await w.desk.record(offense('m3'))

    await expect(w.desk.startProbationForRole(USER, 'some-other-role')).resolves.toBeNull()
    await expect(w.desk.startProbationForRole(USER, ROLE)).resolves.toEqual({
      until: 1_000_000 + BAN_ESCALATION_WINDOW_MS,
      started: true,
    })
    await expect(w.desk.record(offense('m4'))).resolves.toEqual({ did: 'banned' })
  })

  it('does not extend active probation when the restore event is delivered twice', async () => {
    const w = world()

    const first = await w.desk.startProbation(USER)
    w.at(1_100_000)

    await expect(w.desk.startProbation(USER)).resolves.toEqual({
      until: first.until,
      started: false,
    })
  })

  it('does not count a duplicate delivery of the same message', async () => {
    const w = world()

    await w.desk.record(offense('m1'))
    await expect(w.desk.record(offense('m1'))).resolves.toEqual({ did: 'duplicate' })
    await expect(w.desk.record(offense('m2'))).resolves.toEqual({ did: 'strike', count: 2 })

    expect(w.timedOut).toEqual([])
  })

  it('drops strikes at the 60-second boundary', async () => {
    const w = world()

    await w.desk.record(offense('m1'))
    w.at(1_000_000 + RAPID_OFFENSE_WINDOW_MS)
    await expect(w.desk.record(offense('m2'))).resolves.toEqual({ did: 'strike', count: 1 })
  })

  it('does not remove access or open the ban window when timeout fails', async () => {
    const w = world({
      timeout: () => Promise.reject(new Error('Missing Permissions')),
    })

    await w.desk.record(offense('m1'))
    await w.desk.record(offense('m2'))
    await expect(w.desk.record(offense('m3'))).resolves.toEqual({
      did: 'failed',
      step: 'timeout',
    })

    expect(w.reset).toEqual([])
    expect(w.notified).toEqual([])
    expect(w.banned).toEqual([])
  })

  it('keeps the one-hour escalation active when a ban attempt fails', async () => {
    let attempts = 0
    const w = world({
      ban: () => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error('Missing Permissions'))
          : Promise.resolve()
      },
    })

    await w.desk.record(offense('m1'))
    await w.desk.record(offense('m2'))
    await w.desk.record(offense('m3'))
    await w.desk.startProbation(USER)
    await expect(w.desk.record(offense('m4'))).resolves.toEqual({
      did: 'failed',
      step: 'ban',
    })
    await expect(w.desk.record(offense('m5'))).resolves.toEqual({ did: 'banned' })

    expect(attempts).toBe(2)
  })

  it('keeps the ban window even if the access role cannot be removed', async () => {
    const w = world({
      resetAccess: () => Promise.resolve({ did: 'failed', rulesChannelId: CHANNEL }),
    })

    await w.desk.record(offense('m1'))
    await w.desk.record(offense('m2'))
    await expect(w.desk.record(offense('m3'))).resolves.toMatchObject({
      did: 'timed-out',
      access: { did: 'failed' },
    })
    await expect(w.desk.record(offense('m4'))).resolves.toEqual({ did: 'banned' })
  })

  it('reports when neither the private thread nor its DM fallback can notify the member', async () => {
    const w = world({
      notifyTimeout: () => Promise.reject(new Error('Missing Permissions')),
    })

    await w.desk.record(offense('m1'))
    await w.desk.record(offense('m2'))
    await expect(w.desk.record(offense('m3'))).resolves.toMatchObject({
      did: 'timed-out',
    })

    expect(w.reported).toContain(
      `Rapid-offense notice failed. Could not privately notify <@${USER}> after the timeout.`,
    )
  })

  it('never counts webhooks, bots, owners, or known administrators', async () => {
    const w = world()

    await expect(
      w.desk.record(offense('webhook', { webhookId: '999999999999999999' })),
    ).resolves.toEqual({ did: 'ignored', why: 'webhook' })
    await expect(w.desk.record(offense('bot', { fromBot: true }))).resolves.toEqual({
      did: 'ignored',
      why: 'bot',
    })
    await expect(w.desk.record(offense('owner', { isOwner: true }))).resolves.toEqual({
      did: 'ignored',
      why: 'owner',
    })
    await expect(
      w.desk.record(offense('admin', { administrator: true })),
    ).resolves.toEqual({ did: 'ignored', why: 'administrator' })

    expect(w.desk.remembered()).toBe(0)
  })

  it('skips sanctions when a missing member cannot be proven eligible', async () => {
    const w = world({ eligible: () => Promise.resolve(false) })

    await expect(
      w.desk.record(offense('m1', { administrator: null })),
    ).resolves.toEqual({ did: 'ignored', why: 'unreadable-member' })
    expect(w.desk.remembered()).toBe(0)
  })

  it('does not ban an offense queued before access recovery', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const w = world({
      timeout: async (event) => {
        w.timedOut.push(event.messageId)
        await gate
      },
    })

    await w.desk.record(offense('m1'))
    await w.desk.record(offense('m2'))
    const third = w.desk.record(offense('m3'))
    const fourth = w.desk.record(offense('m4'))

    await vi.waitFor(() => {
      expect(w.timedOut).toEqual(['m3'])
    })
    expect(w.banned).toEqual([])

    release?.()
    await expect(third).resolves.toMatchObject({ did: 'timed-out' })
    await expect(fourth).resolves.toEqual({ did: 'restricted' })
    expect(w.banned).toEqual([])
  })

  it('bounds remembered member state', async () => {
    const w = world()

    for (let i = 0; i < 501; i++) {
      await w.desk.record(
        offense(`m${String(i)}`, { userId: `u${String(i).padStart(3, '0')}` }),
      )
    }

    expect(w.desk.remembered()).toBe(500)
  })

  it('forgives the in-memory window on restart', async () => {
    const first = world()
    await first.desk.record(offense('m1'))
    await first.desk.record(offense('m2'))

    const restarted = world()
    await expect(restarted.desk.record(offense('m3'))).resolves.toEqual({
      did: 'strike',
      count: 1,
    })
  })

  it('keeps awaiting recovery and active probation across separate processes', async () => {
    const store = memoryDisciplineStore()
    const first = world({}, store)

    await first.desk.record(offense('m1'))
    await first.desk.record(offense('m2'))
    await first.desk.record(offense('m3'))
    expect(store.read(USER)).toEqual({
      phase: 'awaiting-recovery',
      roleId: ROLE,
    })

    const awaitingRestart = world({}, store)
    awaitingRestart.at(2_000_000)
    await expect(
      awaitingRestart.desk.record(offense('before-recovery')),
    ).resolves.toEqual({ did: 'restricted' })
    const probation = await awaitingRestart.desk.startProbationForRole(USER, ROLE)
    expect(probation).toEqual({
      until: 2_000_000 + BAN_ESCALATION_WINDOW_MS,
      started: true,
    })
    expect(store.read(USER)).toEqual({
      phase: 'probation',
      until: probation?.until,
    })

    const probationRestart = world({}, store)
    probationRestart.at((probation?.until ?? 0) - 1)
    await expect(
      probationRestart.desk.record(offense('during-probation')),
    ).resolves.toEqual({ did: 'banned' })
    expect(probationRestart.banned).toEqual(['during-probation'])
    expect(store.read(USER)).toBeNull()
  })

  it('persists button-started probation before another process handles an offense', async () => {
    const store = memoryDisciplineStore()
    const buttonProcess = world({}, store)
    buttonProcess.at(3_000_000)

    const probation = await buttonProcess.desk.startProbation(USER)
    expect(store.read(USER)).toEqual({
      phase: 'probation',
      until: probation.until,
    })

    const restarted = world({}, store)
    restarted.at(probation.until - 1)
    await expect(restarted.desk.record(offense('m1'))).resolves.toEqual({
      did: 'banned',
    })
  })

  it('clears expired durable probation before opening a fresh strike window', async () => {
    const store = memoryDisciplineStore({
      [USER]: { phase: 'probation', until: 1_000_000 },
    })
    const restarted = world({}, store)

    await expect(restarted.desk.record(offense('m1'))).resolves.toEqual({
      did: 'strike',
      count: 1,
    })
    expect(store.read(USER)).toBeNull()
    expect(restarted.banned).toEqual([])
  })
})

describe('the durable rapid-offense row', () => {
  const states: readonly (DurableDisciplineState | null)[] = [
    null,
    { phase: 'awaiting-recovery', roleId: ROLE },
    { phase: 'probation', until: 1_800_000_000_000 },
  ]

  it.each(states)('round-trips %j', (state) => {
    expect(parseDisciplineState(renderDisciplineState(state))).toEqual(state)
  })

  it.each([
    'not JSON',
    'null',
    '{}',
    '{"version":2,"phase":"idle"}',
    '{"version":1,"phase":"awaiting-recovery","roleId":""}',
    '{"version":1,"phase":"probation","until":0}',
  ])('rejects malformed state: %s', (value) => {
    expect(() => parseDisciplineState(value)).toThrow()
  })

  it('uses one bot-state point row per member', async () => {
    const durable: DurableDisciplineState = {
      phase: 'probation',
      until: 1_800_000_000_000,
    }
    const key = `${DISCIPLINE_STATE_PREFIX}${USER}`
    const get = vi.fn((asked: string) =>
      Promise.resolve({
        ok: true as const,
        value: {
          id: asked,
          value: renderDisciplineState(durable),
          updatedAt: 1,
        },
      }),
    )
    const put = vi.fn((id: string, value: string) =>
      Promise.resolve({
        ok: true as const,
        value: { id, value, updatedAt: 2 },
      }),
    )
    const store = ddbDisciplineStore({ get, put })

    await expect(store.load(USER)).resolves.toEqual(durable)
    expect(get).toHaveBeenCalledExactlyOnceWith(key)

    await store.save(USER, null)
    expect(put).toHaveBeenCalledExactlyOnceWith(
      key,
      '{"version":1,"phase":"idle"}',
    )
  })

  it('fails an offense closed when durable state cannot be read', async () => {
    const w = world({}, {
      load: () => Promise.reject(new Error('DynamoDB unavailable')),
      save: () => Promise.resolve(),
    })

    await expect(w.desk.record(offense('m1'))).resolves.toEqual({
      did: 'failed',
      step: 'state',
    })
    expect(w.timedOut).toEqual([])
    expect(w.reported).toContain(
      `Rapid-offense state failure. Could not read durable discipline state for <@${USER}>.`,
    )
  })

  it('does not resolve recovery until probation is durable', async () => {
    const store: DisciplineStore = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(new Error('DynamoDB unavailable')),
    }
    const w = world({}, store)

    await expect(w.desk.startProbation(USER)).rejects.toThrow(
      'DynamoDB unavailable',
    )
  })

  it('does not remove access or create volatile probation when state writes fail', async () => {
    const store: DisciplineStore = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(new Error('DynamoDB unavailable')),
    }
    const w = world({}, store)

    await w.desk.record(offense('m1'))
    await w.desk.record(offense('m2'))
    await expect(w.desk.record(offense('m3'))).resolves.toEqual({
      did: 'timed-out',
      access: { did: 'failed', rulesChannelId: null },
    })
    expect(w.reset).toEqual([])
    expect(w.timings).toEqual([
      {
        timeoutUntil: 1_000_000 + RAPID_TIMEOUT_MS,
        probation: 'unavailable',
      },
    ])

    await expect(w.desk.record(offense('m4'))).resolves.toEqual({
      did: 'strike',
      count: 1,
    })
    expect(w.banned).toEqual([])
  })
})

function config(over: Partial<Config> = {}): Config {
  return {
    discordToken: 'token',
    guildId: GUILD,
    adminRoleId: ADMIN_ROLE,
    logChannelId: null,
    statusChannelId: null,
    docsChannelId: null,
    maintenanceChannelId: null,
    exemptChannelIds: [],
    serverIps: [],
    exemptAdmins: true,
    dryRun: false,
    commandSecret: null,
    ringmasterUrl: 'http://127.0.0.1:3000',
    gameBanRoleId: '1542596612306505808',
    accessRoleId: ROLE,
    rulesChannelId: RULES,
    devInstanceId: 'i-0f79fdfbbe2506dca',
    devRegion: 'us-east-2',
    ...over,
  }
}

/**
 * A client whose guild answers every call the adapter makes. The Community
 * Rules channel is set to somewhere else on purpose: nothing may read it.
 */
function liveGuild(over: { removeRole?: () => Promise<void>; bot?: { position: number } } = {}) {
  const timeout = vi.fn(() => Promise.resolve())
  const removeRole = vi.fn(over.removeRole ?? (() => Promise.resolve()))
  const ban = vi.fn(() => Promise.resolve())
  const member = {
    id: USER,
    user: { bot: false },
    moderatable: true,
    permissions: { has: () => false },
    roles: { cache: new Map<string, unknown>() },
    timeout,
  }
  const accessRole = { id: ROLE, managed: false, position: 5 }
  const botPosition = over.bot?.position ?? 10
  const guild = {
    ownerId: '999999999999999999',
    rulesChannelId: COMMUNITY_RULES,
    roles: { cache: new Map([[ROLE, accessRole]]) },
    members: {
      fetch: vi.fn(() => Promise.resolve(member)),
      removeRole,
      ban,
      me: {
        permissions: { has: () => true },
        roles: {
          highest: {
            position: botPosition,
            comparePositionTo: (role: { position: number }) => botPosition - role.position,
          },
        },
      },
    },
  }
  const client = {
    guilds: {
      fetch: vi.fn(() => Promise.resolve(guild)),
      cache: new Map([[GUILD, guild]]),
    },
  } as unknown as Client

  return { client, timeout, removeRole, ban }
}

describe('the live Discord sanction adapter', () => {
  it('uses Discord timeout, role removal, and ban APIs with dedicated audit reasons', async () => {
    const { client, timeout, removeRole, ban } = liveGuild()
    const actions = discordDisciplineActions(client, config(), {
      notifyTimeout: () => Promise.resolve(),
      report: () => Promise.resolve(),
    })
    const event = offense('m1')

    await actions.timeout(event)
    expect(timeout).toHaveBeenCalledWith(RAPID_TIMEOUT_MS, DISCIPLINE_TIMEOUT_REASON)

    const beforeRemove = vi.fn<(roleId: string) => Promise<void>>(() =>
      Promise.resolve(),
    )
    await expect(actions.resetAccess(event, beforeRemove)).resolves.toEqual({
      did: 'removed',
      roleId: ROLE,
      rulesChannelId: RULES,
    })
    expect(beforeRemove).toHaveBeenCalledExactlyOnceWith(ROLE)
    expect(beforeRemove.mock.invocationCallOrder[0]).toBeLessThan(
      removeRole.mock.invocationCallOrder[0] ?? 0,
    )
    expect(removeRole).toHaveBeenCalledWith({
      user: USER,
      role: ROLE,
      reason: DISCIPLINE_ACCESS_REASON,
    })

    await actions.ban(event)
    expect(ban).toHaveBeenCalledWith(USER, {
      deleteMessageSeconds: 0,
      reason: DISCIPLINE_BAN_REASON,
    })
  })

  /**
   * REGRESSION. The role came from a `/reactrole` pairing keyed on the guild's
   * Community Rules channel, so a guild outside Community mode timed a rapid
   * offender out and left their access alone. The adapter now takes no
   * DynamoDB reader at all; the configured role is the only one it can remove.
   */
  it('removes the configured access role with nothing looked up', async () => {
    const { client, removeRole } = liveGuild()
    const actions = discordDisciplineActions(
      client,
      config({ accessRoleId: OTHER_ACCESS }),
      { notifyTimeout: () => Promise.resolve(), report: () => Promise.resolve() },
    )

    await expect(
      actions.resetAccess(offense('m1'), () => Promise.resolve()),
    ).resolves.toEqual({ did: 'removed', roleId: OTHER_ACCESS, rulesChannelId: RULES })
    expect(removeRole).toHaveBeenCalledWith(expect.objectContaining({ role: OTHER_ACCESS }))
    expect(discordDisciplineActions).toHaveLength(3)
  })

  it('names the role-hierarchy fault when Discord refuses the removal', async () => {
    const { client } = liveGuild({
      removeRole: () => Promise.reject(new Error('Missing Permissions')),
      bot: { position: 1 },
    })
    const actions = discordDisciplineActions(client, config(), {
      notifyTimeout: () => Promise.resolve(),
      report: () => Promise.resolve(),
    })
    const written: string[] = []
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      written.push(chunk)
      return true
    }) as unknown as typeof process.stderr.write)

    try {
      await expect(
        actions.resetAccess(offense('m1'), () => Promise.resolve()),
      ).resolves.toEqual({ did: 'failed', rulesChannelId: RULES })
    } finally {
      stderr.mockRestore()
    }

    const line = written.join('')
    expect(line).toContain('could not remove the access role during rapid-offense escalation')
    expect(line).toContain(`fault=${JSON.stringify(ACCESS_ROLE_PROBLEM['role-too-high'])}`)
    expect(line).not.toContain('no usable Rules role')
  })
})
