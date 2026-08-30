import { readFileSync } from 'node:fs'

import type {
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createDdb,
  createDocument,
  isBanActive,
  isMaintenanceDraining,
  isMaintenanceLive,
  qualifyId,
  tableNames,
  type Actor,
  type AuditAction,
  type AuditHandle,
  type AuditOutcome,
  type AuditRow,
  type Ban,
  type BanIssueInput,
  type Ddb,
  type DdbOp,
  type DdbResult,
  type DocumentClient,
  type MaintenanceWindow,
  type RequestOptions,
} from './ddb.ts'

/**
 * The DynamoDB layer, offline.
 *
 * NOTHING HERE TOUCHES AWS AND NOTHING HERE COULD. Every test injects a fake
 * document client that records what it was asked for and answers from a
 * literal three lines above the assertion — which is possible at all because
 * `createDdb` takes that client as an option, and is the reason it does. The
 * one exception is the region pair below, which constructs a REAL SDK client
 * and reads its resolved region back: constructing a client opens no socket
 * and resolves no credentials, and the fact under test is the SDK's own
 * behaviour rather than ours, so a fake could not establish it.
 *
 * THE FOUR THINGS THIS FILE IS REALLY FOR, each of which is a production
 * failure the module was written against rather than an invariant somebody
 * liked the sound of:
 *
 *   the region is explicit — the tables and the box need not share one, and
 *   the SDK will silently take the box's and fail against tables that exist;
 *
 *   the deadline is real — a call that hangs burns Discord's three seconds and
 *   the admin sees nothing at all;
 *
 *   the audit write cannot clobber a row — the bot is the SECOND writer to a
 *   partition keyed by the millisecond, on an append-only log;
 *
 *   this module talks to DynamoDB and to nothing else — the console's HTTP API
 *   is not a dependency of this bot, and a test that reads the imports is the
 *   only thing that keeps it that way.
 */

const LICENSE = 'license:abc123'

const ACTOR: Actor = {
  license: 'license:admin1',
  name: 'Admin One',
  discordId: '280000000000000000',
}

/** A Discord audit log entry id: the idempotency key for a ban write. */
const ENTRY = '1300000000000000000'

/** The smallest legal ban write. Spread and overridden where a test needs more. */
const ISSUE: BanIssueInput = {
  id: LICENSE,
  by: ACTOR.license,
  byName: ACTOR.name,
  reason: 'cheating',
  expiresAt: null,
  entryId: ENTRY,
}

/** Any AWS response is legal with only this on it; every field we read is optional. */
const META = { $metadata: {} }

type AnyInput = GetCommandInput | PutCommandInput | UpdateCommandInput | QueryCommandInput

interface Recorded {
  op: DdbOp
  table: string
  input: AnyInput
  signal: AbortSignal | undefined
}

interface Handlers {
  get?: (input: GetCommandInput) => Promise<GetCommandOutput>
  put?: (input: PutCommandInput) => Promise<PutCommandOutput>
  update?: (input: UpdateCommandInput) => Promise<UpdateCommandOutput>
  query?: (input: QueryCommandInput) => Promise<QueryCommandOutput>
}

interface Fake {
  doc: DocumentClient
  calls: Recorded[]
}

/**
 * A document client that writes down what it was asked and answers from the
 * handler it was given, or with an empty response.
 *
 * IT RECORDS THE ABORT SIGNAL, which is most of the point. "Did this call
 * carry a deadline" is not visible in a return value; it is visible in what
 * the SDK was handed, and that is the only place it can be checked from.
 */
function fakeDocument(handlers: Handlers = {}): Fake {
  const calls: Recorded[] = []

  function record<I extends AnyInput, O>(
    op: DdbOp,
    handler: ((input: I) => Promise<O>) | undefined,
    empty: O,
  ): (input: I, options?: RequestOptions) => Promise<O> {
    return async (input, options) => {
      calls.push({ op, table: input.TableName ?? '', input, signal: options?.abortSignal })
      return handler ? handler(input) : empty
    }
  }

  return {
    calls,
    doc: {
      get: record('get', handlers.get, META),
      put: record('put', handlers.put, META),
      update: record('update', handlers.update, META),
      query: record('query', handlers.query, META),
    },
  }
}

/** A document client whose every call rejects with this error. */
function failingDocument(error: unknown): DocumentClient {
  const reject = async (): Promise<never> => {
    throw error
  }
  return { get: reject, put: reject, update: reject, query: reject }
}

/** A document client whose every call never settles. What a hang looks like. */
function hangingDocument(): DocumentClient {
  const hang = (): Promise<never> => new Promise<never>(() => {})
  return { get: hang, put: hang, update: hang, query: hang }
}

/** An AWS-shaped exception: the SDK identifies these by `name`, so we do too. */
function awsError(name: string, message = 'from the fake'): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/**
 * Every call the module offers, so a property that must hold for all of them
 * can be asserted for all of them rather than for the two somebody remembered.
 * A new accessor that is not on this list fails nothing — a new accessor that
 * is on it has to survive the deadline, the classification and the write
 * inventory below.
 */
const EXERCISES: Array<{ name: string; run: (ddb: Ddb) => Promise<DdbResult<unknown>> }> = [
  { name: 'bans.get', run: (d) => d.bans.get(LICENSE) },
  { name: 'bans.issue', run: (d) => d.bans.issue(ISSUE) },
  {
    name: 'bans.lift',
    run: (d) => d.bans.lift({ id: LICENSE, by: ACTOR.license, byName: ACTOR.name }),
  },
  { name: 'players.get', run: (d) => d.players.get(LICENSE) },
  { name: 'playerIds.licensesFor', run: (d) => d.playerIds.licensesFor(qualifyId('discord', '280')) },
  { name: 'gamePlayers.profile', run: (d) => d.gamePlayers.profile(LICENSE) },
  { name: 'gamePlayers.matches', run: (d) => d.gamePlayers.matches(LICENSE, 25) },
  { name: 'maintenance.current', run: (d) => d.maintenance.current() },
  { name: 'audit.begin', run: (d) => d.audit.begin({ action: 'player.kick', actor: ACTOR }) },
  { name: 'audit.resolve', run: (d) => d.audit.resolve({ commandId: 'c1', ts: 1 }, 'ok') },
  { name: 'audit.recent', run: (d) => d.audit.recent(10) },
  { name: 'botState.get', run: (d) => d.botState.get('reported-commit') },
  { name: 'botState.put', run: (d) => d.botState.put('reported-commit', 'abc1234') },
]

/* ------------------------------------------------------------------ */

describe('the region', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to us-east-2', () => {
    expect(createDdb({ document: fakeDocument().doc }).region).toBe('us-east-2')
  })

  it('is overridable, so a second stack is an option and not an edit', () => {
    expect(createDdb({ region: 'eu-west-1', document: fakeDocument().doc }).region).toBe('eu-west-1')
  })

  /**
   * THE TRAP, STATED AS A TEST. The box's region and the tables' region are
   * not the same fact. Left to itself the SDK takes the box's — from the
   * environment, then from instance metadata — and every call fails with
   * `ResourceNotFoundException` against tables that plainly exist, which reads
   * as a missing table and sends you looking at spelling and IAM first.
   */
  it('ignores AWS_REGION in the environment', () => {
    vi.stubEnv('AWS_REGION', 'ap-south-1')
    expect(createDdb({ document: fakeDocument().doc }).region).toBe('us-east-2')
  })

  /**
   * The other half of the same fact, and the only test here that builds a real
   * client: that our explicit value is what the SDK actually resolves, rather
   * than a string we keep on the side while the client goes and finds its own.
   * No socket is opened and no credential is resolved by constructing one.
   */
  it('is what the real SDK client resolves, environment or no environment', async () => {
    vi.stubEnv('AWS_REGION', 'ap-south-1')

    const document = createDocument('us-east-2') as unknown as {
      config: { region: () => Promise<string> }
    }

    await expect(document.config.region()).resolves.toBe('us-east-2')
  })

  it('reaches the SDK when overridden', async () => {
    const document = createDocument('eu-west-1') as unknown as {
      config: { region: () => Promise<string> }
    }

    await expect(document.config.region()).resolves.toBe('eu-west-1')
  })
})

describe('table names', () => {
  it('all come from the one prefix', () => {
    expect(tableNames('ringmaster-', 'br-')).toEqual({
      bans: 'ringmaster-bans',
      players: 'ringmaster-players',
      playerIds: 'ringmaster-player-ids',
      audit: 'ringmaster-audit',
      maintenance: 'ringmaster-maintenance',
      botState: 'ringmaster-bot-state',
      gamePlayers: 'br-players',
    })
  })

  /**
   * THE PROPERTY A SECOND ENVIRONMENT DEPENDS ON. One variable moves every
   * console table; a literal left behind anywhere in the derivation is a
   * staging bot writing an audit row into production.
   */
  it('one prefix change moves every console table', () => {
    const { tables } = createDdb({ tablePrefix: 'staging-', document: fakeDocument().doc })

    const consoleTables = [
      tables.bans,
      tables.players,
      tables.playerIds,
      tables.audit,
      tables.maintenance,
      tables.botState,
    ]

    for (const table of consoleTables) expect(table.startsWith('staging-')).toBe(true)
  })

  it('leaves the game tables on their own prefix, which moves separately', () => {
    const { tables } = createDdb({
      tablePrefix: 'staging-',
      gameTablePrefix: 'brdev-',
      document: fakeDocument().doc,
    })

    expect(tables.gamePlayers).toBe('brdev-players')
    expect(tables.bans).toBe('staging-bans')
  })

  /**
   * Names derived and then not used are names that lie. This runs every
   * accessor and checks that nothing addressed a table the prefix did not
   * produce — the form a hardcoded literal would actually take.
   */
  it('are the only names any accessor sends', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ tablePrefix: 'staging-', gameTablePrefix: 'brdev-', document: fake.doc })

    for (const exercise of EXERCISES) await exercise.run(ddb)

    const known = new Set(Object.values(ddb.tables))
    expect(fake.calls.length).toBeGreaterThan(0)
    for (const call of fake.calls) expect(known).toContain(call.table)
  })
})

describe('the deadline', () => {
  /**
   * A HANG IS A TYPED FAILURE, NOT A WAIT. This is the whole reason the module
   * returns results: a command that sits on DynamoDB spends Discord's three
   * seconds and the admin is told the application did not respond, which is
   * what being down looks like.
   */
  it('turns a call that never answers into a timeout failure', async () => {
    const ddb = createDdb({ document: hangingDocument(), timeoutMs: 5 })

    const result = await ddb.bans.get(LICENSE)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('timeout')
    expect(result.failure.op).toBe('get')
    expect(result.failure.table).toBe('ringmaster-bans')
    expect(result.failure.message).toContain('5ms')
  })

  it('covers every call, not just the ones somebody remembered', async () => {
    const ddb = createDdb({ document: hangingDocument(), timeoutMs: 5 })

    for (const exercise of EXERCISES) {
      const result = await exercise.run(ddb)
      expect(result.ok, exercise.name).toBe(false)
      if (!result.ok) expect(result.failure.kind, exercise.name).toBe('timeout')
    }
  })

  /**
   * The abort is the tidying up rather than the guarantee — but without it a
   * timed-out call leaves the SDK retrying against a socket nobody is waiting
   * on. The signal is only observable in what the client was handed.
   */
  it('aborts the request it gave up on', async () => {
    const fake = fakeDocument({ get: () => new Promise<never>(() => {}) })
    const ddb = createDdb({ document: fake.doc, timeoutMs: 5 })

    await ddb.bans.get(LICENSE)

    expect(fake.calls[0]?.signal?.aborted).toBe(true)
  })

  it('passes a signal that is not aborted while the call is healthy', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.bans.get(LICENSE)

    expect(fake.calls[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(fake.calls[0]?.signal?.aborted).toBe(false)
  })

  it('answers normally when the call is quicker than the budget', async () => {
    const fake = fakeDocument({
      get: async () => ({ ...META, Item: { license: LICENSE, at: 1, expiresAt: null } }),
    })
    const ddb = createDdb({ document: fake.doc, timeoutMs: 50 })

    const result = await ddb.bans.get(LICENSE)

    expect(result).toEqual({ ok: true, value: { license: LICENSE, at: 1, expiresAt: null } })
  })
})

describe('failures', () => {
  /**
   * `ResourceNotFoundException` IS ALMOST ALWAYS THE REGION, which is why it
   * is a kind of its own rather than a line in the general bucket. The table
   * exists; this process is looking for it in the wrong place.
   */
  it('call a missing table a missing table', async () => {
    const ddb = createDdb({ document: failingDocument(awsError('ResourceNotFoundException')) })

    const result = await ddb.bans.get(LICENSE)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('no-such-table')
  })

  it('separate an IAM problem from a network one', async () => {
    const denied = createDdb({ document: failingDocument(awsError('AccessDeniedException')) })
    const missing = createDdb({ document: failingDocument(awsError('CredentialsProviderError')) })

    const first = await denied.players.get(LICENSE)
    const second = await missing.players.get(LICENSE)

    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.failure.kind).toBe('denied')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.failure.kind).toBe('credentials')
  })

  it('keep the exception we have never seen as a plain error, with its message', async () => {
    const ddb = createDdb({
      document: failingDocument(awsError('ProvisionedThroughputExceededException', 'slow down')),
    })

    const result = await ddb.maintenance.current()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('error')
      expect(result.failure.message).toBe('slow down')
      expect(result.failure.op).toBe('get')
      expect(result.failure.table).toBe('ringmaster-maintenance')
    }
  })

  /**
   * MATCHED ON THE NAME, NEVER ON THE MESSAGE. An error that merely says the
   * word "denied" is not an authorisation failure, and classifying it as one
   * sends an operator to the IAM console over a network blip.
   */
  it('do not classify on the text of a message', async () => {
    const ddb = createDdb({
      document: failingDocument(awsError('SomethingElse', 'access denied to the socket')),
    })

    const result = await ddb.bans.get(LICENSE)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('error')
  })

  it('survive a client that throws instead of rejecting', async () => {
    const explode = (): Promise<never> => {
      throw new Error('synchronous')
    }
    const ddb = createDdb({
      document: { get: explode, put: explode, update: explode, query: explode },
    })

    const result = await ddb.bans.get(LICENSE)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.message).toBe('synchronous')
  })

  /**
   * A REJECTION IS A `catch` SOMEBODY HAS TO REMEMBER; A RESULT IS NOT. Every
   * accessor comes back rather than throwing, so a command handler that
   * forgets one cannot produce a silent interaction.
   */
  it('never escape as a rejection, from any accessor', async () => {
    const ddb = createDdb({ document: failingDocument(awsError('ResourceNotFoundException')) })

    for (const exercise of EXERCISES) {
      const result = await exercise.run(ddb)
      expect(result.ok, exercise.name).toBe(false)
    }
  })
})

describe('reads', () => {
  it('address the bans table by license and report no row as null', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    const result = await ddb.bans.get(LICENSE)

    expect(result).toEqual({ ok: true, value: null })
    expect(fake.calls[0]?.input).toMatchObject({
      TableName: 'ringmaster-bans',
      Key: { license: LICENSE },
    })
  })

  it('address the registry by license', async () => {
    const fake = fakeDocument({
      get: async () => ({ ...META, Item: { license: LICENSE, name: 'Someone' } }),
    })
    const ddb = createDdb({ document: fake.doc })

    const result = await ddb.players.get(LICENSE)

    expect(result.ok && result.value?.name).toBe('Someone')
    expect(fake.calls[0]?.input).toMatchObject({ Key: { license: LICENSE } })
  })

  /**
   * The reverse index is keyed on the QUALIFIED identifier, and a bare id is a
   * valid lookup that finds nothing — so "this Discord account has never been
   * here" would be said with confidence about somebody who is in the table.
   */
  it('address the reverse index by the qualified identifier', async () => {
    const fake = fakeDocument({
      get: async () => ({ ...META, Item: { id: 'discord:280', licenses: [LICENSE] } }),
    })
    const ddb = createDdb({ document: fake.doc })

    const result = await ddb.playerIds.licensesFor(qualifyId('discord', '280'))

    expect(result).toEqual({ ok: true, value: [LICENSE] })
    expect(fake.calls[0]?.input).toMatchObject({
      TableName: 'ringmaster-player-ids',
      Key: { id: 'discord:280' },
    })
  })

  it('report an identifier nobody has presented as an empty list', async () => {
    const ddb = createDdb({ document: fakeDocument().doc })

    await expect(ddb.playerIds.licensesFor('discord:nobody')).resolves.toEqual({
      ok: true,
      value: [],
    })
  })

  /**
   * THE GAME'S ROW IS COMPOSITE-KEYED and the console's is not. Getting this
   * wrong returns no row rather than an error, which reads as "never played".
   */
  it("address the game's row with both halves of its key", async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.gamePlayers.profile(LICENSE)

    expect(fake.calls[0]?.input).toMatchObject({
      TableName: 'br-players',
      Key: { pk: LICENSE, sk: 'profile' },
    })
  })

  it('report a player the game has never recorded as null, not as zeroes', async () => {
    const ddb = createDdb({ document: fakeDocument().doc })

    await expect(ddb.gamePlayers.profile(LICENSE)).resolves.toEqual({ ok: true, value: null })
  })

  /**
   * PROJECTED FIELD BY FIELD because the writer is the game server, in another
   * repo and another language. A renamed or missing field costs that field.
   */
  it('project the game row rather than trusting its shape', async () => {
    const fake = fakeDocument({
      get: async () => ({
        ...META,
        Item: { matches: 12, wins: 'three', kills: 40, lastMatchAt: 1700000000000 },
      }),
    })
    const ddb = createDdb({ document: fake.doc })

    const result = await ddb.gamePlayers.profile(LICENSE)

    expect(result.ok).toBe(true)
    if (!result.ok || result.value === null) return
    expect(result.value.matches).toBe(12)
    expect(result.value.kills).toBe(40)
    // A string where a number was promised is that field's problem and nobody
    // else's; it must not arrive downstream as NaN.
    expect(result.value.wins).toBe(0)
    expect(result.value.deaths).toBe(0)
    expect(result.value.lastMatchAt).toBe(1700000000000)
  })

  it('floor the level at one, because zero is an absent field', async () => {
    const ddb = createDdb({
      document: fakeDocument({ get: async () => ({ ...META, Item: { matches: 1 } }) }).doc,
    })

    const result = await ddb.gamePlayers.profile(LICENSE)

    expect(result.ok && result.value?.level).toBe(1)
  })

  it('read the one maintenance row by its fixed key', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.maintenance.current()

    expect(fake.calls[0]?.input).toMatchObject({
      TableName: 'ringmaster-maintenance',
      Key: { id: 'current' },
    })
  })

  /**
   * THE MATCH HISTORY IS A QUERY, NOT A SCAN AND NOT A SECOND TABLE.
   *
   * The game hangs one row per match off the PLAYER's own partition with a sort
   * key of `match#<endedAt>#<matchId>`, so walking that key backwards with a
   * `Limit` already is "the most recent N". Three things have to be right at
   * once and every one of them fails quietly: a missing `begins_with` returns
   * `profile` and `purchases` as if they were matches, a forward scan returns
   * the player's FIRST twenty-five, and a `Limit` taken on trust is an
   * unbounded read on a two-second deadline.
   */
  it("read the match rows off the player's own partition, newest first", async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.gamePlayers.matches(LICENSE, 25)

    expect(fake.calls[0]?.op).toBe('query')
    expect(fake.calls[0]?.input).toMatchObject({
      TableName: 'br-players',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': LICENSE, ':sk': 'match#' },
      ScanIndexForward: false,
      Limit: 25,
    })
  })

  /**
   * THE CAP IS THE READER'S AND NOT THE CALLER'S. A limit is a parameter because
   * the caller knows what it can render; a parameter with no ceiling is one bad
   * call away from paging a player with two thousand matches into Discord's
   * three seconds.
   */
  it('never ask for more rows than the reader will allow, whatever it is told', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.gamePlayers.matches(LICENSE, 5_000)
    await ddb.gamePlayers.matches(LICENSE)

    expect(fake.calls[0]?.input).toMatchObject({ Limit: 50 })

    // And the default is the same ceiling rather than a second number.
    expect(fake.calls[1]?.input).toMatchObject({ Limit: 50 })
  })

  /** DynamoDB reads `Limit: 0` as its own thing; a caller asking for none of
   * something is a caller with a bug, and one row is the cheapest honest answer. */
  it('never ask for zero rows or a fraction of one', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.gamePlayers.matches(LICENSE, 0)
    await ddb.gamePlayers.matches(LICENSE, 2.7)

    expect(fake.calls[0]?.input).toMatchObject({ Limit: 1 })
    expect(fake.calls[1]?.input).toMatchObject({ Limit: 2 })
  })

  /**
   * PROJECTED FIELD BY FIELD, like the career row beside it and for the same
   * reason — br_ddb writes these, in Lua, in another repo.
   *
   * AND AN ABSENT FIELD IS NULL RATHER THAN ZERO, which is the one place this
   * differs from `profile`. `0 kills` is a sentence about a match that was
   * played; a row from a build of the game that did not record kills would say
   * exactly the same thing and be inventing it.
   */
  it('project a match row, and leave a field that did not arrive absent', async () => {
    const fake = fakeDocument({
      query: async () => ({
        ...META,
        Items: [
          { sk: 'match#000001700000000000#42', endedAt: 1_700_000_000_000, placement: 3, kills: 7 },
          { sk: 'match#000001600000000000#41', placement: 'second' },
        ],
      }),
    })
    const ddb = createDdb({ document: fake.doc })

    const result = await ddb.gamePlayers.matches(LICENSE, 25)

    expect(result).toEqual({
      ok: true,
      value: [
        { sk: 'match#000001700000000000#42', at: 1_700_000_000_000, placement: 3, kills: 7 },
        { sk: 'match#000001600000000000#41', at: null, placement: null, kills: null },
      ],
    })
  })

  /**
   * AN EMPTY LIST IS AN ANSWER AND A FAILURE IS NOT ONE. A player with no
   * per-match rows has never played, or played only before the game recorded
   * them individually; a read that was denied is `{ ok: false }` and must never
   * reach anybody as "no matches".
   */
  it('answer an empty history and a denied read differently', async () => {
    const empty = createDdb({ document: fakeDocument().doc })
    await expect(empty.gamePlayers.matches(LICENSE, 25)).resolves.toEqual({ ok: true, value: [] })

    const denied = createDdb({ document: failingDocument(awsError('AccessDeniedException')) })
    const result = await denied.gamePlayers.matches(LICENSE, 25)

    expect(result).toMatchObject({ ok: false, failure: { kind: 'denied', op: 'query' } })
  })

  it('read the audit log newest first', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.audit.recent(25)

    expect(fake.calls[0]?.input).toMatchObject({
      TableName: 'ringmaster-audit',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'AUDIT' },
      ScanIndexForward: false,
      Limit: 25,
    })
  })
})

describe('the bot state table', () => {
  it('is keyed on the state key and stamps its own updatedAt', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc, now: () => 1_700_000_000_000 })

    const result = await ddb.botState.put('reported-commit', 'abc1234')

    expect(result).toEqual({
      ok: true,
      value: { key: 'reported-commit', value: 'abc1234', updatedAt: 1_700_000_000_000 },
    })
    expect(fake.calls[0]?.input).toMatchObject({
      TableName: 'ringmaster-bot-state',
      Item: { key: 'reported-commit', value: 'abc1234', updatedAt: 1_700_000_000_000 },
    })
  })

  it('reads back a key that was never written as null', async () => {
    const ddb = createDdb({ document: fakeDocument().doc })

    await expect(ddb.botState.get('never-written')).resolves.toEqual({ ok: true, value: null })
  })
})

/* ------------------------------------------------------------------ *
 * The ban write path.
 *
 * THE ONE FAILURE THIS SECTION IS FOR: the console's `bans.issue` is an
 * unconditional PutItem of a whole row, so a repeated Discord event run
 * through a copy of it would replace a row an admin had deliberately LIFTED
 * and put somebody back under a ban nobody re-issued. Silently. Most of what
 * follows is that one sentence, asserted from several directions.
 * ------------------------------------------------------------------ */

/** A ban row exactly as the console writes one: explicit nulls, no entry id. */
const CONSOLE_BAN: Ban = {
  license: LICENSE,
  at: 1_000,
  by: 'license:admin1',
  byName: 'Admin One',
  reason: 'cheating',
  expiresAt: null,
  playerName: 'Someone',
  liftedAt: null,
  liftedBy: null,
  liftedByName: null,
  liftReason: null,
}

/** The same, lifted by somebody else. The row a replay must not write over. */
const LIFTED_BAN: Ban = {
  ...CONSOLE_BAN,
  liftedAt: 1_500,
  liftedBy: 'license:admin2',
  liftedByName: 'Admin Two',
  liftReason: 'appealed',
}

/** A table holding this row for the read that every write starts with. */
function holding(ban: Ban | null): Handlers {
  return { get: async () => ({ ...META, ...(ban ? { Item: ban } : {}) }) }
}

/** Was anything written at all? Half of these tests are about not writing. */
function wrote(calls: Recorded[]): boolean {
  return calls.some((call) => call.op === 'put' || call.op === 'update')
}

/**
 * `Ban` AS fivem-ringmaster/src/lib/bans.ts DECLARES IT, transcribed by hand
 * and deliberately not imported — same treatment as `ConsoleAuditRow` below,
 * and now for the same reason: the bot WRITES these rows, so a field it
 * renamed or dropped is a row the console renders wrong and the connect gate
 * reads wrong.
 *
 * `discordEntryId` IS NOT ON THIS INTERFACE AND MUST NOT BE. It is the one
 * attribute the console does not know about, and `toConsoleBan` still compiles
 * because an extra property on a typed value is not an excess-property error —
 * which is precisely the guarantee being claimed: the bot's own attribute
 * costs the console nothing.
 */
interface ConsoleBan {
  license: string
  at: number
  by: string | null
  byName: string
  reason: string
  expiresAt: number | null
  playerName?: string | null
  liftedAt?: number | null
  liftedBy?: string | null
  liftedByName?: string | null
  liftReason?: string | null
}

const toConsoleBan: (ban: Ban) => ConsoleBan = (ban) => ban
const toModuleBan: (ban: ConsoleBan) => Ban = (ban) => ban

describe('the ban row', () => {
  /** The assertion is the typecheck, as with the audit row. See above. */
  it("is the console's row, both ways round", () => {
    expect(toModuleBan(toConsoleBan(CONSOLE_BAN))).toEqual(CONSOLE_BAN)
  })
})

describe('issuing a ban', () => {
  it("writes the console's fields, including the nulls it writes explicitly", async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc, now: () => 1_700_000_000_000 })

    const result = await ddb.bans.issue({
      ...ISSUE,
      playerName: 'Someone',
      expiresAt: 1_800_000_000_000,
    })

    expect(result.ok && result.value.outcome).toBe('issued')
    expect(writtenRow(fake.calls)).toEqual({
      license: LICENSE,
      at: 1_700_000_000_000,
      by: 'license:admin1',
      byName: 'Admin One',
      reason: 'cheating',
      expiresAt: 1_800_000_000_000,
      playerName: 'Someone',
      // The console's explicit nulls, kept so a bot row and a console row are
      // the same shape — NOT because the put needs them to clear a lift, which
      // it does not: a `PutItem` replaces the whole item on its own.
      liftedAt: null,
      liftedBy: null,
      liftedByName: null,
      liftReason: null,
      discordEntryId: ENTRY,
    })
  })

  it('reports the row it wrote, so a caller need not rebuild it', async () => {
    const ddb = createDdb({ document: fakeDocument().doc, now: () => 1_700_000_000_000 })

    const result = await ddb.bans.issue(ISSUE)

    expect(result).toEqual({
      ok: true,
      value: {
        outcome: 'issued',
        ban: {
          license: LICENSE,
          at: 1_700_000_000_000,
          by: 'license:admin1',
          byName: 'Admin One',
          reason: 'cheating',
          expiresAt: null,
          playerName: null,
          liftedAt: null,
          liftedBy: null,
          liftedByName: null,
          liftReason: null,
          discordEntryId: ENTRY,
        },
      },
    })
  })

  /**
   * A BAN ON SOMEBODY THE GAME HAS NEVER SEEN. The table is keyed on a
   * qualified identifier, so this is `qualifyId('discord', …)` in the same
   * place a license goes — and the ATTRIBUTE is still called `license`,
   * because renaming it would be a row the console and the game cannot find.
   *
   * IT IS A RECORD RATHER THAN A DOOR, and the test says so because the code
   * cannot: `br_ddb`'s connect gate does one GetItem on the connecting
   * player's LICENSE, so this row does not stop anybody joining.
   */
  it('keys a row on whatever qualified identifier it is given', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })
    const id = qualifyId('discord', '280000000000000000')

    await ddb.bans.issue({ ...ISSUE, id, playerName: 'someone' })

    expect(fake.calls[0]?.input).toMatchObject({
      TableName: 'ringmaster-bans',
      Key: { license: id },
    })
    expect(writtenRow(fake.calls)).toMatchObject({ license: id, playerName: 'someone' })
  })

  it('writes nothing when an active ban already stands, and reports the one that does', async () => {
    const fake = fakeDocument(holding(CONSOLE_BAN))
    const ddb = createDdb({ document: fake.doc, now: () => 2_000 })

    const result = await ddb.bans.issue({ ...ISSUE, entryId: 'a-second-event' })

    expect(result).toEqual({ ok: true, value: { outcome: 'already-banned', ban: CONSOLE_BAN } })
    expect(wrote(fake.calls)).toBe(false)
  })

  /**
   * `isBanActive` DECIDES, not an `if` written out in the write path — the
   * same rule the console and the connect gate use. An expiry in the past is
   * a ban served, and re-banning is then a normal thing to do.
   */
  it('bans over a ban that has expired', async () => {
    const fake = fakeDocument(holding({ ...CONSOLE_BAN, expiresAt: 2_000 }))
    const ddb = createDdb({ document: fake.doc, now: () => 3_000 })

    const result = await ddb.bans.issue({ ...ISSUE, entryId: 'a-second-event' })

    expect(result.ok && result.value.outcome).toBe('issued')
    expect(wrote(fake.calls)).toBe(true)
  })

  it('bans over a lifted ban, clearing the lift, when the event is a new one', async () => {
    const fake = fakeDocument(holding(LIFTED_BAN))
    const ddb = createDdb({ document: fake.doc, now: () => 3_000 })

    const result = await ddb.bans.issue({ ...ISSUE, entryId: 'a-second-event' })

    expect(result.ok && result.value.outcome).toBe('issued')
    expect(writtenRow(fake.calls)).toMatchObject({
      at: 3_000,
      liftedAt: null,
      liftedBy: null,
      liftedByName: null,
      liftReason: null,
      discordEntryId: 'a-second-event',
    })
  })

  /**
   * THE TEST THIS WHOLE PATH EXISTS FOR.
   *
   * The bot bans somebody; an admin looks at it and lifts it; Discord's
   * gateway redelivers the SAME audit log entry after a reconnect. A write
   * that asked "is this person banned" would answer no — they were just
   * unbanned — and ban them again over the admin's decision, with the
   * console's unconditional PutItem clearing `liftedAt` and taking the record
   * of who let them back in with it.
   *
   * Asking "have I already acted on this event" answers yes, and the lift
   * stands. Which is why the entry id is checked BEFORE the ban's state and
   * not after.
   */
  it('never re-bans on a replay of the event that produced the ban, lifted or not', async () => {
    const replayed: Ban = { ...LIFTED_BAN, discordEntryId: ENTRY }
    const fake = fakeDocument(holding(replayed))
    const ddb = createDdb({ document: fake.doc, now: () => 3_000 })

    const result = await ddb.bans.issue(ISSUE)

    expect(result).toEqual({ ok: true, value: { outcome: 'duplicate-event', ban: replayed } })
    expect(wrote(fake.calls)).toBe(false)
  })

  /**
   * The same replay while the ban is still in force. It is reported as the
   * duplicate it is rather than as `already-banned`, because those are two
   * different sentences: one is "you already did this", the other is
   * "somebody else did".
   */
  it('reports a replay as a duplicate event and not as an already-banned player', async () => {
    const fake = fakeDocument(holding({ ...CONSOLE_BAN, discordEntryId: ENTRY }))
    const ddb = createDdb({ document: fake.doc, now: () => 2_000 })

    const result = await ddb.bans.issue(ISSUE)

    expect(result.ok && result.value.outcome).toBe('duplicate-event')
    expect(wrote(fake.calls)).toBe(false)
  })

  it('treats a different entry id on the row as a different event', async () => {
    const fake = fakeDocument(holding({ ...LIFTED_BAN, discordEntryId: 'an-older-event' }))
    const ddb = createDdb({ document: fake.doc, now: () => 3_000 })

    const result = await ddb.bans.issue(ISSUE)

    expect(result.ok && result.value.outcome).toBe('issued')
  })

  /**
   * THE GUARD IS ON THE ROW WE READ, not on a re-derivation of `isBanActive`
   * in DynamoDB's expression language — which is where the console's rule and
   * the bot's would quietly stop agreeing. `at` is the value we saw; anything
   * that changes the row in the gap between the read and the write fails the
   * condition instead of being overwritten.
   */
  it('guards the write on the exact row it read', async () => {
    const fake = fakeDocument(holding(LIFTED_BAN))
    const ddb = createDdb({ document: fake.doc, now: () => 3_000 })

    await ddb.bans.issue({ ...ISSUE, entryId: 'a-second-event' })

    const put = fake.calls.find((call) => call.op === 'put')?.input as PutCommandInput
    expect(put.ConditionExpression).toBe('at = :seenAt')
    expect(put.ExpressionAttributeValues).toEqual({ ':seenAt': 1_000 })
  })

  /** No row read means the row to guard against is the one that appeared since. */
  it('guards a first ban with create-do-not-replace', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.bans.issue(ISSUE)

    const put = fake.calls.find((call) => call.op === 'put')?.input as PutCommandInput
    expect(put.ConditionExpression).toBe('attribute_not_exists(license)')
    expect(put.ExpressionAttributeValues).toBeUndefined()
  })

  it('reports a row that changed underneath it as a conflict, having written nothing', async () => {
    const fake = fakeDocument({
      ...holding(LIFTED_BAN),
      put: async () => {
        throw awsError('ConditionalCheckFailedException')
      },
    })
    const ddb = createDdb({ document: fake.doc, now: () => 3_000 })

    const result = await ddb.bans.issue({ ...ISSUE, entryId: 'a-second-event' })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure.kind).toBe('conflict')
    expect(!result.ok && result.failure.table).toBe('ringmaster-bans')
  })

  /**
   * A READ THAT FAILED IS NOT A ROW THAT IS ABSENT. Writing anyway would ban
   * over whatever is actually there, which is the un-lift failure again by
   * another route.
   */
  it('never writes blind when the read it decides from failed', async () => {
    const fake = fakeDocument({
      get: async () => {
        throw awsError('AccessDeniedException')
      },
    })
    const ddb = createDdb({ document: fake.doc })

    const result = await ddb.bans.issue(ISSUE)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure.kind).toBe('denied')
    expect(wrote(fake.calls)).toBe(false)
  })
})

describe('lifting a ban', () => {
  const LIFT = { id: LICENSE, by: 'license:admin2', byName: 'Admin Two', reason: 'appealed' }

  /**
   * A BAN IS A RECORD, NOT A DELETION — lib/bans.ts's own rule. The row stays
   * where it is and gains four fields, and the module could not delete it if
   * something asked: `DocumentClient` has no `delete` on it at all.
   */
  it('stamps the lifted fields with an update, and removes nothing', async () => {
    const fake = fakeDocument(holding(CONSOLE_BAN))
    const ddb = createDdb({ document: fake.doc, now: () => 4_000 })

    await ddb.bans.lift(LIFT)

    expect(fake.calls.map((call) => call.op)).toEqual(['get', 'update'])

    const update = fake.calls[1]?.input as UpdateCommandInput
    expect(update.TableName).toBe('ringmaster-bans')
    expect(update.Key).toEqual({ license: LICENSE })
    expect(update.UpdateExpression).toBe(
      'SET liftedAt = :t, liftedBy = :b, liftedByName = :n, liftReason = :r',
    )
    expect(update.ExpressionAttributeValues).toMatchObject({
      ':t': 4_000,
      ':b': 'license:admin2',
      ':n': 'Admin Two',
      ':r': 'appealed',
    })
  })

  it('returns the row as it now stands, without reading it back', async () => {
    const fake = fakeDocument(holding(CONSOLE_BAN))
    const ddb = createDdb({ document: fake.doc, now: () => 4_000 })

    const result = await ddb.bans.lift(LIFT)

    expect(result).toEqual({
      ok: true,
      value: {
        outcome: 'lifted',
        ban: {
          ...CONSOLE_BAN,
          liftedAt: 4_000,
          liftedBy: 'license:admin2',
          liftedByName: 'Admin Two',
          liftReason: 'appealed',
        },
      },
    })
    expect(fake.calls.filter((call) => call.op === 'get')).toHaveLength(1)
  })

  it('writes a missing reason as null rather than leaving the field off', async () => {
    const fake = fakeDocument(holding(CONSOLE_BAN))
    const ddb = createDdb({ document: fake.doc, now: () => 4_000 })

    await ddb.bans.lift({ id: LICENSE, by: null, byName: 'Blitz' })

    const update = fake.calls[1]?.input as UpdateCommandInput
    expect(update.ExpressionAttributeValues?.[':r']).toBeNull()
    expect(update.ExpressionAttributeValues?.[':b']).toBeNull()
  })

  /**
   * TWO CONDITIONS IN ONE, AND THE SECOND HAS TO BE SPELLED TWICE.
   *
   * `attribute_exists(license)` is the console's, verbatim, and it is there
   * because `UpdateItem` against a missing key CREATES one — a lift of a ban
   * nobody issued would otherwise leave a row that reads forever after as
   * though somebody had been banned.
   *
   * The rest is "still not lifted", which needs both spellings because there
   * are two: the console writes `liftedAt: null` explicitly on every ban it
   * issues, so on those rows the attribute EXISTS and is null, while an older
   * or hand-written row may not carry it at all. A condition testing only
   * `attribute_not_exists` would refuse to lift any ban the console ever
   * issued.
   */
  it('conditions on the ban existing and on nobody having lifted it first', async () => {
    const fake = fakeDocument(holding(CONSOLE_BAN))
    const ddb = createDdb({ document: fake.doc, now: () => 4_000 })

    await ddb.bans.lift(LIFT)

    const update = fake.calls[1]?.input as UpdateCommandInput
    expect(update.ConditionExpression).toBe(
      'attribute_exists(license) AND (attribute_not_exists(liftedAt) OR liftedAt = :unlifted)',
    )
    expect(update.ExpressionAttributeValues?.[':unlifted']).toBeNull()
  })

  it('reports a ban that was never there, without writing a lift for it', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    const result = await ddb.bans.lift(LIFT)

    expect(result).toEqual({ ok: true, value: { outcome: 'no-ban', ban: null } })
    expect(wrote(fake.calls)).toBe(false)
  })

  /**
   * A REDELIVERED UNBAN MUST NOT REPLACE THE FIRST LIFTER. Writing the lift
   * again would put this call's admin and reason on the row in place of the
   * ones already there — the same erasure as un-lifting a ban, just quieter,
   * on the field that answers "who let them back in".
   */
  it('leaves an already-lifted ban completely alone, first lifter and all', async () => {
    const fake = fakeDocument(holding(LIFTED_BAN))
    const ddb = createDdb({ document: fake.doc, now: () => 4_000 })

    const result = await ddb.bans.lift(LIFT)

    expect(result).toEqual({ ok: true, value: { outcome: 'already-lifted', ban: LIFTED_BAN } })
    expect(wrote(fake.calls)).toBe(false)
  })

  it('reports a lift that lost the race as a conflict', async () => {
    const fake = fakeDocument({
      ...holding(CONSOLE_BAN),
      update: async () => {
        throw awsError('ConditionalCheckFailedException')
      },
    })
    const ddb = createDdb({ document: fake.doc, now: () => 4_000 })

    const result = await ddb.bans.lift(LIFT)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure.kind).toBe('conflict')
    expect(!result.ok && result.failure.op).toBe('update')
  })

  it('never writes blind when the read it decides from failed', async () => {
    const fake = fakeDocument({
      get: async () => {
        throw awsError('ResourceNotFoundException')
      },
    })
    const ddb = createDdb({ document: fake.doc })

    const result = await ddb.bans.lift(LIFT)

    expect(result.ok).toBe(false)
    expect(wrote(fake.calls)).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * The audit log. The reason this module is not a copy of the console's.
 * ------------------------------------------------------------------ */

/**
 * `AuditRow` AS fivem-ringmaster/src/lib/audit.ts DECLARES IT, transcribed by
 * hand and deliberately not imported — the console is a different repo and CI
 * checks out this one alone.
 *
 * WHAT THIS ACTUALLY CATCHES. `toConsoleRow` and `toModuleRow` below are plain
 * assignments between this interface and the module's own `AuditRow`, checked
 * by `tsc` in BOTH directions: a field renamed, dropped, retyped or made
 * optional on one side and not the other stops `npm run typecheck` with the
 * field named. The runtime assertions that follow catch the other half — a row
 * whose type is right and whose written attributes are not.
 *
 * NEITHER OF THEM MAY BE A CAST. `row as ConsoleAuditRow` type-checks against
 * anything and would leave this whole section asserting nothing, which is
 * exactly what it did in its first draft.
 *
 * IT CANNOT CATCH THE CONSOLE CHANGING ITS OWN SHAPE. Nothing in this repo
 * can. What it does is make the copy here impossible to drift from silently,
 * which leaves exactly one thing to keep an eye on rather than two.
 */
interface ConsoleAuditRow {
  pk: string
  ts: number
  commandId: string
  action: AuditAction
  outcome: AuditOutcome
  actorLicense: string | null
  actorName: string
  actorDiscordId: string | null
  targetLicense?: string | null
  targetName?: string | null
  reason?: string | null
  resolvedAt?: number
  error?: string | null
  detail?: Record<string, string | number | boolean | null>
}

/**
 * The two directions, as assignments rather than casts. `tsc` checks these
 * whether or not a test ever calls them; the test below calls them so that
 * lint does not remove an unused binding and take the check with it.
 */
const toConsoleRow: (row: AuditRow) => ConsoleAuditRow = (row) => row
const toModuleRow: (row: ConsoleAuditRow) => AuditRow = (row) => row

/** The Item an audit put actually sent, or a failure naming what happened. */
function writtenRow(calls: Recorded[]): Record<string, unknown> {
  const put = calls.find((call) => call.op === 'put')
  if (!put) throw new Error('no put was made')
  const item = (put.input as PutCommandInput).Item
  if (!item) throw new Error('the put carried no Item')
  return item
}

describe('the audit row', () => {
  /**
   * THE ASSERTION IS THE TYPECHECK AND NOT THE `expect`. If `AuditRow` and the
   * console's shape stop agreeing, this file stops compiling; the round trip
   * below is here so the two conversions are used rather than pruned.
   */
  it("is the console's row, both ways round", () => {
    const row: AuditRow = {
      pk: 'AUDIT',
      ts: 1_700_000_000_000,
      commandId: 'command-1',
      action: 'ban.issue',
      outcome: 'pending',
      actorLicense: 'license:admin1',
      actorName: 'Admin One',
      actorDiscordId: '280000000000000000',
    }

    expect(toModuleRow(toConsoleRow(row))).toEqual(row)
  })

  it("writes the console's fields, with the console's values", async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc, now: () => 1_700_000_000_000 })

    await ddb.audit.begin({
      action: 'player.kick',
      actor: ACTOR,
      targetLicense: LICENSE,
      targetName: 'Someone',
      reason: 'being a nuisance',
      detail: { via: 'discord' },
    })

    const row = writtenRow(fake.calls)

    expect(row).toEqual({
      pk: 'AUDIT',
      ts: 1_700_000_000_000,
      commandId: expect.any(String),
      action: 'player.kick',
      outcome: 'pending',
      actorLicense: 'license:admin1',
      actorName: 'Admin One',
      actorDiscordId: '280000000000000000',
      targetLicense: LICENSE,
      targetName: 'Someone',
      reason: 'being a nuisance',
      detail: { via: 'discord' },
    })
  })

  it('nulls the fields an action did not carry rather than omitting them', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.audit.begin({ action: 'ban.lift', actor: ACTOR })

    const row = writtenRow(fake.calls)
    expect(row.targetLicense).toBeNull()
    expect(row.targetName).toBeNull()
    expect(row.reason).toBeNull()
  })

  /**
   * THE WHOLE LOG IS ONE PARTITION, ordered by `ts`, so "the last fifty
   * actions" is one query. It is also why two writers collide — see below.
   */
  it('lands in the one partition the console reads', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.audit.begin({ action: 'player.kick', actor: ACTOR })

    expect(writtenRow(fake.calls).pk).toBe('AUDIT')
    expect(fake.calls[0]?.table).toBe('ringmaster-audit')
  })

  it('returns both halves of the key it wrote, plus the id it minted', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc, now: () => 1_700_000_000_000 })

    const result = await ddb.audit.begin({ action: 'player.kick', actor: ACTOR })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ts).toBe(1_700_000_000_000)
    expect(result.value.commandId).toBe(writtenRow(fake.calls).commandId)
  })
})

describe('the audit log has a second writer', () => {
  /**
   * THE FAILURE THIS EXISTS FOR. `pk` + `ts` is the entire primary key, so a
   * `PutItem` at a key that already exists REPLACES what was there — silently,
   * on an append-only log. The console's own counter can only order the rows
   * one PROCESS writes; the bot is a second process writing to the same
   * partition from the same box.
   */
  it('never puts a row without the condition that stops it clobbering one', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.audit.begin({ action: 'player.kick', actor: ACTOR })

    const put = fake.calls[0]?.input as PutCommandInput
    expect(put.ConditionExpression).toBe('attribute_not_exists(pk)')
  })

  it('steps forward over a taken millisecond instead of overwriting it', async () => {
    let attempts = 0
    const fake = fakeDocument({
      put: async () => {
        attempts += 1
        // The first key is taken — by the console, in the same millisecond.
        if (attempts === 1) throw awsError('ConditionalCheckFailedException')
        return META
      },
    })
    // A clock that does not move, so the retry cannot succeed by waiting.
    const ddb = createDdb({ document: fake.doc, now: () => 1_700_000_000_000 })

    const result = await ddb.audit.begin({ action: 'player.kick', actor: ACTOR })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ts).toBe(1_700_000_000_001)
    expect(fake.calls).toHaveLength(2)
  })

  it('keeps one command id across the retries, because it is one action', async () => {
    let attempts = 0
    const fake = fakeDocument({
      put: async () => {
        attempts += 1
        if (attempts === 1) throw awsError('ConditionalCheckFailedException')
        return META
      },
    })
    const ddb = createDdb({ document: fake.doc, now: () => 1_700_000_000_000 })

    await ddb.audit.begin({ action: 'player.kick', actor: ACTOR })

    const ids = fake.calls.map((call) => (call.input as PutCommandInput).Item?.commandId)
    expect(ids[0]).toBe(ids[1])
  })

  /**
   * BOUNDED, AND THE END OF IT IS A REFUSAL. Something is writing to this
   * partition faster than we can step around it; acting without a record is
   * not the fallback, so the failure travels and the caller must not proceed.
   */
  it('gives up after a bounded number of attempts rather than looping', async () => {
    const fake = fakeDocument({
      put: async () => {
        throw awsError('ConditionalCheckFailedException')
      },
    })
    const ddb = createDdb({ document: fake.doc, now: () => 1_700_000_000_000 })

    const result = await ddb.audit.begin({ action: 'player.kick', actor: ACTOR })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('conflict')
    expect(fake.calls.length).toBeGreaterThan(1)
    expect(fake.calls.length).toBeLessThanOrEqual(4)
  })

  it('does not retry a failure that retrying cannot fix', async () => {
    const fake = fakeDocument({
      put: async () => {
        throw awsError('ResourceNotFoundException')
      },
    })
    const ddb = createDdb({ document: fake.doc })

    const result = await ddb.audit.begin({ action: 'player.kick', actor: ACTOR })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('no-such-table')
    expect(fake.calls).toHaveLength(1)
  })

  /**
   * Two of the bot's own rows in one millisecond are the case the console's
   * counter handles and this one must handle too: the second lands a
   * millisecond late rather than on top of the first.
   */
  it('breaks its own same-millisecond ties forward', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc, now: () => 1_700_000_000_000 })

    const first = await ddb.audit.begin({ action: 'player.kick', actor: ACTOR })
    const second = await ddb.audit.begin({ action: 'player.kick', actor: ACTOR })

    expect(first.ok && first.value.ts).toBe(1_700_000_000_000)
    expect(second.ok && second.value.ts).toBe(1_700_000_000_001)
  })
})

describe('stamping an outcome', () => {
  it('updates the row by both halves of its key', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc, now: () => 1_700_000_000_500 })

    const handle: AuditHandle = { commandId: 'command-1', ts: 1_700_000_000_000 }
    const result = await ddb.audit.resolve(handle, 'ok')

    expect(result.ok).toBe(true)
    expect(fake.calls[0]?.input).toMatchObject({
      TableName: 'ringmaster-audit',
      Key: { pk: 'AUDIT', ts: 1_700_000_000_000 },
    })
  })

  /**
   * `error` IS A RESERVED WORD IN DynamoDB. Without the alias the update is a
   * syntax error at runtime and nowhere earlier — and it would only ever be
   * reached on the failure path, which is the worst place to discover it.
   */
  it('aliases the reserved word and sets the three outcome fields', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc, now: () => 1_700_000_000_500 })

    await ddb.audit.resolve({ commandId: 'command-1', ts: 1 }, 'failed', 'the host refused')

    const update = fake.calls[0]?.input as UpdateCommandInput
    expect(update.UpdateExpression).toBe('SET outcome = :o, resolvedAt = :r, #e = :e')
    expect(update.ExpressionAttributeNames).toEqual({ '#e': 'error' })
    expect(update.ExpressionAttributeValues).toMatchObject({
      ':o': 'failed',
      ':r': 1_700_000_000_500,
      ':e': 'the host refused',
    })
  })

  it('records no error at all when there was none', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.audit.resolve({ commandId: 'command-1', ts: 1 }, 'ok')

    const update = fake.calls[0]?.input as UpdateCommandInput
    expect(update.ExpressionAttributeValues?.[':e']).toBeNull()
  })

  /**
   * THE OTHER HALF OF THE SECOND-WRITER PROBLEM. A console write can have
   * replaced our intent row at that millisecond — the console's put is
   * unconditional and cannot be fixed from this repo. Addressing the update by
   * `ts` alone would then stamp our outcome onto SOMEBODY ELSE'S row, which is
   * this module corrupting the log it is trying to keep. Conditioning on the
   * id we minted means the update applies to our row or to nothing.
   *
   * It closes the upsert at the same time: an `UpdateItem` at a key that does
   * not exist CREATES it, so a lost intent row would otherwise become a
   * half-row holding an outcome and no action.
   */
  it('refuses to stamp a row that is not the one it wrote', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    await ddb.audit.resolve({ commandId: 'command-1', ts: 1 }, 'ok')

    const update = fake.calls[0]?.input as UpdateCommandInput
    expect(update.ConditionExpression).toBe('commandId = :c')
    expect(update.ExpressionAttributeValues?.[':c']).toBe('command-1')
  })

  /**
   * AND WHEN IT HAPPENS, IT IS A FINDING RATHER THAN A CRASH. The caller logs
   * it and carries on — the action itself already happened, and a row stuck at
   * `pending` is the honest record of a bookkeeping failure.
   */
  it('reports a vanished intent row as a conflict', async () => {
    const ddb = createDdb({
      document: failingDocument(awsError('ConditionalCheckFailedException')),
    })

    const result = await ddb.audit.resolve({ commandId: 'command-1', ts: 1 }, 'ok')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('conflict')
  })
})

describe('what the bot may do to these tables', () => {
  /**
   * THE ACCESS POLICY, ASSERTED. Three tables are written and the list is
   * short enough to read: the audit log the bot appends to, the bot's own
   * state, and — since blitz-bot#16 — the ban table. A future accessor that
   * writes to a fourth fails here before it reaches a review.
   *
   * `ringmaster-bans` WAS ON THE OTHER SIDE OF THIS ASSERTION UNTIL #16, and
   * the line moving is the whole of what that change did to the bot's reach
   * into AWS. It is asserted rather than described so that the next widening
   * is also a visible edit to a test rather than a quiet extra call.
   */
  it('writes to the audit log, its own state and the ban table, and nothing else', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    for (const exercise of EXERCISES) await exercise.run(ddb)

    const written = new Set(
      fake.calls.filter((call) => call.op === 'put' || call.op === 'update').map((c) => c.table),
    )

    expect([...written].sort()).toEqual([
      'ringmaster-audit',
      'ringmaster-bans',
      'ringmaster-bot-state',
    ])
  })

  it('reads the seven it is pointed at, and no others', async () => {
    const fake = fakeDocument()
    const ddb = createDdb({ document: fake.doc })

    for (const exercise of EXERCISES) await exercise.run(ddb)

    const read = new Set(
      fake.calls.filter((call) => call.op === 'get' || call.op === 'query').map((c) => c.table),
    )

    expect([...read].sort()).toEqual([
      'br-players',
      'ringmaster-audit',
      'ringmaster-bans',
      'ringmaster-bot-state',
      'ringmaster-maintenance',
      'ringmaster-player-ids',
      'ringmaster-players',
    ])
  })
})

describe('the module talks to DynamoDB and to nothing else', () => {
  const source = readFileSync(new URL('./ddb.ts', import.meta.url), 'utf8')

  /**
   * THE STANDING RULE THIS PINS: the bot never calls the Ringmaster service.
   * It reads the console's DATA, so a console that is down, redeploying or
   * mid-migration costs the bot nothing — and the bot cannot take the console
   * down by asking it questions. An import list is where that stops being an
   * intention.
   */
  it('imports the AWS SDK and node:crypto, and nothing else', () => {
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])

    expect(specifiers.length).toBeGreaterThan(0)
    expect([...new Set(specifiers)].sort()).toEqual([
      '@aws-sdk/client-dynamodb',
      '@aws-sdk/lib-dynamodb',
      'node:crypto',
    ])
  })

  it('has no dynamic import or require to smuggle one in', () => {
    expect(source).not.toMatch(/\brequire\s*\(/)
    expect(source).not.toMatch(/\bimport\s*\(/)
  })

  it('names no URL and calls no fetch', () => {
    expect(source).not.toContain('http://')
    expect(source).not.toContain('https://')
    expect(source).not.toMatch(/\bfetch\s*\(/)
  })
})

/* ------------------------------------------------------------------ *
 * The rules copied from the console, which must not drift.
 * ------------------------------------------------------------------ */

const BAN: Ban = {
  license: LICENSE,
  at: 1_000,
  by: 'license:admin1',
  byName: 'Admin One',
  reason: 'cheating',
  expiresAt: null,
}

describe('whether a ban is in force', () => {
  it('holds a permanent ban forever', () => {
    expect(isBanActive(BAN, 9_999_999)).toBe(true)
  })

  it('treats a lift as final, whatever the expiry says', () => {
    expect(isBanActive({ ...BAN, liftedAt: 2_000 }, 3_000)).toBe(false)
  })

  it('treats an expiry in the past as served', () => {
    expect(isBanActive({ ...BAN, expiresAt: 2_000 }, 2_000)).toBe(false)
    expect(isBanActive({ ...BAN, expiresAt: 2_001 }, 2_000)).toBe(true)
  })
})

const WINDOW: MaintenanceWindow = {
  id: 'w1',
  state: 'scheduled',
  createdAt: 1_000,
  createdByName: 'Admin One',
  note: 'patching',
  drainStartsAt: 5_000,
  deployMode: 'when-empty',
  deployAt: null,
}

describe('whether maintenance governs the server', () => {
  it('counts the three live states and no others', () => {
    expect(isMaintenanceLive(WINDOW)).toBe(true)
    expect(isMaintenanceLive({ ...WINDOW, state: 'draining' })).toBe(true)
    expect(isMaintenanceLive({ ...WINDOW, state: 'deploying' })).toBe(true)
    expect(isMaintenanceLive({ ...WINDOW, state: 'complete' })).toBe(false)
    expect(isMaintenanceLive({ ...WINDOW, state: 'cancelled' })).toBe(false)
    expect(isMaintenanceLive(null)).toBe(false)
  })

  /**
   * DERIVED FROM THE CLOCK, NOT FROM THE STORED STATE. A console that was
   * asleep when `drainStartsAt` passed leaves a `scheduled` row behind, and a
   * bot reading the state alone would tell people the server is still open.
   */
  it('is draining once the drain time has passed, whatever the row still says', () => {
    expect(isMaintenanceDraining(WINDOW, 4_999)).toBe(false)
    expect(isMaintenanceDraining(WINDOW, 5_000)).toBe(true)
  })

  it('is draining throughout a deploy, whatever the clock says', () => {
    expect(isMaintenanceDraining({ ...WINDOW, state: 'deploying' }, 0)).toBe(true)
  })

  it('is not draining once the window is over', () => {
    expect(isMaintenanceDraining({ ...WINDOW, state: 'complete' }, 9_999)).toBe(false)
    expect(isMaintenanceDraining(null, 9_999)).toBe(false)
  })
})

describe('qualifying an identifier', () => {
  it('puts the kind in front of the value, the way the index stores it', () => {
    expect(qualifyId('discord', '280')).toBe('discord:280')
    expect(qualifyId('steam', '110000')).toBe('steam:110000')
  })
})
