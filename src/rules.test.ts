import { describe, expect, it, vi } from 'vitest'

import {
  reactRoleChannelKey,
  REACT_ROLE_ANY,
  type Ddb,
  type DdbResult,
  type ReactRolePairing,
} from './ddb.ts'
import {
  handleScreening,
  rulesRoleFor,
  type ScreeningDeps,
  type ScreeningRoles,
} from './rules.ts'

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'
const USER = '333333333333333333'
const ROLE = '444444444444444444'

const ok = <T,>(value: T): DdbResult<T> => ({ ok: true, value })

function pairing(over: Partial<ReactRolePairing> = {}): ReactRolePairing {
  return {
    messageId: reactRoleChannelKey(CHANNEL),
    emoji: REACT_ROLE_ANY,
    roleId: ROLE,
    channelId: CHANNEL,
    guildId: GUILD,
    createdAt: 1,
    createdBy: USER,
    ...over,
  }
}

function reads(result: DdbResult<ReactRolePairing | null>): Pick<Ddb['reactRoles'], 'get'> & {
  get: ReturnType<typeof vi.fn<Ddb['reactRoles']['get']>>
} {
  return {
    get: vi.fn<Ddb['reactRoles']['get']>(() => Promise.resolve(result)),
  }
}

describe('the Rules access role', () => {
  it('is the channel-wide any-reaction pairing and nothing else', async () => {
    const table = reads(ok(pairing()))

    await expect(rulesRoleFor(table, GUILD, CHANNEL)).resolves.toEqual({
      found: true,
      roleId: ROLE,
      rulesChannelId: CHANNEL,
    })

    expect(table.get).toHaveBeenCalledWith(reactRoleChannelKey(CHANNEL), REACT_ROLE_ANY)
    expect(table.get).toHaveBeenCalledTimes(1)
  })

  it('does not read DynamoDB when the guild has no Rules channel', async () => {
    const table = reads(ok(pairing()))

    await expect(rulesRoleFor(table, GUILD, null)).resolves.toEqual({
      found: false,
      why: 'no-rules-channel',
      rulesChannelId: null,
    })
    expect(table.get).not.toHaveBeenCalled()
  })

  it('refuses a row belonging to another guild or channel', async () => {
    const wrongGuild = reads(ok(pairing({ guildId: '999999999999999999' })))
    const wrongChannel = reads(ok(pairing({ channelId: '888888888888888888' })))

    await expect(rulesRoleFor(wrongGuild, GUILD, CHANNEL)).resolves.toMatchObject({
      found: false,
      why: 'mismatched-pairing',
    })
    await expect(rulesRoleFor(wrongChannel, GUILD, CHANNEL)).resolves.toMatchObject({
      found: false,
      why: 'mismatched-pairing',
    })
  })
})

function screening(
  table: Pick<Ddb['reactRoles'], 'get'>,
  roles: ScreeningRoles,
): ScreeningDeps {
  return { guildId: GUILD, reactRoles: table, roles }
}

describe('membership screening completion', () => {
  it('grants the Rules access role on pending true to false', async () => {
    const table = reads(ok(pairing()))
    const add = vi.fn<ScreeningRoles['add']>(() => Promise.resolve())

    const result = await handleScreening(
      {
        guildId: GUILD,
        userId: USER,
        fromBot: false,
        wasPending: true,
        isPending: false,
        rulesChannelId: CHANNEL,
      },
      screening(table, { add }),
    )

    expect(result).toEqual({ did: 'granted', roleId: ROLE })
    expect(add).toHaveBeenCalledWith(USER, ROLE)
  })

  it('does nothing for ordinary member updates, bots, or another guild', async () => {
    const table = reads(ok(pairing()))
    const add = vi.fn<ScreeningRoles['add']>(() => Promise.resolve())
    const base = {
      guildId: GUILD,
      userId: USER,
      fromBot: false,
      wasPending: true,
      isPending: false,
      rulesChannelId: CHANNEL,
    }

    await expect(
      handleScreening({ ...base, wasPending: false }, screening(table, { add })),
    ).resolves.toEqual({ did: 'ignored', why: 'not-completed' })
    await expect(
      handleScreening({ ...base, fromBot: true }, screening(table, { add })),
    ).resolves.toEqual({ did: 'ignored', why: 'bot' })
    await expect(
      handleScreening(
        { ...base, guildId: '999999999999999999' },
        screening(table, { add }),
      ),
    ).resolves.toEqual({ did: 'ignored', why: 'other-guild' })

    expect(table.get).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })

  it('does not grant a role when the channel pairing is absent', async () => {
    const table = reads(ok(null))
    const add = vi.fn<ScreeningRoles['add']>(() => Promise.resolve())

    const result = await handleScreening(
      {
        guildId: GUILD,
        userId: USER,
        fromBot: false,
        wasPending: true,
        isPending: false,
        rulesChannelId: CHANNEL,
      },
      screening(table, { add }),
    )

    expect(result).toEqual({ did: 'failed', why: 'no-pairing' })
    expect(add).not.toHaveBeenCalled()
  })
})
