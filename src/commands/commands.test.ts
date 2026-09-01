import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonStyle,
  ComponentType,
  Events,
  MessageFlags,
  type ChatInputApplicationCommandData,
  type Client,
} from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Config } from '../config.ts'
import { setSink } from '../log.ts'
import {
  refusalFor,
  runCommand,
  TARGET_OPTION,
  type BotCommand,
  type CommandComponentRow,
  type Invocation,
  type Responder,
} from './command.ts'
import { DRAIN_NOTE_OPTION } from './drain.ts'
import { help } from './help.ts'
import { STICKY_TEXT_OPTION } from './sticky.ts'
import {
  COMMANDS,
  commandData,
  installCommands,
  invocationOf,
  registerCommands,
  responderFor,
  roleIdsOf,
  type CommandRegistry,
  type CommandSource,
  type InteractionMember,
  type InteractionUser,
  type RegistrationGuild,
  type ReplyTarget,
  type SuppliedOption,
} from './index.ts'

/**
 * The slash-command foundation, offline.
 *
 * NOTHING HERE TOUCHES DISCORD. `refusalFor` and `runCommand` take plain
 * records and an injected responder, `registerCommands` takes a guild that is
 * three fields long, and `installCommands` is handed a client that only knows
 * how to remember a listener. So the gate, the registration and every failure
 * path run against objects written a few lines above their assertions, with no
 * gateway, no token and no application to register a command against.
 *
 * THE GATE IS THE POINT OF THE FILE. `defaultMemberPermissions: 0n` hides an
 * admin command in every Discord client, so a test that only ever drives the
 * happy path would pass just as well against a build with no gate at all —
 * right up until somebody with Manage Server re-grants the command to
 * @everyone under Server Settings -> Integrations, which needs no code and
 * tells the bot nothing. Several cases below exist for that one path.
 *
 * THE COMMANDS ARE PURPOSE-BUILT, NOT /help. Whether /help is admin-only is not
 * decided yet and is meant to be a one-line change, so hanging the gate's tests
 * on it would mean flipping that word breaks half this file.
 */

const GUILD = '111111111111111111'
const ADMIN_ROLE = '222222222222222222'
const OTHER_ROLE = '333333333333333333'
const MEMBER = '444444444444444444'
const TARGET = '555555555555555555'
const CHANNEL = '666666666666666666'

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

function cfg(over: Partial<Config> = {}): Config {
  return {
    discordToken: 'token',
    guildId: GUILD,
    adminRoleId: null,
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

function invocation(over: Partial<Invocation> = {}): Invocation {
  return {
    commandName: 'guarded',
    guildId: GUILD,
    channelId: CHANNEL,
    userId: MEMBER,
    roleIds: [OTHER_ROLE],
    targetId: null,
    text: null,
    ...over,
  }
}

/** An admin-only command that says what it was given, for the gate's cases. */
function guarded(over: Partial<BotCommand> = {}): BotCommand {
  return {
    data: { name: 'guarded', description: 'a command that exists only in this file' },
    adminOnly: true,
    onlyInvoker: () => true,
    run: () => 'the handler ran',
    ...over,
  }
}

function responder(): Responder & {
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

/**
 * THE GATE, and it is the half of this feature that has to be right. Everything
 * above it in the stack — the hidden command, the greyed-out entry in the
 * picker — is a hint Discord gives its own users and is not a permission.
 */
describe('the gate is a role check in the handler, not a permission on the command', () => {
  it('lets a holder of the admin role through', () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE })
    const who = invocation({ roleIds: [OTHER_ROLE, ADMIN_ROLE] })

    expect(refusalFor(guarded(), who, config)).toBeNull()
  })

  it('refuses a member who does not hold it', () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE })

    expect(refusalFor(guarded(), invocation(), config)).toBe('not-admin')
  })

  it('refuses a member who holds no roles at all', () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE })

    expect(refusalFor(guarded(), invocation({ roleIds: [] }), config)).toBe('not-admin')
  })

  /**
   * FAIL CLOSED. An unset DISCORD_ADMIN_ROLE_ID means nobody in the guild can
   * be identified as an admin, and the only safe reading of that is that
   * nobody is one. The same variable unset on the moderation path means the
   * opposite — every message is scanned rather than none — and both are the
   * closed direction for what they guard. An unset variable must never be the
   * thing that opens a door.
   */
  it('refuses everybody when no admin role is configured', () => {
    expect(refusalFor(guarded(), invocation({ roleIds: [ADMIN_ROLE] }), cfg())).toBe(
      'admin-role-unset',
    )
  })

  /**
   * Null roles are not an empty role list: it means the payload arrived with no
   * member on it at all. Discord ships roles complete on every interaction, so
   * this should not happen — and "should not happen" is not a reason to let
   * somebody in.
   */
  it('refuses when the payload carried no member', () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE })

    expect(refusalFor(guarded(), invocation({ roleIds: null }), config)).toBe('roles-unreadable')
  })

  it('refuses outside a guild, whether or not the command is admin-only', () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE })
    const nowhere = invocation({ guildId: null, roleIds: [ADMIN_ROLE] })

    expect(refusalFor(guarded(), nowhere, config)).toBe('not-in-guild')
    expect(refusalFor(guarded({ adminOnly: false }), nowhere, config)).toBe('not-in-guild')
  })

  it('lets anybody run a command that is not admin-only', () => {
    const open = guarded({ adminOnly: false })

    expect(refusalFor(open, invocation({ roleIds: [] }), cfg())).toBeNull()
    expect(refusalFor(open, invocation({ roleIds: null }), cfg())).toBeNull()
  })

  /**
   * A GATE THAT IS A QUESTION ABOUT THE INVOCATION. `/profile` is the command
   * this exists for — see profile.test.ts, which asserts it through the real
   * one — and the cases here are about the FRAMEWORK: a predicate is resolved
   * before anything else happens, and `true` out of one is the same thing as
   * the constant.
   */
  it('resolves a gate that is a predicate against the invocation it was given', () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE })
    const conditional = guarded({ adminOnly: (one) => one.targetId !== null })

    // The role is not held, so the answer is entirely the predicate's.
    expect(refusalFor(conditional, invocation({ targetId: TARGET }), config)).toBe('not-admin')
    expect(refusalFor(conditional, invocation({ targetId: null }), config)).toBeNull()
  })

  /**
   * THE HALF THAT MUST NOT BE WEAKENED. Making one refusal conditional must not
   * make any of the others conditional too: once the predicate says yes, every
   * closed direction the framework has is exactly where it was, in the same
   * order. `not-in-guild` sits ABOVE the predicate and refuses whatever it
   * would have answered — which is why a payload with no guild is refused here
   * even though this predicate would have let it through.
   */
  it('keeps every closed direction once a predicate says the gate applies', () => {
    const conditional = guarded({ adminOnly: (one) => one.targetId !== null })
    const targeted = invocation({ targetId: TARGET, roleIds: [ADMIN_ROLE] })

    expect(refusalFor(conditional, targeted, cfg())).toBe('admin-role-unset')
    expect(
      refusalFor(conditional, invocation({ targetId: TARGET, roleIds: null }), cfg({ adminRoleId: ADMIN_ROLE })),
    ).toBe('roles-unreadable')

    const open = invocation({ targetId: null, guildId: null, roleIds: [ADMIN_ROLE] })
    expect(refusalFor(conditional, open, cfg({ adminRoleId: ADMIN_ROLE }))).toBe('not-in-guild')
  })

  /**
   * A PREDICATE IS NEVER CONSULTED FOR ANYTHING BUT THE GATE, and it is asked
   * once. It is written in a command file, so treating it as a general hook —
   * calling it twice, or calling it for a command Discord did not send — would
   * make a command file's function a thing the dispatcher depends on for more
   * than it says.
   */
  it('asks the predicate exactly once, and only about the gate', () => {
    const asked: Invocation[] = []
    const config = cfg({ adminRoleId: ADMIN_ROLE })

    const conditional = guarded({
      adminOnly: (one) => {
        asked.push(one)
        return false
      },
    })

    const who = invocation({ targetId: TARGET })
    expect(refusalFor(conditional, who, config)).toBeNull()
    expect(asked).toEqual([who])
  })

  /**
   * THE PATH THAT MAKES ALL OF THE ABOVE NECESSARY. `defaultMemberPermissions:
   * 0n` is what Discord shows by default, and anybody with Manage Server can
   * re-grant the command to @everyone under Server Settings -> Integrations.
   * Nothing tells the bot; the interaction that arrives afterwards is
   * indistinguishable from an admin's. So the command below carries the hidden
   * default AND is still refused, because the default was never the gate.
   */
  it('still refuses when Discord has been told to hide the command', () => {
    const command = guarded()
    expect(commandData(command).defaultMemberPermissions).toBe(0n)

    const config = cfg({ adminRoleId: ADMIN_ROLE })
    expect(refusalFor(command, invocation(), config)).toBe('not-admin')
  })

  /**
   * NOT THE MODERATION PATH'S CACHED ROLES. client.ts remembers an author's
   * roles for sixty seconds, which is a reasonable trade for "was this message
   * scanned" and not for "may this member run an admin command": a TTL is a
   * window in which a demoted admin still holds admin. There is nothing to
   * trade anyway — the roles are on the payload — so the gate reads the record
   * it was handed and asks nothing.
   */
  it('reads the roles it was handed and asks nothing else for them', () => {
    const config = cfg({ adminRoleId: ADMIN_ROLE })

    expect(refusalFor(guarded(), invocation({ roleIds: [ADMIN_ROLE] }), config)).toBeNull()
    expect(refusalFor(guarded(), invocation({ roleIds: [OTHER_ROLE] }), config)).toBe('not-admin')
  })
})

describe('runCommand — the refusal is an answer, never a silence', () => {
  it('replies to a refused command without ever running it', async () => {
    const respond = responder()
    const run = vi.fn(() => 'the handler ran')
    const config = cfg({ adminRoleId: ADMIN_ROLE })

    await runCommand(invocation(), config, respond, [guarded({ run })])

    expect(run).not.toHaveBeenCalled()
    expect(respond.reply).toHaveBeenCalledTimes(1)
    expect(respond.edit).not.toHaveBeenCalled()
  })

  /**
   * A REFUSAL IS SEEN ONLY BY THE PERSON WHO ASKED, whatever visibility the
   * command itself would have used. A public "you may not do that" is a thing
   * an admin channel does not need and a member did not ask for.
   */
  it('shows the refusal only to the member who ran it', async () => {
    const respond = responder()
    const command = guarded({ onlyInvoker: () => false })

    await runCommand(invocation(), cfg({ adminRoleId: ADMIN_ROLE }), respond, [command])

    expect(respond.reply).toHaveBeenCalledWith(expect.any(String), true)
  })

  /** It answers directly rather than deferring: the gate is an array lookup. */
  it('does not defer a refusal', async () => {
    const respond = responder()

    await runCommand(invocation(), cfg({ adminRoleId: ADMIN_ROLE }), respond, [guarded()])

    expect(respond.defer).not.toHaveBeenCalled()
  })

  /**
   * The operator's fault and nobody else's: the command is unusable by
   * everybody until the variable is set, so it goes to stderr where a warning
   * belongs and — with a status channel configured — into Discord.
   */
  it('warns about an unset admin role, and only about that one', async () => {
    const respond = responder()

    await runCommand(invocation({ roleIds: [ADMIN_ROLE] }), cfg(), respond, [guarded()])
    expect(stderr.join('')).toContain('admin-role-unset')

    stderr.length = 0
    await runCommand(invocation(), cfg({ adminRoleId: ADMIN_ROLE }), respond, [guarded()])
    expect(stderr.join('')).not.toContain('slash command refused')
    expect(stdout.join('')).toContain('not-admin')
  })

  it('runs an admin command for an admin', async () => {
    const respond = responder()
    const config = cfg({ adminRoleId: ADMIN_ROLE })

    await runCommand(invocation({ roleIds: [ADMIN_ROLE] }), config, respond, [guarded()])

    expect(respond.defer).toHaveBeenCalledTimes(1)
    expect(respond.edit).toHaveBeenCalledWith('the handler ran')
    expect(respond.reply).not.toHaveBeenCalled()
  })

  /**
   * A command Discord knows about and this build does not means the
   * registration and the code have drifted apart. The bulk PUT makes that
   * self-correcting at the next boot; meanwhile the admin gets an answer rather
   * than a spinner that ends in "The application did not respond".
   */
  it('answers a command it does not have', async () => {
    const respond = responder()

    await runCommand(invocation({ commandName: 'gone' }), cfg(), respond, [guarded()])

    expect(respond.reply).toHaveBeenCalledWith(expect.any(String), true)
    expect(stderr.join('')).toContain('not one this bot has')
  })

  /**
   * THE WIDENED SEAM, END TO END. A handler that answers with embeds has them
   * carried through untouched — `runCommand` does not measure, reshape or
   * flatten what it was given, which is the whole reason /profile stopped
   * flattening its own embed under a message's 2000 instead of an embed's 6000.
   */
  it('carries an embed answer through to the reply exactly as the handler built it', async () => {
    const respond = responder()
    const embed = { title: 'Player profile', description: '<@444>' }
    const command = guarded({ adminOnly: false, run: () => ({ embeds: [embed] }) })

    await runCommand(invocation(), cfg(), respond, [command])

    expect(respond.edit).toHaveBeenCalledWith({ embeds: [embed] })
  })

  /** And a string answer is still a string. /help returns one and must not
   * grow a box around it because another command needed one. */
  it('leaves a text answer as text', async () => {
    const respond = responder()
    const command = guarded({ adminOnly: false, run: () => 'just a sentence' })

    await runCommand(invocation(), cfg(), respond, [command])

    expect(respond.edit).toHaveBeenCalledWith('just a sentence')
  })
})

/**
 * A THROWN HANDLER MUST BECOME A REPLY. Without this the rejection reaches the
 * listener, gets a journal line, and leaves the admin looking at "The
 * application did not respond" — a message that describes a bot which is down,
 * when what happened is one command failing for a reason already written down.
 */
describe('runCommand — a handler that fails still answers', () => {
  it('replies when the handler rejects', async () => {
    const respond = responder()
    const command = guarded({ adminOnly: false, run: () => Promise.reject(new Error('boom')) })

    await runCommand(invocation(), cfg(), respond, [command])

    expect(respond.edit).toHaveBeenCalledTimes(1)
    expect(respond.edit).toHaveBeenCalledWith(expect.any(String))
    expect(stderr.join('')).toContain('slash command handler failed')
    expect(stderr.join('')).toContain('boom')
  })

  /**
   * AND WHEN IT THROWS BEFORE RETURNING A PROMISE, which is the case a bare
   * `.catch()` on the returned value would walk straight past. A handler is
   * allowed to be synchronous, so this is not a hypothetical shape.
   */
  it('replies when the handler throws synchronously', async () => {
    const respond = responder()
    const command = guarded({
      adminOnly: false,
      run: () => {
        throw new Error('boom')
      },
    })

    await expect(runCommand(invocation(), cfg(), respond, [command])).resolves.toBeUndefined()
    expect(respond.edit).toHaveBeenCalledTimes(1)
  })

  /** The failure is edited into the reply that was already deferred. */
  it('defers first, so the answer is not racing the three-second deadline', async () => {
    const respond = responder()
    const command = guarded({
      adminOnly: false,
      run: () => Promise.reject(new Error('boom')),
    })

    await runCommand(invocation(), cfg(), respond, [command])

    expect(respond.defer).toHaveBeenCalledTimes(1)
    expect(respond.reply).not.toHaveBeenCalled()
  })
})

/**
 * THE REPLY FLAGS. `ephemeral: true` is deprecated as of discord.js 14.27, and
 * this is the only place in the bot that has to know it — a handler returns a
 * string and has nothing to pass a flag to.
 */
describe('responderFor — how an interaction is actually answered', () => {
  function target(): ReplyTarget & {
    deferReply: ReturnType<typeof vi.fn<ReplyTarget['deferReply']>>
    editReply: ReturnType<typeof vi.fn<ReplyTarget['editReply']>>
    reply: ReturnType<typeof vi.fn<ReplyTarget['reply']>>
  } {
    return {
      deferReply: vi.fn<ReplyTarget['deferReply']>(() => Promise.resolve(null)),
      editReply: vi.fn<ReplyTarget['editReply']>(() => Promise.resolve(null)),
      reply: vi.fn<ReplyTarget['reply']>(() => Promise.resolve(null)),
    }
  }

  it('defers with the flag, not with the deprecated boolean', async () => {
    const interaction = target()

    await responderFor(interaction).defer(true)

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral })
    expect(interaction.deferReply.mock.calls.at(0)?.at(0)).not.toHaveProperty('ephemeral')
  })

  /** No flag at all is what "everybody in the channel sees it" means. */
  it('defers with no flag for a reply the channel is meant to see', async () => {
    const interaction = target()

    await responderFor(interaction).defer(false)

    expect(interaction.deferReply).toHaveBeenCalledWith({})
  })

  it('replies with the flag, not with the deprecated boolean', async () => {
    const interaction = target()

    await responderFor(interaction).reply('no', true)

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'no',
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    })
    expect(interaction.reply.mock.calls.at(0)?.at(0)).not.toHaveProperty('ephemeral')
  })

  /**
   * The visibility of a deferred reply is fixed at the defer, so the edit
   * carries no flags. Passing them would be ignored rather than honoured, and
   * a reader would be entitled to think they did something.
   */
  it('edits with the content and no flags of its own', async () => {
    const interaction = target()

    await responderFor(interaction).edit('hello')

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'hello',
      allowedMentions: { parse: [] },
    })
  })

  /**
   * ═══ AND EVERY SEND THAT CARRIES TEXT SAYS SO ITSELF ═══
   *
   * `createClient` in ../client.ts SETS THIS CLIENT-WIDE AND THAT IS NOT ENOUGH
   * TO LEAN ON. Its own comment says why: the default "is silently replaced by
   * any call that passes `allowedMentions` of its own", so what it guarantees is
   * the sends that say nothing — and a reader of `responderFor`, or a test of
   * it, cannot see whether it holds. ../maintenance.ts, ../incidents.ts and
   * ../sticky.ts all restate the option at their own sends for exactly this
   * reason, and this is the fourth.
   *
   * THE THING IT GUARDS IS SOMEBODY ELSE'S TEXT. `/drain`'s reply echoes an
   * admin's note and `/help`'s body carries a `<@id>`; a code span makes the
   * first LOOK inert and does nothing about notifications, because Discord
   * decides who is pinged from the request field and not from the markdown. See
   * `noMentions` in ./index.ts and the `@everyone` case in ./drain.test.ts.
   *
   * THE FAKE HERE HAS NO CLIENT BEHIND IT, which is what makes this an assertion
   * about this seam rather than about ../client.ts.
   */
  it('suppresses every mention on both of the sends that carry text', async () => {
    const edited = target()
    const replied = target()

    await responderFor(edited).edit('@everyone the server is going down')
    await responderFor(replied).reply('@everyone you may not run this', true)

    expect(edited.editReply.mock.calls.at(0)?.at(0)?.allowedMentions).toEqual({ parse: [] })
    expect(replied.reply.mock.calls.at(0)?.at(0)?.allowedMentions).toEqual({ parse: [] })

    // The text itself is untouched: suppression is the guard, not rewriting.
    expect(edited.editReply.mock.calls.at(0)?.at(0)?.content).toBe(
      '@everyone the server is going down',
    )
  })

  /** A defer carries no text, so it takes no mention policy either. */
  it('says nothing about mentions on the defer, which has no content', async () => {
    const interaction = target()

    await responderFor(interaction).defer(true)

    expect(interaction.deferReply.mock.calls.at(0)?.at(0)).not.toHaveProperty('allowedMentions')
  })

  /**
   * THE OTHER HALF OF THE SEAM, and the reason `/profile` no longer flattens its
   * embed to text. A reply that is embeds goes out as `embeds` and carries NO
   * `content` — an empty content field beside them would be a blank line above
   * the box in every client.
   */
  it('edits with the embeds when that is what the handler answered', async () => {
    const interaction = target()
    const embed = { title: 'Player profile', description: 'somebody' }

    await responderFor(interaction).edit({ embeds: [embed] })

    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: [embed],
      allowedMentions: { parse: [] },
    })
    expect(interaction.editReply.mock.calls.at(0)?.at(0)).not.toHaveProperty('content')
  })

  /**
   * The array Discord is handed is this bot's own, not the command's. Two
   * elements at most, and the alternative is a live view of a value somebody
   * else still holds.
   */
  it('copies the array rather than handing over the one the command built', async () => {
    const interaction = target()
    const embeds = [{ title: 'one' }]

    await responderFor(interaction).edit({ embeds })

    const sent = interaction.editReply.mock.calls.at(0)?.at(0)
    expect(sent).toEqual({ embeds: [{ title: 'one' }], allowedMentions: { parse: [] } })
    expect((sent as { embeds?: unknown }).embeds).not.toBe(embeds)
  })

  /**
   * THE SEAM WIDENED A SECOND TIME, and `/profile`'s link button to the
   * Ringmaster console is what asked for it. A component is neither content nor
   * part of an embed, so a seam that carries only the first two leaves a command
   * with nothing to answer with but a bare url glued into a field.
   */
  it('edits with the components when the handler answered with some', async () => {
    const interaction = target()

    const row: CommandComponentRow = {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: 'Open in Ringmaster',
          url: 'https://ringmaster.blitz-royale.com/players/license%3Aabc',
        },
      ],
    }

    await responderFor(interaction).edit({ embeds: [{ title: 'Player profile' }], components: [row] })

    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: [{ title: 'Player profile' }],
      components: [row],
      allowedMentions: { parse: [] },
    })
  })

  /**
   * AND NO `components` KEY AT ALL WHEN THERE WERE NONE, which is not tidiness.
   * `editReply` is an EDIT: `components: []` tells Discord to take away the ones
   * that are there and an absent key tells it to leave them alone. Sending the
   * empty array anyway would make every reply in this bot carry an instruction
   * about components it has no opinion on.
   */
  it('sends no components key for a reply that has none', async () => {
    const interaction = target()

    await responderFor(interaction).edit({ embeds: [{ title: 'one' }] })

    expect(interaction.editReply.mock.calls.at(0)?.at(0)).not.toHaveProperty('components')
  })

  /** The rows are copied a level deeper, because a row IS its inner array. */
  it('copies the rows rather than handing over the ones the command built', async () => {
    const interaction = target()

    const row: CommandComponentRow = {
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, style: ButtonStyle.Link, label: 'go', url: 'https://x.test' },
      ],
    }

    await responderFor(interaction).edit({ embeds: [], components: [row] })

    const sent = interaction.editReply.mock.calls.at(0)?.at(0) as {
      components?: CommandComponentRow[]
    }

    expect(sent.components).toEqual([row])
    expect(sent.components?.at(0)).not.toBe(row)
    expect(sent.components?.at(0)?.components).not.toBe(row.components)
  })
})

describe('roleIdsOf — Discord ships the roles, in either of two shapes', () => {
  /** The raw payload's array, which is what arrives when nothing is cached. */
  it('reads the array discord.js passes straight through', () => {
    expect(roleIdsOf({ roles: [ADMIN_ROLE, OTHER_ROLE] })).toEqual([ADMIN_ROLE, OTHER_ROLE])
  })

  /**
   * And the manager discord.js builds when the member IS cached. Reading only
   * the array would make the gate see nothing for exactly those members, which
   * is a refusal for an admin who has been active recently.
   */
  it('reads the role manager discord.js builds for a cached member', () => {
    const member: InteractionMember = {
      roles: { cache: new Map([[ADMIN_ROLE, { id: ADMIN_ROLE }]]) },
    }

    expect(roleIdsOf(member)).toEqual([ADMIN_ROLE])
  })

  it('answers null when no member came with the payload', () => {
    expect(roleIdsOf(null)).toBeNull()
  })
})

describe('invocationOf — a live interaction reduced to a record', () => {
  /**
   * A Discord account as an interaction carries one.
   *
   * `displayAvatarURL` IS A FUNCTION HERE BECAUSE IT IS A METHOD THERE. The
   * whole reason `Invocation` carries a URL rather than a user object is that
   * the real one is a live discord.js `User` — so the fake has to be called,
   * not read, or this file would be asserting a shape the real thing does not
   * have. discord.js types it `displayAvatarURL(options?): string`, non-null,
   * because it falls back to Discord's default avatar.
   */
  function account(id: string, name = `display-${id}`): InteractionUser {
    return {
      id,
      displayName: name,
      displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/abc.png`,
    }
  }

  function source(over: Partial<CommandSource> = {}): CommandSource {
    return {
      commandName: 'help',
      guildId: GUILD,
      channelId: CHANNEL,
      user: account(MEMBER),
      member: { roles: [OTHER_ROLE] },
      options: { get: () => null },
      ...over,
    }
  }

  /** One supplied option, as `interaction.options.get` hands it over. */
  function optionNamed(name: string, option: SuppliedOption): CommandSource['options'] {
    return { get: (asked) => (asked === name ? option : null) }
  }

  it('carries who ran what, where, and their roles', () => {
    expect(invocationOf(source())).toEqual({
      commandName: 'help',
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      userAvatarUrl: `https://cdn.discordapp.com/avatars/${MEMBER}/abc.png`,
      roleIds: [OTHER_ROLE],
      targetId: null,
      targetAvatarUrl: undefined,
      targetDisplayName: undefined,
      text: null,
      subcommand: null,
      note: null,
    })
  })

  /**
   * THE CALLER'S AVATAR IS RESOLVED HERE AND NOWHERE ELSE, which is the seam
   * `/profile`'s thumbnail is built on. `displayAvatarURL()` is a call on a live
   * object; making it here means every handler downstream is handed a string and
   * `Invocation` stays the plain record the gate can be tested against.
   */
  it('resolves the caller’s avatar to a url rather than carrying the user', () => {
    const invocation = invocationOf(source())

    expect(invocation.userAvatarUrl).toBe(
      `https://cdn.discordapp.com/avatars/${MEMBER}/abc.png`,
    )
  })

  /**
   * AND THE TARGET'S, SEPARATELY. Two fields rather than one resolved "subject",
   * because "no target means me" is `/profile`'s rule and belongs in `/profile`
   * — a seam that resolved the subject itself would be a second copy of it in
   * the half of the code that is meant not to know what any command means.
   */
  it('resolves the target’s avatar and display name off the same option', () => {
    const options = optionNamed(TARGET_OPTION, {
      type: ApplicationCommandOptionType.User,
      user: account(TARGET, 'Tagged Person'),
    })

    const invocation = invocationOf(source({ options }))

    expect(invocation.targetId).toBe(TARGET)
    expect(invocation.targetAvatarUrl).toBe(
      `https://cdn.discordapp.com/avatars/${TARGET}/abc.png`,
    )
    expect(invocation.targetDisplayName).toBe('Tagged Person')
  })

  /**
   * THE GUILD'S NAME FOR THEM WINS, IN BOTH SHAPES DISCORD SENDS ONE.
   * discord.js hands back a live `GuildMember` when it has one cached — which
   * resolves `displayName` itself — and the raw API record when it does not,
   * which carries `nick`. `/profile` compares an in-game name against what the
   * reader is actually looking at, and the `<@id>` mention beside it renders as
   * the nickname, so the account's global name is the wrong answer whenever the
   * two differ.
   */
  it('prefers a cached member’s display name over the account’s', () => {
    const options = optionNamed(TARGET_OPTION, {
      type: ApplicationCommandOptionType.User,
      user: account(TARGET, 'Global Name'),
      member: { displayName: 'Nickname Here' },
    })

    expect(invocationOf(source({ options })).targetDisplayName).toBe('Nickname Here')
  })

  it('reads the raw payload’s nick when there is no cached member', () => {
    const options = optionNamed(TARGET_OPTION, {
      type: ApplicationCommandOptionType.User,
      user: account(TARGET, 'Global Name'),
      member: { nick: 'Raw Nickname' },
    })

    expect(invocationOf(source({ options })).targetDisplayName).toBe('Raw Nickname')
  })

  /** A member with no nickname, and somebody tagged who is not in this guild. */
  it('falls back to the account’s display name', () => {
    for (const member of [{ nick: null }, undefined, null]) {
      const options = optionNamed(TARGET_OPTION, {
        type: ApplicationCommandOptionType.User,
        user: account(TARGET, 'Global Name'),
        member,
      })

      expect(invocationOf(source({ options })).targetDisplayName).toBe('Global Name')
    }
  })

  /**
   * THE CHANNEL IS READ OFF THE INTERACTION AND IS NOT AN OPTION. `/sticky` acts
   * on the channel the admin is standing in, and a channel option would be a
   * thing to mistype — a message reposting itself every fifteen seconds in a
   * channel nobody is watching. Carried through exactly as discord.js hands it
   * over, null included, so a command can refuse rather than guess.
   */
  it('carries the channel the command was run in, and null when there is none', () => {
    expect(invocationOf(source()).channelId).toBe(CHANNEL)
    expect(invocationOf(source({ channelId: null })).channelId).toBeNull()
  })

  it('reads the target out of the option both halves agree on', () => {
    const options = optionNamed(TARGET_OPTION, {
      type: ApplicationCommandOptionType.User,
      user: account(TARGET),
    })

    expect(invocationOf(source({ options })).targetId).toBe(TARGET)
  })

  it('is null for a command that supplied no such option', () => {
    expect(invocationOf(source()).targetId).toBeNull()
  })

  /**
   * THE THROW THAT WOULD HAVE ESCAPED THE LISTENER. discord.js's `getUser`
   * raises when an option by that name exists and is not a user, and building
   * the invocation happens while assembling `runCommand`'s arguments — outside
   * the promise the listener catches. So a command added later with a string
   * option named `user` would have killed every invocation of itself before
   * anything could reply, by way of discord.js's own emit. An option that is
   * not a user is simply not a target.
   */
  it('ignores an option of the right name and the wrong type, rather than throwing', () => {
    const options = optionNamed(TARGET_OPTION, { type: ApplicationCommandOptionType.String })

    expect(invocationOf(source({ options })).targetId).toBeNull()
  })

  /** A user option that was declared and not filled in resolves to nobody. */
  it('is null for a user option that was not supplied a user', () => {
    const options = optionNamed(TARGET_OPTION, {
      type: ApplicationCommandOptionType.User,
      user: null,
    })

    const invocation = invocationOf(source({ options }))

    expect(invocation.targetId).toBeNull()

    // And nothing to draw a thumbnail from or weigh a name against, which is
    // what `undefined` means on those two — not "we know there is none".
    expect(invocation.targetAvatarUrl).toBeUndefined()
    expect(invocation.targetDisplayName).toBeUndefined()
  })

  /**
   * THE TEXT OPTION, READ BY THE NAME ./sticky.ts DECLARES IT UNDER. A rename in
   * only one of the two places is not a compile error — it is a `/sticky` that
   * reports an empty message however much text was typed into it.
   */
  it('reads the text out of the option both halves agree on', () => {
    const options = optionNamed(STICKY_TEXT_OPTION, {
      type: ApplicationCommandOptionType.String,
      value: 'the server is down',
    })

    expect(invocationOf(source({ options })).text).toBe('the server is down')
  })

  it('is null for a command that supplied no text option', () => {
    expect(invocationOf(source()).text).toBeNull()
  })

  /** The same trap `targetOf` avoids: a USER option named `text` is not text. */
  it('ignores a text-named option of the wrong type, rather than throwing', () => {
    const options = optionNamed(STICKY_TEXT_OPTION, {
      type: ApplicationCommandOptionType.User,
      user: account(TARGET),
    })

    expect(invocationOf(source({ options })).text).toBeNull()
  })

  /**
   * Discord types an option's value across every kind at once, so a string
   * option carrying a number is a payload that is not what this file expects
   * rather than text. Null is the honest reading of it.
   */
  it('is null for a string option whose value did not arrive as a string', () => {
    const options = optionNamed(STICKY_TEXT_OPTION, {
      type: ApplicationCommandOptionType.String,
      value: 7,
    })

    expect(invocationOf(source({ options })).text).toBeNull()
  })

  /** An empty string is text the admin typed, not an absent option. */
  it('carries an empty string through as itself', () => {
    const options = optionNamed(STICKY_TEXT_OPTION, {
      type: ApplicationCommandOptionType.String,
      value: '',
    })

    expect(invocationOf(source({ options })).text).toBe('')
  })

  /**
   * `/drain`'s NOTE IS ITS OWN FIELD AND NOT `text`. The two are read by
   * different names into different slots on purpose: `text` means the sticky's
   * message everywhere else in this bot, and a note shown to players at a
   * closed door is not that. A single slot fed by two names would make the
   * value depend on which name this seam asked for first.
   */
  it('reads /drain’s note by its own name, into its own field', () => {
    const options = optionNamed(DRAIN_NOTE_OPTION, {
      type: ApplicationCommandOptionType.String,
      value: 'shipping the loot fix',
    })

    const invocation = invocationOf(source({ options }))

    expect(invocation.note).toBe('shipping the loot fix')
    expect(invocation.text).toBeNull()
  })

  it('is null for a command that supplied no note', () => {
    expect(invocationOf(source()).note).toBeNull()
  })

  /** The same trap again: a USER option named `note` is not a note. */
  it('ignores a note-named option of the wrong type, rather than throwing', () => {
    const options = optionNamed(DRAIN_NOTE_OPTION, {
      type: ApplicationCommandOptionType.User,
      user: account(TARGET),
    })

    expect(invocationOf(source({ options })).note).toBeNull()
  })

  /**
   * THE SUBCOMMAND IS READ WITH `getSubcommand(false)` AND THAT ARGUMENT IS THE
   * WHOLE POINT. discord.js's zero-argument overload THROWS when the
   * interaction carries no subcommand, and the throw would happen here — while
   * `runCommand`'s arguments are being assembled, outside the promise the
   * listener catches — so it would escape into discord.js's own emit and every
   * command in the bot would answer "The application did not respond".
   */
  it('reads which subcommand was invoked', () => {
    const options: CommandSource['options'] = {
      get: () => null,
      getSubcommand: () => 'cancel',
    }

    expect(invocationOf(source({ options })).subcommand).toBe('cancel')
  })

  it('asks for the subcommand in the overload that answers null instead of throwing', () => {
    const asked: unknown[] = []
    const options: CommandSource['options'] = {
      get: () => null,
      getSubcommand: (required) => {
        asked.push(required)
        return null
      },
    }

    expect(invocationOf(source({ options })).subcommand).toBeNull()
    expect(asked).toEqual([false])
  })

  /**
   * FOUR OF THE FIVE COMMANDS HAVE NO SUBCOMMANDS, so the fakes above build
   * `options` without the method at all — which is also what a payload for one
   * of those commands amounts to. Null, never a throw.
   */
  it('is null when the interaction carries no subcommand at all', () => {
    expect(invocationOf(source()).subcommand).toBeNull()
  })
})

/**
 * REGISTRATION. A bulk PUT into one guild, run at every boot, so the list on
 * Discord's side cannot drift from the list in this repo.
 */
describe('registerCommands', () => {
  function registrar(): ReturnType<typeof vi.fn<CommandRegistry['set']>> {
    return vi.fn<CommandRegistry['set']>(() => Promise.resolve(null))
  }

  function sent(set: ReturnType<typeof registrar>): readonly ChatInputApplicationCommandData[] {
    const call = set.mock.calls.at(0)
    if (call === undefined) throw new Error('guild.commands.set was never called')
    return call[0]
  }

  it('sends the whole list in one request', async () => {
    const set = registrar()

    await registerCommands({ id: GUILD, name: 'blitz', commands: { set } })

    // ONE call, not one per command: `set` replaces the guild's list, which is
    // what makes it create, update AND delete to match in a single PUT.
    expect(set).toHaveBeenCalledTimes(1)
    expect(sent(set).map((entry) => entry.name)).toEqual(COMMANDS.map((one) => one.data.name))
  })

  /**
   * THE LIST IS THE ONE PLACE A FINISHED COMMAND CAN GO MISSING. Every one of
   * these is built, tested and reachable from Discord only if it is in this
   * array — a command file that nothing imports is a feature that exists in the
   * repo and not in the guild, which is exactly the state /profile, /sticky and
   * /unsticky were in.
   */
  it('registers every command this bot has', () => {
    expect(COMMANDS.map((one) => one.data.name)).toEqual([
      'drain',
      'help',
      'profile',
      'sticky',
      'unsticky',
    ])
  })

  /**
   * AND BUILDING THE LIST REACHES NOTHING. This module is imported by this test
   * file, so an eager `createDdb()` in the array would construct an SDK client
   * here — which is why /profile is registered through `lazyReadsFrom`. The
   * assertion is that the import above happened at all.
   */
  it('is a module that can be imported offline', () => {
    expect(COMMANDS.length).toBeGreaterThan(0)
  })

  /**
   * THE TWO UNCONDITIONALLY ADMIN COMMANDS ARE HIDDEN AS WELL AS GATED, and
   * `commandData` derives the hiding from the gate so the two cannot disagree.
   * /help is open to everybody and must stay that way — it is the one command a
   * member runs.
   *
   * /profile IS NOT IN THIS LIST AND MUST NOT BE. Its gate is a predicate, so
   * it is registered visible: hiding it would leave a member unable to reach
   * the self view the gate exists to permit. See the case below.
   */
  it('hides exactly the unconditionally admin-only commands from the client', () => {
    const hidden = COMMANDS.filter((one) => commandData(one).defaultMemberPermissions === 0n)

    expect(hidden.map((one) => one.data.name)).toEqual(['drain', 'sticky', 'unsticky'])
    expect(hidden.every((one) => one.adminOnly === true)).toBe(true)
  })

  /**
   * AND `/drain` IS IN THAT LIST, WHICH IS THE ONE MEMBERSHIP WORTH ASSERTING
   * BY NAME. It stops the game server letting anybody in and then restarts it,
   * ending every session on the box; a build in which it had drifted out of the
   * hidden set would put the most consequential command in this bot into the
   * picker of every member in the guild. The gate that actually refuses them is
   * `refusalFor`, and this is the default that keeps them from finding it.
   */
  it('hides and gates the command that restarts the game server', () => {
    const drain = COMMANDS.find((one) => one.data.name === 'drain')
    if (drain === undefined) throw new Error('/drain is not in the command list')

    expect(drain.adminOnly).toBe(true)
    expect(commandData(drain).defaultMemberPermissions).toBe(0n)

    // And it answers only the person who ran it, whatever else changes.
    expect(drain.onlyInvoker(invocation())).toBe(true)
  })

  /**
   * A CONDITIONALLY GATED COMMAND IS REGISTERED VISIBLE, AND IS STILL REFUSED.
   * A function is truthy, so a `commandData` written with a truthiness test
   * would hide this command from everybody and the open half of it would be
   * unreachable in the picker however the gate answers. `0n` is a DEFAULT and
   * never a guard — anybody with Manage Server can re-grant it — so un-hiding
   * costs nothing that was ever protection, and the assertion below is the one
   * that says so: visible, and refused all the same.
   */
  it('registers a per-invocation gate visible and still refuses the gated half', () => {
    const conditional = guarded({ adminOnly: (one) => one.targetId !== null })

    expect(commandData(conditional).defaultMemberPermissions).toBeNull()

    const config = cfg({ adminRoleId: ADMIN_ROLE })
    expect(refusalFor(conditional, invocation({ targetId: TARGET }), config)).toBe('not-admin')

    // And /profile, the command all of this exists for, is one of them.
    const profile = COMMANDS.find((one) => one.data.name === 'profile')
    if (profile === undefined) throw new Error('/profile is not in the command list')

    expect(commandData(profile).defaultMemberPermissions).toBeNull()
    expect(typeof profile.adminOnly).toBe('function')
  })

  /**
   * DISCORD REJECTS THE WHOLE ARRAY OVER ONE BAD NAME, so a command added with
   * a capital letter or a space in it does not fail by itself — it takes every
   * other command in the bot down with it, at boot, with nothing but an HTTP
   * 400 in the journal to say why.
   */
  it('gives every command a name Discord will accept, and no duplicates', () => {
    const names = COMMANDS.map((one) => one.data.name)

    for (const name of names) expect(name).toMatch(/^[-_a-z0-9]{1,32}$/u)
    expect(new Set(names).size).toBe(names.length)
  })

  /**
   * `defaultMemberPermissions` IS DERIVED FROM `adminOnly` AND IS NEVER WRITTEN
   * IN A COMMAND FILE. Two fields that have to agree eventually do not, and the
   * failure is silent in the worst direction: an admin-only command whose data
   * forgot the permission is offered to everybody in the guild.
   */
  it('derives what Discord is told from what the gate enforces', () => {
    expect(commandData(guarded({ adminOnly: true })).defaultMemberPermissions).toBe(0n)
    expect(commandData(guarded({ adminOnly: false })).defaultMemberPermissions).toBeNull()
  })

  it('says in the journal which commands went out', async () => {
    const set = registrar()

    await registerCommands({ id: GUILD, name: 'blitz', commands: { set } })

    expect(stdout.join('')).toContain('slash commands registered')
    expect(stdout.join('')).toContain('help')
  })
})

/**
 * A fake client that does nothing but remember the listeners it was handed.
 *
 * `as unknown as Client` FOR THE REASON client.test.ts DOES IT: a real one
 * carries a REST handle, a websocket manager and a hundred members, none of
 * which these cases reach, and building one would mean a test that can only run
 * where discord.js can construct a client.
 */
function fakeClient(): {
  client: Client
  listeners: Map<string, (payload: never) => void>
} {
  const listeners = new Map<string, (payload: never) => void>()

  const client = {
    once: (event: string, listener: (payload: never) => void) => listeners.set(event, listener),
    on: (event: string, listener: (payload: never) => void) => listeners.set(event, listener),
  } as unknown as Client

  return { client, listeners }
}

function listener(
  listeners: Map<string, (payload: never) => void>,
  event: string,
): (payload: never) => void {
  const found = listeners.get(event)
  if (found === undefined) throw new Error(`nothing listened for ${event}`)
  return found
}

/** A `clientReady` payload carrying only what the registration reads. */
function readyPayload(
  guild: RegistrationGuild | null,
  applicationSet: () => Promise<unknown>,
): never {
  const cache = new Map<string, RegistrationGuild>()
  if (guild !== null) cache.set(guild.id, guild)

  return {
    guilds: { cache },
    // Present so a test can prove nothing reaches for it. See below.
    application: { commands: { set: applicationSet } },
    user: { tag: 'blitz#0001', id: '999' },
  } as unknown as never
}

describe('installCommands — registration is guild-scoped, never global', () => {
  /**
   * THE ONE THAT MATTERS. This Discord application is SHARED with the
   * Ringmaster console, so a global command would appear in every guild the app
   * is ever installed into — including guilds this bot is not in and has no
   * business offering commands to — and global registration propagates for up
   * to an hour, which turns every rename into a wait long enough that people
   * restart the bot twice thinking it did not work.
   */
  it('registers into the configured guild and never into the application', async () => {
    const set = vi.fn<CommandRegistry['set']>(() => Promise.resolve(null))
    const applicationSet = vi.fn(() => Promise.resolve(null))
    const { client, listeners } = fakeClient()

    installCommands(client, cfg())
    listener(listeners, Events.ClientReady)(
      readyPayload({ id: GUILD, name: 'blitz', commands: { set } }, applicationSet),
    )

    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledTimes(1)
    })
    expect(applicationSet).not.toHaveBeenCalled()
  })

  /**
   * INTO DISCORD_GUILD_ID AND NOWHERE ELSE. The bot can be a member of other
   * guilds — a test server, one it was added to years ago — and their entries
   * sit in the same cache. Registering into whichever one came back first would
   * put this server's admin commands in somebody else's guild.
   */
  it('registers into the configured guild and not into any other it is in', async () => {
    const set = vi.fn<CommandRegistry['set']>(() => Promise.resolve(null))
    const elsewhere = vi.fn<CommandRegistry['set']>(() => Promise.resolve(null))
    const { client, listeners } = fakeClient()

    const cache = new Map<string, RegistrationGuild>([
      ['999999999999999999', { id: '999', name: 'somewhere else', commands: { set: elsewhere } }],
      [GUILD, { id: GUILD, name: 'blitz', commands: { set } }],
    ])

    installCommands(client, cfg())
    listener(listeners, Events.ClientReady)({
      guilds: { cache },
      user: { tag: 'blitz#0001', id: '999' },
    } as unknown as never)

    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledTimes(1)
    })
    expect(elsewhere).not.toHaveBeenCalled()
  })

  it('says so and registers nothing when the configured guild is missing', () => {
    const applicationSet = vi.fn(() => Promise.resolve(null))
    const { client, listeners } = fakeClient()

    installCommands(client, cfg())
    listener(listeners, Events.ClientReady)(readyPayload(null, applicationSet))

    expect(stderr.join('')).toContain('no slash commands were registered')
    expect(applicationSet).not.toHaveBeenCalled()
  })

  it('logs a registration that Discord refused, rather than dying on it', async () => {
    const set = vi.fn<CommandRegistry['set']>(() => Promise.reject(new Error('403 Forbidden')))
    const { client, listeners } = fakeClient()

    installCommands(client, cfg())
    listener(listeners, Events.ClientReady)(
      readyPayload({ id: GUILD, name: 'blitz', commands: { set } }, () => Promise.resolve(null)),
    )

    await vi.waitFor(() => {
      expect(stderr.join('')).toContain('slash commands could not be registered')
    })
    expect(stderr.join('')).toContain('403 Forbidden')
  })
})

/**
 * A live interaction, as the listener sees one. `isChatInputCommand` is the
 * narrowing the listener does first, so the fake has to answer it.
 */
function fakeInteraction(over: Partial<ReplyTarget> = {}): never {
  return {
    isChatInputCommand: () => true,
    commandName: 'help',
    guildId: GUILD,

    // `displayAvatarURL` is a METHOD on the real `User`, and `invocationOf`
    // calls it — so a fake carrying only an id is a fake the seam throws on, in
    // the one place a throw would escape the listener's own catch. That is
    // exactly what these cases are about, so it is here rather than asserted.
    user: { id: MEMBER, displayName: 'A Member', displayAvatarURL: () => 'https://cdn/a.png' },

    member: { roles: [OTHER_ROLE] },
    options: { get: () => null },
    deferReply: () => Promise.resolve(null),
    editReply: () => Promise.resolve(null),
    reply: () => Promise.resolve(null),
    ...over,
  } as unknown as never
}

/**
 * THE LISTENER IS SYNCHRONOUS AND HANDLES ITS OWN PROMISE, matching the message
 * listener in client.ts. An async function handed to an EventEmitter has
 * nowhere to reject to: it becomes an unhandled rejection several ticks later,
 * attached to no command and no user, and what the admin sees meanwhile is
 * "The application did not respond".
 */
describe('installCommands — the interaction listener never rejects into nothing', () => {
  it('returns nothing at all, rather than a promise the emitter would drop', () => {
    const { client, listeners } = fakeClient()
    installCommands(client, cfg())

    const returned = listener(listeners, Events.InteractionCreate)(fakeInteraction())

    // `undefined`, not a pending promise. This is the whole assertion: an
    // emitter does nothing with a returned promise, so a listener that returns
    // one has already lost every rejection it will ever have.
    expect(returned).toBeUndefined()
  })

  /**
   * REACHING THIS MEANS THE REPLY ITSELF FAILED — an expired interaction token,
   * a Discord that is not answering — because `runCommand` turns a failing
   * handler into a reply on its own. There is nothing left to say over Discord,
   * which is exactly why the journal line has to exist.
   */
  it('logs a reply that could not be delivered', async () => {
    const { client, listeners } = fakeClient()
    installCommands(client, cfg())

    listener(listeners, Events.InteractionCreate)(
      fakeInteraction({ deferReply: () => Promise.reject(new Error('Unknown interaction')) }),
    )

    await vi.waitFor(() => {
      expect(stderr.join('')).toContain('slash command could not be answered')
    })
    expect(stderr.join('')).toContain('Unknown interaction')
  })

  it('answers a slash command through the responder it built', async () => {
    const editReply = vi.fn<ReplyTarget['editReply']>(() => Promise.resolve(null))
    const { client, listeners } = fakeClient()

    installCommands(client, cfg())
    listener(listeners, Events.InteractionCreate)(fakeInteraction({ editReply }))

    await vi.waitFor(() => {
      expect(editReply).toHaveBeenCalledTimes(1)
    })
  })

  /** Buttons, modals, context menus and autocomplete all arrive here too. */
  it('ignores an interaction that is not a chat input command', () => {
    const deferReply = vi.fn<ReplyTarget['deferReply']>(() => Promise.resolve(null))
    const { client, listeners } = fakeClient()

    installCommands(client, cfg())
    listener(listeners, Events.InteractionCreate)({
      isChatInputCommand: () => false,
      deferReply,
    } as unknown as never)

    expect(deferReply).not.toHaveBeenCalled()
  })
})

/**
 * /help, which exists as much to prove the foundation works as to say anything.
 *
 * NOTHING HERE ASSERTS ON THE WORDING. Every string a member can see is a
 * marked placeholder awaiting the owner's own text, and a test that pinned
 * those would make supplying them a two-file change. What is asserted is the
 * shape: the option, the visibility that follows from it, and the one fact the
 * owner did give — the site.
 */
describe('/help', () => {
  it('is a chat input command with an optional user to aim it at', () => {
    expect(help.data.name).toBe('help')
    expect(help.data.type ?? ApplicationCommandType.ChatInput).toBe(ApplicationCommandType.ChatInput)

    const option = help.data.options?.at(0)
    expect(option?.name).toBe(TARGET_OPTION)
    expect(option).toMatchObject({ required: false })
  })

  it('points at the site the owner named', () => {
    expect(help.run(invocation({ commandName: 'help' }), cfg())).toContain('blitz-royale.com')
  })

  /**
   * AIMED AT SOMEBODY ELSE MEANS THEY HAVE TO BE ABLE TO SEE IT. An ephemeral
   * reply reaches the person who ran the command and nobody else, so a
   * `/help @someone` that stayed ephemeral would tag a member with something
   * only the tagger can read — the one shape of this command that cannot work.
   */
  it('is seen only by the invoker until it is aimed at somebody', () => {
    expect(help.onlyInvoker(invocation({ targetId: null }))).toBe(true)
    expect(help.onlyInvoker(invocation({ targetId: TARGET }))).toBe(false)
  })

  it('names the member it was aimed at', () => {
    const said = help.run(invocation({ targetId: TARGET }), cfg())

    expect(said).toContain(`<@${TARGET}>`)
    expect(said).toContain('blitz-royale.com')
  })

  /**
   * OPEN TO EVERYBODY TODAY, AND THAT IS NOT SETTLED. The owner has not said
   * whether /help is admin-only; this pins what the bot does now so that
   * flipping the one word in help.ts is a deliberate change with a failing test
   * next to it rather than something nobody notices.
   */
  it('is open to everybody as it stands, in both halves at once', () => {
    expect(help.adminOnly).toBe(false)
    expect(commandData(help).defaultMemberPermissions).toBeNull()
    expect(refusalFor(help, invocation({ commandName: 'help', roleIds: [] }), cfg())).toBeNull()
  })
})
