import { PermissionsBitField, type Client } from 'discord.js'

import type { Config } from './config.ts'
import type { Ddb } from './ddb.ts'
import { log } from './log.ts'
import { accessFault, roleStanding } from './rules.ts'

export const RAPID_OFFENSE_WINDOW_MS = 60_000
export const RAPID_OFFENSE_COUNT = 3
export const RAPID_TIMEOUT_MS = 10 * 60_000
export const BAN_ESCALATION_WINDOW_MS = 60 * 60_000

const MAX_MEMBERS = 500
const MAX_SEEN_MESSAGES = 100

export const DISCIPLINE_TIMEOUT_REASON =
  'blitz-bot: three qualifying message removals within 60 seconds'
export const DISCIPLINE_ACCESS_REASON =
  'blitz-bot: reset member access after rapid message removals'
export const DISCIPLINE_BAN_REASON =
  'blitz-bot: qualifying message removal during one-hour access-recovery probation'
export const DISCIPLINE_STATE_PREFIX = 'rapid-discipline:'

const DISCIPLINE_STATE_VERSION = 1

/** One successfully deleted message that can count toward escalation. */
export interface DisciplineOffense {
  readonly messageId: string
  readonly userId: string
  readonly channelId: string
  readonly reason: string
  readonly webhookId: string | null
  readonly fromBot: boolean
  readonly isOwner: boolean

  /**
   * Null when the message carried no member. The live action fetches the member
   * before counting in that case, so an unreadable admin is never sanctioned.
   */
  readonly administrator: boolean | null
}

/**
 * The access role and the Rules channel are both configured, so there is no
 * "unconfigured" outcome: the role is removed, or Discord refused the edit.
 */
export type AccessReset =
  | {
      readonly did: 'removed'
      readonly roleId: string
      readonly rulesChannelId: string
    }
  | {
      readonly did: 'failed'
      readonly rulesChannelId: string | null
    }

/** Absolute deadlines attached to the third-strike notice. */
export interface DisciplineTiming {
  readonly timeoutUntil: number
  /** Which probation paragraph, if any, the member can truthfully be shown. */
  readonly probation: 'after-recovery' | 'active' | 'unavailable'
}

export type DurableDisciplineState =
  | {
      readonly phase: 'awaiting-recovery'
      readonly roleId: string
    }
  | {
      readonly phase: 'probation'
      readonly until: number
    }

export interface DisciplineStore {
  load(userId: string): Promise<DurableDisciplineState | null>
  save(userId: string, state: DurableDisciplineState | null): Promise<void>
}

interface StoredDisciplineState {
  readonly version: typeof DISCIPLINE_STATE_VERSION
  readonly phase: 'idle' | DurableDisciplineState['phase']
  readonly roleId?: string
  readonly until?: number
}

export function parseDisciplineState(value: string): DurableDisciplineState | null {
  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('the stored rapid-discipline state is not valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the stored rapid-discipline state is not an object')
  }

  const row = parsed as Record<string, unknown>
  if (row.version !== DISCIPLINE_STATE_VERSION) {
    throw new Error('the stored rapid-discipline state has an unsupported version')
  }

  if (row.phase === 'idle') return null

  if (
    row.phase === 'awaiting-recovery' &&
    typeof row.roleId === 'string' &&
    row.roleId !== ''
  ) {
    return { phase: 'awaiting-recovery', roleId: row.roleId }
  }

  if (
    row.phase === 'probation' &&
    typeof row.until === 'number' &&
    Number.isSafeInteger(row.until) &&
    row.until > 0
  ) {
    return { phase: 'probation', until: row.until }
  }

  throw new Error('the stored rapid-discipline state has an invalid shape')
}

export function renderDisciplineState(state: DurableDisciplineState | null): string {
  const stored: StoredDisciplineState =
    state === null
      ? { version: DISCIPLINE_STATE_VERSION, phase: 'idle' }
      : { version: DISCIPLINE_STATE_VERSION, ...state }

  return JSON.stringify(stored)
}

function stateKey(userId: string): string {
  return `${DISCIPLINE_STATE_PREFIX}${userId}`
}

function ddbStateError(
  operation: 'read' | 'write',
  userId: string,
  failure: { readonly kind: string; readonly message: string },
): Error {
  return new Error(
    `could not ${operation} rapid-discipline state for ${userId}: ${failure.kind}: ${failure.message}`,
  )
}

export function ddbDisciplineStore(
  state: Pick<Ddb['botState'], 'get' | 'put'>,
): DisciplineStore {
  return {
    async load(userId) {
      const result = await state.get(stateKey(userId))
      if (!result.ok) throw ddbStateError('read', userId, result.failure)
      if (result.value === null) return null

      return parseDisciplineState(result.value.value)
    },

    async save(userId, durable) {
      const result = await state.put(stateKey(userId), renderDisciplineState(durable))
      if (!result.ok) throw ddbStateError('write', userId, result.failure)
    },
  }
}

export interface MemoryDisciplineStore extends DisciplineStore {
  read(userId: string): DurableDisciplineState | null
}

export function memoryDisciplineStore(
  initial: Readonly<Record<string, DurableDisciplineState>> = {},
): MemoryDisciplineStore {
  const rows = new Map(Object.entries(initial))

  return {
    load: (userId) => Promise.resolve(rows.get(userId) ?? null),
    save(userId, state) {
      if (state === null) rows.delete(userId)
      else rows.set(userId, state)
      return Promise.resolve()
    },
    read: (userId) => rows.get(userId) ?? null,
  }
}

/** Every external action the state machine may take. */
export interface DisciplineActions {
  eligible(offense: DisciplineOffense): Promise<boolean>
  timeout(offense: DisciplineOffense): Promise<void>
  /** `beforeRemove` must settle before the Discord role edit is attempted. */
  resetAccess(
    offense: DisciplineOffense,
    beforeRemove: (roleId: string) => Promise<void>,
  ): Promise<AccessReset>
  ban(offense: DisciplineOffense): Promise<void>
  notifyTimeout(
    offense: DisciplineOffense,
    access: AccessReset,
    timing: DisciplineTiming,
  ): Promise<void>
  report(line: string): Promise<void>
}

export type DisciplineResult =
  | {
      readonly did: 'ignored'
      readonly why: 'webhook' | 'bot' | 'owner' | 'administrator' | 'unreadable-member'
    }
  | { readonly did: 'duplicate' }
  | { readonly did: 'restricted' }
  | { readonly did: 'strike'; readonly count: number }
  | { readonly did: 'timed-out'; readonly access: AccessReset }
  | { readonly did: 'banned' }
  | { readonly did: 'failed'; readonly step: 'state' | 'timeout' | 'ban' }

export interface ProbationStart {
  readonly until: number
  readonly started: boolean
}

export interface DisciplineDesk {
  record(offense: DisciplineOffense): Promise<DisciplineResult>
  startProbation(userId: string): Promise<ProbationStart>
  startProbationForRole(userId: string, roleId: string): Promise<ProbationStart | null>
  remembered(): number
}

export interface DisciplineOptions {
  readonly now?: () => number
  readonly store?: DisciplineStore
}

interface MemberState {
  strikes: number[]
  escalatedUntil: number | null
  recoveryRoleId: string | null
  seen: Map<string, number>
}

/**
 * The 60-second strike and duplicate windows are bounded and process-local.
 * Awaiting recovery and active probation are point-read from durable storage.
 */
export function createDiscipline(
  actions: DisciplineActions,
  options: DisciplineOptions = {},
): DisciplineDesk {
  const now = options.now ?? Date.now
  const store = options.store ?? memoryDisciplineStore()
  const members = new Map<string, MemberState>()
  const queues = new Map<string, Promise<void>>()

  async function stateFor(userId: string): Promise<MemberState> {
    const existing = members.get(userId)
    if (existing !== undefined) {
      members.delete(userId)
      members.set(userId, existing)
      return existing
    }

    const durable = await store.load(userId)
    const at = now()

    const created: MemberState = {
      strikes: [],
      escalatedUntil:
        durable?.phase === 'probation' && durable.until > at
          ? durable.until
          : null,
      recoveryRoleId:
        durable?.phase === 'awaiting-recovery'
          ? durable.roleId
          : null,
      seen: new Map<string, number>(),
    }

    if (durable?.phase === 'probation' && durable.until <= at) {
      await store.save(userId, null)
    }

    members.set(userId, created)

    while (members.size > MAX_MEMBERS) {
      const oldest = members.keys().next()
      if (oldest.done) break
      members.delete(oldest.value)
    }

    return created
  }

  function rememberMessage(state: MemberState, messageId: string, at: number): boolean {
    const oldestUseful = at - BAN_ESCALATION_WINDOW_MS

    for (const [id, seenAt] of state.seen) {
      if (seenAt >= oldestUseful) break
      state.seen.delete(id)
    }

    if (state.seen.has(messageId)) return false

    state.seen.set(messageId, at)
    while (state.seen.size > MAX_SEEN_MESSAGES) {
      const oldest = state.seen.keys().next()
      if (oldest.done) break
      state.seen.delete(oldest.value)
    }

    return true
  }

  async function beginProbation(
    userId: string,
    state: MemberState,
    at: number,
  ): Promise<ProbationStart> {
    if (state.escalatedUntil !== null && at < state.escalatedUntil) {
      return { until: state.escalatedUntil, started: false }
    }

    const until = at + BAN_ESCALATION_WINDOW_MS
    await store.save(userId, { phase: 'probation', until })

    state.strikes = []
    state.recoveryRoleId = null
    state.escalatedUntil = until
    return { until, started: true }
  }

  function enqueue<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(userId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )

    queues.set(userId, tail)
    void tail.finally(() => {
      if (queues.get(userId) === tail) queues.delete(userId)
    })

    return result
  }

  async function safeReport(line: string): Promise<void> {
    try {
      await actions.report(line)
    } catch (error) {
      log('error', 'could not report rapid-offense escalation', { error })
    }
  }

  async function stateUnavailable(
    userId: string,
    operation: string,
    error: unknown,
  ): Promise<DisciplineResult> {
    log('error', 'rapid-offense durable state is unavailable', {
      user: userId,
      operation,
      error,
    })
    await safeReport(
      `Rapid-offense state failure. Could not ${operation} durable discipline state for <@${userId}>.`,
    )
    return { did: 'failed', step: 'state' }
  }

  async function process(offense: DisciplineOffense): Promise<DisciplineResult> {
    if (offense.webhookId !== null) return { did: 'ignored', why: 'webhook' }
    if (offense.fromBot) return { did: 'ignored', why: 'bot' }
    if (offense.isOwner) return { did: 'ignored', why: 'owner' }
    if (offense.administrator === true) return { did: 'ignored', why: 'administrator' }

    if (offense.administrator === null) {
      let eligible = false

      try {
        eligible = await actions.eligible(offense)
      } catch (error) {
        log('error', 'could not determine whether a member may be sanctioned', {
          user: offense.userId,
          error,
        })
      }

      if (!eligible) return { did: 'ignored', why: 'unreadable-member' }
    }

    const at = now()
    let state: MemberState
    try {
      state = await stateFor(offense.userId)
    } catch (error) {
      return stateUnavailable(offense.userId, 'read', error)
    }

    if (!rememberMessage(state, offense.messageId, at)) return { did: 'duplicate' }

    if (state.recoveryRoleId !== null) return { did: 'restricted' }

    if (state.escalatedUntil !== null && at < state.escalatedUntil) {
      try {
        await actions.ban(offense)
      } catch (error) {
        log('error', 'rapid-offense Discord ban failed', {
          user: offense.userId,
          channel: offense.channelId,
          reason: offense.reason,
          error,
        })
        await safeReport(
          `Rapid-offense escalation failed. Could not ban <@${offense.userId}> after another qualifying removal during access-recovery probation.`,
        )
        return { did: 'failed', step: 'ban' }
      }

      try {
        await store.save(offense.userId, null)
        members.delete(offense.userId)
      } catch (error) {
        log('error', 'Discord ban succeeded but durable probation state could not be cleared', {
          user: offense.userId,
          error,
        })
        await safeReport(
          `Rapid-offense state failure. Banned <@${offense.userId}>, but its durable probation row could not be cleared.`,
        )
      }

      await safeReport(
        `Rapid-offense escalation. Banned <@${offense.userId}> after another qualifying removal during access-recovery probation; Discord's audit event will carry the ban into FiveM.`,
      )
      return { did: 'banned' }
    }

    if (state.escalatedUntil !== null) {
      try {
        await store.save(offense.userId, null)
      } catch (error) {
        return stateUnavailable(offense.userId, 'clear expired', error)
      }

      state.escalatedUntil = null
      state.strikes = []
    }

    state.strikes = state.strikes.filter((strike) => at - strike < RAPID_OFFENSE_WINDOW_MS)
    state.strikes.push(at)

    if (state.strikes.length < RAPID_OFFENSE_COUNT) {
      return { did: 'strike', count: state.strikes.length }
    }

    try {
      await actions.timeout(offense)
    } catch (error) {
      log('error', 'rapid-offense timeout failed', {
        user: offense.userId,
        channel: offense.channelId,
        reason: offense.reason,
        error,
      })
      await safeReport(
        `Rapid-offense escalation failed. Could not timeout <@${offense.userId}> after three qualifying removals in 60 seconds.`,
      )
      return { did: 'failed', step: 'timeout' }
    }

    state.strikes = []
    let access: AccessReset
    let preparedRoleId: string | null = null
    try {
      access = await actions.resetAccess(offense, async (roleId) => {
        await store.save(offense.userId, {
          phase: 'awaiting-recovery',
          roleId,
        })
        state.recoveryRoleId = roleId
        state.escalatedUntil = null
        preparedRoleId = roleId
      })

      if (
        access.did === 'removed' &&
        preparedRoleId !== access.roleId
      ) {
        throw new Error('the access role was removed before recovery state was saved')
      }
    } catch (error) {
      log('error', 'rapid-offense access reset threw', { user: offense.userId, error })
      access = { did: 'failed', rulesChannelId: null }
    }

    let probationStateFailed = false
    if (access.did !== 'removed') {
      try {
        await beginProbation(offense.userId, state, at)
      } catch (error) {
        probationStateFailed = true
        log('error', 'probation could not be made durable and was not started', {
          user: offense.userId,
          error,
        })
        await safeReport(
          `Rapid-offense state failure. Probation for <@${offense.userId}> could not be saved.`,
        )
      }
    }

    const timing: DisciplineTiming = {
      timeoutUntil: at + RAPID_TIMEOUT_MS,
      probation:
        access.did === 'removed'
          ? 'after-recovery'
          : probationStateFailed
            ? 'unavailable'
            : 'active',
    }

    try {
      await actions.notifyTimeout(offense, access, timing)
    } catch (error) {
      log('error', 'could not tell the member about rapid-offense escalation', {
        user: offense.userId,
        error,
      })
      await safeReport(
        `Rapid-offense notice failed. Could not privately notify <@${offense.userId}> after the timeout.`,
      )
    }

    const accessSummary =
      access.did === 'removed'
        ? `access role <@&${access.roleId}> removed`
        : 'access role removal failed'

    const probationSummary =
      access.did === 'removed'
        ? 'The one-hour probation starts when the member presses Restore access'
        : probationStateFailed
          ? 'The one-hour probation could not be saved and did not start'
          : 'The one-hour probation started immediately because access was not removed'

    await safeReport(
      `Rapid-offense escalation. Timed out <@${offense.userId}> for 10 minutes after three qualifying removals in 60 seconds; ${accessSummary}. ${probationSummary}; another qualifying removal during probation will result in a Discord ban.`,
    )

    return { did: 'timed-out', access }
  }

  return {
    record(offense) {
      return enqueue(offense.userId, () => process(offense))
    },

    startProbation(userId) {
      return enqueue(userId, async () => {
        const state = await stateFor(userId)
        return beginProbation(userId, state, now())
      })
    },

    startProbationForRole(userId, roleId) {
      return enqueue(userId, async () => {
        const state = await stateFor(userId)
        if (state.recoveryRoleId !== roleId) return null

        return beginProbation(userId, state, now())
      })
    },

    remembered() {
      return members.size
    },
  }
}

export interface DisciplineDelivery {
  notifyTimeout(
    offense: DisciplineOffense,
    access: AccessReset,
    timing: DisciplineTiming,
  ): Promise<void>
  report(line: string): Promise<void>
}

/**
 * Build the Discord side effects while leaving state in `createDiscipline`. The
 * role removed is `config.accessRoleId`, the one screening grants and the
 * Restore access button gives back; nothing is looked up.
 */
export function discordDisciplineActions(
  client: Client,
  config: Config,
  delivery: DisciplineDelivery,
): DisciplineActions {
  return {
    async eligible(offense) {
      try {
        const guild = await client.guilds.fetch(config.guildId)
        const member = await guild.members.fetch(offense.userId)

        return !(
          member.user.bot ||
          member.id === guild.ownerId ||
          member.permissions.has(PermissionsBitField.Flags.Administrator) ||
          (config.adminRoleId !== null && member.roles.cache.has(config.adminRoleId))
        )
      } catch (error) {
        log('error', 'member could not be checked for rapid-offense sanctions', {
          user: offense.userId,
          error,
        })
        return false
      }
    },

    async timeout(offense) {
      const guild = await client.guilds.fetch(config.guildId)
      const member = await guild.members.fetch(offense.userId)

      if (!member.moderatable) {
        throw new Error(`member ${offense.userId} is not moderatable`)
      }

      await member.timeout(RAPID_TIMEOUT_MS, DISCIPLINE_TIMEOUT_REASON)
    },

    async resetAccess(offense, beforeRemove) {
      let guild

      try {
        guild = await client.guilds.fetch(config.guildId)
      } catch (error) {
        log('error', 'could not fetch the guild while resetting member access', {
          user: offense.userId,
          error,
        })
        return { did: 'failed', rulesChannelId: null }
      }

      const roleId = config.accessRoleId
      await beforeRemove(roleId)

      try {
        await guild.members.removeRole({
          user: offense.userId,
          role: roleId,
          reason: DISCIPLINE_ACCESS_REASON,
        })
      } catch (error) {
        log('error', 'could not remove the access role during rapid-offense escalation', {
          user: offense.userId,
          role: roleId,
          fault: accessFault(roleStanding(client, config.guildId, roleId)),
          error,
        })
        return { did: 'failed', rulesChannelId: config.rulesChannelId }
      }

      return {
        did: 'removed',
        roleId,
        rulesChannelId: config.rulesChannelId,
      }
    },

    async ban(offense) {
      const guild = await client.guilds.fetch(config.guildId)
      await guild.members.ban(offense.userId, {
        deleteMessageSeconds: 0,
        reason: DISCIPLINE_BAN_REASON,
      })
    },

    notifyTimeout: delivery.notifyTimeout,
    report: delivery.report,
  }
}
