import { readFileSync } from 'node:fs'

import { DiscordAPIError, DiscordjsError, RESTJSONErrorCodes } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { log, type Level } from './log.ts'

/**
 * The log line, as journald and as a person read it.
 *
 * THE POINT OF THIS FILE IS THE PRIORITY PREFIX. `src/log.ts` used to assert
 * that journald derived a record's priority from whether the line arrived on
 * stdout or stderr, and docs/deploy.md handed operators `journalctl -u
 * blitz-bot -p warning` on the strength of it. journald does no such thing —
 * both streams get the unit's default priority — so that command returned
 * nothing at all while the bot was crash-looping. The fix is a leading `<N>`,
 * which journald's stream parser really does read, and these tests exist so
 * that nobody removes it as cosmetic noise or moves it after the timestamp,
 * where it is just text.
 *
 * NOTHING HERE TOUCHES THE JOURNAL, obviously. `log()` writes to two streams
 * and that is all it does, so the streams are captured and the bytes asserted
 * on directly. No network, no systemd, no fixture.
 */

const stdout: string[] = []
const stderr: string[] = []

beforeEach(() => {
  stdout.length = 0
  stderr.length = 0

  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString())
    return true
  }) as unknown as typeof process.stdout.write)

  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString())
    return true
  }) as unknown as typeof process.stderr.write)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * One captured write, as a string.
 *
 * `noUncheckedIndexedAccess` is on (see tsconfig.json), so `stderr[0]` is
 * `string | undefined` and every assertion below would otherwise need a `!`.
 * Throwing on a missing write is the right answer anyway: "log() wrote nothing"
 * is a more useful failure than "cannot read properties of undefined".
 */
function written(stream: string[], index = 0): string {
  const value = stream[index]
  if (value === undefined) throw new Error(`log() wrote no line at index ${index}`)
  return value
}

describe('the syslog priority prefix', () => {
  it('opens an error line with <3>', () => {
    log('error', 'login failed')
    expect(stderr).toHaveLength(1)
    expect(written(stderr).startsWith('<3>')).toBe(true)
  })

  it('opens a warn line with <4>', () => {
    log('warn', 'invite lookup failed')
    expect(stderr).toHaveLength(1)
    expect(written(stderr).startsWith('<4>')).toBe(true)
  })

  it('opens an info line with <6>', () => {
    log('info', 'ready')
    expect(stdout).toHaveLength(1)
    expect(written(stdout).startsWith('<6>')).toBe(true)
  })

  /**
   * The documented command is `journalctl -u blitz-bot -p warning`, and `-p
   * warning` matches severity 4 AND everything below it. If warn and error
   * ever collapsed to the same number, that command would stop distinguishing
   * a rate limit from a crash loop.
   */
  it('gives warn and error different priorities', () => {
    log('warn', 'a')
    log('error', 'b')
    expect(written(stderr, 0).slice(0, 3)).not.toBe(written(stderr, 1).slice(0, 3))
  })

  /**
   * FIRST BYTE OF THE LINE OR NOTHING. journald reads the prefix only at the
   * very start; one space in front of it, or the timestamp first, and the
   * record silently lands at the default priority again — exactly the bug this
   * file is here to prevent coming back.
   */
  it('puts the prefix before the timestamp, with nothing in front of it', () => {
    log('warn', 'something')
    expect(written(stderr)).toMatch(/^<4>\d{4}-\d{2}-\d{2}T[\d:.]+Z level=warn /)
  })
})

describe('the rest of the line, unchanged by the prefix', () => {
  it('leaves the human-readable remainder as plain logfmt', () => {
    log('warn', 'invite lookup failed', { code: 'abc123', deleted: false })

    expect(written(stderr).slice(3)).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z level=warn msg="invite lookup failed" code="abc123" deleted=false\n$/,
    )
  })

  /**
   * ONE WRITE, ONE LINE, ONE PREFIX. A value containing a newline must not
   * split the record — the second half would arrive at journald with no `<N>`
   * on it and would be a forged log line at the default priority. This is the
   * escaping property in log.ts restated in terms of the prefix.
   */
  it('emits exactly one line even when a value contains a newline', () => {
    log('warn', 'x', { content: 'first\n<6>2020-01-01T00:00:00.000Z level=info msg="all fine"' })

    expect(stderr).toHaveLength(1)
    expect(written(stderr).split('\n')).toHaveLength(2)
    expect(written(stderr).endsWith('\n')).toBe(true)
    expect(written(stderr).indexOf('<')).toBe(0)
  })

  it('still routes info to stdout and warn and error to stderr', () => {
    log('info', 'ready')
    log('warn', 'wobble')
    log('error', 'boom')

    expect(stdout).toHaveLength(1)
    expect(stderr).toHaveLength(2)
  })
})

/**
 * The operator-facing surface: the workflow and the two documents.
 *
 * WHY THESE LIVE IN log.test.ts AND NOT IN A FILE OF THEIR OWN. They were all
 * one review, and this is the test file that review was allowed to create. More
 * to the point, the first of them genuinely belongs next to `log()`: the bug
 * being pinned is that a document promised operators a `journalctl` filter the
 * code did not implement, and the only way that stays fixed is an assertion
 * that reads both sides and compares them. The rest are here for the same
 * reason a lint rule is not in the linted file — nothing else was going to
 * catch a documented command that stopped being true.
 *
 * THEY READ THE REPO OFF DISK, which is unusual for a unit test and is the
 * point. A test that restated the docs in a string would pass forever while the
 * docs rotted underneath it.
 */
const repoFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/**
 * One `## N. Heading` section of a document, from its heading to the next `##`.
 *
 * PRESENCE IN AN 18KB FILE IS NOT PRESENCE WHERE THE OPERATOR IS LOOKING. A
 * `toContain` over the whole of deploy.md stays green when the string it wants
 * has drifted into the rollback notes at the bottom, which is why the checks
 * below slice first and assert second. Matched by shape rather than by number,
 * so renumbering the sections is allowed and moving their contents is not.
 */
function section(document: string, heading: RegExp): string {
  const start = document.search(heading)
  if (start === -1) throw new Error(`no section matching ${String(heading)}`)

  const body = document.slice(start)

  // Search from one character in, so the section's own `##` is not the match
  // that ends it.
  const next = body.slice(1).search(/^## /m)
  return next === -1 ? body : body.slice(0, next + 1)
}

/** Blank-line separated paragraphs, so a claim can be read in its own context. */
const paragraphs = (text: string): string[] => text.split(/\n\s*\n/)

/**
 * A capture group out of a source file, or a loud failure.
 *
 * The alternative is `pattern.exec(source)?.[1] ?? ''`, which turns a call site
 * that has been renamed or reshaped into an assertion that compares two empty
 * strings and passes. A cross-check that can silently stop cross-checking is
 * worse than no cross-check, because it is still on the list.
 */
function capture(source: string, pattern: RegExp, what: string): string {
  const value = pattern.exec(source)?.[1]
  if (value === undefined) throw new Error(`${what} no longer matches ${String(pattern)}`)
  return value
}

/** `capture` for a `/g` pattern, with the same refusal to answer nothing. */
function captureAll(source: string, pattern: RegExp, what: string): string[] {
  const values: string[] = []

  for (const match of source.matchAll(pattern)) {
    const value = match[1]
    if (value === undefined) throw new Error(`${what} no longer matches ${String(pattern)}`)
    values.push(value)
  }

  if (values.length === 0) throw new Error(`${what} no longer matches ${String(pattern)}`)
  return values
}

/**
 * The contents of every fenced code block, one block per entry.
 *
 * A QUOTED LOG LINE IS ONLY A QUOTED LOG LINE INSIDE A FENCE. deploy.md also
 * discusses `level=` in prose — it tells the operator never to grep for the
 * start of a line — and an assertion that a line containing `level=` must look
 * like a real log record has to be able to tell those two apart, or the
 * sentence warning about the mistake fails the test that exists to prevent it.
 */
const codeBlocks = (text: string): string[] =>
  captureAll(text, /^```[^\n]*\n([\s\S]*?)^```/gm, 'a fenced code block in the document')

/**
 * Every line inside a fenced block of `text` that is a quoted log record.
 *
 * THE SHAPE IS THE FILTER, AND IT IS ALSO THE CONVENTION. deploy.md quotes log
 * lines exactly as `journalctl` prints them — timestamp first, no `<N>` — so a
 * quoted record is recognisable by its opening and a `grep` command that merely
 * mentions `msg="ready"` is not. That distinction is the whole point: §9 both
 * quotes the ready line and hands over a `grep` for it, and only one of the two
 * is an example an operator compares against his screen.
 *
 * THIS IS WHAT MAKES THE ASSERTIONS BELOW POSITIONAL. A `toContain` over the
 * whole 1100-line file stays green when the example block is deleted and the
 * §14 troubleshooting table still mentions the same string somewhere else — a
 * mutation pass proved exactly that for six of the sixteen quoted lines. Slice
 * the section first, keep only its fenced records, and deleting the example is
 * caught even though the table is untouched.
 */
const quotedLogLines = (text: string): string[] =>
  codeBlocks(text)
    .flatMap((block) => block.split('\n'))
    .filter((line) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z level=/.test(line))

/** The quoted records in `text` that carry `token`, which is usually a `key="value"`. */
const quoting = (text: string, token: string): string[] =>
  quotedLogLines(text).filter((line) => line.includes(token))

const deployDoc = repoFile('docs/deploy.md')
const clientSource = repoFile('src/client.ts')
const configSource = repoFile('src/config.ts')
const indexSource = repoFile('src/index.ts')

/**
 * Every message string deploy.md quotes, pulled out of the file that emits it.
 *
 * THE WHOLE POINT IS THAT NOTHING HERE IS TYPED OUT TWICE. deploy.md has now
 * twice shipped log lines the code never wrote — `msg="delete failed"` for a
 * message that reads `delete failed, message left standing`, an intent failure
 * quoted as `... disallowed intents ...` when the string is `Used disallowed
 * intents`, a halt line starting at `level=` when every line starts with a
 * timestamp. Each cost an operator a grep that returned nothing at the moment
 * they most needed it to return something, which reads as "the check never
 * fired" rather than as "the document is wrong".
 *
 * EACH PATTERN IS ANCHORED ON SOMETHING STRUCTURAL — a call to
 * `actions.remove()`, the `Events.ShardDisconnect` registration, the
 * `client.login` that index.ts wraps — rather than on the message text it is
 * fetching, so a reworded message changes the captured value instead of failing
 * to match. `capture` throws loudly if the anchor itself is renamed, which is
 * the other thing worth being told about.
 */
const READY = capture(
  clientSource,
  /Events\.ClientReady[\s\S]*?log\('info', '([^']+)'/,
  'the ready log call in createClient',
)

const READY_FIELDS = captureAll(
  capture(clientSource, /log\('info', 'ready', \{([\s\S]*?)\}\)/, "the ready line's fields"),
  /^\s*(\w+):/gm,
  "the ready line's field names",
)

const HALT = `${capture(
  clientSource,
  /log\('error', `([^`]*)\$\{reason\}`/,
  "haltModeration's log call in src/client.ts",
)}${capture(clientSource, /haltModeration\(\s*'([^']+)'/, 'the haltModeration call in createClient')}`

const CARRIED_FOREIGN = capture(
  clientSource,
  /'foreign-invite': '([^']+)'/,
  "CARRIED['foreign-invite'] in src/client.ts",
)

const WOULD_DELETE = `${capture(
  clientSource,
  /log\('warn', `([^`]*)\$\{CARRIED\[verdict\.why\]\}`/,
  'the dry-run log call',
)}${CARRIED_FOREIGN}`

const DELETED = `${capture(
  clientSource,
  /log\('info', `([^`]*)\$\{CARRIED\[verdict\.why\]\}`/,
  'the removal log call',
)}${CARRIED_FOREIGN}`

const DELETE_FAILED = capture(
  clientSource,
  /await actions\.remove\(\)[\s\S]*?log\('error', '([^']+)'/,
  'the failed-delete log call',
)

const GATEWAY_DISCONNECTED = capture(
  clientSource,
  /Events\.ShardDisconnect[\s\S]*?log\('warn', '([^']+)'/,
  'the gateway-disconnect log call',
)

const LOG_CHANNEL_UNUSABLE = capture(
  clientSource,
  /isSendable\(\)\)[\s\S]*?log\('error', '([^']+)'/,
  'the unusable-log-channel log call',
)

const LOG_CHANNEL_POST_FAILED = capture(
  clientSource,
  /await post\(line\)[\s\S]*?log\('error', '([^']+)'/,
  'the failed-channel-post log call',
)

const LOGIN_FAILED = capture(
  indexSource,
  /await client\.login\([\s\S]*?log\('error', '([^']+)'/,
  'the failed-login log call in src/index.ts',
)

/** The two lines the bot posts to BLITZ_LOG_CHANNEL_ID, up to their first field. */
const CHANNEL_REMOVED = capture(
  clientSource,
  /function removedLine[\s\S]*?return `([^$`]+)\$\{/,
  'removedLine in src/client.ts',
)

const CHANNEL_DRY_RUN = capture(
  clientSource,
  /function dryRunLine[\s\S]*?return `([^$`]+)\$\{/,
  'dryRunLine in src/client.ts',
)

/**
 * The configuration failure, which is the one thing this process writes WITHOUT
 * going through `log()` — no timestamp, no priority prefix, several lines. The
 * sub-messages are the half that names the fault, and deploy.md quoted the
 * heading without them, which tells an operator that something is wrong with
 * the file and nothing about what.
 */
const INVALID_CONFIG = capture(
  configSource,
  /new Error\(`([^`\\]+)\\n/,
  "loadConfig's error heading in src/config.ts",
)

const NOT_SET = capture(configSource, /required_error: '([^']+)'/, "zod's required_error message")

const SET_BUT_EMPTY = capture(configSource, /\.min\(1, '([^']+)'\)/, 'the empty-after-trim message')

const BAD_FLAG = capture(
  configSource,
  /message: `([^`$]+)\$\{raw\}/,
  'the "true"/"false" flag message',
)

const SEE_EXAMPLE = capture(configSource, /\\n\\n(See [^`]+)`\)/, 'the .env.example pointer')

/**
 * discord.js's own wording for the two failures that restart-loop the unit.
 *
 * THEY ARE NOT OURS TO WRITE DOWN FROM MEMORY, which is exactly how `a 401 or
 * an invalid-token message` got into the document: plausible, and matching
 * nothing the journal has ever contained. `Used disallowed intents` is read out
 * of the dependency that constructs it, and the token error is constructed for
 * real so that its `name` — which is where `[TokenInvalid]` comes from — is the
 * library's and not a guess.
 *
 * THE CONSTRUCTOR IS PRIVATE IN THE TYPINGS and public at runtime; discord.js
 * throws exactly this object out of `client.login()` when `/gateway/bot`
 * answers 401. The cast is the cheapest way to hold the real thing rather than
 * a lookalike built by hand.
 */
const DISALLOWED_INTENTS = capture(
  repoFile('node_modules/@discordjs/ws/dist/index.js'),
  /new Error\("(Used disallowed intents)"\)/,
  "@discordjs/ws's disallowed-intent error",
)

const TokenInvalidError = DiscordjsError as unknown as new (code: string) => Error

/**
 * One line, exactly as `log()` writes it, ready to be looked for in the doc.
 *
 * GOING THROUGH `log()` RATHER THAN FORMATTING A STRING HERE is the difference
 * between this file and the weaker check it replaces. The quoting, the escaping
 * and the ordering are the ones the operator will actually see, so a change to
 * any of them fails here instead of quietly making the document wrong again.
 */
function emit(level: Level, message: string, fields?: Record<string, unknown>): string {
  const stream = level === 'info' ? stdout : stderr
  const index = stream.length
  log(level, message, fields)
  return written(stream, index)
}

/** One `key="value"` token off an emitted line. */
const field = (line: string, key: string): string =>
  capture(line, new RegExp(`(${key}="[^"]*")`), `the ${key} field of an emitted line`)

describe('.github/workflows/ci.yml — the first push must not fail on a mode bit', () => {
  const workflow = repoFile('.github/workflows/ci.yml')

  /**
   * `- run: ./verify.sh` needs the executable bit recorded in git, and this
   * repo is developed on Windows with `core.filemode=false`, so verify.sh goes
   * in at 0644 and the runner answers "Permission denied", exit 126, before any
   * check runs. A red build that looks like a broken test suite and is not.
   */
  it('invokes verify.sh through an interpreter, not as an executable', () => {
    expect(workflow).toMatch(/^\s*-\s*run:\s*(ba)?sh verify\.sh\s*$/m)
    expect(workflow).not.toMatch(/^\s*-\s*run:\s*\.\/verify\.sh\s*$/m)
  })
})

describe('docs/deploy.md — what an operator is told at 3am', () => {
  const deploy = repoFile('docs/deploy.md')

  /**
   * THE CROSS-CHECK THAT CLOSES THE ORIGINAL BUG. deploy.md hands the operator
   * `journalctl -u blitz-bot -p warning`; that command only works because
   * `log()` writes a syslog priority prefix. Asserting the document names the
   * exact prefix the code emits means the two cannot drift apart silently
   * again — remove the prefix and this fails, renumber it and this fails.
   */
  it('documents the same priority prefixes log() actually emits', () => {
    log('error', 'x')
    log('warn', 'x')
    log('info', 'x')

    const emitted = [written(stderr, 0), written(stderr, 1), written(stdout, 0)].map((line) =>
      line.slice(0, 3),
    )

    expect(emitted).toEqual(['<3>', '<4>', '<6>'])
    for (const prefix of emitted) expect(deploy).toContain(prefix)
    expect(deploy).toContain('journalctl -u blitz-bot -p warning')
  })

  /**
   * THE BUG THIS REPLACES A WEAKER TEST FOR. The old version asserted five
   * strings against the whole document, and a confirmation pass showed three
   * separate deletions from the Discord section that left it green — including
   * deleting the OAuth2 URL Generator steps outright, which is the only place
   * that says how the bot gets into the guild at all. A `.env` and a unit file
   * with no bot in the server is a working service that moderates nothing.
   *
   * Every string here is something an operator cannot derive from the rest of
   * the document: a portal screen, a scope, or the click that produces an id.
   */
  it('keeps every Discord setup step that cannot be guessed from the rest of the file', () => {
    const discord = section(deploy, /^## \d+\. Discord/m)

    for (const required of [
      // 4.1 — the intent, and the close code it fails with.
      'Message Content',
      '4014',

      // 4.2 — how the bot is put in the guild, and with what.
      'OAuth2 URL Generator',
      'Manage Messages',

      // 4.3 — where each id actually comes from. Without these the operator has
      // a variable name and no way to produce a value for it.
      'Developer Mode',
      'Copy Server ID',
      'Copy Channel ID',
      'DISCORD_GUILD_ID',
      'BLITZ_LOG_CHANNEL_ID',
    ]) {
      expect(discord).toContain(required)
    }

    // The scope is `bot`, and naming it is the point: an install with the wrong
    // scope fails at authorise time with nothing in this repo to explain it.
    expect(discord).toMatch(/Scopes[^\n]*`bot`/)
  })

  /**
   * THE FABRICATED LOG LINE. This section used to tell the operator the
   * wrong-guild case appears as `msg="connected but not a member of the
   * configured guild"`. That string is in no version of src/, so grepping the
   * journal for it returns nothing and reads as "the check never fired" — for
   * the one failure where the bot is deleting our own invites.
   *
   * THE REAL LINE IS ASSEMBLED FROM THREE PLACES, so this assembles it the same
   * way rather than restating it: the template is in `haltModeration`, the
   * reason is at its call site in `createClient`, and the quoting is `log()`'s.
   * Reword any of the three and this fails until deploy.md is updated to match,
   * which is the only thing that keeps a quoted log line honest.
   */
  it('quotes the halt line client.ts actually emits, character for character', () => {
    const client = repoFile('src/client.ts')

    const template = capture(
      client,
      /log\('error', `([^`]*)\$\{reason\}`/,
      "haltModeration's log call in src/client.ts",
    )
    const reason = capture(
      client,
      /haltModeration\(\s*'([^']+)'/,
      'the haltModeration call in createClient',
    )

    log('error', `${template}${reason}`)

    const emitted = capture(written(stderr), /(msg="[^"]*")/, 'the emitted line')
    expect(deploy).toContain(emitted)
  })

  /**
   * THE STORY THE CODE FIX DELETED. This section used to say that with the
   * intent off the bot "connects, logs a healthy `ready`, receives every
   * message, and reads `message.content` as the empty string for all of them",
   * and told the operator to check the switch first when nothing was being
   * removed. src/client.ts now records that as wrong: the gateway closes 4014,
   * `login()` rejects, the process exits non-zero and systemd restart-loops it,
   * so there is no `ready` and no message at all.
   *
   * NAMING THE OLD CLAIM IN ORDER TO RETRACT IT IS ALLOWED; asserting it as
   * current behaviour is not. That is why this reads paragraph by paragraph
   * instead of banning the words outright — the retraction is worth keeping,
   * and it is exactly the thing a broad `not.toContain` would have to forbid.
   */
  it('describes the missing-intent failure the way client.ts says it actually fails', () => {
    const discord = section(deploy, /^## \d+\. Discord/m)

    expect(discord).toContain('4014')
    expect(discord).toMatch(/never[^.]*`ready`/)

    for (const paragraph of paragraphs(discord)) {
      if (!paragraph.includes('empty string')) continue
      expect(paragraph).toMatch(/used to|no longer|was wrong/i)
    }
  })

  /**
   * Ordering, not just presence. Discord configuration done AFTER
   * `systemctl enable --now` is discovered as a restart loop rather than as a
   * step, which is the expensive way to find out.
   */
  it('puts the Discord section ahead of the line that starts the unit', () => {
    // Matched by shape rather than by number, so renumbering the sections is
    // allowed and moving them is not.
    const discord = deploy.search(/^## \d+\. Discord/m)
    const start = deploy.indexOf('systemctl enable --now blitz-bot')

    expect(discord).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(discord)
  })

  /** The bot's application is the console's application; the token is wider than the console's docs say. */
  it('records that the Discord application is shared with the console, and that it is tracked', () => {
    expect(deploy).toMatch(/shared with the Ringmaster console/i)
    expect(deploy).toMatch(/tracked as a known\s+issue/i)
  })

  /**
   * `activating (auto-restart)` reads as "still starting" to anyone who has not
   * seen it before. With `StartLimitIntervalSec=0` it can say that forever.
   */
  it('names the restart-loop signature and how to tell it from a Discord outage', () => {
    expect(deploy).toContain('activating (auto-restart)')
    expect(deploy).toContain('StartLimitIntervalSec=0')
    expect(deploy).toContain('Invalid configuration:')
    expect(deploy).toMatch(/discordstatus\.com/)
  })

  /**
   * THE JOURNAL IS NOT THE INTERFACE. The owner's rule is that there are no CLI
   * interactions with the bot or its data; SSH stays correct for installing and
   * updating it, which is what the rest of this document is, but a Logs section
   * written as "here is how you watch the bot" makes `journalctl` the day-to-day
   * answer and quietly settles a question that is still open.
   *
   * TWO DIFFERENT THINGS SHARE ONE CHANNEL NAME, AND ONLY ONE OF THEM EXISTS.
   * Removals reaching `#bot-status` is `BLITZ_LOG_CHANNEL_ID`, which is built
   * and is what the smoke test exercises. The bot's OWN faults reaching a
   * channel — a failed delete, a halt, a gateway that will not stay up — is
   * issue #9 and is not built. Every paragraph here that names the channel has
   * to be one or the other: an operator sent to watch a channel for faults it
   * never receives loses the same evening as one grepping for a log line that
   * was never emitted, which is the other half of this same review.
   */
  it('frames the journal as a last resort without promising a status channel that does not exist', () => {
    const logs = section(deploy, /^## \d+\. Logs/m)

    expect(logs).toMatch(/last resort/i)

    let removals = 0
    let faults = 0

    for (const paragraph of paragraphs(logs)) {
      if (!paragraph.includes('#bot-status')) continue

      // The built half says which variable puts removals there. The unbuilt
      // half must name the issue and say it is not built. A paragraph that is
      // neither is a promise about a channel nobody has wired up.
      if (paragraph.includes('BLITZ_LOG_CHANNEL_ID')) {
        removals += 1
        expect(paragraph).toMatch(/removal/i)
        continue
      }

      faults += 1
      expect(paragraph).toMatch(/issue\s+#9/)
      expect(paragraph).toMatch(/not\s+built|does not\s+exist|until it is/i)
    }

    // Nothing above fires if the channel is never named, so require both halves.
    expect(removals).toBeGreaterThan(0)
    expect(faults).toBeGreaterThan(0)
  })
})

/**
 * Every log line docs/deploy.md quotes, re-derived from the code that writes it.
 *
 * THIS IS THE THIRD PASS OVER THE SAME CLASS OF BUG. The document has quoted
 * `msg="connected but not a member of the configured guild"`, then
 * `msg="delete failed"`, then `error="... disallowed intents ..."` and `a 401
 * or an invalid-token message` — four strings, none of which the process has
 * ever written. The failure mode is always the same: an operator greps for the
 * quoted line during the one failure it belongs to, gets nothing back, and
 * reads that as evidence the check never fired.
 *
 * SO NOTHING BELOW TYPES A MESSAGE OUT. Each one is captured from its call site
 * at the top of this file, put through the real `log()`, and the resulting
 * `key="value"` token is what the document must contain. Reword a message in
 * src/ and these fail until deploy.md is updated to match, which is the only
 * arrangement that has ever kept a quoted log line honest.
 */
describe('docs/deploy.md — every quoted log line, re-derived from the source', () => {
  it('quotes the message of every line it tells the operator to look for', () => {
    const lines: readonly (readonly [string, Level, string])[] = [
      ['the ready line', 'info', READY],
      ['the halt line', 'error', HALT],
      ['the dry-run line', 'warn', WOULD_DELETE],
      ['the removal line', 'info', DELETED],
      ['the failed-delete line', 'error', DELETE_FAILED],
      ['the gateway-disconnect line', 'warn', GATEWAY_DISCONNECTED],
      ['the unusable-log-channel line', 'error', LOG_CHANNEL_UNUSABLE],
      ['the failed-channel-post line', 'error', LOG_CHANNEL_POST_FAILED],
      ['the failed-login line', 'error', LOGIN_FAILED],
    ]

    for (const [what, level, message] of lines) {
      expect(deployDoc, what).toContain(field(emit(level, message), 'msg'))
    }
  })

  /**
   * ONE CONVENTION, EVERYWHERE: AS `journalctl` PRINTS IT.
   *
   * The halt line was once quoted starting at `level=error`, word-perfect from
   * there on — bytes that exist in neither place, because every line this
   * process writes opens with a `<N>` priority and then an ISO-8601 UTC
   * timestamp, and journald eats the `<N>` and hands back the timestamp.
   *
   * THE DOCUMENT THEN CONTRADICTED ITSELF THE OTHER WAY. §4.1 and §4.3 quoted
   * three lines WITH the `<4>`/`<3>` still on the front, introduced as what the
   * journal shows, while §7 and src/log.ts both said journald strips it — so an
   * operator matching §4 against his screen was comparing against bytes
   * journald had already thrown away, in the one section where he is reading
   * character by character. §14 quoted the same class of line without a prefix,
   * which made the pair look like a typo rather than a decision.
   *
   * So: no prefix, in every fenced example, enforced here. The `<N>` values
   * still appear in §7 and §13 as prose, where they explain `-p warning` and
   * are not being matched against anything.
   */
  it('quotes every log line the way journalctl prints it, with no priority prefix', () => {
    const quoted = codeBlocks(deployDoc)
      .flatMap((block) => block.split('\n'))
      .filter((line) => line.includes('level='))

    expect(quoted.length).toBeGreaterThan(0)

    for (const line of quoted) {
      expect(line, line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z level=(info|warn|error) msg="/)
    }

    // And the document has to say where the prefix went, or a reader who has
    // run the process by hand thinks these lines are missing something.
    expect(deployDoc).toMatch(/journald[^.]*strips/i)

    // Said once, as a rule about the whole file, rather than left to be
    // inferred from the examples: that inference is what drifted last time.
    expect(deployDoc.replace(/\s+/g, ' ')).toMatch(
      /quoted anywhere in this document is quoted the way `journalctl` prints it/,
    )
  })

  /**
   * The `ready` line is the one command in the document that answers "is this
   * bot actually working", and `dryRun=` is the field that says which of the two
   * postures it is in. Deleting a field from the quoted line would leave the
   * operator comparing his journal against a line that is missing the thing he
   * was sent there to read.
   */
  it('quotes the ready line with every field client.ts puts on it, in both postures', () => {
    // The QUOTED line, not the `grep 'msg="ready"'` that finds it: both live in
    // fenced blocks and only one of them is a log record.
    const quoted = quoting(deployDoc, `msg="${READY}"`)

    expect(quoted.length).toBeGreaterThan(0)

    for (const line of quoted) {
      for (const key of READY_FIELDS) expect(line, key).toContain(`${key}=`)
    }

    /**
     * BOTH POSTURES, EACH IN THE SECTION THAT SENDS THE OPERATOR TO READ IT.
     * `dryRun=true` is what §7 checks after the first start and `dryRun=false`
     * is what proves the go-live flip took, and asserting the pair against the
     * whole document is how deleting §9's copy stayed green: §12.1 quotes a
     * ready line with `dryRun=false` of its own, for a different purpose, and
     * covered for it.
     */
    expect(quoting(section(deployDoc, /^## \d+\. Start it/m), 'dryRun=true')).not.toHaveLength(0)
    expect(quoting(section(deployDoc, /^## \d+\. Going live/m), 'dryRun=false')).not.toHaveLength(0)
  })

  /**
   * The two lines that reach the admin channel, which are the only output the
   * owner sees without an SSH session — and therefore the only thing the smoke
   * test in §8 can be read against.
   */
  it('quotes both channel lines the bot posts to BLITZ_LOG_CHANNEL_ID', () => {
    expect(deployDoc).toContain(CHANNEL_DRY_RUN)
    expect(deployDoc).toContain(CHANNEL_REMOVED)
  })

  /**
   * `Invalid configuration:` alone tells an operator that something in a file is
   * wrong and nothing about what. The sub-messages are the diagnosis, and they
   * are two different faults: a line that is missing versus a line that is
   * present and empty.
   */
  it('reproduces the configuration failure with the sub-messages that name the fault', () => {
    expect(deployDoc).toContain(INVALID_CONFIG)
    expect(deployDoc).toContain(`: ${NOT_SET}`)
    expect(deployDoc).toContain(`: ${SET_BUT_EMPTY}`)
    expect(deployDoc).toContain(BAD_FLAG)
    expect(deployDoc).toContain(SEE_EXAMPLE)

    // index.ts writes this one straight to stderr rather than through log(), so
    // it is the one block in the document with no timestamp and no prefix. Say
    // so, or it reads as another line that can be grepped for by its opening.
    expect(deployDoc).toMatch(/no\s+timestamp and no priority prefix/i)
  })

  /**
   * THE TWO RESTART-LOOP ERRORS ARE DISCORD.JS'S WORDS, NOT OURS. This is where
   * `a 401 or an invalid-token message` came from — a plausible sentence about
   * a string nothing emits. Both are rendered through the real `log()` here so
   * the document holds the exact `error="..."` token the journal will.
   */
  it('quotes the login errors discord.js actually hands to index.ts', () => {
    const intents = emit('error', LOGIN_FAILED, { error: new Error(DISALLOWED_INTENTS) })
    expect(deployDoc).toContain(field(intents, 'error'))

    const token = emit('error', LOGIN_FAILED, { error: new TokenInvalidError('TokenInvalid') })
    expect(deployDoc).toContain(field(token, 'error'))
  })

  /**
   * The missing-permission delete. `Missing Permissions` is Discord's own
   * response text and lives in no file in this repo; the half that CAN be
   * derived — the error's name, and the numeric code inside it — is, so a
   * discord.js that renames `DiscordAPIError` or renumbers the constant fails
   * here rather than in a journal at 3am.
   */
  it('quotes the failed delete with the API error the journal will carry', () => {
    const code = RESTJSONErrorCodes.MissingPermissions
    const error = new DiscordAPIError({ code, message: 'Missing Permissions' }, code, 403, 'DELETE', 'https://discord.com/api/v10/channels/0/messages/0', {})

    expect(deployDoc).toContain(field(emit('error', DELETE_FAILED, { error }), 'error'))
  })
})

/**
 * WHERE each quoted line is, not merely THAT the string is somewhere in the file.
 *
 * A MUTATION PASS DELETED ALL SIXTEEN QUOTED LINES, ONE AT A TIME. Ten failed a
 * test and six did not: the two intent-failure lines in §4.1, the halt line in
 * §4.3, §9's `dryRun=false` ready line, and both login errors in §14. The cause
 * was structural rather than six missing cases — every assertion was
 * `deployDoc.toContain(...)` over the whole document, and each of those six
 * strings is ALSO named somewhere else. §14's troubleshooting table repeats both
 * login errors and the disconnect; §12.1 repeats the halt line and a ready line
 * with `dryRun=false` on it. So the example an operator was sent to compare
 * against his screen could be deleted outright and a mention two hundred lines
 * away kept the suite green.
 *
 * SO EACH LINE IS PINNED TO ITS SECTION, AND TO A FENCED BLOCK INSIDE IT. Prose
 * and table rows count for nothing here, deliberately: a row that names the
 * failure is what you read once you already know where to look, and the quoted
 * line is what you match character by character against the journal in front of
 * you. One does not replace the other, which is the whole reason both exist.
 */
describe('docs/deploy.md — every quoted line, in the section that needs it', () => {
  const msgOf = (level: Level, message: string): string => field(emit(level, message), 'msg')
  const errorOf = (error: Error): string =>
    field(emit('error', LOGIN_FAILED, { error }), 'error')

  const DISCORD = /^## \d+\. Discord/m
  const SILENT = /^## \d+\. The failure that looks like success/m
  const RESTART_LOOP = /^## \d+\. When it will not start/m

  it('quotes both intent-failure lines in the Discord section itself', () => {
    const discord = section(deployDoc, DISCORD)

    // §4.1 is where the intent gets turned on, and these two lines are what the
    // journal shows when it was not. §14's table names the same failure and is
    // not a substitute for them.
    expect(quoting(discord, msgOf('warn', GATEWAY_DISCONNECTED))).not.toHaveLength(0)
    expect(quoting(discord, msgOf('error', LOGIN_FAILED))).not.toHaveLength(0)
    expect(quoting(discord, errorOf(new Error(DISALLOWED_INTENTS)))).not.toHaveLength(0)
  })

  it('quotes the halt line both where it is caused and where it is diagnosed', () => {
    // §4.3 is where a wrong DISCORD_GUILD_ID gets typed; §12.1 is where its one
    // symptom is looked for. Each needs the line and neither covers for the
    // other — only §12.1's copy was ever guarded.
    expect(quoting(section(deployDoc, DISCORD), msgOf('error', HALT))).not.toHaveLength(0)
    expect(quoting(section(deployDoc, SILENT), msgOf('error', HALT))).not.toHaveLength(0)
  })

  it('quotes both restart-loop login errors in the restart-loop section', () => {
    const loop = section(deployDoc, RESTART_LOOP)

    // The table immediately above them lists both strings in prose, which is
    // exactly what kept deleting the fenced examples green.
    for (const error of [
      errorOf(new Error(DISALLOWED_INTENTS)),
      errorOf(new TokenInvalidError('TokenInvalid')),
    ]) {
      expect(quoting(loop, error), error).not.toHaveLength(0)
    }
  })
})

/**
 * The steps a non-programmer cannot supply for themselves.
 *
 * A DRY WALK OF THIS DOCUMENT BY THREE REVIEWERS FOUND IT WOULD NOT GET THE
 * OWNER TO A WORKING BOT, and most of what was missing was missing entirely
 * rather than wrong: no way to get a prompt on the box, no `git` (it is not in
 * the Ubuntu Server image), no mention anywhere of `BLITZ_DRY_RUN`, nothing that
 * confirmed the bot had connected, and nothing that tried the feature once
 * before it was pointed at a live community.
 *
 * PRESENCE SOMEWHERE IN A 30KB FILE IS NOT PRESENCE WHERE THE OPERATOR IS
 * STANDING, so these slice a section first and assert inside it, and several
 * assert on ORDER — a step in the wrong place is a step that gets discovered as
 * a failure instead of followed as an instruction.
 */
describe('docs/deploy.md — the steps that cannot be left out', () => {
  const at = (heading: RegExp): number => {
    const index = deployDoc.search(heading)
    if (index === -1) throw new Error(`no section matching ${String(heading)}`)
    return index
  }

  const SSH = /^## \d+\..*SSH/m
  const SMOKE = /^## \d+\. The smoke test/m
  const LIVE = /^## \d+\. Going live/m

  it('starts by getting the operator a prompt on the right box', () => {
    const step = section(deployDoc, SSH)

    // The box has no public IP and the hostname is the only thing that proves
    // the session landed on it rather than on the game host.
    expect(step).toContain('ssh ubuntu@10.0.133.69')
    expect(step).toContain('ip-10-0-133-69')
    expect(step).toMatch(/sudo/)

    // Running the install as root produces a directory and an .env the bot
    // cannot read, and a failure that never mentions ownership.
    expect(step).toMatch(/sudo -i/)

    expect(at(SSH)).toBeLessThan(deployDoc.indexOf('git clone'))
  })

  it('installs git before the clone that needs it', () => {
    const install = deployDoc.search(/apt-get install[^\n]*\bgit\b/)
    expect(install).toBeGreaterThan(-1)
    expect(deployDoc.indexOf('git clone')).toBeGreaterThan(install)
  })

  /**
   * The unit's `ExecStart` names `/opt/node24/bin/node`, and something has to
   * put a binary there. Deleting this section leaves a runbook that ends in a
   * unit pointing at a path that does not exist — which fails at start with an
   * error about the unit rather than about the missing step.
   */
  it('installs the bot its own Node, checks the download, and does it before the unit needs it', () => {
    const node = section(deployDoc, /^## \d+\. Node/m)
    const major = capture(repoFile('package.json'), /"node": ">=(\d+)"/, 'engines.node')

    expect(node).toContain('/opt/node24/bin/node')
    expect(node).toMatch(new RegExp(`nodejs\\.org/dist/v${major}\\.`))

    // A truncated tarball produces errors that read like bugs in the bot.
    expect(node).toMatch(/sha256sum -c/)

    // The console's runtime, recorded before and confirmed unchanged after.
    expect(node).toContain('/usr/bin/node -v')

    expect(deployDoc.search(/^## \d+\. Node/m)).toBeLessThan(deployDoc.indexOf('ExecStart='))
  })

  /**
   * THE ARCHITECTURE WAS ASSUMED AND NEVER CHECKED. §2 downloaded
   * `node-v24.20.0-linux-x64.tar.xz` with no `uname -m` anywhere in the
   * document. This box is x86_64, so it was never a live failure — but a runbook
   * is the thing somebody follows on the NEXT box, and on a Graviton instance
   * the x64 tarball downloads cleanly, passes its checksum, unpacks without a
   * word, and surfaces two blocks later as `cannot execute binary file: Exec
   * format error`. Which reads as a corrupt download and sends the reader back
   * to a checksum that will go on saying `OK`.
   */
  it('checks the CPU architecture instead of assuming it', () => {
    const node = section(deployDoc, /^## \d+\. Node/m)

    expect(node).toContain('uname -m')
    expect(node).toContain('x86_64')
    expect(node).toContain('aarch64')

    // Checked BEFORE the download, which is the only place the answer is still
    // cheap to act on.
    expect(node.indexOf('uname -m')).toBeLessThan(node.indexOf('nodejs.org/dist'))

    /**
     * And every command that names the tarball derives the name rather than
     * hardcoding one of the two. The expected-output block still shows the x64
     * filename, which is correct and is why this looks at commands rather than
     * at every mention: that block is what THIS box prints.
     */
    const naming = codeBlocks(node)
      .flatMap((block) => block.split('\n'))
      .filter((line) => line.includes('.tar.xz') && /(^|\s)(curl|tar|grep)\s/.test(line))

    expect(naming).not.toHaveLength(0)
    for (const line of naming) expect(line, line).toContain('uname -m')
  })

  /**
   * THE BLOCKER, AND IT WAS INVISIBLE BECAUSE IT WOULD NOT HAVE FAILED. §1
   * installs git, curl, ca-certificates and xz-utils and never names npm; §2
   * keeps `/opt/node24/bin` off `PATH` on purpose. So a bare `npm ci` in §3 or
   * §16 does not error — it resolves to the CONSOLE'S npm, running on
   * `/usr/bin/node` v22.23.2, which is the one runtime the first page of this
   * document promises the bot never touches. It would have installed something,
   * and the operator would have had no reason to look.
   *
   * COMMENT LINES ARE SKIPPED, and one of them is load-bearing: the unit heredoc
   * in §6 explains why `ExecStart` is node and not `npm start`. That is prose
   * which happens to live inside a fenced block, not a command anyone runs.
   */
  it('never invokes the console npm for the bot', () => {
    const bash = captureAll(deployDoc, /^```bash\n([\s\S]*?)^```/gm, 'a bash block in deploy.md')

    for (const line of bash.flatMap((block) => block.split('\n'))) {
      if (/^\s*#/.test(line)) continue
      expect(line, line).not.toMatch(/(^|[^\w/])npm\b/)
    }

    // Both places that install dependencies: the first deploy, and every one
    // after it.
    const code = section(deployDoc, /^## \d+\. The code/m)

    expect(code).toContain('/opt/node24/bin/npm ci')
    expect(section(deployDoc, /^## \d+\. Deploying an update/m)).toContain('/opt/node24/bin/npm ci')

    /**
     * And why it is an absolute path rather than a `PATH` entry, which is the
     * fix somebody will reach for first: a `PATH` entry would change which
     * `node` the OPERATOR'S shell finds, and the console is maintained from
     * that shell. Written down, or the next edit undoes this one for tidiness.
     */
    const flat = code.replace(/\s+/g, ' ')

    expect(flat).toMatch(/is deliberately off everyone/)
    expect(flat).toMatch(/Adding `\/opt\/node24\/bin` to `PATH` would fix this line/)
    expect(flat).toMatch(/shell finds, and the console/)
  })

  /**
   * PROOF RATHER THAN ASSERTION, AND AN HONEST ONE. Nothing under
   * `node_modules` records which npm wrote it, so there is no after-the-fact
   * check on the command. What can be checked is the tree: load it with the
   * runtime the unit will use and read back what that runtime says it is.
   * `vitest --version` prints the Node version and the architecture on one
   * line, which answers §2's question and §3's at the same time.
   */
  it('proves after the install that the bot runtime can run what was installed', () => {
    const code = section(deployDoc, /^## \d+\. The code/m)
    const major = capture(repoFile('package.json'), /"node": ">=(\d+)"/, 'engines.node')

    expect(code).toMatch(/\/opt\/node24\/bin\/node \/opt\/blitz-bot\/node_modules\/\.bin\//)

    // The expected output has to name the runtime, or there is nothing in it
    // worth reading: a bare version number would look identical on Node 22.
    expect(code).toContain(`node-v${major}.`)

    expect(code.indexOf('/opt/node24/bin/npm ci')).toBeLessThan(
      code.indexOf('/opt/node24/bin/node /opt/blitz-bot/node_modules/.bin/'),
    )
  })

  /**
   * THE ATTRIBUTION. §14 said `src/config.ts` exits 1 on a mistyped variable.
   * It does not — it throws, and `src/index.ts` is what catches the throw and
   * calls `process.exit(1)`. Small on its own, and not small when the next
   * person greps config.ts for the exit, does not find it, and starts wondering
   * which parts of this document describe a different program.
   */
  it('attributes the non-zero exit to the file that actually calls process.exit', () => {
    expect(configSource).toMatch(/throw new Error\(`Invalid configuration/)
    expect(configSource).not.toMatch(/process\.exit/)
    expect(indexSource).toMatch(/process\.exit\(1\)/)

    const loop = section(deployDoc, /^## \d+\. When it will not start/m).replace(/\s+/g, ' ')

    expect(loop).toMatch(/`src\/config\.ts` throws/)
    expect(loop).toMatch(/`src\/index\.ts` is what catches that and exits 1/)
    expect(loop).not.toMatch(/`src\/config\.ts` exits/)
  })

  /**
   * THE FOURTH SILENT FAILURE, AND THE ONLY ONE THAT IS NOT THE BOT'S FAULT.
   * Every `journalctl` in this document is unsudoed. That is correct on a stock
   * Ubuntu image, where `ubuntu` is in `adm` and `adm` is what journald's ACLs
   * grant read on the system journal. Where it is not — a rebuilt image, a
   * different login — `journalctl -u blitz-bot` does not refuse: it reads the
   * caller's own journal, finds nothing there for a system unit, and exits 0.
   * Piped into a `grep`, as most of §12 is, even `-- No entries --` disappears.
   *
   * Which makes every diagnostic in §12 answer "the bot has logged nothing" —
   * this section's own failure mode, turned around on the operator.
   */
  it('names the empty journal an unprivileged operator gets, and how to tell it apart', () => {
    const silent = section(deployDoc, /^## \d+\. The failure that looks like success/m)

    // The one command that separates "no lines" from "no access".
    expect(silent).toContain('id -nG')
    expect(silent).toMatch(/\badm\b/)

    // sudo is the way out that always works; group membership is how to stop
    // paying for it.
    expect(silent).toMatch(/sudo journalctl -u blitz-bot/)
    expect(silent).toMatch(/usermod -aG adm/)

    // The point is the exit status: an error would have been noticed.
    expect(silent.replace(/\s+/g, ' ')).toMatch(/exits 0/)
  })

  /**
   * THE SINGLE MOST IMPORTANT OMISSION OF THE REVIEW. `BLITZ_DRY_RUN` appeared
   * nowhere in the document, and `.env.example` ships it false — so following
   * the runbook exactly, the bot's first act on a live community was deleting
   * things nobody had reviewed. The flag has to be written into `.env`
   * explicitly, before the unit is ever started, because the code's default is
   * the other way.
   */
  it('puts the bot in dry run before it is ever started', () => {
    expect(capture(configSource, /BLITZ_DRY_RUN: flag\((\w+)\)/, "BLITZ_DRY_RUN's default")).toBe(
      'false',
    )

    /**
     * IN THE BLOCK THAT WRITES THE FILE, not merely somewhere in the document.
     * A table saying the flag ought to be true, next to a heredoc that writes
     * `false`, is a document that reads correctly and deploys a bot that starts
     * deleting.
     */
    const envFile = capture(
      deployDoc,
      /cat > \/opt\/blitz-bot\/\.env <<'EOF'\n([\s\S]*?)\nEOF/,
      'the .env heredoc in deploy.md',
    )

    expect(envFile).toContain('BLITZ_DRY_RUN=true')

    // Both required variables have to be in the file the operator writes, or he
    // finds out which one he missed from a restart loop.
    for (const key of captureAll(
      configSource,
      /^ {2}(\w+): required,$/gm,
      'the required variables in the schema',
    )) {
      expect(envFile, key).toContain(`${key}=`)
    }

    // The admin-only channel the dry run reports into. Without it the whole
    // posture is an SSH session, which is the thing the owner does not want.
    expect(envFile).toMatch(/^BLITZ_LOG_CHANNEL_ID=\d+$/m)

    expect(deployDoc.indexOf('systemctl enable --now blitz-bot')).toBeGreaterThan(
      deployDoc.indexOf('BLITZ_DRY_RUN=true'),
    )
  })

  /**
   * A running process is not a working bot. The `ready` line is the only thing
   * that says it reached Discord and which guild it is in, and this is the step
   * that sends the operator to look at it.
   */
  it('confirms the bot connected, and in which posture', () => {
    const start = section(deployDoc, /^## \d+\. Start it/m)

    expect(start).toMatch(/journalctl[^\n]*grep[^\n]*ready/)
    expect(start).toContain('dryRun=true')
  })

  /**
   * In dry run the smoke test costs one message and removes nothing, which is
   * the whole argument for doing it: everything up to here proves a process is
   * alive and talking, and none of it proves the bot reads a message, recognises
   * a foreign invite, or can post where the owner will see it.
   */
  it('keeps a functional smoke test that exercises the feature end to end', () => {
    const smoke = section(deployDoc, SMOKE)

    expect(smoke).toContain('discord.gg')
    expect(smoke).toContain(CHANNEL_DRY_RUN)
    // The quoted record, not the `grep 'would have deleted'` that finds it.
    expect(quoting(smoke, field(emit('warn', WOULD_DELETE), 'msg'))).not.toHaveLength(0)
    expect(smoke).toMatch(/journalctl/)

    // The other half of the feature, and the one it is easy to forget to try:
    // an invite to OUR guild must survive.
    expect(smoke).toMatch(/our own/i)

    expect(at(SMOKE)).toBeGreaterThan(deployDoc.indexOf('systemctl enable --now blitz-bot'))
  })

  it('keeps a go-live step that flips the flag, restarts, and re-runs the smoke test', () => {
    const live = section(deployDoc, LIVE)

    expect(live).toContain('BLITZ_DRY_RUN=false')
    expect(live).toContain('systemctl restart blitz-bot')
    expect(live).toContain('dryRun=false')
    expect(live).toContain(CHANNEL_REMOVED)
    expect(quoting(live, field(emit('info', DELETED), 'msg'))).not.toHaveLength(0)

    // Going live before the dry run has been watched is the one ordering
    // mistake in this document that cannot be undone.
    expect(at(LIVE)).toBeGreaterThan(at(SMOKE))
  })

  it('confirms ownership, reboot survival and the console, each as its own step', () => {
    expect(deployDoc).toContain('ls -ld /opt/blitz-bot /opt/blitz-bot/node_modules')
    expect(section(deployDoc, /^## \d+\. Reboot/m)).toContain('systemctl is-enabled blitz-bot')
    expect(section(deployDoc, /^## \d+\. Confirm the console/m)).toContain(
      'systemctl is-active ringmaster',
    )
  })

  /**
   * `systemctl status` EXITS 3 WHEN THE UNIT IS NOT RUNNING, so `status &&
   * journalctl` skips the journal on exactly the run that failed — the only run
   * where the journal is the thing worth reading. It appeared twice.
   */
  it('never hides the journal behind a status command that exits non-zero', () => {
    expect(deployDoc).not.toMatch(/systemctl status[^\n]*&&[^\n]*journalctl/)
    expect(deployDoc).toMatch(/systemctl status[^\n]*;[^\n]*journalctl/)
  })

  /**
   * The bot runs its own Node 24 under /opt/node24. /usr/bin/node is the
   * console's runtime, and the version of this document that offered "upgrade
   * the system Node" as a branch handed a non-programmer a judgement call about
   * a service he was not deploying.
   */
  it('runs the bot on its own Node and never proposes moving the console onto another', () => {
    /**
     * Only the warning flag is shared with `npm start`. The rest of that script
     * legitimately differs — it hands node `--env-file-if-exists=.env` because
     * a hand-run has nothing else to populate the environment, where the unit
     * has `EnvironmentFile=` — so pinning the whole script would fail the day
     * that difference was introduced, which is a difference the unit is right
     * not to copy.
     */
    const warning = capture(
      repoFile('package.json'),
      /"start": "node [^"]*?(--disable-warning=\w+)/,
      "the experimental-warning flag in package.json's start script",
    )

    expect(deployDoc).toContain(
      `ExecStart=/opt/node24/bin/node ${warning} /opt/blitz-bot/src/index.ts`,
    )

    expect(deployDoc).not.toMatch(/ExecStart=\/usr\/bin\/node/)
    expect(deployDoc).not.toMatch(/nodesource/i)
    expect(deployDoc).not.toMatch(/systemctl restart ringmaster/)
  })

  it('writes the unit file in one block and checks it before enabling it', () => {
    const unit = section(deployDoc, /^## \d+\. The unit/m)

    expect(unit).toMatch(/sudo tee \/etc\/systemd\/system\/blitz-bot\.service[^\n]*<<'EOF'/)
    expect(unit).not.toMatch(/nano \/etc\/systemd/)
    expect(unit).toContain('systemd-analyze verify /etc/systemd/system/blitz-bot.service')
    expect(deployDoc.indexOf('systemd-analyze verify')).toBeLessThan(
      deployDoc.indexOf('systemctl enable --now blitz-bot'),
    )
  })

  /**
   * `$USER` is root in a shell that reached the line through `sudo -i`, and a
   * bare `chmod 600 .env` is a chmod on whatever directory the shell happens to
   * be standing in — which, two blocks after the last `cd`, leaves a Discord
   * token world-readable and says nothing.
   */
  it('names the owner and the paths outright, where guessing costs the token', () => {
    expect(deployDoc).toContain('sudo chown ubuntu:ubuntu /opt/blitz-bot')
    expect(deployDoc).not.toMatch(/chown "\$USER/)
    expect(deployDoc).toContain('chmod 600 /opt/blitz-bot/.env')
    expect(deployDoc).not.toMatch(/^chmod 600 \.env$/m)
  })

  /**
   * THE FAILURE THAT ANNOUNCES NOTHING. A wrong `DISCORD_GUILD_ID`, a bot
   * missing Manage Messages, a log channel it cannot post to: the process stays
   * up, systemd stays green, Discord shows the bot Online, and it moderates
   * nothing or reports to nobody for the life of the process. Every other
   * failure in this document is loud; this section is the only thing standing
   * between the owner and a bot he believes is working.
   */
  it('gives the green-but-broken failures a section of their own, with a command each', () => {
    const silent = section(deployDoc, /^## \d+\. The failure that looks like success/m)

    expect(silent).toMatch(/not evidence/i)

    /**
     * AS QUOTED RECORDS, NOT AS STRINGS ANYWHERE IN THE SECTION. Every command
     * here is a `journalctl ... | grep 'msg="..."'`, so the section names each
     * message twice: once in the grep that finds the line and once in the line
     * itself. A `toContain` cannot tell those apart, and the example is the
     * half that gets deleted — the operator is sent here to compare what came
     * back against what should have.
     */
    for (const [what, level, message] of [
      ['the halt', 'error', HALT],
      ['the working case it is told apart from', 'info', READY],
      ['the failed delete', 'error', DELETE_FAILED],
      ['the unusable log channel', 'error', LOG_CHANNEL_UNUSABLE],
      ['the failed channel post', 'error', LOG_CHANNEL_POST_FAILED],
    ] as const) {
      expect(quoting(silent, field(emit(level, message), 'msg')), what).not.toHaveLength(0)
    }

    // A section that describes the failure without handing over the command is
    // the state this document was already in.
    expect(silent).toMatch(/journalctl[^\n]*grep/)
  })
})

describe('README.md — true on the day it is first pushed', () => {
  const readme = repoFile('README.md')

  it('carries the branch policy', () => {
    expect(readme).toMatch(/Only `main` and `dev` may ever exist on origin/)
    expect(readme).toMatch(/everything lands on `main`/)
    expect(readme).toMatch(/work lands on `dev`/)
    expect(readme).toMatch(/pull\s+request/)
  })

  /**
   * NOTHING MAY CLAIM A CI RUN OR A RELEASE THAT HAS NOT HAPPENED. At the time
   * this was written the origin held one file and no workflow had ever run, so
   * a build badge would have been a broken image advertising a green build
   * nobody had seen. Describing the workflow is fine; asserting its verdict is
   * not.
   */
  it('advertises no build badge and no release', () => {
    expect(readme).not.toMatch(/shields\.io|badge\.svg|\/actions\/workflows\/.*badge/i)
    expect(readme).not.toMatch(/\breleases?\/(tag|latest)\b/i)
  })

  it('does not tell anyone to run ./verify.sh', () => {
    expect(readme).not.toMatch(/^\s*\.\/verify\.sh\s*$/m)
  })
})
