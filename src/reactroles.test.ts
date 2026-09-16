import { readFileSync } from 'node:fs'

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClient } from './client.ts'
import type { Config } from './config.ts'
import {
  REACT_ROLE_ANY,
  reactRoleChannelKey,
  type Ddb,
  type DdbFailureKind,
  type DdbResult,
  type ReactRolePairing,
} from './ddb.ts'
import { latch } from './latch.ts'
import { setSink } from './log.ts'
import {
  emojiKeyOf,
  handleReaction,
  installReactionRoles,
  pairingFor,
  reactionOf,
  reactRoles,
  setReactRoles,
  type LiveReaction,
  type LiveReactor,
  type Reaction,
  type ReactRoleDeps,
  type ReactRoleGrants,
} from './reactroles.ts'

/**
 * Reaction roles, offline.
 *
 * WHAT THIS FILE IS REALLY FOR, and it is not the happy path. A pairing hands
 * somebody a role, so the cases that matter most are the ones where NOTHING
 * should happen: a reaction from a bot — including this bot's own pre-react — a
 * reaction on a message nobody paired, a reaction in another guild, and a
 * DynamoDB read that failed. Every one of those, read wrongly, either gives a
 * role away or takes one off somebody who never lost their reaction.
 *
 * AND THE PRECEDENCE, WHICH IS THE OTHER HALF. Four shapes can overlap on one
 * reaction and the owner said which wins; the rule is only worth anything if it
 * is the same rule every time, so it is asserted from both directions rather
 * than described.
 *
 * NOTHING HERE TOUCHES DISCORD OR AWS. `handleReaction` takes a plain record and
 * two injected seams, and the two cases that build a real `Client` do so to read
 * its options back — which is where intents and partials actually live, and the
 * one place a fake could not establish them.
 */

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'
const MESSAGE = '333333333333333333'
const MEMBER = '444444444444444444'
const SELF = '555555555555555555'

const ROLE_A = '666666666666666666'
const ROLE_B = '777777777777777777'

const EMOJI = '🎮'
const CUSTOM = '888888888888888888'

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

  // Both are module state, which is the trap ./sticky.test.ts and
  // ./client.test.ts already close: a desk left installed by one case is a desk
  // the next one silently uses.
  setReactRoles(null)
  setSink(null)
})

function cfg(over: Partial<Config> = {}): Config {
  return {
    discordToken: 'token',
    guildId: GUILD,
    adminRoleId: '999999999999999999',
    logChannelId: null,
    statusChannelId: null,
    docsChannelId: null,
    maintenanceChannelId: null,
    exemptChannelIds: [],
    serverIps: ['3.130.92.28'],
    exemptAdmins: true,
    dryRun: false,
    commandSecret: null,
    ringmasterUrl: 'http://127.0.0.1:3000',
    gameBanRoleId: '1542596612306505808',
    ...over,
  }
}

/** One row as it is stored, with only the fields a test cares about spelled out. */
function pairing(over: Partial<ReactRolePairing> = {}): ReactRolePairing {
  return {
    messageId: MESSAGE,
    emoji: EMOJI,
    roleId: ROLE_A,
    channelId: CHANNEL,
    guildId: GUILD,
    createdAt: 1_700_000_000_000,
    createdBy: MEMBER,
    ...over,
  }
}

/** What a `GetItem` on the pairing table was asked for, in order. */
type Asked = [string, string]

interface Table {
  readonly reactRoles: Ddb['reactRoles']
  readonly asked: Asked[]
  readonly saved: ReactRolePairing[]
}

/**
 * The pairing table, as a map.
 *
 * IT RECORDS WHAT IT WAS ASKED FOR AND NOT ONLY WHAT IT ANSWERED, because half
 * of what is being checked here is the SHAPE of the lookup: which keys, in which
 * order, and how many of them were needed before an answer came back. That is
 * the owner's "reaction lookups must not scan the table", asserted rather than
 * promised.
 */
function table(rows: readonly ReactRolePairing[] = [], failure?: DdbFailureKind): Table {
  const asked: Asked[] = []
  const saved: ReactRolePairing[] = []
  const held = new Map(rows.map((row) => [`${row.messageId}\0${row.emoji}`, row]))

  const fail = <T>(op: 'get' | 'put'): DdbResult<T> => ({
    ok: false,
    failure: {
      kind: failure ?? 'error',
      op,
      table: 'ringmaster-reactroles',
      message: 'from the fake',
    },
  })

  return {
    asked,
    saved,

    reactRoles: {
      get: (messageId, emoji) => {
        asked.push([messageId, emoji])

        if (failure !== undefined) return Promise.resolve(fail<ReactRolePairing | null>('get'))
        return Promise.resolve({ ok: true, value: held.get(`${messageId}\0${emoji}`) ?? null })
      },

      put: (input) => {
        if (failure !== undefined) return Promise.resolve(fail<ReactRolePairing>('put'))

        const row: ReactRolePairing = { ...input, createdAt: 1_700_000_000_000 }

        saved.push(row)
        held.set(`${row.messageId}\0${row.emoji}`, row)

        return Promise.resolve({ ok: true, value: row })
      },
    },
  }
}

/** What the bot did to somebody's roles, in order. */
type RoleEdit = ['add' | 'remove', string, string]

function grants(fails = false): ReactRoleGrants & { edits: RoleEdit[] } {
  const edits: RoleEdit[] = []

  const edit = (kind: 'add' | 'remove') => async (userId: string, roleId: string) => {
    if (fails) throw new Error('Missing Permissions')
    edits.push([kind, userId, roleId])
    await Promise.resolve()
  }

  return { edits, add: edit('add'), remove: edit('remove') }
}

function deps(rows: readonly ReactRolePairing[] = [], over: Partial<ReactRoleDeps> = {}) {
  const held = table(rows)
  const roles = grants()
  const reads = latch()

  return {
    held,
    roles,
    reads,
    deps: { ddb: held, roles, guildId: GUILD, reads, ...over } satisfies ReactRoleDeps,
  }
}

/** A reaction as the gateway describes one, reduced. */
function reaction(over: Partial<Reaction> = {}): Reaction {
  return {
    messageId: MESSAGE,
    channelId: CHANNEL,
    guildId: GUILD,
    emoji: EMOJI,
    userId: MEMBER,
    fromBot: false,
    ...over,
  }
}

/* ------------------------------------------------------------------ */

describe('the emoji key', () => {
  /**
   * THE ID FOR A CUSTOM EMOJI, WHICH IS THE HALF THAT SURVIVES A RENAME. A key
   * built from the name would stop matching the day somebody edits the emoji in
   * server settings, and nothing anywhere would say so.
   */
  it('is the id for a custom emoji and the character for a unicode one', () => {
    expect(emojiKeyOf({ id: CUSTOM, name: 'blitz' })).toBe(CUSTOM)
    expect(emojiKeyOf({ id: null, name: EMOJI })).toBe(EMOJI)
  })

  it('is null for a payload carrying neither', () => {
    expect(emojiKeyOf({ id: null, name: null })).toBeNull()
    expect(emojiKeyOf({ id: '', name: '' })).toBeNull()
  })
})

describe('reading a live reaction', () => {
  const live = (over: Partial<LiveReaction['message']> = {}): LiveReaction => ({
    emoji: { id: null, name: EMOJI },
    message: { id: MESSAGE, channelId: CHANNEL, guildId: GUILD, ...over },
  })

  it('takes the three ids off the message, partial or not', () => {
    expect(reactionOf(live(), { id: MEMBER, bot: false }, SELF)).toEqual({
      messageId: MESSAGE,
      channelId: CHANNEL,
      guildId: GUILD,
      emoji: EMOJI,
      userId: MEMBER,
      fromBot: false,
    })
  })

  it('marks a reaction Discord said was a bot’s', () => {
    expect(reactionOf(live(), { id: '123', bot: true }, SELF).fromBot).toBe(true)
  })

  /**
   * AND THIS BOT'S OWN, EVEN WHEN THE PAYLOAD DOES NOT SAY. A removal carries a
   * bare user id and no member object, so for an account that is not in the user
   * cache discord.js hands over a partial user whose `bot` is undefined. The one
   * bot whose reaction must never be acted on is this one, and its id is known.
   */
  it('marks this bot’s own reaction even when the payload does not say it is a bot', () => {
    const partial: LiveReactor = { id: SELF }

    expect(reactionOf(live(), partial, SELF).fromBot).toBe(true)
    expect(reactionOf(live(), partial, null).fromBot).toBe(false)
  })
})

describe('which pairing governs a reaction', () => {
  /**
   * ONE READ WHEN THE MESSAGE HAS THE EXACT EMOJI, which is the shape `/reactrole`
   * pre-reacts for and the one most reactions in a working setup take.
   */
  it('asks one key when the message names that emoji', async () => {
    const held = table([pairing()])

    const found = await pairingFor(held.reactRoles, MESSAGE, CHANNEL, EMOJI)

    expect(found).toEqual({ ok: true, value: { pairing: pairing(), how: 'message-exact' } })
    expect(held.asked).toEqual([[MESSAGE, EMOJI]])
  })

  /**
   * AND FOUR AT THE ABSOLUTE MOST, IN THIS ORDER. Every reaction in the guild
   * that matches nothing costs exactly this, which is why it is asserted: a
   * fifth key, or a `Query` over the partition, would be a change in what this
   * feature costs per reaction and should be a visible edit to this list.
   */
  it('asks four keys and no more when nothing matches, message first', async () => {
    const held = table()

    await expect(pairingFor(held.reactRoles, MESSAGE, CHANNEL, EMOJI)).resolves.toEqual({
      ok: true,
      value: null,
    })

    expect(held.asked).toEqual([
      [MESSAGE, EMOJI],
      [MESSAGE, REACT_ROLE_ANY],
      [reactRoleChannelKey(CHANNEL), EMOJI],
      [reactRoleChannelKey(CHANNEL), REACT_ROLE_ANY],
    ])
  })

  /** A MESSAGE ROW BEATS A CHANNEL ROW, which is the owner's rule, stated first. */
  it('prefers a pairing made for the message over a channel-wide one', async () => {
    const held = table([
      pairing({ roleId: ROLE_A }),
      pairing({ messageId: reactRoleChannelKey(CHANNEL), roleId: ROLE_B }),
    ])

    const found = await pairingFor(held.reactRoles, MESSAGE, CHANNEL, EMOJI)

    expect(found.ok && found.value?.pairing.roleId).toBe(ROLE_A)
    expect(found.ok && found.value?.how).toBe('message-exact')
  })

  /** AND AN EXACT EMOJI BEATS `any`, which is the second half of the same rule. */
  it('prefers an exact emoji over any, on the same message', async () => {
    const held = table([
      pairing({ roleId: ROLE_A }),
      pairing({ emoji: REACT_ROLE_ANY, roleId: ROLE_B }),
    ])

    const found = await pairingFor(held.reactRoles, MESSAGE, CHANNEL, EMOJI)

    expect(found.ok && found.value?.pairing.roleId).toBe(ROLE_A)
  })

  it('prefers an exact emoji over any, on the same channel', async () => {
    const held = table([
      pairing({ messageId: reactRoleChannelKey(CHANNEL), roleId: ROLE_A }),
      pairing({ messageId: reactRoleChannelKey(CHANNEL), emoji: REACT_ROLE_ANY, roleId: ROLE_B }),
    ])

    const found = await pairingFor(held.reactRoles, MESSAGE, CHANNEL, EMOJI)

    expect(found.ok && found.value?.pairing.roleId).toBe(ROLE_A)
    expect(found.ok && found.value?.how).toBe('channel-exact')
  })

  /**
   * THE ONE THAT DECIDES WHICH QUESTION IS THE OUTER ONE. A message row for ANY
   * emoji and a channel row for THIS emoji both match; the owner said a
   * message-specific pairing wins over a channel-wide one, so the message's
   * `any` takes it.
   */
  it('prefers the message’s any over the channel’s exact emoji', async () => {
    const held = table([
      pairing({ emoji: REACT_ROLE_ANY, roleId: ROLE_A }),
      pairing({ messageId: reactRoleChannelKey(CHANNEL), roleId: ROLE_B }),
    ])

    const found = await pairingFor(held.reactRoles, MESSAGE, CHANNEL, EMOJI)

    expect(found.ok && found.value?.pairing.roleId).toBe(ROLE_A)
    expect(found.ok && found.value?.how).toBe('message-any')
  })

  /**
   * A FAILED READ IS NOT "NO PAIRING". The two are opposite instructions, and a
   * lookup that collapsed them would take a role off somebody because DynamoDB
   * timed out.
   */
  it('hands back the failure rather than calling it a miss', async () => {
    const held = table([], 'timeout')

    const found = await pairingFor(held.reactRoles, MESSAGE, CHANNEL, EMOJI)

    expect(found.ok).toBe(false)
    if (!found.ok) expect(found.failure.kind).toBe('timeout')

    // And it stopped at the first one rather than spending four round trips on
    // a table that is not answering.
    expect(held.asked).toHaveLength(1)
  })
})

describe('acting on a reaction — the four shapes', () => {
  const shapes = [
    { name: 'a message and an emoji', row: pairing(), how: 'message-exact' },
    { name: 'a message and any emoji', row: pairing({ emoji: REACT_ROLE_ANY }), how: 'message-any' },
    {
      name: 'a channel and an emoji',
      row: pairing({ messageId: reactRoleChannelKey(CHANNEL) }),
      how: 'channel-exact',
    },
    {
      name: 'a channel and any emoji',
      row: pairing({ messageId: reactRoleChannelKey(CHANNEL), emoji: REACT_ROLE_ANY }),
      how: 'channel-any',
    },
  ] as const

  for (const shape of shapes) {
    it(`gives the role when somebody reacts, for ${shape.name}`, async () => {
      const world = deps([shape.row])

      const did = await handleReaction(reaction(), 'added', world.deps)

      expect(did).toEqual({ did: 'granted', roleId: ROLE_A, how: shape.how })
      expect(world.roles.edits).toEqual([['add', MEMBER, ROLE_A]])
    })

    /**
     * AND TAKES IT BACK, IN EVERY SHAPE. "Removing the reaction removes the
     * role" is one sentence of the owner's that applies to all four, so it is
     * asserted for all four rather than for the one anybody would have checked.
     */
    it(`takes the role back when the reaction goes, for ${shape.name}`, async () => {
      const world = deps([shape.row])

      const did = await handleReaction(reaction(), 'removed', world.deps)

      expect(did).toEqual({ did: 'taken', roleId: ROLE_A, how: shape.how })
      expect(world.roles.edits).toEqual([['remove', MEMBER, ROLE_A]])
    })
  }

  /**
   * A CHANNEL-WIDE PAIRING COVERS A MESSAGE NOBODY HAS EVER SEEN, which is the
   * whole point of that shape: an admin pairs the channel and every message
   * posted in it afterwards works, with nothing written per message.
   */
  it('covers any message in the channel, including ones that did not exist yet', async () => {
    const world = deps([pairing({ messageId: reactRoleChannelKey(CHANNEL) })])

    const did = await handleReaction(reaction({ messageId: 'a-message-posted-later' }), 'added', world.deps)

    expect(did).toMatchObject({ did: 'granted', how: 'channel-exact' })
  })

  /**
   * A PAIRING SURVIVES A RESTART BECAUSE NOTHING ABOUT IT IS IN MEMORY. This is
   * that, spelled as a case: the row is written through one set of deps and read
   * back through a set built from nothing, the way the next process would.
   */
  it('acts on a pairing made before this process started', async () => {
    const before = table()

    await before.reactRoles.put({
      messageId: MESSAGE,
      emoji: EMOJI,
      roleId: ROLE_B,
      channelId: CHANNEL,
      guildId: GUILD,
      createdBy: MEMBER,
    })

    // A NEW PROCESS: new deps, new grants, nothing carried over but the rows.
    const after = table(before.saved)
    const roles = grants()

    const did = await handleReaction(reaction(), 'added', {
      ddb: after,
      roles,
      guildId: GUILD,
      reads: latch(),
    })

    expect(did).toMatchObject({ did: 'granted', roleId: ROLE_B })
    expect(roles.edits).toEqual([['add', MEMBER, ROLE_B]])
  })
})

describe('acting on a reaction — the ones that must do nothing', () => {
  /**
   * THE PRE-REACT IS WHY THIS IS THE FIRST GUARD. `/reactrole` puts the emoji on
   * the message itself so members have something to click, which is a reaction
   * from this bot on a message this bot has a pairing for — and without this the
   * bot would hand itself the role.
   */
  it('ignores a reaction from a bot, before asking DynamoDB anything', async () => {
    const world = deps([pairing()])

    const did = await handleReaction(reaction({ fromBot: true }), 'added', world.deps)

    expect(did).toEqual({ did: 'ignored', why: 'bot' })
    expect(world.held.asked).toEqual([])
    expect(world.roles.edits).toEqual([])
  })

  it('ignores a reaction with no guild on it', async () => {
    const world = deps([pairing()])

    const did = await handleReaction(reaction({ guildId: null }), 'added', world.deps)

    expect(did).toEqual({ did: 'ignored', why: 'no-guild' })
    expect(world.held.asked).toEqual([])
  })

  /**
   * THIS APPLICATION IS SHARED WITH THE RINGMASTER CONSOLE, so "only ever in one
   * guild" is a fact about today's invite list rather than a property of the
   * process. A pairing is a decision about this community.
   */
  it('ignores a reaction from another guild', async () => {
    const world = deps([pairing()])

    const did = await handleReaction(reaction({ guildId: 'another-guild' }), 'added', world.deps)

    expect(did).toEqual({ did: 'ignored', why: 'other-guild' })
    expect(world.held.asked).toEqual([])
  })

  it('ignores a reaction whose payload carried no emoji', async () => {
    const world = deps([pairing()])

    const did = await handleReaction(reaction({ emoji: null }), 'added', world.deps)

    expect(did).toEqual({ did: 'ignored', why: 'no-emoji' })
    expect(world.held.asked).toEqual([])
  })

  /** An unrelated message, in a channel with no channel-wide pairing either. */
  it('does nothing for a reaction on a message nobody paired', async () => {
    const world = deps([pairing()])

    const did = await handleReaction(reaction({ messageId: 'some-other-message' }), 'added', world.deps)

    expect(did).toEqual({ did: 'nothing' })
    expect(world.roles.edits).toEqual([])
  })

  /** And an unrelated channel, where only the channel-wide row could have matched. */
  it('does nothing for a reaction in a channel nobody paired', async () => {
    const world = deps([pairing({ messageId: reactRoleChannelKey(CHANNEL) })])

    const did = await handleReaction(
      reaction({ messageId: 'some-other-message', channelId: 'some-other-channel' }),
      'added',
      world.deps,
    )

    expect(did).toEqual({ did: 'nothing' })
    expect(world.roles.edits).toEqual([])
  })

  /** A reaction that matches nothing is silent, because most reactions are. */
  it('says nothing in the journal about a reaction that matched nothing', async () => {
    const world = deps()

    await handleReaction(reaction(), 'added', world.deps)

    expect(stdout).toEqual([])
    expect(stderr).toEqual([])
  })

  /**
   * A FAILED READ LEAVES THE MEMBER EXACTLY AS THEY WERE, and says so. Granting
   * on a failed read would invent a pairing; taking on one would remove a role
   * nobody gave up.
   *
   * A TIMEOUT RATHER THAN A DENIAL, because the two take different routes out of
   * `handleReaction` now: a transient failure is one line per reaction at `warn`,
   * which is what this test is about, and a permanent one goes through the latch
   * and is the test below.
   */
  it('changes no roles when the pairing could not be read, and journals it', async () => {
    const held = table([], 'timeout')
    const roles = grants()

    const did = await handleReaction(reaction(), 'removed', {
      ddb: held,
      roles,
      guildId: GUILD,
      reads: latch(),
    })

    expect(did).toEqual({ did: 'failed', why: 'read' })
    expect(roles.edits).toEqual([])
    expect(stderr.join('')).toContain('level=warn')
    expect(stderr.join('')).toContain('could not be matched')
  })

  /**
   * A PERMANENT FAILURE IS ONE LINE AND NOT ONE PER REACTION, WHICH IS WHAT
   * ./latch.ts WAS WRITTEN FOR. The owner creates the pairing table by hand, so
   * until he runs that command every reaction anywhere in the guild is a failed
   * read at `error`, and ./log.ts copies every error to #bot-status.
   */
  it('says a missing table once however many reactions arrive, and says when it ends', async () => {
    const roles = grants()
    const reads = latch()
    const missing = table([], 'no-such-table')

    for (let n = 0; n < 5; n += 1) {
      const did = await handleReaction(reaction(), 'added', {
        ddb: missing,
        roles,
        guildId: GUILD,
        reads,
      })

      expect(did).toEqual({ did: 'failed', why: 'read' })
    }

    const said = stderr
      .join('')
      .split('\n')
      .filter((line) => line.includes('does not exist'))

    expect(said).toHaveLength(1)
    expect(roles.edits).toEqual([])

    // AND IT CARRIES ONLY THE FIELDS THAT ARE THE SAME EVERY TIME, which is the
    // half of ./latch.ts's test for a latchable line that is easy to miss: the
    // message and the channel are different on every reaction.
    expect(said[0]).toContain('table="ringmaster-reactroles"')
    expect(said[0]).not.toContain('channel=')

    // THEN THE ALL-CLEAR, ON THE FIRST READ THAT ANSWERS. Without it "it is fixed"
    // is an absence of errors, and nobody can watch for an absence.
    await handleReaction(reaction(), 'added', {
      ddb: table([pairing()]),
      roles,
      guildId: GUILD,
      reads,
    })

    expect(stdout.join('')).toContain('answers now')
    expect(roles.edits).toEqual([['add', MEMBER, ROLE_A]])
  })

  /**
   * AND A ROLE EDIT DISCORD REFUSED IS A WARNING RATHER THAN A CRASH. The
   * command refuses a role this bot cannot assign at the moment the pairing is
   * made; what reaches here is that having become true afterwards, which is
   * somebody dragging a role in the settings page.
   */
  it('reports a refused role edit without throwing', async () => {
    const held = table([pairing()])
    const roles = grants(true)

    const did = await handleReaction(reaction(), 'added', {
      ddb: held,
      roles,
      guildId: GUILD,
      reads: latch(),
    })

    expect(did).toEqual({ did: 'failed', why: 'role' })
    expect(stderr.join('')).toContain('level=warn')
  })
})

describe('the gateway wiring', () => {
  /**
   * BUILT BY HAND RATHER THAN THROUGH `createClient`, because what is under test
   * is the two listeners and not the whole bot. The intents live on the real
   * client below.
   */
  function bare(): Client {
    return new Client({ intents: [] })
  }

  const live: LiveReaction = {
    emoji: { id: null, name: EMOJI },
    message: { id: MESSAGE, channelId: CHANNEL, guildId: GUILD },
  }

  const desk = {
    channel: () => Promise.resolve('ok' as const),
    message: () => Promise.resolve('ok' as const),
    emoji: () => Promise.resolve(true),
    role: () => ({ ok: true }) as const,
    react: () => Promise.resolve(true),
    save: () => Promise.reject(new Error('not part of this case')),
  }

  afterEach(() => {
    setReactRoles(null)
  })

  it('installs the desk the command reaches for', async () => {
    const client = bare()

    expect(reactRoles()).toBeNull()
    installReactionRoles(client, cfg(), table(), desk, grants())
    expect(reactRoles()).toBe(desk)

    await client.destroy()
  })

  it('listens for reactions arriving and reactions going away', async () => {
    const client = bare()

    installReactionRoles(client, cfg(), table(), desk, grants())

    expect(client.listenerCount(Events.MessageReactionAdd)).toBe(1)
    expect(client.listenerCount(Events.MessageReactionRemove)).toBe(1)

    await client.destroy()
  })

  /**
   * THE WHOLE PATH, FROM A GATEWAY EVENT TO A ROLE, with the two seams faked.
   * Emitted rather than called, so the listener's own reduction of the live
   * objects is what is being exercised.
   */
  it('gives the role for an emitted reaction and takes it back', async () => {
    const client = bare()
    const held = table([pairing()])
    const roles = grants()

    installReactionRoles(client, cfg(), held, desk, roles)

    client.emit(Events.MessageReactionAdd, ...asEvent(live, { id: MEMBER, bot: false }))
    client.emit(Events.MessageReactionRemove, ...asEvent(live, { id: MEMBER, bot: false }))

    // The listeners are synchronous and hand their promises to `.catch`, so the
    // work lands a tick later.
    await vi.waitFor(() => {
      expect(roles.edits).toEqual([
        ['add', MEMBER, ROLE_A],
        ['remove', MEMBER, ROLE_A],
      ])
    })

    await client.destroy()
  })
})

describe('what the client has to ask Discord for', () => {
  /**
   * THE INTENT IS NOT PRIVILEGED AND THE PARTIALS ARE THE WHOLE FEATURE. Without
   * `GuildMessageReactions` no reaction event arrives at all; without
   * `Partials.Reaction` and `Partials.User` discord.js drops the ones about
   * messages this process has not cached, which for a reaction role is all of
   * them — the message has been sitting in the channel since before the last
   * restart. Both failures are silent.
   */
  it('asks for the reaction intent and the partials reactions need', async () => {
    const client = createClient(cfg())

    expect(client.options.intents.has(GatewayIntentBits.GuildMessageReactions)).toBe(true)
    expect(client.options.partials).toContain(Partials.Reaction)
    expect(client.options.partials).toContain(Partials.User)

    // And the one that was already there, which reactions need too.
    expect(client.options.partials).toContain(Partials.Message)

    await client.destroy()
  })

  it('wires the reaction listeners onto the real client', async () => {
    const client = createClient(cfg())

    expect(client.listenerCount(Events.MessageReactionAdd)).toBe(1)
    expect(client.listenerCount(Events.MessageReactionRemove)).toBe(1)

    await client.destroy()
  })
})

/**
 * The two arguments discord.js hands a reaction listener, as this file builds
 * them.
 *
 * A CAST AT THE EMIT AND NOWHERE ELSE, which is ./client.test.ts's `asGateway`
 * and the same argument: the real `MessageReaction` and `User` are live objects
 * with REST handles, and the listener reads six fields off them. Casting once,
 * here, keeps every other line in this file honest about what it built.
 */
function asEvent(reaction: LiveReaction, user: LiveReactor): [never, never, never] {
  return [reaction, user, { type: 0, burst: false }] as unknown as [never, never, never]
}

/**
 * THIS FILE AS GIT SEES IT, BECAUSE THREE OF ITS BYTES WERE NUL AND GIT NOTICED.
 *
 * The fake table above joins its map key with a separator, and it was written as
 * a literal NUL rather than as the escape. Git calls a file with a NUL in its
 * first eight thousand bytes BINARY, and that has two consequences, neither of
 * them about this test: `* text=auto eol=lf` in .gitattributes stops applying to
 * it, and every `git diff`, `git show` and PR view of it prints "Binary files
 * differ" instead of the change while `grep` and `rg` skip it by default. A
 * repo-wide search for `handleReaction` would silently not show the file that
 * tests it. The escape is the same byte at run time and none of that.
 */
describe('this file as git sees it', () => {
  it('carries no NUL byte, so git treats it as text', () => {
    const bytes = readFileSync(new URL('./reactroles.test.ts', import.meta.url))

    expect(bytes.includes(0)).toBe(false)
  })
})
