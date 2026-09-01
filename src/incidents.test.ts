import { ButtonStyle, ComponentType, Events, type APIEmbed, type Client } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Config } from './config.ts'
import { CONSOLE_URL } from './console.ts'
import { INCIDENT_KIND_INDEX } from './ddb.ts'
import type {
  AuditRow,
  BotStateRow,
  Ddb,
  DdbFailureKind,
  DdbResult,
  Incident,
  IncidentKey,
  IncidentKind,
  IncidentPage,
  PlayerRecord,
} from './ddb.ts'
import {
  avatarFor,
  BUTTON_URL_CAP,
  CATEGORY_LABEL,
  closedByABan,
  COPY,
  createIncidentLog,
  createIncidentOpenLog,
  CURSOR_KEY,
  OPEN_CURSOR_KEY,
  FAULT_LIMIT,
  incidentEmbed,
  incidentIdOf,
  incidentRow,
  incidentUrl,
  installIncidentLog,
  isIncidentTrigger,
  KIND_LABEL,
  MAX_INCIDENT_READS,
  MAX_INDEX_ROWS,
  MAX_POSTS,
  PENDING_HOLD_MS,
  POLL_LIMIT,
  POLLED_KINDS,
  SETTLE_MS,
  unqueryableKind,
  verdictText,
  type Avatars,
  type ComponentRow,
  type IncidentLog,
  type IncidentOpenLog,
  type IncidentOpenLogDeps,
  type IncidentLogDeps,
} from './incidents.ts'

/**
 * The moderation record for a resolved incident, offline — blitz-bot#19.
 *
 * NOTHING HERE TOUCHES DISCORD OR AWS AND NOTHING HERE COULD. Every case drives
 * `createIncidentLog` through the three seams the module declares: a `Pick` of
 * the DynamoDB layer, a poster that records what it was handed instead of
 * sending it, and an avatar lookup that answers from a table. That is possible
 * because the module takes all three as parameters, and is the reason it does.
 *
 * WHAT THIS FILE IS REALLY FOR, in the order the header of incidents.ts argues
 * them. Each one is a way for the feature to be wrong while every log line and
 * every return value still looks right:
 *
 *   THE REPORTER'S NAME MUST NOT REACH THE CHANNEL — the console's `summary` is
 *   built by the game as `Reported for <category> by <reporterName>`, so the one
 *   field that reads like a harmless case description ends in the name of the
 *   person who filed the report. The post is built from two closed vocabularies
 *   instead, and the assertion is over the whole rendered embed;
 *
 *   the audit row is a trigger and never the fact — the verdict comes off the
 *   incident row, `outcome` is never read, and a case that is not `resolved`
 *   must not be posted about however confident the log is;
 *
 *   one permanent ban must not be fifty embeds — the burst of closures it drags
 *   behind it carries `becauseOf: 'ban.issue'` and is dropped, while the case
 *   the ban was issued FROM is not;
 *
 *   an absent verdict is not "no action taken" — a case closed with
 *   `{ action: 'none' }` is now passed over entirely and two kinds of resolved
 *   case carry NO verdict at all, so reading the second as the first drops a
 *   permanent record on the strength of a decision nobody made;
 *
 *   the avatar is optional and the embed must be correct without it — the
 *   player most likely to have no Discord id is exactly the one being banned;
 *
 *   the button is built from the public console and never from the loopback the
 *   kick relay calls, which is one wiring line and is pinned end to end;
 *
 *   and a restart resumes rather than replays — after the last record actually
 *   POSTED, not the last completed pass, which is the only thing standing between
 *   the moderation channel and ten duplicates on a deploy mid-backlog.
 */

const NOW = 1_700_000_000_000

const LICENCE = 'license:abc123'
const MEMBER = '280000000000000001'
const CASE = '6f1c9a2e-0000-4000-8000-000000000001'
const OTHER_CASE = '6f1c9a2e-0000-4000-8000-000000000002'
const ORIGIN = 'https://ringmaster.example'
const AVATAR = 'https://cdn.discordapp.com/avatars/280000000000000001/abc.png'

/**
 * The person who FILED the report, whose name must never reach the channel.
 *
 * A NAME NOTHING ELSE IN THIS FILE USES, so an assertion that it is absent
 * cannot pass because the string happened to be missing for another reason.
 */
const REPORTER = 'QuietWitness'

/**
 * The summary THE GAME ACTUALLY WRITES, formatted here the way it is formatted
 * there.
 *
 * ═══ THIS IS THE SHAPE THE ORIGINAL TEST DID NOT USE, AND THAT IS WHY THE LEAK
 * SHIPPED ═══
 *
 * The fixture used to say `summary: 'Reported for cheating'` — truncated, and a
 * value the game never writes. The leak assertion beside it then planted the
 * reporter's name on `reporterName`, an attribute the embed never rendered, so
 * it passed without ever testing the field that actually carried the name.
 *
 * THE REAL THING IS `('Reported for %s by %s'):format(category, reporterName)`,
 * in `fromReport` —
 * fivem-royale-m9/resources/[fivem-royale]/br_lib/shared/incident_build.lua —
 * reached from br_core/server/players.lua on the live report path, where
 * `reporterName` is the reporting player's in-game name. So every player-filed
 * report's summary ENDS IN A PLAYER'S NAME, and posting it into the moderation
 * channel publishes who reported whom.
 */
function summaryTheGameWrites(category: string, reporterName: string): string {
  return `Reported for ${category} by ${reporterName}`
}

/**
 * The journal is half the output of this module — the other half is the channel
 * — so a case that asserts a decision without asserting it was written down is
 * only half a case. `warn` and `error` also reach the status channel through the
 * sink in src/log.ts.
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

const ok = <T,>(value: T): DdbResult<T> => ({ ok: true, value })

const failed = <T,>(kind: 'timeout' | 'denied' = 'timeout'): DdbResult<T> => ({
  ok: false,
  failure: { kind, op: 'get', table: 'ringmaster-incidents', message: 'from the fake' },
})

/**
 * A case as `incidents.get` now answers it: the PROJECTION, and nothing else.
 *
 * IT NAMES WHAT DYNAMODB IS ASKED FOR AND NOT WHAT THE ROW HOLDS. `incidents.get`
 * reads this table with a `ProjectionExpression`, so `summary`, `evidence`,
 * `matchTimeline`, `note`, `events`, the reporter's name and license and the
 * moderator's written resolution never enter the process. The cases below that
 * still put them on a row do it with a cast and say why: that is the leak
 * assertion, and it has to be able to describe the row the console really holds.
 */
function incident(over: Partial<Incident> = {}): Incident {
  return {
    incidentId: CASE,
    state: 'resolved',
    kind: 'report',
    category: 'cheating',
    subjectLicense: LICENCE,
    subjectName: 'Nate',
    openedAt: NOW - 600_000,
    resolvedAt: NOW - 120_000,
    resolvedByName: 'Admin One',
    verdict: { action: 'ban', expiresAt: null },
    ...over,
  }
}

/**
 * A case as the OPENINGS poller finds it: filed ten minutes ago, nobody has
 * looked at it, and therefore no verdict, no resolver and no `resolvedAt`.
 *
 * EXPLICIT `undefined` RATHER THAN A `delete`, so the three absences are visible
 * in the fixture. `Incident` marks all three optional, which is what the console
 * writes for a case nobody has closed.
 */
function openCase(over: Partial<Incident> = {}): Incident {
  return incident({
    state: 'pending_review',
    resolvedAt: undefined,
    resolvedByName: undefined,
    verdict: undefined,
    ...over,
  })
}

/**
 * The whole row, as `ringmaster-incidents` really holds it.
 *
 * A CAST BECAUSE `Incident` CANNOT NAME THESE, WHICH IS THE POINT OF `Incident`.
 * Every case that asserts something does NOT reach Discord needs a row carrying
 * the thing that must not — otherwise it asserts about a field nobody was ever
 * going to render, which is exactly how the first version of the leak assertion
 * passed while the leak was live.
 */
function wholeRow(over: Partial<Incident> = {}): Incident {
  return {
    ...incident(over),
    summary: summaryTheGameWrites('cheating', REPORTER),
    reporterName: REPORTER,
    reporterLicense: 'license:reporter',
    resolvedByLicense: 'license:admin1',
    resolution: 'Watched the demo, obvious aimbot at 14:02',
    note: null,
    openedAt: NOW - 600_000,
    evidence: [{ chat: ['a line somebody typed'] }],
    matchTimeline: [{ kind: 'kill' }],
    events: [{ at: NOW, what: 'opened' }],
  } as unknown as Incident
}

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    pk: 'AUDIT',
    ts: NOW - 60_000,
    commandId: 'command-1',
    action: 'incident.resolve',
    // EVERY ROW THIS POLLER SEES SAYS `pending`, because `resolve` updates the
    // same key and a cursor walk reads each row exactly once, before its outcome
    // lands. The default here is the truthful one.
    outcome: 'pending',
    actorLicense: 'license:admin1',
    actorName: 'Admin One',
    actorDiscordId: null,
    targetLicense: LICENCE,
    detail: { incidentId: CASE, kind: 'report', verdict: 'ban' },
    ...over,
  }
}

function record(over: Partial<PlayerRecord> = {}): PlayerRecord {
  return {
    license: LICENCE,
    name: 'Nate',
    identifiers: { discord: [{ value: MEMBER, firstSeen: 1, lastSeen: 2 }] },
    firstSeen: 1,
    lastSeen: 2,
    sessions: 1,
    playtimeMs: 1,
    ...over,
  }
}

/* ------------------------------------------------------------------ *
 * The harness.
 * ------------------------------------------------------------------ */

interface Sent {
  readonly embed: APIEmbed
  readonly components: readonly ComponentRow[]
}

interface Harness {
  readonly log: IncidentLog
  /** The bot-state rows, as the table would hold them. */
  readonly state: Map<string, string>
  /** Everything posted, in order. */
  readonly sent: Sent[]
  /** Every incident row read, in order — the read budget is asserted from this. */
  readonly reads: string[]
  /** Every `since` call, so the hold-back window can be asserted. */
  readonly windows: Array<{ after: number; until: number; limit: number | undefined }>
  /**
   * Every bot-state write the code ATTEMPTED, in order, landed or not.
   *
   * SEPARATE FROM `state` BECAUSE THE TWO ANSWER DIFFERENT QUESTIONS. This one
   * is what the poller tried to do; the map is what the table came out holding.
   * A case about a bookmark that could not be saved needs both, because a
   * refused write leaves the map exactly as it was seeded.
   */
  readonly writes: Array<{ key: string; value: string }>
  /** Every index query this poller made. The resolved poller must make none. */
  readonly indexReads: string[]
  cursor(): number | null
}

function harness(
  over: {
    cases?: Record<string, Incident>
    players?: Record<string, PlayerRecord>
    audit?: AuditRow[]
    state?: Record<string, string>
    origin?: string
    avatars?: Record<string, string>
    avatarFails?: unknown
    sendFails?: unknown
    /**
     * Called with the state table the instant a record lands in the channel.
     *
     * IT IS HOW A CRASH IS DRIVEN WITHOUT A CRASH. A pass cannot be killed
     * halfway through from inside a test, but what a crash LEAVES is a table
     * holding everything written before that moment — which is exactly what this
     * hands over, and starting a second poller from it is the restart.
     */
    afterSend?: (state: Map<string, string>) => void
    /**
     * The registry read FAILING, which is `discordIdFor`'s third answer.
     *
     * A HOOK RATHER THAN AN EMPTY `players` MAP, because those are two different
     * facts and the map could only ever produce the first. `{}` is "the game has
     * never seen this player" — an ordinary, permanent answer — and this is "the
     * table did not answer this time", which the next pass may answer
     * differently. Until this hook existed nothing in this file reached the
     * second branch at all. On THIS path the two produce the same embed, by
     * design; what separates them here is one line in the status channel.
     */
    playerGet?: (licence: string) => Promise<DdbResult<PlayerRecord | null>>
    caseGet?: (id: string) => Promise<DdbResult<Incident | null>>
    statePut?: (key: string, value: string) => Promise<DdbResult<BotStateRow>>
    stateGet?: (key: string) => Promise<DdbResult<BotStateRow | null>>
    since?: () => Promise<DdbResult<AuditRow[]>>
    now?: () => number
  } = {},
): Harness {
  const cases = over.cases ?? { [CASE]: incident() }
  const players = over.players ?? { [LICENCE]: record() }
  const audit = over.audit ?? []
  const avatars = over.avatars ?? { [MEMBER]: AVATAR }

  const state = new Map<string, string>(Object.entries(over.state ?? {}))
  const sent: Sent[] = []
  const reads: string[] = []
  const windows: Array<{ after: number; until: number; limit: number | undefined }> = []
  const writes: Array<{ key: string; value: string }> = []
  const indexReads: string[] = []

  const avatarSeam: Avatars = {
    urlFor: (discordId) => {
      if (over.avatarFails !== undefined) return Promise.reject(over.avatarFails)
      const url = avatars[discordId]
      if (url === undefined) return Promise.reject(new Error('Unknown User'))
      return Promise.resolve(url)
    },
  }

  const deps: IncidentLogDeps = {
    now: over.now ?? (() => NOW),
    consoleOrigin: over.origin ?? ORIGIN,
    avatars: avatarSeam,
    posts: {
      send: (embed, components) => {
        if (over.sendFails !== undefined) return Promise.reject(over.sendFails)
        sent.push({ embed, components })
        over.afterSend?.(state)
        return Promise.resolve()
      },
    },
    ddb: {
      incidents: {
        get:
          over.caseGet ??
          ((id) => {
            reads.push(id)
            return Promise.resolve(ok(cases[id] ?? null))
          }),

        /**
         * THE RESOLVED POLLER MUST NEVER CALL THIS, AND IT COUNTS RATHER THAN
         * THROWS. A fake that threw would be caught by `guarded` in
         * src/auditpoll.ts and reported as a consumer bug, so the suite would go
         * green on a poller that had started reading an index it has no business
         * in. `h.indexReads` is asserted instead.
         */
        opened: () => {
          indexReads.push('opened')
          return Promise.resolve(ok({ keys: [], more: false }))
        },
      },
      players: {
        get: over.playerGet ?? ((licence) => Promise.resolve(ok(players[licence] ?? null))),
      },
      botState: {
        get:
          over.stateGet ??
          ((key) => {
            const value = state.get(key)
            return Promise.resolve(
              ok(value === undefined ? null : { id: key, value, updatedAt: NOW - 1 }),
            )
          }),
        /**
         * ═══ THE MAP FOLLOWS THE ANSWER, WHOEVER GIVES IT ═══
         *
         * A `statePut` OVERRIDE USED TO REPLACE THIS WHOLE FUNCTION, which
         * disconnected `state` from the code under test: with one supplied
         * nothing ever wrote to the map, so `h.cursor()` handed back the SEEDED
         * value however the pass had actually gone. Every cursor assertion in
         * every case with an override was then true before the poller ran —
         * including the one case in this file that is ABOUT a bookmark that did
         * not land.
         *
         * So the override decides the ANSWER and this decides what the answer
         * means: a write the fake accepted lands in the map, a write it refused
         * does not, and `cursor()` reads what a restarted bot would find. Every
         * attempt is recorded either way — see `writes`.
         */
        put: async (key, value) => {
          writes.push({ key, value })

          const written = over.statePut
            ? await over.statePut(key, value)
            : ok<BotStateRow>({ id: key, value, updatedAt: NOW })

          if (written.ok) state.set(key, value)
          return written
        },
      },
      auditWindow: {
        partition: 'AUDIT',
        since: (after, until, limit) => {
          windows.push({ after, until, limit })
          if (over.since) return over.since()
          return Promise.resolve(ok(audit.filter((r) => r.ts > after && r.ts <= until)))
        },
        newest: () => Promise.resolve(ok(null)),
      },
    },
  }

  return {
    log: createIncidentLog(deps),
    state,
    sent,
    reads,
    windows,
    writes,
    indexReads,
    cursor: () => {
      const raw = state.get(CURSOR_KEY)
      return raw === undefined ? null : Number(raw)
    },
  }
}

/** A cursor far enough back that everything in the fake log is in the window. */
const OPEN = String(NOW - 3_600_000)

/** Did any line carry this message? `msg=` so a field cannot match by accident. */
function said(lines: string[], msg: string): boolean {
  return lines.some((line) => line.includes(`msg=${JSON.stringify(msg)}`))
}

/**
 * The whole line carrying this message, so a case can read its LEVEL and its
 * FIELDS rather than only whether the sentence was said.
 *
 * THE LEVEL IS THE FIRST THREE CHARACTERS — `<3>` error, `<4>` warn, `<6>` info
 * (src/log.ts) — and both faults go to stderr, so `said(stderr, …)` cannot tell
 * an `error` from a `warn`. Two of the cases below turn on exactly that
 * difference, and one turns on a number in a field.
 */
function lineFor(lines: string[], msg: string): string | undefined {
  return lines.find((line) => line.includes(`msg=${JSON.stringify(msg)}`))
}

/** One field off an embed, by label. */
function field(embed: APIEmbed, name: string): string | undefined {
  return embed.fields?.find((f) => f.name === name)?.value
}

/**
 * What is INSIDE the code span a foreign value is rendered in, or null.
 *
 * THE SPAN IS THE NEUTRALISER AND THIS IS HOW A CASE READS PAST IT. `inert`
 * wraps every value this repo did not write in `` ` ` `` — the same answer
 * `authorRef` in src/client.ts reached about a username, and the only one that
 * makes a BARE URL inert, which no amount of markdown escaping does. So the
 * cases below assert the fence separately from the name it holds.
 */
function span(value: string | undefined): string | null {
  const match = /^`(.*)`$/su.exec(value ?? '')
  return match?.[1] ?? null
}

/* ------------------------------------------------------------------ *
 * The pure parts.
 * ------------------------------------------------------------------ */

describe('the filter that says which audit rows are about an incident', () => {
  it('lets the one incident verb through and nothing else', () => {
    expect(isIncidentTrigger({ action: 'incident.resolve' })).toBe(true)

    for (const action of ['ban.issue', 'ban.lift', 'player.kick', 'player.spectate'] as const) {
      expect(isIncidentTrigger({ action })).toBe(false)
    }
  })

  /**
   * ONE PERMANENT BAN CLOSES EVERY OTHER OPEN CASE ABOUT THAT PLAYER, up to
   * fifty of them, and each closure writes a row. Fifty embeds for one
   * moderation act is the failure this drop exists for.
   */
  it('drops the burst of closures a permanent ban drags behind it', () => {
    expect(
      closedByABan({ action: 'incident.resolve', detail: { incidentId: CASE, becauseOf: 'ban.issue' } }),
    ).toBe(true)
  })

  /**
   * THE CASE THE BAN WAS ISSUED FROM IS THE ADMIN'S OWN DECISION and carries no
   * marker. Dropping it would mean the one closure worth posting is the one that
   * never posts.
   */
  it('keeps the case the ban was actually issued from', () => {
    expect(closedByABan(row())).toBe(false)
  })

  /**
   * NARROWER THAN "ANYTHING CARRYING THE MARKER", copied from the console's own
   * filter: the enforcement kick that follows a ban carries the same
   * `becauseOf` and is deliberately NOT dropped over there, because it is one
   * row rather than fifty and it IS something that happened to the player.
   */
  it('does not drop the enforcement kick, which carries the same marker', () => {
    expect(closedByABan({ action: 'player.kick', detail: { becauseOf: 'ban.issue' } })).toBe(false)
  })
})

describe('the incident an audit row names', () => {
  it('reads the id out of the detail map', () => {
    expect(incidentIdOf(row())).toBe(CASE)
  })

  /**
   * `detail` IS `Record<string, string | number | boolean | null>` as far as this
   * repo is concerned, so a non-string is a shape the type permits. Coercing one
   * would put `/incidents/42` or worse in a permanent record.
   */
  it('refuses anything that is not a non-empty string', () => {
    expect(incidentIdOf({ detail: undefined })).toBeNull()
    expect(incidentIdOf({ detail: {} })).toBeNull()
    expect(incidentIdOf({ detail: { incidentId: '' } })).toBeNull()
    expect(incidentIdOf({ detail: { incidentId: 42 } })).toBeNull()
    expect(incidentIdOf({ detail: { incidentId: null } })).toBeNull()
  })
})

describe('what the embed says was decided', () => {
  /**
   * ═══ THE ONE THAT MATTERS ═══
   *
   * A case resolved before `verdict` existed has no attribute, and one the
   * system auto-resolved at open is written with an explicit `null`. Neither is
   * "an admin looked and decided nothing was needed" — that is a claim about a
   * decision nobody made, and the console's own type comment is emphatic that no
   * reader may convert "do not know" into an answer.
   */
  it('never reads an absent or null verdict as no action taken', () => {
    expect(verdictText({ verdict: undefined })).toBe(COPY.verdictUnknown)
    expect(verdictText({ verdict: null })).toBe(COPY.verdictUnknown)
  })

  /**
   * TWO AND NOT THREE, AND THE THIRD MOVED RATHER THAN VANISHED. This case
   * asserted `{ action: 'none' }` rendering as `COPY.verdictNone` until the
   * owner answered open question 1 on blitz-bot#19 — nothing is posted if no
   * action was taken — which took the string with it. What that verdict now
   * gets is not a rendering at all: see 'posts nothing about a case an admin
   * closed having decided nothing was warranted', in the poll.
   */
  it('names the two verdicts that reach a record', () => {
    expect(verdictText({ verdict: { action: 'kick' } })).toBe(COPY.verdictKick)
    expect(verdictText({ verdict: { action: 'ban', expiresAt: null } })).toBe(
      COPY.verdictBanPermanent,
    )
  })

  /**
   * `expiresAt` EXISTS IF AND ONLY IF THE ACTION IS `ban`, so the action is
   * narrowed on first — always. A reader that reached for it on a kick would get
   * `undefined` where a permanent ban gives `null`: two falsy values meaning
   * entirely different things, and the difference between "forever" and "not
   * applicable".
   */
  it('separates a permanent ban from a temporary one, and neither from a kick', () => {
    const temporary = verdictText({ verdict: { action: 'ban', expiresAt: NOW + 86_400_000 } })

    expect(temporary).toContain(COPY.verdictBan)
    expect(temporary).toContain(`<t:${String(Math.floor((NOW + 86_400_000) / 1000))}:f>`)

    // The permanent one says so in words and carries no timestamp at all.
    expect(verdictText({ verdict: { action: 'ban', expiresAt: null } })).not.toContain('<t:')
    expect(verdictText({ verdict: { action: 'kick' } })).not.toContain('<t:')
  })

  /**
   * ═══ THE SAME RANGE THE RECORD'S OWN STAMP GETS, FROM THE SAME CONSTANT ═══
   *
   * THE ASYMMETRY THIS CLOSES. `resolvedAt` was range-checked and carried a
   * paragraph explaining why finiteness is not a range; `expiresAt` — the same
   * kind of number, off the same row, going into the same message — got
   * `typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)` and stopped
   * there. `1e18` is a number and is finite, so it rendered
   * `Banned · <t:1000000000000000:f>`: a Discord timestamp far outside anything
   * renderable, in a permanent record nobody goes back to.
   *
   * IT FALLS BACK TO THE WORDS AND NOT TO NOTHING, which is the answer the null
   * branch above already gives for a different reason: the case really was a ban,
   * and the only fact in doubt is when it ends.
   *
   * BOTH SIDES OF THE BOUND, AND THE THREE THAT ARE NOT NUMBERS AT ALL. `Math.abs`
   * covers `NaN` and both infinities on its own, so the finiteness test that was
   * replaced is subsumed rather than dropped.
   */
  it('refuses an expiry outside the envelope a parser reads, and still says it was a ban', () => {
    const MAX = 62_167_219_200_000

    const edge = verdictText({ verdict: { action: 'ban', expiresAt: MAX } })
    expect(edge).toContain(`<t:${String(Math.floor(MAX / 1000))}:f>`)

    for (const beyond of [
      MAX + 1,
      -MAX - 1,
      1e18,
      8_640_000_000_000_000,
      Number.MAX_SAFE_INTEGER,
      -1e16,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const label = String(beyond)
      const text = verdictText({ verdict: { action: 'ban', expiresAt: beyond } })

      expect(text, label).toBe(COPY.verdictBan)
      expect(text, label).not.toContain('<t:')
      // NOT the permanent wording either: an expiry nobody can read is not the
      // same claim as an expiry that was never set.
      expect(text, label).not.toBe(COPY.verdictBanPermanent)
    }
  })

  /** The union says it cannot happen; the row is another repository's, so it can. */
  it('falls back to "no verdict recorded" for an action it does not know', () => {
    const odd = { verdict: { action: 'quarantine' } } as unknown as Pick<Incident, 'verdict'>

    expect(verdictText(odd)).toBe(COPY.verdictUnknown)
  })
})

describe('the embed', () => {
  it('names the case, the player and the verdict, and nothing else', () => {
    const embed = incidentEmbed(incident(), AVATAR, 'resolved')

    expect(embed.title).toBe(COPY.resolvedTitle)
    expect(field(embed, COPY.case)).toBe(`${KIND_LABEL.report} · ${CATEGORY_LABEL.cheating}`)
    // The two names arrive in a code span, verbatim inside it. See `span`.
    expect(span(field(embed, COPY.player))).toBe('Nate')
    expect(field(embed, COPY.verdict)).toBe(COPY.verdictBanPermanent)
    expect(span(field(embed, COPY.resolvedBy))).toBe('Admin One')
    expect(embed.footer?.text).toBe(CASE)
  })

  /**
   * ═══ THE LEAK. THE REPORTER'S NAME MUST NOT REACH THE CHANNEL, FROM ANY
   * FIELD ═══
   *
   * THIS ASSERTION USED TO PASS VACUOUSLY. It planted the reporter's name on
   * `reporterName` — which the embed never rendered — while the embed rendered
   * `summary`, which the game builds as
   * `('Reported for %s by %s'):format(category, reporterName)` and which
   * therefore ENDED IN THAT SAME NAME. The fixture beside it said
   * `'Reported for cheating'`, a truncated shape the game never writes, so
   * nothing in the file ever put the real string in front of the builder.
   *
   * SO THE ROW HERE IS THE ROW THE CONSOLE REALLY HOLDS (`wholeRow`), the name
   * is a string nothing else in this file uses, and the assertion is over the
   * WHOLE rendered embed rather than over one field — a leak that moves to
   * another field is the same leak.
   *
   * THIS IS NOT A TIDINESS RULE, AND THE REASON IS NOT THE AUDIENCE. The
   * assertion used to be justified by "a channel every member reads", which
   * docs/deploy.md, README.md and src/config.ts all contradict — it is the
   * admins' channel. What holds is that who reads a Discord channel is a
   * PERMISSION SETTING, one role edit away from changing under every record
   * already posted, and that the reporter's name describes nothing about the
   * case. fivem-royale-m9/docs/security.md names "the reporter" among the
   * attributes br_ddb's projection keeps off the game box — the same judgment
   * about the field, at a different boundary.
   */
  it('never renders the reporter, from any field, on the row the console really holds', () => {
    const rendered = JSON.stringify(incidentEmbed(wholeRow(), AVATAR, 'resolved'))

    for (const secret of [
      REPORTER,
      summaryTheGameWrites('cheating', REPORTER),
      'Reported for',
      'license:reporter',
      'aimbot',
      'a line somebody typed',
      'opened',
    ]) {
      expect(rendered, secret).not.toContain(secret)
    }
  })

  /**
   * THE FIX IS STRUCTURAL AND NOT A FILTER. Nothing strips the reporter out of
   * the summary — that would be a regex over another repository's format string,
   * which stops working silently the day they reword it. The summary is not
   * rendered at all, and what the post says about the case is built from two
   * CLOSED VOCABULARIES: values the game picks out of a fixed list, which cannot
   * carry a person's name whatever anybody writes.
   *
   * A NEW CATEGORY WOULD CHANGE THE WORDS AND COULD NOT INTRODUCE A NAME, which
   * is the property this asserts: every label rendered is one of this module's
   * own strings, none of them comes off the row.
   */
  it('says what the case was from the two enums and never from the row s prose', () => {
    const said = field(incidentEmbed(wholeRow(), null, 'resolved'), COPY.case) ?? ''

    expect(said).toBe(`${KIND_LABEL.report} · ${CATEGORY_LABEL.cheating}`)
    expect(Object.values({ ...KIND_LABEL, ...CATEGORY_LABEL })).toContain(KIND_LABEL.report)
  })

  it('has a word for every kind and every category the console declares', () => {
    expect(Object.keys(KIND_LABEL).sort()).toEqual(['anticheat', 'identifier_reuse', 'report'])
    expect(Object.keys(CATEGORY_LABEL).sort()).toEqual([
      'abusive_chat',
      'cheating',
      'exploiting',
      'griefing',
      'other',
      'system',
      'teaming',
    ])
  })

  /**
   * ═══ A VALUE NEITHER REPOSITORY HAS HEARD OF IS NOT RENDERED ═══
   *
   * `buildIncidentItem` writes `kind` and `category` as 32-character strings —
   * `str(payload.kind, 32) ?? 'anticheat'` in
   * fivem-royale-m9/js-src/br_ddb/src/incident.js — so the closed vocabulary is
   * a promise the game keeps rather than a constraint the table enforces. If
   * that promise ever breaks, the value must NOT be echoed: echoing it is
   * exactly the property this whole change removed, handed straight back.
   */
  it('falls back to its own word rather than echoing a value it does not know', () => {
    const odd = incident({
      kind: 'a report by QuietWitness' as unknown as Incident['kind'],
      category: 'from QuietWitness' as unknown as Incident['category'],
    })

    const said = field(incidentEmbed(odd, null, 'resolved'), COPY.case) ?? ''

    expect(said).toBe(`${COPY.kindUnknown} · ${COPY.categoryUnknown}`)
    expect(said).not.toContain(REPORTER)
  })

  /**
   * A MAP LOOKUP REACHES THE PROTOTYPE CHAIN AND `?? fallback` DOES NOT CATCH
   * IT. `KIND_LABEL['constructor']` is a function, not undefined, and a `String()`
   * of it would put a JavaScript function body in a moderation record.
   */
  it('does not answer with something off the prototype chain', () => {
    const odd = incident({
      kind: 'constructor' as unknown as Incident['kind'],
      category: '__proto__' as unknown as Incident['category'],
    })

    expect(field(incidentEmbed(odd, null, 'resolved'), COPY.case)).toBe(
      `${COPY.kindUnknown} · ${COPY.categoryUnknown}`,
    )
  })

  /** The game files its own cases as `system`, and "Anticheat · System" says it twice. */
  it('does not repeat itself for a case the system filed', () => {
    const embed = incidentEmbed(incident({ kind: 'anticheat', category: 'system' }), null, 'resolved')

    expect(field(embed, COPY.case)).toBe(KIND_LABEL.anticheat)
  })

  /**
   * ═══ THE AVATAR IS OPTIONAL AND THE EMBED MUST BE CORRECT WITHOUT IT ═══
   *
   * FiveM reports a `discord:` identifier only when the player has the activity
   * integration switched on, and it is opt-in — so a cheater who has turned it
   * off is exactly the person with no id. `thumbnail` is ABSENT rather than
   * empty, because Discord refuses an embed carrying `thumbnail: { url: '' }`
   * and a refused message is a moderation record that does not exist.
   */
  it('omits the thumbnail key entirely when there is no avatar', () => {
    const embed = incidentEmbed(incident(), null, 'resolved')

    expect(embed.thumbnail).toBeUndefined()
    expect('thumbnail' in embed).toBe(false)
    expect(field(embed, COPY.case)).toBe(`${KIND_LABEL.report} · ${CATEGORY_LABEL.cheating}`)
  })

  /**
   * ═══ THE RESOLVER IS NAMED AND NEVER LICENSED ═══
   *
   * `resolvedByLicense` is not projected and is not on `Incident`, so this
   * drives the whole row to prove the builder does not reach for it anyway. The
   * console writes `actor.license ?? ''` for an admin with no grants row — an
   * admin who has never joined the game server holds every power in the console
   * and has no license — so `''` is "not known" and is never an identity.
   */
  it('names the resolver and never renders the licence that can be empty', () => {
    const embed = incidentEmbed(wholeRow(), null, 'resolved')

    expect(span(field(embed, COPY.resolvedBy))).toBe('Admin One')
    expect(JSON.stringify(embed)).not.toContain('license:admin1')
  })

  /**
   * A label with an empty value beside it reads as a fact that failed to load,
   * which is a different claim from a fact nobody recorded.
   */
  it('leaves the resolver out rather than printing an empty identity', () => {
    const embed = incidentEmbed(incident({ resolvedByName: '' }), null, 'resolved')

    expect(field(embed, COPY.resolvedBy)).toBeUndefined()
    expect(field(embed, COPY.verdict)).toBe(COPY.verdictBanPermanent)
  })

  /**
   * The game writes the literal `'Unknown'` when it has no name for the subject.
   * It is rendered as stored — that IS the honest answer — and nothing keys a
   * decision off the string, because a player could be called it.
   */
  it("renders the game's placeholder name as the name it is", () => {
    expect(span(field(incidentEmbed(incident({ subjectName: 'Unknown' }), null, 'resolved'), COPY.player))).toBe(
      'Unknown',
    )
  })

  /**
   * ═══ A PLAYER MUST NOT BE ABLE TO WRITE MARKUP INTO THE PERMANENT RECORD ═══
   *
   * WHAT WAS REACHABLE. An embed FIELD VALUE renders markdown, and `subjectName`
   * is the offender's own in-game name — a surface they choose and can prepare
   * long before anybody looks at them. Rendered verbatim, a player called
   * `[Appeal your ban here](https://not-the-console.example)` got a live,
   * official-looking link in the Player field, sitting directly beside the
   * genuine `Open in Ringmaster` button.
   *
   * THE LIST IS AN ATTACK LIST AND NOT A SAMPLE. Each entry is a different
   * mechanism, and four of them are things discord.js's `escapeMarkdown` does
   * not touch at any option setting: a block quote, `<t:…>` timestamp markup
   * beside the real timestamp, `@everyone`, and a bare url — which has no
   * delimiter to escape at all and which Discord linkifies on sight. That last
   * one is why the fix is a code span rather than an escaper.
   *
   * WHAT "INERT" MEANS HERE, ASSERTED STRUCTURALLY. The value is one code span:
   * exactly two backticks, one at each end, so nothing inside can close it and
   * get out as markup; and what is between them is the name as it was stored, so
   * an admin comparing this record against the console reads the same string.
   */
  it('renders a name that is an attack as one inert code span', () => {
    const attacks = [
      '[Appeal your ban here](https://not-the-console.example)',
      'https://not-the-console.example/appeal',
      '||spoilers||',
      '> quoted',
      '<t:0:R>',
      '@everyone',
      '@here',
      '<@&1542596612306505808>',
      '**bold** _italic_ ~~struck~~',
      '# heading',
    ]

    for (const nasty of attacks) {
      // BOTH FIELDS, because `resolvedByName` has the same exposure from a
      // friendlier source and a fix applied to one of them is not a fix.
      for (const [label, embed] of [
        [COPY.player, incidentEmbed(incident({ subjectName: nasty }), null, 'resolved')],
        [COPY.resolvedBy, incidentEmbed(incident({ resolvedByName: nasty }), null, 'resolved')],
      ] as const) {
        const value = field(embed, label) ?? ''

        // ONE SPAN. Two backticks and no more: a third would close it early and
        // let the tail of the value out as live markup.
        expect(value.match(/`/gu) ?? [], nasty).toHaveLength(2)
        expect(value.startsWith('`') && value.endsWith('`'), nasty).toBe(true)

        // And the name is still the name. Inside a span Discord renders every
        // one of these literally and linkifies nothing, so nothing needs
        // stripping to be safe and nothing is.
        expect(span(value), nasty).toBe(nasty)
      }
    }
  })

  /**
   * BACKTICKS ARE THE ONE THING REMOVED, because they are the one thing that
   * can close the span the rest of the value is made inert by. A name made of
   * nothing else leaves nothing to render, and an empty pair of backticks beside
   * a label reads as a fact that failed to load — so the field is dropped whole.
   */
  it('cannot let a name close the span it is rendered in', () => {
    const value = field(incidentEmbed(incident({ subjectName: '`x` **y**' }), null, 'resolved'), COPY.player)

    expect(value?.match(/`/gu) ?? []).toHaveLength(2)
    expect(span(value)).toBe('x **y**')

    expect(
      field(incidentEmbed(incident({ subjectName: '``````' }), null, 'resolved'), COPY.player),
    ).toBeUndefined()
  })

  /**
   * THE INVISIBLE HALF. Control codes and the bidi overrides reorder what a
   * human reads without changing a byte of what was stored, which is a forged
   * record that survives being copied. `plainName` in src/client.ts removes the
   * same class from a username for the same reason.
   */
  it('strips what is invisible, so the record reads the way it is stored', () => {
    const value = field(
      incidentEmbed(incident({ subjectName: 'Na‮te​' }), null, 'resolved'),
      COPY.player,
    )

    expect(span(value)).toBe('Nate')
  })

  /**
   * A name is written elsewhere and read here as one fact. A newline inside a
   * value forges facts nobody recorded — the reason src/log.ts escapes them — and
   * an unbounded value is a field Discord refuses.
   */
  it('flattens and bounds somebody else s text', () => {
    const embed = incidentEmbed(
      incident({ subjectName: `first line\nsecond line ${'x'.repeat(2000)}` }),
      null,
      'resolved',
    )

    const value = field(embed, COPY.player) ?? ''
    expect(value).not.toContain('\n')
    // The 1024 is Discord's and the two backticks of the span count against it,
    // which is why `inert` cuts at `cap - 2` rather than at the cap.
    expect(value.length).toBeLessThanOrEqual(1024)
    expect(span(value)?.startsWith('first line second line')).toBe(true)
  })

  /**
   * ═══ A ROW WHOSE FIELD IS NOT A STRING MUST NOT STOP THE FEED ═══
   *
   * `short` used to call `.replace` on whatever it was handed, guarded by
   * `?? ''` — which catches `null` and `undefined` and not a NUMBER. This file
   * already refuses a non-string incident id and checks `typeof expiresAt !==
   * 'number'` two functions away, so the missing guard was an inconsistency
   * rather than a decision.
   *
   * WHAT IT COST IS WHY IT IS PINNED. One row with a numeric name threw
   * `text.replace is not a function` out of the middle of a pass; a throw skips
   * the cursor write, so the next pass read the same window, reached the same
   * row and threw again. The feed stops dead, on one malformed row, with a
   * `the incident poll threw` line every half minute and no other symptom.
   */
  it('drops a field that is not a string rather than throwing the pass away', () => {
    const odd = incident({
      subjectName: 4181 as unknown as string,
      resolvedByName: { toString: () => 'nope' } as unknown as string,
    })

    const embed = incidentEmbed(odd, null, 'resolved')

    expect(field(embed, COPY.player)).toBeUndefined()
    expect(field(embed, COPY.resolvedBy)).toBeUndefined()
    // And the record still posts, carrying the facts it does have.
    expect(field(embed, COPY.case)).toBe(`${KIND_LABEL.report} · ${CATEGORY_LABEL.cheating}`)
    expect(field(embed, COPY.verdict)).toBe(COPY.verdictBanPermanent)
  })

  it('is stamped with when the case was closed', () => {
    expect(incidentEmbed(incident(), null, 'resolved').timestamp).toBe(
      new Date(NOW - 120_000).toISOString(),
    )
  })

  /**
   * A TIMESTAMP DISCORD CANNOT PARSE IS LEFT OFF rather than allowed to make the
   * whole message invalid — a refused message is a moderation record that does
   * not exist. `resolvedAt` is optional on the row and the console has written
   * cases without it.
   */
  it('posts without a timestamp rather than with an unparseable one', () => {
    expect(incidentEmbed(incident({ resolvedAt: null }), null, 'resolved').timestamp).toBeUndefined()
    expect('timestamp' in incidentEmbed(incident({ resolvedAt: null }), null, 'resolved')).toBe(false)
  })

  /**
   * ═══ THE BOUNDARY, ON BOTH SIDES, BECAUSE `Number.isFinite` IS NOT A RANGE
   * CHECK ═══
   *
   * WHAT THE GUARD USED TO BE AND WHAT IT MISSED. It was
   * `typeof at === 'number' && Number.isFinite(at)`, and `Date`'s representable
   * range is ±8.64e15. `Number.isFinite(1e16)` is `true`; `new Date(1e16)` is an
   * Invalid Date; and `toISOString` on an Invalid Date THROWS
   * `RangeError: Invalid time value` rather than answering with a string. So a
   * finite number one millisecond past the range took the whole embed with it.
   *
   * ═══ AND THE BOUND IS NO LONGER `Date`'S, WHICH IS WHAT THIS CASE MOVED ═══
   *
   * ±8.64e15 IS WHAT A `Date` CAN HOLD AND NOT WHAT A RECEIVER WILL READ. Its two
   * extremes are pinned below verbatim: ISO 8601 EXPANDED-YEAR form, six digits
   * behind a mandatory sign, which 8601 allows only by prior agreement between
   * sender and receiver. There is no such agreement with Discord — its behaviour
   * on the form is undocumented — so the old bound admitted, at exactly its edge,
   * the one shape most likely to be refused. It degraded safely (the send throws
   * inside the `try` in `settle` and the record is dropped loudly after its
   * strikes) and it was still a needless edge in a value off another repo's row.
   *
   * A FOUR-DIGIT YEAR IS THE ENVELOPE EVERY PARSER TAKES, and the number below is
   * the epoch-to-`0000-01-01` distance so that `Math.abs` lands both ends inside
   * it. Both are pinned as strings here rather than through `new Date(...)`,
   * because "renders the same way the code renders it" is not the assertion —
   * "renders as four digits and no sign" is.
   *
   * BOTH SIDES, BECAUSE ONE SIDE IS NOT A BOUNDARY. A guard that refused
   * everything over a smaller number would pass the second half of this case
   * while quietly dropping the stamp off records it could have carried, and a
   * guard that let one more through admits the form. The two values differ by one
   * millisecond and they are the whole assertion.
   */
  it('renders the furthest instant a parser will read and refuses the millisecond past it', () => {
    const MAX = 62_167_219_200_000

    // The bound, as a reader sees it: four digits, no sign, on both ends.
    expect(new Date(MAX).toISOString()).toBe('3940-01-02T00:00:00.000Z')
    expect(new Date(-MAX).toISOString()).toBe('0000-01-01T00:00:00.000Z')

    // And what the old bound admitted, which is the form nothing agreed to.
    expect(new Date(8_640_000_000_000_000).toISOString()).toBe('+275760-09-13T00:00:00.000Z')
    expect(new Date(-8_640_000_000_000_000).toISOString()).toBe('-271821-04-20T00:00:00.000Z')

    expect(incidentEmbed(incident({ resolvedAt: MAX }), null, 'resolved').timestamp).toBe(
      '3940-01-02T00:00:00.000Z',
    )
    expect(incidentEmbed(incident({ resolvedAt: -MAX }), null, 'resolved').timestamp).toBe(
      '0000-01-01T00:00:00.000Z',
    )

    for (const beyond of [
      MAX + 1,
      -MAX - 1,
      8_640_000_000_000_000,
      -8_640_000_000_000_000,
      1e16,
      1e18,
      Number.MAX_SAFE_INTEGER,
      -1e16,
    ]) {
      const label = String(beyond)

      // It is finite, which is what the old guard asked and why it let it past.
      expect(Number.isFinite(beyond), label).toBe(true)

      const embed = incidentEmbed(incident({ resolvedAt: beyond }), null, 'resolved')

      expect('timestamp' in embed, label).toBe(false)
      // And the record is whole: the stamp is what was dropped, not the post.
      expect(field(embed, COPY.case), label).toBe(
        `${KIND_LABEL.report} · ${CATEGORY_LABEL.cheating}`,
      )
      expect(field(embed, COPY.verdict), label).toBe(COPY.verdictBanPermanent)
    }
  })

  /**
   * THE FINITENESS TEST IS SUBSUMED AND NOT LOST. `Math.abs(NaN) <= x` and
   * `Math.abs(Infinity) <= x` are both `false`, so replacing the check did not
   * quietly readmit the three values it used to be there for.
   */
  it('still refuses the three numbers that are not instants at all', () => {
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect('timestamp' in incidentEmbed(incident({ resolvedAt: odd }), null, 'resolved'), String(odd)).toBe(
        false,
      )
    }
  })

  /**
   * ═══ THE FOOTER IS THE ONE BORROWED VALUE ON THIS EMBED THAT IS NOT `inert`,
   * AND THERE IS EXACTLY ONE THING IT STILL HAS TO STRIP ═══
   *
   * DISCORD RENDERS NO MARKUP IN FOOTER TEXT — no code span, no masked link, no
   * `<@id>`, no `<t:…>`, and no linkified bare url — so the attack list `inert`
   * exists for has nothing to act on there. NEWLINES ARE THE EXCEPTION: a
   * footer holding one is drawn on two lines, which is the same forgery every
   * other field strips, sitting under the bot's own footer.
   */
  it('flattens the one thing footer text does render', () => {
    const embed = incidentEmbed(incident({ incidentId: `${CASE}\n@everyone  banned` }), null, 'resolved')

    expect(embed.footer?.text).toBe(`${CASE} @everyone banned`)
  })

  /**
   * EMPTY IS ABSENT HERE TOO. Discord refuses `footer: { text: '' }` the way it
   * refuses `thumbnail: { url: '' }`, and `incidentId` comes off a row this repo
   * does not write — so an id that is not a usable string costs the footer
   * rather than the whole moderation record.
   */
  it('leaves the footer off rather than sending an empty one', () => {
    expect('footer' in incidentEmbed(incident({ incidentId: '' }), null, 'resolved')).toBe(false)
    expect(
      'footer' in incidentEmbed(incident({ incidentId: 4181 as unknown as string }), null, 'resolved'),
    ).toBe(false)
    expect(incidentEmbed(incident(), null, 'resolved').footer?.text).toBe(CASE)
  })
})

/* ------------------------------------------------------------------ *
 * The subject's avatar.
 * ------------------------------------------------------------------ */

/**
 * ═══ THE ONE BORROWED VALUE IN THIS MODULE THAT WAS NOT GUARDED ═══
 *
 * `subjectLicense` IS TYPED `string` AND THE ROW IS ANOTHER REPOSITORY'S. Every
 * other value off it is already handled as `unknown` — `inert` and `labelled`
 * both take it, `verdictText` narrows on `action`, `resolvedAt` is
 * range-checked — and this was the exception. `avatarFor` handed it to
 * `discordIdIn` in src/banrole.ts, whose first statement is
 * `banKey.startsWith(prefix)`, so a missing or non-string licence was a
 * `TypeError`.
 *
 * AND IT THREW FROM OUTSIDE EVERY `try` ON THE PATH: past `settle`, past
 * `onRow`, and out of `pollAuditWindow`. The poll's cursor calls all the way
 * down were skipped. See the pass case below, which is where that cost is
 * asserted rather than described.
 */
describe('the avatar for the case s subject', () => {
  const noPlayers: Ddb['players'] = { get: () => Promise.resolve(ok(null)) }
  const noAvatars: Avatars = { urlFor: () => Promise.reject(new Error('never asked')) }

  it('answers with no avatar rather than throwing on a licence that is not one', async () => {
    const unusable: Array<[label: string, licence: unknown]> = [
      ['absent', undefined],
      ['null', null],
      ['a number', 4181],
      ['an object', {}],
      ['a list', []],
      ['empty', ''],
    ]

    for (const [label, licence] of unusable) {
      await expect(avatarFor(noPlayers, noAvatars, licence), label).resolves.toBeNull()
    }

    expect(
      said(stderr, 'an incident carries no usable licence, so the record carries no avatar'),
    ).toBe(true)
  })

  it('still asks the registry for a licence that is one', async () => {
    const asked: string[] = []

    await avatarFor(
      {
        get: (key) => {
          asked.push(key)
          return Promise.resolve(ok(record()))
        },
      },
      { urlFor: () => Promise.resolve(AVATAR) },
      LICENCE,
    )

    expect(asked).toEqual([LICENCE])
  })
})

describe('the button', () => {
  it('points at the console s own path for a case', () => {
    expect(incidentUrl(ORIGIN, CASE)).toBe(`${ORIGIN}/incidents/${CASE}`)
  })

  it('percent-encodes the id, which is the whole contract with the console', () => {
    expect(incidentUrl(ORIGIN, 'a/b?c')).toBe(`${ORIGIN}/incidents/a%2Fb%3Fc`)
  })

  it('is a link button, which needs nothing listening for an interaction', () => {
    const built = incidentRow(ORIGIN, CASE)

    expect(built).toEqual({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: COPY.button,
          url: `${ORIGIN}/incidents/${CASE}`,
        },
      ],
    })

    // A link button carries no custom_id, which is what makes it safe on a
    // message from a poller with no interaction handler anywhere near it.
    expect(JSON.stringify(built)).not.toContain('custom_id')
  })

  /**
   * ═══ THE BUTTON IS BUILT FROM THE PUBLIC CONSOLE AND NEVER FROM THE LOOPBACK ═══
   *
   * `Config.ringmasterUrl` is `http://127.0.0.1:3000` — the server-to-server
   * address the kick relay concatenates onto, on a port closed to the internet.
   * A button built from it opens the CLICKER's own machine, and it fails in the
   * worst available way: a working-looking link, in a permanent record, whose
   * failure looks like a console that is down.
   *
   * THE ORIGIN IS NOW A CONSTANT AND NOT A VARIABLE (src/console.ts), so this
   * module has no config to reach for at all. What is left to guard is the one
   * wiring line that supplies it, which is pinned at the foot of this file.
   */
  it('is a public https origin and never the loopback the relay calls', () => {
    expect(CONSOLE_URL.startsWith('https://')).toBe(true)
    expect(CONSOLE_URL).not.toContain('127.0.0.1')
    expect(CONSOLE_URL).not.toContain('localhost')
    expect(incidentUrl(CONSOLE_URL, CASE).startsWith(`${CONSOLE_URL}/incidents/`)).toBe(true)
  })

  /**
   * Over the cap Discord refuses the whole message — the record with it — and a
   * url cut to fit is a button that silently opens the wrong page. So the button
   * goes and the record stays.
   */
  it('is dropped, loudly, when the url will not fit', () => {
    const long = `https://${'a'.repeat(BUTTON_URL_CAP)}.example`

    expect(incidentRow(long, CASE)).toBeNull()
    expect(said(stderr, 'the console link for an incident was too long for a button')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * The pass.
 * ------------------------------------------------------------------ */

describe('the poll', () => {
  it('posts the record for a case the log says was closed', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()] })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.embed.title).toBe(COPY.resolvedTitle)
    expect(h.sent[0]?.embed.thumbnail?.url).toBe(AVATAR)
    expect(h.sent[0]?.components).toHaveLength(1)
    expect(said(stdout, 'posted the record for a resolved incident')).toBe(true)
  })

  /**
   * ═══ THE AUDIT ROW IS A TRIGGER AND THE INCIDENT ROW IS THE FACT ═══
   *
   * `begin()` writes the row `pending` and `resolve()` updates the same key, so
   * every row this poller sees says `pending` and never says anything else. A
   * poller that waited for `ok` would wait forever; one that read `outcome` at
   * all would be reading a field that cannot answer.
   *
   * TWO DIFFERENT CASES, WHICH IS THE WHOLE OF WHY THIS CASE IS WORTH ANYTHING.
   * It used to point both rows at ONE case, so the per-pass dedupe dropped the
   * second row before anything looked at its `outcome` — and the assertion
   * "exactly one post" was produced by the dedupe rather than by the behaviour
   * under test. Adding `if (row.outcome !== 'pending') continue` to the poller
   * would not have failed it. With two cases, the `failed` row has to survive on
   * its own merits, and that edit takes this to one post instead of two.
   */
  it('never reads the audit row s outcome, which is pending on every row it sees', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [
        row({ outcome: 'pending' }),
        row({ ts: NOW - 50_000, outcome: 'failed', detail: { incidentId: OTHER_CASE } }),
      ],
      cases: { [CASE]: incident(), [OTHER_CASE]: incident({ incidentId: OTHER_CASE }) },
    })

    await h.log.poll()

    // Two rows, two cases, two posts. The `failed` one is posted about exactly
    // like the other, because the incident row is what was asked.
    expect(h.sent).toHaveLength(2)
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([CASE, OTHER_CASE])
  })

  /**
   * ═══ A CASE THE TABLE STILL CALLS PENDING IS HELD, NOT SKIPPED ═══
   *
   * A resolve that failed or lost its race leaves the case at `pending_review`,
   * and posting "resolved" about one of those would put a claim in the
   * moderation record that the console itself does not make. That much was
   * always true. What used to happen next is the whole of this case: the cursor
   * ADVANCED past the row, one warn line went out, and that case was never
   * looked at again — `IncidentLog` exposes `poll()` and nothing else, so there
   * is no reconcile to find it later the way the ban role finds an expiry. One
   * moderation record, gone, with the suite green.
   *
   * THE READ BEHIND THIS CANNOT BE STALE — `incidents.get` is strongly
   * consistent (src/ddb.ts) — so there is no version of this where the answer is
   * "wait a moment for a replica". Either the case really is open, or the
   * closure is about to be retried. Both are reasons to ask again rather than to
   * move on, so the cursor stays where it was.
   *
   * THE SECOND ROW IS HERE TO SEPARATE HOLDING FROM SKIPPING. The walk is
   * ordered and the cursor is one number, so a held row holds back everything
   * behind it; treating the pending case as dealt with would post the case
   * behind it and leave the cursor past both.
   */
  it('holds the pass behind a case the incident table still calls pending', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row(), row({ ts: NOW - 50_000, detail: { incidentId: OTHER_CASE } })],
      cases: {
        [CASE]: incident({ state: 'pending_review' }),
        [OTHER_CASE]: incident({ incidentId: OTHER_CASE }),
      },
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(said(stderr, 'an incident.resolve row is about a case that is not resolved')).toBe(true)

    // Behind the row it could not settle, so the next pass sees it again — and
    // nothing was written at all, not even for the row in front of it.
    expect(h.cursor()).toBe(Number(OPEN))
    expect(h.writes).toEqual([])
  })

  /**
   * WHAT THE HOLD IS FOR, END TO END. The disagreement is one an admin fixes by
   * closing the case again, and the only thing standing between that retry and a
   * record that never existed is a cursor that did not move over the row.
   */
  it('posts that same case on a later pass once the console catches up', async () => {
    const cases: Record<string, Incident> = { [CASE]: incident({ state: 'pending_review' }) }
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()], cases })

    await h.log.poll()
    expect(h.sent).toHaveLength(0)

    // The resolve lands on a retry. The row is still inside the window, because
    // the cursor never moved over it.
    cases[CASE] = incident()
    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.embed.footer?.text).toBe(CASE)
    expect(h.cursor()).toBe(NOW - 60_000)
  })

  /**
   * ═══ AND THE OTHER SIDE OF THE BOUND ═══
   *
   * HOLDING FOREVER IS THE SAME LOSS BY A SLOWER ROUTE. One case that is never
   * going to be resolved would sit at the head of an ordered walk silencing
   * every record behind it for as long as the bot runs. So `PENDING_HOLD_MS`
   * ends it: an `error` naming the case — loud, because a record is being given
   * up on — and the cursor moves. The closure is in the console's own `/audit`
   * either way, which is what makes a person the recovery here.
   */
  it('gives up loudly on a case that has stayed unresolved past the bound', async () => {
    const stale = row()
    let clock = NOW
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [stale],
      cases: { [CASE]: incident({ state: 'pending_review' }) },
      now: () => clock,
    })

    // First sight starts the clock and holds. THE BOUND CANNOT FIRE HERE — that
    // is the whole of the outage fix below.
    await h.log.poll()
    expect(h.cursor()).toBe(Number(OPEN))

    // Fifteen minutes of this poller running, and it gives up.
    clock = NOW + PENDING_HOLD_MS
    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(
      said(
        stderr,
        'an incident.resolve row named an unresolved case for too long, so the incident poll moved past it and no record was posted',
      ),
    ).toBe(true)
    expect(h.cursor()).toBe(stale.ts)
  })

  /**
   * THE LAST MOMENT OF THE HOLD, so the bound is a bound and not a rounding.
   * One millisecond short of `PENDING_HOLD_MS` since FIRST SIGHT is still held.
   */
  it('is still holding a case one millisecond short of the bound', async () => {
    let clock = NOW
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      cases: { [CASE]: incident({ state: 'pending_review' }) },
      now: () => clock,
    })

    await h.log.poll()
    clock = NOW + PENDING_HOLD_MS - 1
    await h.log.poll()

    expect(said(stderr, 'an incident.resolve row is about a case that is not resolved')).toBe(true)
    expect(h.cursor()).toBe(Number(OPEN))
  })

  /**
   * ═══ THE HOLD IS MEASURED FROM THIS POLLER, NOT FROM THE CONSOLE'S STAMP ═══
   *
   * THE BUG. `settle` took the audit row's own `ts` and computed
   * `now() - triggeredAt`, so the bound was measured against the CONSOLE'S clock
   * — when the case was closed over there, not when this bot first looked at it.
   * After any outage or deploy gap longer than fifteen minutes, every pending
   * case in the backlog was already past the bound the first time it was seen:
   * one pass, one `error` each, cursor moved, records gone, and not one of them
   * retried once.
   *
   * WHICH IS EXACTLY THE CASE THE HOLD EXISTS FOR. A `pending_review` on a
   * strongly consistent read is the two repositories disagreeing, and the fix is
   * an admin closing the case again — during a window this poller is RUNNING.
   * Time the bot spent switched off is not time anybody had to notice.
   *
   * THE FIXTURE IS AN HOUR-LONG GAP AND THREE GENUINELY PENDING CASES, because
   * the old code dropped all three in a single pass and a one-row fixture cannot
   * tell "gave up on the head of the walk" apart from "gave up on the backlog".
   */
  it('retries every pending case in a backlog, however long the bot was down', async () => {
    const gap = 3_600_000
    const cases = ['case-a', 'case-b', 'case-c']

    const audit = cases.map((id, i) =>
      row({ ts: NOW - gap + i * 1000, detail: { incidentId: id } }),
    )

    const pending = Object.fromEntries(
      cases.map((id) => [id, incident({ incidentId: id, state: 'pending_review' })]),
    )

    let clock = NOW
    const h = harness({
      state: { [CURSOR_KEY]: String(NOW - gap - 1000) },
      audit,
      cases: pending,
      now: () => clock,
    })

    await h.log.poll()

    // Held, all three, behind the first of them. Nothing given up on.
    expect(h.cursor()).toBe(NOW - gap - 1000)
    expect(
      said(
        stderr,
        'an incident.resolve row named an unresolved case for too long, so the incident poll moved past it and no record was posted',
      ),
    ).toBe(false)

    // The admin closes them a minute later, which is the retry the hold is for.
    clock = NOW + 60_000
    for (const id of cases) pending[id] = incident({ incidentId: id })

    await h.log.poll()

    // Every record the old code would have dropped, posted.
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual(cases)
  })

  it('says so when the log names a case the table does not have', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()], cases: {} })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(said(stderr, 'an incident.resolve row names a case that is not in the table')).toBe(true)
  })

  /**
   * ═══ ONE PERMANENT BAN IS NOT FIFTY EMBEDS ═══
   *
   * The sweep after a permanent ban closes every other open case about the
   * player and writes a row for each. This is the assertion that the drop
   * happens BEFORE the incident is read, so fifty closures are not even fifty
   * DynamoDB round trips.
   */
  it('drops the closures a ban swept up and posts only the case it was issued from', async () => {
    const swept = Array.from({ length: 20 }, (_, i) =>
      row({
        ts: NOW - 50_000 + i,
        detail: { incidentId: `swept-${String(i)}`, becauseOf: 'ban.issue' },
      }),
    )

    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row(), ...swept] })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.embed.footer?.text).toBe(CASE)
    expect(h.reads).toEqual([CASE])
  })

  it('ignores every audit verb that is not about an incident', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [
        row({ ts: NOW - 70_000, action: 'ban.issue', detail: undefined }),
        row({ ts: NOW - 65_000, action: 'player.kick', detail: { becauseOf: 'ban.issue' } }),
        row({ ts: NOW - 60_000, action: 'maintenance.deploy', detail: undefined }),
      ],
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(h.reads).toEqual([])
    // The cursor still moves over them: they were dealt with.
    expect(h.cursor()).toBe(NOW - 60_000)
  })

  it('says so when a resolve row names no incident at all', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row({ detail: {} })] })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(said(stderr, 'an incident.resolve row names no incident, so nothing was posted')).toBe(
      true,
    )
  })

  /* ---------------------------------------------------------------- *
   * A case nobody acted on.
   * ---------------------------------------------------------------- */

  /**
   * ═══ THE OWNER'S ANSWER TO OPEN QUESTION 1 ON blitz-bot#19 ═══
   *
   * "We don't need anything posted if no action was taken." A case an admin
   * closed having decided nothing was warranted is not worth a line in the
   * moderation record.
   *
   * THE READ STILL HAPPENS AND THERE IS NO VERSION IN WHICH IT DOES NOT. The
   * verdict is on the INCIDENT row and the trigger is an audit row, so the
   * filter cannot sit where `closedByABan` sits and cannot save a round trip.
   * `reads` is asserted so that a later "optimisation" that tries to decide this
   * from `detail.verdict` — a field the console writes for its own reasons and
   * this repo does not trust — fails here.
   */
  it('posts nothing about a case an admin closed having decided nothing was warranted', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      cases: { [CASE]: incident({ verdict: { action: 'none' } }) },
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(h.reads).toEqual([CASE])
    expect(said(stdout, 'a case was closed with no action taken, so no record was posted')).toBe(
      true,
    )

    /**
     * ═══ AND THE CURSOR MOVED, WHICH IS HALF OF WHAT THIS CASE IS FOR ═══
     *
     * SKIPPING IS A DECISION AND NOT A FAILURE. `settle` has one step for each —
     * `'quiet'` moves the cursor, `'stop'` holds the walk behind the row — and
     * answering with the failure step here would park an ordered walk behind the
     * first no-action case for the life of the process. Nothing after it would
     * ever be posted and no line anywhere would say so.
     */
    expect(h.cursor()).toBe(NOW - 60_000)
  })

  /** The other half: a halted feed is only visible from the row behind it. */
  it('posts the case behind one it passed over', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row(), row({ ts: NOW - 50_000, detail: { incidentId: OTHER_CASE } })],
      cases: {
        [CASE]: incident({ verdict: { action: 'none' } }),
        [OTHER_CASE]: incident({ incidentId: OTHER_CASE }),
      },
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.embed.footer?.text).toBe(OTHER_CASE)
    expect(h.cursor()).toBe(NOW - 50_000)
  })

  /**
   * ═══ THE TRAP THE SKIP IS ONE MISTAKE AWAY FROM ═══
   *
   * ABSENT AND `null` ARE NOT `{ action: 'none' }`. A case resolved before the
   * field existed carries no attribute and one auto-resolved at open carries an
   * explicit `null`, and on neither did anybody record a decision. A filter that
   * read them as "an admin decided nothing was needed" would drop a permanent
   * record on the strength of a decision nobody made — the same conflation
   * `verdictText` has always refused, now with a record rather than a field
   * riding on it.
   */
  it('still posts a case whose row records no verdict at all', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row(), row({ ts: NOW - 50_000, detail: { incidentId: OTHER_CASE } })],
      cases: {
        [CASE]: incident({ verdict: undefined }),
        [OTHER_CASE]: incident({ incidentId: OTHER_CASE, verdict: null }),
      },
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(2)
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([CASE, OTHER_CASE])
    expect(h.sent.map((s) => field(s.embed, COPY.verdict))).toEqual([
      COPY.verdictUnknown,
      COPY.verdictUnknown,
    ])
  })

  /* ---------------------------------------------------------------- *
   * The avatar.
   * ---------------------------------------------------------------- */

  /**
   * `subjectLicense` IS ALREADY THE QUALIFIED KEY SHAPE, so nothing qualifies it
   * again. `license:license:abc` is a perfectly valid GetItem that finds nothing,
   * and "this player has no Discord account" would then be said about everybody.
   */
  it('looks the player up under the licence exactly as the incident stores it', async () => {
    const seen: string[] = []
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      players: { [LICENCE]: record() },
    })

    // The registry read is observable through the avatar that comes back.
    await h.log.poll()
    seen.push(h.sent[0]?.embed.thumbnail?.url ?? '')

    expect(seen).toEqual([AVATAR])
  })

  /**
   * THE PLAYER MOST LIKELY TO HAVE NO DISCORD ID IS EXACTLY THE ONE BEING
   * BANNED: FiveM reports one only when the activity integration is switched on,
   * which is opt-in. The record still posts.
   */
  it('posts the case anyway when the game has no Discord account for the player', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      players: { [LICENCE]: record({ identifiers: {} }) },
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.embed.thumbnail).toBeUndefined()
  })

  /**
   * ═══ THE SILENT LOSS: ONE ROW WITH NO LICENCE AND THE FEED WAS OVER ═══
   *
   * WHAT IT DID, AND WHY NOTHING CAUGHT IT. `avatarFor` is called BEFORE the
   * `try` that wraps the send, so its `TypeError` — out of
   * `banKey.startsWith(prefix)` in src/banrole.ts, on a `subjectLicense` the
   * type says is a string and another repository actually writes — was not a
   * failed send and was not a failed read. It left `settle`, left `onRow`, and
   * left `pollAuditWindow`, which awaited its consumer bare. The pass rejected,
   * so the cursor was never written, so the next pass read the same window,
   * reached the same row and threw again: every closed case from that moment on
   * lost, for the life of the process, with one line every half minute.
   *
   * THE SECOND ROW IS THE WHOLE CASE. With one row in the fixture, "posted it
   * without an avatar" and "died on it" both end with the pass over; the
   * assertion that separates them is that the record BEHIND it posts and the
   * cursor moves over both.
   */
  it('posts the record for a case whose licence is not a string, and the one behind it', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row(), row({ ts: NOW - 50_000, detail: { incidentId: OTHER_CASE } })],
      cases: {
        [CASE]: incident({ subjectLicense: undefined as unknown as string }),
        [OTHER_CASE]: incident({ incidentId: OTHER_CASE }),
      },
    })

    await expect(h.log.poll()).resolves.toBeUndefined()

    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([CASE, OTHER_CASE])
    // The case with no licence is a case with no thumbnail, and nothing else.
    expect(h.sent[0]?.embed.thumbnail).toBeUndefined()
    expect(h.sent[1]?.embed.thumbnail?.url).toBe(AVATAR)
    expect(h.cursor()).toBe(NOW - 50_000)
    expect(
      said(stderr, 'an incident carries no usable licence, so the record carries no avatar'),
    ).toBe(true)
  })

  /**
   * ═══ A NUMBER OFF SOMEBODY ELSE'S ROW WAS BLAMED ON DISCORD FOR 29 PASSES ═══
   *
   * `resolvedAt` IS RANGE-CHECKED NOW AND WAS ONLY CHECKED FOR FINITENESS, and
   * `Number.isFinite(1e16)` is `true` while `new Date(1e16).toISOString()`
   * throws. The throw happened while the embed was being BUILT — inside the
   * `try` around the send — so the walk read it as a channel that would not take
   * the message: a strike on the case, `stop` on the row, the feed held behind
   * it for `FAULT_LIMIT` passes, and then the record dropped with a line in the
   * owner's status channel about a send that never happened.
   *
   * SO THE ASSERTION IS THE POST AND THE SILENCE TOGETHER. The record goes out
   * on the FIRST pass, with the unusable stamp left off, and nothing anywhere
   * says Discord refused anything.
   */
  it('posts a case whose closing stamp is out of range instead of blaming Discord for it', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      cases: { [CASE]: incident({ resolvedAt: 1e16 }) },
    })

    await expect(h.log.poll()).resolves.toBeUndefined()

    expect(h.sent).toHaveLength(1)
    expect('timestamp' in (h.sent[0]?.embed ?? {})).toBe(false)
    expect(h.cursor()).toBe(NOW - 60_000)
    expect(said(stderr, 'could not post the record for a resolved incident')).toBe(false)
  })

  /**
   * ═══ A REGISTRY THAT DID NOT ANSWER STILL COSTS NO RECORD ═══
   *
   * WHAT THIS PAIR OF CASES ACTUALLY COVERS, STATED HONESTLY. `discordIdFor`
   * returns `string | null | 'failed'`, and on THIS path the last two are
   * deliberately the same outcome: `avatarFor` returns null for both and the
   * embed goes out without a thumbnail, by design — an avatar is decoration and
   * the case, its subject and its verdict are the record. So collapsing
   * `'failed'` into `null` at the source changes nothing this file can see, and
   * these two cases do not and cannot claim otherwise. THE PLACE THE TWO
   * ANSWERS MUST NOT COLLAPSE IS src/banrole.ts, where `'failed'` stops the pass
   * and `null` marks nobody and moves on, and it is pinned in
   * src/banrole.test.ts.
   *
   * WHAT THEY DO PIN IS THE LINE, and that is worth a case each: a read that
   * failed says so in the owner's status channel, in this caller's own words,
   * so a thumbnail missing for a reason somebody could fix is distinguishable
   * from one missing because there is nothing to show. The case below is the
   * silent half of that pair.
   */
  it('posts the case anyway when the registry read fails', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      playerGet: () => Promise.resolve(failed('timeout')),
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.embed.thumbnail).toBeUndefined()
    expect(
      said(stderr, 'could not read the player registry, so no Discord account was resolved'),
    ).toBe(true)

    // And the cursor still moves: a record that posted is a record that posted.
    expect(h.cursor()).toBe(NOW - 60_000)
  })

  /**
   * THE SILENT HALF OF THE PAIR ABOVE, AND THE SAME EMBED. An empty registry is
   * a player the game has never seen a Discord account for — the ordinary,
   * permanent case for anybody with the activity integration switched off — so
   * there is nothing wrong and nothing is said. The record it produces is
   * identical to the one above; the difference these two cases hold in place is
   * in the status channel, not in the post.
   */
  it('says nothing at all when the registry simply has no account for the player', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()], players: {} })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.embed.thumbnail).toBeUndefined()
    expect(
      said(stderr, 'could not read the player registry, so no Discord account was resolved'),
    ).toBe(false)
  })

  it('posts the case anyway when Discord will not answer about the account', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      avatarFails: new Error('Unknown User'),
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.embed.thumbnail).toBeUndefined()
    expect(
      said(stdout, 'Discord would not answer about the offender, so the record carries no avatar'),
    ).toBe(true)
  })

  /* ---------------------------------------------------------------- *
   * The button, through a whole pass.
   * ---------------------------------------------------------------- */

  it('puts the console s own page for the case behind the button', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()] })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(JSON.stringify(h.sent[0]?.components)).toContain(`${ORIGIN}/incidents/${CASE}`)
    expect(JSON.stringify(h.sent[0])).not.toContain('127.0.0.1')
  })

  /**
   * ═══ THE BUTTON IS BUILT FROM THE ID THE TABLE WAS ASKED FOR ═══
   *
   * IT USED TO BE `incident.incidentId`, WHICH IS ANOTHER REPOSITORY'S ATTRIBUTE
   * AND WAS NOT GUARDED. `encodeURIComponent` coerces rather than refusing, so an
   * id of `42` posted a live-looking button at `/incidents/42` and `null` posted
   * one at `/incidents/null` — a permanent record carrying a link to a case that
   * does not exist, which reads to whoever presses it as a console that is down.
   *
   * AND THE FALLBACK WENT AT THE SAME MOMENT, WHICH IS WHY THE FOOTER IS ASSERTED
   * HERE TOO. `short` refuses a non-string, so the footer correctly drops the id —
   * meaning the record lost its only other way back to the case at exactly the
   * moment the button was pointing at the wrong one. The button is now right and
   * the footer is still empty, so the two halves are asserted apart.
   *
   * `incidentIdOf`'S ANSWER CANNOT DISAGREE WITH THE ROW THAT WAS FETCHED, because
   * it IS the key `incidents.get` was called with. That is the whole reason it is
   * preferred to guarding the row's copy.
   */
  it('builds the button from the id it queried, not from the copy on the row', async () => {
    for (const carried of [42 as unknown as string, null as unknown as string, '']) {
      stderr.length = 0

      const h = harness({
        state: { [CURSOR_KEY]: OPEN },
        audit: [row()],
        cases: { [CASE]: incident({ incidentId: carried }) },
      })

      await h.log.poll()

      const label = JSON.stringify(carried) ?? String(carried)

      expect(h.sent, label).toHaveLength(1)
      expect(JSON.stringify(h.sent[0]?.components), label).toContain(
        `${ORIGIN}/incidents/${CASE}`,
      )
      // The three shapes the row's own copy took, none of which may reach a url.
      expect(JSON.stringify(h.sent[0]?.components), label).not.toContain('/incidents/42')
      expect(JSON.stringify(h.sent[0]?.components), label).not.toContain('/incidents/null')

      // The footer is the traceability fallback and it is genuinely gone here,
      // which is the fact the button had to stop depending on.
      expect('footer' in (h.sent[0]?.embed ?? {}), label).toBe(false)

      expect(
        said(stderr, 'an incident row carries an id that is not the key it was read by'),
        label,
      ).toBe(true)
    }
  })

  /** The ordinary row agrees with its key, and nothing is said about it. */
  it('says nothing about the id when the row agrees with the key it was read by', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()] })

    await h.log.poll()

    expect(h.sent[0]?.embed.footer?.text).toBe(CASE)
    expect(said(stderr, 'an incident row carries an id that is not the key it was read by')).toBe(
      false,
    )
  })

  /**
   * A URL OVER DISCORD'S CAP MAKES IT REFUSE THE WHOLE MESSAGE — the embed with
   * it — so the button goes and the record stays. That is the one path left on
   * which a record posts with no button at all.
   */
  it('posts the record without its button rather than losing the record', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      origin: `https://${'a'.repeat(BUTTON_URL_CAP)}.example`,
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.components).toEqual([])
    expect(said(stderr, 'the console link for an incident was too long for a button')).toBe(true)
  })

  /* ---------------------------------------------------------------- *
   * The cursor.
   * ---------------------------------------------------------------- */

  /**
   * ═══ A RESTART RESUMES; IT DOES NOT REPLAY ═══
   *
   * The bot restarts on every deploy and every crash. A channel that
   * re-announces the backlog each time is unreadable, and the cursor is the only
   * thing standing between the two.
   */
  /**
   * ═══ A CRASH MID-PASS MUST NOT REPLAY EVERY RECORD THE PASS POSTED ═══
   *
   * THE CURSOR IS WRITTEN AFTER EVERY RECORD, NOT ONCE AT THE END. A pass may
   * post up to `MAX_POSTS` records, and a single write after the loop means a
   * crash or a deploy restart between the last send and that write replays ALL of
   * them into the moderation channel on the next pass. Ten duplicate moderation
   * records is loud, and it is the failure that happens on the exact day the
   * channel is busy — a backlog being drained is when a deploy is most likely to
   * land on top of one.
   *
   * DRIVEN OFF A SNAPSHOT OF THE STATE TABLE TAKEN THE INSTANT EACH RECORD
   * LANDED, which is precisely what a crash leaves behind: everything written
   * before that moment and nothing after it. A second poller is then started from
   * the snapshot, exactly as the process would come back up. With one write at the
   * end of the pass the snapshot still carries the ORIGINAL cursor and the
   * resumed poller replays all five; with the write per record it replays one.
   *
   * ONE DUPLICATE IS THE ACCEPTED COST AND IT IS NOT ZERO. The cursor is written
   * after the send returns, so a crash between the two repeats that record. The
   * alternative — writing first — loses a record instead, and a moderation record
   * that never existed with nothing saying so is the worse failure.
   */
  it('resumes after the last record it actually posted, not the last completed pass', async () => {
    const audit = Array.from({ length: 5 }, (_, i) =>
      row({ ts: NOW - 300_000 + i, detail: { incidentId: `case-${String(i)}` } }),
    )
    const cases = Object.fromEntries(
      audit.map((_, i) => [`case-${String(i)}`, incident({ incidentId: `case-${String(i)}` })]),
    )

    // What was on the table the instant each record landed in the channel.
    const snapshots: Array<Record<string, string>> = []

    const first = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit,
      cases,
      afterSend: (table) => snapshots.push(Object.fromEntries(table)),
    })

    await first.log.poll()
    expect(first.sent).toHaveLength(5)

    // The crash: the process dies just after the third record is posted.
    const resumed = harness({ state: snapshots[2] ?? {}, audit, cases })
    await resumed.log.poll()

    expect(resumed.sent.map((s) => s.embed.footer?.text)).toEqual(['case-2', 'case-3', 'case-4'])
  })

  it('posts each closed case exactly once across restarts', async () => {
    const state: Record<string, string> = { [CURSOR_KEY]: OPEN }
    const audit = [row(), row({ ts: NOW - 50_000, detail: { incidentId: OTHER_CASE } })]
    const cases = { [CASE]: incident(), [OTHER_CASE]: incident({ incidentId: OTHER_CASE }) }

    const first = harness({ state, audit, cases })
    await first.log.poll()
    expect(first.sent).toHaveLength(2)

    // A restart: a brand new poller, the same DynamoDB row.
    const resumed = harness({ state: Object.fromEntries(first.state), audit, cases })
    await resumed.log.poll()
    await resumed.log.poll()

    expect(resumed.sent).toHaveLength(0)
    expect(resumed.cursor()).toBe(NOW - 50_000)
  })

  /**
   * THE FIRST EVER START RECORDS WHERE IT CAME IN AND POSTS NOTHING. Beginning
   * at the start of the log would announce months of closed cases into the
   * moderation channel, once, and it would be the once that made the channel
   * useless.
   */
  it('starts from now on its first ever pass rather than from the beginning', async () => {
    const h = harness({ audit: [row()] })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(h.cursor()).toBe(NOW - SETTLE_MS)
    expect(
      said(
        stdout,
        'no incident poll cursor yet, so cases resolved from now on will be posted and earlier ones will not',
      ),
    ).toBe(true)
  })

  it('restarts from now when the stored cursor is not a number', async () => {
    const h = harness({ state: { [CURSOR_KEY]: 'yesterday' }, audit: [row()] })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(h.cursor()).toBe(NOW - SETTLE_MS)
    expect(
      said(
        stderr,
        'the incident poll cursor is not a position in the log, so polling restarts from now',
      ),
    ).toBe(true)
  })

  /**
   * ═══ AN EMPTY CURSOR REPLAYED THE ENTIRE AUDIT HISTORY INTO THE CHANNEL ═══
   *
   * THE BUG, EXACTLY. The walk read the bookmark as
   * `raw === null ? null : Number(raw)` and rejected it with
   * `!Number.isFinite(parsed)`. `Number('')` is `0` and `0` is finite, so an
   * empty bot-state row was NOT "no cursor, start from now" — it was a cursor at
   * the epoch. `auditWindow.since(0, …)` then answered with the oldest fifty
   * rows in the partition and this poller posted the ten oldest closed cases
   * into the moderation channel, then ten more every half minute until it caught
   * up with the present. No attacker, no outage, no bad deploy: one row with an
   * empty value.
   *
   * THE FIXTURE IS THE REAL SHAPE OF THE DISASTER — a long backlog of closed
   * cases and a cursor that folds to zero — because the assertion that matters
   * is not "the cursor was rejected", it is "nothing was posted". A guard that
   * rejected the value and then walked from zero anyway would pass a test that
   * only read the log line.
   */
  it('posts nothing at all when an empty cursor sits in front of a long history', async () => {
    const ancient = Array.from({ length: 120 }, (_, i) =>
      row({ ts: NOW - 30 * 86_400_000 + i * 60_000, detail: { incidentId: `case-${String(i)}` } }),
    )

    const h = harness({ state: { [CURSOR_KEY]: '' }, audit: ancient })

    await h.log.poll()

    // The whole of it. Ten of these in the moderation channel is the failure.
    expect(h.sent).toEqual([])
    // And the log was never read, so there was nothing to post FROM.
    expect(h.windows).toEqual([])
    expect(h.cursor()).toBe(NOW - SETTLE_MS)
  })

  /**
   * EVERY VALUE A HAND-MADE ROW CAN HOLD, NOT JUST `null`. `BotStateRow.value`
   * is typed `string` and src/ddb.ts casts the item rather than parsing it, over
   * a table docs/aws-notes.md says was created by hand — so the type is a claim
   * about what we write and says nothing about what comes back. Each of these
   * was a finite number through the old `Number()` and therefore a bookmark
   * somewhere around 1970; the last two are not strings at all and only reach
   * this code because nothing between DynamoDB and here checks.
   */
  it('treats every shape a hand-made bot-state row can hold as no cursor', async () => {
    const shapes: Array<[label: string, stored: unknown]> = [
      ['empty', ''],
      ['blank', ' '],
      ['zero', '0'],
      ['padded zero', '  0  '],
      ['negative', '-1'],
      ['a boolean', false],
      ['a true boolean', true],
      ['an empty list', []],
      ['a list holding a stamp', [NOW - 3_600_000]],
    ]

    for (const [label, stored] of shapes) {
      const h = harness({
        audit: [row()],
        stateGet: (key) =>
          Promise.resolve(
            ok({ id: key, value: stored, updatedAt: NOW - 1 } as unknown as BotStateRow),
          ),
      })

      await h.log.poll()

      expect(h.sent, label).toEqual([])
      expect(h.windows, label).toEqual([])
      // Recorded where it came in, which is what "no cursor" has always meant.
      expect(h.writes, label).toEqual([{ key: CURSOR_KEY, value: String(NOW - SETTLE_MS) }])
    }
  })

  /**
   * THE CURSOR MOVES ONLY OVER RECORDS THAT WERE ACTUALLY POSTED. A send that
   * failed and a cursor that moved past it is a moderation record that never
   * existed with nothing anywhere saying so; this way the worst case is one
   * duplicate embed on a send that failed after Discord had accepted it.
   */
  it('stays behind a record it could not post, so the next pass tries again', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      sendFails: new Error('Missing Permissions'),
    })

    await h.log.poll()

    expect(h.cursor()).toBe(Number(OPEN))
    expect(said(stderr, 'could not post the record for a resolved incident')).toBe(true)
  })

  it('stays behind a case it could not read', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      caseGet: () => Promise.resolve(failed()),
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(h.cursor()).toBe(Number(OPEN))
    expect(said(stderr, 'could not read an incident, so nothing was posted about it')).toBe(true)
  })

  /**
   * ═══ AND A PERMANENT FAULT MUST NOT JAM THE FEED FOREVER, SILENTLY ═══
   *
   * WHAT `stop` HAS NO ANSWER FOR. Holding the cursor behind a row is right for
   * a timeout and has no bound for a channel the bot has lost Send Messages in,
   * an embed Discord refuses every time, or an IAM grant somebody removed. Any
   * of those is a `stop` on the same row on every pass for the life of the
   * process: the moderation channel simply goes quiet, and the only evidence is
   * a status line that `statusReporter` folds after its window. Nobody is told
   * that every record after this one is being lost.
   *
   * THE ROW BEHIND THE FAILING ONE IS THE WHOLE CASE. With one row in the
   * fixture, "gave up on it" and "still stuck on it" both end with the walk over
   * and nothing sent; the assertion that separates them is that the NEXT record
   * posts. That is what the bound buys — one record dropped loudly instead of
   * every later record dropped silently.
   */
  it('gives up loudly on a case it has failed on every pass, and posts the next one', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      // The unreadable case at the head of the walk, and a perfectly good record
      // behind it — the one that was being lost, every pass, with nothing said.
      audit: [row({ detail: { incidentId: OTHER_CASE } }), row({ ts: NOW - 30_000 })],
      caseGet: (id) => Promise.resolve(id === OTHER_CASE ? failed() : ok(incident())),
    })

    // Every pass but the last stops on the same case and posts nothing at all.
    for (let pass = 1; pass < FAULT_LIMIT; pass++) {
      await h.log.poll()
      expect(h.sent, `pass ${String(pass)}`).toHaveLength(0)
      expect(h.cursor(), `pass ${String(pass)}`).toBe(Number(OPEN))
    }

    await h.log.poll()

    // The bound: said unmistakably, and past it.
    expect(
      said(
        stderr,
        'the incident poll failed on the same case every pass, so it moved past it and no record was posted',
      ),
    ).toBe(true)

    // AND THE FEED IS MOVING AGAIN. The record behind the jam is posted on the
    // same pass, which is the thing that was being lost silently.
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([CASE])
    expect(h.cursor()).toBe(NOW - 30_000)
  })

  /**
   * THE SAME BOUND ON THE OTHER FAULT, because a channel the bot cannot post in
   * is the likelier of the two: `logChannelPosts` throws on a missing or
   * unsendable channel, and a permission override is one click.
   */
  it('gives up loudly on a record it has failed to send every pass', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      sendFails: new Error('DiscordAPIError[50013]: Missing Permissions'),
    })

    for (let pass = 1; pass < FAULT_LIMIT; pass++) {
      await h.log.poll()
      expect(h.cursor(), `pass ${String(pass)}`).toBe(Number(OPEN))
    }

    await h.log.poll()

    expect(
      said(
        stderr,
        'the incident poll failed on the same case every pass, so it moved past it and no record was posted',
      ),
    ).toBe(true)
    expect(h.cursor()).toBe(NOW - 60_000)
  })

  /**
   * ═══ THE BOUND MUST NOT COST THE THING `stop` IS FOR ═══
   *
   * A TRANSIENT FAULT IS STILL A RETRY. The whole reason a failed read holds the
   * cursor is that the next pass usually works, and a bound written carelessly —
   * one that gave up after the first fault, or that counted faults across
   * different cases into one budget — would turn every DynamoDB blip into a lost
   * moderation record, which is worse than the jam it was added to fix.
   *
   * WHAT IT DOES NOT ASSERT, DELIBERATELY. Nothing here proves the count is
   * CONSECUTIVE rather than a running total, because nothing can: a case that
   * posts leaves the walk and is never offered again, so there is no history in
   * which the two differ. `FAULT_LIMIT` says that rather than implying more.
   */
  it('retries a case that failed once, and posts every record behind it', async () => {
    let fail = true

    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row(), row({ ts: NOW - 30_000, detail: { incidentId: OTHER_CASE } })],
      caseGet: (id) => {
        if (!fail) return Promise.resolve(ok(incident({ incidentId: id })))
        fail = false
        return Promise.resolve(failed())
      },
    })

    // One blip, then a healthy table for far longer than the budget.
    for (let pass = 0; pass < FAULT_LIMIT + 5; pass++) await h.log.poll()

    expect(
      said(
        stderr,
        'the incident poll failed on the same case every pass, so it moved past it and no record was posted',
      ),
    ).toBe(false)
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([CASE, OTHER_CASE])
  })

  /**
   * AN EMPTY WINDOW IS NOT A REASON TO WRITE. The next pass asks about a WIDER
   * window with the same lower bound, which is a superset — so nothing can be
   * skipped — and advancing anyway would be a DynamoDB write every half minute
   * for the life of an idle bot.
   */
  it('leaves the cursor alone when nothing happened', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [] })

    await h.log.poll()

    expect(h.cursor()).toBe(Number(OPEN))
  })

  it('holds back from its own tail and asks for a bounded page', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN } })

    await h.log.poll()

    expect(h.windows).toEqual([
      { after: Number(OPEN), until: NOW - SETTLE_MS, limit: POLL_LIMIT },
    ])
  })

  it('does nothing at all when the cursor cannot be read', async () => {
    const h = harness({
      audit: [row()],
      stateGet: () => Promise.resolve(failed()),
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(said(stderr, 'could not read the incident poll cursor, so nothing was polled')).toBe(true)
  })

  /**
   * ═══ A BOT-STATE OUTAGE MUST NOT REPLAY EVERYTHING THE PASS POSTED ═══
   *
   * `ringmaster-bot-state` NOT ANSWERING DOES NOT STOP THIS POLLER FROM POSTING,
   * which is what makes this the expensive failure. A pass that reported the
   * failed bookmark and carried on would put all ten records in the channel with
   * all ten bookmarks failing, and the next pass — reading a cursor that never
   * moved — would put the same ten there again. That is the exact replay the
   * per-record write was added to prevent, so the walk stops at the first
   * bookmark that did not land: what has been sent has been sent, and going on
   * only widens what comes back.
   *
   * TWO RECORDS AND NOT ONE, BECAUSE ONE CANNOT TELL THE DIFFERENCE. With a
   * single row in the window, stopping and carrying on both post once and both
   * warn once. The second case is what says the poller stopped.
   */
  it('stops the pass at the first cursor it could not save', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row(), row({ ts: NOW - 50_000, detail: { incidentId: OTHER_CASE } })],
      cases: { [CASE]: incident(), [OTHER_CASE]: incident({ incidentId: OTHER_CASE }) },
      statePut: () => Promise.resolve(failed()),
    })

    await h.log.poll()

    // The first record was posted and its bookmark refused; the second case was
    // never read, never posted, and no second write was attempted.
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([CASE])
    expect(h.reads).toEqual([CASE])
    expect(h.writes).toEqual([{ key: CURSOR_KEY, value: String(NOW - 60_000) }])
    expect(said(stderr, 'the incident poll finished but its cursor could not be saved')).toBe(true)
    // Nothing landed, so the next pass reads the same window again.
    expect(h.cursor()).toBe(Number(OPEN))
  })

  it('says nothing and posts nothing when the audit log cannot be read', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      since: () => Promise.resolve(failed()),
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(said(stderr, 'could not read the audit log, so no incident was posted this pass')).toBe(
      true,
    )
  })

  /* ---------------------------------------------------------------- *
   * The budgets.
   * ---------------------------------------------------------------- */

  /**
   * DISCORD'S RATE LIMITS ARE PER ROUTE AND ARE NOT GENEROUS. A moderator
   * working through a weekend's queue, or this poller catching up after an
   * outage, is exactly the burst that hits them — and the cursor stopping where
   * the posts stopped is what makes a bounded pass safe rather than lossy.
   */
  it('posts at most one pass worth and resumes from where it stopped', async () => {
    const many = Array.from({ length: MAX_POSTS + 5 }, (_, i) =>
      row({ ts: NOW - 300_000 + i, detail: { incidentId: `case-${String(i)}` } }),
    )

    const cases = Object.fromEntries(
      many.map((_, i) => [`case-${String(i)}`, incident({ incidentId: `case-${String(i)}` })]),
    )

    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: many, cases })

    await h.log.poll()

    expect(h.sent).toHaveLength(MAX_POSTS)
    expect(h.cursor()).toBe(NOW - 300_000 + MAX_POSTS - 1)

    await h.log.poll()
    expect(h.sent).toHaveLength(MAX_POSTS + 5)
  })

  /**
   * THE READ BUDGET IS SEPARATE FROM THE POST BUDGET because the two count
   * different things: rows that cost a round trip and produce no post — a case
   * the table does not have, a case still pending — would otherwise be unbounded.
   */
  it('bounds the incident reads a pass may make even when nothing posts', async () => {
    const many = Array.from({ length: MAX_INCIDENT_READS + 10 }, (_, i) =>
      row({ ts: NOW - 300_000 + i, detail: { incidentId: `missing-${String(i)}` } }),
    )

    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: many, cases: {} })

    await h.log.poll()

    expect(h.sent).toHaveLength(0)
    expect(h.reads).toHaveLength(MAX_INCIDENT_READS)
  })

  it('reads one case once however many rows in a window name it', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row(), row({ ts: NOW - 50_000 }), row({ ts: NOW - 40_000 })],
    })

    await h.log.poll()

    expect(h.reads).toEqual([CASE])
    expect(h.sent).toHaveLength(1)
  })

  /**
   * The type says a row always has a sort key and the table is another repo's,
   * so it can arrive without one. Stopping keeps the cursor behind a row that
   * could not be placed; a silent skip is the quiet halt this whole file is
   * written against.
   *
   * THE THIRD ROW IS WHAT MAKES THAT AN ASSERTION. With the broken row last,
   * stopping and skipping are the same run: same posts, same cursor, same line.
   * There is a good case BEHIND it, and the record for it must not appear.
   */
  it('stops loudly at a row it cannot place in the log', async () => {
    // Handed back by `since` directly, because the fake's own window filter
    // would drop a row with no sort key before the poller ever saw one.
    const broken = { ...row({ ts: NOW - 50_000 }), ts: undefined as unknown as number }
    const after = row({ ts: NOW - 40_000, detail: { incidentId: OTHER_CASE } })

    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      since: () => Promise.resolve(ok([row(), broken, after])),
      cases: { [CASE]: incident(), [OTHER_CASE]: incident({ incidentId: OTHER_CASE }) },
    })

    await h.log.poll()

    expect(said(stderr, 'an audit row carries no sort key, so the incident poll stopped')).toBe(true)
    // Only the case in front of the broken row. A skip would have posted both
    // and left the cursor past a row nothing ever dealt with.
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([CASE])
    expect(h.cursor()).toBe(NOW - 60_000)
  })
})

/* ------------------------------------------------------------------ *
 * Wiring.
 * ------------------------------------------------------------------ */

describe('wired to the gateway', () => {
  /** What the real seams were handed, when no watcher is injected. */
  interface Wired {
    readonly sent: Array<{ embeds: APIEmbed[]; components?: unknown[] }>
    readonly fetched: string[]
  }

  function fakeClient(wired?: Wired) {
    const ready: Array<() => void> = []

    const client = {
      on: () => {},
      once: (event: unknown, handler: () => void) => {
        if (event === Events.ClientReady) ready.push(handler)
      },
      channels: {
        fetch: (id: string) => {
          wired?.fetched.push(id)
          return Promise.resolve({
            isSendable: () => true,
            send: (payload: { embeds: APIEmbed[]; components?: unknown[] }) => {
              wired?.sent.push(payload)
              return Promise.resolve()
            },
          })
        },
      },
      users: {
        fetch: () => Promise.resolve({ displayAvatarURL: () => AVATAR }),
      },
    } as unknown as Client

    return { client, ready }
  }

  /**
   * BOTH WATCHERS, ALWAYS, AND THE `polls` LIST RECORDS WHICH ONE RAN.
   *
   * IT USED TO HAND BACK ONE, AND THAT STOPPED BEING SAFE THE MOMENT
   * `installIncidentLog` STARTED TWO POLLERS. A case that injects only the
   * resolved watcher gets a REAL openings poller built over whatever `ddb` it
   * passed — `{}` in most of these — which then throws `TypeError` out of the
   * tick on every pass. The suite stayed green, because the throw lands in the
   * `catch` the tick exists to have; what it cost was a case asserting
   * 'the incident poll threw' that would have passed with the poller under test
   * deleted.
   */
  function fakeWatcher(): {
    watcher: IncidentLog
    openWatcher: IncidentOpenLog
    polls: string[]
  } {
    const polls: string[] = []

    return {
      polls,
      watcher: {
        poll: () => {
          polls.push('resolved')
          return Promise.resolve()
        },
      },
      openWatcher: {
        poll: () => {
          polls.push('filed')
          return Promise.resolve()
        },
      },
    }
  }

  /** The address the kick relay calls, which no link may ever be built from. */
  const LOOPBACK = 'http://127.0.0.1:3000'

  const cfg = (over: Partial<Config> = {}): Config =>
    ({
      logChannelId: '111111111111111111',
      ringmasterUrl: LOOPBACK,
      ...over,
    }) as unknown as Config

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  const noDdb = {} as unknown as IncidentLogDeps['ddb']

  /**
   * A DynamoDB layer with one closed case and one freshly filed one, for the one
   * case below that injects no watcher and therefore makes a real pass of BOTH
   * pollers.
   *
   * BOTH CURSORS ARE SEEDED, which is what makes the second pass do any work.
   * Without `OPEN_CURSOR_KEY` the openings poller takes its first-start branch,
   * writes where it came in and returns without querying anything — correct
   * behaviour, and it would have silently made the loopback assertion below cover
   * one of the two `consoleOrigin` assignments instead of both.
   */
  function wiredDdb(): IncidentLogDeps['ddb'] {
    const state = new Map<string, string>([
      [CURSOR_KEY, OPEN],
      [OPEN_CURSOR_KEY, OPEN],
    ])

    return {
      incidents: {
        get: (id) =>
          Promise.resolve(
            ok(id === CASE ? incident() : id === OTHER_CASE ? openCase({ incidentId: id }) : null),
          ),
        opened: (kind) =>
          Promise.resolve(
            ok({
              keys:
                kind === 'report' ? [{ incidentId: OTHER_CASE, kind, openedAt: NOW - 60_000 }] : [],
              more: false,
            }),
          ),
      },
      players: { get: () => Promise.resolve(ok(record())) },
      botState: {
        get: (key) => {
          const value = state.get(key)
          return Promise.resolve(ok(value === undefined ? null : { id: key, value, updatedAt: NOW }))
        },
        put: (key, value) => {
          state.set(key, value)
          return Promise.resolve(ok({ id: key, value, updatedAt: NOW }))
        },
      },
      auditWindow: {
        partition: 'AUDIT',
        since: () => Promise.resolve(ok([row()])),
        newest: () => Promise.resolve(ok(null)),
      },
    }
  }

  /**
   * BOTH POLLERS, ONCE EACH, IN ORDER. The order is asserted because it is a
   * decision rather than an accident: they run one after the other on one tick so
   * that a catch-up does not put two bursts on the same Discord channel route at
   * once, and a `Promise.all` here would be the version of this that looks
   * identical and behaves differently under load.
   */
  it('polls both halves once as soon as the gateway is up', async () => {
    const { client, ready } = fakeClient()
    const fake = fakeWatcher()

    installIncidentLog(client, cfg(), noDdb, {
      watcher: fake.watcher,
      openWatcher: fake.openWatcher,
    })
    ready[0]?.()
    await settle()

    expect(fake.polls).toEqual(['resolved', 'filed'])
  })

  /**
   * NOTHING AT ALL WITH NO LOG CHANNEL, which is the rule every optional channel
   * in this bot follows and matters most here: with nowhere to post there is
   * nothing to poll for, so `ringmaster-audit` is not read at all and this
   * process makes no AWS call it would otherwise make twice a minute.
   */
  it('registers nothing when there is no channel to post the record in', async () => {
    const { client, ready } = fakeClient()
    const fake = fakeWatcher()

    installIncidentLog(client, cfg({ logChannelId: null }), noDdb, { watcher: fake.watcher, openWatcher: fake.openWatcher })

    expect(ready).toHaveLength(0)
    await settle()
    expect(fake.polls).toHaveLength(0)
  })

  /**
   * ═══ THE ONE LINE NOTHING WAS WATCHING ═══
   *
   * `consoleOrigin: CONSOLE_URL` is the whole of this feature's exposure to the
   * loopback: every other case in this file injects a watcher, so every other
   * case skips the assignment entirely. Somebody could edit it to
   * `config.ringmasterUrl` — or, when it was configuration, add a
   * `?? config.ringmasterUrl` fallback — and the entire suite would stay green
   * while every button in the moderation channel pointed at 127.0.0.1 on the
   * clicker's own machine.
   *
   * SO THIS ONE INJECTS NOTHING. It drives `installIncidentLog` with the real
   * poster, the real avatar lookup and a fake gateway, runs one pass end to end,
   * and reads the button's url off the message that came out. It is the only case
   * here that would fail if that assignment changed.
   */
  it('builds the button from the public console and never from the loopback', async () => {
    const wired: Wired = { sent: [], fetched: [] }
    const { client, ready } = fakeClient(wired)

    installIncidentLog(client, cfg(), wiredDdb(), {})
    ready[0]?.()
    await settle()

    expect(wired.fetched).toEqual(['111111111111111111', '111111111111111111'])

    /**
     * TWO RECORDS AND TWO BUTTONS, WHICH IS WHY THIS CASE IS WORTH KEEPING NOW
     * THAT THERE ARE TWO POLLERS. `consoleOrigin: CONSOLE_URL` is assigned twice
     * in `installIncidentLog`, and every other case in this file injects a
     * watcher and skips both assignments — so a `?? config.ringmasterUrl` added
     * to either one would leave the whole suite green while half the buttons in
     * the moderation channel pointed at the clicker's own machine.
     */
    expect(wired.sent.map((m) => m.embeds[0]?.title)).toEqual([
      COPY.resolvedTitle,
      COPY.filedTitle,
    ])

    const url = JSON.stringify(wired.sent.map((m) => m.components))
    expect(url).toContain(`${CONSOLE_URL}/incidents/${CASE}`)
    expect(url).toContain(`${CONSOLE_URL}/incidents/${OTHER_CASE}`)
    expect(url).not.toContain(LOOPBACK)
    expect(url).not.toContain('127.0.0.1')
    expect(url).not.toContain('localhost')
  })

  /**
   * A PASS THAT THROWS MUST NOT LATCH THE LOOP OFF FOR THE LIFE OF THE PROCESS.
   * `poll` is written not to throw; the `finally` in the tick is the structural
   * guarantee that an edit which makes it throw costs one pass rather than all
   * of them.
   */
  it('survives a pass that throws and polls again', async () => {
    const { client, ready } = fakeClient()
    const fake = fakeWatcher()

    let calls = 0
    const watcher: IncidentLog = {
      poll: () => {
        calls++
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve()
      },
    }

    installIncidentLog(client, cfg(), noDdb, {
      watcher,
      openWatcher: fake.openWatcher,
      pollMs: 1,
    })
    ready[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(said(stderr, 'the incident poll threw')).toBe(true)
    expect(calls).toBeGreaterThan(1)
  })

  /**
   * ONE HALF THROWING MUST NOT TAKE THE OTHER DOWN WITH IT FOREVER. The two run
   * in sequence inside one `try`, so a throw from the first ends that TICK for
   * both — which is the price of the sequence and is fine, because the tick
   * repeats. What must not happen is the loop latching off: `running` is cleared
   * in a `finally`, and this is what says so about the half that did not throw.
   */
  it('goes on polling the other half after one of them throws', async () => {
    const { client, ready } = fakeClient()

    let filed = 0
    let calls = 0

    installIncidentLog(client, cfg(), noDdb, {
      watcher: {
        poll: () => {
          calls++
          return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve()
        },
      },
      openWatcher: {
        poll: () => {
          filed++
          return Promise.resolve()
        },
      },
      pollMs: 1,
    })
    ready[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Not on the first tick — the throw ended it before the openings poll — and
    // on every one after it.
    expect(filed).toBeGreaterThan(0)
    expect(filed).toBe(calls - 1)
  })
})

/* ------------------------------------------------------------------ *
 * The other half: the record for a case that was FILED.
 * ------------------------------------------------------------------ */

/**
 * ═══ WHAT THIS SECTION IS REALLY FOR ═══
 *
 * Each of these is a way for the openings feature to be wrong while every log
 * line and every return value still looks right, and they are the reasons the
 * poller has the shape it has:
 *
 *   THE INDEX MAY NOT EXIST WHEN THIS SHIPS, and it is created by hand. A
 *   `Query` against a missing index fails with a `ValidationException`, which
 *   without `no-such-index` is a generic read failure indistinguishable from a
 *   timeout — and the owner runs this from Discord, not a terminal, so a feature
 *   that quietly does nothing looks exactly like a quiet server;
 *
 *   AN EMPTY ANSWER IS NOT PROOF THAT NOTHING HAPPENED while a new index is
 *   backfilling, so nothing empty may ever move the cursor and the first-start
 *   mark must be written before any query exists;
 *
 *   A KIND NOBODY NAMES IS INVISIBLE, with no error and no empty page — the
 *   index's partition key is `kind`, so the query list is a correctness
 *   constraint and there is a check that fails when it goes stale;
 *
 *   `openedAt` IS A GSI SORT KEY AND GSI SORT KEYS ARE NOT UNIQUE, unlike the
 *   audit log's `ts`, so a cursor advanced to a stamp the pass has not finished
 *   drops the rest of that millisecond for good;
 *
 *   ONE FAILING KIND MUST ABANDON THE WHOLE PASS, because the cursor is one
 *   number across all of them and advancing it past a window one kind was never
 *   asked about loses every case of that kind in it;
 *
 *   and A FILED CASE HAS NO VERDICT AND NO RESOLVER, so those fields must be
 *   absent rather than rendered as an absence of a decision nobody was due to
 *   make.
 */

/** An index row, as `kind-openedAt-index` answers with `KEYS_ONLY`. */
function key(over: Partial<IncidentKey> = {}): IncidentKey {
  return { incidentId: CASE, kind: 'report', openedAt: NOW - 60_000, ...over }
}

interface OpenHarness {
  readonly log: IncidentOpenLog
  readonly state: Map<string, string>
  readonly sent: Sent[]
  /** Every incident row read, in order — the read budget is asserted from this. */
  readonly reads: string[]
  /** Every index query, in order, so the kinds and the window can be asserted. */
  readonly queries: Array<{
    kind: IncidentKind
    after: number
    until: number
    limit: number | undefined
  }>
  readonly writes: Array<{ key: string; value: string }>
  cursor(): number | null
}

function openHarness(
  over: {
    cases?: Record<string, Incident>
    players?: Record<string, PlayerRecord>
    /** Index rows per kind. Filtered against the window, as DynamoDB would. */
    index?: Partial<Record<IncidentKind, IncidentKey[]>>
    /**
     * Stop this kind's page after N rows and report `LastEvaluatedKey` — the
     * short page that is NOT the end of the range. See the fake below.
     */
    pageCut?: Partial<Record<IncidentKind, number>>
    /**
     * A whole page handed back exactly as given: no window filter, and `more`
     * as stated rather than derived.
     *
     * WHAT IT EXERCISES IS THE CAST AND NOT THE TABLE. `opened` in src/ddb.ts
     * ends `res.Items as IncidentKey[]`, over an index on a table this repo does
     * not write, so `openedAt: number` is a claim about another repository's row
     * in exactly the way `AuditRow.ts` is. The window filter in the fake is the
     * ACCESSOR's behaviour; it is not a guarantee about what the attribute holds,
     * and a case about a value that is not a position in the index cannot be
     * written through a fake that only ever answers with positions. `more` is
     * stated for the same reason: DynamoDB's own answer, not the fake's opinion.
     */
    rawIndex?: Partial<Record<IncidentKind, IncidentPage>>
    state?: Record<string, string>
    origin?: string
    avatars?: Record<string, string>
    sendFails?: unknown
    afterSend?: (state: Map<string, string>) => void
    caseGet?: (id: string) => Promise<DdbResult<Incident | null>>
    /** The index read failing, for every kind or for one of them. */
    indexFails?: { kind: DdbFailureKind; onlyFor?: IncidentKind }
    statePut?: (key: string, value: string) => Promise<DdbResult<BotStateRow>>
    stateGet?: (key: string) => Promise<DdbResult<BotStateRow | null>>
    now?: () => number
  } = {},
): OpenHarness {
  const cases = over.cases ?? { [CASE]: openCase() }
  const players = over.players ?? { [LICENCE]: record() }
  const index = over.index ?? {}
  const avatars = over.avatars ?? { [MEMBER]: AVATAR }

  const state = new Map<string, string>(Object.entries(over.state ?? {}))
  const sent: Sent[] = []
  const reads: string[] = []
  const queries: OpenHarness['queries'] = []
  const writes: Array<{ key: string; value: string }> = []

  const deps: IncidentOpenLogDeps = {
    now: over.now ?? (() => NOW),
    consoleOrigin: over.origin ?? ORIGIN,
    avatars: {
      urlFor: (discordId) => {
        const url = avatars[discordId]
        if (url === undefined) return Promise.reject(new Error('Unknown User'))
        return Promise.resolve(url)
      },
    },
    posts: {
      send: (embed, components) => {
        if (over.sendFails !== undefined) return Promise.reject(over.sendFails)
        sent.push({ embed, components })
        over.afterSend?.(state)
        return Promise.resolve()
      },
    },
    ddb: {
      incidents: {
        get:
          over.caseGet ??
          ((id) => {
            reads.push(id)
            return Promise.resolve(ok(cases[id] ?? null))
          }),

        opened: (kind, after, until, limit) => {
          queries.push({ kind, after, until, limit })

          const fails = over.indexFails
          if (fails !== undefined && (fails.onlyFor === undefined || fails.onlyFor === kind)) {
            return Promise.resolve({
              ok: false as const,
              failure: {
                kind: fails.kind,
                op: 'query' as const,
                table: 'ringmaster-incidents',
                message: 'from the fake',
              },
            })
          }

          const raw = over.rawIndex?.[kind]
          if (raw !== undefined) return Promise.resolve(ok(raw))

          // The window the real accessor applies, so a test cannot assert a
          // cursor that only holds because the fake ignored the bounds.
          const rows = (index[kind] ?? []).filter((r) => r.openedAt > after && r.openedAt <= until)

          /**
           * ═══ `LastEvaluatedKey` THE WAY DYNAMODB ACTUALLY RETURNS IT ═══
           *
           * IT COMES BACK WHENEVER THE QUERY STOPPED EARLY, AND REACHING `Limit`
           * IS STOPPING EARLY. DynamoDB does not look ahead to see whether
           * anything is left, so a page that is exactly full reports more even
           * when the range is exhausted — which is why `more` reads as "this may
           * have been cut short" rather than "there is definitely another row".
           *
           * AND `pageCut` IS THE OTHER HALF, WHICH NO COUNT OF ROWS CAN IMITATE.
           * A `Query` may stop below `Limit` — a megabyte of scanned data — and
           * still have more behind it. That page is the one the walk used to read
           * as a whole window, so a fake that could not produce it could not test
           * the fix.
           */
          const cap = Math.min(limit ?? MAX_INDEX_ROWS, over.pageCut?.[kind] ?? Infinity)
          const keys = rows.slice(0, cap)
          const more = keys.length < rows.length || keys.length >= (limit ?? MAX_INDEX_ROWS)

          return Promise.resolve(ok({ keys, more }))
        },
      },
      players: { get: (licence) => Promise.resolve(ok(players[licence] ?? null)) },
      botState: {
        get:
          over.stateGet ??
          ((k) => {
            const value = state.get(k)
            return Promise.resolve(
              ok(value === undefined ? null : { id: k, value, updatedAt: NOW - 1 }),
            )
          }),
        // The map follows the answer, whoever gives it. See the resolved
        // harness, where the reason this is not simply replaced is argued.
        put: async (k, value) => {
          writes.push({ key: k, value })

          const written = over.statePut
            ? await over.statePut(k, value)
            : ok<BotStateRow>({ id: k, value, updatedAt: NOW })

          if (written.ok) state.set(k, value)
          return written
        },
      },
    },
  }

  return {
    log: createIncidentOpenLog(deps),
    state,
    sent,
    reads,
    queries,
    writes,
    cursor: () => {
      const raw = state.get(OPEN_CURSOR_KEY)
      return raw === undefined ? null : Number(raw)
    },
  }
}

describe('the kinds the case-opened poll asks about', () => {
  /**
   * ═══ THE CHECK THAT FAILS WHEN THE GAME CAN EMIT A KIND THIS BOT DOES NOT
   * QUERY ═══
   *
   * THE COMPILER ALREADY REFUSES A FOURTH `IncidentKind` that is missing from
   * `INCIDENT_KINDS`, because that constant is a `Record<IncidentKind, true>`.
   * What it cannot refuse is the list going stale in the other direction — a kind
   * declared and worded and then not queried — because `KIND_LABEL` and the query
   * list are two objects and only one of them decides what the poller asks for.
   */
  it('asks about every kind it has a word for', () => {
    expect([...POLLED_KINDS].sort()).toEqual(Object.keys(KIND_LABEL).sort())
  })

  /**
   * THE TWO KINDS THE GAME'S BUILDERS ACTUALLY WRITE, AS LITERALS, because the
   * union is this repo's copy of another repo's vocabulary and a copy can drift
   * from what is really emitted. From
   * fivem-royale-m9/resources/[fivem-royale]/br_lib/shared/incident_build.lua:
   * `fromRefusal`, `fromChat`, `fromStrip` and `fromVehicle` all write
   * `kind = 'anticheat'`, and `fromReport` writes `kind = 'report'`.
   *
   * `identifier_reuse` IS DELIBERATELY NOT ON THIS LIST AND IS STILL QUERIED. No
   * writer of it exists in either repository today — the console declares it and
   * renders it and nothing files one — so this case would pass without it. The
   * case above is what keeps it queried, and `INCIDENT_KINDS` says why asking
   * about a kind nobody writes is the cheap error and not asking is the quiet one.
   */
  it('asks about both kinds the game files today', () => {
    for (const emitted of ['anticheat', 'report'] as const) {
      expect(POLLED_KINDS).toContain(emitted)
    }
  })

  it('names each kind once', () => {
    expect(new Set(POLLED_KINDS).size).toBe(POLLED_KINDS.length)
  })

  /**
   * A KIND FROM OUTSIDE BOTH UNIONS IS POSSIBLE AND IS WHAT THE RUNTIME HALF OF
   * THE CHECK IS FOR. `buildIncidentItem` writes `str(payload.kind, 32)`, so the
   * attribute is a thirty-two character string as far as its writer is concerned.
   */
  it('recognises a kind the poll could not have found', () => {
    expect(unqueryableKind({ kind: 'report' })).toBeNull()
    expect(unqueryableKind({ kind: 'anticheat' })).toBeNull()

    expect(unqueryableKind({ kind: 'griefing_v2' as IncidentKind })).toBe('griefing_v2')
    expect(unqueryableKind({ kind: undefined as unknown as IncidentKind })).toBe('undefined')

    // Through the prototype chain rather than on the object: `Object.hasOwn` is
    // what keeps `constructor` and `toString` from reading as known kinds.
    expect(unqueryableKind({ kind: 'constructor' as IncidentKind })).toBe('constructor')
  })

  /**
   * ═══ THE ALARM IS RAISED BY THE POLLER THAT DOES NOT USE THE INDEX ═══
   *
   * THE RESOLVED POLL IS THE ONLY READER THAT SEES A CASE WITHOUT NAMING ITS
   * KIND: it is handed an id by an audit row. The openings poll finds cases BY
   * kind, so it can never be the thing that notices a kind it does not query.
   */
  it('says so, loudly, when a closed case carries a kind the openings poll cannot find', async () => {
    const odd = incident({ kind: 'griefing_v2' as IncidentKind })
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()], cases: { [CASE]: odd } })

    await h.log.poll()

    expect(
      said(
        stderr,
        'a case carries a kind the case-opened poll does not query, so cases of that kind are never posted when they are filed',
      ),
    ).toBe(true)
    expect(stderr.join('')).toContain('kind="griefing_v2"')
    expect(stderr.join('')).toContain(`index=${JSON.stringify(INCIDENT_KIND_INDEX)}`)

    // The record it is about still posts: what is broken is another poller's
    // coverage, not this case.
    expect(h.sent).toHaveLength(1)
  })

  it('says nothing about a kind it does query', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()] })

    await h.log.poll()

    expect(
      said(
        stderr,
        'a case carries a kind the case-opened poll does not query, so cases of that kind are never posted when they are filed',
      ),
    ).toBe(false)
  })

  /**
   * THE RESOLVED POLL MUST NOT READ THE INDEX AT ALL. It has an id from the audit
   * log and a strongly consistent `GetItem` to spend it on; a query here would be
   * a second, weaker way of answering a question it has already answered.
   */
  it('is not read by the resolved poll', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()] })

    await h.log.poll()

    expect(h.indexReads).toEqual([])
  })
})

describe('the record for a filed case', () => {
  it('says the case was filed and not that anything was decided', () => {
    const embed = incidentEmbed(openCase(), AVATAR, 'filed')

    expect(embed.title).toBe(COPY.filedTitle)
    expect(embed.title).not.toBe(COPY.resolvedTitle)

    expect(field(embed, COPY.case)).toBe(`${KIND_LABEL.report} · ${CATEGORY_LABEL.cheating}`)
    expect(span(field(embed, COPY.player))).toBe('Nate')
  })

  /**
   * ═══ AN OPEN CASE HAS NO VERDICT AND NO RESOLVER, AND BOTH FIELDS GO ═══
   *
   * `COPY.verdictUnknown` ('No verdict recorded') IS THE WRONG ANSWER HERE AND IS
   * THE RIGHT ONE ON A CLOSED CASE, which is the whole reason this is not simply
   * `verdictText`. On a closure it reports that nobody wrote a decision down; on
   * a case filed thirty seconds ago it reports the absence of a decision that was
   * never due, which is a claim about an admin who has not looked yet.
   */
  it('leaves the verdict and the resolver off a case nobody has looked at', () => {
    const embed = incidentEmbed(openCase(), null, 'filed')

    expect(field(embed, COPY.verdict)).toBeUndefined()
    expect(field(embed, COPY.resolvedBy)).toBeUndefined()

    // And not merely blank: a label with an empty value beside it reads as a fact
    // that failed to load.
    expect(JSON.stringify(embed)).not.toContain(COPY.verdictUnknown)
    expect(embed.fields?.map((f) => f.name)).toEqual([COPY.case, COPY.player])
  })

  it('stamps the post with when the case was filed and never with a closure', () => {
    const embed = incidentEmbed(openCase({ openedAt: NOW - 600_000 }), null, 'filed')
    expect(embed.timestamp).toBe(new Date(NOW - 600_000).toISOString())

    // The auto-resolved case carries both stamps. The filed post takes the one
    // the post is about.
    const both = incidentEmbed(
      incident({ openedAt: NOW - 600_000, resolvedAt: NOW - 120_000 }),
      null,
      'filed',
    )
    expect(both.timestamp).toBe(new Date(NOW - 600_000).toISOString())
    expect(both.timestamp).not.toBe(new Date(NOW - 120_000).toISOString())
  })

  /** The same range rule `resolvedAt` has: the value is another repo's. */
  it('leaves the timestamp off an openedAt no receiver would parse', () => {
    for (const odd of [NaN, Infinity, -Infinity, 1e18, 8.64e15, undefined]) {
      expect(
        'timestamp' in incidentEmbed(openCase({ openedAt: odd as number }), null, 'filed'),
        String(odd),
      ).toBe(false)
    }
  })

  /**
   * ═══ THE LEAK ASSERTION, OVER THE OTHER POST ═══
   *
   * THE REPORTER'S NAME IS ON THE ROW AND MUST NOT BE ON THIS EMBED EITHER. The
   * filed post is the one a player-filed report produces FIRST, so it is the post
   * the reporter's name is nearest to: `summary` on that row is
   * `Reported for <category> by <reporterName>`, built by the game.
   */
  it('never carries the reporter into the channel', () => {
    const rendered = JSON.stringify(
      incidentEmbed(wholeRow({ state: 'pending_review' }), AVATAR, 'filed'),
    )

    expect(rendered).not.toContain(REPORTER)
    expect(rendered).not.toContain('Reported for')
    expect(rendered).not.toContain('license:reporter')
    expect(rendered).not.toContain('aimbot')
  })

  /**
   * ═══ A CASE FILED ALREADY CLOSED ═══
   *
   * br_ddb WRITES `state: 'resolved'`, `resolvedAt: openedAt` AND
   * `resolvedByName: 'System'` IN THE PutItem THAT CREATES THE ROW when the game
   * handled something itself, and writes NO `incident.resolve` audit row for it —
   * so the resolved poll never sees that case and this post is the only one it
   * will ever get. The verdict field keys off `state` rather than off which post
   * this is, so the closure shows up on the post that mentions it.
   */
  it('shows the closure on a case the game filed and closed in one write', () => {
    const auto = incident({
      state: 'resolved',
      resolvedByName: 'System',
      resolvedAt: NOW - 600_000,
      openedAt: NOW - 600_000,
      verdict: undefined,
    })

    const embed = incidentEmbed(auto, null, 'filed')

    expect(embed.title).toBe(COPY.filedTitle)
    expect(span(field(embed, COPY.resolvedBy))).toBe('System')
    expect(field(embed, COPY.verdict)).toBe(COPY.verdictUnknown)
  })

  /**
   * ═══ A FILED POST MUST NOT CLAIM SOMEBODY RESOLVED A CASE THAT IS OPEN ═══
   *
   * `Verdict` AND `Resolved by` ARE ONE FACT AND WERE GATED SEPARATELY. The
   * verdict was rendered only for a `resolved` case; the resolver two lines below
   * it was gated on nothing, and left to fall out of the empty-field filter on
   * the argument that an open case has no `resolvedByName`. That is a claim about
   * a row in ANOTHER REPOSITORY, and it is the same claim `settle`'s own state
   * gate exists because this repo cannot make: a row that is `pending_review` and
   * carries a resolver rendered a post saying somebody had resolved a case that
   * is still open, with no verdict beside it to qualify it.
   *
   * DRIFT IS NOT HYPOTHETICAL ON THIS PAIR. `settle` holds a case whose `state`
   * still says `pending_review` after an `incident.resolve` row was written for
   * it, which is that exact half-written row — the console sets the fields and
   * the state in one update, and this poller reads the table while it happens.
   */
  it('never names a resolver on a case whose state says nobody has closed it', () => {
    const drifted = openCase({ resolvedByName: 'Admin One', resolvedAt: NOW - 120_000 })

    for (const about of ['filed', 'resolved'] as const) {
      const embed = incidentEmbed(drifted, null, about)

      expect(field(embed, COPY.resolvedBy), about).toBeUndefined()
      expect(field(embed, COPY.verdict), about).toBeUndefined()
      expect(JSON.stringify(embed), about).not.toContain('Admin One')

      // The two that are always there, and nothing else.
      expect(
        embed.fields?.map((f) => f.name),
        about,
      ).toEqual([COPY.case, COPY.player])
    }
  })
})

describe('the case-opened poll', () => {
  /** The window every pass asks for, given the seeded cursor. */
  const UNTIL = NOW - SETTLE_MS

  /**
   * What the four index sentences say, rebuilt from the constant the request
   * carries. Spelled out here rather than imported, so a reworded line is a
   * failing case and not a case that quietly asserts the new wording.
   */
  const MISSING = `the ${INCIDENT_KIND_INDEX} index on ringmaster-incidents does not exist, so no record is posted when a case is filed`
  const FILLING = `the ${INCIDENT_KIND_INDEX} index on ringmaster-incidents is still filling, so records for filed cases start once it is ready`
  const DENIED = `the bot is not allowed to Query the ${INCIDENT_KIND_INDEX} index on ringmaster-incidents, so no record is posted when a case is filed — dynamodb:Query has to be granted on the table arn AND on that arn with /index/${INCIDENT_KIND_INDEX} on the end, which IAM treats as a separate resource`
  const UNPLACEABLE =
    'the incident index answered with an openedAt that is not a position in it, so the case-opened poll stopped and posted nothing'
  const UNREAD =
    'the incident index stopped short of its window without returning a row, so the case-opened poll waits for the next pass'
  const BUDGET =
    'the case-opened poll spent its budget with cases still waiting, so the rest are posted on later passes'

  it('posts the record for a case the index says was filed', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.embed.title).toBe(COPY.filedTitle)
    expect(h.sent[0]?.embed.thumbnail?.url).toBe(AVATAR)
    expect(h.sent[0]?.components).toHaveLength(1)
    expect(said(stdout, 'posted the record for a newly filed incident')).toBe(true)

    // The cursor is the index's sort key and not the wall clock: a restart
    // resumes at the case, not at the moment the pass happened to run.
    expect(h.cursor()).toBe(NOW - 60_000)
  })

  /**
   * ONE QUERY PER KIND, EVERY KIND, OVER `(cursor, until]`. The list is asserted
   * against `POLLED_KINDS` rather than against three literals, because the
   * constant is what the poller reads and a case that hard-coded the kinds would
   * pass while the poller queried a different set.
   */
  it('asks the index about every kind it knows, over the cursor window', async () => {
    const h = openHarness({ state: { [OPEN_CURSOR_KEY]: OPEN } })

    await h.log.poll()

    expect(h.queries.map((q) => q.kind)).toEqual([...POLLED_KINDS])

    for (const query of h.queries) {
      expect(query.after).toBe(Number(OPEN))
      expect(query.until).toBe(UNTIL)
      expect(query.limit).toBe(MAX_INDEX_ROWS)
    }
  })

  /* ---------------------------------------------------------------- *
   * The index may not exist yet.
   * ---------------------------------------------------------------- */

  /**
   * ═══ THE LOUDEST LINE IN THE FEATURE, AND THE ONE MOST LIKELY TO BE NEEDED ═══
   *
   * The index is created by hand and this code ships before it does. Every pass
   * until somebody runs `update-table` fails on the first query, and what the
   * owner is told about that decides whether the feature ever starts working.
   */
  it('says the index is missing, and names it, rather than reporting a read failure', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
      indexFails: { kind: 'no-such-index' },
    })

    await h.log.poll()

    expect(said(stderr, MISSING)).toBe(true)
    expect(MISSING).toContain(INCIDENT_KIND_INDEX)

    /**
     * AT `error` AND NOT AT `warn`. Both reach the owner's status channel, so
     * this is not the noise decision — it is `journalctl -p err`, and which of
     * two lines is read first. The rule in src/log.ts is that `error` means the
     * bot has stopped doing something it is for and a person has to act, which
     * is exactly this: nothing is posted when a case is filed until somebody
     * creates an index.
     */
    expect(
      stderr.find((line) => line.includes(`msg=${JSON.stringify(MISSING)}`)),
    ).toContain('level=error')

    // NOT the sentence a table that did not answer gets. An operator sent to the
    // wrong page spends the evening on a table that is fine.
    expect(said(stderr, 'could not read the incident index, so no case was posted this pass')).toBe(
      false,
    )
  })

  /**
   * ONE LINE PER PASS AND NOT ONE PER KIND. Three would be three messages in the
   * status channel every half minute about one missing index, and a channel that
   * repeats itself three times is a channel that stops being read.
   */
  it('says it once per pass, not once per kind', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      indexFails: { kind: 'no-such-index' },
    })

    await h.log.poll()

    expect(stderr.filter((line) => line.includes(`msg=${JSON.stringify(MISSING)}`))).toHaveLength(1)
    // It stopped at the first kind rather than asking the other two the question
    // it already has the answer to.
    expect(h.queries).toHaveLength(1)
  })

  /**
   * NOTHING IS POSTED AND THE CURSOR DOES NOT MOVE. A missing index that
   * advanced the bookmark would mean every case filed between shipping this and
   * creating the index is behind it forever — the feature would start working and
   * still never mention the backlog it was switched on for.
   */
  it('posts nothing and moves nothing while the index is missing', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
      indexFails: { kind: 'no-such-index' },
    })

    await h.log.poll()

    expect(h.sent).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.cursor()).toBe(Number(OPEN))
  })

  it('reports any other index failure as a read that did not answer', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      indexFails: { kind: 'timeout' },
    })

    await h.log.poll()

    expect(said(stderr, 'could not read the incident index, so no case was posted this pass')).toBe(
      true,
    )
    expect(said(stderr, MISSING)).toBe(false)
    expect(h.cursor()).toBe(Number(OPEN))
  })

  /**
   * ═══ THE MINUTES AFTER `update-table`, WHICH IS THE STATE THE OWNER WILL
   * ACTUALLY BE IN ═══
   *
   * AWS REFUSES READS OF A GSI WHILE IT BACKFILLS — a `ValidationException`, the
   * same exception name a missing index raises. So the first thing the owner saw
   * after running the command in docs/aws-notes.md was this bot telling him the
   * index does not exist, in the exact state that command puts him in, and the
   * next thing he would do is go looking for a typo in something that is fine.
   * src/ddb.ts is where the two are told apart and where AWS's own wording is
   * quoted from.
   */
  it('says the index is filling rather than that it is not there', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
      indexFails: { kind: 'index-backfilling' },
    })

    await h.log.poll()

    expect(said(stdout, FILLING)).toBe(true)
    expect(FILLING).toContain(INCIDENT_KIND_INDEX)

    // The sentence that is not true in this state, and the one that would send
    // him to the wrong page.
    expect(said(stderr, MISSING)).toBe(false)
    expect(said(stderr, 'could not read the incident index, so no case was posted this pass')).toBe(
      false,
    )

    /**
     * AND IT IS `info`, WHICH IS THE ONE LINE IN THIS GROUP THAT REACHES NOBODY.
     * The rule in src/log.ts is one question — does this need a human — and the
     * answer is no twice over: the backfill finishes on its own, and nothing is
     * lost while it runs because a failed read never moves the cursor. A `warn`
     * would put it in the status channel twice a minute for the whole backfill.
     */
    expect(lineFor(stdout, FILLING)?.startsWith('<6>')).toBe(true)
    expect(stderr).toEqual([])

    // Nothing is lost by waiting: the cursor has not moved, so the next pass
    // asks about a window with the same lower bound.
    expect(h.writes).toEqual([])
    expect(h.cursor()).toBe(Number(OPEN))
  })

  /**
   * ═══ A DENIAL IS PERMANENT AND WAS LOGGED AS IF IT WERE A TIMEOUT ═══
   *
   * IAM TREATS A TABLE AND ITS INDEXES AS SEPARATE RESOURCES, so a policy naming
   * only `…:table/ringmaster-incidents` allows the `GetItem` and refuses the
   * `Query` — which docs/aws-notes.md predicts by name, along with what it costs.
   * That refusal classified as `denied` and fell into the generic branch at
   * `warn`, in the same bucket as a read that did not answer, on every pass
   * forever until a human edits a policy. src/log.ts states the rule it breaks:
   * `error` rather than `warn` when the bot has stopped doing something it is
   * for.
   */
  it('calls a denial on the index read an error and names the arn to grant', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
      indexFails: { kind: 'denied' },
    })

    await h.log.poll()

    expect(said(stderr, DENIED)).toBe(true)
    expect(lineFor(stderr, DENIED)?.startsWith('<3>')).toBe(true)
    expect(lineFor(stderr, DENIED)).toContain('level=error')

    // NOT the transient sentence, which is the one the next pass fixes.
    expect(said(stderr, 'could not read the incident index, so no case was posted this pass')).toBe(
      false,
    )

    /**
     * AND THE SENTENCE NAMES THE RESOURCE THAT IS MISSING FROM THE POLICY. A line
     * that said "denied" and stopped sends somebody to a policy that already
     * names this table; the thing to grant is the index arn, which is the table
     * arn with `/index/<name>` on the end.
     */
    expect(DENIED).toContain(`/index/${INCIDENT_KIND_INDEX}`)
    expect(DENIED).toContain('dynamodb:Query')
  })

  /* ---------------------------------------------------------------- *
   * Said once, and said again when it clears.
   * ---------------------------------------------------------------- */

  /**
   * ═══ THE DELIVERY, WHICH WAS THE HALF THAT WAS WRONG ═══
   *
   * The two sentences above are right and are how the owner found out. What was
   * wrong was that the poller said one of them every thirty seconds for forty
   * minutes and counting: #bot-status folded it correctly — one message, "seen 10
   * times" — and a five-minute window still means a fresh message twelve times an
   * hour, forever, burying everything else in the one place the owner sees any of
   * this. He has no CLI path by design, so a channel nobody can read IS the
   * outage.
   *
   * NEITHER SENTENCE MOVED. What changed is that the two permanent conditions go
   * through the latch in src/latch.ts and the two that are not permanent do not.
   */

  /** The two all-clears, rebuilt here for the reason the four faults are. */
  const FOUND = `the ${INCIDENT_KIND_INDEX} index on ringmaster-incidents answers now, so a record is posted when a case is filed`
  const ALLOWED = `the bot is allowed to Query the ${INCIDENT_KIND_INDEX} index on ringmaster-incidents now, so a record is posted when a case is filed`

  /** The harness options, held so a case can create the index mid-run. */
  type OpenOptions = NonNullable<Parameters<typeof openHarness>[0]>

  it('says the index is missing once, not once every pass for forty minutes', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      indexFails: { kind: 'no-such-index' },
    })

    // Eighty passes is forty minutes at POLL_MS, which is what he sat in front
    // of. Every one of them still queries: the poll never stops, because he may
    // create the index at any moment and it has to pick that up on its own.
    for (let n = 0; n < 80; n++) await h.log.poll()

    expect(stderr.filter((line) => line.includes(`msg=${JSON.stringify(MISSING)}`))).toHaveLength(1)
    expect(h.queries).toHaveLength(80)

    // Still an error. An error that is real stays an error; it just stops
    // repeating.
    expect(lineFor(stderr, MISSING)).toContain('level=error')
  })

  /**
   * ═══ THE LINE THAT TELLS HIM HIS FIX WORKED ═══
   *
   * WITHOUT IT, "IT IS FIXED" IS AN ABSENCE OF ERRORS AND A PERSON CANNOT WATCH
   * FOR AN ABSENCE. He runs `aws dynamodb update-table`, waits out a backfill of
   * unknown length, and has no way to ask this bot whether it is working.
   */
  it('says the index answers, exactly once, when it starts answering', async () => {
    const options: OpenOptions = {
      state: { [OPEN_CURSOR_KEY]: OPEN },
      indexFails: { kind: 'no-such-index' },
    }
    const h = openHarness(options)

    await h.log.poll()
    await h.log.poll()

    // He creates it.
    options.indexFails = undefined

    for (let n = 0; n < 20; n++) await h.log.poll()

    expect(stdout.filter((line) => line.includes(`msg=${JSON.stringify(FOUND)}`))).toHaveLength(1)

    /**
     * AND IT IS `info`. Nothing is wrong when something recovers, so
     * `journalctl -p err` must not carry the good news mixed in with the bad —
     * and it reaches the channel anyway, through `allClear` in src/log.ts, which
     * is the one door an `info` has.
     */
    expect(lineFor(stdout, FOUND)?.startsWith('<6>')).toBe(true)

    // How long the feature was dead, which is the thing the sentence cannot say.
    expect(lineFor(stdout, FOUND)).toContain('since=')
  })

  /**
   * A HEALTHY BOT SAYS NOTHING. The clear runs on every successful pass, twice a
   * minute for the life of the process, and an all-clear for a fault that never
   * happened would be the original problem rebuilt out of good news.
   */
  it('says nothing about an index that was never broken', async () => {
    const h = openHarness({ state: { [OPEN_CURSOR_KEY]: OPEN } })

    for (let n = 0; n < 20; n++) await h.log.poll()

    expect(said(stdout, FOUND)).toBe(false)
    expect(said(stdout, ALLOWED)).toBe(false)
  })

  /**
   * ═══ A DIFFERENT FAULT ARRIVING WHILE ONE IS LATCHED IS STILL REPORTED ═══
   *
   * THIS IS THE ROAD THE OWNER IS ACTUALLY ON. He creates the index and the
   * Query is then refused, because IAM treats the index as a resource of its own
   * and the policy names only the table — docs/aws-notes.md predicts exactly
   * this. A latch that swallowed the second sentence would leave him believing
   * the first fix was the whole job.
   *
   * AND NO ALL-CLEAR IS POSTED ON THE WAY. The index really does exist now, but
   * the read still does not work: `FOUND` says a record is posted when a case is
   * filed, which is false, and it would be the more reassuring of the two lines
   * sitting next to each other in the channel.
   */
  it('reports a denial that arrives while the missing index is latched', async () => {
    const options: OpenOptions = {
      state: { [OPEN_CURSOR_KEY]: OPEN },
      indexFails: { kind: 'no-such-index' },
    }
    const h = openHarness(options)

    await h.log.poll()
    await h.log.poll()

    options.indexFails = { kind: 'denied' }
    for (let n = 0; n < 20; n++) await h.log.poll()

    expect(stderr.filter((line) => line.includes(`msg=${JSON.stringify(MISSING)}`))).toHaveLength(1)
    expect(stderr.filter((line) => line.includes(`msg=${JSON.stringify(DENIED)}`))).toHaveLength(1)
    expect(said(stdout, FOUND)).toBe(false)

    // And when he fixes the policy, the all-clear is the one for the fault that
    // was actually holding.
    options.indexFails = undefined
    await h.log.poll()

    expect(said(stdout, ALLOWED)).toBe(true)
    expect(said(stdout, FOUND)).toBe(false)
  })

  /**
   * ═══ THE TRANSIENT ONE IS LEFT ALONE, AND THAT IS NOT AN OVERSIGHT ═══
   *
   * REPETITION IS THE INFORMATION HERE. One timeout is a hiccup the next pass
   * covers; forty in a row is a table that has stopped answering, and the count
   * is the only thing that says which of the two is happening. Latching it would
   * silence the second fact entirely — and it is not a condition a person clears,
   * which is the test in src/latch.ts.
   */
  it('goes on saying a read that did not answer, every pass', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      indexFails: { kind: 'timeout' },
    })

    for (let n = 0; n < 10; n++) await h.log.poll()

    const transient = 'could not read the incident index, so no case was posted this pass'
    expect(stderr.filter((line) => line.includes(`msg=${JSON.stringify(transient)}`))).toHaveLength(
      10,
    )
  })

  /**
   * ═══ A BACKFILL IS NOT A RECOVERY, WHICH IS THE SUBTLE ONE ═══
   *
   * `update-table` PUTS HIM IN THIS EXACT STATE. The index now exists, so
   * `MISSING` has stopped being true — but `FOUND` says a record is posted when
   * a case is filed and during a backfill that is still false. The all-clear
   * waits for a read that actually answered; the `info` line is what says so
   * meanwhile, and it is the same one it always was.
   */
  it('does not call a backfill an all-clear', async () => {
    const options: OpenOptions = {
      state: { [OPEN_CURSOR_KEY]: OPEN },
      indexFails: { kind: 'no-such-index' },
    }
    const h = openHarness(options)

    await h.log.poll()

    options.indexFails = { kind: 'index-backfilling' }
    for (let n = 0; n < 10; n++) await h.log.poll()

    expect(said(stdout, FOUND)).toBe(false)
    expect(said(stdout, FILLING)).toBe(true)

    // And the missing-index line does not come back when the backfill finishes:
    // what comes back is the all-clear.
    options.indexFails = undefined
    await h.log.poll()

    expect(stderr.filter((line) => line.includes(`msg=${JSON.stringify(MISSING)}`))).toHaveLength(1)
    expect(said(stdout, FOUND)).toBe(true)
  })

  /**
   * ═══ ONE FAILING KIND ABANDONS THE WHOLE PASS ═══
   *
   * THE CURSOR IS ONE NUMBER ACROSS ALL THREE PARTITIONS. Posting the kinds that
   * answered and advancing past their stamps would carry the bookmark over a
   * window the failed kind was never asked about — so every case of that kind in
   * it is gone, permanently, with one `warn` that says a read failed and nothing
   * that says a window was skipped.
   */
  it('posts nothing at all when one kind could not be read', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
      // Not the first kind asked, so the pass really does abandon work it had
      // already been handed rather than never starting.
      indexFails: { kind: 'timeout', onlyFor: 'report' },
      cases: { [CASE]: openCase() },
    })

    await h.log.poll()

    expect(h.sent).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.cursor()).toBe(Number(OPEN))
  })

  /* ---------------------------------------------------------------- *
   * The index may be backfilling.
   * ---------------------------------------------------------------- */

  /**
   * ═══ AN EMPTY ANSWER IS NOT PROOF THAT NOTHING HAPPENED ═══
   *
   * A NEW GSI ANSWERS NOTHING UNTIL IT HAS POPULATED, so "no rows" and "no cases"
   * are the same page from here for as long as the backfill takes. The cursor
   * staying put is what makes that safe: the next pass asks about a WIDER window
   * with the SAME lower bound, and a superset cannot skip anything.
   */
  it('never moves the cursor over an empty answer', async () => {
    const h = openHarness({ state: { [OPEN_CURSOR_KEY]: OPEN }, index: {} })

    await h.log.poll()

    expect(h.queries).toHaveLength(POLLED_KINDS.length)
    expect(h.writes).toEqual([])
    expect(h.cursor()).toBe(Number(OPEN))
  })

  /**
   * AND THE BACKLOG IS STILL THERE WHEN THE INDEX FINISHES FILLING. Driven: two
   * passes against one harness, the first while the index answers nothing and the
   * second after a case that was filed BEFORE the first pass has appeared in it.
   * If the empty pass had bookmarked anything, this case would be filed behind it.
   */
  it('posts what the backfill reveals about a window it already looked at', async () => {
    const index: Partial<Record<IncidentKind, IncidentKey[]>> = {}
    const filed = key({ openedAt: NOW - 900_000 })

    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index,
      cases: { [CASE]: openCase() },
    })

    await h.log.poll()
    expect(h.sent).toEqual([])

    // The backfill lands, and the row it copies is older than the pass above.
    index.report = [filed]

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.cursor()).toBe(NOW - 900_000)
  })

  /**
   * ═══ THE FIRST-START MARK IS WRITTEN BEFORE ANY QUERY EXISTS ═══
   *
   * THIS IS THE OTHER HALF OF THE BACKFILL ARGUMENT AND IT IS THE EASY ONE TO GET
   * WRONG. A no-cursor branch that queried first and then recorded "now" would,
   * against an index that had not populated, bookmark the present on the strength
   * of a table that was still being built — and every case filed while it filled
   * would be behind the mark forever. Asking nothing cannot be wrong about the
   * index.
   */
  it('records where it came in without asking the index anything', async () => {
    const h = openHarness({ index: { report: [key()] } })

    await h.log.poll()

    expect(h.queries).toEqual([])
    expect(h.sent).toEqual([])
    expect(h.cursor()).toBe(UNTIL)
    expect(
      said(
        stdout,
        'no case-opened poll cursor yet, so cases filed from now on will be posted and earlier ones will not',
      ),
    ).toBe(true)
  })

  it('restarts from now when the stored cursor is not a position in the index', async () => {
    for (const stored of ['', ' ', '0', 'later', '-1', String(Number.MAX_SAFE_INTEGER)]) {
      stderr.length = 0

      const h = openHarness({ state: { [OPEN_CURSOR_KEY]: stored }, index: { report: [key()] } })
      await h.log.poll()

      expect(h.queries, stored).toEqual([])
      expect(h.cursor(), stored).toBe(UNTIL)
      expect(
        said(
          stderr,
          'the case-opened poll cursor is not a position in the index, so polling restarts from now',
        ),
        stored,
      ).toBe(true)
    }
  })

  /**
   * A FIRST-START WRITE THAT FAILS MUST NOT SLIDE THE MARK FORWARD. The branch
   * returns without walking anything, so getting this wrong is not a lost write —
   * it is a silently skipped window, and the only line in the journal says a
   * bookmark did not land rather than that cases were dropped.
   */
  it('writes the first pass mark rather than a fresh one after a failed write', async () => {
    let attempts = 0
    let clock = NOW

    const h = openHarness({
      now: () => clock,
      statePut: (id, value) => {
        attempts++
        return Promise.resolve(
          attempts === 1
            ? { ok: false as const, failure: { kind: 'timeout' as const, op: 'put' as const, table: 'ringmaster-bot-state', message: 'from the fake' } }
            : ok<BotStateRow>({ id, value, updatedAt: clock }),
        )
      },
    })

    await h.log.poll()
    expect(h.cursor()).toBeNull()

    // Ten minutes later, and a window of cases in between.
    clock = NOW + 600_000
    await h.log.poll()

    expect(h.cursor()).toBe(UNTIL)
    expect(h.writes.map((w) => w.value)).toEqual([String(UNTIL), String(UNTIL)])
  })

  /* ---------------------------------------------------------------- *
   * The walk.
   * ---------------------------------------------------------------- */

  it('merges the kinds and posts oldest first', async () => {
    const a = '6f1c9a2e-0000-4000-8000-00000000000a'
    const b = '6f1c9a2e-0000-4000-8000-00000000000b'
    const c = '6f1c9a2e-0000-4000-8000-00000000000c'

    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: {
        report: [key({ incidentId: a, openedAt: NOW - 300_000 })],
        anticheat: [
          key({ incidentId: b, kind: 'anticheat', openedAt: NOW - 400_000 }),
          key({ incidentId: c, kind: 'anticheat', openedAt: NOW - 200_000 }),
        ],
      },
      cases: {
        [a]: openCase({ incidentId: a }),
        [b]: openCase({ incidentId: b }),
        [c]: openCase({ incidentId: c }),
      },
    })

    await h.log.poll()

    expect(h.reads).toEqual([b, a, c])
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([b, a, c])
    expect(h.cursor()).toBe(NOW - 200_000)
  })

  /**
   * ═══ `openedAt` IS NOT UNIQUE, WHICH IS WHERE THIS WALK CANNOT COPY THE AUDIT
   * ONE ═══
   *
   * `ts` IS HALF THE AUDIT TABLE'S PRIMARY KEY, so a cursor written at a row's
   * `ts` provably has that row and everything before it behind it. A GSI sort key
   * has no such guarantee: two cases of one kind filed in the same millisecond
   * are two entries at one stamp, and a cursor advanced to that stamp after the
   * first of them would put the second permanently behind the bookmark.
   */
  it('posts every case sharing one openedAt before the cursor passes it', async () => {
    const a = '6f1c9a2e-0000-4000-8000-00000000000a'
    const b = '6f1c9a2e-0000-4000-8000-00000000000b'

    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: {
        report: [
          key({ incidentId: a, openedAt: NOW - 300_000 }),
          key({ incidentId: b, openedAt: NOW - 300_000 }),
        ],
      },
      cases: { [a]: openCase({ incidentId: a }), [b]: openCase({ incidentId: b }) },
    })

    await h.log.poll()

    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([a, b])
    expect(h.cursor()).toBe(NOW - 300_000)

    // And the next pass, reading `> cursor`, finds neither of them again.
    await h.log.poll()
    expect(h.sent).toHaveLength(2)
  })

  /**
   * A FULL PAGE MAY HAVE STOPPED IN THE MIDDLE OF A MILLISECOND, so its last
   * stamp is one this pass cannot claim to have seen the whole of — and rows of
   * OTHER kinds at or above it wait too, because the cursor is one number across
   * all three.
   */
  it('leaves a stamp a full page may have cut in half for the next pass', async () => {
    const tied = Array.from({ length: MAX_INDEX_ROWS }, (_, n) =>
      key({
        incidentId: `6f1c9a2e-0000-4000-8000-0000000${String(100 + n)}`,
        kind: 'anticheat',
        openedAt: NOW - 200_000,
      }),
    )

    const early = '6f1c9a2e-0000-4000-8000-00000000000a'

    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: {
        anticheat: tied,
        report: [key({ incidentId: early, openedAt: NOW - 300_000 })],
      },
      cases: { [early]: openCase({ incidentId: early }) },
    })

    await h.log.poll()

    // Only the case below the ceiling. The fifty at one stamp are not touched,
    // and nor is the read budget spent on them.
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([early])
    expect(h.reads).toEqual([early])
    expect(h.cursor()).toBe(NOW - 300_000)

    expect(
      said(
        stderr,
        'more cases share one openedAt than the case-opened poll can read in a pass, so some of them may never be posted',
      ),
    ).toBe(false)
  })

  /**
   * ═══ A SHORT PAGE IS NOT THE SAME CLAIM AS THE END OF THE RANGE ═══
   *
   * THE WALK INFERRED COMPLETENESS FROM `rows.length < MAX_INDEX_ROWS`, AND A
   * `Query` CAN RETURN FEWER ITEMS THAN `Limit` WITH MORE STILL IN THE RANGE —
   * a megabyte of scanned data is the documented reason. On that page the test
   * said "complete": the ceiling that exists to protect a half-read millisecond
   * stayed at infinity, every returned row was walked as the whole window, and
   * the cursor advanced to the last stamp returned. The rest of that millisecond
   * is then behind the bookmark for good. Never posted, and nothing saying so.
   *
   * THE CASE IS THE ONE THAT IS WRONG TODAY AND NOT THE FULL PAGE ABOVE IT. Two
   * rows come back out of a page of fifty — short, by a mile — and DynamoDB says
   * there is more. One of the two shares a millisecond with a case that did NOT
   * come back, which is the row the old cursor sailed over.
   */
  it('holds back a stamp a SHORT page cut in half, and does not sail past it', async () => {
    const early = '6f1c9a2e-0000-4000-8000-00000000000a'
    const tiedA = '6f1c9a2e-0000-4000-8000-00000000000b'
    const tiedB = '6f1c9a2e-0000-4000-8000-00000000000c'

    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: {
        report: [
          key({ incidentId: early, openedAt: NOW - 300_000 }),
          key({ incidentId: tiedA, openedAt: NOW - 200_000 }),
          key({ incidentId: tiedB, openedAt: NOW - 200_000 }),
        ],
      },
      // Two rows of the three, and `LastEvaluatedKey` with them.
      pageCut: { report: 2 },
      cases: Object.fromEntries(
        [early, tiedA, tiedB].map((id) => [id, openCase({ incidentId: id })]),
      ),
    })

    await h.log.poll()

    // The stamp the page may have stopped inside is held back WHOLE, so the half
    // of it that did come back is not posted either.
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([early])
    expect(h.cursor()).toBe(NOW - 300_000)

    /**
     * AND THE UNREAD REMAINDER IS STILL IN FRONT OF THE CURSOR. This is the
     * assertion the old test could not make: with the cursor at `NOW - 200_000`
     * the next pass asks for `> NOW - 200_000` and `tiedB` — which was never
     * returned and never read — is behind it permanently.
     */
    await h.log.poll()

    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([early, tiedA, tiedB])
    expect(h.cursor()).toBe(NOW - 200_000)
  })

  /**
   * ═══ AND THE STALL THAT WOULD BE, SAID OUT LOUD AND THEN TAKEN ═══
   *
   * A FULL PAGE IN WHICH EVERY ROW SHARES ONE STAMP has no row below the ceiling,
   * so holding would park this walk at that millisecond for the life of the
   * process — the quiet halt the whole feature is written against. They are taken
   * instead, and the line names the stamp, because a bounded loss that says so
   * beats a feed that stops with nothing to show for it.
   */
  it('takes a whole page at one stamp rather than stalling on it forever', async () => {
    const ids = Array.from(
      { length: MAX_INDEX_ROWS },
      (_, n) => `6f1c9a2e-0000-4000-8000-0000000${String(100 + n)}`,
    )

    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: {
        anticheat: ids.map((id) =>
          key({ incidentId: id, kind: 'anticheat', openedAt: NOW - 200_000 }),
        ),
      },
      cases: Object.fromEntries(ids.map((id) => [id, openCase({ incidentId: id })])),
    })

    await h.log.poll()

    expect(
      said(
        stderr,
        'more cases share one openedAt than the case-opened poll can read in a pass, so some of them may never be posted',
      ),
    ).toBe(true)

    // The group is indivisible, so `MAX_POSTS` is overrun rather than the stamp
    // being left half done — which would replay whatever was posted of it.
    expect(h.sent).toHaveLength(MAX_INDEX_ROWS)
    expect(h.cursor()).toBe(NOW - 200_000)
  })

  /**
   * ═══ AND THE NUMBER IN THAT SENTENCE IS THE NUMBER THE SENTENCE IS ABOUT ═══
   *
   * IT REPORTED `merged.length` — EVERY KIND'S ROWS IN THE PASS — under a line
   * about how many cases share ONE `openedAt`. The two differ by whatever else
   * the pass pulled back, which on the row this is diagnosed from is exactly the
   * context that makes it look like more cases collided than did. Fifty at one
   * millisecond, and one more of another kind above the ceiling, so the pass's
   * haul is fifty-one and the answer is fifty.
   */
  it('counts the cases at the stamp it names, and not every row in the pass', async () => {
    const tied = Array.from({ length: MAX_INDEX_ROWS }, (_, n) =>
      key({
        incidentId: `6f1c9a2e-0000-4000-8000-0000000${String(100 + n)}`,
        kind: 'anticheat',
        openedAt: NOW - 200_000,
      }),
    )

    const later = '6f1c9a2e-0000-4000-8000-00000000000f'

    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: {
        anticheat: tied,
        // Above the ceiling, so it is excluded too and `usable` is still empty.
        report: [key({ incidentId: later, openedAt: NOW - 100_000 })],
      },
      cases: Object.fromEntries(
        [...tied.map((t) => t.incidentId), later].map((id) => [id, openCase({ incidentId: id })]),
      ),
    })

    await h.log.poll()

    const line = lineFor(
      stderr,
      'more cases share one openedAt than the case-opened poll can read in a pass, so some of them may never be posted',
    )

    expect(line).toContain(`rows=${String(MAX_INDEX_ROWS)}`)
    expect(line).not.toContain(`rows=${String(MAX_INDEX_ROWS + 1)}`)
    expect(line).toContain(`openedAt=${String(NOW - 200_000)}`)
  })

  /**
   * ═══ THE PROTECTION THE COPY OF THIS WALK DID NOT INHERIT ═══
   *
   * `placeable` IS src/auditpoll.ts's AND WAS ADDED THERE AFTER A PRODUCTION
   * INCIDENT: a sort key that is a broken number was walked as a position and
   * written back out as the bookmark `'NaN'`, and `1e18` was written out as one
   * that `cursorAt` then either refuses — restarting the walk from now and
   * skipping every case in between — or, before the horizon existed, accepted
   * forever as a lower bound past the clock. This walk is the same pairing one
   * table over: `openedAt` is a sort key off another repository's row that this
   * file writes into `ringmaster-bot-state` and reads back through `cursorAt`.
   * It shipped without the guard.
   *
   * `1e15` IS THE VALUE THAT MATTERS AND IT IS WHY A TYPE CHECK IS NOT ENOUGH.
   * It is a number, it is finite, it is positive, and it is past `MAX_STAMP` —
   * so it sorted, it was walked, and it was written as a bookmark that this
   * poller's own reader refuses on the very next pass.
   */
  it('refuses an openedAt that is not a position in the index, and writes nothing', async () => {
    for (const odd of [NaN, Infinity, -Infinity, 1e15, 0, -1, undefined]) {
      stderr.length = 0

      const h = openHarness({
        state: { [OPEN_CURSOR_KEY]: OPEN },
        rawIndex: { report: { keys: [key({ openedAt: odd as number })], more: false } },
        cases: { [CASE]: openCase() },
      })

      await h.log.poll()

      expect(said(stderr, UNPLACEABLE), String(odd)).toBe(true)
      expect(lineFor(stderr, UNPLACEABLE)?.startsWith('<3>'), String(odd)).toBe(true)

      // Nothing posted, nothing written, and above all no bookmark carrying it.
      expect(h.sent, String(odd)).toEqual([])
      expect(h.writes, String(odd)).toEqual([])
      expect(h.cursor(), String(odd)).toBe(Number(OPEN))
    }
  })

  /**
   * AND IT IS NOT THE TIE LINE, WHICH IS WHAT IT USED TO COME OUT AS. A
   * non-numeric `openedAt` failed `< Infinity`, emptied `usable`, and reached the
   * give-up branch with the ceiling still infinite — logging `openedAt=Infinity`
   * under a sentence about a millisecond, matching nothing, on every pass forever
   * while the cursor stood still.
   */
  it('does not report a broken stamp as a millisecond too many cases share', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      rawIndex: { report: { keys: [key({ openedAt: undefined as unknown as number })], more: false } },
    })

    await h.log.poll()

    expect(
      said(
        stderr,
        'more cases share one openedAt than the case-opened poll can read in a pass, so some of them may never be posted',
      ),
    ).toBe(false)
    expect(stderr.some((l) => l.includes('openedAt=Infinity'))).toBe(false)
  })

  /**
   * A PAGE THAT SAYS "THERE IS MORE" AND HANDS BACK NOTHING. DynamoDB can stop a
   * `Query` at a megabyte of scanned data rather than at a row; it is not
   * reachable through this query today — no filter expression, a `KEYS_ONLY`
   * index — and it is one branch rather than a shape to reason about again later.
   * Such a page proves nothing about the window, so the pass claims nothing about
   * it either: the cursor stays put and the next pass asks the same lower bound.
   */
  it('claims nothing from a page that stopped early and returned no row', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      rawIndex: { report: { keys: [], more: true } },
      index: { anticheat: [key({ kind: 'anticheat' })] },
      cases: { [CASE]: openCase() },
    })

    await h.log.poll()

    expect(said(stderr, UNREAD)).toBe(true)
    expect(h.sent).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.cursor()).toBe(Number(OPEN))
  })

  /**
   * THE POST BUDGET IS CHECKED BETWEEN GROUPS. A pass that stopped mid-stamp
   * would leave the cursor behind that stamp — it cannot go past a case it did
   * not deal with — so everything already posted at it would be posted again on
   * the next pass.
   */
  it('spends its budget in whole stamps and leaves the rest for the next pass', async () => {
    const ids = Array.from(
      { length: MAX_POSTS + 4 },
      (_, n) => `6f1c9a2e-0000-4000-8000-0000000${String(200 + n)}`,
    )

    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: {
        report: ids.map((id, n) => key({ incidentId: id, openedAt: NOW - 400_000 + n })),
      },
      cases: Object.fromEntries(ids.map((id) => [id, openCase({ incidentId: id })])),
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(MAX_POSTS)
    expect(h.cursor()).toBe(NOW - 400_000 + (MAX_POSTS - 1))

    await h.log.poll()

    // The rest, and none of the first ten a second time.
    expect(h.sent).toHaveLength(ids.length)
    expect(new Set(h.sent.map((s) => s.embed.footer?.text)).size).toBe(ids.length)
  })

  /**
   * ═══ A POLLER AN HOUR BEHIND LOOKED EXACTLY LIKE A QUIET NIGHT ═══
   *
   * EVERY OTHER PLACE THIS WALK STOPS EARLY SAYS SO — the tie overflow, the
   * strike give-up, the missing index — and the budget break, which is the one
   * that fires on the night a backlog actually matters, exited with no line at
   * any level. Fourteen cases, ten posts of budget, and nothing anywhere saying
   * four were left.
   */
  it('says a pass stopped early with cases still waiting', async () => {
    const ids = Array.from(
      { length: MAX_POSTS + 4 },
      (_, n) => `6f1c9a2e-0000-4000-8000-0000000${String(300 + n)}`,
    )

    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: {
        report: ids.map((id, n) => key({ incidentId: id, openedAt: NOW - 400_000 + n })),
      },
      cases: Object.fromEntries(ids.map((id) => [id, openCase({ incidentId: id })])),
    })

    await h.log.poll()

    expect(said(stdout, BUDGET)).toBe(true)
    expect(lineFor(stdout, BUDGET)).toContain('waiting=4')

    /**
     * ONCE, AND NOT ONCE PER STAMP. Ten groups were walked and four were left; a
     * line per group would make the log somebody reads to measure a backlog the
     * thing that hides it.
     */
    expect(stdout.filter((l) => l.includes(`msg=${JSON.stringify(BUDGET)}`))).toHaveLength(1)

    /**
     * AND IT IS `info`, WHICH IS THE RULE IN src/log.ts APPLIED RATHER THAN
     * DODGED. Nobody has to act: the next pass drains it, and the cursor has
     * already moved over what was dealt with. A `warn` would copy this into the
     * owner's status channel twice a minute for as long as the catch-up lasts —
     * making the busy night into the flood.
     */
    expect(lineFor(stdout, BUDGET)?.startsWith('<6>')).toBe(true)
    expect(said(stderr, BUDGET)).toBe(false)
  })

  /** And a pass that finished its work says nothing, which is most of them. */
  it('says nothing about a budget it did not spend', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(said(stdout, BUDGET)).toBe(false)
  })

  /* ---------------------------------------------------------------- *
   * What goes wrong.
   * ---------------------------------------------------------------- */

  it('keeps the cursor behind a case it could not read', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
      caseGet: () => Promise.resolve(failed()),
    })

    await h.log.poll()

    expect(said(stderr, 'could not read a newly filed incident, so nothing was posted about it')).toBe(
      true,
    )
    expect(h.sent).toEqual([])
    expect(h.cursor()).toBe(Number(OPEN))
  })

  it('keeps the cursor behind a record it could not send', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
      sendFails: new Error('Missing Permissions'),
    })

    await h.log.poll()

    expect(said(stderr, 'could not post the record for a newly filed incident')).toBe(true)
    expect(h.cursor()).toBe(Number(OPEN))
  })

  /**
   * AND THE RETRY IS BOUNDED, for `FAULT_LIMIT`'s reasons: a channel the bot has
   * lost Send Messages in is a `stop` on this case on every pass forever, and the
   * whole feed behind it goes quiet with nothing but a status line that stops
   * repeating. One record dropped loudly beats every later record lost silently.
   */
  it('gives up on one case after enough passes and posts the ones behind it', async () => {
    const stuck = '6f1c9a2e-0000-4000-8000-00000000000a'
    const next = '6f1c9a2e-0000-4000-8000-00000000000b'

    let refuse = true

    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: {
        report: [
          key({ incidentId: stuck, openedAt: NOW - 400_000 }),
          key({ incidentId: next, openedAt: NOW - 300_000 }),
        ],
      },
      cases: { [stuck]: openCase({ incidentId: stuck }), [next]: openCase({ incidentId: next }) },
      caseGet: (id) =>
        Promise.resolve(
          refuse && id === stuck ? failed() : ok(openCase({ incidentId: id })),
        ),
    })

    for (let pass = 0; pass < FAULT_LIMIT; pass++) await h.log.poll()

    expect(
      said(
        stderr,
        'the case-opened poll failed on the same case every pass, so it moved past it and no record was posted',
      ),
    ).toBe(true)

    refuse = false

    // The case behind the stuck one is posted rather than lost with it.
    expect(h.sent.map((s) => s.embed.footer?.text)).toEqual([next])
    expect(h.cursor()).toBe(NOW - 300_000)
  })

  it('moves past an index entry for a case the table does not have', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
      cases: {},
    })

    await h.log.poll()

    expect(said(stderr, 'the incident index names a case that is not in the table')).toBe(true)
    expect(h.sent).toEqual([])
    expect(h.cursor()).toBe(NOW - 60_000)
  })

  /**
   * ═══ A RESTART RESUMES AFTER THE LAST RECORD ACTUALLY POSTED ═══
   *
   * NOT AFTER THE LAST COMPLETED PASS. A post cannot be undone, and a pass may
   * post ten: one write at the end of the pass would replay every one of them
   * into the moderation channel on the next start. The bookmark is written as
   * soon as a stamp has posted something, so a crash costs at most the record it
   * was in the middle of.
   *
   * ONE DUPLICATE IS THE ACCEPTED COST AND IT IS NOT ZERO. The write happens
   * after the send returns, so a crash between the two repeats that record —
   * the alternative loses one instead, and a moderation record that never
   * existed with nothing saying so is the worse failure.
   */
  it('resumes after the last record it actually posted, not the last completed pass', async () => {
    const ids = Array.from(
      { length: 5 },
      (_, n) => `6f1c9a2e-0000-4000-8000-0000000${String(300 + n)}`,
    )

    const index = {
      report: ids.map((id, n) => key({ incidentId: id, openedAt: NOW - 400_000 + n })),
    }
    const cases = Object.fromEntries(ids.map((id) => [id, openCase({ incidentId: id })]))

    // What was on the table the instant each record landed in the channel.
    const snapshots: Array<Record<string, string>> = []

    const first = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index,
      cases,
      afterSend: (state) => snapshots.push(Object.fromEntries(state)),
    })

    await first.log.poll()
    expect(first.sent).toHaveLength(5)

    // The crash: the process dies just after the third record is posted.
    const resumed = openHarness({ state: snapshots[2] ?? {}, index, cases })
    await resumed.log.poll()

    expect(resumed.sent.map((s) => s.embed.footer?.text)).toEqual([ids[2], ids[3], ids[4]])
  })

  /**
   * A CASE THE GAME FILED AND CLOSED IN ONE WRITE IS STILL POSTED, and this
   * poller is the only thing that will ever mention it: br_ddb writes no
   * `incident.resolve` audit row for an auto-resolved case, so the resolved half
   * never sees one. See the open question on blitz-bot#19.
   */
  it('posts a case that was filed already resolved', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { anticheat: [key({ kind: 'anticheat' })] },
      cases: {
        [CASE]: incident({
          kind: 'anticheat',
          category: 'system',
          state: 'resolved',
          resolvedByName: 'System',
          resolvedAt: NOW - 60_000,
          openedAt: NOW - 60_000,
          verdict: undefined,
        }),
      },
    })

    await h.log.poll()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.embed.title).toBe(COPY.filedTitle)
    expect(span(field(h.sent[0]?.embed as APIEmbed, COPY.resolvedBy))).toBe('System')
    expect(stdout.join('')).toContain('alreadyResolved=true')
  })

  /**
   * THE LEAK ASSERTION OVER A WHOLE PASS, not over one call to the embed builder.
   * The row the console really holds carries `summary`, the reporter's name and
   * license, and the moderator's prose; the only thing keeping any of it out of
   * the channel is what this poller renders.
   */
  it('never posts anything the reporter wrote or is named in', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
      cases: { [CASE]: wholeRow({ state: 'pending_review' }) },
    })

    await h.log.poll()

    const rendered = JSON.stringify(h.sent)
    expect(rendered).not.toContain(REPORTER)
    expect(rendered).not.toContain('Reported for')
    expect(rendered).not.toContain('license:reporter')
    expect(rendered).not.toContain('aimbot')
  })

  /**
   * THE BUTTON IS BUILT FROM THE ID THE INDEX WAS READ BY, never from the row's
   * own copy of it — the same rule `settle` keeps, and for the same reason: the
   * attribute is another repository's and `encodeURIComponent` coerces rather
   * than refusing, so a numeric one posted a live-looking button at a case that
   * does not exist.
   */
  it('builds the button from the key it read the case by', async () => {
    const h = openHarness({
      state: { [OPEN_CURSOR_KEY]: OPEN },
      index: { report: [key()] },
      cases: { [CASE]: openCase({ incidentId: 42 as unknown as string }) },
    })

    await h.log.poll()

    expect(JSON.stringify(h.sent[0]?.components)).toContain(`${ORIGIN}/incidents/${CASE}`)
    expect(said(stderr, 'an incident row carries an id that is not the key it was read by')).toBe(
      true,
    )
  })

  it('says nothing and reads nothing when the cursor row cannot be read', async () => {
    const h = openHarness({
      index: { report: [key()] },
      stateGet: () => Promise.resolve(failed()),
    })

    await h.log.poll()

    expect(said(stderr, 'could not read the case-opened poll cursor, so nothing was polled')).toBe(
      true,
    )
    expect(h.queries).toEqual([])
  })
})
