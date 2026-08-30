import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInviteCache, findInviteCodes, scanMessage, type InviteResolver } from './invites.ts'

/**
 * The invite detector.
 *
 * THE PATTERN IS THE PRODUCT, so most of this file is one-line strings fed to
 * `findInviteCodes`. Every case here is either a form somebody has actually
 * typed into a Discord channel or a form somebody would type on purpose after
 * being deleted once — markdown italics, a code fence, an angle-bracketed
 * link. Happy-path coverage of `discord.gg/abc123` proves nothing; the
 * question this file exists to answer is what the pattern does at its edges.
 *
 * NOTHING HERE TOUCHES THE NETWORK. The resolver is an argument, so the whole
 * `scanMessage` half runs against functions defined three lines above their
 * assertions, including the ones that fail the way Discord fails.
 */

const OURS = '111111111111111111'
const THEIRS = '222222222222222222'

/**
 * `scanMessage` logs a warn line when a resolver throws, and warns go to
 * stderr. Captured rather than silenced, because one test asserts on it: a
 * swallowed exception that leaves no trace is the failure mode that comment
 * exists to prevent, and it would be silently removable without this.
 */
const stderr: string[] = []

/**
 * A clock a test can wind forward.
 *
 * THE TTL IS TESTED WITHOUT WAITING FOR IT. A test that proves expiry with a
 * real minute is a test nobody runs, and one that proves it with a 5ms TTL and
 * a `setTimeout` is a test that fails on a loaded CI runner for reasons that
 * have nothing to do with this file.
 */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

/** A message carrying `count` distinct invite codes, `code0` upwards. */
function manyCodes(count: number): string {
  return Array.from({ length: count }, (_, i) => `discord.gg/code${i}`).join(' ')
}

beforeEach(() => {
  stderr.length = 0
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString())
    return true
  }) as unknown as typeof process.stderr.write)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('findInviteCodes — the forms an invite arrives in', () => {
  it('finds a bare discord.gg link', () => {
    expect(findInviteCodes('discord.gg/abc123')).toEqual(['abc123'])
  })

  it('finds both schemes', () => {
    expect(findInviteCodes('https://discord.gg/abc123')).toEqual(['abc123'])
    expect(findInviteCodes('http://discord.gg/abc123')).toEqual(['abc123'])
  })

  it('finds a www host', () => {
    expect(findInviteCodes('www.discord.gg/abc123')).toEqual(['abc123'])
    expect(findInviteCodes('https://www.discord.gg/abc123')).toEqual(['abc123'])
  })

  it('finds the /invite/ paths on discord.com and discordapp.com', () => {
    expect(findInviteCodes('discord.com/invite/abc123')).toEqual(['abc123'])
    expect(findInviteCodes('https://discord.com/invite/abc123')).toEqual(['abc123'])
    expect(findInviteCodes('discordapp.com/invite/abc123')).toEqual(['abc123'])
    expect(findInviteCodes('https://discordapp.com/invite/abc123')).toEqual(['abc123'])
  })

  it('finds the /invite/ form of a discord.gg link', () => {
    // A real, working shape of the link. Without a branch for it the code
    // comes out as the literal string "invite" and the message survives.
    expect(findInviteCodes('https://discord.gg/invite/abc123')).toEqual(['abc123'])
  })

  it('finds hosts other than the bare one, because they are all Discord', () => {
    // canary and ptb serve live invites. Nobody but Discord can put a host
    // under discord.gg, so a subdomain is not an impersonation risk.
    expect(findInviteCodes('https://canary.discord.com/invite/abc123')).toEqual(['abc123'])
    expect(findInviteCodes('https://ptb.discord.com/invite/abc123')).toEqual(['abc123'])
  })

  it('matches the domain in any case and keeps the code in its own', () => {
    // The single most expensive detail to get wrong: invite codes are
    // case-sensitive, so lowercasing the capture resolves the wrong server or
    // nothing at all.
    expect(findInviteCodes('DISCORD.GG/AbC123')).toEqual(['AbC123'])
    expect(findInviteCodes('DiScOrD.gG/AbC123')).toEqual(['AbC123'])
    expect(findInviteCodes('HTTPS://WWW.DISCORD.COM/INVITE/AbC123')).toEqual(['AbC123'])
  })

  it('finds an invite buried mid-sentence', () => {
    expect(findInviteCodes('hey everyone come to discord.gg/abc123 we have events')).toEqual([
      'abc123',
    ])
  })

  it('finds several invites in one message', () => {
    expect(
      findInviteCodes('discord.gg/abc123 and also https://discord.com/invite/def456'),
    ).toEqual(['abc123', 'def456'])
  })

  it('finds invites spread across lines', () => {
    const content = ['come join us', 'discord.gg/abc123', '', 'or discordapp.com/invite/def456'].join(
      '\n',
    )
    expect(findInviteCodes(content)).toEqual(['abc123', 'def456'])
  })

  it('finds a hyphenated vanity code', () => {
    expect(findInviteCodes('discord.gg/blitz-royale')).toEqual(['blitz-royale'])
  })
})

describe('findInviteCodes — punctuation and markup around the code', () => {
  it('leaves trailing sentence punctuation out of the code', () => {
    expect(findInviteCodes('join discord.gg/abc123.')).toEqual(['abc123'])
    expect(findInviteCodes('join discord.gg/abc123!')).toEqual(['abc123'])
    expect(findInviteCodes('join discord.gg/abc123, it is great')).toEqual(['abc123'])
    expect(findInviteCodes('join discord.gg/abc123? maybe')).toEqual(['abc123'])
    expect(findInviteCodes('(discord.gg/abc123)')).toEqual(['abc123'])
    expect(findInviteCodes('"discord.gg/abc123"')).toEqual(['abc123'])
  })

  it('reads a markdown link', () => {
    expect(findInviteCodes('[click me](https://discord.gg/abc123)')).toEqual(['abc123'])
  })

  it('is not fooled by markdown italics', () => {
    // `_x_` is Discord's own italic syntax and the link inside it still works,
    // so the leading underscore must not read as part of a hostname and the
    // trailing one must not read as part of the code.
    expect(findInviteCodes('_discord.gg/abc123_')).toEqual(['abc123'])
    expect(findInviteCodes('**discord.gg/abc123**')).toEqual(['abc123'])
    expect(findInviteCodes('~~discord.gg/abc123~~')).toEqual(['abc123'])
  })

  it('is not fooled by angle brackets', () => {
    // The `<...>` form is how you post a link without an embed. Still a link.
    expect(findInviteCodes('<https://discord.gg/abc123>')).toEqual(['abc123'])
  })

  it('looks inside a code fence', () => {
    // Deliberate. Discord will not linkify this, but it is still legible and
    // copyable, and it is the first thing somebody tries after a deletion.
    expect(findInviteCodes('`discord.gg/abc123`')).toEqual(['abc123'])
    expect(findInviteCodes('```\ndiscord.gg/abc123\n```')).toEqual(['abc123'])
  })

  it('drops a query string', () => {
    expect(findInviteCodes('discord.gg/abc123?event=456')).toEqual(['abc123'])
    expect(findInviteCodes('https://discord.com/invite/abc123?utm_source=x')).toEqual(['abc123'])
  })

  it('drops a trailing path segment and a trailing slash', () => {
    expect(findInviteCodes('discord.gg/abc123/')).toEqual(['abc123'])
    expect(findInviteCodes('discord.gg/abc123/whatever')).toEqual(['abc123'])
  })

  it('handles an invite at the very start and the very end of a message', () => {
    expect(findInviteCodes('discord.gg/abc123 come say hi')).toEqual(['abc123'])
    expect(findInviteCodes('come say hi discord.gg/abc123')).toEqual(['abc123'])
  })
})

describe('findInviteCodes — what must not match', () => {
  it('ignores a domain that merely ends in discord.gg', () => {
    expect(findInviteCodes('mydiscord.gg/abc123')).toEqual([])
    expect(findInviteCodes('https://mydiscord.gg/abc123')).toEqual([])
    expect(findInviteCodes('not-discord.gg/abc123')).toEqual([])
  })

  it('ignores a domain that merely ends in discord.com', () => {
    expect(findInviteCodes('notdiscord.com/invite/x')).toEqual([])
    expect(findInviteCodes('https://notdiscord.com/invite/abc123')).toEqual([])
  })

  it('ignores discord.gg with no code at all', () => {
    expect(findInviteCodes('we are on discord.gg somewhere')).toEqual([])
    expect(findInviteCodes('discord.gg')).toEqual([])
  })

  it('ignores an empty code', () => {
    expect(findInviteCodes('discord.gg/')).toEqual([])
    expect(findInviteCodes('discord.gg//')).toEqual([])
    expect(findInviteCodes('https://discord.com/invite/')).toEqual([])
  })

  it('ignores the .com host without the invite path', () => {
    // discord.com/channels/... is a jump link to a message, posted constantly
    // and never an invite.
    expect(findInviteCodes('discord.com/abc123')).toEqual([])
    expect(findInviteCodes('https://discord.com/channels/111/222/333')).toEqual([])
  })

  it('ignores hosts that mix the two forms up', () => {
    expect(findInviteCodes('discordapp.gg/abc123')).toEqual([])
    expect(findInviteCodes('discord.gg.example.com/invite/abc123')).toEqual([])
  })

  it('ignores prose that has no invite in it', () => {
    expect(findInviteCodes('')).toEqual([])
    expect(findInviteCodes('good game everyone')).toEqual([])
    expect(findInviteCodes('discord is down again')).toEqual([])
  })
})

/**
 * One sentinel code for the whole host-boundary table.
 *
 * MIXED CASE AND A HYPHEN, so every row in the table also re-proves that the
 * code comes back exactly as it was written — a row that yielded `abc-123` or
 * `aBc` would be a row that found the link and then handed the resolver a code
 * for a server nobody was advertising.
 */
const CODE = 'aBc-123'

/**
 * Every form that must still give up its code.
 *
 * THE BUG THIS TABLE PINS: the pattern used to demand a literal `/` immediately
 * after the hostname, so ANYTHING a URL legally allows in between defeated it.
 * `https://discord.gg:443/x` — one token, added by anyone who tried once —
 * yielded nothing at all, and a code the scanner never sees is an advert for
 * somebody else's server left standing in the channel. The root dot, the double
 * slash and the `:443` on the `.com` host were the same hole wearing other hats.
 *
 * A TABLE RATHER THAN A TEST PER FORM, and that is the point of it: the next
 * bypass anybody finds is a one-line addition here, in the file where the rest
 * of the class already lives, instead of a new `it` block written by somebody
 * who then patches the pattern for that instance alone. Every combination below
 * is a row precisely because the combinations are where per-instance patches
 * fall down.
 */
const HOSTILE_MATCHES: string[] = [
  // The plain form, so the table is anchored to something known-good.
  `https://discord.gg/${CODE}`,

  // Ports. The proven bypass, then the variants around it.
  `https://discord.gg:443/${CODE}`,
  `https://discord.com:443/invite/${CODE}`,
  `discord.gg:80/${CODE}`,
  `discord.gg:65535/${CODE}`,
  // An empty port is a legal URL meaning "the scheme's default", and browsers
  // normalise it away and load the invite.
  `https://discord.gg:/${CODE}`,

  // The FQDN root dot. `discord.gg.` resolves to the identical host.
  `https://discord.gg./${CODE}`,
  `https://discord.com./invite/${CODE}`,

  // Repeated slashes, which no URL parser treats as a typo.
  `https://discord.gg//${CODE}`,
  `https://discord.gg.///${CODE}`,
  `discord.gg/invite//${CODE}`,
  `https://discord.com//invite//${CODE}`,

  // All of it at once. These are the rows a per-instance patch fails on.
  `https://discord.gg.:443//${CODE}`,
  `discord.gg.:80//invite//${CODE}`,
  `https://discordapp.com.:8080//invite//${CODE}`,
  `https://canary.discord.com:443/invite/${CODE}`,
  `https://ptb.discord.com.:443//invite//${CODE}`,
  `www.discord.gg:443/${CODE}`,
  `discord.gg:443/invite/${CODE}`,

  // Backslash-escaped markdown. Discord drops a backslash before punctuation,
  // so all of these render as working links while the raw content the bot is
  // handed still carries the backslashes.
  `discord\\.gg/${CODE}`,
  `discord\\.gg\\/${CODE}`,
  `https://discord\\.com\\:443\\/invite\\/${CODE}`,
  `discord\\.gg\\.\\:443\\/\\/${CODE}`,

  // The boundary forms wrapped in the markup people actually post links in.
  `<https://discord.gg:443/${CODE}>`,
  `_discord.gg:443/${CODE}_`,
  `[join us](https://discord.gg:443/${CODE})`,
  `\`discord.gg:443/${CODE}\``,
  `🎉discord.gg.:443//${CODE}🎉`,
  // Case on the domain, case preserved on the code.
  `DISCORD.GG:443/${CODE}`,
  // Userinfo sits to the LEFT of the host, where this pattern has no opinion.
  `https://user@discord.gg:443/${CODE}`,

  // Trailing punctuation must still not weld itself onto the code now that
  // there is more pattern in front of it.
  `(discord.gg:443/${CODE})`,
  `join discord.gg:443/${CODE}.`,
  `discord.gg:443/${CODE}?event=1`,
  `discord.gg:443/${CODE}/whatever`,

  // A BACKSLASH IS A SLASH. The WHATWG URL spec folds `\` into `/` for http and
  // https, so a browser handed any of these loads the invite — measured with
  // node's own parser, `discord.gg\x` comes out as the host `discord.gg` and the
  // path `/x`, `\invite\x` as `/invite/x`, and `\\x` as `//x`.
  `https://discord.gg\\${CODE}`,
  `discord.gg\\${CODE}`,
  `https://discord.com\\invite\\${CODE}`,
  `discord.gg\\invite\\${CODE}`,
  `https://discord.gg\\\\${CODE}`,
  // A backslash and a slash in either order. The markdown reading calls the
  // first of these one escaped slash and the URL reading calls it two
  // separators; the pattern is written so that it never has to choose.
  `https://discord.gg\\/${CODE}`,
  `https://discord.gg/\\${CODE}`,
  `https://discord.gg.:443\\${CODE}`,
  `discord.gg.:80\\\\invite\\${CODE}`,

  // The unicode label separators. RFC 3490 and UTS #46 map all three to `.`
  // before the host is looked up, so these are not lookalikes of the real link —
  // after mapping they ARE it, and node's URL parser resolves every one of them
  // to the host discord.gg. Written as escapes rather than as the characters:
  // three dots that differ only in width are three rows nobody can tell apart in
  // a review, and which one a row is about is the entire content of the row.
  `https://discord\u3002gg/${CODE}`, // IDEOGRAPHIC FULL STOP
  `discord\uFF0Egg/${CODE}`, // FULLWIDTH FULL STOP
  `discord\uFF61gg/${CODE}`, // HALFWIDTH IDEOGRAPHIC FULL STOP
  `https://discord\u3002com/invite/${CODE}`,
  `https://www\u3002discord\uFF0Egg/${CODE}`,
  // The same character in the FQDN root position, and next to the other forms.
  `https://discord.gg\u3002:443//${CODE}`,
  `discord\uFF61gg\\${CODE}`,

  // Percent-encoding, which is decoded once before the pattern runs. Every one
  // of these yields nothing from the raw pass, so the decoded pass is the whole
  // of the answer for them.
  `https://discord.gg/%61%42%63%2D%31%32%33`,
  `https://discord.com/invite/%61%42%63%2D%31%32%33`,
  `https://discord.gg:443//%61%42%63%2D%31%32%33`,
  // The trick moved off the code and onto the host dot, the separator and the
  // path — the places a `%` bolted into the code class would never have reached.
  `https://discord%2Egg/${CODE}`,
  `discord.gg/%2F${CODE}`,
  `discord.gg/%69%6E%76%69%74%65/${CODE}`,
  `https://discord%2Egg:443\\${CODE}`,
  // A malformed escape elsewhere in the message must not cost the decode. This
  // is the row that rules out `decodeURIComponent`, which throws on the whole
  // string for the `%` in `100%` and would hand anyone who noticed a four
  // character bypass.
  `100% sure, discord.gg/%61%42%63%2D%31%32%33`,
]

/**
 * Every form that must still yield nothing.
 *
 * THE HALF THAT KEEPS THE FIX HONEST. Loosening the host boundary is one edit
 * away from matching somebody else's domain, and `mydiscord.gg` with a port on
 * it is the first thing a careless version of this fix would start deleting
 * people's messages over. The other rows are the existing guarantees restated
 * with a boundary in them: a `.com` host is only an invite on the `/invite`
 * path, and a boundary with no code after it is not a match.
 */
const HOSTILE_NON_MATCHES: string[] = [
  // Other people's domains, with every boundary form bolted on.
  `mydiscord.gg:443/${CODE}`,
  `not-discord.gg:443/${CODE}`,
  `notdiscord.com:443/invite/${CODE}`,
  `mydiscord.gg.:443//${CODE}`,
  // A markdown escape must not smuggle a foreign host past the lookbehind.
  `mydiscord\\.gg/${CODE}`,
  `discord.gg.example.com:443/invite/${CODE}`,
  `discord.gg-example.com/invite/${CODE}`,
  `discordapp.gg:443/${CODE}`,
  `discord.ggg:443/${CODE}`,

  // A boundary and then nothing. `discord.gg//` yielding no code is an existing
  // guarantee, and `//` becoming a legal separator must not turn it into one.
  `discord.gg:443/`,
  `discord.gg:443//`,
  `discord.gg.:443//`,
  `discord.gg:443`,
  `discord.gg.`,
  `https://discord.com:443/invite/`,

  // The `.com` host is an invite only on the `/invite` path. Jump links to a
  // message are posted constantly and are not adverts.
  `discord.com:443/${CODE}`,
  `discord.com.:443//${CODE}`,
  `https://discord.com:443/channels/111/222/333`,

  // Not a URL any client will load: the port is the only thing allowed there,
  // and it is digits.
  `discord.gg:44a3/${CODE}`,
  `discord.gg:443:443/${CODE}`,
  `discord.gg,443/${CODE}`,

  // A backslash separator must not smuggle a foreign host past the lookbehind
  // either. `mydiscord.gg\x` is a URL that loads — it just is not Discord's.
  `mydiscord.gg\\${CODE}`,
  `not-discord.gg\\${CODE}`,
  `notdiscord.com\\invite\\${CODE}`,
  // A separator and then nothing, in the new spelling.
  `discord.gg\\`,
  `discord.gg\\\\`,
  `discord.gg.:443\\`,

  // The unicode label separators do not loosen anything else. The lookbehind
  // still ends the argument, `gg` is still not `ggg`, and a `.com` host is still
  // only an invite on the `/invite` path.
  `mydiscord。gg/${CODE}`,
  `discord。ggg:443/${CODE}`,
  `discord．com/${CODE}`,
  `discord。gg。example。com/invite/${CODE}`,

  // Percent-encoding does not either. The decoded pass runs the same pattern,
  // so everything the pattern refuses it still refuses.
  `mydiscord.gg/%61%42%63%2D%31%32%33`,
  `discord.gg/%20`,
  `discord.gg/%2F`,
  // DECODED ONCE, LIKE A BROWSER. `%2561` is the literal text `%61` to every
  // client that will ever load this, so decoding to a fixed point would invent
  // an invite out of text nobody can click.
  `discord.gg/%2561%2542%2563%252D%2531%2532%2533`,
]

describe('findInviteCodes — the host boundary', () => {
  it.each(HOSTILE_MATCHES)('finds the code in %s', (content: string) => {
    expect(findInviteCodes(content)).toEqual([CODE])
  })

  it.each(HOSTILE_NON_MATCHES)('finds nothing in %s', (content: string) => {
    expect(findInviteCodes(content)).toEqual([])
  })
})

describe('findInviteCodes — what a hostile message costs', () => {
  it('finishes in bounded time on a long string of near-matches', () => {
    /**
     * A REGEX DENIAL OF SERVICE IS THE OTHER WAY TO STOP THIS BOT, and widening
     * the host boundary is exactly the edit that introduces one. This regex runs
     * on the message handler's own path against strings a stranger wrote, so a
     * pattern that backtracks exponentially is the API-budget outage the lookup
     * cap was fitted for, reached through the CPU instead.
     *
     * BOTH UNITS ARE NEAR-MISSES BY CONSTRUCTION. Each drives every part of the
     * pattern that repeats — the port digits, the slash run, the escaped slash
     * run — to the far end and then ends in a character that cannot begin a
     * code, which is the shape that makes an engine walk back over all of it.
     *
     * IT IS A REAL GUARD AND NOT A CEREMONY, and the numbers are why the runs
     * are the length they are. Rewriting the slash run as `(?:(?:\\?/)+)+` —
     * one pair of parentheses, and still a correct fix for every row in the
     * table above — takes this from 0.3ms to 3.4 SECONDS. Shorter runs and an
     * exponential pattern slips under the bound (16 slashes a unit: 234ms,
     * which passes); much longer and it stops finishing at all, which is still a
     * red build but a wedged one rather than this line failing.
     *
     * The bound is loose on purpose. The real pattern does this in under a
     * millisecond, so a second is a wall a catastrophic one hits and a loaded
     * CI runner never does.
     */
    const nearGg = `discord.gg.:${'9'.repeat(24)}${'\\/'.repeat(8)}${'/'.repeat(12)}.`
    const nearCom = `discord.com.:${'9'.repeat(24)}${'/'.repeat(12)}invite${'\\/'.repeat(8)}.`
    const unit = nearGg + nearCom
    const hostile = unit.repeat(Math.ceil(50_000 / unit.length))

    expect(hostile.length).toBeGreaterThanOrEqual(50_000)

    const started = performance.now()
    const codes = findInviteCodes(hostile)
    const elapsed = performance.now() - started

    // Asserted so the timing means something: if these ever became matches the
    // scan would be fast for the wrong reason and the guard would be empty.
    expect(codes).toEqual([])
    expect(elapsed).toBeLessThan(1_000)
  })

  it('finishes in bounded time when the decoded pass runs as well', () => {
    /**
     * THE SECOND PASS IS A SECOND PLACE TO PUT A BOMB, and it is the cheaper of
     * the two to arm: one `%` anywhere in the message is enough to make the
     * pattern run twice, over a string the poster wrote both versions of. The
     * guard above cannot see this one, because its string has no `%` in it and
     * so never reaches the decode at all.
     *
     * THE UNIT SPELLS ITS SEPARATORS BOTH WAYS. `%2F` and `%5C` are invisible to
     * the raw pass and become the long run the decoded pass has to walk, which
     * is the shape that drives each pass to the far end of a different part of
     * the pattern before failing on a trailing `.` that no code can start with.
     *
     * SAME ONE-SECOND WALL, deliberately. Two passes and a decode over 50k
     * characters is a couple of milliseconds in the real pattern; the bound is
     * loose enough that only a catastrophic pattern reaches it.
     */
    const nearGg = `discord.gg.:${'9'.repeat(24)}${'%2F'.repeat(8)}${'\\'.repeat(12)}.`
    const nearCom = `discord.com.:${'9'.repeat(24)}${'%2F'.repeat(12)}invite${'%5C'.repeat(8)}.`
    const unit = nearGg + nearCom
    const hostile = unit.repeat(Math.ceil(50_000 / unit.length))

    expect(hostile.length).toBeGreaterThanOrEqual(50_000)
    // If this ever stopped holding the test would be timing one pass and
    // claiming to have timed two.
    expect(hostile).toContain('%')

    const started = performance.now()
    const codes = findInviteCodes(hostile)
    const elapsed = performance.now() - started

    expect(codes).toEqual([])
    expect(elapsed).toBeLessThan(1_000)
  })
})

describe('findInviteCodes — deliberately loose to the left of the host', () => {
  // These all extract a code from something that is not really an invite link,
  // and every one of them is the cheap direction to be wrong in: the code goes
  // to the resolver, comes back unresolved, and unresolved is never deleted.
  // They are pinned here so that tightening the pattern is a decision somebody
  // makes on purpose, having read why it is loose.

  it('does not care what precedes the host, only what the host is', () => {
    expect(findInviteCodes('https://example.com/discord.gg/abc123')).toEqual(['abc123'])
  })

  it('lets an underscore through, because italics need it to', () => {
    // The same rule that makes `_discord.gg/abc123_` work makes this match.
    // Reversing it would trade a real bypass for a cosmetic false positive.
    expect(findInviteCodes('my_discord.gg/abc123')).toEqual(['abc123'])
  })

  it('is not stopped by emoji or other non-ascii pressed against the link', () => {
    expect(findInviteCodes('🎉discord.gg/abc123🎉')).toEqual(['abc123'])
    expect(findInviteCodes('до discord.gg/abc123')).toEqual(['abc123'])
  })

  it('reads a half-encoded code both ways and keeps both', () => {
    // The price of reading the message twice, and it is the cheap direction.
    // The raw pass stops at the `%` and the decoded pass sees the whole code, so
    // a code written half in hex costs one extra lookup on a fragment that
    // resolves to nothing and is therefore never deleted on. Pinned rather than
    // left to be discovered, because the alternative — dropping the raw reading
    // whenever a `%` appears — trades this for a miss, which is the failure
    // nothing downstream can recover from.
    expect(findInviteCodes('discord.gg/ab%63123')).toEqual(['ab', 'abc123'])
  })
})

describe('findInviteCodes — repeats', () => {
  it('returns a repeated code once', () => {
    expect(findInviteCodes('discord.gg/abc123 discord.gg/abc123 discord.gg/abc123')).toEqual([
      'abc123',
    ])
  })

  it('deduplicates across different spellings of the same link', () => {
    expect(
      findInviteCodes('https://discord.gg/abc123 and www.discord.gg/abc123 and discord.gg/abc123'),
    ).toEqual(['abc123'])
  })

  it('treats two codes differing only in case as two codes', () => {
    // Codes are case-sensitive. Folding these together would resolve one and
    // then act on behalf of the other.
    expect(findInviteCodes('discord.gg/abc123 discord.gg/ABC123')).toEqual(['abc123', 'ABC123'])
  })

  it('keeps first-seen order', () => {
    expect(findInviteCodes('discord.gg/ccc discord.gg/aaa discord.gg/ccc discord.gg/bbb')).toEqual([
      'ccc',
      'aaa',
      'bbb',
    ])
  })
})

describe('findInviteCodes — statelessness', () => {
  it('gives the same answer for the same input every time', () => {
    // A global regex kept in a module constant carries `lastIndex` between
    // calls if it is driven with `exec`. That bug scans every other message
    // and nothing about it is visible in production.
    const content = 'discord.gg/abc123 and discord.gg/def456'
    expect(findInviteCodes(content)).toEqual(['abc123', 'def456'])
    expect(findInviteCodes(content)).toEqual(['abc123', 'def456'])
    expect(findInviteCodes(content)).toEqual(['abc123', 'def456'])
  })

  it('does not leak state between different messages', () => {
    expect(findInviteCodes('discord.gg/first')).toEqual(['first'])
    expect(findInviteCodes('nothing here')).toEqual([])
    expect(findInviteCodes('discord.gg/second')).toEqual(['second'])
  })

  it('gives the same answer every time on the decoded path too', () => {
    // The percent decoder is a second global regex, and a global regex is the
    // one kind of constant that can answer differently on the second call. This
    // is the same bug as above, in the piece that was added later: it would show
    // up as the bot scanning every other percent-encoded invite and nothing
    // about it would be visible in production.
    const content = 'discord.gg/%61%62%63 and discord.gg/%64%65%66'
    expect(findInviteCodes(content)).toEqual(['abc', 'def'])
    expect(findInviteCodes(content)).toEqual(['abc', 'def'])
    expect(findInviteCodes(content)).toEqual(['abc', 'def'])
  })
})

describe('scanMessage — sorting codes by what Discord says', () => {
  it('puts a confirmed other guild in foreign', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    await expect(scanMessage('join discord.gg/abc123', OURS, resolve)).resolves.toEqual({
      codes: ['abc123'],
      checked: ['abc123'],
      truncated: false,
      foreign: ['abc123'],
      unresolved: [],
    })
  })

  it('puts our own guild in neither bucket', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(OURS)

    await expect(scanMessage('join discord.gg/abc123', OURS, resolve)).resolves.toEqual({
      codes: ['abc123'],
      checked: ['abc123'],
      truncated: false,
      foreign: [],
      unresolved: [],
    })
  })

  it('puts a null answer in unresolved and NOT in foreign', async () => {
    // The whole safety property of the feature. An expired invite, a revoked
    // one and a typo are indistinguishable here, and none of them is grounds
    // to delete somebody's message.
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(null)

    await expect(scanMessage('join discord.gg/typo', OURS, resolve)).resolves.toEqual({
      codes: ['typo'],
      checked: ['typo'],
      truncated: false,
      foreign: [],
      unresolved: ['typo'],
    })
  })

  it('treats an empty-string guild id as no answer', async () => {
    // A half-answering resolver must fall towards not deleting, not towards a
    // guild id that trivially differs from ours.
    const resolve = vi.fn<InviteResolver>().mockResolvedValue('')

    await expect(scanMessage('discord.gg/abc123', OURS, resolve)).resolves.toEqual({
      codes: ['abc123'],
      checked: ['abc123'],
      truncated: false,
      foreign: [],
      unresolved: ['abc123'],
    })
  })

  it('sorts a message carrying all four kinds at once', async () => {
    const resolve = vi.fn<InviteResolver>().mockImplementation(async (code: string) => {
      if (code === 'ourown') return OURS
      if (code === 'theirs') return THEIRS
      if (code === 'expired') return null
      throw new Error('503 from Discord')
    })

    const content =
      'ours discord.gg/ourown theirs discord.gg/theirs dead discord.gg/expired broken discord.gg/boom'

    await expect(scanMessage(content, OURS, resolve)).resolves.toEqual({
      codes: ['ourown', 'theirs', 'expired', 'boom'],
      checked: ['ourown', 'theirs', 'expired', 'boom'],
      truncated: false,
      foreign: ['theirs'],
      unresolved: ['expired', 'boom'],
    })
  })

  it('reports codes in the order they appeared, deduplicated', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    const result = await scanMessage(
      'discord.gg/bbb discord.gg/aaa discord.gg/bbb',
      OURS,
      resolve,
    )

    expect(result.codes).toEqual(['bbb', 'aaa'])
    expect(result.foreign).toEqual(['bbb', 'aaa'])
  })
})

describe('scanMessage — the resolver is hostile', () => {
  it('treats a rejected promise as unresolved', async () => {
    const resolve = vi.fn<InviteResolver>().mockRejectedValue(new Error('rate limited'))

    await expect(scanMessage('discord.gg/abc123', OURS, resolve)).resolves.toEqual({
      codes: ['abc123'],
      checked: ['abc123'],
      truncated: false,
      foreign: [],
      unresolved: ['abc123'],
    })
  })

  it('treats a synchronous throw as unresolved', async () => {
    // A resolver that throws before it ever returns a promise. `await` inside
    // the try covers both, and this is the one that escapes a `.catch()`.
    const resolve: InviteResolver = () => {
      throw new Error('no client')
    }

    await expect(scanMessage('discord.gg/abc123', OURS, resolve)).resolves.toEqual({
      codes: ['abc123'],
      checked: ['abc123'],
      truncated: false,
      foreign: [],
      unresolved: ['abc123'],
    })
  })

  it('keeps scanning the rest of the message after a throw', async () => {
    // One failed lookup must not cost the message its other three codes — that
    // is how a foreign invite survives on the back of an unrelated 500.
    const resolve = vi.fn<InviteResolver>().mockImplementation(async (code: string) => {
      if (code === 'boom') throw new Error('500')
      return THEIRS
    })

    const result = await scanMessage(
      'discord.gg/boom discord.gg/aaa discord.gg/bbb',
      OURS,
      resolve,
    )

    expect(result.foreign).toEqual(['aaa', 'bbb'])
    expect(result.unresolved).toEqual(['boom'])
    expect(resolve).toHaveBeenCalledTimes(3)
  })

  it('leaves a log line behind when a lookup fails', async () => {
    const resolve = vi.fn<InviteResolver>().mockRejectedValue(new Error('rate limited'))

    await scanMessage('discord.gg/abc123', OURS, resolve)

    const line = stderr.join('')
    expect(line).toContain('level=warn')
    expect(line).toContain('invite lookup failed')
    expect(line).toContain('abc123')
    expect(line).toContain('rate limited')
  })

  it('survives a resolver that throws for every single code', async () => {
    const resolve = vi.fn<InviteResolver>().mockRejectedValue(new Error('down'))

    await expect(
      scanMessage('discord.gg/aaa discord.gg/bbb discord.gg/ccc', OURS, resolve),
    ).resolves.toEqual({
      codes: ['aaa', 'bbb', 'ccc'],
      checked: ['aaa', 'bbb', 'ccc'],
      truncated: false,
      foreign: [],
      unresolved: ['aaa', 'bbb', 'ccc'],
    })
  })
})

describe('scanMessage — how often the resolver is called', () => {
  it('does not call the resolver when there is nothing to resolve', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    await expect(scanMessage('', OURS, resolve)).resolves.toEqual({
      codes: [],
      checked: [],
      truncated: false,
      foreign: [],
      unresolved: [],
    })
    await scanMessage('good game everyone', OURS, resolve)
    await scanMessage('mydiscord.gg/abc123', OURS, resolve)

    expect(resolve).not.toHaveBeenCalled()
  })

  it('calls the resolver once per distinct code, however often it was posted', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    await scanMessage(
      'discord.gg/abc123 https://discord.gg/abc123 www.discord.gg/abc123',
      OURS,
      resolve,
    )

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith('abc123')
  })

  it('hands the resolver the code exactly as it was written', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(null)

    await scanMessage('DISCORD.GG/AbC123', OURS, resolve)

    expect(resolve).toHaveBeenCalledWith('AbC123')
  })
})

describe('scanMessage — the per-message lookup cap', () => {
  /**
   * The bug these pin: the scan used to resolve every distinct code in a
   * message, and a 2000-character message packed with invites holds 147 of
   * them. Discord's global budget is 50 requests a second, so one post was
   * enough to rate-limit the process and stall every legitimate deletion queued
   * behind it.
   */

  it('resolves at most ten distinct codes however many the message carries', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    const result = await scanMessage(manyCodes(60), OURS, resolve)

    expect(resolve).toHaveBeenCalledTimes(10)
    expect(result.checked).toHaveLength(10)
    expect(result.checked).toEqual(result.codes.slice(0, 10))
  })

  it('holds the cap on a message the size Discord actually allows', async () => {
    // The measured shape of the bug: a full-length message of nothing but
    // invites. Over a hundred codes go in, ten lookups come out.
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    const result = await scanMessage(manyCodes(200).slice(0, 2000), OURS, resolve)

    expect(result.codes.length).toBeGreaterThan(100)
    expect(resolve).toHaveBeenCalledTimes(10)
  })

  it('still reports every code it found, so the count is not a lie', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    const result = await scanMessage(manyCodes(25), OURS, resolve)

    expect(result.codes).toHaveLength(25)
    expect(result.truncated).toBe(true)
  })

  it('signals truncation rather than capping silently', async () => {
    // A silent cap makes "this message was scanned" a claim the code cannot
    // support, and it hands anyone who reads this file a bypass: pad a post
    // with junk codes and the real invite falls off the end unmentioned.
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    const result = await scanMessage(manyCodes(25), OURS, resolve)

    expect(result.truncated).toBe(true)

    const line = stderr.join('')
    expect(line).toContain('level=warn')
    expect(line).toContain('invite scan capped')
    expect(line).toContain('found=25')
    expect(line).toContain('checked=10')
  })

  it('leaves the codes past the cap out of every bucket', async () => {
    // They were never looked at, so they are neither foreign nor unresolved.
    // `truncated` is the only honest thing the scan can say about them, and it
    // must not read as a soft yes on codes nobody checked.
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    const result = await scanMessage(manyCodes(25), OURS, resolve)

    for (const code of result.codes.slice(10)) {
      expect(result.foreign).not.toContain(code)
      expect(result.unresolved).not.toContain(code)
    }
    expect(result.foreign).toHaveLength(10)
  })

  it('does not flag a message that sits exactly on the cap', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    const result = await scanMessage(manyCodes(10), OURS, resolve)

    expect(result.truncated).toBe(false)
    expect(resolve).toHaveBeenCalledTimes(10)
    expect(stderr.join('')).not.toContain('invite scan capped')
  })

  it('says nothing about a cap for an ordinary message', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    const result = await scanMessage('come join discord.gg/abc123', OURS, resolve)

    expect(result.truncated).toBe(false)
    expect(stderr.join('')).not.toContain('invite scan capped')
  })
})

describe('scanMessage — repeats inside one message', () => {
  it('collapses fifty repeats of one code into a single lookup', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)
    const content = Array.from({ length: 50 }, () => 'discord.gg/abc123').join(' ')

    const result = await scanMessage(content, OURS, resolve)

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(result.codes).toEqual(['abc123'])
    expect(result.foreign).toEqual(['abc123'])
  })

  it('spends the cap on distinct codes rather than on occurrences', async () => {
    // Deduplication happens BEFORE the cap, and the order is the point. The
    // other way round, a message padded with one code two hundred times would
    // fill the cap with a single invite and push the real one off the end.
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)
    const padding = Array.from({ length: 200 }, () => 'discord.gg/pad').join(' ')

    const result = await scanMessage(`${padding} discord.gg/real`, OURS, resolve)

    expect(result.truncated).toBe(false)
    expect(result.checked).toEqual(['pad', 'real'])
    expect(result.foreign).toContain('real')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('still spends two lookups on two codes differing only in case', async () => {
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    await scanMessage('discord.gg/abc123 discord.gg/ABC123', OURS, resolve)

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenCalledWith('abc123')
    expect(resolve).toHaveBeenCalledWith('ABC123')
  })
})

describe('scanMessage — the answer cache', () => {
  it('answers a repeat from memory instead of asking again', async () => {
    // The same invite posted into fifty channels: fifty messages, one lookup.
    // The cap does nothing about this shape — every one of those messages is
    // well inside it.
    const cache = createInviteCache({ now: fakeClock().now })
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    for (let i = 0; i < 50; i += 1) {
      const result = await scanMessage(`channel ${i} discord.gg/abc123`, OURS, resolve, { cache })
      expect(result.foreign).toEqual(['abc123'])
    }

    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('asks again once the ttl has passed', async () => {
    const clock = fakeClock()
    const cache = createInviteCache({ ttlMs: 60_000, now: clock.now })
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    await scanMessage('discord.gg/abc123', OURS, resolve, { cache })

    clock.advance(59_999)
    await scanMessage('discord.gg/abc123', OURS, resolve, { cache })
    expect(resolve).toHaveBeenCalledTimes(1)

    clock.advance(1)
    const afterExpiry = await scanMessage('discord.gg/abc123', OURS, resolve, { cache })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(afterExpiry.foreign).toEqual(['abc123'])
  })

  it('remembers the guild rather than the verdict', async () => {
    // The cache is keyed on the code alone, which is only safe because what is
    // stored is Discord's answer. Storing "foreign" would carry one guild's
    // decision into another guild's scan.
    const cache = createInviteCache({ now: fakeClock().now })
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(OURS)

    const home = await scanMessage('discord.gg/abc123', OURS, resolve, { cache })
    const elsewhere = await scanMessage('discord.gg/abc123', THEIRS, resolve, { cache })

    expect(home.foreign).toEqual([])
    expect(elsewhere.foreign).toEqual(['abc123'])
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('keys on the code case-sensitively, like everything else here', async () => {
    const cache = createInviteCache({ now: fakeClock().now })
    const resolve = vi
      .fn<InviteResolver>()
      .mockImplementation(async (code: string) => (code === 'abc123' ? OURS : THEIRS))

    await scanMessage('discord.gg/abc123', OURS, resolve, { cache })
    const shouted = await scanMessage('discord.gg/ABC123', OURS, resolve, { cache })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(shouted.foreign).toEqual(['ABC123'])
  })

  it('does not remember that a lookup threw', async () => {
    // A rate-limit or a 500 lasting one second must not blind the bot to that
    // code for the whole TTL. Asking again costs one lookup; remembering the
    // failure costs an invite left standing.
    const cache = createInviteCache({ now: fakeClock().now })
    const resolve = vi.fn<InviteResolver>().mockRejectedValue(new Error('429'))

    await scanMessage('discord.gg/abc123', OURS, resolve, { cache })
    await scanMessage('discord.gg/abc123', OURS, resolve, { cache })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(0)
  })

  it('does not remember a null answer', async () => {
    // An invite created a moment after we first asked would otherwise stay
    // invisible for the whole TTL while it was being advertised.
    const cache = createInviteCache({ now: fakeClock().now })
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(null)

    await scanMessage('discord.gg/abc123', OURS, resolve, { cache })
    await scanMessage('discord.gg/abc123', OURS, resolve, { cache })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(0)
  })

  it('does not remember an empty-string answer', async () => {
    const cache = createInviteCache({ now: fakeClock().now })
    const resolve = vi.fn<InviteResolver>().mockResolvedValue('')

    await scanMessage('discord.gg/abc123', OURS, resolve, { cache })
    await scanMessage('discord.gg/abc123', OURS, resolve, { cache })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(0)
  })

  it('evicts the oldest entry rather than growing forever', async () => {
    // The keys are strings a stranger chose. An unbounded Map here is a memory
    // leak in a process that runs for weeks.
    const cache = createInviteCache({ maxEntries: 2, now: fakeClock().now })
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    await scanMessage('discord.gg/aaa discord.gg/bbb discord.gg/ccc', OURS, resolve, { cache })
    expect(resolve).toHaveBeenCalledTimes(3)
    expect(cache.size).toBe(2)

    // bbb and ccc are the survivors and cost nothing.
    await scanMessage('discord.gg/bbb discord.gg/ccc', OURS, resolve, { cache })
    expect(resolve).toHaveBeenCalledTimes(3)

    // aaa was evicted, so it is asked about again — and answering it evicts in
    // turn rather than making room.
    await scanMessage('discord.gg/aaa', OURS, resolve, { cache })
    expect(resolve).toHaveBeenCalledTimes(4)
    expect(cache.size).toBe(2)
  })

  it('stays bounded under a flood of distinct codes', async () => {
    const cache = createInviteCache({ maxEntries: 4, now: fakeClock().now })
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    for (let i = 0; i < 40; i += 1) {
      await scanMessage(`discord.gg/flood${i}`, OURS, resolve, { cache })
    }

    expect(cache.size).toBe(4)
  })

  it('caches for a caller that supplies no cache of its own', async () => {
    // The default is what makes the fix live for a caller that passes three
    // arguments — client.ts does. Without it the cache would be a knob nobody
    // turned: green in the tests and switched off in production.
    const resolve = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)

    await scanMessage('discord.gg/abc123', OURS, resolve)
    await scanMessage('discord.gg/abc123', OURS, resolve)

    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('does not serve one resolver an answer another resolver gave', async () => {
    // The default cache is keyed on the resolver, and this is why. Two
    // resolvers are two clients seeing two sets of guilds; an answer from one
    // is not evidence about the other, and carrying it across would state a
    // fact neither of them ever gave us. It is also what keeps a scan in one
    // test from deciding the verdict in the next.
    const first = vi.fn<InviteResolver>().mockResolvedValue(THEIRS)
    const second = vi.fn<InviteResolver>().mockResolvedValue(OURS)

    const byFirst = await scanMessage('discord.gg/abc123', OURS, first)
    const bySecond = await scanMessage('discord.gg/abc123', OURS, second)

    expect(byFirst.foreign).toEqual(['abc123'])
    expect(bySecond.foreign).toEqual([])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
