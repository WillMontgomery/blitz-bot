import { ApplicationCommandOptionType } from 'discord.js'

import type { Config } from '../config.ts'
import {
  createDevBoxReach,
  devBoxStatus,
  startDevBox,
  type DevBoxDeps,
  type DevBoxRefused,
  type DevBoxStart,
  type DevBoxStatus,
} from '../devbox.ts'
import { launchInFlight } from '../inflight.ts'
import { log } from '../log.ts'
import type { BotCommand, Invocation } from './command.ts'

/**
 * `/dev` — START THE DEV GAME BOX FROM DISCORD, AND SAY WHICH COMMIT IT CAME UP
 * ON.
 *
 * Starting the dev box is an EC2 console trip today, and the thing an admin
 * actually wants to know afterwards is not that an instance is running: it is
 * that the game server is up and which commit it is running. ../devbox.ts does
 * that work; this file decides what a person is told about it.
 *
 * ═══ THE RESULT IS A CHANNEL MESSAGE AND NOT THE REPLY ═══
 *
 * An interaction token dies fifteen minutes after the interaction, and a cold
 * start plus a deploy can get close to that: the box has to reach `running`, the
 * SSM agent has to register, and then `royale-deploy` syncs the tree and
 * restarts the game server. So `/dev start` answers IMMEDIATELY and ephemerally
 * — "it is starting" — and the ANSWER is posted afterwards as an ordinary
 * message in the channel the command was run in, mentioning whoever asked.
 *
 * A NORMAL MESSAGE HAS NO CLOCK ON IT. An `editReply` fifteen minutes and one
 * second later fails with `Unknown Webhook` and the admin is left looking at a
 * spinner that never resolves, having no idea whether a deploy happened. That is
 * the one failure this design exists to make impossible, and it is why the post
 * goes through the client rather than through the interaction.
 *
 * THE WORK IS `launchInFlight`'ED so that a SIGTERM during a deploy is drained
 * by src/index.ts rather than dropped silently. src/inflight.ts bounds that wait;
 * a deploy outliving it still finishes on the box, and the next `/dev status`
 * says what it did.
 *
 * ═══ ONE START AT A TIME ═══
 *
 * A second `/dev start` while one is in flight does NOT start a second one. The
 * first one's `systemctl start royale-deploy` is blocking on a git sync, and a
 * second deploy landing on top of it is how a half-synced tree gets restarted
 * into. The admin is told one is already going rather than being given a second
 * ack for work nobody is doing twice.
 *
 * ═══ `/dev status` CHANGES NOTHING ═══
 *
 * Same facts, no start, no deploy, and it answers through the interaction because
 * three reads on a running box are seconds rather than minutes. A stopped box is
 * an answer and not a failure.
 *
 * THERE IS NO STOP AND THERE IS NO PROD. The box stops itself after twelve idle
 * hours (infradocs#32), the bot's policy grants no `ec2:StopInstances`, and the
 * only instance this command can reach is the one in `config.devInstanceId`.
 */

/**
 * The names Discord registers.
 *
 * ONE CONSTANT EACH SO THE TWO HALVES CANNOT DRIFT, exactly as `/drain`'s are:
 * this file declares them and `invocationOf` in ./index.ts asks Discord for them
 * by the same strings. A rename in one place is not a compile error — it is a
 * `/dev start` that falls through to the "which half did you mean" refusal.
 */

/** @unwritten picker — the `/dev` subcommand that starts the box. The word `start` is the issue's. */
export const DEV_START_SUBCOMMAND = 'start'

/** @unwritten picker — the `/dev` subcommand that only looks. The word `status` is the issue's. */
export const DEV_STATUS_SUBCOMMAND = 'status'

/**
 * The field this command needs that `Invocation` does not carry yet.
 *
 * WRITTEN AS OPTIONAL, AND THAT IS SCAFFOLDING RATHER THAN A DESIGN, exactly as
 * `DrainFields` is: ./command.ts says a command wanting an option which is not a
 * target "grows a field here and one line in `invocationOf`", and `invocationOf`
 * DOES carry `subcommand` today. Declared as an intersection so this command
 * compiles against an invocation that carries it and against one that does not —
 * and an invocation without it is refused rather than read as the half that
 * restarts the game server.
 */
export interface DevFields {
  /** Which subcommand was invoked. `interaction.options.getSubcommand(false)`. */
  readonly subcommand?: string | null
}

/**
 * Somebody else's sentence, closed off so the sentence carrying it ends.
 *
 * BORROWED FROM ./drain.ts's `ended` AND FOR ITS REASON. Every failure below
 * finishes on a `detail` this repo did not write — AWS's own message, a unit's
 * stderr — and those arrive with a full stop about half the time. A frame that
 * only interpolates ships an unfinished-looking sentence whenever they do not,
 * and a frame that always appends one puts a period after somebody else's.
 *
 * NOTHING ELSE IS TOUCHED: not a word of it, not its opening capital, and not a
 * `.` `!` `?` or `…` it already ends with.
 */
function ended(detail: string): string {
  const said = detail.trimEnd()

  return /[.!?…]$/u.test(said) ? said : `${said}.`
}

/**
 * EVERY STRING `/dev` CAN SAY, IN ONE RECORD, under the rule ./command.ts sets: a
 * sentence somebody can see lives here so that changing one is one edit to one
 * object.
 *
 * ═══ THE SUCCESS LINE IS THE ISSUE'S OWN AND IS NOT PUNCTUATED BY THIS FILE ═══
 *
 * `dev is up on <sha> (<branch>)` is the line the work was asked for in, down to
 * the brackets and the missing full stop, and it ships exactly like that. It is
 * the whole message: no lead, no advice, and nothing echoed back that nobody
 * asked for.
 *
 * ═══ THE REST ARE MINE AND ARE TAGGED ═══
 *
 * The failures and the two acks are this file's words, in ./drain.ts's register —
 * one short sentence, then who has to act if anybody does. They carry
 * `@unwritten admin` in their own doc comments rather than a marker in the
 * sentence, which is the convention `scripts/check-placeholders.ts` reads: the
 * marker in the text is what reached a real admin on `/drain`, and the list is
 * how the owner is asked for wording instead.
 *
 * WHAT EACH FAILURE SAYS IS WHAT TO DO ABOUT IT AND NOT WHAT BROKE INSIDE AWS.
 * The AWS detail rides inside the sentence unedited — see ../devbox.ts, which
 * writes it for whoever has to fix it — because this file cannot know better
 * than the call that failed did.
 */
export const COPY = {
  /** @unwritten picker — the `/dev` command as Discord's picker describes it. Discord allows 1-100 characters. */
  description: 'Start the dev server, or ask what state it is in',

  /** @unwritten picker — the `/dev start` subcommand, in the picker. */
  startDescription: 'Start the dev box and deploy the latest dev commit onto it',

  /** @unwritten picker — the `/dev status` subcommand, in the picker. */
  statusDescription: 'Say what state the dev box is in, without changing anything',

  /**
   * The line the whole feature exists to produce. THE ISSUE'S OWN WORDING,
   * VERBATIM, punctuation and all. See the head of this record.
   */
  up: (commit: string, branch: string) => `dev is up on ${commit} (${branch})`,

  /**
   * @unwritten admin — the deploy finished and the game server is not active. It names the state `systemctl is-active royale` gave.
   *
   * A SECOND LINE RATHER THAN THE FIRST ONE WITH A CAVEAT ON IT. "dev is up" is a
   * claim about the game server, and a box whose `royale` came back `failed`
   * after a deploy that otherwise worked is a real and different outcome. Saying
   * "up" there would be the one sentence in this file that is not true.
   */
  deployedNotActive: (commit: string, branch: string, royale: string) =>
    `dev deployed ${commit} (${branch}) and royale is ${royale}.`,

  /** @unwritten admin — the immediate ephemeral ack for `/dev start`, which has to say where the answer will appear. */
  starting: 'Starting dev. The result will be posted in this channel.',

  /** @unwritten admin — a second `/dev start` while the first one is still going. */
  alreadyStarting: 'dev is already starting, so nothing new was started.',

  /** @unwritten admin — `/dev` could not tell which half was meant. */
  noSubcommand: `It is not clear whether you meant \`/dev ${DEV_START_SUBCOMMAND}\` or \`/dev ${DEV_STATUS_SUBCOMMAND}\`, so nothing was done.`,

  /** @unwritten admin — `/dev start` was invoked from a payload carrying no channel, so the result would have nowhere to go. */
  noChannel: 'Nothing was started, because there is nowhere to post the result.',

  /**
   * The two leads a failure can open with. Which half was being run.
   *
   * @unwritten admin — the opening clause of every `/dev start` failure.
   */
  startLead: 'dev did not start',

  /** @unwritten admin — the opening clause of every `/dev status` failure. */
  statusLead: 'dev could not be read',

  /**
   * @unwritten admin — a failure only an operator can clear: AWS refused the call, there is no identity, the id names nothing, or EC2 will not start it from the state it is in.
   *
   * ONE FRAME FOR FOUR FAILURES, for ./drain.ts's `denied` reason: the caller
   * does the same thing with all of them, which is nothing, and the difference
   * between them is already in the detail. On day one this is the likeliest
   * sentence in this file — the policy is not attached yet.
   */
  operator: (lead: string, detail: string) =>
    `${lead}: ${ended(detail)} An operator has to look at this.`,

  /** @unwritten admin — the box or its agent was not there yet, which the next try may find differently. */
  again: (lead: string, detail: string) => `${lead}: ${ended(detail)} Run this again in a moment.`,

  /** @unwritten admin — a failure this bot has no specific answer for. AWS's own message is the whole of what is known. */
  unknown: (lead: string, detail: string) => `${lead}: ${ended(detail)}`,

  /** @unwritten admin — the deploy ran and ended badly. The unit's own output is quoted. */
  commandFailed: (detail: string) => `The deploy on dev failed: ${ended(detail)}`,

  /** @unwritten admin — the deploy was still going when the wait ran out. The SSM command id is how it is looked up. */
  commandUnfinished: (detail: string, commandId: string) =>
    `The deploy on dev is still running: ${ended(detail)} Its SSM command id is ${commandId}.`,

  /**
   * @unwritten admin — the deploy ran, succeeded, and printed nothing this bot could read the commit out of.
   *
   * IT SAYS THE DEPLOY RAN, WHICH IS THE POINT OF HAVING THIS AT ALL. The
   * invocation came back `Success`; only the marker line was missing. Reporting
   * that as a deploy that did not happen would send somebody to start one again
   * on a box that has already been deployed to.
   */
  unreadable: (commandId: string) =>
    `The deploy on dev ran and its result could not be read. Its SSM command id is ${commandId}.`,

  /**
   * `/dev status`'s clauses, joined with a comma into one line.
   *
   * ONE LINE AND NOT A LIST, for ./drain.ts's reason: the owner has said three
   * times that multi-line replies "look so weird". Each clause is a fact and an
   * absent fact is an absent clause — a stopped box has a state and nothing else
   * to say, and a sentence claiming otherwise would be inventing one.
   */
  statusState: (state: string) => `dev is ${state}`,
  statusAgent: (agent: string) => `the agent is ${agent}`,
  statusRoyale: (royale: string) => `royale is ${royale}`,
  statusCommit: (commit: string, branch: string) => `on ${commit} (${branch})`,

  /**
   * The bot has no way to post the result, which means `installCommands` never
   * put one in place. ./sticky.ts's sentence for the same fault, reused rather
   * than reworded: it is the owner's, and this is the same "the wiring is
   * missing" case it was written for.
   */
  unavailable: 'Something went wrong. Try again.',
}

/**
 * Where the result of a start is posted.
 *
 * A SEAM AND NOT A `Client`, for the reason `ReactRoleDesk` in ../reactroles.ts
 * is not one: a handler is handed an `Invocation` and a `Config` and nothing
 * else, and that signature is what keeps every branch of this file testable.
 * `liveDevNotice` in ./index.ts is the real one, built where the client already
 * is.
 *
 * IT TAKES THE USER ID SEPARATELY FROM THE TEXT so the send can narrow
 * `allowedMentions` to exactly that person. See `liveDevNotice`.
 */
export interface DevNotice {
  post(channelId: string, userId: string, text: string): Promise<void>
}

/**
 * THE ONE NOTICE, AS MODULE STATE, and it is the trade ../reactroles.ts and
 * ../sticky.ts both make for the same reason: a command cannot be handed a live
 * client through its arguments, and threading one through `runCommand` would put
 * a dev-box-shaped parameter on every command this bot will ever have.
 *
 * `null` IS THE HONEST STARTING VALUE. A bot whose client has not installed one,
 * and a test that has not injected one, both get a refusal rather than a crash.
 */
let installed: DevNotice | null = null

/** The notice, or null when none has been installed. */
export function devNotice(): DevNotice | null {
  return installed
}

/** Put one in place, or take it out. Tests use both directions. */
export function setDevNotice(notice: DevNotice | null): void {
  installed = notice
}

/** How the command reaches AWS. Injected so the tests run offline. */
export type DevBoxFor = (config: Config) => DevBoxDeps

/**
 * The real one, built on first use and kept.
 *
 * LAZY FOR `lazyReadsFrom`'S REASON. The command list in ./index.ts is a
 * module-level constant imported by tests that run offline, and building the
 * clients here at import would put two SDK clients in that array for every one of
 * them. One pair for the life of the process after that; they hold sockets and
 * nothing else worth rebuilding.
 *
 * KEYED ON NOTHING, because the config is read once at boot and never changes.
 * `loadConfig` runs in src/index.ts and the same object reaches every command, so
 * caching the first reach cannot serve a later call the wrong region — and it
 * cannot serve it the wrong INSTANCE either, which is the one that matters: the
 * instance id is read from the same config on every call and passed through.
 */
export function lazyDevBox(): DevBoxFor {
  let reach: { ec2: DevBoxDeps['ec2']; ssm: DevBoxDeps['ssm'] } | null = null

  return (config) => {
    reach ??= createDevBoxReach(config.devRegion)

    return { instanceId: config.devInstanceId, ec2: reach.ec2, ssm: reach.ssm }
  }
}

/** Which half was invoked, or null when the payload did not say. */
function subcommandOf(invocation: Invocation & DevFields): string | null {
  const name = invocation.subcommand

  return typeof name === 'string' && name !== '' ? name : null
}

/**
 * The command id on a failure that always carries one.
 *
 * `DevBoxRefused.commandId` IS NULLABLE FOR THE FAILURES THAT HAPPEN BEFORE THE
 * SEND, and the three frames that quote an id are only ever reached after it. The
 * fallback is therefore unreachable rather than a case anybody has to word — and
 * it is a word rather than an empty gap so that a sentence promising an id cannot
 * ship without one in it.
 */
function commandIdOf(result: DevBoxRefused): string {
  return result.commandId ?? 'unknown'
}

/**
 * One failure, in whichever register it belongs to.
 *
 * FIVE FRAMES FOR TEN FAILURES BECAUSE THERE ARE FIVE DIFFERENT NEXT ACTIONS —
 * ./drain.ts's `refusalReply` and its argument. Four of them are an operator's
 * job and the admin needs to know it is not theirs; two are worth trying again;
 * a deploy that failed, one that is still going and one that cannot be read are
 * three different things to be told, and the last two name the command id because
 * that is the only way anybody finds out what happened.
 */
function refusalReply(result: DevBoxRefused, lead: string): string {
  switch (result.failure) {
    case 'denied':
    case 'credentials':
    case 'no-such-instance':
    case 'unstartable':
      return COPY.operator(lead, result.detail)
    case 'not-running':
    case 'agent-offline':
      return COPY.again(lead, result.detail)
    case 'command-failed':
      return COPY.commandFailed(result.detail)
    case 'command-unfinished':
      return COPY.commandUnfinished(result.detail, commandIdOf(result))
    case 'unreadable':
      return COPY.unreadable(commandIdOf(result))
    case 'error':
      return COPY.unknown(lead, result.detail)
  }
}

/**
 * What one finished `/dev start` is said to have done.
 *
 * READ OFF WHAT CAME BACK AND NEVER OFF WHAT WAS ASKED FOR, ./drain.ts's rule:
 * the commit and the branch are the ones the deployed tree actually reports, and
 * `royale` is the word `systemctl is-active` gave rather than an assumption that
 * a deploy which finished left the game server running.
 */
export function replyForStart(result: DevBoxStart): string {
  if (result.outcome === 'failed') return refusalReply(result, COPY.startLead)

  return result.royale === 'active'
    ? COPY.up(result.commit, result.branch)
    : COPY.deployedNotActive(result.commit, result.branch, result.royale)
}

/** And one `/dev status`, as however many of the four facts were readable. */
export function replyForStatus(result: DevBoxStatus): string {
  if (result.outcome === 'failed') return refusalReply(result, COPY.statusLead)

  const parts = [COPY.statusState(result.state)]

  if (result.agent !== null) parts.push(COPY.statusAgent(result.agent))
  if (result.royale !== null) parts.push(COPY.statusRoyale(result.royale))

  if (result.commit !== null && result.branch !== null) {
    parts.push(COPY.statusCommit(result.commit, result.branch))
  }

  return parts.join(', ')
}

/**
 * `/dev`.
 *
 * A FACTORY TAKING THE AWS DEPS AND THE NOTICE, exactly as `/drain` takes its
 * relay. The command is then a pure function of an invocation, a config, an
 * injected AWS and an injected channel — so every branch below, including the one
 * that deploys to a game box, is exercised against object literals in a test file
 * with no AWS and no gateway anywhere near it.
 *
 * THE IN-FLIGHT FLAG IS THIS CLOSURE'S AND NOT MODULE STATE, which is the one
 * thing here that is deliberately NOT ../reactroles.ts's pattern. It is about one
 * command's own work rather than about the live world, so a test that builds a
 * second `/dev` gets a second flag and cannot be left standing in a state the
 * previous test set.
 */
export function devCommand(
  devBoxFor: DevBoxFor,
  noticeFor: () => DevNotice | null = devNotice,
): BotCommand {
  /**
   * Whether a start is already going. See the head of this file: a second
   * deploy on top of one that is mid-sync is the failure this prevents.
   *
   * CLEARED IN A `finally` SO A THROWN START DOES NOT WEDGE THE COMMAND SHUT.
   * The one case it stays true through is a shutdown that refuses the work
   * outright, and that process is on its way out anyway.
   */
  let starting = false

  return {
    data: {
      name: 'dev',
      description: COPY.description,

      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: DEV_START_SUBCOMMAND,
          description: COPY.startDescription,
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: DEV_STATUS_SUBCOMMAND,
          description: COPY.statusDescription,
        },
      ],
    },

    /**
     * ADMIN-ONLY, UNCONDITIONALLY. One half starts a game box and deploys onto
     * it and the other names commits and unit states; neither is a thing to
     * answer about the caller, so the gate is a boolean rather than a predicate —
     * and `commandData` derives `defaultMemberPermissions: 0n` from that word,
     * which hides it in the client as well. The hiding is a default and never
     * the guard; `refusalFor` in ./command.ts is.
     */
    adminOnly: true,

    /**
     * EPHEMERAL, BOTH HALVES, AND THE RESULT IS STILL PUBLIC. The ack is
     * operational noise — "it is starting" — and the ANSWER is a channel message
     * mentioning the requester, which is the thing worth anybody else seeing.
     * `/dev status` is ephemeral because it is somebody checking, and a channel
     * full of unit states is not a record anybody reads.
     */
    onlyInvoker: () => true,

    run: async (invocation, config) => {
      const subcommand = subcommandOf(invocation)

      if (subcommand === DEV_STATUS_SUBCOMMAND) {
        return replyForStatus(await devBoxStatus(devBoxFor(config)))
      }

      /**
       * NEITHER HALF IS ASSUMED. Discord requires a subcommand on a command
       * declared with them, so this is a payload that is not what this file
       * expects — and the safe reading of a `/dev` we cannot parse is not "the
       * one that restarts the game server".
       */
      if (subcommand !== DEV_START_SUBCOMMAND) return COPY.noSubcommand

      // The channel the admin is standing in, which is where the result goes.
      // Read off the interaction rather than taken as an option, for the reason
      // `/sticky` reads it: a channel option is a thing to mistype.
      const channelId = invocation.channelId

      if (channelId === null || channelId === '') return COPY.noChannel

      const notice = noticeFor()

      // No notice means `installCommands` never put one in place, which is a bot
      // whose client was built without it or a test that did not inject one.
      // Refusing before the deploy is better than a deploy nobody is told about.
      if (notice === null) return COPY.unavailable

      if (starting) return COPY.alreadyStarting

      starting = true

      /**
       * THE WORK OUTLIVES THE REPLY, WHICH IS THE WHOLE POINT OF THIS COMMAND.
       * `launchInFlight` is what makes it visible to the shutdown drain in
       * src/index.ts; a bare `void promise` would be work systemd's SIGTERM
       * interrupts with nobody waiting on it.
       *
       * IT CANNOT REJECT. `startDevBox` returns a result for everything it
       * expects, and the `catch` below is for the two things it does not: a
       * Discord send that fails, and a bug in this file. Either way the journal
       * gets the line, because there is no interaction left to answer on.
       */
      launchInFlight(async () => {
        try {
          const result = await startDevBox(devBoxFor(config))

          await notice.post(
            channelId,
            invocation.userId,
            `<@${invocation.userId}> ${replyForStart(result)}`,
          )
        } catch (error) {
          log('error', 'the dev box start could not be reported', {
            actor: invocation.userId,
            channel: channelId,
            error,
          })
        } finally {
          starting = false
        }
      })

      return COPY.starting
    },
  }
}
