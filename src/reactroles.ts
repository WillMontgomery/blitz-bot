import {
  DiscordAPIError,
  Events,
  PermissionsBitField,
  RESTJSONErrorCodes,
  type Client,
} from 'discord.js'

import { roleReadiness, type RoleReadiness } from './banrole.ts'
import type { Config } from './config.ts'
import {
  reactRoleChannelKey,
  REACT_ROLE_ANY,
  type Ddb,
  type DdbFailure,
  type DdbFailureKind,
  type DdbResult,
  type ReactRolePairing,
  type ReactRolePairingInput,
} from './ddb.ts'
import { latch, type Latch } from './latch.ts'
import { log } from './log.ts'

/**
 * Reaction roles: react to a message, be given a role; take the reaction off,
 * lose it again.
 *
 * ═══ THE PAIRING IS A ROW AND NOTHING IS HELD IN MEMORY ═══
 *
 * A bot that remembered its pairings would have to LOAD them at boot, and the
 * only way to load every pairing there is out of a table keyed on the message is
 * a Scan — which `DocumentClient` in ./ddb.ts does not have and must not gain.
 * So nothing is cached: a reaction arrives, the bot asks DynamoDB about that
 * exact message and that exact emoji, and a pairing made a month ago works the
 * same as one made a second ago. `pairingFor` is the whole of the lookup and it
 * is four point reads at most.
 *
 * WHICH IS ALSO WHY A RESTART COSTS NOTHING. There is no state here to rehydrate
 * and no first pass to wait for; the listeners are armed at `clientReady` and the
 * next reaction reads the same rows the last one did.
 *
 * ═══ THE WORK IS SPLIT THE WAY client.ts IS SPLIT ═══
 *
 * Everything above `installReactionRoles` is a function of plain records — a
 * reaction reduced to six fields, a pairing read off an injected `Pick<Ddb, …>`,
 * a role handed to an injected seam — so every branch, including the ones that
 * hand somebody a role, is exercised offline against object literals. The half
 * that touches discord.js is `reactionOf`, `liveDesk`, `guildReactRoles` and the
 * two listeners at the foot of this file.
 *
 * ═══ AND THE COMMAND REACHES THIS FILE THROUGH MODULE STATE ═══
 *
 * `/reactrole` has to fetch a message, check an emoji and read the guild's role
 * list, and a command handler is handed an `Invocation` and a `Config` and
 * nothing else. That is the same wall ../sticky.ts met, and `reactRoles()` below
 * is the same answer: `installReactionRoles` puts a desk in place, the command
 * asks for it, and a bot whose client never installed one refuses rather than
 * crashing.
 */

/* ------------------------------------------------------------------ *
 * The emoji, as a key.
 * ------------------------------------------------------------------ */

/** An emoji as a reaction event carries one: a custom id, or a character. */
export interface ReactionEmoji {
  readonly id: string | null
  readonly name: string | null
}

/**
 * What one emoji is stored and looked up as.
 *
 * THE ID FOR A CUSTOM EMOJI AND THE CHARACTER FOR A UNICODE ONE, which is
 * Discord's own identity for a reaction and not a scheme invented here: the
 * gateway sends `{ id: null, name: '🎮' }` for unicode and
 * `{ id: '123…', name: 'blitz' }` for a custom one, and the id is the half that
 * survives the emoji being RENAMED. A key built from the name would stop matching
 * the day somebody edits the emoji in server settings, and nothing would say so —
 * the pairing would simply stop granting anything.
 *
 * NULL WHEN NEITHER IS THERE, which is a payload this file does not recognize
 * rather than an emoji. The caller ignores the reaction instead of keying a row
 * on an empty string.
 */
export function emojiKeyOf(emoji: ReactionEmoji): string | null {
  if (typeof emoji.id === 'string' && emoji.id !== '') return emoji.id
  if (typeof emoji.name === 'string' && emoji.name !== '') return emoji.name

  return null
}

/* ------------------------------------------------------------------ *
 * One reaction, reduced to what a decision needs.
 * ------------------------------------------------------------------ */

/**
 * A reaction as this file reasons about one.
 *
 * A PLAIN RECORD RATHER THAN discord.js's `MessageReaction`, for the reason
 * `ScannedMessage` in ./client.ts is a plain record: the real thing is a live
 * object hanging off a client, with a message that may be a partial and a REST
 * handle behind it. Six fields is what a decision actually needs, and six fields
 * is what a test can write above its assertion.
 */
export interface Reaction {
  readonly messageId: string
  readonly channelId: string

  /** Null outside a guild. A DM reaction is not this bot's business. */
  readonly guildId: string | null

  /** The key, from `emojiKeyOf`. Null when the payload carried no emoji. */
  readonly emoji: string | null

  readonly userId: string

  /**
   * Whether the reaction is a bot's.
   *
   * THE PRE-REACT IS WHY THIS IS THE FIRST THING CHECKED. `/reactrole` on a
   * message and an emoji puts that emoji on the message itself so members have
   * something to click — which is a reaction, from this bot, arriving on a
   * message this bot has a pairing for. Without this it would hand the BOT the
   * role, and the removal path would take it off again.
   */
  readonly fromBot: boolean
}

/** Which way the reaction went. */
export type ReactionMove = 'added' | 'removed'

/* ------------------------------------------------------------------ *
 * Which pairing a reaction matches.
 * ------------------------------------------------------------------ */

/**
 * Which of the four rows answered, in the order they are asked.
 *
 * THE ORDER IS THE PRECEDENCE AND IT IS THE OWNER'S, said twice: a pairing made
 * for one MESSAGE beats a channel-wide one for the same reaction, and an EXACT
 * emoji beats `any`. So message-specificity is the outer question and exactness
 * the inner one, which is the only reading under which both of his sentences are
 * true at once — a channel-wide exact-emoji row does not outrank an `any` row
 * made for the message itself, because the message row is the more specific
 * statement about where the reaction happened.
 *
 * IT IS CARRIED OUT OF THE LOOKUP RATHER THAN INFERRED, so the journal line says
 * which rule fired and a test can pin the precedence without reading roles off
 * two rows that happen to differ.
 */
export type PairingSource = 'message-exact' | 'message-any' | 'channel-exact' | 'channel-any'

/** A pairing and which rule found it. */
export interface FoundPairing {
  readonly pairing: ReactRolePairing
  readonly how: PairingSource
}

/**
 * The pairing that governs one reaction, or null when none does.
 *
 * FOUR KEYS, ASKED IN PRECEDENCE ORDER, STOPPING AT THE FIRST ANSWER. Each one
 * is a `GetItem` on the whole primary key — see `Ddb.reactRoles.get` for why it
 * is not one `Query` — so the cost of a reaction is:
 *
 *   ONE read when the message has a pairing for that exact emoji, which is the
 *   shape the owner expects most and the one `/reactrole` pre-reacts for;
 *   TWO when the message's pairing is `any`;
 *   THREE or FOUR only when the message has no pairing at all and the
 *   channel-wide rows have to be asked — which is every reaction in a guild
 *   where nobody has set one of these up, and is four point reads of 0.5 read
 *   units each on a table with nothing in it.
 *
 * A FAILED READ IS NOT "NO PAIRING". The two are opposite instructions — one
 * means do nothing, the other means we do not know — and a function that
 * collapsed them would take somebody's role off because DynamoDB timed out. The
 * failure comes back whole so the caller can log it and leave the member alone.
 */
export async function pairingFor(
  reads: Pick<Ddb['reactRoles'], 'get'>,
  messageId: string,
  channelId: string,
  emoji: string,
): Promise<DdbResult<FoundPairing | null>> {
  const channelKey = reactRoleChannelKey(channelId)

  const asked: readonly (readonly [string, string, PairingSource])[] = [
    [messageId, emoji, 'message-exact'],
    [messageId, REACT_ROLE_ANY, 'message-any'],
    [channelKey, emoji, 'channel-exact'],
    [channelKey, REACT_ROLE_ANY, 'channel-any'],
  ]

  for (const [key, sort, how] of asked) {
    const row = await reads.get(key, sort)

    if (!row.ok) return row
    if (row.value !== null) return { ok: true, value: { pairing: row.value, how } }
  }

  return { ok: true, value: null }
}

/* ------------------------------------------------------------------ *
 * Giving the role, and taking it back.
 * ------------------------------------------------------------------ */

/**
 * The reason the bot stamps on its own role edits, in the guild's audit log.
 *
 * MACHINE-SHAPED ON PURPOSE, AND THAT IS WHY NEITHER IS A PLACEHOLDER — the same
 * argument `ROLE_AUDIT_REASON` in ./banrole.ts makes. An admin scrolling the
 * audit log needs to know which process did this and why, in the vocabulary of
 * the journal line beside it. They are not prose addressed to anybody, and they
 * are one string each if the owner ever wants to word them.
 */
export const REACT_ROLE_REASON_GIVEN = 'blitz-bot: reacted to a message paired with this role'
export const REACT_ROLE_REASON_TAKEN = 'blitz-bot: took back the reaction that granted this role'

/**
 * Putting a role on somebody and taking it off. The seam, so everything above
 * runs offline.
 *
 * A SEAM OF ITS OWN RATHER THAN A REUSE OF `GameBanRoles` IN ./banrole.ts, and
 * the reason is the same one that file gives for not reusing `roleTaker`: that
 * one is bound to ONE role id, fixed at construction from
 * `BLITZ_GAME_BAN_ROLE_ID`, and to audit reasons that say a game ban was issued
 * or lifted. Both are wrong here — the role is whichever one the pairing names,
 * and no ban is involved — so sharing it would mean either a false sentence in
 * the guild's audit log or a role parameter bolted onto somebody else's
 * interface.
 */
export interface ReactRoleGrants {
  add(userId: string, roleId: string): Promise<void>
  remove(userId: string, roleId: string): Promise<void>
}

/**
 * The real one.
 *
 * `members.addRole` / `members.removeRole` RATHER THAN `member.roles.add`, for
 * ./banrole.ts's reason: the second needs a `GuildMember` object, which means
 * fetching the member first, and these take a user id and issue the one PATCH.
 * The member usually IS cached here — they just reacted — but a fetch per
 * reaction is a request per reaction, and this path is on the hot side of a
 * feature whose whole cost is per reaction.
 */
export function guildReactRoles(client: Client, guildId: string): ReactRoleGrants {
  return {
    async add(userId, roleId) {
      const guild = await client.guilds.fetch(guildId)
      await guild.members.addRole({ user: userId, role: roleId, reason: REACT_ROLE_REASON_GIVEN })
    },

    async remove(userId, roleId) {
      const guild = await client.guilds.fetch(guildId)
      await guild.members.removeRole({ user: userId, role: roleId, reason: REACT_ROLE_REASON_TAKEN })
    },
  }
}

/* ------------------------------------------------------------------ *
 * The handler.
 * ------------------------------------------------------------------ */

/**
 * Everything the handler needs from the world, named rather than imported.
 *
 * `Pick<Ddb, 'reactRoles'>` IS THE ACCESS POLICY WRITTEN WHERE A COMPILER READS
 * IT, the way `MirrorDeps` and `BanRoleDeps` state theirs. This half of the
 * feature can read and write the pairing table and reach nothing else in
 * DynamoDB: not a ban, not the audit log, not the maintenance row, however it is
 * edited later.
 */
export interface ReactRoleDeps {
  readonly ddb: Pick<Ddb, 'reactRoles'>
  readonly roles: ReactRoleGrants

  /** The guild this bot is for. A reaction from anywhere else is ignored. */
  readonly guildId: string

  /**
   * The slot a permanent read failure is held in, so #bot-status hears it once.
   *
   * ON THE DEPS RATHER THAN IN THIS MODULE, because everything else the handler
   * needs arrives this way, and because a test cannot watch one latch across
   * several reactions otherwise, which is the whole property worth asserting.
   *
   * ONE SLOT FOR THE READ AND NOT ONE PER FAILURE KIND, which is the argument
   * `createIncidentOpenLog` makes for its own: the conditions below are states of
   * one thing, and a slot each would let them alternate and post twice. See
   * `READ_FAULT` and ./latch.ts.
   */
  readonly reads: Latch
}

/**
 * What one reaction did, for the tests and for nothing else.
 *
 * THE JOURNAL IS THE REAL OUTPUT AND THIS IS THE ASSERTABLE ONE, exactly as
 * `MirrorResult` is in ./banrole.ts: every branch below writes its own line
 * because that is what an operator reads, and returning a value as well means a
 * test can pin WHICH branch ran without matching on log text that a rewording
 * would break.
 */
export type ReactRoleResult =
  | { did: 'ignored'; why: 'bot' | 'no-guild' | 'other-guild' | 'no-emoji' }
  | { did: 'nothing' }
  | { did: 'failed'; why: 'read' | 'role' }
  | { did: 'granted' | 'taken'; roleId: string; how: PairingSource }

/** A permanent read failure, and the line that says it has stopped. */
interface ReadFault {
  readonly msg: string
  readonly cleared: string
}

/**
 * The read failures that stay true until a person acts, and what each one says.
 *
 * A TABLE THAT IS NOT THERE WOULD OTHERWISE BE ONE STATUS-CHANNEL ERROR PER
 * REACTION IN THE GUILD, FOREVER. The owner creates `ringmaster-reactroles` by
 * hand and docs/aws-notes.md documents the state before he does: every reaction is
 * a failed read, every failed read here is an error, and ./log.ts copies every
 * error to #bot-status. That is the wall ./latch.ts was written to stop, arriving
 * at the speed of the guild's reaction traffic rather than at a poller's.
 *
 * THREE CONDITIONS AND THREE SENTENCES, BECAUSE THEY ARE THREE DIFFERENT FIXES: a
 * create-table command, an IAM policy, and credentials on the box. One shared
 * sentence would hold one slot for all three, so a change from one to another
 * would be silent, and the point of an all-clear is to say which of the things he
 * did was the one that worked. `INDEX_DENIED` in ./incidents.ts argues the same.
 *
 * AND EVERY OTHER KIND IS DELIBERATELY LEFT PER-REACTION. A timeout and an
 * unrecognized error are the transient bucket, where repetition IS the
 * information. `no-such-index` and `index-backfilling` cannot arrive at all:
 * `classify` in ./ddb.ts only reaches them for a call that named an index, and
 * `reactRoles.get` is a `GetItem`.
 */
const READ_FAULT: Partial<Record<DdbFailureKind, ReadFault>> = {
  'no-such-table': {
    msg:
      'the reaction role table does not exist, so no reaction grants or takes back a role. docs/aws-notes.md has the command that creates it',
    cleared:
      'the reaction role table answers now, so a reaction grants and takes back the role it is paired with',
  },

  denied: {
    msg:
      'the bot is not allowed to read the reaction role table, so no reaction grants or takes back a role. dynamodb:GetItem has to be granted on that table',
    cleared:
      'the bot is allowed to read the reaction role table now, so a reaction grants and takes back the role it is paired with',
  },

  credentials: {
    msg:
      'the bot has no AWS credentials to read the reaction role table with, so no reaction grants or takes back a role',
    cleared:
      "the reaction role table can be read with the bot's AWS credentials again, so a reaction grants and takes back the role it is paired with",
  },
}

/**
 * How loudly a failed pairing read is journaled, for `devLevel`'s reason in
 * ./commands/drain.ts. A timeout or an unrecognized error may pass on the next
 * reaction; anything else is an operator's to fix.
 *
 * THE THREE PERMANENT ONES NEVER REACH THIS. `READ_FAULT` takes them first and
 * they are said once through the latch rather than once per reaction, so what is
 * left here is the transient bucket and the kinds a `GetItem` cannot produce.
 */
function levelFor(failure: DdbFailure): 'warn' | 'error' {
  return failure.kind === 'timeout' || failure.kind === 'error' ? 'warn' : 'error'
}

/**
 * One reaction, decided and acted on.
 *
 * THE GUARDS ARE IN THIS ORDER BECAUSE EACH ONE MAKES THE NEXT MEANINGFUL, which
 * is the same shape as `mirrorEntry`'s. The bot check is first because it is
 * free and because it is what stops this bot's own pre-react handing the bot a
 * role; the guild check is next because a pairing is a decision about THIS
 * community; and DynamoDB is not asked anything at all until both have passed.
 *
 * A REACTION THAT MATCHES NOTHING IS SILENT. It is the overwhelming majority of
 * every reaction in the guild, and a journal line each would bury the lines that
 * mean something under the guild's entire reaction traffic.
 */
export async function handleReaction(
  reaction: Reaction,
  move: ReactionMove,
  deps: ReactRoleDeps,
): Promise<ReactRoleResult> {
  if (reaction.fromBot) return { did: 'ignored', why: 'bot' }
  if (reaction.guildId === null) return { did: 'ignored', why: 'no-guild' }
  if (reaction.guildId !== deps.guildId) return { did: 'ignored', why: 'other-guild' }
  if (reaction.emoji === null) return { did: 'ignored', why: 'no-emoji' }

  const found = await pairingFor(
    deps.ddb.reactRoles,
    reaction.messageId,
    reaction.channelId,
    reaction.emoji,
  )

  if (!found.ok) {
    // NOT SILENT AND NOT ACTED ON. The member is left exactly as they were,
    // which is the only safe end: granting on a failed read would invent a
    // pairing and taking on one would remove a role nobody gave up.
    const permanent = READ_FAULT[found.failure.kind]

    if (permanent === undefined) {
      log(levelFor(found.failure), 'a reaction could not be matched against its pairings', {
        message: reaction.messageId,
        channel: reaction.channelId,
        failure: found.failure.kind,
        detail: found.failure.message,
      })
    } else {
      /**
       * THE FIELDS ARE THE ONES THAT DO NOT VARY, which is the half of ./latch.ts's
       * test that is easy to miss. `message` and `channel` are different on every
       * reaction, and a line whose repeat carries a new value is a new occurrence
       * rather than a repeat of one condition. What is left is the table and what
       * AWS said, which are the same every time; the sentence carries the rest.
       */
      deps.reads.fault({
        level: 'error',
        msg: permanent.msg,
        cleared: permanent.cleared,
        fields: { table: found.failure.table, detail: found.failure.message },
      })
    }

    return { did: 'failed', why: 'read' }
  }

  // THE READ ANSWERED, SO WHATEVER WAS WRONG WITH THE TABLE IS NOT WRONG NOW.
  // Here and not at the foot of the function: the role edit below can still fail,
  // and none of that is a statement about the table. It costs nothing on a healthy
  // bot, because `clear` on a slot holding nothing writes no line.
  deps.reads.clear()

  if (found.value === null) return { did: 'nothing' }

  const { pairing, how } = found.value
  const where = {
    user: reaction.userId,
    role: pairing.roleId,
    message: reaction.messageId,
    channel: reaction.channelId,
    emoji: reaction.emoji,
    matched: how,
  }

  try {
    if (move === 'added') await deps.roles.add(reaction.userId, pairing.roleId)
    else await deps.roles.remove(reaction.userId, pairing.roleId)
  } catch (error) {
    /**
     * WARN RATHER THAN ERROR, AND THE COMMAND IS WHY. `/reactrole` refuses a
     * role this bot cannot assign — managed, or above its own — at the moment
     * the pairing is made, and says so to the admin who made it. What reaches
     * here is that having become true AFTERWARDS: somebody dragged the role
     * above the bot's in the settings page, or took Manage Roles off it. That is
     * worth a line in the status channel and it is not the bot having broken.
     */
    log('warn', 'a reaction matched a pairing but the role could not be changed', {
      ...where,
      move,
      error,
    })

    return { did: 'failed', why: 'role' }
  }

  log(
    'info',
    move === 'added'
      ? 'a reaction granted the role it is paired with'
      : 'a reaction was taken back and its role went with it',
    where,
  )

  return { did: move === 'added' ? 'granted' : 'taken', roleId: pairing.roleId, how }
}

/* ------------------------------------------------------------------ *
 * What `/reactrole` needs from the live world.
 * ------------------------------------------------------------------ */

/**
 * Whether a thing the command was pointed at is there and readable.
 *
 * ONE UNION FOR BOTH QUESTIONS rather than a boolean each, because the command
 * says something different about each answer and the owner asked for it to: "the
 * message or channel cannot be found or read" is two refusals in one sentence,
 * and an admin who mistyped a channel should not be told his message is missing.
 */
export type Look = 'ok' | 'no-channel' | 'no-message'

/**
 * Everything `/reactrole` does that this process cannot do to a plain record.
 *
 * FIVE METHODS AND NOT A `Client`, which is what keeps the command a pure
 * function of an invocation. A test builds one of these as an object literal and
 * every refusal in ./commands/reactrole.ts — a message that is not there, an
 * emoji from another guild, a role above the bot's, a DynamoDB that is down — is
 * an entry in that literal rather than a gateway.
 */
export interface ReactRoleDesk {
  /** Is that channel there, in this guild, and readable by this bot? */
  channel(channelId: string): Promise<Look>

  /** Is that message there, in that channel, and readable by this bot? */
  message(channelId: string, messageId: string): Promise<Look>

  /**
   * Is that custom emoji one this bot can actually use?
   *
   * ASKED OF DISCORD RATHER THAN OF THE CACHE. A custom emoji belongs to one
   * guild and a bot may only put another guild's emoji on a message if it is in
   * that guild — so the question is "is this one ours", and the guild's emoji
   * cache can be stale for an emoji created since the last restart. One REST
   * call on a command that has already deferred is cheaper than refusing an
   * emoji the owner made five minutes ago.
   */
  emoji(emojiId: string): Promise<boolean>

  /** Could this bot give that role right now? Reads caches; makes no request. */
  role(roleId: string): RoleReadiness

  /**
   * Put the emoji on the message, so members have something to click. False when
   * Discord refused it; the pairing stands either way.
   */
  react(channelId: string, messageId: string, emoji: string): Promise<boolean>

  /** Write the pairing down. */
  save(pairing: ReactRolePairingInput): Promise<DdbResult<ReactRolePairing>>
}

/** The channel is gone, or this bot was never able to see it. */
function noChannel(error: unknown): boolean {
  if (!(error instanceof DiscordAPIError)) return false

  return (
    error.code === RESTJSONErrorCodes.UnknownChannel ||
    error.code === RESTJSONErrorCodes.MissingAccess
  )
}

/** The message is not there, or not there to this bot. */
function noMessage(error: unknown): boolean {
  if (noChannel(error)) return true

  return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage
}

/**
 * The real desk.
 *
 * ANYTHING THAT IS NOT ONE OF THE NAMED REFUSALS IS RETHROWN, and `runCommand`
 * in ./commands/command.ts turns a throw into `COPY.failed`. That is the honest
 * end for a rate limit or a Discord that is answering 500: the admin is told the
 * command failed rather than being told his message does not exist.
 */
export function liveDesk(
  client: Client,
  guildId: string,
  ddb: Pick<Ddb, 'reactRoles'>,
): ReactRoleDesk {
  /**
   * The channel, only if it is a text channel of THIS guild.
   *
   * THE GUILD CHECK IS NOT REDUNDANT WITH THE BOT BEING IN ONE GUILD. A channel
   * id is a snowflake an admin typed or pasted, and `client.channels.fetch`
   * resolves DMs and any channel this application can see through the console it
   * shares an identity with. A pairing written against one of those would be a
   * row nothing can ever match.
   */
  async function open(channelId: string) {
    const channel = await client.channels.fetch(channelId)

    if (channel === null || !channel.isTextBased() || channel.isDMBased()) return null
    return channel.guildId === guildId ? channel : null
  }

  return {
    async channel(channelId) {
      try {
        return (await open(channelId)) === null ? 'no-channel' : 'ok'
      } catch (error) {
        if (noChannel(error)) return 'no-channel'
        throw error
      }
    },

    async message(channelId, messageId) {
      let channel

      try {
        channel = await open(channelId)
      } catch (error) {
        if (noChannel(error)) return 'no-channel'
        throw error
      }

      if (channel === null) return 'no-channel'

      try {
        await channel.messages.fetch(messageId)
        return 'ok'
      } catch (error) {
        if (noMessage(error)) return 'no-message'
        throw error
      }
    },

    async emoji(emojiId) {
      const guild = await client.guilds.fetch(guildId)

      try {
        await guild.emojis.fetch(emojiId)
        return true
      } catch (error) {
        if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownEmoji) {
          return false
        }

        throw error
      }
    },

    /**
     * The same readiness check the game-ban role runs, over whichever role this
     * pairing names.
     *
     * IT IS ./banrole.ts's FUNCTION AND NOT A SECOND OPINION. `roleReadiness`
     * already decides this in the order that matters — no guild, no role, no
     * membership, no Manage Roles, a managed role, a role too high — and the one
     * thing it deliberately does not decide for itself is whether the bot's
     * highest role outranks the target, because two roles can share a raw
     * position and Discord breaks the tie on the id. `comparePositionTo` is
     * discord.js's implementation of that rule and is called here, where the live
     * objects are, exactly as `guildRoles` calls it there.
     */
    role(roleId) {
      const guild = client.guilds.cache.get(guildId) ?? null
      if (guild === null) return roleReadiness({ guild: false, role: null, self: null })

      const role = guild.roles.cache.get(roleId) ?? null
      const me = guild.members.me

      return roleReadiness({
        guild: true,
        role: role === null ? null : { managed: role.managed, position: role.position },
        self:
          me === null
            ? null
            : {
                manageRoles: me.permissions.has(PermissionsBitField.Flags.ManageRoles),
                highestPosition: me.roles.highest.position,
                above: role !== null && me.roles.highest.comparePositionTo(role) > 0,
              },
      })
    },

    async react(channelId, messageId, emoji) {
      try {
        const channel = await open(channelId)
        if (channel === null) return false

        const message = await channel.messages.fetch(messageId)
        await message.react(emoji)

        return true
      } catch (error) {
        // NOT A THROW, BECAUSE THE PAIRING IS ALREADY SAVED. Discord refuses a
        // react for reasons that have nothing to do with whether the pairing is
        // good — Add Reactions withheld in that one channel, the message's
        // reaction slots full — and the admin is told which of the two happened.
        log('warn', 'the pairing was saved but its emoji could not be added to the message', {
          channel: channelId,
          message: messageId,
          emoji,
          error,
        })

        return false
      }
    },

    save(pairing) {
      return ddb.reactRoles.put(pairing)
    },
  }
}

/**
 * THE ONE DESK, AS MODULE STATE, and it is the trade ../sticky.ts makes for the
 * same reason: a slash command handler is handed an `Invocation` and a `Config`
 * and nothing else — that signature is what keeps every command testable — so a
 * command cannot be given a desk through its arguments, and threading one
 * through `runCommand` would put a reaction-role-shaped parameter on every
 * command this bot will ever have.
 *
 * `null` IS THE HONEST STARTING VALUE. A bot whose client has not installed one
 * yet, and a test that has not injected one, both get a refusal rather than a
 * crash.
 */
let installed: ReactRoleDesk | null = null

/** The desk, or null when none has been installed. */
export function reactRoles(): ReactRoleDesk | null {
  return installed
}

/** Put a desk in place, or take it out. Tests use both directions. */
export function setReactRoles(desk: ReactRoleDesk | null): void {
  installed = desk
}

/* ------------------------------------------------------------------ *
 * The gateway half.
 * ------------------------------------------------------------------ */

/** A reaction as discord.js hands one over, reduced to what is read off it. */
export interface LiveReaction {
  readonly emoji: ReactionEmoji

  /**
   * The message, which may be a PARTIAL and usually is.
   *
   * ALL THREE IDS ARE ON A PARTIAL, which is the whole reason nothing here
   * fetches one. discord.js builds the partial from the gateway payload's
   * `message_id`, `channel_id` and `guild_id`, so a reaction on a message posted
   * before the last restart carries everything this file asks of it.
   */
  readonly message: {
    readonly id: string
    readonly channelId: string
    readonly guildId: string | null
  }
}

/** The reacting account, as the event carries one. */
export interface LiveReactor {
  readonly id: string

  /**
   * Whether it is a bot, when Discord said.
   *
   * OPTIONAL BECAUSE A REMOVAL MAY NOT SAY. A `MESSAGE_REACTION_ADD` in a guild
   * carries the whole member, so `bot` is known; a `MESSAGE_REACTION_REMOVE`
   * carries a user id and nothing else, and for an account that is not in the
   * user cache discord.js hands over a PARTIAL user whose `bot` is undefined.
   * `reactionOf` compares against this bot's own id as well for exactly that
   * gap — the bot whose reaction must never be acted on is this one.
   */
  readonly bot?: boolean
}

/**
 * A live reaction as the record above.
 *
 * STRUCTURAL RATHER THAN discord.js's TYPES, for the reason `snapshot` in
 * ./client.ts is structural: the real `MessageReaction` cannot be built in a
 * test without a client, and this is the function that decides what the handler
 * gets to see.
 */
export function reactionOf(
  reaction: LiveReaction,
  user: LiveReactor,
  selfId: string | null,
): Reaction {
  return {
    messageId: reaction.message.id,
    channelId: reaction.message.channelId,
    guildId: reaction.message.guildId,
    emoji: emojiKeyOf(reaction.emoji),
    userId: user.id,
    fromBot: user.bot === true || (selfId !== null && user.id === selfId),
  }
}

/**
 * Wire reaction roles onto a live client: the desk the command reaches for, and
 * the two listeners.
 *
 * ONE CALL, BECAUSE THE HOOK LIVES IN client.ts AND THIS FILE DOES NOT OWN IT —
 * the rule `installStickies` follows. Everything that could be a line over there
 * is on this side of the call.
 *
 * ═══ IT NEEDS AN INTENT AND TWO PARTIALS, AND THEY ARE IN client.ts ═══
 *
 * `GuildMessageReactions` is what makes the gateway send these events at all,
 * and it is NOT privileged: no tick in the Developer Portal, no review, nothing
 * for an operator to do beyond restarting onto this build. `Partials.Reaction`
 * and `Partials.User` are what make them arrive for a message this process has
 * never seen and a member it has not cached — without them discord.js drops the
 * event before any listener runs, and the feature would work only on messages
 * posted since the last restart. See `createClient`.
 *
 * THE LISTENERS ARE SYNCHRONOUS AND HANDLE THEIR OWN PROMISES, for the reason
 * `onMessage` in client.ts does: an async function handed to an EventEmitter has
 * nowhere to reject to, and becomes an unhandled rejection several ticks later
 * attached to no reaction and no member.
 *
 * THE DESK AND THE GRANTS ARE PARAMETERS WITH DEFAULTS, which is the only reason
 * the wiring itself is testable. Both defaults are the live ones and no caller
 * passes either; a test passes fakes and reads what the listeners did to them.
 * Without the second one, asserting that a `messageReactionAdd` reaches
 * `handleReaction` would mean a `guilds.fetch` against Discord from a test suite
 * that has no network and no token.
 */
export function installReactionRoles(
  client: Client,
  config: Config,
  ddb: Pick<Ddb, 'reactRoles'>,
  desk: ReactRoleDesk = liveDesk(client, config.guildId, ddb),
  roles: ReactRoleGrants = guildReactRoles(client, config.guildId),
): void {
  setReactRoles(desk)

  /**
   * ONE SLOT, HELD FOR THE LIFE OF THE PROCESS. Built here and not inside the
   * handler, because a latch rebuilt per reaction holds nothing and a wall of one
   * sentence is exactly what it is for. See `READ_FAULT`.
   */
  const deps: ReactRoleDeps = { ddb, roles, guildId: config.guildId, reads: latch() }

  const onReaction = (reaction: LiveReaction, user: LiveReactor, move: ReactionMove): void => {
    void handleReaction(reactionOf(reaction, user, client.user?.id ?? null), move, deps).catch(
      (error: unknown) => {
        // `handleReaction` is written not to throw; this is the guarantee that
        // it did, rather than a path anything is expected to take.
        log('error', 'the reaction role handler threw', { message: reaction.message.id, error })
      },
    )
  }

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    onReaction(reaction, user, 'added')
  })

  client.on(Events.MessageReactionRemove, (reaction, user) => {
    onReaction(reaction, user, 'removed')
  })
}
