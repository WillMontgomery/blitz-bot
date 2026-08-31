import { ApplicationCommandOptionType } from 'discord.js'

import type { Config } from '../config.ts'
import {
  createDrainer,
  DRAIN_NOTE_CAP,
  type CancelResult,
  type DrainFailure,
  type Drainer,
  type DrainResult,
  type DrainWindow,
} from '../ringmaster.ts'
import type { BotCommand, Invocation } from './command.ts'

/**
 * `/drain` — SCHEDULE THE MAINTENANCE WINDOW. THE MOST CONSEQUENTIAL COMMAND IN
 * THIS BOT, AND IT IS NOT CLOSE.
 *
 * Every other command answers a question, moves a message, or acts on one
 * person. This one stops the game server letting anybody in and then restarts
 * it, WHICH ENDS EVERY SESSION ON THE BOX. There is no version of running it by
 * accident that is cheap, which is why it is admin-only, ephemeral, split into
 * two named halves, and why the reply below spends its words saying what is
 * about to happen and when rather than confirming that a button was pressed.
 *
 * ═══ THE WORK IS THE CONSOLE'S AND THIS FILE ONLY ASKS ═══
 *
 * Nothing here writes the maintenance row. `../ringmaster.ts`'s drain section
 * argues that at length and the short version is: the console's driver deploys
 * ANY `scheduled` row it finds within fifteen seconds, and every gate that
 * makes a row safe to write — `nothingToDeploy`, the already-scheduled refusal
 * — lives in `POST /api/maintenance` and nowhere else. So this file's whole job
 * is to decide WHAT AN ADMIN IS TOLD, which is what a command file is for.
 *
 * ═══ TWO SUBCOMMANDS, AND IT IS NOT A TOGGLE ═══
 *
 * A window has five states — `scheduled`, `draining`, `deploying`, `complete`,
 * `cancelled` — and a toggle can only mean "the other one". A second `/drain`
 * during `deploying` has no meaning at all: the deploy has gone to the game box
 * and cannot be recalled, and the console says so in its own words when asked.
 * So scheduling and cancelling are two named things a person chooses between,
 * and neither of them is ever inferred from the current state.
 *
 * WHY SUBCOMMANDS RATHER THAN `/drain [note]` AND `/drain cancel` LITERALLY.
 * Discord's grammar does not allow both: a command that has subcommands may
 * have NO other options, so `/drain <note>` and `/drain cancel` cannot be the
 * same command. Of the shapes that are available, subcommands are the only one
 * where "cancel" is a thing an admin picks by name instead of a magic value
 * typed into a free-text box — and a note that happens to read "cancel" must
 * never call off a window.
 *
 * ═══ THE NOTE IS THE ADMIN'S WORDS OR NOBODY'S ═══
 *
 * `note` is shown to players turned away at the door, so this file neither
 * invents one nor edits one. It goes out exactly as typed, and when it is
 * absent it is OMITTED from the request so the console's own generated wording
 * is used — see `DrainInput.note` in ../ringmaster.ts.
 *
 * ═══ AND THE REPLY REPORTS WHAT CAME BACK ═══
 *
 * `scheduled` or a refusal, never "asked". The console's 409 carries a REASON —
 * "there is nothing to deploy", "a maintenance window is already scheduled,
 * cancel it first" — written for a person, and every refusal below shows it
 * verbatim rather than summarising it into a house sentence. This bot's opinion
 * about why a deploy was refused would be a second, worse copy of a rule it
 * cannot see.
 */

/**
 * The names Discord registers, and the name the note is read out of.
 *
 * ONE CONSTANT EACH SO THE TWO HALVES CANNOT DRIFT, exactly as
 * `STICKY_TEXT_OPTION` is one: this file declares them and `invocationOf` in
 * ./index.ts has to ask Discord for them by the same strings. A rename in only
 * one place is not a compile error — it is a `/drain` that reports an empty
 * note however much was typed, or a `/drain cancel` that falls through to the
 * "which half did you mean" refusal.
 *
 * `cancel` IS THE OWNER'S WORD, FROM THE BRIEF. `start` IS NOT — see
 * `COPY.startPlaceholderName`.
 */
export const DRAIN_START_SUBCOMMAND = 'start'
export const DRAIN_CANCEL_SUBCOMMAND = 'cancel'
export const DRAIN_NOTE_OPTION = 'note'

/**
 * The two fields this command needs that `Invocation` does not carry yet.
 *
 * WRITTEN AS OPTIONAL, AND THAT IS SCAFFOLDING RATHER THAN A DESIGN, exactly as
 * `StickyFields` was before `channelId` and `text` were wired: ./command.ts
 * says a command wanting an option which is not a target "grows a field here
 * and one line in `invocationOf`", and ./command.ts is not this agent's file to
 * edit. Declaring them as an intersection means this command compiles and
 * behaves sensibly against an invocation that carries them and against one that
 * does not — `invocationOf` in ./index.ts DOES carry both today.
 *
 * WHAT HAPPENS IF THEY EVER STOP ARRIVING: `/drain` refuses, in the channel,
 * saying which half it could not tell apart, rather than guessing at one and
 * restarting the game server. WHEN `Invocation` GROWS THEM, this interface
 * becomes two fields over there and this declaration can be deleted whole.
 */
export interface DrainFields {
  /** Which subcommand was invoked. `interaction.options.getSubcommand(false)`. */
  readonly subcommand?: string | null

  /** The text of the `note` option, when one was supplied. */
  readonly note?: string | null
}

/**
 * EVERY STRING `/drain` CAN SAY, IN ONE RECORD, under the rule ./command.ts
 * sets: a member-visible sentence lives here so that changing one is one edit
 * to one object.
 *
 * ═══ THE `PLACEHOLDER:` MARKER IS GONE, AND THE SENTENCES ARE THE OWNER'S ═══
 *
 * These were written as marked stand-ins, each one led by a literal
 * `PLACEHOLDER:` so that shipping one by accident was obvious in the channel
 * rather than invisible. He then ran the command and read them: "remove
 * PLACEHOLDER: from all text please. The verbiage otherwise looks great."
 *
 * SO THE MARKER WAS DELETED AND NOTHING ELSE WAS. Not a word after the colon
 * moved, and none was recapitalised — he approved the sentences AS THEY READ,
 * and an "improvement" made while removing a prefix is an edit he did not ask
 * for and cannot see in a diff he reviewed as a deletion.
 *
 * THE FACTS INSIDE THE FRAMES WERE ALWAYS REAL. `scheduled` and the refusals
 * interpolate the drain time the console returned and the console's own reason,
 * because the one thing this command must do is state plainly what is about to
 * happen and when.
 *
 * THE DESCRIPTIONS ARE MINE RATHER THAN HIS, for the reason /sticky's are:
 * Discord requires a description on a command, on a subcommand and on an
 * option, and will not accept an empty one. They are deliberately plain and
 * they are the strings to hand back when he wants his own.
 */
export const COPY = {
  /** Discord allows 1-100 characters on each of these four. */
  description: 'Take the server down for an update',
  startDescription: 'Stop letting players in, then update and restart the server',
  cancelDescription: 'Call off the maintenance window',
  noteOption: 'What players who try to join are told. Optional',

  /**
   * `start` IS A NAME NOBODY SUPPLIED. The brief says `/drain [note]` and
   * `/drain cancel`, and Discord cannot give both of those on one command (see
   * the header) — so the scheduling half needs a name of its own and this is
   * the one it was given. It is a COMMAND NAME rather than a sentence, so it
   * was never spelled with the marker the sentences carried; the constant is
   * kept, and named, so that "the word `start` was not his" stays sayable now
   * that every marked string in this file has had its marker removed.
   */
  startPlaceholderName: DRAIN_START_SUBCOMMAND,

  /** The reply's frames. */
  scheduledLead: 'no wording supplied yet for a window that was scheduled.',
  doorClosesAt: (at: string) => `the server stops accepting players ${at}.`,
  doorClosesUnknown: 'the console did not say when the server stops accepting players.',
  deployWhenEmpty:
    'it restarts on its own once the last match finishes, and everybody still playing is dropped then.',
  deployAtTime: (at: string) => `it restarts at ${at}, ending any match still running.`,
  deployModeUnknown: 'the console did not say what triggers the restart. Check the console.',
  doorNote: (note: string) => `players who try to join are told: ${note}`,
  doorNoteUnknown: 'the console did not say what players at the door are told.',

  cancelled: 'no wording supplied yet for a window that was called off.',

  /** The refusals. The console's own words follow each of these, unedited. */
  refused: (reason: string) => `nothing was scheduled. The console said: ${reason}`,
  cancelRefused: (reason: string) => `nothing was cancelled. The console said: ${reason}`,
  denied: (code: string) =>
    `the console would not accept this call and answered "${code}". An operator has to look at this.`,
  notConfigured:
    'the console has no command credential set, so it cannot take this. An operator has to look at this.',
  unreachable: (detail: string) =>
    `the console did not answer, so nothing is known to have happened: ${detail}. Run this again.`,
  unavailable: (detail: string) =>
    `the console answered but could not do this: ${detail}. Run this again in a moment.`,
  unknown: (detail: string) => `the console's answer could not be read: ${detail}. Check the console.`,

  /** And the two ways this command can fail before it asks anything. */
  noCredential: 'this bot has no command credential, so it cannot ask the console for anything.',
  noSubcommand: `it is not clear whether you meant \`/drain ${DRAIN_START_SUBCOMMAND}\` or \`/drain ${DRAIN_CANCEL_SUBCOMMAND}\`, so nothing was done.`,
}

/**
 * An instant as Discord renders one, or null.
 *
 * `<t:SECONDS:STYLE>` IS DISCORD'S OWN MARKUP AND NOT A WORDING CHOICE, which
 * is why it is used in place of a formatted date. Discord renders it in the
 * READER'S timezone and locale, so an admin in Sydney and one in Ohio are shown
 * the same instant in their own terms — and the bot never has to decide whose
 * clock a maintenance window is stated in. That decision, made wrongly, is the
 * bug the console fixed in its own scheduling route.
 *
 * SECONDS, NOT MILLISECONDS. Discord takes a Unix timestamp; handing it
 * milliseconds renders a date fifty thousand years out, which looks like a bug
 * in the server rather than in the message.
 *
 * `R` — RELATIVE — BECAUSE "in 3 minutes" IS THE THING BEING ASKED. `/drain`
 * closes the door immediately, so an absolute clock time reads as a schedule
 * for later; the relative form says "now" when it is now.
 */
function at(ms: number | null): string | null {
  if (ms === null) return null
  return `<t:${Math.floor(ms / 1000)}:R>`
}

/**
 * What is about to happen, and when, from the window the console handed back.
 *
 * READ OFF THE ANSWER AND NEVER OFF WHAT WE ASKED FOR. This command always
 * sends `drainInMinutes: 0` and `when-empty`, so it would be easy to write
 * those two facts as constants — and then the reply would keep saying them on
 * the day the route starts answering with something else. What is stated here
 * is what the console wrote onto the row.
 *
 * EACH UNREADABLE FIELD IS NAMED RATHER THAN GUESSED. A window with no
 * `drainStartsAt` on it is still a window, and the server is still going down;
 * saying "the console did not say when" is the honest half of a true sentence,
 * where a fallback of `Date.now()` would be a made-up promise about a live
 * server.
 */
function scheduledReply(window: DrainWindow): string {
  const closes = at(window.drainStartsAt)
  const deployAt = at(window.deployAt)

  const restart =
    window.deployMode === 'when-empty'
      ? COPY.deployWhenEmpty
      : window.deployMode === 'at-time' && deployAt !== null
        ? COPY.deployAtTime(deployAt)
        : COPY.deployModeUnknown

  return [
    COPY.scheduledLead,
    closes === null ? COPY.doorClosesUnknown : COPY.doorClosesAt(closes),
    restart,
    /**
     * THE NOTE IS ECHOED BACK SO THE ADMIN SEES WHAT PLAYERS WILL SEE, which is
     * the one thing about this window they cannot check anywhere else without
     * opening the console. It is their own text, or the console's generated
     * one, and it is not re-wrapped or trimmed here.
     *
     * MARKDOWN IN IT REACHES NOBODY ELSE. This reply is ephemeral — only the
     * person who ran the command is shown it — so a note containing a mention
     * or a code fence is a formatting oddity in one private message rather than
     * a thing the guild sees.
     */
    window.note === null ? COPY.doorNoteUnknown : COPY.doorNote(window.note),
  ].join('\n')
}

/**
 * One refusal, in whichever register it belongs to.
 *
 * FIVE FRAMES BECAUSE THERE ARE FIVE DIFFERENT NEXT ACTIONS. "The console
 * refused and here is why" is for the admin to read and act on; a `denied` or
 * `not-configured` is an operator's job and the admin needs to know it is not
 * theirs; `unreachable` and `unavailable` are worth running again; `unknown`
 * means look at the console. The console's own words ride inside every one of
 * them, unedited, because this file cannot know better than the route did.
 */
function refusalReply(
  failure: DrainFailure,
  detail: string,
  frame: (reason: string) => string,
): string {
  switch (failure) {
    case 'refused':
      return frame(detail)
    case 'denied':
      return COPY.denied(detail)
    case 'not-configured':
      return COPY.notConfigured
    case 'unreachable':
      return COPY.unreachable(detail)
    case 'unavailable':
      return COPY.unavailable(detail)
    case 'unknown':
      return COPY.unknown(detail)
  }
}

/** What one `/drain start` is answered with. */
export function replyForSchedule(result: DrainResult): string {
  return result.outcome === 'scheduled'
    ? scheduledReply(result.window)
    : refusalReply(result.failure, result.detail, COPY.refused)
}

/** And one `/drain cancel`. */
export function replyForCancel(result: CancelResult): string {
  return result.outcome === 'cancelled'
    ? COPY.cancelled
    : refusalReply(result.failure, result.detail, COPY.cancelRefused)
}

/** Which half was invoked, or null when the payload did not say. */
function subcommandOf(invocation: Invocation & DrainFields): string | null {
  const name = invocation.subcommand

  return typeof name === 'string' && name !== '' ? name : null
}

/**
 * The note as it arrived, or null.
 *
 * NOT TRIMMED, NOT DEFAULTED, NOT CHECKED FOR EMPTINESS BEYOND `''`. The
 * console's schema trims and caps it and the relay applies the same cap before
 * sending; a third opinion here about the admin's own words would be a third
 * place for them to differ. An empty string is treated as no note, so that an
 * option supplied blank gets the console's generated wording rather than
 * putting nothing on the door.
 */
function noteOf(invocation: Invocation & DrainFields): string | null {
  const note = invocation.note

  return typeof note === 'string' && note !== '' ? note : null
}

/** How the command reaches the console. Injected so the tests run offline. */
export type DrainerFor = (config: Config) => Drainer | null

/**
 * The real one, built on first use and kept.
 *
 * NULL WITHOUT A SECRET, which is the same switch `createClient` uses for the
 * live kick: no `COMMAND_SECRET` means there is no door to knock on, and the
 * command says so rather than sending a request that would come back 401.
 *
 * BUILT LAZILY FOR THE REASON `lazyReadsFrom` IS. The command list in ./index.ts
 * is a module-level constant, and it is imported by tests that run offline;
 * building the relay here at import would put a `fetch`-holding object in the
 * array for every one of them. One relay for the life of the process after
 * that, because it holds the credential and nothing else worth rebuilding.
 *
 * KEYED ON NOTHING, BECAUSE THE CONFIG IS READ ONCE AT BOOT AND NEVER CHANGES.
 * `loadConfig` runs in index.ts and the same object reaches every command, so
 * caching the first one cannot serve a stale URL to a later call.
 */
export function lazyDrainer(): DrainerFor {
  let built: Drainer | null = null

  return (config) => {
    if (config.commandSecret === null) return null

    return (built ??= createDrainer({
      baseUrl: config.ringmasterUrl,
      secret: config.commandSecret,
    }))
  }
}

/**
 * `/drain`.
 *
 * A FACTORY TAKING THE RELAY, exactly as `/profile` takes its reads. The
 * command is then a pure function of an invocation, a config and an injected
 * console — so every branch below, including the ones that restart a game
 * server, is exercised against an object literal in a test file with no
 * network anywhere near it.
 */
export function drainCommand(drainerFor: DrainerFor): BotCommand {
  return {
    data: {
      name: 'drain',
      description: COPY.description,

      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: DRAIN_START_SUBCOMMAND,
          description: COPY.startDescription,

          options: [
            {
              type: ApplicationCommandOptionType.String,

              // The name `invocationOf` has to read the note out of; see
              // `DRAIN_NOTE_OPTION`.
              name: DRAIN_NOTE_OPTION,
              description: COPY.noteOption,

              // OPTIONAL, AND THAT IS THE CONSOLE'S DESIGN RATHER THAN
              // LENIENCE. `scheduleSchema` says a note is "optional and usually
              // absent", because a maintenance window is always the same thing
              // and asking somebody to type that every time produces either the
              // same sentence or an empty one. An absent note gets the
              // console's generated wording, which is written by whoever wrote
              // the console rather than invented here.
              required: false,

              // Discord refuses the input in the client at the console's own
              // limit, so an over-long note is a thing an admin is stopped from
              // typing rather than a thing that is silently cut afterwards.
              maxLength: DRAIN_NOTE_CAP,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: DRAIN_CANCEL_SUBCOMMAND,
          description: COPY.cancelDescription,
        },
      ],
    },

    /**
     * ADMIN-ONLY, UNCONDITIONALLY. There is no half of this command that
     * answers about the caller and no invocation of it that is harmless, so the
     * gate is a boolean rather than a predicate — and `commandData` derives
     * `defaultMemberPermissions: 0n` from that word, which hides it from
     * everybody in the client as well. The hiding is a default and never the
     * guard; `refusalFor` in ./command.ts is.
     */
    adminOnly: true,

    /**
     * EPHEMERAL. Two reasons, and the second is the one that matters.
     *
     * The reply names the admin's note and the console's refusals, which are
     * operational detail rather than an announcement — and the announcement
     * already exists: ../maintenance.ts posts to the maintenance channel when
     * the window reaches `draining`, `deploying` and a CONFIRMED `complete`, in
     * the owner's chosen shape, for players rather than for admins. A visible
     * reply here would be a second notice of the same outage in a different
     * channel, carrying the console's refusal text and the admin's typed note,
     * neither of which is for players.
     *
     * THE DRAIN-START NOTICE IS THE MAINTENANCE CHANNEL'S AND NOT THIS REPLY'S,
     * which is worth stating because the rule it follows was reversed. He used
     * to want only the outage announced and not the planning; he now wants the
     * start of the window announced too — "A maintenance window has started and
     * the game server is no longer accepting new players or matches." That post
     * is made by ../maintenance.ts off the ROW, so it lands whether the window
     * came from here or from the console, which a reply built in this file
     * could never do.
     */
    onlyInvoker: () => true,

    run: async (invocation, config) => {
      const drainer = drainerFor(config)

      // No `COMMAND_SECRET` means there is no door. Saying so is better than a
      // request that comes back 401 and reads like the console is broken.
      if (drainer === null) return COPY.noCredential

      const subcommand = subcommandOf(invocation)

      /**
       * NEITHER HALF IS ASSUMED. Discord requires a subcommand on a command
       * declared with them, so this is a payload that is not what this file
       * expects rather than an admin who left it off — and the safe reading of
       * a `/drain` we cannot parse is not "probably the one that restarts the
       * server".
       */
      if (subcommand === DRAIN_CANCEL_SUBCOMMAND) {
        return replyForCancel(await drainer.cancel({ actorDiscordId: invocation.userId }))
      }

      if (subcommand !== DRAIN_START_SUBCOMMAND) return COPY.noSubcommand

      /**
       * `invocation.userId` IS THE WHOLE OF THE ATTRIBUTION, and it is the
       * admin who typed the command rather than this bot. The console puts that
       * id through the SAME Discord role gate the browser path runs and writes
       * the audit row against THEM — their license, their name, their id — so a
       * call carrying nobody is refused before anything is written. See
       * `SERVICE_ACTOR_HEADER` in ../ringmaster.ts.
       */
      return replyForSchedule(
        await drainer.schedule({
          actorDiscordId: invocation.userId,
          note: noteOf(invocation),
        }),
      )
    },
  }
}
