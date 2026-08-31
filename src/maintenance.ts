import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client } from 'discord.js'

import { connectIp, DEFAULT_SERVER_IPS } from './config.ts'
import type { Ddb, DdbResult, MaintenanceState, MaintenanceWindow } from './ddb.ts'
import { log } from './log.ts'

/**
 * THE OUTAGE, ANNOUNCED IN A CHANNEL PLAYERS READ — AND NOTHING ELSE.
 *
 * The console already runs the whole maintenance lifecycle: an admin schedules
 * a window, the server stops letting people in, it deploys, it comes back. All
 * of that is in `ringmaster-maintenance` and all of it is visible in the
 * console. What was missing is the half that reaches somebody who is not
 * looking at the console — a player who tries to connect and cannot, or who is
 * dropped mid-match and does not know whether to wait five minutes or give up.
 *
 * THREE POSTS PER WINDOW, AND THE OWNER PICKED WHICH THREE. Into `draining`:
 * a maintenance window has started and nobody new is getting in. Into
 * `deploying`: the server is going down. Into a CONFIRMED `complete`: the
 * server is back and here is the address. `scheduled` and `cancelled` post
 * NOTHING — he does not want the planning announced. That is not an oversight
 * to be helpfully filled in later: a channel that also carried "a window has
 * been scheduled for 3am" and then "it was cancelled" is a channel that has
 * said two things about an outage that never happened, and the next real
 * notice in it is read with that much less attention.
 *
 * ═══ THE DRAIN NOTICE REVERSES AN EARLIER RULE, ON PURPOSE ═══
 *
 * This file used to post at `deploying` and `complete` and nowhere else, under
 * his instruction that the planning was not to be announced. He has since said
 * the opposite about one of the three: the START of the window is to be
 * announced too, "whether it came from /drain or from the console", in his
 * words — "A maintenance window has started and the game server is no longer
 * accepting new players or matches." That is not the planning; it is the moment
 * the door shuts, which a player hits as a refused connection. `scheduled` and
 * `cancelled` are still silent, and that half of the old rule stands.
 *
 * ═══ AND `complete` NO LONGER MEANS THE SERVER IS ANSWERING ═══
 *
 * "The maintenance complete message should NEVER show until br_ringmaster has
 * delivered its first heartbeat." The console marks a window `complete` when
 * the deploy VERB returns, which is the moment `royale-deploy` has been kicked
 * off rather than the moment FXServer is back — so "the server is back" used to
 * land over a box that was still down. See `heartbeatAfterDeploy` for the one
 * field on this row that can prove the game is speaking again, and
 * `RESTART_GRACE_MS` for what is said when it never does.
 *
 * NAMED, NEVER TAGGED. `createdByName` is a plain display name and goes into
 * the post as text; nothing here mentions, pings or resolves anybody. The
 * owner's rule, and `post` states it at the send rather than trusting a
 * client-wide default that any other send can replace.
 *
 * READS ONLY. This module calls exactly one thing on the data layer —
 * `maintenance.current()`, a GetItem against one row — and the parameter type
 * below is `Pick<Ddb, 'maintenance'>` so that is not a promise in a comment.
 * Nothing here writes a Ringmaster table. The console owns this lifecycle and
 * owns the consequences of moving it; a Discord bot that could mark a window
 * complete would be a second, less careful implementation of a path that stops
 * a live server.
 *
 * A GETITEM ON A TIMER RATHER THAN A STREAM OR A WEBHOOK. DynamoDB Streams
 * would be exact and would need a Lambda, an IAM role and a second deployable;
 * a webhook from the console would need the console to know this bot exists.
 * One GetItem every fifteen seconds against a one-row table is a few thousand
 * reads a day against a table that is already provisioned, and the only cost
 * of the polling model is latency measured against the fifteen seconds.
 */

/**
 * How often the row is read.
 *
 * FIFTEEN SECONDS IS A LATENCY BUDGET, NOT A COST ONE. The read is trivially
 * cheap either way; what it buys is how stale "the server is going down" is
 * allowed to be by the time it lands, and a notice that arrives after the
 * server has already dropped everybody is not a warning, it is an epitaph.
 *
 * IT IS ALSO THE WIDTH OF THE ONE RACE THIS MODULE CANNOT WIN — see
 * `noticeFor`, where a window that is created AND deployed inside a single
 * interval is silent.
 */
export const MAINTENANCE_POLL_MS = 15_000

/**
 * How many failed reads in a row before a person is told.
 *
 * ONE FAILED READ IS A POLL, NOT A PROBLEM. The next one is fifteen seconds
 * away and will almost always succeed, and log.ts is explicit that a call the
 * next attempt will make again is `info`. A MINUTE of them is different: it
 * means the bot cannot see maintenance at all, and the consequence of that is
 * the thing worth stating — see `blind`.
 */
const MAINTENANCE_BLIND_POLLS = 4

/**
 * How long a restart is allowed to explain the game's silence.
 *
 * THE CONSOLE'S OWN NUMBER, AND A COPY OF `RESTART_GRACE_MS` IN ITS
 * lib/serverPhase.ts. Same argument, from the other side of the same wait:
 * `royale-deploy` syncs resources and restarts FXServer, which is tens of
 * seconds, and the game pushes every two. Anything past five minutes is not a
 * slow restart, it is a problem — and at that point the honest thing is to stop
 * offering an excuse.
 *
 * A WAIT WITH NO END IS NOT A WAIT, IT IS SILENCE. The owner's rule is that the
 * complete notice must never show before the game speaks; the bound is what
 * stops that rule from turning a server which never came back into a channel
 * that says nothing at all. "A server that never came back is exactly what an
 * admin needs to know."
 *
 * IF THE CONSOLE RETUNES ITS NUMBER THIS ONE MUST FOLLOW. Nothing enforces
 * that; it is why this comment names the file. Being generous in the same
 * direction is the safe way to be wrong — a bot that alarms EARLIER than the
 * console's own page would be raising an alarm the console is still calling a
 * restart in progress.
 */
export const RESTART_GRACE_MS = 5 * 60_000

/**
 * How recently a transition must have happened to be announced by a bot that
 * did not watch it arrive.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * `noticeFor`'s oldest rule is that a window this bot has no mark for is never
 * announced, because it cannot tell a window that started a second ago from one
 * that ran while the process was down. That rule alone would have made the
 * drain notice fire almost never. `POST /api/maintenance` ends with
 * `ensureDriver(); void tick()` — the console drives the window it has just
 * written IMMEDIATELY — and `/drain` schedules with the drain starting now, so
 * the `scheduled` state exists for well under a second and this bot's very
 * first sight of a `/drain` is a row that is ALREADY `draining`. A rule that
 * required having seen the state before would have shipped a notice that only
 * lands for windows somebody scheduled for later.
 *
 * SO RECENCY REPLACES MEMORY, AND ONLY FOR THE TWO LIVE STATES. A window that
 * began draining thirty seconds ago is happening NOW whether or not this
 * process watched it start, and saying so is a warning rather than a history
 * lesson. `complete` is deliberately NOT given this door: "the server is back"
 * about a window the bot never saw go down is the catch-up post the owner ruled
 * out, and it is the one notice that can be hours late without looking it.
 *
 * TWO MINUTES IS EIGHT POLLS, WHICH IS THE POINT OF THE SIZE. It has to be
 * several intervals wide or an ordinary poll landing at the wrong moment would
 * miss the transition it exists to catch; and it has to be far shorter than a
 * drain, which waits for the last match to finish and can run for hours, so
 * that a bot restarted mid-window announces nothing an admin watched happen
 * half an hour ago.
 */
export const FRESH_TRANSITION_MS = 120_000

/**
 * The five states, as values, so a string off disk can be checked against them.
 *
 * TYPED AS THE UNION, so a sixth state added to ddb.ts and forgotten here is a
 * compile error rather than a mark that silently stops parsing.
 */
const STATES: readonly MaintenanceState[] = [
  'scheduled',
  'draining',
  'deploying',
  'complete',
  'cancelled',
]

function isState(raw: string): raw is MaintenanceState {
  return (STATES as readonly string[]).includes(raw)
}

/* ------------------------------------------------------------------ *
 * What this bot remembers between polls, and between restarts.
 * ------------------------------------------------------------------ */

/**
 * The last thing this bot SAW, which is deliberately more than the last thing
 * it POSTED.
 *
 * WHY OBSERVED AND NOT POSTED, since only two of the five states are ever
 * posted about. The posting rule below is "this window moved while we were
 * watching", and answering that needs the states nothing is said about as much
 * as the two that are. Consider a window recorded only when it is announced:
 * the mark still names LAST week's window while this one runs through
 * `scheduled` and `draining` under our nose, so when it reaches `deploying`
 * the mark disagrees about which window this is and the notice — the one post
 * that actually matters — is suppressed as a catch-up. Recording every
 * observation is what makes "we watched this window arrive" a fact the file
 * can carry.
 *
 * THE WINDOW IS IDENTIFIED BY `createdAt`, NOT BY `id`. `id` is the table's
 * key and it is the literal string `current` on every row there will ever be —
 * `ringmaster-maintenance` holds ONE item and the console overwrites it for
 * each new window (lib/maintenance.ts, `schedule`). `createdAt` is stamped
 * with `Date.now()` in that same write, so it is the only field on the row
 * that distinguishes this window from the one before it.
 */
interface Mark {
  /** The window's `createdAt`. See above: `id` is a constant. */
  readonly window: number
  readonly state: MaintenanceState
}

/**
 * The mark, across a restart.
 *
 * STRUCTURAL FOR THE REASON `CommitFiles` IN client.ts IS: the rules about
 * what posts and what stays quiet are the difficult part, and every one of
 * them — a missing file, an unreadable one, a file holding something that is
 * not a mark, a disk that will not take the write — is worth a case without a
 * test having to arrange it on a real filesystem.
 */
export interface MaintenanceMemory {
  /** What this bot last saw. Rejects with ENOENT when it has never seen anything. */
  readonly seen: () => Promise<string>

  /** Record what was seen. */
  readonly remember: (mark: string) => Promise<void>
}

/**
 * Where the mark lives.
 *
 * THE UNIT'S `StateDirectory=`, FOR THE REASON client.ts's `reportedCommitPath`
 * IS THERE: the updater owns /opt/blitz-bot and resets it, so anything this bot
 * remembers under the repo is a file the next update discards — and a
 * forgotten mark is a re-announced outage. /var/lib/blitz-bot is created by
 * systemd, stays writable under `ProtectSystem=strict`, and survives a reboot.
 *
 * THE FOUR LINES ARE A COPY OF client.ts's AND NOT AN IMPORT, which is a real
 * cost paid for a real reason: client.ts is the file that WIRES this module, so
 * importing back out of it would make the two a cycle. The literal fallback has
 * to stay in step with `StateDirectory=` in deploy/blitz-bot.service, which is
 * what log.test.ts already checks for the other file in this directory.
 */
export function maintenanceStatePath(): string {
  const [first] = (process.env.STATE_DIRECTORY ?? '').split(':')
  const state = first === undefined || first === '' ? '/var/lib/blitz-bot' : first

  return join(state, 'maintenance-seen')
}

export function maintenanceMemory(path: string = maintenanceStatePath()): MaintenanceMemory {
  return {
    seen: () => readFile(path, 'utf8'),

    // A trailing newline, like the reported-commit file beside it, so an
    // operator can `cat` it without the next prompt running into the value.
    remember: (mark) => writeFile(path, `${mark}\n`, 'utf8'),
  }
}

function formatMark(mark: Mark): string {
  return `${mark.window} ${mark.state}`
}

/**
 * A mark out of whatever is in the file, or null.
 *
 * NULL FOR ANYTHING THAT IS NOT EXACTLY A MARK, and null is the SILENT
 * direction: a bot with no memory treats the window it finds as one it never
 * saw begin and announces nothing about it. That is the right way to fail. The
 * alternative — half-parsing, keeping the state and guessing at the window —
 * makes a corrupted file into a bot that announces an outage that ended
 * yesterday.
 */
function parseMark(raw: string): Mark | null {
  const parts = raw.trim().split(' ')
  const [left, right] = parts
  if (parts.length !== 2 || left === undefined || right === undefined) return null

  const window = Number(left)
  if (!Number.isSafeInteger(window) || window <= 0) return null
  if (!isState(right)) return null

  return { window, state: right }
}

/* ------------------------------------------------------------------ *
 * What gets said.
 * ------------------------------------------------------------------ */

/**
 * The owner's words, and the whole of what this bot says.
 *
 * VERBATIM, AND THE CONSTANTS ARE WHERE THAT IS ENFORCED. Everything else in a
 * post is a field off the row — the note the admin typed, the name of whoever
 * scheduled it, the commit the console recorded. No sentence here was invented
 * by this bot, and the one frame that has no wording from him yet says so in
 * the string itself; see `NOT_BACK`.
 */
const DRAIN_STARTED =
  'A maintenance window has started and the game server is no longer accepting new players or matches.'

const GOING_DOWN = 'the server is going down'

/**
 * The back-up notice, and the address is not a second copy of anything.
 *
 * HIS WORDING, AND THE DURATION IS GONE. This used to read "the server is back"
 * followed by "down for 3s", computed off `completedAt - deployStartedAt`. His
 * verdict: "'The server is back down for 3s' is ridiculous lol." The arithmetic
 * was never the problem — `completedAt` is stamped when the deploy VERB
 * returns, seconds after it detaches `royale-deploy` and long before FXServer is
 * back, so the number was measuring the console's round trip and calling it an
 * outage. The gate below now waits for the game itself, and the duration is not
 * replaced by a better one: he asked for it dropped and a truer number is still
 * a number he did not ask for.
 *
 * ═══ THE URL IS BARE, AND THAT IS A DISCORD CONSTRAINT RATHER THAN A STYLE ═══
 *
 * DO NOT "TIDY" THIS INTO `[Connect](fivem://connect/…)`. Discord restricts
 * MASKED links to the http, https and discord schemes and rejects anything else
 * — in embeds and in components alike — so the markdown form does not render as
 * a link at all. A PLAIN-TEXT `fivem://` url in ordinary message content IS
 * clickable and does launch the game. So the url is posted as text on purpose,
 * and this paragraph is here because the alternative looks like an obvious
 * improvement to anybody who has not tried it.
 *
 * THE ADDRESS COMES FROM THE ALLOWLIST. `connectIp` reads the head of
 * `BLITZ_SERVER_IPS`, which links.ts already uses to decide whose server a
 * `fivem://connect/` link points at. A literal here would be the same string
 * written down twice, and the day the community moves boxes one of the two
 * copies gets updated.
 */
const BACK = 'The game server is back up and maintenance is complete.'

function backUp(serverIp: string): string {
  return `${BACK} Connect: fivem://connect/${serverIp}`
}

/**
 * What is said when the game never spoke.
 *
 * PLACEHOLDER — THE OWNER SUPPLIES USER-FACING WORDING. He asked for the bound
 * ("if no heartbeat arrives within some window, say something rather than
 * staying silent forever") and not for the sentence, so the sentence says what
 * it is. Shipping an unapproved line has to be obvious in the channel rather
 * than invisible.
 *
 * THE CONSOLE'S OWN REASON RIDES INSIDE IT WHEN THERE IS ONE, unedited, for the
 * reason /drain shows a refusal verbatim: this bot cannot know better than the
 * thing that tried the deploy, and a house summary of somebody else's error is
 * a worse copy of it.
 */
const NOT_BACK = 'PLACEHOLDER: the update finished but the game server has not reported back.'

function didNotConfirm(reason: string | null): string {
  return reason === null ? NOT_BACK : `${NOT_BACK}\nPLACEHOLDER: the console said: ${reason}`
}

/**
 * How much of the admin's note is carried.
 *
 * A CAP BECAUSE DISCORD'S IS 2000 CHARACTERS AND IT REJECTS THE WHOLE MESSAGE,
 * not the overflow. The note is free text typed into the console's schedule
 * form, so nothing upstream of here bounds it, and the failure without this cap
 * is the single most important post this feature makes being dropped by the
 * API — invisibly, because a notice that never landed leaves no gap anybody can
 * see. 1500 is far more note than anyone writes and far less than the limit.
 */
const NOTE_CAP = 1500

/** The same, for a display name. Eighty is a Discord username and then some. */
const NAME_CAP = 80

/**
 * Cut by code point, like every other cut in this repo: a UTF-16 slice can land
 * inside a surrogate pair and put half a character in a post.
 */
function capped(value: string, cap: number): string {
  const points = [...value.trim()]
  if (points.length <= cap) return points.join('')

  return `${points.slice(0, cap).join('')}…`
}

/**
 * A field off a row whose type does not name it.
 *
 * ddb.ts's `MaintenanceWindow` IS A DECLARED SUBSET of the console's row and
 * says so at its definition: the console writes another twenty fields about the
 * deploy itself, and every one of them arrives on the item whether or not the
 * interface mentions it. Six of those matter here — when the drain and the
 * deploy began, when a heartbeat from a NEW process confirmed the restart, what
 * the deploy verb returned when it refused, and the two commits — and none of
 * them is in the subset.
 *
 * READ DEFENSIVELY BECAUSE THE TYPE CANNOT VOUCH FOR THEM. A cast promising
 * `number` would be an assertion about a field TypeScript has never checked, on
 * a row written by another repo. Anything of the wrong shape is ABSENT here,
 * and absent costs a line of a notice rather than the notice — except on the
 * completion gate, where absent is what keeps the bot from claiming a server is
 * back that it cannot prove is back.
 *
 * TWO READERS RATHER THAN ONE GENERIC ONE, because the two checks are not the
 * same check: `Number.isFinite` rejects the NaN a broken arithmetic would
 * produce, and the string reader rejects the empty string, which is a field
 * that exists and says nothing.
 */
function numberOn(window: MaintenanceWindow, field: string): number | null {
  const value = (window as unknown as Record<string, unknown>)[field]

  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOn(window: MaintenanceWindow, field: string): string | null {
  const value = (window as unknown as Record<string, unknown>)[field]

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** When the deploy fired. `markDeploying` writes it with the state change. */
function deployStartedAt(window: MaintenanceWindow): number | null {
  return numberOn(window, 'deployStartedAt')
}

/**
 * When the door actually shut.
 *
 * TWO FIELDS, AND THE SECOND IS IN THE DECLARED SUBSET. `markDraining` stamps
 * `drainStartedAt` in the same write that moves the state, which is the exact
 * moment; `drainStartsAt` is when the console INTENDED to, and the driver acts
 * on it within a tick, so it is the same instant to within seconds. Falling back
 * to it means a row written before the console recorded the first field still
 * dates its own transition.
 */
function drainBeganAt(window: MaintenanceWindow): number | null {
  return numberOn(window, 'drainStartedAt') ?? numberOn(window, 'drainStartsAt')
}

/** When the deploy verb returned. `markComplete` writes it with the state change. */
function completedAt(window: MaintenanceWindow): number | null {
  return numberOn(window, 'completedAt')
}

/**
 * A commit as it goes into a notice.
 *
 * ABBREVIATED TO THE CONSOLE'S OWN EIGHT, AND ONLY WHEN IT IS CERTAINLY A FULL
 * COMMIT. A forty-character hex string in an announcement players read is
 * noise, and eight is what every commit card in the console shows — so the two
 * surfaces name the same deploy in the same shape. Anything that is NOT exactly
 * forty hex characters is printed whole rather than cut, because a value of an
 * unexpected shape is one this bot has no business trimming.
 *
 * IT IS FOR READING AND NEVER FOR COMPARING. The console's `deployLanded` is
 * explicit that a prefix must never be handed to anything that compares
 * commits; nothing here compares them, and nothing downstream should start.
 */
const FULL_SHA = /^[0-9a-f]{40}$/u

function shortSha(sha: string): string {
  return FULL_SHA.test(sha) ? sha.slice(0, 8) : sha
}

/**
 * The commit this window is HEADING FOR, off the row, or null.
 *
 * TWO FIELDS BECAUSE THE CONSOLE WRITES ONE OR THE OTHER AND NEVER BOTH.
 * `targetSha` is a PIN — a window that switches the box to a named branch at a
 * named commit, which the game host enforces twice before it deploys.
 * `shownSha` is the destination the maintenance page NAMED when somebody
 * pressed the button, and `POST /api/maintenance` writes it as null whenever
 * `targetRef` is set precisely so the weaker record cannot be mistaken for the
 * stronger one. Reading the pin first is reading them in that order.
 *
 * NULL IS ORDINARY AND COSTS THE LINE, NOT THE NOTICE. An automatic 72-hour
 * window nobody was looking at, or a console whose branch reading was too old to
 * stand behind, carries no destination at all — and the console's own rule for
 * that state is to show no arrow rather than to invent one.
 */
function headingFor(window: MaintenanceWindow): string | null {
  return stringOn(window, 'targetSha') ?? stringOn(window, 'shownSha')
}

/**
 * The commit the box is RUNNING, off the row, or null.
 *
 * ═══ AND AT DRAIN TIME THE ANSWER IS ALWAYS NULL. READ THIS BEFORE "FIXING" IT ═══
 *
 * `deployLandedSha` is the only commit on this row that was ever OBSERVED on the
 * game box, and the console writes it at deploy confirmation — the moment a
 * heartbeat proves `deploy.sh` has been through fetch, reset and restart. It is
 * therefore about the deploy that is FINISHING, not the code that is running as
 * one starts: `schedule()` writes the field as an explicit null (the row is a
 * full `put`, and it argues at length that carrying the previous window's
 * landing forward would be the exact mistake the field was added to fix), and
 * `markDeploying` nulls it again.
 *
 * SO THE ONLY COMMIT THE ROW CAN ANSWER WITH AT `draining` IS THE DESTINATION.
 * "What is the box running right now" is `runningShaNow` in the console's
 * lib/maintenance.ts, off the live `status` reading it takes over SSH — which
 * this bot has no route to and should not grow one for. The line is BUILT and
 * OMITTED rather than left unwritten, because the day the console records a
 * running commit at scheduling time this reads it with no further change; until
 * then the drain notice names where the server is going and not where it is.
 *
 * NOT SUBSTITUTED WITH A GUESS, AND THE TEMPTING ONE IS REMEMBERING THE LAST
 * WINDOW'S LANDING. The console spells out why that value goes stale: anything
 * that moves the box outside a console-scheduled window — a deploy run on the
 * game host, a restart, a branch switch — leaves it describing a server that has
 * moved on. A commit nobody looked at is worse than no commit.
 */
function runningNow(window: MaintenanceWindow): string | null {
  return stringOn(window, 'deployLandedSha')
}

/**
 * Whoever scheduled the window, as a line, or nothing.
 *
 * NAMED, NEVER TAGGED — the owner's standing rule, and the reason it is a
 * capped plain string rather than a mention. `maintenancePoster` states the same
 * rule again at the send, because a name typed into the console can contain a
 * raw `<@id>`.
 *
 * AN EMPTY NAME IS AN OMITTED LINE, not a blank one and not a placeholder. This
 * bot adds no text nobody asked for, and "scheduled by nobody" is text nobody
 * asked for.
 */
function scheduledBy(window: MaintenanceWindow): string | null {
  const name = capped(window.createdByName, NAME_CAP)

  return name === '' ? null : `scheduled by ${name}`
}

/**
 * The drain-start notice: his sentence, the two commits, and who set it going.
 *
 * THE SENTENCE IS VERBATIM AND THE THREE LINES UNDER IT ARE FACTS OFF THE ROW.
 * He asked for "the CURRENT commit, the commit we are GOING TO, and WHO
 * initiated it"; the labels around those values are the only words here that are
 * not his, and they are deliberately two of them. See `runningNow` for why the
 * first line is absent on every window the console can write today.
 *
 * THE NOTE IS NOT REPEATED HERE. It rides the going-down notice already, and a
 * player who reads both would be told the same sentence twice about one outage.
 */
function drainStarted(window: MaintenanceWindow): string {
  const lines = [DRAIN_STARTED]

  const running = runningNow(window)
  if (running !== null) lines.push(`running ${shortSha(running)}`)

  const heading = headingFor(window)
  if (heading !== null) lines.push(`updating to ${shortSha(heading)}`)

  const by = scheduledBy(window)
  if (by !== null) lines.push(by)

  return lines.join('\n')
}

/**
 * The going-down notice.
 *
 * THE NOTE IS INCLUDED BECAUSE IT IS WHAT PLAYERS WERE TOLD AT THE DOOR. The
 * console shows it to anybody refused a connection while the window is
 * draining, so a channel post carrying different words about the same outage
 * would be a second story. The same string, in both places.
 *
 * AN EMPTY NOTE OR NAME IS AN OMITTED LINE, not a blank one and not a
 * placeholder. The owner's standing rule is that this bot adds no text nobody
 * asked for, and "no note given" is text nobody asked for.
 */
function goingDown(window: MaintenanceWindow): string {
  const lines = [GOING_DOWN]

  const note = capped(window.note, NOTE_CAP)
  if (note !== '') lines.push(note)

  const by = scheduledBy(window)
  if (by !== null) lines.push(by)

  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Is the game actually back?
 * ------------------------------------------------------------------ */

/**
 * WHEN br_ringmaster FIRST SPOKE AS A NEW PROCESS, OR NULL.
 *
 * ═══ THIS IS THE ONLY PROOF OF LIFE THAT REACHES DYNAMODB ═══
 *
 * The obvious places to look do not answer. `ringmaster-telemetry` is a table
 * the console declares in lib/dynamo.ts and NOTHING reads or writes — `tables.
 * telemetry` has no call site in that repo at all. And the ingest path the game
 * pushes to is in-memory by design: `POST /api/ingest` says in its own header
 * that it does "no DynamoDB write, no network call", because `PerformHttpRequest`
 * on the game side has a hardcoded five-second timeout, and the heartbeat it
 * applies lands in `lib/state`, which dies with the console process.
 *
 * SO THE CONSOLE'S DRIVER IS WHAT WRITES THE ANSWER DOWN. `maintenanceDriver`
 * watches its own live feed for a push whose `bootEpoch` differs from the one it
 * recorded when the deploy fired, and stamps `deployConfirmedAt` onto this row —
 * durably, and once, under a condition — precisely so the verdict survives a
 * console restart. That field is on the same one-row GetItem this bot already
 * makes four times a minute, which is why this feature costs no new read, no new
 * table and no new permission.
 *
 * NEWER THAN THE DEPLOY, WHICH IS THE OWNER'S WORD AND NOT A FORMALITY. The
 * console clears this field at `schedule` and again at `markDeploying`, so a
 * value here should already belong to this deploy — but "should" is not a thing
 * to hang the sentence on. The comparison makes a row that somehow carries an
 * older confirmation read as UNCONFIRMED, which is the direction that stays
 * quiet rather than the direction that announces a server is up.
 *
 * AND WITH NO DEPLOY CLOCK AT ALL THERE IS NOTHING TO BE NEWER THAN, so the
 * answer is null. A row that cannot say when its own deploy began cannot prove
 * anything about a timestamp sitting beside it.
 */
function heartbeatAfterDeploy(window: MaintenanceWindow): number | null {
  const confirmed = numberOn(window, 'deployConfirmedAt')
  if (confirmed === null) return null

  const deployed = deployStartedAt(window) ?? completedAt(window)
  if (deployed === null) return null

  return confirmed > deployed ? confirmed : null
}

/**
 * The console's stated reason the deploy did not happen, or null.
 *
 * `deployError` IS THE HOST REFUSING, WHICH IS NOT THE SAME FAILURE AS SILENCE.
 * The console's `deployPhase` tests this field before it tests anything about
 * heartbeats, and says why: a stated error means the code never shipped and the
 * server was never restarted, so the game pushing happily afterwards is the
 * EXPECTED state rather than evidence of a successful deploy. This bot reads it
 * in the same order and for the same reason.
 */
function deployFailure(window: MaintenanceWindow): string | null {
  return stringOn(window, 'deployError')
}

/**
 * Has the wait run out?
 *
 * A STATED FAILURE ENDS IT IMMEDIATELY. Sitting out five minutes of grace over
 * an answer already written on the row would be five minutes of silence with
 * the explanation in hand.
 *
 * OTHERWISE THE CLOCK IS THE ROW'S AND NEVER THIS PROCESS'S UPTIME. `completedAt`
 * is when the deploy verb returned; a bot restarted during the outage must not
 * restart the grace with itself, or a crash loop would hold the alarm off
 * forever.
 *
 * A ROW WITH NO CLOCK AT ALL IS OUT OF TIME AT ONCE, because the alternative is
 * a wait that can never end — and a wait with no end is the silence the bound
 * exists to prevent.
 */
function graceExpired(window: MaintenanceWindow, now: number): boolean {
  if (deployFailure(window) !== null) return true

  const clock = completedAt(window) ?? deployStartedAt(window)
  if (clock === null) return true

  return now - clock >= RESTART_GRACE_MS
}

/* ------------------------------------------------------------------ *
 * What one poll does.
 * ------------------------------------------------------------------ */

/**
 * The three things a poll can decide, and `hold` is the one that is new.
 *
 * `hold` MEANS "SAY NOTHING AND DO NOT WRITE THE MARK DOWN", which no earlier
 * version of this file needed: every decision used to be final at the moment the
 * state changed. The completion gate is not — the row says `complete` and the
 * question "is the game answering" has no answer yet — so the poll has to be
 * able to leave the window exactly as unfinished as it found it and ask again in
 * fifteen seconds. Advancing the mark there would record the transition as
 * handled and cost the notice permanently.
 */
type Step =
  | { readonly kind: 'post'; readonly content: string; readonly alarm: boolean }
  | { readonly kind: 'hold' }
  | { readonly kind: 'quiet' }

const HOLD: Step = { kind: 'hold' }
const QUIET: Step = { kind: 'quiet' }

const say = (content: string, alarm = false): Step => ({ kind: 'post', content, alarm })

/** What the poll knows that is not on the row. */
interface Moment {
  readonly now: number

  /** The address a player is told to type. See `backUp`. */
  readonly serverIp: string

  /**
   * The window this process has already reported as not having come back, or
   * null.
   *
   * IN MEMORY AND DELIBERATELY NOT ON DISK. It exists to let ONE window produce
   * the alarm and then, if the game turns up late, the back-up notice as well —
   * the alarm is not the end of the story and a channel that says "it has not
   * come back" and then never mentions it again is worse than one that never
   * said either. A restart loses it, which costs the late correction and cannot
   * cost a repeat: the mark on disk already says `complete` by then.
   */
  readonly alarmed: number | null
}

/**
 * What to do about a `complete` row.
 *
 * ═══ THE OWNER'S RULE, WHICH IS ABOUT WHAT `complete` DOES NOT MEAN ═══
 *
 * "The maintenance complete message should NEVER show until br_ringmaster has
 * delivered its first heartbeat. That tells us that the server process has
 * executed properly and successfully." The console marks the window complete
 * when its deploy verb returns, and that verb returns as soon as it has detached
 * `systemctl start royale-deploy` — the fetch, the reset and the restart have
 * not happened yet. So `complete` is the console finishing, and the sentence
 * this bot posts is about the GAME finishing, and they are tens of seconds
 * apart on a good day.
 *
 * FOUR ANSWERS, IN THIS ORDER:
 *
 *   A WINDOW THIS BOT NEVER WATCHED — silence, and this is the one state that
 *   keeps the oldest rule unrelaxed. `FRESH_TRANSITION_MS` lets the two live
 *   notices speak about a window the process did not see begin, because those
 *   are warnings about something happening now; "the server is back" is a
 *   report about something that finished, and a report is exactly what must not
 *   arrive hours late.
 *
 *   THE HOST REFUSED — say so at once, with its reason. Waiting for a heartbeat
 *   here would be waiting for a restart that never started.
 *
 *   A HEARTBEAT NEWER THAN THE DEPLOY — the notice, in his words. Said once,
 *   and said a second time only where the previous thing this bot said about
 *   this window was the alarm, which the late arrival has just corrected.
 *
 *   NOTHING YET — hold, until the grace runs out and the silence becomes the
 *   thing worth saying.
 */
function completion(mark: Mark, window: MaintenanceWindow, at: Moment): Step {
  const said = mark.state === 'complete'

  const failure = deployFailure(window)
  if (failure !== null) return said ? QUIET : say(didNotConfirm(failure), true)

  if (heartbeatAfterDeploy(window) !== null) {
    return !said || at.alarmed === window.createdAt ? say(backUp(at.serverIp)) : QUIET
  }

  if (said) return QUIET

  return graceExpired(window, at.now) ? say(didNotConfirm(null), true) : HOLD
}

/**
 * Did this transition happen just now?
 *
 * OFF THE ROW'S OWN TIMESTAMP AND NEVER OFF WHEN THIS PROCESS NOTICED. A bot
 * that had just started would otherwise find every transition fresh, which is
 * precisely the catch-up post the recency rule is standing in for a memory of.
 *
 * NO TIMESTAMP IS NOT FRESH. A row that cannot say when it moved cannot be
 * announced by a process that did not watch it move.
 */
function justNow(at: number | null, now: number): boolean {
  if (at === null) return false

  return now - at >= 0 && now - at < FRESH_TRANSITION_MS
}

/**
 * What to do, given what was last seen and what the row says now.
 *
 * PURE, AND IT IS WHERE EVERY RULE THE OWNER STATED ACTUALLY LIVES.
 *
 *   A DIFFERENT WINDOW, OR NO MARK AT ALL — this process did not watch this
 *   window arrive. It is announced only where the row itself proves the
 *   transition is happening right now; see `FRESH_TRANSITION_MS`, and see
 *   `completion` for why the back-up notice is never given that door.
 *
 *   THE SAME STATE — nothing moved. This is what stops a restart mid-window
 *   re-announcing: the mark comes back off disk saying `deploying`, the row
 *   still says `deploying`, and the going-down notice this bot already posted
 *   before the restart is not posted a second time. `complete` is the one state
 *   where the same state can still produce a post, and only to correct an alarm
 *   this process itself raised.
 *
 *   A STATE NOBODY ASKED ABOUT — `scheduled` and `cancelled` are watched and
 *   recorded and never spoken about. He wants the outage announced, and a
 *   window that was planned and called off was never an outage.
 */
function decide(mark: Mark | null, window: MaintenanceWindow, at: Moment): Step {
  const known = mark !== null && mark.window === window.createdAt
  const moved = known && mark.state !== window.state

  switch (window.state) {
    case 'draining':
      return moved || (!known && justNow(drainBeganAt(window), at.now))
        ? say(drainStarted(window))
        : QUIET

    case 'deploying':
      return moved || (!known && justNow(deployStartedAt(window), at.now))
        ? say(goingDown(window))
        : QUIET

    // Spelled out rather than reusing `known`, because a boolean derived from a
    // null check does not narrow the value: this is the form the compiler can
    // see, and it is the same test.
    case 'complete':
      return mark !== null && mark.window === window.createdAt
        ? completion(mark, window, at)
        : QUIET

    default:
      return QUIET
  }
}

/* ------------------------------------------------------------------ *
 * Posting.
 * ------------------------------------------------------------------ */

/**
 * The channel id names nothing this bot can post in.
 *
 * ITS OWN TYPE SO THE WATCHER CAN TELL IT FROM A RATE LIMIT. One is a wrong
 * variable and never gets better; the other is fifteen seconds of patience.
 * Without the distinction, a misconfigured id is a failed fetch and a log line
 * every fifteen seconds for as long as the process lives.
 */
class UnusableChannel extends Error {}

/**
 * Sending one notice to the maintenance channel.
 *
 * NOT `statusPoster` FROM client.ts, AND THE DUPLICATION IS DELIBERATE TWICE
 * OVER. client.ts is the file that wires this module, so importing back out of
 * it would make a cycle. And the channels are not the same kind of thing: the
 * status channel carries this bot's own faults for the owner, while this one
 * carries an announcement players read, so a failure here has to say which of
 * the two ids is wrong.
 *
 * `allowedMentions: { parse: [] }` IS THE OWNER'S RULE MADE STRUCTURAL. The
 * content carries two strings typed by a human into the console — a note and a
 * display name — and either can contain `@everyone` or a raw `<@id>`. Naming
 * who scheduled an outage must never ping them, and an announcement channel is
 * the worst possible place to discover that it does. Stated at the send rather
 * than left to the client-wide default, because that default is silently
 * replaced by any send that passes an `allowedMentions` of its own and a reader
 * of this function cannot see whether one did.
 */
export function maintenancePoster(
  client: Client,
  channelId: string,
): (content: string) => Promise<void> {
  return async (content) => {
    const channel = await client.channels.fetch(channelId)

    if (channel === null || !channel.isSendable()) {
      throw new UnusableChannel('the maintenance channel id names no channel this bot can post in')
    }

    await channel.send({ content, allowedMentions: { parse: [] } })
  }
}

/**
 * A failure that will not come right on its own.
 *
 * THE SAME THREE CODES client.ts LATCHES ON, for the same reason: a wrong id, a
 * deleted channel and a missing permission are all a variable and a restart,
 * and retrying any of them costs a request and a log line every fifteen seconds
 * forever. Everything else — a rate limit, a 500, a network that blinked — is
 * retried by the next poll.
 */
function permanent(error: unknown): boolean {
  if (error instanceof UnusableChannel) return true
  if (!(error instanceof DiscordAPIError)) return false

  return (
    error.code === RESTJSONErrorCodes.UnknownChannel ||
    error.code === RESTJSONErrorCodes.MissingAccess ||
    error.code === RESTJSONErrorCodes.MissingPermissions
  )
}

/* ------------------------------------------------------------------ *
 * The watcher.
 * ------------------------------------------------------------------ */

export interface MaintenanceWatch {
  /** One poll: read the row, post if it moved, record what was seen. Never rejects. */
  readonly check: () => Promise<void>

  /** True once the channel has been found unusable and nothing more will be posted. */
  readonly stopped: () => boolean
}

export interface MaintenanceWatchOptions {
  /** The one call this module makes. See the module comment: reads only. */
  readonly read: () => Promise<DdbResult<MaintenanceWindow | null>>
  readonly post: (content: string) => Promise<void>
  readonly memory?: MaintenanceMemory

  /**
   * The IP allowlist, whose head is the address the back-up notice names.
   *
   * OPTIONAL, AND THE DEFAULT IS THE LIST'S OWN DEFAULT rather than a literal
   * of this module's. src/client.ts wires this watcher and hands it a channel
   * id, a data layer and nothing else — it holds a `Config` and does not pass
   * it — so a required parameter here would not compile against the one call
   * site there is. See `connectIp`: an operator who has never set
   * `BLITZ_SERVER_IPS` gets the same address either way, and passing
   * `config.serverIps` from client.ts is the one line that makes an operator who
   * HAS set it reach the notice too.
   */
  readonly serverIps?: readonly string[]

  /** The clock, so the grace and the recency rule can be tested offline. */
  readonly now?: () => number
}

/**
 * The whole feature, with the two live edges — DynamoDB and Discord — handed in.
 *
 * THE MARK IS HELD IN MEMORY AS WELL AS ON DISK, and the in-memory copy is the
 * one every decision is made against. The file is read ONCE per process and
 * exists for exactly one purpose: so a restart mid-window does not re-announce.
 * Making the file authoritative per poll would mean a disk that cannot be
 * written turning one missed write into the same notice posted every fifteen
 * seconds — the file failing loudly in the channel it is supposed to keep
 * quiet.
 */
export function maintenanceWatch(options: MaintenanceWatchOptions): MaintenanceWatch {
  const { read, post } = options
  const memory = options.memory ?? maintenanceMemory()
  const serverIp = connectIp(options.serverIps ?? DEFAULT_SERVER_IPS)
  const now = options.now ?? Date.now

  let mark: Mark | null = null
  let loaded = false
  let usable = true
  let failures = 0

  /**
   * The window this process has already reported as not having come back.
   *
   * See `Moment.alarmed`: it is what lets a late heartbeat correct the alarm,
   * and it is in memory rather than on disk on purpose.
   */
  let alarmed: number | null = null

  /**
   * The mark off disk, once.
   *
   * AN ABSENT FILE IS THE ORDINARY STATE OF A BOX NOBODY HAS RUN THIS ON and
   * gets no line at all, exactly like the deploy notice's missing files. A file
   * that cannot be READ is different: the anti-re-announce protection is off
   * until somebody fixes the directory, and that needs a person.
   */
  async function baseline(): Promise<Mark | null> {
    if (loaded) return mark
    loaded = true

    let raw: string
    try {
      raw = await memory.seen()
    } catch (error) {
      if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
        log('warn', 'could not read what maintenance state was last seen', { error })
      }
      return null
    }

    // The content is never logged, only whether it parsed. Whatever sits in a
    // file this process did not write is not a thing to copy into a channel.
    mark = parseMark(raw)
    if (mark === null) log('warn', 'the maintenance state file does not hold a mark')

    return mark
  }

  /**
   * A read that did not answer.
   *
   * AN UNREADABLE ROW IS NOT "NO WINDOW", IT IS "CANNOT SEE", and the two must
   * not collapse into each other. Treating a timeout as an absent window would
   * clear the mark and turn the next successful read into a window this bot has
   * never seen — so the outage in progress would go unannounced AND the notice
   * that it ended would be suppressed as a catch-up. So: change nothing, say
   * nothing to the channel, and leave the mark exactly where it was.
   *
   * A MISSED NOTICE IS INVISIBLE, WHICH IS WHY THE JOURNAL LINE IS NOT
   * OPTIONAL. Every other failure in this bot leaves a mark somebody can trip
   * over — a message still standing, a command that answered with an error. A
   * maintenance notice that was never posted looks precisely like a maintenance
   * window that never happened, from Discord, forever. These lines are the only
   * evidence that the bot was blind while the server went down.
   */
  function blind(failure: unknown): void {
    failures += 1

    // `info` for one: the next poll is fifteen seconds away and will almost
    // certainly succeed, and log.ts is explicit that a call the next attempt
    // will make again does not need a human. A minute of them does — it means
    // this bot cannot see maintenance at all — and it is said ONCE per run of
    // failures rather than four times a minute for as long as it lasts.
    if (failures === MAINTENANCE_BLIND_POLLS) {
      log('warn', 'cannot read the maintenance window, an outage may go unannounced', {
        failures,
        failure,
      })
      return
    }

    log('info', 'could not read the maintenance window', { failure })
  }

  async function check(): Promise<void> {
    if (!usable) return

    const result = await read()
    if (!result.ok) {
      blind(result.failure)
      return
    }

    failures = 0

    // No window has ever been scheduled, or the row was removed. Nothing to
    // compare against and nothing to say; the mark is left alone, because the
    // next window will carry a `createdAt` of its own and be recognised as new
    // whatever this holds.
    const window = result.value
    if (window === null) return

    const seen = await baseline()
    const next: Mark = { window: window.createdAt, state: window.state }

    const step = decide(seen, window, { now: now(), serverIp, alarmed })

    /**
     * THE DECISION IS TAKEN EVERY POLL AND THE WRITE IS NOT.
     *
     * This used to return early whenever the mark equalled the state, before
     * anything was decided. It cannot any more: a `complete` window whose
     * heartbeat arrives after this bot has already reported it as not back is
     * exactly that case, and the correction is the one post worth making from
     * it. `decide` is a pure function over a row already in hand, so asking it
     * four times a minute costs nothing — the thing that had to stay cheap was
     * the WRITE, and that is guarded below where it belongs.
     */
    if (step.kind === 'hold') return

    if (step.kind === 'post') {
      try {
        await post(step.content)
      } catch (error) {
        if (permanent(error)) {
          usable = false
          log('error', 'maintenance channel unusable, nothing more will be posted to it', { error })
          return
        }

        // THE MARK IS NOT ADVANCED, so the next poll tries this again. A rate
        // limit or a five-hundred costs fifteen seconds; recording the state as
        // handled would cost the notice permanently, and this is the one post
        // in the bot whose absence nobody can see. `info` because the retry is
        // already arranged — see the level rule in log.ts.
        log('info', 'could not post a maintenance notice, it will be retried', { error })
        return
      }

      // SET BY THE ALARM AND CLEARED BY EVERY OTHER POST, which is what makes
      // the correction fire exactly once. See `Moment.alarmed`.
      alarmed = step.alarm ? window.createdAt : null
    }

    // ADVANCED IN MEMORY FIRST AND THE WRITE IS BEST EFFORT. A state directory
    // that cannot be written must not make this process announce the same
    // transition again in fifteen seconds; the only thing a failed write costs
    // is that a restart before the next transition could repeat the notice
    // once.
    mark = next

    // NOTHING MOVED, WHICH IS ALMOST EVERY POLL. The row is read four times a
    // minute and changes a handful of times a week, so this is the path that
    // has to cost nothing — and a write is the only expensive thing left in it.
    // Rewriting the same mark five and a half thousand times a day would be a
    // state file whose modification time says the opposite of what it means.
    if (seen !== null && seen.window === next.window && seen.state === next.state) return

    try {
      await memory.remember(formatMark(next))
    } catch (error) {
      log('warn', 'could not record the maintenance state, a restart may re-announce it', { error })
    }
  }

  return {
    check: () => check(),
    stopped: () => !usable,
  }
}

/**
 * Wire the watcher to the gateway coming up.
 *
 * `clientReady` IS THE EARLIEST POINT THERE IS A CHANNEL TO POST TO, and
 * `once`, because a reconnect is not a restart — a second interval on the same
 * client would double every read and race two posts of the same notice.
 *
 * THE FIRST POLL RUNS IMMEDIATELY AND IS USUALLY SILENT. It is what establishes
 * the baseline: either the mark off disk matches the window in front of it, in
 * which case nothing has moved, or it does not, in which case this is a window
 * the bot did not see begin. Waiting fifteen seconds to do that would only
 * delay the point from which real transitions are visible.
 *
 * "USUALLY" RATHER THAN "ALWAYS" SINCE THE DRAIN NOTICE, and it is the one case
 * where a first poll speaks: a window that started draining in the last two
 * minutes is announced even by a process that has just come up, because that is
 * a warning about a door that is shut right now rather than a report about
 * something finished. See `FRESH_TRANSITION_MS`, which also explains why the
 * completion notice is not given the same door.
 *
 * `unref` FOR THE REASON EVERY OTHER TIMER IN THIS BOT IS UNREFFED: a poll
 * loop is not a reason for `systemctl stop` to sit through its timeout.
 *
 * ONE POLL AT A TIME. The read carries a two-second deadline and the post is a
 * Discord request, so a tick CAN outlast the interval — and two overlapping
 * checks would both read the same transition before either had advanced the
 * mark, and post it twice.
 */
export function watchMaintenance(
  client: Client,
  channelId: string,
  ddb: Pick<Ddb, 'maintenance'>,
  options: {
    intervalMs?: number
    memory?: MaintenanceMemory
    /** See `MaintenanceWatchOptions.serverIps`. Pass `config.serverIps` here. */
    serverIps?: readonly string[]
    now?: () => number
  } = {},
): void {
  const watch = maintenanceWatch({
    read: () => ddb.maintenance.current(),
    post: maintenancePoster(client, channelId),
    memory: options.memory,
    serverIps: options.serverIps,
    now: options.now,
  })

  client.once(Events.ClientReady, () => {
    let running = false

    function tick(): void {
      if (running) return
      running = true

      // `check` never rejects, and the `finally` is the structural guarantee
      // that a future edit which makes it reject cannot latch `running` on and
      // stop the poll loop for the life of the process.
      void watch.check().finally(() => {
        running = false
      })
    }

    const timer = setInterval(() => {
      if (watch.stopped()) {
        clearInterval(timer)
        return
      }

      tick()
    }, options.intervalMs ?? MAINTENANCE_POLL_MS)

    timer.unref()

    // Through the same guard as every later poll, so the baseline read cannot
    // still be in flight when the first interval fires on top of it.
    tick()
  })
}
