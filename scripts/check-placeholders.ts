/**
 * Every user-facing string in `src/` that nobody has the owner's words for,
 * printed on every verify and on every push.
 *
 * ═══ WHAT WENT WRONG, IN HIS WORDS ═══
 *
 * "What other surprise PLACEHOLDER text exists? I was never made aware of these
 * and finding them on the fly is terrible." He had been learning which replies
 * were unfinished by running the bot and reading them in his own Discord, one at
 * a time, weeks after each was written.
 *
 * THERE WERE TWO CONVENTIONS AND THEY DISAGREED. src/commands/command.ts,
 * src/commands/sticky.ts, src/maintenance.ts and `BAN_REASON_UNWRITTEN` in
 * src/client.ts each led the string with a literal `PLACEHOLDER:` so that
 * shipping one was unmistakable in the channel. src/incidents.ts marked its
 * eighteen in DOC COMMENTS only, so `Incident filed`, `Case`, `Unclassified` and
 * ten kind and category labels read as finished copy to anybody who was not
 * reading the source beside them. Half the gap announced itself and half of it
 * was invisible, and no reader of the bot could tell which half they were
 * looking at.
 *
 * AND THE LOUD HALF WAS NOT THE ANSWER EITHER. He read `/drain` and said:
 * "remove PLACEHOLDER: from all text please. The verbiage otherwise looks
 * great." A marker that ships is a marker he has to look at, in the product,
 * which is the same complaint one layer down.
 *
 * ═══ SO: THE STRINGS ARE CLEAN AND THE LIST IS THE MECHANISM ═══
 *
 * A string declares itself unwritten in its DOC COMMENT, with `@unwritten`, an
 * audience, and one clause saying what the string is for. Nothing ships. This
 * file reads them out of src/ and prints the lot — file, line, identifier, who
 * reads it, what it is for, and the sentence that ships today — so that the
 * answer to "what else is unwritten" is a command and not an afternoon of
 * grepping, and so that a string written on a Tuesday is on the list on the
 * Tuesday rather than the day it turns up in his channel.
 *
 * THE NOTE IS REQUIRED AND THAT IS THE POINT OF IT. He is being asked to write
 * a sentence; "COPY.empty" and the stand-in currently in its place do not tell
 * him what the sentence has to say. The clause does, in the list, without
 * opening a file.
 *
 * ═══ WHY A COMMENT AND NOT A WRAPPER FUNCTION ═══
 *
 * `unwritten('admin', 'text')` was the alternative, and its advantage is real:
 * the type system can require the audience, so the convention cannot be
 * half-followed. It was rejected on three counts.
 *
 *   IT DOES NOT SOLVE THE PROBLEM IT LOOKS LIKE IT SOLVES. Forgetting to wrap a
 *   new string is exactly as easy as forgetting to comment it. Neither device
 *   can compel a person who does not know the rule exists; what does that job
 *   here is the inventory being in front of everybody on every run.
 *
 *   IT PUTS SHIPPING CODE IN THE BOT FOR A BUILD-TIME CONCERN. A call that
 *   returns its argument, in the hot path of a reply, so that a script can find
 *   a string. And it widens `COPY['foreign-ip']` from a literal to `string`,
 *   which is the exact typing that src/client.ts's `satisfies` was written to
 *   keep.
 *
 *   IT DOES NOT FIT HALF THE VALUES. `COPY.tooLong` is a template, `deployAtTime`
 *   is a function of the time, `KIND_LABEL` is ten labels in one record. A
 *   comment sits above any of those; a wrapper needs a different shape for each.
 *
 * The comment's own weakness is drift — a marker outliving the wording that
 * replaced it — and this repo has a live example: src/client.ts's header claimed
 * the removal notices were unwritten for weeks after the owner supplied them,
 * with a test pinning the claim. Nothing static can see that. The list can: it
 * is read by the one person who knows, and an entry he recognises as his own is
 * one line to delete. That is a real answer, and it is why the inventory is
 * printed rather than counted.
 *
 * ═══ WHAT FAILS THE BUILD, AND WHY IT IS NOT THE LIST ═══
 *
 * UNWRITTEN COPY IS A NORMAL STATE HERE. He supplies wording over days, in
 * batches, after reading the bot. A check that failed on it would leave
 * verify.sh permanently red, and a permanently red check is one everybody learns
 * to run with — at which point the next real failure is invisible too. So the
 * inventory reports and never fails.
 *
 * WHAT FAILS IS THE NARROW THING THAT ACTUALLY REACHED HIS CHANNEL: a shipped
 * string carrying a marker. `PLACEHOLDER: no wording supplied yet for a window
 * that was scheduled.` was the first line a real admin read on a real
 * `/drain start`. That is a bug with a definite answer — the marker belongs in
 * the comment — so it is refused here, in every string literal and every
 * template in src/, for the current marker and for the retired one.
 *
 * A MALFORMED MARKER FAILS TOO, for the reason the convention exists: a marker
 * with no audience, or an audience nobody has heard of, or a note that was never
 * written, is a string that thinks it is on the list and is not. The first
 * person to write one is told so on their own verify rather than by its absence
 * from a list nobody rereads.
 *
 * THERE IS NO BASELINE FILE AND NO EXPECTED COUNT. A ratchet would fail until
 * somebody bumps a number, and bumping a number is a thing people do without
 * reading what it counts. The deliberate act this needs is writing the marker,
 * and the list is printed on every run by everybody, which is the notice a
 * baseline pretends to be.
 *
 * ═══ SCOPE ═══
 *
 * `src/`, excluding `*.test.ts`. A test file ships nothing to a human: its
 * strings reach a terminal, and a test that needs to write about the marker —
 * this file's own test does — must be able to say the word.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

/**
 * The marker.
 *
 * A JSDOC-SHAPED TAG BECAUSE EVERY COMMENT IN THIS REPO IS PROSE. Files here
 * carry paragraphs above every declaration, and a marker written as a sentence
 * would be one more sentence — `@unwritten` is visibly a tag rather than
 * narrative, in a file where everything else is narrative, and that is most of
 * what makes it hard to miss when reading and easy to find when grepping.
 *
 * AND IT IS A WORD THAT CANNOT TURN UP IN COPY. Whatever the owner writes about
 * a ban, a sticky or a maintenance window, it does not contain an at-sign
 * followed by `unwritten`, so the rule below — no shipped string may contain it
 * — has no honest exception to carve out.
 */
export const MARKER = '@unwritten'

/**
 * Markers this repo used to use, refused in shipped strings alongside the
 * current one.
 *
 * `PLACEHOLDER` IS HERE BECAUSE IT IS THE ONE THAT ESCAPED. Eight strings led
 * with it and four of them could reach a member; one reached an admin on
 * `/drain` and is the reason this file exists. Keeping the retired word in the
 * refusal means the specific bug that happened stays caught by name, and that
 * somebody reaching for the old convention out of muscle memory is told on their
 * own machine.
 */
export const RETIRED_MARKERS: readonly string[] = ['PLACEHOLDER']

/**
 * Who reads it. The first thing he will sort by, so it is required rather than
 * inferred.
 *
 * INFERRING IT WAS TRIED IN THE HEAD AND ABANDONED. Whether a string reaches a
 * member depends on which command carries it, whether that command's gate is a
 * constant or a function of the invocation, and whether the reply is ephemeral —
 * three facts in three files, none of which a script reading one declaration can
 * see. A guess printed beside a string is worse than a blank: he would sort by
 * it.
 *
 * FOUR, AND THE FOURTH IS A SURFACE RATHER THAN A READER. `picker` is the
 * command and option descriptions Discord will not let a command be registered
 * without. They are not stand-ins — they are plain, working sentences — but
 * nobody asked him for them, three files each promise to "hand them back when he
 * wants his own", and a promise nobody wrote down is a promise nobody keeps.
 * They are grouped apart and last so that a list he reads for the gap is not a
 * list of twelve command descriptions.
 */
export const AUDIENCES = ['player', 'member', 'admin', 'picker'] as const

export type Audience = (typeof AUDIENCES)[number]

/** What each group is, said in the report so the token is never read alone. */
export const AUDIENCE_HEADING: Record<Audience, string> = {
  player: 'READ BY A PLAYER IN GAME, INCLUDING THE PERSON BEING BANNED',
  member: 'READ BY ANY MEMBER OF THE GUILD',
  admin: 'READ BY AN ADMIN',
  picker: "SHOWN BY DISCORD IN THE COMMAND PICKER (Discord requires these; the words are the bot's)",
}

const AUDIENCE_SET: ReadonlySet<string> = new Set<string>(AUDIENCES)

/** One string awaiting his wording. */
export type Entry = {
  file: string
  line: number
  /** `COPY.empty`, `KIND_LABEL.report`, `NOT_BACK` — what to say when replying. */
  name: string
  audience: Audience
  /** One clause: what the string has to say. */
  note: string
  /** What ships today, as the source writes it. */
  text: string
}

/** A marker that does not parse. Fails the check. */
export type Fault = { file: string; line: number; what: string }

/** A shipped string carrying a marker. Fails the check. This is the /drain bug. */
export type Leak = { file: string; line: number; marker: string; text: string }

export type Report = { entries: Entry[]; faults: Fault[]; leaks: Leak[]; files: number }

/**
 * How much of a string is printed before it is cut.
 *
 * LONG ENOUGH FOR EVERY STRING IN src/ TODAY, so the cut is a guard against a
 * paragraph somebody writes later rather than something that fires now. He is
 * reading this list to decide what to rewrite; a sentence with its end missing
 * is a sentence he has to go and open the file for, which is the thing this
 * exists to stop.
 */
const TEXT_CAP = 200

/** One line, whatever the source did with newlines and indentation. */
function oneLine(text: string, cap = TEXT_CAP): string {
  const flat = text.replace(/\s+/gu, ' ').trim()

  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`
}

/** A marker line, before anybody has decided whether it is any good. */
type RawMarker = { pos: number; line: number; audience: string; note: string }

/**
 * Every marker line in a file.
 *
 * THE TAG HAS TO START ITS LINE, WHICH IS JSDOC'S OWN RULE AND IS ALSO FORCED
 * HERE. The comments in this repo are prose, and prose about this mechanism says
 * the word: src/commands/drain.ts's record explains that its four descriptions
 * are "tagged `@unwritten picker`", src/incidents.ts's says "everything tagged
 * `@unwritten` below". Read loosely, every one of those sentences is a marker on
 * whatever declaration follows the paragraph — the first run of this check
 * produced four, two of them naming an audience of `` ` ``. A tag begins a line;
 * a sentence mentioning one does not.
 *
 * A SWEEP OF THE WHOLE FILE RATHER THAN OF THE DECLARATIONS, so that a marker
 * over something this cannot list — a function, a type, nothing at all — is
 * FOUND and reported rather than skipped in silence. Silence is the failure the
 * whole change is about.
 */
function markerLines(source: string): RawMarker[] {
  const out: RawMarker[] = []

  // WALKED WITH `indexOf` RATHER THAN `split`, because `pos` is compared against
  // TypeScript's own comment ranges and has to be an offset into this exact
  // string. `split(/\r?\n/)` drops the `\r` as well as the `\n`, so on a CRLF
  // checkout — which this repo has, on Windows, by .gitattributes — every line
  // after the first would be off by one more character than the last, and the
  // marker would drift out of the comment it is in.
  for (let start = 0, index = 0; start <= source.length; index += 1) {
    const newline = source.indexOf('\n', start)
    const end = newline < 0 ? source.length : newline
    const raw = source.slice(start, end)
    const at = raw.indexOf(MARKER)

    // Nothing but comment furniture in front of it: `/**`, ` * `, `//`.
    if (at >= 0 && /^\s*(?:\/\*+\s*|\/\/\s*)?\*?\s*$/u.test(raw.slice(0, at))) {
      const rest = raw
        .slice(at + MARKER.length)
        // A one-line doc comment ends on the same line as its tag.
        .replace(/\*\/\s*$/u, '')
        .trim()

      const [audience = '', ...tail] = rest.split(/\s+/u)

      out.push({
        pos: start + at,
        line: index + 1,
        audience,
        // The separator is optional and any of the several somebody would type.
        note: tail.join(' ').replace(/^[—–\-:]\s*/u, '').trim(),
      })
    }

    if (newline < 0) break
    start = end + 1
  }

  return out
}

/**
 * The marker in the comments above a node.
 *
 * `getLeadingCommentRanges` FROM `getFullStart`, so a comment belongs to exactly
 * one declaration: the trivia between the previous token and this one. Matching
 * a marker to the next declaration by line number cannot tell the comment above
 * a property from the comment above the property before it.
 */
function markerAbove(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  markers: readonly RawMarker[],
): RawMarker | null {
  const source = sourceFile.getFullText()

  for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
    const found = markers.find((marker) => marker.pos >= range.pos && marker.pos < range.end)
    if (found !== undefined) return found
  }

  return null
}

/** `refused`, `'foreign-ip'`, `0` — a property's name as it is written. */
function propertyKeyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text
  }

  return null
}

/**
 * What one marked declaration puts on the list.
 *
 * A RECORD EXPANDS INTO ITS PROPERTIES, WHICH IS THE WHOLE REASON THIS IS NOT A
 * ONE-LINER. `KIND_LABEL` and `CATEGORY_LABEL` in src/incidents.ts are ten
 * labels the owner has never worded, and ten doc comments saying the same thing
 * above ten one-word strings is a record nobody will keep marked. One marker on
 * the record, ten lines in his list, and each line names the key he has to
 * answer about.
 */
function entriesFor(
  sourceFile: ts.SourceFile,
  name: string,
  initializer: ts.Expression,
): { name: string; line: number; text: string }[] {
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

  if (ts.isObjectLiteralExpression(initializer)) {
    const out: { name: string; line: number; text: string }[] = []

    for (const member of initializer.properties) {
      if (!ts.isPropertyAssignment(member)) continue
      const key = propertyKeyName(member.name)
      if (key === null) continue

      out.push({
        name: `${name}.${key}`,
        line: lineOf(member),
        text: oneLine(member.initializer.getText(sourceFile)),
      })
    }

    return out
  }

  return [{ name, line: lineOf(initializer), text: oneLine(initializer.getText(sourceFile)) }]
}

/**
 * Every marker in one file, and every marker in it that does not parse.
 *
 * THE SOURCE TEXT OF THE VALUE, NOT THE VALUE. `COPY.tooLong` is a template with
 * the cap interpolated and `deployAtTime` is a function of the time; printing
 * what the source says shows him both honestly, including the hole the number
 * goes in. Evaluating them would need the program to run, and would print a cap
 * of `100` as though somebody had typed it.
 */
export function readMarkers(fileName: string, source: string): { entries: Entry[]; faults: Fault[] } {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const entries: Entry[] = []
  const faults: Fault[] = []

  const markers = markerLines(source)
  const claimed = new Set<number>()

  const take = (node: ts.Node, name: string | null, initializer: ts.Expression | undefined): void => {
    const marker = markerAbove(sourceFile, node, markers)
    if (marker === null) return

    claimed.add(marker.pos)

    if (!AUDIENCE_SET.has(marker.audience)) {
      faults.push({
        file: fileName,
        line: marker.line,
        what:
          marker.audience === ''
            ? `${MARKER} names no audience. Write one of: ${AUDIENCES.join(', ')}`
            : `${MARKER} names an audience nobody has heard of: \`${marker.audience}\`. ` +
              `Write one of: ${AUDIENCES.join(', ')}`,
      })
      return
    }

    if (marker.note === '') {
      faults.push({
        file: fileName,
        line: marker.line,
        what:
          `${MARKER} carries no note. Add one clause saying what the string has to ` +
          'say — that clause is what the owner reads when he writes the wording',
      })
      return
    }

    if (name === null || initializer === undefined) {
      faults.push({
        file: fileName,
        line: marker.line,
        what: `${MARKER} is not above a named declaration with a value, so there is nothing to list`,
      })
      return
    }

    const found = entriesFor(sourceFile, name, initializer)

    if (found.length === 0) {
      faults.push({
        file: fileName,
        line: marker.line,
        what: `${MARKER} is above \`${name}\`, which holds no strings to list`,
      })
      return
    }

    for (const one of found) {
      entries.push({
        file: fileName,
        line: one.line,
        name: one.name,
        audience: marker.audience as Audience,
        note: marker.note,
        text: one.text,
      })
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      // The marker sits above the STATEMENT, and the value is on the declaration
      // inside it. `const A = 'x', B = 'y'` is not written anywhere in this repo;
      // if it ever is, each declaration is listed and the one marker covers both,
      // which is what the marker above them says.
      for (const declaration of node.declarationList.declarations) {
        take(
          node,
          ts.isIdentifier(declaration.name) ? declaration.name.text : null,
          declaration.initializer,
        )
      }
    } else if (ts.isPropertyAssignment(node)) {
      take(node, qualified(sourceFile, node), node.initializer)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  // A MARKER NOTHING CLAIMED IS THE QUIET FAILURE. Above a function, above a
  // type, above an `export default`, or floating in a header: it reads like a
  // string on the list and it is on no list. Reported here rather than skipped,
  // which is the difference between the convention being enforced and being a
  // suggestion.
  for (const marker of markers) {
    if (claimed.has(marker.pos)) continue

    faults.push({
      file: fileName,
      line: marker.line,
      what: `${MARKER} is not above a named declaration with a value, so there is nothing to list`,
    })
  }

  return { entries, faults }
}

/**
 * `COPY.empty` rather than `empty`, by walking out to whatever the object was
 * assigned to.
 *
 * HE REPLIES WITH THESE NAMES. "empty" is a word; `COPY.empty` in
 * src/commands/sticky.ts is an address, and it is the one whoever pastes his
 * wording in has to find.
 */
function qualified(sourceFile: ts.SourceFile, node: ts.PropertyAssignment): string | null {
  const key = propertyKeyName(node.name)
  if (key === null) return null

  const path = [key]

  for (let parent: ts.Node | undefined = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isPropertyAssignment(parent)) {
      const outer = propertyKeyName(parent.name)
      if (outer !== null) path.unshift(outer)
    } else if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      path.unshift(parent.name.text)
      break
    }
  }

  return path.join('.')
}

/**
 * Every string in one file that carries a marker, which is the thing that fails.
 *
 * STRING LITERALS AND TEMPLATES, AND NOT COMMENTS OR IDENTIFIERS. The whole
 * design is that the marker lives in a comment, so a check that refused the word
 * in a comment would refuse the convention itself — and src/commands/drain.ts's
 * record quotes the owner's own "remove PLACEHOLDER: from all text please",
 * which is history worth keeping and is not a string anybody sends.
 *
 * A TEMPLATE'S PIECES ARE CHECKED ONE BY ONE. `${NOT_BACK} PLACEHOLDER: the
 * console said: ${reason}` is a template whose second chunk carried the marker,
 * and it went out with the rest of the sentence.
 */
export function findLeaks(fileName: string, source: string): Leak[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const leaks: Leak[] = []
  const markers = [MARKER, ...RETIRED_MARKERS]

  const check = (node: ts.Node, text: string): void => {
    for (const marker of markers) {
      if (!text.includes(marker)) continue

      leaks.push({
        file: fileName,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        marker,
        text: oneLine(text),
      })
      return
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      check(node, node.text)
    } else if (ts.isTemplateExpression(node)) {
      check(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' '))
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return leaks
}

/**
 * Every `.ts` file under a directory that is not a test, sorted.
 *
 * SORTED SO THE LIST IS THE SAME RUN TO RUN. He is going to read this list
 * repeatedly and answer parts of it; an order that moves when a file is touched
 * makes "the third one" mean nothing between two runs.
 */
export function sourceFilesIn(root: string): string[] {
  const out: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full)
      }
    }
  }

  walk(root)
  return out
}

export function checkFiles(root: string, reportRelativeTo: string): Report {
  const entries: Entry[] = []
  const faults: Fault[] = []
  const leaks: Leak[] = []
  let files = 0

  for (const file of sourceFilesIn(root)) {
    const shown = relative(reportRelativeTo, file).split('\\').join('/')
    const source = readFileSync(file, 'utf8')

    const marked = readMarkers(shown, source)
    entries.push(...marked.entries)
    faults.push(...marked.faults)
    leaks.push(...findLeaks(shown, source))
    files += 1
  }

  return { entries, faults, leaks, files }
}

/** The list, grouped by who reads it, in the order the groups matter. */
export function formatInventory(entries: readonly Entry[]): string[] {
  const lines: string[] = []

  for (const audience of AUDIENCES) {
    const group = entries.filter((entry) => entry.audience === audience)
    if (group.length === 0) continue

    lines.push('', `  ${AUDIENCE_HEADING[audience]}`)

    for (const entry of group) {
      lines.push(`    ${entry.file}:${String(entry.line)}  ${entry.name} — ${entry.note}`)
      lines.push(`      ships now: ${entry.text}`)
    }
  }

  return lines
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const repo = resolve(here, '..')
  const root = join(repo, 'src')

  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`copy: ${root} is not a directory\n`)
    process.exitCode = 1
    return
  }

  const report = checkFiles(root, repo)

  if (report.entries.length === 0) {
    // NOT A FAILURE, AND NOT SILENT EITHER. Every string having the owner's words
    // is the end state this is working towards, so it cannot be an error. But it
    // is also what a parser that has stopped parsing reports, and that version of
    // this check would call the repo clean forever.
    process.stdout.write(
      `copy: no string in src/ is marked ${MARKER}, across ${String(report.files)} files.\n` +
        'copy: if that is a surprise rather than good news, this check has stopped working.\n',
    )
  } else {
    process.stdout.write(
      [
        '',
        'THESE STRINGS ARE WAITING FOR THE OWNER\'S WORDING. Nothing here is broken and',
        'nothing here fails: this is the list of copy nobody has his words for, printed so',
        'that finding out which replies are unfinished is reading this rather than running',
        'the bot. Reply with the identifier and the sentence and it is one edit each.',
        ...formatInventory(report.entries),
        '',
        `copy: ${String(report.entries.length)} strings awaiting his wording, ` +
          `in ${String(new Set(report.entries.map((entry) => entry.file)).size)} files ` +
          `of ${String(report.files)} read\n`,
      ].join('\n'),
    )
  }

  if (report.faults.length > 0) {
    process.stderr.write(
      [
        '',
        `copy: a ${MARKER} marker does not parse, so its string is on no list.`,
        '',
        ...report.faults.map((fault) => `  ${fault.file}:${String(fault.line)}  ${fault.what}`),
        '',
        `The shape is: ${MARKER} <audience> — <one clause saying what the string has to say>`,
        `Audiences: ${AUDIENCES.join(', ')}. See scripts/check-placeholders.ts.`,
        '',
      ].join('\n'),
    )
    process.exitCode = 1
    return
  }

  if (report.leaks.length > 0) {
    process.stderr.write(
      [
        '',
        'copy: a string that SHIPS carries a marker, and a marker must never ship.',
        'This is the bug that reached the owner\'s channel: a real admin ran /drain and',
        'the first line he read was `PLACEHOLDER: no wording supplied yet for a window',
        'that was scheduled.` The marker belongs in the doc comment above the string.',
        '',
        ...report.leaks.map(
          (leak) => `  ${leak.file}:${String(leak.line)}  carries \`${leak.marker}\`\n      ${leak.text}`,
        ),
        '',
        `Move the marker into the doc comment as \`${MARKER} <audience> — <what it says>\``,
        'and leave the string itself alone. The list above is what makes it visible.',
        '',
      ].join('\n'),
    )
    process.exitCode = 1
    return
  }
}

// Run only when invoked as a script. Imported by its test, which must not exit
// the process.
const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) main()
