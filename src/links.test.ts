import { describe, expect, it } from 'vitest'

import { scanLinks, SHORTENERS, type LinkReason } from './links.ts'

/**
 * The link policy.
 *
 * THE PATTERNS ARE THE PRODUCT, so most of this file is one-line strings fed to
 * `scanLinks`. Every case is either a form somebody has actually typed into a
 * Discord channel or a form somebody would type on purpose after being deleted
 * once — a port, a backslash, an escaped dot, a percent escape, italics, a code
 * fence. Happy-path coverage of `bit.ly/x` proves nothing; the question this
 * file exists to answer is what the rules do at their edges.
 *
 * NOTHING HERE TOUCHES THE NETWORK, AND THERE IS NOTHING TO INJECT TO KEEP IT
 * THAT WAY. That is the whole point of the file being separate from invites.ts:
 * `scanLinks` is a pure function of a string and a list, so the entire policy is
 * exercised offline by construction rather than by remembering to pass a fake.
 *
 * THE COST OF A FALSE POSITIVE HERE IS A DELETED MESSAGE, which is why the
 * must-not-match table is as long as the must-match one. In invites.ts a loose
 * pattern costs one lookup that resolves to nothing and deletes nobody's post;
 * here a match IS the removal, so the two tables carry equal weight and the
 * second one is not a formality.
 */

/**
 * The addresses this deployment's own servers answer on.
 *
 * WRITTEN OUT RATHER THAN IMPORTED FROM THE MODULE, because they are not in the
 * module: the allowlist is configuration, and every assertion below passes it in
 * as an argument. A test that shared a constant with the matcher could not tell
 * a wired-up allowlist from a hard-coded one, and there is a case at the bottom
 * that proves the difference.
 */
const OUR_IP = '3.130.92.28'
const OUR_OTHER_IP = '18.222.244.205'
const OUR_IPS = [OUR_IP, OUR_OTHER_IP]

/**
 * Every form that must cost the poster their message, and WHICH RULE says so.
 *
 * ONE TABLE FOR ALL FOUR RULES RATHER THAN FOUR TABLES, and the reason is the
 * second column. The rules share one input string and one priority order, so the
 * interesting failures are the ones a per-rule table cannot see: a shortener form
 * that starts matching as an address, an IP form that starts matching as a
 * `fivem://` target, a row whose reason silently changes when somebody reorders
 * `RULES`. Every row here asserts the reason as well as the removal, so the
 * order is pinned by every row rather than by a handful of cases about it.
 *
 * THE MUST-NOT-MATCH TABLE IS SHARED FOR THE SAME REASON READ BACKWARDS: "no
 * rule fires" is one assertion, and four separate tables would each be blind to
 * the other three rules' false positives.
 *
 * A TABLE RATHER THAN A TEST PER FORM, which is invites.test.ts's argument and
 * is what makes the next bypass anybody finds a one-line addition here — in the
 * file where the rest of the class already lives — instead of a new `it` block
 * written by somebody who then patches one pattern for one instance.
 */
const DELETED: [string, LinkReason][] = [
  // ---- Addresses. Any IPv4 shape that is not ours, in any wrapper. ----

  // The plain form, so the table is anchored to something known-good.
  ['1.2.3.4', 'foreign-ip'],

  // THE THREE THE OWNER WAS ASKED ABOUT BY NAME. Loopback, a private range and a
  // public resolver: no carve-out for any of them, because those discussions do
  // not happen in this guild.
  ['127.0.0.1', 'foreign-ip'],
  ['192.168.1.1', 'foreign-ip'],
  ['1.0.0.1', 'foreign-ip'],

  // NO VERSION-NUMBER EXCEPTION EITHER, which is the same decision stated a
  // fourth way. `v1.2.3.4` is four dotted numbers, and four dotted numbers in a
  // game community are an address.
  ['v1.2.3.4', 'foreign-ip'],

  // A bare address needs no `fivem://` wrapper to be an advert. This is the form
  // people actually post.
  ['come play on 5.6.7.8 instead', 'foreign-ip'],
  ['5.6.7.8:30120', 'foreign-ip'],
  ['https://9.9.9.9/', 'foreign-ip'],
  ['0.0.0.0', 'foreign-ip'],

  // THE TWO ROWS THE ALLOWLIST BOUNDARY EXISTS FOR. A bare substring test, or a
  // match with no fences on it, exempts both of these: the first is a host
  // somebody else controls that merely BEGINS with our address, the second is a
  // different address that merely CONTAINS it.
  ['3.130.92.28.evil.com', 'foreign-ip'],
  ['13.130.92.28', 'foreign-ip'],
  // The same two ideas from the other side, and with the escape in the middle.
  ['x3.130.92.28', 'foreign-ip'],
  ['3.130.92.28-evil.com', 'foreign-ip'],
  ['3.130.92.28\\.evil.com', 'foreign-ip'],
  // Our address named first and somebody else's second is the ordinary shape of
  // a poach, and must not be exempted because it mentioned us.
  ['we were on 3.130.92.28, now we are on 9.9.9.9', 'foreign-ip'],

  // Escaped dots. Discord drops a backslash before punctuation, so this renders
  // as the address and arrives here with the backslashes still on it.
  ['127\\.0\\.0\\.1', 'foreign-ip'],
  // The unicode label separators, which a resolver maps to `.` before use.
  ['127\u30020\u30020\u30021', 'foreign-ip'],
  ['192\uFF0E168\uFF0E1\uFF0E1', 'foreign-ip'],
  // Percent escapes: nothing matches the raw text, so the decoded pass is the
  // whole of the answer for this row.
  ['%31%32%37%2E0%2E0%2E1', 'foreign-ip'],

  // ---- Public listings. cfx.re and the FiveM server browser. ----

  ['cfx.re/join/kvkq6v', 'server-listing'],
  ['https://cfx.re/join/kvkq6v', 'server-listing'],
  ['www.cfx.re/join/kvkq6v', 'server-listing'],
  // CASE-SENSITIVE CODES, BOTH SPELLINGS REMOVED. Measured, `/join/kvkq6v`
  // resolves and `/join/KVKQ6V` 404s — so case is part of a code's identity, and
  // two spellings are potentially two different servers. The only way to tell
  // which is live is to fetch it, which this file never does, so both go.
  ['cfx.re/join/KVKQ6V', 'server-listing'],
  ['CFX.RE/JOIN/kvkq6v', 'server-listing'],
  // The host boundary, all of it: port, root dot, repeated and reversed slashes.
  ['cfx.re:443//join//kvkq6v', 'server-listing'],
  ['cfx.re./join/kvkq6v', 'server-listing'],
  ['cfx.re\\join\\kvkq6v', 'server-listing'],
  ['cfx\\.re/join/kvkq6v', 'server-listing'],
  ['cfx\u3002re/join/kvkq6v', 'server-listing'],
  ['cfx%2Ere/join/kvkq6v', 'server-listing'],
  // The markup people actually paste links in.
  ['<https://cfx.re/join/kvkq6v>', 'server-listing'],
  ['_cfx.re/join/kvkq6v_', 'server-listing'],
  ['[come join](https://cfx.re/join/kvkq6v)', 'server-listing'],
  ['`cfx.re/join/kvkq6v`', 'server-listing'],
  // The server browser's detail page is the same statement at another address,
  // and is anchored at `fivem.net` so the `servers.` subdomain is not a branch.
  ['servers.fivem.net/servers/detail/9m4vjq', 'server-listing'],
  ['https://servers.fivem.net/servers/detail/9m4vjq', 'server-listing'],
  ['fivem.net/servers/detail/9m4vjq', 'server-listing'],
  ['servers.fivem.net:443//servers//detail//9m4vjq', 'server-listing'],

  // ---- fivem://connect. Both real shapes, and the one they do not cover. ----

  // Shape one, from the CitizenFX source: an address and a port.
  ['fivem://connect/1.2.3.4:30120', 'fivem-connect'],
  // Shape two: a cfx join code. The listing rule would have caught this as well;
  // the reason reported is the more specific of the two.
  ['fivem://connect/cfx.re/join/kvkq6v', 'fivem-connect'],
  // THE ROW THAT MAKES THIS RULE MORE THAN A DUPLICATE OF THE OTHER TWO. A
  // hostname target names no address and no listing, so nothing else here sees
  // it — and it is a one-click connect to somebody else's server.
  ['fivem://connect/play.someserver.com', 'fivem-connect'],
  ['FIVEM://CONNECT/play.someserver.com', 'fivem-connect'],
  // The scheme's colon takes the markdown escape like every other delimiter.
  ['fivem\\://connect/play.someserver.com', 'fivem-connect'],
  ['fivem://connect\\play.someserver.com', 'fivem-connect'],
  // The allowlist is anchored inside this rule too: the target is greedy over
  // dots, so a host that merely begins with our address is not our address.
  ['fivem://connect/3.130.92.28.evil.com', 'fivem-connect'],
  // A connect link to nowhere is still a connect link.
  ['fivem://connect/', 'fivem-connect'],

  // ---- Shorteners. By domain, never by following one. ----

  ['bit.ly/3xY9k', 'link-shortener'],
  ['https://bit.ly/3xY9k', 'link-shortener'],
  ['BIT.LY/3XY9K', 'link-shortener'],
  ['tinyurl.com/abcdef', 'link-shortener'],
  ['t.co/aBc123', 'link-shortener'],
  ['is.gd/abcdef', 'link-shortener'],
  // THE dsc.gg GAP, RECORDED AS UNCLOSABLE IN blitz-bot#10. Nothing in this
  // string says "discord", there is no invite code to extract and no lookup
  // would help — and it is caught anyway, by the domain.
  ['dsc.gg/someguild', 'link-shortener'],
  ['invite.gg/someguild', 'link-shortener'],
  ['discord.link/someguild', 'link-shortener'],
  // The host boundary again, because it is the same boundary.
  ['bit.ly:443//3xY9k', 'link-shortener'],
  ['bit.ly./3xY9k', 'link-shortener'],
  ['bit.ly\\3xY9k', 'link-shortener'],
  ['bit\\.ly/3xY9k', 'link-shortener'],
  ['bit\u3002ly/3xY9k', 'link-shortener'],
  ['bit%2Ely/3xY9k', 'link-shortener'],
  ['_bit.ly/3xY9k_', 'link-shortener'],
  ['`bit.ly/3xY9k`', 'link-shortener'],
  ['<https://bit.ly/3xY9k>', 'link-shortener'],
  // A MALFORMED ESCAPE ELSEWHERE MUST NOT COST THE DECODE. This is the row that
  // rules out `decodeURIComponent`, which throws on the whole string for the `%`
  // in `100%` and would hand anyone who noticed a four-character bypass.
  ['100% sure, bit%2Ely/3xY9k', 'link-shortener'],

  // ---- Two rules at once. Which reason is reported is the assertion. ----

  // The listing outranks the address: it says more about the message.
  ['1.2.3.4 and cfx.re/join/kvkq6v', 'server-listing'],
  // The address outranks the shortener: the shortener is the only reason that
  // describes something the bot did NOT read.
  ['bit.ly/3xY9k and 127.0.0.1', 'foreign-ip'],
  ['cfx.re/join/kvkq6v and bit.ly/3xY9k', 'server-listing'],
  // All four at once.
  ['fivem://connect/1.2.3.4 cfx.re/join/kvkq6v bit.ly/3xY9k 127.0.0.1', 'fivem-connect'],
]

/**
 * Every form that must be left exactly where it is.
 *
 * THE HALF THAT KEEPS THE POLICY HONEST, and in this file it is the expensive
 * half. A rule that is too loose does not cost a wasted lookup, it deletes a
 * member's message about nothing, with no way for them to tell why. The rows
 * fall into three groups: this community's own servers in every form anybody
 * writes them, other people's domains that merely end in one of ours, and the
 * near-misses that are not links to anything.
 */
const KEPT: string[] = [
  // ---- Our own servers, in every form. ----

  [OUR_IP, OUR_OTHER_IP].join(' and '),
  '3.130.92.28',
  '18.222.244.205',
  '3.130.92.28:30120',
  '18.222.244.205:30120',
  'https://3.130.92.28/',
  'https://18.222.244.205:30120/',
  'fivem://connect/3.130.92.28',
  'fivem://connect/3.130.92.28:30120',
  'fivem://connect/18.222.244.205:30120',
  '<fivem://connect/3.130.92.28>',
  '[click to join](fivem://connect/18.222.244.205)',
  // A TRAILING DOT IS A FULL STOP, NOT A LONGER HOST. This is the row that stops
  // `gluedRight` reading only the next character: `28.evil.com` continues the
  // host, `28.` at the end of a sentence does not.
  'we are back up on 3.130.92.28.',
  'come play on 3.130.92.28, see you there',
  '(3.130.92.28)',
  '_3.130.92.28_',
  // The escapes and the unicode separators fold to the same address, so the
  // allowlist has to recognise them or the owner's own posts get deleted.
  '3\\.130\\.92\\.28',
  '3\u3002130\u300292\u300228',
  '18\uFF0E222\uFF0E244\uFF0E205',
  '3%2E130%2E92%2E28',
  // A stray `%` runs the decode and must not break the exemption.
  '100% sure, 3.130.92.28 is up',

  // ---- Other people's domains that end in one of ours. ----

  'mybit.ly/3xY9k',
  'not-bit.ly/3xY9k',
  'mybit\\.ly/3xY9k',
  'notcfx.re/join/kvkq6v',
  'my-cfx.re/join/kvkq6v',
  'notfivem.net/servers/detail/9m4vjq',
  'notdsc.gg/someguild',
  'chat.co/abcdef',

  // ---- Platform-native short domains, which are not shorteners. ----

  // MEASURED AND DELIBERATE: `youtu.be` is technically a shortener and must
  // never be treated as one, because the domain says where you end up. The rest
  // are the same argument, and they are what a game community posts all day.
  'youtu.be/dQw4w9WgXcQ',
  'https://youtu.be/dQw4w9WgXcQ',
  't.me/somechannel',
  'redd.it/abcdef',
  'wa.me/1234567890',
  'amzn.to/3abcdef',

  // ---- Near-misses that are not links to anything. ----

  // `/join/` IS MANDATORY, MEASURED: `cfx.re/<code>` alone 404s. Removing a
  // message over a dead URL is removing it over nothing.
  'cfx.re/kvkq6v',
  'cfx.re/join/',
  'cfx.re',
  'servers.fivem.net',
  'fivem.net/servers/9m4vjq',
  // A shortener domain with no path points at nothing.
  'bit.ly',
  'bit.ly/',
  'dsc.gg',
  // The scheme without the connect path is not a connect link.
  'fivem://',
  'the fivem client crashed again',

  // ---- Not IPv4 shapes, because an octet is one to three digits. ----

  'version 1.2.3 of the mod',
  '1.2.3.4567',
  '2024.10.5.1',
  '3.130.92.281234',

  // ---- Somebody else's rule. ----

  // Discord invites belong to invites.ts, which resolves them before deleting
  // anything. This file must have no opinion at all about one.
  'discord.gg/abc123',
  'https://discord.com/invite/abc123',

  // ---- Ordinary conversation. ----

  'good game everyone',
  'we play at 8pm, be there',
  'gg wp, 3 kills to 1',
]

describe('scanLinks — the hostile-form tables', () => {
  it.each(DELETED)('removes %s under %s', (content: string, why: LinkReason) => {
    expect(scanLinks(content, OUR_IPS)).toBe(why)
  })

  it.each(KEPT)('leaves %s alone', (content: string) => {
    expect(scanLinks(content, OUR_IPS)).toBeNull()
  })
})

/**
 * THE ALLOWLIST IS CONFIGURATION AND NOTHING HERE IS HARD-CODED, which the
 * tables above cannot show on their own: they all pass the same two addresses,
 * so a matcher with those two baked into it would pass every row.
 */
describe('scanLinks — the allowlist is an argument', () => {
  it('exempts whatever it is given, not whatever this repo was written with', () => {
    expect(scanLinks('9.9.9.9', ['9.9.9.9'])).toBeNull()
    expect(scanLinks('fivem://connect/9.9.9.9:30120', ['9.9.9.9'])).toBeNull()
  })

  it('removes the owner\'s own address when it is not on the list it was given', () => {
    // Not a suggestion that anybody should run it this way — `loadConfig`
    // defaults the list precisely so nobody does. It is the proof that the
    // exemption comes from the argument and from nowhere else.
    expect(scanLinks(OUR_IP, [])).toBe('foreign-ip')
    expect(scanLinks(`fivem://connect/${OUR_IP}`, [])).toBe('fivem-connect')
  })

  it('exempts each of the two addresses independently', () => {
    expect(scanLinks(OUR_IP, [OUR_OTHER_IP])).toBe('foreign-ip')
    expect(scanLinks(OUR_OTHER_IP, [OUR_IP])).toBe('foreign-ip')
  })
})

/**
 * The shortener list, checked as a list rather than only through its behaviour.
 *
 * THE EXCLUSIONS ARE THE PART WORTH PINNING. A behavioural test proves
 * `youtu.be/x` survives today; this proves nobody can make it not survive by
 * adding one line to the constant, which is exactly how that mistake would be
 * made.
 */
describe('SHORTENERS — what the list may and may not contain', () => {
  it.each(['youtu.be', 'redd.it', 'wa.me', 't.me', 'amzn.to', 'fb.me', 'discord.gg'])(
    'does not contain the platform-native domain %s',
    (host: string) => {
      expect(SHORTENERS).not.toContain(host)
    },
  )

  it('contains the Discord redirectors, which is the gap blitz-bot#10 recorded', () => {
    expect(SHORTENERS).toContain('dsc.gg')
    expect(SHORTENERS).toContain('invite.gg')
  })

  it('holds only letters, digits and dots, which is all the builder escapes', () => {
    for (const host of SHORTENERS) expect(host).toMatch(/^[a-z0-9]+(?:\.[a-z0-9]+)+$/)
  })

  it('lists every domain once', () => {
    expect(new Set(SHORTENERS).size).toBe(SHORTENERS.length)
  })
})

/**
 * REGRESSION-SHAPED BY CONSTRUCTION. Three of the four rules answer with
 * `RegExp.prototype.test`, and a global regex carries `lastIndex` between calls —
 * so the same constant asked the same question twice answers differently, and
 * the classic form of that bug scans every other message. These are the cases
 * that would fail the moment somebody adds a `g` to one of those patterns.
 */
describe('scanLinks — statelessness', () => {
  it('gives the same answer for the same input every time', () => {
    for (const [content, why] of DELETED) {
      expect(scanLinks(content, OUR_IPS)).toBe(why)
      expect(scanLinks(content, OUR_IPS)).toBe(why)
      expect(scanLinks(content, OUR_IPS)).toBe(why)
    }
  })

  it('does not leak state between different messages', () => {
    expect(scanLinks('bit.ly/3xY9k', OUR_IPS)).toBe('link-shortener')
    expect(scanLinks('good game everyone', OUR_IPS)).toBeNull()
    expect(scanLinks('bit.ly/3xY9k', OUR_IPS)).toBe('link-shortener')
    expect(scanLinks('cfx.re/join/kvkq6v', OUR_IPS)).toBe('server-listing')
    expect(scanLinks('good game everyone', OUR_IPS)).toBeNull()
    expect(scanLinks('cfx.re/join/kvkq6v', OUR_IPS)).toBe('server-listing')
  })

  it('is not disturbed by the decoded pass having run on the message before', () => {
    expect(scanLinks('bit%2Ely/3xY9k', OUR_IPS)).toBe('link-shortener')
    expect(scanLinks('bit.ly/3xY9k', OUR_IPS)).toBe('link-shortener')
    expect(scanLinks('bit%2Ely/3xY9k', OUR_IPS)).toBe('link-shortener')
  })
})

describe('scanLinks — what a hostile message costs', () => {
  it('finishes in bounded time on a long string of near-matches', () => {
    /**
     * A REGEX DENIAL OF SERVICE IS A WAY TO STOP THIS BOT, and these patterns
     * run on the message handler's own path against strings a stranger wrote —
     * ahead of the invite scan, so a bomb here is reached by every message in
     * the guild.
     *
     * EVERY UNIT IS A NEAR-MISS BY CONSTRUCTION. Each drives a part of a pattern
     * that repeats — the port digits, the slash run, the `fivem://` target run,
     * the octets — to the far end and then ends in a character that cannot
     * continue the match, which is the shape that makes an engine walk back over
     * all of it.
     *
     * IT IS A REAL GUARD AND NOT A CEREMONY. Rewriting `SLASHES` as the
     * alternation `(?:\\?/|\\)+` — still a correct fix for every row in the
     * tables above, and the obvious way to spell it — gives a run of k
     * separators 2^k parses; invites.ts measured that same rewrite at a clean
     * doubling per token, hours for forty of them.
     *
     * The bound is loose on purpose. The real patterns do this in under a
     * millisecond, so a second is a wall a catastrophic one hits and a loaded CI
     * runner never does.
     */
    const nearCfx = `cfx.re.:${'9'.repeat(24)}${'\\/'.repeat(8)}${'/'.repeat(12)}join.`
    const nearShort = `bit.ly.:${'9'.repeat(24)}${'\\/'.repeat(8)}${'/'.repeat(12)}.`
    const nearFivem = `fivem:${'\\/'.repeat(8)}${'/'.repeat(12)}connect.`
    const nearIp = `${'9'.repeat(4)}.${'9'.repeat(4)}.${'9'.repeat(4)}.${'9'.repeat(4)}.`
    const unit = nearCfx + nearShort + nearFivem + nearIp
    const hostile = unit.repeat(Math.ceil(50_000 / unit.length))

    expect(hostile.length).toBeGreaterThanOrEqual(50_000)

    const started = performance.now()
    const why = scanLinks(hostile, OUR_IPS)
    const elapsed = performance.now() - started

    // Asserted so the timing means something: if any of these became a match the
    // scan would be fast for the wrong reason and the guard would be empty.
    expect(why).toBeNull()
    expect(elapsed).toBeLessThan(1_000)
  })

  it('finishes in bounded time when the decoded pass runs as well', () => {
    /**
     * THE SECOND PASS IS A SECOND PLACE TO PUT A BOMB, and it is the cheaper of
     * the two to arm: one `%` anywhere in the message makes every rule run
     * twice, over a string the poster wrote both versions of. The guard above
     * cannot see this one, because its string has no `%` in it and so never
     * reaches the decode at all.
     *
     * THE UNIT SPELLS ITS SEPARATORS BOTH WAYS. `%2F` and `%5C` are invisible to
     * the raw pass and become the long run the decoded pass has to walk.
     */
    const nearCfx = `cfx.re.:${'9'.repeat(24)}${'%2F'.repeat(8)}${'\\'.repeat(12)}join.`
    const nearShort = `bit.ly.:${'9'.repeat(24)}${'%5C'.repeat(8)}${'/'.repeat(12)}.`
    const nearFivem = `fivem:${'%2F'.repeat(8)}${'\\'.repeat(12)}connect.`
    const nearIp = `%39${'9'.repeat(3)}.${'9'.repeat(4)}.${'9'.repeat(4)}.${'9'.repeat(4)}.`
    const unit = nearCfx + nearShort + nearFivem + nearIp
    const hostile = unit.repeat(Math.ceil(50_000 / unit.length))

    expect(hostile.length).toBeGreaterThanOrEqual(50_000)
    // If this stopped holding the test would be timing one pass and claiming to
    // have timed two.
    expect(hostile).toContain('%')

    const started = performance.now()
    const why = scanLinks(hostile, OUR_IPS)
    const elapsed = performance.now() - started

    expect(why).toBeNull()
    expect(elapsed).toBeLessThan(1_000)
  })
})
