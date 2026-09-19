import { Events, type Client } from 'discord.js'

import type { Config } from './config.ts'
import {
  reactRoleChannelKey,
  REACT_ROLE_ANY,
  type Ddb,
  type DdbFailure,
} from './ddb.ts'
import { launchInFlight } from './inflight.ts'
import { log } from './log.ts'

/**
 * The access role is not a second configuration value. It is the role already
 * paired with any reaction on any message in the guild's Rules channel.
 */
export type RulesRoleResult =
  | { readonly found: true; readonly roleId: string; readonly rulesChannelId: string }
  | {
      readonly found: false
      readonly why: 'no-rules-channel' | 'no-pairing' | 'mismatched-pairing'
      readonly rulesChannelId: string | null
    }
  | {
      readonly found: false
      readonly why: 'read'
      readonly rulesChannelId: string
      readonly failure: DdbFailure
    }

/**
 * Find the one channel-wide, any-emoji pairing that defines member access.
 *
 * This deliberately does not call `pairingFor`: screening has no message or
 * emoji whose more-specific pairings should take precedence.
 */
export async function rulesRoleFor(
  reads: Pick<Ddb['reactRoles'], 'get'>,
  guildId: string,
  rulesChannelId: string | null,
): Promise<RulesRoleResult> {
  if (rulesChannelId === null) {
    return { found: false, why: 'no-rules-channel', rulesChannelId: null }
  }

  const row = await reads.get(reactRoleChannelKey(rulesChannelId), REACT_ROLE_ANY)
  if (!row.ok) {
    return { found: false, why: 'read', rulesChannelId, failure: row.failure }
  }

  if (row.value === null) {
    return { found: false, why: 'no-pairing', rulesChannelId }
  }

  if (row.value.guildId !== guildId || row.value.channelId !== rulesChannelId) {
    return { found: false, why: 'mismatched-pairing', rulesChannelId }
  }

  return { found: true, roleId: row.value.roleId, rulesChannelId }
}

export const SCREENING_ROLE_REASON =
  'blitz-bot: completed Discord membership screening'

/** The Discord role write, separated so the transition is testable offline. */
export interface ScreeningRoles {
  add(userId: string, roleId: string): Promise<void>
}

/** A member update reduced to the fields that can make screening complete. */
export interface ScreeningChange {
  readonly guildId: string
  readonly userId: string
  readonly fromBot: boolean
  readonly wasPending: boolean
  readonly isPending: boolean
  readonly rulesChannelId: string | null
}

export interface ScreeningDeps {
  readonly guildId: string
  readonly reactRoles: Pick<Ddb['reactRoles'], 'get'>
  readonly roles: ScreeningRoles
}

export type ScreeningResult =
  | { readonly did: 'ignored'; readonly why: 'other-guild' | 'bot' | 'not-completed' }
  | { readonly did: 'granted'; readonly roleId: string }
  | {
      readonly did: 'failed'
      readonly why: 'no-rules-channel' | 'no-pairing' | 'mismatched-pairing' | 'read' | 'role'
    }

/** Grant access exactly once, on the pending true -> false transition. */
export async function handleScreening(
  change: ScreeningChange,
  deps: ScreeningDeps,
): Promise<ScreeningResult> {
  if (change.guildId !== deps.guildId) {
    return { did: 'ignored', why: 'other-guild' }
  }

  if (change.fromBot) {
    return { did: 'ignored', why: 'bot' }
  }

  if (!change.wasPending || change.isPending) {
    return { did: 'ignored', why: 'not-completed' }
  }

  const role = await rulesRoleFor(deps.reactRoles, deps.guildId, change.rulesChannelId)

  if (!role.found) {
    if (role.why === 'read') {
      log('error', 'membership screening completed but the Rules role could not be read', {
        user: change.userId,
        channel: role.rulesChannelId,
        failure: role.failure.kind,
        detail: role.failure.message,
      })
    } else {
      log('error', 'membership screening completed but no usable Rules role is configured', {
        user: change.userId,
        channel: role.rulesChannelId,
        reason: role.why,
      })
    }

    return { did: 'failed', why: role.why }
  }

  try {
    await deps.roles.add(change.userId, role.roleId)
  } catch (error) {
    log('error', 'membership screening completed but the access role could not be granted', {
      user: change.userId,
      role: role.roleId,
      error,
    })
    return { did: 'failed', why: 'role' }
  }

  log('info', 'membership screening completed and the access role was granted', {
    user: change.userId,
    role: role.roleId,
  })

  return { did: 'granted', roleId: role.roleId }
}

/** The live role write with a screening-specific audit reason. */
export function guildScreeningRoles(client: Client, guildId: string): ScreeningRoles {
  return {
    async add(userId, roleId) {
      const guild = await client.guilds.fetch(guildId)
      await guild.members.addRole({
        user: userId,
        role: roleId,
        reason: SCREENING_ROLE_REASON,
      })
    },
  }
}

/** Listen only for screening completion; startup does not reconcile old members. */
export function installRulesScreening(
  client: Client,
  config: Config,
  ddb: Pick<Ddb, 'reactRoles'>,
  roles: ScreeningRoles = guildScreeningRoles(client, config.guildId),
): void {
  const deps: ScreeningDeps = {
    guildId: config.guildId,
    reactRoles: ddb.reactRoles,
    roles,
  }

  client.on(Events.GuildMemberUpdate, (before, after) => {
    launchInFlight(() =>
      handleScreening(
        {
          guildId: after.guild.id,
          userId: after.id,
          fromBot: after.user.bot,
          wasPending: before.pending === true,
          isPending: after.pending === true,
          rulesChannelId: after.guild.rulesChannelId,
        },
        deps,
      ).then(
        () => undefined,
        (error: unknown) => {
          log('error', 'the membership screening handler threw', { user: after.id, error })
        },
      ),
    )
  })
}
