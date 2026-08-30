import { ApplicationCommandOptionType, type APIEmbedField } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Config } from '../config.ts'
import {
  tableNames,
  type Ban,
  type Ddb,
  type DdbFailure,
  type DdbResult,
  type GameMatch,
  type GameProfile,
  type PlayerRecord,
} from '../ddb.ts'
import { setSink } from '../log.ts'
import {
  refusalFor,
  runCommand,
  TARGET_OPTION,
  type BotCommand,
  type CommandReply,
  type Invocation,
  type Refusal,
  type Responder,
} from './command.ts'
import {
  embedUnits,
  gatherProfile,
  gatherSelf,
  lazyReadsFrom,
  profileAdminOnly,
  profileCommand,
  profileEmbed,
  readsFrom,
  selfEmbed,
  trimEmbed,
  type MatchSummary,
  type ProfileData,
  type ProfileReads,
  type SelfData,
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

/**
 * A licence with a ban row on it that the index no longer lists. See the
 * three-licence fixture below, which is what needs a FOURTH ban to exist.
 */
const FORGOTTEN = 'license:dddddddddddddddddddddddddddddddddddddddd'

const ADMIN_ROLE = '222222222222222222'
const MEMBER_ROLE = '333333333333333333'

/**
 * Who RAN the command, which is a different person from `DISCORD` — the account
 * being looked up — and the self cases below turn on the difference. A fixture
 * where the caller and the subject are the same id cannot tell "reads the
 * caller" from "reads the target".
 */
const CALLER = '555555555555555555'

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

    // The self path's only route in, and a SEPARATE member of the seam rather
    // than a derivation of the one above — which is what lets a case below
    // assert that one of the two was never called at all.
    currentLicenceFor: () => Promise.resolve(ok(NEWEST)),

    ban: () => Promise.resolve(ok(null)),
    career: () => Promise.resolve(ok(null)),
    registry: () => Promise.resolve(ok(null)),
    ...over,
  }
}

function cfg(over: Partial<Config> = {}): Config {
  return {
    discordToken: 'token',
    guildId: GUILD,
    adminRoleId: ADMIN_ROLE,
    logChannelId: null,
    statusChannelId: null,
    docsChannelId: null,
    maintenanceChannelId: null,
    exemptChannelIds: [],
    exemptAdmins: true,
    dryRun: false,
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
    channelId: '666666666666666666',
    userId: CALLER,
    roleIds: [ADMIN_ROLE],
    targetId: DISCORD,
    text: null,
    ...over,
  }
}

/**
 * The one embed a reply carries, or a failure that says what arrived instead.
 *
 * A HELPER RATHER THAN A CAST, because "the command answered with a string" is
 * the regression worth catching by name: it is what this command did before the
 * seam was widened, and a cast would turn it into `undefined` three assertions
 * later.
 */
function replyEmbed(reply: CommandReply): { title: string; description: string; fields: APIEmbedField[] } {
  if (typeof reply === 'string') throw new Error(`expected an embed, got text: ${reply}`)

  const [embed] = reply.embeds
  if (embed === undefined) throw new Error('the reply carried no embed at all')

  return {
    title: embed.title ?? '',
    description: embed.description ?? '',
    fields: [...(embed.fields ?? [])],
  }
}

/** Everything in an embed that a reader sees, as one string. */
function rendered(reply: CommandReply): string {
  const embed = replyEmbed(reply)

  return [
    embed.title,
    embed.description,
    ...embed.fields.map((entry) => `${entry.name}\n${entry.value}`),
  ].join('\n')
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

        // A lookup reads and never writes, so these two reject like every other
        // member of `Ddb` that a profile has no business reaching. They are
        // named rather than left off because this fake IS a `Ddb`: a member
        // added to that interface has to appear here, which is what stops this
        // file's idea of the module drifting from the module.
        issue: unused,
        lift: unused,
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
        matches: (licence, limit) => {
          seen.push(['gameMatches', `${licence}|${String(limit)}`])
          return Promise.resolve(ok([] as GameMatch[]))
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

  /**
   * THE MATCH READER IS WIRED, THROUGH BOTH. A `readsFrom` that dropped the line
   * is not a crash and not a wrong number: the reply says `matches: unavailable`,
   * which is word for word what an honest build with no reader says. The
   * regression is invisible in the channel, so it has to be visible here.
   */
  it('wires the match reader, with the limit this reply can actually render', async () => {
    const seen: Array<[string, string]> = []

    await gatherProfile(readsFrom(fakeDdb(seen)), DISCORD)

    // 25, from `MATCH_FETCH` — what the embed can show and say it cut — rather
    // than the reader's own ceiling.
    expect(seen).toContainEqual(['gameMatches', `${NEWEST}|25`])
  })

  it('wires it through the lazy one as well, which is the one ./index.ts registers', async () => {
    const seen: Array<[string, string]> = []

    await gatherProfile(
      lazyReadsFrom(() => fakeDdb(seen)),
      DISCORD,
    )

    expect(seen).toContainEqual(['gameMatches', `${NEWEST}|25`])
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

/**
 * THE REPLY IS THE EMBED, AND THE WHOLE 6000 IS ITS BUDGET.
 *
 * THE REGRESSION THIS BLOCK IS FOR is the shape this command shipped in before
 * the seam carried embeds: the same embed flattened into message content and
 * cut again at 2000, so an answer that was perfectly legal lost whole sections
 * on the way out — and lost them by a second set of rules that nothing forced to
 * agree with the first. A `/profile` that answers with a string is that
 * behaviour coming back, whatever the string says.
 */
describe('the reply is an embed and nothing cuts it twice', () => {
  it('answers with one embed rather than with text', async () => {
    const reply = await profileCommand(reads(), () => NOW).run(invocation(), {} as never)

    expect(typeof reply).not.toBe('string')
    expect(replyEmbed(reply).fields.length).toBeGreaterThan(0)
  })

  /**
   * The case that used to be cut down. Ten sixty-character licences, ten bans
   * whose reasons are astral text, and twenty-five matches: over a message's
   * 2000 and inside an embed's 6000, so every section survives now and none of
   * them did before.
   */
  it('sends an answer a message could not have carried, whole', async () => {
    const big = data({
      licences: Array.from({ length: 10 }, (_, index) => `license:${String(index).repeat(60)}`),
      bans: Array.from({ length: 10 }, (_, index) => ({
        licence: `license:${String(index).repeat(60)}`,
        ban: ban({ reason: ASTRAL.repeat(200) }),
      })),
      matches: Array.from({ length: 25 }, (_, index) => match(index)),
    })

    const embed = profileEmbed(big, NOW)

    expect(embedUnits(embed)).toBeGreaterThan(2000)
    expect(embedUnits(embed)).toBeLessThanOrEqual(6000)

    // Every section the embed built is a section the admin gets: nothing
    // between `profileEmbed` and Discord measures this again.
    const command = profileCommand(
      reads({
        licencesFor: () => Promise.resolve(ok([...big.licences])),
        ban: (licence) =>
          Promise.resolve(ok(big.bans.find((row) => row.licence === licence)?.ban ?? null)),
        career: () => Promise.resolve(ok(big.career)),
        registry: () => Promise.resolve(ok(big.registry)),
        matches: () => Promise.resolve(ok([...big.matches])),
      }),
      () => NOW,
    )

    const sent = replyEmbed(await command.run(invocation(), {} as never))

    expect(sent.fields.map((entry) => entry.name)).toEqual(
      embed.fields.map((entry) => entry.name),
    )
    expect(rendered(await command.run(invocation(), {} as never))).not.toContain('did not fit')
  })
})

describe('profileCommand', () => {
  /**
   * OPTIONAL, AND A REQUIRED ONE WOULD MAKE THE SELF VIEW UNASKABLE. Discord
   * will not let a member send `/profile` at all while the option is required,
   * so this is not a nicety — it is the difference between the self view
   * existing and not.
   */
  it('registers one OPTIONAL user option under the name the dispatcher reads', () => {
    const command = profileCommand(reads())

    expect(command.data.name).toBe('profile')

    const options = command.data.options ?? []
    expect(options).toHaveLength(1)

    const [option] = options
    expect(option?.name).toBe(TARGET_OPTION)
    expect(option?.type).toBe(ApplicationCommandOptionType.User)
    expect(option && 'required' in option ? option.required : undefined).toBe(false)
  })

  /**
   * THE GATE IS THE PREDICATE ITSELF, NOT A COPY OF WHAT IT SAYS. `adminOnly`
   * is `profileAdminOnly` by reference, so the rule the tests below exercise is
   * the rule `refusalFor` resolves — there is no second expression anywhere
   * that could answer differently. Neither constant was ever right: `true`
   * refuses the self view to the members it exists for, and `false` lets any
   * member look anybody else up.
   */
  it('gates per invocation rather than shipping either constant', () => {
    expect(profileCommand(reads()).adminOnly).toBe(profileAdminOnly)
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

    const text = rendered(await command.run(invocation(), {} as never))

    expect(text).toContain('2 licences')
    expect(text).toContain(OLDEST)
    expect(text).toContain(NEWEST)
  })

  /**
   * NO TARGET IS NO LONGER A PAYLOAD PROBLEM, IT IS A SUBJECT. This used to
   * answer `No user was given.` because Discord guaranteed a required option;
   * now the absence of one means "me", and the reply is the self view of the
   * person who ran it. The regression this case names is a build that went back
   * to refusing, which would look like the command being broken for everybody
   * who is not an admin looking somebody up.
   */
  it('reads the CALLER and not the target when no user was given', async () => {
    const asked: string[] = []

    const command = profileCommand(
      reads({
        currentLicenceFor: (id) => {
          asked.push(id)
          return Promise.resolve(ok(NEWEST))
        },
        career: () => Promise.resolve(ok(career())),
      }),
      () => NOW,
    )

    const text = rendered(await command.run(invocation({ targetId: null }), cfg()))

    expect(asked).toEqual([CALLER])
    expect(text).toContain(`<@${CALLER}>`)
    expect(text).toContain('Level 7')
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

    const text = rendered(await command.run(invocation(), {} as never))

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

/* ------------------------------------------------------------------ *
 * THE SELF VIEW.
 *
 * `/profile` with no target answers about the person who ran it, and the whole
 * of what these cases are for is the FIELD THAT MUST NOT BE THERE. The admin
 * view leads with the licence list because more than one licence on one Discord
 * account is the ban-evasion signal and the most interesting thing this bot
 * knows; showing that to the player tells a ban evader exactly how many of
 * their alts the system has already joined up. Ban HISTORY — lifted and expired
 * rows — is a moderation record about them rather than their own data.
 *
 * ASSERTED AGAINST THE RENDERED TEXT AND AGAINST THE INJECTED READS, and
 * neither on its own would do. Rendered text is what a player actually sees, so
 * it catches a licence that arrives by some route nobody predicted. The reads
 * are the data-flow claim: a value that was never fetched cannot leak, and
 * which functions were called is the only way to say that out loud.
 * ------------------------------------------------------------------ */

/** A ban that has been lifted. `isBanActive` is false for any `liftedAt`. */
function lifted(over: Partial<Ban> = {}): Ban {
  return ban({
    liftedAt: NOW - 86_400_000,
    liftedBy: OLDEST,
    liftedByName: 'An Admin',
    liftReason: 'appeal upheld',
    ...over,
  })
}

/**
 * THE FIXTURE THE SEPARATION IS TESTED AGAINST: three licences, four bans, two
 * of them lifted.
 *
 * WHY THE FOURTH BAN IS ON A LICENCE THE INDEX NO LONGER LISTS. `ringmaster-
 * bans` is keyed on ONE licence and holds ONE row per licence, so three
 * licences can carry at most three ban rows — a subject with four has a fourth
 * licence somewhere, and `FORGOTTEN` is it: a licence of theirs the index row
 * no longer carries. Neither view reads it, which is worth having in the
 * fixture rather than out of it.
 *
 * `seen` RECORDS EVERY READ THE PATH UNDER TEST MADE, which is what turns "the
 * self view does not show the licences" into "the self view never asked for
 * them".
 */
function subject(seen: string[]): ProfileReads {
  const rows = new Map<string, Ban>([
    // The one the player is under right now, and the only one they may see.
    [NEWEST, ban({ license: NEWEST, reason: 'aimbot', expiresAt: NOW + 86_400_000 })],

    // Two lifted. Moderation history, and not theirs to read.
    [MIDDLE, lifted({ license: MIDDLE, reason: 'wrongly banned for desync' })],
    [OLDEST, lifted({ license: OLDEST, reason: 'evading on an alt' })],

    // Expired, on the licence the index has forgotten.
    [FORGOTTEN, ban({ license: FORGOTTEN, reason: 'chat abuse', expiresAt: NOW - 1 })],
  ])

  return reads({
    licencesFor: (id) => {
      seen.push(`licencesFor:${id}`)
      // Most recent LAST, which is how the index stores them.
      return Promise.resolve(ok([OLDEST, MIDDLE, NEWEST]))
    },

    currentLicenceFor: (id) => {
      seen.push(`currentLicenceFor:${id}`)
      return Promise.resolve(ok(NEWEST))
    },

    ban: (licence) => {
      seen.push(`ban:${licence}`)
      return Promise.resolve(ok(rows.get(licence) ?? null))
    },

    career: (licence) => {
      seen.push(`career:${licence}`)
      return Promise.resolve(ok(career()))
    },

    registry: (licence) => {
      seen.push(`registry:${licence}`)
      return Promise.resolve(ok(registry()))
    },

    matches: (licence, limit) => {
      seen.push(`matches:${licence}|${String(limit)}`)
      return Promise.resolve(ok([match(1), match(2)]))
    },
  })
}

describe('the self view: a player’s own record, and nothing about their licences', () => {
  /**
   * THE ONE THIS WHOLE CHANGE EXISTS FOR. Three licences, four bans, two
   * lifted — and the reply the player gets carries none of the licences, no
   * count of them, and neither lifted ban.
   *
   * AGAINST THE RENDERED TEXT rather than against which builder ran, because a
   * case that asserts `selfEmbed` was called says nothing about what
   * `selfEmbed` put in it. Every string below is a thing a reader sees in
   * Discord.
   */
  it('shows none of the three licences, no count of them, and neither lifted ban', async () => {
    const seen: string[] = []
    const command = profileCommand(subject(seen), () => NOW)

    const text = rendered(await command.run(invocation({ targetId: null }), cfg()))

    // Not one of the licences, by value.
    expect(text).not.toContain(OLDEST)
    expect(text).not.toContain(MIDDLE)
    expect(text).not.toContain(NEWEST)
    expect(text).not.toContain(FORGOTTEN)

    // Nor the count, which is the disclosure even without the values: "3
    // licences" tells a ban evader how many of their alts have been joined up.
    expect(text).not.toContain('3 licences')
    expect(text).not.toContain('licence')

    // Neither lifted ban, by reason or by state.
    expect(text).not.toContain('wrongly banned for desync')
    expect(text).not.toContain('evading on an alt')
    expect(text).not.toContain('lifted')
    expect(text).not.toContain('An Admin')

    // Nor the expired one on the licence the index has forgotten.
    expect(text).not.toContain('chat abuse')

    // And what it DOES show: their own progression, and the ban they are under.
    expect(text).toContain('Level 7')
    expect(text).toContain('aimbot')
  })

  /**
   * THE SAME FIXTURE, THE ADMIN VIEW, AND THE OPPOSITE ASSERTIONS. Without this
   * the case above passes just as well against a build whose self view is empty
   * and against a fixture that never had a licence in it.
   */
  it('is the same subject the admin view leads with the licence list for', async () => {
    const seen: string[] = []
    const command = profileCommand(subject(seen), () => NOW)

    const text = rendered(await command.run(invocation({ targetId: DISCORD }), cfg()))

    expect(text).toContain('3 licences')
    expect(text).toContain(OLDEST)
    expect(text).toContain(MIDDLE)
    expect(text).toContain(NEWEST)
    expect(text).toContain('wrongly banned for desync')
    expect(text).toContain('evading on an alt')
  })

  /**
   * THE DATA-FLOW CLAIM, AND IT IS A DIFFERENT CLAIM FROM THE ONE ABOVE. A
   * build that fetched the licence list and then left it out of the rendering
   * passes every assertion in the first case and is still one edit away from
   * putting it back. This one says the value never existed.
   *
   * `SelfReads` MAKES IT A COMPILE ERROR TOO — it is `ProfileReads` without
   * `licencesFor` or `registry` on it, so `gatherSelf` cannot name either. This
   * case is the runtime backstop, and it is what fails if that is widened back.
   */
  it('issues no read at all against the reverse identifier index', async () => {
    const seen: string[] = []
    const command = profileCommand(subject(seen), () => NOW)

    await command.run(invocation({ targetId: null }), cfg())

    expect(seen.filter((one) => one.startsWith('licencesFor:'))).toEqual([])

    // Nor the registry, which carries the name history and the identifier
    // sightings — the same reuse signal arriving by a different road.
    expect(seen.filter((one) => one.startsWith('registry:'))).toEqual([])

    // What it DID read: one resolution against the CALLER, and three reads
    // keyed on the one licence that came back.
    expect(seen).toEqual([
      `currentLicenceFor:${CALLER}`,
      `ban:${NEWEST}`,
      `career:${NEWEST}`,
      `matches:${NEWEST}|25`,
    ])
  })

  it('reads the index only for the admin view, over the same injected seam', async () => {
    const seen: string[] = []
    const command = profileCommand(subject(seen), () => NOW)

    await command.run(invocation({ targetId: DISCORD }), cfg())

    expect(seen).toContain(`licencesFor:${DISCORD}`)
    expect(seen.filter((one) => one.startsWith('currentLicenceFor:'))).toEqual([])
  })
})

describe('gatherSelf', () => {
  it('keeps an ACTIVE ban and discards the rest AT THE READ, not at the rendering', async () => {
    const active = await gatherSelf(
      reads({ ban: () => Promise.resolve(ok(ban({ expiresAt: NOW + 1000 }))) }),
      DISCORD,
      NOW,
    )

    expect(active.ban).toEqual({ reason: 'cheating', expiresAt: NOW + 1000 })

    // A lifted row and an expired row both become null HERE, so `SelfData` has
    // no shape that could carry either into `selfEmbed`.
    for (const row of [lifted(), ban({ expiresAt: NOW - 1 })]) {
      const got = await gatherSelf(reads({ ban: () => Promise.resolve(ok(row)) }), DISCORD, NOW)
      expect(got.ban).toBeNull()
    }
  })

  /**
   * A PROJECTION AND NOT THE ROW. `Ban` carries `license` — the licence itself
   * — plus `by`, `byName` and the three lift fields. `SelfBan` carries two.
   * Handing the builder the row and trusting it to render two fields off it is
   * the version this is not.
   */
  it('hands the builder two fields and not a ban row', async () => {
    const got = await gatherSelf(
      reads({ ban: () => Promise.resolve(ok(ban({ license: NEWEST, expiresAt: null }))) }),
      DISCORD,
      NOW,
    )

    expect(Object.keys(got.ban ?? {}).sort()).toEqual(['expiresAt', 'reason'])
  })

  it('treats a Discord account with no player record as an answer, not a failure', async () => {
    const got = await gatherSelf(
      reads({ currentLicenceFor: () => Promise.resolve(ok(null)) }),
      DISCORD,
      NOW,
    )

    expect(got.known).toBe(false)
    expect(got.unreached).toEqual([])
    expect(rendered({ embeds: [selfEmbed(got)] })).toContain('No player record')
  })

  /**
   * AND A LOOKUP THAT FAILED IS THE OPPOSITE SENTENCE. "You have never played
   * here", said with confidence to somebody who has played for a year, is the
   * one answer worse than saying nothing.
   */
  it('reports a failed lookup as itself rather than as no record', async () => {
    const got = await gatherSelf(
      reads({ currentLicenceFor: () => Promise.resolve(failed('denied')) }),
      DISCORD,
      NOW,
    )

    expect(got.unreached).toEqual([{ source: 'lookup', why: 'denied' }])

    const text = rendered({ embeds: [selfEmbed(got)] })

    expect(text).not.toContain('No player record')
    expect(text).toContain('lookup: denied')

    // `lookup` AND NOT `licences`: the admin view says `licences: denied` and,
    // a line above it, names the Discord-to-licence index outright. Saying
    // either here would disclose the very thing the self view is built not to.
    expect(text).not.toContain('licence')
    expect(text).not.toContain('index')
  })

  it('names a source it could not read and keeps the SDK message out of the reply', async () => {
    const got = await gatherSelf(
      reads({
        career: () => Promise.resolve(failed('timeout')),
        matches: () => Promise.resolve(failed('no-such-table')),
      }),
      DISCORD,
      NOW,
    )

    const text = rendered({ embeds: [selfEmbed(got)] })

    expect(text).toContain('career: timeout')
    expect(text).toContain('matches: no-such-table')
    expect(text).not.toContain('RingmasterTableAccess')

    // The operator-facing text goes to the journal, where table names belong.
    expect([...stdout, ...stderr].join('')).toContain('RingmasterTableAccess')
  })

  it('says match history is unavailable when this build has no reader for it', async () => {
    const got = await gatherSelf(reads(), DISCORD, NOW)

    expect(got.unreached).toEqual([{ source: 'matches', why: 'unavailable' }])
  })
})

describe('selfEmbed', () => {
  function selfData(over: Partial<SelfData> = {}): SelfData {
    return {
      discordId: DISCORD,
      known: true,
      ban: null,
      career: career(),
      matches: [],
      unreached: [],
      ...over,
    }
  }

  function self(over: Partial<SelfData> = {}): string {
    return rendered({ embeds: [selfEmbed(selfData(over))] })
  }

  /**
   * THE BAN GOES FIRST, WHICH IS BOTH THE RIGHT ORDER AND THE SAFE ONE:
   * `trimEmbed` drops fields from the END, so the field a player must not lose
   * is the one field that cannot be lost.
   */
  it('leads with an active ban, saying the reason and when it runs out', () => {
    const embed = selfEmbed(
      selfData({ ban: { reason: 'aimbot', expiresAt: Date.parse('2026-09-05T00:00:00.000Z') } }),
    )

    expect(embed.fields.at(0)?.name).toBe('Ban')
    expect(embed.fields.at(0)?.value).toContain('aimbot')
    expect(embed.fields.at(0)?.value).toContain('Until 2026-09-05T00:00:00.000Z')
  })

  it('says permanent rather than an expiry there is not', () => {
    expect(self({ ban: { reason: 'aimbot', expiresAt: null } })).toContain('Permanent')
  })

  /**
   * NO FIELD AT ALL RATHER THAN A SENTENCE SAYING THERE IS NO BAN. The admin
   * view says `No ban on any licence read.` because an admin asked that
   * question; a player did not, and inventing copy to answer a question nobody
   * put is how a reply grows text the owner never wrote.
   */
  it('shows no ban section at all when there is no active ban', () => {
    expect(selfEmbed(selfData()).fields.map((one) => one.name)).not.toContain('Ban')
  })

  it('shows the progression and the match record a player already sees in game', () => {
    const text = self({ matches: [match(1), match(2)] })

    expect(text).toContain('Level 7 · 4500 XP · balance 250')
    expect(text).toContain('12 matches · 2 wins · 5 top 10s')
    expect(text).toContain('#2')
  })

  it('does not let a newline in a ban reason forge a line', () => {
    expect(self({ ban: { reason: 'aimbot\nPermanent.', expiresAt: NOW + 1000 } })).toContain(
      'aimbot Permanent.',
    )
  })

  it('offers no fields keyed on a licence for an account that has never played', () => {
    const embed = selfEmbed(selfData({ known: false, career: null }))

    expect(embed.fields).toEqual([])
    expect(embed.description).toContain('No player record')
  })

  /**
   * THE SAME BUDGET THE ADMIN VIEW IS HELD TO, because it is the same set of
   * measuring and cutting helpers — those are about Discord's limits and are
   * exactly what the two builders are meant to share.
   */
  it('keeps the whole reply inside the limits Discord actually counts', () => {
    const embed = selfEmbed(
      selfData({
        ban: { reason: ASTRAL.repeat(4000), expiresAt: NOW + 1000 },
        matches: Array.from({ length: 60 }, (unused, index) => match(index)),
        unreached: [{ source: 'lookup', why: 'timeout' }],
      }),
    )

    expect(embedUnits(embed)).toBeLessThanOrEqual(6000)
    expect(embed.fields.length).toBeLessThanOrEqual(25)

    for (const value of values(embed)) expect(value.length).toBeLessThanOrEqual(1024)
  })
})

/* ------------------------------------------------------------------ *
 * THE GATE.
 *
 * `/profile @someone` NEEDS THE ROLE AND `/profile` DOES NOT, which is a
 * question about the INVOCATION rather than about the command.
 * `BotCommand.adminOnly` is an `AdminGate`, so `profileAdminOnly` states the
 * CONDITION and command.ts is what enforces it — see `refusalFor`, which
 * resolves the predicate above every reason it refuses for.
 *
 * ASSERTED THROUGH `refusalFor` AND NOT AGAINST A RE-IMPLEMENTATION. The four
 * refusal reasons — no guild, unset admin role, no member on the payload, no
 * role — are the framework's, and the point of stating only the condition here
 * is that this command does not get its own copy of them to drift from. The
 * helper below passes the command through UNCHANGED for exactly that reason:
 * anything it rewrote would be a claim about a command that is not the one
 * registered.
 * ------------------------------------------------------------------ */

function gate(command: BotCommand, one: Invocation, config: Config = cfg()): Refusal | null {
  return refusalFor(command, one, config)
}

/**
 * The three things `runCommand` may do to an interaction, remembered.
 *
 * WHAT THE DISPATCHER ADDS TO A `refusalFor` ASSERTION. The gate answering
 * `not-admin` and the member actually being stopped are two different claims,
 * and only the second one is the feature: a refusal is answered WITHOUT
 * deferring and without the handler running at all, so a case that drives
 * `runCommand` can say that the reads were never even reached.
 */
function answering(): Responder & {
  defer: ReturnType<typeof vi.fn<Responder['defer']>>
  edit: ReturnType<typeof vi.fn<Responder['edit']>>
  reply: ReturnType<typeof vi.fn<Responder['reply']>>
} {
  return {
    defer: vi.fn<Responder['defer']>(() => Promise.resolve()),
    edit: vi.fn<Responder['edit']>(() => Promise.resolve()),
    reply: vi.fn<Responder['reply']>(() => Promise.resolve()),
  }
}

describe('/profile is admin-only only when a target is given', () => {
  const command = profileCommand(reads(), () => NOW)

  const admin = { roleIds: [ADMIN_ROLE] }
  const member = { roleIds: [MEMBER_ROLE] }

  it('refuses a non-admin who named somebody else', () => {
    expect(gate(command, invocation({ ...member, targetId: DISCORD }))).toBe('not-admin')
  })

  it('serves a non-admin who named nobody', () => {
    expect(gate(command, invocation({ ...member, targetId: null }))).toBeNull()
  })

  it('serves an admin either way', () => {
    expect(gate(command, invocation({ ...admin, targetId: DISCORD }))).toBeNull()
    expect(gate(command, invocation({ ...admin, targetId: null }))).toBeNull()
  })

  /**
   * THE GATE IS NOT WEAKENED FOR THE TARGETED CASE, WHICH IS THE HALF THAT
   * MATTERS. Every closed direction `refusalFor` has still applies the moment a
   * target is given: an unset DISCORD_ADMIN_ROLE_ID refuses everybody, and a
   * payload that arrived with no member on it refuses. An unset variable must
   * never be the thing that opens a door.
   */
  it('keeps every closed direction the framework has, once a target is given', () => {
    const targeted = invocation({ ...admin, targetId: DISCORD })

    expect(gate(command, targeted, cfg({ adminRoleId: null }))).toBe('admin-role-unset')
    expect(gate(command, invocation({ roleIds: null, targetId: DISCORD }))).toBe('roles-unreadable')
  })

  /**
   * AND `not-in-guild` STILL REFUSES THE SELF VIEW, because the roles on a
   * payload that arrived without a guild are meaningless too. That check sits
   * ahead of `adminOnly` in `refusalFor` and stays ahead of it.
   */
  it('still refuses a payload that carried no guild, target or not', () => {
    expect(gate(command, invocation({ ...member, guildId: null, targetId: null }))).toBe(
      'not-in-guild',
    )
    expect(gate(command, invocation({ ...admin, guildId: null, targetId: DISCORD }))).toBe(
      'not-in-guild',
    )
  })

  it('is ephemeral either way, which is a different guarantee from the gate', () => {
    for (const over of [{ targetId: null }, { targetId: DISCORD }, admin, member]) {
      expect(command.onlyInvoker(invocation(over))).toBe(true)
    }
  })

  /**
   * AN ADMIN WITH NO TARGET GETS THE SELF VIEW, NOT THE ADMIN VIEW. "No target
   * means me" is one rule for everybody; a second reading of it for admins
   * would be a branch on the caller's role inside the half of the file that is
   * meant not to know about roles. It means an admin cannot see their own
   * licence list this way — the decision, not an oversight. They tag themselves
   * if they want it.
   */
  /**
   * THE WHOLE POINT OF THE CONDITIONAL GATE, IN ONE CASE, THROUGH THE REAL
   * DISPATCHER. One member, holding no admin role, running the one registered
   * `/profile`: naming somebody else is refused before a single read happens,
   * and naming nobody is served their own profile. Neither constant can pass
   * this — `adminOnly: true` fails the second half and `false` fails the first
   * — which is what makes it the test for the feature rather than for the gate.
   *
   * `subject` RECORDS EVERY READ, so "refused" is asserted as nothing having
   * been looked up rather than as an embed that happened to come back empty.
   */
  it('refuses a non-admin who named somebody, and serves one who named nobody', async () => {
    const seen: string[] = []
    const one = profileCommand(subject(seen), () => NOW)
    const config = cfg()

    const refused = answering()
    await runCommand(invocation({ ...member, targetId: DISCORD }), config, refused, [one])

    // Answered at once and never deferred: the refusal path does not run the
    // handler, so nothing about the subject was read.
    expect(refused.reply).toHaveBeenCalledTimes(1)
    expect(refused.defer).not.toHaveBeenCalled()
    expect(refused.edit).not.toHaveBeenCalled()
    expect(seen).toEqual([])

    const served = answering()
    await runCommand(invocation({ ...member, targetId: null }), config, served, [one])

    expect(served.reply).not.toHaveBeenCalled()
    expect(served.defer).toHaveBeenCalledWith(true)
    expect(served.edit).toHaveBeenCalledTimes(1)

    // And what they were served is the SELF view of themselves: keyed on the
    // caller, with no licence in it and no licence list ever asked for.
    const answer = served.edit.mock.calls[0]?.[0]
    if (answer === undefined) throw new Error('the reply was filled in with nothing')

    const text = rendered(answer)

    expect(text).toContain(CALLER)
    expect(text).not.toContain(DISCORD)
    expect(text).not.toContain(NEWEST)

    expect(seen).toContain(`currentLicenceFor:${CALLER}`)
    expect(seen.filter((entry) => entry.startsWith('licencesFor:'))).toEqual([])
  })

  it('gives an admin who named nobody the self view and not the admin view', async () => {
    const seen: string[] = []
    const one = profileCommand(subject(seen), () => NOW)

    const text = rendered(await one.run(invocation({ ...admin, targetId: null }), cfg()))

    expect(text).not.toContain(NEWEST)
    expect(text).not.toContain('licence')
    expect(seen.filter((entry) => entry.startsWith('licencesFor:'))).toEqual([])
  })
})
