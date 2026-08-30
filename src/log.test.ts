import { readFileSync } from 'node:fs'

import { DiscordAPIError, DiscordjsError, RESTJSONErrorCodes } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { log, setSink, type Level, type Sink } from './log.ts'

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

  // The sink is module state in log.ts, so a case that installs one and does
  // not take it away leaves every later case in this file — and in whichever
  // file vitest reuses this worker for — logging into it.
  setSink(null)
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
 * The four files that go on the box, and the script that puts them there.
 *
 * THEY USED TO BE HEREDOCS IN docs/deploy.md AND EVERY ASSERTION BELOW READ
 * THEM OUT OF IT. A `sudo tee /usr/local/bin/blitz-bot-update <<'EOF'` block
 * was the only copy of the updater under version control: nothing could parse
 * it without running it, nothing could diff it against the box, and installing
 * it meant pasting nearly four hundred lines into an SSH session. They are real
 * files now, `verify.sh` parses the two scripts and runs `systemd-analyze
 * verify` over the three units, and everything here reads the file that is
 * actually installed rather than a fenced copy of it.
 *
 * THE RISK IN THAT MOVE IS THIS FILE, WHICH IS WHY IT IS NAMED HERE. Repointing
 * a pin at a path that does not exist, or at a file whose shape has changed,
 * leaves an assertion that matches nothing and passes — thirty green checks
 * pinning nothing at all. `repoFile` throws on a missing file, `capture` and
 * `captureAll` throw when their pattern stops matching, and each of these was
 * confirmed by mutating the file it reads and watching the suite go red.
 */
const updateScript = repoFile('deploy/blitz-bot-update')
const installScript = repoFile('deploy/install.sh')
const botUnit = repoFile('deploy/blitz-bot.service')
const updateUnit = repoFile('deploy/blitz-bot-update.service')
const timerUnit = repoFile('deploy/blitz-bot-update.timer')

/** The two directories deploy/install.sh writes into, as it declares them. */
const installDirs = new Map([
  ['BIN', capture(installScript, /^BIN=(\S+)$/m, "the bin directory install.sh declares")],
  ['SYSTEMD', capture(installScript, /^SYSTEMD=(\S+)$/m, "the unit directory install.sh declares")],
])

/**
 * What deploy/install.sh actually puts on the box, in the order it puts it
 * there: source name, absolute destination, mode.
 *
 * READ OUT OF THE SCRIPT RATHER THAN RESTATED. Four destinations and four modes
 * typed out here would be a second copy of the thing being checked, and the
 * copy that is never wrong is the one nobody maintains. `captureAll` refuses to
 * return nothing, so a `place` line that changed shape fails loudly here rather
 * than quietly reducing every assertion below to a loop over an empty list.
 */
const installs = captureAll(
  installScript,
  /^place (\S+ +"\$\w+\/[^"]+" +\d+)$/gm,
  'the place lines in deploy/install.sh',
).map((line) => {
  const [src = '', quoted = '', mode = ''] = line.split(/\s+/)

  return {
    src,
    mode,
    dest: quoted.slice(1, -1).replace(/^\$(\w+)/, (_, name: string) => {
      const directory = installDirs.get(name)
      if (directory === undefined) throw new Error(`install.sh installs into $${name}, unset`)
      return directory
    }),
  }
})

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

/**
 * The two lines the bot posts to BLITZ_LOG_CHANNEL_ID, WHOLE.
 *
 * THESE USED TO BE THE FIRST FEW WORDS AND NOTHING ELSE. `capture` took the
 * literal prefix off each template — `Removed a message. ` and `Dry run,
 * nothing removed. ` — and every assertion below asked deploy.md to contain
 * that much. Then `authorRef` changed how the author is named, from a bare
 * snowflake to a mention plus the username in a code span; both quoted examples
 * in §8 and §9 went stale; and both assertions stayed green, because a prefix
 * cannot see a changed tail and the tail is the whole content of the line. That
 * is the THIRD time this document has drifted from the code, and the second
 * time a check that looked like it covered the case did not.
 *
 * SO THE WHOLE LINE IS REBUILT HERE, out of the same five builders, and the
 * document has to quote the result character for character. Any change to any
 * part of it lands here: the mention markup, the parenthetical username and its
 * code span, the channel link, the reason token, the codes, and every comma and
 * space between them.
 *
 * BY READING THE SOURCE RATHER THAN CALLING THE BUILDERS, because `removedLine`,
 * `dryRunLine`, `attribution`, `authorRef` and `statedGrounds` are all private
 * to src/client.ts and none of them should be exported to satisfy a test — the
 * one function in that family that IS exported, `announcer`, is exported for a
 * promise a test cannot otherwise see. So each builder's `return` expression is
 * read out of the file and its template literals are expanded against the
 * placeholder ids this document uses. Same bargain as the log lines above: the
 * string is derived from the thing that emits it, never typed out twice.
 */

/**
 * The placeholder values deploy.md fills these lines with.
 *
 * ONE SET, SHARED BY THE CHANNEL LINE AND THE JOURNAL LINE, because §8 shows
 * both about the same removal and an operator reads them as a pair. Eighteen
 * zeros for a snowflake and `XXXXXXX` for an invite code are the document's own
 * convention. The username is a placeholder in the same spirit and reads as the
 * operator's own, because in §8 and §9 the message being removed is one he
 * posted himself — and it is spelled with characters Discord's username charset
 * actually allows, so it is not an example of a name that cannot exist.
 */
const AUTHOR_ID = '000000000000000000'
const CHANNEL_ID = '000000000000000000'
const INVITE_CODE = 'XXXXXXX'
const USERNAME = 'your_username'

/**
 * The reason token a confirmed-foreign removal carries.
 *
 * ANCHORED ON THE BRANCH THAT PRODUCES IT rather than typed out, so renaming the
 * token changes the value the document must contain instead of leaving
 * `foreign-invite` correct in this file and wrong on the operator's screen. It
 * is the same token the channel line prints and the journal puts in `reason=`,
 * which is the whole reason the two can be matched up with one `grep`.
 */
const FOREIGN_INVITE = capture(
  clientSource,
  /result\.foreign\.length > 0\) return removal\('([^']+)'/,
  'the reason a confirmed-foreign removal carries in src/client.ts',
)

/**
 * The `return` expression of one private builder, as source text.
 *
 * ANCHORED ON `function <name>(` AND ON THE CLOSING BRACE AT COLUMN 0, so a
 * builder that is renamed, inlined or reshaped into something with more than
 * one `return` throws by way of `capture` instead of quietly matching less.
 * Starting at the `return` also steps over the doc comment and any body comment
 * above it, which is what keeps a backtick in prose from being mistaken for the
 * start of a template.
 */
const returnExpression = (name: string): string =>
  capture(
    clientSource,
    new RegExp(`^function ${name}\\([\\s\\S]*?\\n {2}return ([\\s\\S]*?)\\n\\}`, 'm'),
    `the return expression of ${name}() in src/client.ts`,
  )

/** Every template literal in one expression, `\`` escapes and all. */
const templateLiterals = (expression: string, what: string): string[] =>
  captureAll(expression, /`((?:[^`\\]|\\.)*)`/g, `a template literal in ${what}`)

/** The one template a single-expression builder returns, or a loud failure. */
function onlyTemplate(name: string): string {
  const found = templateLiterals(returnExpression(name), `${name}()`)
  const [single] = found

  if (single === undefined || found.length !== 1) {
    throw new Error(`${name}() no longer returns exactly one template literal`)
  }
  return single
}

/**
 * One branch of a builder that returns a ternary, chosen by something in it.
 *
 * `authorRef` and `statedGrounds` each have two shapes and the document quotes
 * one of each: the author WITH a username on him, and the grounds for a removal
 * that confirmed a foreign invite. Selecting by a marker rather than by position
 * means swapping the branches over does not silently change which line the
 * document is being held to.
 */
function branchTemplate(name: string, marker: string): string {
  const found = templateLiterals(returnExpression(name), `${name}()`).filter((template) =>
    template.includes(marker),
  )
  const [single] = found

  if (single === undefined || found.length !== 1) {
    throw new Error(`${name}() no longer has exactly one branch containing ${marker}`)
  }
  return single
}

/**
 * One template literal, filled in the way the running bot fills it.
 *
 * AN UNKNOWN `${...}` IS A FAILURE, NOT AN EMPTY STRING. A builder that starts
 * interpolating something new — a guild id, a timestamp, a message link — must
 * be given a placeholder here and shown in the document, and the alternative is
 * a pin that quietly drops the new part and keeps passing.
 *
 * `\`` BECOMES A BACKTICK because that is what it is by the time the line
 * reaches Discord: the code span `authorRef` wraps the username in, which is the
 * thing that stops a hostile username reformatting our moderation log.
 */
function expand(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\\`/gu, '`').replace(/\$\{([^}]*)\}/gu, (_match, expression: string) => {
    const value = values[expression.trim()]
    if (value === undefined) {
      throw new Error(`no placeholder for \${${expression}} in a channel-line template`)
    }
    return value
  })
}

const CHANNEL_AUTHOR = expand(branchTemplate('authorRef', '${name}'), {
  'message.authorId': AUTHOR_ID,
  name: USERNAME,
})

const CHANNEL_ATTRIBUTION = expand(onlyTemplate('attribution'), {
  'authorRef(message)': CHANNEL_AUTHOR,
  'message.channelId': CHANNEL_ID,
})

const CHANNEL_GROUNDS = expand(branchTemplate('statedGrounds', 'verdict.foreign'), {
  'verdict.why': FOREIGN_INVITE,
  "verdict.foreign.join(', ')": INVITE_CODE,
})

const CHANNEL_HALVES = {
  'attribution(message)': CHANNEL_ATTRIBUTION,
  'statedGrounds(verdict)': CHANNEL_GROUNDS,
}

const CHANNEL_REMOVED = expand(onlyTemplate('removedLine'), CHANNEL_HALVES)
const CHANNEL_DRY_RUN = expand(onlyTemplate('dryRunLine'), CHANNEL_HALVES)

/**
 * The fields a verdict-carrying journal line puts after `msg=`, in order.
 *
 * THE SAME WEAKNESS AS THE CHANNEL LINE, ONE COLUMN OVER. §8, §9 and §12.2 each
 * quote a full journal record — `author=`, `channel=`, `reason=`, `found=`,
 * `codes=` — and until now only the `msg="..."` part of each was derived from
 * the source. Rename a field in `logFields`, add one, or reorder `where`, and
 * all three quoted records go stale while every assertion about them stays
 * green, which is precisely how the channel line drifted.
 *
 * READ FROM BOTH HALVES OF THE SPREAD, in the order `handleMessage` spreads
 * them, because the order is part of what an operator compares against his
 * screen.
 */
const VERDICT_FIELDS = [
  ...captureAll(
    capture(clientSource, /const where = \{([^}]*)\}/, 'the `where` fields in handleMessage'),
    /(\w+):/g,
    'a field name in `where`',
  ),
  ...captureAll(
    capture(
      clientSource,
      /function logFields[\s\S]*?return \{([^}]*)\}/,
      "logFields' fields in src/client.ts",
    ),
    /(\w+):/g,
    'a field name in logFields',
  ),
]

/**
 * What each of those fields holds in the document's worked example: the same
 * placeholder ids the channel line uses, and one invite code, because §8 says
 * to post exactly one link.
 */
const VERDICT_VALUES: Readonly<Record<string, unknown>> = {
  author: AUTHOR_ID,
  channel: CHANNEL_ID,
  reason: FOREIGN_INVITE,
  found: 1,
  codes: INVITE_CODE,
}

/** The fields of one quoted removal record, plus anything the call site adds. */
function verdictFields(extra?: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}

  for (const key of VERDICT_FIELDS) {
    // A new field with no placeholder is a decision about what the document
    // shows, not something to fill in with a blank and forget.
    if (!(key in VERDICT_VALUES)) {
      throw new Error(`no placeholder for the ${key}= field of a removal line`)
    }
    fields[key] = VERDICT_VALUES[key]
  }

  return { ...fields, ...extra }
}

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

/**
 * One whole quoted record, from `level=` to the end — everything but the
 * timestamp, which is the only part of a real line the document cannot predict.
 *
 * THE POINT IS THE TAIL. `field(..., 'msg')` proves the sentence is the one the
 * code writes and says nothing at all about the five `key=value` pairs after it,
 * which are the half an operator reads to find out WHICH channel to go and fix.
 */
function journalRecord(level: Level, message: string, fields?: Record<string, unknown>): string {
  const line = emit(level, message, fields)
  return line.slice(line.indexOf('level=')).trimEnd()
}

/**
 * The sink: a second copy of every fault, for somebody who is not on the box.
 *
 * THE PROPERTY THESE PROTECT IS THAT THE JOURNAL DOES NOT DEPEND ON DISCORD.
 * `log()` is synchronous, is called from error handlers and `finally` blocks,
 * and now also hands warnings and errors to something that makes a network
 * request. Every case below is one of the ways that arrangement takes a live
 * bot down: a sink that logs, a sink that rejects, a sink that throws where the
 * caller cannot catch it. The line in the journal has to survive all three.
 *
 * NOTHING HERE POSTS ANYTHING. The sink is a function; what the real one does
 * with Discord is `statusReporter`, in client.test.ts.
 */

/** What a sink was handed, in order. */
interface Handed {
  level: string
  msg: string
  line: string
}

function recorder(): { sink: Sink; calls: Handed[] } {
  const calls: Handed[] = []

  return {
    calls,
    sink: (level, msg, line) => {
      calls.push({ level, msg, line })
      return Promise.resolve()
    },
  }
}

/**
 * The one call a case expects, or a loud failure.
 *
 * `noUncheckedIndexedAccess` again: `calls[0]` is possibly undefined, and
 * "the sink was never called" is a better failure than a property read on
 * undefined three lines further down.
 */
function only(calls: Handed[]): Handed {
  if (calls.length !== 1) throw new Error(`expected one sink call, got ${calls.length}`)
  const first = calls[0]
  if (first === undefined) throw new Error('expected one sink call, got a hole')
  return first
}

/**
 * Let everything that was going to happen, happen.
 *
 * A MACROTASK RATHER THAN `await Promise.resolve()`. Node reports an unhandled
 * rejection after the microtask queue drains, so a case that asserts one did
 * NOT happen has to get past that point before the assertion means anything.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the sink — which lines are copied, and what the copy is', () => {
  it('hands a warning over', () => {
    const { sink, calls } = recorder()
    setSink(sink)

    log('warn', 'gateway disconnected', { shard: 0, code: 4014 })

    expect(only(calls).level).toBe('warn')
    expect(only(calls).msg).toBe('gateway disconnected')
  })

  it('hands an error over', () => {
    const { sink, calls } = recorder()
    setSink(sink)

    log('error', 'delete failed, message left standing')

    expect(only(calls).level).toBe('error')
    expect(only(calls).msg).toBe('delete failed, message left standing')
  })

  /**
   * THE ONE THAT DECIDES WHETHER THE CHANNEL IS WORTH READING. `ready`, and a
   * line per deleted message, are info — and a status channel carrying those is
   * a running commentary that an admin learns to scroll past, which is the same
   * as not having it.
   */
  it('never hands over an info', () => {
    const { sink, calls } = recorder()
    setSink(sink)

    log('info', 'ready', { guild: 'Blitz Royale' })

    expect(calls).toEqual([])
    expect(stdout).toHaveLength(1)
  })

  /**
   * THE COPY IS THE JOURNAL LINE, WITHOUT THE PRIORITY PREFIX. journald eats
   * `<4>`; anywhere else it is four characters of noise at the front of every
   * line. The rest is identical on purpose, so a line pasted out of Discord is
   * the string an operator would have grepped for.
   */
  it('gives the sink the journal line, minus the prefix journald eats', () => {
    const { sink, calls } = recorder()
    setSink(sink)

    log('warn', 'invite lookup failed', { code: 'abc123' })

    const journal = written(stderr)
    expect(only(calls).line).toBe(journal.slice('<4>'.length, -1))
    expect(only(calls).line).not.toContain('\n')
    expect(only(calls).line).toContain('msg="invite lookup failed"')
  })

  it('writes the journal line first, and writes it whether or not a sink is there', () => {
    setSink(() => {
      // The line is already on stderr by the time the sink can look. The
      // journal is the floor: nothing here is allowed to decide whether it was
      // written.
      expect(stderr).toHaveLength(1)
      return Promise.resolve()
    })

    log('error', 'client error')

    expect(written(stderr)).toContain('msg="client error"')
  })

  it('stops handing anything over once the sink is removed', () => {
    const { sink, calls } = recorder()
    setSink(sink)
    log('error', 'first')

    setSink(null)
    log('error', 'second')

    expect(calls.map((call) => call.msg)).toEqual(['first'])
    expect(stderr).toHaveLength(2)
  })
})

/**
 * The fault loop, which is the one that takes the bot down.
 *
 * THE SHAPE OF IT: the sink posts to Discord, the post fails, the failed post is
 * itself a fault, the fault is logged, the log calls the sink. Nothing about
 * that is exotic — it is what happens the first time the channel's permissions
 * are wrong — and it recurses until the process dies, at the exact moment the
 * bot was trying to say something was wrong.
 *
 * BOTH TIMINGS ARE TESTED SEPARATELY AND ON PURPOSE. A boolean flag raised
 * around the call and dropped after it passes the first of these two and fails
 * the second, because the sink is async and its own failure is handled several
 * ticks later. The second case is the one that says the guard follows the
 * awaits.
 */
describe('the sink — a failure inside the reporting cannot become a loop', () => {
  it('does not re-enter the sink when the sink logs while it is running', async () => {
    const seen: string[] = []

    setSink((_level, msg) => {
      seen.push(msg)
      log('error', 'status channel unusable, nothing more will be posted to it')
      return Promise.reject(new Error('send failed'))
    })

    log('error', 'delete failed, message left standing')
    await settle()

    expect(seen).toEqual(['delete failed, message left standing'])
  })

  it('does not re-enter the sink when the sink logs several ticks later', async () => {
    const seen: string[] = []

    setSink(async (_level, msg) => {
      seen.push(msg)
      await Promise.resolve()
      await Promise.resolve()
      log('error', 'status channel unusable, nothing more will be posted to it')
      throw new Error('send failed')
    })

    log('error', 'delete failed, message left standing')
    await settle()

    expect(seen).toEqual(['delete failed, message left standing'])
  })

  /**
   * THE SUPPRESSION IS OF THE COPY, NOT OF THE FAULT. `statusReporter` reports
   * its own failures through `log()` and depends on this: the reason the
   * channel went quiet has to be somewhere, and the journal is where.
   */
  it('still writes the journal line for a log call made from inside the sink', async () => {
    setSink(() => {
      log('error', 'status channel unusable, nothing more will be posted to it')
      return Promise.resolve()
    })

    log('warn', 'gateway disconnected')
    await settle()

    expect(stderr).toHaveLength(2)
    expect(stderr.join('')).toContain('msg="gateway disconnected"')
    expect(stderr.join('')).toContain('msg="status channel unusable')
  })

  /**
   * `log()` IS SYNCHRONOUS AND HAS NO CALLER THAT COULD AWAIT IT, so a sink
   * that rejects is an unhandled rejection — which index.ts logs, which is a
   * fault, which reaches the sink, which is the loop again by a longer route.
   * Since Node 15 the default for one nobody handles is to kill the process.
   */
  it('does not let a rejecting sink become an unhandled rejection', async () => {
    const rejections: unknown[] = []
    const listener = (reason: unknown): void => {
      rejections.push(reason)
    }

    process.on('unhandledRejection', listener)

    try {
      setSink(() => Promise.reject(new Error('discord is down')))
      log('error', 'delete failed, message left standing')
      await settle()
    } finally {
      process.off('unhandledRejection', listener)
    }

    expect(rejections).toEqual([])
    expect(written(stderr)).toContain('msg="delete failed, message left standing"')
  })

  /**
   * A sink is allowed to be written badly. It is not allowed to make `log()`
   * throw: half the call sites in the bot are inside a `catch`, and an
   * exception raised from one of those is thrown away from the thing that had
   * already gone wrong.
   */
  it('does not let a sink that throws synchronously reach the caller', () => {
    setSink(() => {
      throw new Error('sink is broken')
    })

    expect(() => {
      log('error', 'login failed')
    }).not.toThrow()

    expect(written(stderr)).toContain('msg="login failed"')
  })
})

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
   *
   * WHOLE LINES, NOT OPENINGS. The tail is where the author, the channel, the
   * reason and the codes are; an assertion that stops after `Removed a message. `
   * is an assertion about the one part of the line nobody has to look up.
   */
  it('quotes both channel lines the bot posts to BLITZ_LOG_CHANNEL_ID, whole', () => {
    expect(deployDoc).toContain(CHANNEL_DRY_RUN)
    expect(deployDoc).toContain(CHANNEL_REMOVED)
  })

  /**
   * EVERY COPY, NOT THE TWO WE KNOW ABOUT. The two examples were corrected by
   * hand once already and a third description of the same line elsewhere in the
   * file would have been missed — §12 and §14 both discuss what the channel
   * shows. So: find every line in the document that names an author the way the
   * channel line does, and require all of them to carry the current shape.
   *
   * The journal's own `author="..."` field is untouched by this and is meant to
   * be: it is a bare id there, deliberately, and `Author ` with a capital A and
   * a space is the channel line's spelling and nothing else's.
   */
  it('describes the author the same way everywhere the channel line appears', () => {
    // The literal text the attribution opens with, taken from the template
    // ahead of its first `${`, so it is the word the OLD shape and the new one
    // have in common rather than anything about how the author is spelled now.
    const opening = capture(
      onlyTemplate('attribution'),
      /^([^$`]+)\$\{/,
      "the literal opening of attribution() in src/client.ts",
    )

    const attributed = deployDoc.split('\n').filter((line) => line.includes(opening))

    expect(attributed).not.toHaveLength(0)
    for (const line of attributed) expect(line, line).toContain(CHANNEL_ATTRIBUTION)
  })

  /**
   * THE SAME PIN, ON THE JOURNAL SIDE. Three records in this document carry a
   * verdict's fields — §8's dry run, §9's removal and §12.2's failed delete —
   * and each was previously held only to its `msg="..."`. `author=` and
   * `channel=` are the two an operator acts on, and §12.2 says in so many words
   * to go and fix the channel named on the line.
   */
  it('quotes every field on the three journal records a removal writes', () => {
    expect(deployDoc).toContain(journalRecord('warn', WOULD_DELETE, verdictFields()))
    expect(deployDoc).toContain(journalRecord('info', DELETED, verdictFields()))

    const code = RESTJSONErrorCodes.MissingPermissions
    const error = new DiscordAPIError({ code, message: 'Missing Permissions' }, code, 403, 'DELETE', 'https://discord.com/api/v10/channels/0/messages/0', {})

    expect(deployDoc).toContain(journalRecord('error', DELETE_FAILED, verdictFields({ error })))
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
   * THE BLOCKER, AND IT WAS INVISIBLE BECAUSE IT DID NOT FAIL. §1 installs git,
   * curl, ca-certificates and xz-utils and never names npm; §2 keeps
   * `/opt/node24/bin` off `PATH` on purpose. So a bare `npm ci` in §3 or §16
   * does not error — it resolves to the CONSOLE'S npm, on `/usr/bin/node`
   * v22.23.2, the one runtime the first page of this document promises the bot
   * never touches. It installs something, and nobody has a reason to look.
   *
   * AND AN ABSOLUTE PATH TO `npm` DOES NOT FIX THAT, WHICH IS THE CLAIM THIS
   * TEST REPLACES. The version of this file that came before it asserted
   * `/opt/node24/bin/npm ci` was present and called the absolute path the
   * load-bearing part. The owner disproved it on the box:
   *
   *     head -1 $(readlink -f /opt/node24/bin/npm)  ->  #!/usr/bin/env node
   *     /opt/node24/bin/npm exec -- node -v         ->  v22.23.2
   *
   * `bin/npm` is a symlink to `npm-cli.js`, a SCRIPT, and a script is run by
   * whatever its shebang resolves to. `#!/usr/bin/env node` searches `PATH`,
   * and `PATH` has no `/opt/node24/bin` on it. Where the script sits changes
   * nothing at all. Every install this runbook has ever produced ran on Node 22.
   *
   * SO THE RULE IS ABOUT THE BINARY, AND THE TEST IS TOO: every npm in the
   * document must be npm's CLI script handed to `/opt/node24/bin/node`, which
   * is an ELF executable nothing resolves through `PATH`. A bare `npm`, a
   * `/opt/node24/bin/npm`, a `node_modules/.bin/npm` — anything added later
   * that a shell would run through a shebang — fails on the first assertion,
   * because the only token this accepts is the one absolute `npm-cli.js` path.
   *
   * COMMENT LINES ARE SKIPPED, and that is not a loophole: the retraction has
   * to be able to name the wrong form in order to withdraw it, and it does so
   * in the script's comments and in the prose the last assertions here pin.
   */
  it('runs every npm through the node binary, never through a shebang', () => {
    // The runtime, taken from the unit that has to be right about it rather
    // than typed out a second time here. It comes from deploy/blitz-bot.service
    // now instead of from the heredoc that unit used to be pasted out of; the
    // value and the argument for it are unchanged.
    const node = capture(
      botUnit,
      /^ExecStart=(\S+) --disable-warning/m,
      "the bot unit's node binary",
    )
    const prefix = capture(node, /^(.*)\/bin\/node$/, "the node install's prefix")

    // The layout of the official linux-x64 tarball §2 unpacks with
    // --strip-components=1: bin/npm is a relative symlink to this path, which
    // is also what `readlink -f` printed on the box.
    const cli = `${prefix}/lib/node_modules/npm/bin/npm-cli.js`

    /**
     * Anything a shell would run as npm: a bare `npm`, any path ending in
     * `/npm`, and npm's own CLI script. Bounded on both sides so that
     * `npm_config_cache=` — an environment variable the update script exports —
     * is not mistaken for a command.
     */
    const NPM = /(?:^|[\s;&|`"'(])((?:[^\s;&|`"'()]*\/)?npm(?:-cli\.js)?)(?=[\s;&|`"')]|$)/g

    /**
     * EVERY PLACE AN `npm` CAN BE RUN, WHICH IS NO LONGER ONLY THE DOCUMENT.
     * The update's own `npm ci` used to sit in a heredoc in deploy.md and was
     * scanned along with everything else in a ```bash fence. It is
     * deploy/blitz-bot-update now, so the two shell scripts are read as well —
     * without them this check would quietly stop covering the one invocation
     * that runs unattended, four times an hour, on the box.
     */
    const lines = [
      ...captureAll(deployDoc, /^```bash\n([\s\S]*?)^```/gm, 'a bash block in deploy.md'),
      updateScript,
      installScript,
    ]
      .flatMap((block) => block.split('\n'))
      .filter((line) => !/^\s*#/.test(line))

    let invocations = 0

    for (const line of lines) {
      for (const match of line.matchAll(NPM)) {
        const token = match[1] ?? ''
        invocations += 1

        // Nothing but the CLI script, by absolute path.
        expect(token, line).toBe(cli)

        // And the word in front of it is the binary. `timeout 300` and
        // `cd … &&` are allowed to be further left; nothing is allowed
        // between the runtime and the script it runs.
        const at = line.indexOf(token, match.index)
        expect(line.slice(0, at).trimEnd().split(/\s+/).at(-1), line).toBe(node)
      }
    }

    // The guard against this check quietly checking nothing: every place the
    // document installs still installs.
    expect(invocations).toBeGreaterThanOrEqual(4)

    // The three places that install, named individually so that losing one of
    // them is a failure rather than a count that is still four because
    // something else grew a second `npm ci`.
    for (const [what, source] of [
      ['the first install', section(deployDoc, /^## \d+\. The code/m)],
      ['the update script', updateScript],
      ['deploying by hand', section(deployDoc, /^## \d+\. Deploying an update/m)],
    ] as const) {
      expect(source, what).toContain(cli)
    }
  })

  /**
   * THE WITHDRAWAL, WHICH IS NOT THE SAME AS THE EDIT. The absolute-npm claim
   * was argued for in §2, in §3 at length and again in §16, and a reader who
   * remembers being told it needs to find it retracted rather than to find it
   * silently absent and wonder which of the two documents was right.
   */
  it('retracts the absolute-path-to-npm claim rather than quietly dropping it', () => {
    const code = section(deployDoc, /^## \d+\. The code/m).replace(/\s+/g, ' ')
    const update = section(deployDoc, /^## \d+\. Deploying an update/m).replace(/\s+/g, ' ')

    // The sentences the old design was carried in. Gone, both of them.
    expect(deployDoc).not.toMatch(/The absolute path to `npm` is the load-bearing part/)
    expect(deployDoc).not.toMatch(/`npm` is spelled out in full/)

    /**
     * §2 IS WHERE THE RULE IS STATED FIRST, AND IT STATED THE WRONG ONE. It is
     * the section that keeps `/opt/node24/bin` off `PATH`, so it is also the
     * section that has to say what naming a path does and does not buy.
     */
    const path = section(deployDoc, /^## \d+\. Node/m).replace(/\s+/g, ' ')

    expect(path).toMatch(/names \*\*the `node` binary itself\*\* by absolute path/)
    expect(path).toMatch(/Naming `npm` by absolute path does not do that/)

    // Said, in the section that argued hardest for it, with the mechanism and
    // not just a change of mind.
    expect(code).toMatch(/this document used to say that it was/i)
    expect(code).toMatch(/That claim is withdrawn/i)
    expect(code).toContain('#!/usr/bin/env node')
    expect(code).toMatch(/env` searches `PATH`/)

    // And where the operator deploys by hand, which is the other place it was
    // asserted and the place he is standing when it matters.
    expect(update).toMatch(/used to say that path was enough, and it was wrong/i)

    /**
     * NO PARAGRAPH MAY NAME THE WRONG FORM WITHOUT SAYING WHY IT IS WRONG.
     * `/opt/node24/bin/npm` is still all over §3, because the proof and the
     * retraction are about it — but a future paragraph that mentions it as the
     * thing to run has nothing in it that reads as a withdrawal.
     */
    for (const paragraph of paragraphs(deployDoc)) {
      if (!paragraph.includes('/opt/node24/bin/npm')) continue
      expect(paragraph, paragraph).toMatch(
        /shebang|env node|used to|Earlier versions|withdraw|was wrong|not enough/i,
      )
    }

    /**
     * And the PATH argument survives the retraction, because it is a separate
     * point and still true: a `PATH` entry is the fix somebody reaches for
     * first, and it would change which `node` the OPERATOR'S shell finds — the
     * shell the console is maintained from.
     */
    expect(code).toMatch(/is deliberately off everyone/)
    expect(code).toMatch(/A `PATH` entry is the other fix, and it is the wrong one/)
    expect(code).toMatch(/shell finds, and the console/)
  })

  /**
   * PROOF RATHER THAN ASSERTION, AND AN HONEST ONE. Nothing under
   * `node_modules` records which npm wrote it, so there is no after-the-fact
   * check on the command. What can be checked is the tree: load it with the
   * runtime the unit will use and read back what that runtime says it is.
   * `vitest --version` prints the Node version and the architecture on one
   * line, which answers §2's question and §3's at the same time.
   *
   * THIS STEP WAS ALREADY WRITTEN THE RIGHT WAY, AND IT IS THE PATTERN THE
   * INSTALL ABOVE IT HAS NOW BEEN FIXED INTO. `node_modules/.bin/vitest` is a
   * `#!/usr/bin/env node` script exactly as npm's CLI is, so run on its own it
   * would answer for whatever `node` is on `PATH` — and the whole value of its
   * output is that `node-v24…` is evidence. It is only evidence because
   * `/opt/node24/bin/node` comes first and the script is its argument.
   */
  it('proves after the install that the bot runtime can run what was installed', () => {
    const code = section(deployDoc, /^## \d+\. The code/m)
    const major = capture(repoFile('package.json'), /"node": ">=(\d+)"/, 'engines.node')

    expect(code).toMatch(/\/opt\/node24\/bin\/node \/opt\/blitz-bot\/node_modules\/\.bin\//)

    // The expected output has to name the runtime, or there is nothing in it
    // worth reading: a bare version number would look identical on Node 22.
    expect(code).toContain(`node-v${major}.`)

    expect(code.indexOf('npm-cli.js ci')).toBeLessThan(
      code.indexOf('/opt/node24/bin/node /opt/blitz-bot/node_modules/.bin/'),
    )

    // And why that shape is the shape, said where the next person copies it.
    expect(code.replace(/\s+/g, ' ')).toMatch(/is a shebang script too/i)
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

    // In the unit, which is deploy/blitz-bot.service rather than a heredoc in
    // §6.4 — the file that gets installed, not a copy of it in a document.
    expect(botUnit).toContain(
      `ExecStart=/opt/node24/bin/node ${warning} /opt/blitz-bot/src/index.ts`,
    )

    // Neither the unit nor the runbook may put the bot on the console's Node,
    // and neither may propose moving the console.
    expect(botUnit).not.toMatch(/ExecStart=\/usr\/bin\/node/)
    expect(deployDoc).not.toMatch(/ExecStart=\/usr\/bin\/node/)
    expect(deployDoc).not.toMatch(/nodesource/i)
    expect(deployDoc).not.toMatch(/systemctl restart ringmaster/)
  })

  /**
   * INSTALLED FROM A FILE, AND CHECKED BEFORE ANYTHING IS ENABLED.
   *
   * This used to assert that §6 wrote the unit in one `sudo tee` block rather
   * than telling anybody to open an editor, because a fifty-line paste into
   * `nano` is where a stray character gets in. There is no paste left: the unit
   * is deploy/blitz-bot.service and deploy/install.sh copies it. What survives
   * of that argument is the half that still bites — nothing sends the operator
   * to edit a unit in place under /etc, and the check happens before a single
   * `systemctl enable`, because a typo in an enabled unit is a boot-time
   * failure on a box nobody is watching.
   */
  it('installs the units from files and checks them before enabling them', () => {
    const unit = section(deployDoc, /^## \d+\. The unit/m)

    expect(unit).not.toMatch(/nano \/etc\/systemd/)

    /**
     * NO HEREDOC MAY PUT ANY OF THE FOUR BACK INTO THE DOCUMENT. A unit quoted
     * in the runbook beside the unit in deploy/ is two units, and the one that
     * gets edited is whichever the next person happened to be reading. Three
     * drifts in this project have started exactly there.
     */
    for (const file of installs) {
      expect(deployDoc, file.dest).not.toContain(`sudo tee ${file.dest}`)
    }

    /**
     * The check is in the installer, over what it just wrote, and it is reached
     * before the runbook enables anything.
     *
     * ON THE CALL AND NOT ON THE STRING. `toContain('systemd-analyze verify')`
     * was the first version of this and a mutation pass walked straight through
     * it: install.sh names the command in a comment two paragraphs above, so
     * replacing the actual invocation with `true` left the string in the file
     * and the assertion green. The arguments are captured instead, which cannot
     * be satisfied by prose.
     */
    const analyze = capture(
      installScript,
      /^systemd-analyze verify((?: *\\\n *"[^"]+")+)/m,
      'the systemd-analyze call in deploy/install.sh',
    )

    // Handed the installed paths rather than the repo copies, so the check
    // covers the copy itself and the ExecStart targets that only exist there.
    for (const file of installs.filter((each) => /\.(service|timer)$/.test(each.src))) {
      expect(analyze, file.dest).toContain(`"$SYSTEMD/${file.src}"`)
    }

    expect(installScript.indexOf('systemd-analyze verify \\')).toBeLessThan(
      installScript.indexOf('systemctl daemon-reload'),
    )
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

/**
 * The bot no longer updates itself, a timer does, and every part of that is a
 * fact about five files on a box nobody looks at.
 *
 * FOUR OF THE FIVE ARE IN THE REPOSITORY NOW, in deploy/, and this block used
 * to read them out of heredocs in docs/deploy.md instead. Nothing about what is
 * asserted changed with them; what changed is that the thing asserted on is the
 * file that gets installed rather than a copy of it inside a fenced block. The
 * fifth, the sudoers drop-in, is still written by hand in §6.3 and is still
 * read out of its heredoc below.
 *
 * A PUSH STILL DEPLOYS NONE OF THEM. `deploy/install.sh` copies them, by hand,
 * and an update brings a new one only as far as /opt/blitz-bot/deploy/ — so an
 * edit that drops a line from one of them still changes what the next box does.
 * What is different is that the edit is now a diff over a shell script and
 * three unit files, which CI parses, rather than a diff over a document.
 *
 * THE LAST ROUND'S DESIGN WAS REJECTED, AND THESE TESTS ARE MOSTLY HERE TO
 * KEEP IT REJECTED. An `ExecStartPre` on the bot's own unit meant three things
 * that are not fixable inside it: `npm ci` deletes node_modules before it
 * installs, so a failed install left no dependencies on a box restarting into
 * them every five seconds; `reset --hard` in a crash loop destroyed the
 * last-known-good tree with nothing referencing it; and `Restart=always` made
 * every crash a deploy. Each of those is one line away from coming back —
 * an `ExecStartPre=` re-added "so a restart picks up the fix", a
 * `ReadWritePaths=` re-added "because the update needs it", a restart moved
 * above the install "so the bot comes back sooner". So the assertions below are
 * about absence at least as much as presence.
 *
 * FIVE VALUES ARE LOAD-BEARING IN A WAY THAT LOOKS COSMETIC:
 *
 *   - the absence of ExecStartPre on blitz-bot.service. Add one line and every
 *     crash is a deploy again, and nothing about the unit looks different.
 *   - ProtectSystem=strict with no ReadWritePaths on that same unit. The bot
 *     writes nothing; the moment it can write /opt/blitz-bot it can rewrite its
 *     own source and its own token file.
 *   - Persistent=true, which has an effect only on an OnCalendar= timer.
 *     Rewrite the schedule as OnUnitActiveSec= and the line is accepted and
 *     silently does nothing, so a box that was off never catches up.
 *   - the order of the install and the restart. Swap them and a failed install
 *     is a restart into a tree with no dependencies — the exact outage this
 *     design exists to remove.
 *   - the commit comparison in front of the restart. Delete it and the bot
 *     drops its gateway connection four times an hour to arrive at the commit
 *     it was already on.
 *
 * SO THE TESTS READ THE FILES AND ASSERT ON DIRECTIVES, and where a value
 * appears in two places — the script's path, the off switch, the sudo grant,
 * the commit file, the line number in .gitignore — one side is derived from the
 * other rather than typed out twice, for the reason the rest of this file
 * gives.
 */
describe('deploy/ — the timer that updates, and the unit that no longer does', () => {
  const UNITS = /^## \d+\. The units/m
  const UPDATE = /^## \d+\. Deploying an update/m
  const RESTART_LOOP = /^## \d+\. When it will not start/m

  const flat = (text: string): string => text.replace(/\s+/g, ' ')

  /**
   * The one heredoc left in the runbook, exactly as the thing that reads it
   * will. §6.3 stages the sudoers drop-in in /tmp and checks it with `visudo
   * -c` before it goes anywhere near /etc/sudoers.d, because a file there that
   * does not parse stops `sudo` working at all — so it stays a deliberate
   * by-hand sequence rather than a fifth line in install.sh.
   */
  const heredoc = (path: string): string =>
    capture(
      deployDoc,
      new RegExp(`sudo tee ${path.replace(/[/.]/g, '\\$&')} > /dev/null <<'EOF'\\n([\\s\\S]*?)\\nEOF`),
      `the ${path} heredoc in deploy.md`,
    )

  const sudoers = heredoc('/tmp/blitz-bot-update.sudoers')

  /** A unit's settings, with its prose and its section headers dropped. */
  const directivesOf = (unit: string): string[] =>
    unit
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('['))

  /** A unit's comments, which is where the reasons have to be. */
  const commentsOf = (unit: string): string =>
    unit
      .split('\n')
      .filter((line) => line.trim().startsWith('#'))
      .join('\n')

  const botDirectives = directivesOf(botUnit)
  const updateDirectives = directivesOf(updateUnit)
  const timerDirectives = directivesOf(timerUnit)

  const setting = (unit: string, name: string, what: string): string =>
    capture(unit, new RegExp(`^${name}=(.*)$`, 'm'), what)

  const positionOf = (haystack: string, needle: RegExp | string, what: string): number => {
    const index = typeof needle === 'string' ? haystack.indexOf(needle) : haystack.search(needle)
    if (index === -1) throw new Error(`${what} is not in the update script`)
    return index
  }

  /** Where the restart lives in the script, derived from the sudo grant it needs. */
  const grantedCommand = capture(
    sudoers,
    /^ubuntu ALL=\(root\) NOPASSWD: (.+)$/m,
    'the command the sudoers drop-in grants',
  )

  /**
   * THE FEATURE THAT WAS REJECTED, PINNED AS AN ABSENCE. `ExecStartPre=` is one
   * line, it reads as an improvement — "so a restart picks up the fix" — and it
   * reintroduces every failure the review rejected: a crash becomes a deploy, a
   * failed `npm ci` leaves no dependencies on a box restarting into them, and a
   * `reset --hard` runs inside a crash loop.
   *
   * THE ABSENCE IS ASSERTED ON THE PARSED DIRECTIVES, not on the text, because
   * the unit's own comments name `ExecStartPre` in order to say it was removed.
   * A test that searched the whole heredoc would fail on the explanation.
   */
  it('never runs the update as part of starting the bot', () => {
    for (const directive of botDirectives) {
      expect(directive, directive).not.toMatch(/^ExecStartPre=/)
      expect(directive, directive).not.toMatch(/^ExecStartPost=/)
      expect(directive, directive).not.toContain('blitz-bot-update')
    }

    // ExecStart is the bot and nothing but the bot: no `sh -c` smuggling the
    // update back in ahead of node.
    expect(setting(botUnit, 'ExecStart', "the bot's ExecStart")).toBe(
      '/opt/node24/bin/node --disable-warning=ExperimentalWarning /opt/blitz-bot/src/index.ts',
    )

    // And the removal is explained where somebody about to undo it will read
    // it: in the unit, from /etc/systemd/system, with no commit message.
    expect(commentsOf(botUnit)).toContain('ExecStartPre')
    expect(flat(commentsOf(botUnit))).toMatch(/reviewed and rejected/i)
  })

  /**
   * THE SANDBOX, PUT BACK, WITH ONE DIRECTORY OPEN IN IT AND THE SOURCE TREE
   * SHUT. The version that updated itself had to open /opt/blitz-bot for
   * writing and hand npm a HOME and a cache — so the running bot could rewrite
   * its own source and its own token file. All of that is gone and the cheap
   * way to bring it back is one line added for a reason that sounds good.
   *
   * `ReadWritePaths=` IS THE ONE THAT MATTERS HERE and it is asserted absent
   * separately from `StateDirectory=`, which is now present: they are opposite
   * answers to "what may this process write", and the whole point of the
   * distinction is that a directory systemd created for this unit is not the
   * directory the bot's own code and token live in.
   */
  it('restores the bot to a sandbox with nothing but its own state directory writable', () => {
    for (const kept of [
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'ProtectSystem=strict',
      'ProtectHome=true',
    ]) {
      expect(botDirectives, kept).toContain(kept)
    }

    for (const directive of botDirectives) {
      // The bot's own source and its own .env. This is the line that must
      // never come back, and it is why StateDirectory= is safe and this is not.
      expect(directive, directive).not.toMatch(/^ReadWritePaths=/)

      // The npm cache and the HOME the rejected install needed.
      expect(directive, directive).not.toMatch(/^CacheDirectory=/)
      expect(directive, directive).not.toMatch(/^Environment=/)

      // The bump that only existed to cover a cold `npm ci` inside the start.
      expect(directive, directive).not.toMatch(/^TimeoutStartSec=/)
    }

    // The one thing the bot still does with /opt/blitz-bot is read it, and
    // read-only is not invisible — which is the whole reason .deployed-commit
    // is there and not in the state directory.
    expect(flat(commentsOf(botUnit))).toMatch(/Read-only is not invisible/i)
  })

  /**
   * THE DEPLOY NOTICE'S MEMORY, AND THE INTEGRATION BUG IT WAS LEFT IN.
   *
   * src/client.ts writes the last commit it announced into
   * `$STATE_DIRECTORY/reported-commit`, falling back to /var/lib/blitz-bot, and
   * compares it at the next start so that a restart on the same commit posts
   * nothing. The unit lost its `StateDirectory=` when the rejected ExecStartPre
   * went, and kept `ProtectSystem=strict` — so that path was read-only to the
   * bot, the write failed, and `Restart=always` re-announced the same commit
   * after every crash. Five seconds apart, in the channel that has to stay
   * readable while the bot is crashing, which is precisely the noise the
   * comparison exists to stop.
   *
   * NOTHING ELSE WOULD HAVE CAUGHT IT. The bot starts, the notice posts, the
   * unit is green; the only signal is one `warn` line nobody is grepping for.
   * Two files, edited in the same round by two people, agreeing about a path
   * and disagreeing about whether it could be written.
   *
   * SO THE UNIT AND THE CODE ARE COMPARED, NOT DESCRIBED. The literal in
   * client.ts is the fallback for a bot started by hand; on the box the value
   * comes from `StateDirectory=` through the `STATE_DIRECTORY` systemd exports.
   * Both have to name the same directory, and neither side is typed out here.
   */
  it('gives the bot the state directory its deploy notice remembers in', () => {
    const state = setting(botUnit, 'StateDirectory', "the bot's state directory")

    // One line, and the name systemd turns into /var/lib/<name>.
    expect(botDirectives.filter((line) => line.startsWith('StateDirectory='))).toHaveLength(1)
    expect(state).toMatch(/^[\w.-]+$/)

    // The path src/client.ts falls back to when STATE_DIRECTORY is unset is the
    // path this directive produces. Change either and this fails.
    const fallback = capture(
      clientSource,
      /const state = first === undefined \|\| first === '' \? '([^']+)'/,
      "the state directory src/client.ts falls back to",
    )

    expect(fallback).toBe(`/var/lib/${state}`)

    // And systemd's own answer is preferred over that literal, which is what
    // keeps the unit and the code from drifting apart in the first place.
    expect(clientSource).toContain('process.env.STATE_DIRECTORY')

    // Both units name the same directory, which is a decision and not a
    // coincidence — one directory, one owner, two writers of different files.
    expect(setting(updateUnit, 'StateDirectory', "the update's state directory")).toBe(state)

    /**
     * AND IT IS COMMENTED FOR THE REASON IT IS THERE NOW. It was there before
     * for an npm cache, in a design that was rejected and stripped out — so the
     * next person tidying this sandbox reads it as a leftover and removes it,
     * unless the unit itself says otherwise where they are standing.
     */
    const why = flat(commentsOf(botUnit))

    expect(why).toMatch(/reported-commit/)
    expect(why).toMatch(/not why it was here before/i)
    expect(why).toMatch(/repeats on every crash restart/i)

    // Including the line that must NOT come back with it, said in the same
    // breath, because "the sandbox already has a hole in it" is the argument
    // that reopens the source tree.
    expect(why).toMatch(/ReadWritePaths=\/opt\/blitz-bot would open/i)
  })

  /**
   * TWO UNITS, ONE DIRECTORY, AND EXACTLY ONE WRITER OF THE FILE THAT MATTERS.
   *
   * Both units now declare `StateDirectory=blitz-bot`, so both see
   * /var/lib/blitz-bot and both run as ubuntu. That is deliberate and it is
   * cheap — but it puts the update one line away from a file it must never
   * touch. Writing the NEW sha into reported-commit would leave the bot
   * believing it had already announced a deploy it never announced, and the
   * notice would never fire again; writing the OLD one would make it fire on
   * every restart. Neither is an error anywhere: one is a silent channel, the
   * other is the noise this file exists to stop.
   *
   * THE NAME IS TAKEN FROM src/client.ts, so renaming the file there and
   * forgetting this is a failure here rather than on the box.
   */
  it('never lets the update write the file the bot remembers its notice in', () => {
    const reported = capture(clientSource, /return join\(state, '([^']+)'\)/, "the bot's notice file")

    // Not written, not copied, not removed, not mentioned as a path in any
    // command: the update script has no business naming it at all.
    for (const line of updateScript.split('\n')) {
      if (/^\s*#/.test(line)) continue
      expect(line, line).not.toContain(reported)
    }

    // And the prohibition is written down in both places somebody would be
    // standing when they broke it.
    expect(flat(commentsOf(updateScript))).toMatch(
      new RegExp(`must never write \\$STATE/${reported}`, 'i'),
    )
    expect(flat(commentsOf(updateUnit))).toMatch(
      new RegExp(`never write ${reported}`, 'i'),
    )

    // The one file the update does own in there, so that "shared directory"
    // stays a statement about a directory rather than about a file.
    expect(capture(updateScript, /^INSTALLED=\$STATE\/(\S+)/m, "the update's own state file")).not.toBe(
      reported,
    )
  })

  /**
   * A CRASH MUST NOT DEPLOY, WHICH IS THE SENTENCE THE OWNER ASKED FOR.
   * `Restart=always` stays — it is what carries the bot through a Discord
   * outage — and it is only safe because the start it produces fetches nothing.
   * Both halves have to be said, and said in §14, which is the section somebody
   * opens while the bot is looping.
   */
  it('keeps Restart=always and says plainly that it no longer deploys', () => {
    expect(botDirectives).toContain('Restart=always')
    expect(botDirectives).toContain('RestartSec=5')

    expect(flat(commentsOf(botUnit))).toMatch(/no longer a deployment mechanism/i)
    expect(flat(section(deployDoc, RESTART_LOOP))).toMatch(/crash loop deploys nothing/i)
  })

  /**
   * THE UPDATE IS A ONESHOT THAT RUNS THE SCRIPT AND NOTHING ELSE, and its
   * failure is allowed to be a failure — the exact inverse of the `-` on the
   * ExecStartPre this replaces, because nothing is waiting on it to start a
   * bot any more.
   *
   * NO Restart= ON IT. A oneshot that restarts itself on failure is the fetch
   * loop this design exists to remove; retrying is the timer's job, once, in
   * fifteen minutes.
   */
  it('runs the update as a oneshot whose failures are allowed to be failures', () => {
    expect(updateDirectives).toContain('Type=oneshot')
    expect(updateDirectives).toContain('ExecStart=/usr/local/bin/blitz-bot-update')

    for (const directive of updateDirectives) {
      // A leading `-` here would restore the swallow-everything policy.
      expect(directive, directive).not.toMatch(/^ExecStart=-/)
      expect(directive, directive).not.toMatch(/^Restart=/)
    }

    /**
     * Installed under the path the unit runs, executable, and installed before
     * the units that name it — the other order leaves a window in which
     * blitz-bot-update.service exists and its ExecStart does not, on a box
     * whose timer may already be running.
     *
     * THE `chmod 755` THIS REPLACES WAS A SEPARATE STEP IN THE RUNBOOK, because
     * `tee` does not set a mode and somebody had to remember to. install.sh
     * writes the file and the mode in one `install` call, so the assertion is
     * on the mode it installs rather than on a command being present two blocks
     * further down the page.
     */
    const script = setting(updateUnit, 'ExecStart', "the update unit's ExecStart")
    const first = installs[0]

    expect(first?.dest, 'the update script is not the first thing install.sh installs').toBe(script)
    expect(first?.mode, 'the update script is not installed executable').toBe('755')

    // It runs as the user that owns the tree. As root, git refuses an
    // ubuntu-owned repository outright and the install leaves a tree the
    // operator can no longer touch by hand.
    expect(updateDirectives).toContain('User=ubuntu')

    // The two network steps bound themselves; the unit's limit is above their
    // sum, so what gives up is the step that hung, with a line naming it.
    const startTimeout = Number(
      capture(updateUnit, /^TimeoutStartSec=(\d+)$/m, "the update unit's start timeout"),
    )
    const fetch = Number(capture(updateScript, /timeout (\d+) git fetch/, "the script's fetch timeout"))
    const install = Number(
      capture(updateScript, /timeout (\d+) \S+\/bin\/node \S+\/npm-cli\.js ci/, "the script's install timeout"),
    )

    expect(startTimeout).toBeGreaterThan(fetch + install)
  })

  /**
   * EVERY FILE install.sh CLAIMS TO INSTALL HAS TO BE THERE TO INSTALL.
   *
   * It copies four files by name out of its own directory. Rename one in the
   * repository and not in the script and the run stops halfway: two units in
   * /etc/systemd/system, the third missing, and the `systemd-analyze verify`
   * that would have said so never reached — because the script died in front of
   * it. On the box that reads as an install that "half worked", which is the
   * one outcome an installer exists to make impossible.
   *
   * AND THE FOURTH FILE IS THE POINT OF THE OTHER HALF OF THIS. `deploy/` is
   * where the units live now, and a destination that does not correspond to a
   * file in it is a unit installed from nowhere.
   */
  it('installs four files, all of which are in deploy/', () => {
    expect(installs).toHaveLength(4)

    // In deploy/, readable, under the name the script asks for. repoFile throws
    // on a missing file, so this is the check and not a description of one.
    for (const file of installs) {
      expect(() => repoFile(`deploy/${file.src}`), file.src).not.toThrow()
    }

    // Installed under the same basename it has in the repository, so
    // `diff deploy/blitz-bot.service /etc/systemd/system/blitz-bot.service` is
    // both the obvious thing to type and the right one. That comparison is the
    // whole reason these files stopped being heredocs.
    for (const file of installs) {
      expect(file.dest.endsWith(`/${file.src}`), `${file.src} -> ${file.dest}`).toBe(true)
    }

    // The three units go where systemd reads units, at 644: a unit file is read
    // by systemd and never executed by anything.
    const units = installs.filter((file) => /\.(service|timer)$/.test(file.src))

    for (const unit of units) {
      expect(unit.dest, unit.src).toBe(`${installDirs.get('SYSTEMD') ?? '?'}/${unit.src}`)
      expect(unit.mode, unit.dest).toBe('644')
    }

    /**
     * AND EVERY DESTINATION IS A PATH §6 ALREADY NAMES. This is the one
     * assertion here that is not derived from install.sh, and it is the only
     * reason the two directories at the top of that file mean anything: an
     * installer retargeted at /etc/systemd/user is internally consistent, and
     * everything above stays green while the box gains three units systemd
     * never loads and a runbook that describes a different machine.
     */
    for (const file of installs) {
      expect(section(deployDoc, UNITS), file.dest).toContain(file.dest)
    }

    /**
     * AND THE FILES IT INSTALLS ARE THE FILES THIS BLOCK PINS. Compared by
     * content rather than by name, so a fourth unit dropped into deploy/ and
     * added to install.sh — installed on the box, asserted on by nothing —
     * fails here instead of arriving unreviewed.
     */
    const pinned = [botUnit, updateUnit, timerUnit]

    expect(units).toHaveLength(pinned.length)
    for (const unit of units) expect(pinned, unit.src).toContain(repoFile(`deploy/${unit.src}`))

    // The one that is not a unit is the update script, likewise by content.
    expect(repoFile(`deploy/${installs[0]?.src ?? ''}`)).toBe(updateScript)

    /**
     * AND IT INSTALLS WITHOUT STARTING, which is the decision the runbook is
     * built on: §7 starts the bot, reads the journal, and turns the timer on
     * last, one step at a time. `enable` folded in here would mean a reboot
     * deploys, and `start` would mean an install starts a bot into a live guild
     * before anybody has looked at `.env`.
     *
     * ON THE COMMANDS AND NOT THE TEXT, because the script's own comments name
     * `systemctl start blitz-bot-update` in order to explain what the
     * daemon-reload is for.
     */
    for (const line of installScript.split('\n')) {
      if (/^\s*#/.test(line)) continue
      expect(line, line).not.toMatch(/systemctl (enable|start|restart)\b/)
    }

    expect(installScript).toContain('systemctl daemon-reload')
  })

  /**
   * THE COMMAND THE RUNBOOK HANDS OVER HAS TO NAME A FILE THAT EXISTS.
   *
   * §6.1 is now one line to paste and it is the entire install, so a renamed or
   * moved installer turns that line into `No such file or directory` at the one
   * moment the operator has nothing else to try — and he is not a programmer,
   * so "work out where it went" is not a step. Both halves are derived: the
   * repo-relative half by reading the file at all, and the box-absolute prefix
   * out of the directory install.sh refuses to run without.
   */
  it('hands over an install command that names the installer that exists', () => {
    const repo = capture(installScript, /^REPO=(\S+)$/m, 'the directory install.sh insists on')
    const command = `sudo sh ${repo}/deploy/install.sh`

    expect(section(deployDoc, UNITS)).toContain(command)

    /**
     * THROUGH AN INTERPRETER AND NOT AS `./install.sh`, for the reason ci.yml
     * gives about verify.sh: this repo is developed on Windows with
     * `core.filemode=false`, and an executable bit that did not survive is
     * "Permission denied", exit 126, out of a command that looks exactly right.
     * Naming `sh` does not consult the mode bit at all.
     */
    expect(deployDoc).not.toMatch(/sudo \S*\/deploy\/install\.sh/)
    expect(deployDoc).not.toMatch(/\.\/deploy\/install\.sh/)

    // §16 sends him back to the same command rather than to a second one, which
    // is the rule the whole "one script, one unit, one path" argument runs on.
    expect(section(deployDoc, UPDATE)).toContain(command)
  })

  /**
   * NEITHER UNIT MAY DEPEND ON THE OTHER, for the reason §"the rule that
   * matters" gives about the console and one more that is specific to these
   * two: the update restarts the bot, and an ordering dependency between a unit
   * and a unit it restarts is how a boot wedges. A `Wants=` looks harmless and
   * is exactly how it starts.
   */
  it('keeps the two units independent of each other', () => {
    for (const directive of updateDirectives) {
      expect(directive, directive).not.toMatch(/^(Requires|Requisite|BindsTo|PartOf|After|Before|Wants)=.*blitz-bot\.service/)
    }

    for (const directive of botDirectives) {
      expect(directive, directive).not.toMatch(/blitz-bot-update/)
    }

    expect(flat(commentsOf(updateUnit))).toMatch(/NOTHING HERE NAMES blitz-bot\.service/)
  })

  /**
   * THE SCHEDULE, AND THE TWO LINES AROUND IT THAT ARE EASY TO GET WRONG.
   *
   * Persistent= HAS AN EFFECT ONLY ON OnCalendar= TIMERS. Written as
   * `OnUnitActiveSec=15min` the schedule reads identically and is arguably
   * tidier, and `Persistent=true` beneath it is then accepted and does
   * nothing — so a box that was switched off comes back and sits on old code
   * until the next window instead of catching up. That is a silent regression
   * with no error anywhere, which is why the pairing is asserted rather than
   * the interval alone.
   *
   * AND THE INTERVAL IS PINNED TO THE PROSE THAT JUSTIFIES IT. A number in a
   * unit file with no argument attached is a number the next person changes on
   * a hunch.
   */
  it('fires on a calendar it can catch up on, with the interval it claims', () => {
    const schedule = capture(timerUnit, /^OnCalendar=(.+)$/m, "the timer's schedule")
    const minutes = Number(capture(schedule, /^\*:0\/(\d+)$/, "the timer's interval in minutes"))

    // Short enough that nobody opens an SSH session; long enough that an
    // evening's commits are a handful of restarts rather than one per push.
    expect(minutes).toBeGreaterThanOrEqual(5)
    expect(minutes).toBeLessThanOrEqual(60)

    expect(timerDirectives).toContain('Persistent=true')
    expect(timerDirectives).toContain('WantedBy=timers.target')

    // The pairing, both ways: no monotonic schedule, and the reason written
    // where the person rewriting it will be standing.
    for (const directive of timerDirectives) {
      expect(directive, directive).not.toMatch(/^OnUnitActiveSec=/)
      expect(directive, directive).not.toMatch(/^OnBootSec=/)
    }

    expect(flat(commentsOf(timerUnit))).toMatch(/only on OnCalendar= timers/)

    // Spread, or every box on this schedule hits github.com on the same second
    // for ever. Less than the interval, or the windows overlap.
    const jitter = Number(capture(timerUnit, /^RandomizedDelaySec=(\d+)$/m, "the timer's spread"))

    expect(jitter).toBeGreaterThan(0)
    expect(jitter).toBeLessThan(minutes * 60)

    // The number is argued for, in the timer and in the section the owner
    // reads, in the units he thinks in.
    expect(flat(commentsOf(timerUnit))).toMatch(/fifteen minutes/i)
    expect(flat(section(deployDoc, UPDATE))).toMatch(/about fifteen minutes/i)
    expect(minutes).toBe(15)
  })

  /**
   * NO CHANGE MEANS NO RESTART, WHICH IS THE OWNER'S OWN SENTENCE. The bot
   * holds a websocket; restarting it four times an hour to arrive back at the
   * commit it was already on is a reconnect for nothing, and it buries the one
   * line that means something was deployed.
   *
   * THE COMPARISON IS AGAINST WHAT THE BOT IS RUNNING, not against what this
   * run changed, and that is not pedantry: a run that fetched a new commit and
   * then failed its install did not restart, so the bot is still on the old
   * code while the disk is on the new. "Did the commit move this run" answers
   * no at the next tick and leaves it there until somebody pushes again.
   */
  it('restarts only when the bot is not already on the commit on disk', () => {
    const restart = positionOf(updateScript, grantedCommand, 'the restart')

    // The comparison, the early exit, and both of them ahead of the restart.
    const compare = positionOf(updateScript, '[ "$current" = "$deployed" ]', 'the commit comparison')

    expect(compare).toBeLessThan(restart)
    expect(positionOf(updateScript, "say \"no restart:", 'the no-restart line')).toBeLessThan(restart)
    expect(updateScript.slice(compare, restart)).toMatch(/exit 0/)

    // `$deployed` is the commit file, not the reset's own before-and-after, and
    // an unreadable one reads as unknown rather than as "already deployed".
    expect(updateScript).toMatch(/deployed=\$\(cat "\$COMMIT" 2>\/dev\/null \|\| true\)/)

    // try-restart and not restart: a bot somebody stopped on purpose stays
    // stopped rather than being started by a deploy nobody was watching.
    expect(grantedCommand).toContain('try-restart')

    // Exactly one restart in the script. A second one is a path that skips
    // everything above it.
    expect(updateScript.split(grantedCommand).length - 1).toBe(1)
  })

  /**
   * `npm ci` DELETES node_modules BEFORE IT INSTALLS, which is the failure the
   * last review found. On a timer it is survivable — nothing is starting the
   * bot into that window, and the running process holds its dependencies in
   * memory — but only while the restart stays behind the install and a failed
   * install ends the run.
   *
   * A RESTART AFTER A FAILED INSTALL IS THE OUTAGE, in one line, and it is the
   * obvious "fix" for somebody who reads the script as "why didn't it come
   * back on the new code".
   */
  it('installs before it restarts, and does not restart at all after a failed install', () => {
    const install = positionOf(updateScript, 'npm-cli.js ci', 'the install')
    const record = positionOf(updateScript, 'cp package-lock.json "$INSTALLED"', 'the lockfile record')
    const failure = positionOf(updateScript, 'die "install failed', 'the failed-install line')
    const restart = positionOf(updateScript, grantedCommand, 'the restart')

    // The order that is the whole argument.
    expect(install).toBeLessThan(restart)
    expect(failure).toBeLessThan(restart)

    // The failure branch leaves through `die`, and `die` exits non-zero without
    // reaching anything below it. Both halves: a `warn` there would fall
    // through to the restart with no dependencies on disk.
    expect(updateScript).toMatch(/^die\(\) \{ warn "\$1"; exit 1; \}$/m)

    // node_modules missing is its own reason to install: the lockfile can be
    // unchanged and the tree still unrunnable.
    expect(updateScript).toMatch(/\[ -d node_modules \] && cmp -s package-lock\.json "\$INSTALLED"/)

    // Recorded after the install and only on its success branch, so a failed
    // install is retried at the next tick rather than remembered as done —
    // which is also what makes a transient failure heal without a human.
    expect(record).toBeGreaterThan(install)
    expect(updateScript.split('cp package-lock.json').length - 1).toBe(1)
    expect(failure).toBeGreaterThan(record)

    // And the operator is told what that state looks like from outside, in the
    // section he opens when something is wrong.
    expect(flat(section(deployDoc, RESTART_LOOP))).toMatch(/tree is ahead of the running process/i)
  })

  /**
   * THE WAY BACK, AND IT HAS TO EXIST BEFORE THE THING IT UNDOES. The review
   * that rejected updating at start said it plainly: `reset --hard` destroys the
   * last-known-good tree with nothing holding a reference to it. A tag is a
   * reference, it is on this disk, and using it needs no network — which
   * matters, because "github.com is unreachable" is one of the two reasons to
   * be rolling back at all.
   *
   * LIGHTWEIGHT, NOT ANNOTATED. An annotated tag is an object with an author,
   * an author needs an identity, and `ProtectHome=true` leaves no home
   * directory to read a `.gitconfig` from — so the annotated form fails exactly
   * when it is needed.
   */
  it('tags the commit it is leaving before it overwrites it', () => {
    const tag = capture(updateScript, /^PREVIOUS=(\S+)/m, "the update script's rollback tag")

    // The commands, not the comments — the comment above the tag quotes the
    // rollback, so a search for a bare `git reset --hard` finds prose first.
    const tagged = positionOf(updateScript, 'git tag -f "$PREVIOUS"', 'the tag')
    const reset = positionOf(updateScript, 'git reset --hard --quiet origin/main', 'the reset')

    // Before the reset, or it names the commit it was supposed to preserve you
    // from.
    expect(tagged).toBeLessThan(reset)

    // Lightweight: `-a`, `-m` or `-s` would need an identity this service has
    // no home directory to read.
    expect(updateScript).not.toMatch(/git tag[^\n]*\s-[ams]\b/)

    // And it is a tag on the commit the box was on, not on HEAD after the fact.
    expect(updateScript).toContain('git tag -f "$PREVIOUS" "$before"')

    // The runbook rolls back with the same name the script writes, and switches
    // updating off first — without that the next tick undoes the rollback.
    const update = section(deployDoc, UPDATE)
    const off = capture(updateScript, /^OFF_SWITCH=(\S+)/m, "the update script's off switch")

    expect(update).toContain(`git reset --hard ${tag}`)
    expect(update.indexOf(`sudo touch ${off}`)).toBeLessThan(update.indexOf(`git reset --hard ${tag}`))
  })

  /**
   * THE OFF SWITCH, WHICH NOW STOPS A TIMER RATHER THAN A START. It is read
   * before anything else in the script so that it still works when the rest of
   * the script is what is broken, and both halves are in the runbook — turning
   * it on, and the one that gets forgotten, turning it back off.
   */
  it('keeps a way to stop the box updating itself', () => {
    const off = capture(updateScript, /^OFF_SWITCH=(\S+)/m, "the update script's off switch")
    const check = positionOf(updateScript, /if \[ -e "\$OFF_SWITCH" \]/, 'the off-switch check')

    expect(check).toBeLessThan(positionOf(updateScript, 'git fetch --quiet origin', 'the fetch'))
    expect(check).toBeLessThan(
      positionOf(updateScript, 'git reset --hard --quiet origin/main', 'the reset'),
    )

    const update = section(deployDoc, UPDATE)

    expect(update).toContain(`sudo touch ${off}`)
    expect(update).toContain(`sudo rm ${off}`)

    // A box left switched off reports success on every tick for ever, which is
    // the failure that looks exactly like a working deploy pipeline.
    expect(flat(update)).toMatch(/looks completely healthy and deploys nothing/i)
  })

  /**
   * THE CONTRACT src/ IS CODED AGAINST, PINNED FROM THE SCRIPT THAT WRITES IT.
   * The bot reads one file at startup and reports what is in it, so the path
   * and the shape are an interface between two things that are edited by
   * different people on different days. Every value below is derived from the
   * script rather than typed out again, so a path changed in one place fails
   * here instead of in Discord.
   */
  it('writes the commit file the bot reads, in the one place the bot can read it', () => {
    const repo = capture(updateScript, /^REPO=(\S+)/m, "the update script's repo path")
    const commit = capture(updateScript, /^COMMIT=(\S+)/m, "the update script's commit file")
    const absolute = commit.replace('$REPO', repo)

    // Inside the bot's WorkingDirectory, which under ProtectSystem=strict with
    // no ReadWritePaths is readable — and not in the state directory, which
    // belongs to the update's unit.
    expect(absolute.startsWith(`${repo}/`)).toBe(true)
    expect(setting(botUnit, 'WorkingDirectory', "the bot's working directory")).toBe(repo)
    expect(absolute).not.toContain('/var/lib')

    /**
     * The runbook states the absolute path and the exact contents, because
     * src/ is written against this section and not against the script.
     *
     * POSITIONALLY, IN THE BLOCK THAT STATES IT. A `toContain` over §6 stays
     * green with the wrong path under "Path, exactly", because the right one
     * survives in the script, in the file table and in three comments — the
     * same "present somewhere in the file" mistake the quoted log lines above
     * are pinned against, and a mutation pass proved it here too.
     */
    const units = section(deployDoc, UNITS)

    expect(capture(units, /\*\*Path, exactly:\*\*\n\n```\n([^\n]+)\n```/, 'the path §6.2 states')).toBe(
      absolute,
    )

    expect(flat(units)).toMatch(/one line — the short commit sha, then a newline/i)

    // And the worked example is a bare sha, not a decorated one. `commit=6bbff70`
    // in an example is what somebody codes against when the prose is long.
    expect(
      capture(units, /as it is on the box today:\n\n```\n([^\n]*)\n```/, "§6.2's example file"),
    ).toMatch(/^[0-9a-f]{7,40}$/)

    // One writer, writing one line with no decoration, and writing it before
    // the restart — the other order hands the new process the old commit.
    expect(updateScript).toContain(`printf '%s\\n' "$current" > "$COMMIT"`)
    expect(updateScript.split('> "$COMMIT"').length - 1).toBe(1)
    expect(positionOf(updateScript, '> "$COMMIT"', 'the commit file write')).toBeLessThan(
      positionOf(updateScript, grantedCommand, 'the restart'),
    )

    // What the value is, said once, in the file that produces it and in the
    // file that describes it.
    expect(updateScript).toContain('git rev-parse --short HEAD')
    expect(units).toContain('git rev-parse --short HEAD')

    // Missing means unknown, and unknown must not be papered over by the bot
    // running git — after a failed install that answers with a commit the
    // process is not on.
    expect(flat(units)).toMatch(/must not fall back to running git/i)
  })

  /**
   * THE ONE PRIVILEGED THING, AND THE TWO SPELLINGS THAT HAVE TO MATCH.
   * sudoers matches a command and its arguments literally: `blitz-bot` in the
   * script against `blitz-bot.service` in the drop-in is a denial, at the last
   * line of a deploy, with the tree already moved. Deriving one from the other
   * is the only way that stays true.
   */
  it('grants exactly the command the script runs, and nothing else', () => {
    expect(updateScript).toContain(`sudo -n ${grantedCommand}`)
    expect(grantedCommand).toMatch(/^\/usr\/bin\/systemctl try-restart blitz-bot\.service$/)

    // One rule in the file, or the narrow grant is not narrow.
    expect(sudoers.split('NOPASSWD:').length - 1).toBe(1)

    const units = section(deployDoc, UNITS)

    // Checked before it is in place. A file in /etc/sudoers.d that does not
    // parse stops sudo working at all, on a box whose only privileged path is
    // sudo over SSH.
    // The check comes before the install, in the same `&&` chain, so a paste
    // that went wrong never reaches /etc/sudoers.d at all. Compared against the
    // install command rather than the path, which §6's file table names first.
    expect(units).toContain('visudo -c -f /tmp/blitz-bot-update.sudoers')
    expect(units.indexOf('visudo -c -f')).toBeLessThan(
      units.indexOf('install -o root -g root -m 440 /tmp/blitz-bot-update.sudoers'),
    )

    // And sudo is why the update unit cannot have NoNewPrivileges. The bot's
    // unit keeps it; this one says out loud that it cannot.
    for (const directive of updateDirectives) {
      expect(directive, directive).not.toMatch(/^NoNewPrivileges=/)
    }

    expect(botDirectives).toContain('NoNewPrivileges=true')
    expect(flat(commentsOf(updateUnit))).toMatch(/NO NoNewPrivileges=true HERE/)
  })

  /**
   * `git pull` IS THE WRONG VERB FOR A DEPLOY BOX, in three ways this box will
   * hit: it refuses outright if a tracked file was edited in place, it can
   * leave a merge commit so the box sits at a commit that exists nowhere else,
   * and a merge commit wants an identity that `ProtectHome=true` leaves no home
   * directory to read.
   */
  it('lands on exactly origin/main and never runs git pull or git clean on the box', () => {
    expect(updateScript).toContain('git fetch --quiet origin')
    expect(updateScript).toContain('git reset --hard --quiet origin/main')

    /**
     * THE SCRIPT ITSELF IS IN THIS SCAN AND USED TO BE IN IT BY ACCIDENT. While
     * the updater lived in a heredoc, "every ```bash block in deploy.md" swept
     * it up along with the runbook's own commands. It is deploy/blitz-bot-update
     * now, and the file has to be named — a mutation pass proved the point by
     * dropping a `git clean -xdf` into the script and watching this stay green.
     * install.sh is here for the same reason and one more: it is the other file
     * that runs `git`-adjacent commands as root on that box.
     */
    for (const block of [
      ...captureAll(deployDoc, /^```bash\n([\s\S]*?)^```/gm, 'a bash block in deploy.md'),
      updateScript,
      installScript,
    ]) {
      for (const line of block.split('\n')) {
        if (/^\s*#/.test(line)) continue
        expect(line, line).not.toMatch(/git pull/)

        // `git clean -x` is the tidy-up that would delete .env, .commit and
        // node_modules in one go, and it is the obvious thing to add next to a
        // hard reset.
        expect(line, line).not.toMatch(/git clean/)
      }
    }

    /**
     * AND THE OPERATOR IS TOLD WHAT IT COSTS HIM, IN THE SECTION HE READS
     * BEFORE HE EDITS SOMETHING IN PLACE. He is not a programmer; "resets onto
     * origin/main" does not read as "your edit is gone" to anyone who has not
     * used git in anger — and the window is now a timer he is not watching
     * rather than a restart he typed.
     */
    const update = flat(section(deployDoc, UPDATE))

    expect(update).toMatch(/is destroyed at the next run of the update/)
    expect(update).toMatch(/fifteen minutes/)
  })

  /**
   * `.env` HOLDS THE BOT TOKEN AND IS NOT IN THE REPO, so a hard reset must
   * leave it alone — and "must" is a claim about `git reset --hard`, not a
   * wish. It is true only while the file is untracked AND ignored, so this
   * reads .gitignore rather than trusting the sentence in the runbook, and the
   * runbook has to cite the same line of the same file.
   */
  it('keeps .env out of the reset, and cites how that was checked', () => {
    const ignore = repoFile('.gitignore')
    const lines = ignore.split('\n').map((line) => line.trim())

    expect(lines).toContain('.env')

    const update = section(deployDoc, UPDATE)

    // The line number is derived, so reordering .gitignore fails here rather
    // than leaving the runbook citing evidence that has moved.
    expect(update).toContain(`.gitignore:${lines.indexOf('.env') + 1}:.env`)

    // Named as repeatable checks rather than as an assurance.
    expect(update).toContain('git check-ignore -v .env')
    expect(update).toContain('git ls-files')
    expect(flat(update)).toMatch(/checked\s+rather than assumed/i)
  })

  /**
   * THE SAME ANTI-FABRICATION RULE AS EVERY OTHER QUOTED LINE IN THIS FILE, for
   * the same reason: four log lines this document quoted had never been written
   * by anything, and each one cost somebody an evening grepping for a string
   * that does not exist. The update's lines are the ones §14 sends an operator
   * to look for, they were all reworded this round, and nothing else was going
   * to notice.
   *
   * BOTH PLACES THEY APPEAR. The fenced examples are what gets compared against
   * the screen; the backticked rows in §14 are what names the fault. A pin on
   * one is not a pin on the other.
   */
  it('quotes only update lines the script can actually print', () => {
    // All three ways the script says something, each cut at the first
    // expansion: `say "deployed $current"` can be held to its literal half and
    // no further.
    const printable = [
      ...updateScript.matchAll(/\b(?:say|warn|die) "([^"]*)"/g),
      ...updateScript.matchAll(/\b(?:say|warn|die) '([^']*)'/g),
    ]
      .map((match) => (match[1] ?? '').split('$')[0] ?? '')
      .filter((prefix) => prefix !== '')

    expect(printable.length).toBeGreaterThan(0)

    const fromBlocks = codeBlocks(deployDoc)
      .flatMap((block) => block.split('\n'))
      .map((line) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z blitz-bot-update: (.+)$/.exec(line)?.[1])
      .filter((message): message is string => message !== undefined)

    const fromProse = [...deployDoc.matchAll(/`blitz-bot-update: ([^`]+)`/g)].map(
      (match) => match[1] ?? '',
    )

    expect(fromBlocks.length).toBeGreaterThan(0)
    expect(fromProse.length).toBeGreaterThan(0)

    for (const message of [...fromBlocks, ...fromProse]) {
      expect(
        printable.some((prefix) => message.startsWith(prefix)),
        `${message} — no say/warn/die in the update script produces this`,
      ).toBe(true)
    }
  })

  /**
   * EVERY `journalctl` HAS TO NAME THE UNIT THE LINE IS ACTUALLY IN. The update
   * moved out of blitz-bot.service into its own unit this round, and a command
   * that greps the bot's journal for an update line now returns nothing at all
   * — which reads as "the update never ran" rather than as "wrong unit", and
   * sends an operator to look for a fault that is not there.
   */
  it('reads update lines out of the update unit and not the bot', () => {
    const commands = captureAll(deployDoc, /^```bash\n([\s\S]*?)^```/gm, 'a bash block in deploy.md')
      .flatMap((block) => block.split('\n'))
      .filter((line) => !/^\s*#/.test(line) && line.includes('journalctl'))

    expect(commands.length).toBeGreaterThan(0)

    for (const command of commands) {
      if (!command.includes('blitz-bot-update:')) continue
      expect(command, command).toMatch(/-u blitz-bot-update\b/)
    }
  })

  /**
   * THREE ANSWERS CHANGED AGAIN, AND ONE OF THEM IS THE POINT OF THE ROUND.
   * "I pushed" now means the box picks it up by itself; "it crashed" now means
   * nothing was deployed; "I edited a file on the box" now means it disappears
   * on a timer rather than at a restart somebody typed. A runbook that documents
   * the mechanism without a table of those answers is one the owner has to
   * derive them from, and he is not a programmer.
   */
  it('answers "I changed X, what happens" for everything that changed', () => {
    const table = section(deployDoc, UPDATE)
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .join('\n')

    for (const [what, row] of [
      ['new code on main', /New code on `main`/],
      ['a crash', /The bot crashed/],
      ['the environment file', /`\/opt\/blitz-bot\/\.env`/],
      ['a unit file or the timer', /A unit file, or the timer/],
      ['the update script', /`\/usr\/local\/bin\/blitz-bot-update`/],
      ['the sudoers grant', /`\/etc\/sudoers\.d\/blitz-bot-update`/],
      ['a tracked file edited on the box', /edited on the box/],
    ] as const) {
      expect(table, what).toMatch(row)
    }

    // The row that is the headline: a crash restarts and deploys nothing.
    expect(table).toMatch(/a crash does not deploy/i)

    // The rows whose answer is still not "it happens by itself".
    expect(table).toMatch(/daemon-reload/)
  })

  /**
   * THIS SECTION HAS NOW ARGUED BOTH WAYS AND MUST NOT BE LEFT DOING SO.
   * Two rounds ago it argued against a restart ever fetching; last round it
   * documented an ExecStartPre that did exactly that; this round that was
   * rejected and removed. Naming an old claim in order to withdraw it is
   * allowed — leaving it standing as current advice is not, which is the rule
   * §4.1's retraction is held to.
   *
   * AND THE THREE REASONS IT WAS REJECTED ARE THE THREE THINGS A FUTURE READER
   * WILL BE TEMPTED TO UNDO, so the withdrawal has to carry them rather than
   * just saying it changed its mind.
   */
  it('retracts the update-on-start design and says what was wrong with it', () => {
    const update = section(deployDoc, UPDATE)

    expect(flat(update)).toMatch(/reviewed and rejected/i)
    expect(flat(update)).toMatch(/deletes `node_modules` before it installs/i)
    expect(flat(update)).toMatch(/nothing holding a reference to it/i)
    expect(flat(update)).toMatch(/any crash deployed/i)

    // No paragraph may still describe updating at start as what happens.
    for (const paragraph of paragraphs(deployDoc)) {
      if (!/ExecStartPre/.test(paragraph)) continue
      expect(paragraph, paragraph).toMatch(/used to|no longer|removed|rejected|does not|inverse/i)
    }
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
