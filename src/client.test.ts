import { readFile } from 'node:fs/promises'

import {
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Partials,
  RESTJSONErrorCodes,
  type Client,
  type Message,
  type OmitPartialGroupDMChannel,
} from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  createClient,
  decide,
  handleLive,
  handleMessage,
  inviteResolver,
  remover,
  scanText,
  type Actions,
  type AttachmentText,
  type ComponentText,
  type EmbedText,
  type LiveActions,
  type LiveGuild,
  type LiveMember,
  type LiveMessage,
  type PollText,
  type RoleLookup,
  type ScannableMessage,
  type ScannableParts,
  type ScannedMessage,
  type StickerText,
} from './client.ts'
import type { Config } from './config.ts'
import { findInviteCodes, type InviteResolver } from './invites.ts'

/**
 * The decision, and what gets done about it.
 *
 * NOTHING HERE TOUCHES DISCORD. `decide` takes a plain record and a resolver,
 * `handleMessage` takes its delete and its post as arguments, and `handleLive`
 * takes a structural message and an injected resolver — so every branch,
 * including the ones that only happen when Discord is broken, runs against
 * objects defined a few lines above their assertions. That split is the reason
 * this file can exist at all; see the header of client.ts.
 *
 * THE DRY-RUN CASES ARE THE POINT OF THE FILE. This bot deletes messages in a
 * live community, and `BLITZ_DRY_RUN` is the switch the owner will be trusting
 * while deciding whether to let it. A test that only checks the happy path
 * would pass just as well against a build that deletes in dry run.
 *
 * THE REGRESSION CASES ARE MARKED AS SUCH. Several of the describes below exist
 * because a review found the bot deleting the wrong thing, or failing to look
 * at the right thing, and each of those has a comment saying what the bug was.
 * They are not tidy-ups; deleting one puts the bug back.
 */

const OURS = '111111111111111111'
const THEIRS = '222222222222222222'
const ADMIN_ROLE = '333333333333333333'
const AUTHOR = '444444444444444444'
const CHANNEL = '555555555555555555'
const LOG_CHANNEL = '666666666666666666'
const WEBHOOK = '777777777777777777'
const OTHER_GUILD = '888888888888888888'

function cfg(over: Partial<Config> = {}): Config {
  return {
    discordToken: 'token',
    guildId: OURS,
    adminRoleId: null,
    logChannelId: null,
    exemptChannelIds: [],
    exemptAdmins: true,
    dryRun: false,
    ...over,
  }
}

function msg(over: Partial<ScannedMessage> = {}): ScannedMessage {
  return {
    text: 'join us at discord.gg/abc123',
    authorId: AUTHOR,
    channelId: CHANNEL,
    guildId: OURS,
    webhookId: null,
    fromSelf: false,
    authorRoleIds: [],
    ...over,
  }
}

/** Every code belongs to somebody else. The ordinary spam case. */
const foreignResolver: InviteResolver = () => Promise.resolve(THEIRS)

/** Nothing resolves — an expired invite, or a Discord that is not answering. */
const deadResolver: InviteResolver = () => Promise.resolve(null)

/** A message carrying `count` distinct invite codes, `code0` upwards. */
function manyCodes(count: number): string {
  return Array.from({ length: count }, (_, i) => `discord.gg/code${i}`).join(' ')
}

/**
 * THE BYPASS, WRITTEN OUT. Ten codes that resolve to nothing, and then the real
 * advert as the eleventh — one past the point where the scan stops looking.
 */
function paddedWith(real: string): string {
  return `${manyCodes(10)} discord.gg/${real}`
}

/** Only the padded-out eleventh code belongs to another guild. */
const onlyRealIsForeign: InviteResolver = (code) =>
  Promise.resolve(code === 'real' ? THEIRS : null)

/**
 * Warn and error lines go to stderr, and several assertions below depend on
 * one having been written: a swallowed failure that leaves no trace is exactly
 * the fault the logging in client.ts exists to prevent, and without these it
 * could be deleted without a test noticing.
 */
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
})

describe('decide — messages that are never scanned at all', () => {
  it('skips its own messages', async () => {
    const verdict = await decide(msg({ fromSelf: true }), cfg(), foreignResolver)
    expect(verdict).toEqual({ action: 'skip', why: 'own-message' })
  })

  it('skips direct messages', async () => {
    const verdict = await decide(msg({ guildId: null }), cfg(), foreignResolver)
    expect(verdict).toEqual({ action: 'skip', why: 'direct-message' })
  })

  it('skips exempt channels', async () => {
    const config = cfg({ exemptChannelIds: ['999', CHANNEL] })
    expect(await decide(msg(), config, foreignResolver)).toEqual({
      action: 'skip',
      why: 'exempt-channel',
    })
  })

  it('scans a channel that is not on the exempt list', async () => {
    const config = cfg({ exemptChannelIds: ['999'] })
    expect(await decide(msg(), config, foreignResolver)).toMatchObject({ action: 'delete' })
  })

  it('skips a holder of the admin role', async () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const verdict = await decide(msg({ authorRoleIds: ['x', ADMIN_ROLE] }), config, foreignResolver)
    expect(verdict).toEqual({ action: 'skip', why: 'exempt-admin' })
  })

  it('scans an admin when the exemption is switched off', async () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: false })
    const verdict = await decide(msg({ authorRoleIds: [ADMIN_ROLE] }), config, foreignResolver)
    expect(verdict).toMatchObject({ action: 'delete' })
  })

  it('scans everyone when no admin role is configured, exemption on or not', async () => {
    // What .env.example promises: an unset DISCORD_ADMIN_ROLE_ID disables the
    // exemption rather than exempting everybody or nobody by accident.
    const config = cfg({ adminRoleId: null, exemptAdmins: true })
    const verdict = await decide(msg({ authorRoleIds: [ADMIN_ROLE] }), config, foreignResolver)
    expect(verdict).toMatchObject({ action: 'delete' })
  })

  it('asks about an author whose roles the payload did not carry, and exempts a real admin', async () => {
    // Unknown roles is not "no roles" — but it is not a reason to stop looking
    // at the message either. It is a reason to go and find out.
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const fetchRoles = vi.fn<RoleLookup>(rolesOf(ADMIN_ROLE))

    const verdict = await decide(msg({ authorRoleIds: null }), config, foreignResolver, fetchRoles)

    expect(fetchRoles).toHaveBeenCalledWith(AUTHOR)
    expect(verdict).toEqual({ action: 'skip', why: 'exempt-admin' })
  })

  it('scans an author whose roles could not be read when no exemption applies', async () => {
    // With nothing to exempt them from, unreadable roles are simply irrelevant,
    // and the ambiguity must not turn into a blanket amnesty.
    const config = cfg({ adminRoleId: null, exemptAdmins: true })
    const verdict = await decide(msg({ authorRoleIds: null }), config, foreignResolver)
    expect(verdict).toMatchObject({ action: 'delete' })
  })

  it('never resolves an invite for a message it skips', async () => {
    // A rate-limit property as much as a correctness one: a spam wave in an
    // exempt channel — or in a guild we do not moderate — must not cost one
    // Discord lookup per code.
    const resolve = vi.fn(foreignResolver)
    const config = cfg({ exemptChannelIds: [CHANNEL] })

    await decide(msg(), config, resolve)
    await decide(msg({ fromSelf: true }), cfg(), resolve)
    await decide(msg({ guildId: null }), cfg(), resolve)
    await decide(msg({ guildId: OTHER_GUILD }), cfg(), resolve)

    expect(resolve).not.toHaveBeenCalled()
  })
})

/**
 * REGRESSION. The bot moderated every guild it was in.
 *
 * The only question `decide` asked about origin was "is this a DM", and
 * `config.guildId` was then used as the yardstick for "ours". So in any other
 * server the bot happened to be in — a test server, a friend's, one it was
 * added to years ago — that server's OWN invite resolved to a guild that was
 * not `config.guildId`, came back foreign, and was deleted.
 */
describe('decide — only the one guild we were configured for', () => {
  it("leaves another server's own invite alone instead of deleting it", async () => {
    const theirOwnInvite: InviteResolver = () => Promise.resolve(OTHER_GUILD)
    const verdict = await decide(msg({ guildId: OTHER_GUILD }), cfg(), theirOwnInvite)

    expect(verdict).toEqual({ action: 'skip', why: 'other-guild' })
  })

  it('skips a foreign guild before any exemption or scan can run', async () => {
    // Above the channel and admin checks as well as above the scan: the answer
    // must not depend on how that guild's channels or roles happen to be set up.
    const resolve = vi.fn(foreignResolver)
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptChannelIds: [CHANNEL] })

    const verdict = await decide(
      msg({ guildId: OTHER_GUILD, authorRoleIds: null, webhookId: WEBHOOK }),
      config,
      resolve,
    )

    expect(verdict).toEqual({ action: 'skip', why: 'other-guild' })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('still scans the guild it was configured for', async () => {
    expect(await decide(msg({ guildId: OURS }), cfg(), foreignResolver)).toMatchObject({
      action: 'delete',
    })
  })
})

/**
 * REGRESSION. Webhook posts stopped being scanned the moment
 * DISCORD_ADMIN_ROLE_ID was set.
 *
 * A webhook has no member object — discord.js resolves `message.member` as
 * `guild.members.resolve(author)`, and a webhook is not a member — so its roles
 * read as null, and "unreadable roles skip" swallowed every one of them.
 * Anybody with Manage Webhooks had a permanent bypass.
 */
describe('decide — a webhook is always scanned', () => {
  it('scans a webhook post while the admin exemption is live', async () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const verdict = await decide(msg({ webhookId: WEBHOOK, authorRoleIds: null }), config, foreignResolver)

    expect(verdict).toMatchObject({ action: 'delete' })
  })

  it('does not let a webhook hold the admin role', async () => {
    // A webhook cannot have roles at all, so a role list on one is not a reason
    // to exempt it — it is a reason to distrust the role list.
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const verdict = await decide(
      msg({ webhookId: WEBHOOK, authorRoleIds: [ADMIN_ROLE] }),
      config,
      foreignResolver,
    )

    expect(verdict).toMatchObject({ action: 'delete' })
  })

  it('never asks who a webhook is, because a webhook is nobody', async () => {
    // The exemption is live and the roles are null, which for a member means
    // "go and fetch one". A webhook has no member to fetch, so asking would be
    // a REST call per webhook post that can only ever come back empty-handed.
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const fetchRoles = vi.fn<RoleLookup>(cannotAsk)

    const verdict = await decide(
      msg({ webhookId: WEBHOOK, authorRoleIds: null }),
      config,
      foreignResolver,
      fetchRoles,
    )

    expect(fetchRoles).not.toHaveBeenCalled()
    expect(verdict).toMatchObject({ action: 'delete' })
  })

  it('still asks about an ordinary member whose roles could not be read', async () => {
    // The webhook case must not be implemented by dropping the rule it is an
    // exception to: an admin whose member object did not arrive is looked up,
    // and is still exempt once the answer comes back.
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const verdict = await decide(
      msg({ webhookId: null, authorRoleIds: null }),
      config,
      foreignResolver,
      rolesOf(ADMIN_ROLE),
    )

    expect(verdict).toEqual({ action: 'skip', why: 'exempt-admin' })
  })
})

describe('decide — what the scan concludes', () => {
  it('deletes a message carrying an invite to somebody else', async () => {
    expect(await decide(msg(), cfg(), foreignResolver)).toEqual({
      action: 'delete',
      why: 'foreign-invite',
      found: 1,
      foreign: ['abc123'],
      unresolved: [],
    })
  })

  it('leaves an invite to our own guild alone', async () => {
    const ourInvite: InviteResolver = () => Promise.resolve(OURS)
    expect(await decide(msg(), cfg(), ourInvite)).toEqual({
      action: 'leave',
      codes: ['abc123'],
      unresolved: [],
    })
  })

  it('leaves a message whose codes do not resolve, and says which', async () => {
    expect(await decide(msg(), cfg(), deadResolver)).toEqual({
      action: 'leave',
      codes: ['abc123'],
      unresolved: ['abc123'],
    })
  })

  it('leaves a message with no invites in it', async () => {
    const verdict = await decide(msg({ text: 'good game everyone' }), cfg(), foreignResolver)
    expect(verdict).toEqual({ action: 'leave', codes: [], unresolved: [] })
  })

  it('deletes on one foreign code even when others are ours or unreadable', async () => {
    const mixed: InviteResolver = (code) =>
      Promise.resolve(code === 'ours' ? OURS : code === 'theirs' ? THEIRS : null)

    const verdict = await decide(
      msg({ text: 'discord.gg/ours discord.gg/theirs discord.gg/gone' }),
      cfg(),
      mixed,
    )

    expect(verdict).toEqual({
      action: 'delete',
      why: 'foreign-invite',
      found: 3,
      foreign: ['theirs'],
      unresolved: ['gone'],
    })
  })

  it('does not let a throwing resolver escape', async () => {
    // invites.ts turns a throw into an unresolved code and logs it. This asserts
    // the handler above it inherits that rather than dying.
    const angry: InviteResolver = () => Promise.reject(new Error('429'))
    const verdict = await decide(msg(), cfg(), angry)

    expect(verdict).toEqual({ action: 'leave', codes: ['abc123'], unresolved: ['abc123'] })
    expect(stderr.join('')).toContain('invite lookup failed')
  })
})

/**
 * REGRESSION, AND IT WAS A WORKING BYPASS THAT NEEDED NO PERMISSIONS AT ALL.
 *
 * `scanMessage` resolves the first ten distinct codes and reports the rest as
 * `truncated`. `decide` dropped that flag — the `Verdict` union had nowhere to
 * put it and nothing outside invites.ts ever read it — so ten junk codes
 * followed by the real advert as the eleventh was a post the bot would not
 * touch: the junk resolved to nothing, the advert was never looked at, `foreign`
 * came back empty and the message was left alone. The flag being set, warned
 * about and documented as "NOT A BYPASS" changed nothing about that.
 */
describe('decide — more codes than the scan will resolve', () => {
  it('deletes the post that hides a foreign invite behind ten junk codes', async () => {
    const resolve = vi.fn(onlyRealIsForeign)

    const verdict = await decide(msg({ text: paddedWith('real') }), cfg(), resolve)

    expect(verdict).toMatchObject({ action: 'delete', why: 'over-lookup-cap', found: 11 })

    // And this is what makes it the bypass rather than an ordinary removal: the
    // invite that would have justified one was never even asked about, so
    // nothing but the cap itself can be carrying this deletion.
    expect(resolve).not.toHaveBeenCalledWith('real')
    expect(verdict).toMatchObject({ foreign: [] })
  })

  it('deletes on the cap alone, with nothing foreign among the codes it did check', async () => {
    const verdict = await decide(msg({ text: manyCodes(11) }), cfg(), deadResolver)

    expect(verdict).toMatchObject({ action: 'delete', why: 'over-lookup-cap', foreign: [] })
  })

  it('leaves a message that sits on the cap with nothing foreign in it', async () => {
    // The cap must not turn ordinary messages into removals. Ten is the most a
    // message may COST in lookups, not the most it is allowed to carry.
    expect(await decide(msg({ text: manyCodes(10) }), cfg(), deadResolver)).toMatchObject({
      action: 'leave',
    })

    const ourInvite: InviteResolver = () => Promise.resolve(OURS)
    expect(await decide(msg({ text: manyCodes(10) }), cfg(), ourInvite)).toMatchObject({
      action: 'leave',
    })
    expect(await decide(msg(), cfg(), deadResolver)).toMatchObject({ action: 'leave' })
  })

  it('reports the confirmed invite when both grounds apply at once', async () => {
    // Over the cap AND carrying a code Discord resolved to another guild. The
    // foreign one is the better-evidenced of the two and names something an
    // admin can go and look at.
    const resolve: InviteResolver = (code) => Promise.resolve(code === 'code0' ? THEIRS : null)

    expect(await decide(msg({ text: manyCodes(25) }), cfg(), resolve)).toMatchObject({
      action: 'delete',
      why: 'foreign-invite',
      foreign: ['code0'],
    })
  })

  it('is still only a would-delete in a dry run', async () => {
    const verdict = await decide(
      msg({ text: paddedWith('real') }),
      cfg({ dryRun: true }),
      onlyRealIsForeign,
    )

    expect(verdict).toMatchObject({ action: 'would-delete', why: 'over-lookup-cap' })
  })

  it('never reaches the scan for a message it would have skipped', async () => {
    // The cap is not a way around an exemption. An admin, an exempt channel and
    // another guild's message are all decided above the scan, so a padded post
    // from one of them is the same non-event it always was.
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const padded = msg({ text: paddedWith('real'), authorRoleIds: [ADMIN_ROLE] })

    expect(await decide(padded, config, onlyRealIsForeign)).toEqual({
      action: 'skip',
      why: 'exempt-admin',
    })
  })
})

describe('decide — dry run', () => {
  it('turns every delete into a would-delete', async () => {
    const verdict = await decide(msg(), cfg({ dryRun: true }), foreignResolver)
    expect(verdict).toEqual({
      action: 'would-delete',
      why: 'foreign-invite',
      found: 1,
      foreign: ['abc123'],
      unresolved: [],
    })
  })

  it('changes nothing about what gets left alone', async () => {
    const ourInvite: InviteResolver = () => Promise.resolve(OURS)
    expect(await decide(msg(), cfg({ dryRun: true }), ourInvite)).toMatchObject({ action: 'leave' })
    expect(await decide(msg(), cfg({ dryRun: true }), deadResolver)).toMatchObject({
      action: 'leave',
    })
  })
})

/**
 * The side effects, as spies.
 *
 * `remove` IS ALWAYS A SPY, INCLUDING WHEN THE CASE OVERRIDES IT with a
 * rejecting one — the failing-delete case has to assert both that the delete
 * was attempted and that the failure was handled, and it cannot do the first
 * with a bare function.
 */
function actions(over: Partial<Actions> = {}): Actions & { remove: Mock<() => Promise<void>> } {
  const remove = vi.fn<() => Promise<void>>(over.remove ?? (() => Promise.resolve()))

  // The default answers "I could not find out", which is the state that used to
  // skip the message entirely and must now scan it.
  return { resolve: foreignResolver, fetchRoles: cannotAsk, announce: null, ...over, remove }
}

/** A role lookup that never finds out. The fail-closed case, as the default. */
const cannotAsk: RoleLookup = () => Promise.resolve(null)

/** A role lookup that answers with a fixed list. */
function rolesOf(...ids: string[]): RoleLookup {
  return () => Promise.resolve(ids)
}

/** A log channel that keeps what was posted to it instead of sending it. */
function collect(posted: string[]): (line: string) => Promise<void> {
  return (line) => {
    posted.push(line)
    return Promise.resolve()
  }
}

describe('handleMessage — carrying the verdict out', () => {
  it('deletes exactly once and records it', async () => {
    const acts = actions()
    await handleMessage(msg(), cfg(), acts)

    expect(acts.remove).toHaveBeenCalledTimes(1)
    expect(stdout.join('')).toContain('deleted message carrying a foreign invite')
  })

  it('posts a factual line to the log channel after a delete', async () => {
    const posted: string[] = []
    const acts = actions({ announce: collect(posted) })

    await handleMessage(msg(), cfg({ logChannelId: LOG_CHANNEL }), acts)

    expect(posted).toHaveLength(1)
    const line = posted[0] ?? ''
    expect(line).toContain(AUTHOR)
    expect(line).toContain(CHANNEL)
    expect(line).toContain('abc123')
  })

  it('never posts a working invite link back into the guild', async () => {
    // Reporting the removal by reproducing the link would be a direct way to
    // defeat the bot with the bot's own log line.
    const posted: string[] = []
    const acts = actions({ announce: collect(posted) })

    await handleMessage(msg(), cfg({ logChannelId: LOG_CHANNEL }), acts)

    expect(posted.join('')).not.toContain('discord.gg')
    expect(posted.join('')).not.toContain('discord.com/invite')
  })

  it('does not talk to the poster and does not mention anyone', async () => {
    // The owner's standing rule, as an assertion: no mention markup, so nothing
    // this bot writes can put a notification in front of a member.
    const posted: string[] = []
    const acts = actions({ announce: collect(posted) })

    await handleMessage(msg(), cfg({ logChannelId: LOG_CHANNEL }), acts)

    expect(posted.join('')).not.toContain(`<@${AUTHOR}>`)
    expect(posted.join('')).not.toContain('@everyone')
    expect(posted.join('')).not.toContain('@here')
  })

  it('survives a delete that fails, and says so', async () => {
    const acts = actions({ remove: () => Promise.reject(new Error('Missing Permissions')) })
    const posted: string[] = []

    await expect(
      handleMessage(msg(), cfg({ logChannelId: LOG_CHANNEL }), {
        ...acts,
        announce: collect(posted),
      }),
    ).resolves.toBeUndefined()

    expect(stderr.join('')).toContain('delete failed')
    // Nothing is announced, because nothing was removed. An admin who reads a
    // removal line and then finds the message still there has been misinformed
    // by their own tooling.
    expect(posted).toEqual([])
  })

  it('survives a log channel that cannot be posted to', async () => {
    const acts = actions({ announce: () => Promise.reject(new Error('Missing Access')) })

    await expect(
      handleMessage(msg(), cfg({ logChannelId: LOG_CHANNEL }), acts),
    ).resolves.toBeUndefined()

    expect(acts.remove).toHaveBeenCalledTimes(1)
    expect(stderr.join('')).toContain('could not post to the log channel')
  })

  it('does nothing at all for a skipped message', async () => {
    const posted: string[] = []
    const acts = actions({
      announce: collect(posted),
      resolve: vi.fn(foreignResolver),
    })

    await handleMessage(msg({ fromSelf: true }), cfg({ logChannelId: LOG_CHANNEL }), acts)

    expect(acts.remove).not.toHaveBeenCalled()
    expect(posted).toEqual([])
  })

  /**
   * REGRESSION. The admin exemption used to swallow the message here.
   *
   * `handleMessage` warned about it, which was the whole mitigation: a message
   * whose author's roles could not be read was never scanned, and a warning in
   * a journal nobody is tailing is a note left next to the thing still
   * happening. It now scans, and the warning about a failed lookup belongs to
   * the half that made the lookup.
   */
  it('scans and removes when the roles cannot be read at all', async () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const acts = actions({ fetchRoles: cannotAsk })

    await handleMessage(msg({ authorRoleIds: null }), config, acts)

    expect(acts.remove).toHaveBeenCalledTimes(1)
  })

  it('records unresolved codes on a message it leaves alone', async () => {
    const acts = actions({ resolve: deadResolver })
    await handleMessage(msg(), cfg(), acts)

    expect(acts.remove).not.toHaveBeenCalled()
    expect(stdout.join('')).toContain('invite codes did not resolve')
  })
})

describe('handleMessage — dry run removes nothing', () => {
  it('does not call remove, and says what it would have done', async () => {
    const acts = actions()
    await handleMessage(msg(), cfg({ dryRun: true }), acts)

    expect(acts.remove).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('dry run: would have deleted')
    expect(stderr.join('')).toContain('abc123')
  })

  it('posts to the log channel and marks the line as a dry run', async () => {
    const posted: string[] = []
    const acts = actions({ announce: collect(posted) })

    await handleMessage(msg(), cfg({ dryRun: true, logChannelId: LOG_CHANNEL }), acts)

    expect(posted).toHaveLength(1)
    expect(posted[0] ?? '').toContain('Dry run')
    expect(posted[0] ?? '').toContain('nothing removed')
  })

  it('removes nothing for any message, under any other setting', async () => {
    // The switch the owner is trusting. Walked across the combinations rather
    // than asserted once, because a dry run that leaks on one path is worth the
    // same as no dry run at all.
    const messages = [
      msg(),
      msg({ text: 'discord.gg/abc123 discord.gg/def456' }),
      msg({ text: 'https://discord.com/invite/abc123', authorRoleIds: null }),
      msg({ text: 'DISCORD.GG/AbC123', channelId: '777' }),
      msg({ text: 'discord.gg/abc123', webhookId: WEBHOOK, authorRoleIds: null }),
    ]

    const configs = [
      cfg({ dryRun: true }),
      cfg({ dryRun: true, adminRoleId: ADMIN_ROLE }),
      cfg({ dryRun: true, exemptAdmins: false }),
      cfg({ dryRun: true, logChannelId: LOG_CHANNEL }),
      cfg({ dryRun: true, exemptChannelIds: ['999'] }),
    ]

    const acts = actions({ announce: () => Promise.resolve() })

    for (const message of messages) {
      for (const config of configs) {
        await handleMessage(message, config, acts)
      }
    }

    expect(acts.remove).not.toHaveBeenCalled()
  })
})

describe('handleMessage — an over-cap removal is never mistaken for an ordinary one', () => {
  it('deletes, and names the grounds in the journal', async () => {
    const acts = actions({ resolve: deadResolver })

    await handleMessage(msg({ text: manyCodes(11) }), cfg(), acts)

    expect(acts.remove).toHaveBeenCalledTimes(1)

    const journal = stdout.join('')
    expect(journal).toContain('reason="over-lookup-cap"')
    expect(journal).toContain('found=11')

    // The ordinary line would be a false statement about this removal: no
    // foreign guild was confirmed on it, and saying one was is how an admin
    // ends up looking for an invite that was never resolved.
    expect(journal).not.toContain('deleted message carrying a foreign invite')
  })

  it('names the grounds in the log channel too', async () => {
    const posted: string[] = []
    const acts = actions({ resolve: deadResolver, announce: collect(posted) })

    await handleMessage(msg({ text: manyCodes(11) }), cfg({ logChannelId: LOG_CHANNEL }), acts)

    expect(posted).toHaveLength(1)
    expect(posted[0] ?? '').toContain('over-lookup-cap')
    expect(posted[0] ?? '').toContain('11')
  })

  it('leaves an ordinary foreign removal reading as one, in both places', async () => {
    const posted: string[] = []
    const acts = actions({ announce: collect(posted) })

    await handleMessage(msg(), cfg({ logChannelId: LOG_CHANNEL }), acts)

    expect(stdout.join('')).toContain('reason="foreign-invite"')
    expect(stdout.join('')).not.toContain('over-lookup-cap')
    expect(posted[0] ?? '').toContain('foreign-invite')
    expect(posted[0] ?? '').not.toContain('over-lookup-cap')
  })

  it('does not tip two hundred unexamined codes into the channel', async () => {
    // The codes past the cap are strings a stranger chose and were never looked
    // at, and there can be hundreds of them. The count is the evidence; the wall
    // of codes is long enough to push the post past Discord's 2000-character
    // limit and fail the send outright.
    const posted: string[] = []
    const acts = actions({ resolve: deadResolver, announce: collect(posted) })

    await handleMessage(msg({ text: manyCodes(200) }), cfg({ logChannelId: LOG_CHANNEL }), acts)

    const line = posted[0] ?? ''
    expect(line).toContain('200')
    expect(line.length).toBeLessThan(2000)
    expect(line).not.toContain('code0')
    expect(line).not.toContain('code150')
  })

  it('removes nothing on this path either when the dry run is on', async () => {
    // The new grounds reaches the same delete call as the old one, so it has to
    // pass the same gate on the way.
    const posted: string[] = []
    const acts = actions({ resolve: deadResolver, announce: collect(posted) })

    await handleMessage(
      msg({ text: manyCodes(11) }),
      cfg({ dryRun: true, logChannelId: LOG_CHANNEL }),
      acts,
    )

    expect(acts.remove).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('dry run: would have deleted')
    expect(posted[0] ?? '').toContain('Dry run')
    expect(posted[0] ?? '').toContain('over-lookup-cap')
  })
})

/** One embed, with only the parts the case under test cares about filled in. */
function embed(over: Partial<EmbedText> = {}): EmbedText {
  return { title: null, description: null, url: null, fields: [], footer: null, author: null, ...over }
}

/**
 * The text-carrying half of a message, or of a message forwarded into one.
 *
 * ONE BUILDER FOR BOTH, because the whole Route A-bis bug was that a forward
 * was walked differently from the message it was forwarded into. A case that
 * can be handed to either without being rewritten is a case that proves the two
 * walks are the same walk.
 */
function parts(over: Partial<ScannableParts> = {}): ScannableParts {
  return {
    content: '',
    embeds: [],
    components: [],
    attachments: new Map<string, AttachmentText>(),
    stickers: new Map<string, StickerText>(),
    poll: null,
    ...over,
  }
}

function scannable(over: Partial<ScannableMessage> = {}): ScannableMessage {
  return {
    ...parts(),
    messageSnapshots: new Map<string, ScannableParts>(),
    ...over,
  }
}

/** A Components V2 text display: `{ type: 10, content: '...' }`. */
function textDisplay(content: string): ComponentText {
  return { type: 10, content }
}

/** A container, which is the component that nests others inside itself. */
function container(children: readonly ComponentText[]): ComponentText {
  return { type: 17, components: children }
}

/** A section: text displays with a button or a thumbnail hung off the side. */
function section(children: readonly ComponentText[], accessory?: ComponentText): ComponentText {
  return { type: 9, components: children, accessory: accessory ?? null }
}

/** An action row, the v1 component that holds buttons. */
function actionRow(children: readonly ComponentText[]): ComponentText {
  return { type: 1, components: children }
}

/** A link button. The label is what you read; the url is where you land. */
function linkButton(label: string, url: string): ComponentText {
  return { type: 2, label, url }
}

function attachment(over: Partial<AttachmentText> = {}): AttachmentText {
  return { name: 'holiday.png', title: null, description: null, ...over }
}

function attached(...list: AttachmentText[]): ReadonlyMap<string, AttachmentText> {
  return new Map(list.map((one, index) => [`a${index}`, one]))
}

function stuckOn(...list: StickerText[]): ReadonlyMap<string, StickerText> {
  return new Map(list.map((one, index) => [`s${index}`, one]))
}

function poll(question: string, ...answers: string[]): PollText {
  return {
    question: { text: question },
    answers: new Map(answers.map((text, index) => [index, { text }])),
  }
}

/**
 * REGRESSION. Embeds and forwarded messages were invisible.
 *
 * The scan input was `message.content` and nothing else. An invite inside an
 * embed — which is how a bot or a webhook posts anything that looks designed —
 * arrives with `content` empty, and a forwarded message keeps the original text
 * in `messageSnapshots` with `content` empty too. Both looked like blank
 * messages and were left standing.
 */
describe('scanText — every piece of text a message carries', () => {
  it('reads the message content, as it always did', () => {
    expect(scanText(scannable({ content: 'join discord.gg/abc123' }))).toContain('discord.gg/abc123')
  })

  it('reads an invite out of an embed title, description, url, field or footer', () => {
    const bodies = [
      embed({ title: 'discord.gg/intitle' }),
      embed({ description: 'discord.gg/indescription' }),
      embed({ url: 'https://discord.gg/inurl' }),
      embed({ fields: [{ name: 'server', value: 'discord.gg/infield' }] }),
      embed({ footer: { text: 'discord.gg/infooter' } }),
      embed({ author: { name: 'discord.gg/inauthor' } }),
    ]

    const codes = findInviteCodes(scanText(scannable({ content: '', embeds: bodies })))

    expect(codes).toEqual([
      'intitle',
      'indescription',
      'inurl',
      'infield',
      'infooter',
      'inauthor',
    ])
  })

  it('reads an invite out of a forwarded message', () => {
    const forwarded = parts({ content: 'come to discord.gg/forwarded' })
    const text = scanText(
      scannable({ content: '', messageSnapshots: new Map([['1', forwarded]]) }),
    )

    expect(findInviteCodes(text)).toEqual(['forwarded'])
  })

  it('reads an invite out of an embed inside a forwarded message', () => {
    const forwarded = parts({ embeds: [embed({ description: 'discord.gg/deep' })] })
    const text = scanText(
      scannable({ content: '', messageSnapshots: new Map([['1', forwarded]]) }),
    )

    expect(findInviteCodes(text)).toEqual(['deep'])
  })

  it('never welds two parts into an invite that nobody posted', () => {
    // Joining bare would let a trailing `discord.gg/` in the content and a bare
    // word at the start of an embed become a link that was never written, and
    // the bot would delete a message over a string it assembled itself.
    const text = scanText(
      scannable({ content: 'discord.gg/', embeds: [embed({ description: 'abc123' })] }),
    )

    expect(findInviteCodes(text)).toEqual([])
  })
})

/**
 * REGRESSION, AND IT IS THE EMBED BUG A SECOND AND THIRD TIME.
 *
 * `ScannableParts` modelled `content` and `embeds`, so every surface a Discord
 * message has grown since — a Components V2 text display, a link button's url, a
 * poll's question and answers, an attachment's filename and alt text, a
 * sticker's name — reached `scanText` and came back as the empty string. An
 * invite in any one of them was a message the bot read as blank and left
 * standing, and none of them needs a single permission to post.
 *
 * AND EVERY ONE OF THEM AGAIN INSIDE A FORWARD. `messageSnapshots` is typed with
 * the same interface and discord.js's `MessageSnapshot` retains attachments,
 * components, content, embeds and stickers — five surfaces, of which the old
 * shape named two. Forwarding has now been the cheap way around this scan twice,
 * which is why every case below is run against the message AND against a forward
 * of the same parts: one walker, called twice, proven twice.
 */
const SURFACES: { readonly what: string; readonly code: string; readonly carrier: Partial<ScannableParts> }[] = [
  {
    what: 'a Components V2 text display',
    code: 'intextdisplay',
    carrier: { components: [textDisplay('best server around: discord.gg/intextdisplay')] },
  },
  {
    what: 'a text display nested inside a container',
    code: 'incontainer',
    carrier: { components: [container([section([textDisplay('discord.gg/incontainer')])])] },
  },
  {
    what: "a link button's url",
    code: 'inbutton',
    // The label says "click here" and nothing else. A walk that reads labels
    // and not urls sees two harmless words and calls the message clean.
    carrier: { components: [actionRow([linkButton('click here', 'https://discord.gg/inbutton')])] },
  },
  {
    what: 'a poll question',
    code: 'inpoll',
    carrier: { poll: poll('who is coming to discord.gg/inpoll', 'me', 'also me') },
  },
  {
    what: 'an attachment filename',
    code: 'infilename',
    // The name is poster-chosen text that arrives verbatim on the payload, and
    // it is displayed under the file. This file is not the place that gets to
    // decide which characters Discord will have stripped from it on the way in:
    // an assumption about that made here is a hole nobody can see from here.
    carrier: { attachments: attached(attachment({ name: 'discord.gg/infilename.png' })) },
  },
]

describe('scanText — the surfaces a message grew after content and embeds', () => {
  for (const surface of SURFACES) {
    it(`reads an invite out of ${surface.what}`, () => {
      expect(findInviteCodes(scanText(scannable(surface.carrier)))).toEqual([surface.code])
    })

    it(`reads an invite out of ${surface.what} inside a forward`, () => {
      const forwarded = new Map([['1', parts(surface.carrier)]])
      const text = scanText(scannable({ messageSnapshots: forwarded }))

      expect(findInviteCodes(text)).toEqual([surface.code])
    })
  }

  it('reads a poll answer as well as the question', () => {
    const text = scanText(scannable({ poll: poll('where next', 'discord.gg/inanswer') }))
    expect(findInviteCodes(text)).toEqual(['inanswer'])
  })

  it('reads an attachment title and description as well as its name', () => {
    const text = scanText(
      scannable({
        attachments: attached(
          attachment({ title: 'discord.gg/intitle' }),
          attachment({ description: 'discord.gg/indescription' }),
        ),
      }),
    )

    expect(findInviteCodes(text)).toEqual(['intitle', 'indescription'])
  })

  it('reads a sticker name and description', () => {
    const text = scanText(
      scannable({
        stickers: stuckOn({ name: 'discord.gg/inname', description: 'discord.gg/indesc' }),
      }),
    )

    expect(findInviteCodes(text)).toEqual(['inname', 'indesc'])
  })

  it("reads a section's accessory, which is where the button hides", () => {
    const text = scanText(
      scannable({
        components: [
          container([section([textDisplay('nice')], linkButton('here', 'discord.gg/inaccessory'))]),
        ],
      }),
    )

    expect(findInviteCodes(text)).toEqual(['inaccessory'])
  })

  it('reads a select menu placeholder and its options', () => {
    const text = scanText(
      scannable({
        components: [
          actionRow([
            {
              type: 3,
              placeholder: 'discord.gg/inplaceholder',
              options: [
                { label: 'discord.gg/inlabel', value: 'discord.gg/invalue' },
                { label: 'other', value: 'x', description: 'discord.gg/inoptdesc' },
              ],
            },
          ]),
        ],
      }),
    )

    expect(findInviteCodes(text)).toEqual([
      'inplaceholder',
      'inlabel',
      'invalue',
      'inoptdesc',
    ])
  })

  it('walks past a component that carries no text at all', () => {
    // A separator has no text fields whatsoever, which is the case that made
    // TypeScript refuse the whole component union until `type` was named.
    const text = scanText(
      scannable({ components: [{ type: 14 }, textDisplay('discord.gg/aftersep')] }),
    )

    expect(findInviteCodes(text)).toEqual(['aftersep'])
  })

  it('will not spin forever on a component tree that nests without end', () => {
    // Nothing Discord sends looks like this. The walk is a recursion over a
    // structure built from a payload a stranger chose, and the failure mode of
    // an unbounded one is a stack overflow that takes the bot off a live guild.
    const loop: { type: number; components: ComponentText[] } = { type: 17, components: [] }
    loop.components.push(loop)

    const text = scanText(scannable({ content: 'discord.gg/stillread', components: [loop] }))

    expect(findInviteCodes(text)).toEqual(['stillread'])
  })

  it('never welds two parts together across the new surfaces either', () => {
    // The guarantee the newline join exists for, restated over everything added
    // above: a trailing `discord.gg/` and a bare code in the next surface along
    // must not become a link the bot then deletes a message over.
    const text = scanText(
      scannable({
        content: 'discord.gg/',
        components: [textDisplay('abc123'), textDisplay('discord.gg/')],
        poll: poll('abc123', 'discord.gg/'),
        attachments: attached(attachment({ name: 'abc123' })),
        stickers: stuckOn({ name: 'discord.gg/', description: 'abc123' }),
      }),
    )

    expect(findInviteCodes(text)).toEqual([])
  })

  it('never welds the end of a message onto the start of a forward', () => {
    const text = scanText(
      scannable({
        content: 'discord.gg/',
        messageSnapshots: new Map([['1', parts({ components: [textDisplay('abc123')] })]]),
      }),
    )

    expect(findInviteCodes(text)).toEqual([])
  })
})

/**
 * A guild whose member fetch is a spy.
 *
 * A FRESH OBJECT PER CALL, AND THAT IS THE TEST ISOLATION. `memberRoles` keeps
 * its remembered answers in a WeakMap keyed on the guild, so a new guild is a
 * new empty table — and a case that wants to prove the SAME author is not
 * fetched twice passes the same guild object to both messages, which is the
 * production arrangement written out.
 */
function guildWhere(fetch: (id: string) => Promise<LiveMember>): LiveGuild & {
  members: { fetch: Mock<(id: string) => Promise<LiveMember>> }
} {
  return { members: { fetch: vi.fn<(id: string) => Promise<LiveMember>>(fetch) } }
}

/** A member carrying exactly these role ids. */
function memberWith(...roleIds: string[]): LiveMember {
  return { roles: { cache: new Map(roleIds.map((id) => [id, {}])) } }
}

/** A live message, with spies on the two things that reach Discord. */
function live(over: Partial<LiveMessage> = {}): LiveMessage & {
  delete: Mock<() => Promise<unknown>>
  fetch: Mock<() => Promise<LiveMessage>>
} {
  const remove = vi.fn<() => Promise<unknown>>(over.delete ?? (() => Promise.resolve()))
  const fetch = vi.fn<() => Promise<LiveMessage>>(
    over.fetch ?? (() => Promise.reject(new Error('nothing to fetch'))),
  )

  return {
    ...parts({ content: 'join us at discord.gg/abc123' }),
    partial: false,
    messageSnapshots: new Map<string, ScannableParts>(),
    author: { id: AUTHOR },
    member: memberWith(),
    guild: guildWhere(() => Promise.reject(new Error('no such member'))),
    channelId: CHANNEL,
    guildId: OURS,
    webhookId: null,
    ...over,
    delete: remove,
    fetch,
  }
}

function liveActions(over: Partial<LiveActions> = {}): LiveActions {
  return { resolve: foreignResolver, announce: null, ...over }
}

/**
 * The one cast in the file, and it is confined to `client.emit`. discord.js
 * types the listener argument as a real `Message`, which cannot be constructed
 * without a client and a REST handle; `LiveMessage` is the shape the code under
 * test actually reads, and the point of that interface is that this cast is the
 * only place the difference matters.
 */
function asGateway(message: LiveMessage): OmitPartialGroupDMChannel<Message> {
  return message as unknown as OmitPartialGroupDMChannel<Message>
}

describe('handleLive — from a gateway message to a removal', () => {
  it('deletes a message carrying somebody else s invite', async () => {
    const message = live()
    await handleLive(message, null, cfg(), liveActions())

    expect(message.delete).toHaveBeenCalledTimes(1)
  })

  it('spends nothing on a message from a guild we do not moderate', async () => {
    // Cheap exclusions first, and the fetch below a partial is an API call:
    // an edit in somebody else's server must cost neither a lookup nor a fetch.
    const resolve = vi.fn(foreignResolver)
    const message = live({ guildId: OTHER_GUILD, partial: true })

    await handleLive(message, null, cfg(), liveActions({ resolve }))

    expect(message.fetch).not.toHaveBeenCalled()
    expect(message.delete).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not delete its own message', async () => {
    const message = live()
    await handleLive(message, AUTHOR, cfg(), liveActions())

    expect(message.delete).not.toHaveBeenCalled()
  })

  /**
   * REGRESSION. A webhook post was never scanned once DISCORD_ADMIN_ROLE_ID was
   * set, because `message.member` is null for a webhook and null roles skipped.
   * This is that path end to end: no member, a webhook id, exemption live.
   */
  it('scans a webhook post that has no member object', async () => {
    const message = live({ member: null, webhookId: WEBHOOK })
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })

    await handleLive(message, null, config, liveActions())

    expect(message.delete).toHaveBeenCalledTimes(1)
  })

  /** REGRESSION. Content-only scanning missed every embed. */
  it('deletes a post whose invite is only in an embed', async () => {
    const message = live({
      content: '',
      member: null,
      webhookId: WEBHOOK,
      embeds: [embed({ description: 'best server: discord.gg/embedded' })],
    })

    await handleLive(message, null, cfg(), liveActions())

    expect(message.delete).toHaveBeenCalledTimes(1)
    expect(stdout.join('')).toContain('embedded')
  })

  /** REGRESSION. Content-only scanning missed every forward. */
  it('deletes a post whose invite is only in a forwarded message', async () => {
    const message = live({
      content: '',
      messageSnapshots: new Map<string, ScannableParts>([
        ['1', parts({ content: 'discord.gg/passediton' })],
      ]),
    })

    await handleLive(message, null, cfg(), liveActions())

    expect(message.delete).toHaveBeenCalledTimes(1)
    expect(stdout.join('')).toContain('passediton')
  })

  it('reports the removal to the log channel', async () => {
    const posted: string[] = []
    const message = live()

    await handleLive(message, null, cfg({ logChannelId: LOG_CHANNEL }), liveActions({
      announce: collect(posted),
    }))

    expect(posted).toHaveLength(1)
    expect(posted[0] ?? '').toContain(AUTHOR)
  })

  it('deletes nothing in a dry run', async () => {
    const message = live()
    await handleLive(message, null, cfg({ dryRun: true }), liveActions())

    expect(message.delete).not.toHaveBeenCalled()
  })

  /**
   * The padding bypass end to end, on the real `delete()` rather than on an
   * injected spy — the resolver is the only thing faked, so this is the whole
   * path from a gateway payload to the message being removed.
   */
  it('deletes a padded post whose real invite falls past the lookup cap', async () => {
    const message = live({ content: `hey all ${paddedWith('real')}` })

    await handleLive(message, null, cfg(), liveActions({ resolve: onlyRealIsForeign }))

    expect(message.delete).toHaveBeenCalledTimes(1)
  })

  it('deletes nothing on that path in a dry run', async () => {
    const message = live({ content: `hey all ${paddedWith('real')}` })

    await handleLive(message, null, cfg({ dryRun: true }), liveActions({ resolve: onlyRealIsForeign }))

    expect(message.delete).not.toHaveBeenCalled()
  })
})

/**
 * REGRESSION, END TO END. Every surface in `SURFACES` was a message the bot read
 * as blank, and every one of them again as a forward.
 *
 * These go through `handleLive` rather than `scanText` on purpose: the pure
 * matcher tests above prove the text comes out, and these prove the message is
 * actually removed — the two used to be different questions, because `scanText`
 * was returning a string nobody had noticed was empty.
 */
describe('handleLive — an invite in any surface is a removal, forwarded or not', () => {
  for (const surface of SURFACES) {
    it(`deletes a post whose only invite is in ${surface.what}`, async () => {
      const message = live({ content: '', ...surface.carrier })

      await handleLive(message, null, cfg(), liveActions())

      expect(message.delete).toHaveBeenCalledTimes(1)
      expect(stdout.join('')).toContain(surface.code)
    })

    it(`deletes a forward whose only invite is in ${surface.what}`, async () => {
      const message = live({
        content: '',
        messageSnapshots: new Map([['1', parts(surface.carrier)]]),
      })

      await handleLive(message, null, cfg(), liveActions())

      expect(message.delete).toHaveBeenCalledTimes(1)
      expect(stdout.join('')).toContain(surface.code)
    })
  }

  it('leaves our own invite alone wherever it is hiding', async () => {
    // The new surfaces are read, not treated as suspicious in themselves: an
    // invite to THIS guild in a poll question is a member being helpful.
    const ourInvite: InviteResolver = () => Promise.resolve(OURS)
    const message = live({ content: '', poll: poll('join us at discord.gg/ourown') })

    await handleLive(message, null, cfg(), liveActions({ resolve: ourInvite }))

    expect(message.delete).not.toHaveBeenCalled()
  })
})

/**
 * REGRESSION, AND IT WAS THE BOT'S DEFAULT POSTURE.
 *
 * `decide` used to skip outright when `authorRoleIds` was null, and null is
 * what arrives whenever the gateway payload carries no member — which happens
 * routinely, because `createClient` does not ask for the `GuildMembers` intent.
 * With `BLITZ_EXEMPT_ADMINS` defaulting to true and an admin role configured,
 * the shipped default was therefore: any message whose member object did not
 * turn up was never scanned. A moderation filter that fails open is not a
 * filter, and this one failed open for everybody, silently, by default.
 */
describe('decide — roles the payload did not carry are fetched, never waved through', () => {
  it('scans and removes when the fetch says the author is not an admin', async () => {
    const fetchRoles = vi.fn<RoleLookup>(rolesOf())
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })

    const verdict = await decide(msg({ authorRoleIds: null }), config, foreignResolver, fetchRoles)

    expect(fetchRoles).toHaveBeenCalledWith(AUTHOR)
    expect(verdict).toMatchObject({ action: 'delete' })
  })

  it('skips when the fetch says the author is an admin', async () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const verdict = await decide(
      msg({ authorRoleIds: null }),
      config,
      foreignResolver,
      rolesOf('other-role', ADMIN_ROLE),
    )

    expect(verdict).toEqual({ action: 'skip', why: 'exempt-admin' })
  })

  it('SCANS when the fetch cannot answer either, rather than skipping', async () => {
    // The whole point. A missed invite is an advert left standing for everyone
    // to see and click; a wrong delete is one admin's own message, visible in
    // the log channel and retypable. Those are not the same size of mistake,
    // and the old code chose the larger one as its default.
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const verdict = await decide(msg({ authorRoleIds: null }), config, foreignResolver, cannotAsk)

    expect(verdict).toMatchObject({ action: 'delete', why: 'foreign-invite' })
  })

  it('scans when no lookup was wired in at all', async () => {
    // The default is "cannot ask", and cannot-ask scans. Forgetting to pass a
    // lookup must cost a scan that need not have happened, never a bypass.
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })
    const verdict = await decide(msg({ authorRoleIds: null }), config, foreignResolver)

    expect(verdict).toMatchObject({ action: 'delete' })
  })

  it('does not ask when the payload already carried the roles', async () => {
    const fetchRoles = vi.fn<RoleLookup>(cannotAsk)
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })

    await decide(msg({ authorRoleIds: [] }), config, foreignResolver, fetchRoles)
    await decide(msg({ authorRoleIds: [ADMIN_ROLE] }), config, foreignResolver, fetchRoles)

    expect(fetchRoles).not.toHaveBeenCalled()
  })

  it('does not ask when there is no exemption for the answer to change', async () => {
    // A rate-limit property: with the exemption off or no admin role set, the
    // roles cannot affect the verdict, so a raid costs no member lookups.
    const fetchRoles = vi.fn<RoleLookup>(cannotAsk)

    await decide(msg({ authorRoleIds: null }), cfg({ adminRoleId: null }), foreignResolver, fetchRoles)
    await decide(
      msg({ authorRoleIds: null }),
      cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: false }),
      foreignResolver,
      fetchRoles,
    )

    expect(fetchRoles).not.toHaveBeenCalled()
  })

  it('does not ask about a message it was going to skip anyway', async () => {
    const fetchRoles = vi.fn<RoleLookup>(cannotAsk)
    const config = cfg({ adminRoleId: ADMIN_ROLE, exemptChannelIds: [CHANNEL] })

    await decide(msg({ authorRoleIds: null }), config, foreignResolver, fetchRoles)
    await decide(msg({ authorRoleIds: null, guildId: OTHER_GUILD }), config, foreignResolver, fetchRoles)
    await decide(msg({ authorRoleIds: null, fromSelf: true }), config, foreignResolver, fetchRoles)

    expect(fetchRoles).not.toHaveBeenCalled()
  })
})

/**
 * The same fix through the live half, where the member fetch is real: this is
 * where `memberRoles` turns a missing member into one `guild.members.fetch`,
 * and where a fetch that throws still ends in a removal.
 */
describe('handleLive — fetching the member the payload did not bring', () => {
  const exempting = cfg({ adminRoleId: ADMIN_ROLE, exemptAdmins: true })

  it('fetches the member and deletes a foreign invite from a non-admin', async () => {
    const guild = guildWhere(() => Promise.resolve(memberWith('some-other-role')))
    const message = live({ member: null, guild })

    await handleLive(message, null, exempting, liveActions())

    expect(guild.members.fetch).toHaveBeenCalledWith(AUTHOR)
    expect(message.delete).toHaveBeenCalledTimes(1)
  })

  it("leaves the message alone once the fetch says it is an admin's", async () => {
    const guild = guildWhere(() => Promise.resolve(memberWith(ADMIN_ROLE)))
    const message = live({ member: null, guild })

    await handleLive(message, null, exempting, liveActions())

    expect(message.delete).not.toHaveBeenCalled()
  })

  it('deletes the foreign invite anyway when the member fetch throws', async () => {
    // Fail closed. A member that cannot be fetched — left the guild, an
    // outage, a permission — is not a reason to stop reading the message.
    const guild = guildWhere(() => Promise.reject(new Error('Unknown Member')))
    const message = live({ member: null, guild })

    await handleLive(message, null, exempting, liveActions())

    expect(message.delete).toHaveBeenCalledTimes(1)
    expect(stderr.join('')).toContain('author roles could not be fetched')
  })

  it('does not ask twice about the same author', async () => {
    // One REST call per uncached author, and the raid case is a hundred fresh
    // accounts at once. The failure is remembered too, or an author who cannot
    // be fetched costs a lookup on every message they ever post.
    const guild = guildWhere(() => Promise.reject(new Error('Unknown Member')))

    await handleLive(live({ member: null, guild }), null, exempting, liveActions())
    await handleLive(live({ member: null, guild }), null, exempting, liveActions())
    await handleLive(live({ member: null, guild }), null, exempting, liveActions())

    expect(guild.members.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not ask twice about an author it did manage to fetch', async () => {
    const guild = guildWhere(() => Promise.resolve(memberWith(ADMIN_ROLE)))

    const first = live({ member: null, guild })
    const second = live({ member: null, guild })

    await handleLive(first, null, exempting, liveActions())
    await handleLive(second, null, exempting, liveActions())

    expect(guild.members.fetch).toHaveBeenCalledTimes(1)
    expect(first.delete).not.toHaveBeenCalled()
    expect(second.delete).not.toHaveBeenCalled()
  })

  it('asks separately about a different author', async () => {
    const guild = guildWhere(() => Promise.resolve(memberWith()))

    await handleLive(live({ member: null, guild }), null, exempting, liveActions())
    await handleLive(
      live({ member: null, guild, author: { id: '123456789012345678' } }),
      null,
      exempting,
      liveActions(),
    )

    expect(guild.members.fetch).toHaveBeenCalledTimes(2)
  })

  it('spends no member lookup when there is no admin exemption to apply', async () => {
    const guild = guildWhere(() => Promise.resolve(memberWith()))
    const message = live({ member: null, guild })

    await handleLive(message, null, cfg(), liveActions())

    expect(guild.members.fetch).not.toHaveBeenCalled()
    expect(message.delete).toHaveBeenCalledTimes(1)
  })

  it('scans rather than skips when there is no guild object to ask', async () => {
    const message = live({ member: null, guild: null })

    await handleLive(message, null, exempting, liveActions())

    expect(message.delete).toHaveBeenCalledTimes(1)
  })

  it('asks again once the remembered answer has gone stale', async () => {
    // A remembered role list means a demoted admin keeps the exemption and a
    // promoted one keeps being scanned, for as long as the entry lives. A
    // remembered answer that never expires makes both of those permanent.
    vi.useFakeTimers()

    try {
      const guild = guildWhere(() => Promise.resolve(memberWith(ADMIN_ROLE)))

      await handleLive(live({ member: null, guild }), null, exempting, liveActions())
      vi.setSystemTime(Date.now() + 61_000)
      await handleLive(live({ member: null, guild }), null, exempting, liveActions())

      expect(guild.members.fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the oldest author rather than remembering every one of them', async () => {
    // Bounded, not a bare Map. This process runs for weeks under systemd and
    // the keys are ids a stranger chose by posting; unbounded is a memory leak
    // with somebody else's hand on the tap. Eviction is proved from the
    // outside: the author pushed out has to be asked about a second time.
    const guild = guildWhere(() => Promise.resolve(memberWith()))
    const first = { id: '100000000000000001' }

    await handleLive(live({ member: null, guild, author: first }), null, exempting, liveActions())

    for (let i = 0; i < 500; i++) {
      const author = { id: `2${String(i).padStart(17, '0')}` }
      await handleLive(live({ member: null, guild, author }), null, exempting, liveActions())
    }

    await handleLive(live({ member: null, guild, author: first }), null, exempting, liveActions())

    // One for the first author, five hundred for the crowd, and one more for
    // the first author again because the crowd pushed their entry out.
    expect(guild.members.fetch).toHaveBeenCalledTimes(502)
  })
})

/**
 * THE SECOND DRY-RUN GATE, WHICH NOTHING WAS EXERCISING.
 *
 * `decide` cannot return `delete` while `dryRun` is set, so this branch is
 * unreachable through `handleLive` by construction — and that is exactly why it
 * needs a test of its own rather than being covered by the ones above. Deleting
 * the gate left every other test in this repo green, which is how a
 * belt-and-braces guard on an irreversible operation rots away in some later
 * edit with nothing at all to say so.
 */
describe('remover — the gate that only matters once something else has broken', () => {
  it('refuses to delete, loudly, if the delete path is ever reached in a dry run', async () => {
    const message = live()

    await remover(message, cfg({ dryRun: true }))()

    expect(message.delete).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('dry run reached the delete path')
  })

  it('does delete when the dry run is off, or the gate would be the whole bot', async () => {
    const message = live()

    await remover(message, cfg({ dryRun: false }))()

    expect(message.delete).toHaveBeenCalledTimes(1)
    expect(stderr.join('')).not.toContain('dry run reached the delete path')
  })
})

/**
 * REGRESSION. Message edits were never scanned.
 *
 * Only `messageCreate` was registered, so "hey all" posted now and edited into
 * an invite five minutes later was never looked at again — a two-step bypass
 * that needs no permissions at all.
 */
describe('handleLive — edits, including the ones that arrive partial', () => {
  it('fetches a partial rather than scanning an empty shell as clean', async () => {
    // The content of an uncached edit is absent, which reads as the empty
    // string — indistinguishable from a message with nothing in it.
    const edited = live({ content: 'now with discord.gg/sneaky in it' })
    const partial = live({
      partial: true,
      content: null,
      author: null,
      fetch: () => Promise.resolve(edited),
    })

    await handleLive(partial, null, cfg(), liveActions())

    expect(partial.fetch).toHaveBeenCalledTimes(1)
    expect(edited.delete).toHaveBeenCalledTimes(1)
  })

  it('says so and deletes nothing when the partial cannot be fetched', async () => {
    const partial = live({
      partial: true,
      content: null,
      fetch: () => Promise.reject(new Error('Unknown Message')),
    })

    await handleLive(partial, null, cfg(), liveActions())

    expect(partial.delete).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('edited message could not be fetched')
  })

  it('says so and deletes nothing when the fetch comes back still partial', async () => {
    const stillPartial = live({ partial: true, content: null })
    const partial = live({
      partial: true,
      content: null,
      fetch: () => Promise.resolve(stillPartial),
    })

    await handleLive(partial, null, cfg(), liveActions())

    expect(partial.delete).not.toHaveBeenCalled()
    expect(stillPartial.delete).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('still partial after a fetch')
  })

  it('will not scan a message it cannot attribute to an author', async () => {
    const authorless = live({ author: null })
    await handleLive(authorless, null, cfg(), liveActions())

    expect(authorless.delete).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('no author')
  })
})

/**
 * REGRESSION. `fetchInvite` throws for an expired invite rather than returning
 * null, so the most common outcome in a real guild went out through invites.ts's
 * "the resolver blew up" handler: one warn per expired invite, and the
 * never-delete-on-unresolved rule reached by the wrong path.
 */
describe('inviteResolver — an expired invite is an answer, not a fault', () => {
  const url = 'https://discord.com/api/v10/invites/abc123'

  function apiError(code: number, message: string): DiscordAPIError {
    return new DiscordAPIError({ code, message }, code, code === 10006 ? 404 : 500, 'GET', url, {})
  }

  it('answers null for an invite Discord has never heard of', async () => {
    const resolve = inviteResolver(() =>
      Promise.reject(apiError(RESTJSONErrorCodes.UnknownInvite, 'Unknown Invite')),
    )

    await expect(resolve('abc123')).resolves.toBeNull()
  })

  it('does not log a warning for one', async () => {
    // The warn line exists to make a broken resolver visible. An expired invite
    // is not a broken resolver, and burying the signal under it is how a real
    // outage stops being noticeable.
    const resolve = inviteResolver(() =>
      Promise.reject(apiError(RESTJSONErrorCodes.UnknownInvite, 'Unknown Invite')),
    )

    const verdict = await decide(msg(), cfg(), resolve)

    expect(verdict).toMatchObject({ action: 'leave', unresolved: ['abc123'] })
    expect(stderr.join('')).not.toContain('invite lookup failed')
  })

  it('rethrows anything else so a genuine outage still logs at warn', async () => {
    const outage = apiError(0, 'Internal Server Error')
    const resolve = inviteResolver(() => Promise.reject(outage))

    await expect(resolve('abc123')).rejects.toBe(outage)

    // And through the scan, that is still an unresolved code and never a delete.
    expect(await decide(msg(), cfg(), resolve)).toMatchObject({ action: 'leave' })
    expect(stderr.join('')).toContain('invite lookup failed')
  })

  it('reports the guild for an invite that resolves', async () => {
    const resolve = inviteResolver(() => Promise.resolve({ guild: { id: THEIRS } }))
    await expect(resolve('abc123')).resolves.toBe(THEIRS)
  })

  it('answers null for an invite with no guild on it', async () => {
    // A group DM invite has no guild. Nothing to compare against ours, so it
    // falls where every other ambiguous answer falls: not a delete.
    const resolve = inviteResolver(() => Promise.resolve({ guild: null }))
    await expect(resolve('abc123')).resolves.toBeNull()
  })
})

/** A `clientReady` payload, carrying only what the handler reads. */
function readyPayload(guildIds: string[]): Client<true> {
  const cache = new Map(guildIds.map((id) => [id, { id, name: `guild-${id}` }]))
  return { guilds: { cache }, user: { tag: 'blitz#0001', id: '999' } } as unknown as Client<true>
}

describe('createClient — the wiring that would otherwise fail silently', () => {
  it('asks for MessageContent, because without it the gateway refuses to connect', async () => {
    const client = createClient(cfg())

    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(true)
    expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true)
    expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(true)

    await client.destroy()
  })

  it('does not request the GuildMembers intent', async () => {
    // The member arrives attached to the message payload, so the admin
    // exemption works without a second privileged intent. Asking for one that
    // is not needed is another switch in the portal to get wrong.
    const client = createClient(cfg())
    expect(client.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(false)
    await client.destroy()
  })

  it('is built so that nothing it sends can ping anyone', async () => {
    const client = createClient(cfg())
    expect(client.options.allowedMentions).toEqual({ parse: [], repliedUser: false })
    await client.destroy()
  })

  /** REGRESSION. `messageCreate` was the only listener; edits went unseen. */
  it('listens for edits as well as new messages', async () => {
    const client = createClient(cfg())

    expect(client.listenerCount(Events.MessageCreate)).toBe(1)
    expect(client.listenerCount(Events.MessageUpdate)).toBe(1)

    await client.destroy()
  })

  it('takes the message partial, or discord.js drops edits to uncached messages', async () => {
    // Without it the edit listener above never fires for a message posted
    // before the last restart, which is the same bypass one day later.
    const client = createClient(cfg())
    expect(client.options.partials).toContain(Partials.Message)
    await client.destroy()
  })

  it('routes the edited message — not the old copy — through the same handler', async () => {
    const client = createClient(cfg())

    // A partial whose fetch fails: it proves the new message reached
    // `handleLive` without the resolver ever needing a network of its own.
    const edited = live({
      partial: true,
      content: null,
      fetch: () => Promise.reject(new Error('Unknown Message')),
    })

    client.emit(Events.MessageUpdate, asGateway(live({ content: 'hey all' })), asGateway(edited))

    await vi.waitFor(() => {
      expect(stderr.join('')).toContain('edited message could not be fetched')
    })
    expect(edited.fetch).toHaveBeenCalledTimes(1)

    await client.destroy()
  })
})

/**
 * REGRESSION, AND THE ONE THAT MATTERS MOST. A wrong DISCORD_GUILD_ID used to
 * log one error line and carry on moderating.
 *
 * `config.guildId` is the only thing separating "our invite, keep" from
 * "foreign invite, delete", so a mistyped id does not make the bot idle — it
 * makes the bot delete OUR OWN invites. The startup check noticed exactly that
 * and then returned, leaving the message listener armed.
 *
 * EACH CASE TAKES A FRESH COPY OF THE MODULE because the halt is a latch with
 * no way back, which is the point of it: nothing in this file may be able to
 * turn moderation back on, so the isolation has to come from the module
 * registry rather than from a reset the production code exports.
 */
describe('a guild id the bot is not in is fatal to moderation', () => {
  async function freshModule(): Promise<typeof import('./client.ts')> {
    vi.resetModules()
    return await import('./client.ts')
  }

  it('names the variable and stops moderating when the guild is missing', async () => {
    const mod = await freshModule()
    const client = mod.createClient(cfg())

    client.emit(Events.ClientReady, readyPayload([OTHER_GUILD]))

    expect(stderr.join('')).toContain('DISCORD_GUILD_ID')
    expect(stderr.join('')).toContain('moderation halted')
    expect(await mod.decide(msg(), cfg(), foreignResolver)).toEqual({
      action: 'skip',
      why: 'moderation-halted',
    })

    await client.destroy()
  })

  it('takes the message listeners off, so not even a queued event can delete', async () => {
    const mod = await freshModule()
    const client = mod.createClient(cfg())

    expect(client.listenerCount(Events.MessageCreate)).toBe(1)

    client.emit(Events.ClientReady, readyPayload([OTHER_GUILD]))

    expect(client.listenerCount(Events.MessageCreate)).toBe(0)
    expect(client.listenerCount(Events.MessageUpdate)).toBe(0)

    await client.destroy()
  })

  it('deletes nothing and looks nothing up once halted', async () => {
    const mod = await freshModule()
    mod.haltModeration('test')

    const resolve = vi.fn(foreignResolver)
    const acts = actions({ resolve })
    await mod.handleMessage(msg(), cfg(), acts)

    expect(acts.remove).not.toHaveBeenCalled()

    const message = live()
    await mod.handleLive(message, null, cfg(), { resolve, announce: null })

    expect(message.delete).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('spends no API call at all, not even the fetch under a partial', async () => {
    // `decide` refuses a halted bot anyway, so nothing is deleted whether or not
    // `handleLive` checks the latch — which is why deleting that check left
    // every test green. What it is actually for is the call ABOVE that
    // decision: an edit arrives partial, and refetching it is a request made to
    // Discord by a bot that has already been told to stop.
    const mod = await freshModule()
    mod.haltModeration('test')

    const resolve = vi.fn(foreignResolver)
    const partial = live({
      partial: true,
      content: null,
      fetch: () => Promise.resolve(live({ content: 'now with discord.gg/sneaky in it' })),
    })

    await mod.handleLive(partial, null, cfg(), { resolve, announce: null })

    expect(partial.fetch).not.toHaveBeenCalled()
    expect(partial.delete).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('carries on moderating when the configured guild is there', async () => {
    const mod = await freshModule()
    const client = mod.createClient(cfg())

    client.emit(Events.ClientReady, readyPayload([OURS, OTHER_GUILD]))

    expect(stdout.join('')).toContain('msg="ready"')
    expect(client.listenerCount(Events.MessageCreate)).toBe(1)
    expect(await mod.decide(msg(), cfg(), foreignResolver)).toMatchObject({ action: 'delete' })

    await client.destroy()
  })
})

/**
 * REGRESSION. The header used to describe a missing MessageContent intent as a
 * bot that connects, looks healthy and sees empty content. That is not what
 * discord.js v14 does — the gateway closes with 4014 and the login rejects —
 * and an operator following the old comment would go and read the regex while a
 * restart loop with the answer in it scrolled past in the journal.
 */
describe('the file header', () => {
  it('describes what a missing MessageContent intent actually looks like', async () => {
    const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8')
    const header = source.slice(0, source.indexOf('export interface ScannedMessage'))

    expect(header).toContain('4014')
    expect(header).toMatch(/login/i)
    expect(header).toMatch(/restart loop/i)
    expect(header).not.toContain('is indistinguishable from a bot whose regex is')
  })
})
