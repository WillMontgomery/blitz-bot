import { ApplicationCommandOptionType } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  tableNames,
  type Ban,
  type Ddb,
  type DdbFailure,
  type DdbResult,
  type GameProfile,
  type PlayerRecord,
} from '../ddb.ts'
import { setSink } from '../log.ts'
import { TARGET_OPTION, type Invocation } from './command.ts'
import {
  embedUnits,
  flattenEmbed,
  gatherProfile,
  lazyReadsFrom,
  profileCommand,
  profileEmbed,
  readsFrom,
  trimEmbed,
  type MatchSummary,
  type ProfileData,
  type ProfileReads,
} from './profile.ts'

/**
 * `/profile`, offline.
 *
 * NOTHING HERE TOUCHES AWS OR DISCORD. `gatherProfile` takes a `ProfileReads`
 * that is five functions long, `profileEmbed` is pure and takes a clock, and
 * the command itself is a factory over the same seam — so a denied table, a
 * timed-out index and a player with three licences are all objects written a
 * few lines above the assertion.
 *
 * THREE THINGS THIS FILE IS REALLY FOR, and they are the three that would fail
 * silently in production:
 *
 *   EVERY LICENCE IS SHOWN AND THE COUNT IS SAID. `ringmaster-player-ids`
 *   returns a list, most recent LAST, and more than one entry is the
 *   identifier-reuse signal the console files incidents about. A version that
 *   read `licences[0]` and stopped would pass every happy-path test ever
 *   written and hide the most interesting thing the bot knows.
 *
 *   THE BUDGET IS MEASURED IN UTF-16 UNITS. Discord's limits apply to the JSON
 *   as it arrives, so a code-point count understates every astral character by
 *   half — the bug `fitEmbed` in client.ts had, where 4096 musical symbols
 *   passed a 4096 guard at 8192 units. The astral cases below fail against a
 *   `[...text].length` implementation and pass against `text.length`.
 *
 *   A TRUNCATION SAYS HOW MUCH IT TOOK. Two different cuts can happen to match
 *   history — the reader's limit and the embed's budget — and reporting one as
 *   the other is a reply that reads as complete and is not.
 */

const DISCORD = '444444444444444444'
const GUILD = '111111111111111111'
const OLDEST = 'license:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MIDDLE = 'license:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NEWEST = 'license:cccccccccccccccccccccccccccccccccccccccc'

/** One code point, TWO UTF-16 units. The whole point of the astral cases. */
const ASTRAL = '𝄞'

const NOW = Date.parse('2026-08-30T12:00:00.000Z')

const stderr: string[] = []
const stdout: string[] = []

beforeEach(() => {
  stderr.length = 0
  stdout.length = 0

  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString())
    return true
  }) as unknown as typeof process.stderr.write)

  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString())
    return true
  }) as unknown as typeof process.stdout.write)
})

afterEach(() => {
  vi.restoreAllMocks()

  // The sink is module state in log.ts, the same trap client.test.ts closes.
  setSink(null)
})

function ok<T>(value: T): DdbResult<T> {
  return { ok: true, value }
}

/**
 * A failure with an operator-facing message on it, so the cases below can
 * assert that the message reaches the journal and NOT the reply.
 */
function failed(kind: DdbFailure['kind']): { ok: false; failure: DdbFailure } {
  return {
    ok: false,
    failure: {
      kind,
      op: 'get',
      table: 'ringmaster-something',
      message: 'arn:aws:iam::123456789012:role/RingmasterTableAccess is not authorized',
    },
  }
}

function reads(over: Partial<ProfileReads> = {}): ProfileReads {
  return {
    licencesFor: () => Promise.resolve(ok([NEWEST])),
    ban: () => Promise.resolve(ok(null)),
    career: () => Promise.resolve(ok(null)),
    registry: () => Promise.resolve(ok(null)),
    ...over,
  }
}

function career(over: Partial<GameProfile> = {}): GameProfile {
  return {
    matches: 12,
    wins: 2,
    top10s: 5,
    kills: 30,
    deaths: 10,
    downs: 14,
    revives: 3,
    damageDealt: 9001,
    playtimeSec: 7200,
    soloMatches: 4,
    squadMatches: 8,
    xp: 4500,
    level: 7,
    balance: 250,
    lastMatchAt: Date.parse('2026-08-29T10:00:00.000Z'),
    ...over,
  }
}

function registry(over: Partial<PlayerRecord> = {}): PlayerRecord {
  return {
    license: NEWEST,
    name: 'Somebody',
    firstSeen: Date.parse('2025-01-01T00:00:00.000Z'),
    lastSeen: Date.parse('2026-08-29T00:00:00.000Z'),
    sessions: 40,
    playtimeMs: 90 * 60_000,
    ...over,
  }
}

function ban(over: Partial<Ban> = {}): Ban {
  return {
    license: NEWEST,
    at: Date.parse('2026-01-01T00:00:00.000Z'),
    by: OLDEST,
    byName: 'An Admin',
    reason: 'cheating',
    expiresAt: null,
    ...over,
  }
}

function data(over: Partial<ProfileData> = {}): ProfileData {
  return {
    discordId: DISCORD,
    licences: [NEWEST],
    current: NEWEST,
    bans: [{ licence: NEWEST, ban: null }],
    bansSkipped: 0,
    career: career(),
    registry: registry(),
    matches: [],
    unreached: [],
    ...over,
  }
}

function match(index: number): MatchSummary {
  return {
    sk: `match#${index}`,
    at: NOW - index * 3_600_000,
    placement: (index % 20) + 1,
    kills: index % 9,
  }
}

function invocation(over: Partial<Invocation> = {}): Invocation {
  return {
    commandName: 'profile',
    guildId: GUILD,
    userId: '555555555555555555',
    roleIds: ['222222222222222222'],
    targetId: DISCORD,
    ...over,
  }
}

/** Every field value the embed carries, for the cap assertions. */
function values(embed: { fields: { name: string; value: string }[] }): string[] {
  return embed.fields.map((entry) => entry.value)
}

function fieldNamed(
  embed: { fields: { name: string; value: string }[] },
  name: string,
): string | undefined {
  return embed.fields.find((entry) => entry.name === name)?.value
}

describe('gatherProfile', () => {
  it('qualifies nothing itself and reads every source against the MOST RECENT licence', async () => {
    const seen: Array<[string, string]> = []

    const got = await gatherProfile(
      reads({
        licencesFor: (id) => {
          seen.push(['licences', id])
          // Most recent LAST, which is how the index stores them.
          return Promise.resolve(ok([OLDEST, MIDDLE, NEWEST]))
        },
        ban: (licence) => {
          seen.push(['ban', licence])
          return Promise.resolve(ok(null))
        },
        career: (licence) => {
          seen.push(['career', licence])
          return Promise.resolve(ok(career()))
        },
        registry: (licence) => {
          seen.push(['registry', licence])
          return Promise.resolve(ok(registry()))
        },
      }),
      DISCORD,
    )

    // The seam takes the RAW id: qualifying is `readsFrom`'s job and doing it
    // twice would produce `discord:discord:…` and an empty answer.
    expect(seen).toContainEqual(['licences', DISCORD])

    expect(got.current).toBe(NEWEST)
    expect(got.licences).toEqual([OLDEST, MIDDLE, NEWEST])

    // Career and registry follow the current licence and nothing else.
    expect(seen).toContainEqual(['career', NEWEST])
    expect(seen).toContainEqual(['registry', NEWEST])
    expect(seen.filter(([call]) => call === 'career')).toHaveLength(1)

    // Bans are read for every licence, because a clean current licence beside a
    // banned old one is the whole reason the list is worth showing.
    expect(seen.filter(([call]) => call === 'ban').map(([, licence]) => licence)).toEqual([
      OLDEST,
      MIDDLE,
      NEWEST,
    ])
  })

  it('treats a Discord account with no record as an answer, not a failure', async () => {
    let asked = 0

    const got = await gatherProfile(
      reads({
        licencesFor: () => Promise.resolve(ok([])),
        career: () => {
          asked++
          return Promise.resolve(ok(null))
        },
      }),
      DISCORD,
    )

    expect(got.licences).toEqual([])
    expect(got.current).toBeNull()

    // Nothing is keyed on a licence that does not exist, so nothing else is asked.
    expect(asked).toBe(0)

    // And it is not reported as something that could not be read.
    expect(got.unreached).toEqual([])
  })

  it('reports an unreadable index as itself rather than as an empty account', async () => {
    const got = await gatherProfile(
      reads({ licencesFor: () => Promise.resolve(failed('timeout')) }),
      DISCORD,
    )

    expect(got.unreached).toEqual([{ source: 'licences', why: 'timeout' }])
    expect(got.licences).toEqual([])
  })

  it('keeps what it got when one source is denied, and names the one it could not reach', async () => {
    const got = await gatherProfile(
      reads({
        // The failure the bot actually has today: `br-players` is outside
        // `RingmasterTableAccess`. See docs/aws-notes.md.
        career: () => Promise.resolve(failed('denied')),
        registry: () => Promise.resolve(ok(registry())),
      }),
      DISCORD,
    )

    expect(got.career).toBeNull()
    expect(got.registry).not.toBeNull()
    expect(got.unreached).toContainEqual({ source: 'career', why: 'denied' })
  })

  it('writes the SDK message to the journal and keeps it out of the value', async () => {
    const got = await gatherProfile(
      reads({ career: () => Promise.resolve(failed('denied')) }),
      DISCORD,
    )

    const journal = [...stdout, ...stderr].join('')

    expect(journal).toContain('RingmasterTableAccess is not authorized')
    expect(JSON.stringify(got)).not.toContain('RingmasterTableAccess')
  })

  it('reports one entry per source however many reads of it failed', async () => {
    const got = await gatherProfile(
      reads({
        licencesFor: () => Promise.resolve(ok([OLDEST, MIDDLE, NEWEST])),
        ban: () => Promise.resolve(failed('denied')),
      }),
      DISCORD,
    )

    expect(got.unreached.filter((entry) => entry.source === 'bans')).toHaveLength(1)
    expect(got.bans).toEqual([])
  })

  it('caps the ban fan-out and counts what it skipped', async () => {
    const many = Array.from({ length: 14 }, (_, index) => `license:${String(index).repeat(8)}`)
    const asked: string[] = []

    const got = await gatherProfile(
      reads({
        licencesFor: () => Promise.resolve(ok(many)),
        ban: (licence) => {
          asked.push(licence)
          return Promise.resolve(ok(null))
        },
      }),
      DISCORD,
    )

    expect(asked).toHaveLength(10)
    expect(got.bansSkipped).toBe(4)

    // The MOST RECENT ten, because those are the ones the account is using.
    expect(asked).toEqual(many.slice(-10))

    // The full list survives even though only ten were checked.
    expect(got.licences).toHaveLength(14)
  })

  it('says match history is unavailable when this build has no reader for it', async () => {
    const got = await gatherProfile(reads(), DISCORD)

    // Not a DynamoDB failure: nothing was asked. Folding it into `error` would
    // send an operator to look at a table that was never queried.
    expect(got.unreached).toContainEqual({ source: 'matches', why: 'unavailable' })
    expect(got.matches).toEqual([])
  })

  it('uses a match reader when one is supplied', async () => {
    const asked: Array<[string, number]> = []

    const got = await gatherProfile(
      reads({
        matches: (licence, limit) => {
          asked.push([licence, limit])
          return Promise.resolve(ok([match(0), match(1)]))
        },
      }),
      DISCORD,
    )

    expect(asked).toEqual([[NEWEST, 25]])
    expect(got.matches).toHaveLength(2)
    expect(got.unreached).toEqual([])
  })

  it('names a match reader that failed, distinctly from one that is absent', async () => {
    const got = await gatherProfile(
      reads({ matches: () => Promise.resolve(failed('no-such-table')) }),
      DISCORD,
    )

    expect(got.unreached).toContainEqual({ source: 'matches', why: 'no-such-table' })
  })
})

describe('readsFrom', () => {
  /** The real module, reduced to what a profile asks of it. */
  function fakeDdb(seen: Array<[string, string]>): Ddb {
    const unused = () => Promise.reject(new Error('not part of a profile lookup'))

    return {
      region: 'us-east-2',
      tables: tableNames('ringmaster-', 'br-'),
      timeoutMs: 2_000,

      bans: {
        get: (licence) => {
          seen.push(['bans', licence])
          return Promise.resolve(ok(null))
        },
      },
      players: {
        get: (licence) => {
          seen.push(['players', licence])
          return Promise.resolve(ok(null))
        },
      },
      playerIds: {
        licensesFor: (id) => {
          seen.push(['playerIds', id])
          return Promise.resolve(ok([NEWEST]))
        },
      },
      gamePlayers: {
        profile: (licence) => {
          seen.push(['gamePlayers', licence])
          return Promise.resolve(ok(null))
        },
      },

      maintenance: { current: unused },
      audit: { begin: unused, resolve: unused, recent: unused },
      botState: { get: unused, put: unused },
    }
  }

  it('qualifies the Discord id and passes licences through exactly as stored', async () => {
    const seen: Array<[string, string]> = []

    await gatherProfile(readsFrom(fakeDdb(seen)), DISCORD)

    // `ringmaster-player-ids` is keyed on the QUALIFIED identifier: a lookup for
    // the bare id is a valid GetItem that returns no row, and the bot would then
    // say "never been here" about somebody who is in the table.
    expect(seen).toContainEqual(['playerIds', `discord:${DISCORD}`])

    // And the licences come back qualified already. Qualifying them again would
    // produce `license:license:…` and the same confident empty answer.
    expect(seen).toContainEqual(['bans', NEWEST])
    expect(seen).toContainEqual(['players', NEWEST])
    expect(seen).toContainEqual(['gamePlayers', NEWEST])
  })

  it('supplies no match reader, so a real profile says so instead of showing none', () => {
    expect(readsFrom(fakeDdb([])).matches).toBeUndefined()

    // And the lazy one must not accidentally supply one by delegating: a
    // `matches` that exists would render an empty history instead of saying
    // there is no reader for it.
    expect(lazyReadsFrom(() => fakeDdb([])).matches).toBeUndefined()
  })

  it('builds no client until a profile is actually asked for', async () => {
    let built = 0
    const seen: Array<[string, string]> = []

    const reads = lazyReadsFrom(() => {
      built++
      return fakeDdb(seen)
    })

    // The command list in ./index.ts is a module-level constant, so anything
    // eager here would construct an SDK client at import — in commands.test.ts
    // among other places, which is meant to run offline.
    expect(built).toBe(0)

    await gatherProfile(reads, DISCORD)
    expect(built).toBe(1)
    expect(seen).toContainEqual(['playerIds', `discord:${DISCORD}`])

    // One client for the life of the process: it holds the pool and the
    // resolved instance role, and rebuilding it per lookup re-resolves both.
    await gatherProfile(reads, DISCORD)
    expect(built).toBe(1)
  })
})

describe('profileEmbed: the licence list', () => {
  it('shows every licence and says plainly that there is more than one', () => {
    const embed = profileEmbed(
      data({ licences: [OLDEST, MIDDLE, NEWEST], current: NEWEST }),
      NOW,
    )

    expect(embed.description).toContain(
      '3 licences — this Discord account has played under more than one.',
    )

    const listed = fieldNamed(embed, 'Licences') ?? ''

    // ALL of them. Showing only the first hides the identifier-reuse signal.
    expect(listed).toContain(OLDEST)
    expect(listed).toContain(MIDDLE)
    expect(listed).toContain(NEWEST)
  })

  it('marks the most recent licence, which the index stores LAST', () => {
    const listed =
      fieldNamed(profileEmbed(data({ licences: [OLDEST, NEWEST] }), NOW), 'Licences') ?? ''

    expect(listed).toContain(`${NEWEST} (current)`)
    expect(listed).not.toContain(`${OLDEST} (current)`)

    // Newest first on the page, so the cut below can only ever eat history.
    expect(listed.indexOf(NEWEST)).toBeLessThan(listed.indexOf(OLDEST))
  })

  it('does not say "more than one" for exactly one', () => {
    const embed = profileEmbed(data({ licences: [NEWEST] }), NOW)

    expect(embed.description).toContain('One licence.')
    expect(embed.description).not.toContain('more than one')
  })

  it('keeps the current licence and states the count when the list is too long', () => {
    const many = Array.from({ length: 60 }, (_, index) => `license:${String(index % 10).repeat(40)}`)
    const listed = fieldNamed(profileEmbed(data({ licences: many }), NOW), 'Licences') ?? ''

    expect(listed.length).toBeLessThanOrEqual(1024)

    // The one that was dropped is named as a count rather than left silent.
    const omitted = /\+(\d+) older licences not shown\./u.exec(listed)
    expect(omitted).not.toBeNull()

    const shown = listed.split('\n').length - 1
    expect(shown + Number(omitted?.[1])).toBe(60)

    // And the current one survived, because the list is rendered newest first.
    expect(listed).toContain('(current)')
  })
})

describe('profileEmbed: no record, and no index', () => {
  it('says there is no record and offers no fields keyed on a licence', () => {
    const embed = profileEmbed(data({ licences: [], current: null, bans: [] }), NOW)

    expect(embed.description).toContain('No player record for this Discord account.')
    expect(fieldNamed(embed, 'Licences')).toBeUndefined()
    expect(fieldNamed(embed, 'Career')).toBeUndefined()
  })

  it('says the index could not be read, which is the opposite sentence', () => {
    const embed = profileEmbed(
      data({
        licences: [],
        current: null,
        bans: [],
        career: null,
        registry: null,
        unreached: [{ source: 'licences', why: 'timeout' }],
      }),
      NOW,
    )

    expect(embed.description).not.toContain('No player record')
    expect(embed.description).toContain('could not be read')
    expect(fieldNamed(embed, 'Could not be read')).toContain('licences: timeout')
  })
})

describe('profileEmbed: bans', () => {
  it('reports an active ban on ANY licence, not only the current one', () => {
    const embed = profileEmbed(
      data({
        licences: [OLDEST, NEWEST],
        bans: [
          { licence: OLDEST, ban: ban({ license: OLDEST, reason: 'ban evasion' }) },
          { licence: NEWEST, ban: null },
        ],
      }),
      NOW,
    )

    const bans = fieldNamed(embed, 'Bans') ?? ''

    expect(bans).toContain(OLDEST)
    expect(bans).toContain('ACTIVE, permanent')
    expect(bans).toContain('ban evasion')
  })

  it('distinguishes lifted, expired and active against the injected clock', () => {
    const embed = profileEmbed(
      data({
        licences: [OLDEST, MIDDLE, NEWEST],
        bans: [
          {
            licence: OLDEST,
            ban: ban({ license: OLDEST, liftedAt: Date.parse('2026-02-01T00:00:00.000Z') }),
          },
          {
            licence: MIDDLE,
            ban: ban({ license: MIDDLE, expiresAt: Date.parse('2026-03-01T00:00:00.000Z') }),
          },
          {
            licence: NEWEST,
            ban: ban({ license: NEWEST, expiresAt: Date.parse('2026-12-01T00:00:00.000Z') }),
          },
        ],
      }),
      NOW,
    )

    const bans = fieldNamed(embed, 'Bans') ?? ''

    expect(bans).toContain(`${OLDEST}: lifted 2026-02-01T00:00:00.000Z`)
    expect(bans).toContain(`${MIDDLE}: expired 2026-03-01T00:00:00.000Z`)
    expect(bans).toContain(`${NEWEST}: ACTIVE until 2026-12-01T00:00:00.000Z`)
  })

  it('says so when nothing read carries a ban', () => {
    expect(fieldNamed(profileEmbed(data(), NOW), 'Bans')).toContain(
      'No ban on any licence read.',
    )
  })

  it('states the licences the cap meant were never checked', () => {
    expect(fieldNamed(profileEmbed(data({ bansSkipped: 4 }), NOW), 'Bans')).toContain(
      '4 older licences were not checked for bans.',
    )
  })

  it('counts what it dropped without borrowing the licence field’s sentence', () => {
    const licences = Array.from({ length: 10 }, (_, index) => `license:${String(index).repeat(40)}`)

    const bans =
      fieldNamed(
        profileEmbed(
          data({
            licences,
            bans: licences.map((licence) => ({
              licence,
              ban: ban({ license: licence, reason: 'r'.repeat(200) }),
            })),
          }),
          NOW,
        ),
        'Bans',
      ) ?? ''

    expect(bans.length).toBeLessThanOrEqual(1024)

    const omitted = /\+(\d+) more not shown\./u.exec(bans)
    expect(omitted).not.toBeNull()

    // Not "older licences not shown": these are bans, and a field that reports
    // a cut it did not make is the failure this file is written against.
    expect(bans).not.toContain('older licences not shown')

    expect(bans.split('\n').length - 1 + Number(omitted?.[1])).toBe(10)
  })

  it('does not let a newline in a ban reason forge a line', () => {
    const embed = profileEmbed(
      data({
        bans: [{ licence: NEWEST, ban: ban({ reason: 'first\nlicense:evil: ACTIVE, permanent' }) }],
      }),
      NOW,
    )

    const bans = fieldNamed(embed, 'Bans') ?? ''

    expect(bans.split('\n')).toHaveLength(1)
    expect(bans).toContain('first license:evil')
  })
})

describe('profileEmbed: match history', () => {
  it('says nothing was omitted when nothing was', () => {
    const matches = fieldNamed(
      profileEmbed(data({ matches: [match(0), match(1)], career: career({ matches: 2 }) }), NOW),
      'Recent matches',
    )

    expect(matches).not.toContain('not shown')
    expect(matches).not.toContain('recorded in all')
  })

  it('states the reader’s cut even when the embed dropped nothing', () => {
    // 3 read out of 300 played: the cut nobody would otherwise see, and it is
    // the larger of the two.
    const matches = fieldNamed(
      profileEmbed(
        data({ matches: [match(0), match(1), match(2)], career: career({ matches: 300 }) }),
        NOW,
      ),
      'Recent matches',
    )

    expect(matches).toContain('300 matches recorded in all.')
    expect(matches).not.toContain('not shown')
  })

  it('states BOTH cuts, and the counts add up to what was read', () => {
    const read = Array.from({ length: 25 }, (_, index) => match(index))

    const matches =
      fieldNamed(
        profileEmbed(data({ matches: read, career: career({ matches: 300 }) }), NOW),
        'Recent matches',
      ) ?? ''

    const omitted = /(\d+) of the 25 read were not shown\./u.exec(matches)
    expect(omitted).not.toBeNull()

    // The lines that are left, not counting the note.
    const shown = matches.split('\n').length - 1
    expect(shown + Number(omitted?.[1])).toBe(25)

    expect(matches).toContain('300 matches recorded in all.')
    expect(matches.length).toBeLessThanOrEqual(1024)
  })

  it('says the history was empty rather than implying there is none', () => {
    expect(fieldNamed(profileEmbed(data({ matches: [] }), NOW), 'Recent matches')).toBe(
      'No matches read.',
    )
  })

  it('falls back to the sort key for a row that carried no timestamp', () => {
    const matches = fieldNamed(
      profileEmbed(
        data({ matches: [{ sk: 'match#01J0', at: null, placement: null, kills: null }] }),
        NOW,
      ),
      'Recent matches',
    )

    expect(matches).toContain('match#01J0')
  })
})

describe('profileEmbed: what could not be read', () => {
  it('names each source and its kind, and never the SDK message', () => {
    const embed = profileEmbed(
      data({
        career: null,
        unreached: [
          { source: 'career', why: 'denied' },
          { source: 'matches', why: 'unavailable' },
        ],
      }),
      NOW,
    )

    const named = fieldNamed(embed, 'Could not be read') ?? ''

    expect(named).toContain('career: denied')
    expect(named).toContain('matches: unavailable')

    // A partial read still shows what it got.
    expect(fieldNamed(embed, 'Licences')).toContain(NEWEST)
    expect(fieldNamed(embed, 'Server record')).toContain('Somebody')
  })

  it('says nothing about it when everything was read', () => {
    expect(fieldNamed(profileEmbed(data({ unreached: [] }), NOW), 'Could not be read')).toBe(
      undefined,
    )
  })

  it('distinguishes a career that is absent from one that was denied', () => {
    expect(fieldNamed(profileEmbed(data({ career: null }), NOW), 'Career')).toContain(
      'No match record on the game side.',
    )
  })
})

describe('profileEmbed: Discord’s limits, measured the way Discord measures them', () => {
  /** Everything at once, and all of it hostile. */
  function monstrous(): ProfileData {
    const licences = Array.from(
      { length: 10 },
      (_, index) => `license:${String(index).repeat(60)}`,
    )

    return data({
      licences,
      current: licences.at(-1) ?? NEWEST,
      bansSkipped: 40,

      bans: licences.map((licence) => ({
        licence,
        // 3000 astral characters is 6000 UTF-16 units on its own.
        ban: ban({ license: licence, reason: ASTRAL.repeat(3000), byName: ASTRAL.repeat(500) }),
      })),

      career: career({ matches: 5000 }),

      registry: registry({
        name: ASTRAL.repeat(400),
        preferredName: ASTRAL.repeat(400),
        names: Array.from({ length: 50 }, (_, index) => ({
          name: `${ASTRAL.repeat(60)}${index}`,
          firstSeen: 0,
          lastSeen: 0,
        })),
      }),

      matches: Array.from({ length: 25 }, (_, index) => match(index)),

      unreached: [{ source: 'matches', why: 'unavailable' }],
    })
  }

  it('keeps the whole embed inside 6000 UTF-16 units', () => {
    const embed = profileEmbed(monstrous(), NOW)

    // `.length` IS the number Discord checks against. A code-point count here
    // understates every astral character by half, which is how `fitEmbed` in
    // client.ts once let 8192 units through a 4096 guard.
    expect(embedUnits(embed)).toBeLessThanOrEqual(6000)

    const measured =
      embed.title.length +
      embed.description.length +
      embed.fields.reduce((sum, entry) => sum + entry.name.length + entry.value.length, 0)

    expect(measured).toBe(embedUnits(embed))
  })

  it('keeps every field value inside 1024 UTF-16 units', () => {
    for (const value of values(profileEmbed(monstrous(), NOW))) {
      expect(value.length).toBeLessThanOrEqual(1024)
    }
  })

  it('keeps the title inside 256 and the description inside 4096', () => {
    const embed = profileEmbed(monstrous(), NOW)

    expect(embed.title.length).toBeLessThanOrEqual(256)
    expect(embed.description.length).toBeLessThanOrEqual(4096)
  })

  it('never sends more than 25 fields', () => {
    expect(profileEmbed(monstrous(), NOW).fields.length).toBeLessThanOrEqual(25)
  })

  it('never leaves half a character behind', () => {
    const embed = profileEmbed(monstrous(), NOW)
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

    for (const text of [embed.title, embed.description, ...values(embed)]) {
      expect(text).not.toMatch(lone)
    }
  })

  it('still says which sources went missing when the reply is at its limit', () => {
    expect(fieldNamed(profileEmbed(monstrous(), NOW), 'Could not be read')).toContain(
      'matches: unavailable',
    )
  })

  it('still shows the current licence when the reply is at its limit', () => {
    expect(fieldNamed(profileEmbed(monstrous(), NOW), 'Licences')).toContain('(current)')
  })
})

describe('trimEmbed', () => {
  /**
   * BUILT BY HAND, BECAUSE `profileEmbed` CANNOT PRODUCE ONE. The guard exists
   * for the edit that adds a seventh field or lifts a cap without redoing the
   * arithmetic, and an embed Discord refuses outright becomes `runCommand`'s
   * failure line — which names nothing at all.
   */
  function embedOf(count: number, value: string): ReturnType<typeof profileEmbed> {
    return {
      title: 'Player profile',
      description: 'a description',
      fields: Array.from({ length: count }, (_, index) => ({ name: `f${index}`, value })),
    }
  }

  it('leaves an embed Discord will take exactly as it is', () => {
    const embed = embedOf(6, 'short')

    expect(trimEmbed(embed)).toBe(embed)
  })

  it('drops fields until the total fits and says how many went', () => {
    const trimmed = trimEmbed(embedOf(10, 'v'.repeat(1000)))

    expect(embedUnits(trimmed)).toBeLessThanOrEqual(6000)

    const notice = trimmed.fields.at(-1)
    expect(notice?.name).toBe('Not shown')

    const dropped = /(\d+) further sections did not fit\./u.exec(notice?.value ?? '')
    expect(dropped).not.toBeNull()

    // The count is of the ORIGINAL fields, not of what is left.
    expect(trimmed.fields.length - 1 + Number(dropped?.[1])).toBe(10)
  })

  it('leaves room for its own notice rather than sending 26 fields', () => {
    const trimmed = trimEmbed(embedOf(40, 'v'))

    expect(trimmed.fields).toHaveLength(25)
    expect(trimmed.fields.at(-1)?.value).toContain('16 further sections did not fit.')
  })
})

describe('flattenEmbed', () => {
  it('carries the title, the description and every field', () => {
    const text = flattenEmbed(profileEmbed(data({ licences: [OLDEST, NEWEST] }), NOW))

    expect(text).toContain('**Licences**')
    expect(text).toContain(NEWEST)
    expect(text).toContain('2 licences')
  })

  it('fits a message, which is a third of what an embed may carry', () => {
    const big = profileEmbed(
      data({
        licences: Array.from({ length: 10 }, (_, index) => `license:${String(index).repeat(60)}`),
        bans: Array.from({ length: 10 }, (_, index) => ({
          licence: `license:${String(index).repeat(60)}`,
          ban: ban({ reason: ASTRAL.repeat(200) }),
        })),
        matches: Array.from({ length: 25 }, (_, index) => match(index)),
      }),
      NOW,
    )

    // The embed is legal and the message it flattens to would not be.
    expect(embedUnits(big)).toBeGreaterThan(2000)

    const text = flattenEmbed(big)

    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text).toMatch(/\d+ further sections did not fit\./u)
  })

  it('says nothing about dropped sections when none were dropped', () => {
    expect(flattenEmbed(profileEmbed(data(), NOW))).not.toContain('did not fit')
  })
})

describe('profileCommand', () => {
  it('registers one required user option under the name the dispatcher reads', () => {
    const command = profileCommand(reads())

    expect(command.data.name).toBe('profile')

    const options = command.data.options ?? []
    expect(options).toHaveLength(1)

    const [option] = options
    expect(option?.name).toBe(TARGET_OPTION)
    expect(option?.type).toBe(ApplicationCommandOptionType.User)
    expect(option && 'required' in option ? option.required : undefined).toBe(true)
  })

  it('is admin-only, which is what turns the gate in refusalFor on', () => {
    expect(profileCommand(reads()).adminOnly).toBe(true)
  })

  it('is ephemeral for every invocation there is', () => {
    const command = profileCommand(reads())

    // Admin-only decides who may RUN it; this decides who SEES it, and a ban
    // history posted into a channel cannot be taken back. There is no
    // invocation that should make this false.
    for (const over of [{}, { targetId: null }, { roleIds: null }, { guildId: null }]) {
      expect(command.onlyInvoker(invocation(over))).toBe(true)
    }
  })

  it('answers a profile without touching Discord or AWS', async () => {
    const command = profileCommand(
      reads({
        licencesFor: () => Promise.resolve(ok([OLDEST, NEWEST])),
        career: () => Promise.resolve(ok(career())),
        registry: () => Promise.resolve(ok(registry())),
      }),
      () => NOW,
    )

    const text = await command.run(invocation(), {} as never)

    expect(text).toContain('2 licences')
    expect(text).toContain(OLDEST)
    expect(text).toContain(NEWEST)
  })

  it('says so rather than guessing when no user came with the interaction', async () => {
    const text = await profileCommand(reads()).run(invocation({ targetId: null }), {} as never)

    expect(text).toBe('No user was given.')
  })

  it('answers instead of throwing when every read fails', async () => {
    const command = profileCommand(
      reads({
        licencesFor: () => Promise.resolve(ok([NEWEST])),
        ban: () => Promise.resolve(failed('timeout')),
        career: () => Promise.resolve(failed('denied')),
        registry: () => Promise.resolve(failed('credentials')),
        matches: () => Promise.resolve(failed('no-such-table')),
      }),
      () => NOW,
    )

    const text = await command.run(invocation(), {} as never)

    // `runCommand` turns a throw into a line that names nothing. A named
    // absence beside the licence that WAS read is a better answer.
    expect(text).toContain(NEWEST)
    expect(text).toContain('bans: timeout')
    expect(text).toContain('career: denied')
    expect(text).toContain('registry: credentials')
    expect(text).toContain('matches: no-such-table')

    // And none of the operator-facing detail went out with it.
    expect(text).not.toContain('RingmasterTableAccess')
  })
})
