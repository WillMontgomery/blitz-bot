import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Partials,
  RESTJSONErrorCodes,
  type Client,
  type CloseEvent,
  type Message,
  type OmitPartialGroupDMChannel,
} from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  announceDeployedCommit,
  announcer,
  botManualPath,
  commitFiles,
  COPY,
  createClient,
  decide,
  docsChannel,
  deployedCommitPath,
  handleLive,
  handleMessage,
  inviteResolver,
  noticeChannel,
  notifier,
  ours,
  parseManual,
  readManual,
  remover,
  removalNotice,
  reportDeployedCommit,
  reportedCommitPath,
  scanText,
  statusPoster,
  statusReporter,
  syncDocsChannel,
  syncManual,
  type Actions,
  type CommitFiles,
  type AttachmentText,
  type ComponentText,
  type DeleteReason,
  type DocsChannel,
  type EmbedText,
  type LiveActions,
  type LiveGuild,
  type LiveMember,
  type LiveMessage,
  type ManualEmbed,
  type ManualSection,
  type NoticeChannel,
  type PollText,
  type PostedSection,
  type RoleLookup,
  type ScannableMessage,
  type ScannableParts,
  type ScannedMessage,
  type StickerText,
} from './client.ts'
// The registered command list, so the manual can be checked against the code
// rather than against a second list kept by hand. Importing it is offline:
// `COMMANDS` builds `/profile`'s DynamoDB client lazily, on the first use of
// the command, which is why this costs no SDK client here. See ./commands/index.ts.
import { COMMANDS } from './commands/index.ts'
import type { Config } from './config.ts'
import { findInviteCodes, type InviteResolver } from './invites.ts'
import { log, setSink } from './log.ts'
import { setStickies, stickies } from './sticky.ts'

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

/**
 * The author's username, and it carries an underscore on purpose: `_` is
 * markdown to Discord and an ordinary character in a real username, so it is
 * the case that says whether the name is neutralised by mangling it or by
 * putting it somewhere markdown is not read.
 */
const AUTHOR_NAME = 'spammer_99'

const CHANNEL = '555555555555555555'
const LOG_CHANNEL = '666666666666666666'
const WEBHOOK = '777777777777777777'
const OTHER_GUILD = '888888888888888888'

/**
 * This community's own game server addresses, as `loadConfig` would hand them
 * over. Written out rather than imported from links.ts, because the point of the
 * cases below is that `decide` passes `config.serverIps` down — a test that
 * shared a constant with the matcher could not tell a wired-up allowlist from a
 * hard-coded one.
 */
const OUR_IP = '3.130.92.28'
const OUR_OTHER_IP = '18.222.244.205'

function cfg(over: Partial<Config> = {}): Config {
  return {
    discordToken: 'token',
    guildId: OURS,
    adminRoleId: null,
    logChannelId: null,
    statusChannelId: null,
    docsChannelId: null,
    maintenanceChannelId: null,
    exemptChannelIds: [],
    serverIps: [OUR_IP, OUR_OTHER_IP],
    exemptAdmins: true,
    dryRun: false,
    ...over,
  }
}

function msg(over: Partial<ScannedMessage> = {}): ScannedMessage {
  return {
    text: 'join us at discord.gg/abc123',
    authorId: AUTHOR,
    authorUsername: AUTHOR_NAME,
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

  // The sink is module state in log.ts, so a case that installs one and leaves
  // it there would send every later case's log lines to a fake Discord.
  setSink(null)

  // And the sticky engine is module state in sticky.ts. `createClient` installs
  // one now, so every case that builds a client leaves an engine behind holding
  // a destroyed client's channel fetcher.
  setStickies(null)
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
 * The link policy, as `decide` consults it. src/links.test.ts is where the
 * patterns are exercised; these cases are about the WIRING — that the rules are
 * consulted at all, where they sit relative to the exemptions and the invite
 * scan, that the allowlist arrives from config, and what a link verdict is
 * shaped like.
 */
describe('decide — the link policy', () => {
  it('removes a message naming an address that is not ours, under its own reason', async () => {
    const verdict = await decide(msg({ text: 'come play on 5.6.7.8' }), cfg(), foreignResolver)

    expect(verdict).toEqual({ action: 'delete', why: 'foreign-ip' })
  })

  it.each([
    ['cfx.re/join/kvkq6v', 'server-listing'],
    ['servers.fivem.net/servers/detail/9m4vjq', 'server-listing'],
    ['fivem://connect/play.someserver.com', 'fivem-connect'],
    ['bit.ly/3xY9k', 'link-shortener'],
    ['dsc.gg/someguild', 'link-shortener'],
  ])('removes %s under %s', async (text: string, why: string) => {
    expect(await decide(msg({ text }), cfg(), foreignResolver)).toEqual({ action: 'delete', why })
  })

  it('leaves this community s own address alone', async () => {
    const verdict = await decide(
      msg({ text: `we are back up on ${OUR_IP}:30120` }),
      cfg(),
      deadResolver,
    )

    expect(verdict).toEqual({ action: 'leave', codes: [], unresolved: [] })
  })

  /**
   * THE ALLOWLIST COMES FROM `config.serverIps` AND FROM NOWHERE ELSE. Without
   * this pair the wire could be missing — links.ts would still pass its own
   * tests, and the bot would delete the one address the channel is for.
   */
  it('exempts whatever the config names, and only that', async () => {
    const elsewhere = cfg({ serverIps: ['9.9.9.9'] })

    expect(await decide(msg({ text: '9.9.9.9' }), elsewhere, deadResolver)).toMatchObject({
      action: 'leave',
    })
    expect(await decide(msg({ text: OUR_IP }), elsewhere, deadResolver)).toEqual({
      action: 'delete',
      why: 'foreign-ip',
    })
  })

  /**
   * A RATE-LIMIT PROPERTY AS MUCH AS AN ORDERING ONE, and the reason the link
   * rules sit above the scan. `scanLinks` costs nothing; `scanMessage` can fire
   * ten Discord lookups. A message that is going to be removed either way must
   * not be paid for out of the API budget that every legitimate deletion queues
   * behind.
   */
  it('never resolves an invite for a message a link rule already condemns', async () => {
    const resolve = vi.fn(foreignResolver)

    const verdict = await decide(
      msg({ text: 'discord.gg/abc123 and 5.6.7.8' }),
      cfg(),
      resolve,
    )

    expect(resolve).not.toHaveBeenCalled()
    // Both policies are broken; the one that cost nothing to establish is the
    // one reported, and it is no less certain than the other.
    expect(verdict).toEqual({ action: 'delete', why: 'foreign-ip' })
  })

  /**
   * BELOW EVERY EXEMPTION, THOUGH. The link rules are cheap, not privileged: a
   * channel the operator excluded and an admin's own post are excluded from
   * these too, or `BLITZ_EXEMPT_CHANNEL_IDS` would mean something different
   * depending on which rule fired.
   */
  it('is not consulted for a message that is never scanned at all', async () => {
    const text = 'cfx.re/join/kvkq6v'

    expect(
      await decide(msg({ text }), cfg({ exemptChannelIds: [CHANNEL] }), foreignResolver),
    ).toEqual({ action: 'skip', why: 'exempt-channel' })

    expect(
      await decide(
        msg({ text, authorRoleIds: [ADMIN_ROLE] }),
        cfg({ adminRoleId: ADMIN_ROLE }),
        foreignResolver,
      ),
    ).toEqual({ action: 'skip', why: 'exempt-admin' })

    expect(await decide(msg({ text, guildId: OTHER_GUILD }), cfg(), foreignResolver)).toEqual({
      action: 'skip',
      why: 'other-guild',
    })
  })

  /**
   * A LINK REMOVAL CARRIES THE REASON AND NOTHING ELSE, and `toEqual` rather
   * than `toMatchObject` is what makes that an assertion. `found: 0` would be a
   * count of invite codes in a message nothing ever counted — the scan does not
   * run on this path — and `codes: []` an empty list of confirmed invites that
   * were never sought.
   */
  it('claims nothing about invite codes it never looked for', async () => {
    const verdict = await decide(msg({ text: 'bit.ly/3xY9k' }), cfg(), foreignResolver)

    expect(verdict).toEqual({ action: 'delete', why: 'link-shortener' })
    expect(verdict).not.toHaveProperty('found')
    expect(verdict).not.toHaveProperty('foreign')
    expect(verdict).not.toHaveProperty('unresolved')
  })

  it('passes the same dry-run gate every other removal does', async () => {
    const verdict = await decide(msg({ text: '5.6.7.8' }), cfg({ dryRun: true }), foreignResolver)

    expect(verdict).toEqual({ action: 'would-delete', why: 'foreign-ip' })
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
function actions(over: Partial<Actions> = {}): Actions & {
  remove: Mock<() => Promise<void>>
  notify: Mock<(why: DeleteReason) => Promise<void>>
} {
  const remove = vi.fn<() => Promise<void>>(over.remove ?? (() => Promise.resolve()))

  // A SPY FOR THE SAME REASON `remove` IS ONE. "The poster was told, and told
  // this reason" is an assertion about a call rather than about a return value,
  // and the branch that must NOT tell them — a dry run — can only be asserted
  // against something that records not having been called.
  const notify = vi.fn<(why: DeleteReason) => Promise<void>>(
    over.notify ?? (() => Promise.resolve()),
  )

  // The default answers "I could not find out", which is the state that used to
  // skip the message entirely and must now scan it.
  return {
    resolve: foreignResolver,
    fetchRoles: cannotAsk,
    announce: null,
    ...over,
    remove,
    notify,
  }
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

  it('does not talk to the poster, and writes no mass ping', async () => {
    // The owner's standing rule is that nothing this bot sends puts a
    // notification in front of a member. It used to be kept by leaving the
    // mention markup out of the line altogether; the author is now `<@id>` on
    // purpose, so the rule is kept by the send instead — `allowedMentions` on
    // `announcer`'s `send`, asserted where that option is actually passed.
    //
    // WHAT DOES NOT MOVE is `@everyone` and `@here`: those are not addressed to
    // an author, no part of this line builds one, and no username can smuggle
    // one in because `plainName` drops the `@`.
    const posted: string[] = []
    const acts = actions({ announce: collect(posted) })

    await handleMessage(msg(), cfg({ logChannelId: LOG_CHANNEL }), acts)

    expect(posted.join('')).toContain(`<@${AUTHOR}>`)
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

/**
 * A link removal, carried out.
 *
 * THE LINK IS NEVER QUOTED BACK, AND THAT IS THE POINT OF HALF THESE CASES. Every
 * rule in links.ts matches a WORKING link, and the log channel is inside the
 * guild the message was removed from — so a line quoting the match would repost
 * the advert the bot has just taken down. That is the same rule this file already
 * follows for invite codes, reached from the other direction, and it holds by
 * construction because `scanLinks` hands back a reason and nothing else.
 */
describe('handleMessage — a link removal names its own rule and quotes nothing', () => {
  it('deletes, and says which rule in the journal', async () => {
    const acts = actions()

    await handleMessage(msg({ text: 'come play on 5.6.7.8:30120' }), cfg(), acts)

    expect(acts.remove).toHaveBeenCalledTimes(1)

    const journal = stdout.join('')
    expect(journal).toContain('reason="foreign-ip"')
    expect(journal).toContain('deleted message naming a server address that is not ours')
    // The two invite lines would each be a false statement about this removal.
    expect(journal).not.toContain('foreign invite')
    expect(journal).not.toContain('over-lookup-cap')
  })

  it('claims no invite evidence it never gathered', async () => {
    const acts = actions()

    await handleMessage(msg({ text: 'bit.ly/3xY9k' }), cfg(), acts)

    const journal = stdout.join('')
    expect(journal).toContain('reason="link-shortener"')
    // `found` counts distinct invite codes and `codes` lists confirmed foreign
    // ones. Neither was established: the scan does not run on this path.
    expect(journal).not.toContain('found=')
    expect(journal).not.toContain('codes=')
  })

  it('does not repost the link into the channel it was removed from', async () => {
    const posted: string[] = []
    const acts = actions({ announce: collect(posted) })

    await handleMessage(
      msg({ text: 'real deal here: cfx.re/join/kvkq6v' }),
      cfg({ logChannelId: LOG_CHANNEL }),
      acts,
    )

    const line = posted[0] ?? ''
    expect(line).toContain('reason: server-listing')
    expect(line).not.toContain('cfx.re')
    expect(line).not.toContain('kvkq6v')
    expect(line).not.toContain('join')
  })

  it('does not repost an address either, in the removal line or the dry-run one', async () => {
    const posted: string[] = []

    await handleMessage(
      msg({ text: 'come play on 5.6.7.8' }),
      cfg({ logChannelId: LOG_CHANNEL }),
      actions({ announce: collect(posted) }),
    )
    await handleMessage(
      msg({ text: 'come play on 5.6.7.8' }),
      cfg({ logChannelId: LOG_CHANNEL, dryRun: true }),
      actions({ announce: collect(posted) }),
    )

    expect(posted).toHaveLength(2)
    for (const line of posted) {
      expect(line).toContain('reason: foreign-ip')
      expect(line).not.toContain('5.6.7.8')
    }
  })

  it('removes nothing on this path either when the dry run is on', async () => {
    const posted: string[] = []
    const acts = actions({ announce: collect(posted) })

    await handleMessage(
      msg({ text: 'fivem://connect/play.someserver.com' }),
      cfg({ dryRun: true, logChannelId: LOG_CHANNEL }),
      acts,
    )

    expect(acts.remove).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('dry run: would have deleted')
    expect(stderr.join('')).toContain('reason="fivem-connect"')
    expect(posted[0] ?? '').toContain('Dry run')
    expect(posted[0] ?? '').toContain('fivem-connect')
  })

  it('leaves this community s own address alone, and posts nothing about it', async () => {
    const posted: string[] = []
    const acts = actions({ resolve: deadResolver, announce: collect(posted) })

    await handleMessage(
      msg({ text: `we are back up on ${OUR_IP}. see you there` }),
      cfg({ logChannelId: LOG_CHANNEL }),
      acts,
    )

    expect(acts.remove).not.toHaveBeenCalled()
    expect(posted).toHaveLength(0)
  })
})

/**
 * THE POSTER IS TOLD, AND TOLD WHICH RULE FIRED.
 *
 * THIS REVERSES A STANDING INSTRUCTION, WHICH IS WHY IT IS TESTED FROM BOTH
 * ENDS. The rule used to be that the bot never talks to members at all — the
 * file header said so and the absence of any such call was the whole
 * implementation. The rule now is that a removal is explained to the person it
 * happened to: by DM, or, when the DM bounces, by a line in the channel that
 * tags them and comes back down about half a minute later.
 *
 * THE THREE THINGS THESE CASES HOLD, none of which the wording can move:
 *
 *   - A NOTICE FOLLOWS A REMOVAL AND ONLY A REMOVAL. A dry run deletes nothing,
 *     so a member told their message was removed during one has been lied to
 *     about the bot's own behaviour, by the exact feature that exists to be
 *     straight with them.
 *   - THE RULE TOKEN IS IN IT. It is the same token the journal line and the
 *     admin channel carry, so a member quoting their notice and an admin
 *     reading the log are looking at one word rather than two descriptions.
 *   - A FAILURE TO DELIVER IT COSTS NOTHING ELSE. Closing your DMs is a setting
 *     anybody has; if that could take down the message handler it would be a
 *     bypass of the whole bot, available from a user-settings menu.
 *
 * THE WORDING ITSELF IS A PLACEHOLDER AND IS DELIBERATELY NOT ASSERTED ON, past
 * the rule token. The owner supplies user-facing text; a test that pinned this
 * draft would have to be edited by whoever pastes the real one in, which is the
 * moment a check gets deleted rather than updated.
 */
describe('the poster is told, and told which rule fired', () => {
  /**
   * The six reasons a message can be removed over, written out rather than
   * derived from `COPY`, so that a seventh is a decision somebody makes here as
   * well as in client.ts. Reading the keys off the record instead would mean a
   * reason added without copy tests itself against nothing.
   */
  const REASONS: DeleteReason[] = [
    'foreign-invite',
    'over-lookup-cap',
    'fivem-connect',
    'server-listing',
    'foreign-ip',
    'link-shortener',
  ]

  it('tells the poster after a removal, naming the rule', async () => {
    const acts = actions()

    await handleMessage(msg({ text: 'bit.ly/3xY9k' }), cfg(), acts)

    expect(acts.notify).toHaveBeenCalledTimes(1)
    expect(acts.notify).toHaveBeenCalledWith('link-shortener')
  })

  it('names the rule that actually fired, not a fixed one', async () => {
    const acts = actions()

    await handleMessage(msg({ text: 'come play at 5.6.7.8.' }), cfg(), acts)

    expect(acts.notify).toHaveBeenCalledWith('foreign-ip')
  })

  it('says nothing to a poster whose message was left alone', async () => {
    const acts = actions()

    await handleMessage(msg({ text: 'good game everyone' }), cfg(), acts)

    expect(acts.notify).not.toHaveBeenCalled()
  })

  it('says nothing during a dry run, which removes nothing', async () => {
    const acts = actions()

    await handleMessage(msg({ text: 'bit.ly/3xY9k' }), cfg({ dryRun: true }), acts)

    expect(acts.remove).not.toHaveBeenCalled()
    expect(acts.notify).not.toHaveBeenCalled()
  })

  it('says nothing when the delete itself failed', async () => {
    // The message is still standing. Telling its author it was removed would be
    // a false statement they can check by scrolling up.
    const acts = actions({ remove: () => Promise.reject(new Error('Missing Permissions')) })

    await handleMessage(msg({ text: 'bit.ly/3xY9k' }), cfg(), acts)

    expect(acts.notify).not.toHaveBeenCalled()
  })

  it('says nothing about a message it never scanned', async () => {
    const acts = actions()

    await handleMessage(msg({ text: 'bit.ly/3xY9k' }), cfg({ exemptChannelIds: [CHANNEL] }), acts)

    expect(acts.notify).not.toHaveBeenCalled()
  })

  it('carries the notice out by DM when the DM lands', async () => {
    const seam = notices()

    await notifier(seam, msg())('link-shortener')

    expect(seam.dm).toHaveBeenCalledTimes(1)
    expect(seam.dm).toHaveBeenCalledWith(AUTHOR, expect.stringContaining('link-shortener'))
    expect(seam.fallback).not.toHaveBeenCalled()
  })

  it('falls back to the channel, tagging them, when the DM bounces', async () => {
    const seam = dmsClosed()

    await notifier(seam, msg())('foreign-ip')

    expect(seam.fallback).toHaveBeenCalledTimes(1)
    expect(seam.fallback).toHaveBeenCalledWith(
      CHANNEL,
      AUTHOR,
      expect.stringContaining(`<@${AUTHOR}>`),
    )
    expect(seam.fallback).toHaveBeenCalledWith(
      CHANNEL,
      AUTHOR,
      expect.stringContaining('foreign-ip'),
    )
  })

  it('does not post in the channel when the DM landed', async () => {
    // The fallback is a public note about somebody's deleted message. It is
    // taken every time the DM fails and never when it did not.
    const seam = notices()

    await notifier(seam, msg())('server-listing')

    expect(seam.fallback).not.toHaveBeenCalled()
  })

  it('never throws, whichever half of the delivery broke', async () => {
    const bothBroken = notices({
      dm: () =>
        Promise.reject(
          dmFailure(
            RESTJSONErrorCodes.CannotSendMessagesToThisUser,
            'Cannot send messages to this user',
          ),
        ),
      fallback: () => Promise.reject(new Error('Missing Permissions')),
    })

    await expect(notifier(bothBroken, msg())('fivem-connect')).resolves.toBeUndefined()
  })

  it('does not take the message handler down when the poster cannot be reached', async () => {
    // The path the case above proves in isolation, proven again through the
    // front door: a member with DMs closed in a channel the bot cannot post in
    // must not be able to stop a removal from completing.
    const acts = actions({
      notify: notifier(
        notices({
          dm: () =>
            Promise.reject(
              dmFailure(
                RESTJSONErrorCodes.CannotSendMessagesToThisUser,
                'Cannot send messages to this user',
              ),
            ),
          fallback: () => Promise.reject(new Error('Missing Permissions')),
        }),
        msg(),
      ),
    })

    await expect(handleMessage(msg({ text: 'bit.ly/3xY9k' }), cfg(), acts)).resolves.toBeUndefined()
    expect(acts.remove).toHaveBeenCalledTimes(1)
  })

  /**
   * A WEBHOOK IS NOT A POSTER. There is no account behind one to DM, and
   * `<@webhookId>` renders as `@unknown-user` and notifies nobody — so the
   * fallback would be a public note about a deleted message addressed to
   * nobody, standing in the channel for half a minute. The removal itself is
   * unaffected: a webhook advert is exactly what `decide` refuses to exempt.
   */
  it('does not try to DM a webhook, which has nobody behind it', async () => {
    const seam = notices()

    await notifier(seam, msg({ webhookId: '777777777777777777' }))('server-listing')

    expect(seam.dm).not.toHaveBeenCalled()
    expect(seam.fallback).not.toHaveBeenCalled()
  })

  it('puts the rule token in the notice, whatever the wording becomes', () => {
    // THE ONE THING A REWRITE MAY NOT DROP. Everything else about this string is
    // the owner's to choose; the token is what ties a member's copy to the
    // journal line and the admin channel line about the same removal.
    for (const why of REASONS) expect(removalNotice(why)).toContain(why)
  })

  /**
   * WHICH MESSAGE FIRED, PINNED THROUGH `COPY` RATHER THAN THROUGH ITS PROSE.
   * This is the whole reason the record is exported. src/commands/sticky.ts
   * asserted fragments of its placeholder text and nine cases broke the day the
   * real wording landed; comparing against `COPY[why]` asks the only question
   * worth asking — did the notice for THIS reason go out — and keeps asking it
   * after somebody rewrites every string in the record.
   */
  it('sends the copy belonging to the rule that fired', () => {
    for (const why of REASONS) expect(removalNotice(why)).toContain(COPY[why])
  })

  it('does not send some other reason as well', async () => {
    const seam = notices()

    await notifier(seam, msg())('foreign-ip')

    const [, sent] = seam.dm.mock.calls[0] ?? []
    expect(sent).toContain(COPY['foreign-ip'])
    for (const why of REASONS.filter((other) => other !== 'foreign-ip')) {
      expect(sent).not.toContain(COPY[why])
    }
  })

  it('carries real wording for every reason, and no drafts', () => {
    // THIS CASE HAS BEEN INVERTED, AND THE OLD ONE DID ITS JOB. It used to
    // assert every string still said PLACEHOLDER, so that supplying wording
    // would fail loudly rather than let a draft reach a member's DMs. The owner
    // supplied it, this failed, and here is what the failure was for.
    //
    // It now guards the opposite and more useful thing: a reason added later
    // with no wording written for it. That is the same mistake in the other
    // direction, and it is the one nobody would notice, because the notice
    // would go out reading like a bug report to whoever posted the message.
    for (const [key, draft] of Object.entries(COPY)) {
      if (typeof draft !== 'string') continue
      expect(draft, key).not.toContain('PLACEHOLDER')
      expect(draft.trim(), key).not.toBe('')
    }

    // Every reason the matcher can return has a sentence, derived from the
    // reason list rather than typed out, so a new DeleteReason fails here.
    for (const why of REASONS) {
      const notice = removalNotice(why)
      expect(notice, why).not.toContain('PLACEHOLDER')
      expect(notice, why).toContain(COPY[why])
      expect(notice, why).toContain(`(rule: ${why})`)
    }
  })

  /**
   * THE NOTICE NEVER REPEATS WHAT WAS REMOVED, AND THAT IS A SAFETY PROPERTY.
   * Every rule that can fire here matched a WORKING link, and the fallback posts
   * into the very channel the message was taken out of — so a notice that quoted
   * the match would repost the advert. The verdict does not carry the text (see
   * links.ts), which is what makes this true; this case is what would notice a
   * later wording reaching for it anyway.
   */
  it('names the reason and never the thing that matched', async () => {
    const seam = dmsClosed()
    const advert = 'join us at 5.6.7.8'

    await notifier(seam, msg({ text: advert }))('foreign-ip')

    const [, , posted] = seam.fallback.mock.calls[0] ?? []
    expect(posted).not.toContain('5.6.7.8')
    expect(posted).toContain('foreign-ip')
  })
})

/**
 * A BOUNCE IS NOT THE SAME AS A BAD MINUTE, AND ONLY ONE OF THEM BUYS A PUBLIC
 * POST.
 *
 * The fallback tags a member, in the channel they posted in, about a message of
 * theirs that was deleted. That is worth doing when the private route can NEVER
 * work — DMs from server members are off — and is not worth doing because
 * Discord returned a 429 or a 500 on one request. The two arrive at the same
 * seam as a rejection and are told apart only by the error's `code`, which is
 * why every case here throws a real `DiscordAPIError`.
 */
describe('a DM that bounced, and a DM that merely failed', () => {
  it('spends the fallback when the recipient has DMs closed', async () => {
    const seam = notices({
      dm: () =>
        Promise.reject(
          dmFailure(
            RESTJSONErrorCodes.CannotSendMessagesToThisUser,
            'Cannot send messages to this user',
          ),
        ),
    })

    await notifier(seam, msg())('foreign-ip')

    expect(seam.fallback).toHaveBeenCalledTimes(1)
  })

  it('spends it for a recipient there is no mutual guild with', async () => {
    // The same sentence under a second code — a member who left between the
    // removal and the notice. Permanent for this send either way, and permanence
    // is what the fallback is paid for.
    const seam = notices({
      dm: () =>
        Promise.reject(
          dmFailure(
            RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds,
            'Cannot send messages to this user',
          ),
        ),
    })

    await notifier(seam, msg())('foreign-ip')

    expect(seam.fallback).toHaveBeenCalledTimes(1)
  })

  it('does not post in the channel when the DM hit a rate limit', async () => {
    const seam = notices({
      dm: () => Promise.reject(dmFailure(0, 'You are being rate limited.', 429)),
    })

    await notifier(seam, msg())('link-shortener')

    expect(seam.fallback).not.toHaveBeenCalled()
  })

  it('does not post in the channel when the DM hit a server error', async () => {
    const seam = notices({
      dm: () => Promise.reject(dmFailure(0, 'Internal Server Error', 500)),
    })

    await notifier(seam, msg())('link-shortener')

    expect(seam.fallback).not.toHaveBeenCalled()
  })

  it('does not post in the channel when the DM failed for no Discord reason at all', async () => {
    // A socket hang-up, a bug in the seam, anything that is not a
    // `DiscordAPIError`. Not known to be permanent, so it does not buy a post.
    const seam = notices({ dm: () => Promise.reject(new Error('socket hang up')) })

    await notifier(seam, msg())('server-listing')

    expect(seam.fallback).not.toHaveBeenCalled()
  })

  it('says in the journal that it did not fall back, and why', async () => {
    const seam = notices({
      dm: () => Promise.reject(dmFailure(0, 'Internal Server Error', 500)),
    })

    await notifier(seam, msg())('link-shortener')

    expect(stderr.join('')).toContain('other than closed DMs')
  })
})

/**
 * A BURST OF REMOVALS FROM ONE PERSON IS ONE NOTICE, NOT TWENTY.
 *
 * Opening a DM channel is rate-limited per recipient and is one of the more
 * expensive requests this bot makes, so the wave that most needs the DELETES to
 * keep landing is exactly the wave that would queue them behind a courtesy note.
 * The fallback path is worse again: twenty pings in the channel, each standing
 * half a minute, is the bot doing more to the channel than the adverts did.
 *
 * NOTHING ABOUT THE RECORD IS COALESCED — every one of those messages is still
 * deleted, still logged, and still posted to the admin channel. What is bounded
 * is how many times one person is told the same thing while they watch it
 * happen.
 */
describe('a burst of removals is not a burst of DMs', () => {
  it('tells one poster once, however many of their messages go', async () => {
    const seam = notices()
    const tell = notifier(seam, msg())

    for (let i = 0; i < 20; i += 1) await tell('link-shortener')

    expect(seam.dm).toHaveBeenCalledTimes(1)
  })

  it('does not turn a burst into a wall of pings either', async () => {
    const seam = dmsClosed()
    const tell = notifier(seam, msg())

    for (let i = 0; i < 20; i += 1) await tell('foreign-ip')

    expect(seam.dm).toHaveBeenCalledTimes(1)
    expect(seam.fallback).toHaveBeenCalledTimes(1)
  })

  it('still tells everybody else in the same wave', async () => {
    // The bound is per poster, not per bot. A raid is several accounts, and
    // suppressing the second one because the first was just told would be a
    // notice that stops working exactly when it is most needed.
    const seam = notices()
    const other = '222222222222222222'

    await notifier(seam, msg())('link-shortener')
    await notifier(seam, msg({ authorId: other }))('link-shortener')

    expect(seam.dm).toHaveBeenCalledTimes(2)
    expect(seam.dm).toHaveBeenCalledWith(AUTHOR, expect.any(String))
    expect(seam.dm).toHaveBeenCalledWith(other, expect.any(String))
  })

  it('tells them again once the window has passed', async () => {
    // Bounded, not silenced. Somebody who is still posting adverts five minutes
    // later is still told; they are not told once per message.
    vi.useFakeTimers()

    try {
      const seam = notices()
      const tell = notifier(seam, msg())

      await tell('link-shortener')
      vi.setSystemTime(Date.now() + 61_000)
      await tell('foreign-ip')

      expect(seam.dm).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the removals themselves untouched', async () => {
    // The coalescing is about the courtesy and nothing else. Two messages, two
    // deletes, two log lines, one DM.
    const seam = notices()
    const first = actions({ notify: notifier(seam, msg()) })
    const second = actions({ notify: notifier(seam, msg()) })

    await handleMessage(msg({ text: 'bit.ly/3xY9k' }), cfg(), first)
    await handleMessage(msg({ text: 'bit.ly/3xY9k' }), cfg(), second)

    expect(first.remove).toHaveBeenCalledTimes(1)
    expect(second.remove).toHaveBeenCalledTimes(1)
    expect(seam.dm).toHaveBeenCalledTimes(1)
  })

  it('says in the journal that somebody was deliberately not told', async () => {
    const seam = notices()
    const tell = notifier(seam, msg())

    await tell('link-shortener')
    await tell('link-shortener')

    // Info, so stdout: a member deliberately not told is the mechanism working
    // rather than a fault, and it is recorded so an admin asking "why did they
    // get no DM" has the line.
    expect(stdout.join('')).toContain('not telling them again')
  })
})

/**
 * THE FALLBACK IS A MESSAGE IN A MODERATED CHANNEL, AND THE BOT MUST NOT MODERATE
 * IT.
 *
 * This is the loop the feature creates and it did not exist before: until now
 * the only thing the bot posted into a member-facing channel was nothing at all.
 * The fallback goes into the very channel the removal happened in, so it arrives
 * back through `messageCreate` like any other message — and it carries `<@id>`,
 * and the wording is a placeholder somebody will later replace with a sentence
 * that may well contain a link. If the bot scanned it, a notice about a removal
 * could be removed, which would post a notice about THAT.
 *
 * `fromSelf` IS WHAT STOPS IT, AND IT IS CHECKED ON THE TEXT ACTUALLY SENT
 * rather than on a string written here. A case that fed a hand-written line back
 * through would keep passing after a rewrite made the real one match a rule.
 *
 * THE OTHER LISTENER THAT SEES IT IS THE STICKY ENGINE, and it ignores the bot's
 * own posts for its own reasons — `saw(channelId, fromSelf)` in sticky.ts, tested
 * there. The delete of the fallback reaches nothing at all: this bot registers no
 * `messageDelete` listener.
 */
describe('the notice the bot posts is not itself moderated', () => {
  it('skips the fallback line it posted a moment ago', async () => {
    const seam = dmsClosed()

    await notifier(seam, msg())('foreign-ip')

    const posted = seam.fallback.mock.calls[0]?.[2] ?? ''
    expect(posted).not.toBe('')

    const own = live({ content: posted })
    const onward = notices()

    // `selfId` is this message's author, which is what the live path computes
    // for anything this bot sent.
    await handleLive(own, AUTHOR, cfg(), liveActions({ notices: onward }))

    expect(own.delete).not.toHaveBeenCalled()
    expect(onward.dm).not.toHaveBeenCalled()
    expect(onward.fallback).not.toHaveBeenCalled()
  })
})

/**
 * THE DELIVERY, AGAINST THE OPTIONS ACTUALLY HANDED TO DISCORD.
 *
 * THE FALLBACK IS THE ONE MESSAGE THIS BOT SENDS THAT PINGS ANYBODY, and
 * nothing about the STRING says whether it will. `<@id>` renders as the account
 * either way; only `allowedMentions` on the request decides whether a
 * notification is delivered. The client-wide default suppresses every mention,
 * so a fallback that forgot to override it would look correct in the channel,
 * read correctly in a test that checked the text, and reach nobody — which is
 * the entire failure this fallback exists to avoid.
 *
 * IT IS NARROWED TO ONE ID RATHER THAN TURNED ON, and that half matters more
 * every time the wording is edited: `{ users: [id] }` means no `@everyone` and
 * no role ping can be produced by anything a future draft puts in the text.
 */
describe('noticeChannel — the DM, and the ping that only the fallback carries', () => {
  function clientNoticing(
    dmSend: Mock<(payload: unknown) => Promise<unknown>>,
    channelSend: Mock<(payload: unknown) => Promise<unknown>>,
    over: { sendable?: boolean; fetchUserRejects?: unknown } = {},
  ): Client {
    return {
      users: {
        fetch: () =>
          over.fetchUserRejects === undefined
            ? Promise.resolve({ send: dmSend })
            : Promise.reject(over.fetchUserRejects),
      },
      channels: {
        fetch: () =>
          Promise.resolve({ isSendable: () => over.sendable !== false, send: channelSend }),
      },
    } as unknown as Client
  }

  const sendSpy = (): Mock<(payload: unknown) => Promise<unknown>> =>
    vi.fn<(payload: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ delete: () => Promise.resolve() }),
    )

  it('sends the DM with every mention suppressed', async () => {
    const dmSend = sendSpy()
    const channelSend = sendSpy()

    await noticeChannel(clientNoticing(dmSend, channelSend)).dm(AUTHOR, 'a notice')

    expect(dmSend).toHaveBeenCalledWith({ content: 'a notice', allowedMentions: { parse: [] } })
    expect(channelSend).not.toHaveBeenCalled()
  })

  it('pings exactly the poster on the channel fallback and nobody else', async () => {
    const dmSend = sendSpy()
    const channelSend = sendSpy()

    await noticeChannel(clientNoticing(dmSend, channelSend)).fallback(
      CHANNEL,
      AUTHOR,
      `<@${AUTHOR}> a notice`,
    )

    expect(channelSend).toHaveBeenCalledWith({
      content: `<@${AUTHOR}> a notice`,
      allowedMentions: { users: [AUTHOR] },
    })
  })

  it('rejects rather than posting when the channel cannot be posted in', async () => {
    // The channel the message was in a moment ago. `notifier` turns this into
    // one error line; swallowing it here would make a bot that can tell nobody
    // anything look exactly like a bot with nothing to say.
    const dmSend = sendSpy()
    const channelSend = sendSpy()
    const seam = noticeChannel(clientNoticing(dmSend, channelSend, { sendable: false }))

    await expect(seam.fallback(CHANNEL, AUTHOR, 'a notice')).rejects.toThrow(CHANNEL)
    expect(channelSend).not.toHaveBeenCalled()
  })

  it('treats a user it cannot even fetch as a bounced DM', async () => {
    // A member who left between the removal and the notice. `notifier` reads
    // any rejection from `dm` as "tell them in the channel instead", so the two
    // failures do not need telling apart.
    const dmSend = sendSpy()
    const channelSend = sendSpy()
    const seam = noticeChannel(
      clientNoticing(dmSend, channelSend, { fetchUserRejects: new Error('Unknown User') }),
    )

    await expect(seam.dm(AUTHOR, 'a notice')).rejects.toThrow('Unknown User')
  })

  it('takes the fallback back down again, and does not hold the process open', async () => {
    /**
     * BOTH HALVES OF THE CLEANUP IN ONE CASE, because each is invisible on its
     * own. A timer that never fires leaves a permanent public note about a
     * member's deleted message; a timer that is not `unref`ed makes every deploy
     * wait half a minute for a courtesy nobody is reading. Fake timers are what
     * make the first assertable without the test taking thirty seconds.
     */
    vi.useFakeTimers()

    try {
      const remove = vi.fn(() => Promise.resolve())
      const channelSend = vi.fn<(payload: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ delete: remove }),
      )

      await noticeChannel(clientNoticing(sendSpy(), channelSend)).fallback(
        CHANNEL,
        AUTHOR,
        'a notice',
      )

      expect(remove).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(30_000)

      expect(remove).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives the take-down failing, which happens once a message is gone', async () => {
    // AN UNHANDLED REJECTION OUT OF A BARE TIMER CALLBACK TAKES THE PROCESS
    // DOWN, and by the time this runs `notifier` has long since returned and
    // there is nobody left to hand an error to. The warning is the evidence
    // that the rejection was caught rather than merely not observed here.
    vi.useFakeTimers()

    const seen: string[] = []
    setSink((level, message) => {
      seen.push(`${level} ${message}`)
      return Promise.resolve()
    })

    try {
      const channelSend = vi.fn<(payload: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ delete: () => Promise.reject(new Error('Unknown Message')) }),
      )

      await noticeChannel(clientNoticing(sendSpy(), channelSend)).fallback(
        CHANNEL,
        AUTHOR,
        'a notice',
      )

      await vi.advanceTimersByTimeAsync(30_000)

      expect(seen).toContainEqual(expect.stringContaining('could not take the removal notice'))
    } finally {
      setSink(null)
      vi.useRealTimers()
    }
  })
})

/**
 * WHO A REMOVAL WAS ABOUT, IN A FORM A HUMAN CAN READ.
 *
 * The line went out with the CHANNEL as `<#id>` — which Discord renders as a
 * link — and the AUTHOR as a bare eighteen-digit snowflake. One line, two
 * conventions, and the half that identifies a person was the unreadable one:
 * the owner's report was that it "only shows the account ID and doesn't tag the
 * user". The author is now `<@id>` with the username in plain text beside it.
 *
 * THE PLAIN-TEXT NAME IS NOT DECORATION. `<@id>` is resolved by the reader's
 * client against the guild's member list, so it renders as `@unknown-user` the
 * moment that account leaves or is banned — which is the moment somebody
 * scrolls back to find out who a removal was about. Every case here therefore
 * asserts both halves, and the ones below assert that neither half can be
 * chosen by the person being moderated.
 */
describe('the channel line names the author', () => {
  /**
   * The removal line and the dry-run line for the same message and the same
   * grounds, in that order.
   *
   * BOTH, EVERY TIME, BECAUSE THE TWO ARE ALLOWED TO DIFFER IN ONE SENTENCE AND
   * NOTHING ELSE. The dry-run line is the only thing the owner reads while
   * deciding whether to let this bot delete anything, so a case that proved the
   * removal line and left the dry-run line untested would be testing the line
   * that ships and not the line that decision is made on.
   */
  async function bothLines(over: Partial<ScannedMessage> = {}): Promise<[string, string]> {
    const removed: string[] = []
    const dry: string[] = []

    await handleMessage(
      msg(over),
      cfg({ logChannelId: LOG_CHANNEL }),
      actions({ announce: collect(removed) }),
    )
    await handleMessage(
      msg(over),
      cfg({ dryRun: true, logChannelId: LOG_CHANNEL }),
      actions({ announce: collect(dry) }),
    )

    return [removed[0] ?? '', dry[0] ?? '']
  }

  /** What the line put inside the code span, or `''` when there is no span. */
  function spanOf(line: string): string {
    return /\(`([^`]*)`\)/u.exec(line)?.[1] ?? ''
  }

  /** The who-and-where half of a line, up to the grounds. */
  function whoAndWhere(line: string): string {
    return /Author [\s\S]*?(?=, reason:)/u.exec(line)?.[0] ?? ''
  }

  it('renders the author as a mention and keeps the username as plain text', async () => {
    for (const line of await bothLines()) {
      expect(line).toContain(`<@${AUTHOR}>`)
      expect(spanOf(line)).toBe(AUTHOR_NAME)
    }
  })

  it('leaves the raw id recoverable, because the mention markup contains it', async () => {
    // The id is what the journal, `grep` and Discord's own audit log agree on;
    // a rendered name that cannot be turned back into one is a dead end.
    for (const line of await bothLines()) expect(line).toContain(AUTHOR)
  })

  it('says who and where in exactly the same words on both lines', async () => {
    // The drift check. Both builders take the attribution from one function, so
    // this fails the moment somebody edits one of them alone.
    const [removed, dry] = await bothLines()

    expect(whoAndWhere(removed)).not.toHaveLength(0)
    expect(whoAndWhere(removed)).toBe(whoAndWhere(dry))
  })

  it('still carries the channel link, the grounds and the codes on both lines', async () => {
    // Everything the line said before the author changed, still said.
    const [removed, dry] = await bothLines()

    expect(removed).toContain(`channel <#${CHANNEL}>`)
    expect(removed).toContain('reason: foreign-invite')
    expect(removed).toContain('invite codes: abc123')

    expect(dry).toContain('Dry run, nothing removed.')
    expect(dry).toContain(`channel <#${CHANNEL}>`)
    expect(dry).toContain('reason: foreign-invite')
    expect(dry).toContain('invite codes: abc123')
  })

  /**
   * A USERNAME IS TEXT THE PERSON BEING MODERATED CHOSE, and it is displayed
   * next to every message they have ever sent, so it is a surface they can
   * prepare long before the bot ever reads it. Interpolating one into a channel
   * post unescaped lets the offender write part of our moderation log.
   */
  it('cannot let a username break the line, forge markup or write a mass ping', async () => {
    const nasty = '@everyone <@&999> `**x**`\n||y||'

    for (const line of await bothLines({ authorUsername: nasty })) {
      // ONE LINE. A newline would push the channel and the grounds onto a line
      // that no longer says who they are about, and would let a poster produce
      // something that reads like a second entry in the log.
      expect(line).not.toContain('\n')

      // Exactly the two delimiters of the code span the name sits in: nothing
      // in the name can close it and get out as markup.
      expect(line.match(/`/gu) ?? []).toHaveLength(2)

      // The only `@` and the only `<`s left in the line are the bot's own
      // mention markup — one `<@`, one `<#` — so the name cannot have forged a
      // mention of a role or of anybody else.
      expect(line.match(/@/gu) ?? []).toHaveLength(1)
      expect(line.match(/</gu) ?? []).toHaveLength(2)
      expect(line).not.toContain('@everyone')
      expect(line).not.toContain('<@&')

      // What is left is the name, verbatim and inert: `**x**` is rendered as
      // asterisks by Discord inside a code span rather than as bold, so it is
      // kept rather than mangled. That matters for the characters a REAL
      // username contains — `_` and `.` are both markdown and both ordinary.
      expect(spanOf(line)).toBe('everyone &999> **x** ||y||')

      // And the record still says what it is for.
      expect(line).toContain(`channel <#${CHANNEL}>`)
      expect(line).toContain('reason: foreign-invite')
    }
  })

  it('caps the name, so one poster cannot choose how long the record is', async () => {
    // A webhook name runs to eighty characters and a webhook post is exactly
    // what this bot removes. The line also has a 2000-character budget to stay
    // inside, and the name is context rather than the evidence.
    for (const line of await bothLines({ authorUsername: 'w'.repeat(80) })) {
      expect(spanOf(line)).toBe(`${'w'.repeat(32)}…`)
      expect(line).toContain('reason: foreign-invite')
    }
  })

  it('still produces a usable line when there is no username to carry', async () => {
    // Null is a payload that did not bring one; the rest are names that are
    // nothing but the characters the sanitiser removes. All four have to leave
    // a record an admin can act on rather than an empty `()` or a stray span.
    for (const authorUsername of [null, '', '   ', '@@@']) {
      for (const line of await bothLines({ authorUsername })) {
        expect(line).toContain(`Author <@${AUTHOR}>,`)
        expect(line).toContain(`channel <#${CHANNEL}>`)
        expect(line).toContain('reason: foreign-invite')
        expect(line).toContain('invite codes: abc123')
        expect(line).not.toContain('()')
        expect(line).not.toContain('`')
      }
    }
  })
})

/**
 * A client that hands back one channel, and remembers what was sent to it.
 *
 * `as unknown as Client` FOR THE SAME REASON `readyPayload` DOES IT: a real
 * `Client` needs a token and a REST handle, and `announcer` reads two things
 * off it. Everything this fake answers is a thing the function under test
 * actually calls.
 */
function clientSending(
  send: Mock<(payload: unknown) => Promise<unknown>>,
  sendable = true,
): Client {
  return {
    channels: { fetch: () => Promise.resolve({ isSendable: () => sendable, send }) },
  } as unknown as Client
}

/**
 * THE MENTION RENDERS AND NOTIFIES NOBODY, AND ONLY THIS PROVES THE SECOND HALF.
 *
 * A mention in a message body pings by default. Nothing about the STRING says
 * whether it will: the only thing that turns the notification off is
 * `allowedMentions` on the request, so a test that reads the posted text cannot
 * tell a suppressed mention from one that pings the member whose message was
 * just deleted. These assert on the options actually handed to `send`.
 *
 * The log channel is admin-only in the guild this runs in, which is why a ping
 * would usually land nowhere — but that is one server's permission overwrites,
 * changeable by anybody with Manage Roles and without this file being touched.
 */
describe('announcer — the mention renders and notifies nobody', () => {
  const sendSpy = (): Mock<(payload: unknown) => Promise<unknown>> =>
    vi.fn<(payload: unknown) => Promise<unknown>>(() => Promise.resolve({}))

  it('suppresses every mention on the send itself', async () => {
    const send = sendSpy()

    await announcer(clientSending(send), LOG_CHANNEL)(`Author <@${AUTHOR}>`)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      content: `Author <@${AUTHOR}>`,
      allowedMentions: { parse: [] },
    })
  })

  it('carries the option on the line a real removal produces', async () => {
    // Through `handleMessage`, so the builder and the send are proven to be
    // wired to each other rather than each proven on its own — which is the way
    // an option can reach the string and never reach the request.
    const send = sendSpy()
    const acts = actions({ announce: announcer(clientSending(send), LOG_CHANNEL) })

    await handleMessage(msg(), cfg({ logChannelId: LOG_CHANNEL }), acts)

    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining(`<@${AUTHOR}>`) as unknown as string,
      allowedMentions: { parse: [] },
    })
  })

  it('does the same for the dry-run line, which is the one the owner watches', async () => {
    const send = sendSpy()
    const acts = actions({ announce: announcer(clientSending(send), LOG_CHANNEL) })

    await handleMessage(msg(), cfg({ dryRun: true, logChannelId: LOG_CHANNEL }), acts)

    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining('Dry run') as unknown as string,
      allowedMentions: { parse: [] },
    })
  })

  it('sends nothing, and says which half is broken, when the channel is unusable', async () => {
    const send = sendSpy()

    await announcer(clientSending(send, false), LOG_CHANNEL)('anything')

    expect(send).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('log channel is missing or cannot be posted to')
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

/**
 * The author as a payload carries one: an id and a username.
 *
 * A HELPER RATHER THAN AN OBJECT LITERAL PER CASE, so the cases that only care
 * which id is being asked about — the role-cache ones below — do not have to
 * say anything about the name, and adding a third field to the author is one
 * edit here rather than one per test.
 */
function authorOf(id: string, username: string | null = AUTHOR_NAME): { id: string; username: string | null } {
  return { id, username }
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
    author: authorOf(AUTHOR),
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
  return { resolve: foreignResolver, announce: null, notices: notices(), ...over }
}

/**
 * The two ways to reach a poster, as spies that reach nobody.
 *
 * THE DM SUCCEEDS BY DEFAULT, so the fallback is only exercised by a case that
 * asks for it. A seam whose default is the failure path would make every
 * unrelated test post in a channel, and the cases about the fallback would then
 * be indistinguishable from the ones that merely did not care.
 */
function notices(over: Partial<NoticeChannel> = {}): NoticeChannel & {
  dm: Mock<NoticeChannel['dm']>
  fallback: Mock<NoticeChannel['fallback']>
} {
  return {
    dm: vi.fn<NoticeChannel['dm']>(over.dm ?? (() => Promise.resolve())),
    fallback: vi.fn<NoticeChannel['fallback']>(over.fallback ?? (() => Promise.resolve())),
  }
}

/**
 * A DM failure exactly as discord.js raises it.
 *
 * A REAL `DiscordAPIError` AND NOT A PLAIN `Error`, WHICH IS NOW LOAD-BEARING.
 * `dmsAreShut` separates a bounce from a bad minute by reading `code` off a
 * `DiscordAPIError`, so a fake that threw `new Error('Cannot send messages to
 * this user')` would exercise the NOT-a-bounce branch while reading like the
 * bounce case — a test that passes for the wrong reason and would keep passing
 * if the discrimination were deleted.
 */
function dmFailure(code: number, message: string, status = 403): DiscordAPIError {
  return new DiscordAPIError({ code, message }, code, status, 'POST', DM_URL, {})
}

const DM_URL = 'https://discord.com/api/v10/channels/1/messages'

/** A DM seam that always bounces, which is a member with DMs closed. */
function dmsClosed(): NoticeChannel & {
  dm: Mock<NoticeChannel['dm']>
  fallback: Mock<NoticeChannel['fallback']>
} {
  return notices({
    dm: () =>
      Promise.reject(
        dmFailure(
          RESTJSONErrorCodes.CannotSendMessagesToThisUser,
          'Cannot send messages to this user',
        ),
      ),
  })
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

/**
 * THE LINK RULES READ THE STRING `scanText` ALREADY BUILDS, and this is the case
 * that says so.
 *
 * IT IS NOT A THEORETICAL TIDINESS POINT. The history of `scanText` is four
 * separate bypasses, each one a surface somebody forgot: an embed, a forward, a
 * Components V2 text display, an attachment name. A second flattening path in
 * links.ts would be a second list of surfaces to keep in step, and the surface
 * that fell off it would be a hole in the new policy only — invisible in every
 * invite test, and only found by somebody trying it.
 */
describe('the link policy reads the same flattened text the invite scan does', () => {
  it.each([
    ['an embed description', scannable({ embeds: [embed({ description: 'join 5.6.7.8:30120' })] })],
    ['a link button url', scannable({ components: [actionRow([linkButton('click', 'https://bit.ly/3xY9k')])] })],
    // A filename cannot hold a slash, so the form that shows up here is the bare
    // address — which is exactly why the policy does not need a `fivem://`
    // wrapper to see one.
    //
    // THE PORT IS IN THE NAME FOR A REASON AND THE CASE IS WEAKER WITHOUT IT.
    // This row used to read `join-us-at-5.6.7.8.png`, and links.ts no longer
    // removes that: an address sitting immediately before a file extension is
    // read as part of the filename, because that is the only way to stop the bot
    // deleting ShadowPlay clips, whose default name ends in a four-field clock.
    // See the ShadowPlay rows in links.test.ts for the full trade. What this
    // case is here to prove is that the attachment SURFACE is read at all, so it
    // uses a name where the address is unambiguously an address.
    [
      'an attachment name',
      scannable({ attachments: attached(attachment({ name: 'join_us_at_5.6.7.8_30120.png' })) }),
    ],
    ['a poll question', scannable({ poll: poll('who is moving to 5.6.7.8?') })],
    [
      'a forwarded message',
      scannable({
        messageSnapshots: new Map([['s0', parts({ content: 'fivem://connect/play.someserver.com' })]]),
      }),
    ],
  ])('removes a message whose only text is in %s', async (_where: string, source) => {
    const verdict = await decide(msg({ text: scanText(source) }), cfg(), deadResolver)

    expect(verdict).toMatchObject({ action: 'delete' })
  })

  it('is not fooled into inventing a link across two surfaces', async () => {
    // `scanText` joins parts with newlines precisely so that two adjacent pieces
    // cannot weld into something neither of them said. A host at the end of one
    // and a path at the start of the next must not become a match.
    const source = scannable({
      content: 'cfx.re',
      embeds: [embed({ description: '/join/kvkq6v' })],
    })

    expect(await decide(msg({ text: scanText(source) }), cfg(), deadResolver)).toMatchObject({
      action: 'leave',
    })
  })
})

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
   * THE NOTICE, THROUGH THE FRONT DOOR. `notifier` is proven on its own above;
   * this is the wiring — that `handleLive` builds one at all, and builds it
   * against the SAME author and channel the verdict was made about rather than
   * a second reading of the live message that could disagree with it.
   */
  it('tells the poster which rule removed their message', async () => {
    const seam = notices()
    const message = live({ content: 'come play at 5.6.7.8.' })

    await handleLive(message, null, cfg(), liveActions({ notices: seam }))

    expect(message.delete).toHaveBeenCalledTimes(1)
    expect(seam.dm).toHaveBeenCalledWith(AUTHOR, expect.stringContaining('foreign-ip'))
  })

  it('tells nobody anything when nothing was removed', async () => {
    const seam = notices()

    await handleLive(live({ content: 'good game everyone' }), null, cfg(), liveActions({ notices: seam }))

    expect(seam.dm).not.toHaveBeenCalled()
    expect(seam.fallback).not.toHaveBeenCalled()
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

  /**
   * THE WIRING, WHICH NO ASSERTION ABOUT THE LINE ITSELF CAN REACH. Every case
   * above that reads the posted text builds the record by hand, so `snapshot`
   * could stop reading `message.author.username` altogether and all of them
   * would still pass with the mention in place and the name silently gone —
   * which is the failure that only shows up weeks later, in the log entry about
   * somebody who has since left the guild.
   */
  it('carries the username off the payload and into the log channel', async () => {
    const posted: string[] = []
    const message = live({ author: authorOf(AUTHOR, 'webhook_advert') })

    await handleLive(
      message,
      null,
      cfg({ logChannelId: LOG_CHANNEL }),
      liveActions({ announce: collect(posted) }),
    )

    expect(posted[0] ?? '').toContain(`<@${AUTHOR}>`)
    expect(posted[0] ?? '').toContain('webhook_advert')
  })

  it('still names the author when the payload brought no username', async () => {
    const posted: string[] = []
    const message = live({ author: authorOf(AUTHOR, null) })

    await handleLive(
      message,
      null,
      cfg({ logChannelId: LOG_CHANNEL }),
      liveActions({ announce: collect(posted) }),
    )

    expect(posted[0] ?? '').toContain(`Author <@${AUTHOR}>,`)
    expect(posted[0] ?? '').toContain('reason: foreign-invite')
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
      live({ member: null, guild, author: authorOf('123456789012345678') }),
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
    const first = authorOf('100000000000000001')

    await handleLive(live({ member: null, guild, author: first }), null, exempting, liveActions())

    for (let i = 0; i < 500; i++) {
      const author = authorOf(`2${String(i).padStart(17, '0')}`)
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

  /**
   * REGRESSION. `messageCreate` was the only listener; edits went unseen.
   *
   * TWO ON `messageCreate` AND ONE ON `messageUpdate`, AND THE ASYMMETRY IS THE
   * DESIGN. The scanner takes both, because an edited message has to be looked
   * at the way a new one is. The sticky takes only the first, because an edit is
   * not drift — nothing moved and nothing was pushed down, and counting one
   * would repost the sticky because somebody fixed a typo.
   */
  it('listens for edits as well as new messages, and sticks only to new ones', async () => {
    const client = createClient(cfg())

    expect(client.listenerCount(Events.MessageCreate)).toBe(2)
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

  /**
   * THE STICKY ENGINE IS INSTALLED, AND THAT IS THE GAP THIS CLOSES. The
   * commands were written against a module singleton that nothing set: `/sticky`
   * answered "the engine is not installed" in a bot with the feature fully
   * built. A null here is that bot.
   */
  it('installs the sticky engine, so /sticky has something to reach', async () => {
    const client = createClient(cfg())

    expect(stickies()).not.toBeNull()

    await client.destroy()
    setStickies(null)
  })

  /**
   * THE TWO `messageCreate` LISTENERS DO NOT KNOW ABOUT EACH OTHER, which is
   * what "the sticky must not interfere with invite scanning" means in practice.
   * A message with a foreign invite in it is still deleted with the counter
   * running beside it — and the sticky's own listener cannot be the reason a
   * delete does not happen, because it is a separate function that reads a
   * channel id and nothing else.
   */
  it('still scans a message for invites with the sticky counting the same one', async () => {
    const client = createClient(cfg())

    expect(stickies()).not.toBeNull()

    // The default `live()` carries `discord.gg/abc123`. Nothing here is logged
    // in, so the lookup fails and the code goes unresolved — which is a `leave`
    // and a journal line, and the journal line is the proof that the scanner
    // saw this message with the sticky's listener attached beside it.
    client.emit(Events.MessageCreate, asGateway(live()))

    await vi.waitFor(() => {
      expect(stderr.join('')).toContain('invite lookup failed')
    })

    await client.destroy()
    setStickies(null)
  })
})

/**
 * REGRESSION, AND THE ONE THE OWNER RAISED HIMSELF. Three lines arrived in
 * #bot-status across nine hours, identical, `level=warn msg="gateway
 * reconnecting" shard=0`, and he asked what they were and whether they could
 * stop. They could: Discord asks clients to reconnect as ordinary housekeeping,
 * three in nine hours is a healthy bot, and every one of them was asking him to
 * look at something that had already fixed itself.
 *
 * THE OTHER HALF IS THE POINT OF THIS BLOCK. Nothing detected the case that
 * does need him — a gateway that goes and does not come back — so the channel
 * was carrying the non-event and silent about the event. These cases pin both
 * ends: the routine reconnect says nothing at all, and an absence past
 * `GATEWAY_DOWN_MS` says something exactly once and then says when it is over.
 *
 * THE ALARM CANNOT BE DELIVERED WHILE IT IS TRUE, which is not a bug and is not
 * fixable from inside a Discord bot: while the gateway is down there is no
 * gateway to post over, the same gap `login failed` has. That is why the return
 * line carries the duration — it is the one line that does arrive, and it has
 * to say what happened while nobody could be told.
 */
describe('the gateway — a reconnect is not a fault, an absence is', () => {
  /**
   * Everything the sink is handed, as `level msg`.
   *
   * THROUGH THE REAL `log()` AND THE REAL SINK GATE, because "posts nothing to
   * the channel" is a claim about the level filter in log.ts and not about this
   * file's own idea of what a fault is. A test that inspected the journal lines
   * would pass just as well against a build that posted every one of them.
   */
  function watching(): string[] {
    const faults: string[] = []

    setSink((level, msg) => {
      faults.push(`${level} ${msg}`)
      return Promise.resolve()
    })

    return faults
  }

  /** A close event, reduced to the code — the only part either side reads. */
  const closed = (code: number): CloseEvent =>
    ({ code, reason: '', wasClean: false }) as unknown as CloseEvent

  it('posts nothing at all when a shard reconnects', async () => {
    const faults = watching()
    const client = createClient(cfg())

    client.emit(Events.ShardReconnecting, 0)

    expect(faults).toEqual([])
    // Still in the journal, for whoever is debugging a connection.
    expect(stdout.join('')).toContain('level=info msg="gateway reconnecting" shard=0')
    expect(stderr.join('')).toBe('')

    await client.destroy()
  })

  it('posts nothing when the gateway comes back promptly', async () => {
    vi.useFakeTimers()

    const faults = watching()
    const client = createClient(cfg())

    try {
      client.emit(Events.ShardReconnecting, 0)
      await vi.advanceTimersByTimeAsync(3_000)
      client.emit(Events.ShardResume, 0, 12)

      // Long past the window, to prove the clock was stopped and not merely
      // not yet reached.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

      expect(faults).toEqual([])
      expect(stderr.join('')).toBe('')
    } finally {
      vi.useRealTimers()
      await client.destroy()
    }
  })

  it('warns exactly once when the gateway does not come back', async () => {
    vi.useFakeTimers()

    const faults = watching()
    const client = createClient(cfg())

    try {
      client.emit(Events.ShardReconnecting, 0)

      await vi.advanceTimersByTimeAsync(59_000)
      expect(faults).toEqual([])

      await vi.advanceTimersByTimeAsync(2_000)
      expect(faults).toEqual(['warn gateway has not come back'])
      expect(stderr.join('')).toContain('msg="gateway has not come back" shard=0 seconds=60')

      // An hour more of it, and still one alarm. The window is a threshold
      // crossed once, not a heartbeat: a warning every minute for an outage
      // nobody can be told about is the same training in reverse.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(faults).toEqual(['warn gateway has not come back'])
    } finally {
      vi.useRealTimers()
      await client.destroy()
    }
  })

  it('runs the clock from the first loss rather than from each retry', async () => {
    // THE CASE THIS EXISTS FOR. discord.js emits `shardReconnecting` once per
    // attempt, so a shard retrying every twenty seconds forever would, on a
    // clock restarted by each attempt, never reach the window at all — the
    // outage that most needs saying would be the one that never got said.
    vi.useFakeTimers()

    const faults = watching()
    const client = createClient(cfg())

    try {
      client.emit(Events.ShardReconnecting, 0)

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await vi.advanceTimersByTimeAsync(20_000)
        client.emit(Events.ShardReconnecting, 0)
      }

      // Sixty seconds after the first loss, not after the latest attempt.
      expect(faults).toEqual(['warn gateway has not come back'])
      expect(stderr.join('')).toContain('seconds=60')

      // AND STILL ONE AN HOUR LATER, which is the half that catches the other
      // way of getting this wrong: a clock that is restarted per attempt but
      // leaves the abandoned windows armed still crosses the first one on time,
      // and then warns again for every attempt after it.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(faults).toEqual(['warn gateway has not come back'])
    } finally {
      vi.useRealTimers()
      await client.destroy()
    }
  })

  it('says the gateway is back, and how long it was gone, once it has warned', async () => {
    vi.useFakeTimers()

    const faults = watching()
    const client = createClient(cfg())

    try {
      client.emit(Events.ShardReconnecting, 0)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

      expect(faults).toEqual(['warn gateway has not come back'])

      client.emit(Events.ShardReady, 0, undefined)

      expect(faults).toEqual(['warn gateway has not come back', 'warn gateway is back'])

      // THE WHOLE OUTAGE AND NOT THE WINDOW. This is the line that actually
      // reaches the channel — the warning above was raised while there was no
      // gateway to post it over — so `seconds` has to be how long the bot was
      // really off Discord, not the threshold it crossed on the way.
      expect(stderr.join('')).toContain('msg="gateway is back" shard=0 seconds=300')
    } finally {
      vi.useRealTimers()
      await client.destroy()
    }
  })

  it('takes a resumed session as the gateway being back', async () => {
    // A shard that resumes its old session emits `shardResume` and never emits
    // `shardReady` at all, so listening for only the second would leave the
    // fastest recovery there is looking permanently down.
    vi.useFakeTimers()

    const faults = watching()
    const client = createClient(cfg())

    try {
      client.emit(Events.ShardReconnecting, 0)
      await vi.advanceTimersByTimeAsync(90_000)
      client.emit(Events.ShardResume, 0, 3)

      expect(faults).toEqual(['warn gateway has not come back', 'warn gateway is back'])
      expect(stderr.join('')).toContain('msg="gateway is back" shard=0 seconds=90')
    } finally {
      vi.useRealTimers()
      await client.destroy()
    }
  })

  it('says nothing about a return that no alarm was raised about', async () => {
    // The ordinary case, and the reason the return line is not itself noise: a
    // gateway that came back inside the window has nothing to clear.
    const faults = watching()
    const client = createClient(cfg())

    client.emit(Events.ShardReady, 0, undefined)
    client.emit(Events.ShardResume, 0, 1)

    expect(faults).toEqual([])
    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toBe('')

    await client.destroy()
  })

  /**
   * NOT DEMOTED WITH THE RECONNECT, AND THE NAME IS THE TRAP. `shardDisconnect`
   * sounds like the other half of a routine reconnect and in discord.js v14 it
   * is the opposite: it is emitted only for the close codes the library lists
   * as unrecoverable — 4004 a bad token, 4013 and 4014 an intent that is not
   * granted — and every close it will retry goes out as `shardReconnecting`
   * instead. So this event means the shard will never come back on its own, and
   * it is exactly what the channel is for.
   */
  it('still warns about a disconnect, which is the shard never coming back', async () => {
    const faults = watching()
    const client = createClient(cfg())

    client.emit(Events.ShardDisconnect, closed(4014), 0)

    expect(faults).toEqual(['warn gateway disconnected'])
    expect(stderr.join('')).toContain('msg="gateway disconnected" shard=0 code=4014')

    await client.destroy()
  })

  it('raises one alarm, not two, when a retrying shard is refused outright', async () => {
    // A shard can be part-way through reconnecting when the identify comes back
    // refused. The disconnect names the cause; a line a minute later saying it
    // has not come back adds nothing to a line that already says it never will.
    vi.useFakeTimers()

    const faults = watching()
    const client = createClient(cfg())

    try {
      client.emit(Events.ShardReconnecting, 0)
      await vi.advanceTimersByTimeAsync(10_000)
      client.emit(Events.ShardDisconnect, closed(4014), 0)

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

      expect(faults).toEqual(['warn gateway disconnected'])
    } finally {
      vi.useRealTimers()
      await client.destroy()
    }
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

    // Two: the scanner and the sticky's counter. Both go, and the sticky's
    // going is right rather than collateral — a bot that is not in its
    // configured guild registers no commands either, so there is nothing left
    // to stick and nothing that could take one down.
    expect(client.listenerCount(Events.MessageCreate)).toBe(2)

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
    await mod.handleLive(message, null, cfg(), liveActions({ resolve }))

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

    await mod.handleLive(partial, null, cfg(), liveActions({ resolve }))

    expect(partial.fetch).not.toHaveBeenCalled()
    expect(partial.delete).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('carries on moderating when the configured guild is there', async () => {
    const mod = await freshModule()
    const client = mod.createClient(cfg())

    client.emit(Events.ClientReady, readyPayload([OURS, OTHER_GUILD]))

    expect(stdout.join('')).toContain('msg="ready"')
    expect(client.listenerCount(Events.MessageCreate)).toBe(2)
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

  /**
   * A HEADER THAT DESCRIBES THE OPPOSITE OF WHAT THE FILE DOES IS WORSE THAN NO
   * HEADER. This one said "THE BOT NEVER TALKS TO MEMBERS. No DM, no reply" and
   * called it a standing instruction from the owner — which it was, until he
   * replaced it. Anybody reading the file to find out whether a notice was
   * deliberate would have been told, in capitals, that it could not exist.
   */
  it('no longer claims the bot never talks to members', async () => {
    const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8')
    const header = source.slice(0, source.indexOf('export interface ScannedMessage'))

    expect(header).not.toContain('THE BOT NEVER TALKS TO MEMBERS')
    expect(header).toMatch(/which rule/i)
    expect(header).toContain('PLACEHOLDER')
  })
})

/**
 * The status channel: the bot's own faults, where somebody will see them.
 *
 * THE RULE THIS SERVES IS THE OWNER'S, VERBATIM — "there should be no cli
 * interactions with the bot or its data". A failed delete, a rate limit, an
 * unusable log channel and an unexpected exception all reached journalctl and
 * stopped there, which for this owner means they reached nobody.
 *
 * NOTHING HERE TOUCHES DISCORD, for the same reason nothing else in this file
 * does. `statusReporter` reads three things off a client — `isReady`,
 * `channels.fetch` and the channel's `send` — and every one of those is
 * answered by the fake below, including the answers a real Discord only gives
 * when something is already broken.
 *
 * THE CASES ARE THE FIVE WAYS THIS FEATURE BREAKS A LIVE BOT: a fault loop, a
 * flood, a secret in a public-ish channel, noise on every restart, and an async
 * failure raised where nothing can catch it. The first and the last are tested
 * in log.test.ts, where the hook is; the middle three are here, where the
 * posting is.
 */
const STATUS_CHANNEL = '999999999999999999'

/**
 * A client with one status channel behind it, and a record of what reached it.
 *
 * `hold` KEEPS EVERY SEND PENDING until `open()` is called, which is the only
 * way to observe a backlog: the reporter serialises its posts, so a queue only
 * exists while Discord is slow.
 *
 * `ready()` IS THE GATEWAY COMING UP, and it is a second thing entirely from
 * `open()`. `statusReporter` reads `isReady()` and registers a `clientReady`
 * listener of its own, because faults raised on the way up are held rather than
 * dropped; this is what lets a case start disconnected, raise a fault, connect,
 * and watch what the channel gets. Starting `ready: false` and never calling
 * this is a start that never reaches Discord at all.
 */
function statusHarness(
  options: {
    ready?: boolean
    sendable?: boolean
    missing?: boolean
    hold?: boolean
    fetchRejects?: unknown
    sendRejects?: unknown
    editRejects?: unknown
  } = {},
): {
  client: Client
  send: Mock<(payload: { content: string; allowedMentions: unknown }) => Promise<unknown>>
  sent: string[]
  edited: string[]
  fetched: string[]
  open: () => void
  ready: () => void
} {
  const sent: string[] = []
  const edited: string[] = []
  const fetched: string[] = []

  let open = (): void => {}
  const gate =
    options.hold === true
      ? new Promise<void>((resolve) => {
          open = resolve
        })
      : Promise.resolve()

  const send = vi.fn(async (payload: { content: string; allowedMentions: unknown }) => {
    await gate
    if (options.sendRejects !== undefined) throw options.sendRejects
    sent.push(payload.content)

    return {
      edit: (content: string): Promise<unknown> => {
        if (options.editRejects !== undefined) return Promise.reject(options.editRejects)
        edited.push(content)
        return Promise.resolve({})
      },
    }
  })

  let connected = options.ready ?? true
  const waiting: (() => void)[] = []

  const client = {
    isReady: () => connected,
    once: (event: unknown, handler: () => void) => {
      if (event === Events.ClientReady) waiting.push(handler)
    },
    channels: {
      // The id is recorded rather than ignored: which channel this bot posts
      // its health to is a decision — BLITZ_STATUS_CHANNEL_ID and not
      // BLITZ_LOG_CHANNEL_ID — and a fake that answers whatever it is asked
      // cannot tell the two apart.
      fetch: (id: string) => {
        fetched.push(id)
        if (options.fetchRejects !== undefined) return Promise.reject(options.fetchRejects)
        if (options.missing === true) return Promise.resolve(null)
        return Promise.resolve({ isSendable: () => options.sendable ?? true, send })
      },
    },
  } as unknown as Client

  // `isReady()` is already true by the time discord.js emits `clientReady`,
  // which is the fact the reporter's gate depends on, so the fake sets it
  // before it calls anybody.
  const ready = (): void => {
    connected = true
    for (const handler of waiting.splice(0, waiting.length)) handler()
  }

  return { client, send, sent, edited, fetched, open, ready }
}

/** A rendered line, of the shape `log()` hands a sink. */
const line = (msg: string, fields = ''): string =>
  `2026-08-30T00:00:00.000Z level=error msg="${msg}"${fields === '' ? '' : ` ${fields}`}`

/** Let the fire-and-forget half of `log()` finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** One captured post, or a loud failure rather than an undefined comparison. */
function at(posts: string[], index: number): string {
  const value = posts[index]
  if (value === undefined) throw new Error(`nothing was posted at index ${index}`)
  return value
}

describe('statusReporter — which faults reach the channel at all', () => {
  it('posts a warning and an error', async () => {
    const { client, sent } = statusHarness()
    const report = statusReporter(client, STATUS_CHANNEL)

    await report('warn', 'gateway disconnected', line('gateway disconnected'))
    await report('error', 'delete failed, message left standing', line('delete failed'))

    expect(sent).toHaveLength(2)
    expect(at(sent, 0)).toContain('gateway disconnected')
    expect(at(sent, 1)).toContain('delete failed')
  })

  /**
   * THE FILTER IS IN log.ts AND THIS IS THE PROOF IT IS WIRED. A status channel
   * that also carries `ready` and a line per removal is a running commentary,
   * and the only reason the channel is worth reading is that everything in it
   * needs a person.
   */
  it('posts nothing for an info, all the way through log()', async () => {
    const { client, sent } = statusHarness()
    setSink(statusReporter(client, STATUS_CHANNEL))

    log('info', 'ready', { guild: 'Blitz Royale' })
    await settle()

    expect(sent).toEqual([])
  })

  /**
   * NOTHING POSTS ON A CLEAN START. index.ts installs the sink before it logs
   * in — deliberately, so that the halt line emitted during `clientReady` still
   * lands — so the thing that keeps a restart quiet is this gate and not the
   * order two listeners were registered in. The bot restarts on every deploy
   * and every crash; a channel that says something each time is one nobody
   * reads.
   */
  it('posts nothing before the client is ready', async () => {
    const { client, sent, send } = statusHarness({ ready: false })
    setSink(statusReporter(client, STATUS_CHANNEL))

    log('error', 'login failed', { error: new Error('An invalid token was provided.') })
    await settle()

    expect(send).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    // The journal is the floor and is unaffected by any of this.
    expect(stderr.join('')).toContain('msg="login failed"')
  })

  /**
   * The same suppression `announcer` states at its own send. A rendered line
   * can carry an id a stranger chose — an invite code, a webhook's name — and
   * nothing this bot posts is allowed to notify anybody.
   */
  it('suppresses every mention on the send', async () => {
    const { client, send } = statusHarness()

    await statusReporter(client, STATUS_CHANNEL)('error', 'client error', line('client error'))

    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining('client error') as unknown as string,
      allowedMentions: { parse: [] },
    })
  })
})

/**
 * REGRESSION, AND THE WORST KIND: the faults that mean "the bot is not running"
 * were the only ones the channel could never carry.
 *
 * An adversarial pass proved it end to end. The sink gated on
 * `client.isReady()` and RETURNED, so every fault raised on the way up — a
 * gateway close on an intent that is not ticked on in the developer portal, a
 * `client error` thrown while connecting, anything at all before `clientReady`
 * — wrote its journal line and posted nothing. Journal 1, channel 0, for the
 * most important thing this bot can say.
 *
 * THE GATE IS STILL THERE AND IS STILL RIGHT: there is no channel to fetch
 * before the gateway is up. What changed is that the fault is HELD and flushed
 * by the same event that makes posting possible.
 */
describe('statusReporter — faults raised before the gateway was up', () => {
  it('holds a fault raised before ready and posts it once the gateway comes up', async () => {
    const { client, sent, send, ready } = statusHarness({ ready: false })
    setSink(statusReporter(client, STATUS_CHANNEL))

    log('warn', 'gateway disconnected', { shard: 0, code: 4014 })
    await settle()

    expect(send).not.toHaveBeenCalled()

    ready()
    await settle()

    expect(sent).toHaveLength(1)
    expect(at(sent, 0)).toContain('gateway disconnected')
    expect(at(sent, 0)).toContain('code=4014')
  })

  it('flushes them in the order they happened', async () => {
    const { client, sent, ready } = statusHarness({ ready: false })
    const report = statusReporter(client, STATUS_CHANNEL)

    await report('error', 'client error', line('client error'))
    await report('warn', 'gateway reconnecting', line('gateway reconnecting'))

    ready()
    await settle()

    expect(sent).toHaveLength(2)
    expect(at(sent, 0)).toContain('client error')
    expect(at(sent, 1)).toContain('gateway reconnecting')
  })

  /**
   * BOUNDED, because a start that is going wrong can raise faults as fast as
   * the event loop turns and there is nothing draining this until the gateway
   * is up — which, in the case that matters, it never is.
   *
   * THE FIRST ONES ARE THE ONES KEPT, which is the opposite of the eviction
   * rule for `seen`. A bad start produces one cause and then a run of
   * consequences; the cause is the line worth having, and there is no "still
   * happening" to preserve because none of this has been posted yet.
   */
  it('bounds what it holds, and keeps the earliest faults', async () => {
    const { client, sent, ready } = statusHarness({ ready: false })
    const report = statusReporter(client, STATUS_CHANNEL)

    for (let i = 0; i < 200; i += 1) {
      await report('error', `fault ${i}`, line(`fault ${i}`))
    }

    ready()
    await settle()

    expect(sent).toHaveLength(20)
    expect(at(sent, 0)).toContain('fault 0')
    expect(at(sent, 19)).toContain('fault 19')
  })

  /**
   * THE IRREDUCIBLE CASE, WRITTEN DOWN AS A TEST SO IT IS NOT MISTAKEN FOR A
   * BUG LATER. A login that never succeeds — a revoked token, an intent the
   * portal does not grant — has no gateway, so there is no channel and nothing
   * inside a Discord bot can report it over Discord. index.ts writes the line
   * and exits; systemd restarts; the evidence is `journalctl -u blitz-bot -p
   * warning` and nowhere else.
   *
   * WHAT IS ASSERTED IS THAT IT COSTS NOTHING: no request, and no floating
   * promise to reject into a process that is on its way out. The sink answers
   * an already-resolved promise, so a held fault is dropped with the process
   * rather than turning into an unhandled rejection during shutdown.
   */
  it('drops what it is holding when ready never comes, without a pending promise', async () => {
    const { client, send } = statusHarness({ ready: false })
    const report = statusReporter(client, STATUS_CHANNEL)

    const rejections: unknown[] = []
    const record = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', record)

    try {
      const held = report('error', 'login failed', line('login failed'))
      await expect(held).resolves.toBeUndefined()

      // Two turns of the loop: an unhandled rejection is reported at the end of
      // one, so a promise left hanging here would have surfaced by now.
      await settle()
      await settle()
    } finally {
      process.off('unhandledRejection', record)
    }

    expect(send).not.toHaveBeenCalled()
    expect(rejections).toEqual([])
  })
})

/**
 * The flood, which is the failure that hurts most at the worst moment.
 *
 * AN ERROR REPEATING SIXTY TIMES A MINUTE buries the channel exactly when it
 * matters, and spends the bot's rate limit doing it. The first occurrence
 * posts; identical ones inside the window edit that message and add a count.
 */
describe('statusReporter — a repeat edits rather than posts', () => {
  it('folds an identical fault into an edit that carries a count', async () => {
    vi.useFakeTimers()

    try {
      vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'))

      const { client, sent, edited } = statusHarness()
      const report = statusReporter(client, STATUS_CHANNEL)

      await report('error', 'delete failed', line('delete failed'))
      await report('error', 'delete failed', line('delete failed'))
      await report('error', 'delete failed', line('delete failed'))

      // One message, and the first repeat written straight away: an occasional
      // repeat behaves exactly as it did before the edits were throttled.
      expect(sent).toHaveLength(1)
      expect(edited).toHaveLength(1)
      expect(at(edited, 0)).toContain('seen 2 times')

      // The third happened inside the throttle window, so it is folded in
      // memory and written by the trailing flush rather than by a request of
      // its own.
      await vi.advanceTimersByTimeAsync(60_000)

      expect(edited).toHaveLength(2)
      expect(at(edited, 1)).toContain('seen 3 times')
      // A last-seen time, so a fault that stopped an hour ago is
      // distinguishable from one still happening.
      expect(at(edited, 1)).toMatch(/last \d{4}-\d{2}-\d{2}T[\d:.]+Z/)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * COALESCING COLLAPSED THE CHANNEL AND LEFT THE API TRAFFIC WHERE IT WAS, and
   * that was half of flood control missing rather than a detail of it. Five
   * hundred occurrences of one fault produced one message and ~500 PATCH edits
   * — one Discord request per occurrence, the whole rate limit spent keeping a
   * number up to date, at the moment the bot is already failing as fast as it
   * can.
   *
   * THE VISIBLE BEHAVIOUR IS THE SAME. One message, a count on it, a last-seen
   * time, and the final number is the true one. What changed is the number of
   * requests it cost.
   */
  it('spends a handful of requests on a fault storm, not one per occurrence', async () => {
    vi.useFakeTimers()

    try {
      vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'))

      const { client, sent, edited, send } = statusHarness()
      const report = statusReporter(client, STATUS_CHANNEL)

      for (let i = 0; i < 500; i += 1) {
        await report('error', 'delete failed', line('delete failed'))
      }

      expect(send).toHaveBeenCalledTimes(1)
      expect(edited).toHaveLength(1)

      // A second of it buys nothing. Every one of those 500 occurrences used to
      // be its own request.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(edited).toHaveLength(1)

      // The trailing flush is what makes the count true rather than whatever it
      // happened to be when the throttle last let an edit through.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(edited).toHaveLength(2)
      expect(at(edited, 1)).toContain('seen 500 times')

      // THE NUMBER, STATED. Three Discord requests for five hundred faults.
      expect(sent.length + edited.length).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * THROTTLING THE EDITS MUST NOT DELAY A NEW FAULT. The whole point of the
   * channel is that something appearing in it needs a person, and a fault
   * nobody has seen before is the thing most worth seeing promptly. Only
   * repeats of something already posted wait.
   */
  it('posts a distinct fault immediately, mid-storm', async () => {
    vi.useFakeTimers()

    try {
      vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'))

      const { client, sent } = statusHarness()
      const report = statusReporter(client, STATUS_CHANNEL)

      for (let i = 0; i < 500; i += 1) {
        await report('error', 'delete failed', line('delete failed'))
      }

      await report('error', 'client error', line('client error'))

      // No timer advanced, and it is already in the channel.
      expect(sent).toHaveLength(2)
      expect(at(sent, 1)).toContain('client error')
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * IDENTITY IS THE MESSAGE AND THE LEVEL, NOT THE RENDERED LINE. Two failed
   * deletes differ in their message id, their channel and their timestamp and
   * are the same fault; keying on the whole line would post one message per
   * occurrence and coalesce nothing at all, which is the bug this exists to
   * avoid rather than a detail of it.
   */
  it('treats the same failure about two different messages as one fault', async () => {
    const { client, sent, edited } = statusHarness()
    const report = statusReporter(client, STATUS_CHANNEL)

    await report('error', 'delete failed', line('delete failed', 'channel="111" author="222"'))
    await report('error', 'delete failed', line('delete failed', 'channel="333" author="444"'))

    expect(sent).toHaveLength(1)
    expect(edited).toHaveLength(1)
    // The body stays the first occurrence's. Rewriting it would change which
    // channel the entry names while the count claims it happened twice.
    expect(at(edited, 0)).toContain('channel="111"')
  })

  it('keeps different faults apart', async () => {
    const { client, sent, edited } = statusHarness()
    const report = statusReporter(client, STATUS_CHANNEL)

    await report('error', 'delete failed', line('delete failed'))
    await report('error', 'client error', line('client error'))
    await report('warn', 'delete failed', line('delete failed'))

    expect(sent).toHaveLength(3)
    expect(edited).toEqual([])
  })

  /**
   * THE WINDOW IS MEASURED FROM THE FIRST POST, so a fault that never stops
   * produces a fresh message every five minutes instead of one message quietly
   * edited for a week. A channel that looks idle while the bot is on fire is
   * the thing being avoided.
   */
  it('posts fresh once the window has closed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      const start = new Date('2026-08-30T00:00:00.000Z')
      vi.setSystemTime(start)

      const { client, sent, edited } = statusHarness()
      const report = statusReporter(client, STATUS_CHANNEL)

      await report('error', 'delete failed', line('delete failed'))
      await report('error', 'delete failed', line('delete failed'))

      vi.setSystemTime(new Date(start.getTime() + 6 * 60 * 1000))
      await report('error', 'delete failed', line('delete failed'))

      expect(sent).toHaveLength(2)
      expect(edited).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * BOUNDED, BECAUSE THIS PROCESS RUNS FOR MONTHS. One entry per distinct fault
   * text, each holding a discord.js `Message`, is a memory leak the day a log
   * line starts carrying an id in its `msg`. Eviction costs only the
   * coalescing.
   */
  it('remembers a bounded number of faults and evicts the oldest', async () => {
    const { client, sent, edited } = statusHarness()
    const report = statusReporter(client, STATUS_CHANNEL)

    // One more than it can hold. `fault 0` is the oldest and is the one pushed
    // out; `fault 50` was the most recent and must still be there.
    for (let i = 0; i <= 50; i += 1) {
      await report('error', `fault ${i}`, line(`fault ${i}`))
    }

    expect(sent).toHaveLength(51)
    expect(edited).toEqual([])

    await report('error', 'fault 50', line('fault 50'))
    expect(edited).toHaveLength(1)

    await report('error', 'fault 0', line('fault 0'))
    expect(sent).toHaveLength(52)
    expect(edited).toHaveLength(1)
  })

  /**
   * THE BACKLOG IS BOUNDED TOO. Coalescing happens at the front of the queue,
   * so a burst of DISTINCT faults still queues one post each — and a Discord
   * that is answering slowly is exactly when a burst arrives. What is dropped
   * is the channel copy of a fault whose journal line was already written.
   */
  it('drops what it cannot keep up with rather than queueing without limit', async () => {
    const { client, sent, open } = statusHarness({ hold: true })
    const report = statusReporter(client, STATUS_CHANNEL)

    const pending: Promise<void>[] = []
    for (let i = 0; i < 40; i += 1) {
      pending.push(report('error', `fault ${i}`, line(`fault ${i}`)))
    }

    open()
    await Promise.all(pending)

    expect(sent).toHaveLength(20)
  })
})

describe('statusReporter — a channel that cannot be posted to', () => {
  /**
   * SAY IT ONCE, THEN STOP. A wrong id, a deleted channel or a missing
   * permission does not get better by being retried, and retrying costs a
   * journal line and a failed request per fault for as long as the process
   * lives — worst when the bot is already producing faults quickly.
   */
  it('says the channel is unusable exactly once and then stops trying', async () => {
    const { client, send } = statusHarness({ sendable: false })
    const report = statusReporter(client, STATUS_CHANNEL)

    await report('error', 'delete failed', line('delete failed'))
    await report('error', 'client error', line('client error'))
    await report('warn', 'gateway disconnected', line('gateway disconnected'))

    expect(send).not.toHaveBeenCalled()

    const said = stderr.join('').split('status channel unusable').length - 1
    expect(said).toBe(1)
    expect(stderr.join('')).toContain(`channel="${STATUS_CHANNEL}"`)
  })

  it('gives up the same way when the id names no channel', async () => {
    const { client } = statusHarness({ missing: true })

    await statusReporter(client, STATUS_CHANNEL)('error', 'client error', line('client error'))

    expect(stderr.join('')).toContain('status channel unusable')
  })

  it('gives up when the bot has no permission to post there', async () => {
    const refused = new DiscordAPIError(
      { code: RESTJSONErrorCodes.MissingPermissions, message: 'Missing Permissions' },
      RESTJSONErrorCodes.MissingPermissions,
      403,
      'POST',
      'https://discord.com/api/v10/channels/0/messages',
      {},
    )

    const { client, send } = statusHarness({ sendRejects: refused })
    const report = statusReporter(client, STATUS_CHANNEL)

    await report('error', 'client error', line('client error'))
    await report('error', 'delete failed', line('delete failed'))

    expect(stderr.join('')).toContain('status channel unusable')
    expect(send).toHaveBeenCalledTimes(1)
  })

  /**
   * A RATE LIMIT IS NOT A REASON TO GIVE UP FOREVER. Latching on a transient
   * failure would turn a bad ten seconds into a bot that reports nothing until
   * the next restart, which is the failure this whole feature exists to stop.
   *
   * NOR IS IT A REASON TO ASK FOR A HUMAN, which is why the line it writes is
   * `info`. The next fault tries again, discord.js queues behind a rate limit
   * on its own, and nobody can do anything about a 500 at Discord's end; the
   * line is for whoever is working out why a fault they expected never showed
   * up in the channel. The permanent case latches at error, one line up.
   */
  it('keeps trying after a transient failure', async () => {
    const { client, send } = statusHarness({ sendRejects: new Error('rate limited') })
    const report = statusReporter(client, STATUS_CHANNEL)

    await report('error', 'client error', line('client error'))
    await report('error', 'delete failed', line('delete failed'))

    expect(send).toHaveBeenCalledTimes(2)
    expect(stdout.join('')).toContain('level=info msg="could not post to the status channel"')
    expect(stderr.join('')).not.toContain('status channel unusable')
  })

  /**
   * An edit that fails means the message is gone — deleted by an admin tidying
   * up, most likely. Forgetting the entry is what stops the reporter editing a
   * dead message for the rest of the window.
   *
   * AND THAT REPAIR IS WHY THE LINE IS `info`. All that was lost is a repeat
   * count; the next occurrence posts a fresh message, which is what happens
   * once the window closes in any case. Nobody has to do anything about it.
   */
  it('forgets a message it could not edit, so the next occurrence posts fresh', async () => {
    const { client, sent } = statusHarness({ editRejects: new Error('Unknown Message') })
    const report = statusReporter(client, STATUS_CHANNEL)

    await report('error', 'delete failed', line('delete failed'))
    await report('error', 'delete failed', line('delete failed'))
    await report('error', 'delete failed', line('delete failed'))

    expect(sent).toHaveLength(2)
    expect(stdout.join('')).toContain('level=info msg="could not update the status channel message"')
  })
})

/**
 * What is allowed to leave the process.
 *
 * THE TOKEN IS THE ONE THAT MATTERS. #bot-status is admin-only in this guild,
 * which is one permission overwrite away from not being, and this application's
 * credentials are shared with the Ringmaster console — so a token in a message
 * is not a leak of one bot. The sink is a general hook on every warning and
 * error the bot will ever emit, including the ones nobody has written yet.
 */
describe('statusReporter — what never reaches the channel', () => {
  // Assembled from parts on purpose. A literal Discord-token-shaped string in a
  // source file trips GitHub push protection and blocks the push, even for a
  // fixture that was never a real credential. The redactor under test sees the
  // same bytes either way, so nothing here is weakened to get past a scanner.
  const TOKEN = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GaBcDe", "abcdefghijklmnopqrstuvwxyz0123"].join('.')

  it('posts neither a request url nor anything shaped like a token', async () => {
    const { client, sent } = statusHarness()
    setSink(statusReporter(client, STATUS_CHANNEL))

    log('error', 'client error', {
      error: new Error(
        `request to https://discord.com/api/webhooks/123/secret failed, authorization ${TOKEN}`,
      ),
    })
    await settle()

    expect(at(sent, 0)).not.toContain(TOKEN)
    expect(at(sent, 0)).not.toContain('discord.com')
    expect(at(sent, 0)).toContain('[url]')
    expect(at(sent, 0)).toContain('[redacted]')
    // The fault itself still arrives; it is the payload that was cut.
    expect(at(sent, 0)).toContain('msg="client error"')
  })

  /**
   * THE REAL PATH, NOT A CONSTRUCTED LINE. A failed delete names the channel
   * and the author and never what was said — that is a property of the call
   * site in `handleMessage`, and it is the one thing on the secrets list a
   * reviewer of a new log line has to check by hand, so it gets a test that
   * goes through the call site.
   */
  it('names the channel and the author of a failed delete, and not the message', async () => {
    const { client, sent } = statusHarness()
    setSink(statusReporter(client, STATUS_CHANNEL))

    const acts = actions({ remove: () => Promise.reject(new Error('Missing Permissions')) })
    await handleMessage(msg({ text: 'join us at discord.gg/abc123 you losers' }), cfg(), acts)
    await settle()

    expect(at(sent, 0)).toContain(`channel="${CHANNEL}"`)
    expect(at(sent, 0)).toContain(`author="${AUTHOR}"`)
    expect(at(sent, 0)).not.toContain('you losers')
    expect(at(sent, 0)).not.toContain('join us at')
  })

  /**
   * A post over 2000 characters is refused outright by Discord, which would
   * turn a long fault into a fault that never gets reported.
   */
  it('caps the line so the post cannot be refused for its length', async () => {
    const { client, sent } = statusHarness()

    await statusReporter(client, STATUS_CHANNEL)(
      'error',
      'invite scan capped',
      line('invite scan capped', `codes="${'x'.repeat(4000)}"`),
    )

    expect(at(sent, 0).length).toBeLessThan(2000)
    expect(at(sent, 0)).toContain('…')
  })

  /**
   * THE SAME CAP, MEASURED IN THE UNITS DISCORD COUNTS. This is the fault
   * `fitEmbed` had and the one profile.ts's limits block is written around: the
   * 2000 applies to the JSON string as it arrives, which is UTF-16, so counting
   * CODE POINTS understates every astral character by half. 1800 musical
   * symbols measured 1800 against a 1800 cap and reached Discord as 3600 units
   * inside a fence — a 50035 on the send, which is a fault that never got
   * reported at all, which is precisely what the cap exists to prevent.
   *
   * IT IS ONLY REACHABLE THROUGH SOMEBODY ELSE'S TEXT — a webhook's name, an
   * error message reflected back — which is why nothing tripped over it by
   * accident. `redact` is exactly where a hostile value is handled.
   */
  it('caps the line in UTF-16 units, so astral text cannot get the post refused', async () => {
    const { client, sent } = statusHarness()

    // 1800 code points, 3600 UTF-16 units: under a code-point cap of 1800 and
    // twice it in the units the 2000 is checked against.
    await statusReporter(client, STATUS_CHANNEL)(
      'error',
      'invite scan capped',
      line('invite scan capped', `codes="${'𝄞'.repeat(1800)}"`),
    )

    expect(at(sent, 0).length).toBeLessThan(2000)
    expect(at(sent, 0)).toContain('…')
  })

  /** And a cut that lands mid-character is half a symbol in the channel. The
   * measurement is UTF-16; the cut is still on a code-point boundary. */
  it('cuts where a character ends, never inside a surrogate pair', async () => {
    const { client, sent } = statusHarness()

    await statusReporter(client, STATUS_CHANNEL)(
      'error',
      'invite scan capped',
      line('invite scan capped', `codes="${'𝄞'.repeat(1800)}"`),
    )

    // A lone surrogate is what a mid-pair slice leaves behind, and it survives
    // JSON and the gateway as U+FFFD rather than as an error anybody sees.
    for (const unit of at(sent, 0)) {
      const code = unit.codePointAt(0) ?? 0
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false)
    }
  })

  /**
   * The body is fenced, and that is a neutraliser rather than styling: inside a
   * fence Discord renders `*`, `_`, `@everyone` and `<@id>` literally, links
   * nothing and pings nobody. A backtick in the line would close the fence, so
   * backticks do not survive.
   */
  it('fences the line, and nothing in the line can close the fence', async () => {
    const { client, sent } = statusHarness()

    await statusReporter(client, STATUS_CHANNEL)(
      'warn',
      'author roles could not be fetched',
      line('author roles could not be fetched', 'author="```@everyone"'),
    )

    expect(at(sent, 0).startsWith('```\n')).toBe(true)
    expect(at(sent, 0).endsWith('\n```')).toBe(true)
    expect(at(sent, 0).split('```')).toHaveLength(3)
  })

  /**
   * THE OTHER HALF OF THE DEPLOY NOTICE'S DISTINCTION, ASSERTED HERE SO THAT
   * OPENING ONE PATH CANNOT QUIETLY OPEN THIS ONE. The notice renders a masked
   * link on purpose — see the deploy-notice cases — and this is the same
   * markup, arriving in the same channel, from a value somebody else chose. It
   * is fenced, so the markdown is inert, and the url is `[url]` before the
   * fence is even reached. What decides that is where the text came from, never
   * which channel it is going to.
   */
  it('still fences a fault, and its markdown is inert whatever it carries', async () => {
    const { client, sent } = statusHarness()

    await statusReporter(client, STATUS_CHANNEL)(
      'warn',
      'author roles could not be fetched',
      line('author roles could not be fetched', 'author="[click](https://evil.example/x)"'),
    )

    const posted = at(sent, 0)

    // Fenced, so `[click](…)` is text rather than a link a reader can follow.
    expect(posted.startsWith('```\n')).toBe(true)
    expect(posted.endsWith('\n```')).toBe(true)

    // And the url never got as far as the fence.
    expect(posted).toContain('[url]')
    expect(posted).not.toContain('evil.example')
  })
})

/**
 * The deploy notice: which commit this process is running.
 *
 * WHAT THE OWNER ASKED FOR — "when an update is installed I expect a message in
 * the log channel telling us which commit it's running now" — and the whole
 * difficulty is the half he did not have to say. `Restart=always` starts this
 * process again five seconds after every crash, so a notice on every start is a
 * channel full of "running abc1234" arriving on top of the faults explaining
 * the crash, and the owner has a standing rule against unsolicited text. So the
 * cases below are mostly cases where it must say NOTHING.
 *
 * THE MEMORY IS THE OTHER HALF. It has to survive a restart, and it must not be
 * a file the updater can overwrite — /opt/blitz-bot is the directory the
 * updater resets, and the bot's own state lives in the unit's
 * `StateDirectory=` instead. That is asserted here as a property of the paths
 * rather than left to docs/deploy.md.
 */
const DEPLOYED = 'a1b2c3d'
const PREVIOUS = 'deadbee'

/**
 * The notice, in the owner's words, WRITTEN OUT HERE.
 *
 * NOT IMPORTED FROM client.ts, WHICH IS THE POINT OF SPELLING IT OUT. A case
 * that built its expectation with the same function under test would pass
 * against any wording at all — including one that lost the link, which is the
 * regression this exists to catch. The owner asked for this sentence and this
 * link, so this file is where they are pinned.
 */
const notice = (sha: string): string =>
  `Update installed. Now running [${sha}](https://github.com/WillMontgomery/blitz-bot/commit/${sha})`

/** An `ENOENT`, exactly as `readFile` rejects with one. */
const noSuchFile = (): Error =>
  Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })

/**
 * The two files, in memory.
 *
 * `deployed` IS WHAT THE UPDATER WROTE and never changes during a case;
 * `reported` is what this bot remembers and is the thing a restart carries
 * forward. Absent means the file is not there; an `Error` means the read
 * itself fails, which is a different answer again — see `readSha`.
 */
function commitStore(
  options: {
    deployed?: string | Error
    reported?: string | Error
    unwritable?: boolean
  } = {},
): { files: CommitFiles; file: () => string | Error | null } {
  let reported: string | Error | null = options.reported ?? null

  const read = (value: string | Error | null): Promise<string> => {
    if (value === null) return Promise.reject(noSuchFile())
    if (value instanceof Error) return Promise.reject(value)
    return Promise.resolve(value)
  }

  return {
    files: {
      deployed: () => read(options.deployed ?? null),
      reported: () => read(reported),
      remember: (sha) => {
        if (options.unwritable === true) {
          return Promise.reject(new Error('EROFS: read-only file system'))
        }

        reported = `${sha}\n`
        return Promise.resolve()
      },
    },
    file: () => reported,
  }
}

/** A post that always works, and remembers what it was handed. */
const poster = (): Mock<(content: string) => Promise<void>> => vi.fn(() => Promise.resolve())

describe('the deploy notice — what it says, and when it says nothing', () => {
  it('names the commit when it is not the one already reported', async () => {
    const post = poster()
    const store = commitStore({ deployed: DEPLOYED, reported: `${PREVIOUS}\n` })

    await reportDeployedCommit(store.files, post)

    expect(post).toHaveBeenCalledWith(notice(DEPLOYED))
    expect(store.file()).toBe(`${DEPLOYED}\n`)
  })

  /**
   * THE CASE THE WHOLE FEATURE IS SHAPED BY. A crash loop restarts this process
   * every five seconds on the same commit, and every one of those restarts must
   * be silent — otherwise the fix for the noise the owner rejected is a second
   * source of the same noise.
   */
  it('says nothing when the bot came back up on the commit it already reported', async () => {
    const post = poster()

    await reportDeployedCommit(commitStore({ deployed: DEPLOYED, reported: DEPLOYED }).files, post)

    expect(post).not.toHaveBeenCalled()
  })

  /**
   * A trailing newline is what the updater writes and what this bot writes; a
   * comparison that did not trim would post on every restart forever, which is
   * the failure mode this whole test file is about.
   */
  it('ignores the whitespace around either sha', async () => {
    const post = poster()

    await reportDeployedCommit(
      commitStore({ deployed: `${DEPLOYED}\n`, reported: `  ${DEPLOYED}  \n` }).files,
      post,
    )

    expect(post).not.toHaveBeenCalled()
  })

  /**
   * NOT AN ERROR, AND NOT WORTH A LINE EITHER. A hand-cloned box, a first start
   * before any update has run, somebody running the bot out of a checkout: in
   * all three the file is simply not there, and a warning about a feature
   * nobody has set up is exactly the unsolicited text the rule is about.
   */
  it('says nothing at all when no deploy has ever been recorded', async () => {
    const post = poster()

    await reportDeployedCommit(commitStore().files, post)

    expect(post).not.toHaveBeenCalled()
    expect(stderr.join('')).toBe('')
    expect(stdout.join('')).toBe('')
  })

  /**
   * A FILE THAT EXISTS AND CANNOT BE READ IS A DIFFERENT ANSWER. Nothing is
   * posted — there is no commit to name — but the updater is broken, and that
   * is a fault, so the journal gets a line and the status channel gets it
   * through the sink like every other fault.
   */
  it('posts nothing and says why when the file cannot be read', async () => {
    const post = poster()
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })

    await reportDeployedCommit(commitStore({ deployed: denied }).files, post)

    expect(post).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('could not read the commit the updater recorded')
  })

  it('posts nothing when the file holds something that is not a commit id', async () => {
    for (const rubbish of ['', 'HEAD', 'not a sha', 'zzzzzzz', 'a1b2c3', '<!DOCTYPE html>']) {
      const post = poster()

      await reportDeployedCommit(commitStore({ deployed: rubbish }).files, post)

      expect(post, rubbish).not.toHaveBeenCalled()
    }

    expect(stderr.join('')).toContain('is not a commit id')
  })

  /**
   * THE CONTENT OF THAT FILE IS NEVER COPIED ANYWHERE. It was written by
   * something other than this process, and the fault line goes to a Discord
   * channel — so what is said about it is its length and nothing else.
   */
  it('does not put the malformed content in the line about it', async () => {
    const post = poster()

    await reportDeployedCommit(commitStore({ deployed: 'ROLLBACK-IN-PROGRESS' }).files, post)

    expect(post).not.toHaveBeenCalled()
    expect(stderr.join('')).not.toContain('ROLLBACK-IN-PROGRESS')
    expect(stderr.join('')).toContain('length=20')
  })

  /**
   * A CORRUPT MEMORY MUST NOT BE READ AS "NOTHING HAS BEEN REPORTED", which
   * would post on every start. It is read as "unknown", the notice goes out
   * once, and the write that follows repairs the file.
   */
  it('reports once and repairs the file when its own memory is unreadable', async () => {
    const post = poster()
    const store = commitStore({ deployed: DEPLOYED, reported: 'not a sha either' })

    await reportDeployedCommit(store.files, post)

    expect(post).toHaveBeenCalledTimes(1)
    expect(store.file()).toBe(`${DEPLOYED}\n`)

    const next = poster()
    await reportDeployedCommit(store.files, next)
    expect(next).not.toHaveBeenCalled()
  })

  /**
   * THE RESTART, WHICH IS THE POINT OF WRITING ANYTHING DOWN. Nothing survives
   * a crash except the file, so the second run below shares only that — and it
   * has to be enough to keep the channel quiet.
   */
  it('remembers across a restart, and says nothing the second time', async () => {
    const store = commitStore({ deployed: DEPLOYED })

    const first = poster()
    await reportDeployedCommit(store.files, first)
    expect(first).toHaveBeenCalledWith(notice(DEPLOYED))

    // The process died here. A new one comes up on the same commit, with the
    // same two files and no memory of anything else.
    const second = poster()
    await reportDeployedCommit(store.files, second)
    expect(second).not.toHaveBeenCalled()

    // And an update lands: a different sha, so it is said once more.
    const store2 = commitStore({ deployed: PREVIOUS, reported: store.file() as string })
    const third = poster()
    await reportDeployedCommit(store2.files, third)
    expect(third).toHaveBeenCalledWith(notice(PREVIOUS))
  })

  /**
   * THE ORDER IS A DECISION. The file means "this commit was reported", so
   * writing it before the post lands would make it a lie — and the notice would
   * be lost for good, because the next start would compare equal and stay
   * quiet. A failed post leaves the file alone and the next start tries again.
   */
  it('does not record a notice it could not post', async () => {
    const store = commitStore({ deployed: DEPLOYED })

    await expect(
      reportDeployedCommit(store.files, () => Promise.reject(new Error('rate limited'))),
    ).rejects.toThrow('rate limited')

    expect(store.file()).toBeNull()
  })

  /**
   * A write that fails is not visible from Discord, and its consequence is that
   * this notice comes back on every single restart — the exact noise the
   * comparison exists to prevent. So it is a fault, and it is said.
   */
  it('says so when it cannot remember what it just reported', async () => {
    const post = poster()

    await reportDeployedCommit(commitStore({ deployed: DEPLOYED, unwritable: true }).files, post)

    expect(post).toHaveBeenCalledTimes(1)
    expect(stderr.join('')).toContain('could not record the reported commit')
  })
})

describe('the deploy notice — where it goes, and when', () => {
  /**
   * THE STATUS CHANNEL, NOT THE MODERATION LOG. BLITZ_LOG_CHANNEL_ID carries
   * what was removed and why — evidence about a member. Which commit the bot is
   * running is evidence about the BOT, which is what BLITZ_STATUS_CHANNEL_ID is
   * for. The owner said "log channel" because it is the only one he has set up.
   */
  it('waits for the gateway and posts to the status channel', async () => {
    const { client, sent, fetched, ready } = statusHarness({ ready: false })

    announceDeployedCommit(client, STATUS_CHANNEL, commitStore({ deployed: DEPLOYED }).files)
    await settle()

    // Nothing before there is a gateway: there is no channel to fetch yet.
    expect(sent).toEqual([])
    expect(fetched).toEqual([])

    ready()
    await settle()

    expect(sent).toEqual([notice(DEPLOYED)])
    expect(fetched).toEqual([STATUS_CHANNEL])
  })

  it('is wired to the status channel id and not to the log channel id', async () => {
    // A source assertion because the two ids are both strings and both optional:
    // a fake client cannot tell which of `config`'s two fields was handed to
    // `announceDeployedCommit`, and getting it wrong puts deploy notices in the
    // channel that holds the moderation record.
    const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8')

    expect(source).toContain('announceDeployedCommit(client, config.statusChannelId)')
    expect(source).not.toMatch(/announceDeployedCommit\([^)]*logChannelId/)
  })

  it('registers nothing at all when no status channel is configured', async () => {
    const quiet = createClient(cfg())
    expect(quiet.listenerCount(Events.ClientReady)).toBe(1)
    await quiet.destroy()

    const wired = createClient(cfg({ statusChannelId: STATUS_CHANNEL }))
    expect(wired.listenerCount(Events.ClientReady)).toBe(2)
    await wired.destroy()
  })

  /**
   * A NOTICE THAT DID NOT LAND IS NOT A REASON TO BE DOWN. One line in the
   * journal, and the bot carries on moderating.
   */
  it('logs and carries on when the channel cannot be posted to', async () => {
    const { client, sent, ready } = statusHarness({ ready: false, sendable: false })

    announceDeployedCommit(client, STATUS_CHANNEL, commitStore({ deployed: DEPLOYED }).files)
    ready()
    await settle()

    expect(sent).toEqual([])
    expect(stderr.join('')).toContain('could not report the commit this bot is running')
  })

  /**
   * The same suppression every other send in this file states at the call. The
   * content is a sentence, a hex sha and a github.com url and could not carry a
   * mention today; the guarantee is made where a reader of the function can see
   * it, because the client-wide default is silently replaced by any send that
   * passes its own.
   */
  it('suppresses every mention on the notice', async () => {
    const { client, send } = statusHarness()

    await statusPoster(client, STATUS_CHANNEL)(notice(DEPLOYED))

    expect(send).toHaveBeenCalledWith({
      content: notice(DEPLOYED),
      allowedMentions: { parse: [] },
    })
  })

  /**
   * THE SHA IS A LINK, AND THE LINK ONLY WORKS UNFENCED — which is the whole
   * reason the deploy notice does not take the fault path into this same
   * channel. Inside `statusBody`'s code fence the markdown is inert and this
   * arrives as literal brackets and a bare URL; `redact` would have replaced
   * the URL with `[url]` before that even happened.
   *
   * A MASKED LINK IS ALLOWED BECAUSE A BOT SENT IT. Discord renders
   * `[text](url)` in content posted by an application and refuses it in content
   * a human types, so this needs no embed.
   *
   * ASSERTED ON WHAT REACHES THE CHANNEL rather than on the builder, because
   * the fence and the redaction are both things that would happen BETWEEN a
   * correct builder and the send.
   */
  it('posts a real markdown link to the commit, and no code fence around it', async () => {
    const { client, sent, ready } = statusHarness({ ready: false })

    announceDeployedCommit(client, STATUS_CHANNEL, commitStore({ deployed: DEPLOYED }).files)
    ready()
    await settle()

    const posted = at(sent, 0)

    expect(posted).toBe(notice(DEPLOYED))
    expect(posted).toContain(`[${DEPLOYED}](https://github.com/`)
    expect(posted).toContain(`/commit/${DEPLOYED})`)

    // Nothing fenced it, and nothing redacted the url out of it: those are the
    // fault path's, and this is not a fault.
    expect(posted).not.toContain('```')
    expect(posted).not.toContain('[url]')
  })
})

describe('the deploy notice — the two files it reads', () => {
  /**
   * THE ONE PROPERTY THAT KEEPS THIS WORKING. The updater owns /opt/blitz-bot:
   * it runs `git reset --hard origin/main` in it and writes the deployed-commit
   * file into it. A memory of what has been reported that lived under that
   * directory would be overwritten or discarded by the next update, and then
   * the notice either repeats on every restart or never fires again.
   *
   * /var/lib/blitz-bot is the unit's `StateDirectory=`: systemd creates it,
   * keeps it writable while `ProtectSystem=strict` puts the rest of the
   * filesystem back to read-only, and it survives a reboot.
   */
  it('remembers outside the repo the updater resets', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url))

    expect(deployedCommitPath().startsWith(repo)).toBe(true)
    expect(reportedCommitPath().startsWith(repo)).toBe(false)
  })

  it('reads the deployed sha from the root of whichever checkout is running', () => {
    // Derived from this module's own location rather than hard-coded to
    // /opt/blitz-bot, so a bot run out of a checkout does not read the deployed
    // box's file and report a commit it is not running.
    expect(deployedCommitPath()).toBe(
      join(fileURLToPath(new URL('..', import.meta.url)), '.deployed-commit'),
    )
  })

  it('takes the state directory from systemd when the unit supplies one', () => {
    try {
      // Colon-separated, because `StateDirectory=` may name more than one.
      vi.stubEnv('STATE_DIRECTORY', '/var/lib/blitz-bot:/var/lib/other')
      expect(reportedCommitPath()).toBe(join('/var/lib/blitz-bot', 'reported-commit'))

      // An empty value is not a directory; the fallback has to hold.
      vi.stubEnv('STATE_DIRECTORY', '')
      expect(reportedCommitPath()).toBe(join('/var/lib/blitz-bot', 'reported-commit'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  /**
   * THE SEAM BETWEEN THE RULES ABOVE AND A REAL DISK, which is the one part of
   * this the fakes cannot speak for: a missing file has to reject with the
   * `ENOENT` that `readSha` reads as silence, and what is written has to come
   * back the way it went in.
   */
  it('rejects with ENOENT for a file that is not there, and round-trips one that is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blitz-bot-'))

    try {
      const files = commitFiles(join(dir, '.deployed-commit'), join(dir, 'reported-commit'))

      await expect(files.deployed()).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(files.reported()).rejects.toMatchObject({ code: 'ENOENT' })

      await files.remember(DEPLOYED)

      // The trailing newline is deliberate: `cat` of this file should not run
      // into the next prompt, and it is the shape the updater's file has too.
      await expect(files.reported()).resolves.toBe(`${DEPLOYED}\n`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The manual: docs/bot-manual.md, rendered into a channel and kept there.
 *
 * THE FEATURE IS "THE DOCS CANNOT DRIFT FROM THE CODE WITHOUT IT BEING
 * VISIBLE", so the cases that matter are the ones where the channel and the
 * file disagree in an awkward way: a message somebody deleted by hand, a run
 * that got half way, two sections under one heading, a section that grew past
 * what an embed will hold. Every one of those is a state a real channel reaches
 * on its own, and none of them can be arranged in a live guild without
 * vandalising it.
 *
 * THE QUIET RESTART IS THE FIRST TEST AND THE MOST IMPORTANT ONE. This process
 * restarts on every deploy and every crash. A channel that stirs each time is a
 * channel nobody reads, and the whole value of this one is that a message in it
 * means the documentation changed.
 *
 * NOTHING HERE TOUCHES DISCORD. `syncManual` takes the channel as four injected
 * functions, so the reconciliation is exercised against an array.
 */
const DOCS_CHANNEL = '101010101010101010'

/** The bot's own id, for the cases that go in through the live adapter. */
const DOCS_SELF = '131313131313131313'

/**
 * A manual, written the way the file is: `# heading`, a blank line, a body.
 *
 * BUILT AND THEN PARSED RATHER THAN HANDED TO `syncManual` AS SECTIONS. The
 * split is half of what can go wrong — a `##` read as a top-level heading, a
 * `#` inside a code fence, whitespace that makes an unchanged section look
 * changed — so the cases below go in through the same door the bot does.
 */
const manual = (...sections: (readonly [string, string])[]): string =>
  sections.map(([heading, body]) => `# ${heading}\n\n${body}\n`).join('\n')

/** The footer on a message the bot last managed to write. `updated <date>`. */
const STAMP = 'updated 2026-01-01T00:00:00.000Z'

/**
 * The footer on a message the bot could not bring up to date, verbatim.
 *
 * WRITTEN OUT HERE RATHER THAN IMPORTED. It is the one string that has to
 * survive a restart — the next start reads it back and stays quiet — so a test
 * that took it from the module could not tell a mark that changed from a mark
 * that did not, and the whole mechanism would still pass with the two halves
 * agreeing on a different string every release.
 */
const STALE = 'out of date: this section could not be published'

/**
 * The channel as an array, and a record of everything asked of it.
 *
 * `messages` ARE GIVEN IDS IN CHANNEL ORDER — m1, m2, m3 — because the port
 * promises oldest first and several assertions below are about which message
 * was edited rather than merely that one was.
 *
 * `rejects` IS ASKED ABOUT EVERY CALL BY NAME, so a case can fail exactly one
 * write and leave the rest working, which is what a partial failure is.
 *
 * `peak` IS HOW MANY CALLS WERE IN FLIGHT AT ONCE. Ten posts fired together are
 * a burst into Discord's per-channel limit at the moment the bot has just
 * started, and a serialised loop and a concurrent one are otherwise
 * indistinguishable from their results.
 *
 * `truncated` IS A READ THAT STOPPED AT DISCORD'S PER-REQUEST LIMIT, which the
 * live adapter reports and which the reconciler must refuse to act on: what
 * came back is not the channel, and everything below derives what to delete
 * from the belief that it is.
 *
 * `footer` IS PART OF A MESSAGE HERE because it is the only thing that survives
 * a restart. A section the bot could not publish is stamped, and the stamp is
 * what the next start reads to know it has already said so.
 */
function docsHarness(
  options: {
    messages?: readonly { title: string; description: string; footer?: string }[]
    rejects?: (call: string) => unknown
    truncated?: boolean
  } = {},
): {
  channel: DocsChannel
  calls: string[]
  written: ManualEmbed[]
  messages: () => PostedSection[]
  peak: () => number
  pause: () => Promise<void>
  pauses: () => number
} {
  const state: PostedSection[] = (options.messages ?? []).map((message, index) => ({
    id: `m${index + 1}`,
    footer: STAMP,
    ...message,
  }))

  const calls: string[] = []
  const written: ManualEmbed[] = []

  let live = 0
  let high = 0
  let pauses = 0
  let ids = state.length

  async function call<T>(name: string, act: () => T): Promise<T> {
    calls.push(name)
    live += 1
    high = Math.max(high, live)

    try {
      // A turn of the loop before anything happens, so two writes fired without
      // waiting for each other are seen here as two at once.
      await Promise.resolve()

      const failure = options.rejects?.(name)
      if (failure !== undefined) throw failure

      return act()
    } finally {
      live -= 1
    }
  }

  function replace(id: string, next: PostedSection): void {
    const at = state.findIndex((message) => message.id === id)
    if (at < 0) throw new Error(`no message ${id} in the channel`)
    state[at] = next
  }

  return {
    calls,
    written,
    messages: () => state.map((message) => ({ ...message })),
    peak: () => high,
    pauses: () => pauses,

    pause: () => {
      pauses += 1
      return Promise.resolve()
    },

    channel: {
      read: () =>
        call('read', () => ({
          sections: state.map((message) => ({ ...message })),
          complete: options.truncated !== true,
        })),

      post: (embed) =>
        call(`post ${embed.title}`, () => {
          written.push(embed)
          ids += 1
          state.push({
            id: `m${ids}`,
            title: embed.title,
            description: embed.description,
            footer: embed.footer,
          })
        }),

      edit: (id, embed) =>
        call(`edit ${id}`, () => {
          written.push(embed)
          replace(id, {
            id,
            title: embed.title,
            description: embed.description,
            footer: embed.footer,
          })
        }),

      remove: (id) =>
        call(`remove ${id}`, () => {
          const at = state.findIndex((message) => message.id === id)
          if (at < 0) throw new Error(`no message ${id} in the channel`)
          state.splice(at, 1)
        }),
    },
  }
}

/** How many times a line was written, so "exactly one" can be asserted. */
const said = (needle: string): number => (stderr.join('') + stdout.join('')).split(needle).length - 1

/** A client that does nothing but hold a `clientReady` listener. No network. */
function docsClient(): { client: Client; ready: () => void } {
  const waiting: (() => void)[] = []

  const client = {
    once: (event: unknown, handler: () => void) => {
      if (event === Events.ClientReady) waiting.push(handler)
    },
  } as unknown as Client

  return {
    client,
    ready: () => {
      for (const handler of waiting.splice(0, waiting.length)) handler()
    },
  }
}

describe('the manual — a restart that changes nothing says nothing', () => {
  /**
   * THE CASE THE WHOLE FEATURE IS SHAPED BY, and the same argument the deploy
   * notice is built around. `Restart=always` starts this process again five
   * seconds after every crash. If a matching manual cost even one edit, the
   * documentation channel would be the noisiest channel on the server.
   */
  it('writes nothing and logs nothing at info when the channel already matches', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'Two', description: 'second' },
      ],
    })

    await syncManual(
      parseManual(manual(['One', 'first'], ['Two', 'second'])),
      docs.channel,
      docs.pause,
    )

    // The read is unavoidable — the channel is the state — and it is the only
    // request that happens.
    expect(docs.calls).toEqual(['read'])
    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toBe('')
  })

  /**
   * THE COMPARISON IS A PLAIN STRING EQUALITY AGAINST THE STORED DESCRIPTION.
   * A body full of markdown is the case that would break a comparison made
   * against anything rendered: what Discord shows for this section is not the
   * string that was sent, and diffing the shown version would rewrite the
   * channel on every start forever.
   */
  it('compares the stored description, not what Discord renders it as', async () => {
    const body = ['**bold**, `code`, <@1234> and a list:', '', '- one', '- two'].join('\n')
    const docs = docsHarness({ messages: [{ title: 'One', description: body }] })

    await syncManual(parseManual(manual(['One', body])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read'])
  })

  /**
   * Reformatting the blank lines around a section is not a change to it. Without
   * the trim in the parser, adding a second blank line under a heading would
   * rewrite that section's message and stamp it with today's date.
   */
  it('is not disturbed by the blank lines around a section', async () => {
    const docs = docsHarness({ messages: [{ title: 'One', description: 'first' }] })

    await syncManual(parseManual('# One\n\n\n\nfirst\n\n\n'), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read'])
  })
})

describe('the manual — one section changes, one message changes', () => {
  /**
   * THE POINT OF MATCHING BY HEADING. Section two growing must not touch
   * sections one and three; under positional matching a change anywhere is a
   * change to everything below it.
   */
  it('edits only the section whose body moved', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'Two', description: 'second' },
        { title: 'Three', description: 'third' },
      ],
    })

    await syncManual(
      parseManual(manual(['One', 'first'], ['Two', 'second, and more'], ['Three', 'third'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read', 'edit m2'])
    expect(docs.messages().map((message) => message.description)).toEqual([
      'first',
      'second, and more',
      'third',
    ])
  })

  /**
   * A HEADING IS THE KEY, SO ITS MESSAGE IS FOUND WHEREVER IT SITS. The channel
   * below is in a different order from the file — which is what a channel looks
   * like after a section was inserted once — and the edit still lands on the
   * right message rather than on whatever is third.
   */
  it('finds a section wherever in the channel it happens to be', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'Three', description: 'third' },
        { title: 'One', description: 'first' },
        { title: 'Two', description: 'second' },
      ],
    })

    await syncManual(
      parseManual(manual(['One', 'first'], ['Two', 'changed'], ['Three', 'third'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read', 'edit m3'])
  })

  /**
   * LAST-CHANGED, NOT LAST-CHECKED. The footer goes out only on a write, so an
   * unchanged section keeps the date of the edit that really happened — which
   * is the only reading of a timestamp on a document that is worth anything.
   * It is also deliberately not part of the comparison: a footer rebuilt every
   * start and then compared would differ every start.
   */
  it('stamps only the section it wrote', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'Two', description: 'second' },
      ],
    })

    await syncManual(
      parseManual(manual(['One', 'first'], ['Two', 'moved'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.written).toHaveLength(1)
    expect(at(docs.written.map((embed) => embed.footer), 0)).toMatch(
      /^updated \d{4}-\d{2}-\d{2}T[\d:.]+Z$/u,
    )
  })
})

describe('the manual — sections added and removed', () => {
  /**
   * ONE POST, AND THE CHANNEL IS NOT REWRITTEN TO MAKE ROOM FOR IT. A message
   * cannot be moved in Discord, so a section inserted into the middle of the
   * file lands at the bottom of the channel. The alternative is deleting and
   * reposting everything below the insertion, which in a project this careful
   * about audit trails reads as the bot rewriting its own history.
   */
  it('posts a new section and touches nothing else, wherever it was inserted', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'Three', description: 'third' },
      ],
    })

    await syncManual(
      parseManual(manual(['One', 'first'], ['Two', 'second'], ['Three', 'third'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read', 'post Two'])
  })

  /** A first run against an empty channel posts the file in file order. */
  it('posts the whole manual in file order the first time', async () => {
    const docs = docsHarness()

    await syncManual(
      parseManual(manual(['One', 'first'], ['Two', 'second'], ['Three', 'third'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read', 'post One', 'post Two', 'post Three'])
  })

  /**
   * A SECTION REMOVED FROM THE FILE HAS ITS MESSAGE DELETED, not edited into a
   * tombstone. "This section was removed" is text nobody asked for, nothing
   * ever clears it, and after a year the channel is mostly tombstones. What the
   * docs used to say is in the file's history.
   */
  it('deletes the message for a section that is no longer in the file', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'Two', description: 'second' },
        { title: 'Three', description: 'third' },
      ],
    })

    await syncManual(
      parseManual(manual(['One', 'first'], ['Three', 'third'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read', 'remove m2'])
    expect(docs.written).toEqual([])
    expect(docs.messages().map((message) => message.title)).toEqual(['One', 'Three'])
  })

  /** Deletions come last, so a run that fails part way leaves an extra rather
   * than a hole — the extra is removed on the next start, where a hole would
   * have to be reposted and would come back at the bottom of the channel. */
  it('adds before it removes', async () => {
    const docs = docsHarness({ messages: [{ title: 'Gone', description: 'old' }] })

    await syncManual(parseManual(manual(['New', 'new'])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read', 'post New', 'remove m1'])
  })
})

/**
 * THE REFUSAL, AND THE CLASS OF BUG BEHIND IT.
 *
 * The file is authoritative and the channel is the state, so every misreading
 * of the file comes out of the far end as DELETIONS from the channel — and
 * three different faults proved it: a code fence that never closed truncated
 * the parse and deleted everything below it, an empty file deleted everything,
 * and a read that stopped at Discord's per-request limit deleted the sections
 * whose messages fell off the end. Each of those has its own guard now, and
 * this is the one that does not depend on anybody having anticipated the fault:
 * a run about to remove a large share of the channel is far more likely to be
 * this bot misreading a document than a person deleting most of one.
 *
 * THE FLOOR IS WHAT KEEPS IT USABLE. Removing a section or two is an ordinary
 * edit and has to go through untouched however small the channel is, or the
 * guard is a feature that stops the feature working.
 */
describe('the manual — a run that would delete most of the channel', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({
    title: `H${String(i)}`,
    description: `body ${String(i)}`,
  }))

  it('refuses the destructive half and leaves every message standing', async () => {
    const docs = docsHarness({ messages: six })

    await syncManual(parseManual(manual(['H0', 'body 0'])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read'])
    expect(docs.messages()).toHaveLength(6)
    expect(said('refusing to delete most of the docs channel')).toBe(1)
    expect(stderr.join('')).toContain('deleting=5')
    expect(stderr.join('')).toContain('found=6')
  })

  /**
   * THE POSTS AND EDITS ABOVE IT ARE NOT REFUSED, and the asymmetry is the
   * point: an edit this bot should not have made is corrected by the next start
   * reading the file again, and a message it should not have deleted is gone.
   */
  it('refuses only the deletions', async () => {
    const docs = docsHarness({ messages: six })

    await syncManual(
      parseManual(manual(['H0', 'body 0'], ['New', 'new'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read', 'post New'])
    expect(docs.messages()).toHaveLength(7)
  })

  /** A manual that lost two sections still works, whatever share of the
   * channel they are. That is what the floor is for. */
  it('still removes a section or two', async () => {
    const docs = docsHarness({ messages: six.slice(0, 4) })

    await syncManual(
      parseManual(manual(['H0', 'body 0'], ['H1', 'body 1'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read', 'remove m3', 'remove m4'])
    expect(docs.messages().map((message) => message.title)).toEqual(['H0', 'H1'])
  })

  /** And the boundary above the floor: half of what was found is a share, not
   * most of it, so it goes through. */
  it('removes exactly half of the channel', async () => {
    const docs = docsHarness({ messages: six })

    await syncManual(
      parseManual(manual(['H0', 'body 0'], ['H1', 'body 1'], ['H2', 'body 2'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read', 'remove m4', 'remove m5', 'remove m6'])
    expect(said('refusing to delete most of the docs channel')).toBe(0)
  })
})

/**
 * REGRESSION. A MANUAL THAT PARSED TO NOTHING EMPTIED THE CHANNEL.
 *
 * `readManual` has always guarded the file that is not there — a checkout of an
 * older commit, a botched deploy — because reading a missing file as "the
 * manual is now empty" deletes every section in the channel. The file that IS
 * there and has nothing in it went straight past that guard and did exactly
 * that, and so did a file whose headings are all `##`. Neither is a manual, and
 * "there is nothing to publish" is never an instruction to empty the channel.
 */
describe('the manual — a file that parsed to no sections at all', () => {
  it('does not even read the channel, let alone write to it', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'Two', description: 'second' },
        { title: 'Three', description: 'third' },
      ],
    })

    await syncManual(parseManual(''), docs.channel, docs.pause)

    expect(docs.calls).toEqual([])
    expect(docs.messages()).toHaveLength(3)
    expect(said('the manual has no sections at all')).toBe(1)
  })

  it('says the same about a file with no top-level heading in it', async () => {
    const docs = docsHarness({ messages: [{ title: 'One', description: 'first' }] })

    const source = '## Only a sub-heading\n\nand a paragraph\n'

    await syncManual(parseManual(source), docs.channel, docs.pause)

    expect(docs.calls).toEqual([])
    expect(docs.messages()).toHaveLength(1)
  })
})

/**
 * REGRESSION, AND IT IS THE SAME DELETION FROM THE OTHER END: one unbalanced
 * code fence.
 *
 * The parser tracks fences so that a `# comment` inside a shell example is not
 * read as a heading. A fence that never closes therefore swallows every line
 * after it — the sections below it stop existing as far as the parse is
 * concerned — and the channel is the state, so "stopped existing" was a DELETE
 * of each of their messages, logged as "no longer in the file" about text still
 * sitting in the file one line above the fence.
 */
describe('the manual — a code fence that is never closed', () => {
  const source = [
    '# One',
    '',
    '```sh',
    'echo hello',
    '',
    '# Two',
    '',
    'second',
    '',
    '# Three',
    '',
    'third',
    '',
  ].join('\n')

  it('answers no sections and names the line the fence was opened on', () => {
    expect(parseManual(source)).toEqual([])

    expect(stderr.join('')).toContain('code fence that is never closed')
    expect(stderr.join('')).toContain('line=3')
  })

  it('leaves every section of the channel standing', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'Two', description: 'second' },
        { title: 'Three', description: 'third' },
      ],
    })

    await syncManual(parseManual(source), docs.channel, docs.pause)

    expect(docs.calls).toEqual([])
    expect(docs.messages()).toHaveLength(3)
  })

  /** A fence that closes is still an ordinary section, and the sections after
   * it are still sections. */
  it('is not disturbed by a fence that does close', () => {
    expect(parseManual(`${source}\n\`\`\`\n`)).toEqual([
      { heading: 'One', body: '```sh\necho hello\n\n# Two\n\nsecond\n\n# Three\n\nthird\n\n```' },
    ])
  })
})

/**
 * THE CHANNEL IS NOT A DATABASE. Any admin can delete a message with a
 * right-click, and a bot that kept its own record of "section four is message
 * 123" would believe that record and never post section four again. Every start
 * derives the whole of its state from the channel, so the repair is automatic
 * and needs no cleanup command that nobody would know to run.
 */
describe('the manual — the channel is read back, never remembered', () => {
  it('reposts a section whose message was deleted by hand', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'Three', description: 'third' },
      ],
    })

    await syncManual(
      parseManual(manual(['One', 'first'], ['Two', 'second'], ['Three', 'third'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read', 'post Two'])
    expect(docs.messages().map((message) => message.title)).toEqual(['One', 'Three', 'Two'])
  })

  /**
   * PARTIAL FAILURE, AND THEN THE RESTART THAT HAS TO CLEAN IT UP. Section two
   * fails to post; one and three are already up. Nothing is written down about
   * any of that, and the next start still has to finish the job without posting
   * a second copy of anything.
   */
  it('finishes a half-done run on the next start, and duplicates nothing', async () => {
    const first = docsHarness({
      rejects: (call) => (call === 'post Two' ? new Error('503 Service Unavailable') : undefined),
    })

    const sections = parseManual(manual(['One', 'first'], ['Two', 'second'], ['Three', 'third']))

    await syncManual(sections, first.channel, first.pause)

    expect(first.calls).toEqual(['read', 'post One', 'post Two', 'post Three'])
    expect(first.messages().map((message) => message.title)).toEqual(['One', 'Three'])
    expect(stdout.join('')).toContain('level=info msg="could not post a manual section"')

    // The process died here. A new one comes up with no memory of any of it,
    // and the channel is the only thing that carried over.
    const second = docsHarness({
      messages: first.messages().map(({ title, description }) => ({ title, description })),
    })

    await syncManual(sections, second.channel, second.pause)

    expect(second.calls).toEqual(['read', 'post Two'])
    expect(second.messages().map((message) => message.title)).toEqual(['One', 'Three', 'Two'])
  })

  /**
   * AND THE OTHER HALF OF THAT: a duplicate that did get posted — a send that
   * succeeded and whose answer was lost — is not left in the channel forever.
   * A second message under a title no second section claims is unmatched, and
   * unmatched is deleted.
   */
  it('clears a duplicate copy of a section left behind by an earlier run', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'One', description: 'first' },
      ],
    })

    await syncManual(parseManual(manual(['One', 'first'])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read', 'remove m2'])
    expect(docs.messages()).toHaveLength(1)
  })
})

/**
 * TWO SECTIONS UNDER ONE HEADING. The key is the heading, so a repeated heading
 * is an ambiguous key — and the two failures worth avoiding are silent ones:
 * both sections editing the same message forever, or one of them being posted
 * again on every start because nothing ever matched it.
 */
describe('the manual — a heading that appears twice', () => {
  const twice = (second: string): ManualSection[] =>
    parseManual(manual(['One', 'first'], ['One', second], ['Two', 'other']))

  it('gives each copy its own message and says the key is ambiguous', async () => {
    const docs = docsHarness({ messages: [{ title: 'Two', description: 'other' }] })

    await syncManual(twice('second'), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read', 'post One', 'post One'])
    expect(docs.messages().map((message) => message.description)).toEqual([
      'other',
      'first',
      'second',
    ])

    expect(stderr.join('')).toContain('more than one section under this heading')
    // Once for the heading, however many copies there are of it.
    expect(said('more than one section under this heading')).toBe(1)
  })

  /**
   * Within the ambiguous group, and only within it, the match is positional —
   * first copy to the first message under that title in channel order. It is
   * the only thing left to go on, and it is why the warning above exists.
   */
  it('matches the second copy to the second message, and edits only that one', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'One', description: 'second' },
        { title: 'Two', description: 'other' },
      ],
    })

    await syncManual(twice('second, rewritten'), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read', 'edit m2'])
    expect(docs.messages().map((message) => message.description)).toEqual([
      'first',
      'second, rewritten',
      'other',
    ])
  })

  /** A heading that appears once is never warned about. */
  it('says nothing when every heading is its own', async () => {
    const docs = docsHarness()

    await syncManual(parseManual(manual(['One', 'a'], ['Two', 'b'])), docs.channel, docs.pause)

    expect(stderr.join('')).toBe('')
  })
})

/**
 * DISCORD'S LIMITS, AND THE RULE THAT A SECTION IS NEVER SILENTLY SHORTENED.
 * This channel's whole claim is that it says the same thing the file says. A
 * truncated section reads like the whole of it, so the drift would be invisible
 * and the bot would have caused it. It is refused and said at error instead,
 * which reaches the status channel and therefore the owner.
 */
describe('the manual — a section that will not fit', () => {
  const long = 'x'.repeat(4097)

  it('refuses a section over the description limit rather than cutting it', async () => {
    const docs = docsHarness({ messages: [{ title: 'One', description: 'short' }] })

    await syncManual(parseManual(manual(['One', long])), docs.channel, docs.pause)

    // The message that is up keeps its text: honest about the last version that
    // fitted, rather than a shortened copy of the one that does not.
    expect(docs.messages().map((message) => message.description)).toEqual(['short'])

    expect(stderr.join('')).toContain('too long for one embed')
    expect(stderr.join('')).toContain('length=4097')
    expect(stderr.join('')).toContain('cap=4096')
  })

  /**
   * REGRESSION. The error named the length and not the heading.
   *
   * The document can have any number of headings and this branch fires because
   * one of them is thousands of characters long — so `length=4321` on its own
   * tells the owner that something in a file they cannot see from Discord is
   * too big, and nothing about which thing. The description error beside it has
   * always named its section.
   */
  it('names the heading in the error about the heading', async () => {
    const docs = docsHarness()
    const heading = `Runbook ${'H'.repeat(300)}`

    await syncManual(parseManual(manual([heading, 'body'])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read'])
    expect(stderr.join('')).toContain('too long for an embed title')
    expect(stderr.join('')).toContain('heading="Runbook HHH')

    // Capped, because the whole point of this branch is that the string is
    // enormous and the line beside it has to stay readable.
    expect(stderr.join('')).toContain('…')
    expect(stderr.join('')).not.toContain('H'.repeat(300))
  })

  /**
   * AND IT IS THE ONE REFUSAL THAT CANNOT BE MARKED IN THE CHANNEL. No message
   * can exist under a title Discord will not take, so there is nothing to stamp
   * and nothing to read back — which is why this one is said on every start
   * where the others are said once.
   */
  it('writes nothing at all for a heading no message could carry', async () => {
    const docs = docsHarness()

    await syncManual(parseManual(manual(['H'.repeat(257), 'body'])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read'])
    expect(docs.written).toEqual([])
  })

  /** The refusal is per section: everything that fits still goes out. */
  it('posts the sections that do fit', async () => {
    const docs = docsHarness()

    await syncManual(
      parseManual(manual(['One', 'first'], ['Big', long], ['Three', 'third'])),
      docs.channel,
      docs.pause,
    )

    // `Big` is marked rather than published — a message under its heading with
    // nothing in it, saying so — and the two that fit are posted as usual.
    expect(docs.calls).toEqual(['read', 'post One', 'post Big', 'post Three'])
    expect(docs.messages().map((message) => [message.title, message.footer])).toEqual([
      ['One', expect.stringContaining('updated ')],
      ['Big', STALE],
      ['Three', expect.stringContaining('updated ')],
    ])
  })

  /**
   * REGRESSION, AND IT HAD THE FAILURE BACKWARDS.
   *
   * The cap was measured in CODE POINTS on the reasoning that a UTF-16 `length`
   * overstates an astral character and would refuse a section Discord accepts.
   * Discord's limits are on the JSON string as it arrives, which is UTF-16, so
   * counting code points UNDERSTATES every astral character by half: 4096
   * musical symbols are 8192 units, sailed through a 4096 guard, and came back
   * 50035 from the one check that exists to stop that happening.
   */
  it('counts a section in the units Discord counts', async () => {
    const docs = docsHarness()

    // 4096 astral characters: 8192 UTF-16 units, and twice the limit.
    await syncManual(parseManual(manual(['One', '𝄞'.repeat(4096)])), docs.channel, docs.pause)

    expect(docs.written.map((embed) => embed.footer)).toEqual([STALE])
    expect(stderr.join('')).toContain('too long for one embed')
    expect(stderr.join('')).toContain('length=8192')
  })

  /** And the other side of it: 4096 units of astral text is exactly the limit
   * and is published, so this is a cap on the right number rather than a cap
   * that happens to refuse everything unusual. */
  it('publishes astral text that fits in the units Discord counts', async () => {
    const docs = docsHarness()

    await syncManual(parseManual(manual(['One', '𝄞'.repeat(2048)])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read', 'post One'])
    expect(stderr.join('')).toBe('')
  })
})

/**
 * A SECTION THE BOT CANNOT PUBLISH, AND THE TWO THINGS THAT HAS TO DO: tell a
 * reader of the channel that the message in front of them is not the file, and
 * tell the owner once rather than on every restart.
 *
 * THE REPEAT IS THE BUG WORTH DWELLING ON. There is no local state anywhere in
 * this feature — the channel is the state, deliberately — so a refusal reported
 * at start-up is a refusal reported on every start-up of a process that starts
 * again five seconds after every crash, about a document that can only be fixed
 * with a commit. That is a slow flood into the one channel that has to stay
 * readable, and the only thing that survives a restart to stop it is the
 * channel itself. Hence the mark, and hence a mark that is read back.
 */
describe('the manual — the mark on a section that could not be published', () => {
  const long = 'x'.repeat(4097)

  it('stamps the message that is up, and leaves its text alone', async () => {
    const docs = docsHarness({ messages: [{ title: 'One', description: 'short' }] })

    await syncManual(parseManual(manual(['One', long])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read', 'edit m1'])
    expect(docs.messages()).toEqual([
      { id: 'm1', title: 'One', description: 'short', footer: STALE },
    ])
  })

  /**
   * THE SECOND START IS SILENT, AND THAT IS THE WHOLE POINT. Same file, same
   * over-long section, and the channel already carrying the mark: no write, no
   * error, nothing in the status channel.
   */
  it('says nothing and writes nothing on the next start', async () => {
    const docs = docsHarness({
      messages: [{ title: 'One', description: 'short', footer: STALE }],
    })

    await syncManual(parseManual(manual(['One', long])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read'])
    expect(stderr.join('')).toBe('')
    expect(stdout.join('')).toBe('')
  })

  /**
   * A SECTION THAT HAS NEVER BEEN POSTED STILL GETS A MESSAGE. The channel is
   * one message per heading, so a reader looking for a section finds it and is
   * told it could not be published, rather than finding nothing and having to
   * work out whether the section exists — and the message is what makes the
   * next start quiet.
   */
  it('posts a marked message for a section that was never up', async () => {
    const docs = docsHarness()

    await syncManual(parseManual(manual(['One', long])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read', 'post One'])
    expect(docs.messages()).toEqual([{ id: 'm1', title: 'One', description: '', footer: STALE }])

    // And the start after that one, against the channel this left behind.
    const next = docsHarness({
      messages: docs.messages().map(({ title, description, footer }) => ({
        title,
        description,
        footer,
      })),
    })

    stderr.length = 0
    await syncManual(parseManual(manual(['One', long])), next.channel, next.pause)

    expect(next.calls).toEqual(['read'])
    expect(stderr.join('')).toBe('')
  })

  /**
   * AND THE MARK COMES OFF WHEN THE FILE IS FIXED. The interesting case is the
   * one where the fix restores the text the channel already has: the
   * descriptions match, so the comparison alone would skip the section and
   * leave a message stamped out of date forever.
   */
  it('clears the mark when the section fits again', async () => {
    const docs = docsHarness({
      messages: [{ title: 'One', description: 'short', footer: STALE }],
    })

    await syncManual(parseManual(manual(['One', 'short'])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read', 'edit m1'])
    expect(at(docs.messages().map((message) => message.footer), 0)).toContain('updated ')
  })

  /**
   * REGRESSION. A section Discord refuses outright was treated as transient.
   *
   * 50035 is "Invalid Form Body": a statement about the payload, not about the
   * moment, so the identical write fails identically on the next start and the
   * one after that. It was logged as a write that might work next time, which
   * meant one warn per refused section per restart, forever, into the status
   * channel — the slow version of the flood the coalescing there exists to
   * stop.
   */
  it('marks a section Discord refuses outright and says so once', async () => {
    const refused = new DiscordAPIError(
      { code: RESTJSONErrorCodes.InvalidFormBodyOrContentType, message: 'Invalid Form Body' },
      RESTJSONErrorCodes.InvalidFormBodyOrContentType,
      400,
      'PATCH',
      'https://discord.com/api/v10/channels/0/messages/m1',
      {},
    )

    // The first edit carries the section Discord will not take; the mark that
    // follows carries the text it stored earlier, which it takes.
    let refusals = 0

    const docs = docsHarness({
      messages: [{ title: 'One', description: 'old' }],
      rejects: (call) => (call === 'edit m1' && refusals++ === 0 ? refused : undefined),
    })

    await syncManual(parseManual(manual(['One', 'new'])), docs.channel, docs.pause)

    // The failed edit, then the mark — which carries the text Discord already
    // accepted, so it is a payload it has taken before.
    expect(docs.calls).toEqual(['read', 'edit m1', 'edit m1'])
    expect(docs.messages()).toEqual([{ id: 'm1', title: 'One', description: 'old', footer: STALE }])

    expect(said('Discord refused a manual section outright')).toBe(1)
    expect(said('could not update a manual section')).toBe(0)

    // The next start, with the mark in the channel: it tries once more, because
    // the file may have been fixed, and says nothing when it has not.
    const next = docsHarness({
      messages: [{ title: 'One', description: 'old', footer: STALE }],
      rejects: (call) => (call === 'edit m1' ? refused : undefined),
    })

    stderr.length = 0
    await syncManual(parseManual(manual(['One', 'new'])), next.channel, next.pause)

    expect(next.calls).toEqual(['read', 'edit m1'])
    expect(stderr.join('')).toBe('')
  })
})

/**
 * RATE LIMITS. A first run on a ten-section manual is ten posts and a rewritten
 * one is ten edits, arriving in the first second after a restart. Serialised is
 * the floor; spaced out is what keeps it well under Discord's per-channel
 * allowance without anybody having to reason about the exact number.
 */
describe('the manual — what it costs Discord', () => {
  const ten = parseManual(
    manual(...Array.from({ length: 10 }, (_, i) => [`H${String(i)}`, `body ${String(i)}`] as const)),
  )

  it('never has two requests in flight at once', async () => {
    const docs = docsHarness()

    await syncManual(ten, docs.channel, docs.pause)

    expect(docs.calls).toHaveLength(11)
    expect(docs.peak()).toBe(1)
  })

  /** Between writes and never before the first, so a one-section change waits
   * for nothing at all. */
  it('waits between writes and not before the first one', async () => {
    const docs = docsHarness()

    await syncManual(ten, docs.channel, docs.pause)
    expect(docs.pauses()).toBe(9)

    const one = docsHarness({ messages: [{ title: 'One', description: 'old' }] })
    await syncManual(parseManual(manual(['One', 'new'])), one.channel, one.pause)
    expect(one.pauses()).toBe(0)
  })

  /**
   * THE PACING IS THE DEFAULT AND NOT SOMETHING A CALLER HAS TO REMEMBER. Every
   * other case here injects an instant pause, so without this one the argument
   * could default to nothing at all and every test would still pass.
   */
  it('spaces its writes out on its own, with nobody passing a pause', async () => {
    vi.useFakeTimers()

    try {
      const docs = docsHarness()
      const done = syncManual(parseManual(manual(['One', 'a'], ['Two', 'b'])), docs.channel)

      await vi.advanceTimersByTimeAsync(0)
      expect(docs.calls).toEqual(['read', 'post One'])

      await vi.advanceTimersByTimeAsync(1000)
      await done

      expect(docs.calls).toEqual(['read', 'post One', 'post Two'])
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * REGRESSION. A SHUTDOWN IN THE MIDDLE OF A PACED RUN SAID NOTHING AT ALL.
   *
   * The wait between two writes is deliberately unreffed — a documentation edit
   * is not a reason for `systemctl stop` to sit through its timeout — so a stop
   * during a ten-section first run takes the remaining nine writes with it. It
   * used to take them silently: a half-published channel, and nothing anywhere
   * saying why. The next start does finish the job, and somebody reading the
   * journal afterwards still has to be able to see that this one did not.
   *
   * THE LISTENER IS CALLED RATHER THAN THE EVENT EMITTED. Emitting `exit` in a
   * test runner runs the runner's own teardown; what this needs to know is that
   * something is listening for the process to go, that it says the right thing,
   * and that it is taken off again when the wait ends.
   */
  it('says so when the process goes down between two writes', async () => {
    const docs = docsHarness()

    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const before = process.listeners('exit')
    const two = parseManual(manual(['One', 'a'], ['Two', 'b']))
    const run = syncManual(two, docs.channel, () => held)

    await settle()
    expect(docs.calls).toEqual(['read', 'post One'])

    const [abandoned] = process.listeners('exit').filter((listener) => !before.includes(listener))
    if (abandoned === undefined) throw new Error('nothing was listening for the process to go')

    // The exit code Node would hand it. Nothing reads it; it is what the
    // listener's signature says an `exit` listener is given.
    abandoned(0)

    // INFO — the journal and not the status channel. A restart part-way
    // through a documentation sync is what `systemctl restart` looks like from
    // in here, the next start finishes the job, and the line is for whoever is
    // reading the journal afterwards wondering why the channel is half written.
    expect(stdout.join('')).toContain('level=info')
    expect(stdout.join('')).toContain('going down between two manual writes')
    expect(stdout.join('')).toContain('written=1')
    expect(stderr.join('')).toBe('')

    release()
    await run

    // And it is taken off again, so a bot that finishes its sync does not carry
    // a listener that would say this on a clean shutdown hours later.
    expect(docs.calls).toEqual(['read', 'post One', 'post Two'])
    expect(process.listeners('exit').filter((listener) => !before.includes(listener))).toEqual([])
  })
})

/**
 * REGRESSION, AND IT WAS UNBOUNDED GROWTH.
 *
 * The channel is read back with one un-paginated fetch, capped at Discord's
 * per-request maximum of a hundred — and Discord answers newest-first, so the
 * messages that fall off the end are the OLDEST. A channel holding more than
 * that came back as a read that had never seen the top of the manual: those
 * sections looked deleted by hand and were posted again at the bottom, and the
 * messages of whatever the read did carry that the file no longer named were
 * deleted. One duplicate per section, on every restart, forever.
 *
 * SO A TRUNCATED READ IS NOT THE STATE OF THE CHANNEL and nothing may be
 * derived from it, and a manual that would put the channel into that state is
 * refused before the first section of it is posted.
 */
describe('the manual — a read that did not see the whole channel', () => {
  it('derives nothing at all from a truncated read', async () => {
    const docs = docsHarness({
      messages: [
        { title: 'One', description: 'first' },
        { title: 'Two', description: 'second' },
      ],
      truncated: true,
    })

    await syncManual(
      parseManual(manual(['One', 'changed'], ['New', 'new'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read'])
    expect(docs.messages()).toHaveLength(2)
    expect(said('more messages than one read can carry')).toBe(1)
  })

  it('refuses a manual with more sections than one read can carry', async () => {
    const docs = docsHarness()

    const many = parseManual(
      manual(...Array.from({ length: 100 }, (_, i) => [`H${String(i)}`, 'body'] as const)),
    )

    await syncManual(many, docs.channel, docs.pause)

    expect(docs.calls).toEqual([])
    expect(said('more sections than one read of the channel can carry')).toBe(1)
  })

  /**
   * THE SEAM ITSELF, which is the only place the fetch limit is a real number.
   * The reconciler above is handed `complete` by the port; this is the half
   * that has to work it out from what Discord returned, and it is where the
   * whole duplication bug lived.
   */
  it('reports a full page as a read that may have stopped short', async () => {
    const page = (count: number): Client =>
      ({
        user: { id: DOCS_SELF },
        channels: {
          fetch: () =>
            Promise.resolve({
              isSendable: () => true,
              messages: {
                fetch: () =>
                  Promise.resolve(
                    new Map(
                      Array.from({ length: count }, (_, i) => [
                        `m${String(i)}`,
                        {
                          id: `m${String(i)}`,
                          author: { id: DOCS_SELF },
                          embeds: [{ title: `H${String(i)}`, description: 'b', footer: null }],
                          createdTimestamp: i,
                        },
                      ]),
                    ),
                  ),
              },
            }),
        },
      }) as unknown as Client

    await expect(docsChannel(page(100), DOCS_CHANNEL).read()).resolves.toMatchObject({
      complete: false,
    })

    const short = await docsChannel(page(99), DOCS_CHANNEL).read()

    expect(short.complete).toBe(true)
    expect(short.sections).toHaveLength(99)
  })
})

/**
 * A CHANNEL THAT CANNOT BE USED LATCHES OFF AFTER ONE LINE, the way
 * `statusReporter` does and for the same reason: a wrong id, a deleted channel
 * or a missing permission does not get better by being retried, and retrying it
 * costs a journal line and a failed request per section.
 */
describe('the manual — a channel the bot cannot use', () => {
  const refused = new DiscordAPIError(
    { code: RESTJSONErrorCodes.MissingPermissions, message: 'Missing Permissions' },
    RESTJSONErrorCodes.MissingPermissions,
    403,
    'POST',
    'https://discord.com/api/v10/channels/0/messages',
    {},
  )

  it('says so once and writes nothing when the channel cannot be read', async () => {
    const docs = docsHarness({ rejects: (call) => (call === 'read' ? refused : undefined) })

    await syncManual(parseManual(manual(['One', 'a'], ['Two', 'b'])), docs.channel, docs.pause)

    expect(docs.calls).toEqual(['read'])
    expect(said('docs channel unusable')).toBe(1)
  })

  it('stops after the first write that proves the channel is unusable', async () => {
    const docs = docsHarness({ rejects: (call) => (call.startsWith('post') ? refused : undefined) })

    await syncManual(
      parseManual(manual(['One', 'a'], ['Two', 'b'], ['Three', 'c'])),
      docs.channel,
      docs.pause,
    )

    // One attempt, not one per section.
    expect(docs.calls).toEqual(['read', 'post One'])
    expect(said('docs channel unusable')).toBe(1)
  })

  /**
   * A TRANSIENT FAILURE IS NOT A LATCH. A rate limit or a 500 in the middle of a
   * run must not stop the rest of the manual going out, and the next start
   * reconciles whatever this one missed.
   */
  it('carries on past a failure that might work next time', async () => {
    const docs = docsHarness({
      rejects: (call) => (call === 'post Two' ? new Error('429 Too Many Requests') : undefined),
    })

    await syncManual(
      parseManual(manual(['One', 'a'], ['Two', 'b'], ['Three', 'c'])),
      docs.channel,
      docs.pause,
    )

    expect(docs.calls).toEqual(['read', 'post One', 'post Two', 'post Three'])
    expect(said('docs channel unusable')).toBe(0)

    // INFO, AND THE TEST NAME IS THE ARGUMENT: it works next time. The next
    // start reads the channel back and publishes whatever this run did not, so
    // there is nothing for anybody to do and the status channel is not told.
    // The failure that WOULD need a person — a channel this bot cannot write in
    // at all — is the error line the assertion above says did not happen.
    expect(stdout.join('')).toContain('level=info msg="could not post a manual section"')
    expect(stderr.join('')).toBe('')
  })
})

/**
 * SPLITTING THE FILE. The parser decides what a section IS, so everything above
 * rests on it: a heading it invents becomes a message nobody wrote, and a
 * heading it misses silently welds two sections into one.
 */
describe('the manual — splitting the file into sections', () => {
  it('splits on top-level headings and keeps them in file order', () => {
    expect(parseManual('# One\n\nfirst\n\n# Two\n\nsecond\n')).toEqual([
      { heading: 'One', body: 'first' },
      { heading: 'Two', body: 'second' },
    ])
  })

  /** `##` is part of the body. One embed per TOP-level heading was the owner's
   * decision, and a parser that split on every heading would post a message per
   * paragraph. */
  it('treats a sub-heading as body', () => {
    expect(parseManual('# One\n\n## Detail\n\nfirst\n')).toEqual([
      { heading: 'One', body: '## Detail\n\nfirst' },
    ])
  })

  /**
   * A `#` INSIDE A CODE FENCE IS NOT A HEADING. A shell example carries comment
   * lines, and a parser that did not track fences would cut the section in half
   * at one and post a section called "set the token".
   */
  it('does not split on a comment inside a fenced block', () => {
    const source = ['# One', '', '```sh', '# set the token', 'export X=1', '```', ''].join('\n')

    expect(parseManual(source)).toEqual([
      { heading: 'One', body: '```sh\n# set the token\nexport X=1\n```' },
    ])
  })

  /**
   * TEXT ABOVE THE FIRST HEADING IS IN NO SECTION AND IS NOT POSTED, and the
   * warning is what stops that being drift the bot caused. A document whose
   * first paragraph vanished quietly is the exact failure this feature exists to
   * prevent.
   */
  it('warns about a preamble rather than dropping it silently', () => {
    expect(parseManual('a note to the reader\n\n# One\n\nfirst\n')).toEqual([
      { heading: 'One', body: 'first' },
    ])

    expect(stderr.join('')).toContain('text above its first heading')
    expect(stderr.join('')).toContain('lines=1')
  })

  it('reads a file written with Windows line endings', () => {
    expect(parseManual('# One\r\n\r\nfirst\r\n')).toEqual([{ heading: 'One', body: 'first' }])
  })

  it('has nothing to say about an empty file', () => {
    expect(parseManual('')).toEqual([])
    expect(stderr.join('')).toBe('')
  })

  /**
   * REGRESSION. `# Heading #` was a different heading from `# Heading`.
   *
   * A trailing run of hashes is a closing sequence: every markdown renderer
   * there is reads that line as "Heading", and this read it as "Heading #".
   * The heading is the key the whole reconciliation turns on, so the two are
   * different sections — the file's section matched no message and was posted
   * as a new one, and the message it should have matched was deleted as no
   * longer being in the file. Both, from adding two characters nobody can see.
   */
  it('reads a closed heading the way markdown does', () => {
    expect(parseManual('# One #\n\nfirst\n')).toEqual([{ heading: 'One', body: 'first' }])
    expect(parseManual('# One ###\n\nfirst\n')).toEqual([{ heading: 'One', body: 'first' }])
  })

  /** And only a run separated by whitespace, exactly as the rest of markdown
   * has it, so a heading that ends in a real hash keeps it. */
  it('keeps a hash that is part of the heading', () => {
    expect(parseManual('# C# and F#\n\nfirst\n')).toEqual([
      { heading: 'C# and F#', body: 'first' },
    ])
  })

  /**
   * A HEADING IS PLAIN TEXT, AND THE RULE IS SAID RATHER THAN ENFORCED. It
   * becomes an embed TITLE, where Discord formats nothing, so `**Loud**` in the
   * file is four asterisks in the channel. Stripping them would silently change
   * the key this file matches on and refusing the section would take a page of
   * documentation out of the channel over a pair of asterisks, so the section
   * is published as written and there is one line saying why it looks like it
   * does. docs/bot-manual.md states the rule for the people writing the file.
   */
  it('says when a heading carries markdown, and publishes it anyway', () => {
    expect(parseManual('# **Loud** and `quoted`\n\nfirst\n')).toEqual([
      { heading: '**Loud** and `quoted`', body: 'first' },
    ])

    expect(said('a manual heading carries markdown')).toBe(1)
  })

  /** And not about an underscore inside a word: Discord does not italicise one,
   * and this repo's headings are full of variable names. A warning nobody can
   * act on is a warning everybody learns to ignore. */
  it('says nothing about a variable name in a heading', () => {
    expect(parseManual('# The BLITZ_LOG_CHANNEL_ID channel\n\nfirst\n')).toEqual([
      { heading: 'The BLITZ_LOG_CHANNEL_ID channel', body: 'first' },
    ])

    expect(stderr.join('')).toBe('')
  })
})

/**
 * WHICH MESSAGES ARE THE BOT'S TO EDIT AND DELETE. Everything this lets through
 * is a message the reconciler may remove, so a mistake here is the bot deleting
 * somebody else's post out of a channel it was given for its own documentation.
 */
describe('the manual — whose messages are read back', () => {
  const SELF = '121212121212121212'

  type Embed = {
    title: string | null
    description: string | null
    footer: { text: string } | null
  }

  const message = (
    over: Partial<{
      id: string
      author: { id: string }
      embeds: Embed[]
      createdTimestamp: number
    }> = {},
  ): {
    id: string
    author: { id: string }
    embeds: Embed[]
    createdTimestamp: number
  } => ({
    id: 'a',
    author: { id: SELF },
    embeds: [{ title: 'One', description: 'first', footer: { text: STAMP } }],
    createdTimestamp: 1,
    ...over,
  })

  it('takes its own single-embed messages and nothing else', () => {
    expect(
      ours(
        [
          message({ id: 'mine' }),
          message({ id: 'someone else', author: { id: AUTHOR } }),
          message({ id: 'no embed', embeds: [] }),
          message({
            id: 'two embeds',
            embeds: [
              { title: 'One', description: 'first', footer: null },
              { title: 'Two', description: 'second', footer: null },
            ],
          }),
          message({
            id: 'no title',
            embeds: [{ title: null, description: 'first', footer: null }],
          }),
        ],
        SELF,
      ).map((section) => section.id),
    ).toEqual(['mine'])
  })

  /**
   * OLDEST FIRST, because `messages.fetch` answers newest first and the order is
   * what pairs two sections sharing a heading with the right two messages.
   */
  it('puts the channel back in the order it reads', () => {
    expect(
      ours(
        [
          message({ id: 'c', createdTimestamp: 3 }),
          message({ id: 'a', createdTimestamp: 1 }),
          message({ id: 'b', createdTimestamp: 2 }),
        ],
        SELF,
      ).map((section) => section.id),
    ).toEqual(['a', 'b', 'c'])
  })

  /** An embed with no description and a section with an empty body have to
   * become the same value, or the comparison is never equal and the section is
   * rewritten on every start. */
  it('reads a missing description as an empty one', () => {
    expect(
      ours([message({ embeds: [{ title: 'One', description: null, footer: null }] })], SELF),
    ).toEqual([{ id: 'a', title: 'One', description: '', footer: '' }])
  })

  /**
   * THE FOOTER IS READ BACK, AND IT IS THE ONLY MEMORY THIS FEATURE HAS. A
   * section the bot could not publish is stamped in the channel, and the next
   * start reads that stamp to know it has already reported the refusal. A
   * filter that dropped the footer would make every restart report it again,
   * which is the flood the stamp exists to stop.
   */
  it('carries the footer back, because that is where the stale mark lives', () => {
    expect(
      ours(
        [message({ embeds: [{ title: 'One', description: 'first', footer: { text: STALE } }] })],
        SELF,
      ),
    ).toEqual([{ id: 'a', title: 'One', description: 'first', footer: STALE }])
  })
})

/**
 * THE FILE ON DISK, AND THE ONE RULE THAT OUTRANKS THIS WHOLE FEATURE:
 * moderation is never blocked by documentation.
 */
describe('the manual — the file, and the bot carrying on without it', () => {
  it('is read from the root of whichever checkout is running', () => {
    // Derived from the module's own location like `deployedCommitPath`, so a
    // bot run out of a checkout reads that checkout's manual.
    expect(botManualPath()).toBe(
      join(fileURLToPath(new URL('..', import.meta.url)), 'docs', 'bot-manual.md'),
    )
  })

  it('answers null and warns once when there is no manual', async () => {
    await expect(readManual(join(tmpdir(), 'blitz-bot-no-such-manual.md'))).resolves.toBeNull()

    expect(said('no bot manual on disk')).toBe(1)
    expect(stderr.join('')).toContain('level=warn')
  })

  /**
   * A MISSING MANUAL TOUCHES THE CHANNEL AT ALL, and in particular does not read
   * it as "the manual is now empty" and delete every section in it. That would
   * be the worst possible reading of a file that is simply not there — a
   * checkout of an older commit, a botched deploy.
   */
  it('leaves the channel alone entirely when the file is missing', async () => {
    const docs = docsHarness({ messages: [{ title: 'One', description: 'first' }] })
    const { client, ready } = docsClient()

    syncDocsChannel(
      client,
      DOCS_CHANNEL,
      () => readManual(join(tmpdir(), 'blitz-bot-no-such-manual.md')),
      () => docs.channel,
    )

    ready()
    await settle()

    expect(docs.calls).toEqual([])
    expect(docs.messages()).toHaveLength(1)
  })

  /**
   * AND THE BOT GOES ON MODERATING. Documentation is the least important thing
   * this process does, and a manual that could not be published is not a reason
   * for the scanner to be off.
   */
  it('leaves the message listeners armed when the manual cannot be published', async () => {
    const client = createClient(cfg({ docsChannelId: DOCS_CHANNEL }))

    expect(client.listenerCount(Events.MessageCreate)).toBe(2)
    expect(client.listenerCount(Events.MessageUpdate)).toBe(1)

    await client.destroy()
  })

  /** Every failure below `syncDocsChannel` ends there. Nothing it does may
   * reach the process as an unhandled rejection. */
  it('swallows a read that blows up in some way nobody expected', async () => {
    const { client, ready } = docsClient()

    syncDocsChannel(
      client,
      DOCS_CHANNEL,
      () => Promise.reject(new Error('disk on fire')),
      () => docsHarness().channel,
    )

    ready()
    await settle()

    expect(stderr.join('')).toContain('the bot manual could not be synchronised')
  })

  it('registers nothing at all when no docs channel is configured', async () => {
    const quiet = createClient(cfg())
    expect(quiet.listenerCount(Events.ClientReady)).toBe(1)
    await quiet.destroy()

    const wired = createClient(cfg({ docsChannelId: DOCS_CHANNEL }))
    expect(wired.listenerCount(Events.ClientReady)).toBe(2)
    await wired.destroy()
  })

  it('is wired to the docs channel id and to no other', async () => {
    // A source assertion because all three optional ids are strings: a fake
    // client cannot tell which of `config`'s fields was handed over, and getting
    // it wrong points the bot at a channel of evidence it would then edit.
    const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8')

    expect(source).toContain('syncDocsChannel(client, config.docsChannelId)')
    expect(source).not.toMatch(/syncDocsChannel\([^)]*(?:logChannelId|statusChannelId)/u)
  })
})

/**
 * THE MAINTENANCE WATCHER, AS FAR AS THIS FILE OWNS IT. Everything it does once
 * it is running — which states post, what a blind read means, what a restart
 * must not re-announce — is maintenance.ts's own file. What is decided HERE is
 * whether it is installed at all, and against which of four channel ids.
 */
describe('the maintenance watcher — installed, and only when there is a channel', () => {
  const MAINTENANCE_CHANNEL = '999999999999999999'

  /**
   * UNSET DOES MORE THAN "POST NOWHERE". With no channel there is nothing to
   * announce to, so the row is not polled — this process makes no AWS call it
   * would otherwise make four times a minute, for the life of a bot that is live
   * today with the variable unset.
   */
  it('registers nothing at all when no maintenance channel is configured', async () => {
    const quiet = createClient(cfg())
    expect(quiet.listenerCount(Events.ClientReady)).toBe(1)
    await quiet.destroy()

    const wired = createClient(cfg({ maintenanceChannelId: MAINTENANCE_CHANNEL }))
    expect(wired.listenerCount(Events.ClientReady)).toBe(2)
    await wired.destroy()
  })

  /**
   * A SOURCE ASSERTION, for the reason the docs channel's is one: all four
   * optional ids are strings, so no fake client can tell which of them was
   * handed over — and this is the only one of the four that players read. An
   * outage notice in the moderation log is an announcement nobody sees; the
   * moderation log in an announcement channel is worse.
   */
  it('is wired to the maintenance channel id and to no other', async () => {
    const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8')

    expect(source).toContain('watchMaintenance(client, config.maintenanceChannelId, createDdb())')
    expect(source).not.toMatch(
      /watchMaintenance\([^)]*(?:logChannelId|statusChannelId|docsChannelId)/u,
    )
  })

  /**
   * IT SURVIVES THE HALT, UNLIKE THE MESSAGE LISTENERS, and that is asserted
   * from the source rather than by emitting `clientReady` — the first poll runs
   * immediately, and a case that fired it would be a test making a real
   * DynamoDB call. The halt names the two events it takes off; a third name
   * appearing in that list is what this would catch.
   */
  it('is not among the listeners the halt takes off', async () => {
    const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8')

    const removed = [...source.matchAll(/removeAllListeners\(Events\.(\w+)\)/gu)].map(
      (match) => match[1],
    )

    expect(removed.sort()).toEqual(['MessageCreate', 'MessageUpdate'])
  })
})

/**
 * THE MANUAL THIS REPO SHIPS, checked against the channel it has to fit in and
 * against the bot it claims to describe.
 *
 * WHY A TEST AND NOT A PROOFREAD. The document is posted by a live bot to a
 * channel admins read, so a section that is too long stops being published and
 * a heading used twice weakens the matching — and both of those are edits
 * anybody could make to a markdown file without ever running the bot.
 */
describe('docs/bot-manual.md — the document that actually ships', () => {
  const shipped = async (): Promise<string> => {
    const markdown = await readManual()
    if (markdown === null) throw new Error('docs/bot-manual.md is missing from this repo')
    return markdown
  }

  it('fits the channel, section by section', async () => {
    const sections = parseManual(await shipped())

    expect(sections.length).toBeGreaterThan(0)

    // In UTF-16 units, which is what Discord counts and therefore what the
    // check in `fitEmbed` counts. Measuring code points here would let a
    // document through that the bot then refuses to publish.
    for (const section of sections) {
      expect(section.heading.length, section.heading).toBeLessThanOrEqual(256)
      expect(section.body.length, section.heading).toBeLessThanOrEqual(4096)
      expect(section.body, section.heading).not.toBe('')
    }

    // No repeated heading — so the key is unique — and no preamble above the
    // first one. Both would have written a warning while parsing.
    expect(new Set(sections.map((section) => section.heading)).size).toBe(sections.length)
    expect(stderr.join('')).toBe('')
  })

  /**
   * IT DESCRIBES THE BOT AS IT IS TODAY. Each of these is a thing the code
   * really does and a thing an admin would otherwise have to read src/ to find
   * out — the surfaces the scan reads being the least obvious of them.
   */
  it('describes what the bot really does', async () => {
    const markdown = (await shipped()).toLowerCase()

    for (const subject of [
      'embed',
      'forward',
      'component',
      'edit',
      'dry run',
      'exempt',
      'webhook',
      'blitz_log_channel_id',
      'blitz_status_channel_id',
      'blitz_docs_channel_id',
      // The FEATURE, not the sentence the bot posts. This used to be `running
      // commit`, which pinned one wording of one message in a document that
      // only has to say the notice exists — so changing the wording broke a
      // test about the manual, and leaving the wording in the manual made the
      // manual a second place the message is written down.
      'deploy notice',
    ]) {
      expect(markdown, subject).toContain(subject)
    }
  })

  /**
   * AND IT NAMES EVERY COMMAND THE BOT REGISTERS, NO MORE AND NO FEWER.
   *
   * THE LIST IS READ OUT OF `COMMANDS` RATHER THAN TYPED HERE, and that is the
   * whole point of this test. What stood here before asserted the manual
   * contained the words "No slash commands" — true when it was written, and
   * four commands later it was a test holding a false statement in place in a
   * document a live bot posts to a channel admins read. A name typed into this
   * file would be the same mistake one step along: registering a fifth command
   * has to fail something until the manual describes it, and the only list that
   * cannot drift from the code is the code's own.
   *
   * BOTH DIRECTIONS, because the old assertion guarded one of them. A command
   * missing from the manual is an admin who cannot find out what the bot can
   * do; a command in the manual and not in `COMMANDS` is worse — several are
   * specced and unbuilt, and a manual promising one has admins typing at a bot
   * that answers nothing.
   */
  it('names every command the bot registers, and no others', async () => {
    const markdown = await shipped()

    // How a command is written in the file: slash, lowercase, and preceded by
    // the start of a line, a space or a backtick so that `docs/bot-manual.md`
    // is not read as a command — and not followed by `/` or `.`, so that an
    // absolute path added to the file later is not read as one either.
    const mentioned = [
      ...markdown.matchAll(/(?:^|[\s`(])\/([a-z][a-z0-9-]*)(?![\w/.])/gmu),
    ].map((match) => match[1] ?? '')

    const registered = COMMANDS.map((command) => command.data.name)

    // Not a vacuous pass on the day both are empty: the bot has commands, and a
    // build where it does not is a different question from this one.
    expect(registered.length).toBeGreaterThan(0)
    expect([...new Set(mentioned)].sort()).toEqual([...registered].sort())
  })
})

/**
 * WHERE THE COMMANDS ARE WIRED, which is the half of the old manual test worth
 * keeping. It read the absence of an interaction listener in client.ts as proof
 * that the bot had no commands at all; it has four, and they are installed from
 * index.ts instead. The absence still means something, and it is the reason
 * this file's subject can be described on its own: moderation's listeners and
 * the command listener go on separately, so a fault in one cannot take the
 * other off.
 */
describe('the command listener — installed apart from moderation', () => {
  it('is not registered anywhere in client.ts', async () => {
    const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8')

    expect(source).not.toContain('InteractionCreate')
  })
})
