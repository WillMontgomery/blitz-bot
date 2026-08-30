import { log } from './log.ts'

/**
 * Finding Discord invites in a message.
 *
 * TWO HALVES, DELIBERATELY SPLIT. `findInviteCodes` is a pure function of one
 * string; `scanMessage` is the half that talks to Discord, and it only does so
 * through a resolver the caller hands it. The split is the whole reason the
 * hard part can be tested — the pattern is the thing that decides whether this
 * bot works, and it gets to be exercised against a hundred hostile strings
 * offline instead of against a live guild.
 *
 * THE TWO FAILURE DIRECTIONS ARE NOT SYMMETRIC, and every judgement call in
 * this file follows from that one fact. A code we fail to extract is an advert
 * for somebody else's server left standing in the channel — precisely the
 * thing the bot exists to remove, and nothing downstream can recover from it,
 * because nothing downstream ever hears about the message again. A code we
 * extract that was never an invite costs one API lookup, comes back
 * unresolved, and is never deleted. So the pattern is loose about everything
 * to the LEFT of the hostname and strict about everything to the right of it.
 *
 * REJECTED: FINDING URL-ISH TOKENS AND HANDING THEM TO `new URL()`. Most
 * invites are typed without a scheme, and `new URL('discord.gg/abc123')`
 * throws rather than parsing — so the scheme would have to be guessed back on
 * before parsing, which is the same string surgery this does, with an
 * exception-throwing constructor in the middle of it.
 *
 * REJECTED: MATCHING WHAT DISCORD'S OWN LINKIFIER WOULD LINK. It is not
 * exposed anywhere, and copying it would mean ignoring an invite inside a code
 * fence — which is exactly where somebody who has been deleted once will put
 * the next one.
 */

/**
 * The pattern is BUILT FROM NAMED PIECES rather than written as one literal,
 * and the reason is the bug below. The old pattern was a single literal, and
 * the thing that was wrong with it — a bare `\/` where the boundary between a
 * host and a path belongs — was invisible in eighty characters of punctuation.
 * Each piece named here is a rule that can be read, and the rule that was
 * missing is now the one with the longest comment on it.
 */

/**
 * An optional markdown backslash escape, allowed before each literal
 * punctuation character in the pattern that still needs one: the dot and the
 * port's colon.
 *
 * DISCORD RENDERS `discord\.gg/abc123` AS A WORKING LINK. Its markdown drops a
 * backslash that precedes punctuation, so the escape survives the round trip
 * from what a spammer types to what a reader clicks — and the raw content this
 * function is handed is the version WITH the backslashes in it. Handling it was
 * a decision, and it is the same decision as the port below: `\.` is a
 * one-character bypass of a pattern that only knows about a bare dot, and this
 * file's whole premise is that a miss costs an advert left standing while a
 * false positive costs one lookup that comes back unresolved.
 *
 * ALLOWED EVERYWHERE A DELIMITER APPEARS, not just on the host dot. Somebody who
 * has just learned that `discord\.gg` gets through will try `discord\.gg\:443`
 * next, and a rule applied to one delimiter out of two is the same bug in a new
 * place.
 *
 * THE SLASHES NO LONGER USE IT, and that is not an exception carved out of the
 * rule above. A backslash in front of a slash is still handled — by `SLASHES`
 * below, which absorbs the backslash for an entirely different reason and comes
 * out at the same answer. See the note there: keeping `ESC` on the slash as well
 * is what makes that pattern ambiguous, and ambiguous is what makes it explode.
 */
const ESC = '\\\\?'

/**
 * THE DOT THAT SEPARATES HOSTNAME LABELS IS FOUR CHARACTERS, not one.
 *
 * RFC 3490 NAMES EXACTLY THIS SET, and the WHATWG URL parser inherits it through
 * UTS #46: U+3002 IDEOGRAPHIC FULL STOP, U+FF0E FULLWIDTH FULL STOP and U+FF61
 * HALFWIDTH IDEOGRAPHIC FULL STOP are each mapped to `.` before a host is
 * looked up. `https://discord。gg/abc123` is therefore not a lookalike OF the
 * real link — after mapping it IS the real link. Measured with node's own URL
 * parser, all three normalise to the host `discord.gg` and the path
 * `/abc123`.
 *
 * THIS WAS REFUSED ONCE, on the grounds that a unicode host is an IDN question
 * wanting the real normalisation this pattern does not have. That was wrong
 * about the facts rather than about the principle: the separator set is CLOSED
 * and has three members, written down in a standard, so it is a rule about a
 * class in exactly the way the boundary below is — not a character bolted on for
 * one instance.
 *
 * WHAT IS STILL NOT COVERED, and the distinction is the whole reason this stops
 * at the dot: the LETTERS of a host are mapped too, so `ｄｉｓｃｏｒｄ.gg` is
 * also a working link and still yields nothing here. That set is not closed — it
 * is the whole compatibility mapping, and spelling `discord` as seven two-way
 * character classes would cover the fullwidth block and miss the next one. It
 * wants a normalisation pass over a candidate host, which is a larger change
 * than this file. Written down so the gap is a known one.
 *
 * SPELLED `\uXXXX` IN THE PATTERN ITSELF, whatever the prose above does. Three
 * dots that differ only in width are three characters nobody can tell apart in a
 * diff, and this is a security pattern that has to be readable to be reviewed.
 * The hostile-form table spells them the same way and for the same reason.
 */
const DOT = `${ESC}[.\\u3002\\uFF0E\\uFF61]`

/**
 * ONE OR MORE SEPARATORS between the hostname and the path, or between path
 * segments.
 *
 * `//` IS NOT A TYPO TO A URL PARSER. `https://discord.gg//abc123` loads the
 * same invite as one slash does, and `discord.gg/invite//abc123` likewise.
 *
 * A BACKSLASH IS A SLASH TO A URL PARSER. The WHATWG spec folds `\` into `/`
 * for special schemes, so `https://discord.gg\abc123` normalises to
 * `https://discord.gg/abc123` and loads the invite — measured, along with
 * `\invite\abc123` and `\\abc123`, which come out as `/invite/abc123` and
 * `//abc123`. That form yielded NOTHING, which is an advert left standing.
 *
 * THE TWO READINGS OF A BACKSLASH COEXIST, AND THAT IS WHY THIS IS A CHARACTER
 * CLASS AND NOT AN ALTERNATION. A backslash was already meaningful here as
 * Discord's markdown escape, where `\/` is one escaped slash; it is now also a
 * separator in its own right, where `\/` is two separators. Neither reading has
 * to win, because the only thing either is allowed to conclude is "the separator
 * run continues", and one slash and two have meant the same thing here from the
 * start. `[\\/]+` says exactly that and never has to decide which reading
 * applies.
 *
 * SPELLING IT AS THE ALTERNATION `(?:\\?/|\\)+` IS THE BUG THIS AVOIDS, and it
 * is the obvious way to write the fix. There the two readings are two distinct
 * PARSES of `\/`, so a run of k of them has 2^k parses and the engine walks all
 * of them before giving up on a string that ends in something no code can start
 * with. Measured on that form: 9.8ms at k=20, 38.4ms at 22, 153ms at 24 — a
 * clean doubling per token, so a 40-token run is hours. The class does k=5000 in
 * 0.04ms. This is the same catastrophic backtracking the timed test guards, and
 * it arrives through the one edit that looks like a one-character fix.
 */
const SLASHES = `[\\\\/]+`

/**
 * EVERYTHING THAT MAY LEGALLY SIT BETWEEN THE HOSTNAME AND THE PATH. This is
 * the fix, and it is deliberately a RULE ABOUT A CLASS rather than four
 * patches.
 *
 * THE BUG: the pattern used to demand a literal `/` immediately after the
 * hostname. Anything a URL allows in between therefore defeated it, and the
 * cheapest of those is a port — `https://discord.gg:443/abc123` is the same
 * link, renders identically in the client, and yielded NOTHING. That is a
 * one-token bypass, and a bypass of the invite scanner is an advert for
 * somebody else's server left standing in the channel, which is the one failure
 * this file exists to prevent. `https://discord.com:443/invite/x`,
 * `https://discord.gg./x` and `https://discord.gg//x` were the same bug wearing
 * three other hats.
 *
 * DO NOT PATCH THE INSTANCES. The four forms above were found by hand; the
 * fifth would not have been. What goes between a host and a path is a closed
 * set the URL grammar already writes down, so it is written down here instead
 * of enumerated: an optional FQDN ROOT DOT (`discord.gg.` names the identical
 * host — the trailing dot is the DNS root and resolvers strip it), an optional
 * `:PORT`, and then the slashes. In that order, because that is the order a URL
 * puts them in, and in any combination — `discord.gg.:443//x` is all three at
 * once and is one string, not a fourth case.
 *
 * THE PORT'S DIGITS MAY BE ABSENT. `https://discord.gg:/abc123` is a valid URL
 * with an empty port, meaning the scheme's default; browsers normalise it away
 * and load the invite. `\d*` rather than `\d+` costs nothing and closes the
 * variant somebody would otherwise reach for the day `:443` stops working.
 *
 * THE UNICODE FULL STOP AND PERCENT-ENCODING WERE ONCE EXCLUDED HERE, on the
 * grounds that they are questions about the HOSTNAME rather than about the
 * boundary after it and want a real normalisation. The second half of that was
 * right and the first half was the mistake: they are both covered now, and
 * neither one is a character bolted into this rule. The unicode dots are a
 * closed set that belongs to `DOT`; percent-encoding is a normalisation, so it
 * is done as one, to the message, before the pattern ever runs. See
 * `percentDecode`.
 */
const AFTER_HOST = `(?:${DOT})?(?:${ESC}:\\d*)?${SLASHES}`

/**
 * The pattern.
 *
 * HOST AND PATH ONLY. There is no `https?://` branch and no `www\.` branch,
 * and their absence is the design rather than an omission: an invite is
 * identified by its host and path, so everything to the left of `discord` is
 * somebody else's business. One rule then covers `https://discord.gg/x`,
 * `http://`, `www.`, the `canary.` and `ptb.` hosts that serve real invites,
 * and the bare `discord.gg/x` that most people actually type. A branch per
 * prefix is four things to keep in step, and the day a fifth prefix shows up
 * it fails silently.
 *
 * THE LOOKBEHIND IS THE ONLY LEFT-HAND RULE, and it exists for one case:
 * `mydiscord.gg/abc123` and `notdiscord.com/invite/x` are other people's
 * domains. A hostname label ends at a dot, so a preceding letter, digit or
 * hyphen means this is the tail of a longer label and not Discord. A preceding
 * DOT is fine — that is a subdomain, and anything under `discord.gg` belongs
 * to whoever controls that zone, which is Discord.
 *
 * `_` IS NOT IN THE LOOKBEHIND even though it reads like a word character.
 * `_discord.gg/abc123_` is how Discord's own markdown writes italics, it
 * renders as a working link, and treating the underscore as part of a hostname
 * would hand every spammer a two-character bypass.
 *
 * THE CODE CLASS EXCLUDES `_` AND `.` FOR THE SAME REASON READ BACKWARDS.
 * Generated codes are alphanumeric and vanity codes add hyphens; neither has
 * ever contained a dot or an underscore. Leaving both out is what makes
 * `discord.gg/abc123.` yield `abc123`, and what stops `_discord.gg/abc123_`
 * yielding a code with an underscore welded to the end — which would resolve
 * to nothing and quietly let the invite stand.
 *
 * `invite/` IS OPTIONAL ON THE `.gg` HOST because `discord.gg/invite/abc123`
 * is a real and working form of the link. Without that branch the extracted
 * code is the literal string `invite`, which resolves to nothing, which lets
 * the message through.
 *
 * CASE-INSENSITIVE ON THE DOMAIN, CASE-PRESERVING ON THE CODE. `DISCORD.GG`
 * is the same host; `AbC123` and `abc123` are two different servers.
 *
 * NO QUANTIFIER HERE NESTS INSIDE ANOTHER AND NO REPEATED PIECE IS AMBIGUOUS,
 * and both are properties to preserve rather than coincidences. This regex is
 * run against attacker-chosen strings of up to 4000 characters on the message
 * handler's own path, so a pattern that backtracks exponentially is a way to
 * stop the bot with one post — the same outage the lookup cap below was fitted
 * for, reached through the CPU instead of through the API budget. Writing the
 * separator run as `(?:[\\/]+)+` is enough to do it, and so is the alternation
 * `(?:\\?/|\\)+` that `SLASHES` explains at length, which is worse because it
 * looks like the natural way to say what it says. Both are still correct fixes
 * for every form the tests list, which is exactly why neither is caught by
 * reading. There are timed tests pinning this, one per pass; keep them passing.
 */
const INVITE = new RegExp(
  `(?<![A-Za-z0-9-])` +
    `(?:discord${DOT}gg${AFTER_HOST}|discord(?:app)?${DOT}com${AFTER_HOST}invite${SLASHES})` +
    `(?:invite${SLASHES})?` +
    `([A-Za-z0-9-]+)`,
  'gi',
)

/**
 * A well-formed percent escape. Global because `percentDecode` replaces every
 * one of them; `String.prototype.replace` resets `lastIndex` on a global regex
 * itself, so this constant carries no state between calls the way the `exec`
 * loop `findInviteCodes` avoids would.
 */
const PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/g

/**
 * The message as a URL parser would read it: ONE pass of percent-decoding.
 *
 * `https://discord.gg/%61%62%63` yielded nothing, because an invite code is
 * alphanumeric and `%` is not. The fix is not to teach the code class about
 * `%` — that extracts the string `%61%62%63`, which no resolver can look up, so
 * the bot would find the invite and then be unable to say anything about it.
 * Decoding the message and running the UNCHANGED pattern over the result gets
 * the code Discord would see, and one rule then also covers `discord%2Egg/x`
 * (measured: node's URL parser resolves that host to `discord.gg`) and
 * `discord.gg/%69%6E%76%69%74%65/x`, which are the same trick moved onto the
 * host dot and onto the path. A `%` in the code class would have missed both.
 *
 * LOWER CONFIDENCE THAN THE REST OF THIS FILE, SAID PLAINLY. `new URL()` does
 * NOT decode a path — measured, the path stays `/%61%62%63` — so whether
 * Discord's own router resolves that to the invite `abc` is not something this
 * repo has verified, and it cannot be verified offline. It is done anyway
 * because the two directions are not the same size: if Discord decodes, leaving
 * this out is an advert left standing, which is unrecoverable. If it does not,
 * the cost is one lookup spent on a message that spelled a foreign guild's
 * invite code out in hex, and a deletion still only ever follows a CONFIRMED
 * foreign guild.
 *
 * BYTE-WISE, AND DELIBERATELY NOT `decodeURIComponent`. That function throws on
 * the WHOLE string for one malformed escape, so `100% sure, discord.gg/%61%62%63`
 * would take the entire pass down with it — a bypass costing four characters of
 * prose, and one nobody would ever see reported. This rewrites well-formed
 * escapes only and cannot throw. It is not UTF-8 aware and does not need to be:
 * a multi-byte sequence decodes to characters that can be part of neither a
 * hostname nor a code, so getting them right would change no answer.
 *
 * ONCE, NOT TO A FIXED POINT, because a browser decodes a path once. `%2561` is
 * the literal text `%61` to every client that will ever load it, and decoding
 * until nothing changes would invent invites out of text nobody can click.
 */
function percentDecode(content: string): string {
  if (!content.includes('%')) return content

  return content.replace(PERCENT_ESCAPE, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
}

/**
 * Every invite code in a message, in the order they appear, each one once.
 *
 * READ TWICE: ONCE AS POSTED AND ONCE DECODED, and the union of the two. Neither
 * pass is redundant. The raw text is what a reader copies, and the decoded text
 * is what a client resolves; a form that only one of them can see is a form the
 * other has to be there to catch, and this file's premise is that a miss is the
 * failure nothing downstream can recover from. The second pass is skipped
 * outright when there is no `%` in the message, which is nearly every message,
 * so the ordinary path still runs the pattern exactly once.
 *
 * THE PRICE, WHICH IS THE CHEAP DIRECTION: a code half-written in hex is seen
 * twice and differently. `discord.gg/ab%63123` yields `ab` from the raw pass and
 * `abc123` from the decoded one. The junk half resolves to nothing and is never
 * deleted on, which is the same bargain every other loose rule in this file
 * takes.
 *
 * DEDUPLICATION IS CASE-SENSITIVE, unlike the domain match above. Two codes
 * that differ only in case are two different invites to two different guilds,
 * and folding them together would resolve one and delete on behalf of the
 * other.
 */
export function findInviteCodes(content: string): string[] {
  const seen = new Set<string>()
  const codes: string[] = []

  collectInto(content, seen, codes)

  const decoded = percentDecode(content)
  if (decoded !== content) collectInto(decoded, seen, codes)

  return codes
}

/**
 * One pass of the pattern over one string, appending what is new.
 *
 * `matchAll` RATHER THAN A `while (re.exec(...))` LOOP over a module-level
 * regex. A global regex carries `lastIndex` between calls, so the loop form on
 * a shared constant returns different answers on the second call with the same
 * input — the classic version of this bug scans every other message. `matchAll`
 * works on its own clone and cannot do that, which is also what makes calling
 * this twice in a row safe.
 */
function collectInto(content: string, seen: Set<string>, codes: string[]): void {
  for (const match of content.matchAll(INVITE)) {
    // The group cannot be absent when the pattern matched, but the compiler is
    // told to assume otherwise and this is a regex over hostile input — the one
    // place in the process where "it must be there" is worth not asserting.
    const code = match[1]
    if (code === undefined) continue

    if (seen.has(code)) continue
    seen.add(code)
    codes.push(code)
  }
}

/** Answers "which guild is this code for", or null if it cannot say. */
export type InviteResolver = (code: string) => Promise<string | null>

/**
 * The most distinct codes one message is allowed to cost in lookups.
 *
 * THIS IS A FUSE, AND IT WAS FITTED AFTER SOMEBODY MEASURED THE BUG. The scan
 * below used to resolve every distinct code a message carried, with no ceiling.
 * Packed tight, an ordinary 2000-character message holds 147 distinct codes and
 * a 4000-character one holds 290 — counted with this file's own pattern — and
 * every one of them was a lookup fired for a single post. Discord's global
 * budget is 50 requests a second, so one crafted message rate-limited the whole
 * process, and every legitimate deletion queued behind it stalled with it. The
 * bot's own moderation is the first thing that breaks.
 *
 * TEN, BECAUSE NO HONEST MESSAGE NEEDS MORE. A real post shares one or two
 * invites and the loudest genuine advert anybody has posted carries a handful.
 * A message with more distinct codes than this is not a message a higher cap
 * would serve better — it is the thing the cap exists for, which is why going
 * over it is reported rather than quietly absorbed, and why the caller treats
 * the report as grounds to remove the message rather than as a note.
 */
const MAX_LOOKUPS = 10

/**
 * How long an answer stays good, and how many are kept.
 *
 * SHORT, because the thing being remembered is a live fact about somebody
 * else's guild. A minute is long enough to cover a spam burst — which arrives
 * in seconds, not hours — and short enough that nothing here is ever badly
 * stale.
 *
 * SMALL, because the keys are strings chosen by whoever is posting. See the
 * cache below: bounded is the whole point.
 */
const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 256

/** A bounded, expiring memory of answers Discord has already given. */
export interface InviteCache {
  /** The remembered guild id for a code, or undefined if we have to ask. */
  get(code: string): string | undefined
  /** Remember an answer. Only ever called with a real guild id. */
  set(code: string, guildId: string): void
  /**
   * How many answers are held right now.
   *
   * HERE SO THE BOUND CAN BE ASSERTED. Boundedness is the property that keeps a
   * weeks-long process from leaking on strings a stranger chose, and a test
   * cannot prove it from the outside without being able to look.
   */
  readonly size: number
}

export interface InviteCacheOptions {
  /** How long an entry stays good. Defaults to a minute. */
  ttlMs?: number
  /** How many entries are held before the oldest is dropped. */
  maxEntries?: number
  /** The clock, so expiry can be driven without waiting for one. */
  now?: () => number
}

/**
 * One spammer, one lookup.
 *
 * THE CAP ABOVE BOUNDS WHAT ONE MESSAGE COSTS; THIS BOUNDS WHAT ONE CODE COSTS.
 * The common shape of an attack is not two hundred codes in one message, it is
 * one code posted into fifty channels in a minute — fifty messages, each well
 * under the cap, each asking Discord a question we already have the answer to.
 * The cap alone does nothing about that; this does.
 *
 * KEYED ON THE CODE ALONE, and that is safe precisely because what is stored is
 * Discord's answer — the guild the invite points at — and never our verdict
 * about it. The comparison against `ourGuildId` still happens on every scan, so
 * one cache can serve every guild this process moderates without carrying a
 * decision from one guild into another.
 *
 * ONLY ANSWERS ARE REMEMBERED. A null, an empty string and a throw all mean "we
 * did not find out", and remembering those would be remembering the wrong thing
 * in the expensive direction: a one-second 500 or rate-limit blip would blind
 * the bot to that code for the whole TTL, and an invite created a moment after
 * we first asked would stay invisible while it was being advertised. Not
 * caching a failure costs one more lookup; caching one costs an invite left
 * standing, and this file's entire premise is that those two are not the same
 * size of mistake.
 *
 * BOUNDED, NOT A BARE MAP. This process runs for weeks under systemd and the
 * keys are attacker-supplied strings — an unbounded Map here is a memory leak
 * with a stranger's hand on the tap. Full means the oldest write is dropped.
 *
 * THE CLOCK IS AN ARGUMENT so a test can prove the TTL expires without a timer
 * and without a second of real waiting.
 */
export function createInviteCache(options: InviteCacheOptions = {}): InviteCache {
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS
  const maxEntries = options.maxEntries ?? CACHE_MAX_ENTRIES
  const now = options.now ?? Date.now

  const entries = new Map<string, { guildId: string; expiresAt: number }>()

  return {
    get(code) {
      const entry = entries.get(code)
      if (entry === undefined) return undefined

      // Expiry is checked on read and the dead entry dropped here. No timer, no
      // sweep, nothing to unref before the process can exit — and an entry
      // nobody asks about again costs one Map slot until eviction reaches it.
      if (now() >= entry.expiresAt) {
        entries.delete(code)
        return undefined
      }

      return entry.guildId
    },

    set(code, guildId) {
      // Delete before set so a re-answered code moves to the END of the Map's
      // insertion order. Without it, eviction could drop the entry just written
      // while older ones survive.
      entries.delete(code)
      entries.set(code, { guildId, expiresAt: now() + ttlMs })

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        // Only reachable on an empty Map, which the loop condition has already
        // ruled out. Checked anyway: the alternative to breaking out is a spin
        // that never ends.
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
    },

    get size() {
      return entries.size
    },
  }
}

/**
 * The cache a caller gets when it does not bring its own: one per resolver.
 *
 * LIVE BY DEFAULT, deliberately. A cache that only exists when a caller opts in
 * is a cache that is switched off in production and green in the tests — the
 * fix reads as done and the fan-out is still there. `client.ts` passes three
 * arguments and gets the cache anyway.
 *
 * KEYED ON THE RESOLVER RATHER THAN ONE CACHE FOR THE PROCESS, because a
 * remembered answer is an answer FROM A PARTICULAR RESOLVER and is worth
 * nothing without it. Two resolvers are two clients, two sets of guilds each is
 * able to see and two sets of credentials; serving one's answer to the other
 * states a fact neither of them ever gave us. `createClient` builds its
 * resolver once and keeps it for the life of the process, so in production this
 * is one cache for the whole bot — which is what makes one invite posted into
 * fifty channels cost one lookup.
 *
 * THE PRICE, PLAINLY: a caller that builds a FRESH resolver closure per message
 * gets a fresh cache per message and no reuse at all. The cap still holds, so
 * the outage this was fixed for stays fixed, but the cross-message saving goes
 * quietly to nothing. Keep the resolver at wiring time, where `client.ts`
 * already keeps it.
 *
 * A WeakMap, so a resolver that goes out of scope takes its cache with it.
 * Nothing here grows, and nothing needs resetting between tests: a test that
 * hands over a new fake gets a new cache by construction rather than by
 * remembering to empty a shared one.
 */
const caches = new WeakMap<InviteResolver, InviteCache>()

function cacheFor(resolve: InviteResolver): InviteCache {
  const existing = caches.get(resolve)
  if (existing !== undefined) return existing

  const created = createInviteCache()
  caches.set(resolve, created)
  return created
}

/**
 * The one thing a caller may swap out.
 *
 * THE CAP IS NOT AN OPTION. It is a fuse on a shared, process-wide budget that
 * Discord enforces against the whole bot, so a per-call override is a per-call
 * way to blow it — and the only argument for one is a caller who thinks its
 * messages are special, which is exactly the caller a fuse is for.
 */
export interface ScanOptions {
  /** Use this cache instead of the resolver's own, e.g. one on a driven clock. */
  cache?: InviteCache
}

export interface ScanResult {
  /** Every code found in the message, deduplicated, in order — cap or no cap. */
  codes: string[]
  /** The codes actually looked up: the first `MAX_LOOKUPS` of `codes`. */
  checked: string[]
  /**
   * True when the message carried more distinct codes than the cap allows, so
   * everything after `checked` went unexamined.
   *
   * NOT A VERDICT, BUT NOT DECORATION EITHER. The codes past the cap are absent
   * from `foreign` and from `unresolved`, because we genuinely do not know what
   * they are — but "this message carried two hundred invites" is itself grounds
   * to act, and the caller cannot see that from the other fields. This is how it
   * finds out.
   *
   * THIS FIELD ONCE SAID "NOT A BYPASS" AND THAT WAS FALSE, because nothing read
   * it: `decide` in client.ts dropped the flag and its `Verdict` union had no
   * field for it, so ten junk codes followed by the real advert as the eleventh
   * was a post the bot would not touch. A signal no caller consumes is a comment
   * rather than a mitigation. `decide` now removes the message on this flag
   * alone, under its own reason — see the truncation check there.
   */
  truncated: boolean
  /** Codes confirmed to belong to a guild that is not ours. */
  foreign: string[]
  /** Codes Discord would not or could not identify. */
  unresolved: string[]
}

/**
 * Sort the codes in a message into what we know about them.
 *
 * AN UNRESOLVED CODE IS NOT A DELETE, and this is the most important line in
 * the file. A resolver answers null for an invite that has expired, been
 * revoked, or never existed — which is what a typo looks like, and what
 * `discord.gg/join-us-later` typed from memory looks like. Deleting on
 * unresolved means deleting people's mistakes and their conversation about
 * invites, with no way for them to tell why. Only a CONFIRMED foreign guild
 * justifies removing somebody's message. `unresolved` is reported separately
 * so the caller can log it and a human can go and look, not so the caller can
 * treat it as a soft yes.
 *
 * OUR OWN GUILD LANDS IN NEITHER BUCKET. An invite to this server posted in
 * this server is the normal, intended thing, and it is a resolved answer
 * rather than a missing one.
 *
 * RESOLVED ONE AT A TIME, NOT `Promise.all`. A wall of spam can carry over a
 * hundred distinct codes in one 2000-character message, and firing that many
 * lookups at once is how a moderation bot gets itself rate-limited at the
 * moment it is most needed. Nothing here is racing a deadline — the message is
 * already posted, and a second spent walking the list costs nothing that
 * matters.
 *
 * THREE THINGS STAND BETWEEN A MESSAGE AND THE API, IN THIS ORDER, and the
 * order is the design. `findInviteCodes` DEDUPLICATES, so fifty repeats of one
 * code are one entry. The CAP then takes the first ten of what is left — a flat
 * ten, counted before the cache is consulted, because letting remembered codes
 * ride free would make the set of codes examined depend on what happened to be
 * in memory a minute ago, and a removal that changes with cache warmth is one
 * nobody can reproduce. The CACHE spares the API for whatever survives both.
 *
 * DEDUPLICATING BEFORE CAPPING IS THE LOAD-BEARING HALF of that order. The other
 * way round, a message padded with one code repeated two hundred times would
 * fill the cap with a single invite and push a real one off the end.
 *
 * A TRUNCATED SCAN IS ANNOUNCED TWICE — a warn line in the journal and
 * `truncated` on the result — because a silent cap makes "this message was
 * scanned" a claim the code cannot support, and it would hand anyone who reads
 * this file a bypass: pad a post with a hundred junk codes and the real invite
 * falls off the end, unexamined and unmentioned. Neither signal is a decision
 * here — this function only sorts codes — but announcing it was for a while the
 * whole of the answer, and it was not one: `decide` in client.ts ignored the
 * flag, so the padded post survived. It now removes on it, which is what makes
 * the padding cost the poster their message instead of earning them a pass.
 */
export async function scanMessage(
  content: string,
  ourGuildId: string,
  resolve: InviteResolver,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const cache = options.cache ?? cacheFor(resolve)

  const codes = findInviteCodes(content)
  const checked = codes.slice(0, MAX_LOOKUPS)
  const truncated = codes.length > checked.length

  if (truncated) {
    log('warn', 'invite scan capped', { found: codes.length, checked: checked.length })
  }

  const foreign: string[] = []
  const unresolved: string[] = []

  for (const code of checked) {
    const guildId = await lookup(code, resolve, cache)

    // Falsy rather than `=== null`, so an empty string from a resolver that
    // half-answered lands in `unresolved` instead of being compared against our
    // guild id and coming out foreign. Every ambiguous answer has to fall the
    // same way: towards not deleting.
    if (!guildId) unresolved.push(code)
    else if (guildId !== ourGuildId) foreign.push(code)
  }

  return { codes, checked, truncated, foreign, unresolved }
}

/**
 * One code's answer, from memory if we have it and from Discord if we do not.
 *
 * THE CACHE IS WRITTEN ONLY ON A REAL ANSWER, which is the same rule the cache
 * itself documents, enforced at the one place that can break it. A guild id of
 * our own is an answer and gets remembered like any other — an invite to this
 * server is the invite posted most often in it.
 */
async function lookup(
  code: string,
  resolve: InviteResolver,
  cache: InviteCache,
): Promise<string | null> {
  const remembered = cache.get(code)
  if (remembered !== undefined) return remembered

  const guildId = await resolveOrNull(code, resolve)
  if (guildId) cache.set(code, guildId)

  return guildId
}

/**
 * A resolver that throws is a resolver that said nothing.
 *
 * DISCORD 500s, RATE-LIMITS AND DROPS CONNECTIONS, and none of that is a
 * reason for a message handler to die — the throw would take out the scan of
 * every other code in the message and, depending on the caller, the listener
 * with it. It is treated as unresolved for the same reason null is: we did not
 * learn whose guild it was, so we have no grounds to delete anything.
 *
 * IT IS LOGGED, THOUGH, and that is not decoration. A resolver that is broken
 * for every code produces a bot that scans, finds, resolves nothing, deletes
 * nothing and looks exactly like a quiet week from the outside. This line is
 * the only difference between that and a visible outage.
 */
async function resolveOrNull(code: string, resolve: InviteResolver): Promise<string | null> {
  try {
    return await resolve(code)
  } catch (error) {
    log('warn', 'invite lookup failed', { code, error })
    return null
  }
}
