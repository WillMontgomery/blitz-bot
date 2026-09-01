import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  type APIEmbed,
  type ChatInputApplicationCommandData,
  type Client,
  type MessageMentionOptions,
} from 'discord.js'

import type { Config } from '../config.ts'
import { createDdb } from '../ddb.ts'
import { log } from '../log.ts'
import {
  runCommand,
  TARGET_OPTION,
  type BotCommand,
  type CommandComponentRow,
  type CommandReply,
  type Invocation,
  type Responder,
} from './command.ts'
import {
  drainCommand,
  DRAIN_NOTE_OPTION,
  lazyDrainer,
  type DrainFields,
} from './drain.ts'
import { help } from './help.ts'
import { lazyReadsFrom, profileCommand } from './profile.ts'
import { sticky, STICKY_TEXT_OPTION, unsticky } from './sticky.ts'

/**
 * The command list, and the half of the slash-command foundation that touches
 * discord.js.
 *
 * ADDING A COMMAND IS A NEW FILE AND ONE LINE. Import it, put it in the array
 * below, and registration, the gate, the defer and the reply all follow from
 * the record it exports. There is no second place to remember.
 *
 * `/profile` IS BUILT LAZILY AND THAT IS NOT A STYLE CHOICE. This array is
 * module-level, so `profileCommand(readsFrom(createDdb()))` here would construct
 * a DynamoDB client while this module is being IMPORTED — including by
 * commands.test.ts, which runs offline and has no business holding an SDK
 * client. `lazyReadsFrom` defers that to the first `/profile` and then keeps the
 * one client for the life of the process, which is what `createDdb`'s own
 * comment asks for. See ./profile.ts.
 *
 * `/drain` IS HANDED A FUNCTION FOR THE SAME REASON AND A SECOND ONE. Its relay
 * needs `ringmasterUrl` and `COMMAND_SECRET`, and there is no config at import
 * time; it also has to answer "there is no secret, so there is no console to
 * ask" per invocation rather than deciding that once, here, before the config
 * has been loaded. Both fall out of passing `lazyDrainer()` instead of a relay.
 */
export const COMMANDS: readonly BotCommand[] = [
  drainCommand(lazyDrainer()),
  help,
  profileCommand(lazyReadsFrom(() => createDdb())),
  sticky,
  unsticky,
]

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
 *
 * `=== true`, AND NEVER `command.adminOnly ? …`, WHICH IS THE WHOLE OF WHAT A
 * CONDITIONAL GATE COSTS THIS FUNCTION. `BotCommand.adminOnly` may be a
 * PREDICATE — see `AdminGate` — and a function is truthy, so the shorter test
 * would hide `/profile` from every member in the client and leave the half of
 * it that needs no role unreachable in the picker whatever `refusalFor` allows.
 * The gate would then be decorative: nobody could reach the invocation it was
 * written to permit.
 *
 * SO A COMMAND WHOSE GATE DEPENDS ON THE INVOCATION IS REGISTERED VISIBLE, and
 * that is a decision rather than a fallthrough. `defaultMemberPermissions` is
 * one value for the whole command and cannot say "admin-only only when this
 * option is filled in"; of the two things it CAN say, hidden closes the half
 * that was meant to be open and visible closes nothing at all. It closes
 * nothing because `0n` was never the guard: it is a DEFAULT anybody with Manage
 * Server can re-grant, and `refusalFor` is what refuses the targeted call
 * either way. Un-hiding therefore costs exactly the protection that path never
 * had.
 */
export function commandData(command: BotCommand): ChatInputApplicationCommandData {
  return { ...command.data, defaultMemberPermissions: command.adminOnly === true ? 0n : null }
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

/**
 * A Discord account as an interaction carries one.
 *
 * THREE THINGS OFF A LIVE `User`, AND THE THIRD IS A CALL RATHER THAN A FIELD.
 * `Invocation` carries ids and strings — see there — so the avatar is resolved
 * HERE, at the seam, and what crosses into the handlers is a URL. That is what
 * keeps `User`, which is a live object with a REST handle on it, out of the half
 * of this foundation that exists to be built in a test.
 *
 * `displayAvatarURL` AND NOT `avatarURL`, CHECKED AGAINST THE INSTALLED
 * TYPINGS. discord.js declares `avatarURL(options?): string | null` and
 * `displayAvatarURL(options?): string` — the second falls back to the default
 * avatar Discord assigns every account, so it cannot answer null and there is no
 * missing-image case anywhere downstream. Declared here as a zero-argument
 * function, which the real one-optional-argument method satisfies.
 *
 * `displayName` IS THE ACCOUNT'S, WHICH IS NOT ALWAYS THE GUILD'S — a member
 * with a nickname here is shown by that nickname. `displayNameOf` prefers the
 * nickname and falls back to this; see there.
 */
export interface InteractionUser {
  readonly id: string
  readonly displayName: string
  displayAvatarURL: () => string
}

/**
 * The invoking guild's member record for a targeted user, in the two shapes an
 * interaction can carry one.
 *
 * TWO SHAPES FOR THE REASON `InteractionMember` HAS TWO. discord.js hands back a
 * live `GuildMember` when the member is cached and the raw API record when it is
 * not, and which one arrives depends on nothing this bot controls. The live one
 * has `displayName` (already the nickname, or the account's name when there is
 * none); the raw one has `nick`. Both properties are optional here, so both real
 * types are assignable and neither has to be narrowed at the call site.
 */
export interface OptionMember {
  readonly displayName?: string
  readonly nick?: string | null
}

/** One option as it arrived, reduced to what the two options are read out of. */
export interface SuppliedOption {
  readonly type: number
  readonly user?: InteractionUser | null

  /**
   * The guild member behind a user option, when the payload carried one.
   *
   * OPTIONAL AND NULLABLE BOTH, because discord.js types it that way: a user
   * option for somebody who is not in this guild resolves a user and no member.
   * `displayNameOf` falls through to the account's own display name for that.
   */
  readonly member?: OptionMember | null

  /**
   * The option's own value, which is what a string option carries.
   *
   * WIDER THAN `string` BECAUSE DISCORD'S IS. discord.js types this
   * `string | number | boolean` across every option kind, so narrowing it here
   * would make the real interaction stop being assignable to this record — and
   * `textOf` has to check the type anyway.
   */
  readonly value?: string | number | boolean | null
}

/** A live chat-input interaction, as far as building an `Invocation` reads it. */
export interface CommandSource {
  readonly commandName: string
  readonly guildId: string | null

  /** discord.js types this `Snowflake | null`; `Invocation` carries it as-is. */
  readonly channelId: string | null

  /**
   * Who ran it. WIDER THAN THE ID IT USED TO BE, because `/profile` puts the
   * caller's own avatar on the self view's embed and the avatar is not something
   * an id can be turned into without asking Discord for it.
   */
  readonly user: InteractionUser

  readonly member: InteractionMember | null

  readonly options: {
    get: (name: string) => SuppliedOption | null

    /**
     * Which subcommand was invoked, for the one command that has any.
     *
     * `getSubcommand(false)` AND NEVER `getSubcommand()`. The zero-argument
     * overload is typed `(required?: true) => string` and THROWS when the
     * interaction carries no subcommand — and that throw would happen while
     * `invocationOf` is assembling `runCommand`'s arguments, which is outside
     * the promise the listener catches. It would escape into discord.js's own
     * emit rather than becoming a reply, and every command in the bot would
     * answer "The application did not respond" for as long as it kept
     * happening. Passing `false` is the overload that answers null.
     *
     * OPTIONAL, AND THAT IS ABOUT THE TESTS RATHER THAN ABOUT DISCORD. The real
     * `ChatInputCommandInteraction` always has this method — the context-menu
     * interactions that do not are refused above by `isChatInputCommand` — but
     * a dozen `CommandSource` fakes in commands.test.ts build `options` as
     * `{ get: ... }` and a required method would make every one of them a
     * compile error over a value they never read.
     */
    getSubcommand?: (required: false) => string | null
  }
}

/**
 * Everything about the tagged member that `Invocation` carries, read off the one
 * option that has it in hand.
 *
 * ONE RECORD OUT OF ONE `options.get`, WHICH IS WHY THE THREE ARE READ TOGETHER.
 * The id, the avatar and the display name all come off the same resolved user,
 * and asking for the option three times would be three chances for the two type
 * checks in `targetOf` to be written differently — and one of those spellings
 * would be the one that throws. A separate `targetAvatarOf` would have to repeat
 * both checks to get back to the same object.
 */
interface Target {
  readonly id: string
  readonly avatarUrl: string
  readonly displayName: string
}

/**
 * What Discord shows this account as in THIS guild.
 *
 * THE NICKNAME FIRST, BECAUSE THAT IS WHAT THE READER IS LOOKING AT. `/profile`
 * uses this for one comparison — is the in-game name already the Discord name on
 * screen — and the `<@id>` mention it leads with renders as the guild nickname
 * when there is one. Comparing against the account's global name instead would
 * decide against a name the reader cannot see, which is the wrong answer in
 * exactly the case somebody set a nickname to match their in-game name.
 *
 * THE TWO MEMBER SHAPES ARE BOTH ASKED, in the order that costs nothing: the
 * live `GuildMember` resolves `displayName` itself (nickname, else the account's
 * name), the raw record carries `nick`, and an option with no member at all —
 * somebody tagged who is not in this guild — falls through to the account's own
 * display name. See `OptionMember`.
 */
function displayNameOf(user: InteractionUser, member: OptionMember | null | undefined): string {
  return member?.displayName ?? member?.nick ?? user.displayName
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
 *
 * A RECORD RATHER THAN AN ID, since `/profile` grew a thumbnail. The avatar and
 * the display name are on the user object Discord already put on this option;
 * the alternative to reading them here is a REST fetch on a path that has three
 * seconds to answer, for a picture.
 */
function targetOf(options: CommandSource['options']): Target | null {
  const option = options.get(TARGET_OPTION)

  if (option === null || option.type !== ApplicationCommandOptionType.User) return null

  // An option of the right kind that resolved no user is not a target, which is
  // what `option.user?.id ?? null` said before this returned a record. Named as
  // its own step now, so the three values below are read off one non-null user
  // rather than three optional chains that could disagree.
  const user = option.user

  if (user === undefined || user === null) return null

  return {
    id: user.id,
    avatarUrl: user.displayAvatarURL(),
    displayName: displayNameOf(user, option.member),
  }
}

/**
 * The `text` option a command supplied, or null.
 *
 * THE SAME TWO CHECKS `targetOf` MAKES, AND FOR THE SAME REASONS. `get` rather
 * than `getString`, because discord.js's typed getters THROW when an option by
 * that name exists and is not the kind asked for — and that throw would happen
 * while assembling `runCommand`'s arguments, outside the promise the listener
 * catches, so it would escape into discord.js's own emit rather than becoming a
 * reply. And the type is compared rather than trusted: a USER option named
 * `text` is not this command's text.
 *
 * NAMED BY `STICKY_TEXT_OPTION` SO THE TWO HALVES CANNOT DRIFT. ./sticky.ts
 * declares the option by that constant and this asks Discord for it by the same
 * one; a rename in only one place is not a compile error, it is a `/sticky` that
 * reports an empty message however much text was typed into it.
 */
function textOf(options: CommandSource['options']): string | null {
  const option = options.get(STICKY_TEXT_OPTION)

  if (option === null || option.type !== ApplicationCommandOptionType.String) return null
  return typeof option.value === 'string' ? option.value : null
}

/**
 * The `note` option `/drain` supplied, or null.
 *
 * THE SAME TWO CHECKS `textOf` MAKES, AND A SEPARATE FIELD RATHER THAN REUSING
 * `text`. Reading two differently-named options into one slot would mean a
 * command declaring both has a field whose value depends on which name this
 * function asks for first — and `text` means "the sticky's message" everywhere
 * else in the bot. A note shown to players at the door is not that.
 *
 * IT IS READ INSIDE A SUBCOMMAND AND THAT COSTS NOTHING. discord.js hoists the
 * invoked subcommand's own options, so `get('note')` finds `/drain start`'s
 * note exactly as it finds a top-level one.
 */
function noteOf(options: CommandSource['options']): string | null {
  const option = options.get(DRAIN_NOTE_OPTION)

  if (option === null || option.type !== ApplicationCommandOptionType.String) return null
  return typeof option.value === 'string' ? option.value : null
}

/**
 * Which subcommand was invoked, or null.
 *
 * NULL FOR EVERY COMMAND THAT HAS NO SUBCOMMANDS, which is four of the five, so
 * this costs nothing to ask on their behalf. `/drain` is the only reader and it
 * refuses rather than guessing when the answer is null — see `subcommandOf` in
 * ./drain.ts, which will not pick the half that restarts the game server on the
 * strength of a payload it could not parse.
 *
 * THE METHOD IS OPTIONAL ON THE RECORD, so this also answers null for a fake
 * that does not have one. See `CommandSource`.
 */
function subcommandOf(options: CommandSource['options']): string | null {
  const name = options.getSubcommand?.(false) ?? null

  return typeof name === 'string' && name !== '' ? name : null
}

/**
 * Reduce a live interaction to the record the gate and the handlers read.
 *
 * STRUCTURAL RATHER THAN discord.js's `ChatInputCommandInteraction`, for the
 * reason `snapshot` in client.ts is structural: the real thing cannot be built
 * in a test without a client and a token, and this is the function that decides
 * what the gate gets to see.
 *
 * THE RETURN TYPE IS WIDER THAN `Invocation`, AND THAT IS TEMPORARY SCAFFOLDING
 * rather than a design. `Invocation` lives in ./command.ts, which this change
 * does not own; `DrainFields` declares the two fields `/drain` needs as an
 * OPTIONAL intersection, which is what `StickyFields` was before `channelId`
 * and `text` moved into `Invocation` proper. Everything downstream still takes
 * an `Invocation` — `runCommand` and every handler — so the widening is visible
 * only to the one command that reads it. When those fields move over there,
 * this annotation and that interface are deleted together.
 */
export function invocationOf(interaction: CommandSource): Invocation & DrainFields {
  const target = targetOf(interaction.options)

  return {
    commandName: interaction.commandName,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,

    // THE ONE PLACE EITHER AVATAR IS RESOLVED. `displayAvatarURL()` is a method
    // on a live discord.js object, so it is called here — where the live object
    // is — and every handler downstream is handed a string. The caller's is
    // always available; the target's exists only when an option resolved a user.
    userAvatarUrl: interaction.user.displayAvatarURL(),

    roleIds: roleIdsOf(interaction.member),

    // Null for every command that does not declare an option by that name, so
    // both cost nothing to ask on behalf of a command that never uses them.
    targetId: target === null ? null : target.id,

    // `undefined` rather than null for these two, which is what "the seam did
    // not carry one" means on `Invocation` — see there. Nobody was tagged, or
    // the option resolved no user, and `/profile` renders no thumbnail and keeps
    // the name history rather than guessing at either.
    targetAvatarUrl: target?.avatarUrl,
    targetDisplayName: target?.displayName,

    text: textOf(interaction.options),

    // `/drain`'s two, null for every other command. See `DrainFields`.
    subcommand: subcommandOf(interaction.options),
    note: noteOf(interaction.options),
  }
}

/** A live interaction, as far as answering it goes. */
export interface ReplyTarget {
  deferReply: (options: { flags?: MessageFlags.Ephemeral }) => Promise<unknown>

  editReply: (options: {
    content?: string
    embeds?: readonly APIEmbed[]
    components?: readonly CommandComponentRow[]
    allowedMentions?: MessageMentionOptions
  }) => Promise<unknown>

  reply: (options: {
    content: string
    flags?: MessageFlags.Ephemeral
    allowedMentions?: MessageMentionOptions
  }) => Promise<unknown>
}

/**
 * NOTHING A COMMAND ANSWERS WITH NOTIFIES ANYBODY, SAID AT THE SEND.
 *
 * ═══ A CODE SPAN IS NOT THE GUARD PEOPLE ASSUME IT IS ═══
 *
 * `/drain`'s reply carries an admin's note — somebody else's typed text, landing
 * inside a sentence a reader takes to be the bot speaking — and `inert` in
 * ./drain.ts wraps it in `` ` ` `` so that a link, a `<t:…>` or a `> quote` in
 * it renders as characters instead of as markup. THAT IS A RENDERING RULE AND
 * NOT A NOTIFICATION RULE. Discord decides who a message pings from the
 * `allowed_mentions` field on the REQUEST, before any markdown is looked at:
 * `@everyone` inside a code span is displayed literally AND still notifies the
 * guild, exactly as it would bare. The span makes the note look inert, which is
 * the reason to be explicit here rather than to rely on how it reads.
 *
 * ═══ AND THE CLIENT-WIDE DEFAULT IS BORROWED, NOT STATED ═══
 *
 * `createClient` in ../client.ts sets `allowedMentions: { parse: [] }` on the
 * client and its own comment says what that is worth: a default is SILENTLY
 * REPLACED by any call that passes an `allowedMentions` of its own, so what it
 * guarantees is the sends that say nothing. A reader of this function cannot see
 * whether it holds, and neither can a test of it — which is why ../maintenance.ts
 * restates the same option at its own `send`, and why ../incidents.ts and
 * ../sticky.ts do. This is the third such restatement and the argument has not
 * changed: the guard belongs beside the thing it guards.
 *
 * ON BOTH SENDS, BECAUSE BOTH CARRY TEXT. `edit` is where every handler's answer
 * goes out, `/drain`'s among them; `reply` is the refusal path, whose strings are
 * this repo's own today and whose safety should not depend on that staying true.
 *
 * A FUNCTION RATHER THAN A SHARED CONSTANT, for the reason `payload` copies the
 * embed array: nothing this bot hands discord.js is an object a later send also
 * holds. It is two words of allocation on a path that is already making an HTTP
 * request.
 *
 * `{ parse: [] }` AND NOT `escapeMarkdown` ANYWHERE NEAR IT. Suppression is the
 * only thing that stops a notification; rewriting the text would change words an
 * admin has to be able to compare against the console's copy of the same note.
 */
function noMentions(): MessageMentionOptions {
  return { parse: [] }
}

/**
 * One `CommandReply` as the payload discord.js takes.
 *
 * THE WHOLE OF WHAT WIDENING THE SEAM COSTS THE LIVE HALF, and it is one
 * function. A string becomes `content`, embeds become `embeds`, components
 * become `components`, and this is the one place in the bot that knows the
 * difference — which is the same argument that keeps `MessageFlags.Ephemeral`
 * here rather than in every command file.
 *
 * `[...reply.embeds]` RATHER THAN THE ARRAY ITSELF, so nothing this bot hands
 * discord.js is a live view of a value a command still holds. One element today
 * and ten at Discord's limit; the alternative is a shared array somebody mutates
 * after the reply has been sent. The rows are copied one level deeper for the
 * same reason: a row IS its `components` array, so copying only the outer array
 * would hand over the inner one.
 *
 * NO `components` KEY AT ALL WHEN THE HANDLER GAVE NONE, and that is not
 * tidiness. `editReply` is an EDIT: `components: []` means "take away the ones
 * that are there" and an absent key means "leave them alone", and the two are
 * only the same on a reply that never had any. Sending the empty array anyway
 * would make every text answer in this bot carry an instruction about
 * components it has no opinion on.
 */
function payload(reply: CommandReply): {
  content?: string
  embeds?: APIEmbed[]
  components?: CommandComponentRow[]
} {
  if (typeof reply === 'string') return { content: reply }

  const embeds = [...reply.embeds]

  if (reply.components === undefined) return { embeds }

  return {
    embeds,
    components: reply.components.map((row) => ({ ...row, components: [...row.components] })),
  }
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
 *
 * THE TWO THAT CARRY TEXT ALSO CARRY `allowedMentions`, STATED HERE RATHER THAN
 * INHERITED. See `noMentions` for why the client-wide default is not something
 * this function may lean on, and for why `/drain`'s code span is not the thing
 * that stops an `@everyone` in an admin's note. The defer carries no text and
 * takes none.
 */
export function responderFor(interaction: ReplyTarget): Responder {
  return {
    defer: async (onlyInvoker) => {
      await interaction.deferReply(visibility(onlyInvoker))
    },

    edit: async (reply) => {
      await interaction.editReply({ ...payload(reply), allowedMentions: noMentions() })
    },

    reply: async (content, onlyInvoker) => {
      await interaction.reply({
        content,
        ...visibility(onlyInvoker),
        allowedMentions: noMentions(),
      })
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
