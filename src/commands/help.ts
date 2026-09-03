import { ApplicationCommandOptionType } from 'discord.js'

import { TARGET_OPTION, type BotCommand } from './command.ts'

/**
 * `/help` — points at the player guide.
 *
 * IT IS ALSO THE PROOF THAT THE FOUNDATION WORKS. Registration, the gate, the
 * defer and the reply flags all have to be right for this to say anything at
 * all, and it reaches no database and no other service, so when it misbehaves
 * the fault is in the wiring rather than in what the command was trying to do.
 *
 * ONE THING HERE IS NOT DECIDED YET, and it is one line. WHO MAY RUN IT:
 * `adminOnly` below is `false`, so anybody in the guild can. Flipping it to
 * `true` turns on the role check in `refusalFor` AND the
 * `defaultMemberPermissions: 0n` that hides it in the client, because
 * `commandData` derives the second from the first. One word, both halves.
 *
 * THERE WERE TWO, AND THE SECOND WAS ALREADY FALSE WHEN IT WAS WRITTEN DOWN. It
 * read "THE WORDING. Every string a member can see is in `COPY` below and every
 * one of them says PLACEHOLDER", over a record whose own comment says THE
 * OWNER'S WORDS, VERBATIM in capitals, and which has never contained the word.
 * The reply is his, character for character. The two Discord descriptions are
 * not his, and they are tagged where they are declared rather than described up
 * here, which is the whole reason this paragraph could go stale unnoticed.
 */

/**
 * THE OWNER'S WORDS, VERBATIM.
 *
 * The reply body is his, character for character, and the mention is
 * interpolated rather than prefixed because his sentence puts it inside itself
 * ("Hey @somebody, here's...") rather than on a line above.
 *
 * NO TARGET MEANS THE SENDER: "if they don't tag anyone, then simply assume
 * it's for themselves and tag the sender instead of some other subject". So
 * there is always exactly one mention and the sentence never has a hole in it.
 *
 * `description` AND `userOption` GO TO DISCORD AT REGISTRATION and are what
 * somebody reads in the command picker. Discord requires a description and
 * will not take an empty one, so these two are mine rather than his. They are
 * deliberately plain, and they are the two strings to hand back if he wants
 * his own.
 */
const COPY = {
  /** @unwritten picker — the `/help` command as Discord's picker describes it. Discord allows 1-100 characters. */
  description: 'Point somebody at the player guide',

  /** @unwritten picker — the `user` option of `/help`, in the picker. Same limit. */
  userOption: 'Who it is for. Leave it blank and it is for you.',

  /** His words. The mention is the only thing this fills in. */
  body: (mention: string) =>
    `Hey ${mention}, here's a help guide which might answer your question. ` +
    `It shows how to do just about everything on the server: ` +
    `https://blitz-royale.com`,
}

export const help: BotCommand = {
  data: {
    name: 'help',
    description: COPY.description,

    options: [
      {
        type: ApplicationCommandOptionType.User,

        // The name `invocationOf` reads the target out of, so the two cannot be
        // renamed apart. See `TARGET_OPTION`.
        name: TARGET_OPTION,
        description: COPY.userOption,

        // Optional, which is what "optionally aimed at a tagged user" means:
        // `/help` on its own has to keep working, and it is the common case.
        required: false,
      },
    ],
  },

  /**
   * THE ONE-LINE CHANGE. `true` here makes /help admin-only in both halves at
   * once — the role check and the client-side default. See the header.
   */
  adminOnly: false,

  /**
   * AIMED AT SOMEBODY ELSE MEANS THEY HAVE TO BE ABLE TO SEE IT. An ephemeral
   * reply is delivered to the person who ran the command and to nobody else, so
   * a `/help @someone` that was ephemeral would tag a member with something
   * only the tagger can read, which is the one shape of this command that
   * cannot work. With no target there is nobody else to show it to, so it stays
   * out of the channel.
   *
   * THE MENTION RENDERS AND NOTIFIES NOBODY. `createClient` sets
   * `allowedMentions: { parse: [] }` on the client, which applies to this reply
   * as it does to every other send: `<@id>` is displayed as the member's name
   * and no notification is delivered. Stated here as a fact about what the bot
   * currently does, not as a decision made in this file — whether being aimed
   * at somebody ought to ping them is the owner's call.
   */
  onlyInvoker: (invocation) => invocation.targetId === null,

  /**
   * ALWAYS EXACTLY ONE MENTION, and it is the sender when nobody was tagged.
   * His rule, and it is also what keeps the sentence whole: the body has a
   * hole in it that a mention fills, so there is no untagged variant of the
   * wording to write and no second string to keep in step with the first.
   */
  run: (invocation) =>
    COPY.body(`<@${invocation.targetId ?? invocation.userId}>`),
}
