import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client } from 'discord.js'

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
 * TWO POSTS PER WINDOW, AND THE OWNER PICKED WHICH TWO. Into `deploying`:
 * the server is going down. Into `complete`: the server is back, and how long
 * it was gone. `scheduled`, `draining` and `cancelled` post NOTHING — he does
 * not want the planning announced, only the outage. That is not an oversight
 * to be helpfully filled in later: a channel that also carried "a window has
 * been scheduled for 3am" and then "it was cancelled" is a channel that has
 * said two things about an outage that never happened, and the next real
 * notice in it is read with that much less attention.
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
 * scheduled it, a duration computed from two timestamps. No sentence here was
 * invented by this bot.
 */
const GOING_DOWN = 'the server is going down'
const BACK = 'the server is back'

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
 * When the deploy actually began, off a row whose type does not name it.
 *
 * ddb.ts's `MaintenanceWindow` IS A DECLARED SUBSET of the console's row and
 * says so at its definition: the console writes another twenty fields about the
 * deploy itself, and every one of them arrives on the item whether or not the
 * interface mentions it. `deployStartedAt` is one of those — lib/maintenance.ts
 * sets it in the same write that moves the state to `deploying` — and it is the
 * only field this module needs that the subset leaves out.
 *
 * READ DEFENSIVELY BECAUSE THE TYPE CANNOT VOUCH FOR IT. A cast promising
 * `number` would be an assertion about a field TypeScript has never checked, on
 * a row written by another repo. Anything that is not a finite number is absent
 * here, and absent costs the duration and not the notice — see `backUp`.
 */
function deployStartedAt(window: MaintenanceWindow): number | null {
  const value = (window as { deployStartedAt?: unknown }).deployStartedAt

  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * How long it was down, in the shortest true form.
 *
 * NULL RATHER THAN A ZERO OR A GUESS when the arithmetic cannot be trusted. The
 * two timestamps are written by the console at two different moments, and a
 * negative span means something about them is wrong — a clock that moved, a row
 * carrying a `deployStartedAt` from a previous deploy. Saying "the server is
 * back" and nothing else is honest; "down for -3s" is the bot reporting a bug
 * in a sentence a player is supposed to act on.
 */
function downFor(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null

  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)

  // The seconds are dropped once there is a bigger unit AND they are zero, so a
  // four-minute outage is "4m" rather than "4m 0s"; a sub-minute one is still
  // "42s" rather than an empty string.
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)

  return parts.join(' ')
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

  const name = capped(window.createdByName, NAME_CAP)
  if (name !== '') lines.push(`scheduled by ${name}`)

  return lines.join('\n')
}

/**
 * The back-up notice.
 *
 * THE DURATION IS THE ROW'S OWN ARITHMETIC — `completedAt` minus
 * `deployStartedAt` — and never the wall clock here. This process may have been
 * restarted during the outage, and a bot that timed the outage from when IT
 * noticed would report an outage as long as its own uptime.
 */
function backUp(window: MaintenanceWindow): string {
  const started = deployStartedAt(window)
  const completed = typeof window.completedAt === 'number' ? window.completedAt : null
  if (started === null || completed === null) return BACK

  const spent = downFor(completed - started)

  return spent === null ? BACK : `${BACK}\ndown for ${spent}`
}

/**
 * What to post, given what was last seen and what the row says now.
 *
 * PURE, AND IT IS WHERE EVERY RULE THE OWNER STATED ACTUALLY LIVES. There are
 * four gates and each one is a different sentence of his:
 *
 *   NO MARK AT ALL — this process has never seen a window, so the one in front
 *   of it may have been running for an hour. Silence. "If the bot was down for
 *   a whole window it stays silent"; Ringmaster's audit trail is the record,
 *   and it is a better one than a notice arriving forty minutes late.
 *
 *   A DIFFERENT WINDOW — same thing, and it is the case that actually happens.
 *   The bot is restarted every update; a window that ran entirely inside one of
 *   those restarts is a `createdAt` this bot has never recorded, and announcing
 *   "the server is back" about it hours later is the catch-up post he ruled
 *   out.
 *
 *   THE SAME STATE — nothing moved. This is what stops a restart mid-window
 *   re-announcing: the mark comes back off disk saying `deploying`, the row
 *   still says `deploying`, and the going-down notice this bot already posted
 *   before the restart is not posted a second time.
 *
 *   A STATE NOBODY ASKED ABOUT — `scheduled`, `draining` and `cancelled` are
 *   watched and recorded and never spoken about.
 *
 * THE ONE RACE THIS LOSES, STATED PLAINLY: a window that is created and driven
 * all the way to `deploying` between two polls arrives as a `createdAt` this
 * bot has no mark for, and is therefore silent. Closing it would mean deciding
 * that an unfamiliar window in `deploying` is worth announcing, which is
 * exactly the catch-up post the second gate exists to refuse — the two are
 * indistinguishable from the row alone. The interval above is what makes the
 * window narrow; silence is the direction to fail in.
 */
function noticeFor(mark: Mark | null, window: MaintenanceWindow): string | null {
  if (mark === null) return null
  if (mark.window !== window.createdAt) return null
  if (mark.state === window.state) return null

  if (window.state === 'deploying') return goingDown(window)
  if (window.state === 'complete') return backUp(window)

  return null
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

  let mark: Mark | null = null
  let loaded = false
  let usable = true
  let failures = 0

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

    // NOTHING MOVED, WHICH IS ALMOST EVERY POLL. The row is read four times a
    // minute and changes a handful of times a week, so this is the path that
    // has to cost nothing — not a post, and not a write to the state directory
    // either. Rewriting the same mark five and a half thousand times a day
    // would be a state file whose modification time says the opposite of what
    // it means.
    if (seen !== null && seen.window === next.window && seen.state === next.state) return

    const notice = noticeFor(seen, window)

    if (notice !== null) {
      try {
        await post(notice)
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
    }

    // ADVANCED IN MEMORY FIRST AND THE WRITE IS BEST EFFORT. A state directory
    // that cannot be written must not make this process announce the same
    // transition again in fifteen seconds; the only thing a failed write costs
    // is that a restart before the next transition could repeat the notice
    // once.
    mark = next

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
 * THE FIRST POLL RUNS IMMEDIATELY AND IS ALWAYS SILENT. It is what establishes
 * the baseline: either the mark off disk matches the window in front of it, in
 * which case nothing has moved, or it does not, in which case this is a window
 * the bot did not see begin and `noticeFor` refuses to announce it. Waiting
 * fifteen seconds to do that would only delay the point from which real
 * transitions are visible.
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
  options: { intervalMs?: number; memory?: MaintenanceMemory } = {},
): void {
  const watch = maintenanceWatch({
    read: () => ddb.maintenance.current(),
    post: maintenancePoster(client, channelId),
    memory: options.memory,
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
