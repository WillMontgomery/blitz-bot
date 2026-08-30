import { log } from './log.ts'

/**
 * The live kick, relayed through the Ringmaster console.
 *
 * WHY THE BOT CANNOT DO THIS ITSELF. Removing somebody from a running match is
 * `tmux send-keys` into the FXServer console over SSH, and the key that opens
 * that channel is on the console's box and belongs to the console
 * (fivem-ringmaster/src/lib/ssh.ts). A second holder of that key would be a
 * second, quieter implementation of the most dangerous thing in the system. So
 * the bot asks, and everything the console checks it still checks — the closed
 * case, the SSH configuration, the role gate on the human being attributed. The
 * console's `lib/service.ts` is the door and says so at length.
 *
 * ═══ THE STANDING RULE: THE BOT MUST NEVER DEPEND ON THE CONSOLE BEING UP ═══
 *
 * docs/deploy.md makes this a property of the two units — no `Requires=`, no
 * `After=`, either may be down and the other will not notice — and this file is
 * where that rule survives contact with a feature that genuinely wants the other
 * service. The split it rests on:
 *
 *   THE BAN ROW IS DURABLE THE MOMENT IT IS WRITTEN, straight to DynamoDB, and
 *   nothing here is between the bot and that write. A ban survives the console
 *   being down, being redeployed, or never having existed.
 *
 *   ONLY THE LIVE KICK NEEDS THE CONSOLE, and a live kick is by nature a thing
 *   that stops being worth doing. So this retries, and then it gives up, and
 *   giving up is a first-class outcome rather than an error.
 *
 * ═══ AND THE GIVING UP IS THE PART WORTH READING ═══
 *
 * "No answer in a few seconds, back off a minute and retry" is the owner's
 * instruction, and it comes with two limits that are not optional:
 *
 *   IT STOPS. {@link KICK_ATTEMPTS} bounds the number of requests, so a console
 *   that is down for a week does not leave one timer per ban running until the
 *   bot is restarted.
 *
 *   IT DROPS A STALE KICK RATHER THAN DELIVERING IT, which is the more
 *   important of the two and is the owner's own example: a kick queued at 21:00
 *   and delivered at 21:40 lands on a different session than the one it was
 *   aimed at — very likely a different match, possibly a player who reconnected
 *   and has done nothing since. A late kick is not a slow kick, it is the wrong
 *   kick. {@link KICK_TTL_MS} is measured from WHEN THE MODERATOR ACTED, not
 *   from when this function was called, so a kick that spent four minutes queued
 *   behind something else inherits the age it really has.
 *
 * ═══ WHAT IT REPORTS, AND WHY IT IS NOT "SENT" ═══
 *
 * The console answers `done`/`failed` rather than `acknowledged`, which was the
 * owner's second comment on fivem-ringmaster#42 and the reason
 * `lib/commandOutcome.ts` exists over there. This file keeps that vocabulary
 * rather than inventing a parallel one — `dispatched`, `unreachable`, `refused`,
 * `not-configured` are that file's words — because the two halves of one
 * conversation drifting apart is how "the game server refused the kick" came to
 * be printed for a connect timeout.
 *
 * `dispatched` IS STILL NOT `done`, AND THIS FILE MUST NOT SAY IT IS. The
 * console is explicit: nothing in the system reports whether a player was really
 * removed, so `confirmed` is `false` and is a field rather than an omission. The
 * caller reports what it was told.
 *
 * ═══ PURE ENOUGH TO TEST OFFLINE ═══
 *
 * `fetch`, the clock and the sleep are all injected, so every branch below —
 * each refusal, the retry, the two ways of giving up, the per-attempt deadline —
 * is exercised with no network, no console and no wall-clock waiting. Nothing
 * here opens a socket that was not handed to it.
 */

/**
 * The credential header.
 *
 * `x-ringmaster-service`, VERBATIM FROM THE CONSOLE'S `COMMAND_SECRET_HEADER`,
 * and it carries `COMMAND_SECRET`'s value under a name that does not match the
 * variable. That mismatch is deliberate over there and is quoted here so nobody
 * "fixes" it from this side: the string is a deployed contract between two
 * services, and renaming it costs a coordinated release to make a byte on the
 * wire agree with a variable name nobody reading the wire can see.
 */
export const COMMAND_SECRET_HEADER = 'x-ringmaster-service'

/**
 * The Discord id of the human being attributed, from the console's
 * `SERVICE_ACTOR_HEADER`.
 *
 * THE ADMIN WHO CLICKED BAN, NEVER THIS BOT. The audit row the console writes
 * names them — their license, their name, their Discord id — because "which
 * process wrote this" is never what anybody asks an audit log and "who banned
 * them" is. It is also not decoration: the console puts this id through the SAME
 * role gate the browser path runs, so a call carrying nobody is refused before
 * anything is written.
 */
export const SERVICE_ACTOR_HEADER = 'x-ringmaster-actor'

/** The console route. One of three the command credential opens; see `SERVICE_ROUTES`. */
export const KICK_PATH = '/api/kick'

/**
 * How long one request may take before it is a failure instead of a wait.
 *
 * FIFTEEN SECONDS, AND THE NUMBER IS ARITHMETIC RATHER THAN A GUESS. A kick that
 * is working normally spends its time in three places on the far side: the
 * console's Discord role re-check waits up to five seconds (lib/actions.ts says
 * so), the SSH dispatch to the game box has a six-second wall (lib/ssh.ts), and
 * a grants read and the audit write sit around them. So a healthy-but-slow call
 * can legitimately take twelve, and a ceiling under that would abandon kicks
 * that were about to succeed — and then RETRY them, which is how one kick
 * becomes three.
 *
 * IT IS NOT MEASURED AGAINST A DISCORD DEADLINE, unlike src/ddb.ts's two
 * seconds. There is no interaction to answer here: the event that started this
 * was an audit log entry, and nobody is watching a spinner.
 */
export const KICK_TIMEOUT_MS = 15_000

/** "Back off a minute", from the brief, unrounded. */
export const KICK_RETRY_MS = 60_000

/**
 * How old the moderator's action may be and still be worth acting on.
 *
 * FIVE MINUTES, MEASURED FROM THE AUDIT ENTRY. The owner's example is a kick
 * queued at 21:00 and delivered at 21:40, and the answer to "how late is too
 * late" is really "how long until this is a different session" — a Blitz Royale
 * round is minutes, so a kick delivered five minutes after the ban was pressed
 * is already landing somewhere other than where it was aimed. Erring short is
 * the cheap direction: a dropped kick is reported and an admin presses the
 * button again against a live session, while a delivered stale one removes
 * somebody from a match they joined afterwards and nobody ever finds out why.
 *
 * IT IS THE OUTER BOUND AND {@link KICK_ATTEMPTS} IS THE INNER ONE. With a
 * fifteen-second deadline and a minute between tries, five minutes is about four
 * attempts; the count is there so that a clock that jumps backwards — an NTP
 * step on a box that has just booted — cannot turn "until it is stale" into
 * "forever".
 */
export const KICK_TTL_MS = 5 * 60_000

/** The hard stop on requests for one kick. See `KICK_TTL_MS`. */
export const KICK_ATTEMPTS = 5

/**
 * A game license, in exactly the shape the console's `licenseSchema` accepts.
 *
 * COPIED, AND THE COPY IS THE POINT RATHER THAN THE COST. The console answers a
 * malformed license with a 400 and a zod message — a permanent failure this file
 * would then classify, report and never retry, which is the correct handling of
 * a request we should not have sent. Checking here means the caller is told "the
 * game has never seen this person" instead of "the console rejected the kick",
 * and those are two different sentences about two different problems.
 *
 * IF IT CHANGES OVER THERE IT MUST CHANGE HERE. Nothing enforces that, which is
 * why this comment names the file: fivem-ringmaster/src/lib/actions.ts.
 */
export const LICENSE = /^license2?:[0-9a-f]{6,64}$/i

/**
 * What the console can tell us, in the console's own words.
 *
 * THE FIRST THREE ARE `CommandFailure` FROM lib/commandOutcome.ts, UNCHANGED:
 *
 *   `not-configured` — nothing was attempted and nothing was going to be. Either
 *     the game host's SSH channel is unset on the console, or `COMMAND_SECRET`
 *     is unset there. An operator fixes this; a moderator cannot.
 *   `unreachable` — nobody answered, or the answer was not an answer. The
 *     console did not hear from the game box, or we did not hear from the
 *     console. We do not know that anything happened.
 *   `refused` — something answered, structurally, and said no, with a reason
 *     attached. A definite negative.
 *
 * `denied` IS OURS AND COVERS THE DOOR RATHER THAN THE COMMAND. The console's
 * service gate answers `auth`, `scope`, `actor` and `role-revoked` — a stale
 * secret, a route not on the allowlist, a call carrying no human, an admin whose
 * role Discord says is gone. Every one of them means this request will never
 * succeed however many times it is sent, and every one of them is the bot or its
 * configuration being wrong rather than the game server. They are one outcome
 * here because the caller does the same thing with all four; the console's own
 * code travels in `detail`, so the journal still says which.
 *
 * `unknown` IS THE HONEST BUCKET. A 500, a proxy's HTML error page, a body that
 * is not JSON. Reported as itself rather than folded into `unreachable`, because
 * "the console answered something we could not read" and "nothing answered" are
 * different faults with different fixes.
 */
export type KickFailure = 'not-configured' | 'unreachable' | 'refused' | 'denied' | 'unknown'

/**
 * Why a kick was never delivered, as opposed to having failed.
 *
 * NOT A FAILURE, AND THE TYPE KEEPS THEM APART SO A CALLER CANNOT REPORT ONE AS
 * THE OTHER. Nothing went wrong with a `stale` drop: the console may be
 * perfectly healthy and the kick is being withheld on purpose because delivering
 * it now would remove the wrong session. `exhausted` is the count running out
 * first, which in practice means a console that has been down for the whole
 * window.
 */
export type KickDrop = 'stale' | 'exhausted'

/**
 * What happened to one kick, all the way through.
 *
 * `attempts` IS ON EVERY BRANCH INCLUDING THE DROPS, because the difference
 * between "we tried four times over five minutes" and "we never sent anything
 * because it was already stale" is the whole of what an operator needs and both
 * of them are `dropped`.
 */
export type KickResult =
  | {
      outcome: 'dispatched'
      /**
       * ALWAYS `false`, CARRIED FROM THE CONSOLE VERBATIM. Nothing in this
       * system reports whether the player was actually removed — the console's
       * `lib/commandOutcome.ts` names exactly what is missing — so a caller that
       * reads `dispatched` as `done` is wrong and the type says which. The day
       * an outcome event exists, this gains a `true` and one sentence changes.
       */
      confirmed: false
      /** The console's audit row for this command, when it named one. */
      commandId: string | null
      attempts: number
    }
  | {
      outcome: 'failed'
      failure: KickFailure
      /** The far side's own words, passed through unedited and never invented. */
      detail: string
      /** The HTTP status, or null when nothing answered. */
      status: number | null
      attempts: number
    }
  | { outcome: 'dropped'; why: KickDrop; detail: string; attempts: number }

/** One kick to ask for. */
export interface KickInput {
  /** The player, by game license. Checked against {@link LICENSE} before sending. */
  license: string

  /**
   * When the moderator acted — the audit log entry's timestamp, NOT `Date.now()`
   * at the call site. Staleness is measured from here; see {@link KICK_TTL_MS}.
   */
  at: number

  /** The Discord id of the admin to attribute this to. See {@link SERVICE_ACTOR_HEADER}. */
  actorDiscordId: string

  /** Their in-game name, if we know one. Shown in the console's audit row. */
  playerName?: string | null

  /**
   * Why, in the moderator's own words, or null.
   *
   * NULL IS OMITTED FROM THE BODY RATHER THAN REPLACED, and that is how this
   * file avoids inventing a sentence: the console's kick route already has a
   * default for a reasonless kick, written by whoever wrote the console. A
   * second default here would be a second wording for the same silence.
   */
  reason?: string | null
}

/**
 * The HTTP call, narrowed to what this file uses.
 *
 * OUR OWN SHAPE RATHER THAN `typeof fetch`, so a test hands over an object
 * literal instead of satisfying the whole of the platform's `fetch` overloads
 * for the four fields that are actually read.
 */
export interface HttpResponse {
  readonly status: number
  text(): Promise<string>
}

export type Fetcher = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<HttpResponse>

export interface RingmasterOptions {
  /** The console's origin. From `config.ringmasterUrl`; already path-free. */
  baseUrl: string

  /** `COMMAND_SECRET`. Held here, put in one header, and never logged. */
  secret: string

  /** The HTTP call, for tests. Defaults to the platform's `fetch`. */
  fetch?: Fetcher

  /**
   * The backoff, for tests.
   *
   * A SEAM RATHER THAN FAKE TIMERS, because the retry has to be observed from
   * outside: a test resolves this immediately and asserts four requests went
   * out, without a minute of real time and without vitest's timer control
   * reaching into a promise chain it does not own.
   */
  wait?: (ms: number) => Promise<void>

  /** The clock. Injectable because staleness is the thing under test. */
  now?: () => number

  timeoutMs?: number
  retryMs?: number
  ttlMs?: number
  attempts?: number
}

export interface Ringmaster {
  /** Ask for one live kick, retrying and giving up per this file's header. */
  kick(input: KickInput): Promise<KickResult>
}

/**
 * The default sleep.
 *
 * `unref`ed, LIKE EVERY OTHER TIMER IN THIS BOT. A kick waiting out its minute
 * must not be the reason `systemctl restart` waits — the retry is worth less
 * than a prompt deploy, and a process that exits mid-backoff has simply dropped
 * a kick that was about to be dropped for staleness anyway.
 *
 * THE PROMISE THEN NEVER SETTLES ON THE WAY OUT, which is correct and is worth
 * saying because it looks like a leak. If the process is exiting there is
 * nothing left to resolve for; if it is not exiting, an unreffed timer still
 * fires exactly on time.
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/**
 * The console's answer, reduced to the fields both of its shapes carry.
 *
 * READ DEFENSIVELY AND NEVER CAST. This body crosses a process boundary from a
 * service that is deployed separately, so a field that has changed shape has to
 * come out as "we could not read the answer" rather than as `undefined`
 * propagating into a log line.
 */
interface ConsoleBody {
  ok?: unknown
  outcome?: unknown
  failure?: unknown
  detail?: unknown
  error?: unknown
  commandId?: unknown
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * The two length caps the console's `kickSchema` enforces, applied before the
 * request rather than discovered from a 400.
 *
 * DISCORD ALLOWS A 512-CHARACTER AUDIT REASON AND THE ROUTE ACCEPTS 300, so this
 * is a real gap and not a theoretical one: an admin who writes a long ban reason
 * would get a zod message back, which this file would classify as `unknown`,
 * report as a failure and — being a 400 — correctly never retry. The kick would
 * simply not happen, over the length of a sentence. Truncating is the right
 * trade because the reason is a note, and the alternative is dropping the
 * moderation action to preserve the note in full.
 *
 * NOT ESCAPED, AND THAT IS CHECKED RATHER THAN ASSUMED. The reason reaches the
 * FXServer console on the game box, where a newline would be a second command —
 * so the obvious worry is real. It is handled on the far side and handled
 * properly: `kickPlayer` in fivem-ringmaster/src/lib/ssh.ts base64-encodes the
 * reason before it becomes an argument, precisely so that free text an admin
 * typed cannot become a second line on stdin. Doing it again here would mangle
 * what the player is shown without adding a guarantee.
 */
const REASON_CAP = 300
const PLAYER_NAME_CAP = 120

function capped(value: string | null | undefined, cap: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.length <= cap ? trimmed : trimmed.slice(0, cap)
}

/** One request's verdict, before the retry loop decides what to do with it. */
type Attempt =
  | { kind: 'dispatched'; commandId: string | null }
  | { kind: 'failed'; failure: KickFailure; detail: string; status: number | null; retry: boolean }

/**
 * Which failures are worth sending again.
 *
 * THE RULE IS "COULD THE SAME REQUEST SUCCEED IN A MINUTE", and it is a
 * property of the answer rather than of its status code:
 *
 *   RETRIED — nothing answered, the console answered `unreachable` (it could not
 *     reach the game box), or it answered `store` / `role-error` (a DynamoDB
 *     read or the Discord role check came apart). Every one of those is an
 *     outage in something between here and the game, and outages end.
 *
 *   NOT RETRIED — `refused`, which is the game box answering and saying no with
 *     a reason; `not-configured`, which is an operator's job and will be just as
 *     unset in a minute; and every refusal from the console's door, which is
 *     this bot's own credential, scope, actor or the named admin's role. Sending
 *     those again is asking the same question after being told the answer, four
 *     more times, on a moderation path.
 *
 * AN UNKNOWN 5xx IS RETRIED AND AN UNKNOWN 4xx IS NOT, which is the same rule
 * applied to a body we could not read: the server has a problem, or we do.
 */
function retryable(failure: KickFailure, code: string | null, status: number | null): boolean {
  if (failure === 'unreachable') return true
  if (failure === 'not-configured' || failure === 'refused' || failure === 'denied') return false

  // `unknown`: fall back to the status. A `store` or `role-error` from the
  // service gate arrives here as a 503 with a code we do recognise, so it is
  // named rather than left to the status.
  if (code === 'store' || code === 'role-error') return true
  return status !== null && status >= 500
}

/**
 * Turn one HTTP answer into an {@link Attempt}.
 *
 * THE CONSOLE HAS THREE ANSWER SHAPES AND THIS READS ALL THREE. `/api/kick`
 * returns `{ ok: true, outcome: 'dispatched', confirmed, commandId }` on
 * success and `{ ok: false, outcome: 'failed', failure, detail, error }` for a
 * command that failed; its service gate and `errorResponse` return
 * `{ ok: false, error: '<machine code>' }` with no `outcome` at all. The third
 * is the one that is easy to miss, because it is the shape a stale secret
 * produces — and a stale secret is the single most likely thing to be wrong with
 * this integration on the day it is wired up.
 *
 * A 200 WITH A BODY WE CANNOT READ IS NOT A SUCCESS. `outcome === 'dispatched'`
 * has to be present; anything else at any status is `unknown`, carrying a
 * bounded slice of what actually arrived so the journal shows the proxy error
 * page rather than "undefined".
 */
export function classify(status: number, body: string): Attempt {
  let parsed: ConsoleBody | null = null
  try {
    const value: unknown = JSON.parse(body)
    parsed = typeof value === 'object' && value !== null ? (value as ConsoleBody) : null
  } catch {
    parsed = null
  }

  if (parsed === null) {
    return {
      kind: 'failed',
      failure: 'unknown',
      // Bounded, because an HTML error page is kilobytes and this ends up on one
      // logfmt line. `render` in log.ts escapes it; the cap is about length.
      detail: `the console answered ${status} with ${body.trim().length === 0 ? 'an empty body' : `a body that is not JSON: ${body.trim().slice(0, 200)}`}`,
      status,
      retry: status >= 500,
    }
  }

  if (parsed.outcome === 'dispatched' && parsed.ok === true) {
    return { kind: 'dispatched', commandId: str(parsed.commandId) }
  }

  // The command's own failure, in the console's vocabulary.
  const code = str(parsed.failure) ?? str(parsed.error)
  const detail = str(parsed.detail) ?? str(parsed.error) ?? `the console answered ${status}`

  const failure: KickFailure =
    code === 'not-configured'
      ? 'not-configured'
      : code === 'unreachable'
        ? 'unreachable'
        : code === 'refused'
          ? 'refused'
          : code === 'auth' || code === 'scope' || code === 'actor' || code === 'role-revoked'
            ? 'denied'
            : 'unknown'

  return { kind: 'failed', failure, detail, status, retry: retryable(failure, code, status) }
}

/**
 * The relay.
 *
 * A FACTORY HOLDING THE SECRET rather than a function taking one, so that the
 * credential is read out of the config once, at wiring time, and every call site
 * downstream passes a player and an admin and has no way to name a URL or a
 * header. `createClient` builds one and hands it to the mirror.
 */
export function createRingmaster(options: RingmasterOptions): Ringmaster {
  const send: Fetcher = options.fetch ?? ((url, init) => fetch(url, init))
  const wait = options.wait ?? sleep
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? KICK_TIMEOUT_MS
  const retryMs = options.retryMs ?? KICK_RETRY_MS
  const ttlMs = options.ttlMs ?? KICK_TTL_MS
  const maxAttempts = options.attempts ?? KICK_ATTEMPTS
  const url = `${options.baseUrl}${KICK_PATH}`

  /**
   * One request, with a deadline on it.
   *
   * TWO MECHANISMS FOR ONE DEADLINE, WHICH IS src/ddb.ts's `call` AND ITS
   * REASONING. The abort signal is what makes `fetch` give up and release the
   * socket; the race against the clock is the actual guarantee, because an abort
   * only cancels what is listening for it and an injected fake is not obliged to
   * listen. The losing promise's rejection handler is attached before the race,
   * so a request that fails thirty seconds after nobody is waiting is a dropped
   * value rather than an unhandled rejection index.ts would log as a fault about
   * an operation nobody can place.
   */
  async function once(input: KickInput): Promise<Attempt> {
    const reason = capped(input.reason, REASON_CAP)
    const playerName = capped(input.playerName, PLAYER_NAME_CAP)

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const deadline = new Promise<'timeout'>((settle) => {
      timer = setTimeout(() => {
        controller.abort()
        settle('timeout')
      }, timeoutMs)
    })

    const request = (async () =>
      send(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [COMMAND_SECRET_HEADER]: options.secret,
          [SERVICE_ACTOR_HEADER]: input.actorDiscordId,
        },
        /**
         * `reason` AND `playerName` ARE OMITTED WHEN ABSENT rather than sent as
         * null. The route's schema accepts null and then falls back, so both
         * spellings work today; omitting is what keeps this body a subset of the
         * one a browser sends, which is the property that makes a change to the
         * route's schema break both callers together or neither.
         */
        body: JSON.stringify({
          license: input.license,
          ...(playerName === null ? {} : { playerName }),
          ...(reason === null ? {} : { reason }),
        }),
        signal: controller.signal,
      }))().then(
      (value) => ({ kind: 'answer' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )

    try {
      const settled = await Promise.race([request, deadline])

      if (settled === 'timeout') {
        return {
          kind: 'failed',
          failure: 'unreachable',
          detail: `no answer from the console in ${timeoutMs}ms`,
          status: null,
          retry: true,
        }
      }

      if (settled.kind === 'error') {
        return {
          kind: 'failed',
          failure: 'unreachable',
          detail: settled.error instanceof Error ? settled.error.message : String(settled.error),
          status: null,
          retry: true,
        }
      }

      const response = settled.value

      // Reading the body can fail on its own — a connection that dies
      // mid-response — and that is still "nobody answered" rather than a crash
      // in the retry loop.
      let text: string
      try {
        text = await response.text()
      } catch (error) {
        return {
          kind: 'failed',
          failure: 'unreachable',
          detail: `the console's answer could not be read: ${error instanceof Error ? error.message : String(error)}`,
          status: response.status,
          retry: true,
        }
      }

      return classify(response.status, text)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async kick(input) {
      // Before anything else, because a request the console would answer with a
      // zod message is a request we already know the answer to. See `LICENSE`.
      if (!LICENSE.test(input.license)) {
        return {
          outcome: 'failed',
          failure: 'refused',
          detail: `"${input.license}" is not a game license, so nothing was sent`,
          status: null,
          attempts: 0,
        }
      }

      let attempts = 0

      for (;;) {
        const age = now() - input.at

        /**
         * CHECKED BEFORE THE FIRST REQUEST AS WELL AS BEFORE EACH RETRY, which
         * is what makes the boot reconcile safe: replaying yesterday's audit log
         * hands this function a kick that is a day old, and it has to be dropped
         * without a request rather than delivered to whoever holds that slot
         * now. `attempts: 0` is how the caller tells that case from a give-up.
         */
        if (age >= ttlMs) {
          return {
            outcome: 'dropped',
            why: 'stale',
            detail: `the kick was ${Math.round(age / 1000)}s old and the limit is ${Math.round(ttlMs / 1000)}s`,
            attempts,
          }
        }

        attempts += 1
        const attempt = await once(input)

        if (attempt.kind === 'dispatched') {
          return {
            outcome: 'dispatched',
            confirmed: false,
            commandId: attempt.commandId,
            attempts,
          }
        }

        if (!attempt.retry) {
          return {
            outcome: 'failed',
            failure: attempt.failure,
            detail: attempt.detail,
            status: attempt.status,
            attempts,
          }
        }

        if (attempts >= maxAttempts) {
          return {
            outcome: 'dropped',
            why: 'exhausted',
            detail: `${attempts} attempts, last: ${attempt.detail}`,
            attempts,
          }
        }

        /**
         * DO NOT SLEEP A MINUTE TO WAKE UP AND FIND IT STALE. The check at the
         * top of the loop would catch it, a minute later, having held a timer
         * and a promise for nothing — and having delayed the caller's report of
         * an outcome that was already decided.
         */
        if (now() + retryMs - input.at >= ttlMs) {
          return {
            outcome: 'dropped',
            why: 'stale',
            detail: `waiting ${Math.round(retryMs / 1000)}s would put the kick past the ${Math.round(ttlMs / 1000)}s limit, last: ${attempt.detail}`,
            attempts,
          }
        }

        // INFO, NOT WARN. A retry that is about to happen needs nobody: it is
        // the journal's business and the eventual outcome is what reaches the
        // status channel. See the level rule in src/log.ts.
        log('info', 'kick did not get through, backing off', {
          attempt: attempts,
          failure: attempt.failure,
          status: attempt.status,
          detail: attempt.detail,
          retryMs,
        })

        await wait(retryMs)
      }
    },
  }
}
