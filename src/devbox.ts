import { DescribeInstancesCommand, EC2Client, StartInstancesCommand } from '@aws-sdk/client-ec2'
import {
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  SendCommandCommand,
  SSMClient,
} from '@aws-sdk/client-ssm'

import { log } from './log.ts'

/**
 * The dev game box: starting it, and reading what came up on it.
 *
 * WHY THIS IS AWS AND NOT THE CONSOLE. `/drain` asks Ringmaster to deploy a box
 * that is already running (src/ringmaster.ts). Nothing in this system can start
 * a box that is switched off: the console lives on the PROD box and has no reach
 * into EC2, and the dev box cannot be asked anything at all while it is stopped.
 * So this file talks to EC2 and SSM directly, which is the only route there is.
 *
 * ═══ ONE INSTANCE, AND IT IS HANDED IN RATHER THAN NAMED HERE ═══
 *
 * THERE IS NO INSTANCE ID IN THIS FILE. `instanceId` arrives on {@link
 * DevBoxDeps} from `config.devInstanceId`, whose default is the DEV box and
 * whose whole point is that one value is spelled once. That is not tidiness: the
 * prod game box is one character different in the middle of seventeen hex
 * digits, every call below would work perfectly well against it, and what
 * `systemctl start royale-deploy` does to a box with players on it is end every
 * match on it. A file that cannot name an instance cannot name the wrong one.
 *
 * NO STOP, NO TERMINATE, AND NO SECOND SSM DOCUMENT. The bot's instance role is
 * getting `ec2:StartInstances` and `ssm:SendCommand` scoped to `Env=dev` plus
 * three read calls scoped by region, and nothing else — infradocs
 * `ops/devbox/iam-bot-devbox.json`. Every call this file makes is one of those
 * five, which is what makes the policy readable against the code. The box stops
 * itself after twelve idle hours; that is infradocs#32's job and not this one's.
 *
 * ═══ THE ONE INVOCATION IS THE WHOLE DESIGN ═══
 *
 * `royale-deploy.service` is a `Type=oneshot` that runs `deploy.sh` and ends
 * with `systemctl restart royale`, so `systemctl start royale-deploy` BLOCKS
 * until the sync and the restart are both finished. That is what lets one
 * `AWS-RunShellScript` invocation do the whole job and then report on it, rather
 * than this file polling a stage at a time and guessing when a deploy is done.
 * It has no `[Install]` section on purpose: it is a verb, not a service.
 *
 * AND THE DEPLOY RUNS BEFORE ANYBODY LOOKS AT `royale`. A freshly started dev
 * box may well have the game server stopped (fivem-br-gamemode#325, open and
 * deliberately not in scope here). The sequence below does not care: it runs the
 * deploy, and the deploy's own last act is the restart, so what `systemctl
 * is-active royale` says afterwards is a fact about the deploy rather than about
 * how the box booted.
 *
 * THE SEND IS NEVER RETRIED. The dev patch runbook pins `maxAttempts: 1` on its
 * patch step for this reason and it is the same reason here: a second deploy
 * landing on top of a failed one is worse than a clear failure, because the
 * failure is at least something a person can read. Every POLL is retried, up to
 * a wall clock, because asking again is free.
 *
 * ═══ RESULTS, NEVER THROWS, AND NO CLIENT REACHES THE TESTS ═══
 *
 * Both entry points return a discriminated union in src/ringmaster.ts's shape:
 * one named failure per thing that can actually go wrong, and a `detail` written
 * for whoever has to fix it. The two AWS clients arrive through {@link
 * DevBoxDeps} as {@link Ec2Reach} and {@link SsmReach} — five methods between
 * them — so src/devbox.test.ts builds object literals and no test in this repo
 * has ever needed credentials.
 */

/* ------------------------------------------------------------------ *
 * What the box is asked to do.
 * ------------------------------------------------------------------ */

/** The oneshot that syncs the tree and restarts the game. See the header. */
export const DEPLOY_UNIT = 'royale-deploy'

/** The game server itself, which the oneshot restarts. */
export const GAME_UNIT = 'royale'

/** The deployed tree `deploy.sh` reads the commit out of. */
export const SRC_DIR = '/opt/fivem-server-classic/.gamemode-src'

/** Where the deploy records the branch it is pinned to. */
export const BRANCH_PIN = '/opt/fivem-server-classic/.branch-pin'

/**
 * Who owns the server tree, and therefore who has to run the `git` read.
 *
 * ═══ ROOT CANNOT READ THAT CLONE, AND THE SIBLING REPO PAID FOR THIS ONCE ═══
 *
 * `AWS-RunShellScript` runs as root. `.gamemode-src` is owned by this user, and
 * git refuses a repository whose owner is not the current user: "detected
 * dubious ownership". The commit would come back empty on every single run and
 * the post would say the deploy could not be read, every time, for a deploy that
 * worked perfectly.
 *
 * It is not a guess. `tools/royale-deploy.service` in the gamemode repo says it
 * in its own words: that unit used to run `deploy.sh` as root and "failed two
 * ways at once the day the invariant arrived -- git refuses to touch the
 * ubuntu-owned .gamemode-src clone (\"dubious ownership\")". It runs
 * `runuser -u ubuntu` now, and so does this, for the same reason and against the
 * same tree.
 *
 * NOT `safe.directory`, WHICH WOULD ALSO WORK. Adding an exception to root's
 * global git config would make root able to read a tree it has no business
 * writing, permanently, to save one word here. The invariant at the top of
 * `royale.service` is that everything under the server root belongs to this
 * user; reading it as that user keeps the invariant rather than carving a hole
 * in it.
 *
 * The `|| true` around it still stands: if `runuser` or git fails for any other
 * reason the field comes back empty and the caller says so.
 */
export const SERVER_USER = 'ubuntu'

/**
 * The only SSM document this file uses, and the only one the policy grants.
 *
 * AWS'S OWN, NOT ONE OF OURS. A document of our own would be a thing to keep in
 * step with this repo through a channel nothing here can see, and the shell it
 * would hold is the four lines below.
 */
export const SHELL_DOCUMENT = 'AWS-RunShellScript'

/**
 * The word the shell prints its answer behind.
 *
 * ═══ THE COMMIT IS PARSED OFF A MARKER AND NEVER SCRAPED OUT OF PROSE ═══
 *
 * A deploy that failed still prints something, and so does a box that is fine:
 * `deploy.sh` writes to the journal, `systemctl` writes to stderr, and any of
 * it can contain a short hex string that looks exactly like a commit. So the
 * shell states the three facts itself, in one line, in `key=value` form, and
 * {@link readMarker} reads that line or reports that there was none. Nothing
 * below ever reads a number out of free text.
 *
 * `key=value` RATHER THAN THREE POSITIONAL FIELDS, because a field that comes
 * back empty has to be visible as empty. Positional fields collapse — two
 * spaces where a value should be — and a parser splitting on whitespace then
 * reads the branch as the commit and reports a deploy that never happened.
 */
export const MARKER = 'blitz-devbox'

/**
 * The shell, in the order it runs.
 *
 * `set -eu` SO A FAILED DEPLOY IS A FAILED INVOCATION. If `systemctl start
 * royale-deploy` exits non-zero the script stops there, SSM reports `Failed`,
 * and no marker is printed — which is exactly right: a commit read after a
 * deploy that did not finish would be the commit of the tree it failed to
 * update. The three reads below are each guarded with `|| true` so that a
 * missing file or a stopped unit becomes an empty field rather than a script
 * that dies before it can say anything.
 *
 * `>/dev/null` ON THE DEPLOY, AND ONLY THERE. SSM returns the first 2500
 * characters of stdout, so a chatty deploy could push the marker off the end of
 * the only place the commit comes from. Its stderr is left alone: that is what
 * `detail` quotes when the invocation fails, and it goes to a field of its own.
 *
 * `is-active` IS READ AFTER THE DEPLOY AND NOT INSTEAD OF IT. It answers
 * `active`, `inactive`, `failed` or `activating`, and the caller reports that
 * word rather than turning it into a boolean — "royale is failed" and "royale is
 * activating" are different things to know.
 */
export function deployScript(): readonly string[] {
  return script(true)
}

/** The same reading with no deploy in front of it. `/dev status` sends this. */
export function reportScript(): readonly string[] {
  return script(false)
}

/**
 * POSIX AND NOTHING MORE. `AWS-RunShellScript` has run these lines under `sh` as
 * well as under `bash` depending on the agent, so there is no `pipefail`, no
 * `[[` and no array here — `set -eu`, `$( )`, `||` and `printf` are in both.
 *
 * `git -C … rev-parse --short HEAD` IS EXACTLY WHAT `deploy.sh` COMPUTES, so the
 * commit this reports is the deploy's own answer rather than a second opinion
 * about the same tree. It is wrapped in `runuser` for the reason written above
 * {@link SERVER_USER}: root cannot read that clone at all. If the read still
 * fails for some other reason the field comes back empty and the caller says the
 * deploy ran and could not be read, which is true.
 */
function script(deploy: boolean): readonly string[] {
  return [
    'set -eu',
    ...(deploy ? [`systemctl start ${DEPLOY_UNIT} >/dev/null`] : []),
    `royale=$(systemctl is-active ${GAME_UNIT} || true)`,
    `commit=$(runuser -u ${SERVER_USER} -- git -C ${SRC_DIR} rev-parse --short HEAD || true)`,
    `branch=$(cat ${BRANCH_PIN} || true)`,
    `printf '${MARKER} royale=%s commit=%s branch=%s\\n' "$royale" "$commit" "$branch"`,
  ]
}

/* ------------------------------------------------------------------ *
 * Clocks.
 * ------------------------------------------------------------------ */

/**
 * How long each stage may take before it is a failure rather than a wait.
 *
 * FOUR WALLS BECAUSE THERE ARE FOUR DIFFERENT WAITS, and each one is generous
 * in the direction that costs least. A start that gives up early leaves the box
 * running with nobody told; a start that waits too long is somebody watching a
 * channel for another minute.
 *
 * `RUNNING` — EC2 reaching `running` is a control-plane move and is usually
 * under thirty seconds.
 *
 * `AGENT` — the SSM agent registering after that is the slowest stage on a cold
 * box: the instance is `running` the moment the hypervisor says so, and the
 * agent cannot check in until the OS, the network and the service are all up.
 *
 * `DEPLOY` — `deploy.sh` plus a `royale` restart. Ten minutes is far more than
 * it takes and is still comfortably inside SSM's own hour-long default for the
 * document, so the invocation's own timeout is never the thing that fires.
 *
 * `REPORT` — three reads on a box whose agent is already online. Short on
 * purpose: `/dev status` answers through the interaction, so it is the one call
 * here with a person waiting on a spinner.
 *
 * NONE OF THIS IS MEASURED AGAINST DISCORD'S FIFTEEN MINUTES, and that is the
 * point of the command posting its result to a channel instead of editing its
 * reply. See src/commands/dev.ts.
 */
export const RUNNING_WAIT_MS = 180_000
export const AGENT_WAIT_MS = 300_000
export const DEPLOY_WAIT_MS = 600_000
export const REPORT_WAIT_MS = 60_000

/** How long between two asks of the same question. */
export const POLL_MS = 5_000

/** The state an instance has to reach, and the one that means it is on its way. */
const RUNNING = 'running'
const PENDING = 'pending'

/** The one `PingStatus` that means SSM can be asked to run something. */
const ONLINE = 'Online'

/**
 * The invocation statuses that are an end rather than a stage.
 *
 * SSM'S OWN WORDS. `Pending`, `InProgress` and `Delayed` are the ones that are
 * still going; anything else is over, and only `Success` is over well.
 */
const FINISHED = new Set(['Success', 'Failed', 'Cancelled', 'TimedOut'])
const SUCCESS = 'Success'

/* ------------------------------------------------------------------ *
 * The seam.
 * ------------------------------------------------------------------ */

/** One instance, reduced to the one thing this file reads off it. */
export interface InstanceLook {
  /** `running`, `pending`, `stopped`, … or null when AWS named no state. */
  readonly state: string | null
}

/** One invocation, reduced to what a report is read out of. */
export interface CommandLook {
  /** SSM's own status word. See {@link FINISHED}. */
  readonly status: string
  readonly stdout: string
  readonly stderr: string
}

/**
 * The two EC2 calls.
 *
 * TWO METHODS AND NOT AN `EC2Client`, for the reason src/ddb.ts's
 * `DocumentClient` is four: this is the module's whole reach into EC2, so the
 * `stop` and `terminate` that are not here are calls no later edit can make
 * without widening this interface and saying why in the diff.
 */
export interface Ec2Reach {
  /** The instance, or null when the region holds no such instance. */
  describe(instanceId: string): Promise<InstanceLook | null>

  /** Switch it on. Answers nothing: the poll that follows is the answer. */
  start(instanceId: string): Promise<void>
}

/** The three SSM calls, under `Ec2Reach`'s rule. */
export interface SsmReach {
  /** The agent's `PingStatus`, or null when it has never registered. */
  ping(instanceId: string): Promise<string | null>

  /** One `AWS-RunShellScript` invocation. Answers the command id. */
  send(instanceId: string, commands: readonly string[]): Promise<string>

  /** How that invocation is getting on, or null when SSM has not got it yet. */
  invocation(instanceId: string, commandId: string): Promise<CommandLook | null>
}

/** Everything the two entry points do to the outside world, and their clocks. */
export interface DevBoxDeps {
  /**
   * The instance to act on. THE ONLY PLACE AN INSTANCE IS NAMED — see the
   * header for why this file has no default and no literal.
   */
  readonly instanceId: string

  readonly ec2: Ec2Reach
  readonly ssm: SsmReach

  /** The clock, so a wall can be reached in a test without waiting for one. */
  readonly now?: () => number

  /** The wait between polls, so a test can make it nothing. */
  readonly sleep?: (ms: number) => Promise<void>

  readonly pollMs?: number
  readonly runningWaitMs?: number
  readonly agentWaitMs?: number
  readonly deployWaitMs?: number
  readonly reportWaitMs?: number
}

/* ------------------------------------------------------------------ *
 * The live clients.
 * ------------------------------------------------------------------ */

/**
 * THE REGION IS PASSED EXPLICITLY AND IS NEVER INHERITED, which is src/ddb.ts's
 * `DEFAULT_REGION` argument applied to a second pair of clients: left unset the
 * SDK takes the region of the BOX, the bot's box and the game box are not
 * required to be in the same one, and the failure that produces is an instance
 * id that "does not exist" while you are looking at it in another tab.
 *
 * TWO SSM CLIENTS, AND THAT IS THE NO-RETRY RULE MADE REAL. `maxAttempts` is a
 * client setting rather than a per-call one, and the send must have exactly one
 * attempt while the polls want the SDK's own retry for a throttle. One client
 * cannot be both, so there are two, and the one that can start a deploy is the
 * one that cannot try twice.
 */
export function createDevBoxReach(region: string): { ec2: Ec2Reach; ssm: SsmReach } {
  const ec2 = new EC2Client({ region, maxAttempts: 2 })
  const reads = new SSMClient({ region, maxAttempts: 2 })
  const sends = new SSMClient({ region, maxAttempts: 1 })

  return {
    ec2: {
      async describe(instanceId) {
        const answer = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
        const instance = answer.Reservations?.[0]?.Instances?.[0]

        // An empty answer rather than an exception is not a shape AWS documents,
        // and reading a state off it would be reading one off `undefined`.
        if (instance === undefined) return null

        return { state: instance.State?.Name ?? null }
      },

      async start(instanceId) {
        await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }))
      },
    },

    ssm: {
      async ping(instanceId) {
        const answer = await reads.send(
          new DescribeInstanceInformationCommand({
            Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
          }),
        )

        return answer.InstanceInformationList?.[0]?.PingStatus ?? null
      },

      async send(instanceId, commands) {
        const answer = await sends.send(
          new SendCommandCommand({
            InstanceIds: [instanceId],
            DocumentName: SHELL_DOCUMENT,
            Parameters: { commands: [...commands] },
          }),
        )

        const id = answer.Command?.CommandId

        // The command id is how a person looks this up afterwards, so an answer
        // without one is a failure rather than a value to carry as undefined.
        if (id === undefined || id === '') throw new Error('SSM accepted the command but named no id')

        return id
      },

      async invocation(instanceId, commandId) {
        const answer = await reads.send(
          new GetCommandInvocationCommand({ InstanceId: instanceId, CommandId: commandId }),
        )

        return {
          status: answer.Status ?? '',
          stdout: answer.StandardOutputContent ?? '',
          stderr: answer.StandardErrorContent ?? '',
        }
      },
    },
  }
}

/* ------------------------------------------------------------------ *
 * Failures.
 * ------------------------------------------------------------------ */

/**
 * Why nothing came back, in words that each mean a different next action.
 *
 * `denied` — AWS REFUSED THE CALL. On day one this is the likeliest failure
 *   there is: the policy in infradocs `ops/devbox/iam-bot-devbox.json` is not
 *   attached to the bot's instance role yet, so `ssm:SendCommand` comes back
 *   `AccessDeniedException` and EC2 comes back `UnauthorizedOperation`. An
 *   operator fixes it and no amount of trying will.
 *
 * `credentials` — THERE IS NO IDENTITY AT ALL. The SDK found no instance role
 *   and no keys. Kept apart from `denied` for src/ddb.ts's reason: "the role is
 *   missing a permission" and "the process has no role" are two different
 *   afternoons.
 *
 * `no-such-instance` — THE ID NAMES NOTHING IN THIS REGION. A wrong
 *   `BLITZ_DEV_INSTANCE_ID`, or the right one with the wrong
 *   `BLITZ_DEV_REGION`.
 *
 * `unstartable` — EC2 WILL NOT START IT FROM THE STATE IT IS IN. A box that is
 *   mid-`stopping`, or one that has been terminated. Nothing here can fix
 *   either: this file has no stop and no run-instances, on purpose.
 *
 * `not-running` — IT NEVER REACHED `running` INSIDE THE WALL. The start was
 *   accepted; the box is on its way or stuck, and the next `/dev start` picks up
 *   wherever it got to.
 *
 * `agent-offline` — IT IS RUNNING AND SSM CANNOT SEE IT. Either the agent is
 *   still coming up, or the box has lost the route to SSM that the agent needs.
 *   The deploy was never sent, which is the important half.
 *
 * `command-failed` — THE INVOCATION RAN AND ENDED BADLY. `deploy.sh` failed,
 *   or SSM cancelled or timed out the command. The script prints no marker on
 *   this path deliberately: see {@link deployScript}.
 *
 * `command-unfinished` — IT WAS STILL RUNNING WHEN THE WALL CAME UP. Nothing is
 *   known to have failed, and nothing is known to have worked, which is why it
 *   is not folded into either neighbour. The command id is the only way to find
 *   out and it is carried.
 *
 * `unreadable` — IT SUCCEEDED AND ITS ANSWER COULD NOT BE READ. No marker line,
 *   or one with an empty field in it. The deploy RAN, so this must never be
 *   reported as a deploy that did not happen.
 *
 * `error` — SOMETHING NOBODY HERE HAS SEEN. The SDK's own message travels in
 *   `detail`, which is the honest answer for a failure this file cannot name.
 */
export type DevBoxFailure =
  | 'denied'
  | 'credentials'
  | 'no-such-instance'
  | 'unstartable'
  | 'not-running'
  | 'agent-offline'
  | 'command-failed'
  | 'command-unfinished'
  | 'unreadable'
  | 'error'

/** A failure, shared by both entry points. */
export interface DevBoxRefused {
  outcome: 'failed'
  failure: DevBoxFailure
  /**
   * What went wrong, for whoever has to act on it. Operator-facing: it carries
   * AWS's own message, an instance state or a wall in seconds, and the command
   * file decides what an admin is shown. See src/commands/dev.ts's `COPY`.
   */
  detail: string
  /** The SSM command id, once there is one. Null before the send. */
  commandId: string | null
}

/**
 * What one `/dev start` came to.
 *
 * `deployed` IS A DONE AND NOT AN ACKNOWLEDGEMENT, for src/ringmaster.ts's
 * `scheduled` reason and more strongly: the oneshot blocked, so by the time this
 * is returned the tree is synced and `royale` has been restarted. The commit is
 * read off the deployed tree afterwards, which is the only reading of it that is
 * worth stating to a person.
 *
 * `royale` IS CARRIED AS SSM'S WORD RATHER THAN AS A BOOLEAN. A deploy that
 * finished over a game server that came back `failed` is a real outcome and a
 * different sentence from one that came back `active`.
 */
export type DevBoxStart =
  | {
      outcome: 'deployed'
      royale: string
      commit: string
      branch: string
      commandId: string
    }
  | DevBoxRefused

/**
 * What one `/dev status` found. READ-ONLY: nothing on this path starts an
 * instance or a deploy.
 *
 * THE THREE FROM THE BOX ARE NULLABLE AND THE INSTANCE STATE IS NOT. A stopped
 * box has a state and nothing else — no agent to ask, no `royale` to read — and
 * that is an answer rather than a failure. Every field below is either a fact or
 * an absence somebody can be told about in words.
 */
export type DevBoxStatus =
  | {
      outcome: 'read'
      state: string
      /** The agent's `PingStatus`, or null when it has never registered. */
      agent: string | null
      /** The three from the box, or null when it was not in a state to be asked. */
      royale: string | null
      commit: string | null
      branch: string | null
      commandId: string | null
    }
  | DevBoxRefused

/**
 * How loudly a failure is journaled, on src/ringmaster.ts's `levelFor` rule.
 *
 * THE THREE THAT NEED A PERSON ARE `error` AND THE REST ARE `warn`. A denial, a
 * missing identity and an id that names nothing are all configuration, and
 * `/dev` will look broken to every admin who tries it until somebody acts. A box
 * that was slow, an agent that had not checked in and a deploy that failed are
 * worth a line and not an alarm; the admin has already been told in Discord.
 */
function levelFor(failure: DevBoxFailure): 'warn' | 'error' {
  return failure === 'denied' || failure === 'credentials' || failure === 'no-such-instance'
    ? 'error'
    : 'warn'
}

/**
 * The AWS exception names this file has an answer for, matched EXACTLY and
 * never by substring, on src/ddb.ts's `FAILURE_KINDS` rule: an error whose
 * message happens to contain "denied" is not a denial, and a guess sends an
 * operator to the IAM console over a dropped packet.
 *
 * EC2 AND SSM SPELL THE SAME REFUSAL DIFFERENTLY, which is why `denied` has
 * four entries. EC2 answers `UnauthorizedOperation` for a call the policy does
 * not allow; SSM answers `AccessDeniedException`.
 *
 * `not-yet` IS NOT A FAILURE AND IS THE REASON THIS MAP IS NOT `DevBoxFailure`.
 * `InvocationDoesNotExist` is what SSM says in the seconds between accepting a
 * command and having an invocation to report on it, and a throttle is a request
 * to ask again — both are ordinary inside a poll loop and neither is an outcome.
 * See {@link refuse} for what happens if one escapes one.
 */
const TROUBLES: Record<string, DevBoxFailure | 'not-yet'> = {
  AccessDeniedException: 'denied',
  AccessDenied: 'denied',
  UnauthorizedOperation: 'denied',
  UnrecognizedClientException: 'denied',
  CredentialsProviderError: 'credentials',
  CredentialsError: 'credentials',
  'InvalidInstanceID.NotFound': 'no-such-instance',
  'InvalidInstanceID.Malformed': 'no-such-instance',
  InvalidInstanceID: 'no-such-instance',
  InvalidInstanceId: 'no-such-instance',
  IncorrectInstanceState: 'unstartable',
  InvocationDoesNotExist: 'not-yet',
  ThrottlingException: 'not-yet',
  RequestLimitExceeded: 'not-yet',
}

/** How much of a borrowed message is carried. */
const DETAIL_CAP = 300

/**
 * One line of somebody else's text, cut to a budget.
 *
 * FLATTENED BECAUSE THE DETAIL ENDS UP IN A DISCORD MESSAGE. `deploy.sh`'s
 * stderr is many lines and an SDK message can be one long one; a reply that is
 * one paragraph is this repo's rule three times over, and a newline out of a
 * borrowed string is the way that rule gets broken by something nobody typed.
 *
 * CUT ON CODE POINTS so a slice cannot leave half a character behind.
 */
function flat(text: string): string {
  const one = text.replace(/\s+/gu, ' ').trim()
  const points = [...one]

  return points.length <= DETAIL_CAP ? one : `${points.slice(0, DETAIL_CAP).join('')}…`
}

/** What one AWS call came to, before anybody has decided what it means. */
type Attempted<T> =
  | { ok: true; value: T }
  | { ok: false; trouble: DevBoxFailure | 'not-yet'; detail: string }

/**
 * One call, with its exception turned into a value.
 *
 * `what` IS THE API'S OWN NAME — `SendCommand`, `DescribeInstances` — because
 * that is the word an operator searches CloudTrail and an IAM policy for. The
 * message that follows it is AWS's, unedited but flattened.
 */
async function attempt<T>(what: string, call: () => Promise<T>): Promise<Attempted<T>> {
  try {
    return { ok: true, value: await call() }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : String(error)

    return { ok: false, trouble: TROUBLES[name] ?? 'error', detail: `${what}: ${flat(message)}` }
  }
}

/**
 * A failed attempt as an outcome.
 *
 * `not-yet` BECOMES `error` HERE AND THAT IS THE HONEST END OF IT. A throttle or
 * a missing invocation is a thing to ask again about, and every place that can
 * raise one asks again until its wall — so reaching this function with one means
 * the wall is gone or the call was the send, and the send is never retried. The
 * detail still carries AWS's own word, so what actually happened is readable.
 */
function refuse(
  attempted: { trouble: DevBoxFailure | 'not-yet'; detail: string },
  commandId: string | null,
): DevBoxRefused {
  return {
    outcome: 'failed',
    failure: attempted.trouble === 'not-yet' ? 'error' : attempted.trouble,
    detail: attempted.detail,
    commandId,
  }
}

function failed(
  failure: DevBoxFailure,
  detail: string,
  commandId: string | null = null,
): DevBoxRefused {
  return { outcome: 'failed', failure, detail, commandId }
}

/* ------------------------------------------------------------------ *
 * Reading the box's answer.
 * ------------------------------------------------------------------ */

/** The three facts the shell states, each absent rather than guessed. */
export interface Marked {
  readonly royale: string | null
  readonly commit: string | null
  readonly branch: string | null
}

/**
 * The marker line out of one invocation's stdout, or null when there was none.
 *
 * THE LAST MATCHING LINE WINS. The marker is printed once, at the end, and
 * taking the last one means an earlier line that happens to quote the word — a
 * deploy that echoed the command it was given — cannot be read as the answer.
 *
 * AN EMPTY FIELD IS AN ABSENT FIELD, NOT AN EMPTY STRING. `commit=` is what the
 * shell prints when `git rev-parse` failed, and a caller that took it at face
 * value would report a deploy "on " with nothing after it.
 */
export function readMarker(stdout: string): Marked | null {
  const line = stdout
    .split(/\r?\n/u)
    .map((one) => one.trim())
    .filter((one) => one.startsWith(`${MARKER} `))
    .at(-1)

  if (line === undefined) return null

  const fields = new Map<string, string>()

  for (const token of line.slice(MARKER.length).trim().split(/\s+/u)) {
    const at = token.indexOf('=')
    if (at > 0) fields.set(token.slice(0, at), token.slice(at + 1))
  }

  const field = (key: string): string | null => {
    const value = fields.get(key)
    return value === undefined || value === '' ? null : value
  }

  return { royale: field('royale'), commit: field('commit'), branch: field('branch') }
}

/* ------------------------------------------------------------------ *
 * The two sequences.
 * ------------------------------------------------------------------ */

/** A pause that is not a busy wait, and that a test replaces with nothing. */
function pause(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms))
}

/** The clocks and the two reaches, resolved once per call. */
interface Run {
  readonly instanceId: string
  readonly ec2: Ec2Reach
  readonly ssm: SsmReach
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly pollMs: number
}

function runFor(deps: DevBoxDeps): Run {
  return {
    instanceId: deps.instanceId,
    ec2: deps.ec2,
    ssm: deps.ssm,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? pause,
    pollMs: deps.pollMs ?? POLL_MS,
  }
}

/** One second, as a whole number, for a sentence a person reads. */
function seconds(ms: number): string {
  return `${String(Math.round(ms / 1000))}s`
}

/**
 * The id names nothing here, said once.
 *
 * ONE SENTENCE FOR BOTH READERS — the first look and the poll after a start —
 * because two spellings of the same failure are two things for an operator to
 * search for. NAMING THE ID BACK is what makes it actionable: it came from
 * `BLITZ_DEV_INSTANCE_ID`, and the fix is in that line or in the region beside it.
 */
function noInstance(run: Run): DevBoxRefused {
  return failed('no-such-instance', `DescribeInstances: ${run.instanceId} is not in this region`)
}

/**
 * The instance's state, or the refusal that stopped us reading it.
 *
 * A NULL INSTANCE IS `no-such-instance` AND NOT AN EMPTY ANSWER PASSED ALONG.
 */
async function stateOf(
  run: Run,
): Promise<{ outcome: 'ok'; state: string | null } | DevBoxRefused> {
  const seen = await attempt('DescribeInstances', () => run.ec2.describe(run.instanceId))

  if (!seen.ok) return refuse(seen, null)

  if (seen.value === null) return noInstance(run)

  return { outcome: 'ok', state: seen.value.state }
}

/**
 * Wait until the instance is `running`.
 *
 * BOUNDED BY A WALL CLOCK AND NOT BY AN ATTEMPT COUNT, so a slow control plane
 * and a fast one are the same promise to whoever is waiting. The state is read
 * BEFORE the clock is consulted, so a box that is already there costs one call
 * and no sleep.
 *
 * A TRANSIENT READ FAILURE IS TOLERATED UNTIL THE WALL and a denial is not: a
 * throttle comes back `not-yet` and the loop asks again, while an
 * `UnauthorizedOperation` ends it immediately — there is no version of waiting
 * that grants a permission.
 */
async function untilRunning(run: Run, waitMs: number): Promise<DevBoxRefused | null> {
  const deadline = run.now() + waitMs
  let last = 'unknown'

  for (;;) {
    const seen = await attempt('DescribeInstances', () => run.ec2.describe(run.instanceId))

    if (seen.ok) {
      if (seen.value === null) return noInstance(run)
      if (seen.value.state === RUNNING) return null

      last = seen.value.state ?? 'unknown'
    } else if (seen.trouble !== 'not-yet') {
      return refuse(seen, null)
    } else {
      last = seen.detail
    }

    if (run.now() >= deadline) {
      return failed('not-running', `the instance was still ${last} after ${seconds(waitMs)}`)
    }

    await run.sleep(run.pollMs)
  }
}

/**
 * Wait until the SSM agent reports `Online`.
 *
 * NULL IS NOT A STATE, IT IS SILENCE. An agent that has never registered is
 * absent from `DescribeInstanceInformation` entirely, which on a box that is
 * still booting is the ordinary case rather than a fault — so it is waited on
 * exactly like `ConnectionLost`, and only the wall decides it has gone on too
 * long.
 */
async function untilOnline(run: Run, waitMs: number): Promise<DevBoxRefused | null> {
  const deadline = run.now() + waitMs
  let last = 'not registered'

  for (;;) {
    const seen = await attempt('DescribeInstanceInformation', () => run.ssm.ping(run.instanceId))

    if (seen.ok) {
      if (seen.value === ONLINE) return null
      last = seen.value ?? 'not registered'
    } else if (seen.trouble !== 'not-yet') {
      return refuse(seen, null)
    } else {
      last = seen.detail
    }

    if (run.now() >= deadline) {
      return failed('agent-offline', `the SSM agent was ${last} after ${seconds(waitMs)}`)
    }

    await run.sleep(run.pollMs)
  }
}

/**
 * The three facts, once every one of them has been read.
 *
 * `Marked` WITH NOTHING NULLABLE LEFT, which is why it is a second type rather
 * than a cast. {@link ran} refuses a marker with an empty field, so the callers
 * below get strings and no branch of theirs has to re-ask a question that has
 * already been answered in one place.
 */
export interface Reported {
  readonly royale: string
  readonly commit: string
  readonly branch: string
}

/** One invocation that finished, and what it printed. */
interface Ran {
  outcome: 'ok'
  readonly commandId: string
  readonly report: Reported
}

/**
 * Send one script, wait for it to finish, and read its marker.
 *
 * ONE SEND, NEVER TWO. There is no retry around the send in this function and
 * there must not be one above it either: see the header. Everything after the
 * send is a poll, because asking how a command is getting on cannot start a
 * second deploy.
 *
 * AN INVOCATION THAT IS NOT THERE YET IS A STAGE AND NOT A FAILURE. SSM answers
 * `InvocationDoesNotExist` for the moments between accepting a command and
 * having something to report about it, which arrives here as `not-yet`.
 *
 * A SUCCESSFUL COMMAND WITH NO MARKER IS `unreadable` AND CARRIES THE COMMAND
 * ID. The deploy ran; only the reading of it failed, and the id is how a person
 * finds out what it did.
 */
async function ran(run: Run, commands: readonly string[], waitMs: number): Promise<Ran | DevBoxRefused> {
  const sent = await attempt('SendCommand', () => run.ssm.send(run.instanceId, commands))

  if (!sent.ok) return refuse(sent, null)

  const commandId = sent.value
  const deadline = run.now() + waitMs
  let last = 'Pending'

  for (;;) {
    const seen = await attempt('GetCommandInvocation', () =>
      run.ssm.invocation(run.instanceId, commandId),
    )

    if (seen.ok && seen.value !== null && FINISHED.has(seen.value.status)) {
      const look = seen.value

      if (look.status !== SUCCESS) {
        const said = flat(look.stderr === '' ? look.stdout : look.stderr)

        return failed(
          'command-failed',
          said === '' ? `the command ended ${look.status}` : `the command ended ${look.status}: ${said}`,
          commandId,
        )
      }

      const marked = readMarker(look.stdout)

      if (
        marked === null ||
        marked.royale === null ||
        marked.commit === null ||
        marked.branch === null
      ) {
        return failed('unreadable', 'the command printed no readable result line', commandId)
      }

      return {
        outcome: 'ok',
        commandId,
        report: { royale: marked.royale, commit: marked.commit, branch: marked.branch },
      }
    }

    if (seen.ok) last = seen.value === null ? 'Pending' : seen.value.status
    else if (seen.trouble !== 'not-yet') return refuse(seen, commandId)

    if (run.now() >= deadline) {
      return failed('command-unfinished', `the command was still ${last} after ${seconds(waitMs)}`, commandId)
    }

    await run.sleep(run.pollMs)
  }
}

/**
 * Start the dev box, deploy the latest dev commit onto it, and say which commit
 * that was.
 *
 * THE ORDER IS THE POINT AND IT IS THE ISSUE'S OWN. Describe, start only if it
 * is neither `running` nor `pending`, wait for `running`, wait for the agent,
 * then ONE invocation that deploys and reports. Nothing here checks whether
 * `royale` was up first: the deploy restarts it, so the only reading of it worth
 * having is the one taken afterwards.
 *
 * AN ALREADY-RUNNING BOX IS NOT STARTED AGAIN, and that is not an optimisation:
 * `StartInstances` on a running instance is a call the policy allows and an
 * `/dev start` that made it would be a request nobody asked for. A `pending` box
 * is somebody else's start, seconds old, and is waited on rather than nudged.
 */
export async function startDevBox(deps: DevBoxDeps): Promise<DevBoxStart> {
  const run = runFor(deps)
  const result = await starting(run, deps)

  if (result.outcome === 'deployed') {
    /*
     * INFO, NOT WARN, FOR src/ringmaster.ts's REASON: `log()` copies every
     * non-info line into #bot-status, and this is the success branch of a
     * command an admin has just run on purpose. The journal keeps the record of
     * which commit the dev box came up on; Discord already has the notice.
     */
    log('info', 'the dev box was started and the dev branch was deployed onto it', {
      instance: run.instanceId,
      commit: result.commit,
      branch: result.branch,
      royale: result.royale,
      command: result.commandId,
    })
  } else {
    log(levelFor(result.failure), 'the dev box did not come up', {
      instance: run.instanceId,
      failure: result.failure,
      detail: result.detail,
      command: result.commandId,
    })
  }

  return result
}

async function starting(run: Run, deps: DevBoxDeps): Promise<DevBoxStart> {
  const state = await stateOf(run)

  if (state.outcome === 'failed') return state

  /**
   * A BOX THAT IS ALREADY `running` COSTS ONE CALL AND NO WAIT, which is the
   * ordinary case for a second `/dev start` in an afternoon. `pending` is
   * somebody else's start, seconds old, so it is waited on rather than nudged —
   * and everything else is started and then waited on.
   */
  if (state.state !== RUNNING) {
    if (state.state !== PENDING) {
      const started = await attempt('StartInstances', () => run.ec2.start(run.instanceId))
      if (!started.ok) return refuse(started, null)
    }

    const running = await untilRunning(run, deps.runningWaitMs ?? RUNNING_WAIT_MS)
    if (running !== null) return running
  }

  const online = await untilOnline(run, deps.agentWaitMs ?? AGENT_WAIT_MS)
  if (online !== null) return online

  const done = await ran(run, deployScript(), deps.deployWaitMs ?? DEPLOY_WAIT_MS)
  if (done.outcome === 'failed') return done

  return {
    outcome: 'deployed',
    royale: done.report.royale,
    commit: done.report.commit,
    branch: done.report.branch,
    commandId: done.commandId,
  }
}

/**
 * Report on the dev box and change nothing.
 *
 * IT STOPS AT WHATEVER IT FINDS. A stopped box is answered with its state and
 * three absences; a running box whose agent is not `Online` is answered with
 * both of those and no reading from inside. Neither is a failure, because the
 * question was what state things are in — and a `/dev status` that waited five
 * minutes for an agent, on a box nobody asked to start, would be a start
 * command wearing a read command's name.
 *
 * ONE INVOCATION, WITH NO DEPLOY IN IT. {@link reportScript} is
 * {@link deployScript} minus its first line, which is the whole difference
 * between this and `/dev start`.
 */
export async function devBoxStatus(deps: DevBoxDeps): Promise<DevBoxStatus> {
  const run = runFor(deps)
  const result = await reading(run, deps)

  if (result.outcome === 'read') {
    log('info', 'the dev box was asked how it is', {
      instance: run.instanceId,
      state: result.state,
      agent: result.agent,
      royale: result.royale,
      commit: result.commit,
    })
  } else {
    log(levelFor(result.failure), 'the dev box could not be read', {
      instance: run.instanceId,
      failure: result.failure,
      detail: result.detail,
      command: result.commandId,
    })
  }

  return result
}

async function reading(run: Run, deps: DevBoxDeps): Promise<DevBoxStatus> {
  const state = await stateOf(run)

  if (state.outcome === 'failed') return state

  const found = state.state ?? 'unknown'
  const stopped: DevBoxStatus = {
    outcome: 'read',
    state: found,
    agent: null,
    royale: null,
    commit: null,
    branch: null,
    commandId: null,
  }

  if (found !== RUNNING) return stopped

  const ping = await attempt('DescribeInstanceInformation', () => run.ssm.ping(run.instanceId))

  if (!ping.ok) return refuse(ping, null)
  if (ping.value !== ONLINE) return { ...stopped, agent: ping.value }

  const done = await ran(run, reportScript(), deps.reportWaitMs ?? REPORT_WAIT_MS)
  if (done.outcome === 'failed') return done

  return {
    outcome: 'read',
    state: found,
    agent: ping.value,
    royale: done.report.royale,
    commit: done.report.commit,
    branch: done.report.branch,
    commandId: done.commandId,
  }
}
