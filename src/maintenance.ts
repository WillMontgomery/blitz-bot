import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client } from 'discord.js'

import { connectIp, DEFAULT_SERVER_IPS } from './config.ts'
import type { Ddb, DdbResult, MaintenanceState, MaintenanceWindow } from './ddb.ts'
import { log } from './log.ts'

/**
 * THE SERVER COMING BACK, ANNOUNCED ONCE. NOTHING ELSE IS ANNOUNCED AT ALL.
 *
 * The console runs the whole maintenance lifecycle: an admin schedules a window,
 * the server stops letting people in, it deploys, it comes back. All of that is
 * in `ringmaster-maintenance` and all of it is visible in the console. This file
 * carries exactly one moment of it into a channel players read.
 *
 * ═══ ONE POST PER WINDOW, AND THE CUT IS THE OWNER'S ═══
 *
 * He watched a full cycle and then said it: "Let's not log any drain action in
 * discord actually. Sorry for the confusion. We can have the commands but we
 * don't need to post anything when it happens. And same for when the server
 * shuts down. Just post when the server comes back up."
 *
 * So `scheduled`, `draining`, `deploying` and `cancelled` are watched, recorded
 * and never spoken about. THAT IS FOUR OF THE FIVE STATES SILENT, and the four
 * are silent for one reason rather than four: a channel that narrates an outage
 * from both ends is a channel somebody scrolls past, and the post that actually
 * matters — the server is joinable again — is the one that then gets scrolled
 * past with it.
 *
 * ═══ WHAT WENT WITH THE OTHER TWO NOTICES ═══
 *
 * This file used to post at `draining` and at `deploying` as well, and a stack
 * of machinery existed only to fill those two sentences in: the initiator's
 * licence resolved through `ringmaster-players` into a Discord id so the person
 * who scheduled the window could be tagged, the admin's free-text note, a
 * timestamp for the moment the door shut, and a from/to pair of commits. Every
 * one of those is gone with the sentences that held it. NOBODY IS NAMED IN THE
 * MESSAGE THAT SURVIVES, so there is nothing left to resolve a licence for —
 * which is also why the data access below narrowed back to one table.
 *
 * ═══ AND `complete` STILL DOES NOT MEAN THE SERVER IS ANSWERING ═══
 *
 * This is the reason the surviving message is worth trusting, and it is the one
 * piece of the old machinery that had nothing to do with the deleted notices.
 * "The maintenance complete message should NEVER show until br_ringmaster has
 * delivered its first heartbeat." The console marks a window `complete` when the
 * deploy VERB returns, which is the moment `royale-deploy` has been kicked off
 * rather than the moment FXServer is back — so "the server is back up" would
 * otherwise land over a box that is still down, which is the exact failure the
 * one remaining post exists to not have.
 *
 * See `heartbeatAfterDeploy` for the one field on this row that can prove the
 * game is speaking again, and `RESTART_GRACE_MS` for what is said when it never
 * does. A wait with no end is silence, and a server that never came back is
 * exactly what an admin needs to know.
 *
 * ═══ THE COMMIT LINKS INTO THE GAME'S REPO, NOT INTO THIS ONE ═══
 *
 * Every sha on a maintenance row is a commit in `fivem-br-gamemode`, NOT in
 * blitz-bot: they are what the game box is running and what `royale-deploy` is
 * fetching. See `GAME_REPO_URL`. Linking them at client.ts's `REPO_URL` would
 * produce a link that works, looks right, and shows an admin an unrelated commit
 * in the wrong codebase.
 *
 * ═══ NOTHING ROUTINE HERE REACHES #bot-status ═══
 *
 * "A maintenance window does not need to write to #bot-status since it's already
 * writing to #maintenance-notifications." log.ts copies `warn` and `error` to the
 * status channel and `info` to nothing, so the level IS the choice of channel.
 * Everything that is maintenance PROGRESS is `info`. Two things are not progress
 * and stay above it: a window this bot could not READ (`blind`) and a notice it
 * could not POST (`check`). Those are the bot failing, not maintenance
 * happening, and they are the only two reasons a maintenance window is allowed
 * to appear in the status channel at all.
 *
 * READS ONLY, AND NOW EXACTLY ONE READ. This module calls one thing on the data
 * layer — `maintenance.current()`, a GetItem against one row — and the parameter
 * type below is `Pick<Ddb, 'maintenance'>` so that is not a promise in a comment.
 * Nothing here writes a Ringmaster table. The console owns this lifecycle and
 * owns the consequences of moving it; a Discord bot that could mark a window
 * complete would be a second, less careful implementation of a path that stops a
 * live server.
 *
 * A GETITEM ON A TIMER RATHER THAN A STREAM OR A WEBHOOK. DynamoDB Streams
 * would be exact and would need a Lambda, an IAM role and a second deployable;
 * a webhook from the console would need the console to know this bot exists.
 * One GetItem every fifteen seconds against a one-row table is a few thousand
 * reads a day against a table that is already provisioned, and the only cost
 * of the polling model is latency measured against the fifteen seconds.
 */

/**
 * How often the row is read.
 *
 * FIFTEEN SECONDS IS A LATENCY BUDGET, NOT A COST ONE. The read is trivially
 * cheap either way; what it buys is how long a server that is already back stays
 * unannounced while players sit at a connect screen deciding whether to give up.
 */
export const MAINTENANCE_POLL_MS = 15_000

/**
 * How many failed reads in a row before a person is told.
 *
 * ONE FAILED READ IS A POLL, NOT A PROBLEM. The next one is fifteen seconds
 * away and will almost always succeed, and log.ts is explicit that a call the
 * next attempt will make again is `info`. A MINUTE of them is different: it
 * means the bot cannot see maintenance at all, and the consequence of that is
 * the thing worth stating — see `blind`.
 */
const MAINTENANCE_BLIND_POLLS = 4

/**
 * How long a restart is allowed to explain the game's silence.
 *
 * THE CONSOLE'S OWN NUMBER, AND A COPY OF `RESTART_GRACE_MS` IN ITS
 * lib/serverPhase.ts. Same argument, from the other side of the same wait:
 * `royale-deploy` syncs resources and restarts FXServer, which is tens of
 * seconds, and the game pushes every two. Anything past five minutes is not a
 * slow restart, it is a problem — and at that point the honest thing is to stop
 * offering an excuse.
 *
 * A WAIT WITH NO END IS NOT A WAIT, IT IS SILENCE. The owner's rule is that the
 * complete notice must never show before the game speaks; the bound is what
 * stops that rule from turning a server which never came back into a channel
 * that says nothing at all. "A server that never came back is exactly what an
 * admin needs to know."
 *
 * IF THE CONSOLE RETUNES ITS NUMBER THIS ONE MUST FOLLOW. Nothing enforces
 * that; it is why this comment names the file. Being generous in the same
 * direction is the safe way to be wrong — a bot that alarms EARLIER than the
 * console's own page would be raising an alarm the console is still calling a
 * restart in progress.
 */
export const RESTART_GRACE_MS = 5 * 60_000

/**
 * The five states, as values, so a string off disk can be checked against them.
 *
 * ALL FIVE, THOUGH ONLY ONE OF THEM IS EVER ANNOUNCED. The mark records what was
 * SEEN and not what was posted — see `Mark` — so the four silent states are as
 * much a part of this list as `complete` is.
 *
 * TYPED AS THE UNION, so a sixth state added to ddb.ts and forgotten here is a
 * compile error rather than a mark that silently stops parsing.
 */
const STATES: readonly MaintenanceState[] = [
  'scheduled',
  'draining',
  'deploying',
  'complete',
  'cancelled',
]

function isState(raw: string): raw is MaintenanceState {
  return (STATES as readonly string[]).includes(raw)
}

/* ------------------------------------------------------------------ *
 * What this bot remembers between polls, and between restarts.
 * ------------------------------------------------------------------ */

/**
 * The last thing this bot SAW, which is deliberately more than the last thing
 * it POSTED.
 *
 * WHY OBSERVED AND NOT POSTED, AND IT MATTERS MORE NOW THAN IT EVER DID. Only
 * one of the five states is posted about, and the posting rule is "this window
 * moved to `complete` while we were watching" — which is a question about the
 * four states nothing is said about. Consider a window recorded only when it is
 * announced: the mark still names LAST week's window while this one runs through
 * `scheduled`, `draining` and `deploying` under our nose, so when it reaches
 * `complete` the mark disagrees about which window this is and the one post this
 * feature makes is suppressed as a catch-up. Recording every observation is what
 * makes "we watched this window arrive" a fact the file can carry.
 *
 * THE WINDOW IS IDENTIFIED BY `createdAt`, NOT BY `id`. `id` is the table's
 * key and it is the literal string `current` on every row there will ever be —
 * `ringmaster-maintenance` holds ONE item and the console overwrites it for
 * each new window (lib/maintenance.ts, `schedule`). `createdAt` is stamped
 * with `Date.now()` in that same write, so it is the only field on the row
 * that distinguishes this window from the one before it.
 */
interface Mark {
  /** The window's `createdAt`. See above: `id` is a constant. */
  readonly window: number
  readonly state: MaintenanceState
}

/**
 * The mark, across a restart.
 *
 * STRUCTURAL FOR THE REASON `CommitFiles` IN client.ts IS: the rules about
 * what posts and what stays quiet are the difficult part, and every one of
 * them — a missing file, an unreadable one, a file holding something that is
 * not a mark, a disk that will not take the write — is worth a case without a
 * test having to arrange it on a real filesystem.
 */
export interface MaintenanceMemory {
  /** What this bot last saw. Rejects with ENOENT when it has never seen anything. */
  readonly seen: () => Promise<string>

  /** Record what was seen. */
  readonly remember: (mark: string) => Promise<void>
}

/**
 * Where the mark lives.
 *
 * THE UNIT'S `StateDirectory=`, FOR THE REASON client.ts's `reportedCommitPath`
 * IS THERE: the updater owns /opt/blitz-bot and resets it, so anything this bot
 * remembers under the repo is a file the next update discards — and a
 * forgotten mark is a re-announced outage. /var/lib/blitz-bot is created by
 * systemd, stays writable under `ProtectSystem=strict`, and survives a reboot.
 *
 * THE FOUR LINES ARE A COPY OF client.ts's AND NOT AN IMPORT, which is a real
 * cost paid for a real reason: client.ts is the file that WIRES this module, so
 * importing back out of it would make the two a cycle. The literal fallback has
 * to stay in step with `StateDirectory=` in deploy/blitz-bot.service, which is
 * what log.test.ts already checks for the other file in this directory.
 */
export function maintenanceStatePath(): string {
  const [first] = (process.env.STATE_DIRECTORY ?? '').split(':')
  const state = first === undefined || first === '' ? '/var/lib/blitz-bot' : first

  return join(state, 'maintenance-seen')
}

export function maintenanceMemory(path: string = maintenanceStatePath()): MaintenanceMemory {
  return {
    seen: () => readFile(path, 'utf8'),

    // A trailing newline, like the reported-commit file beside it, so an
    // operator can `cat` it without the next prompt running into the value.
    remember: (mark) => writeFile(path, `${mark}\n`, 'utf8'),
  }
}

function formatMark(mark: Mark): string {
  return `${mark.window} ${mark.state}`
}

/**
 * A mark out of whatever is in the file, or null.
 *
 * NULL FOR ANYTHING THAT IS NOT EXACTLY A MARK, and null is the SILENT
 * direction: a bot with no memory treats the window it finds as one it never
 * saw begin and announces nothing about it. That is the right way to fail. The
 * alternative — half-parsing, keeping the state and guessing at the window —
 * makes a corrupted file into a bot that announces an outage that ended
 * yesterday.
 */
function parseMark(raw: string): Mark | null {
  const parts = raw.trim().split(' ')
  const [left, right] = parts
  if (parts.length !== 2 || left === undefined || right === undefined) return null

  const window = Number(left)
  if (!Number.isSafeInteger(window) || window <= 0) return null
  if (!isState(right)) return null

  return { window, state: right }
}

/* ------------------------------------------------------------------ *
 * What gets said.
 * ------------------------------------------------------------------ */

/**
 * The owner's sentence, and the whole of what this bot says.
 *
 * ═══ HIS WORDING, VERBATIM, WITH TWO HOLES IN IT ═══
 *
 * "The game server is back up and maintenance is complete. The server is now
 * running [hash as hyperlink]. [Click here to connect](fivem:// hyperlink)."
 *
 * NO SENTENCE HERE WAS INVENTED BY THIS BOT. The two holes are a commit off the
 * row and an address off the allowlist, and the one frame that has no wording
 * from him yet says so in the string itself; see `NOT_BACK`.
 *
 * ═══ ONE FLOWING PARAGRAPH. THE NEWLINES ARE NOT TO BE PUT BACK ═══
 *
 * He asked twice why the old notices were "wrapped on multiple lines. That looks
 * so weird." His wording is flowing sentences, so it is built as flowing text: a
 * `\n` inserted between the clauses to make the source or the post look tidy
 * re-creates the stack he objected to. That is why this is one template literal
 * and not a `lines.join('\n')`, and why the optional middle clause carries its
 * own leading space so dropping it leaves the punctuation intact.
 *
 * ═══ THE DURATION IS GONE AND IS NOT COMING BACK ═══
 *
 * This used to be followed by "down for 3s", computed off
 * `completedAt - deployStartedAt`. His verdict: "'The server is back down for 3s'
 * is ridiculous lol." The arithmetic was never the problem — `completedAt` is
 * stamped when the deploy VERB returns, seconds after it detaches
 * `royale-deploy` and long before FXServer is back, so the number was measuring
 * the console's round trip and calling it an outage. The gate below now waits for
 * the game itself, and the duration is not replaced by a better one: he asked for
 * it dropped and a truer number is still a number he did not ask for.
 */
const BACK = 'The game server is back up and maintenance is complete.'

/**
 * The connect link, in his markdown as well as his words.
 *
 * ═══ THE ONE THING IN THIS NOTICE NOBODY CAN SETTLE OFFLINE ═══
 *
 * HE WROTE IT AS A MASKED LINK — "[Click here to connect](fivem:// hyperlink)" —
 * AND IT SHIPS THAT WAY ON PURPOSE. Discord documents the masked-link scheme
 * allowlist as http, https and discord, and rejects a custom scheme in an EMBED
 * and in a BUTTON COMPONENT. Whether `fivem://` behind `[text](…)` renders in
 * PLAIN MESSAGE CONTENT, which is what this is, is documented neither way. An
 * earlier version of this file asserted flatly that it does not and cited the
 * embed rule as the proof, which is a rule about a different surface.
 *
 * SO THE FIRST CYCLE ANSWERS THE QUESTION AND THE FALLBACK IS ONE EXPRESSION.
 * If it renders as literal brackets he sees it in the channel immediately, and
 * the whole fix is the return below becoming `fivem://connect/${serverIp}` — a
 * bare url, which IS clickable in message content and does launch the game.
 * Nothing else in the notice moves. That is the reason the link is a function of
 * its own rather than spelled into the sentence: the change has to be small
 * enough to make on the evidence of one post.
 *
 * THE ADDRESS COMES FROM THE ALLOWLIST AND NOT FROM A LITERAL HERE. `connectIp`
 * reads the head of `BLITZ_SERVER_IPS`, which links.ts already uses to decide
 * whose server a `fivem://connect/` link points at. A second copy in this file is
 * the copy that does not get updated the day the community moves boxes.
 */
function connectLink(serverIp: string): string {
  return `[Click here to connect](fivem://connect/${serverIp})`
}

function backUp(window: MaintenanceWindow, serverIp: string): string {
  const sha = runningSha(window)
  const running = sha === null ? '' : ` The server is now running ${commitLink(sha)}.`

  // One line, deliberately over the width the rest of this file keeps to. See
  // `BACK`: breaking the literal is how the newlines get back in.
  return `${BACK}${running} ${connectLink(serverIp)}.`
}

/**
 * What is said when the game never spoke.
 *
 * PLACEHOLDER — THE OWNER SUPPLIES USER-FACING WORDING. He asked for the bound
 * ("if no heartbeat arrives within some window, say something rather than
 * staying silent forever") and not for the sentence, so the sentence says what
 * it is. Shipping an unapproved line has to be obvious in the channel rather
 * than invisible.
 *
 * THE CONSOLE'S OWN REASON RIDES INSIDE IT WHEN THERE IS ONE, unedited, for the
 * reason /drain shows a refusal verbatim: this bot cannot know better than the
 * thing that tried the deploy, and a house summary of somebody else's error is
 * a worse copy of it.
 *
 * ONE LINE, LIKE THE NOTICE ABOVE IT. This used to join its two halves with a
 * `\n` and it was the last multi-line message left in the file once the drain
 * and going-down notices went. "Why is anything wrapped on multiple lines" was
 * not a remark about one post.
 */
const NOT_BACK = 'PLACEHOLDER: the update finished but the game server has not reported back.'

function didNotConfirm(reason: string | null): string {
  return reason === null
    ? NOT_BACK
    : `${NOT_BACK} PLACEHOLDER: the console said: ${capped(reason, REASON_CAP)}`
}

/**
 * How much of the console's stated reason is carried.
 *
 * A CAP BECAUSE DISCORD'S IS 2000 CHARACTERS AND IT REJECTS THE WHOLE MESSAGE,
 * not the overflow. This cap used to sit on the admin's free-text note, which
 * went with the going-down notice; it is kept and moved rather than deleted
 * because `deployError` is now the one value in a post that this repo does not
 * bound — it is written by another codebase out of whatever a shell script or an
 * SSH library said, and nothing between there and here shortens it. The failure
 * without a cap is that the message reporting a server which never came back is
 * itself dropped by the API, invisibly.
 *
 * 1500 IS FAR MORE REASON THAN ANY OF THEM CARRY and far less than the limit.
 */
const REASON_CAP = 1500

/**
 * Cut by code point, like every other cut in this repo: a UTF-16 slice can land
 * inside a surrogate pair and put half a character in a post.
 */
function capped(value: string, cap: number): string {
  const points = [...value.trim()]
  if (points.length <= cap) return points.join('')

  return `${points.slice(0, cap).join('')}…`
}

/**
 * A field off a row whose type does not name it.
 *
 * ddb.ts's `MaintenanceWindow` IS A DECLARED SUBSET of the console's row and
 * says so at its definition: the console writes another twenty fields about the
 * deploy itself, and every one of them arrives on the item whether or not the
 * interface mentions it. Five of those matter here — when the deploy began, when
 * a heartbeat from a NEW process confirmed the restart, what the deploy verb
 * returned when it refused, and the commits — and none of them is in the subset.
 *
 * READ DEFENSIVELY BECAUSE THE TYPE CANNOT VOUCH FOR THEM. A cast promising
 * `number` would be an assertion about a field TypeScript has never checked, on
 * a row written by another repo. Anything of the wrong shape is ABSENT here,
 * and absent costs a clause of the notice rather than the notice — except on the
 * completion gate, where absent is what keeps the bot from claiming a server is
 * back that it cannot prove is back.
 *
 * TWO READERS RATHER THAN ONE GENERIC ONE, because the two checks are not the
 * same check: `Number.isFinite` rejects the NaN a broken arithmetic would
 * produce, and the string reader rejects the empty string, which is a field
 * that exists and says nothing.
 */
function numberOn(window: MaintenanceWindow, field: string): number | null {
  const value = (window as unknown as Record<string, unknown>)[field]

  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOn(window: MaintenanceWindow, field: string): string | null {
  const value = (window as unknown as Record<string, unknown>)[field]

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** When the deploy fired. `markDeploying` writes it with the state change. */
function deployStartedAt(window: MaintenanceWindow): number | null {
  return numberOn(window, 'deployStartedAt')
}

/** When the deploy verb returned. `markComplete` writes it with the state change. */
function completedAt(window: MaintenanceWindow): number | null {
  return numberOn(window, 'completedAt')
}

/**
 * A commit as it goes into the notice.
 *
 * ABBREVIATED TO THE CONSOLE'S OWN EIGHT, AND ONLY WHEN IT IS CERTAINLY A FULL
 * COMMIT. A forty-character hex string in an announcement players read is
 * noise, and eight is what every commit card in the console shows — so the two
 * surfaces name the same deploy in the same shape. Anything that is NOT exactly
 * forty hex characters is printed whole rather than cut, because a value of an
 * unexpected shape is one this bot has no business trimming.
 *
 * IT IS FOR READING AND NEVER FOR COMPARING. The console's `deployLanded` is
 * explicit that a prefix must never be handed to anything that compares
 * commits; nothing here compares them, and nothing downstream should start.
 */
const FULL_SHA = /^[0-9a-f]{40}$/u

function shortSha(sha: string): string {
  return FULL_SHA.test(sha) ? sha.slice(0, 8) : sha
}

/**
 * ═══ THE REPO EVERY COMMIT ON A MAINTENANCE ROW BELONGS TO ═══
 *
 * NOT THIS BOT'S REPO, AND GETTING THAT WRONG IS THE WHOLE HAZARD. client.ts has
 * a `REPO_URL` pointing at `blitz-bot` and it is correct there: the sha in the
 * deploy notice is the commit THIS PROCESS was built from, read out of a file the
 * bot's own updater wrote. Every sha on a maintenance row is a different thing
 * entirely — `deployLandedSha`, `targetSha` and `shownSha` are what the GAME box
 * is running and what `royale-deploy` is fetching, and the console says so in
 * lib/github.ts: "every sha this console renders … is a commit in
 * `fivem-br-gamemode`". A link built on the wrong one of those two constants
 * resolves, renders, and shows an admin an unrelated commit in a codebase that
 * has nothing to do with the deploy they are reading about — which is worse than
 * printing the sha with no link at all, because it looks authoritative.
 *
 * THE SAME URL THE CONSOLE'S `GAME_REPO` HOLDS, and a copy rather than an import
 * for the reason every other console constant in this repo is a copy: the two
 * repos deploy separately and share no package. If the game moves, both change.
 *
 * NO TRAILING SLASH; `commitLink` adds its own. `/commit/<sha>` is GitHub's own
 * route.
 */
const GAME_REPO_URL = 'https://github.com/WillMontgomery/fivem-br-gamemode'

/**
 * A commit, as a masked link to the game repo — or bare when it is not a commit.
 *
 * "SAME FOR THE BUILD HASH BEING A HYPERLINK", which is a standing rule rather
 * than a request about one notice. A MASKED LINK WORKS HERE BECAUSE THE SCHEME IS
 * https: Discord's own allowlist covers it, so unlike the connect link two
 * functions up there is nothing uncertain about this one rendering.
 *
 * ONLY A VALUE THAT IS CERTAINLY A COMMIT IS LINKED, and everything else is
 * printed exactly as `shortSha` would print it. `runningSha` can return a value
 * of another shape — a ref name off an older row — and
 * `${GAME_REPO_URL}/commit/origin/main` is not a commit URL. Sending an admin to
 * a 404 is a smaller failure than the wrong-repo one above, and it is still one
 * worth not shipping; a sha with no link says the same true thing and promises
 * nothing.
 *
 * THE HREF CARRIES THE FULL SHA AND THE TEXT CARRIES THE EIGHT. GitHub resolves
 * either, so the link is built from the unambiguous one and the reader is shown
 * the short one — which is also the rule `shortSha` states about abbreviations:
 * for reading, never for identifying.
 */
function commitLink(sha: string): string {
  return FULL_SHA.test(sha) ? `[${shortSha(sha)}](${GAME_REPO_URL}/commit/${sha})` : sha
}

/**
 * The commit the box is running now that the deploy has landed, or null.
 *
 * ═══ ONE COMMIT, WHERE THE OLD NOTICES CARRIED A FROM/TO PAIR ═══
 *
 * The drain notice named where the window was HEADING and the going-down notice
 * sat beside it; between them they printed two shas about one outage. His
 * sentence names one thing — "the server is NOW RUNNING [hash]" — and this is the
 * row's best answer to it, read in the order the console writes.
 *
 * `deployLandedSha` FIRST, BECAUSE IT IS THE ONLY ONE THAT IS A REPORT RATHER
 * THAN A PLAN. The console nulls it at `schedule` and nulls it AGAIN at
 * `markDeploying`, so a value sitting on a `complete` row was written by this
 * window's deploy landing and cannot be left over from the window before — and
 * `ringmaster-maintenance` holds one row that `schedule` overwrites whole, so
 * there is nowhere else for a stale value to have come from. That double-null is
 * also why this field is worthless on a `draining` row, which is what retired it
 * from the drain notice.
 *
 * THEN THE DESTINATION, PIN BEFORE PAGE. `targetSha` is a commit the game box
 * ENFORCES — `switchref` refuses if the branch has moved and `deploy.sh` refuses
 * again — and `POST /api/maintenance` writes `shownSha` as null whenever
 * `targetRef` is set, precisely so the weaker record cannot be mistaken for the
 * stronger one. Reading the pin first is reading them in the console's own order.
 *
 * THE DESTINATION IS ONLY HONEST HERE BECAUSE OF THE GATE. "Heading for" and
 * "now running" are the same commit exactly when the deploy worked, and the one
 * caller of this function is a notice that does not post until a heartbeat from a
 * NEW process has proved it did.
 *
 * NULL IS ORDINARY AND COSTS THE CLAUSE, NOT THE NOTICE. An automatic 72-hour
 * window nobody was looking at, or a console whose branch reading was too old to
 * stand behind, carries no commit at all — and "the game server is back up and
 * maintenance is complete" followed by the connect link is still the whole of
 * what he asked to be told.
 */
function runningSha(window: MaintenanceWindow): string | null {
  return (
    stringOn(window, 'deployLandedSha') ??
    stringOn(window, 'targetSha') ??
    stringOn(window, 'shownSha')
  )
}

/* ------------------------------------------------------------------ *
 * Is the game actually back?
 * ------------------------------------------------------------------ */

/**
 * WHEN br_ringmaster FIRST SPOKE AS A NEW PROCESS, OR NULL.
 *
 * ═══ THIS IS THE ONLY PROOF OF LIFE THAT REACHES DYNAMODB ═══
 *
 * The obvious places to look do not answer. `ringmaster-telemetry` is a table
 * the console declares in lib/dynamo.ts and NOTHING reads or writes — `tables.
 * telemetry` has no call site in that repo at all. And the ingest path the game
 * pushes to is in-memory by design: `POST /api/ingest` says in its own header
 * that it does "no DynamoDB write, no network call", because `PerformHttpRequest`
 * on the game side has a hardcoded five-second timeout, and the heartbeat it
 * applies lands in `lib/state`, which dies with the console process.
 *
 * SO THE CONSOLE'S DRIVER IS WHAT WRITES THE ANSWER DOWN. `maintenanceDriver`
 * watches its own live feed for a push whose `bootEpoch` differs from the one it
 * recorded when the deploy fired, and stamps `deployConfirmedAt` onto this row —
 * durably, and once, under a condition — precisely so the verdict survives a
 * console restart. That field is on the same one-row GetItem this bot already
 * makes four times a minute, which is why this feature costs no new read, no new
 * table and no new permission.
 *
 * NEWER THAN THE DEPLOY, WHICH IS THE OWNER'S WORD AND NOT A FORMALITY. The
 * console clears this field at `schedule` and again at `markDeploying`, so a
 * value here should already belong to this deploy — but "should" is not a thing
 * to hang the sentence on. The comparison makes a row that somehow carries an
 * older confirmation read as UNCONFIRMED, which is the direction that stays
 * quiet rather than the direction that announces a server is up.
 *
 * AND WITH NO DEPLOY CLOCK AT ALL THERE IS NOTHING TO BE NEWER THAN, so the
 * answer is null. A row that cannot say when its own deploy began cannot prove
 * anything about a timestamp sitting beside it.
 */
function heartbeatAfterDeploy(window: MaintenanceWindow): number | null {
  const confirmed = numberOn(window, 'deployConfirmedAt')
  if (confirmed === null) return null

  const deployed = deployStartedAt(window) ?? completedAt(window)
  if (deployed === null) return null

  return confirmed > deployed ? confirmed : null
}

/**
 * The console's stated reason the deploy did not happen, or null.
 *
 * `deployError` IS THE HOST REFUSING, WHICH IS NOT THE SAME FAILURE AS SILENCE.
 * The console's `deployPhase` tests this field before it tests anything about
 * heartbeats, and says why: a stated error means the code never shipped and the
 * server was never restarted, so the game pushing happily afterwards is the
 * EXPECTED state rather than evidence of a successful deploy. This bot reads it
 * in the same order and for the same reason.
 */
function deployFailure(window: MaintenanceWindow): string | null {
  return stringOn(window, 'deployError')
}

/**
 * Has the wait run out?
 *
 * A STATED FAILURE ENDS IT IMMEDIATELY. Sitting out five minutes of grace over
 * an answer already written on the row would be five minutes of silence with
 * the explanation in hand.
 *
 * OTHERWISE THE CLOCK IS THE ROW'S AND NEVER THIS PROCESS'S UPTIME. `completedAt`
 * is when the deploy verb returned; a bot restarted during the outage must not
 * restart the grace with itself, or a crash loop would hold the alarm off
 * forever.
 *
 * A ROW WITH NO CLOCK AT ALL IS OUT OF TIME AT ONCE, because the alternative is
 * a wait that can never end — and a wait with no end is the silence the bound
 * exists to prevent.
 */
function graceExpired(window: MaintenanceWindow, now: number): boolean {
  if (deployFailure(window) !== null) return true

  const clock = completedAt(window) ?? deployStartedAt(window)
  if (clock === null) return true

  return now - clock >= RESTART_GRACE_MS
}

/* ------------------------------------------------------------------ *
 * What one poll does.
 * ------------------------------------------------------------------ */

/**
 * The three things a poll can decide, and `hold` is the one that is not obvious.
 *
 * `hold` MEANS "SAY NOTHING AND DO NOT WRITE THE MARK DOWN". A decision that was
 * final at the moment the state changed would not need it; the completion gate is
 * not final — the row says `complete` and the question "is the game answering"
 * has no answer yet — so the poll has to be able to leave the window exactly as
 * unfinished as it found it and ask again in fifteen seconds. Advancing the mark
 * there would record the transition as handled and cost the notice permanently.
 */
type Step =
  | { readonly kind: 'post'; readonly content: string; readonly alarm: boolean }
  | { readonly kind: 'hold' }
  | { readonly kind: 'quiet' }

const HOLD: Step = { kind: 'hold' }
const QUIET: Step = { kind: 'quiet' }

const say = (content: string, alarm = false): Step => ({ kind: 'post', content, alarm })

/** What the poll knows that is not on the row. */
interface Moment {
  readonly now: number

  /** The address a player is told to connect to. See `connectLink`. */
  readonly serverIp: string

  /**
   * The window this process has already reported as not having come back, or
   * null.
   *
   * IN MEMORY AND DELIBERATELY NOT ON DISK. It exists to let ONE window produce
   * the alarm and then, if the game turns up late, the back-up notice as well —
   * the alarm is not the end of the story and a channel that says "it has not
   * come back" and then never mentions it again is worse than one that never
   * said either. A restart loses it, which costs the late correction and cannot
   * cost a repeat: the mark on disk already says `complete` by then.
   */
  readonly alarmed: number | null
}

/**
 * What to do about a `complete` row.
 *
 * ═══ THE OWNER'S RULE, WHICH IS ABOUT WHAT `complete` DOES NOT MEAN ═══
 *
 * "The maintenance complete message should NEVER show until br_ringmaster has
 * delivered its first heartbeat. That tells us that the server process has
 * executed properly and successfully." The console marks the window complete
 * when its deploy verb returns, and that verb returns as soon as it has detached
 * `systemctl start royale-deploy` — the fetch, the reset and the restart have
 * not happened yet. So `complete` is the console finishing, and the sentence
 * this bot posts is about the GAME finishing, and they are tens of seconds
 * apart on a good day.
 *
 * THREE ANSWERS AND A WAIT, IN THIS ORDER:
 *
 *   THE HOST REFUSED — say so at once, with its reason. Waiting for a heartbeat
 *   here would be waiting for a restart that never started.
 *
 *   A HEARTBEAT NEWER THAN THE DEPLOY — the notice, in his words. Said once,
 *   and said a second time only where the previous thing this bot said about
 *   this window was the alarm, which the late arrival has just corrected.
 *
 *   NOTHING YET — hold, until the grace runs out and the silence becomes the
 *   thing worth saying.
 */
function completion(mark: Mark, window: MaintenanceWindow, at: Moment): Step {
  const said = mark.state === 'complete'

  const failure = deployFailure(window)
  if (failure !== null) return said ? QUIET : say(didNotConfirm(failure), true)

  if (heartbeatAfterDeploy(window) !== null) {
    return !said || at.alarmed === window.createdAt ? say(backUp(window, at.serverIp)) : QUIET
  }

  if (said) return QUIET

  return graceExpired(window, at.now) ? say(didNotConfirm(null), true) : HOLD
}

/**
 * What to do, given what was last seen and what the row says now.
 *
 * PURE, AND IT IS WHERE THE TWO SILENCES LIVE.
 *
 *   ANY STATE BUT `complete` — nothing. "We don't need to post anything when it
 *   happens. And same for when the server shuts down. Just post when the server
 *   comes back up." `scheduled`, `draining`, `deploying` and `cancelled` are all
 *   watched and all recorded, and the recording is not decoration: it is what
 *   proves this process was here when the window began. See `Mark`.
 *
 *   A DIFFERENT WINDOW, OR NO MARK AT ALL — this process did not watch this
 *   window arrive, so it says nothing about it ending. "The server is back up" is
 *   a report about something that finished, and a report is exactly what must not
 *   turn up hours late for an outage that ran while the bot was being updated;
 *   Ringmaster's audit trail is the record of what happened while it was gone.
 *   The deleted notices had a recency door — a transition the ROW timestamped
 *   inside the last two minutes was announced by a process that had not seen it
 *   begin — and that door was never opened for this notice, so it went with them.
 *
 * SPELLED OUT AS A NULL CHECK AND A COMPARISON rather than through a `known`
 * boolean, because a boolean derived from a null check does not narrow the value:
 * this is the form the compiler can see, and it is the same test.
 */
function decide(mark: Mark | null, window: MaintenanceWindow, at: Moment): Step {
  if (window.state !== 'complete') return QUIET
  if (mark === null || mark.window !== window.createdAt) return QUIET

  return completion(mark, window, at)
}

/* ------------------------------------------------------------------ *
 * Posting.
 * ------------------------------------------------------------------ */

/**
 * The channel id names nothing this bot can post in.
 *
 * ITS OWN TYPE SO THE WATCHER CAN TELL IT FROM A RATE LIMIT. One is a wrong
 * variable and never gets better; the other is fifteen seconds of patience.
 * Without the distinction, a misconfigured id is a failed fetch and a log line
 * every fifteen seconds for as long as the process lives.
 */
class UnusableChannel extends Error {}

/**
 * Sending the notice to the maintenance channel.
 *
 * NOT `statusPoster` FROM client.ts, AND THE DUPLICATION IS DELIBERATE TWICE
 * OVER. client.ts is the file that wires this module, so importing back out of
 * it would make a cycle. And the channels are not the same kind of thing: the
 * status channel carries this bot's own faults for the owner, while this one
 * carries an announcement players read, so a failure here has to say which of
 * the two ids is wrong.
 *
 * `allowedMentions: { parse: [] }` STAYS, THOUGH THE REASON IT WAS ADDED IS GONE.
 * It went in when the going-down notice carried two strings a human had typed
 * into the console — an admin's note and a display name — either of which could
 * hold `@everyone`, and later when the initiator was tagged. Neither exists any
 * more: the surviving notice is a fixed sentence, a commit and an address, and
 * nothing in it is meant to notify anybody. That is exactly why the suppression
 * is worth keeping rather than deleting — it is the thing that holds the property
 * true whatever a later edit puts in the content, and an announcement channel is
 * the worst possible place to discover that something pings.
 *
 * STATED AT THE SEND rather than left to the client-wide default, because that
 * default is silently replaced by any send that passes an `allowedMentions` of
 * its own and a reader of this function cannot see whether one did.
 */
export function maintenancePoster(
  client: Client,
  channelId: string,
): (content: string) => Promise<void> {
  return async (content) => {
    const channel = await client.channels.fetch(channelId)

    if (channel === null || !channel.isSendable()) {
      throw new UnusableChannel('the maintenance channel id names no channel this bot can post in')
    }

    await channel.send({ content, allowedMentions: { parse: [] } })
  }
}

/**
 * A failure that will not come right on its own.
 *
 * THE SAME THREE CODES client.ts LATCHES ON, for the same reason: a wrong id, a
 * deleted channel and a missing permission are all a variable and a restart,
 * and retrying any of them costs a request and a log line every fifteen seconds
 * forever. Everything else — a rate limit, a 500, a network that blinked — is
 * retried by the next poll.
 */
function permanent(error: unknown): boolean {
  if (error instanceof UnusableChannel) return true
  if (!(error instanceof DiscordAPIError)) return false

  return (
    error.code === RESTJSONErrorCodes.UnknownChannel ||
    error.code === RESTJSONErrorCodes.MissingAccess ||
    error.code === RESTJSONErrorCodes.MissingPermissions
  )
}

/* ------------------------------------------------------------------ *
 * The watcher.
 * ------------------------------------------------------------------ */

export interface MaintenanceWatch {
  /** One poll: read the row, post if it moved, record what was seen. Never rejects. */
  readonly check: () => Promise<void>

  /** True once the channel has been found unusable and nothing more will be posted. */
  readonly stopped: () => boolean
}

export interface MaintenanceWatchOptions {
  /** The one call this module makes on the data layer. See the module comment: reads only. */
  readonly read: () => Promise<DdbResult<MaintenanceWindow | null>>
  readonly post: (content: string) => Promise<void>

  readonly memory?: MaintenanceMemory

  /**
   * The IP allowlist, whose head is the address the notice tells people to type.
   *
   * OPTIONAL, AND THE DEFAULT IS THE LIST'S OWN DEFAULT rather than a literal
   * of this module's. src/client.ts wires this watcher and hands it a channel
   * id, a data layer and nothing else — it holds a `Config` and does not pass
   * it — so a required parameter here would not compile against the one call
   * site there is. See `connectIp`: an operator who has never set
   * `BLITZ_SERVER_IPS` gets the same address either way, and passing
   * `config.serverIps` from client.ts is the one line that makes an operator who
   * HAS set it reach the notice too.
   */
  readonly serverIps?: readonly string[]

  /** The clock, so the grace can be tested offline. */
  readonly now?: () => number
}

/**
 * The whole feature, with the two live edges — DynamoDB and Discord — handed in.
 *
 * THE MARK IS HELD IN MEMORY AS WELL AS ON DISK, and the in-memory copy is the
 * one every decision is made against. The file is read ONCE per process and
 * exists for exactly one purpose: so a restart mid-window does not re-announce.
 * Making the file authoritative per poll would mean a disk that cannot be
 * written turning one missed write into the same notice posted every fifteen
 * seconds — the file failing loudly in the channel it is supposed to keep
 * quiet.
 */
export function maintenanceWatch(options: MaintenanceWatchOptions): MaintenanceWatch {
  const { read, post } = options
  const memory = options.memory ?? maintenanceMemory()
  const serverIp = connectIp(options.serverIps ?? DEFAULT_SERVER_IPS)
  const now = options.now ?? Date.now

  let mark: Mark | null = null
  let loaded = false
  let usable = true
  let failures = 0

  /**
   * The window this process has already reported as not having come back.
   *
   * See `Moment.alarmed`: it is what lets a late heartbeat correct the alarm,
   * and it is in memory rather than on disk on purpose.
   */
  let alarmed: number | null = null

  /**
   * The mark off disk, once.
   *
   * AN ABSENT FILE IS THE ORDINARY STATE OF A BOX NOBODY HAS RUN THIS ON and
   * gets no line at all, exactly like the deploy notice's missing files.
   *
   * BOTH OF THE OTHER TWO ARE `info`, AND THEY USED TO BE `warn`. This is the
   * owner's "a maintenance window does not need to write to #bot-status" applied
   * where it bites: log.ts copies warn and error into that channel, so a warn
   * here put the bot's own bookkeeping in front of him beside the outage notice
   * he was already reading in #maintenance-notifications. Neither of these is the
   * bot failing at what it is for — it can still see the window and still post
   * the notice. The whole cost of an unreadable or unparseable mark is that a
   * restart in the next few minutes could repeat ONE notice, which does not need
   * a human at 3am; the journal has the line for whoever is debugging.
   */
  async function baseline(): Promise<Mark | null> {
    if (loaded) return mark
    loaded = true

    let raw: string
    try {
      raw = await memory.seen()
    } catch (error) {
      if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
        log('info', 'could not read what maintenance state was last seen', { error })
      }
      return null
    }

    // The content is never logged, only whether it parsed. Whatever sits in a
    // file this process did not write is not a thing to copy into a channel.
    mark = parseMark(raw)
    if (mark === null) log('info', 'the maintenance state file does not hold a mark')

    return mark
  }

  /**
   * A read that did not answer.
   *
   * AN UNREADABLE ROW IS NOT "NO WINDOW", IT IS "CANNOT SEE", and the two must
   * not collapse into each other. Treating a timeout as an absent window would
   * clear the mark and turn the next successful read into a window this bot has
   * never seen — so the notice that the outage ended would be suppressed as a
   * catch-up. So: change nothing, say nothing to the channel, and leave the mark
   * exactly where it was.
   *
   * A MISSED NOTICE IS INVISIBLE, WHICH IS WHY THE JOURNAL LINE IS NOT
   * OPTIONAL. Every other failure in this bot leaves a mark somebody can trip
   * over — a message still standing, a command that answered with an error. A
   * maintenance notice that was never posted looks precisely like a maintenance
   * window that never happened, from Discord, forever. These lines are the only
   * evidence that the bot was blind while the server went down.
   *
   * THIS IS ONE OF THE TWO THINGS THAT MAY STILL REACH #bot-status. "A
   * maintenance window does not need to write to the status channel" is about
   * maintenance PROGRESS, and a window this bot cannot read is not progress —
   * it is the bot unable to do the job, and the notice it is failing to post is
   * the one whose absence nobody can see from Discord.
   */
  function blind(failure: unknown): void {
    failures += 1

    // `info` for one: the next poll is fifteen seconds away and will almost
    // certainly succeed, and log.ts is explicit that a call the next attempt
    // will make again does not need a human. A minute of them does — it means
    // this bot cannot see maintenance at all — and it is said ONCE per run of
    // failures rather than four times a minute for as long as it lasts.
    if (failures === MAINTENANCE_BLIND_POLLS) {
      log('warn', 'cannot read the maintenance window, an outage may go unannounced', {
        failures,
        failure,
      })
      return
    }

    log('info', 'could not read the maintenance window', { failure })
  }

  async function check(): Promise<void> {
    if (!usable) return

    const result = await read()
    if (!result.ok) {
      blind(result.failure)
      return
    }

    failures = 0

    // No window has ever been scheduled, or the row was removed. Nothing to
    // compare against and nothing to say; the mark is left alone, because the
    // next window will carry a `createdAt` of its own and be recognised as new
    // whatever this holds.
    const window = result.value
    if (window === null) return

    const seen = await baseline()
    const next: Mark = { window: window.createdAt, state: window.state }

    const step = decide(seen, window, { now: now(), serverIp, alarmed })

    /**
     * THE DECISION IS TAKEN EVERY POLL AND THE WRITE IS NOT.
     *
     * This used to return early whenever the mark equalled the state, before
     * anything was decided. It cannot any more: a `complete` window whose
     * heartbeat arrives after this bot has already reported it as not back is
     * exactly that case, and the correction is the one post worth making from
     * it. `decide` is a pure function over a row already in hand, so asking it
     * four times a minute costs nothing — the thing that had to stay cheap was
     * the WRITE, and that is guarded below where it belongs.
     */
    if (step.kind === 'hold') return

    if (step.kind === 'post') {
      try {
        await post(step.content)
      } catch (error) {
        if (permanent(error)) {
          usable = false

          // THE OTHER OF THE TWO THINGS THAT MAY STILL REACH #bot-status, and
          // `error` rather than `warn` for log.ts's own reason: the bot has
          // stopped doing something it is for, permanently, and no maintenance
          // notice will ever be posted again until somebody fixes the id. That
          // is not maintenance progress in a status channel — it is the only
          // warning anybody will get that #maintenance-notifications has gone
          // silent, and it cannot be announced in the channel it is about.
          log('error', 'maintenance channel unusable, nothing more will be posted to it', { error })
          return
        }

        // THE MARK IS NOT ADVANCED, so the next poll tries this again. A rate
        // limit or a five-hundred costs fifteen seconds; recording the state as
        // handled would cost the notice permanently, and this is the one post
        // in the bot whose absence nobody can see. `info` because the retry is
        // already arranged — see the level rule in log.ts.
        log('info', 'could not post a maintenance notice, it will be retried', { error })
        return
      }

      // SET BY THE ALARM AND CLEARED BY EVERY OTHER POST, which is what makes
      // the correction fire exactly once. See `Moment.alarmed`.
      alarmed = step.alarm ? window.createdAt : null
    }

    // ADVANCED IN MEMORY FIRST AND THE WRITE IS BEST EFFORT. A state directory
    // that cannot be written must not make this process announce the same
    // transition again in fifteen seconds; the only thing a failed write costs
    // is that a restart before the next transition could repeat the notice
    // once.
    mark = next

    // NOTHING MOVED, WHICH IS ALMOST EVERY POLL. The row is read four times a
    // minute and changes a handful of times a week, so this is the path that
    // has to cost nothing — and a write is the only expensive thing left in it.
    // Rewriting the same mark five and a half thousand times a day would be a
    // state file whose modification time says the opposite of what it means.
    if (seen !== null && seen.window === next.window && seen.state === next.state) return

    try {
      await memory.remember(formatMark(next))
    } catch (error) {
      // `info`, AND THIS IS THE LINE THE OWNER ACTUALLY SAW. It fires once per
      // state change, so an unwritable state directory put three warns into
      // #bot-status over one drain cycle — a running commentary on the window he
      // was already reading about in #maintenance-notifications, which is the
      // complaint. The consequence is bounded and small: the mark is advanced in
      // memory above, so a failed write costs at most ONE repeated notice, and
      // only if the process restarts before the next transition.
      log('info', 'could not record the maintenance state, a restart may re-announce it', { error })
    }
  }

  return {
    check: () => check(),
    stopped: () => !usable,
  }
}

/**
 * Wire the watcher to the gateway coming up.
 *
 * `clientReady` IS THE EARLIEST POINT THERE IS A CHANNEL TO POST TO, and
 * `once`, because a reconnect is not a restart — a second interval on the same
 * client would double every read and race two posts of the same notice.
 *
 * THE FIRST POLL RUNS IMMEDIATELY AND IS ALWAYS SILENT. It is what establishes
 * the baseline: either the mark off disk matches the window in front of it, in
 * which case nothing has moved, or it does not, in which case this is a window
 * the bot did not see begin and will say nothing about. Waiting fifteen seconds
 * to do that would only delay the point from which a real transition is visible.
 *
 * `unref` FOR THE REASON EVERY OTHER TIMER IN THIS BOT IS UNREFFED: a poll
 * loop is not a reason for `systemctl stop` to sit through its timeout.
 *
 * ONE POLL AT A TIME. The read carries a two-second deadline and the post is a
 * Discord request, so a tick CAN outlast the interval — and two overlapping
 * checks would both read the same transition before either had advanced the
 * mark, and post it twice.
 *
 * `Pick<Ddb, 'maintenance'>`, AND IT IS BACK TO ONE MEMBER. It briefly held
 * `players` as well, to turn the initiator's licence into a Discord tag for the
 * going-down notice; nobody is named in the notice that survives, so the second
 * read went with it. The bans, the audit log and the bot's own state table are
 * all absent from the pick, so a later edit of this file cannot reach one however
 * it is written.
 */
export function watchMaintenance(
  client: Client,
  channelId: string,
  ddb: Pick<Ddb, 'maintenance'>,
  options: {
    intervalMs?: number
    memory?: MaintenanceMemory
    /** See `MaintenanceWatchOptions.serverIps`. Pass `config.serverIps` here. */
    serverIps?: readonly string[]
    now?: () => number
  } = {},
): void {
  const watch = maintenanceWatch({
    read: () => ddb.maintenance.current(),
    post: maintenancePoster(client, channelId),
    memory: options.memory,
    serverIps: options.serverIps,
    now: options.now,
  })

  client.once(Events.ClientReady, () => {
    let running = false

    function tick(): void {
      if (running) return
      running = true

      // `check` never rejects, and the `finally` is the structural guarantee
      // that a future edit which makes it reject cannot latch `running` on and
      // stop the poll loop for the life of the process.
      void watch.check().finally(() => {
        running = false
      })
    }

    const timer = setInterval(() => {
      if (watch.stopped()) {
        clearInterval(timer)
        return
      }

      tick()
    }, options.intervalMs ?? MAINTENANCE_POLL_MS)

    timer.unref()

    // Through the same guard as every later poll, so the baseline read cannot
    // still be in flight when the first interval fires on top of it.
    tick()
  })
}
