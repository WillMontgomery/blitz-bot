import {
  ApplicationCommandOptionType,
  ButtonStyle,
  ComponentType,
  type APIEmbedField,
} from 'discord.js'
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
import { responderFor } from './index.ts'
import {
  consoleRow,
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
    serverIps: ['3.130.92.28'],
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
function replyEmbed(reply: CommandReply): {
  title: string
  description: string
  color: number
  thumbnail: { url: string } | undefined
  fields: APIEmbedField[]
} {
  if (typeof reply === 'string') throw new Error(`expected an embed, got text: ${reply}`)

  const [embed] = reply.embeds
  if (embed === undefined) throw new Error('the reply carried no embed at all')

  return {
    title: embed.title ?? '',
    description: embed.description ?? '',
    color: embed.color ?? 0,

    // Carried through rather than dropped, because "the avatar reached the
    // reply" is a claim about the whole path and not about the renderer: the
    // thumbnail is built from a field of the INVOCATION, so a unit test of
    // `profileEmbed` cannot see the wiring that fills it in.
    thumbnail: embed.thumbnail === undefined ? undefined : { url: embed.thumbnail.url },

    fields: [...(embed.fields ?? [])],
  }
}

/**
 * Every link button on a reply, as label and url.
 *
 * A HELPER RATHER THAN REACHING THROUGH `reply.components` AT EACH ASSERTION,
 * because a row is two levels deep and half the cases below are about the button
 * NOT being there — and `undefined?.[0]?.components?.[0]` reads the same whether
 * the button is absent or the shape changed under it.
 */
function buttons(reply: CommandReply): { label: string; url: string }[] {
  if (typeof reply === 'string') return []

  return (reply.components ?? []).flatMap((row) =>
    row.components.flatMap((one) =>
      'url' in one ? [{ label: one.label ?? '', url: one.url }] : [],
    ),
  )
}

/**
 * Everything a reader sees, as one string — THE COMPONENTS INCLUDED.
 *
 * THE BUTTON IS PART OF THE REPLY AND THEREFORE PART OF WHAT LEAKS. Every
 * separation case below is written as "this string is not in what the player
 * sees", and a licence that is absent from the embed and present in a button's
 * url is a licence the player has been shown. Folding the components in here
 * means those cases cover the button without one of them having to remember it.
 */
function rendered(reply: CommandReply): string {
  const embed = replyEmbed(reply)

  return [
    embed.title,
    embed.description,
    ...embed.fields.map((entry) => `${entry.name}\n${entry.value}`),
    ...buttons(reply).map((one) => `${one.label}\n${one.url}`),
  ].join('\n')
}

/**
 * The rendered reply with every mention's markup taken out.
 *
 * WHAT "NO RAW DISCORD ID" HAS TO BE ASSERTED AGAINST. `<@444…>` contains the
 * id by construction — that is what a mention IS — so a bare `not.toContain(id)`
 * would be a test the feature cannot pass and an invitation to delete the
 * mention along with the id. What the owner asked for is the id appearing
 * NOWHERE ELSE, which is exactly this string.
 */
function withoutMentions(text: string): string {
  return text.replace(/<@!?\d+>/gu, '')
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

/**
 * One `##` section of the description, by its heading, or undefined.
 *
 * THE DESCRIPTION IS WHERE THE PROSE LIVES NOW, so this is the counterpart of
 * `fieldNamed` and most of the cases below moved from one to the other. Discord
 * does not render a markdown heading inside a field name or value and does
 * render one in a description, which is the whole reason the reply is shaped
 * this way — see the header of ./profile.ts.
 *
 * SPLIT ON THE BLANK LINE BETWEEN SECTIONS, which is safe because no section
 * body contains one: every line reaching a section has been through `oneLine`,
 * and `packed` joins them with a single newline.
 *
 * IT ASSERTS THE `##` BY CONSTRUCTION. Looking a section up by `## Bans` and not
 * by `Bans` means a build that went back to bold, or to a plain line, finds no
 * section at all rather than quietly matching the text under it.
 */
function section(embed: { description: string }, heading: string): string | undefined {
  const marker = `## ${heading}\n`
  const block = embed.description.split('\n\n').find((one) => one.startsWith(marker))

  return block?.slice(marker.length)
}

/** Every `##` heading in the description, in the order they are read. */
function headings(embed: { description: string }): string[] {
  return [...embed.description.matchAll(/^## (.+)$/gmu)].map((found) => found[1] ?? '')
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

    // `lookup` and not `licences`: the source name is rendered in the reply, and
    // the reply may not mention a licence. See `ProfileSource`.
    expect(got.unreached).toEqual([{ source: 'lookup', why: 'timeout' }])
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

    // AND IT SAYS SO IN THE JOURNAL, WHICH IS WHERE IT SAYS IT NOW. The reply
    // used to carry `4 older licences were not checked for bans`; a count of
    // licences is a count of licences however it is worded, and the owner asked
    // for none of them. A fan-out that hit its bound is still an operational
    // fact — an admin has been shown a ban record that is not the whole one —
    // and the journal is operator-facing, so that is where it goes.
    expect([...stdout, ...stderr].join('')).toContain('checked=10 skipped=4')

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

    // FIVE, not twenty-five. Asking for what is displayed is what keeps the
    // ordinary reply from reporting a cut of the bot's own making — see the
    // history cases below.
    expect(asked).toEqual([[NEWEST, 5]])
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

    // 5, from `RECENT_MATCHES` — what the embed shows — rather than the
    // reader's own ceiling of 50, and rather than the 25 it used to fetch to
    // render a five-line field out of.
    expect(seen).toContainEqual(['gameMatches', `${NEWEST}|5`])
  })

  it('wires it through the lazy one as well, which is the one ./index.ts registers', async () => {
    const seen: Array<[string, string]> = []

    await gatherProfile(
      lazyReadsFrom(() => fakeDdb(seen)),
      DISCORD,
    )

    expect(seen).toContainEqual(['gameMatches', `${NEWEST}|5`])
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

/**
 * THE OWNER'S FIRST CUT, AND THE ONE WITH A TRAP IN IT: "We don't need any list
 * or mention of licences. Not even in the bans section."
 *
 * THESE CASES ASSERT THE ABSENCE AND THE CASES BELOW ASSERT THE READING, and
 * both halves have to hold at once. It is trivial to satisfy the owner by
 * looking up one licence and rendering its ban; that would also delete the
 * signal `/profile` exists for — a clean current licence beside a banned old one
 * — while every "no licence anywhere" assertion here still passed. So the ban
 * cases below keep three licences in the fixture and demand the OLD one's ban in
 * the reply, without its licence beside it.
 */
describe('profileEmbed: no licence anywhere in the reply', () => {
  const three = data({
    licences: [OLDEST, MIDDLE, NEWEST],
    current: NEWEST,
    bans: [
      { licence: OLDEST, ban: ban({ license: OLDEST, reason: 'ban evasion' }) },
      { licence: MIDDLE, ban: null },
      { licence: NEWEST, ban: null },
    ],
    registry: registry({ names: [{ name: 'Somebody', firstSeen: 1, lastSeen: 2 }] }),
    matches: [match(1)],
  })

  it('prints no licence value in the embed, the bans included', () => {
    const embed = profileEmbed(three, NOW)
    const whole = [embed.title, embed.description, ...values(embed)].join('\n')

    expect(whole).not.toContain(OLDEST)
    expect(whole).not.toContain(MIDDLE)
    expect(whole).not.toContain(NEWEST)

    // Not the bare hex either: the guard above would pass on a reply that
    // printed the licence with its `license:` qualifier stripped off.
    expect(whole).not.toContain('aaaaaaaa')
    expect(whole).not.toContain('cccccccc')
  })

  it('prints no count of them and no sentence about how many there are', () => {
    const whole = [
      profileEmbed(three, NOW).description,
      ...values(profileEmbed(three, NOW)),
    ].join('\n')

    // The three sentences that used to be the description's second line, and
    // the word itself, in either case.
    expect(whole).not.toMatch(/licen[cs]e/iu)
    expect(whole).not.toContain('more than one')
  })

  it('has no Licences section left to render one into', () => {
    const embed = profileEmbed(three, NOW)

    expect(fieldNamed(embed, 'Licences')).toBeUndefined()
    expect(section(embed, 'Licences')).toBeUndefined()
  })

  it('still reports the ban on the OLDEST licence, which is the whole point', () => {
    // The account's CURRENT licence is clean and an old one is permanently
    // banned. Reading only the current licence would answer "no ban" here, and
    // this is the case that says the fan-out survived the owner's cut.
    expect(section(profileEmbed(three, NOW), 'Bans')).toContain('ban evasion')
    expect(section(profileEmbed(three, NOW), 'Bans')).not.toContain('No ban')
  })

  it('says nothing about the licences the fan-out cap skipped', () => {
    const embed = profileEmbed(data({ bansSkipped: 7 }), NOW)

    expect(section(embed, 'Bans')).not.toContain('7')
    expect(embed.description).not.toMatch(/licen[cs]e/iu)
  })

  it('keeps the console button, which is a route and not a display', () => {
    // The one place a licence still travels. It is in a url rather than in the
    // reply's text, and the owner asked for it to stay.
    const url = consoleRow(NEWEST)

    expect(url).not.toBeNull()
  })
})

describe('profileEmbed: no record, and no lookup', () => {
  it('says there is no record and offers nothing keyed on a licence', () => {
    const embed = profileEmbed(data({ licences: [], current: null, bans: [] }), NOW)

    expect(embed.description).toContain('No player record for this Discord account.')
    expect(section(embed, 'Bans')).toBeUndefined()
    expect(section(embed, 'Server record')).toBeUndefined()
    expect(fieldNamed(embed, 'Level')).toBeUndefined()
  })

  it('names the failed read as a lookup rather than as an index of licences', () => {
    const embed = profileEmbed(
      data({
        licences: [],
        current: null,
        bans: [],
        career: null,
        registry: null,
        unreached: [{ source: 'lookup', why: 'timeout' }],
      }),
      NOW,
    )

    // The sentence that used to sit in the description here — `The
    // Discord-to-licence index could not be read` — named the index outright.
    // What is left says which read failed without saying what it reads.
    expect(embed.description).not.toContain('No player record')
    expect(embed.description).not.toMatch(/licen[cs]e/iu)
    expect(section(embed, 'Could not be read')).toContain('lookup: timeout')
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

    const bans = section(embed, 'Bans') ?? ''

    // The state and the reason, and NOT the licence the row was keyed on.
    expect(bans).toContain('**ACTIVE**, permanent')
    expect(bans).toContain('ban evasion')
    expect(bans).not.toContain(OLDEST)
  })

  /**
   * TWO ROWS THAT DIFFERED ONLY BY THEIR LICENCE NOW READ THE SAME, and that is
   * a consequence of the owner's cut rather than a rendering fault. Both lines
   * are kept: collapsing them would hide a second ban, which is the wrong
   * direction for the section an admin ran this command to read.
   */
  it('keeps two identical-looking rows rather than folding them into one', () => {
    const same = { reason: 'cheating', at: Date.parse('2026-01-01T00:00:00.000Z') }

    const bans =
      section(
        profileEmbed(
          data({
            licences: [OLDEST, NEWEST],
            bans: [
              { licence: OLDEST, ban: ban({ license: OLDEST, ...same }) },
              { licence: NEWEST, ban: ban({ license: NEWEST, ...same }) },
            ],
          }),
          NOW,
        ),
        'Bans',
      ) ?? ''

    expect(bans.split('\n')).toHaveLength(2)
  })

  /**
   * THE THREE STATES, AND THE THREE STAMPS UNDER THEM. Lifted and expired are
   * `R` — an admin reading a ban list is asking "recently?" — and the one still
   * in force says its expiry as a DATE, because that is the thing somebody has
   * to honour rather than estimate. Asserted as the markup Discord is actually
   * sent, seconds included: a stamp built from milliseconds renders a date fifty
   * thousand years out and looks like a working feature.
   */
  it('distinguishes lifted, expired and active against the injected clock', () => {
    const lift = Date.parse('2026-02-01T00:00:00.000Z')
    const gone = Date.parse('2026-03-01T00:00:00.000Z')
    const ends = Date.parse('2026-12-01T00:00:00.000Z')

    const embed = profileEmbed(
      data({
        licences: [OLDEST, MIDDLE, NEWEST],
        bans: [
          { licence: OLDEST, ban: ban({ license: OLDEST, liftedAt: lift }) },
          { licence: MIDDLE, ban: ban({ license: MIDDLE, expiresAt: gone }) },
          { licence: NEWEST, ban: ban({ license: NEWEST, expiresAt: ends }) },
        ],
      }),
      NOW,
    )

    const bans = section(embed, 'Bans') ?? ''

    expect(bans).toContain(`lifted <t:${String(lift / 1000)}:R>`)
    expect(bans).toContain(`expired <t:${String(gone / 1000)}:R>`)
    expect(bans).toContain(`**ACTIVE** until <t:${String(ends / 1000)}:f>`)

    // And not one ISO string anywhere in the section, which is what was there
    // before and what a half-done edit would leave behind.
    expect(bans).not.toMatch(/\d{4}-\d{2}-\d{2}T/u)
  })

  it('says so when nothing read carries a ban, and says it without the word', () => {
    const bans = section(profileEmbed(data(), NOW), 'Bans') ?? ''

    expect(bans).toContain('No ban on any record read.')
    expect(bans).not.toMatch(/licen[cs]e/iu)
  })

  it('counts the ban lines it dropped, and states the count in the section', () => {
    const licences = Array.from({ length: 10 }, (_, index) => `license:${String(index).repeat(40)}`)

    const bans =
      section(
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

    // THE CAP THAT MATTERS MOVED WITH THE TEXT. This used to be a field with
    // 1024 units of its own; it is a section of a description now, and
    // `SECTION_CAP` keeps the same ceiling so that the shape it was truncated
    // to survived the move.
    expect(bans.length).toBeLessThanOrEqual(1024)

    const omitted = /\+(\d+) more not shown\./u.exec(bans)
    expect(omitted).not.toBeNull()

    // Not "older licences not shown": that string is deleted, and a section
    // that reports a cut it did not make is what this file is written against.
    expect(bans).not.toContain('older licences not shown')

    expect(bans.split('\n').length - 1 + Number(omitted?.[1])).toBe(10)
  })

  it('does not let a newline in a ban reason forge a line', () => {
    const embed = profileEmbed(
      data({
        bans: [{ licence: NEWEST, ban: ban({ reason: 'first\nsecond: ACTIVE, permanent' }) }],
      }),
      NOW,
    )

    const bans = section(embed, 'Bans') ?? ''

    expect(bans.split('\n')).toHaveLength(1)
    expect(bans).toContain('first second')
  })
})

describe('profileEmbed: match history', () => {
  it('says nothing was omitted when nothing was', () => {
    const matches = section(
      profileEmbed(data({ matches: [match(0), match(1)], career: career({ matches: 2 }) }), NOW),
      'Recent matches',
    )

    expect(matches).not.toContain('not shown')
    expect(matches).not.toContain('recorded in all')
  })

  it('states the reader’s cut even when the embed dropped nothing', () => {
    // 3 read out of 300 played: the cut nobody would otherwise see, and it is
    // the larger of the two.
    const matches = section(
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
      section(
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

  /**
   * FIVE, BY THE OWNER, AND THE TOTAL STILL SAID.
   *
   * THE TWO HALVES ARE ONE FEATURE. A history cut to five that says nothing
   * about the rest is a reply that reads as a complete record of somebody who
   * has played forty times — which is the failure `COPY.matchesNote` was written
   * against, arriving by a different road than the one it was written for. So
   * this asserts the count of LINES and the sentence in the same case: neither
   * alone is the thing that was asked for.
   */
  it('shows five matches at most and still says how many were played in all', () => {
    const matches =
      section(
        profileEmbed(
          data({
            matches: Array.from({ length: 5 }, (unused, index) => match(index)),
            career: career({ matches: 40 }),
          }),
          NOW,
        ),
        'Recent matches',
      ) ?? ''

    const lines = matches.split('\n')

    // Five matches and the sentence about the rest, and nothing else.
    expect(lines).toHaveLength(6)
    expect(lines.at(-1)).toBe('40 matches recorded in all.')

    // And not the plumbing sentence: the reader was asked for five and gave
    // five, so nothing about this reply was cut by the bot's own limit.
    expect(matches).not.toContain('read were not shown')
  })

  /**
   * AND THE SLICE IS IN THE RENDERER TOO, not only in the number passed to the
   * reader. A seam is a seam: a fixture, or a reader written later with its own
   * idea of a default, must not be able to make this a nine-line field.
   */
  it('renders five even when the reader hands back more, and says it read more', () => {
    const matches =
      section(
        profileEmbed(
          data({
            matches: Array.from({ length: 9 }, (unused, index) => match(index)),
            career: career({ matches: 9 }),
          }),
          NOW,
        ),
        'Recent matches',
      ) ?? ''

    expect(matches.split('\n')).toHaveLength(6)
    expect(matches).toContain('4 of the 9 read were not shown.')
  })

  it('says the history was empty rather than implying there is none', () => {
    expect(section(profileEmbed(data({ matches: [] }), NOW), 'Recent matches')).toBe(
      'No matches read.',
    )
  })

  it('falls back to the sort key for a row that carried no timestamp', () => {
    const matches = section(
      profileEmbed(
        data({ matches: [{ sk: 'match#01J0', at: null, placement: null, kills: null }] }),
        NOW,
      ),
      'Recent matches',
    )

    expect(matches).toContain('match#01J0')
  })

  /**
   * THE TIME IS A DISCORD TIMESTAMP AND THE PLACEMENT IS BOLD.
   *
   * `R` HERE, WHICH IS THE FIELD THE STYLE RULE WAS WRITTEN FOR: a list of
   * recent matches is read as "how long ago", and the reader's own client is the
   * only thing that knows what timezone to say that in. An ISO string was
   * correct and made everybody do the arithmetic themselves.
   */
  it('writes each match time as a Discord timestamp and never as an ISO string', () => {
    const played = Date.parse('2026-08-30T09:00:00.000Z')

    const matches =
      section(
        profileEmbed(
          data({ matches: [{ sk: 'match#1', at: played, placement: 3, kills: 4 }] }),
          NOW,
        ),
        'Recent matches',
      ) ?? ''

    expect(matches).toContain(`<t:${String(played / 1000)}:R> · **#3** · 4 kills`)
    expect(matches).not.toContain('2026-08-30T')
  })
})

/* ------------------------------------------------------------------ *
 * THE PRESENTATION.
 *
 * These cases are about what a READER sees, which is a different question from
 * every other block in this file and is the owner's to answer. He looked at
 * `/profile` and asked for four things by name: the balance is in Volts, the
 * times are Discord's own timestamps, the short numbers are a table, and his
 * Discord id is not in it.
 *
 * WORTH TESTING BECAUSE ALL FOUR FAIL SILENTLY. A column that lost its
 * `inline: true` still renders, as a row; a timestamp built from milliseconds
 * still renders, as a date in the year 57000; an id put back into the
 * description looks exactly like the mention beside it. None of these is a
 * crash and none of them is visible in a diff of the reply's text.
 * ------------------------------------------------------------------ */

describe('profileEmbed: the numbers read as a table', () => {
  function fieldAt(
    embed: ReturnType<typeof profileEmbed>,
    name: string,
  ): APIEmbedField | undefined {
    return embed.fields.find((entry) => entry.name === name)
  }

  /**
   * THE COLUMNS, AS DISCORD ACTUALLY LAYS THEM OUT. `inline: true` is the whole
   * of the instruction — it means "put this beside the last one if it fits" —
   * and three consecutive ones is a row. Asserting the flag rather than the
   * order is what makes this a test of the layout instead of a test of the
   * array: without the flag these six are six full-width fields, which renders
   * and is not a table.
   */
  it('marks the six career numbers inline, in two rows of three', () => {
    const embed = profileEmbed(data(), NOW)

    const columns = ['Level', 'Volts', 'Matches', 'Kills', 'Damage', 'In match']

    for (const name of columns) expect(fieldAt(embed, name)?.inline).toBe(true)

    // Consecutive, because a full-width field between them would break the row.
    const names = embed.fields.map((entry) => entry.name)
    const first = names.indexOf('Level')

    expect(names.slice(first, first + columns.length)).toEqual(columns)
  })

  /**
   * AND THE LONG ONES ARE NOT FIELDS AT ALL ANY MORE. A ban history in a third
   * of the width is a ribbon of two-word lines; a ban history in a FIELD cannot
   * carry a heading, because Discord renders no markdown heading in one. Both
   * arguments point the same way, and the second is why these are sections of
   * the description now. The tiles are the only fields left.
   */
  it('leaves nothing that grows in a column, or in a field at all', () => {
    const embed = profileEmbed(
      data({ matches: [match(1)], unreached: [{ source: 'matches', why: 'unavailable' }] }),
      NOW,
    )

    for (const name of ['Bans', 'Server record', 'Could not be read', 'Recent matches']) {
      expect(fieldAt(embed, name)).toBeUndefined()
      expect(section(embed, name)).toBeDefined()
    }

    expect(embed.fields.every((entry) => entry.inline === true)).toBe(true)
  })

  /**
   * THE HEADINGS ARE `##` AND HAVE TO BE, WHICH IS A PLATFORM FACT AND NOT A
   * TASTE. The owner asked for larger text rather than bold. Discord renders
   * `#`/`##`/`###` in an embed DESCRIPTION and renders none of them in a field
   * name or value (discord/discord-api-docs#7167), so a build that put these
   * back into fields would ship the two characters `##` to the reader — or, if
   * it dropped them, go back to the bold the owner asked to replace.
   */
  it('writes every section heading as a real markdown heading', () => {
    const embed = profileEmbed(
      data({ matches: [match(1)], unreached: [{ source: 'matches', why: 'unavailable' }] }),
      NOW,
    )

    expect(headings(embed)).toEqual([
      'Bans',
      'Server record',
      'Could not be read',
      'Recent matches',
    ])

    // And no `#` reached a field, where it would arrive as punctuation.
    for (const entry of embed.fields) {
      expect(entry.name).not.toContain('#')
      expect(entry.value).not.toContain('#')
    }
  })

  /**
   * THE CURRENCY HAS A NAME AND IT IS NOT "BALANCE". The game says so itself —
   * `BR.Config.Market.currency = 'Volts'` — and a player who earns Volts, spends
   * Volts and sees Volts on every shop screen was being shown `balance 250`.
   */
  it('calls the balance Volts, which is what the game calls it', () => {
    const embed = profileEmbed(data({ career: career({ balance: 250 }) }), NOW)

    expect(fieldAt(embed, 'Volts')?.value).toBe('**250**')

    // And the old label is gone rather than sitting beside the new one.
    expect(rendered({ embeds: [embed] })).not.toContain('balance')
  })

  /** The headline number in each column is bold; the context under it is not. */
  it('bolds the number a column is named for', () => {
    const embed = profileEmbed(data(), NOW)

    expect(fieldAt(embed, 'Level')?.value).toBe('**7**\n4500 XP')
    expect(fieldAt(embed, 'Kills')?.value).toBe('**30**\n10 deaths · 3 revives')
    expect(fieldAt(embed, 'Damage')?.value).toBe('**9001**')
    expect(fieldAt(embed, 'In match')?.value).toBe('**2h 0m**\n4 solo · 8 squad')
  })

  /**
   * Every number `GameProfile` carries is still somewhere — except the one the
   * owner took out. See the case under this one.
   */
  it('drops none of the career numbers on the way into the columns', () => {
    const shown = rendered({ embeds: [profileEmbed(data(), NOW)] })

    for (const number of ['7', '4500', '250', '12', '2 wins', '5 top 10s', '30', '10 deaths',
      '3 revives', '9001', '2h 0m', '4 solo', '8 squad']) {
      expect(shown).toContain(number)
    }
  })

  /**
   * "We don't need a mention of downs." The row is still READ — ddb.ts projects
   * it and `GameProfile` still carries the number — and the kills tile no longer
   * prints it. The fixture's `downs` is 14 and its `revives` is 3, so a build
   * that dropped the wrong one of the two fails this rather than passing it.
   */
  it('says nothing about downs', () => {
    const embed = profileEmbed(data({ career: career({ downs: 14, deaths: 10, revives: 3 }) }), NOW)
    const shown = rendered({ embeds: [embed] })

    expect(shown).not.toContain('downs')
    expect(shown).not.toContain('14')
    expect(fieldAt(embed, 'Kills')?.value).toBe('**30**\n10 deaths · 3 revives')
  })

  it('answers with one sentence under its own heading when there is no career row', () => {
    const embed = profileEmbed(data({ career: null }), NOW)

    expect(section(embed, 'Career')).toBe('No match record on the game side.')

    // No empty columns beside it: six tiles of nothing is a table of nothing.
    expect(fieldAt(embed, 'Volts')).toBeUndefined()
    expect(embed.fields).toHaveLength(0)
  })
})

describe('profileEmbed: times are the reader’s own, not UTC', () => {
  /**
   * `f` FOR FIRST SEEN AND `R` FOR LAST SEEN, which look like the same kind of
   * fact and are not. When an account started is a date somebody quotes; when it
   * was last here is freshness, and "yesterday" is the answer.
   */
  it('writes first seen as a date and last seen as how long ago', () => {
    const first = Date.parse('2025-01-01T00:00:00.000Z')
    const last = Date.parse('2026-08-29T00:00:00.000Z')

    const record =
      section(
        profileEmbed(data({ registry: registry({ firstSeen: first, lastSeen: last }) }), NOW),
        'Server record',
      ) ?? ''

    expect(record).toContain(`First seen <t:${String(first / 1000)}:f>`)
    expect(record).toContain(`last seen <t:${String(last / 1000)}:R>`)
  })

  /**
   * SECONDS, AND THIS IS THE CASE THAT CATCHES THE ONE MISTAKE THIS FEATURE HAS.
   * Discord's markup takes a unix time in SECONDS; handed milliseconds it
   * renders a date fifty thousand years out, which is a bug that looks exactly
   * like the feature working until somebody reads the date.
   */
  it('writes the timestamp in seconds and not in milliseconds', () => {
    const at = Date.parse('2026-08-30T09:00:00.000Z')
    const shown = rendered({
      embeds: [profileEmbed(data({ registry: registry({ lastSeen: at }) }), NOW)],
    })

    expect(shown).toContain(`<t:${String(Math.floor(at / 1000))}:`)
    expect(shown).not.toContain(String(at))
  })

  /** No ISO string survives anywhere in a reply that has every field filled in. */
  it('leaves no ISO string anywhere in the whole reply', () => {
    const shown = rendered({
      embeds: [
        profileEmbed(
          data({
            bans: [{ licence: NEWEST, ban: ban({ expiresAt: NOW + 86_400_000 }) }],
            matches: [match(1), match(2)],
          }),
          NOW,
        ),
      ],
    })

    expect(shown).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u)
  })

  /**
   * AND A ROW WITH NO USABLE TIME ON IT SAYS SO. `unknown` rather than
   * `<t:NaN:R>`, which Discord renders as the literal characters and reads as a
   * bug in the bot rather than as a gap in the row.
   */
  it('says the time is unknown rather than building a stamp out of one that is not', () => {
    const record =
      section(
        profileEmbed(
          // Finite, and far outside the range a Date can hold — the case
          // `Number.isFinite` alone does not catch.
          data({ registry: registry({ firstSeen: 1e300, lastSeen: Number.NaN }) }),
          NOW,
        ),
        'Server record',
      ) ?? ''

    expect(record).toContain('First seen unknown · last seen unknown')
    expect(record).not.toContain('<t:')
  })
})

describe('profileEmbed: the colour says the one thing the fields say in words', () => {
  it('is red when a ban is in force on any licence', () => {
    const embed = profileEmbed(
      data({
        licences: [OLDEST, NEWEST],
        // The CURRENT licence is clean and the old one is not, which is the
        // case the whole admin view exists for. A colour off the current
        // licence alone would say the opposite of the field under it.
        bans: [
          { licence: OLDEST, ban: ban({ license: OLDEST }) },
          { licence: NEWEST, ban: null },
        ],
      }),
      NOW,
    )

    expect(embed.color).toBe(0xed4245)
  })

  it('is not red for a ban that is lifted or expired', () => {
    for (const row of [lifted(), ban({ expiresAt: NOW - 1 })]) {
      const embed = profileEmbed(data({ bans: [{ licence: NEWEST, ban: row }] }), NOW)

      expect(embed.color).toBe(0x5865f2)
    }
  })

  it('is the ordinary colour when nothing read carries a ban', () => {
    expect(profileEmbed(data(), NOW).color).toBe(0x5865f2)
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

    const named = section(embed, 'Could not be read') ?? ''

    expect(named).toContain('career: denied')
    expect(named).toContain('matches: unavailable')

    // A partial read still shows what it got.
    expect(section(embed, 'Server record')).toBeDefined()
    expect(embed.title).toBe('Somebody')
  })

  it('says nothing about it when everything was read', () => {
    expect(section(profileEmbed(data({ unreached: [] }), NOW), 'Could not be read')).toBe(
      undefined,
    )
  })

  it('distinguishes a career that is absent from one that was denied', () => {
    expect(section(profileEmbed(data({ career: null }), NOW), 'Career')).toContain(
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

  /**
   * AND EVERY SECTION TOO, WHICH IS THE CAP THAT MOVED. These four used to be
   * fields with 1024 units apiece; they share one 4096-unit description now.
   * `SECTION_CAP` keeps the old ceiling on each so that nothing was silently
   * re-truncated to a different shape by the move, and `descriptionOf` clamps
   * each one again to the room the ones above it left.
   */
  it('keeps every description section inside 1024 UTF-16 units', () => {
    const embed = profileEmbed(monstrous(), NOW)

    for (const heading of headings(embed)) {
      expect((section(embed, heading) ?? '').length).toBeLessThanOrEqual(1024)
    }
  })

  /**
   * AND EVERY CUT STILL SAYS ITS OWN COUNT. The move into one shared budget is
   * exactly where a truncation goes quiet: a section squeezed by the sections
   * above it has no reason of its own to notice. Each of these renders more than
   * it can hold in `monstrous`, and each has to say so in its own words.
   */
  it('states what each squeezed section dropped, in that section', () => {
    const embed = profileEmbed(monstrous(), NOW)

    expect(section(embed, 'Bans')).toMatch(/\+\d+ more not shown\./u)
    expect(section(embed, 'Recent matches')).toMatch(
      /(\d+ of the \d+ read were not shown\.|\d+ matches recorded in all\.)/u,
    )
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
    expect(section(profileEmbed(monstrous(), NOW), 'Could not be read')).toContain(
      'matches: unavailable',
    )
  })

  /**
   * THE BANS SURVIVE THE SQUEEZE, WHICH IS WHAT THE SECTION ORDER IS FOR. A
   * description is squeezed from the end, so the section an admin ran the
   * command for is the one that cannot be lost — and the reply still names no
   * licence even when everything in it is at its ceiling.
   */
  it('still shows the bans, and still no licence, when the reply is at its limit', () => {
    const embed = profileEmbed(monstrous(), NOW)

    expect(section(embed, 'Bans')).toBeDefined()
    expect([embed.title, embed.description, ...values(embed)].join('\n')).not.toContain('license:')
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
      color: 0x5865f2,
      fields: Array.from({ length: count }, (_, index) => ({ name: `f${index}`, value })),
    }
  }

  it('leaves an embed Discord will take exactly as it is', () => {
    const embed = embedOf(6, 'short')

    expect(trimEmbed(embed)).toBe(embed)
  })

  /**
   * THE COLOUR SURVIVES THE TRIM. This function rebuilds the record rather than
   * mutating it, so a field left off the new one is a fact silently dropped —
   * and the colour is the one fact in this reply that says "banned" without
   * costing a single unit of the budget being trimmed.
   */
  it('carries the colour through rather than rebuilding an embed without one', () => {
    const trimmed = trimEmbed(embedOf(40, 'v'))

    expect(trimmed.color).toBe(0x5865f2)
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

    // The sections are the answer now, and the tiles are only there when there
    // is a career row to fill them — the default fixture has none.
    expect(headings(replyEmbed(reply)).length).toBeGreaterThan(0)
  })

  /**
   * The case that used to be cut down. Ten bans whose reasons are astral text, a
   * registry row of astral names and five matches whose only identifier is a
   * long sort key: over a message's 2000 and inside an embed's 6000, so every
   * section survives now and none of them did before.
   *
   * THE FIXTURE HAD TO CHANGE WHEN THE LICENCES WENT. It used to reach 2000 with
   * ten sixty-character licences in a field of their own; there is no such field
   * any more, so the weight is where the reply actually carries weight — the
   * three prose sections that share one description.
   */
  it('sends an answer a message could not have carried, whole', async () => {
    const licences = Array.from({ length: 10 }, (_, index) => `license:${String(index).repeat(60)}`)

    const big = data({
      licences,
      current: licences.at(-1) ?? NEWEST,

      bans: licences.map((licence) => ({
        licence,
        ban: ban({ license: licence, reason: ASTRAL.repeat(200) }),
      })),

      registry: registry({
        preferredName: ASTRAL.repeat(200),
        names: Array.from({ length: 8 }, (unused, index) => ({
          name: `${ASTRAL.repeat(40)}${String(index)}`,
          firstSeen: 0,
          lastSeen: 0,
        })),
      }),

      matches: Array.from({ length: 5 }, (unused, index) => ({
        sk: `match#${'k'.repeat(200)}${String(index)}`,
        at: null,
        placement: null,
        kills: null,
      })),
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

    expect(headings(sent)).toEqual(headings(embed))
    expect(sent.description).toBe(embed.description)
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

    const reply = await command.run(invocation(), {} as never)
    const text = rendered(reply)

    // The record it read, and none of what it read it FROM. The button's url
    // still carries the current licence, which is why `rendered` folds the
    // components in and this asserts against the embed alone.
    expect(replyEmbed(reply).title).toBe('Somebody')
    expect(section(replyEmbed(reply), 'Server record')).toBeDefined()
    expect(text).not.toContain(OLDEST)
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

    // The career column, which is how "their own progression came back" looks
    // now that the numbers are a table rather than a line of `a · b · c`.
    expect(text).toContain('Level\n**7**')
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
    // absence per source is a better answer.
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
 * of what these cases are for is the THING THAT MUST NOT BE THERE. Neither view
 * prints a licence any more — the owner asked for that — but the two halves are
 * kept apart by two different mechanisms and only one of them is a rendering
 * decision. The admin path READS the list, because more than one licence on one
 * Discord account is the ban-evasion signal and the ban fan-out is built on it;
 * the self path cannot read it at all, because `SelfReads` has no `licencesFor`
 * on it and `tsc` is what enforces that. Ban HISTORY — lifted and expired rows —
 * is a moderation record about them rather than their own data, and is discarded
 * at the read for the same reason.
 *
 * WHICH IS WHY THESE CASES DID NOT WEAKEN WHEN THE DISPLAY RULE CHANGED. "We do
 * not show it" and "we cannot reach it" are different guarantees; the first one
 * now covers both views and the second one still covers only this one.
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
    expect(text).toContain('Level\n**7**')
    expect(text).toContain('aimbot')

    // NOR A BUTTON, and `rendered` folds the components in so that this line
    // covers one. The console is behind a sign-in a player does not have, and
    // the url would carry the licence every assertion above is about.
    expect(buttons(await command.run(invocation({ targetId: null }), cfg()))).toEqual([])
  })

  /**
   * THE SAME FIXTURE, THE ADMIN VIEW, AND THE OPPOSITE ASSERTIONS. Without this
   * the case above passes just as well against a build whose self view is empty
   * and against a fixture that never had a ban in it.
   *
   * IT CANNOT ASSERT THE LICENCES ANY MORE, WHICH IS WHY IT ASSERTS THE BAN
   * HISTORY INSTEAD. Neither view prints a licence now. What still separates the
   * two is the moderation record: the lifted bans off the OLD licences, which
   * the admin fan-out reads across the whole list and the self path never sees.
   * A build that quietly narrowed the admin read to the current licence would
   * fail here and pass everything else in this file.
   */
  it('is the same subject the admin view shows the whole ban history for', async () => {
    const seen: string[] = []
    const command = profileCommand(subject(seen), () => NOW)

    const embed = replyEmbed(await command.run(invocation({ targetId: DISCORD }), cfg()))
    const bans = section(embed, 'Bans') ?? ''

    // Both lifted rows, which are on licences that are NOT the current one.
    expect(bans).toContain('wrongly banned for desync')
    expect(bans).toContain('evading on an alt')
    expect(bans).toContain('An Admin')

    // And still not one licence value, in the reply the ADMIN gets either.
    for (const licence of [OLDEST, MIDDLE, NEWEST, FORGOTTEN]) {
      expect(embed.description).not.toContain(licence)
    }
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
      `matches:${NEWEST}|5`,
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
   * THE BAN GOES FIRST, WHICH IS BOTH THE RIGHT ORDER AND THE SAFE ONE: a
   * description is squeezed from the END, so the section a player must not lose
   * is the one section that cannot be.
   */
  it('leads with an active ban, saying the reason and when it runs out', () => {
    const embed = selfEmbed(
      selfData({ ban: { reason: 'aimbot', expiresAt: Date.parse('2026-09-05T00:00:00.000Z') } }),
    )

    expect(headings(embed).at(0)).toBe('Ban')

    const said = section(embed, 'Ban') ?? ''

    expect(said).toContain('aimbot')

    // `f` AND NOT `R`, WHICH IS THE ONE PLACE THE STYLE RULE GOES THE OTHER WAY.
    // An expiry is a deadline a player plans around, so it is the date — in
    // their own timezone, which is exactly what the ISO string here was not.
    expect(said).toContain(
      `Until **<t:${String(Date.parse('2026-09-05T00:00:00.000Z') / 1000)}:f>**.`,
    )
    expect(said).not.toContain('2026-09-05T')
  })

  it('says permanent rather than an expiry there is not', () => {
    expect(self({ ban: { reason: 'aimbot', expiresAt: null } })).toContain('Permanent')
  })

  /** The bar down the side says it before the field does. */
  it('is red for a player who is banned and ordinary for one who is not', () => {
    expect(selfEmbed(selfData({ ban: { reason: 'aimbot', expiresAt: null } })).color).toBe(
      0xed4245,
    )

    expect(selfEmbed(selfData()).color).toBe(0x5865f2)
  })

  /**
   * NO SECTION AT ALL RATHER THAN A SENTENCE SAYING THERE IS NO BAN. The admin
   * view says `No ban on any record read.` because an admin asked that
   * question; a player did not, and inventing copy to answer a question nobody
   * put is how a reply grows text the owner never wrote.
   */
  it('shows no ban section at all when there is no active ban', () => {
    expect(headings(selfEmbed(selfData()))).not.toContain('Ban')
    expect(section(selfEmbed(selfData()), 'Ban')).toBeUndefined()
  })

  /**
   * THE SAME COLUMNS THE ADMIN VIEW SHOWS, out of the second builder. The two
   * render the same six numbers today and are two functions so that the day one
   * of them stops being the same, it changes on one side.
   */
  it('shows the progression and the match record a player already sees in game', () => {
    const embed = selfEmbed(selfData({ matches: [match(1), match(2)] }))
    const text = rendered({ embeds: [embed] })

    expect(text).toContain('Level\n**7**\n4500 XP')
    expect(text).toContain('Volts\n**250**')
    expect(text).toContain('Matches\n**12**\n2 wins · 5 top 10s')
    expect(text).toContain('**#2**')

    // Columns there and columns here: the flag is what makes them a table.
    for (const name of ['Level', 'Volts', 'Matches', 'Kills', 'Damage', 'In match']) {
      expect(embed.fields.find((one) => one.name === name)?.inline).toBe(true)
    }

    // And the player's own balance is in Volts, not in `balance`.
    expect(text).not.toContain('balance')
  })

  /**
   * FIVE FOR A PLAYER TOO, AND THE TOTAL SAID.
   *
   * THIS IS THE HALF THAT WAS MISSING. The self view cut its history with
   * `packed`, which reports only what IT dropped — so a five-row history handed
   * to it whole would have been five lines with nothing under them, read by
   * somebody with forty matches as the whole of their record. `SELF.matchesNote`
   * says the count in a player's words rather than the admin view's two numbers.
   */
  it('shows five matches at most and says how many they have played in all', () => {
    const value =
      section(
        selfEmbed(
          selfData({
            matches: Array.from({ length: 5 }, (unused, index) => match(index)),
            career: career({ matches: 40 }),
          }),
        ),
        'Recent matches',
      ) ?? ''

    const lines = value.split('\n')

    expect(lines).toHaveLength(6)
    expect(lines.at(-1)).toBe('40 matches played in all.')

    // A player is not auditing the bot's fetch limit, so the admin view's
    // sentence about how many rows were read does not appear here.
    expect(value).not.toContain('read were not shown')
  })

  it('renders five even when the reader hands back more', () => {
    const value =
      section(
        selfEmbed(
          selfData({
            matches: Array.from({ length: 12 }, (unused, index) => match(index)),
            career: career({ matches: 12 }),
          }),
        ),
        'Recent matches',
      ) ?? ''

    expect(value.split('\n')).toHaveLength(6)
    expect(value).toContain('+7 more not shown.')
  })

  /** Their match times are Discord timestamps too, in their own timezone. */
  it('writes a player’s match times as Discord timestamps', () => {
    const at = Date.parse('2026-08-30T09:00:00.000Z')
    const text = self({ matches: [{ sk: 'match#1', at, placement: 2, kills: 6 }] })

    expect(text).toContain(`<t:${String(at / 1000)}:R> · **#2** · 6 kills`)
    expect(text).not.toContain('2026-08-30T')
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
 * THE CONSOLE BUTTON.
 *
 * A LINK BUTTON IS A COMPONENT, WHICH IS THE THIRD THING A REPLY CAN CARRY, and
 * these cases are about the two halves that would fail quietly. The url is
 * built out of a licence with a COLON in it, and a colon that reaches a URL path
 * unencoded is a link that is wrong in the one character nobody reads. And the
 * button belongs to the ADMIN view alone: the console is behind a sign-in a
 * player does not have, so a button on their own reply is a dead end that also
 * implies there is a page about them they may open.
 * ------------------------------------------------------------------ */

/**
 * THE SERVER RECORD, AND THE TWO LINES THE OWNER TOOK OUT OF IT.
 *
 * "We don't need their name listed again under Server record." It is the embed's
 * TITLE, off the same registry row, so the first line under the heading was the
 * same word twice on one screen.
 *
 * "We don't need a mention of Also known as if the name is the same as their
 * discord display name." Which is the ordinary case — somebody who plays under
 * the name they use on Discord — and the line then says nothing at all.
 */
describe('profileEmbed: the server record', () => {
  const named = (over: Partial<PlayerRecord> = {}): PlayerRecord =>
    registry({
      name: 'Somebody',
      names: [
        { name: 'Somebody', firstSeen: 1, lastSeen: 2 },
        { name: 'Someone Else', firstSeen: 0, lastSeen: 1 },
      ],
      ...over,
    })

  it('does not repeat the in-game name under the heading', () => {
    // No name history on this row, so the only place the name could appear
    // under the heading is the line the owner asked to remove.
    const embed = profileEmbed(data({ registry: named({ names: [] }) }), NOW)
    const record = section(embed, 'Server record') ?? ''

    // Once, as the title, and nowhere in the section's own lines.
    expect(embed.title).toBe('Somebody')
    expect(record).not.toContain('Somebody')

    // And the facts that are not the name are all still there.
    expect(record).toContain('First seen')
    expect(record).toContain('**40** sessions')
  })

  it('drops "Also known as" when the in-game name is their Discord display name', () => {
    const embed = profileEmbed(data({ registry: named() }), NOW, {
      avatarUrl: null,
      displayName: 'Somebody',
    })

    expect(section(embed, 'Server record')).not.toContain('Also known as')
    expect(section(embed, 'Server record')).not.toContain('Someone Else')
  })

  it('keeps it when the two names differ', () => {
    const embed = profileEmbed(data({ registry: named() }), NOW, {
      avatarUrl: null,
      displayName: 'Different On Discord',
    })

    expect(section(embed, 'Server record')).toContain('Also known as Somebody, Someone Else')
  })

  /**
   * AN ABSENT DISPLAY NAME SHOWS THE HISTORY RATHER THAN HIDING IT. `null` means
   * the invocation carried no user object to read one off, and treating that as
   * "they match" would delete a moderation signal to make a tidier reply — the
   * wrong direction for the one section that exists to surface it.
   */
  it('shows it when there is no display name to compare against', () => {
    expect(section(profileEmbed(data({ registry: named() }), NOW), 'Server record')).toContain(
      'Also known as',
    )
  })

  /**
   * COMPARED THE WAY THE REPLY RENDERS THEM. Both sides go through `oneLine`, so
   * a name carrying a newline or a run of spaces is not called different from
   * the one the reader sees. Case is deliberately NOT folded: `Somebody` and
   * `somebody` are two names a moderator would want side by side.
   */
  it('compares the names as they are rendered, and does not fold case', () => {
    const collapsed = profileEmbed(data({ registry: named({ name: 'Two  Words' }) }), NOW, {
      avatarUrl: null,
      displayName: 'Two Words',
    })

    expect(section(collapsed, 'Server record')).not.toContain('Also known as')

    const cased = profileEmbed(data({ registry: named() }), NOW, {
      avatarUrl: null,
      displayName: 'somebody',
    })

    expect(section(cased, 'Server record')).toContain('Also known as')
  })
})

/**
 * THE AVATAR THUMBNAIL. "On the embed - make the thumbnail URL the user's
 * profile image."
 *
 * IN BOTH VIEWS, and the self one discloses nothing: it is the caller's own
 * picture, which they are looking at beside their own name in every channel
 * already.
 */
describe('the avatar thumbnail', () => {
  const AVATAR = 'https://cdn.discordapp.com/avatars/444/abc.png'

  it('is the subject’s avatar on the admin view', () => {
    const embed = profileEmbed(data(), NOW, { avatarUrl: AVATAR, displayName: 'Somebody' })

    expect(embed.thumbnail).toEqual({ url: AVATAR })
  })

  it('is the caller’s own avatar on the self view', () => {
    const embed = selfEmbed(
      { discordId: DISCORD, known: true, ban: null, career: career(), matches: [], unreached: [] },
      AVATAR,
    )

    expect(embed.thumbnail).toEqual({ url: AVATAR })
  })

  /**
   * NO KEY AT ALL RATHER THAN AN EMPTY ONE. Discord refuses an embed whose
   * thumbnail carries an empty `url`, and a refused reply reaches the admin as
   * `runCommand`'s failure line with no profile in it.
   */
  it('is absent, and not empty, when no avatar reached the renderer', () => {
    expect(profileEmbed(data(), NOW).thumbnail).toBeUndefined()
    expect('thumbnail' in profileEmbed(data(), NOW)).toBe(false)

    expect(
      profileEmbed(data(), NOW, { avatarUrl: '', displayName: null }).thumbnail,
    ).toBeUndefined()
  })

  /**
   * NOT IN THE 6000. Discord's embed budget covers the title, the description,
   * every field name and value, the footer text and the author name — a
   * thumbnail is a URL it fetches an image from, not text it renders. Counting
   * one would spend a hundred units of somebody's ban history on nothing.
   */
  it('costs nothing against the embed’s text budget', () => {
    const bare = profileEmbed(data(), NOW)
    const withOne = profileEmbed(data(), NOW, { avatarUrl: AVATAR, displayName: null })

    expect(embedUnits(withOne)).toBe(embedUnits(bare))
  })

  /**
   * AND THE BUDGET GUARD CARRIES IT THROUGH. `trimEmbed` rebuilds the record by
   * hand, so a key left off that literal is a key silently dropped from every
   * reply that trips the guard — the same trap the colour was already in.
   */
  it('survives the last-resort trim', () => {
    const trimmed = trimEmbed({
      title: 'Player profile',
      description: 'a description',
      color: 0x5865f2,
      thumbnail: { url: AVATAR },
      fields: Array.from({ length: 30 }, (unused, index) => ({
        name: `f${String(index)}`,
        value: 'v',
      })),
    })

    expect(trimmed.thumbnail).toEqual({ url: AVATAR })
  })

  /**
   * THE WIRING, WHICH IS THE HALF A UNIT TEST OF THE RENDERER CANNOT SEE.
   * `Invocation` carries the caller's avatar and the target's separately, and
   * `run` picks between them with the same `targetId === null` test that decides
   * whose profile it is building. A build that resolved "the subject" at the
   * seam instead would put the caller's picture on an admin's lookup.
   */
  it('takes the target’s avatar for a lookup and the caller’s for the self view', async () => {
    const command = profileCommand(
      reads({ registry: () => Promise.resolve(ok(registry())) }),
      () => NOW,
    )

    const lookedUp = replyEmbed(
      await command.run(
        invocation({
          targetId: DISCORD,
          targetAvatarUrl: 'https://cdn/target.png',
          userAvatarUrl: 'https://cdn/caller.png',
        }),
        {} as never,
      ),
    )

    expect(lookedUp.thumbnail).toEqual({ url: 'https://cdn/target.png' })

    const own = replyEmbed(
      await command.run(
        invocation({
          targetId: null,
          targetAvatarUrl: 'https://cdn/target.png',
          userAvatarUrl: 'https://cdn/caller.png',
        }),
        {} as never,
      ),
    )

    expect(own.thumbnail).toEqual({ url: 'https://cdn/caller.png' })
  })

  /** And the display name reaches the one comparison that reads it. */
  it('carries the target’s display name into the name-history decision', async () => {
    const command = profileCommand(
      reads({
        registry: () =>
          Promise.resolve(
            ok(
              registry({
                name: 'Somebody',
                names: [{ name: 'Somebody', firstSeen: 1, lastSeen: 2 }],
              }),
            ),
          ),
      }),
      () => NOW,
    )

    const same = replyEmbed(
      await command.run(invocation({ targetDisplayName: 'Somebody' }), {} as never),
    )

    expect(section(same, 'Server record')).not.toContain('Also known as')

    const differs = replyEmbed(
      await command.run(invocation({ targetDisplayName: 'Another Name' }), {} as never),
    )

    expect(section(differs, 'Server record')).toContain('Also known as Somebody')
  })
})

describe('the console button', () => {
  /**
   * THE ENCODING, WHERE IT HAPPENS. `license:aaa…` has to reach the console's
   * `/players/[license]` route as `license%3Aaaa…`: Next.js decodes a dynamic
   * segment on arrival, so the encoded form is what makes the page read the
   * licence it was given rather than a truncated one — or refuse the message
   * outright, since Discord validates a button's url before accepting it.
   */
  it('percent-encodes the licence into the path', () => {
    const row = consoleRow(NEWEST)
    const [button] = row?.components ?? []

    expect(button && 'url' in button ? button.url : null).toBe(
      `https://ringmaster.blitz-royale.com/players/license%3A${'c'.repeat(40)}`,
    )

    // The colon is gone from the path, which is the whole of the encoding.
    expect(button && 'url' in button ? button.url : '').not.toContain('license:')
  })

  /**
   * A LINK BUTTON AND NOT A CUSTOM-ID ONE, which is what makes this a widening
   * of the reply seam rather than a feature with a listener. Nothing in this bot
   * handles a component interaction — ./index.ts ignores everything that is not
   * a chat-input command — so a button with a `custom_id` would be one that does
   * nothing at all the day somebody pressed it.
   */
  it('is a link button, so nothing has to listen for it', () => {
    const [button] = consoleRow(NEWEST)?.components ?? []

    expect(button?.type).toBe(ComponentType.Button)
    expect(button && 'style' in button ? button.style : null).toBe(ButtonStyle.Link)
    expect(button).not.toHaveProperty('custom_id')
    expect(button && 'label' in button ? button.label : null).toBe('Open in Ringmaster')
  })

  /**
   * A url Discord would refuse costs the BUTTON and not the reply. Over the cap
   * the whole message is rejected and the admin gets `runCommand`'s failure line
   * instead of a profile; cut to fit, the button silently opens another page.
   */
  it('drops the button rather than the answer when the url will not fit', () => {
    expect(consoleRow(`license:${'a'.repeat(600)}`)).toBeNull()

    // And it says so where an operator can see it, since the row that caused it
    // is in DynamoDB rather than in this repo.
    expect([...stdout, ...stderr].join('')).toContain('too long for a button')
  })

  it('is on the admin view, pointing at the licence that was looked up', async () => {
    const command = profileCommand(subject([]), () => NOW)
    const shown = buttons(await command.run(invocation({ targetId: DISCORD }), cfg()))

    expect(shown).toHaveLength(1)
    expect(shown.at(0)?.label).toBe('Open in Ringmaster')

    // The CURRENT licence, which is the one every other read was keyed on.
    expect(shown.at(0)?.url).toContain(encodeURIComponent(NEWEST))
  })

  /**
   * AND IT IS NOT ON THE SELF VIEW. Enforced by there being nothing to build one
   * from — `SelfData` carries `known: boolean` and no licence — but asserted
   * here anyway, because "the type makes it impossible" is a claim about the
   * code as it stands and this is a claim about the reply a player receives.
   */
  it('is absent from the self view entirely', async () => {
    const command = profileCommand(subject([]), () => NOW)
    const reply = await command.run(invocation({ targetId: null }), cfg())

    expect(buttons(reply)).toEqual([])

    // No empty row either: an absent `components` and an empty one are different
    // instructions to Discord on an edit. See `payload` in ./index.ts.
    expect(typeof reply === 'string' ? undefined : reply.components).toBeUndefined()
  })

  /**
   * NO LICENCE, NO BUTTON — and both ways of having no licence land here. An
   * account the index has never heard of and an index that could not be read
   * both arrive with `current: null`, and the console has a page for neither.
   */
  it('offers no button when there is no licence to link to', async () => {
    const unknown = profileCommand(
      reads({ licencesFor: () => Promise.resolve(ok([])) }),
      () => NOW,
    )

    expect(buttons(await unknown.run(invocation(), cfg()))).toEqual([])

    const unreadable = profileCommand(
      reads({ licencesFor: () => Promise.resolve(failed('denied')) }),
      () => NOW,
    )

    expect(buttons(await unreadable.run(invocation(), cfg()))).toEqual([])
  })

  /**
   * THE SEAM CARRIES IT UNTOUCHED, END TO END. `runCommand` does not measure or
   * reshape what a handler answered with, and `responderFor` is what turns it
   * into the payload discord.js takes — so this is the case that fails if the
   * button is built correctly and dropped on the way out.
   */
  it('reaches the interaction as components beside the embed', async () => {
    const sent: Array<{ embeds?: unknown; components?: unknown }> = []

    const interaction = {
      deferReply: () => Promise.resolve(null),
      editReply: (options: { embeds?: unknown; components?: unknown }) => {
        sent.push(options)
        return Promise.resolve(null)
      },
      reply: () => Promise.resolve(null),
    }

    await runCommand(invocation({ targetId: DISCORD }), cfg(), responderFor(interaction), [
      profileCommand(subject([]), () => NOW),
    ])

    const [payload] = sent
    expect(payload?.embeds).toHaveLength(1)
    expect(payload?.components).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * THE RAW DISCORD ID, WHICH IS IN NEITHER VIEW.
 *
 * THE MENTION IS NOT THE LEAK AND MUST NOT BE READ AS ONE. `<@444…>` contains
 * the id because that is what a mention is made of, so every case here strips
 * the mention markup first and asserts on what is left — otherwise the only way
 * to pass would be to delete the tag the owner asked to keep.
 *
 * WHAT WAS THERE: the description said `<@id> \`id\``, the mention and the
 * snowflake in backticks beside it, copied from the removals channel where a
 * mention that stops rendering after somebody leaves would leave a record naming
 * nobody. This reply is ephemeral and read once, about an account in front of
 * the reader.
 * ------------------------------------------------------------------ */

describe('no raw Discord id in either view', () => {
  /**
   * AN ID CHOSEN TO BE EASY TO CATCH. Eighteen digits with no repetition, so a
   * substring match cannot pass by accident against a level, a kill count or a
   * unix timestamp that happens to share a prefix.
   */
  const LEAKY = '135792468013579246'

  it('tags the subject and prints their id nowhere else', async () => {
    const command = profileCommand(subject([]), () => NOW)
    const reply = await command.run(invocation({ targetId: LEAKY }), cfg())

    // The tag is there, which is how the reader knows who this is about.
    expect(rendered(reply)).toContain(`<@${LEAKY}>`)

    // And the id appears nowhere a mention is not.
    expect(withoutMentions(rendered(reply))).not.toContain(LEAKY)
  })

  it('does the same for a player looking at their own profile', async () => {
    const command = profileCommand(subject([]), () => NOW)
    const reply = await command.run(invocation({ targetId: null, userId: LEAKY }), cfg())

    expect(rendered(reply)).toContain(`<@${LEAKY}>`)
    expect(withoutMentions(rendered(reply))).not.toContain(LEAKY)
  })

  /**
   * AND ON THE TWO PATHS THAT ANSWER WITHOUT READING ANYTHING, which are the
   * ones a change to the description would be written against and forget: a
   * Discord account with no player record, and an index that would not answer.
   */
  it('does the same when there is no record and when nothing could be read', async () => {
    for (const over of [
      { licencesFor: () => Promise.resolve(ok([])) },
      { licencesFor: () => Promise.resolve(failed('denied')) },
    ]) {
      const reply = await profileCommand(reads(over), () => NOW).run(
        invocation({ targetId: LEAKY }),
        cfg(),
      )

      expect(rendered(reply)).toContain(`<@${LEAKY}>`)
      expect(withoutMentions(rendered(reply))).not.toContain(LEAKY)
    }
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
