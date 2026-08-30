import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The log.
 *
 * ONE LINE PER EVENT, LOGFMT, TO THE JOURNAL. This process runs under systemd
 * on the same box as the console, and its output goes to journalctl and
 * nowhere else — no shipper, no index, no dashboard. So the format is chosen
 * for `journalctl -u blitz-bot | grep`: a timestamp, a level, a message, then
 * flat `key=value` pairs that survive being grepped for one at a time.
 *
 * THE JOURNAL IS THE FLOOR AND NOTHING IS ALLOWED UNDER IT. `log()` is
 * synchronous, writes its line before anything else is attempted, and depends
 * on no network and no configuration. The optional sink at the foot of this
 * file copies faults to a Discord channel so that the owner — who operates this
 * bot from Discord and not from an SSH session — sees them at all; it can be
 * absent, slow, rate-limited or outright broken, and none of that changes a
 * byte of what systemd recorded.
 *
 * NOT JSON, though that was the real alternative. JSON is right when something
 * machine-parses the stream, and nothing does; what it costs here is that
 * every line has to be read through its own punctuation by a person on an SSH
 * session at the moment something is already broken. Revisit the day a log
 * shipper exists — every call site keeps working, only this file changes.
 *
 * EVERY LINE OPENS WITH A SYSLOG PRIORITY PREFIX — `<3>` error, `<4>` warn,
 * `<6>` info — because that is the only thing that makes `journalctl -u
 * blitz-bot -p warning` return anything.
 *
 * THIS COMMENT USED TO SAY, CONFIDENTLY AND WRONGLY, that the journal derives
 * priority from whether a line arrived on stdout or stderr. It does not.
 * journald stamps everything a service writes on BOTH streams with the same
 * priority — the unit's `SyslogLevel=`, which defaults to info — so `-p
 * warning` returned an empty page while the bot was crash-looping, and
 * docs/deploy.md handed an operator that exact command as the way to find out
 * what was wrong. What journald's stream parser does read is a leading `<N>`,
 * which it consumes off the front of the line and turns into the record's real
 * priority. Hence the prefix, and hence its position: first byte of the line,
 * before the timestamp, or it is just text.
 *
 * THE PREFIX IS INVISIBLE IN `journalctl` because journald strips it. It is
 * visible when the process is run by hand in a terminal, which is the whole
 * cost of this and is worth less than a working `-p` filter.
 *
 * WARN AND ERROR STILL GO TO STDERR, now for the terminal rather than for the
 * journal: run by hand, `node src/index.ts > /dev/null` should still show the
 * things that went wrong.
 *
 * EVERY VALUE IS QUOTED AND ESCAPED, AND THAT IS A SECURITY PROPERTY RATHER
 * THAN A TIDINESS ONE. This bot logs invite codes and message content written
 * by strangers. An unescaped newline in a value would let anyone in the guild
 * post a message that appends a forged record to the log — a plausible-looking
 * `level=info msg="nothing happened"` — and the log of their own removal stops
 * being evidence of anything. Keys are written by us and are trusted; values
 * never are.
 *
 * `process.stdout.write` RATHER THAN `console.log`, for a related reason.
 * `console.log` treats its first argument as a format string, so a message
 * containing `%s` or `%j` would swallow whatever came after it and print
 * something other than what the caller passed. It also writes one record per
 * call here, with the newline attached, so two levels cannot interleave
 * mid-line.
 */

export type Level = 'info' | 'warn' | 'error'

/**
 * The syslog priority journald reads off the front of the line.
 *
 * THE NUMBERS ARE RFC 5424 SEVERITIES and are not ours to choose: 3 is err, 4
 * is warning, 6 is info, and `journalctl -p warning` means "severity 4 and
 * lower-numbered", so error lines come back with warnings for free. Debug
 * would be 7 and there is no debug level here.
 *
 * A `Record` RATHER THAN AN ENUM because Node's type stripping rejects enums
 * outright — see tsconfig.json. Typing it as `Record<Level, string>` is what
 * makes a fourth level a compile error here rather than an `undefined` printed
 * at the start of a line.
 */
const PRIORITY: Record<Level, string> = {
  error: '<3>',
  warn: '<4>',
  info: '<6>',
}

export function log(level: Level, msg: string, fields?: Record<string, unknown>): void {
  /**
   * ISO 8601 IN UTC EVEN THOUGH THE JOURNAL ALREADY STAMPS EVERY LINE. The
   * journal's stamp is in the box's local time and is lost the moment a line
   * is pasted into an issue or a Discord thread, which is where these lines
   * actually get read. UTC because this box, the game host and the console get
   * compared to each other far more often than to a wall clock.
   */
  const parts = [new Date().toISOString(), `level=${level}`, `msg=${render(msg)}`]

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      // An absent field is absent. Printing `channel=undefined` puts a word
      // that looks like data where the data was supposed to be.
      if (value === undefined) continue
      parts.push(`${key}=${render(value)}`)
    }
  }

  const body = parts.join(' ')

  // The prefix is prepended here and nowhere else, so it cannot end up after
  // the timestamp on one path and before it on another. journald only reads it
  // as a priority when it is the first thing on the line.
  const line = `${PRIORITY[level]}${body}\n`

  if (level === 'info') process.stdout.write(line)
  else process.stderr.write(line)

  // Second, and only ever second. `body` and not `line`: the prefix is a thing
  // journald eats, and a `<4>` at the front of a Discord post is noise nobody
  // can act on.
  if (level !== 'info') report(level, msg, body)
}

/**
 * A level that means something went wrong.
 *
 * INFO IS NOT A FAULT AND THE TYPE IS WHERE THAT IS SAID. The sink exists to
 * put the things that need a human in front of one, and a channel that also
 * carries `ready` and a line per deleted message is a channel nobody reads —
 * so `info` never reaches it. Excluding it here rather than in a comment means
 * no sink can be written that expects to be handed one.
 *
 * SO THE RULE FOR PICKING A LEVEL IS ONE QUESTION: DOES THIS NEED A HUMAN?
 * `warn` and `error` mean yes, and mean it literally — every one of them is
 * copied into a Discord channel the owner reads, so writing one is asking him
 * to go and look at something. `info` means no: it is the journal's business,
 * there for whoever is already debugging and invisible otherwise. Nothing
 * anywhere in this bot chooses a level for any other reason.
 *
 * ANYTHING ROUTINE, SELF-HEALING OR PURELY INFORMATIONAL IS `info`, however
 * alarming the sentence sounds when you write it. A gateway that reconnects, a
 * request the next attempt will make again, an invite that had expired: none of
 * those need anybody, and each one that reaches the channel teaches the owner a
 * little more that the channel can be scrolled past. The cost of getting this
 * wrong is not noise, it is the alarm being ignored the day it is real —
 * `gateway reconnecting` sat at `warn` for months and did exactly that.
 *
 * THE QUESTION IS ABOUT THE CONSEQUENCE, NOT THE CAUSE. "A Discord call failed"
 * is not it; "and something stays broken until a person fixes it" is. The same
 * failed call is `info` when the next one will succeed and `warn` when it means
 * the bot has stopped moderating.
 *
 * `error` RATHER THAN `warn` WHEN THE BOT HAS STOPPED DOING SOMETHING IT IS
 * FOR: moderation halted, a delete that did not happen, a channel it can no
 * longer post to. Both reach the owner, so this is not the noise decision — it
 * is `journalctl -p err`, and which of two lines gets read first.
 */
export type Fault = Exclude<Level, 'info'>

/**
 * Somewhere else a fault is copied to. index.ts installs one; `statusReporter`
 * in client.ts is the only implementation.
 *
 * IT IS HANDED THE RENDERED LINE, NOT THE FIELDS. Everything the caller passed
 * has already been through `render` by the time it arrives — quoted, escaped,
 * newline-free — so a sink cannot interpolate a raw invite code or an error's
 * own text into whatever it builds, and the copy in the channel is the same
 * string as the copy in the journal, which is most of the reason for having a
 * second one.
 *
 * `level` AND `msg` COME SEPARATELY ANYWAY, because those two are the identity
 * of a fault and the rendered line is not: the same failure about two different
 * messages differs only in its fields and its timestamp. A sink that wants to
 * recognise a repeat has to compare the parts that do not move.
 */
export type Sink = (level: Fault, msg: string, line: string) => Promise<void>

/**
 * MODULE STATE, AND THE ONLY PIECE IN THIS FILE. There is exactly one journal
 * and one process, and the alternative — threading a logger object through
 * every call site in the bot — buys a second sink nobody will ever want and
 * costs an argument on every function between here and `decide`.
 *
 * `null` REMOVES IT, which is what tests use between cases and what an unset
 * BLITZ_STATUS_CHANNEL_ID leaves it as.
 */
let sink: Sink | null = null

export function setSink(next: Sink | null): void {
  sink = next
}

/**
 * Whether the code running right now IS the sink.
 *
 * THIS IS WHAT STOPS A FAULT LOOP, and it has to be structural because the loop
 * is not hypothetical: the sink posts to Discord, the post fails, the failed
 * post is itself a fault, the fault is logged, the log calls the sink. That is
 * not a rare edge — it is what happens the first time the channel's permissions
 * are wrong — and it is an unbounded recursion that takes the bot down at
 * exactly the moment it is trying to say something.
 *
 * AN ASYNC CONTEXT RATHER THAN A BOOLEAN FLAG, and the difference is the whole
 * design. A flag raised around the call and dropped after it covers nothing,
 * because the sink is async and its own failure is handled several ticks later.
 * A flag held until the sink's promise settles does cover that, but it also
 * silences every UNRELATED fault that happens while a post is in flight — which
 * is precisely the minute the channel is worth having. `AsyncLocalStorage`
 * follows the awaits: everything the sink does, however deep and however late,
 * is inside the store, and nothing else in the process is.
 *
 * A `log()` CALL FROM INSIDE THE SINK STILL WRITES ITS LINE. Only the copy is
 * dropped. `statusReporter` reports its own faults through `log()` on purpose
 * and depends on this being true.
 */
const reporting = new AsyncLocalStorage<true>()

function report(level: Fault, msg: string, line: string): void {
  const current = sink
  if (current === null || reporting.getStore() !== undefined) return

  /**
   * FIRE AND FORGET, WITH THE REJECTION CAUGHT HERE AND NOWHERE ELSE. `log()`
   * is synchronous and is called from error handlers and `finally` blocks;
   * there is no caller in the bot that could await this. An unawaited promise
   * that rejects is an unhandled rejection, and index.ts's handler for those
   * logs an error — which is a fault, which reaches the sink, which is the loop
   * again by a longer route.
   *
   * WHAT IS CAUGHT IS DROPPED. The journal already has the line; saying
   * anything more about it here is the one thing that cannot be done safely.
   */
  void reporting.run(true, async () => {
    try {
      await current(level, msg, line)
    } catch {
      // Dropped on purpose. See above.
    }
  })
}

/**
 * One field value, safe to put on a line with others.
 *
 * `JSON.stringify` IS THE ESCAPER because it is the one in the standard
 * library that already handles quotes, backslashes and control characters
 * correctly, including the newline this exists to neutralise. Hand-rolling
 * that is how a log injection gets in.
 *
 * ERRORS ARE UNWRAPPED FIRST. `JSON.stringify(new Error('boom'))` is `{}` —
 * name and message are not enumerable — so passing an error to a logger and
 * getting an empty object back is a trap worth closing here rather than at
 * every call site. The stack is deliberately not included: it would be
 * multi-line, and one line per event is the property the whole format rests
 * on.
 */
function render(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(`${value.name}: ${value.message}`)

  // Bare, because unquoted numbers and booleans are what makes `grep
  // 'deleted=true'` work the way anyone would expect it to.
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value)
  }

  try {
    // bigint throws, circular structures throw, and functions and symbols
    // return undefined rather than a string. A logger must not be the thing
    // that takes the process down, so all three land in the same place.
    return JSON.stringify(value) ?? '"<unserialisable>"'
  } catch {
    return '"<unserialisable>"'
  }
}
