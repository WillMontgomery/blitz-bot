import { ApplicationCommandOptionType, type ApplicationCommandStringOptionData } from 'discord.js'

import type { Config } from '../config.ts'
import {
  createDevMaintenance,
  isMaintenanceLive,
  type DdbFailure,
  type DevMaintenance,
} from '../ddb.ts'
import { log } from '../log.ts'
import {
  capped,
  createDrainer,
  DRAIN_NOTE_CAP,
  type CancelResult,
  type DrainFailure,
  type Drainer,
  type DrainResult,
  type DrainWindow,
} from '../ringmaster.ts'
import { COPY as COMMAND_COPY, type BotCommand, type Invocation } from './command.ts'

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
 * ═══ EXCEPT ON DEV, WHERE THIS FILE WRITES THE ROW ITSELF ═══
 *
 * `server:dev` has no console to ask. The dev game box polls
 * `dev-ringmaster-maintenance` itself, a runner on that box deploys the dev
 * branch once it is empty, and the owner's rule is that the dev path must not
 * involve Ringmaster at all. So on dev the row IS the request, written through
 * `maintenanceWriter` in ../ddb.ts under the conditions both repos agreed on.
 * Leaving `server` out is prod, and prod is exactly what it was.
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
 * THE OPTION IS STILL HERE AND THE REPLY NO LONGER ECHOES IT (2026-09-05). He
 * asked for the "Players who try to join are told: …" sentence out of the drain
 * output and asked for nothing else, so the note keeps travelling to the console
 * — where a player at a closed door actually reads it — and the admin simply is
 * not read it back. See `COPY` for his words and `scheduledReply` for what is
 * left.
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
 * `cancel` IS THE OWNER'S WORD, FROM THE BRIEF. `start` IS NOT.
 */

/**
 * @unwritten picker — the `/drain` subcommand that schedules a window. The word `start` is the bot's; his brief said `/drain [note]`.
 */
export const DRAIN_START_SUBCOMMAND = 'start'
export const DRAIN_CANCEL_SUBCOMMAND = 'cancel'
export const DRAIN_NOTE_OPTION = 'note'

/**
 * The `server` option and its two choices, which are the owner's words.
 *
 * NOT REQUIRED, AND LEAVING IT OUT IS PROD. That is his decision, and it is why a
 * `/drain` typed the way it always was does exactly what it always did.
 */
export const DRAIN_SERVER_OPTION = 'server'
export const DRAIN_SERVER_PROD = 'prod'
export const DRAIN_SERVER_DEV = 'dev'

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

  /** The value of the `server` option, when one was supplied. Absent is prod. */
  readonly server?: string | null

  /**
   * The invoker's Discord display name, the guild's nickname first. Written onto
   * a dev window as `createdByName`; the prod path attributes by id alone.
   */
  readonly userDisplayName?: string | null
}

/**
 * The console's own reason, closed off so the sentence carrying it ends.
 *
 * THE TWO REFUSAL FRAMES THAT QUOTE THE ROUTE PUT ITS WORDS LAST, which is the
 * one thing that makes them different from every other frame in this file:
 * `Nothing was scheduled. The console said: …` finishes on a string this repo
 * did not write, and the route writes it both ways. `A maintenance window is
 * already scheduled. Cancel it first.` arrives with its own full stop, and
 * `nothing is scheduled` arrives with none — so a frame that only interpolates
 * ships an unfinished sentence whenever the route happens to send the second
 * kind, which is what an admin read.
 *
 * THE FULL STOP IS THE BOT'S AND IS ADDED ONLY WHERE THE REASON DID NOT BRING
 * ONE. Nothing else is touched: not a word of it, not its opening capital or
 * lack of one, and not a `.` `!` `?` or `…` it already ends with. That is the
 * same rule the frames themselves follow — this command cannot see what the
 * route looked at and must not paraphrase it — narrowed to the single character
 * that decides whether the BOT's sentence is finished.
 *
 * `trimEnd` SO THE STOP LANDS AGAINST THE LAST WORD rather than after a space.
 * `detail` reaches here through `str` in ../ringmaster.ts, which trims and
 * refuses an empty string, so this is belt on a value that is already clean.
 */
function ended(reason: string): string {
  const said = reason.trimEnd()

  return /[.!?…]$/u.test(said) ? said : `${said}.`
}

/**
 * EVERY STRING `/drain` CAN SAY, IN ONE RECORD, under the rule ./command.ts
 * sets: a member-visible sentence lives here so that changing one is one edit
 * to one object.
 *
 * ═══ REMOVING THE MARKER WAS NOT THE SAME AS SUPPLYING THE WORDS ═══
 *
 * These were written as marked stand-ins, each one led by a literal
 * `PLACEHOLDER:` so that shipping one by accident was obvious in the channel
 * rather than invisible. He then ran the command and read them: "remove
 * PLACEHOLDER: from all text please. The verbiage otherwise looks great."
 *
 * THE MARKER WAS DELETED FROM STRINGS THAT WERE STILL STAND-INS, and two of
 * them said so in their own words. `scheduledLead` read "no wording supplied
 * yet for a window that was scheduled." and `cancelled` read "no wording
 * supplied yet for a window that was called off." Stripping the prefix did not
 * make those sentences his — it only stopped them announcing what they were,
 * and the first line a real admin saw on a real `/drain start` was a stand-in
 * telling him no wording had been supplied. The lesson is that the marker was
 * the alarm and not the fault: a string with no owner's words in it is unshipped
 * whether or not it is labelled.
 *
 * SO THE SENTENCES BELOW ARE HIS, SUPPLIED AFTER HE READ THAT REPLY. The lead
 * is GONE rather than reworded — he wrote the start reply as three sentences
 * and none of them introduces the other two — and `cancelled` is his sentence.
 * The two fallbacks he named, for a console that did not say when the door
 * closes or what the note is, are kept and put into the same voice.
 *
 * TWO STRINGS HERE ARE NEITHER HIS NEW WORDING NOR STAND-INS: `deployAtTime`
 * and `deployModeUnknown`. He gave one restart sentence, for the mode this
 * command asks for, and the other two branches keep the words he approved
 * before with nothing changed but the capital they now need mid-paragraph. They
 * are flagged where they are declared, because a sentence he has not read in
 * its new company is a thing to ask about rather than to rewrite.
 *
 * THE FACTS INSIDE THE FRAMES WERE ALWAYS REAL. `scheduled` and the refusals
 * interpolate the drain time the console returned and the console's own reason,
 * because the one thing this command must do is state plainly what is about to
 * happen and when.
 *
 * AND THE REFUSALS ARE SENTENCES TOO, WHICH THEY WERE NOT WHEN THE FOUR SUCCESS
 * FRAMES WERE FIXED. They were written when the reply had a lead in front of it,
 * so each one opened lowercase and ran on from a clause that no longer exists —
 * `nothing was scheduled. The console said: a window is already open`, sent to
 * an admin as the whole message. That is the same fault the four lines had, in
 * the branch nobody re-read, and it is the second screenshot of unfinished-
 * looking text the owner has sent. What they SAY is unchanged; they open with a
 * capital and they close with a full stop, which for the two that end on the
 * console's own words means `ended` rather than a period glued onto somebody
 * else's sentence. See there.
 *
 * THE DESCRIPTIONS ARE MINE RATHER THAN HIS, for the reason /sticky's are:
 * Discord requires a description on a command, on a subcommand and on an
 * option, and will not accept an empty one. They are deliberately plain and
 * they are the strings to hand back when he wants his own — which is a promise
 * three files make and none of them could keep, so all four are tagged
 * `@unwritten picker` and `scripts/check-placeholders.ts` prints them in a group
 * of their own. `COPY.startPlaceholderName` existed to keep "the word `start`
 * was not his" sayable and is gone: the tag on `DRAIN_START_SUBCOMMAND` says it
 * where the word actually is, and says it to him rather than to a reader of this
 * file.
 */
export const COPY = {
  /** @unwritten picker — the `/drain` command as Discord's picker describes it. Discord allows 1-100 characters. */
  description: 'Take the server down for an update',

  /** @unwritten picker — the `/drain start` subcommand, in the picker. */
  startDescription: 'Stop letting players in, then update and restart the server',

  /** @unwritten picker — the `/drain cancel` subcommand, in the picker. */
  cancelDescription: 'Call off the maintenance window',

  /** @unwritten picker — the `note` option of `/drain start`, in the picker. */
  noteOption: 'What players who try to join are told. Optional',

  /** @unwritten picker - the `server` option of `/drain start` and `/drain cancel`, in the picker. */
  serverOption: 'Which server, prod or dev. Optional, prod when left out',

  /**
   * The two sentences of the start reply, in the order they are spoken.
   *
   * ONE PARAGRAPH AND NOT FOUR LINES. `scheduledReply` joins these with a
   * SPACE, and the reason is his, said three times: multi-line replies "look so
   * weird" and he asked for flowing sentences. So each of these is a whole
   * sentence — capital at the front, full stop at the back — because a fragment
   * that only worked as its own line reads as a stumble once the newline is
   * gone.
   *
   * ═══ THERE WERE THREE, AND HE TOOK THE THIRD OUT (2026-09-05) ═══
   *
   *   "'Players who try to join are told: a server update.' please remove this
   *    text from the drain command output"
   *
   * So `doorNote` and its `doorNoteUnknown` branch are gone, and with them the
   * `inert` that rendered somebody else's text safely inside that sentence —
   * this reply no longer carries a value this repo did not write.
   *
   * THE `note` OPTION IS NOT GONE AND WAS NOT WHAT HE ASKED ABOUT. It still
   * travels to the console and the console still shows it to a player who hits
   * the closed door; what he deleted is the echo back to the admin who typed it.
   * `COPY.noteOption` therefore still describes it truthfully — it says what
   * players are told, which is the option's job and never was this reply's.
   */
  /*
   * PAST TENSE, AND HE GAVE BOTH SENTENCES (2026-09-04):
   *
   *   "that should read as past-tense. How about 'The server stopped accepting
   *    players at [@time]. It will restart on it's own once all players have
   *    left.'"
   *
   * The door is already shut by the time an admin reads the reply -- the console
   * has accepted the window and answered -- so "stops" was describing something
   * that had happened as though it were about to.
   *
   * "it's" IS CORRECTED TO "its" AND HE ASKED FOR THAT (2026-09-04: "please
   * correct the typo to 'on its own'"). His words are quoted above exactly as
   * he typed them, because the quote is the record of what he asked for; the
   * SHIPPED string is the corrected one, because that is what he then asked to
   * ship. The two differing is the point, not a slip.
   *
   * `doorClosesUnknown` MOVED WITH IT, and that is the one line here he did not
   * type. It is the other branch of the SAME sentence in the same slot -- the
   * console failed to say WHEN the door shut -- so leaving it in the present
   * tense would put "stopped" and "stops" in the same paragraph depending on a
   * field the admin cannot see. Flagged to him rather than done quietly.
   */
  doorClosesAt: (at: string) => `The server stopped accepting players at ${at}.`,
  doorClosesUnknown: 'The console did not say when the server stopped accepting players.',
  deployWhenEmpty: 'It will restart on its own once all players have left.',

  /**
   * THE OTHER TWO RESTART BRANCHES, AND HE HAS NOT WORDED THESE TWO. He supplied
   * the `when-empty` sentence above, which is the mode this command asks for and
   * the only one he has ever been shown. These keep the words he approved
   * before, recapitalised for their place in the paragraph and not otherwise
   * touched — see the head of this record. They are not stand-ins: they are real
   * sentences awaiting a second opinion, and they read as finished copy because
   * they nearly are.
   *
   * WHICH IS WHY THEY WENT UNTRACKED, AND WHY THEY ARE TRACKED NOW. This comment
   * used to end "they must not be marked as any: a `PLACEHOLDER:` on them would
   * ship the marker to an admin the day the console answers `at-time`." That
   * objection was to the marker SHIPPING and it was right; the answer was not to
   * leave the two sentences off every list there is. The tag stays in the
   * comment and `scripts/check-placeholders.ts` prints them, so an admin sees
   * these words and the owner sees that nobody chose them.
   *
   * @unwritten admin — the restart sentence when the console schedules by time. He has only ever been shown the when-empty one.
   */
  deployAtTime: (at: string) => `It restarts at ${at}, ending any match still running.`,

  /** @unwritten admin — the restart sentence when the console did not say what triggers the restart. */
  deployModeUnknown: 'The console did not say what triggers the restart. Check the console.',

  cancelled: 'The maintenance window has been called off. The server is accepting players again.',

  /**
   * The refusals. The console's own words follow each of these, unedited.
   *
   * EVERY ONE OF THEM IS A WHOLE SENTENCE, for the reason the three start
   * sentences are — see the head of this record. There is no lead in front of
   * them and there has not been one for two changes now, so a lowercase opening
   * is not a continuation of anything: it is the first character an admin reads.
   *
   * THE TWO THAT QUOTE THE ROUTE END ON WORDS THIS FILE DID NOT WRITE, which is
   * why their full stop goes through `ended` instead of being typed into the
   * frame. `A maintenance window is already scheduled. Cancel it first.` brings
   * its own; `nothing is scheduled` does not, and a template that assumed either
   * way is wrong half the time. The other five end on this file's own clause and
   * need nothing.
   */
  refused: (reason: string) => `Nothing was scheduled. The console said: ${ended(reason)}`,
  cancelRefused: (reason: string) => `Nothing was cancelled. The console said: ${ended(reason)}`,
  denied: (code: string) =>
    `The console would not accept this call and answered "${code}". An operator has to look at this.`,
  notConfigured:
    'The console has no command credential set, so it cannot take this. An operator has to look at this.',
  unreachable: (detail: string) =>
    `The console did not answer, so nothing is known to have happened: ${detail}. Run this again.`,
  unavailable: (detail: string) =>
    `The console answered but could not do this: ${detail}. Run this again in a moment.`,
  unknown: (detail: string) => `The console's answer could not be read: ${detail}. Check the console.`,

  /**
   * `server:dev`'s refusals, which have no console to quote.
   *
   * THESE THREE ARE RINGMASTER'S OWN SENTENCES, TRANSCRIBED RATHER THAN WRITTEN:
   * `alreadyOpen` from `schedule` in fivem-ringmaster/src/lib/maintenance.ts, the
   * other two from its `api/maintenance/cancel` route. A dev drain is refused in
   * the words a prod one is, without the frame that says a console said them.
   * A DynamoDB failure on that path answers with ./command.ts's `COPY.failed`.
   */
  alreadyOpen: 'A maintenance window is already scheduled. Cancel it first.',
  nothingToCancel: 'There is no maintenance window to cancel.',
  deployStarted: 'The deploy has already started. It cannot be cancelled now.',

  /** @unwritten admin - `/drain cancel server:dev` refused because the live dev window is a host-patch window, which only blitz-patch closes. */
  hostPatchWindow: 'This maintenance window was opened by host patching, so it cannot be cancelled here.',

  /** And the ways this command can fail before it asks anything. */
  noCredential: 'This bot has no command credential, so it cannot ask the console for anything.',
  noSubcommand: `It is not clear whether you meant \`/drain ${DRAIN_START_SUBCOMMAND}\` or \`/drain ${DRAIN_CANCEL_SUBCOMMAND}\`, so nothing was done.`,

  /** @unwritten admin - `/drain` refused because its `server` option carried something other than prod or dev. */
  noServer: `It is not clear whether you meant \`${DRAIN_SERVER_PROD}\` or \`${DRAIN_SERVER_DEV}\`, so nothing was done.`,
}

/**
 * The Discord timestamp style every instant in this reply is rendered with.
 *
 * ONE CONSTANT SO THE DOOR AND THE RESTART CANNOT DRIFT INTO TWO STYLES. They
 * are two instants in one paragraph, and a relative one standing beside an
 * absolute one reads as two different kinds of fact. See `at` for why it is
 * this letter and not `R`.
 */
const TIMESTAMP_STYLE = 't'

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
 * ═══ `t` — SHORT TIME — AND `R` WAS A BUG RATHER THAN A TASTE ═══
 *
 * IT USED TO BE `R`, RELATIVE, ON THE ARGUMENT THAT "in 3 minutes" IS THE THING
 * BEING ASKED. What an admin actually read was `The server stops accepting
 * players a minute ago.` — A PRESENT-TENSE VERB WELDED TO A PAST-TENSE STAMP,
 * in one sentence, contradicting itself.
 *
 * AND IT WAS NOT A RACE THAT NEEDED LOSING. `/drain` closes the door
 * immediately, so `drainStartsAt` is at most seconds in the future when the
 * reply is composed and is in the PAST for the entire rest of the message's
 * life. Discord re-renders `R` live, in the reader's client, forever: this
 * reply is ephemeral but it sits on screen as long as the admin leaves it
 * there, and every second of that it reads more wrongly than the last. A stamp
 * whose truth expires cannot go in a sentence whose tense does not.
 *
 * `t` IS A CLOCK TIME — `16:20` — AND NOT A DATE. Of the styles Discord has,
 * `d`/`D` are dates with no time on them, `f`/`F` are a full date AND time, and
 * `T` is a clock time with the seconds shown. `t` is the one that says what
 * hour and minute the door shuts and nothing else, which is what the sentence
 * around it needs: the window is minutes away, so naming the day would be
 * saying something nobody asked and the seconds would be false precision on a
 * value the console rounds anyway.
 *
 * IT IS STILL RENDERED IN THE READER'S OWN TIMEZONE, which is the whole reason
 * this is markup rather than a formatted date — see above. Absolute here means
 * "a fixed instant", not "in the bot's timezone".
 */
function at(ms: number | null): string | null {
  if (ms === null) return null
  return `<t:${Math.floor(ms / 1000)}:${TIMESTAMP_STYLE}>`
}

/**
 * ═══ `inert` AND `cut` STOOD HERE, AND THEY WENT WITH THE SENTENCE THEY
 * GUARDED (2026-09-05) ═══
 *
 * NOT SIMPLIFIED AWAY — ORPHANED. `inert` was a deliberate copy of
 * ../incidents.ts's function of the same name: it wrapped the note in `` ` ` ``
 * so that a masked link, a forged `<t:…>`, a `> quote`, a `||spoiler||` or a
 * bare url typed into it rendered as characters rather than as markup inside a
 * paragraph a reader takes to be the bot speaking, and it flattened `\s+` to one
 * space so that somebody else's line break could not put half the reply on a
 * second line. `cut` was its budget, on code points so a UTF-16 slice could not
 * leave half a character in the reply. Both had exactly one caller — the
 * `Players who try to join are told: …` sentence — and he asked for that
 * sentence out, so neither has a caller now.
 *
 * WHAT THE ARGUMENT WAS FOR, IN CASE IT IS NEEDED AGAIN: this reply no longer
 * interpolates ANY value this repo did not write on the success path, so there
 * is nothing here left to render inert. The refusal frames still carry the
 * console's own reason — see `ended` and `refusalReply` — and the reason THAT is
 * safe is not markdown at all: `responderFor` in ./index.ts sends every reply
 * with `allowedMentions: { parse: [] }`, which is what stops an `@everyone` in
 * borrowed text from notifying a guild. ./drain.test.ts proves that on the
 * refusal path now that the note is not there to prove it on.
 *
 * IF A BORROWED VALUE EVER RETURNS TO THIS FILE, take ../incidents.ts's `inert`
 * rather than writing a third opinion about escaping; the day it is exported,
 * import it.
 */

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

  /**
   * ONE PARAGRAPH. JOINED WITH A SPACE, AND THERE IS NO NEWLINE IN THIS FILE.
   *
   * THIS USED TO BE `join('\n')` AND IT SHIPPED AS FOUR LINES. He has said
   * three times that multi-line replies "look so weird" and asked for flowing
   * sentences, so the separator is the one thing here that is not negotiable.
   * ./drain.test.ts asserts the absence of a line break over the whole reply
   * rather than over this line, so a newline smuggled into any frame — a
   * refusal carrying the console's own multi-line reason, now that the note is
   * gone — fails there.
   *
   * AND THE LEAD IS GONE RATHER THAN REWORDED. The four lines opened with a
   * stand-in that told a real admin no wording had been supplied; the reply he
   * then wrote introduces itself.
   *
   * TWO SENTENCES, NOT THREE. `window.note` is deliberately not read here any
   * more — see `COPY` for the words he removed and for why the option that
   * carries it stays.
   */
  return [closes === null ? COPY.doorClosesUnknown : COPY.doorClosesAt(closes), restart].join(' ')
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

/**
 * Which server, or null when the option carried something that is neither.
 *
 * ABSENT IS PROD, WHICH IS THE OWNER'S DECISION. A value that is not one of the
 * two choices is a payload Discord would not have sent, and it is refused rather
 * than read as the server that ends real players' matches, for the reason an
 * unreadable subcommand is.
 */
function serverOf(
  invocation: Invocation & DrainFields,
): typeof DRAIN_SERVER_PROD | typeof DRAIN_SERVER_DEV | null {
  const server = invocation.server

  if (server === undefined || server === null) return DRAIN_SERVER_PROD
  return server === DRAIN_SERVER_PROD || server === DRAIN_SERVER_DEV ? server : null
}

/**
 * Who a dev window is attributed to by name. The invoker's id when the seam
 * carried no display name, which `invocationOf` in ./index.ts always does.
 */
function nameOf(invocation: Invocation & DrainFields): string {
  const name = invocation.userDisplayName

  return typeof name === 'string' && name.trim() !== '' ? name : invocation.userId
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

/** How the command reaches the dev table. Injected so the tests run offline. */
export type DevMaintenanceFor = () => DevMaintenance

/**
 * The real one, built on first use and kept, for `lazyDrainer`'s reasons.
 *
 * NO PREFIX AND NO TABLE NAME. `createDevMaintenance` forces the dev prefixes,
 * so neither is chosen here. No secret gates it: nothing here asks the console
 * for anything.
 */
export function lazyDevMaintenance(): DevMaintenanceFor {
  let built: DevMaintenance | null = null

  return () => (built ??= createDevMaintenance())
}

/**
 * How recently a row must have been cancelled for a refused cancel to be read as
 * this one. The update, with the SDK's one retry inside it, and the read after it
 * each run under ../ddb.ts's two-second deadline, so a retry of a cancel that
 * landed reads back well inside this. A window somebody else called off in the
 * same seconds is off too, so the reply is still true.
 */
const JUST_CANCELLED_MS = 10_000

/**
 * How loudly a dev-table failure is journaled, for `levelFor`'s reason in
 * ../ringmaster.ts. A timeout or an unrecognized error may pass on the next try;
 * a missing table, a denial or no credentials is an operator's to fix.
 */
function devLevel(failure: DdbFailure): 'warn' | 'error' {
  return failure.kind === 'timeout' || failure.kind === 'error' ? 'warn' : 'error'
}

/**
 * `/drain start server:dev`: open the window by writing the row.
 *
 * THE REPLY IS PROD'S, READ OFF THE ROW THAT WAS WRITTEN. The door closes now and
 * the restart waits for the box to empty, which is what `scheduledReply` says.
 *
 * THE NOTE IS CAPPED BY THE RELAY'S OWN `capped`, so a dev note is trimmed and
 * cut exactly as a prod one is before the console ever sees it.
 */
async function startDev(invocation: Invocation & DrainFields, dev: DevMaintenance): Promise<string> {
  const where = { actor: invocation.userId, table: dev.tables.maintenance }

  const opened = await dev.maintenanceWriter.open({
    createdBy: invocation.userId,
    createdByName: nameOf(invocation),
    note: capped(noteOf(invocation), DRAIN_NOTE_CAP),
  })

  if (opened.ok) {
    // Info, for the reason the prod line is: an admin asked for exactly this.
    log('info', 'a dev maintenance window was opened and the dev server will restart', {
      ...where,
      drainStartsAt: opened.value.drainStartsAt,
    })

    return scheduledReply({
      state: opened.value.state,
      note: opened.value.note ?? null,
      drainStartsAt: opened.value.drainStartsAt,
      deployMode: opened.value.deployMode,
      deployAt: opened.value.deployAt,
    })
  }

  if (opened.failure.kind === 'conflict') {
    log('info', 'no dev maintenance window was opened because one is already live', where)
    return COPY.alreadyOpen
  }

  log(devLevel(opened.failure), 'the dev maintenance window could not be written', {
    ...where,
    failure: opened.failure.kind,
    detail: opened.failure.message,
  })

  return COMMAND_COPY.failed
}

/**
 * `/drain cancel server:dev`: call the window off by updating the row.
 *
 * A REFUSED UPDATE IS THEN READ, ONLY TO SAY WHY. The update is the act and its
 * condition is the rule; the read afterwards picks which of Ringmaster's
 * sentences is true of what is actually there. A row that now looks cancellable
 * changed between the two, and that is answered as a failure rather than guessed.
 * A row cancelled in the last few seconds is answered as cancelled; see
 * `JUST_CANCELLED_MS`.
 */
async function cancelDev(invocation: Invocation & DrainFields, dev: DevMaintenance): Promise<string> {
  const where = { actor: invocation.userId, table: dev.tables.maintenance }

  const cancelled = await dev.maintenanceWriter.cancel()

  if (cancelled.ok) {
    log('info', 'the dev maintenance window was cancelled', where)
    return COPY.cancelled
  }

  if (cancelled.failure.kind !== 'conflict') {
    log(devLevel(cancelled.failure), 'the dev maintenance window could not be cancelled', {
      ...where,
      failure: cancelled.failure.kind,
      detail: cancelled.failure.message,
    })

    return COMMAND_COPY.failed
  }

  const seen = await dev.maintenanceWriter.current()

  if (!seen.ok) {
    log(devLevel(seen.failure), 'the dev maintenance window refused a cancel and could not be read', {
      ...where,
      failure: seen.failure.kind,
      detail: seen.failure.message,
    })

    return COMMAND_COPY.failed
  }

  const window = seen.value

  // An update that landed and lost its answer is retried into its own condition
  // and refused. The window is off either way, so the admin is told it is.
  if (
    window?.state === 'cancelled' &&
    typeof window.cancelledAt === 'number' &&
    Math.abs(Date.now() - window.cancelledAt) <= JUST_CANCELLED_MS
  ) {
    log('info', 'the dev maintenance window was cancelled', { ...where, cancelledAt: window.cancelledAt })
    return COPY.cancelled
  }

  log('info', 'the dev maintenance window was not cancelled', { ...where, state: window?.state })

  if (!isMaintenanceLive(window)) return COPY.nothingToCancel
  if (window.hostPatch === true) return COPY.hostPatchWindow
  if (window.state === 'deploying') return COPY.deployStarted

  return COMMAND_COPY.failed
}

/** Which dev half was invoked. Neither half is assumed, exactly as on prod. */
async function runDev(invocation: Invocation & DrainFields, devFor: DevMaintenanceFor): Promise<string> {
  const subcommand = subcommandOf(invocation)

  if (subcommand === DRAIN_CANCEL_SUBCOMMAND) return cancelDev(invocation, devFor())
  if (subcommand !== DRAIN_START_SUBCOMMAND) return COPY.noSubcommand

  return startDev(invocation, devFor())
}

/**
 * The `server` option, declared on both halves.
 *
 * A FUNCTION SO EACH HALF HOLDS ITS OWN OBJECT. Discord's grammar puts options
 * inside the subcommand, so the one declaration has to appear twice.
 */
function serverOptionData(): ApplicationCommandStringOptionData {
  return {
    type: ApplicationCommandOptionType.String,
    name: DRAIN_SERVER_OPTION,
    description: COPY.serverOption,
    required: false,
    choices: [
      { name: DRAIN_SERVER_PROD, value: DRAIN_SERVER_PROD },
      { name: DRAIN_SERVER_DEV, value: DRAIN_SERVER_DEV },
    ],
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
export function drainCommand(
  drainerFor: DrainerFor,
  devMaintenanceFor: DevMaintenanceFor,
): BotCommand {
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
            serverOptionData(),
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: DRAIN_CANCEL_SUBCOMMAND,
          description: COPY.cancelDescription,
          options: [serverOptionData()],
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
      /**
       * THE SERVER FIRST, BECAUSE IT DECIDES WHETHER THE CONSOLE IS INVOLVED AT
       * ALL. Prod, named or left out, runs every line below this block exactly as
       * it ran before the option existed. Dev never reaches `drainerFor`, so it
       * needs no `COMMAND_SECRET`.
       */
      const server = serverOf(invocation)

      if (server === null) return COPY.noServer
      if (server === DRAIN_SERVER_DEV) return runDev(invocation, devMaintenanceFor)

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
