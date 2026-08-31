import { readFileSync } from 'node:fs'

import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createBanRoleSync,
  CURSOR_KEY,
  discordIdIn,
  dueFirst,
  installGameBanRole,
  isBanTrigger,
  JOIN_BACKLOG,
  MAX_BAN_READS,
  MAX_ROLE_EDITS,
  newestDiscordId,
  parseTags,
  PARTITION_SILENCE_MS,
  POLL_LIMIT,
  RECONCILE_READS,
  renderTags,
  roleReadiness,
  ROLE_PROBLEM,
  ROLE_REASON_CLEARED,
  ROLE_REASON_TAGGED,
  SETTLE_MS,
  TAGS_KEY,
  TAG_LIMIT,
  type BanRoleDeps,
  type BanRoleSync,
  type GameBanRoles,
  type RoleReadiness,
  type TaggedBan,
} from './banrole.ts'
import type { Config } from './config.ts'
import type {
  AuditRow,
  Ban,
  BotStateRow,
  DdbResult,
  IdentifierSighting,
  PlayerRecord,
} from './ddb.ts'

/**
 * The game-ban role, offline — blitz-bot#2.
 *
 * NOTHING HERE TOUCHES DISCORD OR AWS AND NOTHING HERE COULD. Every case drives
 * `createBanRoleSync` through the two seams the module declares: a `Pick` of the
 * DynamoDB layer, and a `GameBanRoles` that records role edits instead of making
 * them. That is possible at all because the module takes both as parameters, and
 * is the reason it does.
 *
 * WHAT THIS FILE IS REALLY FOR: the five traps in banrole.ts's header. Each one is
 * a way for the feature to stop working while every log line and every return
 * value still looks correct, so each one gets cases that would pass just as well
 * against a version with the bug in it unless the assertion is on the exact thing
 * the trap turns on.
 *
 *   an audit row is an intent — the poller must act on the BAN ROW, never on
 *   `outcome`, which says `pending` on every row it will ever see;
 *
 *   one ban writes several rows — the kick and the incident burst that follow a
 *   ban must not each cost a role edit;
 *
 *   an expiring ban writes no row — the reconcile is the ONLY thing in the whole
 *   system that will ever notice, and without it a temp ban is a permanent role;
 *
 *   the bot is a second writer to the audit partition — nothing here writes one,
 *   and the `Pick` is what says so;
 *
 *   the partition is documented as moving — an empty page must be distinguishable
 *   from a lost log, or the feature stops with nothing to show for it.
 */

const NOW = 1_700_000_000_000

const LICENCE = 'license:abc123'
const OTHER_LICENCE = 'license:def456'
const MEMBER = '280000000000000001'
const OTHER_MEMBER = '280000000000000002'
const DISCORD_KEY = `discord:${MEMBER}`
const GUILD = '111111111111111111'
const OTHER_GUILD = '222222222222222222'
const ROLE = '1542596612306505808'

/**
 * The journal is the real output of this module — there is no command reply to
 * edit and no member to tell — so a case that asserts a decision without
 * asserting that it was written down is only half a case. `warn` and `error` also
 * reach the status channel through the sink in src/log.ts, which is the only
 * place a silent role failure becomes visible to anybody.
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

const failed = <T,>(kind: 'timeout' | 'denied' | 'conflict' = 'timeout'): DdbResult<T> => ({
  ok: false,
  failure: { kind, op: 'get', table: 'ringmaster-bans', message: 'from the fake' },
})

function ban(over: Partial<Ban> = {}): Ban {
  return {
    license: LICENCE,
    at: NOW - 1000,
    by: 'license:admin1',
    byName: 'Admin One',
    reason: 'cheating',
    expiresAt: null,
    ...over,
  }
}

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    pk: 'AUDIT',
    ts: NOW - 60_000,
    commandId: 'command-1',
    action: 'ban.issue',
    // EVERY ROW THE POLLER SEES SAYS `pending`, WHICH IS TRAP 1. `resolve`
    // updates the same key, so a row is only ever read once and always before
    // its outcome lands. The default here is the truthful one.
    outcome: 'pending',
    actorLicense: 'license:admin1',
    actorName: 'Admin One',
    actorDiscordId: null,
    targetLicense: LICENCE,
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

interface Harness {
  readonly deps: BanRoleDeps
  readonly sync: BanRoleSync
  /** The bot-state rows, as the table would hold them. */
  readonly state: Map<string, string>
  /** Every role edit, in order. */
  readonly edits: Array<{ do: 'add' | 'remove'; member: string }>
  /** Every ban row read, in order — the read budget is asserted from this. */
  readonly reads: string[]
  /** Every `since` call, so the hold-back window can be asserted. */
  readonly windows: Array<{ after: number; until: number; limit: number | undefined }>
  /** Anything that tried to WRITE a ban. Must stay empty, on every path. */
  readonly banWrites: string[]
  /** The tags as they now stand in the state table. */
  tags(): TaggedBan[]
  cursor(): number | null
}

function harness(
  over: {
    rows?: Record<string, Ban>
    players?: Record<string, PlayerRecord>
    licences?: Record<string, string[]>
    audit?: AuditRow[]
    newest?: AuditRow | null
    state?: Record<string, string>
    standing?: RoleReadiness
    addFails?: unknown
    removeFails?: unknown
    banGet?: (key: string) => Promise<DdbResult<Ban | null>>
    statePut?: (key: string, value: string) => Promise<DdbResult<BotStateRow>>
    stateGet?: (key: string) => Promise<DdbResult<BotStateRow | null>>
    since?: () => Promise<DdbResult<AuditRow[]>>
    newestResult?: () => Promise<DdbResult<AuditRow | null>>
    now?: () => number
  } = {},
): Harness {
  const rows = over.rows ?? {}
  const players = over.players ?? { [LICENCE]: record() }
  const licences = over.licences ?? {}
  const audit = over.audit ?? []

  const state = new Map<string, string>(Object.entries(over.state ?? {}))
  const edits: Array<{ do: 'add' | 'remove'; member: string }> = []
  const reads: string[] = []
  const windows: Array<{ after: number; until: number; limit: number | undefined }> = []
  const banWrites: string[] = []

  const roles: GameBanRoles = {
    standing: () => over.standing ?? { ok: true },
    add: (member) => {
      if (over.addFails !== undefined) return Promise.reject(over.addFails)
      edits.push({ do: 'add', member })
      return Promise.resolve()
    },
    remove: (member) => {
      if (over.removeFails !== undefined) return Promise.reject(over.removeFails)
      edits.push({ do: 'remove', member })
      return Promise.resolve()
    },
  }

  const deps: BanRoleDeps = {
    now: over.now ?? (() => NOW),
    roles,
    ddb: {
      bans: {
        get:
          over.banGet ??
          ((key) => {
            reads.push(key)
            return Promise.resolve(ok(rows[key] ?? null))
          }),
        // Recorded rather than rejected: a rejection here would be swallowed by
        // whatever caught it, and "nothing tried" is the assertion.
        issue: (input) => {
          banWrites.push(`issue:${input.id}`)
          return Promise.reject(new Error('the role sync must never issue a ban'))
        },
        lift: (input) => {
          banWrites.push(`lift:${input.id}`)
          return Promise.reject(new Error('the role sync must never lift a ban'))
        },
      },
      players: {
        get: (licence) => Promise.resolve(ok(players[licence] ?? null)),
      },
      playerIds: {
        licensesFor: (id) => Promise.resolve(ok(licences[id] ?? [])),
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
        put:
          over.statePut ??
          ((key, value) => {
            state.set(key, value)
            return Promise.resolve(ok({ id: key, value, updatedAt: NOW }))
          }),
      },
      auditWindow: {
        partition: 'AUDIT',
        since: (after, until, limit) => {
          windows.push({ after, until, limit })
          if (over.since) return over.since()
          return Promise.resolve(ok(audit.filter((r) => r.ts > after && r.ts <= until)))
        },
        newest: () => {
          if (over.newestResult) return over.newestResult()
          return Promise.resolve(ok(over.newest ?? null))
        },
      },
    },
  }

  return {
    deps,
    sync: createBanRoleSync(deps),
    state,
    edits,
    reads,
    windows,
    banWrites,
    tags: () => {
      const read = parseTags(state.get(TAGS_KEY) ?? null)
      return read.ok ? read.tags : []
    },
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

/* ------------------------------------------------------------------ *
 * The pure parts.
 * ------------------------------------------------------------------ */

describe('the filter that separates a ban from everything a ban drags along', () => {
  /**
   * TRAP 2. One ban writes `ban.issue`, then a `player.kick` carrying
   * `detail.becauseOf = 'ban.issue'`, and for a permanent ban a burst of
   * `incident.resolve` with the same marker. A filter on the target, or on
   * "anything about this player in the last second", would be four decisions.
   */
  it('lets the two ban verbs through and nothing else', () => {
    expect(isBanTrigger({ action: 'ban.issue' })).toBe(true)
    expect(isBanTrigger({ action: 'ban.lift' })).toBe(true)

    expect(isBanTrigger({ action: 'player.kick' })).toBe(false)
    expect(isBanTrigger({ action: 'incident.resolve' })).toBe(false)
    expect(isBanTrigger({ action: 'player.spectate' })).toBe(false)
    expect(isBanTrigger({ action: 'maintenance.deploy' })).toBe(false)
    expect(isBanTrigger({ action: 'discord.revoked' })).toBe(false)
  })

  /**
   * THERE IS NO `ban.expire` VERB, WHICH IS TRAP 3 STATED AS A TYPE. Nothing
   * writes one and nothing ever will, so the reconcile is not a belt-and-braces
   * sweep — it is the only thing in this system that can notice an expiry. If a
   * verb like this is ever added to `AuditAction`, this line stops compiling and
   * whoever added it has to decide what the poller does with it.
   */
  it('has no expiry verb to listen for, which is why the reconcile exists', () => {
    // @ts-expect-error — 'ban.expire' is not an AuditAction, and that is the point.
    expect(isBanTrigger({ action: 'ban.expire' })).toBe(false)
  })
})

describe('the stored tag list', () => {
  const tags: TaggedBan[] = [
    { key: LICENCE, discordId: MEMBER, expiresAt: NOW + 1000, checkedAt: NOW },
    { key: DISCORD_KEY, discordId: MEMBER, expiresAt: null, checkedAt: NOW - 5 },
  ]

  it('round-trips', () => {
    const read = parseTags(renderTags(tags))
    expect(read.ok && read.tags).toEqual(tags)
  })

  it('reads an absent row as no tags rather than as a fault', () => {
    expect(parseTags(null)).toEqual({ ok: true, tags: [] })
    expect(parseTags(undefined)).toEqual({ ok: true, tags: [] })
    expect(parseTags('   ')).toEqual({ ok: true, tags: [] })
  })

  /**
   * A VALUE THAT WILL NOT PARSE IS NOT AN EMPTY LIST, AND THIS IS THE ASSERTION
   * THAT SAYS SO. "No tags" would be catastrophic: the next pass writes a fresh
   * empty list over the row and every role the bot has ever applied is orphaned
   * in one step, with nothing left that says who is wearing one.
   */
  it('refuses a value it cannot read rather than reading it as nothing', () => {
    expect(parseTags('not json at all').ok).toBe(false)
    expect(parseTags('"a string"').ok).toBe(false)
    expect(parseTags('[]').ok).toBe(false)
    expect(parseTags(JSON.stringify({ v: 1 })).ok).toBe(false)
    expect(parseTags(JSON.stringify({ v: 2, tags: [] })).ok).toBe(false)
  })

  /**
   * AN UNUSABLE ENTRY IS THE OPPOSITE CHOICE AND IS NOT AN INCONSISTENCY. An
   * entry with no key or no member names no ban row to read and nobody to take a
   * role off, so keeping it would mean carrying a record nothing can ever act on.
   */
  it('drops an entry it cannot use, loudly, and keeps the rest', () => {
    const read = parseTags(
      JSON.stringify({
        v: 1,
        tags: [{ k: LICENCE, d: MEMBER, x: null, c: 5 }, { k: '', d: MEMBER }, { d: MEMBER }, null],
      }),
    )

    expect(read.ok && read.tags).toEqual([
      { key: LICENCE, discordId: MEMBER, expiresAt: null, checkedAt: 5 },
    ])
    expect(said(stderr, 'some game-ban role tags could not be read and were dropped')).toBe(true)
  })

  /**
   * A MISSING `checkedAt` READS AS "NEVER CHECKED", which puts the entry at the
   * FRONT of the reconcile's queue — the right end for a record this file cannot
   * vouch for.
   */
  it('treats a tag with no check time as the most stale one there is', () => {
    const read = parseTags(JSON.stringify({ v: 1, tags: [{ k: LICENCE, d: MEMBER }] }))
    expect(read.ok && read.tags[0]?.checkedAt).toBe(0)
    expect(read.ok && read.tags[0]?.expiresAt).toBe(null)
  })

  /**
   * ONE-LETTER FIELD NAMES ARE THE WIRE FORMAT AND ARE LOAD-BEARING: the whole
   * list is ONE DynamoDB item with a 400KB ceiling, so a rename to something
   * readable would cost a third of the budget. Pinned because it is the kind of
   * "tidying" that looks free.
   */
  it('is written compactly, because the whole list is one item', () => {
    const written = renderTags([tags[0] as TaggedBan])

    expect(JSON.parse(written)).toEqual({
      v: 1,
      tags: [{ k: LICENCE, d: MEMBER, x: NOW + 1000, c: NOW }],
    })
    expect(written).not.toContain('discordId')
  })
})

describe('the order the reconcile works in', () => {
  const permanent: TaggedBan = { key: 'a', discordId: MEMBER, expiresAt: null, checkedAt: 100 }
  const expired: TaggedBan = { key: 'b', discordId: MEMBER, expiresAt: NOW - 1, checkedAt: 900 }
  const older: TaggedBan = { key: 'c', discordId: MEMBER, expiresAt: NOW - 500, checkedAt: 900 }
  const future: TaggedBan = { key: 'd', discordId: MEMBER, expiresAt: NOW + 10_000, checkedAt: 50 }

  /**
   * TRAP 3'S QUEUE. An entry whose expiry has passed is the one case nothing else
   * will ever report, so it goes first — soonest expiry first, so a backlog is
   * drained in the order it accumulated.
   */
  it('puts the expired ones first, oldest expiry first', () => {
    const order = dueFirst([permanent, expired, older, future], NOW).map((tag) => tag.key)
    expect(order.slice(0, 2)).toEqual(['c', 'b'])
  })

  /**
   * AND THEN LEAST RECENTLY CHECKED, which is what turns a bounded pass into a
   * rotating sweep of the whole list — the backstop for every way the poll can go
   * blind, including the partition moving.
   */
  it('then rotates through the rest, least recently checked first', () => {
    const order = dueFirst([permanent, expired, older, future], NOW).map((tag) => tag.key)
    expect(order).toEqual(['c', 'b', 'd', 'a'])
  })

  it('never treats a permanent ban as due, however old the tag is', () => {
    const order = dueFirst([permanent], NOW).map((tag) => tag.key)
    expect(order).toEqual(['a'])
    expect(dueFirst([permanent], NOW)[0]?.expiresAt).toBe(null)
  })

  /** An expiry exactly now has passed. The console's `isActive` draws it there too. */
  it('counts a ban expiring on this millisecond as due', () => {
    const now: TaggedBan = { key: 'e', discordId: MEMBER, expiresAt: NOW, checkedAt: 1 }
    expect(dueFirst([permanent, now], NOW)[0]?.key).toBe('e')
  })
})

describe('finding the Discord account behind a licence', () => {
  /**
   * THE NEWEST SIGHTING BY `lastSeen`, NOT THE LAST ARRAY ELEMENT. `licensesFor`
   * elsewhere may take `at(-1)` because that list is documented most-recent-last;
   * these per-kind arrays carry no such promise, and "whichever the array happens
   * to end with" is how an abandoned account ends up wearing a ban role.
   */
  it('picks the most recently seen account and not the last one in the array', () => {
    const found = newestDiscordId(
      record({
        identifiers: {
          discord: [
            { value: MEMBER, firstSeen: 1, lastSeen: 900 },
            { value: OTHER_MEMBER, firstSeen: 1, lastSeen: 100 },
          ],
        },
      }),
    )

    expect(found).toBe(MEMBER)
  })

  it('answers null when the game has never seen a Discord account', () => {
    expect(newestDiscordId(record({ identifiers: {} }))).toBe(null)
    expect(newestDiscordId(record({ identifiers: undefined }))).toBe(null)
    expect(newestDiscordId(null)).toBe(null)
  })

  /**
   * SHAPE-CHECKED BEFORE IT IS RETURNED. This row is written by another repo, and
   * handing whatever is in that field to `members.addRole` would be one REST
   * error per ban with an unhelpful message attached.
   */
  it('refuses a value that is not a Discord id', () => {
    const found = newestDiscordId(
      record({
        identifiers: {
          discord: [{ value: 'not-a-snowflake', firstSeen: 1, lastSeen: 900 }],
        },
      }),
    )

    expect(found).toBe(null)
  })

  /**
   * A SIGHTING WITH NO USABLE `lastSeen` MUST COST THAT SIGHTING, NOT THE ANSWER.
   * These rows are written by another repo on another box; a `NaN` in the
   * comparison would silently pick whichever account came first.
   */
  it('does not let a malformed sighting win the comparison', () => {
    const damaged = { value: OTHER_MEMBER, firstSeen: 1 } as unknown as IdentifierSighting

    const found = newestDiscordId(
      record({
        identifiers: { discord: [{ value: MEMBER, firstSeen: 1, lastSeen: 5 }, damaged] },
      }),
    )

    expect(found).toBe(MEMBER)
  })
})

describe('a ban keyed on a Discord id', () => {
  it('carries the account it is about, so no registry read is needed', () => {
    expect(discordIdIn(DISCORD_KEY)).toBe(MEMBER)
  })

  it('is not confused with a licence key', () => {
    expect(discordIdIn(LICENCE)).toBe(null)
    expect(discordIdIn('steam:110000100000000')).toBe(null)
    expect(discordIdIn('discord:not-a-snowflake')).toBe(null)
  })
})

describe('whether the bot can assign the role at all', () => {
  const fine = {
    guild: true,
    role: { managed: false, position: 4 },
    self: { manageRoles: true, highestPosition: 9, above: true },
  }

  it('says yes when the role is below the bot and Manage Roles is held', () => {
    expect(roleReadiness(fine)).toEqual({ ok: true })
  })

  /**
   * THE ONE THIS CHECK EXISTS FOR. Discord refuses a role edit unless the acting
   * member's HIGHEST role sits above the role being assigned, and role order is
   * dragged by hand in a settings page — so this is not an exotic
   * misconfiguration, it is the default outcome of making a role and not thinking
   * about where it landed. The failure is a 403 per edit and nothing in the guild
   * to explain it.
   */
  it('says no when the role sits above the bot, and names the fix', () => {
    const verdict = roleReadiness({ ...fine, self: { ...fine.self, above: false } })

    expect(verdict).toEqual({ ok: false, why: 'role-too-high' })
    expect(ROLE_PROBLEM['role-too-high']).toContain('Server Settings')
  })

  it('says no when Manage Roles is missing', () => {
    expect(roleReadiness({ ...fine, self: { ...fine.self, manageRoles: false } })).toEqual({
      ok: false,
      why: 'no-permission',
    })
  })

  it('says no for a role an integration owns, whatever the position', () => {
    expect(roleReadiness({ ...fine, role: { managed: true, position: 1 } })).toEqual({
      ok: false,
      why: 'managed-role',
    })
  })

  /**
   * THE ORDER IS STRUCTURAL: nothing further down may be reported about a guild
   * or a role that is not there. A missing role reported as "too high" would send
   * an operator to drag something that does not exist.
   */
  it('reports the most fundamental problem first', () => {
    expect(roleReadiness({ guild: false, role: null, self: null })).toEqual({
      ok: false,
      why: 'no-guild',
    })
    expect(roleReadiness({ guild: true, role: null, self: null })).toEqual({
      ok: false,
      why: 'no-role',
    })
    expect(roleReadiness({ ...fine, self: null })).toEqual({ ok: false, why: 'no-self' })
  })

  it('has a sentence for every problem it can report', () => {
    for (const why of Object.keys(ROLE_PROBLEM)) {
      expect(ROLE_PROBLEM[why as keyof typeof ROLE_PROBLEM].length).toBeGreaterThan(20)
    }
  })
})

/* ------------------------------------------------------------------ *
 * The poll.
 * ------------------------------------------------------------------ */

describe('a game ban issued in the console becomes a role', () => {
  it('reads the ban row the audit row points at, and marks the player', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      rows: { [LICENCE]: ban() },
    })

    await h.sync.poll()

    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
    expect(h.tags()).toEqual([
      { key: LICENCE, discordId: MEMBER, expiresAt: null, checkedAt: NOW },
    ])
    expect(said(stdout, 'game-ban role applied')).toBe(true)
  })

  /**
   * TRAP 1, AND THIS IS THE CASE THAT WOULD PASS AGAINST A BROKEN VERSION UNLESS
   * IT IS WRITTEN THIS WAY. `audit.begin()` writes `pending` BEFORE the action and
   * `resolve()` updates the same key afterwards, so a poll of `ts > cursor` sees
   * every row exactly once and NEVER sees the outcome land on it. A poller that
   * waited for `outcome: 'ok'` would wait forever; one that treated `pending` as
   * "not yet" would do the same.
   */
  it('acts on a row still marked pending, because that is the only state it sees', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row({ outcome: 'pending' })],
      rows: { [LICENCE]: ban() },
    })

    await h.sync.poll()

    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
  })

  /**
   * AND THE OTHER HALF OF TRAP 1: the row is a TRIGGER, not the fact. A ban that
   * failed leaves an audit row saying `ban.issue` and no active ban row, and the
   * answer is taken from the ban table rather than from the log.
   */
  it('marks nobody when the ban row it points at is not in force', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      rows: { [LICENCE]: ban({ liftedAt: NOW - 10 }) },
    })

    await h.sync.poll()

    expect(h.edits).toEqual([])
    expect(h.tags()).toEqual([])
  })

  /**
   * A `ban.issue` WITH NO BAN ROW AT ALL IS REPORTED, and that line is a guard
   * rather than noise. The other explanation for it is that the audit log's
   * `targetLicense` and the bans table's key have stopped agreeing — in which
   * case this feature marks nobody, forever, with nothing else to show for it.
   */
  it('says so when a ban was issued and no ban row can be found', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()], rows: {} })

    await h.sync.poll()

    expect(said(stderr, 'a ban was issued but no ban row could be found for it')).toBe(true)
  })

  /**
   * THE KEY-SHAPE FALLBACK. `ringmaster-bans` is keyed on a QUALIFIED identifier;
   * if the console ever writes a bare licence into the audit row, every lookup is
   * a valid `GetItem` that returns no row. One second look settles it, and the
   * `warn` is what stops the mismatch from being invisible.
   */
  it('qualifies a bare licence rather than marking nobody, and says it did', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row({ targetLicense: 'abc123' })],
      rows: { [LICENCE]: ban() },
    })

    await h.sync.poll()

    expect(h.reads).toEqual(['abc123', LICENCE])
    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
    expect(h.tags()[0]?.key).toBe(LICENCE)
    expect(said(stderr, "the audit log's target is not the bans table's key shape, so it was qualified")).toBe(
      true,
    )
  })

  it('does not look twice at a key that is already qualified', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, audit: [row()], rows: {} })

    await h.sync.poll()

    expect(h.reads).toEqual([LICENCE])
  })

  /** A `discord:`-keyed ban carries the account, so no registry read is needed. */
  it('marks a discord-keyed ban without reading the player registry', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row({ targetLicense: DISCORD_KEY })],
      rows: { [DISCORD_KEY]: ban({ license: DISCORD_KEY }) },
      players: {},
    })

    await h.sync.poll()

    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
  })

  it('marks nobody when the game has never seen a Discord account for the player', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      rows: { [LICENCE]: ban() },
      players: { [LICENCE]: record({ identifiers: {} }) },
    })

    await h.sync.poll()

    expect(h.edits).toEqual([])
    expect(said(stdout, 'the game has no Discord account for this player, so nothing was marked')).toBe(
      true,
    )
  })
})

describe('a game ban lifted in the console takes the role off', () => {
  it('removes the role and forgets the tag', async () => {
    const h = harness({
      state: {
        [CURSOR_KEY]: OPEN,
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: null, checkedAt: NOW - 10 },
        ]),
      },
      audit: [row({ action: 'ban.lift' })],
      rows: { [LICENCE]: ban({ liftedAt: NOW - 1, liftedBy: 'license:admin1' }) },
    })

    await h.sync.poll()

    expect(h.edits).toEqual([{ do: 'remove', member: MEMBER }])
    expect(h.tags()).toEqual([])
  })

  /**
   * THE INVARIANT IS "THE ROLE IS ON WHILE ANY GAME BAN STANDS". One account can
   * carry two ban rows at once — a licence one and a `discord:` one, which is
   * exactly what blitz-bot#16 writes for somebody the game has never seen — and
   * the first of them ending must drop its own record without touching the role.
   */
  it('keeps the role when another ban of the same account is still tracked', async () => {
    const h = harness({
      state: {
        [CURSOR_KEY]: OPEN,
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: null, checkedAt: NOW - 10 },
          { key: DISCORD_KEY, discordId: MEMBER, expiresAt: null, checkedAt: NOW - 10 },
        ]),
      },
      audit: [row({ action: 'ban.lift' })],
      rows: { [LICENCE]: ban({ liftedAt: NOW - 1 }), [DISCORD_KEY]: ban({ license: DISCORD_KEY }) },
    })

    await h.sync.poll()

    expect(h.edits).toEqual([])
    expect(h.tags().map((tag) => tag.key)).toEqual([DISCORD_KEY])
    expect(said(stdout, 'another game ban still stands for this account, so the role was kept')).toBe(
      true,
    )
  })

  /** A lift for somebody this bot never marked is not a role to take off. */
  it('does nothing for a ban it never marked', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row({ action: 'ban.lift' })],
      rows: { [LICENCE]: ban({ liftedAt: NOW - 1 }) },
    })

    await h.sync.poll()

    expect(h.edits).toEqual([])
  })
})

/**
 * `release` — THE UNTAG PATH /unban COMES THROUGH.
 *
 * THE OWNER'S INSTRUCTION IS THE WHOLE REASON IT IS A METHOD HERE RATHER THAN
 * TWO LINES IN A COMMAND FILE: "reuse ... banrole's own untag path so the role
 * and the bot's tag record stay in step — do not remove the role behind
 * banrole's back or its book will think the role is still on." Every case below
 * is a property `unmark` already had, now reachable by a caller that has just
 * lifted a ban by hand.
 *
 * IT NEVER READS OR WRITES A BAN ROW, which is the other half of the split: the
 * lift belongs to the command, and `banWrites` staying empty here is the
 * assertion that this half cannot have done it.
 */
describe('a ban lifted by hand from Discord', () => {
  const tagged = (...keys: string[]): string =>
    renderTags(keys.map((key) => ({ key, discordId: MEMBER, expiresAt: null, checkedAt: NOW - 10 })))

  it('takes the role off and forgets the tag', async () => {
    const h = harness({ state: { [TAGS_KEY]: tagged(LICENCE) } })

    await expect(h.sync.release([LICENCE])).resolves.toBe('cleared')

    expect(h.edits).toEqual([{ do: 'remove', member: MEMBER }])
    expect(h.tags()).toEqual([])
    expect(h.banWrites).toEqual([])
  })

  /**
   * BOTH KEYS IN ONE CALL, WHICH IS WHY IT TAKES A LIST. An account banned under
   * its licence AND under `discord:` is two tags for one person; asking about
   * them one at a time in two separate books would let the first call decide the
   * role must stay because of a tag the second was about to drop.
   */
  it('clears both keys of one account in a single pass', async () => {
    const h = harness({ state: { [TAGS_KEY]: tagged(LICENCE, DISCORD_KEY) } })

    await expect(h.sync.release([LICENCE, DISCORD_KEY])).resolves.toBe('cleared')

    expect(h.edits).toEqual([{ do: 'remove', member: MEMBER }])
    expect(h.tags()).toEqual([])
  })

  /**
   * AND THE INVARIANT SURVIVES A HAND LIFT. "The role is on while ANY game ban
   * stands": a second tag for the same account that this call was not asked
   * about keeps the role exactly where it is, and the caller is told so — an
   * admin who is not told reads the role still being there as the command having
   * failed.
   */
  it('keeps the role when another tracked ban of the same account stands', async () => {
    const h = harness({ state: { [TAGS_KEY]: tagged(LICENCE, DISCORD_KEY) } })

    await expect(h.sync.release([LICENCE])).resolves.toBe('kept')

    expect(h.edits).toEqual([])
    expect(h.tags().map((tag) => tag.key)).toEqual([DISCORD_KEY])
  })

  /**
   * NOT AN ERROR. Most people carrying a game ban were never in the guild to be
   * marked, so "there was no role on them" is the ordinary answer and the
   * command reports it as one.
   */
  it('answers not-tagged when the bot held no record for these keys', async () => {
    const h = harness({ state: { [TAGS_KEY]: tagged(DISCORD_KEY) } })

    await expect(h.sync.release([LICENCE])).resolves.toBe('not-tagged')

    expect(h.edits).toEqual([])
    expect(h.tags().map((tag) => tag.key)).toEqual([DISCORD_KEY])
  })

  it('answers not-tagged when there is no tag row at all', async () => {
    const h = harness()

    await expect(h.sync.release([LICENCE])).resolves.toBe('not-tagged')
  })

  /**
   * A TAG ROW THAT CANNOT BE READ STOPS THE PASS, exactly as it does for every
   * other pass in this file — and the caller must not report success over it.
   */
  it('fails rather than guessing when the tag row cannot be read', async () => {
    const h = harness({
      stateGet: () => Promise.resolve(failed('timeout')),
    })

    await expect(h.sync.release([LICENCE])).resolves.toBe('failed')
    expect(h.edits).toEqual([])
  })

  /**
   * AND A ROLE EDIT THAT DID NOT GO THROUGH IS A FAILURE, WITH THE TAG KEPT.
   * That is `unmark`'s ordering — the role first, then the record — so the
   * failure mode is "role still on, record still there", which the reconcile
   * pass settles within five minutes. Reporting `cleared` here would tell an
   * admin the role is off somebody it is still on.
   */
  it('reports a failure and keeps the tag when the role edit does not hold', async () => {
    const h = harness({
      state: { [TAGS_KEY]: tagged(LICENCE) },
      removeFails: new Error('429'),
    })

    await expect(h.sync.release([LICENCE])).resolves.toBe('failed')
    expect(h.tags().map((tag) => tag.key)).toEqual([LICENCE])
  })

  /**
   * WORST FIRST WHEN ONE KEY WORKED AND ANOTHER DID NOT. A run that half
   * finished has not finished, and reporting the half that worked is the report
   * that gets somebody let back in who is not.
   */
  it('reports a failure when the book cannot be written back', async () => {
    const h = harness({
      state: { [TAGS_KEY]: tagged(LICENCE) },
      statePut: () => Promise.resolve(failed('timeout')),
    })

    await expect(h.sync.release([LICENCE])).resolves.toBe('failed')
    expect(h.edits).toEqual([{ do: 'remove', member: MEMBER }])
  })
})

describe('the rows a ban drags along behind it', () => {
  /**
   * TRAP 2, END TO END. A permanent ban writes `ban.issue`, then a `player.kick`
   * carrying `detail.becauseOf = 'ban.issue'`, then a burst of `incident.resolve`
   * with the same marker. All four are about one person and one ban row; only one
   * of them is a decision.
   */
  it('makes one decision for the four rows one ban writes', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [
        row({ ts: NOW - 60_000, action: 'ban.issue' }),
        row({ ts: NOW - 59_999, action: 'player.kick', detail: { becauseOf: 'ban.issue' } }),
        row({ ts: NOW - 59_998, action: 'incident.resolve', detail: { becauseOf: 'ban.issue' } }),
        row({ ts: NOW - 59_997, action: 'incident.resolve', detail: { becauseOf: 'ban.issue' } }),
      ],
      rows: { [LICENCE]: ban() },
    })

    await h.sync.poll()

    expect(h.reads).toEqual([LICENCE])
    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
    // And the cursor still moves over all four, or they come back next pass.
    expect(h.cursor()).toBe(NOW - 59_997)
  })

  /**
   * A RE-BAN AND ITS LIFT IN ONE WINDOW ARE STILL ONE ROW IN `ringmaster-bans`,
   * and that row already holds the answer both of them are asking about. Acting
   * on each in turn would be two role edits to reach a state one read gives.
   */
  it('decides once per ban key however many trigger rows name it', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [
        row({ ts: NOW - 60_000, action: 'ban.issue' }),
        row({ ts: NOW - 50_000, action: 'ban.lift' }),
        row({ ts: NOW - 40_000, action: 'ban.issue' }),
      ],
      rows: { [LICENCE]: ban() },
    })

    await h.sync.poll()

    expect(h.reads).toEqual([LICENCE])
    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
  })

  it('ignores a trigger row that names no target, and says so', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row({ targetLicense: null })],
    })

    await h.sync.poll()

    expect(h.reads).toEqual([])
    expect(said(stderr, 'a ban audit row names no target, so no role decision was made')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * The cursor and the window.
 * ------------------------------------------------------------------ */

describe('where the poll reads from', () => {
  /**
   * TRAP 1'S HOLD-BACK. An audit row is written BEFORE the ban row it describes,
   * so the newest rows in the log are intents whose consequences have not landed.
   * Reading one and finding no ban would be read as "the ban failed", the cursor
   * would move past it, and that ban would never be marked.
   */
  it('stops reading a settle window short of now', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN } })

    await h.sync.poll()

    expect(h.windows).toEqual([{ after: NOW - 3_600_000, until: NOW - SETTLE_MS, limit: POLL_LIMIT }])
  })

  /**
   * NO CURSOR MEANS START HERE, NOT START AT THE BEGINNING. Walking the whole log
   * would re-read months of triggers to arrive at the state the bans table already
   * holds — and it still would not mark anybody whose ban predates the log.
   */
  it('records where it came in on the first ever start and replays nothing', async () => {
    const h = harness({ audit: [row()], rows: { [LICENCE]: ban() } })

    await h.sync.poll()

    expect(h.windows).toEqual([])
    expect(h.edits).toEqual([])
    expect(h.cursor()).toBe(NOW - SETTLE_MS)
    expect(
      said(
        stdout,
        'no game-ban poll cursor yet, so bans from now on will be marked and earlier ones will not',
      ),
    ).toBe(true)
  })

  it('restarts from now on a cursor it cannot read, and warns', async () => {
    const h = harness({ state: { [CURSOR_KEY]: 'not-a-number' } })

    await h.sync.poll()

    expect(h.cursor()).toBe(NOW - SETTLE_MS)
    expect(said(stderr, 'the game-ban poll cursor is not a number, so polling restarts from now')).toBe(
      true,
    )
  })

  it('moves the cursor to the newest row it dealt with', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row({ ts: NOW - 60_000 }), row({ ts: NOW - 30_000, targetLicense: OTHER_LICENCE })],
      rows: { [LICENCE]: ban() },
    })

    await h.sync.poll()

    expect(h.cursor()).toBe(NOW - 30_000)
  })

  /**
   * AN IDLE BOT MUST NOT WRITE TO DYNAMODB EVERY THIRTY SECONDS TO RECORD THAT
   * NOTHING HAPPENED. Leaving the cursor where it is costs nothing: the next pass
   * asks about a wider window with the same lower bound, which is a superset, so
   * nothing can be skipped by not writing.
   */
  it('writes nothing at all when the window was empty', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN } })

    await h.sync.poll()

    expect(h.cursor()).toBe(NOW - 3_600_000)
    expect(h.state.get(TAGS_KEY)).toBeUndefined()
  })

  it('still sees a row that lands below a window it did not move past', async () => {
    let clock = NOW

    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row({ ts: NOW + 10_000 })],
      rows: { [LICENCE]: ban() },
      now: () => clock,
    })

    // Too new to be settled, so this pass sees nothing and moves nothing.
    await h.sync.poll()
    expect(h.edits).toEqual([])

    clock = NOW + 20_000
    await h.sync.poll()

    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
  })

  /**
   * THE CURSOR STOPS WHERE THE WORK STOPPED. A ban row that could not be read is
   * a decision not made, and moving past it would turn a transient DynamoDB
   * failure into a ban that is never marked at all — the same rule
   * `reconcileModeration` keeps in src/client.ts.
   */
  it('does not move past a row whose ban could not be read', async () => {
    let calls = 0

    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [
        row({ ts: NOW - 60_000 }),
        row({ ts: NOW - 50_000, targetLicense: OTHER_LICENCE }),
        row({ ts: NOW - 40_000, targetLicense: 'license:third' }),
      ],
      rows: { [LICENCE]: ban() },
      banGet: (key) => {
        calls++
        if (calls === 2) return Promise.resolve(failed<Ban | null>())
        return Promise.resolve(ok(key === LICENCE ? ban() : null))
      },
    })

    await h.sync.poll()

    expect(h.cursor()).toBe(NOW - 60_000)
    expect(said(stderr, 'could not read a ban row, so no role decision was made')).toBe(true)
  })

  /**
   * A CURSOR THAT COULD NOT BE SAVED IS A WARN AND NOT A LOSS. The work happened;
   * the next pass reads the same window again and every decision in it is
   * idempotent.
   */
  it('reports a cursor it could not save, having done the work anyway', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      rows: { [LICENCE]: ban() },
      statePut: (key, value) =>
        key === CURSOR_KEY
          ? Promise.resolve(failed<BotStateRow>())
          : Promise.resolve(ok({ id: key, value, updatedAt: NOW })),
    })

    await h.sync.poll()

    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
    expect(said(stderr, 'the game-ban poll finished but its cursor could not be saved')).toBe(true)
  })

  /**
   * THE CURSOR MOVES ONLY OVER WORK THAT WAS ACTUALLY RECORDED. A pass's drops
   * live in one state write; if that write did not land, the decisions behind it
   * are not durable and a cursor moved past them would mean nothing ever
   * re-derives them. Repeating the window is free — every decision in it is
   * idempotent.
   */
  it('does not move the cursor when the tags it changed could not be saved', async () => {
    let allowed = true

    const h = harness({
      state: {
        [CURSOR_KEY]: OPEN,
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: null, checkedAt: NOW - 10 },
        ]),
      },
      audit: [row({ action: 'ban.lift' })],
      rows: { [LICENCE]: ban({ liftedAt: NOW - 1 }) },
      statePut: (key, value) => {
        if (key === TAGS_KEY && !allowed) return Promise.resolve(failed<BotStateRow>())
        allowed = false
        return Promise.resolve(ok({ id: key, value, updatedAt: NOW }))
      },
    })

    // The role comes off, and then the write that would have forgotten the tag
    // fails — so the cursor must stay where it was.
    allowed = false
    await h.sync.poll()

    expect(h.edits).toEqual([{ do: 'remove', member: MEMBER }])
    expect(h.cursor()).toBe(NOW - 3_600_000)
  })

  it('polls nothing at all when the cursor cannot be read', async () => {
    const h = harness({
      audit: [row()],
      rows: { [LICENCE]: ban() },
      stateGet: () => Promise.resolve(failed<BotStateRow | null>()),
    })

    await h.sync.poll()

    expect(h.windows).toEqual([])
    expect(said(stderr, 'could not read the game-ban poll cursor, so nothing was polled')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Trap 3 — the expiry nothing reports.
 * ------------------------------------------------------------------ */

describe('a ban that expires, which nothing anywhere announces', () => {
  /**
   * TRAP 3. There is no `ban.expire` verb and no process that would write one: a
   * temporary ban stops being in force because a timestamp passed. Without this
   * pass the role stays on every temp-banned player forever, and nobody would ever
   * come and take it off by hand.
   */
  it('takes the role off, with no audit row having said anything', async () => {
    const h = harness({
      state: {
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: NOW - 1, checkedAt: NOW - 100_000 },
        ]),
      },
      rows: { [LICENCE]: ban({ expiresAt: NOW - 1 }) },
    })

    await h.sync.reconcile()

    expect(h.edits).toEqual([{ do: 'remove', member: MEMBER }])
    expect(h.tags()).toEqual([])
    expect(said(stdout, 'a game ban has ended, so its role is coming off')).toBe(true)
  })

  /**
   * THE STORED EXPIRY ORDERS THE QUEUE AND NEVER DECIDES, which is trap 1 applied
   * to this file's own memory. The console can extend a ban by replacing the row,
   * so the row is read every time.
   */
  it('keeps the role when the ban row has been extended since the tag was written', async () => {
    const h = harness({
      state: {
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: NOW - 1, checkedAt: NOW - 100_000 },
        ]),
      },
      rows: { [LICENCE]: ban({ expiresAt: NOW + 86_400_000 }) },
    })

    await h.sync.reconcile()

    expect(h.edits).toEqual([])
    expect(h.tags()).toEqual([
      { key: LICENCE, discordId: MEMBER, expiresAt: NOW + 86_400_000, checkedAt: NOW },
    ])
  })

  /**
   * THE ROTATING SWEEP IS THE BACKSTOP FOR A BLIND POLL — a lost cursor, a
   * partition that moved, a ban row edited straight in the AWS console. A
   * permanent ban that was lifted while the poller saw nothing is found here.
   */
  it('finds a lifted ban the poll never heard about', async () => {
    const h = harness({
      state: {
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: null, checkedAt: 0 },
        ]),
      },
      rows: { [LICENCE]: ban({ liftedAt: NOW - 5 }) },
    })

    await h.sync.reconcile()

    expect(h.edits).toEqual([{ do: 'remove', member: MEMBER }])
  })

  it('takes the role off when the ban row has gone entirely', async () => {
    const h = harness({
      state: {
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: null, checkedAt: 0 },
        ]),
      },
      rows: {},
    })

    await h.sync.reconcile()

    expect(h.edits).toEqual([{ do: 'remove', member: MEMBER }])
  })

  it('does nothing at all when nothing is tagged', async () => {
    const h = harness()

    await h.sync.reconcile()

    expect(h.reads).toEqual([])
    expect(h.edits).toEqual([])
  })

  /**
   * A TABLE THAT IS NOT ANSWERING MAKES EVERY REMAINING ANSWER A GUESS, so the
   * pass stops and the entries left unchecked keep their place at the front of the
   * queue.
   */
  it('stops on a read failure rather than skipping ahead', async () => {
    const h = harness({
      state: {
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: NOW - 2, checkedAt: 0 },
          { key: OTHER_LICENCE, discordId: OTHER_MEMBER, expiresAt: NOW - 1, checkedAt: 0 },
        ]),
      },
      banGet: () => Promise.resolve(failed<Ban | null>()),
    })

    await h.sync.reconcile()

    expect(h.edits).toEqual([])
    expect(h.tags()).toHaveLength(2)
    expect(said(stderr, 'could not re-read a ban row, so the reconcile stopped')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Trap 5 — the partition that moves.
 * ------------------------------------------------------------------ */

describe('the audit partition, which is documented as moving one day', () => {
  /**
   * TRAP 5. The console's own note says `pk` becomes `AUDIT#<yyyy-mm>`. A poller
   * with the old key returns zero rows — not an error, not a warning, just an
   * empty page, forever, and the role sync stops with nothing to show that it has.
   * A partition holding literally nothing is what tells that apart from a quiet
   * guild.
   */
  it('says loudly that the partition it reads holds no rows at all', async () => {
    const h = harness({ newest: null })

    await h.sync.probe()

    expect(said(stderr, 'the audit partition holds no rows at all, so no game ban will be noticed')).toBe(
      true,
    )
  })

  it('is quiet when the partition is where it expects', async () => {
    const h = harness({ newest: row() })

    await h.sync.probe()

    expect(said(stdout, 'the audit log is where the game-ban poller expects it')).toBe(true)
    expect(stderr).toEqual([])
  })

  it('does not accuse a partition it could not read', async () => {
    const h = harness({ newestResult: () => Promise.resolve(failed<AuditRow | null>()) })

    await h.sync.probe()

    expect(said(stderr, 'could not read the audit log, so the game-ban poller is unverified')).toBe(
      true,
    )
  })

  /**
   * SILENCE IS CHECKED RATHER THAN ASSUMED, but only after long enough that a
   * false alarm is impossible: `ringmaster-audit` carries every console action, so
   * six hours with not one row is already unusual. A quiet half hour must not
   * probe, or the status channel fills with a question nobody asked.
   */
  it('does not ask about a merely quiet log', async () => {
    let probed = 0

    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      newestResult: () => {
        probed++
        return Promise.resolve(ok(null))
      },
    })

    await h.sync.poll()

    expect(probed).toBe(0)
  })

  it('asks once when the log has been silent for a very long time', async () => {
    let clock = NOW
    let probed = 0

    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      now: () => clock,
      newestResult: () => {
        probed++
        return Promise.resolve(ok(null))
      },
    })

    await h.sync.poll()
    expect(probed).toBe(0)

    clock = NOW + PARTITION_SILENCE_MS
    await h.sync.poll()
    expect(probed).toBe(1)

    // And not again on the very next tick, or a genuinely idle weekend becomes a
    // probe every thirty seconds.
    clock = NOW + PARTITION_SILENCE_MS + 1000
    await h.sync.poll()
    expect(probed).toBe(1)
  })

  /**
   * THE COUNTDOWN RESTARTS WHENEVER A ROW ARRIVES, which is what stops a busy
   * system from ever probing: the alarm is about a partition that has NEVER
   * answered, not about one that has been quiet since the process started.
   */
  it('stops counting silence the moment a row arrives', async () => {
    let clock = NOW + PARTITION_SILENCE_MS - 1000
    let probed = 0

    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      rows: { [LICENCE]: ban() },
      now: () => clock,
      newestResult: () => {
        probed++
        return Promise.resolve(ok(null))
      },
    })

    // A row arrives just before the window would have closed.
    await h.sync.poll()
    expect(probed).toBe(0)

    // Past the window measured from boot, but only a moment past that row. With
    // no reset this poll would probe; with one it must not.
    clock = NOW + PARTITION_SILENCE_MS + 1000
    await h.sync.poll()

    expect(probed).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * The role edits themselves.
 * ------------------------------------------------------------------ */

describe('the order the record and the role are written in', () => {
  /**
   * THE RECORD FIRST, THEN THE ROLE, AND IT IS THE ONLY ORDER THAT FAILS SAFELY.
   * What this file must never do is put a role on somebody and forget it did,
   * because nothing else in this system will ever take that role off.
   */
  it('does not put the role on when the record could not be saved', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      rows: { [LICENCE]: ban() },
      statePut: (key, value) =>
        key === TAGS_KEY
          ? Promise.resolve(failed<BotStateRow>())
          : Promise.resolve(ok({ id: key, value, updatedAt: NOW })),
    })

    await h.sync.poll()

    expect(h.edits).toEqual([])
    expect(said(stderr, 'the game-ban role tags could not be saved')).toBe(true)
  })

  /**
   * THE MIRROR IMAGE: THE ROLE FIRST, THEN THE RECORD. Dropping the record and
   * then failing to remove the role would leave a role nothing remembers.
   */
  it('keeps the record when the role could not be removed', async () => {
    const h = harness({
      state: {
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: NOW - 1, checkedAt: 0 },
        ]),
      },
      rows: { [LICENCE]: ban({ expiresAt: NOW - 1 }) },
      removeFails: new Error('429 from the fake'),
    })

    await h.sync.reconcile()

    expect(h.tags()).toHaveLength(1)
    expect(h.sync.stats().failed).toBe(1)
  })

  /**
   * `Unknown Member` AND `Unknown Role` MEAN THE ROLE IS CERTAINLY NOT ON ANYBODY
   * AS A RESULT OF THIS TAG, so the record has done its job and can go. Keeping it
   * would mean retrying a removal that can never succeed, forever.
   */
  it('forgets the tag when there is nobody to take the role off', async () => {
    const h = harness({
      state: {
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: NOW - 1, checkedAt: 0 },
        ]),
      },
      rows: { [LICENCE]: ban({ expiresAt: NOW - 1 }) },
      removeFails: unknownMember(),
    })

    await h.sync.reconcile()

    expect(h.tags()).toEqual([])
    expect(h.sync.stats().failed).toBe(0)
    expect(said(stdout, 'nobody to take the game-ban role off, so the tag was dropped')).toBe(true)
  })

  /**
   * A BANNED PLAYER WHO IS NOT IN THE GUILD IS THE ORDINARY CASE, NOT A FAULT.
   * Most people the console bans are not in the Discord server, so reporting this
   * as a failure would put a warning in the status channel for every one of them —
   * and it is the reason the join listener exists.
   */
  it('does not count a banned player who is not in the guild as a failure', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      rows: { [LICENCE]: ban() },
      addFails: unknownMember(),
    })

    await h.sync.poll()

    expect(h.sync.stats().failed).toBe(0)
    // The record is kept, so the reconcile can still clean it up when the ban ends.
    expect(h.tags()).toHaveLength(1)
    expect(said(stdout, 'the banned player is not in the guild, so there was nobody to mark')).toBe(
      true,
    )
  })
})

describe('a role edit that fails, which is otherwise completely silent', () => {
  /**
   * NOTHING IN THE GUILD SHOWS A ROLE THAT WAS NOT APPLIED: the person looks
   * unbanned, the ban row says otherwise, and there is no reply to edit and no
   * member to tell. So every failure is a `warn` — which reaches the status
   * channel through the sink in src/log.ts — and carries the running total,
   * because that channel FOLDS a repeating fault into one message and the total is
   * what says whether this is one 429 or every edit since boot.
   */
  it('warns, counts, and puts the count on the line', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      rows: { [LICENCE]: ban() },
      addFails: new Error('500 from the fake'),
    })

    await h.sync.poll()

    expect(h.sync.stats().failed).toBe(1)
    expect(h.sync.stats().lastFailureAt).toBe(NOW)
    expect(said(stderr, 'the game-ban role could not be applied')).toBe(true)
    expect(stderr.some((line) => line.includes('failures=1'))).toBe(true)
  })

  it('keeps counting across passes, so a systemic failure is distinguishable', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row(), row({ ts: NOW - 50_000, targetLicense: OTHER_LICENCE })],
      rows: { [LICENCE]: ban(), [OTHER_LICENCE]: ban({ license: OTHER_LICENCE }) },
      players: {
        [LICENCE]: record(),
        [OTHER_LICENCE]: record({
          license: OTHER_LICENCE,
          identifiers: { discord: [{ value: OTHER_MEMBER, firstSeen: 1, lastSeen: 2 }] },
        }),
      },
      addFails: new Error('500 from the fake'),
    })

    await h.sync.poll()

    expect(h.sync.stats().failed).toBe(2)
    expect(stderr.some((line) => line.includes('failures=2'))).toBe(true)
  })
})

describe('a role the bot cannot assign', () => {
  /**
   * THE BOOT CHECK IS `error` BECAUSE THE BOT CANNOT DO THE THING IT IS FOR. The
   * whole of blitz-bot#2 is one role going on and coming off; a role it cannot
   * touch is the feature being off with nothing in the guild to say so.
   */
  it('says so loudly at boot, naming what to move', () => {
    const h = harness({ standing: { ok: false, why: 'role-too-high' } })

    h.sync.check()

    expect(said(stderr, ROLE_PROBLEM['role-too-high'])).toBe(true)
  })

  it('says it is ready when it is', () => {
    const h = harness()

    h.sync.check()

    expect(said(stdout, 'the game-ban role can be assigned')).toBe(true)
  })

  /**
   * RE-ASKED BEFORE EVERY EDIT AND NOT ONLY AT BOOT. The check reads caches the
   * gateway keeps up to date, so it costs nothing — and it means an owner who
   * drags the role into place while the bot is running has a working feature
   * within one poll instead of after a restart.
   */
  it('refuses the edit rather than attempting it, and counts that separately', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      rows: { [LICENCE]: ban() },
      standing: { ok: false, why: 'no-permission' },
    })

    await h.sync.poll()

    expect(h.edits).toEqual([])
    expect(h.sync.stats().blocked).toBe(1)
    expect(h.sync.stats().failed).toBe(0)
    expect(said(stderr, ROLE_PROBLEM['no-permission'])).toBe(true)
  })

  /**
   * THE RECORD IS STILL WRITTEN, which is the superset invariant holding under a
   * blocked edit: the tag is what the reconcile uses to try again and, when the
   * ban ends, to take the role off if it ever went on.
   */
  it('still remembers the tag, so the role is not orphaned when it does go on', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row()],
      rows: { [LICENCE]: ban() },
      standing: { ok: false, why: 'role-too-high' },
    })

    await h.sync.poll()

    expect(h.tags()).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * Bounds.
 * ------------------------------------------------------------------ */

describe('everything is bounded', () => {
  function manyBans(count: number): {
    audit: AuditRow[]
    rows: Record<string, Ban>
    players: Record<string, PlayerRecord>
  } {
    const audit: AuditRow[] = []
    const rows: Record<string, Ban> = {}
    const players: Record<string, PlayerRecord> = {}

    for (let i = 0; i < count; i++) {
      const key = `license:player${String(i).padStart(3, '0')}`
      const member = String(280_000_000_000_000_000n + BigInt(i))

      audit.push(row({ ts: NOW - 100_000 + i, targetLicense: key }))
      rows[key] = ban({ license: key })
      players[key] = record({
        license: key,
        identifiers: { discord: [{ value: member, firstSeen: 1, lastSeen: 2 }] },
      })
    }

    return { audit, rows, players }
  }

  /**
   * DISCORD'S RATE LIMITS ARE PER ROUTE AND ARE NOT GENEROUS, and a burst of role
   * edits is the shape of traffic that hits them — a mass ban in the console, or a
   * reconcile finding twenty expiries after a week down.
   */
  it('makes at most a fixed number of role edits in one poll', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, ...manyBans(40) })

    await h.sync.poll()

    expect(h.edits).toHaveLength(MAX_ROLE_EDITS)
  })

  /**
   * AND THE CURSOR STOPS WITH IT, which is what makes stopping early safe rather
   * than lossy: the rows it did not reach are still in the next pass's window.
   */
  it('leaves the cursor on the last row it dealt with, so the rest come back', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN }, ...manyBans(40) })

    await h.sync.poll()

    expect(h.cursor()).toBe(NOW - 100_000 + (MAX_ROLE_EDITS - 1))

    await h.sync.poll()

    expect(h.edits).toHaveLength(MAX_ROLE_EDITS * 2)
  })

  /**
   * THE READ BUDGET IS SEPARATE FROM THE EDIT BUDGET BECAUSE THEY COUNT DIFFERENT
   * THINGS. Fifty audit rows can be fifty rows about fifty people who need no edit
   * at all, and that is still fifty round trips.
   */
  it('reads at most a fixed number of ban rows in one poll', async () => {
    const many = manyBans(40)
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: many.audit,
      // No ban rows at all, so nothing is edited and only the reads bound the pass.
      rows: {},
      players: many.players,
    })

    await h.sync.poll()

    expect(h.reads).toHaveLength(MAX_BAN_READS)
  })

  it('asks the audit log for at most one page', async () => {
    const h = harness({ state: { [CURSOR_KEY]: OPEN } })

    await h.sync.poll()

    expect(h.windows[0]?.limit).toBe(POLL_LIMIT)
  })

  it('reads at most a fixed number of ban rows in one reconcile', async () => {
    const tags: TaggedBan[] = []
    for (let i = 0; i < 40; i++) {
      tags.push({
        key: `license:player${String(i)}`,
        discordId: MEMBER,
        expiresAt: null,
        checkedAt: i,
      })
    }

    const h = harness({ state: { [TAGS_KEY]: renderTags(tags) }, rows: {} })

    await h.sync.reconcile()

    expect(h.reads).toHaveLength(RECONCILE_READS)
  })

  /**
   * THE TAG LIST IS ONE DYNAMODB ITEM AND AN ITEM HAS A CEILING. Reaching this is
   * a fault, so it is reported as one — and the oldest-checked tag is dropped
   * rather than the new one refused, because an unmarked banned player is the
   * worse of the two failures. The line names whom, so the role can be taken off
   * by hand.
   */
  it('makes room loudly rather than growing without limit', async () => {
    const tags: TaggedBan[] = []
    for (let i = 0; i < TAG_LIMIT; i++) {
      tags.push({
        key: `license:old${String(i)}`,
        discordId: MEMBER,
        expiresAt: null,
        checkedAt: i + 1,
      })
    }

    const h = harness({
      state: { [CURSOR_KEY]: OPEN, [TAGS_KEY]: renderTags(tags) },
      audit: [row()],
      rows: { [LICENCE]: ban() },
    })

    await h.sync.poll()

    expect(h.tags()).toHaveLength(TAG_LIMIT)
    expect(h.tags().some((tag) => tag.key === 'license:old0')).toBe(false)
    expect(h.tags().some((tag) => tag.key === LICENCE)).toBe(true)
    expect(said(stderr, 'the game-ban role tag list is full, so the oldest tag was forgotten')).toBe(
      true,
    )
  })
})

/* ------------------------------------------------------------------ *
 * The join.
 * ------------------------------------------------------------------ */

describe('a banned player joining the Discord', () => {
  it('puts the role on somebody a game ban stands against', async () => {
    const h = harness({
      licences: { [DISCORD_KEY]: [LICENCE] },
      rows: { [LICENCE]: ban() },
    })

    await h.sync.join(MEMBER)

    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
    expect(h.tags()).toEqual([
      { key: LICENCE, discordId: MEMBER, expiresAt: null, checkedAt: NOW },
    ])
  })

  it('does nothing for somebody with no ban', async () => {
    const h = harness({ licences: { [DISCORD_KEY]: [LICENCE] }, rows: {} })

    await h.sync.join(MEMBER)

    expect(h.edits).toEqual([])
    expect(h.tags()).toEqual([])
  })

  it('does nothing for a ban that has already expired', async () => {
    const h = harness({
      licences: { [DISCORD_KEY]: [LICENCE] },
      rows: { [LICENCE]: ban({ expiresAt: NOW - 1 }) },
    })

    await h.sync.join(MEMBER)

    expect(h.edits).toEqual([])
  })

  /**
   * THE ROLE IS RE-APPLIED EVEN WHEN THE TAG IS ALREADY THERE, and this is the
   * case the whole listener exists for. Leaving a guild strips every role, so a
   * banned player who leaves and rejoins arrives unmarked while the bot's record
   * says otherwise — a "we already know about them" shortcut here would make
   * rejoining the way to shed the role.
   */
  it('re-applies the role to somebody who left and came back', async () => {
    const h = harness({
      licences: { [DISCORD_KEY]: [LICENCE] },
      rows: { [LICENCE]: ban() },
      state: {
        [TAGS_KEY]: renderTags([
          { key: LICENCE, discordId: MEMBER, expiresAt: null, checkedAt: NOW - 1000 },
        ]),
      },
    })

    await h.sync.join(MEMBER)

    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
    expect(h.tags()).toHaveLength(1)
  })

  /**
   * TWO KEYS, AND THEY ARE THE ONLY TWO A BAN CAN BE UNDER FOR ONE ACCOUNT: the
   * licence they play on, and their `discord:` identifier. The second is what
   * blitz-bot#16 writes for somebody the game has never seen, and a check that
   * looked only at the licence would let them in unmarked.
   */
  it('checks the discord-keyed ban as well as the licence one', async () => {
    const h = harness({
      licences: { [DISCORD_KEY]: [LICENCE] },
      rows: { [DISCORD_KEY]: ban({ license: DISCORD_KEY }) },
    })

    await h.sync.join(MEMBER)

    expect(h.reads).toEqual([LICENCE, DISCORD_KEY])
    expect(h.edits).toEqual([{ do: 'add', member: MEMBER }])
  })

  it('is bounded at those two, whatever the index holds', async () => {
    const h = harness({
      licences: { [DISCORD_KEY]: ['license:one', 'license:two', 'license:three'] },
      rows: {},
    })

    await h.sync.join(MEMBER)

    // The most recent licence — the index stores them oldest first — and the
    // Discord key. Never the whole list.
    expect(h.reads).toEqual(['license:three', DISCORD_KEY])
  })

  it('says so when the identifier index could not be read, and marks nobody', async () => {
    const h = harness({ licences: {} })

    const deps: BanRoleDeps = {
      ...h.deps,
      ddb: {
        ...h.deps.ddb,
        playerIds: { licensesFor: () => Promise.resolve(failed<string[]>()) },
      },
    }

    await createBanRoleSync(deps).join(MEMBER)

    expect(h.edits).toEqual([])
    expect(
      said(stderr, 'could not read the identifier index, so a joining member was not checked'),
    ).toBe(true)
  })

  it('ignores an id that is not a snowflake without reading anything', async () => {
    const h = harness({ rows: { [LICENCE]: ban() } })

    await h.sync.join('not-an-id')

    expect(h.reads).toEqual([])
    expect(h.edits).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * Wiring.
 * ------------------------------------------------------------------ */

describe('wired to the gateway', () => {
  function fakeClient() {
    const joins: Array<(member: unknown) => void> = []
    const ready: Array<() => void> = []

    const client = {
      on: (event: unknown, handler: (member: unknown) => void) => {
        if (event === Events.GuildMemberAdd) joins.push(handler)
      },
      once: (event: unknown, handler: () => void) => {
        if (event === Events.ClientReady) ready.push(handler)
      },
    } as unknown as Client

    return { client, joins, ready }
  }

  function fakeSync(): { sync: BanRoleSync; joined: string[]; calls: string[] } {
    const joined: string[] = []
    const calls: string[] = []

    return {
      joined,
      calls,
      sync: {
        check: () => calls.push('check'),
        probe: () => {
          calls.push('probe')
          return Promise.resolve()
        },
        poll: () => {
          calls.push('poll')
          return Promise.resolve()
        },
        reconcile: () => {
          calls.push('reconcile')
          return Promise.resolve()
        },
        join: (id) => {
          joined.push(id)
          return Promise.resolve()
        },

        // `installGameBanRole` wires the timers and the join listener and does
        // NOT call this: `release` is reached from /unban, on demand, and a
        // wiring that started calling it on a schedule would be taking roles off
        // nobody asked about.
        release: () => {
          calls.push('release')
          return Promise.resolve('not-tagged' as const)
        },

        stats: () => ({
          tagged: 0,
          cleared: 0,
          failed: 0,
          blocked: 0,
          lastFailureAt: null,
        }),
      },
    }
  }

  const config = { guildId: GUILD, gameBanRoleId: ROLE } as unknown as Config
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('checks the role and the partition before it polls anything', async () => {
    const { client, ready } = fakeClient()
    const fake = fakeSync()

    installGameBanRole(client, config, {} as unknown as BanRoleDeps['ddb'], { sync: fake.sync })
    ready[0]?.()
    await settle()

    expect(fake.calls.slice(0, 2)).toEqual(['check', 'probe'])
    expect(fake.calls).toContain('poll')
    expect(fake.calls).toContain('reconcile')
  })

  /**
   * ONE GUILD IS A FACT ABOUT TODAY'S INVITE LIST AND NOT A PROPERTY OF THE
   * PROCESS. A join somewhere else is somebody else's member being handed this
   * community's ban role.
   */
  it('ignores a join in another guild entirely', async () => {
    const { client, joins } = fakeClient()
    const fake = fakeSync()

    installGameBanRole(client, config, {} as unknown as BanRoleDeps['ddb'], { sync: fake.sync })
    joins[0]?.({ id: MEMBER, guild: { id: OTHER_GUILD } })
    await settle()

    expect(fake.joined).toEqual([])
  })

  it('checks a join in our own guild', async () => {
    const { client, joins } = fakeClient()
    const fake = fakeSync()

    installGameBanRole(client, config, {} as unknown as BanRoleDeps['ddb'], { sync: fake.sync })
    joins[0]?.({ id: MEMBER, guild: { id: GUILD } })
    await settle()

    expect(fake.joined).toEqual([MEMBER])
  })

  /**
   * A RAID IS THE CASE THE BACKLOG EXISTS FOR. Every join costs up to three
   * DynamoDB reads, and an unbounded queue turns a raid into an unbounded bill —
   * so the extras are dropped, with a line naming them, rather than queued behind
   * a check that would run twenty minutes late.
   */
  it('drops joins beyond the backlog rather than queueing them all', async () => {
    const { client, joins } = fakeClient()

    const joined: string[] = []

    // A holder rather than a `let`, so the narrowing inside the closure below
    // does not convince the compiler this is permanently null.
    const held: { release: (() => void) | undefined } = { release: undefined }

    const sync: BanRoleSync = {
      ...fakeSync().sync,
      join: async (id) => {
        joined.push(id)
        // The first one is held open, so everything after it queues behind it.
        if (held.release === undefined) {
          await new Promise<void>((resolve) => {
            held.release = resolve
          })
        }
      },
    }

    installGameBanRole(client, config, {} as unknown as BanRoleDeps['ddb'], { sync })

    for (let i = 0; i < JOIN_BACKLOG + 20; i++) {
      joins[0]?.({ id: String(280_000_000_000_000_000n + BigInt(i)), guild: { id: GUILD } })
    }

    await settle()
    held.release?.()
    await settle()

    expect(joined.length).toBeLessThanOrEqual(JOIN_BACKLOG + 1)
    expect(said(stderr, 'too many joins at once, so this one was not checked for a game ban')).toBe(
      true,
    )
  })

  /**
   * SERIAL RATHER THAN PARALLEL, because two joins can be about one ban row and
   * because a raid arriving as fifty concurrent DynamoDB reads is how a background
   * feature becomes the reason a slash command times out.
   */
  it('checks joins one at a time', async () => {
    const { client, joins } = fakeClient()

    let inFlight = 0
    let most = 0

    const sync: BanRoleSync = {
      ...fakeSync().sync,
      join: async () => {
        inFlight++
        most = Math.max(most, inFlight)
        await new Promise<void>((r) => setTimeout(r, 0))
        inFlight--
      },
    }

    installGameBanRole(client, config, {} as unknown as BanRoleDeps['ddb'], { sync })

    for (let i = 0; i < 5; i++) {
      joins[0]?.({ id: String(280_000_000_000_000_000n + BigInt(i)), guild: { id: GUILD } })
    }

    await new Promise<void>((r) => setTimeout(r, 20))

    expect(most).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * The things this module must never be able to do.
 * ------------------------------------------------------------------ */

describe('what the game-ban role can and cannot reach', () => {
  /**
   * A GAME BAN NEVER CAUSES A DISCORD BAN, and the enforcement is that there is no
   * verb here to do it with. The seam offers `add` and `remove` on one role id;
   * nothing in this module names a ban, a kick, or a member removal.
   */
  it('has no way to ban, kick or remove anybody from the guild', () => {
    for (const forbidden of ['bans.create', 'members.ban(', 'members.kick', '.kick(', '.ban(']) {
      expect(SOURCE, forbidden).not.toContain(forbidden)
    }
  })

  /**
   * IT IS DOWNSTREAM OF SOMEBODY ELSE'S MODERATION DECISION. The day it can write
   * to `ringmaster-bans` it stops being a mirror and becomes a second, unreviewed
   * opinion about who is banned. A full pass over all three entry points must
   * touch neither writer.
   */
  it('never issues or lifts a ban, on any path', async () => {
    const h = harness({
      state: { [CURSOR_KEY]: OPEN },
      audit: [row(), row({ ts: NOW - 50_000, action: 'ban.lift' })],
      rows: { [LICENCE]: ban() },
      licences: { [DISCORD_KEY]: [LICENCE] },
    })

    await h.sync.poll()
    await h.sync.reconcile()
    await h.sync.join(MEMBER)

    expect(h.banWrites).toEqual([])
  })

  /**
   * TRAP 4. The bot is a second writer to `pk = 'AUDIT'` and `nextTs` breaks a
   * tie per process, so two processes in one millisecond still collide. Nothing
   * here writes an audit row, and the `Pick` in `BanRoleDeps` is what says so:
   * `auditWindow` is a read-only capability and `audit` — which carries `begin`
   * and `resolve` — is deliberately not in it.
   *
   * ASSERTED FROM THE DEPS OBJECT AND NOT FROM THE SOURCE, because the fake is
   * typed as `BanRoleDeps['ddb']`: a member missing from it is a compile error and
   * a member added to it that the `Pick` does not name is an excess-property
   * error. Its key list therefore IS the declared reach.
   */
  it('cannot write an audit row, because it never asked for the ability', () => {
    const reach = Object.keys(harness().deps.ddb).sort()

    expect(reach).toEqual(['auditWindow', 'bans', 'botState', 'playerIds', 'players'])
    expect(reach).not.toContain('audit')
  })

  /**
   * THE ROLE EDITS ARE STAMPED WITH A REASON, so an admin scrolling the guild's
   * audit log can see which process did this and why. Two reasons, because a ban
   * being issued and a ban having ended are not the same sentence — and reusing
   * #16's `ROLE_AUDIT_REASON` would have said "lifted" for an expiry.
   */
  it('gives Discord a reason for each direction, and they differ', () => {
    expect(ROLE_REASON_TAGGED).not.toBe(ROLE_REASON_CLEARED)
    expect(ROLE_REASON_TAGGED).toContain('blitz-bot')
    expect(ROLE_REASON_CLEARED).toContain('blitz-bot')
  })
})

/** This module's own source, for the reach assertions above. */
const SOURCE = readFileSync(new URL('./banrole.ts', import.meta.url), 'utf8')

/** The error Discord returns for somebody who is not in the guild. */
function unknownMember(): DiscordAPIError {
  return new DiscordAPIError(
    { code: RESTJSONErrorCodes.UnknownMember, message: 'Unknown Member' },
    RESTJSONErrorCodes.UnknownMember,
    404,
    'PATCH',
    'https://discord.com/api/v10/guilds/1/members/2',
    {},
  )
}
