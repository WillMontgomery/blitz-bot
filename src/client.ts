import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  AuditLogEvent,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Partials,
  RESTJSONErrorCodes,
  type APIEmbed,
  type Guild,
  type GuildAuditLogsEntry,
  type SendableChannels,
} from 'discord.js'

import { installGameBanRole } from './banrole.ts'
import type { Config } from './config.ts'
import {
  createDdb,
  isBanActive,
  qualifyId,
  type Actor,
  type AuditHandle,
  type AuditInput,
  type Ban,
  type BanIssueOutcome,
  type Ddb,
  type DdbFailure,
  type DdbResult,
} from './ddb.ts'
import { installIncidentLog } from './incidents.ts'
import { scanMessage, type InviteResolver, type ScanResult } from './invites.ts'
import { latch } from './latch.ts'
import { scanLinks, type LinkReason } from './links.ts'
import { log, type Level, type Sink } from './log.ts'
import { watchMaintenance } from './maintenance.ts'
import { createRingmaster, KICK_TTL_MS, type KickResult, type Ringmaster } from './ringmaster.ts'
import { installStickies } from './sticky.ts'

/**
 * The bot: the discord.js client, and the decision it makes about a message.
 *
 * SPLIT THE WAY invites.ts IS SPLIT, for the same reason. `decide` is a
 * function of a plain record, the config and a resolver, and it returns what
 * ought to happen without doing any of it. `createClient` is the half that
 * touches discord.js, and all it does is turn a `Message` into that record,
 * hand `decide` the answer, and carry the verdict out. Every branch that
 * matters — every exemption, dry run, a delete that fails — is therefore
 * exercised offline against objects built three lines above the assertion,
 * rather than against a live guild that would have to be spammed on purpose.
 *
 * `MessageContent` IS A PRIVILEGED INTENT AND MUST BE TICKED ON IN THE DISCORD
 * DEVELOPER PORTAL (your app -> Bot -> Privileged Gateway Intents). The
 * signature of getting it wrong is a RESTART LOOP, not a quiet bot: discord.js
 * sends the intent in its identify, the gateway rejects the identify outright
 * and closes the websocket with code 4014 (Disallowed intent), `client.login()`
 * rejects, and index.ts logs `login failed` and exits non-zero for systemd to
 * start again. So the evidence is `code=4014` on the `gateway disconnected`
 * line and a unit that never reaches `msg="ready"`.
 *
 * (This comment used to claim the opposite — a bot that connects, logs a
 * healthy `ready` and sees every `message.content` as the empty string. That
 * describes no version of discord.js v14, and it sent anyone debugging a
 * restart loop off to read the regex in invites.ts instead of the close code
 * already in their journal.)
 *
 * THE GATEWAY LIFECYCLE IS LOGGED FOR THE SAME REASON. A bot that has silently
 * lost its websocket looks exactly like a bot with nothing to do: the process
 * is up, systemd is happy, the journal is quiet. The disconnect and reconnect
 * lines are the only thing that tells those two apart from the outside, which
 * is why they are warnings and not debug.
 *
 * THE BOT TALKS TO A MEMBER IN EXACTLY ONE CASE: ITS OWN REMOVAL OF THEIR
 * MESSAGE. This file used to say it never did, and that was the standing
 * instruction until the owner replaced it. The instruction now is that a poster
 * is told their message was removed and WHICH RULE removed it — by DM, or, if
 * the DM bounces, by a line in the channel that tags them and is taken back down
 * about half a minute later. See `notifier` and `noticeChannel`.
 *
 * EVERYTHING ELSE ABOUT THAT RULE IS UNCHANGED. It is still the case that no
 * removal is announced to the guild at large, that nothing quotes the text that
 * matched, and that the RECORD of a removal is the journal line plus — if
 * `BLITZ_LOG_CHANNEL_ID` is set — one factual line in a channel admins read.
 * The notice is a courtesy to one person; it is not evidence and nothing reads
 * it back.
 *
 * THE WORDS ARE THE OWNER'S AND THIS PARAGRAPH USED TO SAY THEY WERE NOT. It
 * read "THE WORDS THEMSELVES ARE NOT WRITTEN YET AND ARE A MARKED PLACEHOLDER —
 * see `NOTICE_PLACEHOLDER`", and there has been no `NOTICE_PLACEHOLDER` since he
 * supplied the six sentences in `COPY`. A header that says the copy is a draft,
 * over copy that is not, is the drift a comment convention costs — worth naming
 * here, because it is the argument against marking a string in prose and the
 * reason `scripts/check-placeholders.ts` prints the list to the one person who
 * can tell it is stale. The one string in this file still awaiting wording is
 * `BAN_REASON_UNWRITTEN`, and it is tagged where it is declared.
 */

/**
 * The kill switch, and the one piece of state in this file.
 *
 * WHY A LATCH AND NOT A LOG LINE. `config.guildId` is the ONLY thing that
 * separates "our invite, leave it" from "somebody else's invite, delete it".
 * A mistyped `DISCORD_GUILD_ID` therefore does not make the bot do nothing —
 * it makes the bot delete OUR OWN invites, every time anyone posts one, in the
 * guild it is actually sitting in. The startup check used to notice exactly
 * that condition, write one `error` line and `return`, leaving the message
 * listener armed and deleting. An error line in a journal nobody is tailing is
 * not a safety mechanism; it is a note left next to the thing still happening.
 *
 * SET ONCE, NEVER CLEARED. There is no `resume`, because every route back to
 * moderating passes through fixing the environment and restarting the unit,
 * which is the thing that has to happen anyway. `decide` reads it first, which
 * puts it in front of the one function in this file that can yield `delete`;
 * `handleLive` reads it too, so a halted bot spends no API call either. That
 * second read is worth exactly one thing — the fetch under a partial edit,
 * which happens ABOVE the decision and is the only request a halted bot could
 * still make — so it is the thing its test asserts. Deleting the check leaves
 * every other test in the repo green.
 */
let halted = false

export function haltModeration(reason: string, fields: Record<string, unknown> = {}): void {
  halted = true
  log('error', `moderation halted, nothing will be scanned or deleted: ${reason}`, fields)
}

/**
 * Everything the decision needs about a message, and nothing else.
 *
 * A PLAIN RECORD RATHER THAN discord.js's `Message`. `Message` is a live object
 * with a client, a REST handle and a `delete()` on it, and taking one as a
 * parameter would mean every test either constructs one or mocks a class with a
 * hundred members. More importantly it would put a deletion inside arm's reach
 * of the decision, and keeping those two apart is the point of the file.
 */
export interface ScannedMessage {
  /**
   * EVERY PIECE OF TEXT THE MESSAGE CARRIES, not `message.content`.
   *
   * It used to be `message.content` alone, and that left two holes wide enough
   * to walk an advert through: an invite in an embed (any bot or webhook post)
   * arrives with `content` empty, and a FORWARDED message keeps the original
   * text in `messageSnapshots` and leaves `content` empty as well. Both looked
   * like a blank message and were left standing. `scanText` builds this.
   */
  readonly text: string

  readonly authorId: string

  /**
   * The author's Discord username, or null when the payload did not carry one.
   *
   * `username` AND NOT `globalName`, `displayName` OR `tag`. discord.js 14.27
   * offers all four and they are not equally good in a record that is read
   * weeks later. `globalName` is a vanity string its owner can change between
   * posting the advert and anyone reading about it, and it is not unique — two
   * accounts can carry the same one, which is how an impersonator ends up
   * named in a moderation log as somebody else. `displayName` is
   * `globalName ?? username`, so it inherits that. `tag` is `username` for
   * every migrated account and `username#1234` only for the legacy ones, so it
   * is the same string as `username` most of the time and a differently shaped
   * one the rest of the time. `username` is the unique handle: stable, one per
   * account, and the thing an admin can actually type into Discord's search.
   *
   * WHY IT IS CARRIED AT ALL, when `authorId` is already here: see
   * `authorRef`. A mention is not a durable record.
   */
  readonly authorUsername: string | null

  readonly channelId: string

  /** Null in a DM. The one signal that says this did not happen in a guild. */
  readonly guildId: string | null

  /**
   * The webhook that posted this, or null for an ordinary member or bot user.
   *
   * A WEBHOOK CAN NEVER HOLD A ROLE, so it can never be exempt, and it is the
   * one author for which `authorRoleIds === null` is a fact rather than a gap
   * in what we could read. Without this field the two are indistinguishable and
   * the admin exemption's "unreadable roles skip" rule hands every webhook a
   * free pass — which is a bypass anyone with Manage Webhooks can use.
   */
  readonly webhookId: string | null

  /** Was this posted by the bot itself? */
  readonly fromSelf: boolean

  /**
   * The author's role ids as they arrived on the payload, or null when the
   * payload did not carry them.
   *
   * NULL AND `[]` ARE DIFFERENT ANSWERS and the distinction decides what happens
   * next. `[]` means Discord told us this author holds no roles; null means the
   * message arrived without a member on it and we have not asked yet. Collapsing
   * them would make an unreadable member look like an ordinary one — but null is
   * a reason to go and ASK (`RoleLookup`), never a reason to stop scanning; see
   * `decide`.
   */
  readonly authorRoleIds: readonly string[] | null
}

/**
 * Go and find out an author's roles when the payload did not carry them, or
 * answer null if that cannot be done either.
 *
 * INJECTED, LIKE `InviteResolver`, so `decide` stays a function of a record and
 * two lookups and every branch below can be driven offline. The live one is
 * `memberRoles`, which fetches the member from the guild.
 *
 * NULL MEANS "STILL DO NOT KNOW", AND THE CALLER SCANS ON IT. That is the whole
 * direction of this type: it is not permission to skip.
 */
export type RoleLookup = (authorId: string) => Promise<readonly string[] | null>

/**
 * What `decide` uses when a caller brings no lookup: an honest "cannot ask".
 *
 * SAFE TO FORGET, BY CONSTRUCTION. A caller that omits the lookup gets an
 * answer of null, and null makes `decide` scan — so the cost of not wiring this
 * up is that an admin's post can be scanned, never that anybody's post is
 * skipped. A default that guessed the other way would make a missing wire a
 * silent bypass, which is the bug this whole parameter exists to fix.
 */
const CANNOT_ASK: RoleLookup = () => Promise.resolve(null)

/** Why a message was not scanned at all. */
export type SkipReason =
  | 'moderation-halted'
  | 'own-message'
  | 'direct-message'
  | 'other-guild'
  | 'exempt-channel'
  | 'exempt-admin'

/**
 * Why a message is being removed. Six grounds, and they are not all the same
 * kind of statement, so nothing downstream may present them as one.
 *
 * `foreign-invite` is evidence about a specific invite: a code was resolved, and
 * the guild it points at is not ours.
 *
 * `over-lookup-cap` is the opposite — it says we do NOT know what the codes past
 * the cap were, and that is precisely why it is grounds to act. An admin reading
 * the log has to be able to tell the two apart, because only the first one names
 * an invite that was actually confirmed.
 *
 * THE OTHER FOUR COME FROM src/links.ts AND ARE A THIRD KIND AGAIN: each of them
 * is a string that was literally in the message, established without asking
 * anybody anything. They are not folded into one `bad-link` reason, because the
 * whole point of a reason is that the channel line and the journal line say
 * WHICH RULE FIRED — an admin who reads `link-shortener` knows the bot never saw
 * the destination, and one who reads `fivem-connect` knows it did.
 */
export type DeleteReason = 'foreign-invite' | 'over-lookup-cap' | LinkReason

/**
 * What a removal carries, which depends on what kind of thing established it.
 *
 * A UNION RATHER THAN ONE RECORD WITH EMPTY FIELDS ON THE LINK BRANCH, and it is
 * the same argument this file already makes about `over-lookup-cap` not being a
 * `foreign-invite` with an empty list. A link removal happens BEFORE any invite
 * is resolved — before `scanMessage` runs at all, see `decide` — so `found: 0`
 * would not be a tidy default, it would be a claim that the message carried no
 * invite codes, made by code that never looked. The union makes that claim
 * impossible to print by accident.
 *
 * `found` IS THE COUNT OF DISTINCT CODES IN THE MESSAGE, not the length of
 * `foreign`. It is the only evidence an `over-lookup-cap` removal has: `foreign`
 * is empty on one of those whenever the codes that would have filled it are the
 * ones that fell past the cap, which is the whole shape of the attack.
 */
interface InviteRemoval {
  why: 'foreign-invite' | 'over-lookup-cap'
  found: number
  foreign: string[]
  unresolved: string[]
}

/**
 * A link removal carries the reason and NOTHING ELSE, and the emptiness is the
 * design. links.ts does not hand back the text that matched — every one of its
 * rules matches a working link, and the log channel is inside the guild, so a
 * line quoting the match would repost the advert the bot has just removed. That
 * is this file's existing rule about bare invite codes, arrived at from the
 * other direction; see `removedLine`.
 */
interface LinkRemoval {
  why: LinkReason
}

type Removal = InviteRemoval | LinkRemoval

/**
 * What should happen to one message.
 *
 * `delete` IS THE ONLY VERDICT THAT REMOVES ANYTHING, AND `decide` IS THE ONLY
 * THING THAT PRODUCES IT. That is the whole dry-run guarantee stated as a type:
 * one function — `removal` below — builds every verdict that can remove
 * anything, its `delete` sits behind `!config.dryRun`, and it can be read in one
 * screen. It became a function the moment a SECOND grounds for removal was added
 * (see the truncation check in `decide`): two copies of that ternary would be
 * two places for a later edit to get the flag wrong, and the copy nobody thinks
 * to check is the one that deletes in a dry run. Compare a boolean threaded down
 * into the executor next to the `.delete()` call, which is the obvious
 * alternative and was rejected — it puts the flag and the irreversible operation
 * in the same place, where an early return or a reordered condition during some
 * later edit deletes messages on a box the owner believes is only watching.
 */
export type Verdict =
  | { action: 'skip'; why: SkipReason }
  | { action: 'leave'; codes: string[]; unresolved: string[] }
  | ({ action: 'delete' } & Removal)
  | ({ action: 'would-delete' } & Removal)

/**
 * Decide what to do with a message. Does nothing; says what should be done.
 *
 * THE CHEAP EXCLUSIONS COME FIRST, and that ordering is a rate-limit decision
 * rather than a style one. Everything above the scan is a string comparison
 * against data already in hand; the scan below it can fire one Discord lookup
 * per distinct code in the message. A spam wave in an exempt channel therefore
 * costs nothing, which is the case where that matters most.
 *
 * WE ONLY MODERATE ONE GUILD, AND IT IS `config.guildId`. This was missing and
 * it was the worst bug in the file: the DM check below was the only thing
 * asking where a message came from, so in ANY other server the bot was in — a
 * test server, a friend's, one it was added to years ago — that server's own
 * invite resolved to a guild that was not `config.guildId`, came back
 * `foreign`, and was deleted. The check sits above the scan so a busy foreign
 * guild costs zero API calls as well as zero deletions.
 *
 * ONLY THE BOT'S OWN MESSAGES ARE EXEMPT, NOT EVERY BOT. The obvious form of
 * this check is `message.author.bot`, and it is wrong here: a webhook or a
 * compromised integration posting an invite is precisely what this exists to
 * remove, and exempting the whole class hands anyone with the Manage Webhooks
 * permission a way around it. Our own messages are excluded because the removal
 * line posted to the log channel would otherwise be scanned as a new message.
 * (It would not match — the line carries bare codes, never a link — but relying
 * on that would be relying on the wording of a log line.)
 *
 * AN UNREADABLE MEMBER IS ASKED ABOUT, AND SCANNED IF THE ANSWER DOES NOT COME.
 * REGRESSION, AND IT WAS THE DEFAULT POSTURE OF THE BOT. This used to read
 * `if (message.authorRoleIds === null) return skip 'roles-unknown'`, and
 * `authorRoleIds` is null whenever the gateway payload arrived without a member
 * attached — which it does routinely, because `createClient` does not request
 * the `GuildMembers` intent and the member therefore comes along only
 * opportunistically. `BLITZ_EXEMPT_ADMINS` defaults to true, so with an admin
 * role configured the shipped default was: any message whose member object did
 * not turn up was never scanned at all. That is a moderation filter failing
 * OPEN, and a filter that fails open is not a filter — it is a bypass anyone
 * gets for free, without permissions, without knowing it exists.
 *
 * SO THE MISSING ROLES ARE FETCHED, AND A FETCH THAT FAILS SCANS. The two
 * mistakes are not the same size. Scanning an admin's message costs one member
 * lookup and, in the worst case, one wrongly deleted admin post — visible,
 * recoverable by the human who wrote it, and loud in the log channel. Skipping
 * costs a guaranteed, silent, permanent bypass for everybody. invites.ts's rule
 * that ambiguity falls towards not deleting is about an invite code Discord
 * would not answer for; it was never a licence to stop looking at the message.
 *
 * A WEBHOOK IS NOT AMBIGUOUS, THOUGH, and that exception is load-bearing — it
 * is also the reason no member is fetched for one. A webhook has no member
 * object, so its roles read as null, and under the old rule that skipped it:
 * from the moment `DISCORD_ADMIN_ROLE_ID` was set, every webhook post in the
 * guild went unscanned. Webhooks cannot hold roles, so nothing about them is
 * unknown and there is nothing to go and ask: they are scanned, always.
 *
 * THE FETCH SITS INSIDE THE EXEMPTION GUARD, WHICH IS A RATE-LIMIT DECISION.
 * With `BLITZ_EXEMPT_ADMINS` off or `DISCORD_ADMIN_ROLE_ID` unset there is
 * nothing an author's roles could change, so nothing is asked and a spam wave
 * costs no member lookups at all.
 */
export async function decide(
  message: ScannedMessage,
  config: Config,
  resolve: InviteResolver,
  fetchRoles: RoleLookup = CANNOT_ASK,
): Promise<Verdict> {
  if (halted) return { action: 'skip', why: 'moderation-halted' }

  if (message.fromSelf) return { action: 'skip', why: 'own-message' }

  // A DM cannot be moderated — there is no message in the guild to remove, and
  // the bot has no business acting on a private conversation in any case.
  if (message.guildId === null) return { action: 'skip', why: 'direct-message' }

  // Somebody else's server. Not ours to police, and `config.guildId` would be
  // the wrong yardstick there anyway: it would mark their own invites foreign.
  if (message.guildId !== config.guildId) return { action: 'skip', why: 'other-guild' }

  // Threads carry their own id, so a thread under an exempt channel is NOT
  // exempt. Left that way deliberately: `BLITZ_EXEMPT_CHANNEL_IDS` names
  // channels, and quietly extending it to cover descendants would exempt places
  // the operator never listed. Revisit if the owner asks for the other rule.
  if (config.exemptChannelIds.includes(message.channelId)) {
    return { action: 'skip', why: 'exempt-channel' }
  }

  // `adminRoleId` unset disables the exemption outright rather than exempting
  // everybody or nobody by accident — matching what .env.example promises.
  // `webhookId === null` because a webhook is never a member and so is never
  // exempt; see the header above this function.
  if (config.exemptAdmins && config.adminRoleId !== null && message.webhookId === null) {
    // Null here is "the payload did not say", so ask. Null again is "we still
    // do not know", and the only safe reading of that is that this author is
    // not exempt — see the header. There is no branch out of this block that
    // stops the scan below.
    const roles = message.authorRoleIds ?? (await fetchRoles(message.authorId))

    if (roles !== null && roles.includes(config.adminRoleId)) {
      return { action: 'skip', why: 'exempt-admin' }
    }
  }

  /**
   * THE LINK POLICY RUNS BEFORE THE INVITE SCAN, AND THAT ORDER IS THE SAME
   * RATE-LIMIT DECISION THE EXEMPTIONS ABOVE ARE. `scanLinks` is pure string
   * matching over a string already in hand: no resolver, no cache, no network,
   * and nothing it can spend. `scanMessage` below can fire up to ten Discord
   * lookups. A message carrying a bare IP is going to be removed either way, so
   * resolving its invite codes first would be paying the API budget to learn
   * something that changes no verdict — and a wall of spam is exactly where that
   * budget matters, because every legitimate deletion queues behind it.
   *
   * SO A MESSAGE THAT BREAKS BOTH POLICIES REPORTS THE LINK RULE, and that is
   * not a loss of evidence. A link verdict is a string that was in the message;
   * a `foreign-invite` verdict is a string that was in the message plus an
   * answer from Discord about it. Neither is more certain than the other, and
   * only one of them costs anything to establish.
   */
  const link = scanLinks(message.text, config.serverIps)
  if (link !== null) return removal({ why: link }, config)

  const result = await scanMessage(message.text, config.guildId, resolve)

  // A confirmed foreign guild is tested first because it is the better-evidenced
  // of the two grounds: it names an invite Discord actually answered for. Both
  // can be true of one message, and that is the one worth putting in the log.
  if (result.foreign.length > 0) return removal(fromScan('foreign-invite', result), config)

  /**
   * REGRESSION, AND IT WAS A WORKING BYPASS. `scanMessage` resolves only the
   * first ten distinct codes in document order and reports the rest as
   * `truncated`; this function used to drop that flag on the floor. Nothing
   * outside invites.ts read it, and the `Verdict` union had nowhere to put it —
   * so ten junk codes followed by the real advert as the eleventh was a
   * removal-proof post. The junk resolved to nothing, the advert was never
   * looked at, `foreign` came back empty, and the message stood. The flag being
   * set, warned about and documented as "NOT A BYPASS" changed none of that: a
   * signal no caller consumes is a comment, not a mitigation.
   *
   * BEING OVER THE CAP IS ITSELF GROUNDS TO ACT. No honest message carries
   * eleven distinct invite codes — the loudest genuine advert anybody has posted
   * carries a handful — and nothing that deserves the benefit of the doubt gets
   * this far anyway: every exemption, the admin one included, sits above the
   * scan. The alternative is raising the cap, which moves the same bypass to a
   * larger number and pays for it out of the rate-limit budget the cap exists to
   * protect.
   *
   * IT IS ITS OWN REASON, NOT A `foreign-invite` WITH AN EMPTY LIST. What is
   * being said here is "we could not look", and an admin who reads this removal
   * as a confirmed foreign invite has been told something we never established.
   */
  if (result.truncated) return removal(fromScan('over-lookup-cap', result), config)

  // Unresolved codes are carried through rather than acted on. invites.ts is
  // the file that explains why an unresolved code is never a delete; this only
  // has to avoid quietly dropping the fact on the floor.
  return { action: 'leave', codes: result.codes, unresolved: result.unresolved }
}

/**
 * The one place a removing verdict is built, and therefore the one place
 * `dryRun` has to be read.
 *
 * EVERY NEW GROUNDS FOR REMOVAL GOES THROUGH HERE. That is what keeps the
 * dry-run guarantee a property of one line instead of a rule each new caller has
 * to remember; see the `Verdict` header.
 */
function removal(grounds: Removal, config: Config): Verdict {
  return config.dryRun ? { action: 'would-delete', ...grounds } : { action: 'delete', ...grounds }
}

/**
 * The evidence an invite-grounds removal carries, read off one scan.
 *
 * A SEPARATE FUNCTION FROM `removal` RATHER THAN A SECOND PARAMETER ON IT,
 * because `removal` is the one place `dryRun` is read and that has to stay
 * readable in one screen. This one knows about `ScanResult` and nothing about
 * the flag; that one knows about the flag and nothing about invites.
 */
function fromScan(why: InviteRemoval['why'], result: ScanResult): InviteRemoval {
  return {
    why,
    found: result.codes.length,
    foreign: result.foreign,
    unresolved: result.unresolved,
  }
}

/**
 * Everything the handler is allowed to reach outside itself: one lookup and two
 * side effects, all injected.
 *
 * `announce` IS NULL WHEN THERE IS NO LOG CHANNEL rather than a function that
 * quietly does nothing. The difference shows up in a test: a null says the
 * absence was decided at wiring time from `BLITZ_LOG_CHANNEL_ID`, where a
 * silent no-op is indistinguishable from a broken send.
 */
export interface Actions {
  resolve: InviteResolver

  /**
   * How to find out an author's roles when the payload did not carry them.
   *
   * REQUIRED RATHER THAN OPTIONAL, so wiring a new caller is a compile error
   * instead of a caller that silently never asks. `decide`'s own default is the
   * safe direction anyway — see `CANNOT_ASK` — but a field that can be left off
   * is a field that gets left off, and this one decides whether the admin
   * exemption swallows messages it cannot justify swallowing.
   */
  fetchRoles: RoleLookup

  remove: () => Promise<void>
  announce: ((line: string) => Promise<void>) | null

  /**
   * How the poster is told their message was removed, and which rule removed
   * it.
   *
   * REQUIRED AND NOT NULLABLE, unlike `announce`. A missing log channel is a
   * configured absence — the operator did not set `BLITZ_LOG_CHANNEL_ID` — so
   * `null` there says something true about the deployment. There is no
   * corresponding setting here: telling the poster is a standing instruction
   * and not a feature that can be off, so a nullable field would only ever be a
   * way for a caller to skip it by accident.
   *
   * IT NEVER REJECTS, AND `notifier` IS WHY. Every failure it can have — a
   * closed DM, a channel the bot cannot post in, a member who left — is handled
   * where it happens, so the delete path below can await it without a `try`
   * and without a reader wondering what a rejection here would cost.
   */
  notify: (why: DeleteReason) => Promise<void>
}

/**
 * Carry out the verdict for one message.
 *
 * DELETE FIRST, LOG SECOND, ANNOUNCE THIRD, and a failed delete stops at the
 * first step. The alternative ordering — announce, then delete — puts a line
 * in the admin channel claiming a removal that may not have happened, and an
 * admin who goes looking for a message the bot says it deleted and finds it
 * still there has been told a lie by their own tooling.
 *
 * NOTHING IN HERE IS ALLOWED TO THROW PAST THE CALLER. A delete fails routinely
 * and for dull reasons: the message was already removed by a human, the bot
 * lacks Manage Messages in that one channel, the channel was deleted mid-scan.
 * None of those is a reason to take down a process that is moderating a live
 * guild.
 */
export async function handleMessage(
  message: ScannedMessage,
  config: Config,
  actions: Actions,
): Promise<void> {
  const verdict = await decide(message, config, actions.resolve, actions.fetchRoles)
  const where = { author: message.authorId, channel: message.channelId }

  switch (verdict.action) {
    case 'skip':
      // Skips are silent. Logging one would put a line in the journal for every
      // message in an exempt channel and bury everything worth reading, and
      // every reason left in `SkipReason` is now a deliberate, configured
      // exclusion rather than something going wrong.
      //
      // There used to be a `roles-unknown` warning here, for the case where the
      // admin exemption swallowed a message it could not justify swallowing.
      // That case no longer skips — it fetches the member and scans if the
      // fetch does not answer — and the warning moved to `memberRoles`, which is
      // the half that knows the fetch failed and why.
      return

    case 'leave':
      // An expired or revoked invite is an unremarkable thing for a member to
      // post, so this is info and not a warning. It is recorded because a bot
      // that resolves NOTHING — a broken token, Discord degraded — produces
      // this line for every invite it sees, and that pattern is the only
      // warning anyone gets before invites start surviving.
      if (verdict.unresolved.length > 0) {
        log('info', 'invite codes did not resolve, message left alone', {
          ...where,
          codes: verdict.unresolved.join(','),
        })
      }
      return

    case 'would-delete':
      log('warn', `dry run: would have deleted ${CARRIED[verdict.why]}`, {
        ...where,
        ...logFields(verdict),
      })
      await postLine(actions.announce, dryRunLine(message, verdict))
      return

    case 'delete': {
      try {
        await actions.remove()
      } catch (error) {
        log('error', 'delete failed, message left standing', {
          ...where,
          ...logFields(verdict),
          error,
        })
        return
      }

      log('info', `deleted ${CARRIED[verdict.why]}`, { ...where, ...logFields(verdict) })
      await postLine(actions.announce, removedLine(message, verdict))

      // THE POSTER IS TOLD LAST, AND ONLY ON A REMOVAL THAT ACTUALLY HAPPENED.
      // It is last for the same reason the announce is after the delete: the
      // record comes before the courtesy, so a member is never told about a
      // removal the journal has no line for. It is inside this branch and not
      // shared with `would-delete` because a dry run deletes nothing — a DM
      // saying a message was removed, sent while the bot is only watching,
      // would be the bot lying to a member about its own behaviour.
      await actions.notify(verdict.why)
      return
    }
  }
}

/**
 * What the message was removed over, in the words of the log line.
 *
 * A LINE PER REASON RATHER THAN ONE LINE WITH A FIELD ON IT. "deleted message
 * carrying a foreign invite" is a false statement about an over-cap removal —
 * no foreign invite was ever confirmed on one — and a log that says it is a log
 * an admin cannot trust about the case they are least likely to expect.
 *
 * A `Record` keyed on the reason, like log.ts's priorities: a third reason is
 * then a compile error here rather than `undefined` printed mid-sentence.
 */
const CARRIED: Record<DeleteReason, string> = {
  'foreign-invite': 'message carrying a foreign invite',
  'over-lookup-cap': 'message carrying more distinct invite codes than the scan will resolve',
  'fivem-connect': 'message carrying a connect link to another game server',
  'server-listing': 'message carrying a public listing for another game server',
  'foreign-ip': 'message naming a server address that is not ours',
  'link-shortener': 'message carrying a shortened link, whose destination is not read',
}

/**
 * The fields every removal line carries, so the journal and the channel post
 * can be matched up by grepping one token.
 *
 * `codes` STAYS THE CONFIRMED-FOREIGN LIST ON BOTH INVITE REASONS, and is empty
 * on the over-cap removal that confirmed nothing. Filling it with the codes we
 * did not look at would put unexamined strings in the field the other line uses
 * for established ones — `found` and `reason` are what carry that case.
 *
 * A LINK REMOVAL PRINTS `reason` AND NOTHING ELSE, because there is nothing else
 * true about it. It is decided before `scanMessage` runs, so `found=0` would be
 * a count of invite codes in a message nothing ever counted, and `codes=""` an
 * empty list of confirmed invites that were never sought. A field that is a lie
 * in one case is worse than a field that is absent in it.
 */
function logFields(verdict: Removal): Record<string, unknown> {
  // THE FULLER BRANCH IS FIRST, AND THAT ORDER IS LOAD-BEARING RATHER THAN
  // STYLISTIC. log.test.ts reads the field list of a verdict-carrying journal
  // line out of the FIRST `return {` in this function and holds docs/deploy.md's
  // worked examples to it. A one-field branch in front of it would leave that
  // cross-check green while checking three fields fewer, which is the silent
  // weakening that whole mechanism exists to prevent.
  if ('found' in verdict) {
    return { reason: verdict.why, found: verdict.found, codes: verdict.foreign.join(',') }
  }

  return { reason: verdict.why }
}

/**
 * The line posted to the admin log channel.
 *
 * WHO, WHERE, WHY, WHICH CODES. Nothing else. It is a record for admins, not a
 * message about a member's behaviour, so there is no advice in it, no emoji and
 * nothing addressed to the poster.
 *
 * THE CODES ARE BARE, NEVER `discord.gg/x`. Reposting a working invite into the
 * guild in order to report that it was removed from the guild would be an
 * unusually direct way to defeat the whole bot.
 */
function removedLine(message: ScannedMessage, verdict: Removal): string {
  return `Removed a message. ${attribution(message)}, ${statedGrounds(verdict)}`
}

function dryRunLine(message: ScannedMessage, verdict: Removal): string {
  // Dry run posts too, and says so in the first three words. The flag exists so
  // the owner can watch what the bot WOULD do before letting it do anything; a
  // dry run that only writes to the journal makes that watching an SSH session
  // instead of a channel they are already in.
  return `Dry run, nothing removed. ${attribution(message)}, ${statedGrounds(verdict)}`
}

/**
 * The who-and-where half of both channel lines, built once.
 *
 * ONE FUNCTION FOR THE SAME REASON `statedGrounds` IS ONE FUNCTION. The two
 * lines above are the same record with a different first sentence, and the
 * removal line and the dry-run line drifting apart is not a cosmetic problem:
 * the dry-run line is the ONLY thing the owner reads while deciding whether to
 * let this bot delete anything, so a field that is right on one of them and
 * missing on the other is a decision made about a line that is not the line
 * that will ship. Anything added to the attribution is added to both by
 * construction, and neither builder can be edited alone.
 */
function attribution(message: ScannedMessage): string {
  return `Author ${authorRef(message)}, channel <#${message.channelId}>`
}

/**
 * How the author is named: a mention, and the username in plain text after it.
 *
 * THE CHANNEL WAS ALREADY `<#id>` AND THE AUTHOR WAS A BARE SNOWFLAKE — one
 * line, two conventions, and the half a human actually needs was the unreadable
 * one. `<@id>` renders as the account's name, so the line can be read without
 * anybody pasting an eighteen-digit number into a lookup.
 *
 * A MENTION IS NOT A DURABLE RECORD, WHICH IS WHY THE NAME IS HERE TOO. `<@id>`
 * is resolved by the reader's Discord client against the guild's member list,
 * so the moment that account leaves or is banned the mention renders as
 * `@unknown-user` — which is exactly when someone scrolls back to find out who
 * a removal was about. The plain-text username is the copy that survives that,
 * and it is the copy `grep` and Discord's own search can find. The raw id stays
 * recoverable either way: it is the digits inside the mention markup.
 *
 * THE NAME IS WRAPPED IN A CODE SPAN, AND THAT IS THE NEUTRALISER. A username
 * is text a stranger chose, interpolated into a message this bot posts, so
 * without something it is the poster who decides how our moderation log reads:
 * `**` `_` `~~` `|| ||` reformat the line, and a name is displayed next to
 * every message they have ever sent, so it is a surface they can prepare in
 * advance. Inside `` ` ` `` Discord renders every one of those literally and
 * linkifies nothing — so the name comes out EXACTLY as it was registered rather
 * than escaped or gutted, which matters because `_` and `.` are ordinary
 * characters in a real Discord username and stripping them would leave admins
 * searching for an account that does not exist. `plainName` removes the one
 * character that could close the span, and three others; see there.
 *
 * NOTHING HERE IS THE ANTI-PING MECHANISM. The mention is suppressed at the
 * send — `announcer` — because that is the only place that can make a promise
 * about notifications.
 */
function authorRef(message: ScannedMessage): string {
  const name = plainName(message.authorUsername)

  // No name, no parenthetical. An empty `()` would be one more thing in a line
  // that is read in a hurry, and it says nothing that the mention does not.
  return name === null ? `<@${message.authorId}>` : `<@${message.authorId}> (\`${name}\`)`
}

/**
 * How much of a username the record carries. Discord's own username limit.
 *
 * A CAP BECAUSE THE AUTHOR OF THIS STRING IS THE PERSON BEING MODERATED. A
 * webhook name may be eighty characters and a webhook post is precisely what
 * this bot exists to remove, so without a cap the offender chooses how much of
 * every one of our log lines is their text. The channel line has a 2000
 * character budget it must stay inside — see `statedGrounds` — and the name is
 * context, not the evidence.
 */
const NAME_CAP = 32

/**
 * A username reduced to something that cannot restructure the line it goes in.
 *
 * ONE LINE, ALWAYS. Every run of whitespace becomes a single space, because a
 * newline in the name does not merely look untidy: it moves the channel and the
 * grounds onto a second line that no longer says who they are about, and it
 * lets a poster produce something that reads like a whole second entry in the
 * moderation log.
 *
 * FOUR CHARACTERS ARE REMOVED, AND NONE OF THEM CAN OCCUR IN A REAL DISCORD
 * USERNAME (the charset is letters, digits, `_` and `.`), so this mangles
 * nothing legitimate — it is aimed at the names that are not usernames, chiefly
 * a webhook's, which is free text chosen by anybody holding Manage Webhooks.
 * A backtick would close the code span `authorRef` puts around the name and let
 * the rest of it out as markup. `@` is `@everyone` and `@here`. `<` opens every
 * piece of Discord entity markup there is — `<@id>`, `<@&role>`, `<#channel>` —
 * so without it a name can forge a mention of somebody who had nothing to do
 * with the message. `\p{C}` is everything invisible: control codes, zero-width
 * joiners, and the bidi overrides that reorder what a human reads without
 * changing a byte of what was stored.
 *
 * The suppression at the send makes the ping half of that moot, and this makes
 * it moot a second time, in the text itself, where it holds no matter what any
 * later caller does with the string.
 *
 * EMPTY IS THE SAME ANSWER AS ABSENT. A name that is nothing but the characters
 * above leaves an empty string, and printing `` (``) `` would be worse than
 * printing nothing at all.
 */
function plainName(username: string | null): string | null {
  if (username === null) return null

  const flattened = username.replace(/\s+/gu, ' ').replace(/[`@<\p{C}]/gu, '').trim()
  if (flattened === '') return null

  // Cut by code point, not by `slice`: a UTF-16 cut can land in the middle of a
  // surrogate pair and leave half a character in the record.
  const points = [...flattened]
  return points.length > NAME_CAP ? `${points.slice(0, NAME_CAP).join('')}…` : flattened
}

/**
 * The tail of the channel line: which of the two grounds this removal stands on.
 *
 * THE SAME TOKEN THE JOURNAL PUTS IN ITS `reason` FIELD, verbatim, so a line an
 * admin is looking at in the channel and the record of it in `journalctl` are
 * one `grep over-lookup-cap` apart. Without it the two removals are the same
 * sentence with different codes in it, and the one that confirmed nothing reads
 * exactly like the one that did.
 *
 * AN OVER-CAP LINE REPORTS THE COUNT AND NOT THE CODES, which is not brevity:
 * the codes are unexamined strings a stranger chose and there can be two hundred
 * of them, which is a wall of noise long enough to push the post past Discord's
 * 2000-character limit and fail the send outright.
 *
 * A LINK LINE IS THE REASON ALONE, AND THAT IS A SAFETY PROPERTY RATHER THAN A
 * STYLE ONE. The thing a link removal found is a WORKING LINK — an address, a
 * cfx code, a `fivem://` target, a shortened url — and this string is posted
 * into the guild the message was removed from. Quoting it would repost the
 * advert, which is the same reason the invite lines carry bare codes and never
 * `discord.gg/x`. links.ts does not even hand the text back, so there is nothing
 * here to leak; this branch exists to say that the omission is deliberate.
 */
function statedGrounds(verdict: Removal): string {
  if (!('found' in verdict)) return `reason: ${verdict.why}`

  return verdict.why === 'over-lookup-cap'
    ? `reason: ${verdict.why}, distinct invite codes: ${verdict.found}`
    : `reason: ${verdict.why}, invite codes: ${verdict.foreign.join(', ')}`
}

/** Post to the log channel if there is one. A failure here is never fatal. */
async function postLine(
  post: ((line: string) => Promise<void>) | null,
  line: string,
): Promise<void> {
  if (post === null) return

  try {
    await post(line)
  } catch (error) {
    // The removal already happened and is already in the journal. Losing the
    // channel copy is a nuisance; throwing here would lose the handler.
    log('error', 'could not post to the log channel', { error })
  }
}

/**
 * ============================================================================
 * WHAT THE POSTER IS TOLD. THE WORDING IS THE OWNER'S.
 * ============================================================================
 *
 * THIS HEADING SAID THE OPPOSITE FOR WEEKS AFTER IT STOPPED BEING TRUE. It read
 * "PLACEHOLDER — THE OWNER SUPPLIES THIS WORDING. NONE OF THESE STRINGS ARE THE
 * FINAL TEXT AND NONE MAY SHIP AS IF THEY WERE", over six sentences he had
 * supplied and a test one file over asserting that not one of them says
 * PLACEHOLDER. Anybody auditing what this bot says to members had to choose
 * which of the two to believe. It is corrected rather than deleted because it is
 * the case FOR `scripts/check-placeholders.ts` printing its list to the owner:
 * no static check can see a marker that outlived its draft, and he can, at a
 * glance, because he wrote the sentence.
 *
 * EVERYTHING AROUND THEM IS DECIDED AND TESTED — which rule fired, how it is
 * delivered, when the fallback is taken down.
 *
 * ONE RECORD, EXPORTED, AND THAT IS THE POINT RATHER THAN THE TIDINESS.
 * src/commands/sticky.ts is the worked example of getting this wrong: its tests
 * asserted FRAGMENTS OF THE PLACEHOLDER PROSE, and nine of them broke the
 * moment the real wording arrived — so the person pasting the owner's text in
 * spent the afternoon editing assertions instead of reading them. A test that
 * says `toContain(COPY['foreign-ip'])` pins WHICH message fired and survives
 * any rewrite of what it says. A test that says `toContain('shortened link')`
 * pins the draft, and it is the assertion that gets deleted rather than updated.
 *
 * A STRING PER REASON RATHER THAN ONE FOR ALL SIX, WHICH REVERSES WHAT THIS WAS.
 * It used to be a single placeholder with `(rule: <why>)` appended, on the
 * argument that a poster is told one thing and six wordings would be six things
 * to keep in step. But the standing instruction is that a poster is told WHICH
 * RULE fired, and six rules the owner may well want to word six different ways
 * — an invite to another Discord is not the same conversation as a shortened
 * link — is exactly the shape a copy record exists for. The frame is what stops
 * them drifting: it is one sentence, written once, and every reason goes
 * through it.
 *
 * THE RULE TOKEN SURVIVES ANY REWRITE, AND IT IS THE ONE THING THE FINAL
 * WORDING MAY NOT DROP. `why` is the same token the journal line and the admin
 * channel line carry, so a member quoting their notice and an admin reading the
 * log are looking at the same word rather than at two descriptions. The frame
 * is where it is put, and the tests hold a rewrite to it.
 *
 * NOTHING FROM THE MESSAGE IS QUOTED BACK. Every rule that can fire here
 * matched a WORKING link — an address, a cfx code, a `fivem://` target, a
 * shortened url — and the fallback posts into the very channel the message was
 * removed from, so quoting the match would repost the advert the bot has just
 * taken down. links.ts does not hand the text back at all, so there is nothing
 * here to interpolate even if a wording asked for it; these strings name the
 * reason and never the match, and a rewrite must keep it that way.
 *
 * `satisfies` RATHER THAN A TYPE ANNOTATION. A seventh `DeleteReason` is then a
 * compile error here — the same guarantee `CARRIED` above gets from its
 * `Record` — while `COPY['foreign-ip']` stays the literal string a test can
 * compare against instead of widening to `string`.
 */
export const COPY = {
  /**
   * The sentence wrapped around whichever reason fired, and the ONLY place the
   * rule token is put. One frame rather than six means a rewrite cannot leave
   * five notices carrying the token and one not.
   */
  frame: (reason: string, why: DeleteReason) =>
    `Your message was removed. ${reason} If that's wrong, tell an admin. (rule: ${why})`,

  'foreign-invite': 'It contained an invite to another Discord server.',
  'over-lookup-cap': 'It contained too many invite links to check.',
  'fivem-connect': 'It contained a connect link to another game server.',
  'server-listing': 'It contained a link to another FiveM server.',
  'foreign-ip': 'It contained an IP address. Four numbers separated by dots will trigger this, even in a file name or a version number.',
  'link-shortener': "It contained a shortened link, which we don't allow because the destination is hidden.",
} satisfies Record<DeleteReason, string> & {
  frame: (reason: string, why: DeleteReason) => string
}

/** The notice for one removal, in whatever words are in force. */
export function removalNotice(why: DeleteReason): string {
  return COPY.frame(COPY[why], why)
}

/**
 * How long the channel fallback stands before the bot takes it down again.
 *
 * ABOUT HALF A MINUTE, WHICH IS THE INSTRUCTION. Long enough that a member who
 * is looking at the channel — and they are, they just posted in it — sees the
 * ping; short enough that the channel is not left with a permanent public note
 * about somebody's deleted message. The fallback is a courtesy, not a record;
 * the record is the journal line and the admin channel.
 */
const NOTICE_TTL_MS = 30_000

/**
 * The two ways a poster can be reached, as a seam.
 *
 * A SEAM RATHER THAN A discord.js CALL INSIDE `handleMessage`, for the reason
 * `remove` and `announce` are already seams: this file's whole split is that
 * the decision and the carrying-out are testable without a live guild, and a
 * notice that DMs a real user on a real gateway is exactly the sort of side
 * effect that otherwise only gets exercised in production.
 *
 * `dm` REJECTS RATHER THAN RETURNING FALSE, and that is not a style choice.
 * There is no in-band answer to "the DM bounced": discord.js throws a
 * `DiscordAPIError` with code 50007 when the recipient does not accept DMs from
 * the server, and throws differently again for a user that cannot be fetched.
 * Making the seam reject means the fallback is driven by the same event the
 * real client produces, rather than by a boolean somebody has to remember to
 * return.
 *
 * `fallback` TAKES THE AUTHOR ID AS WELL AS THE TEXT because the mention has to
 * be allowed at the send — see `noticeChannel`. A function that only saw the
 * finished string could put `<@id>` in a message and have no way to make it
 * notify the person it names.
 */
export interface NoticeChannel {
  dm: (userId: string, text: string) => Promise<void>
  fallback: (channelId: string, userId: string, text: string) => Promise<void>
}

/**
 * Whether a failed DM means the poster cannot be DMed AT ALL, rather than the
 * send having gone wrong this time.
 *
 * THE FALLBACK IS SPENT ON A BOUNCE AND ON NOTHING ELSE, AND THAT DISTINCTION IS
 * THE WHOLE OF THIS FUNCTION. This used to treat every rejection out of `dm` as
 * a bounce, on the reasoning that a user who cannot be fetched and a user who
 * will not accept the message are the same outcome for the poster. They are not
 * the same outcome for the CHANNEL: a 429 or a 500 is a DM that would have
 * landed a second later, and answering one with a public note about somebody's
 * deleted message — tagging them, in the channel they posted in — is a cost
 * paid on Discord having a bad minute. There is no third state to represent,
 * either; the notice is a courtesy, so a transient failure is simply a courtesy
 * that did not get done, and the removal is recorded twice over regardless.
 *
 * TWO CODES, AND THEY ARE THE SAME ANSWER SPELLED TWICE. 50007 is what Discord
 * returns when a member has "allow direct messages from server members" off,
 * which is the common case this fallback was built for. 50278 is the same
 * sentence for a member the bot shares no guild with — it can arrive when
 * somebody leaves between the removal and the notice. Both are permanent for
 * this send: no retry, no later attempt and no other route reaches them, which
 * is precisely what makes the channel worth spending.
 *
 * EVERYTHING ELSE FALLS THE OTHER WAY, INCLUDING WHAT WE HAVE NOT SEEN. An
 * unrecognised failure is not known to be permanent, and the closed direction
 * for a public post about a member is not to make it. The cost is one member
 * occasionally not told; the cost of the other default is the channel filling
 * with notes every time the API wobbles.
 */
function dmsAreShut(error: unknown): boolean {
  if (!(error instanceof DiscordAPIError)) return false

  return (
    error.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser ||
    error.code === RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds
  )
}

/**
 * How long one poster stays told before another removal earns them a second
 * notice.
 *
 * A SPAM WAVE IS ONE PERSON POSTING TWENTY TIMES, AND IT MUST NOT BE TWENTY DM
 * OPENS. Opening a DM channel is one of the more expensive things this bot can
 * ask Discord for and it is rate-limited per recipient, so the burst that most
 * needs the removals to keep landing is exactly the burst that would queue every
 * delete behind a courtesy note. Worse on the fallback path: twenty pings in the
 * channel, each standing half a minute, is the bot doing more damage to the
 * channel than the adverts did.
 *
 * A MINUTE, WHICH IS `ROLE_TTL_MS` AND FOR A RELATED REASON — it is long enough
 * to flatten a raid and short enough that nobody moderated twice in an evening
 * goes unexplained. A continuing wave still earns a notice once a window rather
 * than never: the window is not refreshed by a suppressed removal, so somebody
 * spamming for five minutes is told five times, not silently ignored.
 *
 * COALESCED, NOT QUEUED, AND THE FIRST REASON IS THE ONE SENT. The suppressed
 * removals are still deleted, still logged, and still posted to the admin
 * channel — the record is unaffected. What is dropped is the second through
 * twentieth copy of "your message was removed" to somebody who is at that moment
 * watching their messages disappear.
 */
const NOTICE_COOLDOWN_MS = 60_000

/** How many posters the window remembers before the oldest is dropped. */
const NOTICE_MAX_ENTRIES = 500

/**
 * Who has been told lately, per `NoticeChannel`.
 *
 * KEYED ON THE SEAM RATHER THAN HELD AS ONE MODULE-LEVEL MAP, which is the
 * `roleCaches` pattern above and is here for both of its reasons. In the process
 * there is exactly one `NoticeChannel` — `createClient` builds it once — so the
 * window is process-wide in practice. In a test each fake seam is its own
 * object, so no case can be made to pass or fail by what an earlier one did to a
 * shared table, and there is no reset anybody has to remember to call.
 *
 * A `WeakMap`, so a seam that goes out of scope takes its table with it, and the
 * table itself is bounded — the keys are ids a stranger chose by posting, and
 * unbounded is a memory leak anybody can drive.
 */
const noticed = new WeakMap<NoticeChannel, Map<string, number>>()

function noticedVia(notices: NoticeChannel): Map<string, number> {
  const existing = noticed.get(notices)
  if (existing !== undefined) return existing

  const created = new Map<string, number>()
  noticed.set(notices, created)
  return created
}

/**
 * Whether this poster is due a notice, recording the attempt if they are.
 *
 * THE ATTEMPT IS WHAT IS RECORDED, NOT THE DELIVERY, because the attempt is what
 * costs. A DM that bounces has already spent the request, and a bounce is a
 * SETTING rather than a transient — so the twenty messages after it would each
 * bounce in turn and each spend a channel post. Marking before the send is what
 * makes the bound hold on the path that needs it most.
 */
function noticeIsDue(notices: NoticeChannel, authorId: string): boolean {
  const seen = noticedVia(notices)
  const now = Date.now()
  const told = seen.get(authorId)

  if (told !== undefined && now - told < NOTICE_COOLDOWN_MS) return false

  // Delete before set so a re-told author moves to the END of the Map's
  // insertion order, or eviction could drop the entry just written. Same idiom,
  // same reason, as `remember` below.
  seen.delete(authorId)
  seen.set(authorId, now)

  while (seen.size > NOTICE_MAX_ENTRIES) {
    const oldest = seen.keys().next()
    // Only reachable on an empty Map, which the loop condition has ruled out.
    if (oldest.done === true) break
    seen.delete(oldest.value)
  }

  return true
}

/**
 * Tell one poster their message was removed, and which rule removed it.
 *
 * DM FIRST, CHANNEL SECOND, AND THE CHANNEL ONLY WHEN THE DM BOUNCES. A DM is
 * the version of this that costs nobody else anything: the member finds out,
 * and the channel they posted in is not given a public note about them. The
 * fallback exists because a member with DMs closed to server members is the
 * common case rather than the odd one, and a notice that silently goes nowhere
 * for those members is the same as no notice at all.
 *
 * A DM IS THE ONLY PRIVATE ROUTE THERE IS, which is worth saying because the
 * obvious alternative does not exist. An ephemeral reply is a property of an
 * INTERACTION response — a slash command, a button — and a member typing a
 * message generates no interaction, so there is nothing to answer ephemerally.
 * The choice is a DM or a public line; it is not a DM or a quiet in-channel one.
 *
 * "BOUNCED" MEANS DISCORD SAID THE DM CANNOT LAND, NOT THAT THE SEND FAILED.
 * See `dmsAreShut`: a rate limit or a 500 is a courtesy that did not get done
 * this time, and answering it with a public note about somebody's deleted
 * message would spend the fallback on the API having a bad minute.
 *
 * ONE POSTER IS TOLD AT MOST ONCE A WINDOW, whichever route it took. See
 * `noticeIsDue`: a burst of removals from one person is the case where telling
 * them each time is both most expensive and least useful.
 *
 * THE FALLBACK IS TAKEN DOWN AGAIN, WHICH IS WHAT MAKES IT ACCEPTABLE. See
 * `NOTICE_TTL_MS`. It is also the only message this bot sends that PINGS
 * anybody, and it has to: a silent mention in a channel, deleted again half a
 * minute later, would reach nobody at all — which is the case the fallback
 * exists for. `noticeChannel` is where that is spelled out and asserted.
 *
 * A WEBHOOK IS NOT A POSTER AND IS NOT TOLD. A webhook removal has no member
 * behind it: there is no account to DM, and `<@webhookId>` renders as
 * `@unknown-user` and notifies nobody, so the fallback would be a public note
 * about a deleted message addressed to no one. It is logged instead, so the
 * absence is visible rather than silent.
 *
 * NOTHING IN HERE IS ALLOWED TO THROW PAST `handleMessage`. The message is
 * already gone and the removal is already recorded; failing to tell somebody
 * about it is a nuisance, and taking down the message handler over it would be
 * a bypass anybody could trigger by closing their DMs.
 */
export function notifier(
  notices: NoticeChannel,
  message: ScannedMessage,
): (why: DeleteReason) => Promise<void> {
  return async (why) => {
    const where = { author: message.authorId, channel: message.channelId }

    if (message.webhookId !== null) {
      log('info', 'removal was a webhook post, so there is no poster to tell', {
        ...where,
        reason: why,
      })
      return
    }

    if (!noticeIsDue(notices, message.authorId)) {
      // Info rather than a warning: this is the mechanism working. It is
      // recorded at all because it is the one path where a member is knowingly
      // not told, and an admin asking "why did they get no DM" needs the line.
      log('info', 'poster was told about a removal moments ago, not telling them again', {
        ...where,
        reason: why,
      })
      return
    }

    const text = removalNotice(why)

    try {
      await notices.dm(message.authorId, text)
      return
    } catch (error) {
      if (!dmsAreShut(error)) {
        // NOT A BOUNCE, SO THE FALLBACK IS NOT SPENT. A warning and not an info,
        // unlike the closed-DM case below: a member's privacy setting is
        // expected traffic, and the API refusing a send for some other reason is
        // the bot's own fault to look at.
        log('warn', 'the DM failed for a reason other than closed DMs, so nothing was posted', {
          ...where,
          reason: why,
          error,
        })
        return
      }

      // Expected traffic, not a fault: a member who does not accept DMs from
      // this server is the ordinary reason to be here. Recorded at info so that
      // a bot whose DMs ALL bounce — a token problem, a gateway problem — is
      // still visible as a pattern in the journal.
      log('info', 'could not DM the poster, telling them in the channel instead', {
        ...where,
        reason: why,
        error,
      })
    }

    try {
      await notices.fallback(message.channelId, message.authorId, `<@${message.authorId}> ${text}`)
    } catch (error) {
      log('error', 'could not tell the poster their message was removed', {
        ...where,
        reason: why,
        error,
      })
    }
  }
}

/**
 * The text-carrying parts of one embed, exactly as discord.js's `Embed` getters
 * present them. Structural rather than the class, so a test can write one down.
 */
export interface EmbedText {
  readonly title: string | null
  readonly description: string | null
  readonly url: string | null
  readonly fields: readonly { readonly name: string; readonly value: string }[]
  readonly footer: { readonly text: string } | null
  readonly author: { readonly name: string; readonly url?: string | undefined } | null
}

/**
 * One node of the component tree, as much of one as a scan reads.
 *
 * ONE SHAPE FOR EVERY COMPONENT RATHER THAN A UNION OF SEVEN. discord.js models
 * Components V2 as `TopLevelComponent`, a union of an action row, a container, a
 * section, a text display, a media gallery, a file and a separator — and every
 * one of those either carries a string or carries more components. Naming each
 * class here would mean a `switch` that a new component type in the next
 * discord.js release walks straight past, silently, which is precisely the shape
 * of the hole this is closing. Every field is optional and every field is the
 * name discord.js already uses, so a component that has none of them
 * contributes nothing and a component that has one is read without this file
 * having to know which class it was.
 *
 * A LINK BUTTON'S `url` IS AS MUCH A CARRIER AS ITS LABEL. `{style:5, label:
 * 'click', url:'https://discord.gg/x'}` renders as a button that says "click"
 * and takes you to somebody else's guild; reading only the label sees the word
 * "click" and calls the message clean.
 *
 * WHAT IS DELIBERATELY NOT READ: `customId`. It is a string the posting
 * application chose, so it is attacker-supplied, but it is never rendered and
 * never navigable — it cannot advertise anything to anyone, so scanning it
 * would only add ways to delete a message over a string no member can see.
 */
export interface ComponentText {
  /**
   * discord.js stamps every component with its type. NOTHING HERE READS IT —
   * the walk is by field name, deliberately, see above — but naming it is what
   * makes a component carrying no text at all assignable to this shape:
   * TypeScript rejects a value with nothing in common with an all-optional
   * interface, and a separator has no text fields by definition.
   */
  readonly type?: unknown

  /** A text display — the Components V2 replacement for `content`. */
  readonly content?: string | null
  /** A button's face. */
  readonly label?: string | null
  /** A link button's destination. */
  readonly url?: string | null
  /** A select option's value. */
  readonly value?: string | null
  /** Alt text: a thumbnail, a media gallery item, a select option. */
  readonly description?: string | null
  /** A select menu's placeholder. */
  readonly placeholder?: string | null
  /** A thumbnail's or gallery item's media. `attachment://` carries a name. */
  readonly media?: { readonly url?: string | null } | null
  /** A file component's file, same story as `media`. */
  readonly file?: { readonly url?: string | null } | null
  /** Action rows, containers and sections all nest their children here. */
  readonly components?: readonly ComponentText[]
  /** A section's trailing button or thumbnail. */
  readonly accessory?: ComponentText | null
  /** A media gallery's items. */
  readonly items?: readonly ComponentText[]
  /** A select menu's options. */
  readonly options?: readonly ComponentText[]
}

/** A poll's text: the question, and every answer. */
export interface PollText {
  readonly question: { readonly text: string | null }
  readonly answers: ReadonlyMap<number, { readonly text: string | null }>
}

/** An upload. The name, the title and the alt text are all poster-chosen. */
export interface AttachmentText {
  readonly name: string
  readonly title: string | null
  readonly description: string | null
}

/** A sticker. Its name and description come from whichever guild made it. */
export interface StickerText {
  readonly name: string
  readonly description: string | null
}

/**
 * A thing that carries text: a message, or a message forwarded into one.
 *
 * EVERY FIELD IS REQUIRED, AND THAT IS THE POINT OF THE INTERFACE. This used to
 * model `content` and `embeds` and nothing else, so an invite in a Components V2
 * text display, in a link button's url, in a poll question or in an attachment
 * filename reached `scanText` and came back as the empty string. Forwarding one
 * of those was the same bypass a second time, because `messageSnapshots` is
 * typed with this interface too and discord.js's `MessageSnapshot` retains
 * `attachments`, `components`, `content`, `embeds` and `stickers` — five
 * surfaces, of which the old shape named two.
 *
 * MAKING THEM REQUIRED IS WHAT KEEPS THEM HONEST. `createClient` hands a real
 * discord.js `Message` to a listener typed `(message: LiveMessage) => void`, and
 * `LiveMessage` extends this — so a field named here that discord.js does not
 * have, or renames, is a compile error rather than a surface that quietly stops
 * being read. Optional fields would have made that same drift silent, which is
 * how this file came to model two of five in the first place.
 */
export interface ScannableParts {
  readonly content: string | null
  readonly embeds: readonly EmbedText[]
  readonly components: readonly ComponentText[]
  readonly attachments: ReadonlyMap<string, AttachmentText>
  readonly stickers: ReadonlyMap<string, StickerText>

  /**
   * Null on a message with no poll, and on a forward: `poll` is not among the
   * fields discord.js's `MessageSnapshot` retains. Named here anyway, so that
   * one walker can read a message and a snapshot without branching on which.
   */
  readonly poll: PollText | null
}

export interface ScannableMessage extends ScannableParts {
  /** Forwarded messages. The original's text lives here, not in `content`. */
  readonly messageSnapshots: ReadonlyMap<string, ScannableParts>
}

/**
 * Everything in a message that a human would read as text, as one string.
 *
 * `message.content` ALONE MISSED TWO WHOLE CLASSES OF POST. An invite in an
 * embed — which is how every bot and every webhook posts anything that looks
 * designed — arrives with `content` empty, so the scan saw a blank message and
 * left it. A FORWARDED message is the same story with a different field: the
 * original text is in `messageSnapshots` and `content` is empty, so forwarding
 * somebody's advert was a one-click bypass.
 *
 * AND THEN THE SAME BUG A THIRD AND FOURTH TIME, in the surfaces a message grew
 * after that code was written. A Components V2 text display, a link button's
 * url, a poll question, an attachment's filename: each of them is text a
 * stranger chooses, each of them arrives with `content` empty, and each of them
 * came back from here as the empty string. Every one of those was a bypass
 * again as soon as it was forwarded, because the snapshot walk read the same two
 * fields. There is no list of surfaces to remember any more — `ScannableParts`
 * names them and the compiler holds discord.js to it.
 *
 * ONE WALKER, CALLED TWICE, AND THAT IS DELIBERATE. The message and each
 * forwarded snapshot go through `collectText` and nothing else, so the two
 * cannot drift apart the way they did: a surface added to the walk is added to
 * both, and a surface left out is left out of both loudly rather than out of one
 * quietly. Forwarding has been the cheap way around this scan twice now.
 *
 * JOINED WITH NEWLINES, NEVER CONCATENATED BARE. Two adjacent parts welded
 * together can spell something neither of them said — a `discord.gg/` at the
 * end of the content and a bare code at the start of an embed would become a
 * link that was never posted, and the bot would delete a message on the
 * strength of a string it assembled itself. A newline cannot appear inside a
 * host or a code, so it is the separator that cannot invent a match, and it
 * holds across every new surface below for the same reason.
 *
 * ONE STRING INTO THE SAME PURE `findInviteCodes`. No second pattern, no second
 * set of rules to keep in step with invites.ts.
 */
export function scanText(message: ScannableMessage): string {
  const parts: string[] = []

  collectText(parts, message)

  // One level of forwarding. Discord does not nest a forward inside a forward,
  // and a snapshot does not carry snapshots of its own to walk.
  for (const forwarded of message.messageSnapshots.values()) collectText(parts, forwarded)

  return parts.join('\n')
}

/**
 * How deep the component walk will go.
 *
 * Discord's own nesting is shallower than this — a container holding a section
 * holding a text display is three — so the cap is not a limit on anything real.
 * It is there because this walk is a recursion over a structure built from a
 * payload a stranger sent, and the failure mode of a cycle or an absurd depth in
 * one is a stack overflow that takes down a bot moderating a live guild.
 */
const MAX_COMPONENT_DEPTH = 8

function collectText(parts: string[], source: ScannableParts): void {
  push(parts, source.content)

  for (const embed of source.embeds) {
    // Every field a stranger can write into, not only the description. A field
    // value and a footer are as postable as a title, and the cost of reading
    // one that never holds an invite is nothing.
    push(parts, embed.title)
    push(parts, embed.description)
    push(parts, embed.url)

    for (const field of embed.fields) {
      push(parts, field.name)
      push(parts, field.value)
    }

    if (embed.footer !== null) push(parts, embed.footer.text)

    if (embed.author !== null) {
      push(parts, embed.author.name)
      push(parts, embed.author.url)
    }
  }

  collectComponents(parts, source.components, 0)

  if (source.poll !== null) {
    // A poll is a title and a list of options a stranger wrote, rendered large.
    push(parts, source.poll.question.text)
    for (const answer of source.poll.answers.values()) push(parts, answer.text)
  }

  // A filename is chosen by the uploader and is displayed under the file, so
  // `discord.gg-x3.png` is an advert that never appears in `content`. The title
  // and the description are the alt-text fields next to it, same story.
  for (const attachment of source.attachments.values()) {
    push(parts, attachment.name)
    push(parts, attachment.title)
    push(parts, attachment.description)
  }

  // A sticker carries the name and description the guild that made it chose,
  // and it travels into ours attached to the message.
  for (const sticker of source.stickers.values()) {
    push(parts, sticker.name)
    push(parts, sticker.description)
  }
}

/**
 * Walk a component tree. Containers, action rows and sections nest, so this
 * recurses rather than reading one level: an invite inside a container was
 * invisible to a walk that only looked at the top-level list.
 */
function collectComponents(
  parts: string[],
  components: readonly ComponentText[],
  depth: number,
): void {
  if (depth > MAX_COMPONENT_DEPTH) return

  for (const component of components) {
    push(parts, component.content)
    push(parts, component.label)
    push(parts, component.url)
    push(parts, component.value)
    push(parts, component.description)
    push(parts, component.placeholder)
    push(parts, component.media?.url)
    push(parts, component.file?.url)

    // The four names discord.js nests children under. Reading them all here
    // rather than switching on a component type is what stops the next
    // component class discord.js adds from being a hole nobody notices.
    if (component.accessory !== null && component.accessory !== undefined) {
      collectComponents(parts, [component.accessory], depth + 1)
    }

    collectComponents(parts, component.components ?? [], depth + 1)
    collectComponents(parts, component.items ?? [], depth + 1)
    collectComponents(parts, component.options ?? [], depth + 1)
  }
}

/**
 * Add one part, or nothing.
 *
 * EMPTY AND ABSENT ARE DROPPED RATHER THAN PUSHED. An empty string between two
 * real ones would put two newlines in the joined text, which changes nothing
 * about what matches — but it keeps the parts list to what the message actually
 * said, and every one of the surfaces above is absent far more often than not.
 */
function push(parts: string[], text: string | null | undefined): void {
  if (text !== null && text !== undefined && text !== '') parts.push(text)
}

/**
 * The live `Message` as this file uses it, and no more of it than that.
 *
 * STRUCTURAL RATHER THAN discord.js's `Message` FOR THE SAME REASON
 * `ScannedMessage` IS. A real `Message` cannot be built in a test without a
 * client and a REST handle, and the half of this file that turns a message into
 * a record is exactly the half the embed and forwarding bugs lived in. Both
 * `Message` and `PartialMessage` satisfy this, so `createClient` hands the real
 * thing over unchanged.
 *
 * NULLS ARE HERE BECAUSE A PARTIAL IS REAL. An edit to a message the bot never
 * cached arrives with `content` and `author` absent; typing them as present
 * would let a partial be scanned as an empty — and therefore clean — message.
 */
export interface LiveMember {
  readonly roles: { readonly cache: ReadonlyMap<string, unknown> }
}

/**
 * The guild, reduced to the one question this file asks it: who is this author.
 *
 * `members.fetch` IS A CACHING READ. discord.js checks its own member cache
 * first and only spends a REST call on a miss, and a member it does fetch is
 * cached — after which `message.member` resolves from that cache on its own and
 * the next message from the same author never reaches this at all.
 */
export interface LiveGuild {
  readonly members: { fetch: (id: string) => Promise<LiveMember> }
}

export interface LiveMessage extends ScannableMessage {
  readonly partial: boolean

  /**
   * `username` IS NAMED HERE SO THE COMPILER HOLDS discord.js TO IT, the same
   * way `ScannableParts` names the text surfaces. discord.js's `User` carries
   * `username`, `globalName`, `displayName` and `tag`; naming the one this file
   * uses means a rename in a future release is a compile error rather than a
   * log line that quietly stops saying who a removal was about.
   *
   * NULLABLE, THOUGH `User.username` IS NOT. A username the payload did not
   * bring must not be the difference between a record and no record, and the
   * line is built to survive its absence — see `authorRef`.
   */
  readonly author: { readonly id: string; readonly username: string | null } | null

  readonly member: LiveMember | null

  /**
   * Null in a DM. Present so an author whose member object did not arrive can
   * be looked up rather than waved through; see `memberRoles`.
   */
  readonly guild: LiveGuild | null

  readonly channelId: string
  readonly guildId: string | null
  readonly webhookId: string | null
  fetch: () => Promise<LiveMessage>
  delete: () => Promise<unknown>
}

/**
 * What the live half needs that it cannot build per message: the invite lookup
 * and the log channel. `remove` is absent because it is bound to one message
 * and is built for each of them by `remover`.
 */
export interface LiveActions {
  resolve: InviteResolver
  announce: ((line: string) => Promise<void>) | null

  /**
   * The two ways to reach a poster. Built once from the client, like the
   * resolver and the log channel, because neither of them is bound to a
   * message — `notifier` is what binds them to one.
   */
  notices: NoticeChannel
}

/**
 * One live message — created or edited — from the gateway to a verdict.
 *
 * THIS IS THE PATH BOTH EVENTS TAKE. `messageCreate` alone left a two-step
 * bypass that needs no permissions at all: post "hey all", wait, edit it to
 * carry the invite. The edit was never looked at, so the advert sat there
 * permanently. Registering `messageUpdate` through this same function is what
 * closes it, and routing both through one function is what stops the two paths
 * drifting apart later.
 *
 * A PARTIAL IS FETCHED, NEVER SCANNED AS-IS. An edit to a message that is not
 * in the cache arrives with its content missing, which reads as the empty
 * string — indistinguishable from a message with nothing in it, and therefore
 * "clean". So a partial is fetched, and if it cannot be fetched, or comes back
 * still partial, it is logged and skipped. Skipping leaves an advert standing;
 * scanning an empty shell would report every uncached edit as clean forever.
 */
export async function handleLive(
  message: LiveMessage,
  selfId: string | null,
  config: Config,
  actions: LiveActions,
): Promise<void> {
  if (halted) return

  // `decide` asks this again — it is the choke point and it has to. It is asked
  // here as well because everything below can cost an API call, and a message
  // in a guild we do not moderate (or a DM, where `guildId` is null) must cost
  // nothing at all.
  if (message.guildId !== config.guildId) return

  const full = message.partial ? await refetch(message) : message
  if (full === null) return

  const authorId = full.author?.id ?? null
  if (authorId === null) {
    // Nothing to attribute the removal to, and no way to tell our own message
    // apart from anyone else's. Louder than a silent return, because a stream
    // of these means the payloads are not what this file thinks they are.
    log('warn', 'message arrived with no author, not scanned', { channel: full.channelId })
    return
  }

  // Built once and used twice: `handleMessage` reads it, and `notifier` needs
  // the same author and channel the verdict was made about rather than a second
  // reading of the live message that could disagree with it.
  const scanned = snapshot(full, authorId, selfId)

  await handleMessage(scanned, config, {
    resolve: actions.resolve,
    fetchRoles: memberRoles(full),
    remove: remover(full, config),
    announce: actions.announce,
    notify: notifier(actions.notices, scanned),
  })
}

/** How long an author's roles — or a failure to read them — stay good. */
const ROLE_TTL_MS = 60_000

/** How many authors one guild remembers before the oldest is dropped. */
const ROLE_MAX_ENTRIES = 500

interface RoleEntry {
  roles: readonly string[] | null
  expiresAt: number
}

/**
 * One remembered answer per author, per guild.
 *
 * WHY THIS EXISTS AT ALL: the fetch below is one REST call per author whose
 * member object did not arrive, and the case it has to survive is a raid — a
 * hundred fresh accounts posting at once, none of them cached, every one of
 * them a lookup. Without a bound, the fix for a bypass would be a way to make
 * the bot rate-limit itself off the gateway.
 *
 * THE FAILURE IS REMEMBERED TOO, and that is the entry that matters. A member
 * that cannot be fetched — gone from the guild, an outage, a permission — has
 * nothing to put in discord.js's own cache, so without this every single
 * message from that author asks Discord the same question and gets the same
 * error. Remembering the failure for a minute costs nothing in safety: the
 * remembered answer is null, and null scans.
 *
 * KEYED ON THE GUILD OBJECT, IN A WeakMap, the way invites.ts keys its caches
 * on the resolver. The lifetime is then the guild's own — a guild that goes out
 * of scope takes its table with it, nothing has to be reset between tests, and
 * a test that wants a fresh table builds a fresh guild rather than remembering
 * to empty a shared one.
 *
 * A MINUTE, NOT AN HOUR. A remembered role list means an admin who was demoted
 * keeps the exemption, and a member promoted to admin keeps being scanned, for
 * as long as the entry lives. One minute is short enough that neither is worth
 * anybody's attention and long enough to flatten a raid.
 *
 * NOT AN IN-FLIGHT DEDUPLICATOR. Two messages from the same uncached author in
 * the same tick both miss and both fetch, and that was left alone deliberately:
 * it is two calls, not two hundred, discord.js queues them behind one rate
 * limiter anyway, and the alternative is a table of pending promises that has to
 * be cleaned up on every path including the one where the fetch throws.
 */
const roleCaches = new WeakMap<LiveGuild, Map<string, RoleEntry>>()

function roleCacheFor(guild: LiveGuild): Map<string, RoleEntry> {
  const existing = roleCaches.get(guild)
  if (existing !== undefined) return existing

  const created = new Map<string, RoleEntry>()
  roleCaches.set(guild, created)
  return created
}

/**
 * The live `RoleLookup`: fetch the member, and say plainly if we could not.
 *
 * A THROW IS ANSWERED WITH NULL, NOT WITH A RETHROW OR A SKIP. Null means the
 * author is not known to be exempt, so `decide` scans them — which is the whole
 * point of the change this belongs to. The warning is written here rather than
 * left to the caller because this is the half that knows WHY: the error is in
 * the line.
 */
function memberRoles(message: LiveMessage): RoleLookup {
  return async (authorId) => {
    const guild = message.guild

    // No guild object to ask. `decide` has already established this message is
    // in the guild we moderate, so this is a payload that is not what this file
    // expects rather than a DM — and the answer is still "not known exempt".
    if (guild === null) return null

    const cache = roleCacheFor(guild)
    const entry = cache.get(authorId)

    // Expiry is checked on read and the dead entry dropped here: no timer, and
    // nothing to unref before the process can exit.
    if (entry !== undefined && Date.now() < entry.expiresAt) return entry.roles
    if (entry !== undefined) cache.delete(authorId)

    let roles: readonly string[] | null

    try {
      const member = await guild.members.fetch(authorId)
      roles = [...member.roles.cache.keys()]
    } catch (error) {
      // Not fatal and not a reason to stop: the message is scanned either way.
      // Worth a warning because a stream of these means the bot cannot read its
      // own guild's members, and the admin exemption has stopped working.
      log('warn', 'author roles could not be fetched, scanning the message anyway', {
        author: authorId,
        channel: message.channelId,
        error,
      })
      roles = null
    }

    remember(cache, authorId, roles)
    return roles
  }
}

function remember(
  cache: Map<string, RoleEntry>,
  authorId: string,
  roles: readonly string[] | null,
): void {
  // Delete before set so a re-answered author moves to the END of the Map's
  // insertion order, or eviction could drop the entry just written.
  cache.delete(authorId)
  cache.set(authorId, { roles, expiresAt: Date.now() + ROLE_TTL_MS })

  while (cache.size > ROLE_MAX_ENTRIES) {
    const oldest = cache.keys().next()
    // Only reachable on an empty Map, which the loop condition has ruled out.
    // Checked anyway: the alternative to breaking out is a spin that never ends.
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/** Fill in a partial, or say plainly that we could not. Never returns a shell. */
async function refetch(message: LiveMessage): Promise<LiveMessage | null> {
  let fetched: LiveMessage

  try {
    fetched = await message.fetch()
  } catch (error) {
    // Deleted between the edit and the fetch, or a channel the bot cannot read.
    log('warn', 'edited message could not be fetched, not scanned', {
      channel: message.channelId,
      error,
    })
    return null
  }

  if (fetched.partial) {
    log('warn', 'edited message is still partial after a fetch, not scanned', {
      channel: message.channelId,
    })
    return null
  }

  return fetched
}

/**
 * Build the client and wire every handler onto it. Does not log in.
 *
 * LOGIN IS THE CALLER'S JOB (see index.ts), so this function is constructible
 * in a test without a token and without touching the network.
 */
export function createClient(config: Config): Client {
  const client = new Client({
    /**
     * `Guilds` for the channel and role caches every other lookup reads from,
     * `GuildMessages` to be told a message exists, and `MessageContent` to be
     * allowed to read it.
     *
     * `GuildMembers` IS NOW ASKED FOR, AND THIS COMMENT USED TO ARGUE AT LENGTH
     * THAT IT NEVER SHOULD BE. Both halves of that argument still stand and
     * neither is what changed. The moderation path genuinely does not need it —
     * a `messageCreate` payload carries the author's member OPPORTUNISTICALLY,
     * and the rule is "no member, so fetch one" (`memberRoles`) and "fetch
     * failed, so scan", so the missing intent cost at most a lookup and never a
     * bypass. And it is still true that this application's credentials are shared
     * with the Ringmaster console, so a privileged intent is widened for every
     * consumer of the token and not only for this feature.
     *
     * WHAT CHANGED IS THAT A FEATURE NOW NEEDS THE EVENT ITSELF. blitz-bot#2 puts
     * the game-ban role on somebody the console has banned; a banned player who
     * is not in the guild cannot be marked until they arrive, and `guildMemberAdd`
     * is the only way to learn that they have. Without it, leaving and rejoining
     * is how you take the role off. The owner has approved enabling it.
     *
     * IT IS PRIVILEGED, SO THE TICK IN THE DEVELOPER PORTAL HAS TO BE ON BEFORE
     * THIS SHIPS — your app -> Bot -> Privileged Gateway Intents -> Server Members
     * Intent. The signature of getting that wrong is the one `MessageContent`
     * already documents above and it is the whole bot rather than this feature:
     * the gateway rejects the identify, closes with code 4014, `client.login()`
     * rejects, index.ts exits non-zero and systemd restarts into the same wall.
     * `code=4014` on the `gateway disconnected` line is the evidence.
     *
     * IT ALSO MAKES THE MEMBER CACHE REAL. discord.js will now hold guild members
     * it is told about, which costs memory in proportion to the guild. Nothing
     * here asks for a full member list — `installGameBanRole` works from ids and
     * REST writes — so what accumulates is what the gateway pushes.
     */
    /**
     * `GuildModeration` IS NEW AND IS NOT PRIVILEGED. It is the intent that
     * delivers `guildAuditLogEntryCreate`, which is the whole of how this bot
     * learns that a moderator banned, unbanned or kicked somebody — see
     * `installBanMirror`. It needs no tick in the Developer Portal and no
     * review; what it does need is the **View Audit Log** permission on the
     * bot's role in the guild, which the owner has granted. Without the
     * permission the intent is accepted, the gateway connects, and the event
     * simply never arrives — a silence that looks exactly like a quiet guild.
     *
     * IT ALSO DELIVERS `guildBanAdd` AND `guildBanRemove`, WHICH THIS BOT
     * DELIBERATELY DOES NOT LISTEN FOR. Those carry the user and no executor
     * and no entry id, so a mirror built on them would have to correlate a ban
     * against the audit log to find out who did it. The audit event carries
     * target, executor and reason together and is therefore the one that needs
     * no correlating.
     */
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMembers,
    ],

    /**
     * `Partials.Message` IS WHAT MAKES THE EDIT LISTENER COVER OLD MESSAGES.
     * discord.js drops a `messageUpdate` for a message it has not cached unless
     * this partial is enabled — the event never reaches any listener at all. So
     * without it the edit bypass survives every restart: post now, let the bot
     * restart, edit the message tomorrow and nothing is ever looked at.
     * `handleLive` fetches what arrives partial rather than scanning it empty.
     */
    partials: [Partials.Message],

    /**
     * NOTHING THIS BOT SENDS PINGS ANYONE UNLESS THE SEND ITSELF SAYS SO. Set
     * on the client so the guarantee holds for whatever gets added later
     * without depending on somebody remembering. The log line carries an invite
     * code chosen by a stranger and, since the author became a mention, `<@id>`
     * on purpose — this makes the question moot instead of making it a thing to
     * reason about.
     *
     * THIS USED TO SAY "CAN EVER PING ANYONE", AND THAT IS NO LONGER TRUE. A
     * default is silently replaced by any call that passes `allowedMentions` of
     * its own, so what it really guarantees is the sends that say nothing. Two
     * now say something: `announcer` repeats the suppression at its own `send`,
     * because that call deliberately contains a mention and because a default
     * set here cannot be asserted on there — and `noticeChannel`'s fallback
     * DELIBERATELY pings, narrowed to the single poster it names, because its
     * whole job is to reach a member whose DMs are shut. Both state their
     * option at the send, which is the only place a reader can see it.
     */
    allowedMentions: { parse: [], repliedUser: false },
  })

  const resolve = inviteResolver((code) => client.fetchInvite(code))
  const post = config.logChannelId === null ? null : announcer(client, config.logChannelId)
  const actions: LiveActions = { resolve, announce: post, notices: noticeChannel(client) }

  client.once(Events.ClientReady, (ready) => {
    // `Events.ClientReady` is `clientReady` in this version; the old `ready`
    // name still fires but is deprecated, and pinning the enum means the rename
    // is a compile error rather than a listener that silently never runs.
    const guild = ready.guilds.cache.get(config.guildId)

    if (guild === undefined) {
      // Connected, authenticated, and not in the guild it was configured for —
      // a mistyped DISCORD_GUILD_ID, or a bot that was removed from the server.
      //
      // THIS IS FATAL TO MODERATION, NOT A WARNING ABOUT IT. `config.guildId`
      // is the only thing that makes an invite "ours", so a wrong one does not
      // make the bot idle: it makes every invite to THIS server look foreign,
      // and the bot deletes our own invites in whatever guild it is actually
      // in. This used to log and return with the message listener still armed.
      // It now stops the bot moderating, and takes the listeners off as well so
      // that not even a queued event can reach a delete.
      haltModeration('DISCORD_GUILD_ID names a guild this bot is not a member of', {
        user: ready.user.tag,
        guild: config.guildId,
      })

      client.removeAllListeners(Events.MessageCreate)
      client.removeAllListeners(Events.MessageUpdate)
      return
    }

    log('info', 'ready', {
      user: ready.user.tag,
      userId: ready.user.id,
      guild: guild.name,
      guildId: guild.id,
      dryRun: config.dryRun,
    })
  })

  /**
   * An `error` event with no listener is not a log line, it is an uncaught
   * exception — EventEmitter rethrows it — so this listener is what stops a
   * transient gateway fault from killing a bot that would otherwise have
   * reconnected on its own.
   *
   * There is no `disconnect` listener here, though the brief asked for one:
   * discord.js v12 had a client `disconnect` event and v14 does not. The
   * gateway lives on a shard now. Registering the old string would type-error,
   * and if it did not it would be a handler that never fires.
   *
   * AND `shardDisconnect` IS NOT THAT EVENT UNDER A NEW NAME, which this
   * comment used to say and which is the trap the shard listeners below are
   * written around: in v14 it fires only for close codes the library will not
   * retry. "The gateway went away" is `shardReconnecting`.
   */
  client.on(Events.Error, (error) => {
    log('error', 'client error', { error })
  })

  /**
   * How long each shard has been off Discord, while it is.
   *
   * THE FAULT IS THE ABSENCE, NOT THE RECONNECT. Discord asks clients to
   * reconnect as ordinary housekeeping and a healthy bot does it several times
   * a day; `gateway reconnecting` was logged at warn, so each of those arrived
   * in the status channel as something to go and look at, and three of them
   * across a night taught the owner that the channel can be scrolled past.
   * What nothing detected was the case that actually needs him: a gateway that
   * goes and does not come back. That is what this map is for — a clock per
   * shard, started when the connection is lost and stopped when it returns.
   *
   * KEYED BY SHARD because the events are, even though this bot runs one. A
   * single `let` would work today and would silently mean "whichever shard
   * moved last" the day it does not.
   */
  const outages = new Map<number, Outage>()

  /**
   * The gateway is away. Start the clock, or leave one that is already running.
   *
   * THE CLOCK RUNS FROM THE FIRST LOSS AND EVERY RETRY AFTER IT IS THE SAME
   * OUTAGE. discord.js emits `shardReconnecting` once per attempt, so restarting
   * the clock on each one would mean a shard retrying every twenty seconds
   * forever never reached the window at all — the exact failure this exists to
   * catch would be the one it could not see.
   *
   * THE TIMER IS UNREFFED. A bot being shut down while its gateway is away must
   * not make `systemctl stop` wait out this window for a line about a
   * connection nobody is waiting for any more.
   */
  function gatewayAway(shardId: number): void {
    if (outages.has(shardId)) return

    const since = Date.now()

    const timer = setTimeout(() => {
      const outage = outages.get(shardId)
      if (outage === undefined) return

      // Recorded so the return can say the alarm is over. An alarm that never
      // clears is one people learn to ignore, which is how this started.
      outage.warned = true

      // MEASURED RATHER THAN ASSUMED. This is `GATEWAY_DOWN_MS` in a healthy
      // process and is not in a busy or suspended one, and the whole value of
      // the line is that the number in it is true.
      log('warn', 'gateway has not come back', { shard: shardId, seconds: awaySeconds(since) })
    }, GATEWAY_DOWN_MS)

    timer.unref()
    outages.set(shardId, { since, timer, warned: false })
  }

  /**
   * The gateway is back. Stop the clock, and say so only if we raised an alarm.
   *
   * THIS IS A `warn` AND THAT IS DELIBERATE, THOUGH IT IS GOOD NEWS. While the
   * gateway is down there is no gateway to post over, so the warning above
   * reaches the journal and nothing else — the same irreducible gap `login
   * failed` has. This line is the first thing that CAN be delivered afterwards,
   * so it is not a celebration: it is the outage report, and it carries how
   * long the bot was off Discord because that is the fact nobody could be told
   * at the time. `info` would put it where the sink cannot reach it, which
   * would leave the alarm hanging open forever.
   *
   * SILENT WHEN NOTHING WAS RAISED, which is the ordinary case: a reconnect
   * inside the window ends its outage here having never warned about it, and
   * says nothing at either end.
   */
  function gatewayBack(shardId: number): void {
    const outage = outages.get(shardId)
    if (outage === undefined) return

    outages.delete(shardId)
    clearTimeout(outage.timer)

    if (!outage.warned) return

    log('warn', 'gateway is back', { shard: shardId, seconds: awaySeconds(outage.since) })
  }

  /**
   * IN v14 THIS EVENT MEANS THE SHARD WILL NEVER RECONNECT, which is not what
   * its name suggests and is the reverse of the v12 event it was named after.
   * discord.js emits `shardDisconnect` only for the close codes it lists as
   * unrecoverable — 4004 a bad token, 4013 and 4014 an intent that is not
   * granted, 4010/4011/4012 a sharding or API-version mistake — and emits
   * `shardReconnecting` for every close it will retry. So this is not the other
   * half of a routine reconnect and does not become `info` with it: the bot is
   * off Discord until somebody changes something and restarts it.
   *
   * IT IS ALSO THE END OF ANY OUTAGE CLOCK, because a shard can be retrying
   * when the identify comes back refused. One fault gets one alarm, and this
   * one names the cause; a second line a minute later saying it has not come
   * back adds nothing to a line that already says it never will.
   */
  client.on(Events.ShardDisconnect, (event, shardId) => {
    const outage = outages.get(shardId)

    if (outage !== undefined) {
      outages.delete(shardId)
      clearTimeout(outage.timer)
    }

    // The close code is the whole diagnosis, and the only one of these that is
    // ever a mistake in configuration rather than in code: 4014 is a privileged
    // intent requested and not granted, 4004 is a bad token.
    log('warn', 'gateway disconnected', { shard: shardId, code: event.code })
  })

  /**
   * INFO, BECAUSE A RECONNECT THAT SUCCEEDS IS NOT A FAULT. Discord hands out
   * close codes it expects clients to reconnect from as a matter of routine —
   * a gateway node going out of service, an op 7 asking for a resume — and
   * discord.js does exactly that without anything else in this process
   * noticing. The line stays in the journal for whoever is debugging a
   * connection; what it stops doing is asking for a person.
   */
  client.on(Events.ShardReconnecting, (shardId) => {
    log('info', 'gateway reconnecting', { shard: shardId })
    gatewayAway(shardId)
  })

  /**
   * BOTH WAYS BACK, AND EITHER ONE ENDS THE OUTAGE. A shard that re-identifies
   * emits `shardReady`; one that resumes its old session emits `shardResume`
   * and never emits `shardReady` at all. Listening for only the first would
   * leave a resumed session looking permanently down, which is a false alarm on
   * the fastest and most common recovery there is.
   *
   * NEITHER IS LOGGED IN ITSELF. A gateway that came back inside the window is
   * the routine case and says nothing; `gatewayBack` speaks only when an alarm
   * is waiting to be cleared.
   */
  client.on(Events.ShardReady, (shardId) => {
    gatewayBack(shardId)
  })

  client.on(Events.ShardResume, (shardId) => {
    gatewayBack(shardId)
  })

  // The listener is synchronous and the promise is handled here, because an
  // async listener handed to an EventEmitter has nowhere to reject to: it
  // becomes an unhandled rejection several ticks later, attached to no message
  // and no channel.
  const onMessage = (message: LiveMessage): void => {
    void handleLive(message, client.user?.id ?? null, config, actions).catch((error: unknown) => {
      log('error', 'message handler failed', { channel: message.channelId, error })
    })
  }

  client.on(Events.MessageCreate, onMessage)

  // The edited message, not the old one. The old copy is what the guild saw
  // before the edit and is already gone from every client in it.
  client.on(Events.MessageUpdate, (_old, updated) => {
    onMessage(updated)
  })

  /**
   * THE STICKY, AND IT IS A SECOND `messageCreate` LISTENER RATHER THAN A LINE
   * IN `onMessage`. Both see every message and that is the whole of what they
   * share: the scanner reads content and can delete, the sticky counts arrivals
   * and cares about nothing else on the message. Folding the count into the
   * moderation handler would put a repost behind an `await` on an invite lookup
   * and, worse, behind every `return` in `decide` — an exempt channel, an admin's
   * message, a halted bot — so a channel full of exempt traffic would drift with
   * the counter reading zero. Nothing in the invite path changes; it does not
   * know this listener exists.
   *
   * `messageCreate` ONLY, WHICH IS WHY IT CANNOT BE THE SAME LISTENER. The line
   * above deliberately routes `messageUpdate` through `onMessage` as well,
   * because an edited message has to be scanned the way a new one is. AN EDIT IS
   * NOT DRIFT: nothing moved and nothing was pushed down, and counting one would
   * repost the sticky because somebody fixed a typo.
   *
   * REGISTERED HERE SO THE HALT TAKES IT OFF WITH THE OTHERS. `removeAllListeners`
   * above means "stop moderating", and a bot that is not in its configured guild
   * registers no commands either — so there is nothing left to stick, and a
   * sticky engine still counting messages in some other guild would be the one
   * listener the halt missed.
   *
   * ONE CALL, BECAUSE EVERYTHING IT NEEDS IS ON THE OTHER SIDE OF IT. The
   * poster, the state file under `StateDirectory=` and the restore-at-boot are
   * all in sticky.ts; see `installStickies` there.
   */
  installStickies(client)

  /**
   * THE MAINTENANCE WATCHER, AND NOTHING AT ALL WHEN NO CHANNEL IS SET — the
   * same rule the status channel and the manual follow, and the one that matters
   * most here: with no channel there is nowhere to announce an outage, so the
   * `ringmaster-maintenance` row is not polled and this process makes no AWS
   * call it would otherwise make four times a minute.
   *
   * IT BUILDS THE `Ddb` ITSELF, and that is the one place in this file that
   * reaches AWS. `createDdb` opens no socket and resolves no credentials — the
   * first poll does, after `clientReady` — and it is called here rather than at
   * module scope for the reason its own comment gives. `Pick<Ddb, 'maintenance'>`
   * is what `watchMaintenance` asks for, so the watcher cannot read a ban or
   * write an audit row however it is edited later.
   *
   * REGISTERED AFTER THE GUILD CHECK, like the deploy notice and the manual, so
   * a bot that cannot find its guild says the halt line first. It is NOT taken
   * off by the halt, and that is deliberate: announcing an outage is not
   * moderation, it posts to an id from the config rather than to anything it
   * discovered in the guild, and an outage during a misconfiguration is exactly
   * when players are asking what is going on.
   */
  if (config.maintenanceChannelId !== null) {
    watchMaintenance(client, config.maintenanceChannelId, createDdb())
  }

  /**
   * WIRED HERE RATHER THAN IN index.ts, because it is one more `clientReady`
   * listener and every listener this bot has is registered in this function.
   * Registered last so it runs after the guild check: a bot that came up on a
   * new commit AND cannot find its guild says the halt line first.
   *
   * NOTHING AT ALL WHEN NO STATUS CHANNEL IS SET, the same rule the sink
   * follows in index.ts. The bot is live today with the id unset and has to
   * keep running exactly as it does now.
   */
  if (config.statusChannelId !== null) {
    announceDeployedCommit(client, config.statusChannelId)
  }

  /**
   * The manual, for the same reasons and under the same rule: one more
   * `clientReady` listener, registered here because every listener this bot has
   * is registered in this function, and nothing at all when the id is unset.
   *
   * REGISTERED AFTER THE GUILD CHECK, so a bot that cannot find its guild says
   * the halt line first. Documentation is not moderation and must never come
   * before it — nor block it: `syncDocsChannel` catches everything.
   *
   * THE CONFIG GOES WITH IT BECAUSE THE DOCUMENT IS RENDERED AGAINST IT. Two
   * passages of the manual describe exemptions and are published only when those
   * exemptions are actually running — see `renderManual`. `ManualConfig` is a
   * `Pick` of the three fields that decides, so this call hands over the whole
   * `Config` and the renderer can still only read those three.
   *
   * ═══ AND ONE LINE WHEN THE ID IS UNSET, WHICH IS WHAT THIS FEATURE GOT WRONG ═══
   *
   * "Nothing at all" used to include saying nothing at all, and that is the one
   * silent way this bot could decide not to publish the manual. Every other way
   * speaks: a file that is not there is a `warn`, a template that does not render
   * and a document that does not parse or does not fit are `error`s, a channel
   * that cannot be read is an `error`. An unset id was the only branch that left
   * no trace anywhere, and it is the branch an operator lands on by ACCIDENT —
   * docs/deploy.md's `.env` block omitted `BLITZ_DOCS_CHANNEL_ID` entirely until
   * d5696c5, so an install done from that guide has the manual switched off and
   * nothing on the box, in the journal or in the status channel says so. The
   * channel members actually read can then be stale for a week while every
   * signal this bot produces agrees that it is fine.
   *
   * `info`, DELIBERATELY, AND THE SECOND REASON IS THE BINDING ONE. An id nobody
   * set is a configuration and not a fault — the bot is live today with several
   * of these unset — so `warn` would put a line in the status channel on every
   * restart about something nobody is going to do anything about, which is how
   * `gateway reconnecting` taught this owner that the channel can be scrolled
   * past. AND IT COULD NOT REACH HIM ANYWAY: this runs inside `createClient`, and
   * index.ts installs the sink AFTER `createClient` returns, so `report` in
   * src/log.ts has no sink to hand it to and drops the copy. A `warn` here would
   * read like it went to Discord and would have gone to the journal alone.
   *
   * WHAT IT BUYS IS THAT THE SILENCE NOW MEANS SOMETHING. After this line, a
   * start says either "no docs channel" or what went wrong with the manual, so a
   * start that says nothing about the manual is a manual that is published and
   * current. That is exactly the rule the quiet restart depends on, and until now
   * there was no way to tell it apart from a feature that was never switched on.
   */
  if (config.docsChannelId !== null) {
    syncDocsChannel(client, config.docsChannelId, config)
  } else {
    log('info', 'no docs channel is configured, so the manual will not be published', {
      variable: 'BLITZ_DOCS_CHANNEL_ID',
    })
  }

  /**
   * THE MODERATION MIRROR, AND IT IS THE ONE FEATURE HERE WITH NO OFF SWITCH.
   *
   * Every other optional half of this bot hangs off a channel id, and unset
   * means the feature does nothing. This one has no id to hang off, because it
   * is not a thing the bot says — it is the bot carrying a decision an admin
   * already made in Discord into the game. blitz-bot#16 is that feature, so it
   * is wired unconditionally and its two configurable parts degrade instead:
   * no `COMMAND_SECRET` means the ban is still written and only the live kick is
   * skipped, and the game-ban role has a default rather than an absence.
   *
   * REGISTERED AFTER THE GUILD CHECK, like everything else here. It is NOT taken
   * off by the halt, and unlike the maintenance watcher that needs saying twice:
   * `haltModeration` exists because a wrong `DISCORD_GUILD_ID` makes the message
   * scanner delete the guild's own invites, and this listener has no such
   * failure mode — it checks the guild id on every event and ignores anything
   * from anywhere else, so a misconfigured bot mirrors nothing rather than
   * mirroring the wrong guild's bans.
   */
  installBanMirror(client, config, createDdb())

  /**
   * THE OTHER DIRECTION OF THE SAME POLICY — blitz-bot#2.
   *
   * `installBanMirror` above carries a DISCORD decision into the game. This one
   * carries a GAME decision into Discord: a ban issued in the console puts the
   * game-ban role on, and lifting or EXPIRING it takes the role off. Neither
   * direction can ban anybody on Discord, which is the asymmetry the owner
   * settled and which both files state at length.
   *
   * IT IS WIRED HERE, UNCONDITIONALLY, FOR THE MIRROR'S REASONS. There is no
   * channel id to hang it off because it is not a thing the bot says, and its one
   * configurable part — the role id — has a default rather than an absence.
   *
   * A SEPARATE `Ddb` FOR THE SAME REASON THE MAINTENANCE WATCHER HAS ONE:
   * `createDdb` opens no socket and resolves no credentials, and each caller then
   * gets exactly the `Pick` of it that its own module declares.
   *
   * REGISTERED AFTER THE GUILD CHECK, like everything else here, and not taken off
   * by the halt: it checks the guild id on every join and reads a role id from the
   * config rather than anything it discovered in the guild.
   */
  installGameBanRole(client, config, createDdb())

  /**
   * THE MODERATION RECORD FOR A CLOSED INCIDENT — blitz-bot#19.
   *
   * The same audit log the ban role polls, read for a different verb: a case
   * closed in the console becomes an embed in `logChannelId`, which is the
   * channel that already carries what was removed and why.
   *
   * NOTHING AT ALL WITH NO LOG CHANNEL, and the guard is inside
   * `installIncidentLog` rather than here — it reads the id off the config it is
   * already given, so there is one place that decides rather than two that have
   * to agree. With the id unset the poller is never started and `ringmaster-audit`
   * is not read for this feature at all.
   *
   * A SEPARATE `Ddb` FOR THE REASONS ABOVE: `createDdb` opens no socket and
   * resolves no credentials, and each caller gets exactly the `Pick` of it that
   * its own module declares — this one cannot write anything except the bot's own
   * cursor.
   *
   * REGISTERED AFTER THE GUILD CHECK, like everything else here, and not taken off
   * by the halt: it posts to an id from the config and reads rows from DynamoDB,
   * so a bot that cannot find its guild neither posts to the wrong one nor stops
   * recording moderation that is still happening in the console.
   */
  installIncidentLog(client, config, createDdb())

  return client
}

/** One shard's absence from Discord, while it lasts. See `gatewayAway`. */
interface Outage {
  /** When the connection was lost — the first loss, not the latest retry. */
  readonly since: number

  /** The window, waiting to fire. Unreffed. */
  readonly timer: ReturnType<typeof setTimeout>

  /** Whether the window fired, and therefore whether the return needs saying. */
  warned: boolean
}

/** How long the gateway has been away, in the units a person reads. */
function awaySeconds(since: number): number {
  return Math.round((Date.now() - since) / 1000)
}

/**
 * How long the gateway may be away before a person is asked to look.
 *
 * MEASURED AGAINST HOW LONG A HEALTHY RECONNECT ACTUALLY TAKES, which is the
 * only thing that makes this number defensible rather than a guess. The fast
 * path is a resume: one websocket connect and a RESUME frame, done in well
 * under a second. The slow healthy path is a re-identify, and it has two real
 * costs — Discord's identify bucket, which admits one identify per shard every
 * five seconds, and discord.js's own `waitGuildTimeout`, fifteen seconds spent
 * waiting for the GUILD_CREATE payloads before it calls the shard ready. So a
 * reconnect that is going to work has done so inside about twenty seconds, and
 * the great majority finish in one.
 *
 * SIXTY SECONDS IS THEREFORE THREE TIMES THE WORST HEALTHY CASE, which is the
 * margin that keeps this from crying wolf over a slow night on Discord's side,
 * and it is also the owner's own threshold: a bot that has been off Discord for
 * a minute is not moderating and he wants to know. Nothing between twenty and
 * sixty seconds is silently dropped — every one of those is in the journal as
 * `gateway reconnecting` — it is only the ask for a human that waits.
 *
 * IT IS NOT A RETRY BUDGET AND CHANGES NOTHING ABOUT RECONNECTING. discord.js
 * keeps trying on its own schedule whatever this says; this is only how long
 * the bot stays quiet about it.
 */
const GATEWAY_DOWN_MS = 60_000

/** What `client.fetchInvite` answers, reduced to the part this file reads. */
export type InviteLookup = (code: string) => Promise<{ guild: { id: string } | null }>

/**
 * "Which guild is this code for", or null when Discord says there is no such
 * invite.
 *
 * A 404 IS THE ORDINARY ANSWER, NOT A FAULT. `fetchInvite` is a REST GET, and
 * an expired, revoked or mistyped code comes back `10006 Unknown Invite` — as
 * a THROW, not as a null. The resolver used to have no catch at all, so the
 * single most common outcome in a real guild went out through invites.ts's
 * "the resolver blew up" path: one `warn` per expired invite, and the
 * deliberate never-delete-on-unresolved rule being reached by an error handler
 * rather than by the answer it was written for.
 *
 * EVERYTHING ELSE IS RETHROWN, and that is the half worth keeping. A 500, a
 * rate limit, a dead socket — invites.ts catches those, logs `invite lookup
 * failed` at warn, and treats the code as unresolved. Swallowing them here
 * would make a total Discord outage look exactly like a guild full of expired
 * invites, which is the difference between a visible fault and a silent one.
 */
export function inviteResolver(lookup: InviteLookup): InviteResolver {
  return async (code) => {
    try {
      const invite = await lookup(code)
      return invite.guild?.id ?? null
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownInvite) {
        return null
      }

      throw error
    }
  }
}

/**
 * The delete, or a loud refusal to delete.
 *
 * THE SECOND OF THE TWO DRY-RUN GATES, and it is here because one gate is not
 * enough for an irreversible operation in somebody's live community. `decide`
 * cannot return `delete` while `dryRun` is set, so this branch is unreachable
 * today; the point is that it stays harmless if a later edit breaks that. A gate
 * that never fires costs nothing, and if it ever does fire it says so at error
 * level instead of removing a message from a server that was only supposed to
 * be watching.
 *
 * EXPORTED ONLY SO THE GATE CAN BE PROVEN TO EXIST. Nothing outside this file
 * calls it in production. Being unreachable through `handleLive` is the property
 * this branch is here to back up, so a test that comes in through the front door
 * cannot tell a working gate from a deleted one — and deleting it did in fact
 * leave every test green, which is how a belt-and-braces guard rots away in a
 * later edit with nothing to say so.
 */
export function remover(message: LiveMessage, config: Config): () => Promise<void> {
  if (config.dryRun) {
    return () => {
      log('error', 'dry run reached the delete path, nothing was deleted', {
        channel: message.channelId,
      })
      return Promise.resolve()
    }
  }

  return async () => {
    await message.delete()
  }
}

/** Reduce a live message to the record `decide` reads. */
function snapshot(message: LiveMessage, authorId: string, selfId: string | null): ScannedMessage {
  return {
    text: scanText(message),
    authorId,

    // Read here rather than threaded through `handleLive` alongside `authorId`:
    // the id is load-bearing for the decision and has to be established before
    // the message is scanned at all, and the name is only ever a record.
    authorUsername: message.author?.username ?? null,

    channelId: message.channelId,
    guildId: message.guildId,
    webhookId: message.webhookId,
    fromSelf: selfId !== null && authorId === selfId,

    // Absent whenever discord.js could not build a member for the author — a
    // webhook, or a payload without the member attached. See ScannedMessage for
    // why that is not the same as holding no roles, and why a webhook is told
    // apart from it by `webhookId` rather than being left in the same bucket.
    // Null is not the end of the question: `decide` goes and asks `memberRoles`.
    authorRoleIds: message.member ? [...message.member.roles.cache.keys()] : null,
  }
}

/**
 * Posting to the log channel.
 *
 * `channels.fetch` RATHER THAN A CHANNEL RESOLVED ONCE AT STARTUP. Fetch reads
 * the cache first and only hits the API when it misses, so the steady-state
 * cost is nothing — and unlike a channel captured at boot, it survives the
 * channel being recreated, and it fails per-removal instead of leaving the bot
 * permanently unable to report anything because it started before the guild
 * finished loading.
 *
 * THE MENTION RENDERS AND NOTIFIES NOBODY, AND THIS IS THE HALF THAT DECIDES
 * THAT. `allowedMentions: { parse: [] }` tells Discord to resolve no mention in
 * this message: `<@id>` is still displayed as the account's name, and no
 * notification is delivered to anybody. Nothing the string builder does can
 * achieve that — a mention in a message body pings by default, and the only
 * thing that turns it off is an option on the request.
 *
 * IT IS SET HERE AS WELL AS ON THE CLIENT, DELIBERATELY. `createClient` sets
 * the same option as a client-wide default and that default is worth keeping,
 * but it is a default: it applies to the sends that say nothing about mentions,
 * it lives four hundred lines from here, and the guarantee it makes is one that
 * a `send` passing its own `allowedMentions` for some other reason silently
 * replaces. This call puts a mention in a message ON PURPOSE, so the
 * suppression belongs next to it, where a reader of this function can see it
 * and a test can assert on the options that were actually handed to `send`.
 *
 * THE OTHER DELIBERATE MENTION IN THIS FILE SETS THE OPPOSITE OPTION, AND BOTH
 * ARE RIGHT. `noticeChannel`'s fallback passes `allowedMentions: { users: [id] }`
 * and DOES notify the person it names. The two are not an inconsistency and
 * neither is an oversight: this line is a RECORD, read by admins, about a member
 * — and a removal record that pings the person it is about turns evidence into a
 * poke. That one is the LAST RESORT of telling that member something, taken only
 * because the private route already failed, and a mention nobody is notified
 * about would reach nobody at all. Same markup, opposite jobs, opposite options,
 * each stated at its own send. Change one and you have not changed the other.
 *
 * EXPORTED SO THAT LAST PART IS POSSIBLE, for the same reason `remover` is. The
 * option is invisible from the front door — every caller above this sees a
 * `(line: string) => Promise<void>` and a string that reads correctly whether
 * or not the send suppresses anything — so a test coming in through
 * `handleMessage` cannot tell a suppressed mention from one that pings the
 * member the bot just deleted a message from.
 *
 * The channel this posts to is admin-only in the guild it runs in, which is why
 * a ping would usually land nowhere. That is a property of one server's
 * permission overwrites, changeable by anybody with Manage Roles and without
 * anybody touching this file, so it is not the thing the promise rests on.
 */
export function announcer(client: Client, channelId: string): (line: string) => Promise<void> {
  /**
   * ═══ "WORTH ONE LINE EACH TIME" WAS THE OLD RULE HERE AND IT WAS WRONG ═══
   *
   * A wrong id, a deleted channel or a missing permission is fixed by a person
   * editing a variable or a permission overwrite, and until they do, EVERY
   * removal this bot makes emits an identical error — same sentence, same one
   * field, forever. That is worse than the poller that started all this: a raid
   * produces removals far faster than thirty seconds apart, so the moment the
   * moderation record goes missing is the moment the status channel becomes
   * unreadable, and the two faults an operator most needs side by side are the
   * two that bury each other.
   *
   * IT MEETS BOTH HALVES OF THE TEST IN src/latch.ts: only a person ends it, and
   * every repeat carries the same `channel` and nothing else. Nothing is lost by
   * saying it once.
   *
   * THE FAULT'S OWN SENTENCE IS UNTOUCHED, and it still says which of the two
   * halves is broken — that was the reason it was a line at all, and it is still
   * the reason.
   */
  const posting = latch()

  return async (line) => {
    const channel = await client.channels.fetch(channelId)

    if (channel === null || !channel.isSendable()) {
      posting.fault({
        level: 'error',
        msg: 'log channel is missing or cannot be posted to',
        cleared: LOG_CHANNEL_BACK,
        fields: { channel: channelId },
      })
      return
    }

    // CLEARED ON SENDABLE AND NOT ON A SUCCESSFUL SEND. What the fault claims is
    // that the id names nothing this bot can post in, and that claim is answered
    // here; a `send` that then fails on a rate limit or a five-hundred is a
    // different fault and rejects to the caller, as it always has.
    posting.clear()

    await channel.send({ content: line, allowedMentions: { parse: [] } })
  }
}

/**
 * What the status channel says when the log channel comes back.
 *
 * IT NAMES THE CONSEQUENCE THE FAULT NAMED, WHICH IS THE POINT OF SAYING
 * ANYTHING. "The log channel works" is a fact about a channel; what the owner
 * wants to know is that the moderation record is being written again, because
 * that is what stopped.
 *
 * IT LANDS IN #bot-status AND NOT IN THE CHANNEL IT IS ABOUT, exactly like the
 * fault it clears — the two are a pair and have to be read together, and the
 * channel this is about is the one that was unreachable.
 */
const LOG_CHANNEL_BACK = 'the log channel can be posted to again, so removals are recorded there'

/**
 * The two ways this bot reaches a poster, built on the live client.
 *
 * `users.fetch` THEN `send` IS THE WHOLE OF THE DM. discord.js opens the DM
 * channel on the first send by itself, so there is nothing to cache and nothing
 * to clean up, and a fetch reads its own user cache first. A member who does not
 * accept DMs from this server makes the SEND reject — not the fetch — with
 * Discord's 50007.
 *
 * THE ERROR IS PASSED UP AS IT CAME, AND THAT IS WHAT LETS `notifier` TELL A
 * BOUNCE FROM A BAD MINUTE. Nothing here catches, wraps or re-throws: a
 * `DiscordAPIError` arrives at `dmsAreShut` with its `code` intact, so 50007 can
 * be separated from a 429 or a 500. An earlier version of this comment argued
 * the opposite — that a user who cannot be fetched and a user who will not
 * accept the message are the same outcome, so any rejection should spend the
 * fallback. They are the same outcome for the POSTER and not for the CHANNEL,
 * which is the half that pays for it; see `dmsAreShut`.
 *
 * THE FALLBACK IS THE ONE MESSAGE THIS BOT SENDS THAT PINGS ANYBODY, and the
 * option that makes that true is right here so it can be read and asserted.
 * `createClient` sets `allowedMentions: { parse: [] }` as a client-wide default
 * and `announcer` repeats it, because the moderation record names a member
 * without notifying them. This send is the opposite case on purpose: its only
 * job is to reach a member whose DMs are shut, and a mention that does not
 * notify — in a message the bot deletes again half a minute later — would reach
 * nobody at all and the fallback would be theatre.
 *
 * IT IS NARROWED TO ONE ID RATHER THAN TURNED ON. `{ users: [userId] }` allows
 * exactly the poster and nothing else: no `@everyone`, no role ping, and no
 * second user — so a notice can never be made to ping the guild by anything in
 * the text, which matters because the text is a template somebody will later
 * rewrite.
 *
 * THE MESSAGE TAKES ITSELF DOWN AGAIN, AND THE TIMER IS `unref`ed. A courtesy
 * note must not be the reason a restart waits thirty seconds — systemd restarts
 * this unit on every deploy — so a process that exits inside the window leaves
 * the line standing rather than holding the event loop open for it. That is the
 * cheaper of the two failures: one stale line in a channel, against a deploy
 * that hangs.
 *
 * THE DELETE'S OWN FAILURE IS LOGGED AND NOT THROWN. By the time it runs,
 * `notifier` has long since returned and there is nobody left to hand an error
 * to; an unhandled rejection out of a bare timer callback would take the
 * process down over a message somebody had probably already dismissed.
 */
export function noticeChannel(client: Client): NoticeChannel {
  return {
    dm: async (userId, text) => {
      const user = await client.users.fetch(userId)
      await user.send({ content: text, allowedMentions: { parse: [] } })
    },

    fallback: async (channelId, userId, text) => {
      const channel = await client.channels.fetch(channelId)

      if (channel === null || !channel.isSendable()) {
        // The channel the message was posted in, a moment ago. If it cannot be
        // posted to now, the bot has lost a permission or the channel is gone —
        // either way the poster cannot be told and somebody should know.
        throw new Error(`cannot post the removal notice in ${channelId}`)
      }

      const sent = await channel.send({
        content: text,
        allowedMentions: { users: [userId] },
      })

      setTimeout(() => {
        void sent.delete().catch((error: unknown) => {
          log('warn', 'could not take the removal notice back down', {
            channel: channelId,
            error,
          })
        })
      }, NOTICE_TTL_MS).unref()
    },
  }
}

/**
 * The bot's own faults, in a channel the owner is already in.
 *
 * WHY THIS EXISTS. Today a failed delete, a rate limit, an unusable log channel
 * or an unexpected exception reaches `journalctl` on the box and stops there.
 * The owner does not read journalctl — the standing rule is that there are no
 * CLI interactions with this bot or its data — so in practice those faults
 * reach nobody, and a bot that has quietly stopped moderating looks exactly
 * like a quiet guild. This is the copy that lands where he can see it.
 *
 * IT IS NOT THE MODERATION RECORD. `announcer` and BLITZ_LOG_CHANNEL_ID carry
 * what was removed and why, which is evidence about a member. This carries what
 * BROKE, which is evidence about the bot. The two point at the same channel
 * today and are still two different features; keeping them apart is why there
 * are two functions here rather than one with a flag on it.
 *
 * WARNINGS AND ERRORS ONLY — `log()` never offers this an `info`, and the
 * `Sink` type says so. A channel that also announced every start, every ready
 * and every deleted message would be a running commentary, and the whole value
 * of this one is that anything appearing in it needs a person.
 *
 * EVERY POST IS SERIALISED THROUGH ONE PROMISE CHAIN, and that is load-bearing
 * rather than tidy. `log()` is synchronous and fires the sink off unawaited, so
 * two faults a millisecond apart would otherwise be two concurrent posts, each
 * reading `seen` before the other had written to it — and the coalescing below
 * would post the same fault twice and then edit only one of them. The chain
 * also means the bot makes at most one Discord request at a time for this,
 * which is the cheapest possible answer to the rate limit.
 *
 * THE CHAIN MUST NEVER REJECT. A rejected promise skips every callback chained
 * onto it, so one unhandled failure would silence the channel permanently —
 * which is the exact failure this whole feature exists to stop happening
 * silently. `deliver` handles its own faults and the `.catch` below is the
 * structural guarantee that it did.
 */
export function statusReporter(client: Client, channelId: string): Sink {
  const seen = new Map<string, Repeat>()

  /**
   * Faults raised before the gateway was ready, held until it is.
   *
   * WITHOUT THIS, THE FAULTS THAT MEAN "THE BOT IS NOT RUNNING" ARE THE ONLY
   * ONES THAT NEVER POST. Everything below gates on `client.isReady()`, and
   * that gate used to be a `return` — so `login failed`, a gateway close on a
   * disallowed intent, a `client error` thrown while connecting, every fault
   * that happens on the way up, wrote its journal line and posted nothing.
   * Those are the most important things this bot can say and they were exactly
   * the ones the channel could not carry. Measured, before the fix: one journal
   * line, zero posts.
   *
   * THE GATE ITSELF STAYS, and it is not the bug. Before the gateway is up
   * there is no channel to fetch, and a fetch attempted then fails for reasons
   * that say nothing about the channel — which would latch it unusable for the
   * life of the process over a race. What changes is what happens to the fault
   * meanwhile: held, not dropped, and flushed by the same `clientReady` that
   * makes posting possible.
   *
   * ONE CASE REMAINS IRREDUCIBLE AND IS NOT A BUG TO FIX HERE. A login that
   * NEVER succeeds — a revoked token, an intent that is not ticked on in the
   * developer portal — has no gateway, so there is no channel and no way to
   * reach Discord at all; index.ts logs `login failed` and exits, and this
   * buffer is discarded with the process. Nothing inside a Discord bot can
   * report that over Discord. It is a systemd restart loop, and finding it is
   * what `journalctl -u blitz-bot -p warning` and docs/deploy.md are for.
   *
   * THE FIRST FAULTS ARE THE ONES KEPT when the buffer is full. A start that is
   * going wrong tends to produce one cause and then a run of consequences, and
   * the cause is the line worth having. Dropping the newest is therefore the
   * opposite choice from `remember` below, which evicts the oldest — there, the
   * newest occurrence is the evidence that a fault is still happening.
   */
  const early: { level: Level; msg: string; line: string }[] = []

  let usable = true
  let queued = 0
  let tail: Promise<void> = Promise.resolve()

  /**
   * Stop, and say why exactly once.
   *
   * A WRONG ID, A DELETED CHANNEL OR A MISSING PERMISSION DOES NOT GET BETTER
   * BY BEING RETRIED, and retrying it costs a journal line and a failed HTTP
   * request per fault for as long as the process lives — worst when the bot is
   * already in trouble and producing faults quickly. One line, then silence,
   * and the fix is a variable and a restart either way.
   *
   * This goes through `log()` like everything else, and the async context in
   * log.ts is what makes that safe: the line is written to the journal and is
   * not handed back to the sink that is currently running.
   */
  function giveUp(reason: string, fields: Record<string, unknown> = {}): void {
    usable = false
    log('error', `status channel unusable, nothing more will be posted to it: ${reason}`, {
      channel: channelId,
      ...fields,
    })
  }

  /**
   * Write the current count onto the message that is already reporting a fault.
   *
   * NEVER THROWS, like everything else that runs on the chain.
   *
   * NOTHING IS SENT WHEN THE COUNT HAS NOT MOVED since the last edit, which is
   * what makes a trailing flush free when the storm stopped on its own.
   */
  async function flush(entry: Repeat): Promise<void> {
    if (!usable || entry.count === entry.written) return

    // Read once and recorded BEFORE the await. Occurrences that arrive while
    // this request is in flight must schedule their own flush rather than
    // believing this one already carried them.
    const count = entry.count
    entry.written = count
    entry.edited = Date.now()

    try {
      await entry.message.edit(statusBody(entry.line, count, entry.last))
    } catch (error) {
      // The message was deleted, or the edit lost a race with something.
      // Forgetting the entry is what stops that repeating forever: the next
      // occurrence posts a fresh message instead of editing a dead one. Only if
      // the map still holds THIS entry — a trailing flush can land after the
      // window closed and a fresh message took its place.
      if (seen.get(entry.key) === entry) seen.delete(entry.key)

      // INFO, BECAUSE THE LINE ABOVE IS THE REPAIR. All that was lost is a
      // repeat count on one message; the next occurrence posts a fresh one, and
      // the channel is no worse off than it is after the window closes anyway.
      // Nothing here needs a person, and the failure that would — a channel
      // this bot cannot post in at all — has `giveUp` and its own error line.
      log('info', 'could not update the status channel message', { error })
    }
  }

  /**
   * Arrange for the count to reach Discord, at most once every
   * STATUS_EDIT_MS.
   *
   * THIS IS THE HALF OF FLOOD CONTROL THAT WAS MISSING. Coalescing collapsed
   * the CHANNEL — five hundred occurrences of one fault produced one message —
   * and left the API TRAFFIC exactly where it was: one PATCH per occurrence,
   * measured at ~500 requests for those 500 faults. The rate limit is spent
   * either way, and it is spent at the moment the bot is already in trouble and
   * raising faults as fast as it can. Folding in memory and writing the running
   * total on a timer collapses that to a handful of requests.
   *
   * THE FIRST REPEAT IS STILL PROMPT. `edited` starts at 0, so the edit that
   * turns one message into "seen 2 times" goes out immediately and the visible
   * behaviour of an occasional repeat is unchanged. It is only a burst — a
   * second occurrence and then hundreds inside the same window — that waits.
   *
   * THERE IS ALWAYS A TRAILING FLUSH. Throttling on the leading edge alone
   * would leave the last occurrences unwritten whenever a storm stopped, so the
   * posted message would understate what happened; the timer is what makes the
   * final edit carry the true total.
   *
   * `unref` SO A PENDING EDIT CANNOT HOLD THE PROCESS OPEN. A timer with
   * nothing but a count in it is not a reason for `systemctl stop` to wait.
   */
  function schedule(entry: Repeat, now: number): Promise<void> | null {
    const wait = STATUS_EDIT_MS - (now - entry.edited)

    if (wait <= 0) {
      // Already on the chain — the caller is `deliver`, which runs there — so
      // this is serialised with every send like the edit it replaces.
      return flush(entry)
    }

    if (entry.timer === null) {
      entry.timer = setTimeout(() => {
        entry.timer = null

        // Back onto the chain rather than straight into an edit, so a trailing
        // flush cannot overlap a send. Nothing awaits this: the occurrence that
        // scheduled it was reported as delivered when its journal line was
        // written, and `flush` handles its own faults.
        tail = tail.then(() => flush(entry)).catch(() => {})
      }, wait)

      entry.timer.unref()
    }

    return null
  }

  /**
   * Post one fault, or fold it into the message that already reported it.
   *
   * NEVER THROWS. See the chain above.
   */
  async function deliver(key: string, line: string): Promise<void> {
    // Checked here as well as at the sink's own gate, because a queued fault
    // can reach this after an earlier one latched the channel unusable — which
    // is exactly what a flush of the startup buffer looks like against a
    // misconfigured channel id.
    if (!usable) return

    const now = Date.now()
    const previous = seen.get(key)

    if (previous !== undefined && now - previous.posted < STATUS_WINDOW_MS) {
      previous.count += 1
      previous.last = now

      // Re-inserted so that a fault which is still repeating is not the one the
      // bound in `remember` evicts. A `Map` iterates in insertion order, so a
      // delete and a set are the whole of "least recently seen goes first".
      seen.delete(key)
      seen.set(key, previous)

      await schedule(previous, now)
      return
    }

    try {
      const channel = await client.channels.fetch(channelId)

      if (channel === null || !channel.isSendable()) {
        giveUp('the id names no channel this bot can send in')
        return
      }

      const message = await channel.send({
        content: statusBody(line, 1, now),
        // The same suppression `announcer` states at its own send, for the same
        // reason and one more: a rendered line can carry an id a stranger put
        // in an invite code, and nothing this bot posts may notify anybody.
        allowedMentions: { parse: [] },
      })

      remember(key, {
        key,
        message,
        line,
        posted: now,
        last: now,
        count: 1,
        written: 1,
        // Zero rather than `now`, so the first repeat is written immediately
        // and only a burst is made to wait. See `schedule`.
        edited: 0,
        timer: null,
      })
    } catch (error) {
      if (permanentlyUnusable(error)) {
        giveUp('the bot cannot post there', { error })
        return
      }

      // Rate limited, a 500, a network that went away. All transient, all
      // retried by the next fault, and none of them a thing anybody can do
      // something about — discord.js queues behind a rate limit on its own and
      // a 500 is Discord's. So: one journal line for whoever is working out why
      // a fault they expected never appeared, and no second alarm about the
      // alarm. The permanent case latches through `giveUp` at error instead.
      log('info', 'could not post to the status channel', { error })
    }
  }

  /**
   * Remember a posted fault, and forget the oldest when there are too many.
   *
   * BOUNDED, BECAUSE THIS PROCESS RUNS FOR MONTHS. The map is keyed on fault
   * text, which is small and fixed in a healthy bot and neither of those in a
   * broken one — an id reaching a `msg` string would make every occurrence a
   * new key. An unbounded map here is a leak that shows up only in production
   * and only after weeks, and it holds a discord.js `Message` per entry, so it
   * is not a leak of one string apiece.
   *
   * EVICTION COSTS ONLY THE COALESCING. An evicted fault that happens again
   * posts a new message instead of editing the old one, which is what happens
   * after the window closes anyway.
   */
  function remember(key: string, entry: Repeat): void {
    // Deleted first, because `set` on a key that is already there keeps its
    // ORIGINAL position in the iteration order — which would leave a fault that
    // just re-posted looking like the least recently seen one.
    seen.delete(key)
    seen.set(key, entry)

    while (seen.size > STATUS_MEMORY) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
  }

  /** Put one fault on the chain, or drop it because too much is already there. */
  function enqueue(level: Level, msg: string, line: string): Promise<void> {
    /**
     * A BOUND ON WHAT IS WAITING, not only on what is remembered. Coalescing
     * happens at the front of the queue, so a burst of DISTINCT faults still
     * queues one entry each — and a Discord that is answering slowly is exactly
     * when a burst arrives. What is dropped here is the channel copy of a fault
     * whose journal line was already written.
     */
    if (queued >= STATUS_BACKLOG) return Promise.resolve()

    queued += 1

    tail = tail
      .then(() => deliver(`${level} ${msg}`, redact(line)))
      .catch(() => {
        // Unreachable while `deliver` keeps its promise not to throw, and kept
        // anyway: this is what stops one bad post from poisoning the chain and
        // silencing every fault after it.
      })
      .finally(() => {
        queued -= 1
      })

    return tail
  }

  /**
   * The gateway came up, so everything held on the way up can now be said.
   *
   * `once`, AND REGISTERED HERE RATHER THAN IN index.ts, because the buffer is
   * this closure's and nothing outside it can flush it. index.ts builds the
   * sink before `client.login()`, so this listener is always in place before
   * there is any gateway to become ready.
   *
   * ORDERING IS NOT LOAD-BEARING FOR THIS ONE. createClient's own
   * `clientReady` listener runs first and may emit the halt line — that fault
   * finds `isReady()` already true and posts directly, without ever reaching
   * the buffer.
   *
   * NOTHING AWAITS THE FLUSH. `log()` fires this sink unawaited and there is no
   * caller here at all; `enqueue` returns a promise that cannot reject, so
   * discarding it is not an unhandled rejection.
   */
  client.once(Events.ClientReady, () => {
    for (const fault of early.splice(0, early.length)) {
      void enqueue(fault.level, fault.msg, fault.line)
    }
  })

  return (level, msg, line) => {
    if (!usable) return Promise.resolve()

    /**
     * NOTHING POSTS DURING STARTUP, AND THIS IS STILL THE WHOLE MECHANISM.
     * index.ts installs the sink before it logs in, so the gate is the client's
     * own readiness rather than an ordering between two listeners: before the
     * gateway is up there is no channel to fetch, and a fetch that failed then
     * would latch the channel unusable for the rest of the process over
     * nothing.
     *
     * WHAT IS GATED IS THE POST, NOT THE FAULT. A clean start emits no warning
     * and no error, so a normal restart still says nothing; a start that goes
     * wrong and then connects has its faults posted the moment there is
     * somewhere to post them. See `early` above for why that is the whole point
     * of this feature and for the one case it cannot cover.
     */
    if (!client.isReady()) {
      if (early.length < STATUS_EARLY) early.push({ level, msg, line })
      return Promise.resolve()
    }

    return enqueue(level, msg, line)
  }
}

/**
 * One fault that has already been posted, and the message reporting it.
 *
 * `line` IS THE FIRST OCCURRENCE'S, kept so that an edit can rebuild the whole
 * body from it. Later occurrences differ only in their fields and their
 * timestamp — that is what made them the same fault — and rewriting the body
 * with the newest one would quietly change which channel or author the entry
 * names while the count says it happened forty times.
 */
interface Repeat {
  /**
   * The key this entry is filed under in `seen`, carried on the entry so that a
   * flush arriving late can tell whether the map still holds IT rather than a
   * fresh message posted after the window closed.
   */
  readonly key: string

  /**
   * Structural rather than discord.js's `Message`, for the reason every other
   * boundary in this file is: a test can write this down in one line, and the
   * only thing needed from a `Message` here is the ability to edit it.
   */
  readonly message: { edit: (content: string) => Promise<unknown> }
  readonly line: string
  readonly posted: number

  /** When the most recent occurrence arrived — the `last` in the posted body. */
  last: number

  /** How many times this fault has happened inside the window. */
  count: number

  /**
   * The count as of the last edit that was actually SENT, which is what makes
   * "nothing changed since the last one" a request that does not have to be
   * made at all.
   */
  written: number

  /** When that edit went out, or 0 while none has. See `schedule`. */
  edited: number

  /** The trailing flush, while one is waiting. See `schedule`. */
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * How long identical faults fold into one message.
 *
 * MEASURED FROM THE FIRST POST, NOT THE LAST. A fault that repeats forever
 * therefore produces a fresh message every five minutes rather than one message
 * quietly edited for a week — which is the difference between a channel that
 * resurfaces an ongoing problem and one that looks idle while the bot is on
 * fire. Inside the window it is one message and a count, which is the half that
 * keeps sixty failures a minute from burying everything else in the channel.
 */
const STATUS_WINDOW_MS = 5 * 60 * 1000

/**
 * The shortest gap between two edits of the same message.
 *
 * THIS IS A REQUEST BUDGET, NOT A DISPLAY DECISION. Discord's own limit on
 * editing a message is a handful of requests every few seconds, and the folding
 * above used to spend one PATCH per occurrence — so a fault repeating sixty
 * times a minute burned the whole allowance to keep a number on one message
 * up to date. Ten seconds bounds that to at most thirty edits inside a
 * five-minute window however hard the bot is failing, and a number that is at
 * most ten seconds stale is not a number anybody is reading that closely.
 */
const STATUS_EDIT_MS = 10_000

/** How many distinct faults can be folding at once. See `remember`. */
const STATUS_MEMORY = 50

/** How many posts may be waiting on the chain. See the sink's own comment. */
const STATUS_BACKLOG = 20

/**
 * How many faults raised before the gateway is ready are held for it.
 *
 * SMALL ON PURPOSE. This holds what happened during one connect, and a start
 * that produces more than twenty distinct faults before it reaches `ready` has
 * said everything it needs to in the first few. See `early`.
 */
const STATUS_EARLY = 20

/**
 * How much of a rendered line survives into the channel, in UTF-16 code units.
 *
 * DISCORD REFUSES A MESSAGE OVER 2000 CHARACTERS OUTRIGHT, and a rejected send
 * is a fault that never gets reported at all. The rest of the budget is the
 * code fence and the repeat count.
 *
 * UTF-16 UNITS, WHICH IS WHAT DISCORD COUNTS, AND THIS USED TO COUNT CODE
 * POINTS. It is the same fault `fitEmbed` had and the same one profile.ts's
 * limits block is written around: the 2000 applies to the JSON string as it
 * arrives, which is UTF-16, so a code-point count UNDERSTATES every astral
 * character by half. 1800 musical symbols measured 1800 here and reached Discord
 * as 3600 units inside a fence, and the send came back 50035 — a fault that
 * never got reported, which is precisely what this cap exists to prevent. It was
 * only ever reachable through a value written by somebody else (a webhook's
 * name, an error's text), which is why nothing tripped over it by accident.
 */
const STATUS_LINE_CAP = 1800

/**
 * The posted message: the journal line, and how many times it has happened.
 *
 * INSIDE A CODE FENCE, AND THAT IS A NEUTRALISER RATHER THAN STYLING. The line
 * carries values written by strangers — an invite code, a webhook's name
 * reflected back out of an error — and inside a fence Discord renders every one
 * of `*` `_` `~~` `|| ||` `@everyone` `<@id>` literally, links nothing and
 * pings nobody. It is also exactly what `journalctl` shows, so a line pasted
 * out of the channel into an issue is the string an operator would have
 * grepped.
 *
 * THIS IS THE FAULT PATH'S BODY AND NOT EVERY POST'S. The deploy notice reaches
 * the same channel through `statusPoster` and is not fenced, because nothing in
 * it is borrowed and it is meant to render a link — see there for the whole
 * distinction. What decides the fence is where the text came from, never which
 * channel it is going to.
 *
 * THE COUNT SITS OUTSIDE THE FENCE and is absent altogether on the first post,
 * because `seen 1 times` on something that has happened once is noise on every
 * line in the channel to make the fortieth one cheaper to write.
 */
function statusBody(line: string, count: number, last: number): string {
  const quoted = ['```', line, '```'].join('\n')
  if (count === 1) return quoted

  return `${quoted}\nseen ${count} times, last ${new Date(last).toISOString()}`
}

/**
 * What is allowed to leave the process.
 *
 * THE TOKEN MUST NEVER REACH THE CHANNEL. #bot-status is admin-only in this
 * guild, which is one permission overwrite away from not being, and a bot token
 * in a message is a full takeover of an application whose credentials are
 * shared with the Ringmaster console. Nothing in src/ logs the token today —
 * that was checked call site by call site — but this sink is a general hook on
 * every warning and error the bot will ever emit, including the ones nobody has
 * written yet, so the guarantee is made here where it holds for all of them.
 *
 * URLS GO FIRST AND GO WHOLE. An error object is the realistic carrier: undici
 * and discord.js put a request URL in the message of some failures, and a
 * Discord WEBHOOK url carries its own token as the last path segment — posting
 * one hands anybody reading the channel the ability to speak as that webhook.
 * No URL this bot could log is worth more than the ids already in the fields
 * beside it.
 *
 * THEN ANYTHING SHAPED LIKE A TOKEN. A Discord token is three base64url runs
 * separated by dots and is recognisable without knowing the value, which
 * matters: the value is not available here, and passing it in would mean
 * handing the token to the one function whose job is making sure it never
 * leaves.
 *
 * MESSAGE CONTENT IS NOT SCRUBBED HERE BECAUSE IT NEVER ARRIVES. A removal
 * names the author, the channel and the invite codes and never what was said —
 * see `removedLine` — and no `log()` call in the bot passes message text. That
 * is a property of the call sites rather than of this function, and it is the
 * one item on this list that a reviewer of a new log line has to check by hand.
 *
 * BACKTICKS ARE REMOVED, because three of them close the fence in `statusBody`.
 * Values are JSON-quoted by `render`, so a backtick inside one is literal text
 * and cannot arrive from an escape sequence; it can still arrive from a
 * webhook's name.
 */
function redact(line: string): string {
  const scrubbed = line
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(/[\w-]{20,}\.[\w-]{6,}\.[\w-]{25,}/gu, '[redacted]')
    .replace(/`/gu, '')

  // MEASURED IN THE UNITS DISCORD COUNTS, AND CUT WHERE A CHARACTER ACTUALLY
  // ENDS. Two different questions with two different answers: `String#length`
  // is the number the 2000 is checked against, so that is what decides whether
  // this is too long; but a `slice` at that number can land inside a surrogate
  // pair and leave half a character in the post, so the walk is over CODE
  // POINTS and stops when the UTF-16 total would be exceeded.
  if (scrubbed.length <= STATUS_LINE_CAP) return scrubbed

  // The ellipsis is inside the budget rather than added to it, so what comes
  // back always satisfies the cap it was measured against.
  const room = STATUS_LINE_CAP - 1
  let kept = ''

  for (const point of scrubbed) {
    if (kept.length + point.length > room) break
    kept += point
  }

  return `${kept}…`
}

/**
 * Whether a failed post means the channel will never work again.
 *
 * THE DISTINCTION IS "FIX THE CONFIG" AGAINST "TRY AGAIN LATER". A rate limit,
 * a 500 or a dropped connection is the second, and latching on one of those
 * would turn a bad ten seconds into a bot that reports nothing until the next
 * restart. These three are the first: the id is wrong, the channel is gone, or
 * the bot was never given permission to speak there.
 */
function permanentlyUnusable(error: unknown): boolean {
  if (!(error instanceof DiscordAPIError)) return false

  return (
    error.code === RESTJSONErrorCodes.UnknownChannel ||
    error.code === RESTJSONErrorCodes.MissingAccess ||
    error.code === RESTJSONErrorCodes.MissingPermissions
  )
}

/**
 * WHICH COMMIT THIS PROCESS IS RUNNING, SAID ONCE, WHEN IT CHANGES.
 *
 * THE OWNER ASKED FOR THIS ABOUT UPDATES — "when an update is installed I
 * expect a message in the log channel telling us which commit it's running
 * now". An update restarts the bot, so the bot reporting its own commit at
 * startup IS that message, and it is the better half of the pair: an updater
 * can only say what it INSTALLED, and a tree that was installed and a process
 * that came up on it are different facts. What this posts is the second one.
 *
 * THE STATUS CHANNEL, NOT THE LOG CHANNEL, and the wording of the request is
 * not the reason to put it in BLITZ_LOG_CHANNEL_ID. That channel carries the
 * moderation record — what was removed and why, which is evidence about a
 * member. A deploy notice is evidence about the BOT, which is what
 * BLITZ_STATUS_CHANNEL_ID and `statusReporter` are for. The owner said "log
 * channel" because it is the only channel he has configured today; the two are
 * separate features and keeping them apart is the same argument `announcer` and
 * `statusReporter` already make.
 *
 * IT POSTS ONLY WHEN THE COMMIT CHANGED, AND THAT IS THE WHOLE DIFFICULTY.
 * `Restart=always` means this process starts again five seconds after every
 * crash. A channel that says "running abc1234" on each of those is unsolicited
 * noise — the owner has a standing rule against exactly that — and it is noise
 * that arrives in a burst on top of the faults explaining the crash, which is
 * the one moment the channel has to be readable. So the sha on disk is compared
 * against the last one this bot REPORTED, and a restart on the same commit says
 * nothing at all.
 *
 * A MISSING FILE IS NOT A FAULT AND POSTS NOTHING. A hand-cloned box, a first
 * start before any update has ever run, someone running the bot from a checkout
 * on a laptop: in all three there is no deployed-commit file, and the correct
 * behaviour is silence rather than a warning about a feature nobody set up.
 */

/** A short git sha, as `git rev-parse --short` writes one. */
const SHORT_SHA = /^[0-9a-f]{7,40}$/u

/**
 * Where this bot's source lives, so a sha can be a link to the commit.
 *
 * A MODULE CONSTANT HERE, AND DELIBERATELY NOT IN `Config`. Everything in
 * config.ts is a thing that DIFFERS between deployments and that an operator
 * has to supply — a token, a guild, three channel ids — and every one of them
 * is a thing they can get wrong. This is not one of those: it is a fact about
 * the SOURCE this process was built from, identical on the box, on a laptop and
 * in CI, and there is no deployment for which a different value would be right.
 * Making it an environment variable would buy nothing and would introduce a
 * failure this feature cannot otherwise have — a notice whose sha is a link
 * into somebody else's repository, which reads as authoritative and points at
 * code the bot is not running.
 *
 * BESIDE `SHORT_SHA` AND `deployedCommitPath` RATHER THAN INSIDE THE BUILDER,
 * because those three are the whole answer to "where does the commit in that
 * message come from": what shape it must be, which file it was read out of, and
 * what it names. A literal buried in `deployNotice` would be a URL nobody reads
 * until it is wrong, and the next thing that wants the repo — a compare link, an
 * issue link — would grow a second copy of it.
 *
 * NO TRAILING SLASH, and the paths below add their own. `/commit/<sha>` is
 * GitHub's own route and it resolves an abbreviated sha, which is what the
 * updater writes.
 */
const REPO_URL = 'https://github.com/WillMontgomery/blitz-bot'

/**
 * The notice itself, in the owner's words.
 *
 * THE WORDING IS HIS AND IS REPRODUCED EXACTLY, including the full stop and the
 * capital on "Now". The sha is a MASKED LINK — `[text](url)` — so the message
 * says the short sha and one click reaches the commit, instead of an operator
 * copying seven characters into a search box.
 *
 * A MASKED LINK WORKS BECAUSE A BOT SENT IT. Discord refuses `[text](url)` in
 * message content that a HUMAN types and renders it as literal brackets; it
 * renders it as a link in content posted by an application, which is what this
 * is. So the notice needs no embed, and does not get one — an embed would be a
 * box drawn around one sentence.
 *
 * IT MUST NOT BE FENCED, WHICH IS WHY IT DOES NOT TAKE THE FAULT PATH. Inside a
 * code fence the markdown above is inert and this arrives as literal brackets
 * and a bare URL. See `statusPoster` for the distinction and for why this line
 * is allowed to be formatted when a fault line is not.
 */
function deployNotice(sha: string): string {
  return `Update installed. Now running [${sha}](${REPO_URL}/commit/${sha})`
}

/**
 * Where the updater records what it installed.
 *
 * DERIVED FROM THIS FILE'S OWN LOCATION, NOT TYPED OUT. This module is
 * <repo>/src/client.ts wherever the repo happens to be, so the parent of its
 * directory is the repo root — /opt/blitz-bot on the box, and somebody's
 * checkout when the bot is run by hand. A literal /opt/blitz-bot would make a
 * hand-run bot read the deployed box's file and report a commit it is not
 * running.
 */
export function deployedCommitPath(): string {
  return join(import.meta.dirname, '..', '.deployed-commit')
}

/**
 * Where the bot remembers the last commit it announced.
 *
 * DELIBERATELY NOT IN THE REPO, AND THAT IS THE LOAD-BEARING PART. The updater
 * owns /opt/blitz-bot: it runs `git reset --hard origin/main` in it and writes
 * the deployed-commit file into it. Anything this bot remembers under that
 * directory is a file the updater can overwrite or discard, and then the notice
 * either repeats on every restart or never fires again — the two failures this
 * whole comparison exists to avoid.
 *
 * /var/lib/blitz-bot IS THE UNIT'S `StateDirectory=`. systemd creates it, owns
 * it to the service user and keeps it writable while `ProtectSystem=strict`
 * puts the rest of the filesystem back to read-only — which is what it is now
 * that updating no longer happens inside the bot's own start. It is the only
 * path this process can write, and it survives a restart and a reboot.
 *
 * systemd's OWN ANSWER FIRST. `StateDirectory=` exports `STATE_DIRECTORY`
 * (colon-separated when a unit names more than one), so the unit file and this
 * function cannot drift apart about where the directory is. The literal is the
 * fallback for a bot started by hand, where the write will usually fail — which
 * is a fault, handled as one, and never a reason not to start.
 */
export function reportedCommitPath(): string {
  const [first] = (process.env.STATE_DIRECTORY ?? '').split(':')
  const state = first === undefined || first === '' ? '/var/lib/blitz-bot' : first

  return join(state, 'reported-commit')
}

/**
 * The two files, behind three functions.
 *
 * STRUCTURAL FOR THE REASON EVERY OTHER BOUNDARY IN THIS FILE IS: the rules
 * about what posts and what stays quiet are the difficult part, and they are
 * worth exercising against a missing file, an unreadable one and a malformed
 * one without a test having to arrange any of those on a real disk.
 */
export interface CommitFiles {
  /** The commit the updater last installed. Rejects when there is no file. */
  readonly deployed: () => Promise<string>

  /** The commit this bot last reported. Rejects when it has never reported one. */
  readonly reported: () => Promise<string>

  /** Record a commit as reported, so the next start knows not to repeat it. */
  readonly remember: (sha: string) => Promise<void>
}

export function commitFiles(
  deployedPath: string = deployedCommitPath(),
  reportedPath: string = reportedCommitPath(),
): CommitFiles {
  return {
    deployed: () => readFile(deployedPath, 'utf8'),
    reported: () => readFile(reportedPath, 'utf8'),

    // A trailing newline, so the file is one an operator can `cat` without it
    // running into the next prompt, and so it is the same shape as the file the
    // updater writes.
    remember: (sha) => writeFile(reportedPath, `${sha}\n`, 'utf8'),
  }
}

/**
 * Post the commit, if there is one to post and it is not the one already said.
 *
 * THE POST HAPPENS BEFORE THE REMEMBERING, and the order is a decision. The
 * file means "this commit was reported", so writing it first and then failing
 * to post would make it a lie and lose the notice permanently — the next start
 * would compare equal and stay quiet. This way a failed post is retried by the
 * next start, which is the only start that could have noticed.
 */
export async function reportDeployedCommit(
  files: CommitFiles,
  post: (content: string) => Promise<void>,
): Promise<void> {
  const deployed = await readSha(files.deployed, 'the commit the updater recorded')
  if (deployed === null) return

  const reported = await readSha(files.reported, 'the commit last reported')
  if (reported === deployed) return

  await post(deployNotice(deployed))

  try {
    await files.remember(deployed)
  } catch (error) {
    // Worth a fault line: it is not visible from Discord, and its consequence
    // is that this notice comes back on every single restart — the exact noise
    // the comparison exists to prevent.
    log('warn', 'could not record the reported commit, the notice will repeat on every start', {
      error,
    })
  }
}

/**
 * One sha out of one file, or null and a reason.
 *
 * THE THREE ANSWERS ARE DELIBERATELY DIFFERENT. A file that is not there is the
 * ordinary state of a box nobody has deployed to and gets no line at all. A
 * file that cannot be READ, or that holds something which is not a commit id,
 * means the updater is broken — the bot cannot fix that and must not post a
 * deploy notice about it, but the journal says so, and through the sink so does
 * the status channel.
 *
 * THE CONTENT IS NEVER LOGGED, ONLY ITS LENGTH. Whatever sits in a file this
 * process did not write is not a thing to copy into a channel.
 */
async function readSha(read: () => Promise<string>, what: string): Promise<string | null> {
  let raw: string

  try {
    raw = await read()
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null

    log('warn', `could not read ${what}`, { error })
    return null
  }

  const sha = raw.trim()
  if (SHORT_SHA.test(sha)) return sha

  log('warn', `${what} is not a commit id`, { length: sha.length })
  return null
}

/**
 * Sending one line to the status channel.
 *
 * A THROW RATHER THAN A LOGGED RETURN when the channel cannot be posted to, so
 * that `reportDeployedCommit` does not record a notice as delivered when
 * nothing was sent. `statusReporter` makes the opposite choice for the same
 * condition because it has somewhere to latch and a whole process's worth of
 * later faults to protect; this runs exactly once.
 *
 * THE CONTENT GOES OUT VERBATIM: NO `redact`, AND NO CODE FENCE. That is the
 * deliberate half of a distinction rather than a step somebody forgot, and it
 * is the reason there are two ways into this one channel at all. FAULTS take
 * `statusReporter`, where every line is scrubbed by `redact` and wrapped in a
 * fence by `statusBody` — because a fault line carries values a stranger chose
 * (a webhook's name, an error message with somebody's text reflected back), and
 * inside a fence Discord renders all of it literally, links nothing and pings
 * nobody. THIS path carries lines the bot wrote about itself.
 *
 * SO THE RULE IS "BORROWED TEXT IS FENCED", NOT "THIS CHANNEL IS FENCED", and
 * these two functions are what state it. Its only caller is the deploy notice,
 * which is a literal sentence plus a sha that `readSha` has already matched
 * against `SHORT_SHA` — seven to forty hex characters, which cannot be markup,
 * cannot be a mention and cannot close anything that was opened. It is also the
 * one line in the channel that is MEANT to be formatted: fencing it would
 * render the owner's link as literal brackets. A caller added here that carries
 * anybody else's text belongs on `statusReporter` instead, and if one ever has
 * to be on this path it fences its own borrowed values before it arrives.
 *
 * THE SAME MENTION SUPPRESSION `announcer` STATES AT ITS OWN SEND. The content
 * here is a sentence, a hex sha and a github.com URL, none of which can carry a
 * mention, and the guarantee is still made at the call rather than left to the
 * client-wide default, because that default is silently replaced by any send
 * that passes an `allowedMentions` of its own and a reader of this function
 * cannot see it.
 */
export function statusPoster(
  client: Client,
  channelId: string,
): (content: string) => Promise<void> {
  return async (content) => {
    const channel = await client.channels.fetch(channelId)

    if (channel === null || !channel.isSendable()) {
      throw new Error('the status channel id names no channel this bot can send in')
    }

    await channel.send({ content, allowedMentions: { parse: [] } })
  }
}

/**
 * Wire the notice to the gateway coming up.
 *
 * `clientReady` IS THE EARLIEST POINT THERE IS A CHANNEL TO POST TO, and it is
 * also the one event that says this process really did start on that commit
 * rather than merely being handed it.
 *
 * `once`, BECAUSE A RECONNECT IS NOT A DEPLOY. discord.js does not re-emit it
 * on a resumed session, and if a later version did, the sha comparison would
 * keep it quiet anyway — this is belt and braces on a rule that already holds.
 */
export function announceDeployedCommit(
  client: Client,
  channelId: string,
  files: CommitFiles = commitFiles(),
): void {
  client.once(Events.ClientReady, () => {
    void reportDeployedCommit(files, statusPoster(client, channelId)).catch((error: unknown) => {
      // Including a channel that cannot be posted to. One line, and the bot
      // carries on moderating: a deploy notice that did not land is not a
      // reason to be down.
      log('warn', 'could not report the commit this bot is running', { error })
    })
  })
}

/**
 * THE BOT DOCUMENTS ITSELF, AND THE REPO IS THE SOURCE OF TRUTH.
 *
 * docs/bot-manual.md is the document; the docs channel is a rendering of it
 * that the bot brings back into agreement with the file on every start. Nobody
 * has to remember to update a wiki, and the docs cannot drift from the code
 * without the drift being visible in a channel the admins already read.
 *
 * THE FILE IS NOW A TEMPLATE AND THE CONFIGURATION IS THE OTHER HALF. Two of its
 * passages describe exemptions and are published only when those exemptions are
 * running, and one of them names the exempted channels inline. `renderManual`
 * and the header above it are the whole of that; everything below this line
 * works on the RENDERED document and does not know a template was involved.
 *
 * THE WHOLE MANUAL IS ONE EMBED IN ONE MESSAGE. THAT IS THE OWNER'S CORRECTION
 * AND IT IS WHY THIS HALF IS A THIRD OF THE SIZE IT WAS. It used to be an embed
 * per top-level heading — eleven messages in his channel — and the first time
 * he read it: "Holy cow - those embeds are plain and LOOONNGGG. The manual
 * should be no more than 1 embed". A reference card read in one screen, rather
 * than a channel to scroll.
 *
 * AND THE WHOLE DOCUMENT IS THE DESCRIPTION, WHICH IS HIS SECOND CORRECTION:
 * "bot docs headers should be larger font". The `## ` sections used to be embed
 * FIELDS, and a field name is not a heading — Discord renders it bold, at body
 * size, and renders no markdown in it at all. The same `## ` line in the
 * DESCRIPTION is a real heading, at heading size. So the `# ` line is the
 * embed's title and everything under it is the description, verbatim, headings
 * and all.
 *
 * WHICH MEANS THE DESCRIPTION CAP IS NOW THE ONE THAT BINDS: 4096 units for the
 * document, where the old shape had six caps to satisfy and 6000 in total. The
 * manual is prose, so it loses nothing by leaving fields behind — columns earn
 * their place on /profile, which carries numeric tiles, and not here.
 *
 * AND THE LAYOUT CODE WENT WITH THEM: the inline decision, the per-field caps,
 * the field-by-field comparison, and the refusal of a field with nothing in it.
 * There are no fields to lay out, to measure, or to leave empty.
 *
 * AND EVERYTHING THAT ONLY EXISTED FOR MANY MESSAGES IS GONE: matching a
 * section to a message by its heading, the per-section reconcile, two sections
 * sharing a heading, the mark stamped on a section that could not be published,
 * the per-section refusal, and the circuit breaker that refused to delete most
 * of the channel. Every one of those was built because THE FILE IS
 * AUTHORITATIVE AND THE CHANNEL IS THE STATE, so any misreading of the file
 * came out of the far end as DELETIONS of sections that were still in it — an
 * unclosed code fence, an empty file, a read that stopped at its own limit. Each
 * of them limited the damage a parse bug could do to a channel full of
 * documentation. With one message there is one message: the worst a misparse
 * can now do is put a wrong version of the manual in front of a reader for as
 * long as it takes to fix the file, and the next start writes it again.
 *
 * THE ONE GUARD WORTH KEEPING IS THE ONE WHERE ACTING ON A BAD PARSE STILL
 * DESTROYS SOMETHING. A manual that cannot be READ, or that parses to nothing,
 * leaves the channel EXACTLY as it was found: not read, not written, not
 * emptied. A missing or unparseable file is a checkout of an older commit or a
 * botched deploy, and "the manual is now empty" is the worst possible reading of
 * one. See `readManual`, `parseManual` and the first lines of `syncManual`.
 *
 * AN IDENTICAL MANUAL IS COMPLETELY SILENT. No post, no edit, no info line.
 * This process restarts on every deploy and on every crash, and a channel that
 * stirs each time is a channel nobody reads — the same argument the deploy
 * notice above is built around. The comparison is a plain equality between what
 * Discord handed back and what the file RENDERS TO; see `unchanged`.
 *
 * WHICH IS WHY A CONFIGURATION CHANGE REPUBLISHES AND AN UNCHANGED ONE DOES NOT.
 * The compared text is the rendering, so exempting a channel edits the message
 * on the next start with nobody touching the file, and a restart that changes no
 * setting renders the identical string and writes nothing. Both halves fall out
 * of comparing the rendering rather than the file; see `syncDocsChannel`.
 *
 * THE CHANNEL IS THE STATE, AND THERE IS NO LOCAL RECORD OF WHAT WAS POSTED.
 * A file saying "the manual is message 123" is a claim about a channel any admin
 * can edit with a right-click, and the moment somebody deletes that message by
 * hand the claim is a lie that stops the manual ever being posted again. So
 * every start reads the channel back and derives everything from what is
 * actually there: a hand-deleted manual comes back, and every OTHER message of
 * ours in the channel is a leftover to remove. That last clause is also the
 * changeover — the eleven messages the old model left in the owner's channel
 * become one on the first start after this, because ten of them are leftovers.
 * The circuit breaker would have refused that as "deleting most of the channel",
 * which is the other reason it is gone.
 *
 * NOTHING HERE MAY DELAY OR BREAK MODERATION. Every failure in this half is
 * caught, written down and dropped; a missing manual is one warn and the bot
 * carries on scanning. Documentation is the least important thing this process
 * does.
 */

/**
 * The document, parsed: the one `# ` heading, and everything under it.
 *
 * THE SHAPE IS THE EMBED'S SHAPE, and that is deliberate — a title and a
 * description. The parser's job is to say what the document IS, and under this
 * model a document that cannot be described in those two parts is a document
 * that cannot be published at all.
 *
 * `body` IS THE FILE'S OWN TEXT AND NOT A RENDERING OF IT. The `## ` lines are
 * still in it, which is the whole point: Discord renders them as headings in a
 * description. Nothing here rewrites, wraps or reflows the markdown — what the
 * file says is what the channel shows.
 */
export interface Manual {
  readonly title: string
  readonly body: string
}

/**
 * The manual as one embed: everything that goes out in one message.
 *
 * `colour` AND NOT `color`, matching the rest of this repo, with the American
 * spelling confined to the two lines that speak to discord.js — `apiEmbed` and
 * the read in `ours`.
 *
 * THERE IS NO THUMBNAIL AND THAT IS AN ANSWER RATHER THAN AN OMISSION. The
 * owner was asked and said no: a thumbnail takes about a fifth of the width off
 * every line of a reference card, and the bot's own avatar is already at the top
 * of the message. Width is worth more than a second copy of the avatar.
 *
 * THE STAMP IS AN INSTANT AND NOT A STRING, WHICH IS THE POINT OF THE FIELD.
 * `footer` is the word "updated" and nothing else; `stampedAt` is the moment,
 * carried as a `Date` all the way to `apiEmbed`, which is the only place it
 * becomes the ISO8601 text Discord's `timestamp` field wants. Discord renders
 * that field on the footer line — footer text, a bullet, then the time IN EACH
 * READER'S OWN TIMEZONE — so the two halves are one line to a reader and two
 * values here.
 *
 * AND THE TIME IS NOT IN `footer` BECAUSE IT CANNOT BE. `footer.text` parses no
 * markdown: `<t:1234567890:f>` written there is shown as those literal
 * characters, so the timestamp markup that works in a description would publish
 * angle brackets into a documentation channel. The native field is the only
 * mechanism on this surface that renders, and Discord has declined to add
 * another (discord/discord-api-docs#3777, 2026-02-08: embeds are getting no new
 * features), so this will not become possible later either.
 */
export interface ManualEmbed {
  readonly title: string
  readonly description: string
  readonly colour: number
  readonly footer: string
  readonly stampedAt: Date
}

/**
 * One of the bot's messages already in the channel, reduced to what the
 * comparison reads.
 *
 * EVERY FIELD HERE IS THE STORED STRING AND NOT A RENDERED VIEW. The comparison
 * that decides whether anything is sent is a plain equality between this and the
 * built embed, so both sides have to be the same kind of value: what Discord
 * gave back, verbatim. Comparing anything that had been through a renderer would
 * make every start a diff of two formattings and every restart an edit.
 *
 * THE FOOTER TEXT IS HERE AND THE INSTANT BESIDE IT IS NOT, AND THAT SPLIT IS
 * THE WHOLE OF THE RULE. `stampedAt` is a fresh moment on every start, so reading
 * it back and comparing it would make every start differ from the last one and
 * rewrite the channel forever. It goes out only on a write, which is what makes
 * it a last-CHANGED stamp rather than a last-checked one. `footer` moves only
 * when somebody edits the word, so it is compared like the title and the colour.
 *
 * THE WORD USED TO BE EXCLUDED AND THAT WAS RIGHT UNTIL IT WAS NOT. The footer
 * was `updated ${new Date().toISOString()}` — the time lived IN the text, so it
 * was different on every start and comparing it would have reposted the manual
 * on every deploy and every crash. The instant moved to `stampedAt`, the text
 * became the constant word, and the reason went with the ISO string.
 *
 * LEAVING IT OUT AFTER THAT COST A REAL DEFECT. The footer's wording changed and
 * the owner's channel kept the old one — silently, and forever, because nothing
 * in the comparison could see the difference. A published message that says
 * something the code no longer says is exactly the drift this feature exists to
 * prevent, and the footer was the one line of it nobody was watching.
 *
 * WHICH IS ALSO THE CONDITION ON ANY FOOTER AFTER THIS ONE. A per-start value put
 * back into this text puts the channel back to rewriting itself on every restart;
 * a value that moves per start belongs on `stampedAt`, which is not read back at
 * all. Compare what the file decides, never what the clock does.
 */
export interface PostedManual {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly colour: number | null
  readonly footer: string
}

/**
 * The channel, as the four operations this needs.
 *
 * STRUCTURAL, FOR THE REASON EVERY OTHER BOUNDARY IN THIS FILE IS. The awkward
 * cases — a message somebody deleted by hand, a channel still holding the old
 * model's eleven messages, a write Discord refuses — are worth exercising
 * against a fake built three lines above the assertion rather than against a
 * live channel that would have to be vandalised on purpose.
 *
 * `read` ANSWERS THE BOT'S OWN MESSAGES, OLDEST FIRST, and the order is
 * load-bearing: the first of them is the manual and the rest are leftovers.
 */
export interface DocsChannel {
  readonly read: () => Promise<readonly PostedManual[]>
  readonly post: (embed: ManualEmbed) => Promise<void>
  readonly edit: (id: string, embed: ManualEmbed) => Promise<void>
  readonly remove: (id: string) => Promise<void>
}

/**
 * Discord's limits on one embed, in UTF-16 code units.
 *
 * COUNTED IN UTF-16 CODE UNITS, WHICH IS WHAT DISCORD COUNTS, and this had the
 * failure backwards once already. The caps are on the JSON string as it
 * arrives, which is UTF-16, so counting CODE POINTS understates every astral
 * character by half: 4096 musical symbols passed a 4096 guard at 8192 units and
 * the post came back 50035, which is the one outcome the check exists to
 * prevent. `String.length` is the number Discord is checking against.
 *
 * ONE RECORD RATHER THAN THREE CONSTANTS, so `embedBudget` can walk them and so
 * the test over the shipped document can hold the manual to these numbers
 * without writing any of them down a second time. A cap restated in a test is a
 * cap that is wrong in one of the two places.
 *
 * THREE, WHERE THERE WERE SIX. The `## ` sections are text in the description
 * now rather than fields, so the three caps that were about fields — how many,
 * how long a name, how long a value — are caps on a thing this embed no longer
 * has.
 *
 * `description` IS THE ONE THAT BINDS, and that is the price of the change: the
 * whole document has to fit in 4096 where it used to have 1024 per section and
 * 6000 across the message. `total` cannot bite while the other two hold — 256
 * and 4096 and a footer come to well under 6000 — and it stays because it is
 * Discord's cap on the payload rather than an inference of ours, and inferences
 * are what stop being true when somebody adds a field back.
 *
 * THE DOCUMENT THAT SHIPS TODAY FITS, AND THE TEST OVER IT IS WORTH MORE THAN
 * THIS CONSTANT. A manual is a file anybody can add a paragraph to without ever
 * running the bot, and the failure that causes is a message Discord refuses
 * outright — the whole manual gone from the channel rather than one long
 * paragraph.
 *
 * AND THE 4096 IS MEASURED ON THE RENDERING, WHICH IS WHAT THE TEMPLATE CHANGED.
 * There is no longer one document: `renderManual` produces a family of them, and
 * the one that has to fit is the LONGEST — every conditional block included,
 * with the exempt channels spelled out as `<#…>` mentions.
 *
 * WHICH MEANS THE LENGTH IS NO LONGER SOMETHING ONLY AN EDIT CAN GROW. Each
 * exempt channel costs about twenty-four units, and an operator adds one by
 * changing a setting and restarting — no commit, no review, nothing that would
 * make anybody look at this number. As the file stands there is room for roughly
 * thirty of them; the test works the figure out rather than restating it here,
 * because it is the prose that moves it. Going over is `unpublishable`'s
 * refusal like any other: the channel keeps the last version Discord accepted
 * and the owner gets one error line.
 */
export const EMBED_CAPS = {
  title: 256,
  description: 4096,
  total: 6000,
} as const

export type EmbedCap = keyof typeof EMBED_CAPS

/** One cap, what this embed spends against it, and the limit. */
export interface CapSpend {
  readonly cap: EmbedCap
  readonly spent: number
  readonly limit: number
}

/**
 * What one embed spends against each of Discord's caps.
 *
 * `total` COUNTS THE FOOTER TEXT AND NOT THE TIMESTAMP, and that is the only
 * part of this arithmetic that is not obvious. Discord's 6000 is documented by
 * ENUMERATION — it names title, description, field.name, field.value,
 * footer.text and author.name — and `timestamp` is absent from that list, along
 * with `url`, `color` and the image URLs. So the word "updated" spends seven
 * units here and the instant beside it spends nothing at all, which is the whole
 * reason the native field is the right mechanism: a per-reader local time for
 * free, where any string in the footer would be charged for.
 *
 * BOTH DIRECTIONS OF THAT ARE A FAULT, WHICH IS WHY IT IS SPELLED OUT. Counting
 * `stampedAt` would reserve budget Discord never charges; dropping `footer` from
 * the sum would stop counting characters that ARE still sent. Either leaves this
 * function approving a payload on numbers that are not Discord's, and the place
 * it shows up is a 50035 on a message the caps said was fine.
 *
 * EXPORTED SO THE SHIPPED DOCUMENT CAN BE MEASURED WITH THE SAME ARITHMETIC THE
 * BOT USES. A test that added the lengths up itself would be a second
 * implementation of this function, and the one that is wrong is always the one
 * nobody runs against Discord.
 */
export function embedBudget(embed: ManualEmbed): CapSpend[] {
  const spent: Record<EmbedCap, number> = {
    title: embed.title.length,
    description: embed.description.length,
    total: embed.title.length + embed.description.length + embed.footer.length,
  }

  // `Object.keys` widens to `string[]`; these are this record's own keys and
  // there is no way to say so that the compiler already knows.
  return (Object.keys(EMBED_CAPS) as EmbedCap[]).map((cap) => ({
    cap,
    spent: spent[cap],
    limit: EMBED_CAPS[cap],
  }))
}

/**
 * Why this embed cannot be sent at all, or null.
 *
 * A DEFECT ANYWHERE IN THE DOCUMENT IS A DEFECT IN THE WHOLE MESSAGE, and that
 * is the consequence of one embed rather than eleven. There is no per-section
 * refusal left to reach for: Discord takes the message or it does not, so the
 * honest answer to a document that is too long is to leave the channel showing
 * the last version it accepted and say so at error — which reaches the status
 * channel, where a fault that repeats on every restart folds into one line
 * (src/log.ts).
 *
 * TRUNCATION IS NEVER THE ANSWER. This channel's entire claim is that it says
 * what the file says, and a shortened document reads like the whole of it, so
 * the drift would be invisible and the bot would have caused it.
 *
 * IT IS THE CAPS AND NOTHING ELSE NOW. The other refusal here was a `## `
 * heading with nothing under it — Discord rejects an empty field VALUE outright
 * and refuses the whole message with it. There are no fields, so there is no
 * empty one; a half-written section is text in the description like any other,
 * and the file that has nothing under its `# ` heading at all is answered one
 * step earlier, by `parseManual`.
 */
export function unpublishable(
  embed: ManualEmbed,
): { readonly why: string; readonly fields: Record<string, unknown> } | null {
  for (const { cap, spent, limit } of embedBudget(embed)) {
    if (spent > limit) {
      return {
        why: 'the manual does not fit in one embed and was not published',
        fields: { over: cap, length: spent, cap: limit },
      }
    }
  }

  return null
}

/**
 * The stripe down the left of the embed.
 *
 * "PLAIN" WAS HALF THE OWNER'S COMPLAINT and this is the cheapest half of the
 * answer: an uncoloured embed is a grey bar, and a coloured one reads as a card
 * somebody made on purpose. Blurple is Discord's own, which is the one choice
 * that cannot clash with a server's theme or be mistaken for a warning colour —
 * this document is a reference, not an alert.
 *
 * IT IS PART OF THE COMPARISON, so changing this constant actually reaches the
 * channel on the next start instead of leaving the code and the message
 * disagreeing about a colour nobody can see in the file.
 */
const MANUAL_COLOUR = 0x5865f2

/**
 * The shortest gap between two writes to the docs channel.
 *
 * THE RUN THAT NEEDS THIS IS THE CHANGEOVER: one edit and ten deletions, fired
 * together into Discord's per-channel limit at the moment the bot has just
 * started and has a gateway session worth keeping. The writes are already
 * serialised — every one is awaited before the next is built — and this spaces
 * them as well, which costs ten seconds once and nothing at all on the ordinary
 * start that writes nothing.
 */
const DOCS_WRITE_GAP_MS = 1000

/**
 * How many messages are read back from the channel.
 *
 * DISCORD'S OWN PER-REQUEST MAXIMUM, and one request is deliberately the whole
 * of it: paginating would mean a bot that walks a channel's entire history on
 * every start.
 *
 * A READ THAT STOPPED HERE USED TO BE A DISASTER AND NOW IS NOT, which is worth
 * writing down because the guard that existed for it has been deleted. Under the
 * old model the messages that fell off the end were sections that looked deleted
 * by hand: they were posted again at the bottom and the ones the read did carry
 * were deleted as no longer in the file, one duplicate per section per restart,
 * unbounded. Under this one every message past the first is a leftover to be
 * removed whatever the read saw, so a short read removes the ones it saw and the
 * next start removes the rest. It converges on one message either way.
 */
const DOCS_FETCH_LIMIT = 100

/**
 * Where the manual lives.
 *
 * DERIVED FROM THIS MODULE'S LOCATION, exactly like `deployedCommitPath`: this
 * file is <repo>/src/client.ts wherever the repo happens to be, so the manual
 * is <repo>/docs/bot-manual.md on the box and in anybody's checkout alike.
 */
export function botManualPath(): string {
  return join(import.meta.dirname, '..', 'docs', 'bot-manual.md')
}

/**
 * The manual off disk, or null and a reason.
 *
 * A MISSING FILE IS ONE WARN AND NOTHING ELSE. It is a real state — a checkout
 * of an older commit, a botched deploy — and the correct response is to leave
 * the channel exactly as it is. Treating it as "the manual is now empty" would
 * make a missing file empty the channel, which is the worst possible reading of
 * a file that is not there.
 */
export async function readManual(path: string = botManualPath()): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      log('warn', 'no bot manual on disk, the docs channel was left alone', { path })
      return null
    }

    log('warn', 'the bot manual could not be read, the docs channel was left alone', {
      path,
      error,
    })

    return null
  }
}

/* ------------------------------------------------------------------ *
 * THE DOCUMENT IS A TEMPLATE AND THE CONFIG IS THE OTHER HALF OF IT.
 * ------------------------------------------------------------------ */

/**
 * ═══ WHY THE MANUAL IS NO LONGER A FILE THAT IS PUBLISHED VERBATIM ═══
 *
 * THE OWNER'S ASK, AND IT IS ABOUT TRUTH RATHER THAN TIDINESS: "only show the
 * blurb about exempted channels if there are any configured. If there are, tell
 * us what they are inline. Same goes for admin exemption — don't show the text
 * if not applicable." A bullet saying "Channels that have been exempted" in a
 * guild where none are is not a shorter truth, it is a false one — an admin
 * reads it and believes there is a list somewhere. And when there IS a list, the
 * document that describes the bot is the one place a reader can find out which
 * channels are on it.
 *
 * SO THE FILE IS NOW A TEMPLATE AND THE RENDERING IS WHAT GETS PUBLISHED. Two
 * passages appear only when the thing they describe is switched on, and one of
 * them names the channels inline as #mentions — which is what makes a rename in
 * the server settings reach this document with nobody editing it, exactly as the
 * two channel mentions and the role tag already do.
 *
 * ═══ THE MARKUP IS LEGIBLE IN THE FILE, WHICH IS THE POINT ═══
 *
 * "Keep it legible in the source file — somebody editing the manual should be
 * able to see what is conditional without reading the publisher." So a block is
 * an HTML comment on a line of its own, opened and closed by name:
 *
 *     <!-- when: exempt-channels -->
 *     - Channels that have been exempted: {{exempt-channels}}. ...
 *     <!-- end: exempt-channels -->
 *
 * HTML COMMENTS BECAUSE THAT IS MARKDOWN'S OWN WAY OF CARRYING SOMETHING THE
 * READER OF THE FILE IS NOT MEANT TO SEE. Anybody who previews the file — on
 * GitHub, in an editor — sees the conditional paragraph and none of the markup
 * around it, and anybody who OPENS the file sees a marker that says in English
 * what it does. The alternatives were worse in both directions: a lead character
 * on the line (`?- Channels…`) is invisible to a reader who does not know the
 * convention, and a data file listing which paragraphs are conditional puts the
 * answer in a second place nobody editing prose would think to look.
 *
 * THE CLOSE NAMES THE CONDITION TOO, and that is not redundancy: the two blocks
 * sit next to each other in the same section, and a bare `<!-- end -->` between
 * them is a line a reader has to count brackets to place. It also turns a block
 * closed in the wrong order into a refusal rather than a silently mis-scoped
 * paragraph.
 *
 * ═══ A TEMPLATE THAT DOES NOT MAKE SENSE TAKES THE WHOLE DOCUMENT OUT ═══
 *
 * Every defect below answers null, and null means the channel is left exactly as
 * it was found — the same answer, for the same reason, as the unclosed code
 * fence in `parseManual`. This is the case where acting on a bad parse destroys
 * something: the alternatives are publishing `<!-- when: exempt-chanels -->` as
 * literal text into a channel admins read, or GUESSING whether a block whose
 * condition nobody recognises belongs in the document. The second is the
 * dangerous one — guessing "include" tells admins a channel is exempt when it is
 * not, and guessing "drop" quietly deletes a paragraph of documentation. There
 * is no safe guess, so there is no guess.
 *
 * ═══ THE CONDITIONS ASK THE QUESTION THE BOT ACTUALLY ASKS ═══
 *
 * AND EACH OF THEM HAD AN OBVIOUS WRONG VERSION. See `conditionsFor` for both,
 * which is where the argument belongs; the short of it is that "is the variable
 * set" is not the question in either case, and getting it wrong publishes a
 * document that describes a bot other than this one.
 *
 * ═══ THE RENDERING HAPPENS BEFORE THE PARSE, AND THAT IS LOAD-BEARING ═══
 *
 * `syncManual` compares what Discord handed back against the DESCRIPTION it is
 * about to write, and the description is now the rendered text. So the rule that
 * a restart which changes nothing says nothing keeps holding, and gains the half
 * it needs: a CONFIG change renders a different document and therefore edits the
 * message, and a config that did not change renders the identical document and
 * is silent. Neither needed a line of new code in the reconciler, and that is
 * the argument for rendering here rather than teaching the comparison about
 * config.
 *
 * WHICH ALSO MOVES THE 4096-UNIT CAP ONTO THE RENDERED TEXT. `unpublishable`
 * measures the embed, and the embed is built from the rendering, so the document
 * that has to fit is the LONGEST one this file can produce — every block
 * included, with the channel list spelled out — and not the one today's
 * configuration happens to produce. The test over the shipped document renders
 * it that way for exactly that reason.
 */

/**
 * What the manual may be written against.
 *
 * A UNION AND A `Record` KEYED ON IT, so a third condition is a compile error in
 * `conditionsFor` rather than a block that silently never renders. The names are
 * the tokens the file writes, verbatim, because a mapping between what the file
 * says and what the code calls it is a mapping somebody has to keep.
 */
export type ManualCondition = 'exempt-admins' | 'exempt-channels'

/** What the manual may ask to have spelled out inline. */
export type ManualValue = 'exempt-channels'

/**
 * The configuration the document is rendered against.
 *
 * A `Pick` RATHER THAN THE WHOLE `Config`, like `watchMaintenance` takes
 * `Pick<Ddb, 'maintenance'>`: these three fields are the whole of what the
 * document can be conditional on, so a renderer that grew an opinion about the
 * bot token or the docs channel id would not compile.
 */
export type ManualConfig = Pick<Config, 'adminRoleId' | 'exemptAdmins' | 'exemptChannelIds'>

/**
 * Which passages belong in the document this configuration describes.
 *
 * `exempt-channels` IS "ARE THERE ANY", NOT "IS THE VARIABLE SET". There is no
 * difference to ask about: the list is a `string[]` that is empty when the
 * operator named no channels, when they named a blank list, and when they set
 * nothing at all — config.ts collapses all three, and it is right to, because
 * all three mean the same thing to the scanner. The question the bullet answers
 * is "is any channel skipped", and the only honest way to ask it is to count the
 * list.
 *
 * `exempt-admins` NEEDS BOTH HALVES, AND EITHER ONE ALONE IS WRONG IN A WAY THAT
 * SHIPS. It is the exact condition `decide` guards the admin exemption with, and
 * it has to be: the flag DEFAULTS TO TRUE, so asking the flag alone puts the
 * bullet in front of every guild that never set an admin role — the majority
 * case, and one where no post by anybody is skipped. Asking the role alone
 * publishes the bullet in a guild that has a role and has deliberately turned
 * the exemption off. The passage describes an exemption that is running, so the
 * condition is the one that decides whether it runs.
 *
 * IF THE GUARD IN `decide` EVER CHANGES, THIS CHANGES WITH IT. They are two
 * statements of one policy, and the failure of letting them drift is a document
 * that describes a bot other than the one posting it.
 */
function conditionsFor(config: ManualConfig): Record<ManualCondition, boolean> {
  return {
    'exempt-channels': config.exemptChannelIds.length > 0,
    'exempt-admins': config.exemptAdmins && config.adminRoleId !== null,
  }
}

/**
 * What the document asks to have spelled out, spelled out.
 *
 * #MENTIONS AND NOT NAMES, which is the rule the rest of the document already
 * follows — "If you really want to include something use #channel instead". An
 * id rendered as `<#…>` becomes the channel's name in the reader's own client
 * and follows a rename with nobody editing anything; the name written out as
 * text is the drift the mentions exist to replace. It is also the only rendering
 * available here: the bot has a list of ids and no guild lookup at this point,
 * and going and fetching names would put a channel's name in a message that
 * outlives the fetch.
 *
 * JOINED WITH COMMAS AND NOTHING ELSE. An "and" before the last one is a wording
 * decision, and the wording in this document is the owner's; a separator is not.
 *
 * THE OPERATOR'S ORDER IS KEPT. `BLITZ_EXEMPT_CHANNEL_IDS` is a list somebody
 * typed, and sorting it would make the rendered document differ from the file
 * they can go and read — and, worse, would reorder itself under an edit that
 * only added one id, which is an edit to the channel for no visible reason.
 */
function valuesFor(config: ManualConfig): Record<ManualValue, string> {
  return {
    'exempt-channels': config.exemptChannelIds.map((id) => `<#${id}>`).join(', '),
  }
}

/**
 * A conditional block opening and closing: an HTML comment alone on its line.
 *
 * ALONE ON ITS LINE, DELIBERATELY. A marker at the end of a paragraph would be
 * a marker a reader scrolls past, and removing it would leave the paragraph's
 * own text to be spliced rather than the line to be dropped — the difference
 * between "delete these lines" and a string edit that can leave a double space
 * behind. Whole lines in, whole lines out.
 */
const BLOCK_OPEN = /^<!--\s*when:\s*([a-z][a-z0-9-]*)\s*-->\s*$/u
const BLOCK_END = /^<!--\s*end:\s*([a-z][a-z0-9-]*)\s*-->\s*$/u

/**
 * A value the document wants spliced into a sentence.
 *
 * DOUBLED BRACES BECAUSE SINGLE ONES ARE PROSE. `{note}` is a plausible thing to
 * write about a slash command's argument; `{{note}}` is not something anybody
 * types by accident.
 */
const SUBSTITUTION = /\{\{\s*([a-z][a-z0-9-]*)\s*\}\}/gu

/**
 * Is `name` one of this record's keys?
 *
 * A GUARD RATHER THAN A CAST, and it is worth the three lines: the alternative
 * is `name as ManualCondition` on a string that came out of a file anybody can
 * edit, which is the one place in this half where an assertion would be
 * outranking the compiler about a value the compiler is right about.
 *
 * SOUND BECAUSE BOTH RECORDS ARE OBJECT LITERALS with exactly the union's keys —
 * see `conditionsFor` and `valuesFor`. A record built any other way could carry
 * a key the type does not name, and this would let it through.
 */
function known<K extends string>(record: Record<K, unknown>, name: string): name is K {
  return Object.hasOwn(record, name)
}

/**
 * One line with its `{{…}}` filled in, and anything wrong about it collected.
 *
 * COLLECTED RATHER THAN THROWN, so a document with three bad tokens in it names
 * all three in one line of the journal instead of one per edit-and-restart.
 * `readManual`'s neighbours in config.ts make the same argument about naming
 * every missing variable at once.
 *
 * A BAD TOKEN IS LEFT IN PLACE IN THE RETURNED STRING, which is never published:
 * the caller answers null the moment either set is non-empty. It is written this
 * way round because a replacer has to return something, and returning the token
 * keeps the failure legible if this is ever called for anything but publishing.
 */
function substituted(
  line: string,
  values: Record<ManualValue, string>,
  unknown: Set<string>,
  empty: Set<string>,
): string {
  return line.replace(SUBSTITUTION, (whole: string, name: string) => {
    if (!known(values, name)) {
      unknown.add(name)
      return whole
    }

    // Empty here does not mean "nothing to say", it means this token got out of
    // the block that is only rendered when it has something to say — somebody
    // moved the sentence and left the token behind. Publishing it would put
    // "Channels that have been exempted: ." in front of a reader.
    if (values[name] === '') {
      empty.add(name)
      return whole
    }

    return values[name]
  })
}

/**
 * The document this configuration describes, or null because the template does
 * not make sense.
 *
 * NULL IS "LEAVE THE CHANNEL ALONE", exactly as it is out of `parseManual`, and
 * the header above this section is the argument. Every branch that answers null
 * writes one error line first — error rather than warn, because it reaches the
 * status channel and because nothing gets better until somebody edits the file.
 *
 * FENCES ARE TRACKED FOR `parseManual`'S REASON, one step earlier. A shell
 * example carrying a `{{…}}` is a great deal more likely than one carrying a
 * `# comment`, and a renderer that substituted into a code block would corrupt
 * an example instead of documenting one. A fence that never closes swallows the
 * markers after it, which shows up here as a block that is never closed and in
 * `parseManual` as the fence itself; both name their line and either one is the
 * fix.
 *
 * THE LINE NUMBERS ARE THE FILE'S, one-based, because the only thing the person
 * reading the journal has to do is open the file and go to a line.
 */
export function renderManual(markdown: string, config: ManualConfig): string | null {
  const conditions = conditionsFor(config)
  const values = valuesFor(config)

  const kept: string[] = []
  const unknown = new Set<string>()
  const empty = new Set<string>()

  let block: { readonly name: ManualCondition; readonly line: number } | null = null
  let fenced = 0

  for (const [index, raw] of markdown.split(/\r?\n/u).entries()) {
    const line = index + 1

    if (CODE_FENCE.test(raw)) fenced = fenced === 0 ? line : 0

    if (fenced === 0) {
      const opened = BLOCK_OPEN.exec(raw)

      if (opened !== null) {
        // The capture cannot be absent — the pattern has one group and it
        // matched — but `noUncheckedIndexedAccess` does not know that, and the
        // fallback lands on the unknown-condition branch below either way.
        const name = opened[1] ?? ''

        if (block !== null) {
          log(
            'error',
            'the manual opens a conditional block inside another one, so it cannot be published and the docs channel was left alone',
            { line, opened: block.line, condition: block.name },
          )

          return null
        }

        if (!known(conditions, name)) {
          log(
            'error',
            'the manual is written against a condition this bot does not know, so it cannot be published and the docs channel was left alone',
            { line, condition: name },
          )

          return null
        }

        block = { name, line }
        continue
      }

      const closed = BLOCK_END.exec(raw)

      if (closed !== null) {
        const name = closed[1] ?? ''

        if (block === null) {
          log(
            'error',
            'the manual closes a conditional block that was never opened, so it cannot be published and the docs channel was left alone',
            { line, condition: name },
          )

          return null
        }

        if (block.name !== name) {
          log(
            'error',
            'the manual closes a conditional block other than the one it opened, so it cannot be published and the docs channel was left alone',
            { line, opened: block.name, closed: name },
          )

          return null
        }

        block = null
        continue
      }
    }

    // A dropped block takes WHOLE LINES with it, markers included, so that what
    // is left is byte-for-byte a document that never had the passage in it. That
    // is what keeps the blank line above and below a block from doubling up, and
    // it is why the rule that an unchanged document is silent survives a
    // configuration that switches a block off.
    if (block !== null && !conditions[block.name]) continue

    kept.push(fenced === 0 ? substituted(raw, values, unknown, empty) : raw)
  }

  if (block !== null) {
    log(
      'error',
      'the manual has a conditional block that is never closed, so it cannot be published and the docs channel was left alone',
      { line: block.line, condition: block.name },
    )

    return null
  }

  if (unknown.size > 0) {
    log(
      'error',
      'the manual asks for a value this bot does not have, so it cannot be published and the docs channel was left alone',
      { values: [...unknown].join(', ') },
    )

    return null
  }

  if (empty.size > 0) {
    log(
      'error',
      'the manual asks for a value that is empty under this configuration, which means the sentence is outside the block that guards it, so it cannot be published and the docs channel was left alone',
      { values: [...empty].join(', ') },
    )

    return null
  }

  return kept.join('\n')
}

/**
 * The document's one title: a single `#`, whitespace, then something.
 *
 * WHAT THE TITLE MAY CONTAIN, DECIDED: one line of plain text. It is not a
 * paragraph of markdown, because it does not become one — it becomes an embed
 * TITLE, and Discord renders nothing in a title. `**Never do this**` in the file
 * is the four asterisks, shown, in the channel. See `HEADING_MARKUP`.
 *
 * THE RULE IS THE TITLE'S ALONE NOW. A `## ` heading is text in the description,
 * where Discord renders markdown like anywhere else, so `**bold**` in one is
 * bold — which is why nothing below warns about them any more.
 *
 * A TRAILING RUN OF `#` IS A CLOSING SEQUENCE AND IS DROPPED. `# Heading #` is
 * one heading called "Heading" to every markdown renderer there is. The closing
 * run has to be separated by whitespace, exactly as the rest of markdown has it,
 * so a heading that ends in a real `#` — `C#` — keeps it.
 *
 * THE `#` IS IN THE FIRST COLUMN OR IT IS NOT A HEADING. CommonMark allows up to
 * three spaces in front of one and this deliberately does not: an indented `#`
 * in a document like this one is far more often a line of an example than a
 * heading, and the cost of the two mistakes is not the same — missing a heading
 * leaves a paragraph where it was, inventing one cuts the document in half.
 */
const TOP_LEVEL_HEADING = /^#\s+(\S.*?)(?:\s+#+)?\s*$/u

/**
 * Inline markdown that got into the title.
 *
 * SAID, NOT STRIPPED AND NOT REFUSED. Stripping would silently change what the
 * channel shows against what the file says, and refusing would take the whole
 * manual out of the channel over a pair of asterisks. So it is published exactly
 * as written and there is one line in the journal saying why it looks like that.
 *
 * PAIRS ONLY, AND `_` IS DELIBERATELY NOT HERE. Discord does not italicise an
 * underscore inside a word, and a name with underscores in it is a name; a
 * pattern that warned about those would be a warning nobody could act on and
 * everybody would learn to ignore.
 */
const HEADING_MARKUP = /\*[^*\n]+\*|`[^`\n]+`|~~[^~\n]+~~|\|\|[^|\n]+\|\||\[[^\]\n]+\]\([^)\n]+\)/u

/** A fenced code block opening or closing. */
const CODE_FENCE = /^\s*(?:```|~~~)/u

function warnAboutMarkup(title: string): void {
  if (!HEADING_MARKUP.test(title)) return

  log('warn', 'the manual title carries markdown, which an embed shows literally', {
    heading: named(title),
  })
}

/**
 * Split the file into the two parts of an embed, or answer null because it
 * cannot be split at all.
 *
 * IT IS A SPLIT AND NO LONGER A STRUCTURE, which is what moving the document
 * into the description bought. The first `# ` line is the title and every line
 * after it is the body, carried across as it was written — `## ` headings, code
 * fences, bullets and all — because Discord's own renderer is what turns them
 * into headings. There is nothing here that decides what a section IS any more,
 * so there is nothing here that can get it wrong.
 *
 * NULL IS "LEAVE THE CHANNEL ALONE", AND IT IS THE ONE GUARD THIS HALF KEPT.
 * Every other way of limiting the damage a misparse can do went with the
 * many-message model; this one stayed because it is the case where acting on a
 * bad parse destroys something. An empty file, a file with no `# ` heading in
 * it, a file with nothing under the heading it has, and a file whose code fence
 * never closes are all "there is nothing here that can be published" — never an
 * instruction to replace the manual with nothing. The difference between them is
 * in the log line, not in what happens next.
 *
 * A TITLE WITH NOTHING UNDER IT IS ONE OF THOSE, AND THAT IS NEW. Under the old
 * model the text under the `# ` was the lead paragraph and the sections carried
 * the document, so an empty lead was an embed with no description and harmless.
 * The body IS the document now, so publishing an empty one would replace the
 * manual with a bare title — the same harm as an empty file, and it gets the
 * same answer.
 *
 * FENCES ARE TRACKED, AND THAT IS NOT FUSSINESS. A shell example in the manual
 * carries `# comment` lines, and a parser that did not know it was inside a
 * fence would read one as the document's title. A fence that never CLOSES no
 * longer costs anything in the PARSE — the body is verbatim either way — but it
 * is still refused, because Discord renders the description as markdown: an
 * unbalanced ``` swallows the rest of the manual into one grey block in the
 * channel. So it answers null and names the line the fence was opened on, and
 * the fix is a keystroke once you know where to put it.
 *
 * TEXT ABOVE THE TITLE BELONGS TO NO PART OF THE EMBED AND IS NOT POSTED. It
 * gets a warn rather than being dropped silently, because the whole promise of
 * this feature is that the channel and the file agree: a preamble that vanished
 * quietly would be exactly the drift this exists to make visible.
 *
 * A SECOND `# ` IS BODY, AND IS SAID. There is one embed and it has one title,
 * so the first `# ` is it; a later one is a line of the description like any
 * other. Refusing the document over it would take the manual out of the channel
 * for a stray character.
 */
export function parseManual(markdown: string): Manual | null {
  const body: string[] = []

  let title: string | null = null
  let orphaned = 0
  let extraTitles = 0

  // The line an unclosed fence was opened on, or 0 while none is open. A line
  // number rather than a boolean because it is the only thing the operator
  // needs in order to fix the file.
  let fenced = 0

  for (const [index, raw] of markdown.split(/\r?\n/u).entries()) {
    if (CODE_FENCE.test(raw)) fenced = fenced === 0 ? index + 1 : 0

    if (fenced === 0) {
      // The capture cannot be absent — the pattern has one group and it
      // matched — but `noUncheckedIndexedAccess` does not know that, and an
      // assertion here would be the one place in this file that outranks the
      // compiler.
      const top = TOP_LEVEL_HEADING.exec(raw)

      if (top !== null && title === null) {
        title = top[1] ?? ''
        warnAboutMarkup(title)
        continue
      }

      if (top !== null) extraTitles += 1
    }

    if (title === null) {
      if (raw.trim() !== '') orphaned += 1
      continue
    }

    body.push(raw)
  }

  if (fenced !== 0) {
    log(
      'error',
      'the manual has a code fence that is never closed, so it cannot be published and the docs channel was left alone',
      { line: fenced },
    )

    return null
  }

  if (title === null) {
    log(
      'error',
      'the manual has no top-level heading, so there is nothing to publish and the docs channel was left alone',
    )

    return null
  }

  // `trim` so that the blank line every writer leaves under the title, and the
  // one at the end of the file, are not part of the text being compared.
  // Without it, reformatting the file's whitespace would rewrite the message.
  const text = body.join('\n').trim()

  if (text === '') {
    log(
      'error',
      'the manual has nothing under its top-level heading, so there is nothing to publish and the docs channel was left alone',
    )

    return null
  }

  if (orphaned > 0) {
    log('warn', 'the manual has text above its first heading, which is in no part of the embed and was not posted', {
      lines: orphaned,
    })
  }

  if (extraTitles > 0) {
    log('warn', 'the manual has more than one top-level heading, and only the first is the embed title', {
      extra: extraTitles,
    })
  }

  return { title, body: text }
}

/**
 * The manual as one embed, stamped now.
 *
 * THE STAMP IS BUILT HERE AND ONLY REACHES DISCORD ON A WRITE. That is what
 * makes it a last-CHANGED stamp rather than a last-checked one: an unchanged
 * manual returns before this embed is ever handed to `post` or `edit`, so the
 * message keeps the moment of the edit that really happened. It is also why
 * `stampedAt` is not part of the comparison — comparing it would make every
 * start differ from the last one and rewrite the channel forever.
 *
 * THE FOOTER TEXT BESIDE IT *IS* COMPARED, and the two are not the same rule.
 * The word below moves only when this line is edited, so a channel showing an
 * older wording is a difference `unchanged` can see and one edit puts right. It
 * is only the moment that has to stay out.
 *
 * THE TIME IS TAKEN HERE, AND HERE IS THE RIGHT PLACE ONLY BECAUSE OF THAT RULE.
 * `new Date()` in a builder means "whenever this object was constructed", which
 * is a lie in any design that rebuilds the embed without writing it. This one
 * does not: the object is built once per sync and the only paths that carry it
 * onward are the two writes. If that ever stops holding, the instant has to be
 * passed IN — the moment the document was published — rather than read off the
 * clock at build time.
 *
 * THE WORD IS THE OWNER'S AND IS THE WHOLE OF THE COPY. "updated", then whatever
 * Discord's client decides to render beside it. Nothing here writes a second
 * word of user-facing prose.
 */
export function manualEmbed(manual: Manual): ManualEmbed {
  return {
    title: manual.title,
    description: manual.body,
    colour: MANUAL_COLOUR,
    footer: 'updated',
    stampedAt: new Date(),
  }
}

/**
 * Is the message in the channel already this manual?
 *
 * A PLAIN EQUALITY, PART BY PART, ON PURPOSE. Both sides are stored strings:
 * what Discord handed back against what the file says. Anything cleverer here is
 * a source of edits nobody asked for, in a channel whose whole value is that it
 * changes only when the documentation does.
 *
 * THE COLOUR IS COMPARED TOO, because it is as much a part of what was published
 * as the text. Leaving it out would let the code and the channel disagree about
 * how the manual looks, silently and forever, which is the drift this feature
 * exists to prevent.
 *
 * AND SO IS THE FOOTER TEXT, WHICH IS THE SAME ARGUMENT AND WAS THE EXCEPTION.
 * It is a line of the published message like any other and it changes only when
 * somebody edits the word, so a footer that no longer matches the code is a
 * difference and is written. It was left out while the text carried the instant
 * — `updated <ISO string>`, rebuilt every start — and comparing it then would
 * have reposted the manual on every deploy; the instant is `stampedAt` now.
 *
 * `stampedAt` IS STILL NOT HERE AND CANNOT BE. It is a fresh moment on every
 * start, so comparing it would make every start differ from the last one. That
 * is the whole distinction: the footer's WORDING is compared, the moment drawn
 * beside it is not, and a stamp that moves on every restart still writes nothing.
 */
function unchanged(posted: PostedManual, embed: ManualEmbed): boolean {
  return (
    posted.title === embed.title &&
    posted.description === embed.description &&
    posted.colour === embed.colour &&
    posted.footer === embed.footer
  )
}

/**
 * What one write to the channel is. A `Record` per outcome below, so a fourth
 * kind of change is a compile error rather than an `undefined` in a log line.
 */
type Change = 'post' | 'edit' | 'delete'

const CHANGED: Record<Change, string> = {
  post: 'posted the manual',
  edit: 'updated the manual',
  delete: 'deleted a leftover message from the docs channel',
}

const CHANGE_FAILED: Record<Change, string> = {
  post: 'could not post the manual',
  edit: 'could not update the manual',
  delete: 'could not delete a leftover message from the docs channel',
}

/**
 * Whether a failed write means this content will never be accepted.
 *
 * 50035 IS "INVALID FORM BODY" AND IT IS A STATEMENT ABOUT THE PAYLOAD, not
 * about the channel or about the moment. Retrying it with the same bytes fails
 * the same way, so it is an error rather than the info a rate limit gets — and
 * it should be unreachable, because `unpublishable` checks every cap Discord
 * checks before anything is sent. Reaching it means this file's arithmetic and
 * Discord's disagree, which is exactly the thing somebody has to be told about.
 *
 * IT DOES NOT LATCH THE CHANNEL OFF, and that is the difference from
 * `permanentlyUnusable`. The channel is fine; this payload is not.
 */
function contentRefused(error: unknown): boolean {
  if (!(error instanceof DiscordAPIError)) return false

  return error.code === RESTJSONErrorCodes.InvalidFormBodyOrContentType
}

/**
 * Bring the channel into agreement with the file.
 *
 * THE ONLY WRITES ARE THE DIFFERENCES. A message that already says what the file
 * says is not touched and not mentioned; see the header above for why a quiet
 * restart is the point of the whole feature.
 *
 * THE FIRST OF OUR MESSAGES IS THE MANUAL AND THE REST ARE LEFTOVERS. Oldest
 * first, so the manual keeps the place in the channel it has always had and a
 * reader's link to it keeps working. Everything after it is a message this bot
 * put there under a model that no longer applies, or a duplicate left by a run
 * that failed after posting — the same treatment, because from the channel's
 * side they are the same thing.
 *
 * THE WRITE COMES BEFORE THE DELETIONS, so a run that fails part way leaves an
 * extra message rather than none at all. The next start removes the extra; an
 * empty channel would have to be posted to again.
 */
export async function syncManual(
  manual: Manual | null,
  channel: DocsChannel,
  pause: () => Promise<void> = () => sleep(DOCS_WRITE_GAP_MS),
): Promise<void> {
  // NOTHING IS EVEN READ FOR A MANUAL THAT DID NOT PARSE. `parseManual` has
  // already said which of the three reasons it was and that the channel was left
  // alone; saying it twice would put two lines in the status channel for one
  // fault. The point is that nothing below this line runs.
  if (manual === null) return

  const embed = manualEmbed(manual)
  const refusal = unpublishable(embed)

  if (refusal !== null) {
    // The channel keeps whatever it is showing: the last version Discord
    // accepted, which is honest, rather than a shortened copy of one it will
    // not take. This reaches the status channel and therefore the owner.
    log('error', refusal.why, refusal.fields)
    return
  }

  let posted: readonly PostedManual[]

  try {
    posted = await channel.read()
  } catch (error) {
    // ONE LINE, THEN NOTHING, like `statusReporter` latching off. A wrong id, a
    // channel that was deleted, a missing permission: none of them gets better
    // by being asked again, and the fix is a variable and a restart either way.
    log('error', 'docs channel unusable, the manual was not synchronised', { error })
    return
  }

  const [current, ...leftovers] = posted

  let stopped = false
  let writes = 0

  /**
   * One write, paced, and never allowed to throw past this function.
   *
   * A FAILURE THAT MIGHT WORK NEXT TIME IS INFO, not a warning, and the reason
   * is that nobody has to do anything about it: the channel is the state, so the
   * next start reads it back and finishes whatever this run did not. The failure
   * that WOULD need a person is a channel this bot cannot write in at all, which
   * latches and is an error.
   */
  async function apply(
    change: Change,
    run: () => Promise<void>,
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    if (stopped) return

    // Between writes and never before the first, so a run that changes the
    // manual and nothing else costs no wait at all.
    if (writes > 0) await paced()
    writes += 1

    try {
      await run()
      log('info', CHANGED[change], fields)
    } catch (error) {
      if (permanentlyUnusable(error)) {
        stopped = true
        log('error', 'docs channel unusable, nothing further was written', { ...fields, error })
        return
      }

      if (contentRefused(error)) {
        log('error', CHANGE_FAILED[change], { ...fields, error })
        return
      }

      // Transient: rate limited, a 500, a message somebody deleted underneath
      // us. The next start reconciles it, so there is nothing to retry here.
      log('info', CHANGE_FAILED[change], { ...fields, error })
    }
  }

  /**
   * Wait between two writes, and say so if the process goes while we are
   * waiting.
   *
   * THE WAIT IS UNREFFED, WHICH IS RIGHT AND WHICH MADE THE ABANDONMENT SILENT.
   * `sleep` deliberately does not hold the process open for a documentation
   * edit, so a `systemctl stop` in the middle of the changeover takes the
   * remaining deletions with it — and used to take them without a single line
   * anywhere. The next start does finish the job, and somebody reading the
   * journal after a restart still has to be able to see that this one did not.
   *
   * `exit` AND NOT `beforeExit`, because index.ts calls `process.exit` from its
   * signal handler once the gateway is closed, and `beforeExit` does not fire on
   * that path at all — which is the only path a `systemctl restart` takes.
   * `log()` is synchronous and writes to the journal first, so the line lands
   * even though nothing async can run any more; the copy in the status channel
   * is lost with the process, which is the same trade the whole sink makes.
   */
  async function paced(): Promise<void> {
    const abandoned = (): void => {
      // INFO, AND THE COMMENT ABOVE IS THE ARGUMENT FOR IT: this is what
      // `systemctl restart` looks like from inside a documentation sync, the
      // next start finishes the job, and nobody has to do anything. It could not
      // have reached the status channel in any case — the process is on its way
      // out.
      log('info', 'the process is going down between two docs channel writes, the rest were not made', {
        written: writes,
      })
    }

    process.once('exit', abandoned)

    try {
      await pause()
    } finally {
      process.off('exit', abandoned)
    }
  }

  // A channel with none of our messages in it is a first run, or a manual
  // somebody deleted by hand. Both are "post it", and that is the whole repair:
  // there is no local record to have gone stale.
  if (current === undefined) {
    await apply('post', () => channel.post(embed))
  } else if (!unchanged(current, embed)) {
    await apply('edit', () => channel.edit(current.id, embed), { message: current.id })
  }

  for (const extra of leftovers) {
    await apply('delete', () => channel.remove(extra.id), { message: extra.id })
  }
}

/**
 * How much of the title a log line carries.
 *
 * A CAP BECAUSE THE LINE THAT MOST NEEDS THE TITLE IS THE ONE ABOUT A TITLE THAT
 * IS TOO LONG, and the whole of a 4000-character title in a journal line is a
 * wall that pushes everything else off the status channel post beside it. The
 * first eighty characters are enough to find the line in an editor.
 */
const HEADING_LOG_CAP = 80

function named(title: string): string {
  // Cut by code point, like every other cut in this file: a UTF-16 slice can
  // land inside a surrogate pair and leave half a character in the record.
  const points = [...title]
  if (points.length <= HEADING_LOG_CAP) return title

  return `${points.slice(0, HEADING_LOG_CAP).join('')}…`
}

/**
 * A pause that cannot hold the process open.
 *
 * `unref` FOR THE REASON `statusReporter`'s TIMER IS UNREFFED: a wait between
 * two documentation edits is not a reason for `systemctl stop` to sit through
 * its timeout.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/**
 * One message in the docs channel, as much of one as this reads.
 *
 * STRUCTURAL FOR THE REASON EVERY OTHER LIVE SHAPE IN THIS FILE IS, and for one
 * more: `channel.messages` is a union across every sendable channel type, and
 * naming what is read off a message here keeps the adapter below to one narrow
 * conversion instead of spreading discord.js's types through the reconciler.
 */
interface DocsMessage {
  readonly id: string
  readonly author: { readonly id: string }

  readonly embeds: readonly {
    readonly title: string | null
    readonly description: string | null

    /** discord.js's spelling, at the one boundary that has to use it. */
    readonly color: number | null

    /**
     * The footer TEXT, and there is no `timestamp` beside it here on purpose:
     * the instant is not read back and not compared (see `PostedManual`), so
     * naming it at this boundary is the first step of the bug that comparison
     * would be.
     */
    readonly footer: { readonly text: string } | null
  }[]

  readonly createdTimestamp: number
}

/**
 * The live channel behind the four operations.
 *
 * `channels.fetch` PER OPERATION, exactly like `announcer`: it reads
 * discord.js's cache first and only spends a request on a miss, and unlike a
 * channel captured at startup it survives the channel being recreated.
 */
export function docsChannel(client: Client, channelId: string): DocsChannel {
  async function open(): Promise<SendableChannels> {
    const channel = await client.channels.fetch(channelId)

    if (channel === null || !channel.isSendable()) {
      throw new Error('the docs channel id names no channel this bot can post in')
    }

    return channel
  }

  return {
    read: async () => {
      const channel = await open()

      /**
       * NO SELF ID, NO READ. `client.user` is set well before `clientReady`
       * fires, so this cannot happen in practice — and if it ever did, the
       * filter below would match nothing, the channel would look empty, and the
       * bot would post a second copy of the manual beside the first. Throwing
       * turns the worst outcome this feature has into one line and an untouched
       * channel.
       */
      const selfId = client.user?.id
      if (selfId === undefined) throw new Error('the bot does not know its own user id yet')

      const messages = await channel.messages.fetch({ limit: DOCS_FETCH_LIMIT })

      return ours([...messages.values()], selfId)
    },

    post: async (embed) => {
      const channel = await open()

      // The same mention suppression every other send in this file states at
      // its own call. The manual is our own text and an embed does not resolve
      // mentions in any case; the guarantee is still made here rather than left
      // to a client-wide default a reader of this function cannot see.
      await channel.send({ embeds: [apiEmbed(embed)], allowedMentions: { parse: [] } })
    },

    edit: async (id, embed) => {
      const channel = await open()

      // SAID ON THE EDIT TOO, WHICH IT WAS NOT BEFORE. The document now carries
      // a role tag — the owner asked for the game-ban role to be tagged rather
      // than described, so a reader sees which one is meant — and this is the
      // write that runs every time the file changes. An embed resolves no
      // mention, so the tag cannot notify anybody either way; the write that
      // republishes a role tag is not the place to leave that unstated.
      await channel.messages.edit(id, {
        embeds: [apiEmbed(embed)],
        allowedMentions: { parse: [] },
      })
    },

    remove: async (id) => {
      const channel = await open()
      await channel.messages.delete(id)
    },
  }
}

/**
 * The bot's own single-embed messages, oldest first.
 *
 * OLDEST FIRST BECAUSE `messages.fetch` ANSWERS NEWEST FIRST, and the order
 * decides which message is the manual and which are leftovers to be deleted.
 *
 * ONLY THE BOT'S OWN MESSAGES, AND ONLY THE ONES SHAPED LIKE A MANUAL. The docs
 * channel is bot-only post, but a permission overwrite is one right-click away
 * from not being, and anything else in there — an admin's note, an older message
 * of ours carrying no embed — is not this bot's to edit and certainly not its to
 * delete.
 *
 * EXPORTED SO THE FILTER CAN BE PROVEN, and it is worth proving: everything it
 * lets through is a message this bot may edit or DELETE, and this is the run
 * that deletes ten of them.
 */
export function ours(messages: readonly DocsMessage[], selfId: string): PostedManual[] {
  const mine: (PostedManual & { at: number })[] = []

  for (const message of messages) {
    if (message.author.id !== selfId) continue

    // Exactly one, because that is what this bot posts. A message of ours
    // carrying two embeds is not the manual, and keying on the first of them
    // would let an unrelated post be edited over.
    if (message.embeds.length !== 1) continue

    const embed = message.embeds[0]
    if (embed === undefined || embed.title === null) continue

    mine.push({
      id: message.id,
      title: embed.title,

      // Null is what Discord returns for an embed with no description, and a
      // leftover from the old model is exactly that: eleven messages whose
      // whole content was fields. It has to be a string before the comparison
      // can be a plain equality, and '' is never what the file parses to — a
      // manual with nothing under its heading does not get this far.
      description: embed.description ?? '',

      colour: embed.color,

      // NULL IS WHAT DISCORD RETURNS FOR AN EMBED WITH NO FOOTER AT ALL, and it
      // has to be a string here for the same reason the description does: the
      // comparison is a plain equality and '' is never what `manualEmbed`
      // builds. A message of ours carrying no footer is therefore a difference,
      // which is right — it is a leftover, or a manual published before the
      // footer existed, and either way the channel is out of date.
      footer: embed.footer?.text ?? '',

      at: message.createdTimestamp,
    })
  }

  return mine
    .sort((a, b) => a.at - b.at)
    .map(({ id, title, description, colour, footer }) => ({
      id,
      title,
      description,
      colour,
      footer,
    }))
}

/**
 * One `ManualEmbed` as discord.js takes it.
 *
 * THE DESCRIPTION IS SENT UNCONDITIONALLY, and it used to be omitted when empty
 * because Discord rejects `''`. It cannot be empty any more: a file with nothing
 * under its `# ` heading is refused by `parseManual`, which is the honest place
 * for it — a manual with no body is not a manual to publish without one.
 *
 * NO FIELDS. The `## ` sections are lines of the description now, which is the
 * whole point of the change: Discord renders a heading in a description and
 * renders a field name bold, at body size, with no markdown at all.
 *
 * NO THUMBNAIL, NO AUTHOR, NO IMAGE — see `ManualEmbed`. This is the only place
 * one could be added, so it is the place to say it was asked about and declined.
 *
 * `timestamp` IS THE ONE MECHANISM THAT GIVES EACH READER THEIR OWN CLOCK, and
 * it is a sibling of `footer` rather than part of it. Discord draws them on one
 * line separated by a bullet — "updated • Today at 4:20 PM" — and renders the
 * time in the viewer's timezone and locale, so the same instant reads 14:00 to a
 * reader at UTC+2 and 12:00 to one at UTC. It is an ISO8601 string on the wire
 * and that string is never what anybody sees.
 *
 * WHAT IT IS NOT IS "2 hours ago". The native field has no style parameter — the
 * two requests for one were declined — so it is a fixed instant re-rendered per
 * reader, absolute, with "Today"/"Yesterday" for recent days. A relative time
 * that keeps counting needs a surface that parses markdown, which the footer is
 * not; it would have to be a `-# <t:…:R>` line at the end of the DESCRIPTION,
 * and that is a change to what the document says, not to how it is stamped.
 */
function apiEmbed(embed: ManualEmbed): APIEmbed {
  return {
    title: embed.title,
    description: embed.description,
    color: embed.colour,
    footer: { text: embed.footer },
    timestamp: embed.stampedAt.toISOString(),
  }
}

/**
 * Wire the manual to the gateway coming up.
 *
 * `clientReady` FOR THE REASON THE DEPLOY NOTICE USES IT: it is the earliest
 * point at which there is a channel to read or post to.
 *
 * `once`, BECAUSE A RECONNECT IS NOT A DEPLOY. discord.js does not re-emit it
 * on a resumed session, and a manual that had not changed would be silent
 * anyway — this is belt and braces on a rule that already holds.
 *
 * EVERY FAILURE ENDS HERE. The bot is moderating a live guild; a document that
 * could not be published is not a reason for any of that to stop.
 *
 * THE THREE STEPS ARE READ, RENDER, PARSE, AND THAT ORDER IS THE FEATURE. The
 * file is a template; `renderManual` turns it into the document THIS bot's
 * configuration describes; `parseManual` splits that into the embed. Which
 * means the text `syncManual` compares against the channel is the RENDERED one,
 * so a configuration change edits the message and an unchanged configuration
 * writes nothing — neither of which the reconciler had to be told about.
 *
 * EACH STEP ANSWERS NULL FOR "LEAVE THE CHANNEL ALONE" AND HAS ALREADY SAID WHY.
 * Nothing is added here on any of the three, for `syncManual`'s reason: a second
 * line about one fault is a second post in the status channel.
 */
export function syncDocsChannel(
  client: Client,
  channelId: string,
  config: ManualConfig,
  read: () => Promise<string | null> = readManual,
  open: (client: Client, channelId: string) => DocsChannel = docsChannel,
): void {
  client.once(Events.ClientReady, () => {
    void (async () => {
      const markdown = await read()
      if (markdown === null) return

      const rendered = renderManual(markdown, config)
      if (rendered === null) return

      await syncManual(parseManual(rendered), open(client, channelId))
    })().catch((error: unknown) => {
      log('warn', 'the bot manual could not be synchronised', { error })
    })
  })
}

/* ------------------------------------------------------------------ *
 * THE MODERATION MIRROR — blitz-bot#16.
 *
 * Discord's own ban, unban and kick, carried into the game.
 * ------------------------------------------------------------------ */

/**
 * ═══ THE POLICY, WHICH IS THE OWNER'S AND IS DELIBERATELY ASYMMETRIC ═══
 *
 * A DISCORD BAN MEANS BANNED IN THE GAME, PERMANENTLY. Somebody the owner will
 * not have in the Discord server is not somebody he wants on the game server,
 * and there is no expiry: `expiresAt` is null on every row this writes.
 *
 * A GAME BAN NEVER MEANS A DISCORD BAN. It assigns `config.gameBanRoleId`
 * instead, so the person keeps limited access to the guild and can argue their
 * case with a human. Lifting or expiring the game ban takes the role off again.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN AND NOT AN INCONSISTENCY. The two directions
 * are not one decision seen from two sides: one is "I do not want this person
 * here", a judgement about the community that carries the game with it; the
 * other is "you cheated in a match", a judgement about play that must leave open
 * the one channel where it can be disputed. A mirror that ran both ways would
 * mean a cheating ban silences the appeal.
 *
 * ═══ THERE ARE NO SLASH COMMANDS HERE, AND THAT IS THE POINT ═══
 *
 * `/brban` and `/brkick` were designed and then cut, in the owner's words: "we
 * do not need /brkick or /brban if the default discord /kick and /ban do the
 * same thing, since we have event listeners". He is right, and the reason is
 * worth keeping: a command would have been a SECOND TRIGGER for this one
 * listener. An admin typing `/brban` would ban on Discord, which fires the audit
 * event, which arrives here — so either the command duplicated the mirror's work
 * and the two could disagree, or it did nothing except what the listener was
 * about to do anyway. One trigger, one path, one place to be wrong.
 *
 * It also means there is nothing for an admin to look at while this runs. A
 * slash command has a reply to edit; a ban typed into Discord's own dialog has
 * nowhere to put an outcome, which is why the outcomes below are reported
 * through `log()` — and why the ones that need a person are `warn`, since that
 * is what reaches the status channel (src/log.ts).
 *
 * ═══ WHY THE AUDIT EVENT AND NOT `guildMemberRemove` ═══
 *
 * Verified against the installed discord.js, because the obvious listener is the
 * wrong one twice over:
 *
 *   THERE IS NO KICK EVENT. A voluntary leave, a kick and a ban are the same
 *   `GUILD_MEMBER_REMOVE` on the wire, byte for byte. Nothing in the payload
 *   says which of the three happened, so a kick mirror built on it would either
 *   act on everybody who left or go and read the audit log anyway — after the
 *   fact, hoping the entry has landed, correlating by target and timestamp.
 *
 *   IT IS SILENTLY SWALLOWED FOR AN UNCACHED MEMBER. discord.js drops
 *   `guildMemberRemove` for a member it does not hold unless
 *   `Partials.GuildMember` is enabled, so a ban mirror built on it would drop
 *   bans depending on how warm the cache happened to be — a bug that reproduces
 *   on a busy evening and not on a quiet one.
 *
 * THE AUDIT ENTRY CARRIES `targetId`, `executorId` AND `reason` TOGETHER, so
 * nothing needs correlating: who was acted on, who did it, and what they typed,
 * in one event with an id of its own. YAGPDB and Red-DiscordBot both work purely
 * from this event for exactly this reason.
 *
 * ═══ THE THREE THINGS THAT WOULD OTHERWISE BITE ═══
 *
 * 1. THE LOOP. This bot removes a role in response to an audit entry, and
 *    removing a role writes an audit entry. `mirrorEntry` ignores any entry
 *    whose `executorId` is the bot's own user id, which is one line and is what
 *    both YAGPDB and Red do. `moderationEntry` is the second line of defence: a
 *    role edit is `MemberRoleUpdate`, which is not in `MIRRORED` and never
 *    becomes a `ModerationEntry` at all. Idempotence is the backstop, not the
 *    mechanism.
 *
 * 2. IDEMPOTENCY IS THE AUDIT ENTRY ID, stored on the ban row as
 *    `discordEntryId` and checked before the write — Zeppelin's
 *    `findByAuditLogId` pattern. It survives a restart, a gateway redelivery and
 *    the boot replay below, and it records WHICH event produced a ban, which is
 *    a better question than "is this person banned" because it is still
 *    answerable after somebody lifts the ban.
 *
 * 3. THE BAN WRITE IS CONDITIONAL AND MUST STAY SO. `bans.issue` in src/ddb.ts
 *    reads before it writes; the console's own write is an unconditional
 *    overwrite that clears the lifted marker, so a replay through that path
 *    would silently un-lift a ban an admin had deliberately lifted. That file's
 *    comment is the long version.
 *
 * ═══ THE AUDIT ROW, AND WHY ONLY TWO OF THE THREE ACTIONS WRITE ONE ═══
 *
 * The owner: "I would like any admin actions like kicking or banning from
 * discord to be shown in Ringmaster's audit log." `ringmaster-audit` is the
 * chronological record of who did what, and until now a Discord ban wrote a ban
 * row and left no trace in it at all — the console's own `lib/audit.ts` calls an
 * unlogged admin action the thing that table exists to make impossible.
 *
 * THE BAN AND THE LIFT NOW WRITE ONE. `ban.issue` around `bans.issue`,
 * `ban.lift` around `bans.lift`, both two-phase: `audit.begin` BEFORE the write
 * and `audit.resolve` after it with what actually happened. See `auditedBan` and
 * `auditedLift` below.
 *
 * THE KICK DOES NOT, AND THAT IS NOT AN OVERSIGHT — IT IS ALREADY THERE. A
 * Discord kick is relayed to the console's `POST /api/kick`, which begins its
 * OWN `player.kick` row before it dispatches (fivem-ringmaster
 * `src/app/api/kick/route.ts`), attributed to the human because this bot sends
 * their Discord id in `SERVICE_ACTOR_HEADER` and `lib/service.ts` resolves it to
 * `{ license, name, discordId }` there. Writing a second row from here would put
 * the same kick in the log twice, in the same words, a few hundred milliseconds
 * apart — and `reconcileModeration` replays up to `RECONCILE_LIMIT` kicks on a
 * boot with no cursor, so it would put twenty-five of last week's kicks in the
 * log dated today. An append-only log cannot take either of those back.
 *
 * WHAT THAT LEAVES UNCOVERED, PLAINLY: a Discord kick that never reaches the
 * console — `COMMAND_SECRET` unset, or the console unreachable — is in this
 * bot's journal at `warn` and in no audit row anywhere. Closing it needs a
 * signal this bot does not have, namely whether the console got far enough to
 * begin a row of its own; `KickResult.commandId` names that row on the
 * `dispatched` branch and is absent on every other, which is not enough to
 * decide on.
 *
 * ═══ THE RULE HERE IS THE OPPOSITE OF THE CONSOLE'S, DELIBERATELY ═══
 *
 * The console's rule is that a failure to record is a failure to act: if
 * `audit.begin` throws, the action must not proceed. THIS FILE INVERTS IT. A
 * failed audit write is logged loudly and the ban goes ahead anyway.
 *
 * THE DIFFERENCE IS WHO IS DECIDING. The console IS the authority — an admin
 * clicks, and refusing the click costs nothing but a retry. This bot is
 * MIRRORING a decision Discord has already carried out: the person is already
 * banned from the guild, and the ban row is the thing that keeps them off the
 * game server. Refusing to write it because a log entry failed would trade the
 * protection for the record, which is the wrong way round — and unlike the
 * console there is nobody watching a dialog to retry it.
 *
 * ═══ THE BOT IS A SECOND WRITER TO `pk = 'AUDIT'` ═══
 *
 * Two processes writing one partition whose primary key is `pk` + a millisecond
 * `ts` means a same-millisecond write is a silent overwrite on a log whose whole
 * job is that a record cannot go missing. `audit.begin` in src/ddb.ts is
 * therefore conditional on `attribute_not_exists(pk)` and steps its sort key
 * FORWARD and retries on a refusal, and `audit.resolve` conditions on the
 * `commandId` it minted so it can never stamp an outcome onto somebody else's
 * row. Neither of those is this file's to keep, but both are why this file may
 * write here at all; src/ddb.ts carries the long version and the one direction
 * that cannot be closed from this repo.
 *
 * ═══ THE ROW GOES PAST THIS BOT'S OWN BAN-ROLE POLLER, AND THAT IS FINE ═══
 *
 * src/banrole.ts polls `pk = 'AUDIT'` and treats `ban.issue` and `ban.lift` as
 * TRIGGERS: read the ban row, and put the game-ban role on whoever a standing
 * ban is about. The rows written here are those two verbs, so the poller sees
 * them and acts. Traced end to end, three things make that harmless:
 *
 *   IT IS NOT A LOOP. The poller's only writes are one role id and the bot's own
 *   state row; it cannot ban, kick or write an audit row (its `Pick` of `Ddb`
 *   has no `audit` in it), so nothing it does comes back here.
 *
 *   THE TRIGGER IS NOT THE FACT. The poller never reads `outcome` — it goes and
 *   reads `ringmaster-bans`. A ban row this file wrote IS a standing game ban by
 *   the policy at the top of this comment, so "mark them" is the poller's own
 *   rule applied correctly rather than a false trigger, and a ban whose write
 *   FAILED leaves no active row and therefore no decision.
 *
 *   THE ROLE CANNOT LAND ANYWAY, AND THAT IS THE STRUCTURAL ANSWER. The role is
 *   for GAME bans: its whole point is that the person keeps limited access to the
 *   guild and can argue their case with a human. Somebody Discord-banned has no
 *   guild membership to hold a role — Discord enforces that, not us — so the
 *   poller's `roles.add` answers `Unknown Member`, which src/banrole.ts already
 *   treats as the ordinary case and logs at `info`. A Discord ban and a game ban
 *   happen to write the same verb; only one of them has anybody to mark.
 *
 * WHAT IT DOES COST, SAID PLAINLY: the poller records the tag BEFORE it tries the
 * role (that order is its own safety property), so each mirrored ban leaves an
 * entry in its tag book that will never correspond to a role. It is dropped when
 * the ban is lifted, and until then it occupies one of `TAG_LIMIT` slots. Nothing
 * in this repo can filter it out from this side — the poller's filter is on the
 * verb alone, deliberately — so it is written down here and reported rather than
 * worked around.
 *
 * AND THE ORDERING HAZARD IS ALREADY ANSWERED. `audit.begin` writes its row
 * BEFORE the ban row exists, so a poller reading the log at exactly the wrong
 * moment would find a `ban.issue` with no ban behind it and log "a ban was
 * issued but no ban row could be found for it". That is what `SETTLE_MS` in
 * src/banrole.ts is for — it refuses to read the newest five seconds of the log
 * for precisely this reason — and it was sized against the console's writes,
 * which have the same shape and the same gap of one DynamoDB round trip.
 */

/** The three things this bot mirrors. Every other audit action is ignored. */
export type MirrorAction = 'ban' | 'unban' | 'kick'

/**
 * One audit entry, reduced to the seven things the mirror reads.
 *
 * A PLAIN RECORD RATHER THAN discord.js's `GuildAuditLogsEntry`, for the reason
 * `ScannedMessage` is one: that class is a live object hanging off a guild, a
 * client and a REST handle, and taking one as a parameter would mean every test
 * either constructs one or mocks a class with twenty members. Everything below
 * this line is a function of plain data and can be driven from three lines above
 * an assertion.
 *
 * `at` IS WHEN THE MODERATOR ACTED, not when we heard about it, and it is what
 * the staleness rule is measured from. A kick replayed out of the audit log at
 * boot therefore carries the age it really has.
 */
export interface ModerationEntry {
  /** The audit entry's own snowflake. The idempotency key. */
  readonly id: string
  readonly action: MirrorAction
  readonly at: number
  readonly targetId: string | null
  readonly targetName: string | null
  readonly executorId: string | null
  readonly executorName: string | null
  /** What the moderator typed in Discord's dialog, or null. */
  readonly reason: string | null
}

/**
 * The audit actions this bot acts on, and the only ones it can see.
 *
 * A `Record` RATHER THAN A `switch`, so the listener's filter and the mirror's
 * dispatch read one list. `MemberRoleUpdate` is deliberately absent — see the
 * loop note above — and so is everything else Discord writes to that log, which
 * is most of what happens in a guild.
 */
const MIRRORED: Partial<Record<AuditLogEvent, MirrorAction>> = {
  [AuditLogEvent.MemberBanAdd]: 'ban',
  [AuditLogEvent.MemberBanRemove]: 'unban',
  [AuditLogEvent.MemberKick]: 'kick',
}

/** A username off whatever discord.js put on the entry, or null. */
function nameOf(who: unknown): string | null {
  if (typeof who !== 'object' || who === null) return null
  const username: unknown = (who as { username?: unknown }).username
  return typeof username === 'string' && username.length > 0 ? username : null
}

/**
 * Turn a live audit entry into a `ModerationEntry`, or null for one we ignore.
 *
 * THE NAMES ARE TAKEN OFF THE ENTRY AND NEVER FETCHED. `executor` and `target`
 * arrive populated when discord.js has the user and null when it does not, and a
 * REST lookup to turn a null into a name would put a network call in front of a
 * ban write. Where a name is missing the id is used instead — the console's own
 * fallback in lib/service.ts, chosen there for the property a fallback in a
 * permanent record needs: ugly in a table, and unambiguous.
 */
export function moderationEntry(entry: GuildAuditLogsEntry): ModerationEntry | null {
  const action = MIRRORED[entry.action]
  if (action === undefined) return null

  return {
    id: entry.id,
    action,
    at: entry.createdTimestamp,
    targetId: entry.targetId,
    // `target` is typed as a union across every audit action; for these three it
    // is a user, and anything without a `username` is treated as no name at all.
    targetName: nameOf(entry.target),
    executorId: entry.executorId,
    executorName: nameOf(entry.executor),
    reason: entry.reason,
  }
}

/**
 * ============================================================================
 * THE BAN REASON WHEN DISCORD'S DIALOG WAS LEFT BLANK. THE OWNER SUPPLIES THIS
 * WORDING AND HAS NOT SUPPLIED IT.
 * ============================================================================
 *
 * THIS STRING IS READ BY THE PERSON IT IS ABOUT, WHICH IS WHY IT IS FIRST ON THE
 * LIST. `Ban.reason` is written for the banned person and not for the log —
 * src/ddb.ts says so — and it is required, so a Discord ban typed with no reason
 * has to carry something. The game shows it at the connect refusal, and
 * `/profile` shows it back to them in their own self view (`selfBanBody` in
 * ./commands/profile.ts). Three surfaces, one of them in another codebase.
 *
 * IT USED TO LEAD WITH A LITERAL `PLACEHOLDER:`, AND THAT WAS SHOWN TO THEM TOO.
 * The marker was there so it could not ship by accident; what it actually did
 * was ship, to the one reader in this whole repo who is least able to ask what
 * it means. It is a tag in this comment now, and
 * `scripts/check-placeholders.ts` prints the string on every verify.
 *
 * EVERYTHING AROUND IT IS DECIDED AND TESTED. When it is used, where it is
 * stored, and that it never replaces a reason the moderator did type. Only the
 * words are open.
 *
 * IT IS NOT USED FOR THE KICK. The console's kick route already has its own
 * default for a reasonless kick, written by whoever wrote the console, so
 * src/ringmaster.ts omits the field rather than inventing a second wording for
 * the same silence.
 *
 * @unwritten player — the ban reason stored when Discord's own dialog was left blank; the game shows it at connect refusal.
 */
export const BAN_REASON_UNWRITTEN = 'Banned from the Discord server.'

/**
 * The reason the bot stamps on its own role edit, in Discord's audit log.
 *
 * MACHINE-SHAPED ON PURPOSE, AND THAT IS WHY IT IS NOT A PLACEHOLDER. It is read
 * by an admin scrolling the guild's audit log, and its whole job is to say which
 * process did this and why, in the same vocabulary as the journal line. It is
 * not prose addressed to anybody — but it is one string in one place if the
 * owner ever wants to word it.
 */
export const ROLE_AUDIT_REASON = 'blitz-bot: the game ban this role marked was lifted'

/**
 * Take the game-ban role off somebody.
 *
 * A SEAM RATHER THAN A DIRECT CALL, so `mirrorEntry` runs offline. Null where
 * the mirror is wired without one.
 */
export type RoleTaker = (userId: string) => Promise<void>

/**
 * The real one.
 *
 * `members.removeRole` RATHER THAN `member.roles.remove`, and the difference is
 * a REST call. The second needs a `GuildMember` object, which means fetching the
 * member first; this takes a user id and issues the one PATCH. It matters
 * because the member usually is not there to fetch — see the note in
 * `mirrorEntry` on why this call is normally a no-op.
 *
 * IT NEEDS NO PRIVILEGED INTENT. `GuildMembers` is deliberately absent from
 * `createClient`'s intents and stays absent: this is a REST write against an id
 * we already have, not a gateway read of the member list.
 */
export function roleTaker(client: Client, guildId: string, roleId: string): RoleTaker {
  return async (userId) => {
    const guild = await client.guilds.fetch(guildId)
    await guild.members.removeRole({ user: userId, role: roleId, reason: ROLE_AUDIT_REASON })
  }
}

/**
 * Everything the mirror needs from the world, named rather than imported.
 *
 * ONE SEAM, AND IT IS WHY EVERY BRANCH BELOW IS TESTABLE WITH NO DISCORD, NO AWS
 * AND NO CONSOLE. `Pick<Ddb, …>` rather than `Ddb` is the access policy written
 * where a compiler reads it: the mirror can read the identifier index and the
 * player registry, read/issue/lift a ban, and append to the audit log — and it
 * cannot touch the maintenance row or anything else however it is edited later.
 *
 * `audit` AND `players` ARE NEW HERE, AND THIS COMMENT USED TO SAY THE MIRROR
 * COULD TOUCH NEITHER. What changed is the owner's ask — "any admin actions like
 * kicking or banning from discord to be shown in Ringmaster's audit log" — and
 * the two reads pull in opposite directions from the same sentence: `audit` so
 * the ban and the lift leave a row in the chronological record of who did what,
 * and `players` so the WHO on that row is a human name rather than a snowflake.
 * `audit` is the only WRITE the mirror has ever gained that is not a ban.
 */
export interface MirrorDeps {
  /**
   * The bot's own user id, for the loop guard. Null before the gateway is ready,
   * which is safe here rather than a hole: an entry with a null `executorId` is
   * already refused a line later, so the guard is only ever comparing two real
   * ids or not running at all.
   */
  readonly selfId: string | null

  readonly ddb: Pick<Ddb, 'audit' | 'bans' | 'playerIds' | 'players'>

  /** The live kick, or null when `COMMAND_SECRET` is unset. */
  readonly kick: Ringmaster | null

  /** Take the game-ban role off, or null when no role is wired. */
  readonly untag: RoleTaker | null

  readonly now?: () => number
}

/**
 * What one entry did, for the tests and for nothing else.
 *
 * THE JOURNAL IS THE REAL OUTPUT AND THIS IS THE ASSERTABLE ONE. Every branch
 * below writes its own line, because that is what an operator reads; returning a
 * value as well means a test can pin WHICH branch ran without matching on log
 * text that a rewording would break.
 */
export type MirrorResult =
  | { did: 'ignored'; why: 'self' | 'no-target' | 'no-executor' }
  | {
      did: 'ban'
      /** The row's partition key: a license, or a `discord:` id. */
      key: string
      outcome: BanIssueOutcome
      /** False for a `discord:`-keyed row. See `enforcedNote`. */
      enforced: boolean
      kick: KickResult | null
    }
  | { did: 'unban'; lifted: string[]; kept: string[]; roleRemoved: boolean }
  | { did: 'kick'; kick: KickResult | null }
  | { did: 'failed'; step: 'licence' | 'issue' | 'read' | 'lift'; failure: DdbFailure }

/**
 * A ban keyed on a `discord:` identifier is a RECORD AND NOT A DOOR, and
 * anything that reports one has to say so.
 *
 * THE GAME'S CONNECT GATE IS ONE LOOKUP ON THE CONNECTING LICENSE. Somebody the
 * game has never seen has no license to look up, so the row this bot writes for
 * them sits in the table, shows on the console's ban list, and stops nobody from
 * joining. That changes when fivem-ringmaster#38 lands and the gate learns to
 * check a qualified Discord identifier too; until then, `enforced=false` on the
 * journal line is the difference between a ban and a note.
 *
 * TWO REASONS NOT TO "FIX" IT FROM THIS SIDE, BOTH FROM src/ddb.ts: FiveM only
 * reports a `discord:` identifier when the player has Discord's activity
 * integration switched on, which is opt-in and therefore evadable by switching
 * it off; and the console's profile link on such a row points at a player page
 * that resolves to nothing.
 */
function enforcedNote(key: string): boolean {
  return !key.startsWith('discord:')
}

/**
 * Is this ban row one that a Discord ban created, and is it OLDER than the unban
 * being processed?
 *
 * THE FIRST HALF IS THE ONE THE BRIEF ASKS FOR AND IT IS THE IMPORTANT ONE.
 * Lifting unconditionally would walk somebody game-banned for cheating straight
 * back in: an admin unbans them from Discord — a favour about a chat channel —
 * and the console's cheating ban evaporates with it. `discordEntryId` is present
 * only on rows this bot wrote, and `bans.issue` refuses to overwrite an ACTIVE
 * ban, so a person already game-banned by the console and then banned on Discord
 * keeps a row with no marker on it. That is exactly the row this must not touch.
 *
 * THE SECOND HALF CLOSES A REPLAY THE FIRST ONE DOES NOT. Audit entry ids are
 * snowflakes and snowflakes sort by time, so "the ban on this row was created by
 * a LATER Discord event than this unban" is a comparison rather than a guess —
 * and it is the difference between a redelivered or replayed unban being ignored
 * and it lifting a ban somebody re-issued afterwards. src/ddb.ts names that gap
 * explicitly where `bans.lift` explains it has no event id of its own; this is
 * the caller-side answer to it.
 *
 * A MARKER THAT IS NOT A SNOWFLAKE MEANS NO, and says so at `warn`. Nothing in
 * this system writes one, so a row carrying one is a row something unexpected
 * touched — and the safe direction for "I cannot tell how old this is" on a
 * moderation record is to leave it alone.
 */
export function liftableBy(ban: Ban, entry: ModerationEntry): boolean {
  const marker = ban.discordEntryId
  if (!marker) return false

  let issuedBy: bigint
  let unbanBy: bigint
  try {
    issuedBy = BigInt(marker)
    unbanBy = BigInt(entry.id)
  } catch {
    log('warn', 'ban row carries a discordEntryId that is not a snowflake, so it was left alone', {
      ban: ban.license,
      marker,
      entry: entry.id,
    })
    return false
  }

  return issuedBy <= unbanBy
}

/**
 * Act on one moderation entry.
 *
 * THE ORDER OF THE GUARDS IS THE SAFETY PROPERTY, and it is the shape the
 * console's `serviceGate` uses: cheapest and most structural first, so nothing
 * further down can be reached by an entry that should never have got past the
 * top.
 *
 *   ourselves? → a target? → an executor? → then, and only then, act.
 *
 * IT NEVER THROWS. This is called from an EventEmitter listener and from the
 * boot replay, and both handle the promise rather than await it; a throw out of
 * here would become an unhandled rejection attached to no member and no event.
 * Every failure is a `MirrorResult` and a line in the journal.
 */
export async function mirrorEntry(entry: ModerationEntry, deps: MirrorDeps): Promise<MirrorResult> {
  const now = deps.now ?? Date.now

  /**
   * THE LOOP PREVENTION, AND IT IS ONE LINE. The bot removes a role, Discord
   * writes an audit entry for it, the entry comes back to this listener. Both
   * YAGPDB and Red-DiscordBot do exactly this and nothing more elaborate,
   * because anything more elaborate is state that can be wrong.
   */
  if (entry.executorId !== null && entry.executorId === deps.selfId) {
    return { did: 'ignored', why: 'self' }
  }

  if (entry.targetId === null) {
    // Discord's audit schema allows it and these three actions never do it in
    // practice. Worth a line rather than a silent return: an entry we cannot
    // place is the shape of the API having changed under us.
    log('warn', 'moderation entry names no target, so nothing was mirrored', {
      entry: entry.id,
      action: entry.action,
    })
    return { did: 'ignored', why: 'no-target' }
  }

  /**
   * NO EXECUTOR, NO ACTION — THE CONSOLE'S OWN STANCE IN ITS OWN WORDS: "an
   * unattributable ban is the one thing the audit table exists to prevent."
   * `Ban.by` may be null and `byName` may not, so mirroring an executor-less
   * entry would mean inventing a name for whoever did it, and a name in a
   * permanent moderation record is the one field that must never be a guess.
   * The console would refuse the relayed kick for the same reason.
   */
  if (entry.executorId === null) {
    log('warn', 'moderation entry names no executor, so nothing was mirrored', {
      entry: entry.id,
      action: entry.action,
      target: entry.targetId,
    })
    return { did: 'ignored', why: 'no-executor' }
  }

  // Narrowed once, here, so the four uses below do not each re-prove it.
  const executorId = entry.executorId
  const targetId = entry.targetId

  /** The license a Discord account plays on, or null. Never a guess. */
  async function licenceFor(discordId: string): Promise<DdbResult<string | null>> {
    const found = await deps.ddb.playerIds.licensesFor(qualifyId('discord', discordId))
    /**
     * `at(-1)` — MOST RECENT LAST, which is how the index stores them, and the
     * same narrowing `readsFrom` in src/commands/profile.ts does. A failure is
     * passed through as itself: null means "this account has never connected",
     * and reporting a table we could not read as that is the confident wrong
     * answer `qualifyId` exists to prevent.
     */
    return found.ok ? { ok: true, value: found.value.at(-1) ?? null } : found
  }

  /**
   * The admin's own license, for `Ban.by`.
   *
   * READ FROM `ringmaster-player-ids` AND NOT FROM THE GRANTS TABLE, WHICH IS
   * NOT WHERE THE CONSOLE READS IT. The console fills `actorLicense` from
   * `grantsForDiscordId` — the row linking an admin's Discord account to their
   * license — and this bot has no reader for that table at all: adding one is a
   * new table in `Ddb` and a new statement in an IAM policy, which is a
   * deploy-level change rather than a code one. What is read instead is the
   * license that Discord account has PLAYED on, which for an admin who plays is
   * the same license by a different road and for one who does not is null.
   *
   * A FAILURE HERE IS NOT A REFUSAL, unlike the console's. Over there the read
   * happens BEFORE the ban and refusing costs a retry; here the Discord ban has
   * already happened and refusing would cost the mirror of it. `by: null` with a
   * line in the journal is the cheaper wrong answer, and `byName` — which is
   * what the ban list actually renders — is unaffected.
   *
   * ASKED AT MOST ONCE PER ENTRY, AND THAT IS WHY THE ANSWER IS CACHED. It is now
   * wanted by three callers on one entry — the ban row's `by`, the lift's `by`
   * once per key, and the audit row's `actorLicense` — and they are all asking
   * the same question about the same admin at the same instant. Three round trips
   * for one answer would be three chances for them to DISAGREE as well: a read
   * that failed on the second attempt would put a license on the ban row and a
   * null on the audit row beside it, for the same act.
   */
  let issuer: { licence: string | null } | null = null

  async function issuerLicence(): Promise<string | null> {
    if (issuer !== null) return issuer.licence

    const found = await licenceFor(executorId)
    if (found.ok) {
      issuer = { licence: found.value }
      return issuer.licence
    }

    log('warn', 'could not read the issuing admin license, so the ban row will not carry one', {
      entry: entry.id,
      executor: executorId,
      failure: found.failure.kind,
      detail: found.failure.message,
    })

    // Cached as a FAILURE too, deliberately. Retrying a table that just timed
    // out, inside the same entry, spends the deadline to arrive at a different
    // answer for the same act — see above.
    issuer = { licence: null }
    return null
  }

  /**
   * The name written into the permanent record.
   *
   * THE ID IS THE FALLBACK, WHICH IS THE CONSOLE'S CHOICE AND ITS REASONING:
   * ugly in a table, and unambiguous, which is the property a fallback in an
   * audit log needs. It is never blank and never the word "unknown".
   */
  const issuerName = entry.executorName ?? executorId

  /**
   * The acting admin, in the shape the console's audit log names people in.
   *
   * ATTRIBUTION IS THE HUMAN, WHICH IS THE WHOLE POINT OF THE ROW. The console
   * builds this from the Discord id in `SERVICE_ACTOR_HEADER`:
   * `{ license: grantsForDiscordId(id)?.license ?? null, name: discordName ?? id,
   * discordId: id }` (fivem-ringmaster `src/lib/service.ts`). This is the same
   * shape reached by the one road this bot has — see `issuerLicence` on why the
   * license comes from `ringmaster-player-ids` and not from the grants table.
   *
   * "blitz-bot" IS NEVER THE ANSWER. Which process wrote the row is not what
   * anybody asks an audit log, and an admin who has never played the game is
   * still a person: they get their Discord id as the name and a NULL license,
   * which is exactly what the console writes for an admin with no grants row.
   *
   * THE NAME IS DISCORD'S FIRST AND THE GAME'S SECOND, in that order and not the
   * other way round. The console writes the Discord display name, so taking the
   * in-game name first would file the same admin under two different names
   * depending on which repo wrote the row. `ringmaster-players` is consulted only
   * when Discord gave us no name at all — which happens on the boot replay, where
   * discord.js has no cached user — and it earns its round trip there because the
   * alternative is a raw snowflake in a permanent record.
   */
  let acting: Actor | null = null

  async function actingAs(): Promise<Actor> {
    if (acting !== null) return acting

    const licence = await issuerLicence()

    // Settled once for the whole entry, for `issuerLicence`'s reason: an unban
    // that lifts two keys writes two audit rows about ONE act, and two rows
    // naming the same admin differently would be worse than either name alone.
    acting = {
      license: licence,
      name: entry.executorName ?? (await playedName(licence)) ?? executorId,
      discordId: executorId,
    }

    return acting
  }

  /** The admin's most recent in-game name, or null. Never a guess, never a throw. */
  async function playedName(licence: string | null): Promise<string | null> {
    if (licence === null) return null

    const record = await deps.ddb.players.get(licence)
    if (!record.ok) {
      log('warn', 'could not read the acting admin`s player record, so the id was used instead', {
        entry: entry.id,
        executor: executorId,
        failure: record.failure.kind,
        detail: record.failure.message,
      })
      return null
    }

    const name = record.value?.name
    return typeof name === 'string' && name.length > 0 ? name : null
  }

  /**
   * Open an audit row for something this bot is ABOUT to do, or null.
   *
   * NULL IS "IT WAS NOT RECORDED", AND THE CALLER CARRIES ON ANYWAY. This is the
   * console's rule turned exactly around, and the header says why at length: over
   * there an unlogged action must not proceed, because the console is the
   * authority and refusing a click costs a retry. Here the Discord ban has
   * already happened, the ban row is what keeps the person off the game server,
   * and there is no dialog for anybody to retry from. So a failed audit write is
   * loud — `error`, which reaches the status channel — and then the ban goes on.
   *
   * IT NEVER THROWS. `audit.begin` answers with a `DdbResult`; everything it can
   * report, including having run out of free sort keys under a colliding writer,
   * arrives here as a failure rather than as an exception.
   */
  async function beginRow(input: AuditInput): Promise<AuditHandle | null> {
    const opened = await deps.ddb.audit.begin(input)

    if (!opened.ok) {
      log('error', 'the moderation could not be written to the audit log, but it went ahead', {
        entry: entry.id,
        action: input.action,
        target: input.targetLicense,
        failure: opened.failure.kind,
        detail: opened.failure.message,
      })
      return null
    }

    return opened.value
  }

  /**
   * Stamp the outcome onto an open audit row. A null handle is a no-op.
   *
   * A ROW LEFT AT `pending` IS THE HONEST RECORD OF A BOOKKEEPING FAILURE and is
   * a different fact from `failed` — the console's `lib/audit.ts` is explicit
   * that "we asked and never learned what happened" has to stay distinguishable
   * from "it did not work". So this reports and swallows: the action it describes
   * has already happened either way.
   */
  async function settleRow(
    handle: AuditHandle | null,
    outcome: 'ok' | 'failed',
    error?: string,
  ): Promise<void> {
    if (handle === null) return

    const stamped = await deps.ddb.audit.resolve(handle, outcome, error ?? null)
    if (!stamped.ok) {
      log('warn', 'the audit row could not be closed, so it stays pending', {
        entry: entry.id,
        commandId: handle.commandId,
        outcome,
        failure: stamped.failure.kind,
        detail: stamped.failure.message,
      })
    }
  }

  /**
   * Did THIS Discord event already write the ban row sitting at `key`?
   *
   * A QUESTION ABOUT THE LOG AND NOT ABOUT THE BAN. `bans.issue` decides on its
   * own whether to write, by the same key and the same attribute; nothing here
   * changes that. All this decides is whether a replay gets a second audit row —
   * see the long note at the call site.
   *
   * FALSE WHEN THE READ FAILS, so the doubt costs a possible duplicate row rather
   * than a possible missing one. It is a `warn` and not an `error`: nothing about
   * the ban is affected, and the next line of the journal reports the ban itself.
   */
  async function alreadyMirrored(key: string): Promise<boolean> {
    const read = await deps.ddb.bans.get(key)

    if (!read.ok) {
      log('warn', 'could not check whether this ban was already mirrored, so it was logged again', {
        entry: entry.id,
        key,
        failure: read.failure.kind,
        detail: read.failure.message,
      })
      return false
    }

    return read.value?.discordEntryId === entry.id
  }

  /**
   * Ask the console for a live kick, and report what came back.
   *
   * THREE THINGS CAN STOP IT BEFORE A REQUEST IS MADE, and each is a different
   * sentence:
   *
   *   NO LICENSE — the game has never seen this Discord account. Nothing to kick
   *     and nothing wrong; `info`.
   *
   *   NO RELAY — `COMMAND_SECRET` is unset, so this deployment cannot ask for a
   *     kick at all. A `warn`, on every ban, on purpose: it is a half-wired
   *     integration, bans are silently not taking effect on a live server, and
   *     fixing it is one variable.
   *
   *   TOO OLD — the entry predates the staleness window, which in practice means
   *     the boot replay is walking last week's audit log. `info`, and
   *     deliberately NOT left to the relay's own check: that one reports a drop,
   *     and a drop is a `warn`, so a restart would post a burst of alarms about
   *     kicks nobody expected to happen.
   *
   * `KICK_TTL_MS` IS IMPORTED RATHER THAN RESTATED so the two checks cannot
   * drift into disagreeing about what stale means. The relay keeps its own, for
   * the case this one cannot see: a kick that goes stale WHILE it is retrying.
   */
  async function relayKick(licence: string | null): Promise<KickResult | null> {
    if (licence === null) {
      log('info', 'the game has never seen this account, so there was nothing to kick', {
        entry: entry.id,
        action: entry.action,
        target: targetId,
      })
      return null
    }

    if (deps.kick === null) {
      log('warn', 'COMMAND_SECRET is not set, so no live kick was attempted', {
        entry: entry.id,
        action: entry.action,
        licence,
      })
      return null
    }

    const age = now() - entry.at
    if (age >= KICK_TTL_MS) {
      log('info', 'moderation entry is too old for a live kick, so none was sent', {
        entry: entry.id,
        action: entry.action,
        licence,
        seconds: Math.round(age / 1000),
      })
      return null
    }

    const result = await deps.kick.kick({
      license: licence,
      at: entry.at,
      // The human who acted, so the console's audit row names them and not this
      // bot. See `SERVICE_ACTOR_HEADER` in src/ringmaster.ts.
      actorDiscordId: executorId,
      playerName: entry.targetName,
      reason: entry.reason,
    })

    const fields = {
      entry: entry.id,
      action: entry.action,
      licence,
      target: targetId,
      attempts: result.attempts,
    }

    if (result.outcome === 'dispatched') {
      /**
       * INFO, AND `confirmed=false` IS ON THE LINE. The console is explicit that
       * `dispatched` means the command reached the FXServer console and nothing
       * more — nothing in this system reports whether a player was really
       * removed. So this line must not say "kicked", and it does not need a
       * human, which is what `info` means in this bot (src/log.ts).
       */
      log('info', 'live kick dispatched to the game server', {
        ...fields,
        confirmed: result.confirmed,
        commandId: result.commandId,
      })
      return result
    }

    /**
     * WARN, BECAUSE THE PERSON IS STILL IN THE MATCH. The ban row is already
     * durable and the game will refuse them at their next connect, but right now
     * a banned player is still playing and nobody would know. This is what
     * "report the real outcome" means when there is no command reply to edit: it
     * reaches the status channel because `warn` does.
     */
    log(
      'warn',
      result.outcome === 'failed'
        ? 'live kick failed, so the player may still be in the match'
        : 'live kick was dropped, so the player may still be in the match',
      {
        ...fields,
        ...(result.outcome === 'failed'
          ? { failure: result.failure, status: result.status }
          : { dropped: result.why }),
        detail: result.detail,
      },
    )
    return result
  }

  if (entry.action === 'kick') {
    /**
     * A KICK IS NOT A BAN, SO NOTHING IS WRITTEN TO DYNAMODB. It is a nudge —
     * the console's own kick route says as much and does not even require a
     * reason for one — and the person may reconnect a second later. Recording it
     * as a ban row would put somebody on the ban list for being AFK in the bus.
     *
     * The Discord kick has already happened by the time we hear about it; the
     * only thing left to mirror is the removal from the running match.
     */
    const licence = await licenceFor(targetId)
    if (!licence.ok) {
      log('error', 'could not read the licence for a kicked member, so no kick was relayed', {
        entry: entry.id,
        target: targetId,
        failure: licence.failure.kind,
        detail: licence.failure.message,
      })
      return { did: 'failed', step: 'licence', failure: licence.failure }
    }

    return { did: 'kick', kick: await relayKick(licence.value) }
  }

  if (entry.action === 'ban') {
    const licence = await licenceFor(targetId)
    if (!licence.ok) {
      /**
       * THE READ FAILED, SO NOTHING IS WRITTEN — a decision rather than a
       * shortcut. The key depends on the answer: a license if the game has seen
       * them, a `discord:` id if not. Guessing the second because the first
       * could not be read would write a row on a key that is not theirs, which
       * is worse than no row: a ban that never fires, and a lift that will never
       * find it.
       *
       * ERROR, BECAUSE THE BOT HAS NOT DONE THE THING IT IS FOR. An admin banned
       * somebody and the game does not know.
       */
      log('error', 'could not read the licence for a banned member, so no ban was written', {
        entry: entry.id,
        target: targetId,
        failure: licence.failure.kind,
        detail: licence.failure.message,
      })
      return { did: 'failed', step: 'licence', failure: licence.failure }
    }

    const key = licence.value ?? qualifyId('discord', targetId)
    const enforced = enforcedNote(key)

    /**
     * THE AUDIT ROW IS OPENED BEFORE THE BAN WRITE AND CLOSED AFTER IT, which is
     * the console's two-phase contract and the whole reason `pending` exists as
     * an outcome: a row written only on success is missing in exactly the moment
     * it matters, and its absence looks identical to nobody having tried.
     *
     * UNLESS THIS EVENT HAS ALREADY BEEN MIRRORED, IN WHICH CASE THERE IS NO
     * SECOND ACT TO RECORD. `bans.issue` is idempotent on `discordEntryId` and
     * answers `duplicate-event`, but it only answers AFTER the write it is about
     * to skip — and by then the audit row would already be open. That row cannot
     * be withdrawn: `ringmaster-audit` is append-only and this bot has no delete.
     * So the cost of finding out too late is permanent, and it is not a rare
     * case: `reconcileModeration` replays up to `RECONCILE_LIMIT` bans on any
     * boot with no cursor, which would put twenty-five duplicate bans in the
     * console's `/audit` page, dated today, describing acts from last week.
     *
     * ONE `GetItem`, AND IT IS NOT A SECOND SPELLING OF THE IDEMPOTENCY RULE. It
     * asks `bans.get` — the same reader `bans.issue` itself uses, by the same key
     * — one question: did THIS entry write this row. The decision to write or
     * skip the ban stays entirely inside src/ddb.ts; all that is decided here is
     * whether there is anything to log.
     *
     * A FAILED PROBE FALLS THROUGH TO WRITING THE ROW. The direction matters: an
     * extra audit row for a replay is noise in a log, and a missing one is a ban
     * nobody can find afterwards.
     */
    const handle = (await alreadyMirrored(key))
      ? null
      : await beginRow({
          action: 'ban.issue',
          actor: await actingAs(),
          // The bans table's own key, because that is what `AuditRow.targetLicense`
          // means to every reader of it — the console's `/audit` page renders it as
          // the player, and src/banrole.ts feeds it straight back into `bans.get`.
          targetLicense: key,
          targetName: entry.targetName,
          reason: entry.reason ?? BAN_REASON_UNWRITTEN,
          detail: {
            // The console's two, in the console's words: see its
            // `src/app/api/bans/route.ts`. Both are constants here, because the
            // policy is that a Discord ban is permanent.
            expiresAt: null,
            permanent: true,
            // PROVENANCE, which the console's rows carry as `incidentId` and this
            // one carries as the Discord event that caused it. It is also what
            // makes a duplicate identifiable in the log itself if one ever does
            // get through the probe above.
            discordEntryId: entry.id,
            // `enforced=false` means the row exists and the game's connect gate
            // cannot see it — see `enforcedNote`. It belongs on the permanent
            // record for the same reason it is on the journal line.
            enforced,
          },
        })

    const issued = await deps.ddb.bans.issue({
      id: key,
      by: await issuerLicence(),
      byName: issuerName,
      // The moderator's own words, or the marked placeholder. Never a rewrite of
      // what they typed.
      reason: entry.reason ?? BAN_REASON_UNWRITTEN,
      /**
       * PERMANENT, AND IT IS THE POLICY RATHER THAN A DEFAULT. "A Discord ban
       * means banned in the game, permanently." Discord's ban dialog has no
       * duration field to read one from even if the policy wanted it.
       */
      expiresAt: null,
      playerName: entry.targetName,
      entryId: entry.id,
    })

    if (!issued.ok) {
      /**
       * `failed`, NOT A ROW LEFT AT `pending`. We asked and we DID learn what
       * happened: the write came back refused. That is the case the outcome
       * field exists to tell apart from silence, and it is the one the brief
       * insists on — a ban that failed must not leave a row claiming otherwise.
       */
      await settleRow(handle, 'failed', issued.failure.message)

      log('error', 'the game ban could not be written', {
        entry: entry.id,
        target: targetId,
        key,
        failure: issued.failure.kind,
        detail: issued.failure.message,
      })
      return { did: 'failed', step: 'issue', failure: issued.failure }
    }

    /**
     * `ok` FOR EVERY OUTCOME THAT CAME BACK WITHOUT A FAILURE, which is what the
     * console's `audited()` wrapper does: the outcome field records whether the
     * ACTION completed, not which branch of it ran. `already-banned` is a
     * completed action — the admin banned somebody the console had already
     * banned, the standing ban is not ours to replace, and the row records that
     * they acted. Which branch it was is on the journal line and on the ban row.
     */
    await settleRow(handle, 'ok')

    log('info', 'discord ban mirrored to the game', {
      entry: entry.id,
      target: targetId,
      key,
      outcome: issued.value.outcome,
      /**
       * ON EVERY LINE, BECAUSE THE ALTERNATIVE MISLEADS. `enforced=false` says
       * the row exists and the game's connect gate cannot see it — see
       * `enforcedNote`. A line saying only "mirrored" would be true and would
       * leave a reader believing the person is kept out.
       */
      enforced,
      by: issuerName,
    })

    /**
     * THE KICK IS ATTEMPTED FOR EVERY OUTCOME, `duplicate-event` INCLUDED. The
     * marker is written by the ban write, which happens BEFORE the kick, so
     * `duplicate-event` proves the row was written and does not prove the kick
     * landed — and a kick against somebody who is not connected is a no-op on
     * the game side. What stops a replay removing the wrong session is the
     * staleness rule in `relayKick`, not this branch.
     */
    return {
      did: 'ban',
      key,
      outcome: issued.value.outcome,
      enforced,
      kick: await relayKick(licence.value),
    }
  }

  /**
   * THE UNBAN, WHICH IS THE MOST CAREFUL PATH HERE.
   *
   * TWO KEYS ARE CONSIDERED AND THEY ARE THE ONLY TWO THIS BOT EVER WRITES: the
   * license the account plays on today, and its `discord:` identifier. Checking
   * both is not belt and braces, it closes a real hole — somebody with no player
   * record is banned under a `discord:` key, that key is not enforced by the game
   * (see `enforcedNote`), so they go on playing and acquire a license; a lift
   * that looked only at the license would find no row and the `discord:` one
   * would stay banned for good.
   *
   * IT IS BOUNDED AT TWO. The reverse index can hold several licenses and only
   * the most recent is ever written to, so a third read would be looking for a
   * row nothing in this bot could have put there.
   */
  const licence = await licenceFor(targetId)
  if (!licence.ok) {
    log('error', 'could not read the licence for an unbanned member, so nothing was lifted', {
      entry: entry.id,
      target: targetId,
      failure: licence.failure.kind,
      detail: licence.failure.message,
    })
    return { did: 'failed', step: 'licence', failure: licence.failure }
  }

  const keys = [...new Set([licence.value, qualifyId('discord', targetId)])].filter(
    (key): key is string => key !== null,
  )

  const lifted: string[] = []
  const kept: string[] = []

  for (const key of keys) {
    const read = await deps.ddb.bans.get(key)
    if (!read.ok) {
      /**
       * A FAILED READ IS NOT "NO BAN". Carrying on would mean deciding the role
       * question — and possibly removing the role — on the strength of a table
       * we could not reach, which is the same confident wrong answer this file
       * refuses everywhere else.
       */
      log('error', 'could not read a ban row, so the lift was abandoned', {
        entry: entry.id,
        key,
        failure: read.failure.kind,
        detail: read.failure.message,
      })
      return { did: 'failed', step: 'read', failure: read.failure }
    }

    const ban = read.value
    if (ban === null) continue

    if (!liftableBy(ban, entry)) {
      /**
       * THE REFUSAL THE BRIEF IS BUILT AROUND. This ban was issued by the
       * console — a cheating ban, an incident verdict — or by a LATER Discord
       * ban than the unban being replayed. Either way the Discord unban is not
       * about it, and lifting it would walk somebody straight back in.
       *
       * WARN, BECAUSE THE ADMIN WILL BELIEVE OTHERWISE. They unbanned somebody
       * on Discord and the game ban stands; that is the correct outcome and it
       * is not the one they will assume, so it goes where a person reads it.
       *
       * ONLY WHEN IT IS STILL IN FORCE. An expired or already-lifted row that
       * we did not write is not a refusal to report — nobody is being kept out
       * by it, and a line about it would be an alarm with nothing behind it.
       */
      if (isBanActive(ban, now())) {
        kept.push(key)
        log('warn', 'the game ban was not created by a discord ban, so it still stands', {
          entry: entry.id,
          key,
          target: targetId,
          issuedBy: ban.byName,
          marker: ban.discordEntryId ?? null,
        })
      }
      continue
    }

    /**
     * THE SAME TWO PHASES AS THE BAN, AND THE SAME REASON FOR SKIPPING IT.
     *
     * A ROW ALREADY CARRYING `liftedAt` IS ONE `bans.lift` WILL LEAVE ALONE —
     * that is its own first check, and it exists so a redelivered unban cannot
     * write over the original lifter's name and time. An audit row opened in
     * front of that call would be a `ban.lift` for a lift that did not happen,
     * and on a boot with no cursor `reconcileModeration` replays every recent
     * unban, so it would be one per replayed unban forever after.
     *
     * `liftedAt` AND NOT `isBanActive`, and the difference is a real case rather
     * than a nicety: a ban that has EXPIRED but was never lifted is still one
     * `bans.lift` stamps, so it is a real act and earns its row. `isBanActive`
     * would answer "not in force" for both and quietly drop the second.
     *
     * THE ROW IS READ ALREADY. `ban` came from the `bans.get` above, which the
     * lift path has always made, so this costs nothing.
     */
    const handle = ban.liftedAt
      ? null
      : await beginRow({
          action: 'ban.lift',
          actor: await actingAs(),
          targetLicense: key,
          targetName: ban.playerName ?? entry.targetName,
          reason: entry.reason ?? null,
          detail: {
            // The console's two, from its `src/app/api/bans/lift/route.ts`: what
            // they were banned for, and when. A lift row that carried only the
            // unban reason would make "what was undone here" unanswerable
            // without a second lookup.
            originalReason: ban.reason,
            bannedAt: ban.at,
            // Ours: which Discord event lifted it, and which one had banned
            // them. `liftableBy` compares exactly these two and refuses when the
            // ban is newer, so the pair is the evidence for the decision.
            discordEntryId: entry.id,
            liftsEntryId: ban.discordEntryId ?? null,
          },
        })

    const result = await deps.ddb.bans.lift({
      id: key,
      by: await issuerLicence(),
      byName: issuerName,
      reason: entry.reason,
    })

    if (!result.ok) {
      await settleRow(handle, 'failed', result.failure.message)

      log('error', 'the game ban could not be lifted', {
        entry: entry.id,
        key,
        failure: result.failure.kind,
        detail: result.failure.message,
      })
      return { did: 'failed', step: 'lift', failure: result.failure }
    }

    await settleRow(handle, 'ok')

    if (result.value.outcome === 'lifted') lifted.push(key)

    log('info', 'discord unban mirrored to the game', {
      entry: entry.id,
      target: targetId,
      key,
      outcome: result.value.outcome,
      by: issuerName,
    })
  }

  /**
   * THE ROLE COMES OFF ONLY WHEN NO ACTIVE GAME BAN IS LEFT, which is the
   * invariant the role exists to express: it is on somebody exactly while a game
   * ban stands. A cheating ban that survived the loop above is precisely the case
   * where the role must stay — taking it off would hand back the limited access
   * that the standing ban is the reason for.
   *
   * IT IS USUALLY A NO-OP, AND THAT IS EXPECTED RATHER THAN A BUG. A Discord
   * unban does not put anybody back in the guild, it only makes rejoining
   * possible, so at the moment this runs the target is almost always not a member
   * and Discord answers `Unknown Member`. That is the ordinary case and is logged
   * at `info`. The removal earns its place for the member who IS in the guild:
   * somebody the console game-banned, who kept their limited access, and whose
   * ban this event has just lifted.
   */
  let roleRemoved = false

  if (deps.untag === null) {
    log('info', 'no game-ban role is configured, so none was removed', { entry: entry.id })
  } else if (kept.length > 0) {
    log('info', 'a game ban still stands, so the game-ban role was kept', {
      entry: entry.id,
      target: targetId,
      kept,
    })
  } else {
    try {
      await deps.untag(targetId)
      roleRemoved = true
      log('info', 'game-ban role removed', { entry: entry.id, target: targetId })
    } catch (error) {
      const expected =
        error instanceof DiscordAPIError &&
        (error.code === RESTJSONErrorCodes.UnknownMember ||
          error.code === RESTJSONErrorCodes.UnknownRole)

      log(
        expected ? 'info' : 'warn',
        expected
          ? 'nobody to take the game-ban role off, which is normal after an unban'
          : 'could not remove the game-ban role',
        { entry: entry.id, target: targetId, error },
      )
    }
  }

  return { did: 'unban', lifted, kept, roleRemoved }
}

/**
 * Where the boot replay's cursor is kept.
 *
 * IN `ringmaster-bot-state` RATHER THAN ON DISK, and the difference is what
 * happens on a fresh box. A file under `StateDirectory=` is lost when the
 * instance is replaced, and losing this one means replaying a window of audit
 * log that has already been mirrored — harmless, because every write below is
 * idempotent, but a burst of DynamoDB reads on a boot that had no reason for
 * one. The table already exists and this is its first caller.
 */
export const AUDIT_CURSOR_KEY = 'discord-audit-cursor'

/**
 * How much history one boot may replay, per action.
 *
 * TWENTY-FIVE, WHICH IS A BOUND AND NOT A CAPACITY. The cursor means a normal
 * restart reads nothing at all — three REST calls that come back empty — so this
 * number only ever matters after a real outage, and there it is the answer to
 * "how much are we willing to spend catching up". Each entry costs up to three
 * DynamoDB round trips, so seventy-five entries is the worst boot this can have,
 * and a longer outage than that is one where somebody should be looking anyway.
 *
 * THE THREE ACTIONS ARE FETCHED SEPARATELY FOR THIS REASON. One untyped fetch
 * would spend its whole window on whatever else the guild's audit log recorded —
 * a channel rename, a role edit — and quietly come back with no moderation in it
 * at all.
 */
export const RECONCILE_LIMIT = 25

/**
 * Read one page of the guild's audit log. A seam, so the replay runs offline.
 *
 * `after` IS AN ENTRY ID AND MEANS "NEWER THAN THIS". Null is the first-ever
 * boot; see `reconcileModeration`.
 */
export type AuditReader = (action: MirrorAction, after: string | null) => Promise<ModerationEntry[]>

/** The real one, over one guild. */
export function auditReader(guild: Guild, limit = RECONCILE_LIMIT): AuditReader {
  const types: Record<MirrorAction, AuditLogEvent> = {
    ban: AuditLogEvent.MemberBanAdd,
    unban: AuditLogEvent.MemberBanRemove,
    kick: AuditLogEvent.MemberKick,
  }

  return async (action, after) => {
    const page = await guild.fetchAuditLogs({
      type: types[action],
      limit,
      ...(after === null ? {} : { after }),
    })

    return [...page.entries.values()]
      .map((entry) => moderationEntry(entry))
      .filter((entry): entry is ModerationEntry => entry !== null)
  }
}

/**
 * Catch up on what was missed while the bot was down.
 *
 * WHY THIS EXISTS. Gateway events are not queued for a client that is not
 * connected: a ban issued during a deploy, a crash or a network partition is an
 * event nobody will ever redeliver. Without a replay the mirror is only as
 * reliable as this process's uptime, and this process restarts on every deploy.
 *
 * IT REPLAYS THE AUDIT LOG AND NOT THE BAN LIST, WHICH IS A DEPARTURE WORTH
 * STATING. "Reconcile Discord's ban list against DynamoDB" was the brief, and
 * `guild.bans.fetch()` is the literal reading of it. It was rejected because
 * that list carries a user and a reason and NOTHING ELSE — no executor, so every
 * mirrored ban would be attributed to nobody, and no entry id, so the idempotency
 * key would have to be invented. Those are the two things this whole design
 * rests on. The audit log carries both, and replaying it is the same
 * reconciliation reached through the door that has the keys in it.
 *
 * WHAT THAT COSTS, SAID PLAINLY: a Discord ban that predates this feature, or
 * that has aged out of the audit log's forty-five day retention, is never
 * backfilled. That is a one-off migration with a decision attached — who is it
 * attributed to? — and not something a boot path should do quietly.
 *
 * OLDEST FIRST, ACROSS ALL THREE ACTIONS TOGETHER. Snowflakes sort by time, so
 * sorting the merged list by id replays a ban-then-unban in the order it
 * happened. Replaying it backwards would leave somebody banned who is not.
 *
 * SEQUENTIALLY, NOT IN PARALLEL. Two entries about the same person are exactly
 * the case where order matters, and a `Promise.all` over `mirrorEntry` would
 * race them against each other over one DynamoDB row.
 *
 * KICKS REPLAY AND DELIVER NOTHING. Every entry here is old by construction, so
 * `relayKick`'s staleness check drops them without a request — the owner's rule
 * about a kick queued at 21:00 arriving at 21:40, applied to one queued last
 * Tuesday.
 *
 * THE CURSOR ONLY MOVES ON A CLEAN PASS. A replay that failed halfway has to be
 * repeated, and repeating it is free because every write it makes is idempotent.
 * Moving the cursor over an entry we could not act on would turn a transient
 * DynamoDB failure into a ban that is never mirrored at all.
 */
export async function reconcileModeration(
  read: AuditReader,
  state: Pick<Ddb['botState'], 'get' | 'put'>,
  deps: MirrorDeps,
): Promise<void> {
  const cursor = await state.get(AUDIT_CURSOR_KEY)

  if (!cursor.ok) {
    log('warn', 'could not read the audit cursor, so nothing was replayed', {
      failure: cursor.failure.kind,
      detail: cursor.failure.message,
    })
    return
  }

  /**
   * NULL ON THE FIRST EVER BOOT, AND THAT REPLAYS THE MOST RECENT WINDOW RATHER
   * THAN NOTHING. Same argument as the replay itself: the guild's recent bans
   * are decisions the game has not been told about, and the policy says a
   * Discord ban is a game ban. Bounded by `RECONCILE_LIMIT` like every other
   * pass, and idempotent, so the cost of being wrong about it is a few DynamoDB
   * reads once.
   */
  const after = cursor.value?.value ?? null

  const pages = await Promise.all(
    (['ban', 'unban', 'kick'] as const).map(async (action) => {
      try {
        return await read(action, after)
      } catch (error) {
        // One action failing must not lose the other two silently. A missing
        // View Audit Log permission fails all three and says so three times,
        // which is the right number of times for a permission the whole feature
        // depends on.
        log('warn', 'could not read the audit log', { action, error })
        return null
      }
    }),
  )

  if (pages.some((page) => page === null)) {
    log('warn', 'the audit log could not be read in full, so nothing was replayed', { after })
    return
  }

  const entries = pages
    .flatMap((page) => page ?? [])
    // Oldest first. Snowflakes are time-ordered, and comparing them as BigInt
    // rather than as numbers is what keeps that true past 2^53.
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))

  if (entries.length === 0) {
    log('info', 'nothing to replay from the audit log', { after })
    return
  }

  log('info', 'replaying moderation missed while the bot was down', {
    entries: entries.length,
    after,
  })

  for (const entry of entries) {
    const result = await mirrorEntry(entry, deps)
    if (result.did === 'failed') {
      log('warn', 'the audit replay stopped on a failure and the cursor was not moved', {
        entry: entry.id,
        step: result.step,
      })
      return
    }
  }

  // `entries` is non-empty and sorted, so the last element is the newest.
  const newest = entries[entries.length - 1]?.id
  if (newest === undefined) return

  const stored = await state.put(AUDIT_CURSOR_KEY, newest)
  if (!stored.ok) {
    // The replay itself succeeded; only the bookmark did not. The next boot
    // replays the same window again, which is idempotent and cheap.
    log('warn', 'the audit replay finished but its cursor could not be saved', {
      newest,
      failure: stored.failure.kind,
      detail: stored.failure.message,
    })
  }
}

/**
 * Wire the mirror onto the gateway.
 *
 * TWO LISTENERS: the live event, and the boot replay. Both go through
 * `mirrorEntry`, which is what makes a replayed ban and a live one the same code
 * path rather than two implementations that can disagree.
 *
 * THE GUILD IS CHECKED ON EVERY EVENT. This bot is only ever in one guild, but
 * "only ever" is a fact about today's invite list and not a property of the
 * process — and an audit entry from somewhere else would be somebody else's
 * moderation written into this community's ban table.
 *
 * THE LISTENER IS SYNCHRONOUS AND HANDLES ITS OWN PROMISE, for the reason
 * `onMessage` above does: an async function handed to an EventEmitter has
 * nowhere to reject to, and becomes an unhandled rejection several ticks later
 * attached to no event.
 */
export function installBanMirror(
  client: Client,
  config: Config,
  ddb: Ddb,
  /**
   * THE RELAY IS BUILT HERE AND IS NULL WITHOUT A SECRET, which is the one switch
   * that turns the live kick off. Everything else about the mirror keeps working:
   * the ban row is written, the lift is written, the role comes off. The bot must
   * never depend on the console being up, and this is where that rule is spelled
   * as a value.
   */
  relay: Ringmaster | null = config.commandSecret === null
    ? null
    : createRingmaster({ baseUrl: config.ringmasterUrl, secret: config.commandSecret }),
): void {
  const deps = (): MirrorDeps => ({
    selfId: client.user?.id ?? null,
    ddb,
    kick: relay,
    untag: roleTaker(client, config.guildId, config.gameBanRoleId),
  })

  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    if (guild.id !== config.guildId) return

    const moderation = moderationEntry(entry)
    if (moderation === null) return

    void mirrorEntry(moderation, deps()).catch((error: unknown) => {
      // `mirrorEntry` is written not to throw; this is the guarantee that it
      // did, rather than a path anything is expected to take.
      log('error', 'the moderation mirror threw', { entry: entry.id, error })
    })
  })

  client.once(Events.ClientReady, (ready) => {
    const guild = ready.guilds.cache.get(config.guildId)
    // The guild check in `createClient` has already halted moderation and said
    // why; there is nothing to add and no audit log worth reading.
    if (guild === undefined) return

    void reconcileModeration(auditReader(guild), ddb.botState, deps()).catch((error: unknown) => {
      // A replay that came apart is a warn and not a stop. The live listener is
      // already armed and the bot is moderating; what is lost is the catch-up.
      log('warn', 'the moderation replay failed', { error })
    })
  })
}
