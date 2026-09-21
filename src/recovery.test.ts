import {
  ChannelType,
  Events,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Client,
} from 'discord.js'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { Config } from './config.ts'
import {
  installRulesRecovery,
  RECOVERY_BUTTON_LABEL,
  RECOVERY_CLOSE_REASON,
  RECOVERY_REMINDER_MS,
  RECOVERY_ROLE_REASON,
  RECOVERY_THREAD_REASON,
  probationConfirmation,
  recoveryButtonId,
  recoveryButtonRow,
  recoveryReminder,
  recoveryTarget,
} from './recovery.ts'
import { ACCESS_ROLE_PROBLEM } from './rules.ts'

const NOW = 1_800_000_000_000
const GUILD = '111111111111111111'
const RULES = '222222222222222222'
const USER = '333333333333333333'
const OTHER = '444444444444444444'
const ROLE = '555555555555555555'
const BOT = '666666666666666666'
const THREAD = '777777777777777777'
const ACCESS = '888888888888888888'
const COMMUNITY_RULES = '999999999999999999'
const PROBATION_UNTIL = NOW + 60 * 60_000

afterEach(() => {
  vi.useRealTimers()
})

function config(over: Partial<Config> = {}): Config {
  return {
    discordToken: 'token',
    guildId: GUILD,
    adminRoleId: ROLE,
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
    gameBanRoleId: ROLE,
    accessRoleId: ACCESS,
    rulesChannelId: RULES,
    devInstanceId: 'i-0f79fdfbbe2506dca',
    devRegion: 'us-east-2',
    ...over,
  }
}

interface World {
  readonly client: Client
  readonly desk: ReturnType<typeof installRulesRecovery>
  readonly listeners: Map<string, ((payload: never) => void)[]>
  readonly create: Mock<(options: unknown) => Promise<unknown>>
  readonly addMember: Mock<(userId: string) => Promise<string>>
  readonly addRole: Mock<(options: unknown) => Promise<void>>
  readonly startProbation: Mock<
    (
      userId: string,
    ) => Promise<{ readonly until: number; readonly started: boolean }>
  >
  readonly startProbationForRole: Mock<
    (
      userId: string,
      roleId: string,
    ) => Promise<{ readonly until: number; readonly started: boolean } | null>
  >
  readonly fetchActive: Mock<() => Promise<unknown>>
  readonly send: Mock<(payload: unknown) => Promise<unknown>>
  readonly setName: Mock<(name: string, reason?: string) => Promise<unknown>>
  readonly editThread: Mock<(options: unknown) => Promise<unknown>>
  readonly deleteThread: Mock<(reason?: string) => Promise<unknown>>
  readonly thread: {
    id: string
    type: ChannelType.PrivateThread
    name: string
    createdTimestamp: number
    parentId: string
    ownerId: string
    members: { add: (userId: string) => Promise<string> }
    send: (payload: unknown) => Promise<unknown>
    setName: (name: string, reason?: string) => Promise<unknown>
    edit: (options: unknown) => Promise<unknown>
    delete: (reason?: string) => Promise<unknown>
  }
}

function world(
  over: {
    readonly hasRole?: boolean
    readonly active?: boolean
    readonly threadName?: string
    readonly threadCreatedAt?: number
    readonly addMemberRejects?: boolean
    readonly addRoleRejects?: boolean
    readonly startProbationRejects?: boolean
    readonly botBelowAccess?: boolean
    readonly threadParent?: string
  } = {},
): World {
  const listeners = new Map<string, ((payload: never) => void)[]>()
  const send = vi.fn<(payload: unknown) => Promise<unknown>>(() => Promise.resolve({}))
  const addMember = vi.fn<(userId: string) => Promise<string>>((userId) =>
    over.addMemberRejects === true
      ? Promise.reject(new Error('Unknown Member'))
      : Promise.resolve(userId),
  )
  const addRole = vi.fn<(options: unknown) => Promise<void>>(() =>
    over.addRoleRejects === true
      ? Promise.reject(new Error('Missing Permissions'))
      : Promise.resolve(),
  )
  const startProbation = vi.fn((userId: string) =>
    over.startProbationRejects === true
      ? Promise.reject(new Error('DynamoDB unavailable'))
      : Promise.resolve({
          userId,
          until: PROBATION_UNTIL,
          started: true,
        }),
  )
  const startProbationForRole = vi.fn((userId: string, roleId: string) =>
    Promise.resolve({
      userId,
      roleId,
      until: PROBATION_UNTIL,
      started: true,
    }),
  )
  const deleteThread = vi.fn<(reason?: string) => Promise<unknown>>(() => Promise.resolve({}))

  const thread: World['thread'] = {
    id: THREAD,
    type: ChannelType.PrivateThread as const,
    name: over.threadName ?? `rules-access-${USER}`,
    createdTimestamp: over.threadCreatedAt ?? NOW,
    parentId: over.threadParent ?? RULES,
    ownerId: BOT,
    members: { add: addMember },
    send,
    setName: () => Promise.resolve({}),
    edit: () => Promise.resolve({}),
    delete: deleteThread,
  }
  const setName = vi.fn<(name: string, reason?: string) => Promise<unknown>>(
    (name) => {
      thread.name = name
      return Promise.resolve(thread)
    },
  )
  const editThread = vi.fn<(options: unknown) => Promise<unknown>>((options) => {
    if (
      typeof options === 'object' &&
      options !== null &&
      'name' in options &&
      typeof options.name === 'string'
    ) {
      thread.name = options.name
    }
    return Promise.resolve(thread)
  })
  thread.setName = setName
  thread.edit = editThread

  const create = vi.fn<(options: unknown) => Promise<unknown>>((options) => {
    if (
      typeof options === 'object' &&
      options !== null &&
      'name' in options &&
      typeof options.name === 'string'
    ) {
      thread.name = options.name
    }
    return Promise.resolve(thread)
  })
  const fetchActive = vi.fn<() => Promise<unknown>>(() =>
    Promise.resolve({
      threads: new Map(over.active === true ? [[THREAD, thread]] : []),
    }),
  )
  const rulesChannel = {
    type: ChannelType.GuildText,
    threads: { create, fetchActive },
  }
  const member = {
    roles: {
      cache: new Map(over.hasRole === true ? [[ACCESS, {}]] : []),
    },
  }
  const botPosition = over.botBelowAccess === true ? 1 : 10
  // The Community Rules channel points somewhere else on purpose: nothing may read it.
  const guild = {
    id: GUILD,
    rulesChannelId: COMMUNITY_RULES,
    roles: { cache: new Map([[ACCESS, { id: ACCESS, managed: false, position: 5 }]]) },
    members: {
      fetch: () => Promise.resolve(member),
      addRole,
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
    user: { id: BOT },
    guilds: { fetch: () => Promise.resolve(guild), cache: new Map([[GUILD, guild]]) },
    channels: {
      fetch: (id: string) =>
        Promise.resolve(id === RULES ? rulesChannel : id === THREAD ? thread : null),
    },
    once(event: string, handler: (payload: never) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return client
    },
    on(event: string, handler: (payload: never) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return client
    },
  } as unknown as Client

  return {
    client,
    desk: installRulesRecovery(client, config(), {
      now: () => NOW,
      startProbation,
      startProbationForRole,
    }),
    listeners,
    create,
    addMember,
    addRole,
    startProbation,
    startProbationForRole,
    fetchActive,
    send,
    setName,
    editThread,
    deleteThread,
    thread,
  }
}

function emit(worldValue: World, event: Events, payload: unknown): void {
  for (const handler of worldValue.listeners.get(event) ?? []) {
    handler(payload as never)
  }
}

function ready(): unknown {
  return {
    guilds: {
      cache: new Map([
        [GUILD, { id: GUILD, rulesChannelId: COMMUNITY_RULES }],
      ]),
    },
    user: { id: BOT },
  }
}

function button(
  customId: string,
  over: {
    readonly userId?: string
    readonly guildId?: string | null
    readonly channelId?: string | null
  } = {},
): {
  readonly interaction: ButtonInteraction
  readonly reply: Mock<(payload: unknown) => Promise<unknown>>
  readonly deferReply: Mock<(payload: unknown) => Promise<unknown>>
  readonly editReply: Mock<(payload: unknown) => Promise<unknown>>
  readonly editMessage: Mock<(payload: unknown) => Promise<unknown>>
} {
  const reply = vi.fn<(payload: unknown) => Promise<unknown>>(() => Promise.resolve({}))
  const deferReply = vi.fn<(payload: unknown) => Promise<unknown>>(() => Promise.resolve({}))
  const editReply = vi.fn<(payload: unknown) => Promise<unknown>>(() => Promise.resolve({}))
  const editMessage = vi.fn<(payload: unknown) => Promise<unknown>>(() => Promise.resolve({}))

  return {
    interaction: {
      isButton: () => true,
      customId,
      user: { id: over.userId ?? USER },
      guildId: over.guildId === undefined ? GUILD : over.guildId,
      channelId: over.channelId === undefined ? THREAD : over.channelId,
      reply,
      deferReply,
      editReply,
      message: { edit: editMessage },
    } as unknown as ButtonInteraction,
    reply,
    deferReply,
    editReply,
    editMessage,
  }
}

describe('Rules access recovery identifiers', () => {
  it('round-trips only one member and one thread snowflake', () => {
    const customId = recoveryButtonId(USER, THREAD)

    expect(recoveryTarget(customId)).toEqual({ userId: USER, threadId: THREAD })
    expect(recoveryTarget(`${customId}:extra`)).toBeNull()
    expect(recoveryTarget('something-else')).toBeNull()
  })
})

describe('the private Rules recovery thread', () => {
  it('opens for one member with a restore button and a one-week archive window', async () => {
    const w = world()

    await w.desk.open({
      userId: USER,
      rulesChannelId: RULES,
      text: 'Read the rules.',
    })

    expect(w.create).toHaveBeenCalledWith({
      name: `rules-access-${USER}`,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      invitable: false,
      reason: RECOVERY_THREAD_REASON,
    })
    expect(w.addMember).toHaveBeenCalledWith(USER)
    expect(w.send).toHaveBeenCalledWith({
      content: `<@${USER}>\n\nRead the rules.`,
      components: [recoveryButtonRow(recoveryButtonId(USER, THREAD))],
      allowedMentions: { parse: [], users: [USER], roles: [] },
    })
  })

  it('deletes an incomplete thread when the member cannot be added', async () => {
    const w = world({ addMemberRejects: true })

    await expect(
      w.desk.open({
        userId: USER,
        rulesChannelId: RULES,
        text: 'Read the rules.',
      }),
    ).rejects.toThrow('Unknown Member')

    expect(w.deleteThread).toHaveBeenCalledWith(
      'blitz-bot: incomplete rapid-offense Rules warning',
    )
  })

  it('tags the member with another restore button after one hour', async () => {
    vi.useFakeTimers()
    const w = world()

    await w.desk.open({
      userId: USER,
      rulesChannelId: RULES,
      text: 'Read the rules.',
    })
    await vi.advanceTimersByTimeAsync(RECOVERY_REMINDER_MS)

    expect(w.send).toHaveBeenCalledTimes(2)
    expect(w.send).toHaveBeenLastCalledWith({
      content: recoveryReminder(USER),
      components: [recoveryButtonRow(recoveryButtonId(USER, THREAD))],
      allowedMentions: { parse: [], users: [USER], roles: [] },
    })
    expect(w.setName).toHaveBeenCalledWith(
      `rules-access-reminded-${USER}`,
      'blitz-bot: sent the one-hour Rules access reminder',
    )
  })

  it('closes without reminding when access was restored another way', async () => {
    vi.useFakeTimers()
    const w = world({ hasRole: true })

    await w.desk.open({
      userId: USER,
      rulesChannelId: RULES,
      text: 'Read the rules.',
    })
    await vi.advanceTimersByTimeAsync(RECOVERY_REMINDER_MS)

    expect(w.send).toHaveBeenCalledTimes(1)
    expect(w.startProbationForRole).toHaveBeenCalledWith(USER, ACCESS)
    expect(w.startProbation).not.toHaveBeenCalled()
    expect(w.editThread).toHaveBeenCalledWith({
      name: `rules-access-restored-${USER}`,
      locked: true,
      archived: true,
      reason: RECOVERY_CLOSE_REASON,
    })
  })

  it('resumes an unreminded active thread after a restart', async () => {
    vi.useFakeTimers()
    const w = world({
      active: true,
      threadName: `rules-access-${USER}`,
      threadCreatedAt: NOW - RECOVERY_REMINDER_MS / 2,
    })

    emit(w, Events.ClientReady, ready())
    await vi.advanceTimersByTimeAsync(RECOVERY_REMINDER_MS / 2)

    expect(w.fetchActive).toHaveBeenCalledTimes(1)
    expect(w.send).toHaveBeenCalledWith({
      content: recoveryReminder(USER),
      components: [recoveryButtonRow(recoveryButtonId(USER, THREAD))],
      allowedMentions: { parse: [], users: [USER], roles: [] },
    })
  })
})

describe('the restore-access button', () => {
  it('restores the configured access role, confirms privately, and closes the thread', async () => {
    const w = world()
    const customId = recoveryButtonId(USER, THREAD)
    const clicked = button(customId)

    emit(w, Events.InteractionCreate, clicked.interaction)

    await vi.waitFor(() => {
      expect(w.addRole).toHaveBeenCalledTimes(1)
    })

    expect(clicked.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral })
    expect(w.addRole).toHaveBeenCalledWith({
      user: USER,
      role: ACCESS,
      reason: RECOVERY_ROLE_REASON,
    })
    expect(w.startProbation).toHaveBeenCalledWith(USER)
    expect(w.startProbation.mock.invocationCallOrder[0]).toBeLessThan(
      w.addRole.mock.invocationCallOrder[0] ?? 0,
    )
    expect(clicked.editReply).toHaveBeenCalledWith({
      content: probationConfirmation(PROBATION_UNTIL),
      allowedMentions: { parse: [] },
    })
    expect(clicked.editMessage).toHaveBeenCalledWith({
      components: [recoveryButtonRow(customId, true)],
    })
    expect(w.editThread).toHaveBeenCalledWith({
      name: `rules-access-restored-${USER}`,
      locked: true,
      archived: true,
      reason: RECOVERY_CLOSE_REASON,
    })
  })

  it('refuses a different member without touching the role', async () => {
    const w = world()
    const clicked = button(recoveryButtonId(USER, THREAD), { userId: OTHER })

    emit(w, Events.InteractionCreate, clicked.interaction)

    await vi.waitFor(() => {
      expect(clicked.reply).toHaveBeenCalledTimes(1)
    })

    expect(clicked.reply).toHaveBeenCalledWith({
      content: 'This button belongs to another member.',
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    })
    expect(w.addRole).not.toHaveBeenCalled()
  })

  /**
   * The old version of this case was a missing `/reactrole` pairing. The role is
   * configured now, so what can stop the button is a role the bot cannot assign,
   * and it is refused before probation starts.
   */
  it('keeps the thread open and points to admins when the access role cannot be assigned', async () => {
    const w = world({ botBelowAccess: true })
    const clicked = button(recoveryButtonId(USER, THREAD))
    const written: string[] = []
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      written.push(chunk)
      return true
    }) as unknown as typeof process.stderr.write)

    try {
      emit(w, Events.InteractionCreate, clicked.interaction)

      await vi.waitFor(() => {
        expect(clicked.editReply).toHaveBeenCalledTimes(1)
      })
    } finally {
      stderr.mockRestore()
    }

    expect(clicked.editReply).toHaveBeenCalledWith({
      content: `I could not restore your access. Contact <@&${ROLE}>.`,
      allowedMentions: { parse: [] },
    })
    expect(w.addRole).not.toHaveBeenCalled()
    expect(w.startProbation).not.toHaveBeenCalled()
    expect(w.editThread).not.toHaveBeenCalled()
    expect(written.join('')).toContain(
      `fault=${JSON.stringify(ACCESS_ROLE_PROBLEM['role-too-high'])}`,
    )
  })

  /**
   * REGRESSION. The thread was validated against the guild's Community Rules
   * channel. A thread under the configured channel is the valid one, and one
   * under the Community channel is not, whichever the guild object names.
   */
  it('validates the thread against the configured Rules channel only', async () => {
    const valid = world()
    const underCommunity = world({ threadParent: COMMUNITY_RULES })
    const good = button(recoveryButtonId(USER, THREAD))
    const stale = button(recoveryButtonId(USER, THREAD))

    emit(valid, Events.InteractionCreate, good.interaction)
    emit(underCommunity, Events.InteractionCreate, stale.interaction)

    await vi.waitFor(() => {
      expect(valid.addRole).toHaveBeenCalledTimes(1)
      expect(stale.editReply).toHaveBeenCalledTimes(1)
    })

    expect(stale.editReply).toHaveBeenCalledWith({
      content: 'This access button is no longer valid.',
      allowedMentions: { parse: [] },
    })
    expect(underCommunity.addRole).not.toHaveBeenCalled()
    expect(underCommunity.startProbation).not.toHaveBeenCalled()
  })

  it('does not restore the role when probation cannot be persisted', async () => {
    const w = world({ startProbationRejects: true })
    const clicked = button(recoveryButtonId(USER, THREAD))

    emit(w, Events.InteractionCreate, clicked.interaction)

    await vi.waitFor(() => {
      expect(clicked.editReply).toHaveBeenCalledTimes(1)
    })

    expect(w.startProbation).toHaveBeenCalledWith(USER)
    expect(w.addRole).not.toHaveBeenCalled()
    expect(clicked.editReply).toHaveBeenCalledWith({
      content: `I could not restore your access. Contact <@&${ROLE}>.`,
      allowedMentions: { parse: [] },
    })
    expect(w.editThread).not.toHaveBeenCalled()
  })

  it('keeps the recovery thread open when role restoration fails after probation starts', async () => {
    const w = world({ addRoleRejects: true })
    const clicked = button(recoveryButtonId(USER, THREAD))

    emit(w, Events.InteractionCreate, clicked.interaction)

    await vi.waitFor(() => {
      expect(clicked.editReply).toHaveBeenCalledTimes(1)
    })

    expect(w.startProbation).toHaveBeenCalledWith(USER)
    expect(w.addRole).toHaveBeenCalledTimes(1)
    expect(w.editThread).not.toHaveBeenCalled()
  })

  it('uses the configured button label in the one-hour reminder', () => {
    expect(recoveryReminder(USER)).toContain(`**${RECOVERY_BUTTON_LABEL}**`)
  })
})
