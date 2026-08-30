import { describe, expect, it } from 'vitest'

import { scanLinks, SHORTENER_HOSTS, SHORTENERS, type LinkReason } from './links.ts'

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

  // ---- AN ADDRESS AT THE END OF A SENTENCE, WHICH IS HOW AN ADVERT IS WRITTEN.
  //
  // THE REGRESSION THESE ROWS EXIST FOR. `sentenceTail` answered yes to a
  // trailing run of `.` with nothing after it — zero labels passed a `<= 1`
  // test — so the exemption written to keep the OWNER'S address safe from
  // ordinary punctuation exempted EVERY address that had been punctuated. Both
  // of these used to be `foreign-ip` and both went silently null, which is the
  // worst way for a rule to fail: the poster sees nothing, the log says nothing,
  // and the only symptom is adverts standing.
  //
  // OUR ADDRESS FOLLOWED BY A FULL STOP IS EXEMPT BECAUSE IT IS OURS, NOT
  // BECAUSE OF THE FULL STOP. `we are back up on 3.130.92.28.` is in the KEPT
  // table three rows apart from these, and the two facts now come from two
  // different questions rather than from one that could not tell them apart.
  ['come play at 5.6.7.8.', 'foreign-ip'],
  ['New server, join us at 45.87.154.22.', 'foreign-ip'],
  // An ellipsis is the same punctuation with two more characters on it.
  ['come play at 5.6.7.8...', 'foreign-ip'],
  ['join us at 45.87.154.22, best server', 'foreign-ip'],

  // ---- THE THREE FALSE POSITIVES THE OWNER WAS SHOWN AND ACCEPTED. ----
  //
  // EACH OF THESE IS A REAL MESSAGE THAT A REAL MEMBER LOSES, and each is here
  // as a removal because he was shown it and chose to keep deleting rather than
  // narrow the rule. They are pinned so that nobody re-opens the trade by
  // reading a bug report instead of this table: a version string is four dotted
  // numbers, an Instant Replay clip carries `.DVR.` before its extension so it
  // reads as a domain, and a re-uploaded clip has ` (1)` between the clock and
  // the extension so nothing follows the quad at all.
  ['Version=3.6.0.0', 'foreign-ip'],
  ['Grand Theft Auto V 2026.08.30 - 14.22.35.13.DVR.mp4', 'foreign-ip'],
  ['Grand Theft Auto V 2026.08.30 - 14.22.35.13 (1).mp4', 'foreign-ip'],

  // ---- A FILENAME WITH TWO EXTENSIONS, EVEN WHEN THE ADDRESS IN IT IS OURS. --
  //
  // THE COST OF DRAWING THE DOMAIN LINE AT TWO LABELS, AND IT IS PAID BY THE
  // OWNER. `.tar.gz` and `.crt.pem` are two labels after the quad, exactly like
  // `.evil.com` two rows down, and there is no shape that separates them: the
  // only real difference is that `com` is a public suffix and `gz` is not, which
  // is the TLD list this rule exists to avoid carrying. Exempting them means
  // exempting `3.130.92.28.evil.com`, which is a host somebody else controls
  // that merely begins with our address.
  //
  // ASSERTED RATHER THAN LEFT UNSAID so the next person weighing it has the
  // trade in front of them instead of a bug report about one half of it.
  ['blitz-backup-3.130.92.28.tar.gz', 'foreign-ip'],
  ['3.130.92.28.crt.pem', 'foreign-ip'],

  // THE TWO ROWS THE ALLOWLIST BOUNDARY EXISTS FOR. A bare substring test, or a
  // match with no fences on it, exempts both of these: the first is a host
  // somebody else controls that merely BEGINS with our address, the second is a
  // different address that merely CONTAINS it.
  ['3.130.92.28.evil.com', 'foreign-ip'],
  ['13.130.92.28', 'foreign-ip'],
  // The same idea with a hyphen and with the escape in the middle. A hyphen
  // joins `evil.com` to our address exactly as a dot does, so `segments` counts
  // it as a break and both are one case.
  ['3.130.92.28-evil.com', 'foreign-ip'],
  ['3.130.92.28\\.evil.com', 'foreign-ip'],
  // A FOREIGN address with a domain after it is the same shape and the same
  // answer; the allowlist is not what decides this one.
  ['1.2.3.4.evil.com', 'foreign-ip'],

  // A PORT WRITTEN WITH A HYPHEN IS STILL AN ADDRESS AND A PORT. This is the
  // row that stops `endsTheAddress` being read as "anything glued on is
  // punctuation": a hyphen and a number add no host, so the four numbers are
  // still the address, and this one is not ours.
  ['1.2.3.4-30120', 'foreign-ip'],
  // A letter stuck on the end adds no label either.
  ['1.2.3.4x', 'foreign-ip'],
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
  // A MULTI-BYTE PERCENT ESCAPE, WHICH THE BYTE-WISE DECODE TURNED INTO
  // MOJIBAKE. `%E3%80%82` is U+3002 in UTF-8 and `new URL` resolves this whole
  // string to the host `cfx.re` — measured. Decoding one byte at a time gave
  // three Latin-1 characters that matched nothing, which was a three-escape
  // bypass of the rule that exists to catch the unicode dots.
  ['cfx%E3%80%82re/join/kvkq6v', 'server-listing'],
  // THE HOMOGLYPHS UTS #46 MAPS TO ASCII. Every one of these resolves to the
  // host `cfx.re` under `new URL`, measured, and every one is NFKC-mapped to
  // ASCII `cfx` — fullwidth, mathematical bold, and circled. The file already
  // made this argument for the three unicode dots; `fold` finishes it.
  ['\uff43\uff46\uff58\uff0ere/join/kvkq6v', 'server-listing'],
  ['\u{1D41C}\u{1D41F}\u{1D431}.re/join/kvkq6v', 'server-listing'],
  ['\u24d2\u24d5\u24e7.re/join/kvkq6v', 'server-listing'],
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
  // dots, so a host that merely begins with our address is not our address —
  // `evil.com` is a registrable domain and `See` is the next word of a
  // sentence, which is the whole of the difference. See the KEPT rows.
  ['fivem://connect/3.130.92.28.evil.com', 'fivem-connect'],
  ['fivem://connect/3.130.92.28-evil.com', 'fivem-connect'],
  // THE OPAQUE FORM: ONE COLON AND NO SLASHES, WHICH WAS INVISIBLE. A URI
  // scheme's colon may be followed by an opaque path, so `fivem:connect/x` is
  // the same request to the same protocol handler as `fivem://connect/x` — and
  // the pattern demanded at least one separator, so three slashes fired, two
  // fired, and none did not. Two keystrokes.
  ['fivem:connect/play.someserver.com', 'fivem-connect'],
  ['fivem:connect/1.2.3.4:30120', 'fivem-connect'],
  ['fivem:connect\\play.someserver.com', 'fivem-connect'],
  ['FIVEM:CONNECT/play.someserver.com', 'fivem-connect'],
  ['fivem\\:connect/play.someserver.com', 'fivem-connect'],

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

  // THE SEVEN THE LIST WAS MISSING, EACH ADMITTED BY THE SAME RULE THAT ADMITTED
  // `bit.ly`: a generic redirector whose path is an opaque slug, so the domain
  // says nothing about the destination and the bot would have to fetch it to
  // find out. They are not a new class -- they are the class the list already
  // names, spelled seven more ways, and they were absent because the list was
  // assembled out of the ones anybody could remember. Rows rather than only
  // constant entries, because the constant does not prove the BOUNDARY builder
  // and the lookbehind still work on a domain with a hyphen-free two-label form.
  ['short.gy/abcdef', 'link-shortener'],
  ['bl.ink/abcdef', 'link-shortener'],
  ['lnk.to/abcdef', 'link-shortener'],
  ['tiny.one/abcdef', 'link-shortener'],
  ['clck.ru/abcdef', 'link-shortener'],
  ['surl.li/abcdef', 'link-shortener'],
  ['urlz.fr/abcdef', 'link-shortener'],
  // `tiny.one` AND `tiny.cc` SHARE A FIRST LABEL AND NEITHER IS A PREFIX OF THE
  // OTHER, which is the invariant the constant's comment states. This pair is
  // the one that would break it first, so both spellings are asserted.
  ['tiny.cc/abcdef', 'link-shortener'],
  ['https://short.gy/abcdef', 'link-shortener'],
  ['SURL.LI/ABCDEF', 'link-shortener'],
  // The host boundary again, because it is the same boundary.
  ['bit.ly:443//3xY9k', 'link-shortener'],
  ['bit.ly./3xY9k', 'link-shortener'],
  ['bit.ly\\3xY9k', 'link-shortener'],
  ['bit\\.ly/3xY9k', 'link-shortener'],
  ['bit\u3002ly/3xY9k', 'link-shortener'],
  ['bit%2Ely/3xY9k', 'link-shortener'],
  ['\uff42\uff49\uff54\uff0e\uff4c\uff59/3xY9k', 'link-shortener'],

  // THE FORMAT CHARACTERS THAT RENDER AS NOTHING, WHICH WERE A ONE-KEYSTROKE
  // BYPASS OF EVERY HOST RULE IN THE FILE. Discord renders each of these as
  // `bit.ly/3xY9k` and `new URL` resolves each to the host `bit.ly` -- measured,
  // all five. A rule that matches what was typed rather than what will be opened
  // cannot see any of them. SPELLED AS ESCAPES, because a test row whose point is
  // a character nobody can see is a row nobody can review.
  ['b\u00ADit.ly/3xY9k', 'link-shortener'],
  ['b\u200Bit.ly/3xY9k', 'link-shortener'],
  ['b\u200Dit.ly/3xY9k', 'link-shortener'],
  ['b\u2060it.ly/3xY9k', 'link-shortener'],
  ['b\uFEFFit.ly/3xY9k', 'link-shortener'],
  // The two dodges composed: a soft hyphen written as a percent escape. This is
  // the row that pins the ORDER of the two passes -- the decode has to run before
  // the fold, or the escape hides the character the fold removes.
  ['bit%C2%AD.ly/3xY9k', 'link-shortener'],

  // THE FOUR THE HAND-WRITTEN LIST OF FIVE DID NOT HAVE, WHICH IS WHY THERE IS
  // NO LIST ANY MORE. Measured with `new URL` exactly as the five above were:
  // each of these resolves to the host `bit.ly`. U+034F is the combining
  // grapheme joiner and U+FE0F the emoji variation selector -- both invisible,
  // both skipped by a resolver, and NEITHER is a format character, so a class
  // written as "the format characters" could never have reached them. U+3164 is
  // a Hangul filler and U+180E a Mongolian vowel separator, which is how long
  // the list would have had to get. `Default_Ignorable_Code_Point` is the
  // property all four share and is what the rule names now.
  ['b\u034Fit.ly/3xY9k', 'link-shortener'],
  ['b\uFE0Fit.ly/3xY9k', 'link-shortener'],
  ['b\u3164it.ly/3xY9k', 'link-shortener'],
  ['b\u180Eit.ly/3xY9k', 'link-shortener'],
  // AN ASTRAL ONE, WHICH IS THE ROW THAT PINS THE `u` FLAG. U+E0001 is written
  // as a surrogate pair, so a class without `u` would try to strip half a
  // character; and `NON_ASCII` has to let a lone surrogate through or the fold
  // never runs on a message whose only non-ASCII content is up here. (Measured,
  // `new URL` REFUSES a host containing this one rather than skipping it -- so
  // this row is the rule matching more than a resolver would, which is the
  // direction the class errs in and is stated at `INVISIBLE`.)
  ['b\u{E0001}it.ly/3xY9k', 'link-shortener'],

  // `goo.gl` ITSELF IS UNCHANGED, AND SO IS A FIREBASE LINK UNDER IT. Only the
  // two hosts Google runs are exempt; `<name>.app.goo.gl` lands wherever the app
  // that registered it points, so it fails the SHORTENERS rule and stays.
  ['goo.gl/abcdef', 'link-shortener'],
  ['app.goo.gl/abcdef', 'link-shortener'],
  // THE EXEMPTION IS A SUFFIX ON A LABEL BOUNDARY AND NOT A SUBSTRING. This is
  // a different label, and it is somebody's Firebase link.
  ['evilmaps.app.goo.gl/abcdef', 'link-shortener'],
  // One exempt host in a message does not exempt the message.
  ['maps.app.goo.gl/x and bit.ly/3xY9k', 'link-shortener'],
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

  // ---- THE OWNER'S OWN ADDRESS, IN ORDINARY PUNCTUATION. ----
  //
  // THE MOST EMBARRASSING THING THIS BOT CAN DO IS DELETE A MESSAGE THAT NAMES
  // THE SERVER THE CHANNEL IS FOR, and it was doing it five ways. The old
  // boundary asked what the next character was; every row here is a way of
  // writing a sentence that the answer got wrong. `namesOurs` asks about the
  // whole host instead, so an ellipsis, a full stop with no space, a hyphen, a
  // filename and a port are all just where the URL ended.
  'fivem://connect/3.130.92.28... see you',
  'fivem://connect/3.130.92.28.See you',
  'we are back up on 3.130.92.28.See you there',
  'join 3.130.92.28... see you',
  'ping-3.130.92.28.png',
  'server3.130.92.28 is ours',
  '3.130.92.28-30120',
  // THE SAME SENTENCE WITHOUT THE PREAMBLE. This one and
  // `come play at 5.6.7.8.` in the DELETED table are the pair that says what the
  // fix was: identical punctuation, opposite answers, and the only thing that
  // separates them is whose address it is.
  '3.130.92.28.See you',
  '3.130.92.28.',
  // The opaque scheme reaches the allowlist exactly as the slashed forms do, or
  // closing that bypass would have started deleting the owner's own posts in a
  // form he can now type.
  'fivem:connect/3.130.92.28',
  'fivem:connect/3.130.92.28:30120',
  // A LETTER IN FRONT MAKES IT NEITHER AN ADDRESS NOR A HOST, so nothing fires.
  // This row used to be a removal, on the grounds that a host must not be
  // exempted just because it ends with our address — but `x3.130.92.28` is not
  // a host anybody can reach (its last label is `28`, and there is no such TLD)
  // and not an address (because of the `x`). It is the same string as
  // `server3.130.92.28` above with a shorter prefix, and no rule can delete one
  // without deleting the other. A different address that CONTAINS ours needs no
  // left-hand rule at all: `13.130.92.28` is matched whole and is still removed.
  'x3.130.92.28',
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

  // ---- LINKTREE, WHICH IS A PAGE AND NOT A REDIRECT. ----
  //
  // THE SECOND WORKED EXAMPLE OF THE ADMISSION RULE, AND THE ONE THAT COST
  // SOMETHING TO GET RIGHT. It was put forward as a domain a poacher would reach
  // for, which is true, and it still fails the test that admits `t.co`:
  // `linktr.ee/<name>` does not carry the reader anywhere, it renders a Linktree
  // page and stops. The domain says exactly where you are going, which is the
  // `youtu.be` answer word for word, and reaching a server from it takes a
  // second click on a page already in front of the reader.
  //
  // ASSERTED SO THE ABSENCE IS A DECISION. Streamers post their linktree in a
  // game community constantly; this row and the SHORTENERS exclusion test are
  // what stop it being added by taste on a bad afternoon. If the owner would
  // rather delete Linktree posts, that is a ruling about this guild and it moves
  // one line.
  'linktr.ee/someguild',
  'https://linktr.ee/someguild',

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
  // NEITHER IS A CONNECT PATH WITH NO TARGET, WHICH IS WHAT SOMEBODY TYPES WHILE
  // EXPLAINING HOW TO CONNECT — with the address on the next line, or in a
  // screenshot. `FIVEM_TARGET` was `*` rather than `+`, so the target was the
  // empty string, the empty string is not on the allowlist, and the rule fired
  // on a link to nowhere. Same measured reasoning as `cfx.re/join/` above.
  'fivem://connect/',
  'to join, paste fivem://connect/ and then the address',
  'fivem://connect/...',

  // ---- Google's share links, which name their destination. ----

  // `maps.app.goo.gl` AND `photos.app.goo.gl` ARE NOT SHORTENERS, by the same
  // test that keeps `youtu.be` out of SHORTENERS: the host says where you end
  // up. They were removed because the lookbehind allows a preceding dot on the
  // grounds that a subdomain of a shortener belongs to the shortener — true of
  // `goo.gl`, false of these two, and the rule is asked of the whole host now.
  'maps.app.goo.gl/abcdef',
  'photos.app.goo.gl/abcdef',
  'https://maps.app.goo.gl/abcdef',
  'MAPS.APP.GOO.GL/abcdef',
  'x.maps.app.goo.gl/abcdef',
  'here is where we met up maps.app.goo.gl/abcdef',

  // ---- Not IPv4 shapes, because an octet is one to three digits. ----

  'version 1.2.3 of the mod',
  '1.2.3.4567',
  '2024.10.5.1',
  '3.130.92.281234',

  // ---- THE SHADOWPLAY CLIP. The false positive that costs the most here. ----
  //
  // NVIDIA'S CAPTURE TOOL IS THE DEFAULT ONE AND THIS IS ITS DEFAULT FILENAME.
  // On a GTA server, clips are most of what gets posted, and an attachment's
  // name is a scanned surface by design — client.ts reads it because
  // `discord.gg-x3.png` is an advert that never appears in `content`. So this
  // string reaches the rules whatever else changes, and `14.22.05.03` is four
  // groups of one to three digits, each under 255. The old pattern read the
  // clock as an address.
  //
  // TWO SEPARATE THINGS SAVE IT, WHICH IS WHY BOTH ROWS ARE HERE. The first has
  // zero-padded fields, and a leading zero is not canonical dotted-quad — the
  // WHATWG parser rejects it outright. The second was captured after 10am with
  // no padded field anywhere, so it IS a valid quad, and the only thing that
  // saves it is the `.mp4`: a dot and one label is an extension, not a domain.
  // Delete either mechanism and roughly half of this server's clips go with it.
  'Grand Theft Auto V 2026.08.30 - 14.22.05.03.mp4',
  'Grand Theft Auto V 2026.08.30 - 14.22.35.13.mp4',
  'clip 14.22.35.13.mp4',
  // A FOREIGN QUAD IN A FILENAME IS THE SAME CASE AND GETS THE SAME ANSWER.
  // There is no way to keep the clip above and remove this one, and the trade is
  // stated in `endsTheAddress`: this is a bypass that a poster has to hand-edit
  // before it connects to anything.
  '1.2.3.4.mp4',

  // ---- A QUAD INSIDE A LONGER DOTTED RUN IS FOUR FIELDS OF SOMETHING ELSE. ----
  //
  // THE `(?<!\d)` FENCE NEVER STOPPED ANY OF THESE, THOUGH THE FILE SAID IT DID.
  // The character in the way is a DOT, not a digit: `2026.08.30.14.22.05`
  // matched at `08.30.14.22`, and `1.2.3.4.5` matched at its first four. The
  // second fence of each pair — no digit-then-separator adjacent — is what reads
  // the dot as continuing a number.
  'stamp 2026.08.30.14.22.05',
  'rule 1.2.3.4.5',
  'laps: 1.02.3.99',
  'see you 2026.08.30',
  'build 1.2.3.4.5.6',

  // ---- An octet over 255 is not an address in any spelling. ----

  '999.1.1.1',
  '256.1.1.1',
  '300.300.300.300',

  // ---- THE OTHER SPELLINGS OF AN ADDRESS, DELIBERATELY NOT CAUGHT. ----
  //
  // EACH OF THESE IS A REAL ADDRESS TO A BROWSER — measured, `new URL` resolves
  // `http://84281096/` and `http://0x05060708/` to the host 5.6.7.8, and
  // `http://1.2.3/` to 1.2.0.3. They are left alone ON PURPOSE, and these rows
  // exist so that decision is visible rather than an oversight somebody
  // "fixes" later.
  //
  // THE COST OF CATCHING THEM IS PAID BY EVERY MEMBER AND THE BENEFIT IS NEARLY
  // NOTHING. A bare eight-to-ten digit number is a player id, a score, a
  // timestamp or a Discord id fragment; `0x`-prefixed hex is what a GTA crash
  // dump and a script error are made of, and this is a modded-game community
  // that pastes them daily. Against that, the FiveM client does not take a
  // decimal or hex host in `connect`, so an advert in this form cannot be acted
  // on with one click — it needs a browser and a conversion. A rule here would
  // delete real conversation every day to close a hole nobody can walk through.
  'connect to 84281096',
  '0x05060708',
  'my id is 84281096',
  'crashed at 0x05060708 again',
  'connect 1.2.3',

  // ---- IPv6, WHICH HAD NO RULE AND, WORSE, NO WRITTEN DECISION. ----
  //
  // THESE ROWS ARE THE DECISION. Until they existed, the only way to learn that
  // an IPv6 advert survives this file was to post one, and an unstated gap is
  // the one nobody revisits. See `links.ts`, above `LABEL_CHAR`, for the whole
  // argument; the short version is that this gap is NOT the same shape as the
  // decimal and hex rows above it. Those are left because the FiveM client will
  // not take them, so the advert cannot be acted on. Cfx.re staff state that
  // `connect [::1]:30120` in the client console works, so this one CAN be.
  //
  // IT IS LEFT OPEN ON THREE COUNTS, EVERY ONE OF WHICH IS CHECKABLE: the
  // allowlist is shape-checked as IPv4 so there would be no way to spell an
  // exemption for OUR address; comparing two IPv6 addresses is canonicalisation
  // and not string equality; and the server browser does not resolve IPv6, so
  // the form barely exists in the field. Any one of those changing is grounds to
  // build the rule, and this table is where the change will be noticed.
  'connect to 2001:db8::1',
  'fivem://connect/[2001:db8::1]:30120',
  '[2001:db8::1]:30120',
  '::1',

  // ---- Somebody else's rule. ----

  // Discord invites belong to invites.ts, which resolves them before deleting
  // anything. This file must have no opinion at all about one.
  'discord.gg/abc123',
  'https://discord.com/invite/abc123',

  // ---- Ordinary conversation. ----

  'good game everyone',
  'we play at 8pm, be there',
  'gg wp, 3 kills to 1',

  // ---- The fold runs on these and must invent nothing. ----
  //
  // NORMALISING THE WHOLE MESSAGE IS A SECOND READING OF EVERY POST, so the
  // question to ask of it is whether it can MAKE a match out of text that had
  // none. An emoji built from zero-width joiners and a line of Japanese are the
  // two shapes that go furthest through `fold` — the first loses characters to
  // `INVISIBLE`, the second is rewritten by NFKC — and neither can produce a
  // host, because nothing on either side of what is removed is a label
  // character.
  'nice clip 👨‍💻 gg',
  'こんにちは、ゲーム',
  'そのクリップは 14.22.35.13.mp4 です',
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

  /**
   * THE LINK-IN-BIO PAGES, WHICH ARE THE OTHER SIDE OF THE SAME LINE. A poacher
   * would reach for `linktr.ee`, which is why it keeps being suggested — but it
   * does not redirect, and the admission rule is about a domain that does not
   * say where you end up. Every one of these lands on a page of its own and
   * stops there.
   */
  it.each(['linktr.ee', 'beacons.ai', 'carrd.co'])(
    'does not contain the link-in-bio page %s, which lands rather than redirects',
    (host: string) => {
      expect(SHORTENERS).not.toContain(host)
    },
  )

  it('contains the seven the first sweep found missing', () => {
    for (const host of ['bl.ink', 'clck.ru', 'lnk.to', 'short.gy', 'surl.li', 'tiny.one', 'urlz.fr'])
      expect(SHORTENERS).toContain(host)
  })

  /**
   * THE INVARIANT THE CONSTANT'S COMMENT CLAIMS, ASSERTED RATHER THAN TRUSTED.
   * The alternation is built in list order, so an entry that is a prefix of a
   * later one could match first and strand the longer branch. `tiny.cc` and
   * `tiny.one` are the pair that made this worth checking mechanically.
   */
  it('holds no entry that is a prefix of another', () => {
    for (const host of SHORTENERS) {
      const others = SHORTENERS.filter((other) => other !== host)
      expect(others.some((other) => other.startsWith(host))).toBe(false)
    }
  })

  it('is sorted, which is the only thing that keeps the list reviewable', () => {
    expect([...SHORTENERS]).toEqual([...SHORTENERS].sort())
  })

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
 * The hosts under a shortener that are not shorteners.
 *
 * THE INVARIANT IS THAT AN ENTRY IS ACTUALLY UNDER ONE, which is not decoration:
 * a host that is not under any listed domain can never be reached by the match
 * at all, so it would sit here looking like protection and providing none.
 */
describe('SHORTENER_HOSTS — the hosts a shortener domain does not own', () => {
  it('names the two Google share hosts and not the Firebase parent', () => {
    expect(SHORTENER_HOSTS).toContain('maps.app.goo.gl')
    expect(SHORTENER_HOSTS).toContain('photos.app.goo.gl')
    // `<name>.app.goo.gl` is a Firebase Dynamic Link and lands wherever its app
    // points, so it fails the SHORTENERS rule and must stay matched.
    expect(SHORTENER_HOSTS).not.toContain('app.goo.gl')
    expect(SHORTENER_HOSTS).not.toContain('goo.gl')
  })

  it('holds only hosts that sit under a domain in SHORTENERS', () => {
    for (const host of SHORTENER_HOSTS) {
      expect(SHORTENERS.some((domain) => host.endsWith(`.${domain}`))).toBe(true)
    }
  })

  it('holds only letters, digits and dots, which is all the comparison folds', () => {
    for (const host of SHORTENER_HOSTS) expect(host).toMatch(/^[a-z0-9]+(?:\.[a-z0-9]+)+$/)
  })
})

/**
 * WHAT THE FOLD CANNOT DO, PINNED SO THAT NOBODY READS IT AS MORE THAN IT IS.
 *
 * A normalisation pass makes the homoglyph classes FINITE, not empty, and the
 * difference matters when the next person reaches for this file after finding a
 * lookalike that still gets through. These two cases are the honest edge, and
 * they are asserted rather than described so that a future fold which DOES cover
 * them fails here and gets its comment updated.
 */
describe('scanLinks — what normalising does not reach', () => {
  it('does not catch a Cyrillic lookalike, which resolves somewhere else anyway', () => {
    // NFKC does not map U+0441 to ASCII `c`, and measured, `new URL` resolves
    // this to the punycode host `xn--fx-9lc.re` — NOT cfx.re. The lookalike
    // fools a reader, not a resolver, so it does not reach the advertiser's
    // server; catching it would mean carrying a confusable-skeleton table.
    expect(scanLinks('сfx.re/join/kvkq6v', OUR_IPS)).toBeNull()
  })

  it('does not follow anything, so an unlisted shortener is invisible', () => {
    // The premise of the whole file. However well the text is normalised, a
    // domain that is not in SHORTENERS and redirects to a FiveM server is a
    // fetch away from being known, and this file never fetches.
    expect(scanLinks('someshortener.example/3xY9k', OUR_IPS)).toBeNull()
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

  it('finishes in bounded time on a message of nothing but exempt near-addresses', () => {
    /**
     * A THIRD BOMB SITE, AND THE TWO ABOVE ARE BLIND TO IT. Both of those are
     * pure ASCII, so `fold` returns the string untouched and never runs; and
     * both are built of strings that MATCH NOTHING, so `foreignIp` finds no
     * candidates and its per-match work is never reached.
     *
     * THE EXPENSIVE PATH IS THE ONE WHERE EVERY MATCH IS SKIPPED, because that
     * is the only way the loop keeps going. Each surviving candidate costs a
     * walk forward over the host characters after it, so a message that is
     * thousands of exempt addresses is thousands of walks — the shape that turns
     * a linear scan quadratic. The owner's address is public, so anybody can
     * build this string.
     *
     * NON-ASCII THROUGHOUT, so the NFKC fold and the invisible-strip both run on
     * every byte of it, twice, and the `%` makes it four passes in total.
     */
    const exempt = `${OUR_IP}．png `
    const padded = `${OUR_IP}${'a'.repeat(200)} `
    const escaped = `%E3%80%82${OUR_IP}-30120 `
    const unit = exempt + padded + escaped
    const hostile = unit.repeat(Math.ceil(50_000 / unit.length))

    expect(hostile.length).toBeGreaterThanOrEqual(50_000)
    // Both extra passes are armed: a non-ASCII character reaches `fold`, and a
    // `%` reaches the decode. Without these the test times the cheap path.
    expect(hostile).toContain('．')
    expect(hostile).toContain('%')

    const started = performance.now()
    const why = scanLinks(hostile, OUR_IPS)
    const elapsed = performance.now() - started

    // Null is the assertion that the loop actually ran to the end every time
    // rather than exiting on the first candidate, which is what makes the
    // timing above mean anything.
    expect(why).toBeNull()
    expect(elapsed).toBeLessThan(1_000)
  })
})
