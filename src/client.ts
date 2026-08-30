import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Partials,
  RESTJSONErrorCodes,
  type APIEmbed,
  type SendableChannels,
} from 'discord.js'

import type { Config } from './config.ts'
import { createDdb } from './ddb.ts'
import { scanMessage, type InviteResolver, type ScanResult } from './invites.ts'
import { log, type Fault, type Sink } from './log.ts'
import { watchMaintenance } from './maintenance.ts'
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
 * THE BOT NEVER TALKS TO MEMBERS. No DM, no reply, no "your message was
 * removed". A removal is a journal line and, if `BLITZ_LOG_CHANNEL_ID` is set,
 * one factual line in a channel admins read. That is a standing instruction
 * from the owner, not an oversight to be helpfully filled in later.
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
 * Why a message is being removed. Two grounds, and they are not the same kind
 * of statement, so nothing downstream may present them as one.
 *
 * `foreign-invite` is evidence about a specific invite: a code was resolved, and
 * the guild it points at is not ours.
 *
 * `over-lookup-cap` is the opposite — it says we do NOT know what the codes past
 * the cap were, and that is precisely why it is grounds to act. An admin reading
 * the log has to be able to tell the two apart, because only the first one names
 * an invite that was actually confirmed.
 */
export type DeleteReason = 'foreign-invite' | 'over-lookup-cap'

/**
 * What the two removing verdicts carry.
 *
 * `found` IS THE COUNT OF DISTINCT CODES IN THE MESSAGE, not the length of
 * `foreign`. It is the only evidence an `over-lookup-cap` removal has: `foreign`
 * is empty on one of those whenever the codes that would have filled it are the
 * ones that fell past the cap, which is the whole shape of the attack.
 */
interface Removal {
  why: DeleteReason
  found: number
  foreign: string[]
  unresolved: string[]
}

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

  const result = await scanMessage(message.text, config.guildId, resolve)

  // A confirmed foreign guild is tested first because it is the better-evidenced
  // of the two grounds: it names an invite Discord actually answered for. Both
  // can be true of one message, and that is the one worth putting in the log.
  if (result.foreign.length > 0) return removal('foreign-invite', result, config)

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
  if (result.truncated) return removal('over-lookup-cap', result, config)

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
function removal(why: DeleteReason, result: ScanResult, config: Config): Verdict {
  const grounds = {
    why,
    found: result.codes.length,
    foreign: result.foreign,
    unresolved: result.unresolved,
  }

  return config.dryRun ? { action: 'would-delete', ...grounds } : { action: 'delete', ...grounds }
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
}

/**
 * The fields every removal line carries, so the journal and the channel post
 * can be matched up by grepping one token.
 *
 * `codes` STAYS THE CONFIRMED-FOREIGN LIST ON BOTH REASONS, and is empty on the
 * over-cap removal that confirmed nothing. Filling it with the codes we did not
 * look at would put unexamined strings in the field the other line uses for
 * established ones — `found` and `reason` are what carry that case.
 */
function logFields(verdict: Removal): Record<string, unknown> {
  return { reason: verdict.why, found: verdict.found, codes: verdict.foreign.join(',') }
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
 */
function statedGrounds(verdict: Removal): string {
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

  await handleMessage(snapshot(full, authorId, selfId), config, {
    resolve: actions.resolve,
    fetchRoles: memberRoles(full),
    remove: remover(full, config),
    announce: actions.announce,
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
     * `GuildMembers` IS DELIBERATELY ABSENT, AND THE ADMIN EXEMPTION DOES NOT
     * NEED IT. A `messageCreate` payload carries the author's member object
     * OPPORTUNISTICALLY — often, not always — and this comment used to claim it
     * always did, which is how "no member, so skip the message" came to be the
     * shipped default. The rule is now "no member, so fetch one" (`memberRoles`,
     * one cached REST call per uncached author) and "fetch failed, so scan", so
     * the missing intent costs at most a lookup and never a bypass.
     *
     * IT STAYS ABSENT FOR A REASON BEYOND TIDINESS. This application's
     * credentials are shared with the Ringmaster console, and its grant is
     * already wider than that console's own docs describe. Adding a second
     * privileged intent widens it again, for every consumer of the token, to
     * save one REST call.
     */
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
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
     * NOTHING THIS BOT SENDS CAN EVER PING ANYONE. Set on the client so the
     * guarantee holds for whatever gets added later without depending on
     * somebody remembering. The log line carries an invite code chosen by a
     * stranger and, since the author became a mention, `<@id>` on purpose —
     * this makes the question moot instead of making it a thing to reason
     * about.
     *
     * THE ONE SEND THAT EXISTS TODAY REPEATS IT ANYWAY. This is a default, and
     * a default is silently replaced by any call that passes `allowedMentions`
     * of its own; `announcer` states the suppression at its own `send` because
     * that call deliberately contains a mention, and because a default set here
     * cannot be asserted on there.
     */
    allowedMentions: { parse: [], repliedUser: false },
  })

  const resolve = inviteResolver((code) => client.fetchInvite(code))
  const post = config.logChannelId === null ? null : announcer(client, config.logChannelId)
  const actions: LiveActions = { resolve, announce: post }

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
   */
  if (config.docsChannelId !== null) {
    syncDocsChannel(client, config.docsChannelId)
  }

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
 * replaces. This is now the one call in the bot that puts a mention in a
 * message ON PURPOSE, so the suppression belongs next to it, where a reader of
 * this function can see it and a test can assert on the options that were
 * actually handed to `send`.
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
  return async (line) => {
    const channel = await client.channels.fetch(channelId)

    // A wrong id, a deleted channel, or a channel the bot cannot send in. Worth
    // one line each time rather than a silent return: an operator who set
    // BLITZ_LOG_CHANNEL_ID and sees nothing in the channel needs to be told
    // which of the two halves is broken.
    if (channel === null || !channel.isSendable()) {
      log('error', 'log channel is missing or cannot be posted to', { channel: channelId })
      return
    }

    await channel.send({ content: line, allowedMentions: { parse: [] } })
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
  const early: { level: Fault; msg: string; line: string }[] = []

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
  function enqueue(level: Fault, msg: string, line: string): Promise<void> {
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

  await post(`running commit ${deployed}`)

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
 * THE SAME MENTION SUPPRESSION `announcer` STATES AT ITS OWN SEND. The content
 * here is a hex sha and cannot carry a mention, and the guarantee is still made
 * at the call rather than left to the client-wide default, because that default
 * is silently replaced by any send that passes an `allowedMentions` of its own
 * and a reader of this function cannot see it.
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
 * ONE EMBED PER TOP-LEVEL HEADING, IN FILE ORDER. The owner's decision. An
 * embed's description holds 4096 characters against a plain message's 2000, and
 * a section per message is what makes a change to one section a change to one
 * message.
 *
 * MATCHED BY HEADING, NEVER BY POSITION, AND THAT IS THE WHOLE DESIGN. Matching
 * the n-th section to the n-th message is one line shorter and it means that
 * inserting a section near the top rewrites every message below it on the next
 * restart. In a project this careful about audit trails, a bot silently
 * rewriting its own history is a worse failure than a stale paragraph. So the
 * embed title IS the key: section three growing edits section three's message
 * and touches nothing else.
 *
 * THE CHANNEL IS THE STATE, AND THERE IS NO LOCAL RECORD OF WHAT WAS POSTED.
 * A file saying "section four is message 123" is a claim about a channel any
 * admin can edit with a right-click, and the moment somebody deletes a message
 * by hand that claim is a lie which makes the bot skip the section forever. So
 * every start reads the channel back and derives everything from what is
 * actually there — which is also what makes a partially failed run reconcile
 * instead of duplicating.
 *
 * AN IDENTICAL MANUAL IS COMPLETELY SILENT. No post, no edit, no info line.
 * This process restarts on every deploy and on every crash, and a channel that
 * stirs each time is a channel nobody reads — the same argument the deploy
 * notice above is built around.
 *
 * AND THE PRICE OF THAT DESIGN, WHICH IS THE THING THE REST OF THIS HALF IS
 * SHAPED BY: the file is authoritative and the channel is the state, so ANY
 * misreading of the file becomes DELETIONS from the channel. An unclosed code
 * fence, a file that arrived empty, a read that stopped at its own limit — each
 * of those is a parse or a transport fault, and each of them used to come out
 * the far end as "these sections are no longer in the file", said about
 * sections that were still in it. The file cannot be trusted to be well formed
 * and the channel cannot be recovered from a git history, so the two are not
 * symmetrical: a run that is about to remove a large share of the channel is
 * far more likely to be this bot misreading a document than a human deleting
 * most of one. `syncManual` refuses the whole destructive half when that
 * happens, says so at error, and leaves the channel exactly as it found it.
 * Every individual guard below — the empty parse, the unclosed fence, the
 * truncated read — is a second line of defence in front of that one, not a
 * replacement for it.
 *
 * A SECTION THAT CANNOT BE PUBLISHED IS MARKED IN THE CHANNEL, AND THE MARK IS
 * THE MEMORY. There is no local record of anything here by design, so the only
 * thing that survives a restart is what is in the channel — which means a
 * refusal reported at error on every start is a refusal reported forever. A
 * section this bot cannot carry (too long for an embed, or refused outright by
 * Discord) therefore has its message stamped with `STALE_FOOTER`, so a reader
 * of the channel is told that message is not the file, and so the next start
 * can see it has already said so and stay quiet. See `unpublishable`.
 *
 * NOTHING HERE MAY DELAY OR BREAK MODERATION. Every failure in this half is
 * caught, written down and dropped; a missing manual is one warn and the bot
 * carries on scanning. Documentation is the least important thing this process
 * does.
 */

/** One top-level section of the manual: the heading, and the text under it. */
export interface ManualSection {
  /** The heading text without its `#`. Becomes the embed title, and the key. */
  readonly heading: string

  /** Everything until the next top-level heading. Becomes the description. */
  readonly body: string
}

/**
 * One of the bot's messages already in the channel, reduced to what matching
 * needs: which section it is, and what it currently says.
 *
 * `description` IS THE STORED STRING AND NOT A RENDERED VIEW. The comparison
 * that decides whether anything is sent is a plain `===` between this and the
 * file's body, so it has to be the same kind of string at both ends — what
 * Discord gave back for `embed.description`, verbatim. Comparing anything that
 * had been through a renderer would make every start a diff of two formattings
 * and every restart a channel full of edits.
 */
export interface PostedSection {
  readonly id: string
  readonly title: string
  readonly description: string

  /**
   * The embed's footer, verbatim, and never part of the comparison.
   *
   * IT IS READ BACK BECAUSE IT IS THE ONLY DURABLE MEMORY THIS FEATURE HAS.
   * Nothing about the channel is written down anywhere else — that is the whole
   * design — so a fault reported at start-up is a fault reported on every
   * start-up unless the channel itself is carrying the fact that it was already
   * said. A section this bot could not publish is stamped with `STALE_FOOTER`,
   * and reading that stamp back is what makes the second report silent. See
   * `unpublishable`.
   */
  readonly footer: string
}

/**
 * What one read of the channel says: the bot's sections oldest first, and
 * whether that is the whole channel or only as much of it as one request
 * carries.
 *
 * `complete` IS NOT A DETAIL OF THE TRANSPORT, IT IS THE VALIDITY OF EVERYTHING
 * BELOW. Every decision here is derived from what the read came back with: a
 * section whose message is not in it looks deleted by hand and is posted again,
 * and a message no section claims looks removed from the file and is deleted.
 * A read that stopped at its own limit is therefore not a smaller answer to the
 * same question — it is a confident wrong answer to it, and the only safe thing
 * to do with one is nothing at all.
 */
export interface ChannelRead {
  readonly sections: PostedSection[]
  readonly complete: boolean
}

/** One section as it goes out: the embed's three fields and nothing else. */
export interface ManualEmbed {
  readonly title: string
  readonly description: string
  readonly footer: string
}

/**
 * The channel, as the four operations this needs.
 *
 * STRUCTURAL, FOR THE REASON EVERY OTHER BOUNDARY IN THIS FILE IS. The hard
 * part here is the reconciliation — a hand-deleted message, a half-finished
 * run, two sections under one heading — and every one of those is worth
 * exercising against a fake built three lines above the assertion rather than
 * against a live channel that would have to be vandalised on purpose.
 */
export interface DocsChannel {
  /** The bot's own manual messages, and whether that is all of them. Rejects if unreadable. */
  readonly read: () => Promise<ChannelRead>

  readonly post: (embed: ManualEmbed) => Promise<void>
  readonly edit: (id: string, embed: ManualEmbed) => Promise<void>
  readonly remove: (id: string) => Promise<void>
}

/**
 * Discord's own limits on one embed, and on a message's embeds together.
 *
 * COUNTED IN UTF-16 CODE UNITS, WHICH IS WHAT DISCORD COUNTS. See `fitEmbed`.
 */
const EMBED_TITLE_CAP = 256
const EMBED_DESCRIPTION_CAP = 4096
const EMBED_TOTAL_CAP = 6000

/**
 * The footer on a message this bot could not bring into agreement with the
 * file, and the one piece of state it keeps anywhere but in its own source.
 *
 * WHAT A READER OF THE CHANNEL SHOULD SEE. A section that is too long for an
 * embed, or that Discord refuses outright, leaves the previous version of that
 * section standing — which is the right call, because a truncated section reads
 * like the whole of it. What is NOT right is leaving it standing with nothing
 * to say so: the channel's entire claim is that it says what the file says, and
 * a message that quietly does not is the exact drift this feature exists to
 * make visible. So the message keeps its text and its footer says the text is
 * not current.
 *
 * IT REPLACES THE `updated` STAMP RATHER THAN SITTING BESIDE IT, because the
 * stamp is a claim about when this message last matched the file and that claim
 * is now false. The date is recoverable from the file's history, which is where
 * a record of a change belongs.
 *
 * AND IT IS THE MEMORY. `unpublishable` reports a refusal only when it puts
 * this mark up, so the second start finds the mark already there and says
 * nothing. Without it the same error is written to the journal and posted to
 * the status channel on every restart, forever, for a document nobody can fix
 * from Discord — a slow flood in the one channel that has to stay readable.
 *
 * A SECTION THAT COMES BACK UNDER THE LIMITS IS WRITTEN AND STAMPED AGAIN LIKE
 * ANY OTHER CHANGE, which is what clears this. `syncManual` therefore treats a
 * marked message as different from the file even when the description matches
 * — see the comparison there.
 */
const STALE_FOOTER = 'out of date: this section could not be published'

/**
 * The shortest gap between two writes to the docs channel.
 *
 * A FIRST RUN ON A TEN-SECTION MANUAL IS TEN POSTS, and a rewritten one is ten
 * edits. Fired together that is a burst straight into Discord's per-channel
 * limit, at the one moment the bot has just started and has a gateway session
 * worth keeping. The writes are already serialised — every one is awaited
 * before the next is built — and this spaces them as well, which costs a
 * ten-second start on the rare run that changes everything and nothing at all
 * on the ordinary run that changes nothing.
 */
const DOCS_WRITE_GAP_MS = 1000

/**
 * How many messages are read back from the channel.
 *
 * DISCORD'S OWN PER-REQUEST MAXIMUM, and one request is deliberately the whole
 * of it. A manual with more than a hundred top-level headings is not a manual,
 * and paginating would mean a bot that walks a channel's entire history on
 * every start.
 *
 * A READ THAT CAME BACK FULL IS A READ THAT STOPPED HERE, AND THAT USED TO BE
 * SILENT — which made this constant the ugliest bug in the feature. Discord
 * answers newest-first, so the messages that fell off the end were the OLDEST:
 * the first sections of the manual looked as though somebody had deleted them
 * by hand, were posted again at the bottom of the channel, and the channel grew
 * by one duplicate per section on every single restart, unbounded, while the
 * sections at the top were deleted as "no longer in the file". So the read now
 * says whether it saw the whole channel (`ChannelRead`) and a truncated one
 * stops the run, and a manual with more sections than one read can cover is
 * refused before anything is written rather than posted into that state.
 */
const DOCS_FETCH_LIMIT = 100

/**
 * How much of the channel one run may delete before the run is treated as a
 * fault rather than as an edit somebody made.
 *
 * THE THRESHOLD IS A JUDGEMENT AND HERE IS THE JUDGEMENT. Deleting sections is
 * the only irreversible thing this feature does, and every way it has gone
 * wrong — an unclosed fence truncating the parse, an empty file, a read that
 * stopped at its limit — arrives here looking exactly like "the author removed
 * most of the manual". The two are not equally likely: a person removing one or
 * two sections is an ordinary edit and happens; a person removing most of the
 * document in one commit and restarting the bot is not, and when it does happen
 * the cost of making them restart the bot a second time after emptying the
 * channel by hand is a minute. The cost of guessing the other way is a
 * documentation channel deleted by a parser bug.
 *
 * SO: UP TO `DOCS_DELETE_FLOOR` DELETIONS ALWAYS GO THROUGH, whatever share of
 * the channel they are — that is what keeps a two-section manual losing a
 * section from needing anybody's attention — and above that floor a run may
 * remove at most `DOCS_DELETE_SHARE` of what it found. Half is chosen because
 * it is the point where "most of it" starts being true; the exact number
 * matters far less than that there is one, since the fault cases are all at or
 * near a hundred per cent.
 */
const DOCS_DELETE_FLOOR = 2
const DOCS_DELETE_SHARE = 0.5

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
 * make a missing file delete every section in the channel, which is the worst
 * possible reading of a file that is not there.
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

/**
 * A top-level heading: one `#`, whitespace, then something. `##` is body.
 *
 * WHAT A HEADING MAY CONTAIN, DECIDED: one line of plain text. It is not a
 * paragraph of markdown, because it does not become one — it becomes an embed
 * TITLE, and Discord renders nothing in a title. `**Never do this**` in the
 * file is the four asterisks, shown, in the channel. It is also the key the
 * whole reconciliation turns on, so it is the one string in the document whose
 * exact bytes matter; see `HEADING_MARKUP` for what is said about markdown that
 * gets in anyway, and docs/bot-manual.md, which states the rule for the people
 * who write the file.
 *
 * A TRAILING RUN OF `#` IS A CLOSING SEQUENCE AND IS DROPPED. `# Heading #` is
 * one heading called "Heading" to every markdown renderer there is, and it used
 * to be one called "Heading #" here — which is a different key, so the section
 * matched no message, was posted as a new one, and the message it should have
 * matched was deleted as no longer being in the file. The closing run has to be
 * separated by whitespace, exactly as the rest of markdown has it, so a heading
 * that ends in a real `#` — `C#` — keeps it.
 *
 * THE `#` IS IN THE FIRST COLUMN OR IT IS NOT A HEADING. CommonMark allows up
 * to three spaces in front of one and this deliberately does not: an indented
 * `#` in a document like this one is far more often a line of an example than a
 * section of the manual, and the cost of the two mistakes is not the same —
 * missing a heading leaves a paragraph in the section above it, inventing one
 * cuts a section in half and posts the half as a message of its own.
 * docs/bot-manual.md states the rule for the people writing the file.
 */
const TOP_LEVEL_HEADING = /^#\s+(\S.*?)(?:\s+#+)?\s*$/u

/**
 * Inline markdown that got into a heading.
 *
 * SAID, NOT STRIPPED AND NOT REFUSED. Stripping would silently change the key
 * this file matches on — the one thing a heading may not do — and refusing the
 * section would take a whole page of documentation out of the channel over a
 * pair of asterisks. So the section is published exactly as written, the
 * asterisks show up in the title, and there is one line in the journal saying
 * why it looks like that.
 *
 * PAIRS ONLY, AND `_` IS DELIBERATELY NOT HERE. Discord does not italicise an
 * underscore inside a word, and this repo's headings are full of variable names
 * like BLITZ_LOG_CHANNEL_ID; a pattern that warned about those would be a
 * warning nobody could act on and everybody would learn to ignore.
 */
const HEADING_MARKUP = /\*[^*\n]+\*|`[^`\n]+`|~~[^~\n]+~~|\|\|[^|\n]+\|\||\[[^\]\n]+\]\([^)\n]+\)/u

/** A fenced code block opening or closing. */
const CODE_FENCE = /^\s*(?:```|~~~)/u

/**
 * Split the manual into its top-level sections, in file order, or answer none
 * because the file cannot be split at all.
 *
 * FENCES ARE TRACKED, AND THAT IS NOT FUSSINESS. A shell example in the manual
 * carries `# comment` lines, and a parser that did not know it was inside a
 * fence would cut the section in half there and post a "comment" section — a
 * document that silently loses its shape because somebody documented a command.
 *
 * A FENCE THAT NEVER CLOSES IS A FILE THIS CANNOT READ, AND THAT WAS THE WORST
 * BUG IN THE FEATURE. One unbalanced ``` swallows every line after it into
 * whichever section it opened in: the sections below it stop existing as far as
 * the parse is concerned, and the channel is the state, so "stop existing" came
 * out of the far end as a DELETE of each of their messages, logged as "no
 * longer in the file" about text that was still in the file, one line above the
 * fence. Nothing about that is recoverable from the channel. So the answer is
 * no sections at all, which `syncManual` refuses to act on, and one error line
 * naming the line the fence was opened on — the fix is a keystroke once you
 * know where to put it.
 *
 * NO SECTIONS IS ALSO THE ANSWER FOR A FILE WITH NO HEADINGS IN IT, and the two
 * are the same answer on purpose: both mean "there is nothing here that can be
 * published", and `syncManual` treats that as a reason to leave the channel
 * alone rather than as an instruction to empty it. The difference between them
 * is in the log line, not in what happens next.
 *
 * TEXT BEFORE THE FIRST HEADING BELONGS TO NO SECTION AND IS NOT POSTED. It
 * gets a warn rather than being dropped silently, because the whole promise of
 * this feature is that the channel and the file agree: a preamble that vanished
 * quietly would be exactly the drift this exists to make visible.
 */
export function parseManual(markdown: string): ManualSection[] {
  const sections: ManualSection[] = []

  let heading: string | null = null
  let body: string[] = []
  let orphaned = 0

  // The line an unclosed fence was opened on, or 0 while none is open. A line
  // number rather than a boolean because it is the only thing the operator
  // needs in order to fix the file.
  let fenced = 0

  const finish = (): void => {
    // `trim` so that the blank line every writer leaves under a heading, and the
    // one before the next, are not part of the text being compared. Without it,
    // reformatting the file's whitespace would rewrite the whole channel.
    if (heading !== null) sections.push({ heading, body: body.join('\n').trim() })
  }

  for (const [index, raw] of markdown.split(/\r?\n/u).entries()) {
    if (CODE_FENCE.test(raw)) fenced = fenced === 0 ? index + 1 : 0

    const found = fenced !== 0 ? null : TOP_LEVEL_HEADING.exec(raw)

    if (found !== null) {
      finish()
      // The capture cannot be absent — the pattern has one group and it matched
      // — but `noUncheckedIndexedAccess` does not know that, and an assertion
      // here would be the one place in this file that outranks the compiler.
      heading = found[1] ?? ''
      body = []

      if (HEADING_MARKUP.test(heading)) {
        log('warn', 'a manual heading carries markdown, which an embed title shows literally', {
          heading: named(heading),
        })
      }

      continue
    }

    if (heading === null) {
      if (raw.trim() !== '') orphaned += 1
      continue
    }

    body.push(raw)
  }

  if (fenced !== 0) {
    log(
      'error',
      'the manual has a code fence that is never closed, so it cannot be split into sections',
      { line: fenced },
    )

    return []
  }

  finish()

  if (orphaned > 0) {
    log('warn', 'the manual has text above its first heading, which is in no section and was not posted', {
      lines: orphaned,
    })
  }

  return sections
}

/**
 * What one write to the channel is. A `Record` per outcome below, so a fourth
 * kind of change is a compile error rather than an `undefined` in a log line.
 */
type Change = 'post' | 'edit' | 'delete' | 'mark'

const CHANGED: Record<Change, string> = {
  post: 'posted a manual section',
  edit: 'updated a manual section',
  delete: 'deleted a manual section that is no longer in the file',
  mark: 'marked a manual section in the channel as one that could not be published',
}

const CHANGE_FAILED: Record<Change, string> = {
  post: 'could not post a manual section',
  edit: 'could not update a manual section',
  delete: 'could not delete a manual section that is no longer in the file',
  mark: 'could not mark a manual section in the channel as one that could not be published',
}

/**
 * The error from a write Discord refused because of what was IN it.
 *
 * ANSWERED RATHER THAN LOGGED, which is the whole point of the type. `apply`
 * knows a write failed and nothing else; only the caller knows whether the
 * channel is already carrying a mark that says this, and therefore whether
 * saying it again is a report or a flood. See `unpublishable`.
 */
interface Refused {
  readonly error: unknown
}

/**
 * Whether a failed write means this content will never be accepted.
 *
 * 50035 IS "INVALID FORM BODY" AND IT IS A STATEMENT ABOUT THE PAYLOAD, not
 * about the channel or about the moment. Retrying it with the same bytes fails
 * the same way, so it belongs with the too-long section rather than with the
 * rate limits and the 500s — and it used to be treated as transient, which
 * meant one warn per refused section on every restart of a process that
 * restarts on every crash. That is a slow flood into the one channel that has
 * to stay readable, and it is the reason `permanentlyUnusable` is not the only
 * question `apply` asks.
 *
 * IT DOES NOT LATCH THE CHANNEL OFF, and that is the difference from
 * `permanentlyUnusable`. The channel is fine; one section is not. Every other
 * section still goes out.
 */
function contentRefused(error: unknown): boolean {
  if (!(error instanceof DiscordAPIError)) return false

  return error.code === RESTJSONErrorCodes.InvalidFormBodyOrContentType
}

/**
 * Bring the channel into agreement with the file.
 *
 * THE ONLY WRITES ARE THE DIFFERENCES. A section whose stored description
 * already equals the file's body is not touched and not mentioned; see the
 * header above for why a quiet restart is the point of the whole feature.
 *
 * POSTS GO OUT IN FILE ORDER, AND A MESSAGE CANNOT BE MOVED. Discord orders a
 * channel by when things were said, so a section appended to the file appears
 * at the bottom of the channel where it belongs, and a section inserted into
 * the MIDDLE of the file appears at the bottom too. The alternative is deleting
 * and reposting everything below the insertion — ten messages rewritten to move
 * one, in a channel whose value is that it changes only when the docs change.
 * One post, in the wrong place, is the cheaper wrong.
 *
 * DELETIONS COME LAST, so a run that fails part way leaves a stale extra
 * message rather than a hole. The next start removes the extra; a hole would
 * have to be reposted, and it would come back at the bottom of the channel.
 *
 * A SECTION DELETED FROM THE FILE HAS ITS MESSAGE DELETED, rather than being
 * edited to say it was removed. A tombstone is text nobody asked for, it stays
 * forever because nothing ever clears it, and after a year the channel is
 * mostly tombstones. What the docs used to say is in the file's history, which
 * is where a record of a change belongs.
 *
 * AND EVERY ONE OF THOSE DELETIONS IS REFUSED WHEN THERE ARE TOO MANY OF THEM.
 * See `DOCS_DELETE_FLOOR` for the threshold and the argument; see the header of
 * this half for why the three bugs that reached it were all parse faults
 * wearing a deletion's clothes. The refusal is of the destructive half only:
 * the posts and the edits above it have already happened and are recoverable
 * from the file on the next start, and a deleted message is not.
 *
 * NOTHING IS EVEN READ FOR A MANUAL THAT PARSED TO NOTHING. An empty file, a
 * file with no top-level headings and a file whose code fence never closes all
 * arrive here as no sections at all, and "no sections" is the one input for
 * which the correct behaviour is not "make the channel look like that" but
 * "leave the channel alone and say so". `readManual` has always guarded the
 * MISSING file for exactly this reason; the empty one reached the delete loop
 * and took the whole channel with it.
 */
export async function syncManual(
  sections: readonly ManualSection[],
  channel: DocsChannel,
  pause: () => Promise<void> = () => sleep(DOCS_WRITE_GAP_MS),
): Promise<void> {
  if (sections.length === 0) {
    log('error', 'the manual has no sections at all, so the docs channel was left alone')
    return
  }

  // More sections than one read of the channel can carry means the channel can
  // never be read back correctly again — see DOCS_FETCH_LIMIT for what that did
  // — so this is refused before the first of them is posted rather than after
  // the hundredth.
  if (sections.length >= DOCS_FETCH_LIMIT) {
    log('error', 'the manual has more sections than one read of the channel can carry, so it was left alone', {
      sections: sections.length,
      limit: DOCS_FETCH_LIMIT,
    })

    return
  }

  let state: ChannelRead

  try {
    state = await channel.read()
  } catch (error) {
    // ONE LINE, THEN NOTHING, like `statusReporter` latching off. A wrong id, a
    // channel that was deleted, a missing permission: none of them gets better
    // by being asked again, and the fix is a variable and a restart either way.
    log('error', 'docs channel unusable, the manual was not synchronised', { error })
    return
  }

  if (!state.complete) {
    log('error', 'the docs channel holds more messages than one read can carry, so it was left alone', {
      limit: DOCS_FETCH_LIMIT,
    })

    return
  }

  const posted = state.sections
  const unclaimed = groupByTitle(posted)
  warnAboutSharedHeadings(sections)

  let stopped = false
  let writes = 0

  /**
   * One write, paced, and never allowed to throw past this function.
   *
   * ANSWERS `Refused` FOR A WRITE DISCORD WOULD NEVER ACCEPT and null for
   * everything else, including the failures it has already written down. See
   * `contentRefused`: whether that one is worth a line depends on what the
   * channel is already saying, and this function cannot know that.
   */
  async function apply(
    change: Change,
    heading: string,
    run: () => Promise<void>,
  ): Promise<Refused | null> {
    if (stopped) return null

    // Between writes and never before the first, so a run that changes one
    // section costs no wait at all.
    if (writes > 0) await paced()
    writes += 1

    try {
      await run()
      log('info', CHANGED[change], { heading })
    } catch (error) {
      if (permanentlyUnusable(error)) {
        stopped = true
        log('error', 'docs channel unusable, the rest of the manual was not synchronised', {
          heading,
          error,
        })

        return null
      }

      if (contentRefused(error)) return { error }

      // Transient: rate limited, a 500, a message somebody deleted underneath
      // us. The next start reads the channel back and reconciles whatever this
      // run did not manage, so there is nothing to retry here.
      //
      // AND THEREFORE INFO. The sentence above is the definition of
      // self-healing: nobody has to do anything, and the one section that did
      // not land is published by the next restart. It is documentation, not
      // moderation — the failure that WOULD need a person is a channel this bot
      // cannot write in at all, which is the error line a few lines up.
      log('info', CHANGE_FAILED[change], { heading, error })
    }

    return null
  }

  /**
   * Wait between two writes, and say so if the process goes while we are
   * waiting.
   *
   * THE WAIT IS UNREFFED, WHICH IS RIGHT AND WHICH MADE THE ABANDONMENT
   * SILENT. `sleep` deliberately does not hold the process open for a
   * documentation edit, so a `systemctl stop` in the middle of a ten-section
   * first run takes the remaining nine writes with it — and used to take them
   * without a single line anywhere, leaving a half-published channel and no
   * record of why. The next start does finish the job, and somebody reading the
   * journal after a restart still has to be able to see that this one did not.
   *
   * `exit` AND NOT `beforeExit`, because index.ts calls `process.exit` from its
   * signal handler once the gateway is closed, and `beforeExit` does not fire
   * on that path at all — which is the only path a `systemctl restart` takes.
   * `log()` is synchronous and writes to the journal first, so the line lands
   * even though nothing async can run any more; the copy in the status channel
   * is lost with the process, which is the same trade the whole sink makes.
   */
  async function paced(): Promise<void> {
    const abandoned = (): void => {
      // INFO, AND THE COMMENT ABOVE IS THE ARGUMENT FOR IT: this is what
      // `systemctl restart` looks like from inside a documentation sync, the
      // next start finishes the job, and the line exists for somebody reading
      // the journal after a restart and wondering why the channel is half
      // written. Nobody has to do anything. It could not have reached the
      // status channel in any case — the process is on its way out.
      log('info', 'the process is going down between two manual writes, the rest of the manual was not synchronised', {
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

  /**
   * Say once that a section is not being published, and leave the channel
   * saying it too.
   *
   * THE MARK IS THE REPORT'S MEMORY, so the two happen together or not at all:
   * a start that finds the mark already up says nothing and writes nothing, and
   * a start that puts it up says exactly one line. Reporting without marking is
   * the flood this replaces — the same error every restart, forever, about a
   * document that can only be fixed in the repository.
   *
   * A HEADING DISCORD WILL NOT TAKE HAS NOWHERE TO PUT THE MARK. No message can
   * exist under a title over the limit, so there is nothing to stamp and
   * nothing to read back, and the line is written on every start instead. That
   * is the honest answer rather than a worse one: the alternative is silence
   * about a section that is not in the channel at all.
   */
  async function unpublishable(
    section: ManualSection,
    existing: PostedSection | undefined,
    refusal: Unpublishable,
  ): Promise<void> {
    if (!refusal.markable) {
      log('error', refusal.why, refusal.fields)
      return
    }

    if (existing?.footer === STALE_FOOTER) return

    log('error', refusal.why, refusal.fields)

    // The existing message keeps its own text: it is the last version that
    // Discord accepted, and replacing it with a shortened copy of the one that
    // did not is the truncation this feature refuses to do. A section that has
    // never been posted gets a message with its heading and nothing under it,
    // so the channel still has one message per heading and a reader can see
    // which section is missing rather than being left to notice the absence.
    const mark: ManualEmbed =
      existing === undefined
        ? { title: section.heading, description: '', footer: STALE_FOOTER }
        : { title: existing.title, description: existing.description, footer: STALE_FOOTER }

    const refused = await apply('mark', section.heading, () =>
      existing === undefined ? channel.post(mark) : channel.edit(existing.id, mark),
    )

    // Refused in turn — the heading is fine by our arithmetic and Discord
    // disagrees about something else in it. One line, and no third attempt.
    if (refused !== null) {
      log('warn', CHANGE_FAILED.mark, { heading: named(section.heading), error: refused.error })
    }
  }

  for (const section of sections) {
    /**
     * THE MATCH. `shift` off the front of the group filed under this heading,
     * so a heading that appears once — every heading, in a well-formed manual —
     * finds its own message wherever in the channel it happens to sit. Two
     * sections sharing a heading take the first and second message under that
     * title in channel order, which is the only thing left to go on once the
     * key is ambiguous; `warnAboutSharedHeadings` says so out loud.
     */
    const existing = unclaimed.get(section.heading)?.shift()
    const fit = fitEmbed(section)

    // Over one of Discord's limits, and deliberately NOT written: any existing
    // message stays as it was rather than being replaced by a truncated copy
    // that reads like the whole section. It is marked instead, so the channel
    // says which of its messages is not the file.
    if (!fit.ok) {
      await unpublishable(section, existing, fit)
      continue
    }

    if (existing === undefined) {
      const refused = await apply('post', section.heading, () => channel.post(fit.embed))
      if (refused !== null) await unpublishable(section, undefined, discordRefused(refused))
      continue
    }

    // THE COMPARISON, and it is a plain string equality on purpose. Both sides
    // are the stored description: what Discord handed back, against what the
    // file says. Anything cleverer here is a source of edits nobody asked for.
    //
    // THE FOOTER IS NOT COMPARED AND IS STILL READ HERE, for one case: a
    // section that was marked unpublishable and has since been brought back
    // under the limits by an edit that restored its previous text. The
    // descriptions match, and the message is still stamped as out of date, so
    // the write that clears the stamp has to happen anyway.
    if (existing.description === section.body && existing.footer !== STALE_FOOTER) continue

    const refused = await apply('edit', section.heading, () => channel.edit(existing.id, fit.embed))
    if (refused !== null) await unpublishable(section, existing, discordRefused(refused))
  }

  // Whatever is left matched no section in the file. That covers a heading
  // removed from the manual and a second copy of a section left behind by a run
  // that failed after posting — the same treatment, because from the channel's
  // side they are the same thing.
  const doomed = [...unclaimed.values()].flat()

  if (doomed.length > DOCS_DELETE_FLOOR && doomed.length > posted.length * DOCS_DELETE_SHARE) {
    log(
      'error',
      'refusing to delete most of the docs channel, which is far more likely a misread manual than an edit; nothing was deleted',
      { deleting: doomed.length, found: posted.length, floor: DOCS_DELETE_FLOOR },
    )

    return
  }

  for (const message of doomed) {
    await apply('delete', message.title, () => channel.remove(message.id))
  }
}

/**
 * The channel's messages filed under their embed title, each group in channel
 * order.
 *
 * A LIST PER TITLE RATHER THAN ONE MESSAGE PER TITLE. Two messages can carry
 * the same title — a manual with a repeated heading, or a duplicate left by a
 * failed run — and a `Map<string, PostedSection>` would silently keep one of
 * them and leave the other in the channel forever with nothing to say so.
 */
function groupByTitle(posted: readonly PostedSection[]): Map<string, PostedSection[]> {
  const groups = new Map<string, PostedSection[]>()

  for (const message of posted) {
    const group = groups.get(message.title)
    if (group === undefined) groups.set(message.title, [message])
    else group.push(message)
  }

  return groups
}

/**
 * Say when the key is not unique.
 *
 * TWO SECTIONS UNDER ONE HEADING ARE HANDLED, NOT REFUSED — they are matched to
 * the first and second message under that title — but the guarantee is weaker
 * there than everywhere else: inserting a third copy shifts the two below it,
 * which is the positional matching this whole design avoids, confined to the
 * ambiguous group. That is worth a line, because the fix is to rename a heading
 * and nobody would think to.
 */
function warnAboutSharedHeadings(sections: readonly ManualSection[]): void {
  const seen = new Set<string>()
  const said = new Set<string>()

  for (const section of sections) {
    if (!seen.has(section.heading)) {
      seen.add(section.heading)
      continue
    }

    if (said.has(section.heading)) continue
    said.add(section.heading)

    log('warn', 'the manual has more than one section under this heading, which are matched by position within it rather than by it', {
      heading: section.heading,
    })
  }
}

/**
 * Why a section is not going into the channel as it stands, in the words of the
 * line that will say so — and whether the channel can be made to say it.
 *
 * THE REASON TRAVELS INSTEAD OF BEING LOGGED WHERE IT IS FOUND, and that is the
 * fix for the repeat. This used to write its own error line, so a section that
 * was too long produced one on every start of a process that restarts on every
 * crash, forever, about a file only a commit can change. The caller is the half
 * that knows whether the channel is already carrying a mark that says this; see
 * `unpublishable`.
 */
interface Unpublishable {
  readonly ok: false

  /**
   * Whether a message saying so can exist. False only when the HEADING is over
   * the title limit: no message can be posted under a title Discord will not
   * take, so there is nowhere to put a mark and nothing to read back from it.
   */
  readonly markable: boolean

  readonly why: string
  readonly fields: Record<string, unknown>
}

/** One section as an embed, or the reason it cannot be one. */
type Fit = { readonly ok: true; readonly embed: ManualEmbed } | Unpublishable

/**
 * One section as an embed, or why not.
 *
 * A SECTION THAT IS TOO LONG IS NOT POSTED, NOT TRUNCATED, AND IS SAID AT
 * ERROR. Truncating would put a section in the channel that reads like the
 * whole of it and is not, in the one document whose entire purpose is that the
 * channel and the file agree — the drift would be invisible and the bot would
 * have caused it. Refusing leaves the channel honest about the section it last
 * managed to carry, and the error reaches the status channel, where the owner
 * sees it. The fix is to split the section under a second heading.
 *
 * MEASURED IN UTF-16 CODE UNITS, WHICH IS WHAT DISCORD COUNTS. This used to
 * count code points, on the reasoning that a `length` overstates anything
 * outside the basic plane and would refuse a section Discord would take — and
 * it has the failure backwards. Discord's limits are on the JSON string as it
 * arrives, which is UTF-16, so a code-point count UNDERSTATES every astral
 * character by half: 4096 musical symbols passed a 4096 guard at 8192 units and
 * the post came back 50035, which is the one outcome this check exists to
 * prevent. `length` is the number Discord is checking against.
 *
 * THE HEADING IS NAMED IN THE ERROR ABOUT THE HEADING, which sounds too obvious
 * to write down and was missing: the line said only how long it was, in a
 * document that can have any number of headings, so the one thing the owner
 * needed in order to find it was the one thing it did not say. It is capped by
 * `named` because the whole point of this branch is that the string is enormous.
 *
 * THE FOOTER IS BUILT HERE AND ONLY REACHES DISCORD ON A WRITE. That is what
 * makes it a last-CHANGED stamp rather than a last-checked one: an unchanged
 * section returns before this embed is ever handed to `post` or `edit`, so its
 * footer keeps the date of the edit that really happened. It is also why the
 * footer is not part of the comparison — comparing it would make every start
 * differ from the last one and rewrite the channel forever.
 */
function fitEmbed(section: ManualSection): Fit {
  const footer = `updated ${new Date().toISOString()}`

  const title = section.heading.length
  const description = section.body.length
  const total = title + description + footer.length

  if (title > EMBED_TITLE_CAP) {
    return {
      ok: false,
      markable: false,
      why: 'a manual heading is too long for an embed title and was not posted',
      fields: { heading: named(section.heading), length: title, cap: EMBED_TITLE_CAP },
    }
  }

  if (description > EMBED_DESCRIPTION_CAP) {
    return {
      ok: false,
      markable: true,
      why: 'a manual section is too long for one embed and was not posted',
      fields: { heading: section.heading, length: description, cap: EMBED_DESCRIPTION_CAP },
    }
  }

  // The per-embed limits are what a section realistically hits; this is the
  // other limit Discord enforces, on a message's embeds together. One embed per
  // message means it cannot bite before the two above do — checked anyway, so
  // that the arithmetic saying so is code rather than a comment.
  if (total > EMBED_TOTAL_CAP) {
    return {
      ok: false,
      markable: true,
      why: 'a manual section is too long for one message and was not posted',
      fields: { heading: section.heading, length: total, cap: EMBED_TOTAL_CAP },
    }
  }

  return { ok: true, embed: { title: section.heading, description: section.body, footer } }
}

/**
 * A write Discord refused, as a refusal of the section that was in it.
 *
 * MARKABLE, ALWAYS. Whatever Discord objected to, an embed carrying the title
 * it already accepted and the text it already stored is a payload it has taken
 * before — so the mark can go up, and once it is up this stops being said.
 */
function discordRefused(refused: Refused): Unpublishable {
  return {
    ok: false,
    markable: true,
    why: 'Discord refused a manual section outright, so it was not published',
    fields: { error: refused.error },
  }
}

/**
 * How much of a heading a log line carries.
 *
 * A CAP BECAUSE THE LINE THAT MOST NEEDS THE HEADING IS THE ONE ABOUT A HEADING
 * THAT IS TOO LONG, and the whole of a 4000-character title in a journal line
 * is a wall that pushes everything else off the status channel post beside it.
 * The first eighty characters are enough to find the section in an editor.
 */
const HEADING_LOG_CAP = 80

function named(heading: string): string {
  // Cut by code point, like every other cut in this file: a UTF-16 slice can
  // land inside a surrogate pair and leave half a character in the record.
  const points = [...heading]
  if (points.length <= HEADING_LOG_CAP) return heading

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

    /** Read for one reason: the stale mark lives here. See `STALE_FOOTER`. */
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
 *
 * ONLY THE BOT'S OWN MESSAGES ARE READ BACK, AND ONLY THE ONES SHAPED LIKE A
 * SECTION. The docs channel is bot-only post, but a permission overwrite is one
 * right-click away from not being, and anything else in there — an admin's
 * note, an older message of ours carrying no embed — is not this bot's to key
 * on and certainly not its to delete.
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
       * bot would post a second copy of every section. Throwing turns the worst
       * outcome this feature has into one line and an untouched channel.
       */
      const selfId = client.user?.id
      if (selfId === undefined) throw new Error('the bot does not know its own user id yet')

      const messages = await channel.messages.fetch({ limit: DOCS_FETCH_LIMIT })

      return {
        sections: ours([...messages.values()], selfId),

        // A read that came back full is a read that stopped at its own limit,
        // and there is no way to tell that from a channel holding exactly this
        // many messages. The conservative reading costs a manual of exactly
        // ninety-nine sections and buys the certainty that a truncated read is
        // never mistaken for the state of the channel; see DOCS_FETCH_LIMIT.
        complete: messages.size < DOCS_FETCH_LIMIT,
      }
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
      await channel.messages.edit(id, { embeds: [apiEmbed(embed)] })
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
 * OLDEST FIRST BECAUSE `messages.fetch` ANSWERS NEWEST FIRST, and the order is
 * load-bearing for two sections that share a heading: they are paired with the
 * first and second message in the order the channel reads.
 *
 * EXPORTED SO THE FILTER CAN BE PROVEN, and it is worth proving: everything it
 * lets through is a message this bot may edit or DELETE, so a mistake here is
 * the bot removing somebody else's post from a channel it was given for its own
 * documentation.
 */
export function ours(messages: readonly DocsMessage[], selfId: string): PostedSection[] {
  const mine: (PostedSection & { at: number })[] = []

  for (const message of messages) {
    if (message.author.id !== selfId) continue

    // Exactly one, because that is what this bot posts. A message of ours
    // carrying two embeds is not a section of the manual, and keying on the
    // first of them would let an unrelated post be edited over.
    if (message.embeds.length !== 1) continue

    const embed = message.embeds[0]
    if (embed === undefined || embed.title === null) continue

    mine.push({
      id: message.id,
      title: embed.title,
      // Null is what Discord returns for an embed with no description and '' is
      // what an empty section parses to, so the two have to become one value
      // before the comparison can be a plain equality.
      description: embed.description ?? '',

      // Same story, and it is compared against one exact string — the stale
      // mark — so an absent footer has to be a value rather than a null the
      // comparison would have to know about.
      footer: embed.footer?.text ?? '',
      at: message.createdTimestamp,
    })
  }

  return mine
    .sort((a, b) => a.at - b.at)
    .map(({ id, title, description, footer }) => ({ id, title, description, footer }))
}

/**
 * One `ManualEmbed` as discord.js takes it.
 *
 * AN EMPTY DESCRIPTION IS OMITTED RATHER THAN SENT AS `''`, which Discord
 * rejects. A heading with nothing under it is a section somebody has started
 * writing, and a title-only embed is the honest rendering of that.
 */
function apiEmbed(embed: ManualEmbed): APIEmbed {
  return {
    title: embed.title,
    description: embed.description === '' ? undefined : embed.description,
    footer: { text: embed.footer },
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
 */
export function syncDocsChannel(
  client: Client,
  channelId: string,
  read: () => Promise<string | null> = readManual,
  open: (client: Client, channelId: string) => DocsChannel = docsChannel,
): void {
  client.once(Events.ClientReady, () => {
    void (async () => {
      const markdown = await read()
      if (markdown === null) return

      await syncManual(parseManual(markdown), open(client, channelId))
    })().catch((error: unknown) => {
      log('warn', 'the bot manual could not be synchronised', { error })
    })
  })
}
