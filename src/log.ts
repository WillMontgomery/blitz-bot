/**
 * The log.
 *
 * ONE LINE PER EVENT, LOGFMT, TO THE JOURNAL. This process runs under systemd
 * on the same box as the console, and its output goes to journalctl and
 * nowhere else — no shipper, no index, no dashboard. So the format is chosen
 * for `journalctl -u blitz-bot | grep`: a timestamp, a level, a message, then
 * flat `key=value` pairs that survive being grepped for one at a time.
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

  // The prefix is prepended here and nowhere else, so it cannot end up after
  // the timestamp on one path and before it on another. journald only reads it
  // as a priority when it is the first thing on the line.
  const line = `${PRIORITY[level]}${parts.join(' ')}\n`

  if (level === 'info') process.stdout.write(line)
  else process.stderr.write(line)
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
