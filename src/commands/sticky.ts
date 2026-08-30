import { ApplicationCommandOptionType } from 'discord.js'

import { stickies, stickyRefusal, STICKY_TEXT_CAP } from '../sticky.ts'
import type { BotCommand, Invocation } from './command.ts'

/**
 * `/sticky` and `/unsticky` — the two ends of the sticky message.
 *
 * `/sticky`, NOT `/pin`, AND THE NAME IS NOT A PREFERENCE. Discord already has
 * a pin: a native feature, a different list, a different permission, and a
 * pinned message does not move. An admin who ran `/pin` expecting Discord's
 * would get a message that keeps reposting itself and no entry in the pinned
 * list, and an admin who wanted this one would look for it in the pins and find
 * nothing. Two features with one name is a support conversation every time.
 *
 * THE HANDLERS ARE THREE LINES AND EVERY RULE IS IN sticky.ts. What is decided
 * here is what the admin is TOLD, which is this layer's job: the engine has no
 * opinion about wording and no way to reply.
 *
 * BOTH ARE ADMIN-ONLY. The owner's description is "an admin-only message", and
 * `adminOnly` is the whole of that in both halves — the role check in
 * `refusalFor` and the `defaultMemberPermissions: 0n` that `commandData`
 * derives from it.
 */

/**
 * The name of the option `/sticky`'s text is read out of.
 *
 * ONE CONSTANT SO THE TWO HALVES CANNOT DRIFT, exactly as `TARGET_OPTION` is
 * one for `/help`: this file declares an option by this name and `invocationOf`
 * in ./index.ts has to ask Discord for one by this name. A rename in only one
 * place is not a compile error — it is a `/sticky` that reports an empty
 * message however much text was typed into it.
 */
export const STICKY_TEXT_OPTION = 'text'

/**
 * The two fields these commands need that `Invocation` does not carry yet.
 *
 * WRITTEN AS OPTIONAL, AND THAT IS TEMPORARY SCAFFOLDING RATHER THAN A DESIGN.
 * `Invocation` is a record of what a decision needs, and ./command.ts says
 * outright that a command wanting an option which is not a target "grows a
 * field here and one line in `invocationOf`". These are those two fields, and
 * command.ts is not this agent's file to edit — so they are declared here as an
 * intersection instead, which means the commands compile and behave sensibly
 * against an invocation that has them and against one that does not.
 *
 * WHAT HAPPENS UNTIL THEY ARE WIRED: `/sticky` refuses, in the channel, with a
 * message saying what is missing, rather than sticking to the wrong channel or
 * posting an empty message. WHEN THEY ARE WIRED, this interface becomes
 * `Invocation`'s own two fields and this declaration can be deleted whole.
 */
export interface StickyFields {
  /** The channel the command was run in. `interaction.channelId`. */
  readonly channelId?: string | null

  /** The text of the `text` option, when one was supplied. */
  readonly text?: string | null
}

/**
 * PLACEHOLDER COPY, AND NONE OF IT IS THE OWNER'S WORDING, under the rule
 * ./command.ts sets: every string a member can see is in one record so that
 * supplying the real text is one edit to one object. The strings say what they
 * are on purpose — shipping one by accident has to be obvious rather than
 * invisible.
 *
 * `description` AND THE OPTION DESCRIPTION ARE MINE RATHER THAN HIS, for the
 * reason `/help`'s are: Discord requires a description on a command and on an
 * option and will not accept an empty one. They are deliberately plain and they
 * are the two strings to hand back when he wants his own.
 */
export const COPY = {
  /** Discord allows 1-100 characters here. */
  stickyDescription: 'Keep a message at the bottom of this channel',
  unstickyDescription: 'Stop keeping a message at the bottom of this channel',

  /** Same limit, on the option. */
  textOption: 'What the message says',

  set: "Sticky note set. To turn it off, use `/unsticky`",
  replaced: "Sticky note set. To turn it off, use `/unsticky`",
  cleared: "Sticky turned off.",
  nothingToClear: "There's nothing to unstick in this channel.",
  empty: 'PLACEHOLDER: no wording supplied yet for a sticky with no text in it.',
  tooLong: `PLACEHOLDER: no wording supplied yet for a sticky longer than ${STICKY_TEXT_CAP} characters.`,
  noChannel: "Something went wrong. Try again.",
  unavailable: "Something went wrong. Try again.",
}

/**
 * The channel this was run in, or null.
 *
 * A CHANNEL OPTION WAS THE ALTERNATIVE AND IT IS WORSE. `/sticky` is run by
 * somebody standing in the channel they want it in, and an option adds a thing
 * to get wrong — a sticky reposting itself every fifteen seconds in a channel
 * the admin is not looking at, which nobody notices until somebody complains.
 * The channel the command came from cannot be mistyped.
 */
function channelOf(invocation: Invocation & StickyFields): string | null {
  const channelId = invocation.channelId

  return typeof channelId === 'string' && channelId !== '' ? channelId : null
}

/** The `text` option as it arrived, or null when the invocation did not carry one. */
function textOf(invocation: Invocation & StickyFields): string | null {
  const text = invocation.text

  return typeof text === 'string' ? text : null
}

export const sticky: BotCommand = {
  data: {
    name: 'sticky',
    description: COPY.stickyDescription,

    options: [
      {
        type: ApplicationCommandOptionType.String,

        // The name `invocationOf` has to read the text out of; see
        // `STICKY_TEXT_OPTION`.
        name: STICKY_TEXT_OPTION,
        description: COPY.textOption,

        // Required, because there is no sensible sticky with no text. Discord
        // enforces this in the client, so the null branch below is for a
        // payload that did not carry the option at all rather than for an admin
        // who left it blank.
        required: true,
      },
    ],
  },

  adminOnly: true,

  /**
   * EPHEMERAL, AND NOT ONLY FOR TIDINESS. A visible reply is a message in the
   * channel, and a message in the channel is drift — the bot would push its own
   * sticky down by confirming that it had put it up, and then repost over it.
   * An ephemeral reply is not a channel message at all and nothing about it
   * reaches the counter.
   */
  onlyInvoker: () => true,

  run: async (invocation) => {
    const engine = stickies()

    // No engine means `installStickies` never ran, which is a bot whose client
    // was built without it or a test that did not inject one. Saying so is
    // better than a throw the admin reads as "the command is broken".
    if (engine === null) return COPY.unavailable

    const channelId = channelOf(invocation)
    if (channelId === null) return COPY.noChannel

    const text = textOf(invocation)
    if (text === null) return COPY.empty

    // Asked before anything is posted or written down, so that a text Discord
    // would refuse never reaches the state file — where it would be retried
    // every fifteen seconds with nobody left to tell about it.
    const refusal = stickyRefusal(text)
    if (refusal !== null) return refusal === 'empty' ? COPY.empty : COPY.tooLong

    // `/sticky` TWICE IN ONE CHANNEL REPLACES, IT DOES NOT STACK. Two stickies
    // in one channel is two messages fighting to be last, each reposting on top
    // of the other every fifteen seconds until the bucket is empty. The engine
    // answers which of the two happened so the admin is told.
    return (await engine.set(channelId, text)) ? COPY.replaced : COPY.set
  },
}

export const unsticky: BotCommand = {
  data: {
    name: 'unsticky',
    description: COPY.unstickyDescription,
  },

  adminOnly: true,

  /** The same reason as `/sticky`: a visible reply would be drift. */
  onlyInvoker: () => true,

  run: async (invocation) => {
    const engine = stickies()
    if (engine === null) return COPY.unavailable

    const channelId = channelOf(invocation)
    if (channelId === null) return COPY.noChannel

    // A channel with no sticky is not a failure — it is the answer to "is there
    // one here", and an admin who ran this twice needs to be told the second
    // one did nothing rather than shown the same confirmation again.
    return (await engine.clear(channelId)) ? COPY.cleared : COPY.nothingToClear
  },
}
