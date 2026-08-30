/**
 * The link policy: what a message may point AT, decided by string matching and
 * nothing else.
 *
 * WHY THIS IS NOT IN invites.ts, WHICH IS THE FIRST QUESTION ANYONE WILL ASK.
 * Both files read a message and say "remove this", so folding them together
 * looks like an obvious tidy-up. It is not, and the reason is the one thing
 * invites.ts has that nothing here has: a NETWORK LOOKUP. A Discord invite code
 * is opaque — `discord.gg/abc123` does not say whose guild it is, so the only
 * way to tell a foreign advert from a link to this very server is to ask
 * Discord. That single fact is why invites.ts carries a resolver seam, an answer
 * cache, and `MAX_LOOKUPS` — a fuse on a shared API budget that one crafted
 * message can otherwise blow for the whole process.
 *
 * EVERY RULE HERE ANSWERS ITSELF FROM THE TEXT. An IP either is one of ours or
 * it is not; `cfx.re/join/<code>` is somebody else's server whatever the code
 * says, because this guild's server has no cfx listing at all; a shortener is
 * recognised by its DOMAIN and is never followed. Nothing is asked of anybody.
 * Merging these into `scanMessage` would put a ten-lookup cap on rules that make
 * zero lookups — so eleven bare IPs in one message would fall past a fuse fitted
 * for an API budget that this file does not spend — and it would make the pure
 * pattern work, which is the part worth testing against a hundred hostile
 * strings, reachable only through an async function that wants a resolver.
 *
 * SO: THE RULES LIVE HERE, `client.ts` CONSULTS BOTH, AND EACH VERDICT CARRIES
 * ITS OWN REASON. `decide` calls this first precisely because it costs nothing —
 * see the ordering note there — and the reason token it gets back is what the
 * journal line and the channel line both print, so an admin can tell which rule
 * fired without reading this file.
 *
 * THE FAILURE ASYMMETRY IS THE OPPOSITE WAY ROUND FROM invites.ts, AND EVERY
 * JUDGEMENT CALL BELOW TURNS ON THAT. There, a false positive costs one lookup
 * that comes back unresolved and nothing is ever deleted on it, so the pattern
 * can afford to be loose. Here there is no confirmation step: a match IS the
 * removal. A rule that is too loose deletes a member's message about nothing,
 * with no way for them to tell why. So the patterns below are anchored on BOTH
 * sides, the allowlist exception is anchored the same way the match is, and an
 * octet is at most three digits because a four-digit group is not an address.
 *
 * WHAT IS DELIBERATELY NOT CARRIED OUT OF HERE: THE TEXT THAT MATCHED. A verdict
 * is a reason and nothing else. Every rule here matches a WORKING LINK, and the
 * two places a verdict can go are the journal and the log channel — and the log
 * channel is inside the guild. Echoing the match there would repost the advert
 * the bot just removed, which is client.ts's existing rule about bare invite
 * codes arriving at the same answer from the other direction. Unlike an invite
 * code there is nothing to look up either, so the string has no second use.
 *
 * THAT ALSO SETTLES THE LENGTH QUESTION BEFORE IT IS ASKED. client.ts caps and
 * code-point-truncates the one other attacker-chosen string it prints — see
 * `plainName` — because a poster who chooses part of a log line chooses how much
 * of it is theirs, and a UTF-16 cut can leave half a character in the record.
 * Nothing here needs that treatment, because nothing here reaches a line: the
 * longest thing a verdict can carry is a token this file wrote itself.
 */

/**
 * THE FOUR PATTERN PIECES BELOW ARE A DELIBERATE COPY OF invites.ts's, character
 * for character, and the duplication is chosen rather than overlooked.
 *
 * They are not imported because invites.ts does not export them, and that file
 * is not this change's to edit. That is the small reason. The larger one is that
 * each of them is a RULE ABOUT A CLASS whose entire justification is written out
 * at length over there, against the invite host — and the same class turns out
 * to be the right rule against a cfx listing, a shortener and a `fivem://`
 * scheme, for the same reasons, which is worth knowing and is stated here rather
 * than assumed. Read invites.ts for the argument; what follows is the summary.
 *
 * `ESC` — Discord's markdown drops a backslash before punctuation, so
 * `bit\.ly/x` renders as a working link and the raw content the bot is handed
 * still has the backslash in it. A one-character bypass otherwise.
 *
 * `DOT` — RFC 3490 and UTS #46 map U+3002, U+FF0E and U+FF61 to `.` before a
 * host is resolved, so `cfx。re/join/x` is not a lookalike of the real link;
 * after mapping it IS the real link. A closed set of three, spelled as escapes
 * because three dots that differ only in width are indistinguishable in a diff.
 *
 * `SLASHES` — `//` is not a typo to a URL parser and `\` folds to `/` for
 * special schemes. A character class rather than the alternation `(?:\\?/|\\)+`
 * that says the same thing, because that form gives a run of k separators 2^k
 * parses and is the catastrophic backtracking the timed test guards.
 *
 * `AFTER_HOST` — everything a URL legally allows between a host and a path: the
 * FQDN root dot, an optional `:port` whose digits may be absent, then the
 * separators. Written as the closed set the URL grammar already defines rather
 * than patched per instance, because `bit.ly:443//x` is one string and not a
 * fourth case.
 *
 * If a third rule file is ever added, extract these three files' worth into one
 * module. Two is not yet that day.
 */
const ESC = '\\\\?'
const DOT = `${ESC}[.\\u3002\\uFF0E\\uFF61]`
const SLASHES = `[\\\\/]+`
const AFTER_HOST = `(?:${DOT})?(?:${ESC}:\\d*)?${SLASHES}`

/**
 * One character of a hostname label, and the lookbehind built from it.
 *
 * THE LOOKBEHIND IS THE ONLY LEFT-HAND RULE, exactly as in invites.ts:
 * `mybit.ly/x` and `notcfx.re/join/x` are other people's domains, and a label
 * ends at a dot, so a preceding letter, digit or hyphen means this is the tail
 * of a longer label. A preceding dot is fine — that is a subdomain, and a
 * subdomain of a shortener belongs to the shortener.
 *
 * `_` IS NOT IN IT, for the reason invites.ts gives: `_bit.ly/x_` is how
 * Discord's markdown writes italics, it renders as a working link, and treating
 * the underscore as part of a hostname would hand anybody a two-character
 * bypass.
 */
const LABEL = `[A-Za-z0-9-]`
const NOT_A_LABEL_TAIL = `(?<!${LABEL})`

/** Why a message is being removed by one of the rules in this file. */
export type LinkReason = 'fivem-connect' | 'server-listing' | 'foreign-ip' | 'link-shortener'

/**
 * The shortener domains, and how to keep them.
 *
 * A MODULE CONSTANT AND NOT CONFIGURATION, unlike the IP allowlist below. The
 * two look alike and are not: the allowlist names THIS deployment's servers, so
 * a third server must not need a code change, and it is different on every box
 * that ever runs this. The shortener list is a fact about the internet, the same
 * for everybody, and putting it in the environment would mean the list that
 * actually runs is invisible to the tests, unreviewable in a diff, and different
 * on the box from what this repo believes. Adding a domain here is a one-line
 * commit that the update timer deploys within fifteen minutes, which is faster
 * than editing a systemd unit and restarting.
 *
 * THE RULE FOR WHAT BELONGS HERE, because a list with no rule grows by taste:
 * A DOMAIN GOES IN THIS LIST WHEN THE DOMAIN DOES NOT TELL YOU WHERE YOU WILL
 * END UP. That is the whole of the policy — the bot never follows one of these,
 * because following a shortened link means fetching a URL a stranger chose, so
 * an unreadable destination is the thing being removed rather than a step on the
 * way to reading it.
 *
 * WHICH IS WHY `youtu.be` IS NOT HERE, AND MUST NOT BE ADDED. It is technically
 * a shortener and it fails the rule above in the other direction: every
 * `youtu.be/<id>` lands on a YouTube video, so the domain says exactly where you
 * are going. The same goes for `redd.it`, `wa.me`, `t.me`, `amzn.to` and
 * `fb.me` — platform-native short domains that people in a game community share
 * constantly, each of which can only reach the platform it is named after.
 * Deleting those would be deleting ordinary conversation.
 *
 * `t.co` IS THE LINE BETWEEN THE TWO, and it is here on purpose. It is
 * Twitter's own domain, which makes it look platform-native like `youtu.be` —
 * but it wraps every OUTBOUND link in a tweet, so `t.co/<id>` goes wherever the
 * tweet's author pointed it, which may be a FiveM server. It fails the rule, so
 * it is in.
 *
 * THE DISCORD REDIRECTORS ARE WHY THIS RULE EXISTS AT ALL. `dsc.gg/<name>`
 * redirects to a Discord invite, and invites.ts cannot see it: nothing in the
 * message says "discord", there is no invite code to extract, and no lookup
 * would help because the resolver takes a code and this is a name on somebody
 * else's site. blitz-bot#10 recorded that gap as unclosable. Matching by domain
 * closes it — not by understanding the redirect, but by refusing to care what is
 * on the far end of one.
 *
 * ORDER IS ALPHABETICAL AND DOES NOT AFFECT THE MATCH: no entry is a prefix of
 * another that could be followed by a legal host boundary, so the alternation
 * cannot pick a shorter branch and strand a longer one. Keep it that way when
 * adding to it, and keep every entry to letters, digits and dots — the builder
 * below turns a dot into the pattern piece and escapes nothing else.
 */
export const SHORTENERS: readonly string[] = [
  'bit.ly',
  'bitly.com',
  'buff.ly',
  'cutt.ly',
  'discord.link',
  'dsc.gg',
  'dsc.lol',
  'goo.gl',
  'invite.gg',
  'is.gd',
  'ow.ly',
  'rb.gy',
  'rebrand.ly',
  'shorturl.at',
  'shrtco.de',
  't.co',
  't.ly',
  'tiny.cc',
  'tinyurl.com',
  'v.gd',
]

/**
 * A shortened link: one of the domains above, a host boundary, and at least one
 * character of path.
 *
 * THE PATH IS REQUIRED, and that is the difference between a link and a
 * mention. `bit.ly` on its own points at nothing; `bit.ly/3xY9k` is the thing
 * being removed. One alphanumeric is enough — a slug is alphanumeric, and asking
 * for more would be guessing at how long they are.
 *
 * CASE-INSENSITIVE THROUGHOUT. A hostname is case-insensitive by DNS, and a
 * shortener's slug is not compared against anything here, so there is no reason
 * to be strict about its case and one good reason not to be: `BIT.LY/3XY9K`
 * loads the same page.
 */
const SHORTENER = new RegExp(
  `${NOT_A_LABEL_TAIL}(?:${SHORTENERS.map((host) => host.split('.').join(DOT)).join('|')})` +
    `${AFTER_HOST}[A-Za-z0-9]`,
  'i',
)

/**
 * A cfx.re join link, which is a public listing for a FiveM server.
 *
 * UNCONDITIONAL, AND THAT IS A FACT ABOUT THIS GUILD RATHER THAN A SHORTCUT.
 * The server this bot moderates has no cfx listing, so there is no code that
 * could name it — every `cfx.re/join/<code>` posted here is somebody else's
 * server by construction, and there is nothing to compare a code against.
 *
 * `/join/` IS MANDATORY, WHICH IS ONE FEWER BRANCH THAN invites.ts NEEDS.
 * `discord.gg/invite/x` and `discord.gg/x` are both real, so that pattern
 * carries an optional `invite/`. Measured on cfx.re, `cfx.re/<code>` alone 404s:
 * the bare form is not a link to anything, so matching it would be deleting
 * messages over a dead URL.
 *
 * THE CODE IS MATCHED IN ANY CASE EVEN THOUGH CODES ARE CASE-SENSITIVE, and the
 * two halves of that fit together rather than contradicting. Measured:
 * `/join/kvkq6v` resolves and `/join/KVKQ6V` 404s, so case is part of a code's
 * identity the same way it is part of an invite code's — two spellings are
 * potentially two different servers. invites.ts resolves the difference by
 * asking Discord, which is exactly what this file never does. With no way to
 * tell which spelling is the live one and no intention of finding out, both are
 * removed. The cost of that is a message deleted over a dead cfx link, which
 * nobody types by accident; the cost of the other choice is a live advert left
 * standing, and those are not the same size of mistake.
 *
 * THE HOST IS ANCHORED AT `cfx.re`, NOT AT A SUBDOMAIN, for invites.ts's reason:
 * anything under `cfx.re` belongs to whoever controls that zone, so one rule
 * covers `https://cfx.re/join/x`, `www.cfx.re/join/x` and the bare form people
 * actually paste, while the lookbehind still stops `notcfx.re`.
 */
const CFX_JOIN = new RegExp(
  `${NOT_A_LABEL_TAIL}cfx${DOT}re${AFTER_HOST}join${SLASHES}${LABEL}+`,
  'i',
)

/**
 * The other public listing for the same thing: the FiveM server browser's
 * detail page.
 *
 * THE SAME RULE, NOT A SECOND ONE, which is why it shares `server-listing`.
 * `servers.fivem.net/servers/detail/<code>` and `cfx.re/join/<code>` are two
 * addresses for one statement — here is a game server that is not this one — and
 * an admin reading the log gains nothing from being told which of the two spellings
 * was used.
 *
 * ANCHORED AT `fivem.net` RATHER THAN AT `servers.fivem.net`, so the
 * `servers.` subdomain is not a branch to keep in step. Everything to the left
 * of `fivem` is somebody else's business, exactly as in invites.ts, and the
 * lookbehind still ends the argument about `notfivem.net`.
 */
const FIVEM_DETAIL = new RegExp(
  `${NOT_A_LABEL_TAIL}fivem${DOT}net${AFTER_HOST}servers${SLASHES}detail${SLASHES}${LABEL}+`,
  'i',
)

/**
 * The target of a `fivem://connect/` link: a run of label characters and dots.
 *
 * GREEDY OVER DOTS ON PURPOSE, and that is what anchors the allowlist. A target
 * is a whole host, so `fivem://connect/3.130.92.28.evil.com` must yield
 * `3.130.92.28.evil.com` and not the allowlisted prefix of it. Greedy is the
 * whole of that: there is nothing left for the exception to match.
 *
 * TWO DISJOINT ALTERNATIVES, WHICH IS NOT AN ACCIDENT. `${LABEL}` cannot begin
 * with a backslash or a dot and `${DOT}` cannot begin with anything else, so no
 * string has two parses and a run of k of them cannot be walked 2^k ways. This
 * is the property `SLASHES` exists to preserve, in a second place; see the
 * timed test.
 */
const FIVEM_TARGET = `(?:${LABEL}|${DOT})*`

/**
 * `fivem://connect/<target>`.
 *
 * TWO REAL SHAPES AND THIS PATTERN COVERS BOTH, because the CitizenFX source
 * that parses them accepts `fivem://connect/<ip>:<port>` and
 * `fivem://connect/cfx.re/join/<code>`. The first ends at the target captured
 * here; the second's target is the host `cfx.re`, which is not an address of
 * ours, so it fires without this pattern needing a second branch — and the
 * listing rule above would have caught it anyway.
 *
 * THIS RULE IS NOT REDUNDANT WITH THE OTHER THREE, WHICH IS THE ONLY REASON IT
 * EXISTS. A bare IP target is already covered by `foreign-ip` and a cfx target
 * by `server-listing`; what neither covers is a HOSTNAME target —
 * `fivem://connect/play.someserver.com` names no IP and no listing, and it is a
 * one-click connect to another server. That is the gap, and it is why the
 * exception here is spelled "the target is one of our addresses" rather than
 * "the target is not an IP".
 *
 * THE SCHEME'S COLON TAKES `ESC` LIKE EVERY OTHER DELIMITER. Discord drops a
 * backslash before punctuation, so `fivem\://connect/x` renders as the link and
 * arrives here with the backslash still on it. A rule applied to one delimiter
 * out of three is the same bug in a new place.
 */
const FIVEM_CONNECT = new RegExp(
  `${NOT_A_LABEL_TAIL}fivem${ESC}:${SLASHES}connect${SLASHES}(${FIVEM_TARGET})`,
  'gi',
)

/**
 * Anything shaped like an IPv4 address.
 *
 * ANY SUCH STRING IS REMOVED UNLESS IT IS ONE OF OURS, AND THERE ARE NO CARVE
 * OUTS. Not for the private ranges, not for loopback, not for anything that
 * could be read as a version number: `127.0.0.1`, `192.168.1.1` and `1.0.0.1`
 * were each asked about and each answered the same way, because those
 * discussions do not happen in this guild. This is a game community, not a
 * support forum, and the only reason four dotted numbers appear in it is to tell
 * somebody where to connect.
 *
 * NO `fivem://` WRAPPER IS NEEDED. A bare address in prose is the form people
 * actually post — the scheme is a convenience, not the advert.
 *
 * AN OCTET IS ONE TO THREE DIGITS AND THE MATCH IS FENCED BY `(?<!\d)` AND
 * `(?!\d)`, WHICH IS THE ONE PLACE THIS FILE IS STRICT RATHER THAN LOOSE. Those
 * two fences are what stop `1.2.3.4567` matching as `1.2.3.456` and
 * `2024.10.5.1` matching as `024.10.5.1` — neither is an address anybody can
 * connect to, and a match here is a deletion with no confirmation step behind
 * it. There is no range check on top of that: `999.1.1.1` is not a real address
 * either, but rejecting it would be a carve-out, and a carve-out is a bypass
 * with a justification attached.
 *
 * THE VALUES ARE NOT CHECKED AGAINST THE ALLOWLIST HERE. The pattern's job is to
 * find every candidate; whether one is exempt is a question about the characters
 * on either side of it, which a regex alternative would have to encode twice.
 * See `foreignIp`.
 *
 * GLOBAL, AND ITERATED WITH `matchAll` RATHER THAN `test`. A global regex
 * carries `lastIndex` between calls, so `test` on a module-level constant
 * answers differently on the second call with the same input — the classic form
 * of that bug scans every other message, and there is a case pinning it.
 * `FIVEM_CONNECT` is global for the same reason, because it too has to hand back
 * something. The three that are NOT global — the shortener and the two
 * listings — are the three that are only ever asked whether they match at all,
 * so they hold no state that could survive the question.
 */
const IPV4 = new RegExp(`(?<!\\d)\\d{1,3}(?:${DOT}\\d{1,3}){3}(?!\\d)`, 'g')

/** One character that can appear inside a hostname label. */
const LABEL_CHAR = /[A-Za-z0-9-]/

/**
 * The four characters a resolver reads as a label separator.
 *
 * SPELLED AS ESCAPES, like `DOT` and for the same reason: three dots that differ
 * only in width are three characters nobody can tell apart in a diff, and the
 * fences below decide whether the owner's own server is exempt.
 */
const DOT_CHARS = '.\u3002\uFF0E\uFF61'

/**
 * A well-formed percent escape. Global because `percentDecode` replaces every
 * one of them; `String.prototype.replace` resets `lastIndex` on a global regex
 * itself, so this constant carries no state between calls.
 */
const PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/g

/**
 * The message as a URL parser would read it: ONE pass of percent-decoding.
 *
 * THE SAME BYPASS THAT invites.ts CLOSES, IN FOUR MORE PLACES. `bit%2Ely/x`,
 * `cfx%2Ere/join/x` and `%31%32%37.0.0.1` are the host dot and the digits
 * written in hex; node's own URL parser resolves `discord%2Egg` to
 * `discord.gg`, measured over there, and nothing about that is specific to
 * Discord's host. Teaching each pattern about `%` instead would mean four
 * character classes that each match a string no client can load.
 *
 * ONCE, NOT TO A FIXED POINT, because a browser decodes a path once. `%2561` is
 * the literal text `%61` to every client that will ever load it.
 *
 * BYTE-WISE AND DELIBERATELY NOT `decodeURIComponent`, which throws on the whole
 * string for one malformed escape — so `100% sure, bit.ly/x` would take the pass
 * down with it, a bypass costing four characters of prose.
 */
function percentDecode(content: string): string {
  if (!content.includes('%')) return content

  return content.replace(PERCENT_ESCAPE, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
}

/**
 * A matched address reduced to the form the allowlist is written in.
 *
 * ONLY THE MATCH IS NORMALISED, NEVER THE MESSAGE. Rewriting the whole message
 * before matching would be a second reading of every post and would move the
 * escape and unicode-dot rules out of the patterns that document them. The
 * allowlist is a COMPARISON rather than a search, so normalising the few
 * characters being compared is enough.
 *
 * THE ONLY BACKSLASHES A MATCH CAN CONTAIN ARE `ESC`'s, so removing all of them
 * cannot damage anything else. The three unicode separators fold to `.` because
 * a resolver folds them. A single TRAILING dot is dropped because `3.130.92.28.`
 * is the FQDN root form of the identical host — the same rule `AFTER_HOST`
 * encodes for the boundary after a hostname.
 */
function plainIp(text: string): string {
  return text
    .replace(/\\/g, '')
    .replace(/[\u3002\uFF0E\uFF61]/g, '.')
    .replace(/\.$/, '')
}

/** Is this matched text one of the addresses this deployment is allowed to name? */
function isOurs(text: string, ourIps: readonly string[]): boolean {
  return ourIps.includes(plainIp(text))
}

/**
 * Is the character before the match part of a hostname that continues leftwards?
 *
 * THIS AND `gluedRight` ARE THE WHOLE OF THE ALLOWLIST BOUNDARY, AND THE
 * BOUNDARY IS THE SUBTLE PART OF THIS FILE. Excepting the literal string
 * `3.130.92.28` — a substring test, or a match with no fences on it — hands out
 * two bypasses immediately: `3.130.92.28.evil.com` is a host somebody else
 * controls that merely BEGINS with our address, and `13.130.92.28` is a
 * different address that merely CONTAINS it. Both would be exempted, and both
 * are somebody else's server.
 *
 * SO THE EXCEPTION IS ANCHORED THE SAME WAY THE HOST PATTERN IS: it applies only
 * when the match is a whole host on its own. A label character or a dot
 * immediately to the left means more hostname is attached and this is not our
 * address; `/`, `:`, a space, a bracket, an underscore or the start of the
 * message all mean it stands alone.
 */
function gluedLeft(content: string, start: number): boolean {
  const before = content[start - 1]
  if (before === undefined) return false

  return LABEL_CHAR.test(before) || DOT_CHARS.includes(before)
}

/**
 * The same question on the right, where a dot is ambiguous and has to be read
 * one character further.
 *
 * A LABEL CHARACTER GLUES OUTRIGHT. A DOT ONLY GLUES WHEN A LABEL FOLLOWS IT:
 * `3.130.92.28.evil.com` continues the host and is not ours, while
 * `connect to 3.130.92.28.` is our address at the end of a sentence and the
 * full stop is punctuation. Reading only the next character would have to choose
 * one of those and be wrong about the other.
 *
 * THE OPTIONAL BACKSLASH IS `ESC` AGAIN, in the one place a fence rather than a
 * pattern has to know about it: `3.130.92.28\.evil.com` renders as the glued
 * host, so the escape must not be what makes the exception apply.
 */
function gluedRight(content: string, end: number): boolean {
  const next = content[end]
  if (next === undefined) return false
  if (LABEL_CHAR.test(next)) return true

  const offset = next === '\\' ? 1 : 0
  const dot = content[end + offset]
  const after = content[end + offset + 1]

  return (
    dot !== undefined &&
    DOT_CHARS.includes(dot) &&
    after !== undefined &&
    LABEL_CHAR.test(after)
  )
}

/**
 * Does the message name an address that is not one of ours?
 *
 * EVERY CANDIDATE IS EXAMINED, NOT JUST THE FIRST. A message that names our
 * server and then somebody else's is the ordinary shape of a poach — "we used to
 * play on 3.130.92.28, come to 5.6.7.8 instead" — so exempting on the first
 * match would be exempting the message because it mentioned us.
 */
function foreignIp(content: string, ourIps: readonly string[]): boolean {
  for (const match of content.matchAll(IPV4)) {
    const text = match[0]
    const at = match.index

    // Neither can be absent when the pattern matched, but this is a regex over
    // hostile input and `noUncheckedIndexedAccess` is on — the one place in the
    // process where "it must be there" is worth not asserting.
    if (text === undefined || at === undefined) continue

    const exempt =
      isOurs(text, ourIps) && !gluedLeft(content, at) && !gluedRight(content, at + text.length)

    if (!exempt) return true
  }

  return false
}

/**
 * Does the message carry a `fivem://connect/` link to somewhere that is not
 * ours?
 *
 * THE ALLOWLIST CAN ONLY EVER EXEMPT AN ADDRESS, NOT A HOSTNAME, and that is
 * enforced one file away: `loadConfig` rejects an entry in `BLITZ_SERVER_IPS`
 * that is not shaped like an IPv4 address, so `evil.com` cannot be sitting in
 * `ourIps` waiting for `fivem://connect/evil.com` to walk through. Checking it
 * again here would be a second place for the two notions of "IPv4-shaped" to
 * drift apart.
 *
 * NO BOUNDARY CHECK IS NEEDED AROUND THE TARGET, unlike the bare address above,
 * because `FIVEM_TARGET` is greedy over dots and label characters: anything glued
 * to our address is already inside the captured string and has already failed the
 * comparison.
 */
function fivemConnect(content: string, ourIps: readonly string[]): boolean {
  for (const match of content.matchAll(FIVEM_CONNECT)) {
    const target = match[1]
    if (target === undefined) continue

    if (!isOurs(target, ourIps)) return true
  }

  return false
}

/** Either public listing for a game server that is not this one. */
function serverListing(content: string): boolean {
  return CFX_JOIN.test(content) || FIVEM_DETAIL.test(content)
}

/** A link whose destination the bot cannot read and will not fetch. */
function shortener(content: string): boolean {
  return SHORTENER.test(content)
}

/**
 * One rule: a reason, and the question that decides whether it applies.
 *
 * THE ALLOWLIST IS A PARAMETER OF THE QUESTION EVEN THOUGH TWO OF THE FOUR
 * IGNORE IT. A narrower signature per rule would mean the loop below could not
 * hold them in one list, and the list is the thing that makes the ORDER a single
 * readable fact rather than four `if` statements somebody can reorder without
 * noticing.
 */
interface Rule {
  readonly why: LinkReason
  readonly fires: (content: string, ourIps: readonly string[]) => boolean
}

/**
 * The rules, IN THE ORDER A VERDICT PICKS FROM THEM.
 *
 * ONE MESSAGE CAN TRIP SEVERAL — `fivem://connect/cfx.re/join/abc` trips two,
 * and a post advertising a server properly trips three — so the order is not a
 * detail. It is fixed, it is in one place, and it is tested.
 *
 * MOST SPECIFIC STATEMENT FIRST, WHICH IS THE ONLY AXIS AVAILABLE. All four are
 * equally certain: each is a string that was literally in the message, with no
 * lookup behind it that could have been wrong — so unlike `decide`'s choice
 * between `foreign-invite` and `over-lookup-cap`, this cannot be settled on
 * which one is better evidenced. It is settled on what the reason TELLS an admin
 * reading the log. `fivem-connect` says the message carried a one-click connect
 * to another server, which is the most that can be said about a post.
 * `server-listing` says it carried a public advert for one. `foreign-ip` says it
 * named an address, which might have been a connect target and might have been
 * prose. `link-shortener` is last because it is the only one that describes
 * something the bot did NOT read: it says the destination was hidden from us,
 * which is grounds to act and is the least informative of the four.
 */
const RULES: readonly Rule[] = [
  { why: 'fivem-connect', fires: fivemConnect },
  { why: 'server-listing', fires: serverListing },
  { why: 'foreign-ip', fires: foreignIp },
  { why: 'link-shortener', fires: shortener },
]

/**
 * Which rule this message breaks, or null if it breaks none.
 *
 * PURE, SYNCHRONOUS, AND A FUNCTION OF TWO ARGUMENTS. There is no resolver, no
 * cache, no lookup cap and nothing to await — see the header. That is what lets
 * the whole policy be exercised against a table of hostile strings offline,
 * which is the only way a pattern that decides whether messages get deleted can
 * be reviewed at all.
 *
 * THE TEXT IT IS GIVEN IS THE ONE `scanText` ALREADY BUILDS. Content, embeds,
 * components, poll questions, attachment names, stickers and the same again for
 * forwarded snapshots are flattened into a single string in client.ts, and these
 * rules read exactly that string. A second flattening path here would be a
 * second list of message surfaces to keep in step, and the history of that file
 * is four separate bypasses that all came from a surface somebody forgot.
 *
 * READ TWICE, ONCE AS POSTED AND ONCE PERCENT-DECODED, and per rule rather than
 * per pass. Doing all four rules on the raw text and only then falling back to
 * the decoded text would let a low-priority rule matching the raw text outrank a
 * high-priority rule that only the decoded text shows — the message would be
 * removed either way, but the reason printed would be the less informative one.
 * The decode is skipped outright when the message has no `%` in it, which is
 * nearly every message.
 *
 * FIRST HIT WINS AND NOTHING KEEPS LOOKING. One removal needs one reason, and
 * every rule below the one that fired would be describing the same deletion.
 */
export function scanLinks(content: string, ourIps: readonly string[]): LinkReason | null {
  const decoded = percentDecode(content)

  for (const rule of RULES) {
    if (rule.fires(content, ourIps)) return rule.why
    if (decoded !== content && rule.fires(decoded, ourIps)) return rule.why
  }

  return null
}
