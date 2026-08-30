import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DiscordAPIError,
  Events,
  RESTJSONErrorCodes,
  type Client,
  type SendableChannels,
} from 'discord.js'
import { z } from 'zod'

import { log } from './log.ts'

/**
 * The sticky: one admin-written message kept as the last thing in a channel.
 *
 * WHAT IT IS FOR, IN THE OWNER'S WORDS: "we know the server's down". Something
 * that has to be read by everybody who opens the channel during an outage,
 * including the twentieth person to arrive, and that therefore cannot be
 * allowed to scroll away under "is it down?" asked nineteen times.
 *
 * THE HARD PART IS NOT KEEPING IT LAST, IT IS NOT DOING SO ON EVERY MESSAGE.
 * A sticky that reposts per message costs a delete and a send for every single
 * thing anybody says, and the binding limit is Discord's per-channel send
 * bucket: five messages per five seconds. A channel with people talking in it
 * during an outage — which is the only channel this feature is ever used in —
 * fills that bucket with the bot's OWN reposts, and once it is full the sends
 * that get queued behind it are the moderation log and everything else this
 * bot has to say. So the reposting is throttled two ways at once, and the
 * throttle is the feature rather than a refinement of it:
 *
 *   AT MOST ONE REPOST PER `REPOST_COOLDOWN_MS` PER CHANNEL. Two API calls
 *   every fifteen seconds is one send per fifteen seconds, which is a fifteenth
 *   of the bucket and leaves the rest for everything else.
 *
 *   AND NOTHING AT ALL UNTIL `REPOST_AFTER_MESSAGES` HAVE ARRIVED. The cooldown
 *   alone would still repost for a single "k" posted twenty seconds apart,
 *   forever, in a channel nobody is really using — a bot talking to itself. A
 *   sticky four messages up is still on screen; one twenty messages up is not.
 *
 *   AND A GUARANTEED TRAILING REPOST, which is what makes the two above safe.
 *   A burst that trips the count while the cooldown is running arms a timer for
 *   the remainder of the window, so the repost happens when the window closes
 *   whether or not anybody says anything else. Without it a burst that ENDS —
 *   the ordinary shape of an outage, twenty messages and then quiet — would
 *   leave the sticky buried until the next person spoke, which is precisely the
 *   moment it stopped being read.
 *
 * HOW FAR THE STICKY CAN DRIFT BEFORE IT COMES BACK. Two answers, and both are
 * deliberate. In a channel that goes quiet it sits under at most
 * `REPOST_AFTER_MESSAGES - 1` — four messages — and stays there until somebody
 * posts a fifth; four is inside one screen of Discord on any client, so it has
 * drifted without going away. In a channel that is busy it sits under those
 * four plus everything posted during one cooldown window, and THAT number is
 * not bounded by anything this bot controls: fifteen seconds of a raid is as
 * many messages as Discord will accept. The trade is stated rather than fixed —
 * a shorter window buys a shallower burst at the price of the send bucket, and
 * the bucket is the thing that must not be spent.
 *
 * THE STATE OUTLIVES THE PROCESS, and it has to. `Restart=always` means this
 * bot comes back five seconds after every crash and every deploy, and a sticky
 * that a restart forgot is an outage notice that stopped being maintained
 * without anybody being told — the message stays in the channel, drifts away
 * and never returns. So the channel, the text and the id of the copy currently
 * standing are written to `STATE_DIRECTORY`; see `stickyStatePath`.
 *
 * NOTHING IS REPOSTED AT STARTUP. The copy from before the restart is still in
 * the channel and the file says which one it is, so the bot picks up where it
 * left off. Reposting on boot would put a message in the channel on every crash
 * of a process that restarts on every crash, which is the noise the deploy
 * notice in client.ts goes to some trouble to avoid.
 */

/**
 * The two numbers the throttle is made of.
 *
 * FIFTEEN SECONDS AGAINST THE FIVE-PER-FIVE-SECONDS SEND BUCKET: a repost is
 * one send, so this spends a fifteenth of what the channel allows and leaves
 * the rest for the moderation log, the status channel and anything added later.
 *
 * FIVE MESSAGES BECAUSE FOUR IS STILL ON SCREEN. The count is what stops a
 * near-idle channel being reposted into forever; see the header.
 */
export const REPOST_COOLDOWN_MS = 15_000
export const REPOST_AFTER_MESSAGES = 5

/**
 * Discord's own limit on the content of a message, in UTF-16 code units, which
 * is what Discord counts. A sticky longer than this is refused at the command
 * rather than sent and rejected: a 50035 arriving from the repost path is a
 * failure with nobody left to tell, because the admin who typed it is long
 * gone by then.
 */
export const STICKY_TEXT_CAP = 2000

/** Why a proposed sticky text cannot be used. Null means it can. */
export type TextRefusal = 'empty' | 'too-long'

/**
 * Is this text something Discord will take?
 *
 * EXPORTED SO THE COMMAND AND THE ENGINE CANNOT DISAGREE about it. The command
 * asks in order to answer the admin; the engine never has to ask, because
 * nothing reaches it that this did not pass.
 *
 * WHITESPACE IS NOT CONTENT. Discord refuses a message whose content is empty
 * after trimming, so `/sticky` with a space in it would otherwise be accepted,
 * written to the state file, and then fail on every send for the life of the
 * process.
 */
export function stickyRefusal(text: string): TextRefusal | null {
  if (text.trim() === '') return 'empty'

  // Counted before trimming, because the string that goes to Discord is the
  // one the admin typed. Leading spaces are theirs to spend.
  return text.length > STICKY_TEXT_CAP ? 'too-long' : null
}

/**
 * Everything the engine does to Discord, which is two calls.
 *
 * INJECTED FOR THE REASON `DocsChannel` IN client.ts IS INJECTED: the awkward
 * cases in this file are a delete that is refused, a channel that has been
 * removed and a message that arrives mid-repost, and not one of them can be
 * arranged in a live guild without vandalising it. `stickyChannels` is the
 * live one.
 */
export interface StickyChannels {
  /** Post the text, and answer with the id of the message that was created. */
  readonly post: (channelId: string, text: string) => Promise<string>

  /** Delete one message this bot posted. */
  readonly remove: (channelId: string, messageId: string) => Promise<void>
}

/**
 * The state file, behind two functions, so that a missing one and a corrupt one
 * are cases in a test rather than fixtures on a disk.
 */
export interface StickyStore {
  /** The file as it stands. Rejects with ENOENT when there is none. */
  readonly load: () => Promise<string>

  /** Replace the file. */
  readonly save: (raw: string) => Promise<void>
}

/** One sticky, as the state file carries it. */
export interface StoredSticky {
  readonly channelId: string
  readonly text: string

  /**
   * The copy currently standing in the channel, or null when there is none —
   * which is what a sticky whose post failed looks like until the next repost.
   */
  readonly messageId: string | null
}

/**
 * The engine, as its two callers see it.
 *
 * `saw` IS THE WHOLE OF THE GATEWAY SIDE and it is synchronous on purpose. It
 * is called from a `messageCreate` listener, and an async function handed to an
 * EventEmitter has nowhere to reject to — it becomes an unhandled rejection
 * several ticks later, attached to no channel. Everything this counter leads to
 * happens on a timer, where there is a `catch` to put it in.
 */
export interface Stickies {
  /**
   * One message arrived in a channel. Cheap, and a no-op for the channels —
   * nearly all of them — that have no sticky.
   */
  readonly saw: (channelId: string, fromSelf: boolean) => void

  /**
   * Put a sticky in a channel, replacing whatever was there. Answers whether it
   * replaced one. Rejects when the channel cannot be posted to.
   */
  readonly set: (channelId: string, text: string) => Promise<boolean>

  /** Take a channel's sticky down. Answers whether there was one. */
  readonly clear: (channelId: string) => Promise<boolean>

  /** Read the state file back at startup. Never rejects. */
  readonly restore: () => Promise<void>
}

/**
 * Where the stickies are remembered between restarts.
 *
 * THE SAME REASONING AS `reportedCommitPath` IN client.ts, AND THE SAME
 * DIRECTORY. /var/lib/blitz-bot is the unit's `StateDirectory=`: systemd
 * creates it, owns it to the service user, and keeps it writable while
 * `ProtectSystem=strict` puts the rest of the filesystem back to read-only. It
 * is the only path this process can write and it survives a reboot. The repo
 * checkout is not an option — the updater runs `git reset --hard` in it.
 *
 * systemd's OWN ANSWER FIRST, colon-separated because `StateDirectory=` may
 * name more than one, so the unit file and this function cannot drift apart.
 * The literal is the fallback for a bot started by hand, where the write will
 * usually fail — which is a fault, handled as one, and never a reason not to
 * start.
 *
 * THE FOUR LINES ARE COPIED FROM client.ts RATHER THAN SHARED, and that is not
 * an oversight. Both files would rather import a `stateDirectory()` from one
 * place; extracting it means editing client.ts, and the two copies are checked
 * against the same literals by both test files. Worth merging the day a third
 * file wants it.
 */
export function stickyStatePath(): string {
  const [first] = (process.env.STATE_DIRECTORY ?? '').split(':')
  const state = first === undefined || first === '' ? '/var/lib/blitz-bot' : first

  return join(state, 'stickies.json')
}

export function stickyStore(path: string = stickyStatePath()): StickyStore {
  return {
    load: () => readFile(path, 'utf8'),

    /**
     * WRITTEN WHOLE AND NOT ATOMICALLY, which is a decision rather than a
     * shortcut. A crash between the truncate and the write leaves a partial
     * file — and `restore` already has to survive one, because a file this
     * process did not finish and a file somebody edited by hand are the same
     * case to it. A temp-file-and-rename would buy the difference between
     * "start with no stickies and say so" and "start with the previous set",
     * which is one `/sticky` on a box that just crashed.
     *
     * The bytes are shaped by `remember`: indented, with a trailing newline, so
     * that an operator can `cat` this during an outage and read it.
     */
    save: (raw) => writeFile(path, raw, 'utf8'),
  }
}

/**
 * The file's shape, and the only thing that decides whether it is trusted.
 *
 * ONE BAD ENTRY REJECTS THE WHOLE FILE, which loses the good ones with it. That
 * is the choice rather than salvaging what parses, because this file is written
 * by nothing but this bot: anything in it that is not this shape means the file
 * was truncated by a crash mid-write or edited by hand, and a half-trusted
 * record of which messages to DELETE is worse than none. Starting empty costs
 * an admin running `/sticky` again; the other way round the bot deletes a
 * message id it read out of a damaged file.
 */
const STORED = z.array(
  z.object({
    channelId: z.string().min(1),
    text: z.string().min(1).max(STICKY_TEXT_CAP),
    messageId: z.string().min(1).nullable(),
  }),
)

/** One channel's sticky, and everything the throttle needs to know about it. */
interface ChannelState {
  text: string

  /** The copy standing in the channel, or null when none was posted. */
  messageId: string | null

  /** Messages seen since that copy was posted. The `REPOST_AFTER_MESSAGES` half. */
  since: number

  /** When that copy was posted. The `REPOST_COOLDOWN_MS` half. */
  lastPost: number

  /** The trailing repost, waiting to fire. Unreffed. */
  timer: ReturnType<typeof setTimeout> | null

  /** Whether a repost is in flight, so a second cannot start beside it. */
  busy: boolean

  /**
   * Whether this channel's current fault has already been reported.
   *
   * ONE LINE PER FAULT, NOT ONE PER ATTEMPT. A bot that cannot delete its own
   * message, or a Discord that is answering 500, fails the same way every
   * fifteen seconds for as long as it lasts — and these lines go to the status
   * channel as well as the journal, so one per attempt is a slow flood into the
   * one channel that has to stay readable. Cleared by a repost that works, so a
   * fault that comes back is reported again.
   */
  warned: boolean
}

/**
 * Whether a failure means there is no channel here any more.
 *
 * THE CHANNEL WAS DELETED, OR THE BOT WAS REMOVED FROM IT. Either way nothing
 * about this sticky can ever work again, and the honest response is to forget
 * it rather than to retry it every fifteen seconds for the life of the process.
 */
function noChannel(error: unknown): boolean {
  if (!(error instanceof DiscordAPIError)) return false

  return (
    error.code === RESTJSONErrorCodes.UnknownChannel ||
    error.code === RESTJSONErrorCodes.MissingAccess
  )
}

/**
 * Whether a failure means this bot will not be posting here again.
 *
 * `MissingPermissions` IS ADDED TO `noChannel` FOR THE SEND AND NOT FOR THE
 * DELETE, and the difference is the whole of the "cannot delete its own
 * message" case. A send this bot is not permitted to make is a sticky that
 * cannot exist. A delete it is not permitted to make is a sticky that exists
 * and cannot be MOVED — a different thing, handled where it happens, because
 * forgetting the sticky there would delete a notice nobody asked to remove.
 */
function cannotSend(error: unknown): boolean {
  if (noChannel(error)) return true

  return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.MissingPermissions
}

/**
 * The engine.
 *
 * ONE OBJECT AND NO MODULE STATE OF ITS OWN, so a test builds as many as it
 * likes and they do not see each other. The singleton the commands reach for is
 * held below, and it holds one of these.
 */
export function stickyEngine(channels: StickyChannels, store: StickyStore): Stickies {
  const open = new Map<string, ChannelState>()

  /**
   * Write the state file.
   *
   * NEVER REJECTS, AND A FAILURE IS A WARNING RATHER THAN A REFUSAL. What is
   * lost when this fails is the NEXT process's knowledge, not this one's: the
   * sticky in front of us keeps working, and the cost lands at the next restart
   * as a copy standing in a channel that nobody remembers posting. Turning that
   * into a failed `/sticky` would trade a working sticky for no sticky.
   */
  async function remember(): Promise<void> {
    const stored: StoredSticky[] = [...open.entries()].map(([channelId, state]) => ({
      channelId,
      text: state.text,
      messageId: state.messageId,
    }))

    try {
      await store.save(`${JSON.stringify(stored, null, 2)}\n`)
    } catch (error) {
      log('warn', 'could not write the sticky state, a restart will forget them', { error })
    }
  }

  /** Stop a trailing repost that is waiting, if one is. */
  function disarm(state: ChannelState): void {
    if (state.timer === null) return

    clearTimeout(state.timer)
    state.timer = null
  }

  /**
   * Take one message down. True when it is gone, false when it would not go.
   *
   * `UnknownMessage` IS SUCCESS AND NOT A FAULT. Somebody deleted it by hand,
   * or a previous repost got half way; either way the copy this was asked to
   * remove is not in the channel, which is the state the call was trying to
   * reach. Treating it as a failure would stop the sticky dead the first time
   * an admin tidied one away.
   *
   * A CHANNEL THAT IS GONE IS RETHROWN rather than answered false, so that the
   * one caller who can act on it — `repost`, which forgets the sticky — sees it
   * instead of reading it as a stubborn message.
   */
  async function takeDown(channelId: string, messageId: string): Promise<boolean> {
    try {
      await channels.remove(channelId, messageId)
      return true
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) {
        return true
      }

      if (noChannel(error)) throw error

      log('warn', 'could not delete the sticky to repost it', { channel: channelId, error })
      return false
    }
  }

  /** Drop a channel's sticky from memory and from the file. */
  async function forget(channelId: string): Promise<void> {
    const state = open.get(channelId)
    if (state === undefined) return

    disarm(state)
    open.delete(channelId)
    await remember()
  }

  /**
   * Arm the trailing repost, if this channel has earned one and none is armed.
   *
   * EVERY REPOST GOES THROUGH A TIMER, INCLUDING THE ONES THAT ARE DUE NOW, and
   * that is worth the zero-delay `setTimeout` it costs. Two things fall out of
   * it. A burst delivered in one tick — which is what a gateway that was behind
   * catching up looks like — is counted in full before anything is posted,
   * rather than reposting on the fifth message and again on the tenth. And
   * `saw` stays synchronous with no promise to lose, which is what a listener
   * on an EventEmitter needs.
   *
   * ONE TIMER PER CHANNEL AT MOST. A second message during the window finds one
   * already armed and adds nothing; the count it increments is read when the
   * timer fires.
   *
   * UNREFFED, so a bot being stopped does not make `systemctl stop` wait out
   * fifteen seconds for a message nobody is waiting for.
   */
  function arm(channelId: string): void {
    const state = open.get(channelId)
    if (state === undefined || state.busy || state.timer !== null) return

    /**
     * THE COUNT IS ABOUT DRIFT, AND A STICKY WITH NO COPY STANDING HAS NOT
     * DRIFTED — IT IS ABSENT. That is a repost whose delete succeeded and whose
     * send then failed for a reason that was not permanent: a 500, a rate
     * limit, a connection that went away. Holding the retry until five more
     * people speak would mean an outage notice that vanished from the channel
     * and came back only if the channel happened to get busy, which is the
     * opposite of what it is for. The cooldown still applies, so the retry is
     * one send every fifteen seconds and no faster.
     */
    if (state.messageId !== null && state.since < REPOST_AFTER_MESSAGES) return

    const waited = Date.now() - state.lastPost
    const delay = Math.max(0, REPOST_COOLDOWN_MS - waited)

    state.timer = setTimeout(() => {
      state.timer = null

      void repost(channelId, state).catch((error: unknown) => {
        // `repost` handles every failure it expects, so reaching here is one it
        // did not — and it is on a timer, which has nowhere else to reject to.
        log('error', 'sticky repost failed', { channel: channelId, error })
      })
    }, delay)

    state.timer.unref()
  }

  /**
   * Delete the standing copy and post a new one on top.
   *
   * DELETE FIRST, THEN POST, AND THAT IS THE OPPOSITE ORDER TO `set` BELOW. The
   * two have different things to be afraid of. This one runs unattended every
   * fifteen seconds, so posting first would mean a delete that keeps failing
   * leaves a new copy behind on every single attempt — a channel filling with
   * stickies, unattended, which is worse than the drift it was fixing. So a
   * refused delete stops the repost and leaves the copy where it is: the notice
   * stays visible, it simply stops moving, and the counters are reset so the
   * next attempt is a full window away rather than on the next message.
   *
   * A MESSAGE ARRIVING MID-REPOST IS NOT SWEPT UP WITH THE ONES THIS BURIED,
   * and getting that wrong is a sticky that sinks a little deeper every window
   * without anything looking broken. Discord orders a channel by time, so the
   * messages this new copy buries are exactly the ones that arrived before the
   * send RESOLVED — and the count is read at that instant rather than at the
   * end of this function, because the state file is written in between and a
   * message that lands across that write is BELOW the new copy and is real
   * drift. Subtracted rather than zeroed for the same reason. The one message
   * this can be wrong about is one that lands between the send and its
   * acknowledgement, which is buried when it should not be; erring that way
   * costs one message of drift and the other way costs a repost nobody earned.
   *
   * A REPOST WHOSE CHANNEL WAS RE-STUCK OR UNSTUCK WHILE IT RAN CLEANS UP AFTER
   * ITSELF. `/unsticky` and a second `/sticky` both replace what is in the map,
   * and this holds the OLD record: writing the new message id onto it would
   * leave a copy standing that nothing remembers and nothing can remove. Rare —
   * the window is one round trip — and permanent when it happens, which is why
   * it is checked rather than reasoned away.
   */
  async function repost(channelId: string, state: ChannelState): Promise<void> {
    state.busy = true

    /**
     * How much of the counter this attempt accounts for.
     *
     * EVERYTHING SEEN SO FAR, UNTIL THE SEND SAYS OTHERWISE. On the failure
     * paths below nothing is posted and nothing is buried, and the counter is
     * still cleared to here — otherwise a channel that refuses deletes would
     * try again on the very next message rather than a window later. The
     * cooldown, reset in the `finally`, is what actually paces those retries.
     */
    let buried = state.since

    try {
      if (state.messageId !== null && !(await takeDown(channelId, state.messageId))) {
        if (!state.warned) {
          state.warned = true
          log('warn', 'the sticky cannot be moved, it stays where it is', { channel: channelId })
        }

        return
      }

      // The old copy is gone whatever happens next, so nothing must delete it
      // twice — a second attempt would be an `UnknownMessage` at best and, if
      // the id were reused, a delete of somebody else's message.
      state.messageId = null

      const messageId = await channels.post(channelId, state.text)

      // Read here and nowhere else: the copy is in the channel as of this line,
      // so this is precisely what it buried. See the header.
      buried = state.since

      if (open.get(channelId) !== state) {
        await takeDown(channelId, messageId)
        return
      }

      state.messageId = messageId
      state.warned = false
      await remember()
    } catch (error) {
      if (cannotSend(error)) {
        log('warn', 'the sticky channel is gone, forgetting it', { channel: channelId, error })
        await forget(channelId)
        return
      }

      /**
       * ANYTHING ELSE IS TRANSIENT AND IS RETRIED, NOT DROPPED. A 500, a rate
       * limit, a connection that went away: the channel is fine and the same
       * call will work later. It is caught rather than rethrown because there
       * is nothing above a timer to catch it, and because the retry is already
       * arranged — the old copy is gone, so `arm` in the `finally` sees a
       * sticky with nothing standing and schedules the next window whether or
       * not anybody says anything else.
       */
      if (!state.warned) {
        state.warned = true
        log('warn', 'could not repost the sticky, trying again', { channel: channelId, error })
      }
    } finally {
      state.busy = false

      // Reset even when nothing was posted: on the failure paths the cooldown
      // is what keeps a channel that refuses deletes from being retried on
      // every message rather than once a window.
      state.lastPost = Date.now()
      state.since = Math.max(0, state.since - buried)

      arm(channelId)
    }
  }

  return {
    saw: (channelId, fromSelf) => {
      /**
       * THE BOT'S OWN MESSAGES ARE NOT DRIFT, and this is a blunter rule than
       * "everything except the sticky itself" on purpose. The gateway can
       * deliver `messageCreate` for a message this bot posted BEFORE the send
       * that created it has resolved, so at that instant the sticky's own id is
       * not yet written down and matching on it would count the sticky as
       * having drifted past itself. The cost of the blunt rule is that a
       * moderation line posted into a sticky channel does not count toward the
       * five; the cost of the precise one is a repost triggered by nothing.
       */
      if (fromSelf) return

      const state = open.get(channelId)
      if (state === undefined) return

      state.since += 1
      arm(channelId)
    },

    /**
     * POST FIRST, THEN DELETE THE OLD ONE, WHICH IS THE REVERSE OF `repost`.
     * An admin is watching this one and it happens once. If the delete of the
     * previous copy is refused, the channel is left holding two stickies — one
     * of them current, both of them visible, and a person right there who can
     * remove the stale one by hand. The other order would answer a `/sticky`
     * that failed with a channel that has no sticky in it at all, which is the
     * worse end of the same fault.
     *
     * THE THROTTLE DOES NOT APPLY HERE. An admin typing this expects to see it,
     * and one send from a command is not what fills a bucket.
     */
    set: async (channelId, text) => {
      const existing = open.get(channelId)

      // Anything already scheduled is a repost of text that is about to stop
      // being the sticky. The record stays in the map until the new copy is up,
      // so that a post which fails changes nothing at all.
      if (existing !== undefined) disarm(existing)

      const messageId = await channels.post(channelId, text)

      open.set(channelId, {
        text,
        messageId,
        since: 0,
        lastPost: Date.now(),
        timer: null,
        busy: false,
        warned: false,
      })

      if (existing !== undefined && existing.messageId !== null) {
        try {
          // Best effort, and a refusal is already a warning line inside
          // `takeDown`. A leftover copy is a message the admin standing here
          // can delete; a rejection would be a `/sticky` reporting failure
          // after doing exactly what it was asked.
          await takeDown(channelId, existing.messageId)
        } catch (error) {
          log('warn', 'could not remove the sticky this one replaced', {
            channel: channelId,
            error,
          })
        }
      }

      await remember()
      return existing !== undefined
    },

    clear: async (channelId) => {
      const state = open.get(channelId)
      if (state === undefined) return false

      disarm(state)
      open.delete(channelId)

      // Out of the map before the delete is attempted, so that a repost which
      // is in flight finds itself orphaned and removes its own post rather than
      // leaving a copy this call never knew about.
      if (state.messageId !== null) {
        try {
          await takeDown(channelId, state.messageId)
        } catch (error) {
          // The channel is gone, so the message is too. `/unsticky` on a
          // deleted channel has done what it was asked either way.
          log('warn', 'the sticky channel is gone, nothing to take down', {
            channel: channelId,
            error,
          })
        }
      }

      await remember()
      return true
    },

    /**
     * NEVER REJECTS AND NEVER POSTS. A missing file is the ordinary state of a
     * box where nobody has ever run `/sticky` and gets no line at all — the
     * same rule the deploy notice follows for its own missing file. A file that
     * cannot be read, or that is not the shape this bot writes, is a fault
     * worth a line, and the bot comes up with no stickies rather than not at
     * all.
     *
     * THE CONTENT IS NEVER LOGGED. Whatever is in a damaged file is not a thing
     * to copy into the status channel.
     *
     * A CHANNEL SET WHILE THIS WAS READING IS LEFT ALONE. The read is a few
     * milliseconds at boot and a command cannot arrive inside it, but the
     * ordering is not this function's to assume, and the live value is always
     * the better one.
     */
    restore: async () => {
      let raw: string

      try {
        raw = await store.load()
      } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return

        log('warn', 'could not read the sticky state', { error })
        return
      }

      let stored: StoredSticky[]

      try {
        stored = STORED.parse(JSON.parse(raw))
      } catch (error) {
        log('warn', 'the sticky state is not readable, starting with none', {
          bytes: raw.length,
          error,
        })
        return
      }

      for (const sticky of stored) {
        if (open.has(sticky.channelId)) continue

        open.set(sticky.channelId, {
          text: sticky.text,
          messageId: sticky.messageId,
          since: 0,

          // Now, rather than zero. A restart is not a reason to repost, and a
          // channel that was busy when the bot went down would otherwise get
          // one on its fifth message with no cooldown behind it.
          lastPost: Date.now(),
          timer: null,
          busy: false,
          warned: false,
        })
      }

      log('info', 'stickies restored', { channels: stored.length })
    },
  }
}

/**
 * The live Discord half: two calls, and the check that the id names something
 * this bot can post in.
 */
export function stickyChannels(client: Client): StickyChannels {
  async function open(channelId: string): Promise<SendableChannels> {
    const channel = await client.channels.fetch(channelId)

    if (channel === null || !channel.isSendable()) {
      throw new Error('the sticky channel id names no channel this bot can post in')
    }

    return channel
  }

  return {
    post: async (channelId, text) => {
      const channel = await open(channelId)

      // The same mention suppression every other send in this bot states at its
      // own call. This content is an admin's, so it CAN carry a mention, and a
      // sticky reposted every fifteen seconds is the last thing that should be
      // able to ping a role. The client-wide default already says so; it is
      // repeated here because that default is silently replaced by any send
      // passing `allowedMentions` of its own, and a reader of this function
      // cannot see it.
      const message = await channel.send({ content: text, allowedMentions: { parse: [] } })

      return message.id
    },

    remove: async (channelId, messageId) => {
      const channel = await open(channelId)
      await channel.messages.delete(messageId)
    },
  }
}

/**
 * THE ONE ENGINE, AS MODULE STATE, and it is the same trade `log.ts` makes for
 * the sink. A slash command handler is handed an `Invocation` and a `Config`
 * and nothing else — that signature is the thing which keeps every command
 * testable — so a command cannot be given an engine through its arguments, and
 * threading one through `runCommand` would put a sticky-shaped parameter on
 * every command this bot will ever have.
 *
 * `null` IS THE HONEST STARTING VALUE and it is what the commands are written
 * against: a bot whose client has not installed the engine yet, and a test that
 * has not injected one, both get a refusal rather than a crash.
 */
let installed: Stickies | null = null

/** The engine, or null when none has been installed. */
export function stickies(): Stickies | null {
  return installed
}

/** Put an engine in place, or take it out. Tests use both directions. */
export function setStickies(engine: Stickies | null): void {
  installed = engine
}

/**
 * Wire the sticky into a live client: the engine, the state file and the one
 * listener it needs.
 *
 * ONE CALL, BECAUSE THE HOOK LIVES IN client.ts AND THIS FILE DOES NOT OWN IT.
 * Everything that could be a line over there — building the poster, reading the
 * state file, deciding what counts as drift — is on this side of the call, so
 * the edit to client.ts is `installStickies(client)` and nothing else.
 *
 * ITS OWN `messageCreate` LISTENER RATHER THAN A LINE IN THE MODERATION ONE,
 * and the reason is `messageUpdate`. client.ts deliberately runs both events
 * through one handler, because an edited message has to be scanned the way a
 * new one is. An EDIT IS NOT DRIFT: nothing moved, nothing was pushed down, and
 * counting it would repost the sticky because somebody fixed a typo.
 *
 * A CONSEQUENCE WORTH KNOWING: `createClient` takes every `messageCreate`
 * listener off when the configured guild is not one this bot is in, so this one
 * goes with them. That is the right end of it — in that state no commands are
 * registered either, so there is nothing to stick.
 *
 * THE ENGINE IS A PARAMETER WITH A DEFAULT, which is the only reason the rules
 * above are testable at all. The default is the live one and no caller passes
 * anything; a test passes a fake and reads what the listener handed it, without
 * a state file, a channel or a client behind it.
 */
export function installStickies(
  client: Client,
  engine: Stickies = stickyEngine(stickyChannels(client), stickyStore()),
): void {
  setStickies(engine)

  client.on(Events.MessageCreate, (message) => {
    /**
     * OURS ONLY WHEN BOTH IDS ARE KNOWN AND EQUAL, written out rather than left
     * as `message.author?.id === client.user?.id`. That one-liner reads the
     * same until neither side is known, where `undefined === undefined` makes
     * an unattributable message the bot's own and silently stops the sticky.
     *
     * AN UNATTRIBUTABLE MESSAGE IS DRIFT. It arrived, so it pushed the sticky
     * down, and that is true whoever sent it; the worst it costs is one repost
     * that a stricter reading would have skipped. Neither id is ever really
     * absent — `client.user` is set before `clientReady` and a `messageCreate`
     * carries an author — which is exactly why the branch has to be decided
     * here rather than by whichever value happens to be missing.
     */
    const selfId = client.user?.id ?? null
    const authorId = message.author?.id ?? null

    engine.saw(message.channelId, authorId !== null && authorId === selfId)
  })

  void engine.restore().catch((error: unknown) => {
    // `restore` handles what it expects, so this is a fault it did not, at a
    // point in startup with nothing else to report it.
    log('error', 'could not restore the stickies', { error })
  })
}
