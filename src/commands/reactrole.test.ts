import { ApplicationCommandOptionType, type ApplicationCommandOptionData } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleProblem, RoleReadiness } from '../banrole.ts'
import type { Config } from '../config.ts'
import {
  REACT_ROLE_ANY,
  reactRoleChannelKey,
  type DdbResult,
  type ReactRolePairing,
  type ReactRolePairingInput,
} from '../ddb.ts'
import { setSink } from '../log.ts'
import { setReactRoles, type Look, type ReactRoleDesk } from '../reactroles.ts'
import {
  COPY as COMMAND_COPY,
  refusalFor,
  runCommand,
  type Invocation,
  type Responder,
} from './command.ts'
import { commandData } from './index.ts'
import {
  COPY,
  parseEmojiRef,
  parseMessageRef,
  reactrole,
  REACTROLE_CHANNEL_OPTION,
  REACTROLE_EMOJI_OPTION,
  REACTROLE_MESSAGE_OPTION,
  REACTROLE_ROLE_OPTION,
  ROLE_REFUSAL,
  type ReactRoleFields,
} from './reactrole.ts'

/**
 * `/reactrole`, offline.
 *
 * WHAT IS BEING TESTED HERE IS WHAT AN ADMIN IS TOLD AND WHAT ROW IS WRITTEN.
 * The reaction side of the feature — who gets the role, and which of four
 * overlapping pairings wins — is ../reactroles.test.ts's; this file is the
 * command: four shapes read out of two free-text options, every refusal the
 * owner asked for, and the key the pairing lands under.
 *
 * THE KEY IS THE MOST IMPORTANT THING IN THIS FILE. Two of the four shapes have
 * no message and one has no emoji, and all four live in one table keyed on
 * `messageId` + `emoji` — so a shape that wrote the wrong key would be a pairing
 * that saves, replies that it worked, and never fires. Nothing about that failure
 * is visible anywhere except here.
 */

const GUILD = '111111111111111111'
const ADMIN_ROLE = '222222222222222222'
const OTHER_ROLE = '333333333333333333'
const MEMBER = '444444444444444444'

/** The channel the command is run in, and another one an option can name. */
const HERE = '555555555555555555'
const THERE = '666666666666666666'

const MESSAGE = '777777777777777777'
const ROLE = '888888888888888888'
const CUSTOM_ID = '999999999999999999'

const EMOJI = '🎮'
const CUSTOM = `<:blitz:${CUSTOM_ID}>`

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

  // The desk and the sink are both module state, which is the trap every other
  // test file in this repo closes the same way.
  setReactRoles(null)
  setSink(null)
})

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
    commandSecret: null,
    ringmasterUrl: 'http://127.0.0.1:3000',
    gameBanRoleId: '1542596612306505808',
    accessRoleId: '1542596402180530257',
    rulesChannelId: '1542595815833604176',
    devInstanceId: 'i-0f79fdfbbe2506dca',
    devRegion: 'us-east-2',
    ...over,
  }
}

/**
 * An invocation as it arrives today, plus the four fields this command needs.
 *
 * THE `ReactRoleFields` ARE SPREAD IN rather than named in the base, which is the
 * shape the command reads them with: an invocation without them is a case below,
 * not a compile error.
 */
function invocation(over: Partial<Invocation & ReactRoleFields> = {}): Invocation & ReactRoleFields {
  return {
    commandName: 'reactrole',
    guildId: GUILD,
    userId: MEMBER,
    roleIds: [ADMIN_ROLE],
    targetId: null,
    channelId: HERE,
    text: null,
    messageRef: MESSAGE,
    emojiRef: EMOJI,
    roleId: ROLE,
    targetChannelId: null,
    ...over,
  }
}

/** What the desk was asked to do, in order, and what it was handed. */
interface FakeDesk extends ReactRoleDesk {
  readonly looked: string[]
  readonly saved: ReactRolePairingInput[]
  readonly reacted: [string, string, string][]
}

interface Answers {
  channel?: Look
  message?: Look
  emoji?: boolean
  role?: RoleReadiness
  react?: boolean
  save?: DdbResult<ReactRolePairing>
}

/**
 * The desk, faked.
 *
 * EVERY REFUSAL IN THE COMMAND IS AN ENTRY IN THIS RECORD, which is the whole
 * reason the desk is a seam: a message that is not there, an emoji from another
 * guild, a role above the bot's and a DynamoDB that is down are four object
 * literals rather than four gateways.
 */
function desk(answers: Answers = {}): FakeDesk {
  const looked: string[] = []
  const saved: ReactRolePairingInput[] = []
  const reacted: [string, string, string][] = []

  return {
    looked,
    saved,
    reacted,

    channel: (channelId) => {
      looked.push(`channel:${channelId}`)
      return Promise.resolve(answers.channel ?? 'ok')
    },

    message: (channelId, messageId) => {
      looked.push(`message:${channelId}/${messageId}`)
      return Promise.resolve(answers.message ?? 'ok')
    },

    emoji: (emojiId) => {
      looked.push(`emoji:${emojiId}`)
      return Promise.resolve(answers.emoji ?? true)
    },

    role: (roleId) => {
      looked.push(`role:${roleId}`)
      return answers.role ?? { ok: true }
    },

    react: (channelId, messageId, emoji) => {
      reacted.push([channelId, messageId, emoji])
      return Promise.resolve(answers.react ?? true)
    },

    save: (pairing) => {
      saved.push(pairing)

      return Promise.resolve(
        answers.save ?? { ok: true, value: { ...pairing, createdAt: 1_700_000_000_000 } },
      )
    },
  }
}

/** `runCommand`'s three outputs, remembered rather than sent. */
function responder(): Responder & {
  deferred: boolean[]
  edited: string[]
  replied: [string, boolean][]
} {
  const deferred: boolean[] = []
  const edited: string[] = []
  const replied: [string, boolean][] = []

  return {
    deferred,
    edited,
    replied,

    defer: (onlyInvoker) => {
      deferred.push(onlyInvoker)
      return Promise.resolve()
    },

    edit: (reply) => {
      edited.push(typeof reply === 'string' ? reply : JSON.stringify(reply))
      return Promise.resolve()
    },

    reply: (content, onlyInvoker) => {
      replied.push([content, onlyInvoker])
      return Promise.resolve()
    },
  }
}

/** Run the command and hand back the one thing the admin was shown. */
async function answerFor(
  over: Partial<Invocation & ReactRoleFields> = {},
  fake: FakeDesk | null = desk(),
  config = cfg(),
): Promise<string> {
  setReactRoles(fake)

  const respond = responder()

  await runCommand(invocation(over), config, respond, [reactrole])

  const shown = respond.edited[0] ?? respond.replied[0]?.[0]
  if (shown === undefined) throw new Error('the admin was shown nothing at all')
  return shown
}

/** Run it and hand back both the reply and what the desk was asked to do. */
async function runWith(
  over: Partial<Invocation & ReactRoleFields> = {},
  answers: Answers = {},
): Promise<{ shown: string; fake: FakeDesk }> {
  const fake = desk(answers)
  const shown = await answerFor(over, fake)

  return { shown, fake }
}

/* ------------------------------------------------------------------ */

describe('/reactrole — how it is registered, which is half of the guard', () => {
  /**
   * ADMIN-ONLY, UNCONDITIONALLY, AND EPHEMERAL, exactly as `/drain` is. A command
   * that hands out roles hands out whatever those roles can do, so there is no
   * invocation of it that is harmless — which is also what makes `commandData`
   * hide it from every member's picker.
   */
  it('is admin-only and answers only the person who ran it', () => {
    expect(reactrole.adminOnly).toBe(true)
    expect(reactrole.onlyInvoker(invocation())).toBe(true)
    expect(commandData(reactrole).defaultMemberPermissions).toBe(0n)
  })

  it('is refused for a member who does not hold the admin role', () => {
    expect(refusalFor(reactrole, invocation({ roleIds: [OTHER_ROLE] }), cfg())).toBe('not-admin')
  })

  /**
   * AND THE REFUSAL HAPPENS BEFORE THE HANDLER, which is the half that matters:
   * a member who is not an admin never reaches the desk, so nothing is looked up
   * and nothing is written.
   */
  it('writes nothing at all for a member who is not an admin', async () => {
    const fake = desk()

    const shown = await answerFor({ roleIds: [OTHER_ROLE] }, fake)

    expect(shown).toBe(COMMAND_COPY.refused)
    expect(fake.saved).toEqual([])
    expect(fake.looked).toEqual([])
  })

  it('refuses everybody when no admin role is configured', () => {
    expect(refusalFor(reactrole, invocation(), cfg({ adminRoleId: null }))).toBe('admin-role-unset')
  })

  /**
   * THE FOUR OPTIONS, BY NAME AND KIND. The names are what `invocationOf` asks
   * Discord for; a rename in only one place is not a compile error, it is a
   * command that reports no emoji however carefully one was typed.
   */
  it('declares the four options the owner asked for', () => {
    const options = (reactrole.data.options ?? []) as ApplicationCommandOptionData[]

    expect(options.map((option) => [option.name, option.type])).toEqual([
      [REACTROLE_MESSAGE_OPTION, ApplicationCommandOptionType.String],
      [REACTROLE_EMOJI_OPTION, ApplicationCommandOptionType.String],
      [REACTROLE_ROLE_OPTION, ApplicationCommandOptionType.Role],
      [REACTROLE_CHANNEL_OPTION, ApplicationCommandOptionType.Channel],
    ])

    // THE CHANNEL IS THE ONLY OPTIONAL ONE, and it is optional because three of
    // the four shapes do not need it. The fourth is refused by name.
    //
    // READ THROUGH A RECORD RATHER THAN OFF THE UNION, because
    // `ApplicationCommandOptionData` includes the subcommand shapes, which have
    // no `required` at all. This command declares none of those.
    expect(
      options.map((option) => (option as { required?: boolean }).required === true),
    ).toEqual([true, true, true, false])
  })
})

describe('reading the message option', () => {
  /** Every host Discord hands a link out under, and the old domain. */
  const hosts = ['discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com']

  it('reads a message link from every client Discord ships', () => {
    for (const host of hosts) {
      expect(parseMessageRef(`https://${host}/channels/${GUILD}/${THERE}/${MESSAGE}`)).toEqual({
        kind: 'link',
        channelId: THERE,
        messageId: MESSAGE,
      })
    }
  })

  it('reads a link with a trailing slash, and one pasted with spaces around it', () => {
    expect(parseMessageRef(`  https://discord.com/channels/${GUILD}/${THERE}/${MESSAGE}/  `)).toEqual({
      kind: 'link',
      channelId: THERE,
      messageId: MESSAGE,
    })
  })

  it('reads a raw message id', () => {
    expect(parseMessageRef(MESSAGE)).toEqual({ kind: 'id', messageId: MESSAGE })
  })

  it('reads the word any, whatever case it was typed in', () => {
    expect(parseMessageRef('any')).toEqual({ kind: 'any' })
    expect(parseMessageRef(' Any ')).toEqual({ kind: 'any' })
    expect(parseMessageRef('ANY')).toEqual({ kind: 'any' })
  })

  /**
   * AND ANYTHING ELSE IS REFUSED RATHER THAN STORED. A short number or a
   * half-pasted link would key a row that no reaction can ever match, and the
   * only symptom would be a pairing that never fires.
   */
  it('refuses anything that is none of those three', () => {
    for (const bad of [
      '',
      '   ',
      'hello',
      '12345',
      'https://example.com/channels/1/2/3',
      `https://discord.com/channels/${GUILD}/${THERE}`,
      `<#${THERE}>`,
      null,
      undefined,
    ]) {
      expect(parseMessageRef(bad), String(bad)).toEqual({ kind: 'bad' })
    }
  })
})

describe('reading the emoji option', () => {
  it('reads a unicode emoji, including the awkward ones', () => {
    for (const emoji of [EMOJI, '👍🏽', '🇬🇧', '1️⃣', '👨‍👩‍👧', '❤️']) {
      expect(parseEmojiRef(emoji), emoji).toEqual({ kind: 'unicode', key: emoji, react: emoji })
    }
  })

  /**
   * A CUSTOM EMOJI IS KEYED ON ITS ID AND REACTED WITH AS TYPED. The id is what a
   * reaction event carries and what survives a rename; the whole `<:name:id>` is
   * what discord.js's own `resolvePartialEmoji` takes, and it is the only form
   * that keeps `animated` attached.
   */
  it('reads a custom emoji, keyed on its id', () => {
    expect(parseEmojiRef(CUSTOM)).toEqual({ kind: 'custom', key: CUSTOM_ID, react: CUSTOM })

    const animated = `<a:blitz:${CUSTOM_ID}>`
    expect(parseEmojiRef(animated)).toEqual({ kind: 'custom', key: CUSTOM_ID, react: animated })
  })

  it('reads the word any, whatever case it was typed in', () => {
    expect(parseEmojiRef('any')).toEqual({ kind: 'any' })
    expect(parseEmojiRef(' ANY ')).toEqual({ kind: 'any' })
  })

  /**
   * AND REFUSES TEXT. `\p{Emoji}` alone would accept `123` and `#`, because the
   * digits are the bases of the keycap emoji — so something in the string has to
   * actually be a picture.
   */
  it('refuses anything that is not an emoji', () => {
    for (const bad of ['', 'hello', '123', '#', ':blitz:', '<:blitz:12>', null, undefined]) {
      expect(parseEmojiRef(bad), String(bad)).toEqual({ kind: 'bad' })
    }
  })

  /**
   * AND REFUSES TWO EMOJI JAMMED TOGETHER, WHICH THE TWO TESTS ABOVE CANNOT SEE.
   * Both are happy with a RUN of emoji, and the key that would be stored is one
   * no reaction event can ever carry: the gateway sends one emoji per reaction.
   * In the two shapes that take `any` as the message there is no pre-react to
   * fail either, so the row would save, the reply would say it worked, and the
   * pairing would be dead with nothing anywhere saying so.
   */
  it('refuses a run of emoji, while every legitimate one still reads', () => {
    for (const bad of ['👍👎', '🎮🎮', '🇬🇧🇫🇷']) {
      expect(parseEmojiRef(bad), bad).toEqual({ kind: 'bad' })
    }

    for (const good of ['👍🏽', '🇬🇧', '1️⃣', '👨‍👩‍👧']) {
      expect(parseEmojiRef(good), good).toEqual({ kind: 'unicode', key: good, react: good })
    }
  })
})

describe('the four shapes, and the row each one writes', () => {
  /**
   * SHAPE ONE: a message and an emoji. The row is keyed on the message id and
   * the emoji key, and it is the only shape with something to pre-react to.
   */
  it('pairs one emoji on one message, and puts that emoji on the message', async () => {
    const { shown, fake } = await runWith({
      messageRef: `https://discord.com/channels/${GUILD}/${THERE}/${MESSAGE}`,
    })

    expect(fake.saved).toEqual([
      {
        messageId: MESSAGE,
        emoji: EMOJI,
        roleId: ROLE,
        channelId: THERE,
        guildId: GUILD,
        createdBy: MEMBER,
      },
    ])

    expect(fake.reacted).toEqual([[THERE, MESSAGE, EMOJI]])
    expect(shown).toContain(COPY.reacted)
    expect(shown).toContain(`<@&${ROLE}>`)
  })

  /** SHAPE TWO: a message and `any`. Nothing to pre-react with. */
  it('pairs any reaction on one message, and adds no emoji', async () => {
    const { shown, fake } = await runWith({ emojiRef: 'any' })

    expect(fake.saved).toEqual([
      {
        messageId: MESSAGE,
        emoji: REACT_ROLE_ANY,
        roleId: ROLE,
        channelId: HERE,
        guildId: GUILD,
        createdBy: MEMBER,
      },
    ])

    expect(fake.reacted).toEqual([])
    expect(shown).not.toContain(COPY.reacted)
    expect(shown).not.toContain(COPY.notReacted)
  })

  /**
   * SHAPE THREE: any message in a channel, one emoji. The key is the channel key
   * and it cannot collide with a message id — a snowflake is digits.
   */
  it('pairs one emoji anywhere in a channel, under a key no message can have', async () => {
    const { shown, fake } = await runWith({ messageRef: 'any', targetChannelId: THERE })

    expect(fake.saved).toEqual([
      {
        messageId: reactRoleChannelKey(THERE),
        emoji: EMOJI,
        roleId: ROLE,
        channelId: THERE,
        guildId: GUILD,
        createdBy: MEMBER,
      },
    ])

    expect(fake.saved[0]?.messageId).not.toMatch(/^\d+$/u)
    expect(fake.reacted).toEqual([])
    expect(shown).toContain(`<#${THERE}>`)
  })

  /** SHAPE FOUR: any message in a channel, any emoji. Both halves are magic. */
  it('pairs any reaction anywhere in a channel', async () => {
    const { fake } = await runWith({
      messageRef: 'any',
      emojiRef: 'any',
      targetChannelId: THERE,
    })

    expect(fake.saved).toEqual([
      {
        messageId: reactRoleChannelKey(THERE),
        emoji: REACT_ROLE_ANY,
        roleId: ROLE,
        channelId: THERE,
        guildId: GUILD,
        createdBy: MEMBER,
      },
    ])

    expect(fake.reacted).toEqual([])
  })

  /**
   * THE CHANNEL-WIDE SHAPES CHECK THE CHANNEL AND NOT A MESSAGE, which is the
   * only thing there is to check: there is no message to fetch.
   */
  it('checks the channel rather than a message when the message is any', async () => {
    const { fake } = await runWith({ messageRef: 'any', targetChannelId: THERE })

    expect(fake.looked).toContain(`channel:${THERE}`)
    expect(fake.looked.some((one) => one.startsWith('message:'))).toBe(false)
  })

  /** A custom emoji is checked against this guild before anything is written. */
  it('checks a custom emoji is one this bot can use', async () => {
    const { fake } = await runWith({ emojiRef: CUSTOM })

    expect(fake.looked).toContain(`emoji:${CUSTOM_ID}`)
    expect(fake.saved[0]?.emoji).toBe(CUSTOM_ID)
    expect(fake.reacted).toEqual([[HERE, MESSAGE, CUSTOM]])
  })

  /** A unicode emoji belongs to nobody, so there is nothing to ask Discord. */
  it('asks Discord nothing about a unicode emoji', async () => {
    const { fake } = await runWith()

    expect(fake.looked.some((one) => one.startsWith('emoji:'))).toBe(false)
  })
})

describe('which channel a message id is looked up in', () => {
  /**
   * A BARE ID NEEDS A CHANNEL: Discord's API fetches a message from a channel and
   * not from a guild. The option wins, then the channel the command was run in —
   * and the reply says which, because a command that quietly picked one for you
   * is a command you cannot check.
   */
  it('uses the channel option when one was given, and says so', async () => {
    const { shown, fake } = await runWith({ targetChannelId: THERE })

    expect(fake.looked).toContain(`message:${THERE}/${MESSAGE}`)
    expect(shown).toContain(COPY.lookedIn(`<#${THERE}>`))
  })

  it('falls back to the channel the command was run in, and says so', async () => {
    const { shown, fake } = await runWith()

    expect(fake.looked).toContain(`message:${HERE}/${MESSAGE}`)
    expect(shown).toContain(COPY.lookedIn(`<#${HERE}>`))
  })

  /**
   * A LINK SAYS WHICH CHANNEL ITSELF, so nothing was chosen and the reply does
   * not name one. That is the one case where the sentence would be noise.
   */
  it('takes the channel out of a link and says nothing about it', async () => {
    const { shown, fake } = await runWith({
      messageRef: `https://discord.com/channels/${GUILD}/${THERE}/${MESSAGE}`,
    })

    expect(fake.looked).toContain(`message:${THERE}/${MESSAGE}`)
    expect(shown).not.toContain(COPY.lookedIn(`<#${THERE}>`))
  })

  /**
   * AND A LINK BESIDE A CHANNEL OPTION IS REDUNDANT, SO THE LINK WINS — but the
   * reply names the channel it used, so an admin who supplied a different one can
   * see that it was not.
   */
  it('prefers the link’s channel over the option, and names the one it used', async () => {
    const { shown, fake } = await runWith({
      messageRef: `https://discord.com/channels/${GUILD}/${THERE}/${MESSAGE}`,
      targetChannelId: HERE,
    })

    expect(fake.looked).toContain(`message:${THERE}/${MESSAGE}`)
    expect(shown).toContain(COPY.lookedIn(`<#${THERE}>`))
  })

  it('refuses a bare id with no channel anywhere to look in', async () => {
    const { shown, fake } = await runWith({ channelId: null })

    expect(shown).toBe(COPY.noChannelToLookIn)
    expect(fake.saved).toEqual([])
  })
})

describe('the refusals', () => {
  /** `any` AS THE MESSAGE IS ONLY VALID WITH A CHANNEL. The owner's rule. */
  it('refuses any as the message when no channel was given', async () => {
    const { shown, fake } = await runWith({ messageRef: 'any' })

    expect(shown).toBe(COPY.anyNeedsChannel)
    expect(fake.saved).toEqual([])
    expect(fake.looked).toEqual([])
  })

  it('refuses a message option that is none of the three things it may be', async () => {
    const { shown, fake } = await runWith({ messageRef: 'the one about the update' })

    expect(shown).toBe(COPY.badMessage)
    expect(fake.saved).toEqual([])
  })

  it('refuses an emoji option that is not an emoji', async () => {
    const { shown, fake } = await runWith({ emojiRef: ':shrug:' })

    expect(shown).toBe(COPY.badEmoji)
    expect(fake.saved).toEqual([])
  })

  /** A custom emoji from another guild is one this bot cannot put on anything. */
  it('refuses a custom emoji this bot cannot use', async () => {
    const { shown, fake } = await runWith({ emojiRef: CUSTOM }, { emoji: false })

    expect(shown).toBe(COPY.foreignEmoji)
    expect(fake.saved).toEqual([])
    expect(fake.reacted).toEqual([])
  })

  it('refuses a message that cannot be found or read', async () => {
    const { shown, fake } = await runWith({}, { message: 'no-message' })

    expect(shown).toBe(COPY.noMessage)
    expect(fake.saved).toEqual([])
  })

  it('refuses a channel that cannot be found or read, looking a message up', async () => {
    const { shown, fake } = await runWith({}, { message: 'no-channel' })

    expect(shown).toBe(COPY.noChannel)
    expect(fake.saved).toEqual([])
  })

  it('refuses a channel that cannot be found or read, for a channel-wide pairing', async () => {
    const { shown, fake } = await runWith(
      { messageRef: 'any', targetChannelId: THERE },
      { channel: 'no-channel' },
    )

    expect(shown).toBe(COPY.noChannel)
    expect(fake.saved).toEqual([])
  })

  it('refuses an invocation that carried no role at all', async () => {
    const { shown, fake } = await runWith({ roleId: null })

    expect(shown).toBe(COPY.noRole)
    expect(fake.saved).toEqual([])
  })

  /**
   * @everyone, WHICH THE READINESS CHECK CANNOT REFUSE FOR US. The default role
   * carries the guild's own id, is not managed and sits at position 0, so all six
   * of `roleReadiness`’s branches pass. Without this the pairing saves, the admin
   * is told everybody who reacts is given @everyone, the bot pre-reacts so there
   * is a button, and then Discord refuses every single click.
   */
  it('refuses the default everyone role, before it asks the desk anything', async () => {
    const { shown, fake } = await runWith({ roleId: GUILD })

    expect(shown).toBe(COPY.everyoneRole)
    expect(fake.saved).toEqual([])
    expect(fake.reacted).toEqual([])

    // Not even the standing check, which would have said the role was fine.
    expect(fake.looked).toEqual([])
  })

  /**
   * EVERY REASON A ROLE CANNOT BE HANDED OUT, ONE SENTENCE EACH. The two the
   * owner named — a managed role, and one at or above the bot's own — are in
   * here with the four the same check produces, because `roleReadiness` in
   * ../banrole.ts answers all six and a command that handled two of them would
   * print `undefined` for the rest.
   */
  const problems: RoleProblem[] = [
    'no-guild',
    'no-role',
    'no-self',
    'no-permission',
    'managed-role',
    'role-too-high',
  ]

  for (const why of problems) {
    it(`refuses a role this bot cannot hand out: ${why}`, async () => {
      const { shown, fake } = await runWith({}, { role: { ok: false, why } })

      expect(shown).toBe(ROLE_REFUSAL[why])
      expect(fake.saved).toEqual([])

      // AND IT IS ASKED FIRST, BEFORE ANY REQUEST. The standing check reads
      // caches and costs nothing; the message and emoji checks are REST calls.
      expect(fake.looked).toEqual([`role:${ROLE}`])
    })
  }

  /**
   * A DYNAMODB FAILURE IS THE COMMAND FAILING, ANSWERED WITH THE SENTENCE THAT
   * ALREADY EXISTS FOR THAT. Not a throw — a throw reaches `runCommand` and
   * produces the same sentence anyway, so returning it is the honest version of
   * what happens — and not a made-up one naming a table an admin cannot act on.
   */
  it('answers a refused write with the existing failure reply, and journals it', async () => {
    const { shown, fake } = await runWith(
      {},
      {
        save: {
          ok: false,
          failure: {
            kind: 'denied',
            op: 'put',
            table: 'ringmaster-reactroles',
            message: 'from the fake',
          },
        },
      },
    )

    expect(shown).toBe(COMMAND_COPY.failed)

    // Nothing was pre-reacted, because there is no pairing behind it: an emoji
    // on the message with nothing saved is a button that does nothing.
    expect(fake.reacted).toEqual([])

    expect(stderr.join('')).toContain('level=error')
    expect(stderr.join('')).toContain('could not be saved')

    // Quoted, because `render` in ../log.ts quotes every string value: the
    // journal's own escaping is what makes one line one record.
    expect(stderr.join('')).toContain('table="ringmaster-reactroles"')
  })

  /**
   * AND A BOT BUILT WITHOUT THE LISTENERS REFUSES RATHER THAN CRASHING. No desk
   * means `installReactionRoles` never ran, so there is nowhere to save a pairing
   * and nothing to check it against.
   */
  it('answers with the failure reply when no desk was ever installed', async () => {
    setReactRoles(null)

    const respond = responder()
    await runCommand(invocation(), cfg(), respond, [reactrole])

    expect(respond.edited[0]).toBe(COMMAND_COPY.failed)
    expect(stderr.join('')).toContain('no reaction-role desk')
  })
})

describe('what the admin is told', () => {
  /**
   * THE PAIRING IS WRITTEN BEFORE THE EMOJI GOES ON, and a refused react does not
   * undo it. An emoji on a message with no pairing behind it is a button that
   * does nothing; a pairing with no emoji on the message is one somebody has to
   * react to first, which is what the sentence says.
   */
  it('keeps the pairing when Discord would not let it add the emoji', async () => {
    const { shown, fake } = await runWith({}, { react: false })

    expect(fake.saved).toHaveLength(1)
    expect(shown).toContain(COPY.notReacted)
    expect(shown).not.toContain(COPY.reacted)
  })

  it('says the reaction coming off takes the role away, in every shape', async () => {
    for (const over of [
      {},
      { emojiRef: 'any' },
      { messageRef: 'any', targetChannelId: THERE },
      { messageRef: 'any', emojiRef: 'any', targetChannelId: THERE },
    ]) {
      const { shown } = await runWith(over)
      expect(shown, JSON.stringify(over)).toContain('takes the role away')
    }
  })

  /**
   * EVERY STRING THIS COMMAND CAN PUT IN FRONT OF AN ADMIN, in one list, for
   * ../drain.test.ts's reason: "no line break", "no stand-in", "a whole
   * sentence" are claims about the command and not about its best case, and the
   * faults that reached the owner reached him through the one branch anybody had
   * looked at.
   */
  function everyFrame(): string[] {
    const role = `<@&${ROLE}>`
    const channel = `<#${THERE}>`

    return [
      COPY.pairedMessage(role, EMOJI),
      COPY.pairedMessageAny(role),
      COPY.pairedChannel(role, EMOJI, channel),
      COPY.pairedChannelAny(role, channel),
      COPY.reacted,
      COPY.notReacted,
      COPY.lookedIn(channel),
      COPY.badMessage,
      COPY.badEmoji,
      COPY.foreignEmoji,
      COPY.anyNeedsChannel,
      COPY.noChannelToLookIn,
      COPY.noChannel,
      COPY.noMessage,
      COPY.noRole,
      COPY.everyoneRole,
      ...Object.values(ROLE_REFUSAL),
    ]
  }

  it('never ships a marker or a stand-in sentence', () => {
    const frames = everyFrame()

    // Not a vacuous pass: there are frames and they are non-empty sentences.
    expect(frames.length).toBeGreaterThan(15)

    for (const frame of frames) {
      expect(frame.length).toBeGreaterThan(0)
      expect(frame, frame).not.toContain('PLACEHOLDER')
      expect(frame, frame).not.toContain('@unwritten')
      expect(frame.toLowerCase(), frame).not.toContain('no wording supplied')
    }

    // And the picker descriptions, which are registered rather than replied.
    for (const description of [
      COPY.description,
      COPY.messageOption,
      COPY.emojiOption,
      COPY.roleOption,
      COPY.channelOption,
    ]) {
      expect(description, description).not.toContain('PLACEHOLDER')
      expect(description.length).toBeGreaterThan(0)
      expect(description.length).toBeLessThanOrEqual(100)
    }
  })

  /**
   * ONE PARAGRAPH OF WHOLE SENTENCES. He has said three times that multi-line
   * replies "look so weird", so the separator is a space and every frame has to
   * survive being read next to another one.
   */
  it('is one paragraph of whole sentences, with no line break anywhere', () => {
    for (const frame of everyFrame()) {
      expect(frame, frame).not.toContain('\n')
      expect(frame, frame).toMatch(/^[A-Z]/u)
      expect(frame, frame).toMatch(/\.$/u)

      for (const [, next] of frame.matchAll(/\.(.)/gu)) {
        if (next !== undefined) expect(next, frame).toBe(' ')
      }

      for (const [, next] of frame.matchAll(/\. (.)/gu)) {
        if (next !== undefined) expect(next, frame).toMatch(/[A-Z]/u)
      }
    }
  })

  /** And the composed replies, which is what an admin actually reads. */
  it('composes the sentences into one paragraph', async () => {
    const { shown } = await runWith({ targetChannelId: THERE })

    expect(shown).not.toContain('\n')
    expect(shown).toContain(COPY.lookedIn(`<#${THERE}>`))
    expect(shown).toContain(COPY.reacted)
    expect(shown.startsWith(COPY.pairedMessage(`<@&${ROLE}>`, EMOJI))).toBe(true)
  })

  it('says in the journal which pairing was saved', async () => {
    await runWith()

    expect(stdout.join('')).toContain('level=info')
    expect(stdout.join('')).toContain('a reaction role pairing was saved')
    expect(stdout.join('')).toContain(`role="${ROLE}"`)
  })
})
