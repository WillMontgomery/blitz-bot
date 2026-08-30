import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Partials,
  RESTJSONErrorCodes,
} from 'discord.js'

import type { Config } from './config.ts'
import { scanMessage, type InviteResolver, type ScanResult } from './invites.ts'
import { log, type Fault, type Sink } from './log.ts'

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
   * gateway lives on a shard now, and `shardDisconnect` is the same fact under
   * its current name. Registering the old string would type-error, and if it
   * did not it would be a handler that never fires.
   */
  client.on(Events.Error, (error) => {
    log('error', 'client error', { error })
  })

  client.on(Events.ShardDisconnect, (event, shardId) => {
    // The close code is the whole diagnosis: 4014 is a privileged intent that
    // was requested and not granted, 4004 is a bad token, 1000/1001 are
    // ordinary. Everything else is worth looking up.
    log('warn', 'gateway disconnected', { shard: shardId, code: event.code })
  })

  client.on(Events.ShardReconnecting, (shardId) => {
    log('warn', 'gateway reconnecting', { shard: shardId })
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

  return client
}

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
      log('warn', 'could not update the status channel message', { error })
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

      // Rate limited, a 500, a network that went away. All transient, all worth
      // one journal line and another attempt on the next fault.
      log('warn', 'could not post to the status channel', { error })
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
 * How much of a rendered line survives into the channel.
 *
 * DISCORD REFUSES A MESSAGE OVER 2000 CHARACTERS OUTRIGHT, and a rejected send
 * is a fault that never gets reported at all. The rest of the budget is the
 * code fence and the repeat count.
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

  // Cut by code point: a UTF-16 slice can land inside a surrogate pair and
  // leave half a character in the post.
  const points = [...scrubbed]
  return points.length > STATUS_LINE_CAP
    ? `${points.slice(0, STATUS_LINE_CAP).join('')}…`
    : scrubbed
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
