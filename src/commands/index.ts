import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  type ChatInputApplicationCommandData,
  type Client,
} from 'discord.js'

import type { Config } from '../config.ts'
import { log } from '../log.ts'
import {
  runCommand,
  TARGET_OPTION,
  type BotCommand,
  type Invocation,
  type Responder,
} from './command.ts'
import { help } from './help.ts'

/**
 * The command list, and the half of the slash-command foundation that touches
 * discord.js.
 *
 * ADDING A COMMAND IS A NEW FILE AND ONE LINE. Import it, put it in the array
 * below, and registration, the gate, the defer and the reply all follow from
 * the record it exports. There is no second place to remember.
 */
export const COMMANDS: readonly BotCommand[] = [help]

/**
 * What Discord is told about one command.
 *
 * `defaultMemberPermissions` IS DERIVED FROM `adminOnly` AND IS NEVER WRITTEN
 * IN A COMMAND FILE. Two fields that have to agree are two fields that
 * eventually do not, and the failure is silent in the worst direction: a
 * command marked `adminOnly` whose data forgot the permission is visible to
 * everybody in the client, and every one of them gets a refusal from a command
 * they were shown. Deriving it means "admin-only" is one word in one place.
 *
 * `0n` HIDES THE COMMAND AND DOES NOT GUARD IT. It is Discord's DEFAULT member
 * permission — the initial value of a setting, not the setting itself. Anyone
 * with Manage Server can go to Server Settings -> Integrations, find this
 * application, and grant any command back to @everyone or to a role of their
 * choosing; the bot is not told, and the interaction that arrives afterwards
 * looks exactly like an admin's. So this fails open on a path that needs no
 * exploit at all, and the real gate is `refusalFor` in ./command.ts.
 *
 * `null` RATHER THAN LEAVING IT OFF for a command that is open to everybody.
 * Registration is a bulk PUT, so an absent field means "reset to the default"
 * anyway — writing it says which of the two we meant, and makes a command
 * flipped from admin-only back to open actually get un-hidden.
 */
export function commandData(command: BotCommand): ChatInputApplicationCommandData {
  return { ...command.data, defaultMemberPermissions: command.adminOnly ? 0n : null }
}

/** The guild, reduced to the one thing registration does to it. */
export interface CommandRegistry {
  set: (commands: readonly ChatInputApplicationCommandData[]) => Promise<unknown>
}

export interface RegistrationGuild {
  readonly id: string
  readonly name: string
  readonly commands: CommandRegistry
}

/**
 * Put the whole command list into one guild.
 *
 * `set` IS A BULK PUT, WHICH IS WHY THIS CAN RUN AT EVERY BOOT. It replaces the
 * guild's command list with the array handed to it, so it creates what is new,
 * updates what changed and DELETES what is no longer here, in one request. That
 * makes it idempotent: registration cannot drift from the code, a command
 * deleted from this repo actually disappears from the guild, and there is no
 * separate "deploy commands" script that somebody has to remember to run — the
 * thing that has to happen anyway (a restart) is the thing that does it.
 *
 * `create` PER COMMAND WAS THE ALTERNATIVE AND IT ONLY ADDS. A renamed command
 * leaves the old name registered forever, and the guild ends up with a list
 * that is the union of every version this bot has ever had.
 *
 * GUILD-SCOPED, AND THIS FUNCTION CANNOT DO ANYTHING ELSE — it is handed a
 * guild and has no route to the application. That is deliberate and it is the
 * point of the parameter. THIS DISCORD APPLICATION IS SHARED WITH THE
 * RINGMASTER CONSOLE, so a global command would appear in every guild the app
 * is ever installed into, including ones this bot is not in and has no business
 * offering commands to. Global registration also propagates for up to an hour,
 * which turns every change to a command name or description into a wait long
 * enough that people restart the bot twice thinking it did not work. A guild
 * command is live the moment this request returns.
 */
export async function registerCommands(guild: RegistrationGuild): Promise<void> {
  const data = COMMANDS.map(commandData)

  await guild.commands.set(data)

  // Info rather than silence: the list is the one thing about this bot that
  // lives on Discord's side rather than in the repo, so a boot that registered
  // a different set than expected is worth being able to see in the journal.
  log('info', 'slash commands registered', {
    guild: guild.id,
    commands: data.map((entry) => entry.name).join(','),
  })
}

/**
 * The invoking member as an interaction can carry them, which is two shapes.
 *
 * DISCORD SENDS THE ROLE IDS AS AN ARRAY ON EVERY INTERACTION, and that is the
 * whole basis of the gate: no fetch, no cache, no `GuildMembers` intent.
 * discord.js hands that array through as-is when it has no cached member, and
 * as a `GuildMemberRoleManager` when it does — same information, two types, and
 * which one arrives depends on nothing this bot controls. Naming both here is
 * what stops the gate reading `undefined` for a member who is in the cache and
 * refusing an admin that Discord already told us about.
 */
export interface InteractionMember {
  readonly roles: readonly string[] | { readonly cache: ReadonlyMap<string, unknown> }
}

/** The role ids off an interaction's member, or null when it carried none. */
export function roleIdsOf(member: InteractionMember | null): readonly string[] | null {
  if (member === null) return null

  const roles = member.roles
  return 'cache' in roles ? [...roles.cache.keys()] : roles
}

/** One option as it arrived, reduced to what the target is read out of. */
export interface SuppliedOption {
  readonly type: number
  readonly user?: { readonly id: string } | null
}

/** A live chat-input interaction, as far as building an `Invocation` reads it. */
export interface CommandSource {
  readonly commandName: string
  readonly guildId: string | null
  readonly user: { readonly id: string }
  readonly member: InteractionMember | null
  readonly options: { get: (name: string) => SuppliedOption | null }
}

/**
 * The member a command was aimed at, or null.
 *
 * `get` AND A TYPE CHECK, NOT `getUser`. discord.js's `getUser` THROWS when an
 * option by that name exists and is not a user — so the day somebody adds a
 * command with, say, a string option named `user`, every invocation of it dies
 * before `runCommand` is reached. That throw would happen while building the
 * argument list, which is outside the promise the listener catches, so it would
 * escape into discord.js's own emit rather than becoming a reply. `get` answers
 * null for an option that is not there and never throws, and comparing the type
 * says what is actually meant: a target is a USER option by this name, and
 * anything else is not a target.
 */
function targetOf(options: CommandSource['options']): string | null {
  const option = options.get(TARGET_OPTION)

  if (option === null || option.type !== ApplicationCommandOptionType.User) return null
  return option.user?.id ?? null
}

/**
 * Reduce a live interaction to the record the gate and the handlers read.
 *
 * STRUCTURAL RATHER THAN discord.js's `ChatInputCommandInteraction`, for the
 * reason `snapshot` in client.ts is structural: the real thing cannot be built
 * in a test without a client and a token, and this is the function that decides
 * what the gate gets to see.
 */
export function invocationOf(interaction: CommandSource): Invocation {
  return {
    commandName: interaction.commandName,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    roleIds: roleIdsOf(interaction.member),

    // Null for every command that does not declare a user option by that name,
    // so this costs nothing to ask on behalf of a command that never uses it.
    targetId: targetOf(interaction.options),
  }
}

/** A live interaction, as far as answering it goes. */
export interface ReplyTarget {
  deferReply: (options: { flags?: MessageFlags.Ephemeral }) => Promise<unknown>
  editReply: (options: { content: string }) => Promise<unknown>
  reply: (options: { content: string; flags?: MessageFlags.Ephemeral }) => Promise<unknown>
}

/**
 * `flags: MessageFlags.Ephemeral`, AND NOT `ephemeral: true`. The boolean still
 * works in discord.js 14.27 and is deprecated: `InteractionResponses` checks
 * for it and emits `Supplying "ephemeral" for interaction response options is
 * deprecated. Utilize flags instead.` That is a DeprecationWarning, which the
 * `--disable-warning=ExperimentalWarning` in `npm start` does not suppress — so
 * using it would put a line in the journal for every reply the bot makes,
 * saying nothing anybody can act on. This is the only place in the bot that has
 * to know any of that, which is the reason a handler returns a string instead
 * of replying for itself.
 *
 * AN EMPTY OBJECT FOR THE VISIBLE CASE rather than `flags: 0`. The absence of
 * the flag is what "everybody in the channel sees it" means to Discord.
 */
function visibility(onlyInvoker: boolean): { flags?: MessageFlags.Ephemeral } {
  return onlyInvoker ? { flags: MessageFlags.Ephemeral } : {}
}

/**
 * The three things `runCommand` is allowed to do to a real interaction.
 *
 * A DEFERRED REPLY'S VISIBILITY IS FIXED AT THE DEFER, which is why
 * `BotCommand.onlyInvoker` is asked before the handler runs. `editReply` has no
 * flags of its own: whatever `deferReply` was told is what the finished reply
 * is, and passing `flags` to the edit would be ignored rather than honoured.
 */
export function responderFor(interaction: ReplyTarget): Responder {
  return {
    defer: async (onlyInvoker) => {
      await interaction.deferReply(visibility(onlyInvoker))
    },

    edit: async (content) => {
      await interaction.editReply({ content })
    },

    reply: async (content, onlyInvoker) => {
      await interaction.reply({ content, ...visibility(onlyInvoker) })
    },
  }
}

/**
 * Register the commands at boot and answer them for the life of the process.
 *
 * REGISTRATION HAPPENS IN `clientReady` because it needs the guild, and the
 * guild cache is not populated until then. It is `once`: the bulk PUT is
 * idempotent, but a reconnect is not a new deploy and there is nothing new to
 * say to Discord.
 *
 * WIRED FROM index.ts RATHER THAN FROM `createClient`. Everything in client.ts
 * is moderation — the message listeners, the halt, the log channel — and a
 * command foundation is not. Keeping it out means a fault in one cannot take
 * the other's listeners off, and it is why `createClient` needed no edit to
 * gain slash commands.
 *
 * THE INTERACTION LISTENER IS SYNCHRONOUS AND HANDLES ITS OWN PROMISE, exactly
 * as the message listener in client.ts does and for the same reason: an async
 * function handed to an EventEmitter has nowhere to reject to. It becomes an
 * unhandled rejection several ticks later, attached to no command and no user,
 * and what the admin sees meanwhile is Discord's "The application did not
 * respond".
 */
export function installCommands(client: Client, config: Config): void {
  client.once(Events.ClientReady, (ready) => {
    const guild = ready.guilds.cache.get(config.guildId)

    if (guild === undefined) {
      // client.ts has already halted moderation over this and named the
      // variable; this line says what it cost on this side. There is no guild
      // object to register into, so there is nothing to retry either.
      log('error', 'no such guild, so no slash commands were registered', {
        guild: config.guildId,
      })
      return
    }

    void registerCommands(guild).catch((error: unknown) => {
      // A registration that fails leaves the guild with whatever list it had
      // before, which is usually the previous deploy's — so the bot keeps
      // answering commands and the journal is the only thing that says the
      // list is stale.
      log('error', 'slash commands could not be registered', { guild: guild.id, error })
    })
  })

  client.on(Events.InteractionCreate, (interaction) => {
    // Buttons, autocomplete, context menus and modals all arrive here too, and
    // none of them is a slash command. Nothing else in this bot registers any
    // of them, so anything that is not a chat-input command is not ours.
    if (!interaction.isChatInputCommand()) return

    void runCommand(
      invocationOf(interaction),
      config,
      responderFor(interaction),
      COMMANDS,
    ).catch((error: unknown) => {
      // `runCommand` turns a failing handler into a reply on its own, so
      // reaching this means the REPLY failed: an expired interaction token, a
      // Discord that is not answering. There is nothing left to say to the
      // admin over Discord, which is exactly why this line has to exist.
      log('error', 'slash command could not be answered', {
        command: interaction.commandName,
        error,
      })
    })
  })
}
