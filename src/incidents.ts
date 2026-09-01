import {
  ButtonStyle,
  ComponentType,
  Events,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
  type Client,
} from 'discord.js'

import {
  POLL_LIMIT,
  POLL_MS,
  pollAuditWindow,
  SETTLE_MS,
  type AuditPollMessages,
  type RowStep,
} from './auditpoll.ts'
import { discordIdFor } from './banrole.ts'
import type { Config } from './config.ts'
import { CONSOLE_URL } from './console.ts'
import type {
  AuditAction,
  AuditRow,
  Ddb,
  DdbWithAuditWindow,
  Incident,
  IncidentCategory,
  IncidentKind,
} from './ddb.ts'
import { log } from './log.ts'

/* ------------------------------------------------------------------ *
 * THE MODERATION RECORD FOR AN INCIDENT — blitz-bot#19.
 *
 * A case is closed in the console; an embed about it lands in the moderation
 * channel, carrying the offender's avatar and a button that opens the case.
 * ------------------------------------------------------------------ */

/**
 * ═══ WHAT THIS IS AND WHAT IT IS DELIBERATELY NOT ═══
 *
 * IT IS THE BAN-ROLE POLLER WITH A DIFFERENT VERB, AND NOW LITERALLY SO.
 * src/banrole.ts watches the console's audit log for `ban.issue`/`ban.lift`; this
 * watches it for `incident.resolve`. The walk itself — the cursor, the settle
 * window, the page, the row loop — is ONE implementation in src/auditpoll.ts that
 * both files drive; what is left here is what a resolved case means. Every trap
 * written down in banrole.ts's header applies unchanged and is not restated at
 * length. The two that decide the shape of this file are named again where they
 * bite.
 *
 * IT IS ONLY THE RESOLVED HALF. blitz-bot#19 asks for a post when a case OPENS as
 * well, and that half is not buildable today: there is no `incident.open` verb in
 * `AuditAction`, the game files cases straight into `ringmaster-incidents` without
 * touching the log, and finding them needs a GSI on `state` that does not exist
 * (fivem-ringmaster#46). Everything here that is not specifically about a
 * RESOLUTION — the avatar lookup, the button, the poster, and the walk itself — is
 * at module scope or in src/auditpoll.ts so that half arrives as a second caller.
 * Nothing here is PARAMETERISED for it: `incidentEmbed` renders a closed case and
 * says so, because a headline argument with one caller and an unreachable branch
 * for the other is scaffolding, and this repo has a habit of landing scaffolding
 * before its wiring. It is cheap to re-add beside the caller that needs it.
 *
 * ═══ THE AUDIT ROW IS THE TRIGGER AND THE INCIDENT ROW IS THE FACT ═══
 *
 * `audit.begin()` writes its row `pending` BEFORE the action and `resolve()`
 * updates THE SAME KEY afterwards, so a cursor poll over `ts` sees every row
 * exactly once, in its pending state, and never learns the outcome. `outcome` is
 * therefore never read here — the same rule banrole.ts keeps, arrived at by the
 * same road.
 *
 * SO THE VERDICT COMES FROM `ringmaster-incidents`, AND `state === 'resolved'` IS
 * REQUIRED. A resolve that failed or lost its conditional write leaves the case at
 * `pending_review`, and posting "resolved" about one of those would put a claim in
 * the moderation record that the console itself does not make.
 *
 * THAT READ IS TRUSTED BECAUSE IT IS STRONGLY CONSISTENT, AND FOR NO OTHER
 * REASON. `incidents.get` sets `ConsistentRead` (src/ddb.ts), so what comes back
 * is the item and not a replica of it. The argument this replaces was a
 * cross-repository one — `closeWithVerdict` calls `audit.begin` only after its
 * conditional update succeeds, so the trigger cannot exist before the fact — plus
 * `SETTLE_MS` as headroom for replication. Both halves may well be true and
 * NEITHER IS CHECKABLE FROM THIS REPOSITORY: the first is another repo's call
 * order, the second is a five-second guess at somebody else's replication. A
 * consistent read costs one `GetItem` per closed case and needs no such faith.
 *
 * WHAT IS LEFT IS A REAL DISAGREEMENT, AND IT IS HELD RATHER THAN SKIPPED. A row
 * that still reads `pending_review` on a consistent read means the two tables
 * genuinely disagree; the cursor stays behind it and the next pass asks again,
 * bounded by `PENDING_HOLD_MS`. Advancing over it would lose that moderation
 * record for good, because `poll()` is all this module exposes and nothing ever
 * goes back.
 *
 * ═══ ONE PERMANENT BAN MUST NOT BE FIFTY EMBEDS ═══
 *
 * Banning somebody forever closes every other open case about them — up to
 * `AUTO_CLOSE_LIMIT = 50` in the console's lib/incidents.ts — and each closure
 * writes its own `incident.resolve` row. Those rows carry
 * `detail.becauseOf = 'ban.issue'`, and dropping them is the difference between
 * one post about one moderation act and fifty. See `closedByABan`.
 *
 * ═══ WHAT MUST NOT CROSS INTO DISCORD, AND THE ONE THAT NEARLY DID ═══
 *
 * WHY THE CASE IS DESCRIBED FROM TWO ENUMS AND NOT FROM ITS SUMMARY. The
 * console's `summary` is the row a moderator reads in the queue, and it is built
 * by the GAME. For every player-filed report it is
 * `('Reported for %s by %s'):format(category, reporterName)` —
 * fivem-royale-m9/resources/[fivem-royale]/br_lib/shared/incident_build.lua,
 * `fromReport`, reached from br_core/server/players.lua on the live report path.
 * So the string ENDS IN THE REPORTER'S IN-GAME NAME.
 *
 * ═══ AND THE REASON FOR DROPPING IT IS NOT THE ONE THIS COMMENT USED TO GIVE ═══
 *
 * IT SAID THE LOG CHANNEL IS "A CHANNEL EVERY MEMBER OF THE GUILD READS", in
 * four places, and this repository says the opposite in three: docs/deploy.md
 * calls it admin-only, README.md calls it "a channel admins read", and
 * `Config.maintenanceChannelId` in src/config.ts sets the moderation record, the
 * status channel and the manual apart from the one channel players see with the
 * words "all three are for whoever runs the server". A justification the rest of
 * the repo contradicts is worse than none, because it is the sentence somebody
 * checks the decision against later.
 *
 * THE DECISION STANDS AND THE REASON IS THIS. Who reads that channel is a
 * PERMISSION SETTING — one role edit, made by somebody who has never read this
 * file, and the audience of every record already posted changes retroactively. A
 * privacy boundary that depends on a Discord permission staying the way it was
 * on the day the feature shipped is not a boundary. And the second half needs no
 * argument about audience at all: the reporter's name is not needed to DESCRIBE
 * a case. `kind` and `category` say what happened and why it was filed, the
 * button carries an admin to everything else, and a field nothing is answered by
 * has no claim on a permanent record whoever is standing in front of it.
 *
 * THE GAME REPO AGREES ABOUT THE FIELD AND NOT ABOUT THIS BOUNDARY, which is
 * worth citing precisely. fivem-royale-m9/docs/security.md names "the reporter"
 * among the attributes br_ddb's four-attribute projection deliberately keeps off
 * the GAME BOX. That is a different boundary from this one and nothing over there
 * says anything about Discord — the call below is this repo's, and this comment
 * is where it is made rather than a rule borrowed from somebody else.
 *
 * ═══ AND WHAT THE OFFENDER MUST NOT BE ABLE TO WRITE INTO IT ═══
 *
 * AN EMBED FIELD VALUE RENDERS MARKDOWN AND `subjectName` IS THE PLAYER'S OWN
 * NAME. Every value on this post that came off somebody else's row goes through
 * `inert` before it reaches a field — see there for the attack it closes and for
 * why `escapeMarkdown` alone does not close it.
 *
 * SO THIS FILE RENDERS `kind` AND `category` AND NEVER A SENTENCE SOMEBODY ELSE
 * WROTE. Both are closed vocabularies the game picks out of a list, so neither
 * can carry a name — see `caseText`. A regex that stripped the reporter out of
 * the summary was considered and refused: it is a filter over another
 * repository's format string, and it stops working, silently, the day they
 * reword it.
 *
 * WHAT ELSE STAYS BEHIND THE SIGN-IN: the evidence, the match timeline, `note`,
 * `events`, the reporter's name and license, and the moderator's written
 * resolution. The button is how somebody sees the rest. That is not a rule this
 * file keeps by remembering it — `incidents.get` in src/ddb.ts reads this table
 * with a `ProjectionExpression` naming nine attributes, so none of the others is
 * in this process at all, and `Incident` names exactly what is projected.
 *
 * ═══ THE PARTITION MOVING IS SOMEBODY ELSE'S ALARM ═══
 *
 * banrole.ts's trap 5 — `pk = 'AUDIT'` is documented as becoming
 * `AUDIT#<yyyy-mm>`, and a reader pointed at the old key returns an empty page
 * forever with no error — applies to this poller identically, and there is
 * deliberately NO second probe here. Both consumers read one partition through one
 * `AUDIT_PK` in src/ddb.ts, so the fault is one fault; a second alarm for it would
 * be a second message in the status channel about the same thing, which is how a
 * channel stops being read.
 */

/**
 * Where this poller's place in `ringmaster-audit` is kept.
 *
 * ITS OWN ROW, AND `game-ban-audit-cursor` IS TAKEN. Two consumers walk this log
 * at different speeds and stop at different rows; sharing a cursor would mean
 * whichever ran last decided what the other had already seen — silently, and in
 * the direction of skipping work rather than repeating it. Two consumers, two
 * cursors, two names, and the name says which verb it is a position in.
 */
export const CURSOR_KEY = 'incident-resolve-audit-cursor'

/**
 * The two numbers that describe the WALK rather than this consumer, re-exported
 * because src/incidents.test.ts asserts the window this poller asks for and
 * those are the bounds of it. `POLL_MS` is NOT among them: nothing imports it
 * from here, and a re-export with no importer is a second name for a number that
 * only has to disagree once.
 *
 * THEY LIVE IN src/auditpoll.ts BECAUSE THEY WERE IDENTICAL IN TWO FILES. The
 * half of each argument that belongs to this consumer: nothing here is on the
 * path of enforcement at all — the case is already closed in the console when the
 * row is written and this is a record catching up. And `SETTLE_MS` is not
 * guarding a write order here, unlike in banrole.ts: on this path the console
 * writes the incident row FIRST and the audit row second, so the fact is already
 * in place when the trigger appears. What the hold-back buys here is headroom
 * against `nextTs` stamping a burst slightly ahead of the wall clock, and that
 * alone — the consistency of the `GetItem` in `settle` used to be argued from
 * these five seconds and is now a property of the read itself (`ConsistentRead`
 * in src/ddb.ts), which is a claim this repository can check.
 *
 * WHAT IS NOT SHARED IS BELOW: `MAX_INCIDENT_READS` and `MAX_POSTS` count reads
 * of a different table and sends on a different Discord route from their
 * ban-role counterparts, and agreeing with them today is a coincidence.
 */
export { POLL_LIMIT, SETTLE_MS }

/**
 * How many incident rows one poll may read.
 *
 * SEPARATE FROM `POLL_LIMIT` BECAUSE THE TWO COUNT DIFFERENT THINGS. Fifty audit
 * rows can be fifty rows about one case or fifty rows about fifty; the read budget
 * is what stops the second case from turning one pass into fifty round trips.
 */
export const MAX_INCIDENT_READS = 25

/**
 * How many embeds one pass may post.
 *
 * DISCORD'S RATE LIMITS ARE PER ROUTE AND ARE NOT GENEROUS, and a burst of sends
 * to one channel is the shape of traffic that hits them — a moderator working
 * through the queue after a weekend, or this poller catching up after an outage.
 * Ten a pass drains that across a few minutes instead of into one 429 storm, and
 * the cursor only moves over rows actually posted, so stopping early costs a wait
 * and nothing else.
 */
export const MAX_POSTS = 10

/**
 * How long a case the log calls closed may go on reading `pending_review` before
 * this poller gives up on it and moves past it.
 *
 * ═══ WHY THERE IS A HOLD AT ALL ═══
 *
 * `incidents.get` IS STRONGLY CONSISTENT (src/ddb.ts), so a row that comes back
 * `pending_review` is not a replica that has not caught up. It is the two
 * repositories genuinely disagreeing about a case — a resolve that failed after
 * its audit row was written, or one that lost a conditional write — and the next
 * pass may well find it resolved, because that is a thing an admin retries.
 *
 * ADVANCING OVER IT LOSES THE RECORD FOR GOOD, which is what makes this
 * different from every other "move on" in this repository. `IncidentLog` exposes
 * `poll()` and nothing else: there is no reconcile, no second pass over old
 * rows, nothing that ever goes back for a row the cursor has passed. The ban role
 * survives the same class of mistake only because it re-reads every tag it holds
 * every `RECONCILE_MS`. So the cursor stays behind the row and the next pass asks
 * the table again.
 *
 * ═══ AND WHY THE HOLD IS BOUNDED ═══
 *
 * THE CURSOR IS ONE NUMBER OVER AN ORDERED WALK, so a row held back holds back
 * every record BEHIND it. A case that is never going to be resolved would
 * silence the moderation channel permanently — the same loss as skipping,
 * arrived at more slowly and with more of it.
 *
 * FIFTEEN MINUTES, AND THE UNIT IS AN ADMIN NOTICING. It is thirty attempts at
 * `POLL_MS`; it covers a console retry and a moderator closing the case a second
 * time by hand; and it caps what one stuck row costs the records behind it at a
 * quarter of an hour, which is affordable for a feed that is a record catching up
 * rather than anything on the path of enforcement. Past it the give-up is an
 * `error` naming the case, and the closure is in the console's own `/audit`
 * either way — that is the recovery, and it is a person's rather than this
 * process's.
 *
 * ═══ MEASURED FROM WHEN THIS POLLER FIRST SAW THE ROW, NOT FROM `row.ts` ═══
 *
 * IT USED TO BE `now() - triggeredAt`, WHERE `triggeredAt` IS THE CONSOLE'S OWN
 * STAMP ON THE AUDIT ROW, AND THAT MADE THE BOUND FIRE BEFORE THE FIRST RETRY.
 * After any outage or deploy gap longer than fifteen minutes — a `npm ci` that
 * took a while, an afternoon with the box off, the update timer restarting the
 * unit — every pending case in the backlog was ALREADY past the bound the moment
 * the poller first looked at it. One pass, one `error` per case, cursor moved,
 * record gone. Driven: a one-hour gap with three genuinely-pending cases behind
 * it gave up on all three in a single pass and never asked the table a second
 * time about any of them.
 *
 * WHICH IS EXACTLY THE CASE THE HOLD EXISTS FOR. The disagreement it is written
 * against is one an admin fixes by closing the case again — and the window in
 * which he would is the window this poller is running, not the window the bot
 * spent switched off. A bound measured against somebody else's clock counts time
 * this process was not there to retry in.
 *
 * SO THE CLOCK STARTS AT FIRST SIGHT, kept in `heldSince` in `createIncidentLog`,
 * and every case gets its full fifteen minutes of retries however long the bot
 * was down. A restart starts it again, which is the same choice and the same
 * argument: the budget is attempts this process can actually make.
 */
export const PENDING_HOLD_MS = 900_000

/**
 * How many passes may fail outright on one case before this poller gives up on
 * that case and moves past it.
 *
 * ═══ WHY THERE HAS TO BE A BOUND AT ALL ═══
 *
 * `stop` IS RIGHT FOR A TRANSIENT FAULT AND HAS NO ANSWER FOR A PERMANENT ONE.
 * An incident that cannot be read and a send that was refused both end the walk
 * without advancing the cursor, which is what turns a timeout or a 500 into a
 * retry rather than a hole in a permanent record. But nothing distinguishes
 * those from a channel the bot has lost Send Messages in, an embed Discord will
 * refuse every time it is offered, or an IAM grant somebody removed from the
 * role. Any of those stops the feed at row one FOR THE LIFE OF THE PROCESS: no
 * record after it is ever posted, the moderation channel simply goes quiet, and
 * the only evidence is a status line that `statusReporter` folds after its
 * window. Losing one record loudly beats losing every later record silently.
 *
 * ═══ WHY IT COUNTS ATTEMPTS AND `PENDING_HOLD_MS` COUNTS MINUTES ═══
 *
 * THEY BOUND TWO DIFFERENT KINDS OF WAITING AND THE UNITS ARE NOT
 * INTERCHANGEABLE. The pending hold is waiting on ANOTHER system — an admin
 * closing a case a second time — so the question it asks is "how long has there
 * been for that to happen", and the answer is wall-clock minutes. This one is
 * waiting on THIS bot succeeding at something it attempted, so the question is
 * "how many times has it tried", and an elapsed bound would answer it by
 * counting a window the process spent switched off as attempts it never made.
 * That is the exact mistake `PENDING_HOLD_MS` above has just stopped making, and
 * writing it back in here under a different name would be a poor trade.
 *
 * THIRTY, WHICH IS THIRTY REAL TRIES. At `POLL_MS` that is fifteen minutes of a
 * caught-up bot — the same quarter of an hour the pending hold allows, and NOT
 * the same number for the same reason: change `POLL_MS` and the pending hold
 * still means fifteen minutes while this still means thirty attempts, which is
 * what each of them is actually about. Thirty is also comfortably more than any
 * burst of Discord 5xx or DynamoDB throttling this feed can produce, and a fault
 * that survives thirty consecutive attempts a half-minute apart is not the kind
 * the next attempt fixes.
 *
 * A RESTART GIVES A CASE ITS THIRTY BACK, deliberately. The count is in memory
 * and is not written anywhere: a deploy or a crash between attempt five and
 * attempt six is not evidence about the case, and the first thing an operator
 * does about a channel that went quiet is restart the bot.
 *
 * "CONSECUTIVE" IS NOT A DISTINCTION THIS COUNT CAN MAKE, AND SAYING IT WOULD BE
 * A CLAIM WITH NO TEST BEHIND IT. A case that succeeds leaves the walk and is
 * never offered again, so every attempt on a case that is still being counted
 * has failed by construction; a running total and a consecutive run are the same
 * number in every history this poller can produce. `settled` clearing the count
 * is about memory, and says so there.
 *
 * PAST IT THE GIVE-UP IS AN `error` NAMING THE CASE AND THE FAULT, so the one
 * record being dropped is louder in the status channel than the whole feed
 * stopping was. The closure is in the console's own `/audit` either way — that
 * is the recovery, and it is a person's rather than this process's.
 *
 * ═══ WHERE THIS TRADE IS AT ITS WORST, STATED RATHER THAN GLOSSED ═══
 *
 * THE COUNT IS PER CASE, SO A FAULT THAT IS NOT ABOUT ANY ONE CASE COSTS MORE
 * THAN ONE RECORD. A `ringmaster-incidents` outage or a revoked IAM grant fails
 * every case alike: the walk stops at the head each pass, gives that one up
 * after fifteen minutes, stops at the next, and so on — so a long enough outage
 * drops a record every fifteen minutes rather than one record in total. Per case
 * is still the right granularity, because the ordinary fault IS about one case —
 * an embed Discord will not accept, an id that reads back as nothing — and a
 * shared counter would give up on a healthy case because an unrelated one is
 * broken. What the wider fault buys is that it is impossible to miss: an `error`
 * per case in the status channel, naming the failure kind, while the old
 * behaviour was silence.
 */
export const FAULT_LIMIT = 30

/**
 * What Discord will accept as a link button's url.
 *
 * THE SAME 512 `/profile` CHECKS ITS OWN BUTTON AGAINST, and for the same reason:
 * the origin is operator-supplied and the id comes out of DynamoDB, so neither
 * half of this url is written in this repo. A url over the cap makes Discord
 * refuse the WHOLE message — the embed with it — so the button is dropped and the
 * record still posts.
 */
export const BUTTON_URL_CAP = 512

/** Discord's cap on one embed field's value. */
const FIELD_VALUE_CAP = 1024

/** Discord's cap on an embed footer's text. */
const FOOTER_TEXT_CAP = 2048

/**
 * The furthest from the epoch, in milliseconds, that a stamp on one of these
 * records may be: the distance to `0000-01-01T00:00:00.000Z`.
 *
 * ═══ IT IS A RANGE AND `Number.isFinite` IS NOT A RANGE CHECK ═══
 *
 * ECMA-262 GIVES `Date` A TIME VALUE OF ±8.64e15 AND NOTHING OUTSIDE IT. A
 * number one millisecond past that is an Invalid Date, and `toISOString` on an
 * Invalid Date THROWS `RangeError: Invalid time value` — it does not answer
 * `'Invalid Date'` the way `toString` does. `Number.isFinite` says nothing about
 * any of that: `8640000000000001`, `1e16`, `1e18`, `Number.MAX_SAFE_INTEGER` and
 * `-1e16` are all finite, and every one of them throws.
 *
 * WHAT THAT COST, AND WHY IT IS WORTH A CONSTANT RATHER THAN AN INLINE NUMBER.
 * `resolvedAt` comes off `ringmaster-incidents`, a row THIS REPO DOES NOT WRITE.
 * The throw landed inside the `try` around the send in `settle`, so a value the
 * row carried was recorded as a Discord failure: the case took a strike, the
 * walk stopped behind it for `FAULT_LIMIT` passes with every record behind it
 * waiting, and it was then dropped with a line in the owner's status channel
 * blaming a channel that had never refused anything.
 *
 * ═══ AND THE LIMIT IS ABOUT WHAT A RECEIVER WILL PARSE, NOT WHAT `Date` HOLDS ═══
 *
 * THE NUMBER USED TO BE ±8.64e15, WHICH IS `Date`'S OWN LIMIT AND IS NOT
 * DISCORD'S — so the bound admitted exactly the two values it should have been
 * most suspicious of. `new Date(8_640_000_000_000_000).toISOString()` is
 * `+275760-09-13T00:00:00.000Z` and the negative extreme is
 * `-271821-04-20T00:00:00.000Z`: ISO 8601 EXPANDED-YEAR form, six digits behind a
 * mandatory sign, which 8601 permits only by prior agreement between the sender
 * and the receiver. There is no such agreement here — Discord's behaviour on it
 * is undocumented, most parsers refuse it outright, and this value arrives on
 * another repository's row.
 *
 * SO THE ENVELOPE IS A FOUR-DIGIT YEAR, WHICH EVERY PARSER TAKES WITHOUT ONE.
 * This number is the epoch-to-`0000-01-01` distance, so the two ends of
 * `Math.abs` are `0000-01-01T00:00:00.000Z` — the first four-digit year there is,
 * and the side where the real boundary sits — and `3940-01-02T00:00:00.000Z`. The
 * upper end is deliberately conservative rather than exact: one constant and one
 * symmetric rule is cheaper to hold than two bounds, and no `resolvedAt` or
 * `expiresAt` this bot is handed will be in the fourth millennium.
 *
 * WHY THIS WAS AN EDGE AND NOT AN OUTAGE, STATED SO THE NEXT READER DOES NOT
 * OVERSTATE IT. An expanded year does not throw — `toISOString` answers a string
 * — so the failure was a send Discord might refuse, inside the `try` in `settle`:
 * a strike, and the record dropped loudly after `FAULT_LIMIT` passes. Bounded and
 * visible, and still a needless edge in a value this repo does not write.
 */
const MAX_PARSEABLE_MS = 62_167_219_200_000

/**
 * Is this a stamp this bot will put in a permanent record — a number, and inside
 * the envelope a receiver will parse?
 *
 * ONE RULE IN ONE PLACE, AND IT USED TO BE TWO RULES TWO FUNCTIONS APART.
 * `resolvedAt` in `incidentEmbed` got `MAX_PARSEABLE_MS` and a paragraph
 * explaining why finiteness is not a range; `expiresAt` in `verdictText` — the
 * same kind of number, off the same row, going into the same message — got
 * `typeof` and `Number.isFinite` and stopped there. `expiresAt = 1e18` is both of
 * those, so it rendered `Banned · <t:1000000000000000:f>`: a Discord timestamp
 * far outside anything renderable, in a record nobody ever goes back to.
 *
 * `Math.abs` COVERS `NaN` AND BOTH INFINITIES ON ITS OWN, since none of the three
 * is `<=` anything. The finiteness test this replaces is subsumed, not lost.
 */
function renderable(at: unknown): at is number {
  return typeof at === 'number' && Math.abs(at) <= MAX_PARSEABLE_MS
}

/**
 * Everything a human reads on this post.
 *
 * THE LABELS ARE STRUCTURAL AND THE SENTENCES ARE NOT, AND THAT IS THE WHOLE
 * REASON THIS OBJECT EXISTS. `Case`, `Player`, `Verdict` and `Resolved by` are
 * names for the facts beside them — they are the embed's structure written down,
 * the way a column heading is. Everything marked PLACEHOLDER below is a statement
 * this bot makes in the owner's moderation channel, and the owner supplies his own
 * copy: each one is the minimum factual version, in one place, so that rewording
 * the lot is one edit to this object and nothing else.
 *
 * `verdictUnknown` IS THE ONE TO READ TWICE. It is what a case with NO verdict
 * gets — resolved before the field existed, or auto-resolved at open — and it must
 * never be worded as "no action was taken", because that states a decision nobody
 * made. See `verdictText`.
 */
export const COPY = {
  /** PLACEHOLDER — the embed's title, and the only place the post says what happened. */
  title: 'Incident resolved',

  case: 'Case',
  player: 'Player',
  verdict: 'Verdict',
  resolvedBy: 'Resolved by',

  /**
   * PLACEHOLDER — what a case is said to be about when its `kind` is one this
   * bot does not have a word for.
   *
   * IT IS NOT "OTHER" AND IT MUST NOT BECOME THE RAW VALUE. The whole reason the
   * post is built from `kind` and `category` is that both are closed
   * vocabularies and therefore cannot carry somebody's name; rendering an
   * unrecognised value verbatim would hand that property straight back, because
   * the attribute is a 32-character string as far as `buildIncidentItem` is
   * concerned. A word this bot chose is the only safe answer to a word it does
   * not know.
   */
  kindUnknown: 'Case',
  /** PLACEHOLDER — the same, for a `category` this bot has no word for. */
  categoryUnknown: 'Unclassified',

  /** PLACEHOLDER — a ban with an expiry. The time is appended after it. */
  verdictBan: 'Banned',
  /** PLACEHOLDER — a ban with no expiry. */
  verdictBanPermanent: 'Banned permanently',
  /** PLACEHOLDER */
  verdictKick: 'Kicked',
  /** PLACEHOLDER — an admin looked and decided nothing was needed. */
  verdictNone: 'No action taken',
  /**
   * PLACEHOLDER — and NOT a synonym for `verdictNone`. The row carries no
   * verdict, so this says exactly that and claims nothing about what was decided.
   */
  verdictUnknown: 'No verdict recorded',

  /**
   * The link button's label.
   *
   * THE SAME LABEL `/profile`'s BUTTON ALREADY CARRIES — `openInConsole` in
   * `COPY`, src/commands/profile.ts — because it is the same button doing the
   * same job in a different place, and two spellings of one label is how a bot
   * starts reading as two bots.
   *
   * IT USED TO SAY "THE SAME NINETEEN CHARACTERS". `Open in Ringmaster` is
   * eighteen. The count was decoration on a claim that does not need one, and a
   * number nothing checks is a number that goes stale the first time somebody
   * rewords the label — so it is gone rather than corrected.
   */
  button: 'Open in Ringmaster',
}

/**
 * The embed's colour bar.
 *
 * DISCORD'S OWN BLURPLE, the same `0x5865f2` `/profile` uses for its ordinary
 * reply, rather than a palette invented here. There is deliberately ONE colour:
 * `severity` is on every incident row and is read by nothing — not even declared
 * on the console's own `Incident` type — and it is the natural source for a second
 * one, but making this bot its first consumer is a decision about a field another
 * repository owns and it belongs to the owner rather than to this file. See the
 * open question on blitz-bot#19.
 */
const COLOUR = 0x5865f2

/* ------------------------------------------------------------------ *
 * Reading the log.
 * ------------------------------------------------------------------ */

/**
 * The audit verbs that mean an incident changed.
 *
 * ONE VERB, AND A `Set` OF `AuditAction` FOR THE REASON banrole.ts GIVES: a verb
 * renamed in src/ddb.ts becomes a compile error here rather than a filter that
 * silently matches nothing. `incident.resolve` is the only incident verb there is
 * — there is no `incident.open`, which is the whole reason the other half of
 * blitz-bot#19 needs an index instead of this poller.
 */
const TRIGGERS: ReadonlySet<AuditAction> = new Set<AuditAction>(['incident.resolve'])

/** Is this row about an incident at all? */
export function isIncidentTrigger(row: Pick<AuditRow, 'action'>): boolean {
  return TRIGGERS.has(row.action)
}

/**
 * A case closed BY a ban, rather than a decision anybody took about this case.
 *
 * A COPY OF `closedByABan` IN fivem-ringmaster/src/lib/audit.ts, CONDITION FOR
 * CONDITION, because the console filters exactly these rows out of a moderator's
 * profile and for exactly this reason: one permanent ban closes every other open
 * case about that player — up to fifty — and each closure writes a row. Fifty
 * embeds for one moderation act would make the channel unreadable on the one day
 * it matters most.
 *
 * IT IS NARROWER THAN "ANYTHING CARRYING `becauseOf`", DELIBERATELY AND FOR THE
 * CONSOLE'S OWN STATED REASON. The enforcement `player.kick` that follows a ban
 * carries the same marker and is NOT dropped over there: being removed from a
 * match is something that happened to the player, and it is one row rather than
 * fifty. Nothing in this file acts on `player.kick`, so the distinction costs
 * nothing here — it is copied whole so that the day something does, it inherits
 * the right rule rather than a convenient one.
 *
 * THE ORIGINATING CASE DOES NOT CARRY THE MARKER. The case the ban was issued
 * FROM is the admin's own decision and is posted like any other closure.
 */
export function closedByABan(row: Pick<AuditRow, 'action' | 'detail'>): boolean {
  return row.action === 'incident.resolve' && row.detail?.becauseOf === 'ban.issue'
}

/**
 * The case an `incident.resolve` row is about, or null.
 *
 * `detail` IS `Record<string, string | number | boolean | null>`, so the id
 * arrives as `unknown`-shaped as far as this repo is concerned even though the
 * console writes a string. A non-string here would become
 * `/incidents/[object%20Object]` in a button, so it is refused rather than
 * coerced.
 */
export function incidentIdOf(row: Pick<AuditRow, 'detail'>): string | null {
  const id = row.detail?.incidentId
  return typeof id === 'string' && id !== '' ? id : null
}

/* ------------------------------------------------------------------ *
 * The post.
 * ------------------------------------------------------------------ */

/**
 * One line, bounded. FOR TEXT THIS FILE WROTE — `inert` is for everything else.
 *
 * NEWLINES OUT OF EVERY BORROWED VALUE, for the reason src/log.ts escapes them
 * and `oneLine` in src/commands/profile.ts collapses them: a field here is read
 * as one fact, and a newline inside a value forges facts nobody recorded.
 * Collapsing all whitespace also stops a value of forty spaces from spending a
 * field's budget on nothing.
 *
 * BOTH OF ITS CALLERS TODAY ARE IN `incidentEmbed`, AND THEY ARE NOT THE SAME
 * KIND OF VALUE. The Case field is handed `caseText`'s output, which is this
 * module's own words — `KIND_LABEL` and `CATEGORY_LABEL`, joined — so from there
 * the cap and the non-string guard are both unreachable and are kept anyway,
 * because "unreachable" is a claim about today's caller and `FIELD_VALUE_CAP` is
 * a claim about Discord. The footer is handed `incidentId`, which this repo did
 * NOT write, and it is the one borrowed value on the embed that legitimately
 * does not need `inert`: footer text renders no markup at all, so there is
 * nothing there for a code span to neutralise. See the footer itself.
 *
 * WHAT THIS DOES NOT DO IS NEUTRALISE MARKDOWN, and an embed FIELD renders it —
 * which is exactly why nothing foreign may come through here into one. The two
 * values a player controls go through `inert`.
 */
function short(text: unknown, cap = FIELD_VALUE_CAP): string {
  if (typeof text !== 'string') return ''
  return cut(text.replace(/\s+/gu, ' ').trim(), cap)
}

/**
 * One line, cut to a budget without splitting a character in half.
 *
 * CUT ON CODE POINTS, because a UTF-16 slice can land in the middle of a
 * surrogate pair and leave half a character in the record. Extracted out of
 * `short` when `inert` needed the same cut against a smaller budget — the two
 * backticks it wraps the value in are two of the 1024 Discord counts.
 */
function cut(line: string, cap: number): string {
  if (line.length <= cap) return line

  const room = Math.max(1, cap - 1)
  let kept = ''
  for (const point of line) {
    if (kept.length + point.length > room) break
    kept += point
  }

  return `${kept}…`
}

/**
 * A value THIS REPO DID NOT WRITE, rendered as itself and as nothing else.
 *
 * ═══ THE HOLE THIS CLOSES ═══
 *
 * AN EMBED FIELD VALUE RENDERS MARKDOWN, AND `subjectName` IS THE PLAYER'S OWN
 * IN-GAME NAME. It is a surface the person being moderated chooses and can
 * prepare weeks before anybody looks at them, and until this function existed it
 * went into the moderation record verbatim. A player called
 * `[Appeal your ban here](https://not-the-console.example)` got a live,
 * official-looking link in the Player field, sitting directly beside the genuine
 * `Open in Ringmaster` button. `<t:0:R>` forged a timestamp next to the real
 * one; `||spoilers||`, `> quotes` and backticks restructured the post; and a
 * bare `https://…` needs no markup at all, because Discord linkifies a url on
 * sight. `resolvedByName` has the same exposure from a friendlier source.
 *
 * ═══ WHY NOT `escapeMarkdown` ═══
 *
 * IT IS NOT ENOUGH, AND THAT IS A MEASUREMENT RATHER THAN AN OPINION. Run over
 * the attack list with every option it has turned on — `maskedLink`, `heading`,
 * `bulletedList`, `numberedList` on top of its defaults — discord.js's
 * `escapeMarkdown` neutralises `[`, `*`, `_`, `~`, `|`, `` ` ``, a leading `#`,
 * `-` and `1.`, and leaves FOUR things exactly as it found them:
 *
 *   `> quoted`      — no block-quote rule at any option;
 *   `<t:0:R>`       — it is not written for timestamp or entity markup, so
 *                     `<@id>`, `<@&role>` and `<#channel>` pass too;
 *   `@everyone`     — it escapes markdown, and a mass ping is not markdown;
 *   `https://x.y`   — a bare url has no delimiter to escape. There is no
 *                     backslash that stops Discord linkifying one.
 *
 * The last of those is the one that settles it: the headline attack is a
 * clickable link beside the real button, and escaping cannot make a plain url
 * inert. Nothing can, in running text.
 *
 * ═══ SO IT IS A CODE SPAN, WHICH IS THE ARGUMENT src/client.ts ALREADY MADE ═══
 *
 * INSIDE `` ` ` `` DISCORD RENDERS EVERY ONE OF THOSE LITERALLY AND LINKIFIES
 * NOTHING. `authorRef` in src/client.ts reached the same conclusion about the
 * same class of value — a username a stranger chose, interpolated into a
 * moderation post — and this is that decision applied to the other channel. It
 * also has the property escaping does not: the name comes out EXACTLY as it was
 * registered rather than sprayed with backslashes, which matters for a record
 * an admin reads next to the console's own copy of the same name.
 *
 * ONE CHARACTER CLASS IS REMOVED RATHER THAN RENDERED, AND ONLY ONE MORE THAN
 * THE SPAN NEEDS. A backtick would close the span and let the rest of the value
 * out as markup, so it goes. `\p{C}` — control codes, zero-width joiners and the
 * bidi overrides that reorder what a human reads without changing a byte of what
 * was stored — goes with it, for the reason `plainName` gives.
 *
 * `@` AND `<` ARE KEPT, WHICH IS WHERE THIS DIFFERS FROM `plainName`. That one
 * strips them because a Discord username cannot contain either, so removing them
 * mangles nothing real. A FiveM in-game name can contain both, and this string
 * is a moderation record that has to match what an admin sees in the console —
 * so they are made inert by the span rather than deleted from the record. The
 * `allowedMentions: { parse: [] }` at the send in `logChannelPosts` is the
 * second, independent reason no `@everyone` in here can ping anybody.
 *
 * EMPTY IS THE SAME ANSWER AS ABSENT, and `incidentEmbed` drops the field. A
 * name that is nothing but backticks leaves nothing to put in a span, and a
 * label with an empty pair of backticks beside it reads as a fact that failed to
 * load.
 *
 * IT TAKES `unknown` AND REFUSES ANYTHING THAT IS NOT A STRING, the guard
 * `short` already carried and for its reasons: every value handed here comes off
 * a row another repository writes, so the type is a claim rather than a fact, and
 * a numeric `subjectName` would have thrown `.replace is not a function` out of
 * the middle of a pass — which, because a throw skips the cursor write, stops the
 * feed dead on one malformed row.
 */
function inert(text: unknown, cap = FIELD_VALUE_CAP): string {
  if (typeof text !== 'string') return ''

  const flattened = text
    .replace(/\s+/gu, ' ')
    .replace(/[`\p{C}]/gu, '')
    .trim()

  if (flattened === '') return ''

  // `cap - 2` because the two backticks are two of the characters Discord counts
  // against the field's 1024.
  return `\`${cut(flattened, cap - 2)}\``
}

/**
 * What a case is about, per `kind`. PLACEHOLDERS, every one.
 *
 * A `Record<IncidentKind, string>` SO A FOURTH KIND IS A COMPILE ERROR rather
 * than a silent fall-through to `COPY.kindUnknown` — the fallback is for a value
 * that reached DynamoDB without passing through this repo's types, not for one
 * somebody added to the union and forgot to word.
 *
 * THE SAME THREE WORDS THE CONSOLE USES (`KIND_LABEL` in its lib/incidents.ts),
 * because an admin reading a case in the channel and then opening it in the
 * console is reading one record in two places, and two vocabularies for one field
 * is how they stop looking like the same record.
 */
export const KIND_LABEL: Record<IncidentKind, string> = {
  report: 'Player report',
  identifier_reuse: 'Shared identifier',
  anticheat: 'Anticheat',
}

/** Why, per `category`. PLACEHOLDERS, and the console's own words again. */
export const CATEGORY_LABEL: Record<IncidentCategory, string> = {
  cheating: 'Cheating',
  teaming: 'Teaming',
  griefing: 'Griefing',
  abusive_chat: 'Abusive chat',
  exploiting: 'Exploiting',
  other: 'Something else',
  system: 'System',
}

/**
 * One label out of a map, or the fallback. Never the value it was handed.
 *
 * `Object.hasOwn` RATHER THAN `map[value] ?? fallback`, which is the same answer
 * for every real value and a different one for `constructor`, `toString` and
 * `__proto__`. Those reach the map through the prototype chain and are functions,
 * so the `??` would miss them and a `String()` of the result would put a
 * JavaScript function body in a moderation record. The attribute comes off
 * another repository's row and is a 32-character string as far as its writer is
 * concerned, so "that value cannot occur" is not available here.
 */
function labelled(labels: Readonly<Record<string, string>>, value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !Object.hasOwn(labels, value)) return fallback
  return labels[value] ?? fallback
}

/**
 * What the case was, as one field's worth of words.
 *
 * ═══ THIS IS THE FUNCTION THAT REPLACED `summary`, AND WHY ═══
 *
 * The console's `summary` is free text built by the game, and for a player-filed
 * report it ends in the REPORTER'S IN-GAME NAME — see the file header, which
 * names the line that builds it.
 *
 * THE REASON IS NOT "EVERYONE IN THE GUILD READS THIS CHANNEL", which is what
 * this comment used to say and what docs/deploy.md, README.md:31-32 and
 * `Config.maintenanceChannelId` in src/config.ts all contradict — it is the
 * admins' channel. It is that who reads it is a PERMISSION SETTING and can
 * change under a record that is already posted, and that the reporter's name
 * answers nothing about the case anyway. The file header argues both halves.
 *
 * `kind` AND `category` CANNOT CARRY A NAME, WHICH IS THE WHOLE OF THE ARGUMENT.
 * They are values the game picks out of a fixed list — the same two lists the
 * console declares in lib/incidents.ts — so there is no shape of report, and no
 * rewording on the game's side, that puts a person's name in this string.
 * `labelled` above is what keeps that true for a value neither repo has heard of.
 *
 * IT SAYS LESS THAN THE SUMMARY DID, AND THAT IS THE TRADE, STATED. A reader
 * gets "what kind of case, about what" instead of a sentence; the case itself is
 * one button away, in the console, where the reporter is a fact an admin is
 * allowed to see. That is the same boundary `/profile` keeps.
 *
 * ONE FIELD RATHER THAN TWO, because they are one fact read together and two
 * inline fields for a five-word answer wastes the width the player's name needs.
 * A `system` category on an `anticheat` kind is not repeated — the game writes
 * that pair for everything it files itself, and "Anticheat · System" says the
 * same word twice.
 */
export function caseText(incident: Pick<Incident, 'kind' | 'category'>): string {
  const kind = labelled(KIND_LABEL, incident.kind, COPY.kindUnknown)
  const category = labelled(CATEGORY_LABEL, incident.category, COPY.categoryUnknown)

  if (incident.category === 'system' || category === kind) return kind
  return `${kind} · ${category}`
}

/**
 * What was decided, as one field's worth of words.
 *
 * IT NARROWS ON `action` FIRST AND ALWAYS, WHICH IS THE CONTRACT AND NOT A STYLE.
 * `expiresAt` exists IF AND ONLY IF the action is `ban`; reaching for it on a kick
 * gets `undefined` where a permanent ban gives `null`, two falsy values meaning
 * entirely different things.
 *
 * ABSENT AND `null` ARE THE SAME ANSWER AND IT IS NOT "NONE". A case resolved
 * before the field existed carries no attribute; one the system auto-resolved at
 * open carries an explicit `null`. Reading either as "no action was taken" states
 * a decision nobody made — the console's own `IncidentVerdict` comment is emphatic
 * about it, and this is the reader that has to honour it.
 *
 * AN ACTION THIS DOES NOT RECOGNISE FALLS THROUGH TO THE SAME ANSWER. The union
 * says it cannot happen; the row is written by another repository, so it can.
 *
 * `expiresAt` IS RANGE-CHECKED AND NOT MERELY CHECKED FOR FINITENESS, WHICH IS
 * THE SAME RULE `resolvedAt` HAS ALWAYS HAD. This line was
 * `typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)`, and `1e18` is a
 * number and is finite — so it rendered as a Discord timestamp nothing can draw,
 * in a record that is never revisited. See `renderable`.
 */
export function verdictText(incident: Pick<Incident, 'verdict'>): string {
  const verdict = incident.verdict
  if (verdict === null || verdict === undefined) return COPY.verdictUnknown

  if (verdict.action === 'ban') {
    const { expiresAt } = verdict
    if (expiresAt === null) return COPY.verdictBanPermanent
    if (!renderable(expiresAt)) return COPY.verdictBan

    // Discord's own timestamp markup, so the expiry is rendered in the reader's
    // timezone rather than in the bot's. `f` is the long date-and-time form.
    return `${COPY.verdictBan} · <t:${String(Math.floor(expiresAt / 1000))}:f>`
  }

  if (verdict.action === 'kick') return COPY.verdictKick
  if (verdict.action === 'none') return COPY.verdictNone

  return COPY.verdictUnknown
}

/**
 * The moderation record for one CLOSED case.
 *
 * IT BUILDS ONE POST AND TAKES NO HEADLINE, WHICH IS A DELIBERATE NARROWING. It
 * used to take the title as an argument and render the verdict only when
 * `state === 'resolved'`, so that the other half of blitz-bot#19 could reuse it
 * — but `settle` refuses every case that is not resolved and no production call
 * passes a title, so both of those were an unreachable branch and an unused
 * parameter maintained against a caller that cannot be written until
 * fivem-ringmaster#46 lands. This repo has a documented habit of landing
 * scaffolding before its wiring; re-adding a parameter beside the call that needs
 * it is a smaller change than keeping a branch nothing can execute.
 *
 * WHAT IT SAYS ABOUT THE CASE COMES FROM `caseText`, WHICH IS THE PRIVACY
 * BOUNDARY OF THIS WHOLE FEATURE. Read its comment before adding a field: the
 * summary this used to render ends in the reporter's in-game name.
 *
 * THE AVATAR IS OPTIONAL AND THE EMBED IS CORRECT WITHOUT IT, which is the case
 * that has to work rather than the case that usually happens. FiveM reports a
 * `discord:` identifier only when the player has Discord's activity integration
 * switched on, and it is opt-in — so a cheater who has turned it off is exactly
 * the person with no id to look up. `thumbnail` is ABSENT rather than empty in
 * that case: Discord refuses an embed carrying `thumbnail: { url: '' }`, and a
 * refused message is a moderation record that does not exist.
 *
 * `subjectName` IS RENDERED AS STORED AND IS NOT TRUSTED TO BE A NAME. The game's
 * builders set it from the sighting they have (`subjectName = ev.name`, in
 * br_lib/shared/incident_build.lua) and the literal `'Unknown'` is substituted a
 * layer later, where the row is assembled for DynamoDB —
 * `subjectName: str(payload.subjectName) ?? 'Unknown'` in `buildIncidentItem`,
 * fivem-royale-m9/js-src/br_ddb/src/incident.js. So the field can say `Unknown`,
 * that is the honest answer, and nothing here may key a decision off the string
 * because a player could be called it.
 *
 * THE RESOLVER IS NAMED AND NEVER LICENSED. `resolvedByLicense` is not projected
 * and is not on `Incident` at all: the console writes `actor.license ?? ''` for an
 * admin with no grants row — an admin who has never joined the game server holds
 * every power in the console and has no license — so `''` is "not known" and never
 * an identity. `resolvedByName` is what a reader wanted anyway.
 *
 * A FIELD IS OMITTED RATHER THAN LEFT BLANK when it has nothing in it. A label
 * with an empty value beside it reads as a fact that failed to load, which is a
 * different claim from a fact nobody recorded.
 */
export function incidentEmbed(incident: Incident, avatarUrl: string | null): APIEmbed {
  /**
   * `inert` ON THE TWO VALUES THIS REPO DID NOT WRITE, AND `short` ON THE ONE IT
   * DID. `subjectName` is the offender's own in-game name and `resolvedByName`
   * is a name the console holds; both render markdown in an embed field, so both
   * go through the code span — see `inert`, which lists what a player could put
   * in this record before it existed. `caseText` is this module's own two labels
   * and `verdictText` is this module's own words plus a timestamp built from a
   * number it range-checks, so neither can carry anybody's markup.
   */
  const fields: APIEmbedField[] = [
    { name: COPY.case, value: short(caseText(incident)) },
    { name: COPY.player, value: inert(incident.subjectName), inline: true },
    { name: COPY.verdict, value: verdictText(incident), inline: true },
    { name: COPY.resolvedBy, value: inert(incident.resolvedByName), inline: true },
  ]

  /**
   * The instant the embed is about: when the case was closed. A field Discord
   * cannot parse is left off rather than allowed to make the whole message
   * invalid — and that is now true of the ONE value that could stop it being
   * built at all.
   *
   * A RANGE CHECK AND NOT A FINITENESS CHECK. This line read
   * `Number.isFinite(at)` and `MAX_PARSEABLE_MS` says what that missed: a stamp
   * outside `Date`'s range is finite, and `new Date(at).toISOString()` on it
   * throws rather than answering. `Math.abs` covers `NaN` and both infinities on
   * its own — neither is `<=` anything — so the finiteness test it replaces is
   * not lost, it is subsumed. The range itself now stops one step short of
   * `Date`'s own, and `MAX_PARSEABLE_MS` says why; `renderable` is the one place
   * that rule is written down.
   */
  const at = incident.resolvedAt

  /**
   * The id is the one thing that makes the record traceable when the button is
   * absent, and the footer is where it costs no room a fact could have used.
   *
   * ═══ WHY IT IS NOT `inert`, WHICH IS THE QUESTION EVERY OTHER BORROWED VALUE
   * ON THIS EMBED ANSWERS THE OTHER WAY ═══
   *
   * FOOTER TEXT IS THE ONE PLACE ON AN EMBED DISCORD RENDERS NO MARKUP. It is
   * drawn as plain text: no bold, no code span, no `[label](url)`, no `<@id>`
   * mention, no `<t:…>` timestamp, and no linkified bare url. So the attack list
   * in `inert` — every item of which is about something Discord RENDERS — has
   * nothing to act on here, and wrapping the id in backticks would put two
   * literal backticks in the record rather than neutralise anything.
   *
   * NEWLINES ARE THE EXCEPTION AND THEY DO RENDER. A footer holding `\n` is
   * drawn on two lines, which is the same forgery `short` and `inert` strip out
   * of every other field: a value that looks like a second fact nobody recorded,
   * sitting under the bot's own footer. `short` collapses them, and it caps at
   * Discord's footer limit for the reason `FIELD_VALUE_CAP` exists — an embed
   * over the limit is refused whole, and a refused message is a moderation
   * record that does not exist.
   *
   * AND EMPTY MEANS ABSENT, as everywhere else on this embed. Discord refuses
   * `footer: { text: '' }` the way it refuses `thumbnail: { url: '' }`, so an id
   * that is not a usable string costs the footer rather than the record.
   */
  const footer = short(incident.incidentId, FOOTER_TEXT_CAP)

  return {
    title: COPY.title,
    color: COLOUR,
    fields: fields.filter((field) => field.value !== ''),
    ...(avatarUrl === null ? {} : { thumbnail: { url: avatarUrl } }),
    ...(renderable(at) ? { timestamp: new Date(at).toISOString() } : {}),
    ...(footer === '' ? {} : { footer: { text: footer } }),
  }
}

/** One row of components, as Discord's own record. */
export type ComponentRow = APIActionRowComponent<APIComponentInMessageActionRow>

/**
 * The console's page for one case.
 *
 * `encodeURIComponent` ON THE ID, matching the console's own builder
 * (`incidentHref` in lib/profileLink.ts). An incident id is a UUID today and
 * needs no escaping, which is exactly why doing it anyway is cheap: the id comes
 * out of a table this repo does not write, and a Next.js dynamic segment arrives
 * percent-decoded, so encoding here and nothing at the other end is the whole
 * contract.
 */
export function incidentUrl(origin: string, incidentId: string): string {
  return `${origin}/incidents/${encodeURIComponent(incidentId)}`
}

/**
 * The button, or nothing at all.
 *
 * THE ORIGIN IS `CONSOLE_URL` AND MUST NEVER BE `Config.ringmasterUrl`. That one
 * is `http://127.0.0.1:3000` — the server-to-server address the kick relay
 * concatenates onto, on a port closed to the internet — and a button built from it
 * opens the clicker's OWN machine. It fails in the worst available way: it looks
 * like a working link, it is in a permanent record, and what it looks like when
 * pressed is a console that is down. It is a PARAMETER rather than the constant
 * read directly, so a test can drive this offline against an origin it chose; the
 * one production caller is `installIncidentLog`, and there is a test on that line.
 *
 * A LINK BUTTON NEEDS NOTHING LISTENING. It carries a `url` and no `custom_id`, so
 * pressing it opens a page and sends this bot no interaction — which is what makes
 * it safe to put on a message from a background poller that has no interaction
 * handler anywhere near it.
 *
 * `incidentId` IS THE ID THE CASE WAS READ BY AND NOT THE ONE THE ROW CARRIES,
 * which is the caller's job and is stated here because the type cannot state it:
 * `string` is a claim about an attribute another repository writes, and
 * `encodeURIComponent` coerces whatever it is handed rather than refusing it. The
 * one production caller passes `incidentIdOf`'s validated answer — see `settle`.
 */
export function incidentRow(origin: string, incidentId: string): ComponentRow | null {
  const url = incidentUrl(origin, incidentId)

  if (url.length > BUTTON_URL_CAP) {
    // Dropped rather than cut: a truncated url is a button that silently opens
    // the wrong page, and an over-long one makes Discord refuse the whole
    // message — the record with it.
    log('warn', 'the console link for an incident was too long for a button', {
      incident: incidentId,
      length: url.length,
    })
    return null
  }

  return {
    type: ComponentType.ActionRow,
    components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label: COPY.button, url }],
  }
}

/* ------------------------------------------------------------------ *
 * The seams.
 * ------------------------------------------------------------------ */

/** Putting one record in the channel. The seam, so everything above runs offline. */
export interface IncidentPosts {
  send(embed: APIEmbed, components: readonly ComponentRow[]): Promise<void>
}

/**
 * The real one.
 *
 * `channels.fetch` RATHER THAN A CHANNEL RESOLVED ONCE AT STARTUP, exactly as
 * `announcer` in src/client.ts does it and for its reasons: fetch reads the cache
 * first, so the steady-state cost is nothing, and unlike a handle captured at boot
 * it survives the channel being recreated.
 *
 * IT THROWS WHEN IT CANNOT POST, WHICH IS THE OPPOSITE OF `announcer`. That one
 * logs and returns because a removal notice missed is a line missed; here the
 * caller has to know, because the cursor must not move over a record that was
 * never written. See `poll`.
 *
 * `allowedMentions: { parse: [] }` AT THE SEND, not left to the client-wide
 * default. Nothing in this embed is a mention today — the player is named by the
 * string the incident row carries — and this is the option that keeps that true
 * when somebody later puts `<@id>` in a field.
 */
export function logChannelPosts(client: Client, channelId: string): IncidentPosts {
  return {
    async send(embed, components) {
      const channel = await client.channels.fetch(channelId)

      if (channel === null || !channel.isSendable()) {
        throw new Error(`BLITZ_LOG_CHANNEL_ID ${channelId} is missing or cannot be posted to`)
      }

      await channel.send({
        embeds: [embed],
        ...(components.length === 0 ? {} : { components: [...components] }),
        allowedMentions: { parse: [] },
      })
    },
  }
}

/** Where an avatar comes from. The other seam. */
export interface Avatars {
  /** The account's avatar, or a rejection. Never null: Discord always has one. */
  urlFor(discordId: string): Promise<string>
}

/**
 * The real one.
 *
 * `displayAvatarURL()` AND NOT `avatarURL()`, checked against the installed
 * discord.js the way src/commands/index.ts checks it: the second returns
 * `string | null` for an account that has never set one, and the first falls back
 * to Discord's default avatar and always answers.
 */
export function clientAvatars(client: Client): Avatars {
  return {
    async urlFor(discordId) {
      const user = await client.users.fetch(discordId)
      return user.displayAvatarURL()
    },
  }
}

/**
 * Everything the poller needs from the world.
 *
 * THE `Pick` IS THE ACCESS POLICY WRITTEN WHERE A COMPILER READS IT, the same way
 * `BanRoleDeps` states the ban role's. This one can read incidents, read the
 * player registry, read the audit STREAM and read and write the bot's own state —
 * and it cannot write an incident, cannot write an audit row, cannot touch a ban
 * and cannot reach the maintenance window, however it is edited later.
 *
 * NOT BEING ABLE TO WRITE AN INCIDENT IS THE IMPORTANT ONE. This file is
 * downstream of a moderator's decision and its whole job is to describe one; the
 * day it can write to `ringmaster-incidents` it can close a case nobody closed.
 */
export interface IncidentLogDeps {
  readonly ddb: Pick<DdbWithAuditWindow, 'incidents' | 'players' | 'botState' | 'auditWindow'>
  readonly posts: IncidentPosts
  readonly avatars: Avatars
  /**
   * Where a PERSON reaches the console. `CONSOLE_URL`, at the one real call
   * site, and never `Config.ringmasterUrl` — see `incidentRow`.
   */
  readonly consoleOrigin: string
  readonly now?: () => number
}

export interface IncidentLog {
  /** One pass over the audit log. */
  poll(): Promise<void>
}

/**
 * The avatar for a case's subject, or null when there is not one to show.
 *
 * `discordIdFor` IS src/banrole.ts's, REUSED RATHER THAN REIMPLEMENTED. It
 * answers the same question about the same registry, and a second copy would be a
 * second opinion about which of somebody's Discord accounts is theirs — the newest
 * sighting by `lastSeen`, which is the whole of what `newestDiscordId` decides and
 * is not obvious enough to be worth deciding twice.
 *
 * `subjectLicense` IS ALREADY THE QUALIFIED KEY SHAPE — `license:abc…`, as the
 * console stores it and as `ringmaster-players` is keyed — so nothing here
 * qualifies it. That is cleaner than the ban path, where the audit log's target and
 * the bans table's key are not guaranteed to agree and banrole.ts has to try the
 * other shape.
 *
 * NONE OF THE THREE FAILURES STOPS THE POST, WHICH IS THE POINT. `'failed'` is a
 * registry read that did not answer, `null` is a player the game has never seen a
 * Discord account for — the ordinary case for anybody with the activity integration
 * switched off — and a rejected `users.fetch` is an account Discord will not tell
 * us about. All three give an embed with no thumbnail, and the case is still
 * recorded.
 *
 * AT MODULE SCOPE AND TAKING ITS TWO SOURCES, so the other half of blitz-bot#19
 * reuses it rather than closing over a poller it has nothing else to do with. It
 * is the same question about the same subject however the case reached us.
 *
 * ═══ IT TAKES `unknown`, WHICH IS THE FOURTH FAILURE AND WAS THE SILENT ONE ═══
 *
 * `subjectLicense` IS TYPED `string` AND THE TYPE IS A CLAIM ABOUT ANOTHER
 * REPOSITORY'S ROW. Every other borrowed value this module renders already knows
 * that — `inert` and `labelled` both take `unknown`, `verdictText` narrows on
 * `action` before it reaches `expiresAt`, and `resolvedAt` is range-checked —
 * and this was the one that did not. Handed a missing or non-string licence it
 * reached `discordIdIn` in src/banrole.ts, whose first statement is
 * `banKey.startsWith(prefix)`, and threw `TypeError` out of the middle of a
 * pass.
 *
 * AND THAT THROW WAS THE WORST-SHAPED ONE IN THE FEATURE. The call sits OUTSIDE
 * the `try` that wraps the send, so nothing caught it: it left `settle`, left
 * `onRow`, and left `pollAuditWindow` — which now wraps its consumers for
 * exactly this reason, but did not — so the pass rejected, the cursor never
 * moved, and the next pass read the same window, reached the same row and threw
 * again. One malformed row and the feed is dead for the life of the process.
 *
 * SO AN UNUSABLE LICENCE COSTS THE AVATAR AND NOTHING ELSE, which is the answer
 * the three failures below already give. There is no case in which a record is
 * worth less than a thumbnail.
 */
export async function avatarFor(
  players: Ddb['players'],
  avatars: Avatars,
  subjectLicense: unknown,
): Promise<string | null> {
  if (typeof subjectLicense !== 'string' || subjectLicense === '') {
    // A row that cannot say who its subject is, said once, where the owner
    // reads it. NOT silently: the record still posts and the console still has
    // the case, so this is the only place the malformed row is visible at all.
    log('warn', 'an incident carries no usable licence, so the record carries no avatar', {
      licence: subjectLicense,
    })
    return null
  }

  // This caller's own sentence, and it says what the failed read cost HERE: the
  // record still posts, without a thumbnail. The ban path's costs a ban going
  // unmarked and says so instead. See `discordIdFor`.
  const discordId = await discordIdFor(
    players,
    subjectLicense,
    'could not read the player registry, so no Discord account was resolved',
  )
  if (discordId === null || discordId === 'failed') return null

  try {
    return await avatars.urlFor(discordId)
  } catch (error) {
    // NOT "they have no account" — that is the `null` above, and it is a
    // different fact. This is Discord declining to tell us about one, which the
    // next pass may answer differently and which changes nothing about the
    // record either way.
    log('info', 'Discord would not answer about the offender, so the record carries no avatar', {
      licence: subjectLicense,
      member: discordId,
      error,
    })
    return null
  }
}

/** What one decision did, so a pass can budget and a test can assert. */
type Step = 'posted' | 'quiet' | 'stop'

export function createIncidentLog(deps: IncidentLogDeps): IncidentLog {
  const now = deps.now ?? Date.now

  /**
   * ═══ THE TWO BOUNDS, AND THE ONE THING THEY HAVE IN COMMON ═══
   *
   * BOTH ARE MEASURED FROM WHAT THIS PROCESS HAS ACTUALLY SEEN AND DONE, which
   * is why they live here — in the poller, across passes — rather than being
   * derived from a stamp on the row. `heldSince` is when this poller first found
   * a case the incident table still calls pending; `strikes` is how many passes
   * in a row have failed outright on a case. See `PENDING_HOLD_MS` and
   * `FAULT_LIMIT` for what each is bounding and why the units differ.
   *
   * NEITHER SURVIVES A RESTART, AND THAT IS THE POINT RATHER THAN A LIMITATION.
   * A bound written to DynamoDB would mean a case that ran out its budget while
   * the bot was down is dropped the instant the bot comes back, unretried —
   * exactly the bug the first of these two replaces.
   *
   * THEY HOLD ONE CASE AT A TIME IN THE ORDINARY RUN, because a case that is
   * held or faulting ends the walk, so the next pass reaches it and settles it
   * or bounds it out. `settled` is what empties them, and it is called on every
   * path the cursor moves over: posted, not in the table, held past its bound,
   * and faulted past its limit. An entry can outlive its case only if a case
   * AHEAD of it gets stuck first, which is a handful of strings until the
   * process restarts.
   */
  const heldSince = new Map<string, number>()
  const strikes = new Map<string, number>()

  /**
   * This case is finished with, however it ended. Forget both bounds for it.
   *
   * IT IS BOOKKEEPING AND NOT SEMANTICS, WHICH IS WORTH SAYING BECAUSE THE
   * OPPOSITE READS SO NATURALLY. "Clear the strikes on success" sounds like it
   * makes the bound count CONSECUTIVE failures rather than a running total — and
   * there is no history in which the two differ, because a case that succeeds
   * leaves the walk for good and is never offered again. A mutation that removed
   * this line changed no test and could not: it is here so that a process which
   * has run for a month does not hold one map entry per case it ever stumbled
   * on.
   */
  function settled(incidentId: string): void {
    heldSince.delete(incidentId)
    strikes.delete(incidentId)
  }

  /**
   * A pass failed outright on one case: hold the walk behind it, or give up.
   *
   * IT IS CALLED FROM THE TWO PLACES THAT COULD JAM THE FEED FOREVER — an
   * incident that could not be read and a record that could not be sent — and
   * from nowhere else. The `pending_review` branch does NOT come through here:
   * that is not a fault, it is two tables disagreeing, and it has its own bound
   * in its own unit. See `FAULT_LIMIT`.
   */
  function faulted(incidentId: string, fault: string): Step {
    const count = (strikes.get(incidentId) ?? 0) + 1
    strikes.set(incidentId, count)

    if (count < FAULT_LIMIT) return 'stop'

    log(
      'error',
      'the incident poll failed on the same case every pass, so it moved past it and no record was posted',
      { incident: incidentId, fault, attempts: count, limit: FAULT_LIMIT },
    )

    settled(incidentId)
    return 'quiet'
  }

  /**
   * One case, decided from the incident row as it stands right now.
   *
   * THE AUDIT ROW'S `outcome` IS NEVER CONSULTED, HERE OR ANYWHERE. It says
   * `pending` on every row this poller will ever see.
   *
   * IT TAKES THE CASE ID AND NOTHING ELSE. It used to take the audit row's `ts`
   * as well, to measure the pending hold from — see `PENDING_HOLD_MS` for why
   * that clock was the wrong one and what it cost after an outage. Both bounds
   * are now kept by the poller in `heldSince` and `strikes`, so there is nothing
   * about the trigger this function needs.
   */
  async function settle(incidentId: string): Promise<Step> {
    const read = await deps.ddb.incidents.get(incidentId)

    if (!read.ok) {
      log('warn', 'could not read an incident, so nothing was posted about it', {
        incident: incidentId,
        failure: read.failure.kind,
        detail: read.failure.message,
      })

      // Retried, and bounded: a read that fails every pass forever would stop
      // the feed at this row for the life of the process. See `FAULT_LIMIT`.
      return faulted(incidentId, read.failure.kind)
    }

    const incident = read.value

    if (incident === null) {
      /**
       * THE LOG NAMES A CASE THE TABLE DOES NOT HAVE. Nothing in the console
       * deletes an incident, so this is either a row removed by hand or an
       * `incidentId` in the audit log that is not the key of anything — and the
       * second explanation is silent in every other way, which is what makes it
       * worth a line rather than a skip.
       *
       * MOVING ON IS SAFE HERE AND IT IS THE CONSISTENT READ THAT MAKES IT SO.
       * `incidents.get` asks for the item itself and not a replica of it, so
       * `null` is not "the write has not arrived yet" — it is the table saying
       * there is no such row, which no number of retries turns into one. This is
       * the branch that separates it from the `pending_review` case below, where
       * the row DOES exist and may yet change.
       */
      log('warn', 'an incident.resolve row names a case that is not in the table', {
        incident: incidentId,
      })

      settled(incidentId)
      return 'quiet'
    }

    if (incident.state !== 'resolved') {
      /**
       * ═══ THE TRIGGER SAID CLOSED AND THE CASE IS NOT ═══
       *
       * A resolve that failed or lost its conditional write leaves the row at
       * `pending_review`, and the console writes the audit row for an admin's
       * closure only AFTER that write succeeds — so this is the two repositories
       * disagreeing about a case, which is exactly the kind of drift that is
       * invisible everywhere else.
       *
       * AND IT IS NOT A STALE READ. The `GetItem` behind this is strongly
       * consistent, so there is no third explanation in which waiting a moment
       * and asking again is the same question. Either the case really is open
       * and this row should not have been written, or it is about to be closed
       * properly on a retry.
       *
       * SO THE CURSOR STAYS BEHIND IT, BOUNDED. Moving past it posts nothing
       * about a case that may be resolved thirty seconds from now, and nothing
       * in this file ever comes back for it; holding forever silences every
       * record behind it. `PENDING_HOLD_MS` is where those two meet, and both
       * sides of it are stated there.
       *
       * THE CLOCK STARTS THE FIRST TIME THIS POLLER SEES THE CASE, and not at
       * the console's stamp on the audit row. Measured the old way, every
       * pending case in a backlog older than the bound was already past it on
       * first sight, so an outage or a deploy gap dropped the whole backlog in
       * one pass without retrying any of it once — which is precisely the
       * situation the hold is written for.
       */
      const since = heldSince.get(incidentId) ?? now()
      heldSince.set(incidentId, since)

      const held = now() - since

      if (held < PENDING_HOLD_MS) {
        log('warn', 'an incident.resolve row is about a case that is not resolved', {
          incident: incidentId,
          state: incident.state,
        })
        return 'stop'
      }

      log(
        'error',
        'an incident.resolve row named an unresolved case for too long, so the incident poll moved past it and no record was posted',
        { incident: incidentId, state: incident.state, heldMs: held, boundMs: PENDING_HOLD_MS },
      )

      settled(incidentId)
      return 'quiet'
    }

    const avatarUrl = await avatarFor(deps.ddb.players, deps.avatars, incident.subjectLicense)

    /**
     * ═══ THE BUTTON IS BUILT FROM THE ID THIS PASS ASKED THE TABLE FOR ═══
     *
     * IT USED TO BE `incident.incidentId`, THE ROW'S OWN COPY, AND THAT COPY IS
     * ANOTHER REPOSITORY'S ATTRIBUTE. Nothing guarded it before
     * `encodeURIComponent`, which coerces rather than refusing: an id of `42`
     * posted a live-looking button at `/incidents/42` and `null` posted one at
     * `/incidents/null`. A button in a permanent record that opens a case which
     * does not exist is the same failure shape as the loopback origin — it looks
     * like a working link and it reads as a console that is down.
     *
     * AND THE FALLBACK WENT AT THE SAME MOMENT, WHICH IS WHAT MADE IT WORTH
     * FIXING HERE RATHER THAN GUARDING THERE. The footer is the id in plain text
     * and `short` refuses a non-string, so exactly when the button was wrong the
     * record ALSO lost the traceability the footer's own comment leans on: a post
     * about a case with no usable way back to it, and nothing anywhere saying so.
     *
     * `incidentId` IS ALREADY KNOWN GOOD AND CANNOT DISAGREE WITH THE ROW. It is
     * `incidentIdOf`'s answer — a non-empty string, refused otherwise — and it is
     * the key `incidents.get` was called WITH at the top of this function, so the
     * button now opens the case this record is about by construction rather than
     * by trusting an attribute.
     */
    if (incident.incidentId !== incidentId) {
      // A row keyed by one case and carrying another's id is the console's two
      // writers disagreeing about which case this is, and it is invisible
      // everywhere else — the record still posts, and the button is right.
      log('warn', 'an incident row carries an id that is not the key it was read by', {
        incident: incidentId,
        carried: incident.incidentId,
      })
    }

    const row = incidentRow(deps.consoleOrigin, incidentId)

    try {
      await deps.posts.send(incidentEmbed(incident, avatarUrl), row === null ? [] : [row])
    } catch (error) {
      /**
       * THE CURSOR STAYS BEHIND THIS ROW, which is what makes a failed send a
       * retry rather than a lost record. The cost of getting that backwards is a
       * moderation record that never existed and nothing anywhere saying so; the
       * cost of this way is at most one duplicate embed, on a send that failed
       * after Discord had already accepted it. The status channel folds a
       * repeating fault into one message, so a channel the bot genuinely cannot
       * post to is one line rather than one every half minute.
       *
       * AND THAT FOLDING IS WHY THE RETRY IS BOUNDED. A channel the bot has lost
       * Send Messages in, or an embed Discord refuses every time, is a `stop` on
       * this row on every pass forever — the feed silent, and the only sign of
       * it a status line that stops repeating. `FAULT_LIMIT` ends that: one
       * record dropped loudly, and every record behind it posted.
       */
      log('warn', 'could not post the record for a resolved incident', {
        incident: incidentId,
        error,
      })

      return faulted(incidentId, 'send')
    }

    log('info', 'posted the record for a resolved incident', {
      incident: incidentId,
      licence: incident.subjectLicense,
      avatar: avatarUrl !== null,
      button: row !== null,
    })

    settled(incidentId)
    return 'posted'
  }

  /**
   * The sentences this consumer's walk says. See `AuditPollMessages`.
   *
   * VERBATIM WHAT THEY WERE. Moving the walk into src/auditpoll.ts moved no
   * words: three of these reach the owner's status channel, where "the incident
   * poll" and "the game-ban poll" are the two things he needs told apart.
   */
  const MESSAGES: AuditPollMessages = {
    cursorUnreadable: 'could not read the incident poll cursor, so nothing was polled',
    /**
     * NO CURSOR MEANS START HERE, NOT START AT THE BEGINNING, AND THAT IS THIS
     * FEATURE'S IDEMPOTENCE STORY IN ONE LINE. A poller that began at the start
     * of the log would re-announce months of closed cases into the moderation
     * channel on every deploy, which is a channel nobody can read afterwards.
     * The cost is stated rather than hidden: cases resolved before the first
     * start are never posted about, and the record they belong to is `/audit` in
     * the console.
     */
    noCursorYet:
      'no incident poll cursor yet, so cases resolved from now on will be posted and earlier ones will not',
    /**
     * THE SENTENCE SAYS "POSITION" AND NOT "NUMBER", AND THAT IS A CORRECTION
     * RATHER THAN A REWORD. `''`, `' '` and `'0'` all reach this line now — see
     * `cursorAt` in src/auditpoll.ts — and telling the owner that `0` is not a
     * number, in the channel he goes to when something is wrong, would be a
     * false statement in the one place a false statement costs an evening.
     */
    cursorUnusable:
      'the incident poll cursor is not a position in the log, so polling restarts from now',
    windowUnreadable: 'could not read the audit log, so no incident was posted this pass',
    cursorUnsaved: 'the incident poll finished but its cursor could not be saved',
    rowWithoutSortKey: 'an audit row carries no sort key, so the incident poll stopped',
    /**
     * THE SEVENTH SENTENCE, AND IT IS ABOUT A BUG RATHER THAN A TABLE. Every
     * other line here names something outside this process that did not answer;
     * this one says the code in this file threw where the walk was awaiting it,
     * which is the only one of the seven that is nobody else's fault. Worded so
     * the owner can tell it apart from the five that are.
     */
    consumerThrew: 'the incident poll threw on one case, so it stopped at that row',
  }

  async function poll(): Promise<void> {
    let posts = 0
    let reads = 0
    const decided = new Set<string>()

    await pollAuditWindow(
      { ddb: deps.ddb, now },
      {
        cursorKey: CURSOR_KEY,
        messages: MESSAGES,

        room: () => posts < MAX_POSTS && reads < MAX_INCIDENT_READS,

        /**
         * NO SILENCE PROBE HERE, DELIBERATELY. banrole.ts asks whether the
         * partition still holds anything after `PARTITION_SILENCE_MS`; both
         * consumers read one partition through one `AUDIT_PK`, so the fault is
         * one fault, and a second alarm for it would be a second message in the
         * status channel about the same thing — which is how a channel stops
         * being read. Absent rather than empty, so the omission is visible.
         */

        onRow: async (row): Promise<RowStep> => {
          if (!isIncidentTrigger(row)) return 'done'

          // One permanent ban, up to fifty of these. See `closedByABan`.
          if (closedByABan(row)) return 'done'

          const incidentId = incidentIdOf(row)
          if (incidentId === null) {
            log('warn', 'an incident.resolve row names no incident, so nothing was posted', {
              ts: row.ts,
            })
            return 'done'
          }

          // One post per case per pass. The console writes an admin's closure row
          // only after the closure succeeds, so a case cannot legitimately be
          // resolved twice — this is the guard for a log that says otherwise.
          if (decided.has(incidentId)) return 'done'
          decided.add(incidentId)
          reads++

          const step = await settle(incidentId)
          if (step === 'stop') return 'stop'
          if (step !== 'posted') return 'done'

          posts++

          /**
           * ═══ THE CURSOR IS WRITTEN AFTER EVERY RECORD, NOT ONCE A PASS ═══
           *
           * A POST CANNOT BE UNDONE, WHICH IS THE WHOLE DIFFERENCE FROM THE
           * BAN-ROLE POLLER. That one answers `done` to everything because a role
           * added twice is a role; this one puts a permanent message in a channel
           * people read. A pass may post ten, and a crash or a deploy restart
           * between the tenth send and a single write at the end would replay all
           * ten into the moderation channel on the next pass. Ten duplicate
           * moderation records is loud, and the fix costs one small write per
           * record — a restart now resumes after the last record actually POSTED
           * rather than after the last completed pass.
           *
           * A FAILED SEND STILL LEAVES THE CURSOR BEHIND ITS ROW: `settle`
           * answers `stop`, this returns before the write, and the next pass tries
           * that record again. Worst case one duplicate, on a send that failed
           * after Discord had already accepted it. A moderation record that never
           * existed, with nothing anywhere saying so, is worse.
           */
          return 'persist'
        },
      },
    )
  }

  return { poll }
}

/* ------------------------------------------------------------------ *
 * Wiring.
 * ------------------------------------------------------------------ */

/**
 * Watch the console's audit log and post the moderation record for closed cases.
 *
 * NOTHING AT ALL WHEN `BLITZ_LOG_CHANNEL_ID` IS UNSET, which is the rule every
 * optional channel in this bot follows and matters most here: with nowhere to post
 * there is nothing to poll for, so `ringmaster-audit` is not read at all and this
 * process makes no AWS call it would otherwise make twice a minute. Null is not a
 * degraded mode.
 *
 * ═══ THE ONE LINE THIS FUNCTION EXISTS TO GET RIGHT ═══
 *
 * `consoleOrigin: CONSOLE_URL`, AND NEVER `config.ringmasterUrl`. That one is the
 * loopback the kick relay calls, `http://127.0.0.1:3000`, on a port closed to the
 * internet: a button built from it opens the CLICKER's own machine, looks like a
 * working link, sits in a permanent record, and fails in the way that reads as a
 * console outage. Nothing else in this file can make that mistake — `incidentRow`
 * is handed an origin and has no access to the config at all — so this assignment
 * is the whole of the exposure, and there is a test that drives this function with
 * no injected watcher and reads the button's url off the message that comes out.
 *
 * IT IS A CONSTANT AND NOT A VARIABLE. A `BLITZ_RINGMASTER_PUBLIC_URL` was
 * drafted for this line and dropped before it shipped, once `CONSOLE_URL` was
 * found already in src/commands/profile.ts: there is one Ringmaster console, so
 * the variable bought nothing, added a boot failure on a malformed value, and
 * gave the owner something he had to set correctly or silently lose the button
 * on every record. See src/console.ts.
 *
 * THE TIMER IS UNREF'D AND GUARDED AGAINST RE-ENTRY, exactly as `watchMaintenance`
 * and the ban-role passes are: a pass still running must not have a second started
 * on top of it, and a pending timer must not be the thing that keeps the process
 * alive through a shutdown.
 */
export function installIncidentLog(
  client: Client,
  config: Config,
  ddb: IncidentLogDeps['ddb'],
  options: { pollMs?: number; watcher?: IncidentLog } = {},
): void {
  const channelId = config.logChannelId
  if (channelId === null) return

  const watcher =
    options.watcher ??
    createIncidentLog({
      ddb,
      posts: logChannelPosts(client, channelId),
      avatars: clientAvatars(client),
      consoleOrigin: CONSOLE_URL,
    })

  client.once(Events.ClientReady, () => {
    let running = false

    const tick = (): void => {
      if (running) return
      running = true

      void watcher
        .poll()
        .catch((error: unknown) => {
          // `poll` is written not to throw. The `finally` is the structural
          // guarantee that an edit which makes it throw cannot latch `running`
          // on and stop the loop for the life of the process.
          log('error', 'the incident poll threw', { error })
        })
        .finally(() => {
          running = false
        })
    }

    const timer = setInterval(tick, options.pollMs ?? POLL_MS)
    timer.unref()
    tick()
  })
}
