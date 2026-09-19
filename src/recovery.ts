import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  Events,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ActionRowData,
  type ButtonComponentData,
  type ButtonInteraction,
  type Client,
  type Guild,
  type PrivateThreadChannel,
} from 'discord.js'

import type { Config } from './config.ts'
import type { Ddb } from './ddb.ts'
import type { ProbationStart } from './discipline.ts'
import { launchInFlight } from './inflight.ts'
import { log } from './log.ts'
import { rulesRoleFor } from './rules.ts'

export const RECOVERY_REMINDER_MS = 60 * 60_000
export const RECOVERY_RETRY_MS = 5 * 60_000
export const RECOVERY_BUTTON_LABEL = 'Restore access'
export const RECOVERY_THREAD_REASON =
  'blitz-bot: private rapid-offense Rules warning'
export const RECOVERY_ROLE_REASON =
  'blitz-bot: restored member access from the Rules warning'
export const RECOVERY_CLOSE_REASON =
  'blitz-bot: member access restored'

const BUTTON_PREFIX = 'blitz:restore-access:'
const OPEN_THREAD_PREFIX = 'rules-access-'
const REMINDED_THREAD_PREFIX = 'rules-access-reminded-'
const RESTORED_THREAD_PREFIX = 'rules-access-restored-'
const SNOWFLAKE = /^\d{17,20}$/u

export interface RecoveryTarget {
  readonly userId: string
  readonly threadId: string
}

export interface RecoveryNotice {
  readonly userId: string
  readonly rulesChannelId: string
  readonly text: string
}

export interface RulesRecoveryDesk {
  open(notice: RecoveryNotice): Promise<void>
}

export interface RecoveryOptions {
  readonly now?: () => number
  readonly startProbation: (userId: string) => Promise<ProbationStart>
  readonly startProbationForRole: (
    userId: string,
    roleId: string,
  ) => Promise<ProbationStart | null>
}

export function recoveryButtonId(userId: string, threadId: string): string {
  return `${BUTTON_PREFIX}${userId}:${threadId}`
}

export function recoveryTarget(customId: string): RecoveryTarget | null {
  if (!customId.startsWith(BUTTON_PREFIX)) return null

  const [userId, threadId, extra] = customId.slice(BUTTON_PREFIX.length).split(':')
  if (
    extra !== undefined ||
    userId === undefined ||
    threadId === undefined ||
    !SNOWFLAKE.test(userId) ||
    !SNOWFLAKE.test(threadId)
  ) {
    return null
  }

  return { userId, threadId }
}

export function recoveryButtonRow(
  customId: string,
  disabled = false,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Success,
        customId,
        label: RECOVERY_BUTTON_LABEL,
        disabled,
      },
    ],
  }
}

export function recoveryReminder(userId: string): string {
  return `<@${userId}> Reminder: press **${RECOVERY_BUTTON_LABEL}** below to get back into the server.`
}

export function probationConfirmation(until: number): string {
  return `Access restored. Your probation ends <t:${Math.floor(until / 1000)}:R>. Until then, your next offense will result in an immediate ban from our Discord and FiveM servers.`
}

function openThreadName(userId: string): string {
  return `${OPEN_THREAD_PREFIX}${userId}`
}

function remindedThreadName(userId: string): string {
  return `${REMINDED_THREAD_PREFIX}${userId}`
}

function restoredThreadName(userId: string): string {
  return `${RESTORED_THREAD_PREFIX}${userId}`
}

function openThreadUser(name: string): string | null {
  if (!name.startsWith(OPEN_THREAD_PREFIX) || name.startsWith(REMINDED_THREAD_PREFIX)) {
    return null
  }

  const userId = name.slice(OPEN_THREAD_PREFIX.length)
  return SNOWFLAKE.test(userId) ? userId : null
}

function restoreFailure(adminRoleId: string | null): string {
  return adminRoleId === null
    ? 'I could not restore your access. Contact an admin.'
    : `I could not restore your access. Contact <@&${adminRoleId}>.`
}

async function editPrivateReply(
  interaction: ButtonInteraction,
  content: string,
): Promise<void> {
  await interaction.editReply({ content, allowedMentions: { parse: [] } })
}

/**
 * Own the private Rules thread, its restore button and its one-hour reminder.
 * The open/reminded thread-name transition is the restart-safe reminder mark.
 */
export function installRulesRecovery(
  client: Client,
  config: Config,
  ddb: Pick<Ddb, 'reactRoles'>,
  options: RecoveryOptions,
): RulesRecoveryDesk {
  const now = options.now ?? Date.now
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function cancel(threadId: string): void {
    const timer = timers.get(threadId)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(threadId)
  }

  async function close(thread: PrivateThreadChannel, userId: string): Promise<void> {
    cancel(thread.id)

    try {
      await thread.edit({
        name: restoredThreadName(userId),
        locked: true,
        archived: true,
        reason: RECOVERY_CLOSE_REASON,
      })
    } catch (error) {
      log('warn', 'member access was restored but the private Rules thread could not be closed', {
        user: userId,
        thread: thread.id,
        error,
      })
    }
  }

  async function alreadyRestored(
    thread: PrivateThreadChannel,
    userId: string,
  ): Promise<boolean> {
    try {
      const guild = await client.guilds.fetch(config.guildId)
      const role = await rulesRoleFor(ddb.reactRoles, config.guildId, guild.rulesChannelId)
      if (!role.found) return false

      const member = await guild.members.fetch(userId)
      if (!member.roles.cache.has(role.roleId)) return false

      await options.startProbationForRole(userId, role.roleId)
      await close(thread, userId)
      return true
    } catch (error) {
      log('warn', 'could not check access before the private Rules reminder', {
        user: userId,
        thread: thread.id,
        error,
      })
      return false
    }
  }

  async function remind(threadId: string, userId: string): Promise<void> {
    timers.delete(threadId)

    let thread: PrivateThreadChannel

    try {
      const channel = await client.channels.fetch(threadId)
      if (channel === null || channel.type !== ChannelType.PrivateThread) return
      if (openThreadUser(channel.name) !== userId) return
      if (await alreadyRestored(channel, userId)) return
      thread = channel

      const customId = recoveryButtonId(userId, channel.id)
      await channel.send({
        content: recoveryReminder(userId),
        components: [recoveryButtonRow(customId)],
        allowedMentions: { parse: [], users: [userId], roles: [] },
      })
    } catch (error) {
      log('warn', 'could not send the private Rules access reminder; retrying', {
        user: userId,
        thread: threadId,
        error,
      })
      schedule(threadId, userId, RECOVERY_RETRY_MS)
      return
    }

    try {
      await thread.setName(
        remindedThreadName(userId),
        'blitz-bot: sent the one-hour Rules access reminder',
      )
    } catch (error) {
      log('warn', 'the private Rules reminder was sent but its thread could not be marked', {
        user: userId,
        thread: threadId,
        error,
      })
    }
  }

  function schedule(threadId: string, userId: string, delay?: number): void {
    cancel(threadId)

    const timer = setTimeout(
      () => {
        launchInFlight(() =>
          remind(threadId, userId).catch((error: unknown) => {
            log('warn', 'the private Rules reminder handler threw', {
              user: userId,
              thread: threadId,
              error,
            })
          }),
        )
      },
      Math.max(0, delay ?? RECOVERY_REMINDER_MS),
    )
    timer.unref()
    timers.set(threadId, timer)
  }

  function scheduleThread(thread: PrivateThreadChannel, userId: string): void {
    const createdAt = thread.createdTimestamp ?? now()
    schedule(thread.id, userId, createdAt + RECOVERY_REMINDER_MS - now())
  }

  async function restore(
    interaction: ButtonInteraction,
    target: RecoveryTarget,
  ): Promise<void> {
    if (interaction.user.id !== target.userId) {
      await interaction.reply({
        content: 'This button belongs to another member.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      })
      return
    }

    if (
      interaction.guildId !== config.guildId ||
      interaction.channelId !== target.threadId
    ) {
      await interaction.reply({
        content: 'This access button is no longer valid.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      })
      return
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral })

    let access: {
      readonly guild: Guild
      readonly roleId: string
      readonly thread: PrivateThreadChannel
    }

    try {
      const guild = await client.guilds.fetch(config.guildId)
      const channel = await client.channels.fetch(target.threadId)
      if (
        channel === null ||
        channel.type !== ChannelType.PrivateThread ||
        channel.parentId !== guild.rulesChannelId ||
        channel.ownerId !== client.user?.id
      ) {
        await editPrivateReply(interaction, 'This access button is no longer valid.')
        return
      }

      const role = await rulesRoleFor(ddb.reactRoles, config.guildId, guild.rulesChannelId)
      if (!role.found) {
        log('error', 'the Rules access button could not resolve the access role', {
          user: target.userId,
          thread: target.threadId,
          reason: role.why,
        })
        await editPrivateReply(interaction, restoreFailure(config.adminRoleId))
        return
      }

      access = { guild, roleId: role.roleId, thread: channel }
    } catch (error) {
      log('error', 'the Rules access button could not restore member access', {
        user: target.userId,
        thread: target.threadId,
        error,
      })
      await editPrivateReply(interaction, restoreFailure(config.adminRoleId))
      return
    }

    let probation: ProbationStart
    try {
      probation = await options.startProbation(target.userId)
    } catch (error) {
      log('error', 'member access was not restored because probation could not be started', {
        user: target.userId,
        thread: target.threadId,
        error,
      })
      await editPrivateReply(interaction, restoreFailure(config.adminRoleId))
      return
    }

    try {
      await access.guild.members.addRole({
        user: target.userId,
        role: access.roleId,
        reason: RECOVERY_ROLE_REASON,
      })
    } catch (error) {
      log('error', 'probation started but the Rules access button could not restore access', {
        user: target.userId,
        thread: target.threadId,
        error,
      })
      await editPrivateReply(interaction, restoreFailure(config.adminRoleId))
      return
    }

    try {
      await editPrivateReply(interaction, probationConfirmation(probation.until))
    } catch (error) {
      log('warn', 'access was restored but the button confirmation could not be sent', {
        user: target.userId,
        thread: target.threadId,
        error,
      })
    }

    try {
      await interaction.message.edit({
        components: [recoveryButtonRow(interaction.customId, true)],
      })
    } catch (error) {
      log('warn', 'access was restored but the restore button could not be disabled', {
        user: target.userId,
        thread: target.threadId,
        error,
      })
    }

    await close(access.thread, target.userId)
  }

  client.once(Events.ClientReady, (ready) => {
    launchInFlight(() =>
      (async () => {
        const guild = ready.guilds.cache.get(config.guildId)
        if (guild === undefined || guild.rulesChannelId === null) return

        const channel = await client.channels.fetch(guild.rulesChannelId)
        if (channel === null || channel.type !== ChannelType.GuildText) return

        const active = await channel.threads.fetchActive()
        for (const thread of active.threads.values()) {
          if (
            thread.type !== ChannelType.PrivateThread ||
            thread.ownerId !== ready.user.id
          ) {
            continue
          }

          const userId = openThreadUser(thread.name)
          if (userId !== null) scheduleThread(thread as PrivateThreadChannel, userId)
        }
      })().catch((error: unknown) => {
        log('warn', 'private Rules recovery threads could not be resumed', { error })
      }),
    )
  })

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton()) return

    const target = recoveryTarget(interaction.customId)
    if (target === null) return

    launchInFlight(() =>
      restore(interaction, target).catch((error: unknown) => {
        log('error', 'the Rules access button handler threw', {
          user: interaction.user.id,
          thread: interaction.channelId,
          error,
        })
      }),
    )
  })

  return {
    async open(notice) {
      const channel = await client.channels.fetch(notice.rulesChannelId)
      if (channel === null || channel.type !== ChannelType.GuildText) {
        throw new Error(`cannot create a private Rules thread in ${notice.rulesChannelId}`)
      }

      const thread = (await channel.threads.create({
        name: openThreadName(notice.userId),
        type: ChannelType.PrivateThread,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        invitable: false,
        reason: RECOVERY_THREAD_REASON,
      })) as PrivateThreadChannel

      try {
        const customId = recoveryButtonId(notice.userId, thread.id)
        await thread.members.add(notice.userId)
        await thread.send({
          content: `<@${notice.userId}>\n\n${notice.text}`,
          components: [recoveryButtonRow(customId)],
          allowedMentions: { parse: [], users: [notice.userId], roles: [] },
        })
        scheduleThread(thread, notice.userId)
      } catch (error) {
        try {
          await thread.delete('blitz-bot: incomplete rapid-offense Rules warning')
        } catch (cleanupError) {
          log('warn', 'could not remove an incomplete rapid-offense Rules thread', {
            channel: notice.rulesChannelId,
            thread: thread.id,
            user: notice.userId,
            error: cleanupError,
          })
        }

        throw error
      }
    },
  }
}
