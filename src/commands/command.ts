import type { ChatInputApplicationCommandData } from 'discord.js'

import type { Config } from '../config.ts'
import { log } from '../log.ts'

/**
 * What a slash command is, who is allowed to run it, and what is said when the
 * answer is no.
 *
 * SPLIT THE WAY client.ts IS SPLIT, for the same reason. Everything here is a
 * function of plain records: an `Invocation` says who ran what, `refusalFor`
 * answers whether they may, and a handler returns the STRING it wants said
 * rather than reaching for the interaction and saying it. The half that touches
 * discord.js — turning a real interaction into an `Invocation`, turning a
 * string into a reply with the right flags on it — is in ./index.ts and is
 * three small functions long. So the gate, the dispatch and every failure path
 * are exercised offline against objects written three lines above the
 * assertion, with no gateway and no application to register against.
 *
 * A HANDLER RETURNS TEXT AND NEVER REPLIES ITSELF. That is what keeps
 * `MessageFlags.Ephemeral` in ONE place instead of in every command file, and
 * one place is the difference between a rule and a habit: the deprecated
 * `ephemeral: true` boolean cannot creep back in through a command written six
 * months from now, because a command has nothing to pass it to.
 */

/**
 * One use of one command, reduced to what a decision needs.
 *
 * A PLAIN RECORD RATHER THAN discord.js's `ChatInputCommandInteraction`, for
 * the reason `ScannedMessage` is a plain record: the real thing is a live
 * object with a REST handle, a token that expires and three different ways to
 * reply on it, and taking one as a parameter would put a reply inside arm's
 * reach of the gate. Building one in a test is six fields.
 */
export interface Invocation {
  readonly commandName: string

  /**
   * Null outside a guild.
   *
   * THESE ARE GUILD COMMANDS, so this should never be null — a guild command
   * does not exist anywhere it could be run from a DM. It is carried, and
   * checked, because "should never" is not a thing to bet a gate on: if a
   * payload ever arrives without it, the roles below are meaningless too, and
   * the safe reading of that is a refusal rather than a run.
   */
  readonly guildId: string | null

  /** Who ran it. For the journal, and for nothing else. */
  readonly userId: string

  /**
   * The invoker's role ids as the interaction payload carried them, or null
   * when it carried none.
   *
   * DISCORD SHIPS THESE COMPLETE ON EVERY INTERACTION, which is the whole
   * reason the gate can be a comparison against data already in hand: no
   * member fetch, no cache read, and no `GuildMembers` intent — see
   * `createClient` in client.ts for why that intent stays off.
   *
   * NULL IS NOT AN EMPTY LIST. `[]` means Discord said this member holds no
   * roles; null means no member came with the payload at all. Both fail the
   * gate, and they are kept apart so the journal can say which one happened.
   */
  readonly roleIds: readonly string[] | null

  /**
   * The user id of the command's `user` option, when it has one and one was
   * given.
   *
   * NAMED IN THE RECORD RATHER THAN HANDING THE HANDLER discord.js's OPTION
   * RESOLVER. The resolver is a live object off the interaction, and putting
   * one in here would drag the whole live half back into the part of the file
   * that exists to be testable. A command that later needs an option which is
   * not a target grows a field here and one line in `invocationOf`; that is a
   * cheaper price than the one it replaces.
   */
  readonly targetId: string | null
}

/**
 * The name of the option `targetId` is read out of.
 *
 * ONE CONSTANT SO THE TWO HALVES CANNOT DRIFT. The command file declares an
 * option by this name and `invocationOf` asks Discord for one by this name, and
 * a rename in only one of those places is not a compile error — it is a
 * `/help @someone` that silently behaves as though nobody was tagged.
 */
export const TARGET_OPTION = 'user'

/**
 * Why an invocation was not run. Four reasons, and they are four different
 * things to an operator reading the journal.
 *
 * `not-in-guild` is a payload that is not what this file expects.
 *
 * `admin-role-unset` says DISCORD_ADMIN_ROLE_ID is not configured, so nobody
 * in the guild can be an admin and no admin command can ever run. That is a
 * misconfiguration and it is the one refusal that is worth a warning.
 *
 * `roles-unreadable` says the payload arrived with no member on it.
 *
 * `not-admin` is the ordinary case: a member who does not hold the role.
 */
export type Refusal = 'not-in-guild' | 'admin-role-unset' | 'roles-unreadable' | 'not-admin'

/**
 * One command: what Discord is told about it, who may run it, and what it does.
 */
export interface BotCommand {
  /**
   * The registration payload, minus the one field this file derives.
   *
   * A PLAIN `ChatInputApplicationCommandData` RATHER THAN `SlashCommandBuilder`.
   * It is a record, which is what every other boundary in this repo is, and it
   * needs no import that is not already here. The builder's only real offer is
   * validation of a shape that `tsc` already checks.
   *
   * `defaultMemberPermissions` IS DELIBERATELY NOT WRITTEN HERE. `commandData`
   * derives it from `adminOnly`, so the two cannot disagree; see there.
   */
  readonly data: ChatInputApplicationCommandData

  /**
   * Whether the gate below applies. THIS FIELD IS THE GATE — see `refusalFor`
   * for why the permission Discord shows in its own UI is not.
   */
  readonly adminOnly: boolean

  /**
   * Whether the reply is seen only by the person who ran the command.
   *
   * A FUNCTION OF THE INVOCATION, AND IT HAS TO BE, because Discord fixes a
   * reply's visibility at the moment it is DEFERRED — before the handler has
   * run and before it could have an opinion. Anything the choice depends on
   * therefore has to be readable from the invocation alone.
   */
  readonly onlyInvoker: (invocation: Invocation) => boolean

  /**
   * What to say back. Returns the text; does not send it.
   *
   * ALLOWED TO THROW. `runCommand` turns a throw into a reply — see there —
   * because the alternative Discord shows the admin is "The application did
   * not respond", which says nothing about what broke.
   */
  readonly run: (invocation: Invocation, config: Config) => string | Promise<string>
}

/**
 * Everything `runCommand` is allowed to do to the outside world, injected.
 *
 * THREE FUNCTIONS AND NOT AN INTERACTION, so every path below — the refusal,
 * the deferred success, the handler that threw — is asserted against a fake
 * built in the test. `responderFor` in ./index.ts is the live one.
 */
export interface Responder {
  /**
   * Buy time past Discord's three-second deadline, and fix the reply's
   * visibility while doing it.
   */
  defer: (onlyInvoker: boolean) => Promise<void>

  /** Fill in a reply that was deferred. */
  edit: (content: string) => Promise<void>

  /** Answer at once, without deferring. Only the refusals take this path. */
  reply: (content: string, onlyInvoker: boolean) => Promise<void>
}

/**
 * PLACEHOLDER COPY, AND NONE OF IT IS THE OWNER'S WORDING. Every string a
 * member can see is here, in one record, so that supplying the real text is one
 * edit to one object rather than a hunt through the command files. The strings
 * say what they are on purpose: shipping one by accident has to be obvious in
 * the channel rather than invisible.
 */
const COPY = {
  refused: 'PLACEHOLDER: no wording supplied yet for a command you may not run.',
  unknown: 'PLACEHOLDER: no wording supplied yet for a command this bot does not have.',
  failed: 'PLACEHOLDER: no wording supplied yet for a command that failed.',
}

/**
 * May this invocation run? Null means yes.
 *
 * THIS IS THE GATE, AND IT IS CHECKED HERE BECAUSE DISCORD'S OWN ONE IS NOT A
 * GATE. `commandData` sets `defaultMemberPermissions: 0n` on every admin
 * command, which hides it from everybody in the client — and that is a DEFAULT,
 * not a permission. Anybody holding Manage Server can open Server Settings ->
 * Integrations, find this application, and re-grant any command to @everyone or
 * to a role of their choosing. Nothing tells the bot that happened: the
 * interaction arrives looking exactly like an admin's. So the UI default fails
 * open on a path that needs no code, no token and no cooperation from us, and
 * the only thing standing behind it is this function.
 *
 * THE ROLES ARE READ OFF THE PAYLOAD AND NOTHING IS CACHED. The bot has a
 * remembered role table for the moderation path — `ROLE_TTL_MS`, one minute,
 * in client.ts — and it is deliberately not reused here. A TTL is a window in
 * which an admin who was demoted a moment ago still holds admin, and that is a
 * reasonable trade for "was this member's message scanned" and not a reasonable
 * one for "may this member run an admin command". The console refuses to cache
 * this for the same reason. There is nothing to trade anyway: the roles are in
 * the payload, so reading them fresh costs nothing at all.
 *
 * AN UNSET DISCORD_ADMIN_ROLE_ID REFUSES. It is the direction that matters most
 * in this file, and it is the opposite of what the same variable does on the
 * moderation path, where unset turns the admin EXEMPTION off and everybody gets
 * scanned. Both are the closed direction for what they guard: there, not being
 * able to identify an admin means nobody is skipped; here, it means nobody is
 * let in. An unset variable must never be the thing that opens a door.
 */
export function refusalFor(
  command: BotCommand,
  invocation: Invocation,
  config: Config,
): Refusal | null {
  // Checked for every command, admin-only or not. A guild command cannot be
  // invoked outside its guild, so this is a payload that is not what this file
  // expects rather than a DM — and the roles below would be meaningless.
  if (invocation.guildId === null) return 'not-in-guild'

  if (!command.adminOnly) return null

  if (config.adminRoleId === null) return 'admin-role-unset'
  if (invocation.roleIds === null) return 'roles-unreadable'

  return invocation.roleIds.includes(config.adminRoleId) ? null : 'not-admin'
}

/**
 * Run one invocation: find the command, gate it, answer it, and never leave it
 * unanswered.
 *
 * THE REFUSAL IS ANSWERED WITHOUT DEFERRING. The gate is a comparison against
 * an array already in memory, so it is nowhere near Discord's three seconds,
 * and replying directly keeps the refusal seen only by the person who ran the
 * command whatever visibility the command itself would have used.
 *
 * EVERYTHING ELSE IS DEFERRED FIRST. The deadline is three seconds from the
 * interaction arriving, and a handler that reads DynamoDB or asks Discord
 * anything can exceed that on a bad day for reasons that have nothing to do
 * with it. `deferReply` is one request and it buys fifteen minutes; the cost is
 * that the admin sees Discord's own "thinking" state for a moment. Deferring
 * every command rather than the ones that look slow means no command written
 * later can miss the deadline by being written the obvious way.
 *
 * A THROW BECOMES A REPLY. Without this the handler's rejection reaches the
 * listener's `.catch`, gets a journal line, and leaves the admin looking at
 * "The application did not respond" — a message that describes a bot which is
 * down, when what happened is one command failing for one reason that is
 * already written in the journal.
 */
export async function runCommand(
  invocation: Invocation,
  config: Config,
  respond: Responder,
  commands: readonly BotCommand[],
): Promise<void> {
  const where = { command: invocation.commandName, user: invocation.userId }
  const command = commands.find((candidate) => candidate.data.name === invocation.commandName)

  if (command === undefined) {
    // Discord sent a command this build does not have, which means the
    // registration and the code have drifted apart — most often a command
    // deleted here while a client somewhere still has the old list.
    // `guild.commands.set` makes that self-correcting at the next boot; until
    // then the admin gets an answer instead of a spinner.
    log('warn', 'slash command is not one this bot has', where)
    await respond.reply(COPY.unknown, true)
    return
  }

  const refusal = refusalFor(command, invocation, config)

  if (refusal !== null) {
    // `admin-role-unset` is the operator's problem and nobody else's: the
    // command is unusable by everybody until the variable is set, and that
    // needs to reach whoever runs the bot. The other three are an ordinary
    // member trying a command they cannot run, which is not a fault.
    log(refusal === 'admin-role-unset' ? 'warn' : 'info', `slash command refused: ${refusal}`, where)
    await respond.reply(COPY.refused, true)
    return
  }

  await respond.defer(command.onlyInvoker(invocation))

  let content: string

  try {
    // Awaited inside the try so that a handler which rejects and a handler
    // which throws before returning a promise land in the same place. A bare
    // `.catch()` on the returned value would only catch the first.
    content = await command.run(invocation, config)
  } catch (error) {
    log('error', 'slash command handler failed', { ...where, error })
    await respond.edit(COPY.failed)
    return
  }

  await respond.edit(content)
}
