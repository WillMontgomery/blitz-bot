import { ApplicationCommandOptionType } from 'discord.js'

import type { RoleProblem } from '../banrole.ts'
import { REACT_ROLE_ANY, reactRoleChannelKey, type ReactRolePairingInput } from '../ddb.ts'
import { log } from '../log.ts'
import { reactRoles } from '../reactroles.ts'
import { COPY as COMMAND_COPY, type BotCommand, type Invocation } from './command.ts'

/**
 * `/reactrole` — react to a message, be given a role.
 *
 * `/reactrole {message id, message link, or the word any} {emoji, or the word
 * any} {@role or role id} [#channel]`, which is the owner's own line and the
 * reason the `message` and `emoji` options are STRINGS rather than anything
 * Discord could validate for us: each of them carries two different kinds of
 * thing plus a magic word, and Discord has no option type for that.
 *
 * ═══ FOUR SHAPES, ALL HIS, AND THEY ARE TWO QUESTIONS RATHER THAN FOUR CASES ═══
 *
 * WHERE: one message, or any message in a channel. WHICH REACTION: one emoji, or
 * any emoji. The four shapes are those two crossed, and the row that is written
 * says so — `messageId` is a message id or `reactRoleChannelKey(channel)`, and
 * `emoji` is an emoji key or `REACT_ROLE_ANY`. There is no fifth field marking
 * which shape a row is; the KEY is the shape.
 *
 * `any` AS THE MESSAGE NEEDS A CHANNEL AND IS REFUSED WITHOUT ONE, which is his
 * rule and is also the only reading that can be acted on: "any message anywhere
 * in the guild" is a pairing that would fire on every reaction in every channel,
 * and nobody asked for that.
 *
 * A #CHANNEL BESIDE A REAL MESSAGE ID IS ALLOWED AND REDUNDANT. It is used for
 * one thing — deciding where to look the message up — because a bare message id
 * is not enough to fetch a message with; Discord's API takes a channel and an id.
 * When a LINK was given, the link already says which channel, and the link wins.
 * Either way the reply states which channel was used, because a command that
 * quietly picked one for you is a command you cannot check.
 *
 * ═══ THE PRE-REACT IS ONLY POSSIBLE IN ONE OF THE FOUR ═══
 *
 * With a message AND an emoji there is something to click, so the bot adds that
 * emoji to that message itself. With `any` as the emoji there is no emoji to
 * add, and with `any` as the message there is no message to add it to. So three
 * of the four shapes add nothing at all, and that is a fact about the shapes
 * rather than a feature that was skipped.
 *
 * ═══ ADMIN-ONLY, EXACTLY LIKE `/drain` ═══
 *
 * `adminOnly: true` is the whole of it: the role check in `refusalFor` and the
 * `defaultMemberPermissions: 0n` that `commandData` derives from that one word.
 * A command that hands out roles is a command that hands out whatever those roles
 * can do, so there is no invocation of it that is harmless and the gate is a
 * boolean rather than a predicate. Ephemeral, because a pairing is a
 * configuration and not an announcement.
 */

/**
 * The names Discord registers, and the names `invocationOf` in ./index.ts has to
 * ask Discord for.
 *
 * ONE CONSTANT EACH SO THE TWO HALVES CANNOT DRIFT, exactly as `TARGET_OPTION`
 * and `STICKY_TEXT_OPTION` are. A rename in only one place is not a compile
 * error — it is a `/reactrole` that reports no emoji however carefully one was
 * typed.
 */
export const REACTROLE_MESSAGE_OPTION = 'message'
export const REACTROLE_EMOJI_OPTION = 'emoji'
export const REACTROLE_ROLE_OPTION = 'role'
export const REACTROLE_CHANNEL_OPTION = 'channel'

/**
 * The word that means "all of them", in both options that take one.
 *
 * THE SAME LITERAL THE ROW IS KEYED ON, imported from ../ddb.ts rather than
 * spelled again here. The owner asked for one word in the command and one value
 * in the table, and two constants would eventually be two words.
 */
export const REACTROLE_ANY = REACT_ROLE_ANY

/**
 * The four fields this command needs that `Invocation` does not carry yet.
 *
 * WRITTEN AS OPTIONAL, AND THAT IS THE SAME SCAFFOLDING `StickyFields` AND
 * `DrainFields` ARE. ./command.ts says a command wanting an option which is not
 * a target "grows a field here and one line in `invocationOf`"; two commands
 * have already answered that with an optional intersection instead, because the
 * alternative is four more fields on a record every command and every test in
 * this bot builds. Declaring them here means this command compiles and behaves
 * sensibly against an invocation that carries them and against one that does
 * not, and `invocationOf` in ./index.ts DOES carry all four today.
 *
 * WHAT HAPPENS IF THEY EVER STOP ARRIVING: `/reactrole` refuses and says what it
 * could not read, rather than writing a pairing against a message or a role it
 * had to guess at.
 */
export interface ReactRoleFields {
  /** The `message` option as typed: an id, a link, or the word `any`. */
  readonly messageRef?: string | null

  /** The `emoji` option as typed: an emoji, or the word `any`. */
  readonly emojiRef?: string | null

  /** The `role` option, already resolved to an id by Discord. */
  readonly roleId?: string | null

  /**
   * The `channel` option, already resolved to an id by Discord.
   *
   * NOT `channelId`, WHICH IS ALREADY TAKEN AND MEANS SOMETHING ELSE.
   * `Invocation.channelId` is where the command was RUN, which this command also
   * reads — it is the channel a bare message id is looked for in when no option
   * was given. Two fields called nearly the same thing, holding two different
   * channels, is exactly the confusion that ends in a pairing written against
   * the wrong room.
   */
  readonly targetChannelId?: string | null
}

/**
 * EVERY STRING `/reactrole` CAN SAY, IN ONE RECORD, under the rule ./command.ts
 * sets.
 *
 * ═══ NONE OF THESE ARE THE OWNER'S WORDS AND ALL OF THEM ARE ON THE LIST ═══
 *
 * He asked for this command and described what it does; he has not been shown a
 * single sentence it says. So every string below carries `@unwritten` in its own
 * doc comment and `scripts/check-placeholders.ts` prints the lot on every verify,
 * which is how he finds out what this command tells an admin without running it.
 *
 * THEY ARE REAL SENTENCES RATHER THAN STAND-INS, AND THAT IS `deployAtTime`'s
 * PRECEDENT IN ./drain.ts RATHER THAN `COPY.empty`'s IN ./sticky.ts. The
 * difference is whether the string carries information: "No wording supplied yet
 * for a saved pairing" would lose which role, which emoji and where — which is
 * the entire content of the reply and the only way an admin can check that the
 * command understood him. A stand-in is right where the sentence says nothing but
 * "that did not work"; here it would be a worse sentence, not a safer one.
 *
 * WHICH IS WHY THE MARKER IS IN THE COMMENT AND NEVER IN THE TEXT. A literal
 * `PLACEHOLDER:` shipped to a real admin on `/drain` once, he asked for it out,
 * and the list is what replaced it.
 *
 * ONE PARAGRAPH AND NO LINE BREAKS ANYWHERE. He has said three times that
 * multi-line replies "look so weird", so every sentence here is a whole sentence
 * and `reply` joins them with a space.
 *
 * THE DESCRIPTIONS ARE MINE RATHER THAN HIS for the reason `/drain`'s and
 * `/sticky`'s are: Discord requires one on a command and on every option and will
 * not accept an empty one. They are deliberately plain and are grouped apart on
 * the list.
 */
export const COPY = {
  /** @unwritten picker — the `/reactrole` command as Discord's picker describes it. Discord allows 1-100 characters. */
  description: 'Give a role to anybody who reacts',

  /** @unwritten picker — the `message` option of `/reactrole`, in the picker. Same limit. */
  messageOption: 'A message link, a message id, or the word any',

  /** @unwritten picker — the `emoji` option of `/reactrole`, in the picker. */
  emojiOption: 'The emoji that grants the role, or the word any',

  /** @unwritten picker — the `role` option of `/reactrole`, in the picker. */
  roleOption: 'The role to give',

  /** @unwritten picker — the `channel` option of `/reactrole`, in the picker. */
  channelOption: 'Which channel. Required when the message is any',

  /**
   * The four success leads, one per shape, each a whole sentence.
   *
   * FOUR RATHER THAN ONE SENTENCE WITH THE DIFFERENCES INTERPOLATED, so that
   * rewording any of them is one edit to one sentence rather than a clause
   * somebody has to read three other strings to understand. Each states what is
   * now true and that the reaction coming off undoes it, because "removing the
   * reaction removes the role" is a rule an admin has to know before he tells
   * anybody to click anything.
   *
   * NOTHING CLAIMS THAT AN OLDER PAIRING WAS REPLACED. Running this again for
   * the same target and emoji does replace the role — that is his rule, and
   * ../ddb.ts's `reactRoles.put` is how it happens — but the write does not
   * report whether it overwrote anything, and finding out would cost a second
   * read of a row nobody is going to look at again. What these say is what is
   * true now, which is true either way.
   *
   * @unwritten admin — what an admin is told after pairing one emoji on one message with a role.
   */
  pairedMessage: (role: string, emoji: string) =>
    `Anybody who reacts ${emoji} to that message is given ${role}, and taking the reaction off takes the role away.`,

  /** @unwritten admin — the same, for any reaction at all on one message. */
  pairedMessageAny: (role: string) =>
    `Anybody who reacts to that message, with anything, is given ${role}, and taking the reaction off takes the role away.`,

  /** @unwritten admin — the same, for one emoji on any message in a channel. */
  pairedChannel: (role: string, emoji: string, channel: string) =>
    `Anybody who reacts ${emoji} to any message in ${channel} is given ${role}, and taking the reaction off takes the role away.`,

  /** @unwritten admin — the same, for any reaction at all on any message in a channel. */
  pairedChannelAny: (role: string, channel: string) =>
    `Anybody who reacts to any message in ${channel}, with anything, is given ${role}, and taking the reaction off takes the role away.`,

  /** @unwritten admin — said after a pairing when the bot put the emoji on the message itself. */
  reacted: 'The emoji is on the message already, so there is something to click.',

  /** @unwritten admin — said after a pairing when Discord would not let the bot add the emoji. */
  notReacted: 'The emoji could not be added to the message, so somebody has to react first.',

  /** @unwritten admin — which channel a message id was looked for in, when this command had to choose. */
  lookedIn: (channel: string) => `It was looked for in ${channel}.`,

  /**
   * The refusals. Every one of them ends in "nothing was saved", because the
   * one thing an admin needs from a refusal is whether he has to undo anything.
   *
   * @unwritten admin — refused because the message option was not an id, a link or the word any.
   */
  badMessage: 'That is not a message link, a message id or the word any, so nothing was saved.',

  /** @unwritten admin — refused because the emoji option was not an emoji or the word any. */
  badEmoji: 'That is not an emoji or the word any, so nothing was saved.',

  /** @unwritten admin — refused because the emoji is a custom one from a server this bot is not in. */
  foreignEmoji: 'That emoji belongs to another server, so this bot cannot use it and nothing was saved.',

  /** @unwritten admin — refused because `any` was given as the message with no channel beside it. */
  anyNeedsChannel: 'Any as the message needs a channel as well, so nothing was saved.',

  /** @unwritten admin — refused because a bare message id arrived with no channel to look it up in. */
  noChannelToLookIn: 'There is no channel to look that message up in, so nothing was saved.',

  /** @unwritten admin — refused because the channel could not be found or read. */
  noChannel: 'That channel cannot be found or read, so nothing was saved.',

  /** @unwritten admin — refused because the message could not be found or read in that channel. */
  noMessage: 'That message cannot be found or read in that channel, so nothing was saved.',

  /** @unwritten admin — refused because the payload carried no role at all. */
  noRole: 'No role was given, so nothing was saved.',

  /** @unwritten admin - refused because the role named is the server's default role, which nobody can be given. */
  everyoneRole:
    'That is the default role everybody in this server already has, so nobody can be given it and nothing was saved.',
}

/**
 * Why the role cannot be handed out, said to the admin who asked for it.
 *
 * A `Record<RoleProblem, string>` SO A SEVENTH PROBLEM IS A COMPILE ERROR rather
 * than an `undefined` printed where the sentence goes — which is the argument
 * `ROLE_PROBLEM` in ../banrole.ts makes for the same union. It is a SECOND record
 * over that union and not a reuse of that one, because those six are journal
 * lines about the game-ban role: they name `BLITZ_GAME_BAN_ROLE_ID`, they say
 * "no game ban can be marked", and they are addressed to whoever runs the bot.
 * These are addressed to an admin who just typed a role into a command, about
 * that role.
 *
 * @unwritten admin — what an admin is told when the role they named cannot be handed out by this bot, one sentence per reason.
 */
export const ROLE_REFUSAL: Record<RoleProblem, string> = {
  'no-guild': 'This bot cannot see the server right now, so nothing was saved.',
  'no-role': 'There is no such role in this server, so nothing was saved.',
  'no-self': 'This bot cannot see its own membership right now, so nothing was saved.',
  'no-permission': 'This bot does not hold Manage Roles, so it cannot give that role and nothing was saved.',
  'managed-role': 'That role belongs to an integration, so nobody can be given it and nothing was saved.',
  'role-too-high':
    "That role sits at or above this bot's own role, so the bot cannot give it. Move it below in Server Settings, Roles. Nothing was saved.",
}

/* ------------------------------------------------------------------ *
 * Reading what was typed.
 * ------------------------------------------------------------------ */

/**
 * A Discord snowflake, as an option may carry one.
 *
 * SEVENTEEN TO TWENTY DIGITS, which is what a snowflake is today and for the rest
 * of this century: the epoch left of the timestamp is 42 bits, so ids have been
 * 18 digits since 2016 and become 20 in the 2090s. The point of the bound is not
 * arithmetic — it is that `12` and `not-a-message` are refused with a sentence
 * instead of becoming a row nothing can ever match.
 */
const SNOWFLAKE = /^\d{17,20}$/u

/**
 * A message link, in every host Discord hands one out under.
 *
 * `discord.com`, `ptb.` AND `canary.` ARE THE THREE CLIENTS, and `discordapp.com`
 * is the old domain that still works and that older messages still carry. A link
 * copied out of any of them is the same three ids in the same order, and refusing
 * one of the four would refuse it for a reason nobody could guess from the
 * sentence.
 *
 * THE GUILD IN THE LINK IS PARSED AND NOT CHECKED, deliberately. A link from
 * another guild names a channel this bot cannot fetch, so it is refused one step
 * later by the lookup that would have had to run anyway — and that refusal says
 * the channel cannot be read, which is exactly what is wrong with it.
 */
const MESSAGE_LINK =
  /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})\/?$/u

/** A custom emoji as Discord writes one: `<:name:id>`, or `<a:name:id>` animated. */
const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{17,20})>$/u

/**
 * Whether a string is made only of the code points an emoji is made of.
 *
 * `\p{Emoji}` AND `\p{Emoji_Component}` TOGETHER, because neither is enough
 * alone: the first misses the zero-width joiner, the variation selector and the
 * keycap mark, and a family emoji is four pictographs held together by three
 * joiners. Together they accept 🎮, 👍🏽, 🇬🇧, 1️⃣ and 👨‍👩‍👧.
 *
 * AND `\p{Emoji}` ON ITS OWN WOULD ACCEPT `123`, which is the trap in this
 * property: the digits, `#` and `*` carry it because they are the bases of the
 * keycap emoji. So a second test demands that something in the string is actually
 * a picture — a pictograph, a flag half, or a keycap mark — and `9` alone, `#`
 * alone and `hello` are all refused.
 *
 * WHY NOT `\p{RGI_Emoji}`, WHICH IS THE PROPERTY THAT ACTUALLY MEANS THIS: it
 * needs the `v` regex flag, and `v` needs an ES2024 target. This repo's tsconfig
 * says ES2023 and moving it for one refusal message is not a trade worth making.
 * The cost of the looser test is that a sequence Discord itself would reject can
 * reach the pre-react, where Discord rejects it and the admin is told the emoji
 * could not be added.
 */
const EMOJI_PARTS = /^(?:\p{Emoji}|\p{Emoji_Component})+$/u
const EMOJI_PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u

/**
 * Whether a string is exactly ONE emoji, which is the thing the two tests above
 * cannot say.
 *
 * BOTH OF THEM ARE HAPPY WITH A RUN. `EMOJI_PARTS` ends in `+` and
 * `EMOJI_PICTURE` only asks that SOMETHING in the string is a picture, so two
 * emoji jammed together passed both and were stored as that sort key, which is a
 * key no reaction event can ever carry: the gateway sends one emoji per reaction.
 * The pairing would be dead the moment it was written, and in the two shapes that
 * take `any` as the message there is no pre-react to catch it and nothing says
 * anything at all.
 *
 * A GRAPHEME CLUSTER IS THE UNIT AND NOT A CODE POINT COUNT. Every emoji an
 * admin can legitimately type is one cluster however many code points it is made
 * of (a skin tone is two, a flag is two, a keycap is three, a family is five), and
 * two emoji jammed together are two clusters whatever they are. `Intl.Segmenter`
 * defaults to grapheme granularity, and it is built once here because it is the
 * same segmenter every time.
 */
const GRAPHEMES = new Intl.Segmenter()

function oneEmoji(text: string): boolean {
  return [...GRAPHEMES.segment(text)].length === 1
}

/** What the `message` option turned out to be. */
export type MessageRef =
  | { readonly kind: 'any' }
  | { readonly kind: 'id'; readonly messageId: string }
  | { readonly kind: 'link'; readonly channelId: string; readonly messageId: string }
  | { readonly kind: 'bad' }

/**
 * The same, minus the one that is refused before anything else happens.
 *
 * A NARROWER PARAMETER TYPE RATHER THAN A SECOND `kind === 'bad'` CHECK inside
 * the functions below. The refusal is made once, at the top of `run`, and saying
 * so in the type is what stops the next reader wondering whether it was made
 * twice — or writing a branch for a case that cannot arrive.
 */
type GoodMessageRef = Exclude<MessageRef, { readonly kind: 'bad' }>

/**
 * The `message` option, read.
 *
 * TRIMMED AND MATCHED CASE-INSENSITIVELY FOR THE ONE MAGIC WORD. `Any` typed
 * with a capital is the same instruction as `any`, and a person pasting a link
 * out of Discord's own menu brings whatever whitespace came with it.
 */
export function parseMessageRef(raw: string | null | undefined): MessageRef {
  const text = typeof raw === 'string' ? raw.trim() : ''

  if (text === '') return { kind: 'bad' }
  if (text.toLowerCase() === REACTROLE_ANY) return { kind: 'any' }

  const link = MESSAGE_LINK.exec(text)

  if (link !== null) {
    const [, channelId, messageId] = link

    // Both groups are non-optional in the pattern, so this is `tsc`'s
    // `noUncheckedIndexedAccess` being satisfied rather than a case that happens.
    if (channelId === undefined || messageId === undefined) return { kind: 'bad' }
    return { kind: 'link', channelId, messageId }
  }

  return SNOWFLAKE.test(text) ? { kind: 'id', messageId: text } : { kind: 'bad' }
}

/** What the `emoji` option turned out to be. */
export type EmojiRef =
  | { readonly kind: 'any' }
  | { readonly kind: 'unicode'; readonly key: string; readonly react: string }
  | { readonly kind: 'custom'; readonly key: string; readonly react: string }
  | { readonly kind: 'bad' }

/** The same, minus the refused one. See `GoodMessageRef`. */
type GoodEmojiRef = Exclude<EmojiRef, { readonly kind: 'bad' }>

/**
 * The `emoji` option, read.
 *
 * `key` IS WHAT THE ROW IS SORTED ON AND `react` IS WHAT DISCORD IS ASKED TO PUT
 * ON THE MESSAGE, and for a custom emoji they are deliberately different. The key
 * is the id alone, because that is what a reaction event carries and what
 * survives the emoji being renamed; the react form is the whole `<:name:id>` the
 * admin typed, because that is what discord.js's own `resolvePartialEmoji` takes
 * and it is the only form that keeps `animated` attached.
 */
export function parseEmojiRef(raw: string | null | undefined): EmojiRef {
  const text = typeof raw === 'string' ? raw.trim() : ''

  if (text === '') return { kind: 'bad' }
  if (text.toLowerCase() === REACTROLE_ANY) return { kind: 'any' }

  const custom = CUSTOM_EMOJI.exec(text)

  if (custom !== null) {
    const id = custom[3]

    if (id === undefined) return { kind: 'bad' }
    return { kind: 'custom', key: id, react: text }
  }

  if (EMOJI_PARTS.test(text) && EMOJI_PICTURE.test(text) && oneEmoji(text)) {
    return { kind: 'unicode', key: text, react: text }
  }

  return { kind: 'bad' }
}

/** The `message` option as it arrived, or null when the invocation carried none. */
function messageRefOf(invocation: Invocation & ReactRoleFields): string | null {
  const raw = invocation.messageRef

  return typeof raw === 'string' ? raw : null
}

/** The `emoji` option as it arrived, or null when the invocation carried none. */
function emojiRefOf(invocation: Invocation & ReactRoleFields): string | null {
  const raw = invocation.emojiRef

  return typeof raw === 'string' ? raw : null
}

/** The `role` option as it arrived, or null when the invocation carried none. */
function roleOf(invocation: Invocation & ReactRoleFields): string | null {
  const roleId = invocation.roleId

  return typeof roleId === 'string' && roleId !== '' ? roleId : null
}

/** The `channel` option as it arrived, or null when none was given. */
function suppliedChannelOf(invocation: Invocation & ReactRoleFields): string | null {
  const channelId = invocation.targetChannelId

  return typeof channelId === 'string' && channelId !== '' ? channelId : null
}

/** The channel the command was run in, or null when the payload carried none. */
function hereOf(invocation: Invocation & ReactRoleFields): string | null {
  const channelId = invocation.channelId

  return typeof channelId === 'string' && channelId !== '' ? channelId : null
}

/* ------------------------------------------------------------------ *
 * What the pairing is about.
 * ------------------------------------------------------------------ */

/**
 * Where a pairing applies, once the options have been read against each other.
 *
 * `said` IS WHETHER THE REPLY HAS TO NAME THE CHANNEL, and it is decided here
 * rather than in the reply because this is where the choosing happens. A link
 * names its own channel and nothing was chosen; a bare message id was looked up
 * somewhere this command picked, and the owner asked to be told which.
 */
type Target =
  | {
      readonly kind: 'message'
      readonly channelId: string
      readonly messageId: string
      readonly said: boolean
    }
  | { readonly kind: 'channel'; readonly channelId: string }

/** A refusal, or the target the rest of the command works on. */
type Aim = { readonly no: string } | { readonly target: Target }

function aimFor(invocation: Invocation & ReactRoleFields, message: GoodMessageRef): Aim {
  const supplied = suppliedChannelOf(invocation)

  // `any` AS THE MESSAGE IS ONLY VALID WITH A CHANNEL. His rule, and the only
  // one that can be acted on — see the head of this file.
  if (message.kind === 'any') {
    if (supplied === null) return { no: COPY.anyNeedsChannel }
    return { target: { kind: 'channel', channelId: supplied } }
  }

  // THE LINK WINS OVER THE OPTION, because the link is a fact about where the
  // message IS and the option is a guess about where to look. The reply still
  // names the channel whenever an option was given, so an admin who supplied a
  // different one can see it was not used.
  if (message.kind === 'link') {
    return {
      target: {
        kind: 'message',
        channelId: message.channelId,
        messageId: message.messageId,
        said: supplied !== null,
      },
    }
  }

  // A BARE ID NEEDS A CHANNEL TO LOOK IN: Discord's API fetches a message from a
  // channel, not from a guild. The option first, then the channel the command was
  // run in, which is the one an admin is standing in and pointing at.
  const where = supplied ?? hereOf(invocation)

  if (where === null) return { no: COPY.noChannelToLookIn }

  return { target: { kind: 'message', channelId: where, messageId: message.messageId, said: true } }
}

/** The pairing's key, which is its shape. See the head of this file. */
function keyFor(target: Target): string {
  return target.kind === 'message' ? target.messageId : reactRoleChannelKey(target.channelId)
}

/* ------------------------------------------------------------------ *
 * The command.
 * ------------------------------------------------------------------ */

/**
 * ONE PARAGRAPH, JOINED WITH A SPACE, AND NO NEWLINE IN THIS FILE. Empty
 * sentences are dropped rather than rendered as double spaces.
 */
function paragraph(sentences: readonly (string | null)[]): string {
  return sentences.filter((sentence): sentence is string => sentence !== null).join(' ')
}

/** The lead sentence for one saved pairing, which is the shape it was saved in. */
function lead(target: Target, emoji: GoodEmojiRef, roleId: string): string {
  const role = `<@&${roleId}>`

  if (target.kind === 'channel') {
    const channel = `<#${target.channelId}>`

    return emoji.kind === 'any'
      ? COPY.pairedChannelAny(role, channel)
      : COPY.pairedChannel(role, emoji.react, channel)
  }

  return emoji.kind === 'any'
    ? COPY.pairedMessageAny(role)
    : COPY.pairedMessage(role, emoji.react)
}

export const reactrole: BotCommand = {
  data: {
    name: 'reactrole',
    description: COPY.description,

    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: REACTROLE_MESSAGE_OPTION,
        description: COPY.messageOption,
        required: true,
      },
      {
        type: ApplicationCommandOptionType.String,
        name: REACTROLE_EMOJI_OPTION,
        description: COPY.emojiOption,
        required: true,
      },
      {
        /**
         * A ROLE OPTION AND NOT A STRING, which is what "@role or role id"
         * already is in Discord's own picker: it accepts a mention, a name typed
         * at it, or an id pasted into it, and hands this bot a resolved id
         * whichever was used. A string option would mean parsing `<@&…>` here and
         * refusing a role that was named rather than mentioned.
         */
        type: ApplicationCommandOptionType.Role,
        name: REACTROLE_ROLE_OPTION,
        description: COPY.roleOption,
        required: true,
      },
      {
        /**
         * OPTIONAL, BECAUSE THREE OF THE FOUR SHAPES DO NOT NEED IT — and the
         * fourth is refused by name when it is missing rather than by Discord,
         * because "required" is one flag for the whole command and cannot say
         * "required when the message is `any`".
         */
        type: ApplicationCommandOptionType.Channel,
        name: REACTROLE_CHANNEL_OPTION,
        description: COPY.channelOption,
        required: false,
      },
    ],
  },

  /** ADMIN-ONLY, UNCONDITIONALLY. See the head of this file. */
  adminOnly: true,

  /**
   * EPHEMERAL. A pairing is a configuration: the members who will use it learn
   * about it from the message they are reacting to, not from a bot confirming to
   * a channel that an admin set something up. It also names a role and a channel
   * an admin may be arranging before anybody is meant to see either.
   */
  onlyInvoker: () => true,

  run: async (invocation) => {
    const desk = reactRoles()

    // No desk means `installReactionRoles` never ran, which is a bot whose client
    // was built without it or a test that did not inject one. There is nothing to
    // save a pairing into and nothing to check it against, so this is the command
    // failing rather than an admin being refused — `runCommand` sends the same
    // sentence for a handler that threw.
    if (desk === null) {
      log('error', 'a /reactrole arrived with no reaction-role desk installed', {
        user: invocation.userId,
      })

      return COMMAND_COPY.failed
    }

    const guildId = invocation.guildId

    // `refusalFor` has already refused an invocation with no guild on it, above
    // everything else and for every command. This is that fact spelled where the
    // type system can see it, and it writes no row against a guild it had to
    // invent.
    if (guildId === null) return COMMAND_COPY.failed

    const message = parseMessageRef(messageRefOf(invocation))
    if (message.kind === 'bad') return COPY.badMessage

    const emoji = parseEmojiRef(emojiRefOf(invocation))
    if (emoji.kind === 'bad') return COPY.badEmoji

    const roleId = roleOf(invocation)
    if (roleId === null) return COPY.noRole

    /**
     * @everyone, REFUSED HERE BECAUSE THE READINESS CHECK BELOW PASSES IT.
     * The default role carries the GUILD'S OWN ID, is not managed, and sits at
     * position 0, so `roleReadiness` finds a role, finds it unmanaged and finds
     * the bot's highest role above it: all six of its branches pass and the
     * pairing saves. What happens next is that Discord refuses every role edit a
     * reaction makes, forever, and the only trace is a warn per reaction in the
     * status channel that never reaches the admin who made the pairing.
     *
     * IT IS A LOCAL REFUSAL AND NOT A SEVENTH `RoleProblem`. The shared check in
     * ../banrole.ts is about `BLITZ_GAME_BAN_ROLE_ID`, which is an operator
     * setting rather than something typed into a picker, and widening its union
     * would put a sentence about a default role into a journal line addressed to
     * whoever runs the bot.
     */
    if (roleId === guildId) return COPY.everyoneRole

    const aim = aimFor(invocation, message)
    if ('no' in aim) return aim.no

    const target = aim.target

    /**
     * THE ROLE FIRST, BECAUSE IT COSTS NOTHING AND DECIDES EVERYTHING. The
     * standing check reads caches the gateway keeps up to date and makes no
     * request at all — `roleReadiness`'s own comment says so — where the two
     * checks below are REST calls. And a role this bot could not hand out makes
     * every other question moot: the pairing would save, the emoji would go on
     * the message, and the first member to click it would get nothing.
     */
    const standing = desk.role(roleId)
    if (!standing.ok) return ROLE_REFUSAL[standing.why]

    // THEN THAT THE THING POINTED AT IS THERE. A channel-wide pairing checks the
    // channel; a message pairing checks the message, which checks the channel on
    // the way past.
    const look =
      target.kind === 'message'
        ? await desk.message(target.channelId, target.messageId)
        : await desk.channel(target.channelId)

    if (look === 'no-channel') return COPY.noChannel
    if (look === 'no-message') return COPY.noMessage

    // AND THAT THE EMOJI IS ONE THIS BOT CAN USE. Only a custom one can fail
    // this: a unicode emoji belongs to nobody, and `any` is not an emoji at all.
    if (emoji.kind === 'custom' && !(await desk.emoji(emoji.key))) return COPY.foreignEmoji

    const pairing: ReactRolePairingInput = {
      messageId: keyFor(target),
      emoji: emoji.kind === 'any' ? REACTROLE_ANY : emoji.key,
      roleId,
      channelId: target.channelId,
      guildId,
      createdBy: invocation.userId,
    }

    const saved = await desk.save(pairing)

    if (!saved.ok) {
      log('error', 'a reaction role pairing could not be saved', {
        actor: invocation.userId,
        table: saved.failure.table,
        message: pairing.messageId,
        emoji: pairing.emoji,
        role: pairing.roleId,
        failure: saved.failure.kind,
        detail: saved.failure.message,
      })

      // The same sentence a handler that threw produces, which is what it is: the
      // admin asked for something, nothing was written, and the reason is in the
      // journal rather than in a Discord message naming a DynamoDB table.
      return COMMAND_COPY.failed
    }

    log('info', 'a reaction role pairing was saved', {
      actor: invocation.userId,
      message: pairing.messageId,
      emoji: pairing.emoji,
      role: pairing.roleId,
      channel: pairing.channelId,
    })

    /**
     * THE PRE-REACT, AND ONLY IN THE ONE SHAPE THAT HAS SOMETHING TO REACT TO.
     * It happens AFTER the pairing is written, which is the order that cannot
     * mislead anybody: an emoji on the message with no pairing behind it is a
     * button that does nothing, where a pairing with no emoji on the message is
     * simply one somebody has to react to first.
     */
    const reacted =
      target.kind === 'message' && emoji.kind !== 'any'
        ? await desk.react(target.channelId, target.messageId, emoji.react)
        : null

    return paragraph([
      lead(target, emoji, roleId),
      target.kind === 'message' && target.said ? COPY.lookedIn(`<#${target.channelId}>`) : null,
      reacted === null ? null : reacted ? COPY.reacted : COPY.notReacted,
    ])
  },
}
