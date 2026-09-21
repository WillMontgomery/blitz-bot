import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ChannelType, Events, type Client } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleReadiness } from './banrole.ts'
import { renderManual } from './client.ts'
import { loadConfig, type Config } from './config.ts'
import {
  reactRoleChannelKey,
  REACT_ROLE_ANY,
  type Ddb,
  type DdbFailureKind,
  type DdbResult,
  type ReactRolePairing,
} from './ddb.ts'
import { discordDisciplineActions } from './discipline.ts'
import { latch } from './latch.ts'
import { handleReaction, type ReactRoleDeps } from './reactroles.ts'
import { installRulesRecovery, recoveryButtonId } from './recovery.ts'
import {
  ACCESS_RECHECK_MS,
  ACCESS_ROLE_PROBLEM,
  ACCESS_ROLE_READY,
  checkAccess,
  guildScreeningRoles,
  handleScreening,
  installAccessCheck,
  installRulesScreening,
  legacyRulesRecovery,
  PAIRING_AGREES,
  PAIRING_DISAGREES,
  PAIRING_UNREAD,
  RULES_CHANNEL_PROBLEM,
  RULES_CHANNEL_READY,
  type AccessCheckDeps,
  type AccessLook,
  type ScreeningDeps,
  type ScreeningRoles,
} from './rules.ts'

const GUILD = '111111111111111111'
const RULES = '222222222222222222'
const USER = '333333333333333333'
const ACCESS = '444444444444444444'
const OTHER_ROLE = '555555555555555555'
const COMMUNITY_RULES = '666666666666666666'
const ELSEWHERE = '777777777777777777'

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

const ok = <T,>(value: T): DdbResult<T> => ({ ok: true, value })

const failed = (kind: DdbFailureKind): DdbResult<never> => ({
  ok: false,
  failure: { kind, op: 'get', table: 'ringmaster-reactroles', message: 'from the fake' },
})

function config(over: Partial<Config> = {}): Config {
  return {
    discordToken: 'token',
    guildId: GUILD,
    adminRoleId: null,
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
    accessRoleId: ACCESS,
    rulesChannelId: RULES,
    devInstanceId: 'i-0f79fdfbbe2506dca',
    devRegion: 'us-east-2',
    ...over,
  }
}

function pairing(over: Partial<ReactRolePairing> = {}): ReactRolePairing {
  return {
    messageId: reactRoleChannelKey(RULES),
    emoji: REACT_ROLE_ANY,
    roleId: ACCESS,
    channelId: RULES,
    guildId: GUILD,
    createdAt: 1,
    createdBy: USER,
    ...over,
  }
}

function reads(
  result: DdbResult<ReactRolePairing | null> = ok(null),
): Pick<Ddb['reactRoles'], 'get'> & { get: ReturnType<typeof vi.fn<Ddb['reactRoles']['get']>> } {
  return { get: vi.fn<Ddb['reactRoles']['get']>(() => Promise.resolve(result)) }
}

/* ------------------------------------------------------------------ */

function roles(
  over: { add?: ScreeningRoles['add']; standing?: RoleReadiness } = {},
): ScreeningRoles & { add: ReturnType<typeof vi.fn<ScreeningRoles['add']>> } {
  return {
    add: vi.fn<ScreeningRoles['add']>(over.add ?? (() => Promise.resolve())),
    standing: () => over.standing ?? { ok: true },
  }
}

function screening(granting: ScreeningRoles): ScreeningDeps {
  return { guildId: GUILD, accessRoleId: ACCESS, roles: granting }
}

const completed = {
  guildId: GUILD,
  userId: USER,
  fromBot: false,
  wasPending: true,
  isPending: false,
}

describe('membership screening completion', () => {
  it('grants the configured access role on pending true to false', async () => {
    const granting = roles()

    await expect(handleScreening(completed, screening(granting))).resolves.toEqual({
      did: 'granted',
      roleId: ACCESS,
    })
    expect(granting.add).toHaveBeenCalledExactlyOnceWith(USER, ACCESS)
  })

  it('does nothing for ordinary member updates, bots, or another guild', async () => {
    const granting = roles()

    await expect(
      handleScreening({ ...completed, wasPending: false }, screening(granting)),
    ).resolves.toEqual({ did: 'ignored', why: 'not-completed' })
    await expect(
      handleScreening({ ...completed, fromBot: true }, screening(granting)),
    ).resolves.toEqual({ did: 'ignored', why: 'bot' })
    await expect(
      handleScreening({ ...completed, guildId: ELSEWHERE }, screening(granting)),
    ).resolves.toEqual({ did: 'ignored', why: 'other-guild' })

    expect(granting.add).not.toHaveBeenCalled()
  })

  /**
   * REGRESSION, THE LIVE FAILURE. The member's pending flag flipped, the handler
   * ran, and it logged "no usable Rules role is configured" with
   * `reason="no-rules-channel"`, because the role was looked up from a pairing
   * keyed on the guild's Community Rules channel and the guild does not use
   * Community mode. Through the real listener, with that channel null and no
   * DynamoDB handed over at all, the configured role is granted.
   */
  it('grants the configured role through the listener with no Community channel and no DynamoDB', async () => {
    const listeners = new Map<string, (before: unknown, after: unknown) => void>()
    const client = {
      on(event: string, handler: (before: unknown, after: unknown) => void) {
        listeners.set(event, handler)
        return client
      },
    } as unknown as Client
    const granting = roles()

    installRulesScreening(client, config(), granting)

    listeners.get(Events.GuildMemberUpdate)?.(
      { pending: true },
      {
        id: USER,
        pending: false,
        user: { bot: false },
        guild: { id: GUILD, rulesChannelId: null },
      },
    )

    await vi.waitFor(() => {
      expect(granting.add).toHaveBeenCalledExactlyOnceWith(USER, ACCESS)
    })
    expect(stderr.join('')).toBe('')
    expect(installRulesScreening).toHaveLength(2)
  })

  it('names the configuration fault and where it is fixed when the grant fails', async () => {
    const granting = roles({
      add: () => Promise.reject(new Error('Missing Permissions')),
      standing: { ok: false, why: 'role-too-high' },
    })

    await expect(handleScreening(completed, screening(granting))).resolves.toEqual({
      did: 'failed',
      why: 'role-too-high',
    })

    const line = stderr.join('')
    expect(line).toContain('the access role could not be granted, so the member has to be given it by hand')
    expect(line).toContain(`fault=${JSON.stringify(ACCESS_ROLE_PROBLEM['role-too-high'])}`)
    expect(line).toContain('Server Settings, Roles')
    expect(line).not.toContain('no usable Rules role')
  })

  it('carries the error Discord gave, and no invented fault, when the role looked assignable', async () => {
    const granting = roles({ add: () => Promise.reject(new Error('Unknown Member')) })

    await expect(handleScreening(completed, screening(granting))).resolves.toEqual({
      did: 'failed',
      why: 'refused',
    })

    const line = stderr.join('')
    expect(line).toContain('error="Error: Unknown Member"')
    expect(line).not.toContain('fault=')
  })
})

/* ------------------------------------------------------------------ */

/**
 * ONE ROLE, THREE PATHS. Screening grants, the three-strike removal takes and
 * the Restore access button gives back, each through its own live adapter, and
 * every edit they make lands on `config.accessRoleId`. The guild's Community
 * Rules channel points somewhere else and no DynamoDB is handed to any of them.
 */
describe('the access role across screening, removal and recovery', () => {
  it('grants, removes and restores the same configured role', async () => {
    const edits: [string, string][] = []
    const edit = (kind: string) => (options: { role: string }) => {
      edits.push([kind, options.role])
      return Promise.resolve()
    }
    const handlers = new Map<string, (payload: never) => void>()
    const thread = {
      id: '888888888888888888',
      type: ChannelType.PrivateThread,
      parentId: RULES,
      ownerId: ELSEWHERE,
      edit: () => Promise.resolve(),
    }
    const guild = {
      id: GUILD,
      rulesChannelId: COMMUNITY_RULES,
      ownerId: '999999999999999999',
      roles: { cache: new Map([[ACCESS, { id: ACCESS, managed: false, position: 5 }]]) },
      members: {
        addRole: edit('add'),
        removeRole: edit('remove'),
        me: {
          permissions: { has: () => true },
          roles: {
            highest: {
              position: 10,
              comparePositionTo: (role: { position: number }) => 10 - role.position,
            },
          },
        },
      },
    }
    const client = {
      user: { id: ELSEWHERE },
      guilds: { fetch: () => Promise.resolve(guild), cache: new Map([[GUILD, guild]]) },
      channels: { fetch: () => Promise.resolve(thread) },
      on(event: string, handler: (payload: never) => void) {
        handlers.set(event, handler)
        return client
      },
      once() {
        return client
      },
    } as unknown as Client

    await handleScreening(completed, {
      guildId: GUILD,
      accessRoleId: config().accessRoleId,
      roles: guildScreeningRoles(client, GUILD),
    })

    const actions = discordDisciplineActions(client, config(), {
      notifyTimeout: () => Promise.resolve(),
      report: () => Promise.resolve(),
    })
    await actions.resetAccess(
      {
        messageId: '101010101010101010',
        userId: USER,
        channelId: ELSEWHERE,
        reason: 'foreign-ip',
        webhookId: null,
        fromBot: false,
        isOwner: false,
        administrator: false,
      },
      () => Promise.resolve(),
    )

    installRulesRecovery(client, config(), {
      startProbation: () => Promise.resolve({ until: 1, started: true }),
      startProbationForRole: () => Promise.resolve(null),
    })
    handlers.get(Events.InteractionCreate)?.({
      isButton: () => true,
      customId: recoveryButtonId(USER, thread.id),
      user: { id: USER },
      guildId: GUILD,
      channelId: thread.id,
      deferReply: () => Promise.resolve(),
      editReply: () => Promise.resolve(),
      message: { edit: () => Promise.resolve() },
    } as never)

    await vi.waitFor(() => {
      expect(edits).toHaveLength(3)
    })
    expect(edits).toEqual([
      ['add', ACCESS],
      ['remove', ACCESS],
      ['add', ACCESS],
    ])
  })
})

/* ------------------------------------------------------------------ */

describe('the legacy Rules reaction', () => {
  function reacted(
    rows: readonly ReactRolePairing[],
    reaction: { channelId: string; messageId?: string },
  ) {
    const startProbationForRole = vi.fn(() => Promise.resolve(null))
    const add = vi.fn(() => Promise.resolve())
    const held = new Map(rows.map((row) => [`${row.messageId}\0${row.emoji}`, row]))
    const deps: ReactRoleDeps = {
      ddb: {
        reactRoles: {
          get: (messageId, emoji) => Promise.resolve(ok(held.get(`${messageId}\0${emoji}`) ?? null)),
          put: () => Promise.reject(new Error('not used')),
        },
      },
      roles: { add, remove: () => Promise.resolve() },
      beforeGrant: legacyRulesRecovery(config(), { startProbationForRole }),
      guildId: GUILD,
      reads: latch(),
    }

    return {
      startProbationForRole,
      add,
      done: handleReaction(
        {
          messageId: reaction.messageId ?? '888888888888888888',
          channelId: reaction.channelId,
          guildId: GUILD,
          emoji: '✅',
          userId: USER,
          fromBot: false,
        },
        'added',
        deps,
      ),
    }
  }

  /**
   * THE BACKUP PATH STILL WORKS AGAINST THE CONFIGURED CHANNEL. A reaction there
   * that the channel-wide any-reaction pairing matched is handed to the
   * discipline desk with the pairing's own role, before that role is granted.
   */
  it('starts probation for a reaction the configured Rules channel pairing matched', async () => {
    const w = reacted([pairing()], { channelId: RULES })

    await expect(w.done).resolves.toMatchObject({ did: 'granted', how: 'channel-any' })
    expect(w.startProbationForRole).toHaveBeenCalledExactlyOnceWith(USER, ACCESS)
    expect(w.startProbationForRole.mock.invocationCallOrder[0]).toBeLessThan(
      w.add.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('leaves every other reaction role out of recovery', async () => {
    const community = reacted(
      [pairing({ messageId: reactRoleChannelKey(COMMUNITY_RULES), channelId: COMMUNITY_RULES })],
      { channelId: COMMUNITY_RULES },
    )
    const messageSpecific = reacted(
      [pairing({ messageId: '888888888888888888', emoji: REACT_ROLE_ANY })],
      { channelId: RULES },
    )

    await expect(community.done).resolves.toMatchObject({ did: 'granted' })
    await expect(messageSpecific.done).resolves.toMatchObject({ did: 'granted', how: 'message-any' })
    expect(community.startProbationForRole).not.toHaveBeenCalled()
    expect(messageSpecific.startProbationForRole).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ */

/**
 * REGRESSION, AT THE SOURCE. Every #23 reader took the Rules channel from
 * `guild.rulesChannelId`, Discord's Community setting, and the guild does not
 * use Community mode. The fix is that nothing reads it, not even as a fallback,
 * so this reads every shipped file and allows `.rulesChannelId` only on the
 * config and on the #23 records that were handed the configured value.
 */
describe('no reader takes the Rules channel from the guild', () => {
  const ALLOWED = new Set(['config', 'access', 'references', 'notice'])

  const shipped = (dir: URL): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return shipped(new URL(`${entry.name}/`, dir))
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
      return [fileURLToPath(new URL(entry.name, dir))]
    })

  it('reads .rulesChannelId off the config and the #23 records only', () => {
    const files = shipped(new URL('./', import.meta.url))
    expect(files.length).toBeGreaterThan(10)

    const readers: string[] = []
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/u.test(line))
        .join('\n')

      for (const match of code.matchAll(/([\w)\]]+)(\??)\.rulesChannel(?:Id)?\b/gu)) {
        const receiver = `${match[1] ?? ''}${match[2] ?? ''}`
        if (!ALLOWED.has(receiver)) readers.push(`${file}: ${match[0]}`)
      }
    }

    expect(readers).toEqual([])
  })

  it('would catch each shape the old readers had', () => {
    for (const old of [
      'rulesChannelId: after.guild.rulesChannelId,',
      'const role = await rulesRoleFor(reads, config.guildId, guild.rulesChannelId)',
      'client.guilds.cache.get(config.guildId)?.rulesChannelId ?? null',
      'rulesChannelId: full.guild?.rulesChannelId ?? null,',
      'const channel = guild.rulesChannel',
    ]) {
      const receivers = [...old.matchAll(/([\w)\]]+)(\??)\.rulesChannel(?:Id)?\b/gu)].map(
        (match) => `${match[1] ?? ''}${match[2] ?? ''}`,
      )
      expect(receivers.some((receiver) => !ALLOWED.has(receiver)), old).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------ */

const HEALTHY: AccessLook = { role: { ok: true }, channel: 'ok' }

function checking(
  look: AccessLook | 'unavailable' | null | (() => AccessLook | 'unavailable' | null),
  table: Pick<Ddb['reactRoles'], 'get'> = reads(),
): AccessCheckDeps {
  return {
    config: { accessRoleId: ACCESS, rulesChannelId: RULES },
    look: typeof look === 'function' ? look : () => look,
    reads: table,
    role: latch(),
    channel: latch(),
    pairing: latch(),
  }
}

const said = (): string => stderr.join('') + stdout.join('')

describe('the startup access check', () => {
  it('says nothing and looks no further when everything is in place', async () => {
    const table = reads(ok(pairing()))

    await expect(checkAccess(checking(HEALTHY, table))).resolves.toBe(false)

    expect(stderr.join('')).toBe('')
    expect(table.get).toHaveBeenCalledExactlyOnceWith(reactRoleChannelKey(RULES), REACT_ROLE_ANY)
  })

  /** THE BACKUP IS OPTIONAL. No pairing in the Rules channel is not a fault. */
  it('does not warn when the Rules channel has no legacy pairing', async () => {
    await expect(checkAccess(checking(HEALTHY, reads(ok(null))))).resolves.toBe(false)

    expect(said()).toBe('')
  })

  it('warns, once, when the legacy pairing grants a different role, and says when it agrees', async () => {
    let row = pairing({ roleId: OTHER_ROLE })
    const table = { get: vi.fn(() => Promise.resolve(ok(row))) }
    const deps = checking(HEALTHY, table)

    await expect(checkAccess(deps)).resolves.toBe(true)
    await expect(checkAccess(deps)).resolves.toBe(true)

    expect(stderr.join('').split(PAIRING_DISAGREES)).toHaveLength(2)
    expect(stderr.join('')).toContain('level=warn')
    expect(stderr.join('')).toContain(`pairing="${OTHER_ROLE}" access="${ACCESS}"`)

    row = pairing()
    await expect(checkAccess(deps)).resolves.toBe(false)
    expect(stdout.join('')).toContain(PAIRING_AGREES)
  })

  it('reports a role the bot cannot assign, and the all-clear when it is dragged into place', async () => {
    let look: AccessLook = { role: { ok: false, why: 'role-too-high' }, channel: 'ok' }
    const deps = checking(() => look)

    await expect(checkAccess(deps)).resolves.toBe(true)
    expect(stderr.join('')).toContain(`msg=${JSON.stringify(ACCESS_ROLE_PROBLEM['role-too-high'])} role="${ACCESS}"`)

    look = HEALTHY
    await expect(checkAccess(deps)).resolves.toBe(false)
    expect(stdout.join('')).toContain(ACCESS_ROLE_READY)
  })

  it.each(['missing', 'not-text'] as const)('reports a Rules channel that is %s', async (channel) => {
    let look: AccessLook = { role: { ok: true }, channel }
    const deps = checking(() => look)

    await expect(checkAccess(deps)).resolves.toBe(true)
    expect(stderr.join('')).toContain(`msg=${JSON.stringify(RULES_CHANNEL_PROBLEM[channel])} channel="${RULES}"`)

    look = HEALTHY
    await expect(checkAccess(deps)).resolves.toBe(false)
    expect(stdout.join('')).toContain(RULES_CHANNEL_READY)
  })

  /**
   * A DYNAMODB READ FAILURE IS NOT A MISCONFIGURATION, and ./reactroles.ts's
   * split is followed: a timeout is said per pass and holds nothing, while a
   * table that is not there is latched and cleared when it answers.
   */
  it('does not call a failed read a disagreement, and latches only the permanent kinds', async () => {
    const transient = checking(HEALTHY, reads(failed('timeout')))

    // Asked again next pass, because the answer is still unknown.
    await expect(checkAccess(transient)).resolves.toBe(true)
    expect(stderr.join('')).toContain(PAIRING_UNREAD)
    expect(stderr.join('')).toContain('level=warn')
    expect(stderr.join('')).not.toContain(PAIRING_DISAGREES)

    stderr.length = 0
    let answer: DdbResult<ReactRolePairing | null> = failed('no-such-table')
    const permanent = checking(HEALTHY, { get: () => Promise.resolve(answer) })

    await expect(checkAccess(permanent)).resolves.toBe(true)
    await expect(checkAccess(permanent)).resolves.toBe(true)
    expect(stderr.join('').match(/level=error/gu)).toHaveLength(1)
    expect(stderr.join('')).not.toContain(PAIRING_DISAGREES)

    answer = ok(null)
    await expect(checkAccess(permanent)).resolves.toBe(false)
    expect(stdout.join('')).toContain('the reaction role table answers now')
  })

  /**
   * A held disagreement must still get its all-clear when a read in between
   * times out. The pass that timed out once reported "nothing held" and the
   * re-check stopped with the warning latched for good.
   */
  it('keeps looking through a timed-out read while a disagreement is held', async () => {
    let answer: DdbResult<ReactRolePairing | null> = ok(pairing({ roleId: OTHER_ROLE }))
    const deps = checking(HEALTHY, { get: () => Promise.resolve(answer) })

    await expect(checkAccess(deps)).resolves.toBe(true)

    answer = failed('timeout')
    await expect(checkAccess(deps)).resolves.toBe(true)

    answer = ok(pairing())
    await expect(checkAccess(deps)).resolves.toBe(false)
    expect(stdout.join('')).toContain(PAIRING_AGREES)
  })

  it('says nothing and reads nothing when the guild is not in the cache', async () => {
    const table = reads()

    await expect(checkAccess(checking(null, table))).resolves.toBe(false)
    expect(said()).toBe('')
    expect(table.get).not.toHaveBeenCalled()
  })

  /**
   * An unavailable guild is a Discord outage, not a misconfiguration: nothing is
   * said or latched, and the check looks again rather than stopping for good.
   */
  it('says nothing, holds nothing and looks again while the guild is unavailable', async () => {
    const table = reads(ok(pairing()))
    let look: AccessLook | 'unavailable' = 'unavailable'
    const deps = checking(() => look, table)

    await expect(checkAccess(deps)).resolves.toBe(true)
    expect(said()).toBe('')
    expect(table.get).not.toHaveBeenCalled()

    // Nothing was latched, so the healthy pass has no all-clear to say.
    look = HEALTHY
    await expect(checkAccess(deps)).resolves.toBe(false)
    expect(said()).toBe('')
  })

  it('logs rather than throws when the guild cannot be read', async () => {
    const deps = checking(() => {
      throw new Error('cache exploded')
    })

    await expect(checkAccess(deps)).resolves.toBe(false)
    expect(stderr.join('')).toContain('cache exploded')
  })
})

/* ------------------------------------------------------------------ */

/** A client with one cached guild, shaped the way `lookAtAccess` reads one. */
function liveClient(over: { botPosition?: number; channelType?: ChannelType | null } = {}) {
  const ready: (() => void)[] = []
  const state = { botPosition: over.botPosition ?? 10 }
  const channelType = over.channelType === undefined ? ChannelType.GuildText : over.channelType
  const guild = {
    available: true,
    rulesChannelId: COMMUNITY_RULES,
    channels: {
      cache: new Map(channelType === null ? [] : [[RULES, { id: RULES, type: channelType }]]),
    },
    roles: { cache: new Map([[ACCESS, { id: ACCESS, managed: false, position: 5 }]]) },
    members: {
      me: {
        permissions: { has: () => true },
        roles: {
          highest: {
            get position() {
              return state.botPosition
            },
            comparePositionTo: (role: { position: number }) => state.botPosition - role.position,
          },
        },
      },
    },
  }
  const guilds = new Map<string, unknown>([[GUILD, guild]])
  const client = {
    guilds: { cache: guilds },
    once(event: string, handler: () => void) {
      if (event === Events.ClientReady) ready.push(handler)
      return client
    },
  }

  return {
    client: client as unknown as Client,
    state,
    guild,
    guilds,
    ready: () => {
      for (const handler of ready) handler()
    },
  }
}

describe('installAccessCheck', () => {
  it('checks once when the client is ready, and not again when all is well', async () => {
    vi.useFakeTimers()
    const live = liveClient()
    const table = reads(ok(pairing()))

    installAccessCheck(live.client, config(), table)
    expect(table.get).not.toHaveBeenCalled()

    live.ready()
    await vi.advanceTimersByTimeAsync(ACCESS_RECHECK_MS * 3)

    expect(table.get).toHaveBeenCalledTimes(1)
    expect(said()).toBe('')
  })

  it('looks again while a fault is held, so the all-clear arrives once the owner fixes it', async () => {
    vi.useFakeTimers()
    const live = liveClient({ botPosition: 1 })
    const table = reads(ok(null))

    installAccessCheck(live.client, config(), table)
    live.ready()
    await vi.advanceTimersByTimeAsync(0)

    expect(stderr.join('')).toContain(ACCESS_ROLE_PROBLEM['role-too-high'])

    await vi.advanceTimersByTimeAsync(ACCESS_RECHECK_MS)
    expect(stderr.join('').split(ACCESS_ROLE_PROBLEM['role-too-high'])).toHaveLength(2)

    live.state.botPosition = 10
    await vi.advanceTimersByTimeAsync(ACCESS_RECHECK_MS)
    expect(stdout.join('')).toContain(ACCESS_ROLE_READY)

    const before = table.get.mock.calls.length
    await vi.advanceTimersByTimeAsync(ACCESS_RECHECK_MS * 3)
    expect(table.get.mock.calls.length).toBe(before)
  })

  /**
   * discord.js emits ClientReady after `waitGuildTimeout` with a guild Discord
   * has not sent still cached, unavailable and empty. Read as configuration,
   * that was two errors telling the owner to edit a correct `.env`.
   */
  it('says nothing while the guild is unavailable, and checks it once Discord sends it', async () => {
    vi.useFakeTimers()
    const live = liveClient()
    const table = reads(ok(pairing()))

    live.guilds.set(GUILD, {
      available: false,
      channels: { cache: new Map() },
      roles: { cache: new Map() },
      members: { me: null },
    })

    installAccessCheck(live.client, config(), table)
    live.ready()
    await vi.advanceTimersByTimeAsync(0)

    expect(said()).toBe('')
    expect(table.get).not.toHaveBeenCalled()

    live.guilds.set(GUILD, live.guild)
    await vi.advanceTimersByTimeAsync(ACCESS_RECHECK_MS)

    expect(table.get).toHaveBeenCalledTimes(1)
    expect(said()).toBe('')

    await vi.advanceTimersByTimeAsync(ACCESS_RECHECK_MS * 3)
    expect(table.get).toHaveBeenCalledTimes(1)
  })

  it('reports a Rules channel that is not in the guild', async () => {
    const live = liveClient({ channelType: null })

    installAccessCheck(live.client, config(), reads())
    live.ready()

    await vi.waitFor(() => {
      expect(stderr.join('')).toContain(RULES_CHANNEL_PROBLEM.missing)
    })
  })

  /** Never blocking or crashing startup: the ready listener cannot throw. */
  it('cannot throw out of the ready listener, whatever the check meets', async () => {
    const ready: (() => void)[] = []
    const client = {
      guilds: {
        cache: {
          get: () => {
            throw new Error('cache exploded')
          },
        },
      },
      once(_event: string, handler: () => void) {
        ready.push(handler)
        return client
      },
    } as unknown as Client
    const table = { get: () => Promise.reject(new Error('not a DdbResult')) }

    installAccessCheck(client, config(), table)

    expect(() => {
      for (const handler of ready) handler()
    }).not.toThrow()

    await vi.waitFor(() => {
      expect(stderr.join('')).toContain('cache exploded')
    })
  })

  it('cannot throw out of the ready listener when the pairing read rejects', async () => {
    const live = liveClient()

    installAccessCheck(live.client, config(), { get: () => Promise.reject(new Error('socket hang up')) })

    expect(() => {
      live.ready()
    }).not.toThrow()

    await vi.waitFor(() => {
      expect(stderr.join('')).toContain('the access check threw')
    })
  })
})

/* ------------------------------------------------------------------ */

/**
 * docs/deploy.md quotes what the check says, and those lines are held to the
 * constants that write them rather than typed out twice.
 */
describe('docs/deploy.md on the access check', () => {
  const deploy = readFileSync(new URL('../docs/deploy.md', import.meta.url), 'utf8')

  it('quotes the role-hierarchy fault and its all-clear exactly as the journal prints them', () => {
    expect(deploy).toContain(
      `level=error msg=${JSON.stringify(ACCESS_ROLE_PROBLEM['role-too-high'])} role="1542596402180530257"`,
    )
    expect(deploy).toContain(`level=info msg=${JSON.stringify(ACCESS_ROLE_READY)}`)
  })

  /**
   * THE MANUAL'S ROLE MENTION IS RENDERED FROM THE CONFIG. It was a literal,
   * which held only while BLITZ_ACCESS_ROLE_ID was the default, so this sets
   * another id and reads the rendering.
   */
  it('has the manual name the members role screening actually grants', () => {
    const manual = readFileSync(new URL('../docs/bot-manual.md', import.meta.url), 'utf8')
    const granted = loadConfig({
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_GUILD_ID: GUILD,
      BLITZ_ACCESS_ROLE_ID: OTHER_ROLE,
    })
    const rendered = renderManual(manual, granted)

    expect(rendered).toContain(`Membership Screening grants <@&${OTHER_ROLE}>.`)
    expect(rendered).not.toContain('1542596402180530257')
    expect(rendered).not.toContain('any-reaction role')
  })

  it('says Community mode is not needed and names both settings', () => {
    expect(deploy).toContain('BLITZ_ACCESS_ROLE_ID')
    expect(deploy).toContain('BLITZ_RULES_CHANNEL_ID')
    expect(deploy).toMatch(/Community mode is not needed/u)
    expect(deploy).not.toMatch(/make `#rules` the guild's Rules channel/u)
  })
})
