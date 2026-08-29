import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { log } from './log.ts'

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
   * AND IT MUST NOT PROMISE A CHANNEL NOBODY HAS BUILT. `#bot-status` is issue
   * #9 and does not exist; an operator sent to look in it loses the same evening
   * as one grepping for a log line that was never emitted, which is the other
   * half of this same review.
   */
  it('frames the journal as a last resort without promising a status channel that does not exist', () => {
    const logs = section(deploy, /^## \d+\. Logs/m)

    expect(logs).toMatch(/last resort/i)

    let mentions = 0
    for (const paragraph of paragraphs(logs)) {
      if (!paragraph.includes('#bot-status')) continue
      mentions += 1
      expect(paragraph).toMatch(/issue\s+#9/)
      expect(paragraph).toMatch(/not\s+built|does not\s+exist|until it is/i)
    }

    // Nothing above fires if the channel is never named, so say that it is.
    expect(mentions).toBeGreaterThan(0)
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
