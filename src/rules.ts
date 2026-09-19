import { ChannelType, Events, PermissionsBitField, type Client } from 'discord.js'

import { roleReadiness, type RoleProblem, type RoleReadiness } from './banrole.ts'
import type { Config } from './config.ts'
import {
  reactRoleChannelKey,
  REACT_ROLE_ANY,
  type Ddb,
  type DdbFailure,
  type DdbFailureKind,
} from './ddb.ts'
import type { DisciplineDesk } from './discipline.ts'
import { launchInFlight } from './inflight.ts'
import { latch, type Latch } from './latch.ts'
import { log } from './log.ts'
import type { PairingSource } from './reactroles.ts'

/**
 * Member access is one configured role and one configured channel:
 * `config.accessRoleId`, which the owner calls the members role, and
 * `config.rulesChannelId`. Neither is read from Discord's Community settings,
 * which this guild does not use, and the role is never looked up in DynamoDB.
 * Screening grants it, the three-strike removal takes it, and the Restore access
 * button gives it back, so all three edit the same role by construction.
 */

/**
 * What an operator is told when the bot cannot edit the access role, and where
 * it is fixed. A `Record` so a seventh `RoleProblem` is a compile error here.
 */
export const ACCESS_ROLE_PROBLEM: Record<RoleProblem, string> = {
  'no-guild':
    'the guild is not in the cache, so the access role in BLITZ_ACCESS_ROLE_ID cannot be checked',
  'no-role':
    'BLITZ_ACCESS_ROLE_ID names no role in this guild, so screening, the three-strike removal and the Restore access button cannot change member access. Set it in /opt/blitz-bot/.env to the members role id',
  'no-self':
    "the bot's own membership is not in the cache, so the access role in BLITZ_ACCESS_ROLE_ID cannot be checked",
  'no-permission':
    'the bot does not hold Manage Roles, so screening, the three-strike removal and the Restore access button cannot change member access. Grant it to the bot in Server Settings, Roles',
  'managed-role':
    'the access role in BLITZ_ACCESS_ROLE_ID belongs to an integration, so nobody can be given it. Set BLITZ_ACCESS_ROLE_ID in /opt/blitz-bot/.env to the members role id',
  'role-too-high':
    "the access role in BLITZ_ACCESS_ROLE_ID sits above the bot's own role, so screening, the three-strike removal and the Restore access button cannot change member access. Drag the bot's role above it in Server Settings, Roles",
}

/** Said once, when a held access-role fault is observed to have stopped. */
export const ACCESS_ROLE_READY =
  'the access role in BLITZ_ACCESS_ROLE_ID can be assigned now, so screening, the three-strike removal and the Restore access button can change member access again'

/**
 * Whether the bot could put `roleId` on a member right now. Reads caches and
 * makes no request.
 *
 * ./banrole.ts's `roleReadiness` decides, exactly as `/reactrole` has it
 * decide; `comparePositionTo` is discord.js's tie-break on equal positions, so
 * it is called here where the live objects are.
 */
export function roleStanding(client: Client, guildId: string, roleId: string): RoleReadiness {
  const guild = client.guilds.cache.get(guildId) ?? null
  if (guild === null) return roleReadiness({ guild: false, role: null, self: null })

  const role = guild.roles.cache.get(roleId) ?? null
  const me = guild.members.me

  return roleReadiness({
    guild: true,
    role: role === null ? null : { managed: role.managed, position: role.position },
    self:
      me === null
        ? null
        : {
            manageRoles: me.permissions.has(PermissionsBitField.Flags.ManageRoles),
            highestPosition: me.roles.highest.position,
            above: role !== null && me.roles.highest.comparePositionTo(role) > 0,
          },
  })
}

/**
 * The configuration fault behind a failed access-role edit, for the `fault`
 * field. Undefined when the role looked assignable, so the line carries
 * Discord's own `error` and no guess.
 */
export function accessFault(standing: RoleReadiness): string | undefined {
  return standing.ok ? undefined : ACCESS_ROLE_PROBLEM[standing.why]
}

export const SCREENING_ROLE_REASON =
  'blitz-bot: completed Discord membership screening'

/** The Discord role write, separated so the transition is testable offline. */
export interface ScreeningRoles {
  add(userId: string, roleId: string): Promise<void>

  /** Asked only after a failed grant, to name the fault. Reads caches. */
  standing(roleId: string): RoleReadiness
}

/** A member update reduced to the fields that can make screening complete. */
export interface ScreeningChange {
  readonly guildId: string
  readonly userId: string
  readonly fromBot: boolean
  readonly wasPending: boolean
  readonly isPending: boolean
}

/** No DynamoDB here: the role is the configured one and nothing is looked up. */
export interface ScreeningDeps {
  readonly guildId: string
  readonly accessRoleId: string
  readonly roles: ScreeningRoles
}

export type ScreeningResult =
  | { readonly did: 'ignored'; readonly why: 'other-guild' | 'bot' | 'not-completed' }
  | { readonly did: 'granted'; readonly roleId: string }
  | { readonly did: 'failed'; readonly why: RoleProblem | 'refused' }

/** Grant the configured access role exactly once, on the pending true -> false transition. */
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

  try {
    await deps.roles.add(change.userId, deps.accessRoleId)
  } catch (error) {
    // Startup does not reconcile old members, so this member stays without
    // access until somebody acts. `fault` names a configuration fault when there
    // is one; otherwise `error` is Discord's own reason.
    const standing = deps.roles.standing(deps.accessRoleId)

    log(
      'error',
      'membership screening completed but the access role could not be granted, so the member has to be given it by hand',
      {
        user: change.userId,
        role: deps.accessRoleId,
        fault: accessFault(standing),
        error,
      },
    )

    return { did: 'failed', why: standing.ok ? 'refused' : standing.why }
  }

  log('info', 'membership screening completed and the access role was granted', {
    user: change.userId,
    role: deps.accessRoleId,
  })

  return { did: 'granted', roleId: deps.accessRoleId }
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

    standing(roleId) {
      return roleStanding(client, guildId, roleId)
    },
  }
}

/** Listen only for screening completion; startup does not reconcile old members. */
export function installRulesScreening(
  client: Client,
  config: Config,
  roles: ScreeningRoles = guildScreeningRoles(client, config.guildId),
): void {
  const deps: ScreeningDeps = {
    guildId: config.guildId,
    accessRoleId: config.accessRoleId,
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

/**
 * The legacy backup path: a reaction in the configured Rules channel that the
 * channel's any-message, any-reaction `/reactrole` pairing matched. Only that
 * pairing takes part in recovery; every other reaction role is left alone.
 *
 * The pairing keeps its own role. It restores pending access, and starts
 * probation first, only when that role is the configured access role, because
 * `startProbationForRole` compares it with the role recorded at removal. The
 * startup check warns when the two disagree.
 */
export function legacyRulesRecovery(
  config: Pick<Config, 'rulesChannelId'>,
  discipline: Pick<DisciplineDesk, 'startProbationForRole'>,
): (userId: string, roleId: string, channelId: string, how: PairingSource) => Promise<void> {
  return async (userId, roleId, channelId, how) => {
    if (channelId !== config.rulesChannelId || how !== 'channel-any') return

    await discipline.startProbationForRole(userId, roleId)
  }
}

/* ------------------------------------------------------------------ *
 * The startup check.
 * ------------------------------------------------------------------ */

/**
 * How long a held fault waits before the check looks at it again.
 *
 * A healthy start is checked once and never again. A fault is looked at again
 * on this interval only while it is held, or while the guild or the pairing
 * could not be read, which is what lets the all-clear say that a role dragged
 * into place or a pairing fixed has actually worked.
 */
export const ACCESS_RECHECK_MS = 5 * 60_000

export type RulesChannelLook = 'ok' | 'missing' | 'not-text'

/** What the check reads off the cached guild. */
export interface AccessLook {
  readonly role: RoleReadiness
  readonly channel: RulesChannelLook
}

export const RULES_CHANNEL_PROBLEM: Record<Exclude<RulesChannelLook, 'ok'>, string> = {
  missing:
    'BLITZ_RULES_CHANNEL_ID names no channel in this guild, so the three-strike warning cannot open its private Restore access thread. Set it in /opt/blitz-bot/.env to the Rules channel id',
  'not-text':
    'BLITZ_RULES_CHANNEL_ID names a channel that is not a text channel, so the three-strike warning cannot open its private Restore access thread there. Set it in /opt/blitz-bot/.env to the Rules channel id',
}

export const RULES_CHANNEL_READY =
  'BLITZ_RULES_CHANNEL_ID names a text channel in this guild now, so the three-strike warning can open its private Restore access thread'

/** The legacy pairing grants a different role. A `warn`: the backup path is optional. */
export const PAIRING_DISAGREES =
  "the Rules channel's any-reaction /reactrole pairing grants a different role from BLITZ_ACCESS_ROLE_ID, so reacting in the Rules channel does not restore member access. Run /reactrole with message any, emoji any, the members role and the Rules channel to make them agree"

export const PAIRING_AGREES =
  "the Rules channel's any-reaction /reactrole pairing no longer grants a role other than BLITZ_ACCESS_ROLE_ID"

/**
 * The pairing reads that stay failed until a person acts, each with its own fix
 * and its own all-clear, the split ./reactroles.ts makes in `READ_FAULT`. Every
 * other kind is transient and is said per pass rather than latched.
 */
const PAIRING_READ_FAULT: Partial<
  Record<DdbFailureKind, { readonly msg: string; readonly cleared: string }>
> = {
  'no-such-table': {
    msg: "the reaction role table does not exist, so the Rules channel's /reactrole pairing cannot be checked against BLITZ_ACCESS_ROLE_ID. docs/aws-notes.md has the command that creates it",
    cleared:
      "the reaction role table answers now, so the Rules channel's /reactrole pairing is checked against BLITZ_ACCESS_ROLE_ID",
  },

  denied: {
    msg: "the bot is not allowed to read the reaction role table, so the Rules channel's /reactrole pairing cannot be checked against BLITZ_ACCESS_ROLE_ID. dynamodb:GetItem has to be granted on that table",
    cleared:
      "the bot is allowed to read the reaction role table now, so the Rules channel's /reactrole pairing is checked against BLITZ_ACCESS_ROLE_ID",
  },

  credentials: {
    msg: "the bot has no AWS credentials to read the reaction role table with, so the Rules channel's /reactrole pairing cannot be checked against BLITZ_ACCESS_ROLE_ID",
    cleared:
      "the reaction role table can be read with the bot's AWS credentials again, so the Rules channel's /reactrole pairing is checked against BLITZ_ACCESS_ROLE_ID",
  },
}

/** A transient read, said once per pass. Not a misconfiguration and not latched. */
export const PAIRING_UNREAD =
  "the Rules channel's /reactrole pairing could not be read this time, so it was not checked against BLITZ_ACCESS_ROLE_ID"

/** ./reactroles.ts's `levelFor`: a timeout or an unrecognized error may pass. */
function unreadLevel(failure: DdbFailure): 'warn' | 'error' {
  return failure.kind === 'timeout' || failure.kind === 'error' ? 'warn' : 'error'
}

export interface AccessCheckDeps {
  readonly config: Pick<Config, 'accessRoleId' | 'rulesChannelId'>

  /**
   * Null when the guild is not in the cache; the ready listener's halt line
   * covers that. `unavailable` when it is cached but Discord has not sent it,
   * which is a Discord outage and not a misconfiguration.
   */
  readonly look: () => AccessLook | 'unavailable' | null
  readonly reads: Pick<Ddb['reactRoles'], 'get'>

  /**
   * One slot per condition, held for the life of the process. Every field on a
   * latched line is the same on every repeat: ids from the config and the row,
   * never a member or a time.
   */
  readonly role: Latch
  readonly channel: Latch
  readonly pairing: Latch
}

/**
 * One pass over what member access depends on: the access role can be assigned,
 * the Rules channel is a text channel in the guild, and the Rules channel's
 * legacy pairing, if there is one, grants the same role. A missing pairing is
 * not a fault; the backup is optional. Resolves whether to look again: a fault
 * is held, or the guild or the pairing could not be read this time.
 */
export async function checkAccess(deps: AccessCheckDeps): Promise<boolean> {
  let look: AccessLook | 'unavailable' | null

  try {
    look = deps.look()
  } catch (error) {
    log('error', 'the access check could not read the cached guild', { error })
    return false
  }

  if (look === null) return false

  // An unavailable guild has empty role and channel caches, so every check
  // below would name a fault that is not there. Nothing is latched or said, and
  // the next pass looks again.
  if (look === 'unavailable') return true

  const { accessRoleId, rulesChannelId } = deps.config
  let held = false

  if (look.role.ok) {
    deps.role.clear()
  } else {
    held = true
    deps.role.fault({
      level: 'error',
      msg: ACCESS_ROLE_PROBLEM[look.role.why],
      cleared: ACCESS_ROLE_READY,
      fields: { role: accessRoleId },
    })
  }

  if (look.channel === 'ok') {
    deps.channel.clear()
  } else {
    held = true
    deps.channel.fault({
      level: 'error',
      msg: RULES_CHANNEL_PROBLEM[look.channel],
      cleared: RULES_CHANNEL_READY,
      fields: { channel: rulesChannelId },
    })
  }

  const row = await deps.reads.get(reactRoleChannelKey(rulesChannelId), REACT_ROLE_ANY)

  if (!row.ok) {
    const permanent = PAIRING_READ_FAULT[row.failure.kind]

    if (permanent === undefined) {
      // Not known either way, so the slot is left as it was and the pairing is
      // asked again next pass; a disagreement held from an earlier pass still
      // gets its all-clear that way.
      log(unreadLevel(row.failure), PAIRING_UNREAD, {
        table: row.failure.table,
        failure: row.failure.kind,
        detail: row.failure.message,
      })
      return true
    }

    deps.pairing.fault({
      level: 'error',
      msg: permanent.msg,
      cleared: permanent.cleared,
      fields: { table: row.failure.table, detail: row.failure.message },
    })
    return true
  }

  if (row.value !== null && row.value.roleId !== accessRoleId) {
    deps.pairing.fault({
      level: 'warn',
      msg: PAIRING_DISAGREES,
      cleared: PAIRING_AGREES,
      fields: { channel: rulesChannelId, pairing: row.value.roleId, access: accessRoleId },
    })
    return true
  }

  deps.pairing.clear()
  return held
}

/** The live half of `AccessLook`, off the caches the gateway keeps. */
function lookAtAccess(
  client: Client,
  config: Pick<Config, 'guildId' | 'accessRoleId' | 'rulesChannelId'>,
): AccessLook | 'unavailable' | null {
  const guild = client.guilds.cache.get(config.guildId)
  if (guild === undefined) return null

  // discord.js emits ClientReady after `waitGuildTimeout` with a guild Discord
  // has not sent still in the cache, marked unavailable and with nothing in it.
  if (!guild.available) return 'unavailable'

  const channel = guild.channels.cache.get(config.rulesChannelId)

  return {
    role: roleStanding(client, config.guildId, config.accessRoleId),
    channel:
      channel === undefined
        ? 'missing'
        : channel.type === ChannelType.GuildText
          ? 'ok'
          : 'not-text',
  }
}

/**
 * Check member access once the client is ready, and again only while a fault
 * is held. Nothing here can block or fail startup: the pass is not awaited by
 * the ready listener, and anything it throws is caught and logged.
 */
export function installAccessCheck(
  client: Client,
  config: Config,
  reads: Pick<Ddb['reactRoles'], 'get'>,
  recheckMs: number = ACCESS_RECHECK_MS,
): void {
  const deps: AccessCheckDeps = {
    config,
    look: () => lookAtAccess(client, config),
    reads,
    role: latch(),
    channel: latch(),
    pairing: latch(),
  }

  const pass = (): void => {
    void checkAccess(deps).then(
      (held) => {
        if (held) setTimeout(pass, recheckMs).unref()
      },
      (error: unknown) => {
        log('error', 'the access check threw', { error })
      },
    )
  }

  client.once(Events.ClientReady, () => {
    pass()
  })
}
