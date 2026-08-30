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
 * with no way for them to tell why — and the member is a real person who now
 * distrusts the bot, while the bypass that gets away costs one advert standing
 * for an hour. When those two pull in opposite directions below, the false
 * positive is the one that decides.
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
 * `fold` below folds two of the three away before any pattern runs; U+3002 is
 * the one NFKC leaves alone, which is measured and is why this class stays.
 *
 * `SLASHES` — `//` is not a typo to a URL parser and `\` folds to `/` for
 * special schemes. A character class rather than the alternation `(?:\\?/|\\)+`
 * that says the same thing, because that form gives a run of k separators 2^k
 * parses and is the catastrophic backtracking the timed test guards.
 *
 * `MAYBE_SLASHES` — the same class with `*` rather than `+`, and it exists for
 * exactly one place: the gap between a scheme's colon and its path. `fivem:` is
 * a URI scheme, and a URI scheme's colon may be followed by an OPAQUE path with
 * no separators at all — `fivem:connect/x` is the same request to the same
 * handler as `fivem://connect/x`. Written as `[\\/]*` and NOT as `${SLASHES}?`,
 * which is a different pattern with the same reading: appending `?` to `+`
 * yields the LAZY `+?`, which still demands one separator. The star is one
 * character class with one parse, so it keeps the property `SLASHES` exists for.
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
const MAYBE_SLASHES = `[\\\\/]*`
const AFTER_HOST = `(?:${DOT})?(?:${ESC}:\\d*)?${SLASHES}`

/**
 * One character of a hostname label, and the lookbehind built from it.
 *
 * THE LOOKBEHIND IS THE ONLY LEFT-HAND RULE, exactly as in invites.ts:
 * `mybit.ly/x` and `notcfx.re/join/x` are other people's domains, and a label
 * ends at a dot, so a preceding letter, digit or hyphen means this is the tail
 * of a longer label. A preceding dot is fine — that is a subdomain, and a
 * subdomain of a shortener USUALLY belongs to the shortener; `SHORTENER_HOSTS`
 * below is where the word "usually" is paid for.
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
 * `linktr.ee` WAS PUT TO THE RULE AND CAME BACK OUT, AND THAT IS THE SECOND
 * WORKED EXAMPLE OF THE LINE. It is the domain a poacher reaches for after the
 * plain shorteners stop working, so leaving it out is a real cost and is stated
 * as one. But it does not REDIRECT: `linktr.ee/<name>` lands on a Linktree page
 * and stays there, which is the `youtu.be` answer word for word — the domain
 * says exactly where you are going, and reaching a server from it takes a second
 * click on a page the reader is already looking at. `t.co` is in because it
 * carries the reader to the advertiser's URL without stopping; Linktree stops.
 * The same reading keeps out every other link-in-bio page for the same reason,
 * and it is why `linktr.ee` has a test of its own rather than only an absence:
 * this is the entry somebody adds by taste on a bad afternoon, and the rule has
 * to be what says no rather than whoever reviews that diff. If the owner would
 * rather delete Linktree posts, that is a decision about this guild and not a
 * reading of this rule, and the line to add is one line.
 *
 * THE SEVEN ADDED AFTER THE FIRST SWEEP — `bl.ink`, `clck.ru`, `lnk.to`,
 * `short.gy`, `surl.li`, `tiny.one`, `urlz.fr` — were each asked the same
 * question and each answered it the same way: every one of them is a generic
 * redirector whose path is an opaque slug, so the domain says nothing about the
 * destination and the bot would have to fetch it to find out. They are not a
 * new class; they are the class this list already names, spelled seven more
 * ways, and they were missing because the list was assembled from the ones
 * anybody could remember.
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
  'bl.ink',
  'buff.ly',
  'clck.ru',
  'cutt.ly',
  'discord.link',
  'dsc.gg',
  'dsc.lol',
  'goo.gl',
  'invite.gg',
  'is.gd',
  'lnk.to',
  'ow.ly',
  'rb.gy',
  'rebrand.ly',
  'short.gy',
  'shorturl.at',
  'shrtco.de',
  'surl.li',
  't.co',
  't.ly',
  'tiny.cc',
  'tiny.one',
  'tinyurl.com',
  'urlz.fr',
  'v.gd',
]

/**
 * The hosts UNDER a shortener domain that are not shorteners.
 *
 * "A SUBDOMAIN OF A SHORTENER BELONGS TO THE SHORTENER" IS TRUE OF `goo.gl` AND
 * FALSE OF `app.goo.gl`, AND THAT COST A MEMBER THEIR MESSAGE. `goo.gl/<id>`
 * is Google's dead URL shortener and says nothing about where it lands.
 * `maps.app.goo.gl/<id>` is the link the Google Maps share sheet produces and
 * `photos.app.goo.gl/<id>` is the one Google Photos produces; each can only
 * reach the product it is named after. That is the SHORTENERS rule above,
 * applied without an exception for the fact that the host happens to end in one
 * of the twenty — exactly the reading that keeps `youtu.be` out of the list.
 *
 * SO THIS IS NOT A CARVE-OUT, IT IS THE SAME TEST ASKED OF THE WHOLE HOST rather
 * than of its last two labels. The unit a reader judges is the host they can
 * see, and the host they can see here says Maps or Photos.
 *
 * IT DOES NOT GENERALISE TO `app.goo.gl` ITSELF, WHICH IS THE INTERESTING PART.
 * A bare `<name>.app.goo.gl` is a Firebase Dynamic Link, and where one of those
 * lands is chosen by whoever registered the app — so it fails the rule and stays
 * matched. Only the two hosts Google itself runs are named, and the reason a
 * third would be added is the same reason: the host names its destination.
 *
 * MATCHED AS A SUFFIX ON A LABEL BOUNDARY, so `x.maps.app.goo.gl` is exempt (it
 * is under a host only Google controls) and `evilmaps.app.goo.gl` is not (it is
 * a different label, and it is somebody's Firebase link).
 */
export const SHORTENER_HOSTS: readonly string[] = ['maps.app.goo.gl', 'photos.app.goo.gl']

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
 *
 * THE DOMAIN IS CAPTURED AND THE PATTERN IS GLOBAL because `shortener` has to
 * look at the host each match sits in — see `SHORTENER_HOSTS`. `matchAll` builds
 * its own regex from this one and leaves this constant's `lastIndex` alone,
 * which is what keeps the statelessness cases green.
 */
const SHORTENER = new RegExp(
  `${NOT_A_LABEL_TAIL}(${SHORTENERS.map((host) => host.split('.').join(DOT)).join('|')})` +
    `${AFTER_HOST}[A-Za-z0-9]`,
  'gi',
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
 * ONE OR MORE, NOT ZERO OR MORE, AND THE DIFFERENCE WAS A LIVE FALSE POSITIVE.
 * With `*` the target could be the empty string, `isOurs('')` was false, and so
 * the bare text `fivem://connect/` — which is what somebody types when they are
 * EXPLAINING how to connect, with the address on the next line or in a
 * screenshot — was removed as a connect link to another server. A connect link
 * to nowhere is not a link to anywhere; see `fivemConnect`, which also drops a
 * target that normalises away to nothing.
 *
 * TWO DISJOINT ALTERNATIVES, WHICH IS NOT AN ACCIDENT. `${LABEL}` cannot begin
 * with a backslash or a dot and `${DOT}` cannot begin with anything else, so no
 * string has two parses and a run of k of them cannot be walked 2^k ways. This
 * is the property `SLASHES` exists to preserve, in a second place; see the
 * timed test.
 */
const FIVEM_TARGET = `(?:${LABEL}|${DOT})+`

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
 *
 * THE SEPARATORS AFTER THE COLON ARE OPTIONAL, AND THE `+` THERE WAS A BYPASS
 * COSTING TWO KEYSTROKES. `fivem:///connect/x` fired and `fivem://connect/x`
 * fired, but `fivem:connect/x` — one colon, no slashes — did not, and that form
 * is not a typo: RFC 3986 calls it the opaque path, every scheme has one, and
 * the protocol handler this scheme is registered to receives the identical
 * string either way. There was no rule behind the `+`; it was the shape of the
 * two spellings somebody happened to write down. See `MAYBE_SLASHES` for why
 * this is a `*` rather than a `?` hung off `SLASHES`.
 *
 * THE SEPARATOR BEFORE THE TARGET STAYS MANDATORY, WHICH IS NOT THE SAME
 * QUESTION. `connect` there is a path segment and not a scheme, so what follows
 * it has to be a segment boundary — without one, `fivem:connectplay.evil.com`
 * would read `connect` as a prefix of a word and pull `play.evil.com` out of the
 * middle of it.
 */
const FIVEM_CONNECT = new RegExp(
  `${NOT_A_LABEL_TAIL}fivem${ESC}:${MAYBE_SLASHES}connect${SLASHES}(${FIVEM_TARGET})`,
  'gi',
)

/**
 * One octet: a number from 0 to 255 with no leading zero.
 *
 * THE RANGE AND THE LEADING ZERO ARE ONE RULE AND THEY ARE HERE FOR ONE CASE.
 * NVIDIA ShadowPlay — the capture button every GTA player already has bound —
 * names its clips `Grand Theft Auto V 2026.08.30 - 14.22.05.03.mp4`. The tail of
 * that filename is `14.22.05.03`: four groups, each one to three digits, each
 * under 255. The old pattern read it as an address and the bot deleted the clip,
 * on a GTA server, where clips are most of what gets posted. An attachment's
 * filename is a scanned surface — client.ts reads it deliberately, because
 * `discord.gg-x3.png` is an advert that never appears in `content` — so there is
 * no fixing this by looking somewhere else.
 *
 * `05` AND `03` ARE WHAT MAKE IT NOT AN ADDRESS. A leading zero is not
 * canonical dotted-quad: nobody pastes `14.22.05.03` to be connected to, every
 * client that renders an address renders `14.22.5.3`, and the WHATWG URL parser
 * has rejected leading zeros outright since 2021 — measured, `new URL` throws on
 * `http://0300.0400.0500.0600/`. A zero-padded field is a CLOCK, and that is
 * what ShadowPlay is writing there.
 *
 * A SINGLE `0` IS STILL AN OCTET, so `0.0.0.0` and `127.0.0.1` are untouched by
 * this and are still removed. The rule is about a zero that PADS, not about the
 * digit.
 *
 * THE RANGE CHECK RIDES ALONG BECAUSE THE ALTERNATION THAT REJECTS `05` IS THE
 * SAME ONE THAT REJECTS `999`, and the file used to argue against it — "a
 * carve-out is a bypass with a justification attached". That argument was about
 * carving out addresses that WORK (loopback, the private ranges), and it still
 * stands for those. `999.1.1.1` is not an address anyone can connect to in any
 * spelling, so refusing it removes no reachable destination; what it removes is
 * a class of version string and score line that a member can now post.
 */
const OCTET = `(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)`

/**
 * Anything shaped like an IPv4 address a person could actually connect to.
 *
 * ANY SUCH STRING IS REMOVED UNLESS IT IS ONE OF OURS, AND THERE ARE NO CARVE
 * OUTS FOR WHAT AN ADDRESS MEANS. Not for the private ranges, not for loopback,
 * not for anything that could be read as a version number: `127.0.0.1`,
 * `192.168.1.1` and `1.0.0.1` were each asked about and each answered the same
 * way, because those discussions do not happen in this guild. This is a game
 * community, not a support forum, and the only reason four dotted numbers appear
 * in it is to tell somebody where to connect.
 *
 * NO `fivem://` WRAPPER IS NEEDED. A bare address in prose is the form people
 * actually post — the scheme is a convenience, not the advert.
 *
 * THE FENCES ARE THE WHOLE OF "FOUR GROUPS, NOT FOUR OF SEVEN", AND THE OLD ONES
 * WERE HALF THE RULE. `(?<!\d)` and `(?!\d)` stop `1.2.3.4567` matching as
 * `1.2.3.456`, and they always did. What they never stopped is a quad found
 * INSIDE a longer dotted run: `rule 1.2.3.4.5` matched at `1.2.3.4`,
 * `laps: 1.02.3.99` matched, and `stamp 2026.08.30.14.22.05` matched at
 * `08.30.14.22` — four numbers that are four fields of something else. A digit
 * fence cannot see that, because the character in the way is a DOT. So there are
 * four fences now, one pair per side: no digit adjacent, and no
 * digit-then-separator adjacent either. `(?<!\d${DOT})` is what says "the dot to
 * my left continues a number, so I am in the middle of something".
 *
 * A VARIABLE-LENGTH LOOKBEHIND, WHICH JAVASCRIPT ALLOWS AND MOST FLAVOURS DO
 * NOT. `${DOT}` carries `ESC`'s optional backslash, so the assertion is two or
 * three characters wide. V8 has supported this since 2018 and node 24 is the
 * only engine this runs on; the alternative is spelling the same fence twice.
 *
 * THE VALUES ARE NOT CHECKED AGAINST THE ALLOWLIST HERE. The pattern's job is to
 * find every candidate; whether one is exempt — and whether it is an address at
 * all rather than the middle of a filename — is a question about the characters
 * on either side of it. See `foreignIp`.
 *
 * GLOBAL, AND ITERATED WITH `matchAll` RATHER THAN `test`. A global regex
 * carries `lastIndex` between calls, so `test` on a module-level constant
 * answers differently on the second call with the same input — the classic form
 * of that bug scans every other message, and there is a case pinning it.
 * `FIVEM_CONNECT` and `SHORTENER` are global for the same reason, because they
 * too have to hand something back. The two that are NOT global — the listings —
 * are the two that are only ever asked whether they match at all, so they hold
 * no state that could survive the question.
 */
const IPV4 = new RegExp(
  `(?<!\\d)(?<!\\d${DOT})${OCTET}(?:${DOT}${OCTET}){3}(?!\\d)(?!${DOT}\\d)`,
  'g',
)

/**
 * ONE IPv4 ADDRESS AND NOTHING ELSE, in exactly the spelling `IPV4` can produce.
 *
 * EXPORTED FOR config.ts, WHICH IS THE ONLY WAY THE TWO STAY THE SAME NOTION.
 * `BLITZ_SERVER_IPS` is checked for shape at boot so that a typo stops the
 * process instead of quietly becoming an allowlist line that exempts nothing,
 * and that check used to be its own regex over there: one to three digits per
 * octet, no range, no leading-zero rule. It therefore ACCEPTED `999.1.1.1` and
 * `014.22.5.3` — two spellings this matcher can never produce, so both would
 * have sat in the config looking like protection and exempting nothing. A
 * comment claiming the two notions were the same one is not the same one. This
 * is.
 *
 * PLAIN `\.` AND NOT `DOT`, BECAUSE AN ALLOWLIST ENTRY IS NOT A MESSAGE. The
 * unicode separators and the markdown escape are things a poster writes; an
 * operator writes this into a systemd unit, and `plainIp` has already folded a
 * matched address to this spelling before either is compared.
 */
export const IPV4_ADDRESS = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`)

/**
 * IPv6 IS NOT MATCHED, AND THIS IS THE DECISION RATHER THAN THE ABSENCE OF ONE.
 *
 * WRITTEN DOWN BECAUSE AN UNSTATED GAP IS THE ONE NOBODY REVISITS. `connect to
 * 2001:db8::1` and `fivem://connect/[2001:db8::1]:30120` are both kept today,
 * and until this paragraph existed the only way to find that out was to try it.
 *
 * IT IS NOT THE SAME SHAPE AS THE DECIMAL AND HEX SPELLINGS, WHICH ARE ALSO
 * DELIBERATELY NOT CAUGHT — see the rows for them in the tests. Those are left
 * because the FiveM client will not take them: an advert written as
 * `http://84281096/` cannot be acted on without a browser and a conversion, so
 * the rule would delete crash dumps and player ids every day to close a hole
 * nobody can walk through. That argument does NOT transfer. Cfx.re staff state
 * on the forum that `connect [::1]:30120` in the client console works, so an
 * IPv6 advert is actionable in a way a decimal one is not. This gap is real.
 *
 * IT IS LEFT OPEN ANYWAY, ON THREE COUNTS, AND ANY ONE OF THEM CHANGING IS
 * GROUNDS TO REOPEN IT:
 *
 *   1. THE ALLOWLIST CANNOT HOLD ONE. `BLITZ_SERVER_IPS` is shape-checked as
 *      IPv4 by `IPV4_ADDRESS` above, so a rule that removed IPv6 addresses would
 *      have no way to spell an exemption for OURS. The first time this guild's
 *      server answered on IPv6 the bot would delete the message naming it, and
 *      the only fix would be a code change — which is the exact failure the
 *      allowlist is configuration to avoid.
 *   2. COMPARING TWO OF THEM IS NOT STRING EQUALITY. `2001:db8::1`,
 *      `2001:0db8:0000:0000:0000:0000:0000:0001` and `::FFFF:1.2.3.4` are one
 *      address in three spellings, so an exemption needs a canonicaliser, not a
 *      `.includes`. That is a real piece of code with its own edges, and every
 *      one of its bugs is a deleted message.
 *   3. THE FORM BARELY EXISTS IN THE FIELD. The server browser does not resolve
 *      IPv6, FXServer has open bugs against IPv6-only setups, and a FiveM server
 *      being advertised into this guild is behind an IPv4 address or a cfx code.
 *      The benefit today is close to nothing.
 *
 * WHAT WOULD BE BUILT IF IT WERE BUILT: a strict pattern only — eight groups, or
 * the `::` compression — never a loose colon run, because `14:22:35` is a
 * timestamp and `00:1A:2B:3C:4D:5E` is a MAC address, and both are six or fewer
 * groups with no `::`, which strict IPv6 rejects and a loose rule would not.
 */

/** One character that can appear inside a hostname label. */
const LABEL_CHAR = /[A-Za-z0-9-]/

/**
 * The four characters a resolver reads as a label separator.
 *
 * SPELLED AS ESCAPES, like `DOT` and for the same reason: three dots that differ
 * only in width are three characters nobody can tell apart in a diff, and the
 * boundary work below decides whether the owner's own server is exempt.
 */
const DOT_CHARS = '.\u3002\uFF0E\uFF61'

/**
 * A run of percent escapes. Global because `percentDecode` replaces every one of
 * them; `String.prototype.replace` resets `lastIndex` on a global regex itself,
 * so this constant carries no state between calls.
 *
 * A RUN AND NOT A SINGLE ESCAPE, WHICH IS THE WHOLE OF THE UTF-8 FIX. One
 * character outside ASCII is two to four escapes that only mean anything
 * together: `%E3%80%82` is U+3002, and decoding it a byte at a time produces
 * three characters of mojibake that no pattern here matches. See `percentDecode`.
 */
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g

/** One decoder for the whole module; it holds no state between calls. */
const UTF8 = new TextDecoder()

/**
 * The message as a URL parser would read it: ONE pass of percent-decoding, and
 * the bytes read as UTF-8.
 *
 * THE SAME BYPASS THAT invites.ts CLOSES, IN FOUR MORE PLACES. `bit%2Ely/x`,
 * `cfx%2Ere/join/x` and `%31%32%37.0.0.1` are the host dot and the digits
 * written in hex; node's own URL parser resolves `discord%2Egg` to
 * `discord.gg`, measured over there, and nothing about that is specific to
 * Discord's host. Teaching each pattern about `%` instead would mean four
 * character classes that each match a string no client can load.
 *
 * DECODED AS UTF-8 AND NOT ONE BYTE AT A TIME, WHICH WAS A WORKING BYPASS.
 * `String.fromCharCode` per escape turns `cfx%E3%80%82re` into three Latin-1
 * characters — mojibake that matches nothing — while `new URL` resolves the same
 * text to the host `cfx.re`, measured. Every non-ASCII separator this file
 * already knows about has a percent spelling, so the byte-wise decode was a
 * three-escape way around the rule that exists to catch them.
 *
 * ONCE, NOT TO A FIXED POINT, because a browser decodes a path once. `%2561` is
 * the literal text `%61` to every client that will ever load it.
 *
 * STILL NOT `decodeURIComponent`, which throws on the whole string for one
 * malformed escape — so `100% sure, bit.ly/x` would take the pass down with it,
 * a bypass costing four characters of prose. This decodes each well-formed RUN
 * and leaves everything else exactly as posted; a run whose bytes are not valid
 * UTF-8 comes back as U+FFFD, which matches nothing here and is no worse than
 * the mojibake it replaces.
 */
function percentDecode(content: string): string {
  if (!content.includes('%')) return content

  return content.replace(PERCENT_RUN, (run: string) => {
    const bytes = new Uint8Array(run.length / 3)

    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16)
    }

    return UTF8.decode(bytes)
  })
}

/**
 * The characters that render as NOTHING between two letters of a host.
 *
 * A SOFT HYPHEN IN THE MIDDLE OF A HOST DEFEATED EVERY RULE IN THIS FILE FOR ONE
 * KEYSTROKE. `b<U+00AD>it.ly/3xY9k` renders in Discord as `bit.ly/3xY9k`, is
 * clicked as `bit.ly/3xY9k`, and measured, `new URL` resolves it to exactly
 * that host — UTS #46 maps the character to nothing before the name is looked
 * up. The zero-width space, the two zero-width joiners, the word joiner and the
 * byte-order mark are the same character class and the same measurement.
 *
 * THIS USED TO BE THOSE SIX SPELLED OUT, AND THE COMMENT CLAIMED THE SET WAS
 * CLOSED. IT WAS NOT. Measured the same way, `new URL` resolves `b<U+034F>it.ly`
 * and `b<U+FE0F>it.ly` to the host `bit.ly` as well — the combining grapheme
 * joiner and the emoji variation selector, neither of which is a FORMAT
 * character and neither of which NFKC removes, so nothing else in this file
 * touched them. U+3164 and U+180E are two more, measured the same way. A
 * hand-written list of invisible characters is a list somebody has to keep
 * finishing, and this one was six items into a class of several hundred.
 *
 * SO THE CLASS IS NAMED RATHER THAN ENUMERATED. `Default_Ignorable_Code_Point`
 * is Unicode's own name for "renders as nothing and is meant to be skipped",
 * which is what all four of those measurements have in common; `Cf` is the
 * format characters, which overlaps it heavily and carries the few separator
 * controls sitting outside it. Both are asked of the engine's Unicode tables,
 * so the answer grows with Node rather than with whoever next reads a bug
 * report — and the `u` flag is what makes the property escapes legal and what
 * makes an astral one a single character rather than two surrogates.
 *
 * STRIPPING THEM CANNOT INVENT A MATCH OUT OF ORDINARY TEXT, which is the
 * question to ask of anything that rewrites a message before matching it. Every
 * one of them is invisible where it matters here — between two label characters
 * — so no member has ever typed one there between two characters they meant to
 * keep apart. The only strings this changes are strings that already render as
 * the joined form.
 *
 * WHAT NAMING THE CLASS STILL DOES NOT GET, because a rule that names a class
 * invites being read as complete:
 *
 *   - IT IS NOT UTS #46'S IGNORED SET, AND THE TWO DISAGREE IN BOTH DIRECTIONS.
 *     Measured: U+00AD, U+034F, U+FE0F, U+3164 and U+180E are dropped and the
 *     host resolves, so those are the bypass this closes. U+061C, U+202E, U+0600
 *     and U+E0001 are in this class as well, and `new URL` THROWS on a host
 *     containing any of them — so stripping those builds a match out of a string
 *     that no client can open. This rule matches MORE than a resolver would,
 *     never less: the safe direction for a bypass and the wrong one for a false
 *     positive. Nobody types a bidi override inside `bit.ly`, so that half is
 *     paid in theory rather than in posts, and splitting the class by hand would
 *     be the hand-written list this replaced.
 *   - IT IS THE ENGINE'S TABLES AND NOT UNICODE'S LATEST. A character that
 *     becomes default-ignorable in a release newer than the Node this runs on is
 *     not in the class until that Node is upgraded. "Closed" is a claim about
 *     today's build, which is the claim the six-character list should have made.
 *   - IT IS ABOUT CHARACTERS THAT VANISH, NOT CHARACTERS THAT CHANGE. A
 *     lookalike that RESOLVES SOMEWHERE ELSE is a different problem with a
 *     different answer, and `fold` writes the Cyrillic case out.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu

/**
 * Is there anything here that `fold` could possibly change?
 *
 * A SURROGATE IS IN THE RANGE, WHICH IS WHAT MAKES THIS GATE SAFE FOR AN ASTRAL
 * CHARACTER. `INVISIBLE` reaches U+E0001 and NFKC reaches the mathematical
 * alphabets, and both are written as a pair from U+D800\u2013U+DFFF \u2014 inside the
 * range this class tests \u2014 so a message whose only non-ASCII content is astral
 * still reaches the fold rather than being skipped as plain ASCII.
 */
const NON_ASCII = /[\u0080-\uFFFF]/

/**
 * The message as the reader's client will render and resolve it.
 *
 * FINDINGS 6, 7 AND 8 WERE ONE FINDING: THE RULES MATCHED RAW TEXT WHILE WHAT
 * DECIDES WHERE A CLICK LANDS IS WHAT A URL PARSER RESOLVES TO. A soft hyphen, a
 * fullwidth letter and a UTF-8 percent escape are three spellings of "this is
 * not the host you are matching against, but it is the host that will be
 * opened". Patching three patterns for three spellings leaves the fourth open;
 * normalising once, before any rule runs, means every rule below is matching
 * something closer to what the client will actually load.
 *
 * NFKC IS THE FOLD BECAUSE IT IS THE ONE UTS #46 USES. Fullwidth `ｃｆｘ.re`,
 * mathematical bold `𝐜𝐟𝐱.re` and circled `ⓒⓕⓧ.re` all resolve to the host
 * `cfx.re` — measured with `new URL`, all three — and all three are NFKC-mapped
 * to ASCII `cfx`. The file already argued this case for the three unicode dots;
 * this is the same argument applied to the rest of the alphabet instead of
 * stopping at the separator.
 *
 * WHAT THIS CANNOT DO, AND IT IS WORTH BEING PLAIN ABOUT IT:
 *
 *   - NORMALISATION MAKES THE HOMOGLYPH CLASSES FINITE, NOT EMPTY. Cyrillic
 *     `с` (U+0441) is NOT NFKC-mapped to ASCII `c`, so `сfx.re/join/x` still
 *     walks past every rule here. It is a weaker bypass than the ones above, and
 *     that is the honest reason it is left: measured, `new URL` resolves it to
 *     the punycode host `xn--fx-9lc.re`, which is NOT cfx.re — the lookalike
 *     goes somewhere else, or nowhere. Catching it would mean a confusable-skeleton
 *     table, which is a large dependency for a class of link that does not reach
 *     the advertiser's server.
 *   - A RULE THAT RESOLVES IS STILL NOT A RULE THAT FETCHES. This file's whole
 *     premise is that it never follows anything, so a shortener domain that is
 *     not in the list above, or a redirect from a domain that is not, is
 *     invisible however well the text is normalised.
 *   - THE THREE UNICODE DOTS STAY IN `DOT` REGARDLESS. Measured: NFKC maps
 *     U+FF0E to `.` and U+FF61 to U+3002, and leaves U+3002 exactly as it is. A
 *     fold that handled two separators out of three would be worse than no fold
 *     at all, because it would read as having handled them.
 *
 * SKIPPED OUTRIGHT FOR AN ALL-ASCII MESSAGE, which is nearly every message. The
 * test is one pass that finds nothing, against a `normalize` call that would
 * copy the string.
 */
function fold(content: string): string {
  if (!NON_ASCII.test(content)) return content

  return content.replace(INVISIBLE, '').normalize('NFKC')
}

/**
 * A host reduced to the form the allowlist is written in: backslashes gone, the
 * unicode separators folded to `.`.
 *
 * THE ONLY BACKSLASHES A MATCH CAN CONTAIN ARE `ESC`'s, so removing all of them
 * cannot damage anything else. The three unicode separators fold to `.` because
 * a resolver folds them — `fold` above has already dealt with two of the three,
 * and U+3002 survives NFKC, so this is not redundant.
 */
function plainHost(text: string): string {
  return text.replace(/\\/g, '').replace(/[\u3002\uFF0E\uFF61]/g, '.')
}

/**
 * The same thing, with every trailing dot dropped.
 *
 * ONE ROOT DOT IS A HOST; THREE ARE AN ELLIPSIS; NEITHER IS PART OF THE ADDRESS.
 * `3.130.92.28.` is the FQDN root form of the identical host — the same rule
 * `AFTER_HOST` encodes for the boundary after a hostname. Stripping exactly one
 * was a live false positive: `fivem://connect/3.130.92.28... see you` left
 * `3.130.92.28..`, which matched no allowlist entry, and the owner's own connect
 * link was deleted for ending a sentence.
 */
function plainIp(text: string): string {
  return plainHost(text).replace(/\.+$/, '')
}

/**
 * How many hostname labels a trailing run of host characters actually contains.
 *
 * A HYPHEN COUNTS AS A SEPARATOR HERE EVEN THOUGH DNS SAYS IT IS NOT, and that
 * is deliberate rather than sloppy. The question being asked is "does a DOMAIN
 * follow this address", and `3.130.92.28-evil.com` answers it exactly as
 * `3.130.92.28.evil.com` does: `evil.com` is a registrable name somebody owns
 * and can point at a server. Counting the hyphen as a break is what makes those
 * two one case instead of two.
 */
function segments(tail: string): number {
  return plainHost(tail).split(/[.-]+/).filter((part) => part !== '').length
}

/**
 * Does this trailing run turn the address in front of it into a LONGER HOST?
 *
 * TWO OR MORE LABELS IS A REGISTRABLE DOMAIN — `3.130.92.28.evil.com` — and that
 * is a host somebody else controls that merely begins with an address. The line
 * is drawn at two because `com`, `net` and `re` are public suffixes while `mp4`,
 * `png` and `See` are not, and counting labels is the only way to say that
 * without carrying a list of every TLD and every file extension in the world.
 * Both lists change weekly; the shape does not.
 *
 * A HYPHEN IS A BREAK HERE, VIA `segments`, so `3.130.92.28-evil.com` is the
 * same case as `3.130.92.28.evil.com` rather than a second one.
 *
 * THE COST IS A FILENAME WITH TWO EXTENSIONS, AND IT IS PAID EVEN FOR OUR OWN
 * ADDRESS. `blitz-backup-3.130.92.28.tar.gz` and `3.130.92.28.crt.pem` have two
 * labels after the quad, so they read as a domain and are removed — and there is
 * no shape that separates `.tar.gz` from `.evil.com`, because the only real
 * difference between them is that `com` is a public suffix and `gz` is not.
 * Keeping both would mean carrying the list this rule exists to avoid. The
 * owner has been shown these two by name; see the tables, where they sit as
 * removals with this paragraph's reason attached.
 */
function addsADomain(tail: string): boolean {
  return segments(tail) >= 2
}

/**
 * Is this trailing run a full stop and a word, or a file extension — rather than
 * an address at all?
 *
 * THIS IS THE ONE JUDGEMENT THAT DECIDES THE WORST FALSE POSITIVE, and it is a
 * judgement rather than a fact, so it is written down once. After a dotted quad,
 * a dot and EXACTLY ONE label is
 *
 *   - a sentence: `we are back up on 3.130.92.28.See you there`, which is a full
 *     stop somebody did not put a space after;
 *   - or a file extension: `14.22.35.13.mp4`, the ShadowPlay clip whose clock
 *     happens to have no zero-padded field in it, and `ping-3.130.92.28.png`.
 *
 * EXACTLY ONE, AND `<= 1` HERE WAS THE REGRESSION. A trailing run of `.` with
 * nothing after it counts ZERO labels, so `<= 1` answered yes to it — and the
 * question this asks is "is there a word after the dot", not "is there a dot".
 * The effect was that `come play at 5.6.7.8.` and
 * `New server, join us at 45.87.154.22.` stopped firing: an address at the end
 * of a sentence, which is how an advert is actually written, went invisible
 * because it had been punctuated. A full stop is where the address ENDS; it is
 * not evidence about whose address it is.
 *
 * WHAT THIS COSTS, BECAUSE A JUDGEMENT WITH NO COST IS A JUDGEMENT NOBODY
 * CHECKED. `1.2.3.4.x` and `1.2.3.4.join` survive: a foreign address with one
 * junk label stuck on the end is readable to a human and invisible to this rule.
 * That is the price of the ShadowPlay clip and it is the right way round — this
 * bypass costs an advert the reader has to hand-edit before it connects, and the
 * false positive cost a member their clip, on a GTA server, where clips are most
 * of what gets posted.
 */
function endsTheAddress(tail: string): boolean {
  const plain = plainHost(tail)

  return plain.startsWith('.') && segments(plain) === 1
}

/** Is this matched text one of the addresses this deployment is allowed to name? */
function isOurs(text: string, ourIps: readonly string[]): boolean {
  return ourIps.includes(plainIp(text))
}

/**
 * Does this host name one of our addresses and nothing else?
 *
 * THE EXCEPTION IS ANCHORED AGAINST WHERE A URL ENDS, NOT AGAINST A LIST OF
 * NEIGHBOURING CHARACTERS. The old boundary asked "is the next character a
 * label character or a dot", which is a question about punctuation, and it
 * answered wrongly for every ordinary way of writing a sentence: an ellipsis, a
 * full stop with no space after it, a hyphen before a port, a `.png`. Deleting a
 * message that names the OWNER'S OWN server is the most embarrassing thing this
 * bot can do, and it was doing it five different ways.
 *
 * SO THE QUESTION IS ASKED OF THE WHOLE HOST INSTEAD: our address, then a
 * trailing run that does not add a domain to it. Anything that does —
 * `3.130.92.28.evil.com`, `3.130.92.28-evil.com` — is a different host, and it
 * is not ours.
 *
 * THE REMAINDER IS TESTED WITH `addsADomain` AND NOT WITH `endsTheAddress`, and
 * the difference is a port. `fivem://connect/3.130.92.28-30120` and
 * `fivem://connect/3.130.92.28:30120` are the same address twice, but only the
 * second one's separator stops `FIVEM_TARGET`, so the first arrives here with
 * `-30120` still attached — a remainder that is not punctuation, not a domain,
 * and not a reason to delete the owner's own connect link. Asking the negative
 * question is what makes the port, the ellipsis, the extension and the next
 * word of a sentence one case rather than four.
 */
function namesOurs(host: string, ourIps: readonly string[]): boolean {
  for (const ip of ourIps) {
    if (host === ip) return true
    if (host.startsWith(ip) && !addsADomain(host.slice(ip.length))) return true
  }

  return false
}

/**
 * Everything to the RIGHT of an index that a resolver would still read as part
 * of the same hostname.
 *
 * READ FORWARD AS FAR AS THE HOST GOES rather than one or two characters, so the
 * caller can ask a question about the host instead of about the next character.
 * A backslash is included because `ESC` puts one in front of any dot Discord
 * would otherwise eat, and `3.130.92.28\.evil.com` renders as the glued host.
 */
function hostTail(content: string, end: number): string {
  let at = end

  while (at < content.length) {
    const char = content[at]

    if (char === undefined) break
    if (!LABEL_CHAR.test(char) && !DOT_CHARS.includes(char) && char !== '\\') break

    at += 1
  }

  return content.slice(end, at)
}

/** The same, to the LEFT: the subdomain labels a matched host sits under. */
function hostHead(content: string, start: number): string {
  let at = start

  while (at > 0) {
    const char = content[at - 1]

    if (char === undefined) break
    if (!LABEL_CHAR.test(char) && !DOT_CHARS.includes(char) && char !== '\\') break

    at -= 1
  }

  return content.slice(at, start)
}

/**
 * Does the message name an address that is not one of ours?
 *
 * THREE QUESTIONS, ASKED IN THIS ORDER, AND THE ORDER IS THE WHOLE FIX. A dotted
 * quad in a message is one of:
 *
 *   1. A LONGER HOST — a real domain follows, so the string names somewhere that
 *      is not an address at all and cannot be on an allowlist of addresses.
 *      Removed. `3.130.92.28.evil.com` is the shape this exists for, and it is
 *      asked FIRST because it is the one answer the allowlist must not overrule.
 *   2. OUR ADDRESS — kept, whatever punctuation ends it. This is the exemption,
 *      and it is the only place the allowlist is consulted.
 *   3. NOT AN ADDRESS AT ALL — a dot and one more label follows, so it is a
 *      filename's extension or the first word of the next sentence. Nothing
 *      fires, for anybody's address: `14.22.35.13.mp4` is a clip and
 *      `1.2.3.4.mp4` is also a clip. See `endsTheAddress` for what that costs.
 *
 * Anything else is somebody else's address, and it is removed.
 *
 * QUESTION 2 IS ASKED OF THE ADDRESS AND NOT OF THE PUNCTUATION, WHICH IS THE
 * BUG THIS ORDER FIXES. The exemption used to be reached through the tail test:
 * a trailing run that looked like the end of a sentence skipped the candidate
 * outright, before anybody asked WHOSE address it was. That is true of the
 * owner's address followed by a full stop, and it is equally true of a poacher's
 * — so `come play at 5.6.7.8.` stopped firing, and an advert is a sentence with
 * an address at the end of it. Our address is exempt because it is OURS. A full
 * stop only says where it stopped.
 *
 * NOTHING IS ASKED ABOUT THE CHARACTERS TO THE LEFT ANY MORE, AND THAT IS A
 * DELIBERATE LOSS. `gluedLeft` used to fire on a preceding letter or hyphen,
 * which deleted `server3.130.92.28 is ours` and `ping-3.130.92.28.png` — the
 * owner's own address, in his own sentences. The prefix it was defending against
 * cannot make a working destination: `x3.130.92.28` is not an address, because
 * of the `x`, and not a host, because its last label is `28` and there is no
 * such TLD. A different address that CONTAINS ours needs no left-hand rule at
 * all — `13.130.92.28` is matched whole by the pattern, compared whole, and
 * removed.
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

    const tail = hostTail(content, at + text.length)

    if (addsADomain(tail)) return true
    if (isOurs(text, ourIps)) continue
    if (endsTheAddress(tail)) continue

    return true
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
 * drift apart — and they DID drift, back when config.ts spelled the shape out
 * in a regex of its own; `IPV4_ADDRESS` above is now the single one both use.
 *
 * A TARGET THAT NORMALISES TO NOTHING IS NOT A LINK TO ANYWHERE.
 * `fivem://connect/` is what a person types while EXPLAINING how to connect, and
 * `fivem://connect/...` is that with an ellipsis; both used to be removed. This
 * is the same measured rule that keeps `cfx.re/join/` — a listing link with no
 * code — out of the listing rule: removing a message over a URL that goes
 * nowhere is removing it over nothing.
 *
 * NO SEPARATE BOUNDARY CHECK IS NEEDED AROUND THE TARGET, unlike the bare
 * address above, because `FIVEM_TARGET` is greedy over dots and label
 * characters: anything glued to our address is already inside the captured
 * string, and `namesOurs` is what decides whether it is punctuation or a domain.
 */
function fivemConnect(content: string, ourIps: readonly string[]): boolean {
  for (const match of content.matchAll(FIVEM_CONNECT)) {
    const target = match[1]
    if (target === undefined) continue

    const host = plainIp(target)

    if (host === '') continue
    if (namesOurs(host, ourIps)) continue

    return true
  }

  return false
}

/** Either public listing for a game server that is not this one. */
function serverListing(content: string): boolean {
  return CFX_JOIN.test(content) || FIVEM_DETAIL.test(content)
}

/**
 * A link whose destination the bot cannot read and will not fetch.
 *
 * THE MATCH IS ONLY THE LAST TWO LABELS, SO THE HOST IS REBUILT BEFORE JUDGING
 * IT. `goo.gl` matches inside `maps.app.goo.gl`, and the lookbehind lets it,
 * because a preceding dot is a subdomain and a subdomain of a shortener usually
 * belongs to the shortener. `SHORTENER_HOSTS` is the list of hosts where that
 * "usually" is false, and it can only be checked against the whole host — which
 * is what `hostHead` reads back.
 */
function shortener(content: string): boolean {
  for (const match of content.matchAll(SHORTENER)) {
    const domain = match[1]
    const at = match.index

    if (domain === undefined || at === undefined) continue

    const host = plainHost(hostHead(content, at) + domain).toLowerCase()
    const named = SHORTENER_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))

    if (!named) return true
  }

  return false
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
 * THE FOLD RUNS ONCE, HERE, AND EVERY RULE BELOW SEES ONLY ITS OUTPUT. That is
 * the point of it being one pass at the top rather than a change to four
 * patterns — see `fold`. The normalisation is NOT done in `scanText`, even
 * though that is where the string is built, because invites.ts reads the same
 * string and a change to what IT matches is not this change's to make.
 *
 * READ TWICE, ONCE AS POSTED AND ONCE PERCENT-DECODED, and per rule rather than
 * per pass. Doing all four rules on the raw text and only then falling back to
 * the decoded text would let a low-priority rule matching the raw text outrank a
 * high-priority rule that only the decoded text shows — the message would be
 * removed either way, but the reason printed would be the less informative one.
 * The decode is skipped outright when the message has no `%` in it, which is
 * nearly every message, and the folded pair are compared so an unchanged decode
 * costs no second scan.
 *
 * FIRST HIT WINS AND NOTHING KEEPS LOOKING. One removal needs one reason, and
 * every rule below the one that fired would be describing the same deletion.
 */
export function scanLinks(content: string, ourIps: readonly string[]): LinkReason | null {
  const folded = fold(content)
  const decoded = fold(percentDecode(content))

  for (const rule of RULES) {
    if (rule.fires(folded, ourIps)) return rule.why
    if (decoded !== folded && rule.fires(decoded, ourIps)) return rule.why
  }

  return null
}
