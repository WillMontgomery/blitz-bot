import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  AUDIENCES,
  AUDIENCE_HEADING,
  checkFiles,
  findLeaks,
  formatInventory,
  MARKER,
  readMarkers,
  RETIRED_MARKERS,
  sourceFilesIn,
  type Audience,
} from './check-placeholders.ts'

/**
 * The copy inventory, over source text written here rather than over src/.
 *
 * WHY BOTH HALVES ARE TESTED AND NOT JUST THE REPORT. This check has one job
 * that fails a build — a marker inside a string that ships — and that job exists
 * because it already happened: a real admin ran `/drain` and the first line he
 * read was `PLACEHOLDER: no wording supplied yet for a window that was
 * scheduled.` A check that silently stopped finding those would leave the repo
 * believing it is covered, which is worse than not having it.
 *
 * AND THE PARSING IS TESTED AGAINST THE THING THAT ACTUALLY BROKE IT. The first
 * run over the real src/ reported four malformed markers, all four of them
 * PROSE: comments in this repo explain the convention, and explaining it means
 * writing the word. `@unwritten` has to start its line to count, and that rule
 * has a case below because without it the convention eats its own documentation.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('reading a marker', () => {
  it('lists a marked constant with its audience, note and current text', () => {
    const { entries, faults } = readMarkers(
      'x.ts',
      ['/** @unwritten member — what a member is told when nothing worked. */', "const A = 'try again'"].join(
        '\n',
      ),
    )

    expect(faults).toEqual([])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'A',
      audience: 'member',
      note: 'what a member is told when nothing worked.',
      text: "'try again'",
      line: 2,
    })
  })

  /**
   * `COPY.empty` AND NOT `empty`, because the name is what he replies with and
   * what whoever pastes his wording in has to find. A bare key is a word.
   */
  it('qualifies a property with the record it is in', () => {
    const { entries } = readMarkers(
      'x.ts',
      [
        'const COPY = {',
        '  /** @unwritten admin — a sticky with no text in it. */',
        "  empty: 'nothing yet',",
        '}',
      ].join('\n'),
    )

    expect(entries.map((entry) => entry.name)).toEqual(['COPY.empty'])
  })

  /**
   * ONE TAG OVER A RECORD BECOMES ONE LINE PER LABEL. `KIND_LABEL` and
   * `CATEGORY_LABEL` in src/incidents.ts are ten unworded labels between them,
   * and ten doc comments repeating one sentence over ten one-word strings is a
   * record that stops being marked. He still gets ten addressable lines.
   */
  it('expands a marked record into one entry per string in it', () => {
    const { entries } = readMarkers(
      'x.ts',
      [
        '/** @unwritten admin — one label per kind. */',
        'const KIND_LABEL = {',
        "  report: 'Player report',",
        "  anticheat: 'Anticheat',",
        '}',
      ].join('\n'),
    )

    expect(entries.map((entry) => entry.name)).toEqual(['KIND_LABEL.report', 'KIND_LABEL.anticheat'])
    expect(entries.map((entry) => entry.text)).toEqual(["'Player report'", "'Anticheat'"])
    expect(new Set(entries.map((entry) => entry.note))).toEqual(new Set(['one label per kind.']))
  })

  /**
   * THE SOURCE TEXT AND NOT THE VALUE. A template with the cap interpolated and
   * a function of the time are both strings he has to word, and printing what
   * the source says shows him the hole the number goes in. Evaluating them would
   * need the program to run.
   */
  it('prints a template and a function as the source writes them', () => {
    const { entries } = readMarkers(
      'x.ts',
      [
        'const COPY = {',
        '  /** @unwritten admin — over the cap. */',
        '  tooLong: `longer than ${CAP} characters`,',
        '  /** @unwritten admin — restarts at a time. */',
        '  at: (when: string) => `It restarts at ${when}.`,',
        '}',
      ].join('\n'),
    )

    expect(entries.map((entry) => entry.text)).toEqual([
      '`longer than ${CAP} characters`',
      '(when: string) => `It restarts at ${when}.`',
    ])
  })

  /**
   * ═══ THE ONE THAT CAUGHT THE CHECK OUT ═══
   *
   * Four of these were reported as broken markers on the first run over the real
   * src/, and every one of them was a sentence ABOUT the convention:
   * src/commands/drain.ts says its descriptions are "tagged `@unwritten
   * picker`", src/incidents.ts says "everything tagged `@unwritten` below". Read
   * loosely, each is a marker on whichever declaration follows the paragraph.
   * A tag begins a line. Prose about a tag does not.
   */
  it('ignores the marker written mid-sentence in prose', () => {
    const { entries, faults } = readMarkers(
      'x.ts',
      [
        '/**',
        ' * Every string below is tagged `@unwritten admin` and printed on verify.',
        ' * Nothing here is a marker.',
        ' */',
        "const A = 'his words'",
      ].join('\n'),
    )

    expect(faults).toEqual([])
    expect(entries).toEqual([])
  })

  it('takes a marker on the last line of the doc comment', () => {
    const { entries } = readMarkers(
      'x.ts',
      [
        '/**',
        ' * Several paragraphs of argument.',
        ' *',
        ' * @unwritten player — the ban reason when the dialog was blank.',
        ' */',
        "const BAN = 'banned'",
      ].join('\n'),
    )

    expect(entries.map((entry) => entry.audience)).toEqual(['player'])
  })

  it('accepts a note with no separator in front of it', () => {
    const { entries } = readMarkers(
      'x.ts',
      ['/** @unwritten member what a member reads. */', "const A = 'x'"].join('\n'),
    )

    expect(entries[0]?.note).toBe('what a member reads.')
  })
})

/**
 * A HALF-WRITTEN MARKER IS A STRING THAT THINKS IT IS ON THE LIST AND IS NOT,
 * which is the failure the whole change exists against. The first person to
 * write one is told on their own verify rather than by its absence from a list
 * nobody rereads.
 */
describe('a marker that does not parse', () => {
  it('refuses an audience nobody has heard of', () => {
    const { entries, faults } = readMarkers(
      'x.ts',
      ['/** @unwritten everyone — who reads this? */', "const A = 'x'"].join('\n'),
    )

    expect(entries).toEqual([])
    expect(faults).toHaveLength(1)
    expect(faults[0]?.what).toContain('everyone')
  })

  it('refuses a marker with no audience at all', () => {
    const { faults } = readMarkers('x.ts', ['/** @unwritten */', "const A = 'x'"].join('\n'))

    expect(faults).toHaveLength(1)
    expect(faults[0]?.what).toContain('names no audience')
  })

  /**
   * THE NOTE IS THE HALF HE READS. `COPY.empty` and the stand-in in its place do
   * not tell him what the sentence has to say; the clause does, in the list,
   * without opening a file. So it is required rather than encouraged.
   */
  it('refuses a marker with no note', () => {
    const { faults } = readMarkers('x.ts', ['/** @unwritten admin */', "const A = 'x'"].join('\n'))

    expect(faults).toHaveLength(1)
    expect(faults[0]?.what).toContain('carries no note')
  })

  it('refuses a marker over something with no value to list', () => {
    const { faults } = readMarkers(
      'x.ts',
      ['/** @unwritten admin — nothing to see. */', 'function f(): void {}'].join('\n'),
    )

    expect(faults).toHaveLength(1)
    expect(faults[0]?.what).toContain('nothing to list')
  })
})

/**
 * ═══ THE HALF THAT FAILS THE BUILD, AND THE BUG IT IS ABOUT ═══
 *
 * `PLACEHOLDER: no wording supplied yet for a window that was scheduled.` went
 * to a real admin on a real `/drain start`. The marker was in the sentence so
 * that shipping it would be obvious, and it was obvious — to him, in his own
 * Discord, which is the last place anybody wanted it to be obvious.
 */
describe('a marker inside a string that ships', () => {
  it('catches the current marker and the retired one', () => {
    const leaks = findLeaks(
      'x.ts',
      [
        "const a = 'PLACEHOLDER: no wording supplied yet.'",
        "const b = 'this one @unwritten leaked too'",
        "const fine = 'ordinary copy'",
      ].join('\n'),
    )

    expect(leaks.map((leak) => leak.marker)).toEqual(['PLACEHOLDER', MARKER])
    expect(leaks.map((leak) => leak.line)).toEqual([1, 2])
  })

  /**
   * THE SECOND CHUNK OF A TEMPLATE IS WHERE ONE OF THE EIGHT WAS. `${NOT_BACK}
   * PLACEHOLDER: the console said: ${reason}` went out whole, into the one
   * channel players read, and a check that looked only at whole string literals
   * would have called that file clean.
   */
  it('reads every chunk of a template, not just the first', () => {
    const leaks = findLeaks('x.ts', ['const a = `${x} PLACEHOLDER: the console said: ${y}`'].join('\n'))

    expect(leaks).toHaveLength(1)
  })

  /**
   * AND NOT IN A COMMENT, WHICH IS WHERE THE MARKER IS SUPPOSED TO LIVE. A check
   * that refused the word in a comment would refuse the convention itself — and
   * src/commands/drain.ts's record quotes the owner's own "remove PLACEHOLDER:
   * from all text please", which is history worth keeping and is not a string
   * anybody sends.
   */
  it('says nothing about the marker in a comment or an identifier', () => {
    const leaks = findLeaks(
      'x.ts',
      [
        '/** @unwritten admin — a note. He said: remove PLACEHOLDER: from all text please. */',
        "const BAN_REASON_PLACEHOLDER = 'banned from the Discord server.'",
      ].join('\n'),
    )

    expect(leaks).toEqual([])
  })
})

describe('the report', () => {
  it('groups by audience, in the order the groups matter', () => {
    const entry = (audience: Audience, name: string) => ({
      file: 'x.ts',
      line: 1,
      name,
      audience,
      note: 'n',
      text: "'t'",
    })

    const lines = formatInventory([
      entry('picker', 'D'),
      entry('admin', 'C'),
      entry('member', 'B'),
      entry('player', 'A'),
    ])

    const headings = lines.filter((line) => line.trim().startsWith('READ') || line.includes('PICKER'))

    expect(headings.map((line) => line.trim())).toEqual(
      AUDIENCES.map((audience) => AUDIENCE_HEADING[audience]),
    )
  })

  it('prints the file, the line, the name, the note and what ships', () => {
    const lines = formatInventory([
      {
        file: 'src/commands/sticky.ts',
        line: 94,
        name: 'COPY.empty',
        audience: 'admin',
        note: 'a sticky with no text in it',
        text: "'No wording supplied yet.'",
      },
    ]).join('\n')

    expect(lines).toContain('src/commands/sticky.ts:94')
    expect(lines).toContain('COPY.empty')
    expect(lines).toContain('a sticky with no text in it')
    expect(lines).toContain("ships now: 'No wording supplied yet.'")
  })
})

/**
 * ═══ AND THE REAL src/, WHICH IS THE ONLY PART THAT COULD HAVE CAUGHT IT ═══
 *
 * Eight strings shipped a marker on the day this was written — four of them
 * reachable by a member, one of them by the person being banned — and every unit
 * case above passed over source text invented here. Nothing but a run over the
 * actual tree says whether the repo is clean.
 */
describe('the repository as it stands', () => {
  const report = checkFiles(fileURLToPath(new URL('../src', import.meta.url)), repoRoot)

  it('ships no marker to anybody', () => {
    expect(report.leaks).toEqual([])
  })

  it('has no marker that does not parse', () => {
    expect(report.faults).toEqual([])
  })

  /**
   * NOT AN EXPECTED COUNT, DELIBERATELY. A number here is a ratchet, and a
   * ratchet is a thing people bump without reading what it counts — which is the
   * whole failure this change is about. What is asserted is that the check is
   * still finding things at all: it is reading the real files, the strings the
   * owner has been surprised by are among them, and a parser that quietly
   * stopped parsing would report a clean repo forever.
   */
  it('is still finding the strings it was built to find', () => {
    expect(report.files).toBeGreaterThan(10)
    expect(report.entries.length).toBeGreaterThan(10)

    const names = report.entries.map((entry) => `${entry.file} ${entry.name}`)

    expect(names).toContain('src/client.ts BAN_REASON_UNWRITTEN')
    expect(names).toContain('src/incidents.ts COPY.filedTitle')
    expect(names).toContain('src/incidents.ts CATEGORY_LABEL.teaming')
    expect(names).toContain('src/commands/sticky.ts COPY.empty')
  })

  /** Every entry is answerable: a note to write from, and a name to reply with. */
  it('gives him something to write from on every line', () => {
    for (const entry of report.entries) {
      expect(entry.note.length, entry.name).toBeGreaterThan(10)
      expect(entry.text.trim(), entry.name).not.toBe('')
      expect(AUDIENCES).toContain(entry.audience)
    }
  })

  /**
   * TEST FILES ARE OUT, AND THAT IS THE OPPOSITE CALL FROM
   * ./check-ddb-expressions.ts, WHICH READS THEM. There, a test asserting a
   * broken expression string was the bug being PINNED and had to be caught.
   * Here, a test file ships nothing to a human — its strings reach a terminal —
   * and a test that needs to write about the marker, this one included, must be
   * able to say the word.
   */
  it('reads the source and not the tests', () => {
    const files = sourceFilesIn(fileURLToPath(new URL('../src', import.meta.url)))

    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false)
    expect(files.length).toBeGreaterThan(10)
  })
})

/** The retired marker is still refused by name, which is the one that escaped. */
it('still refuses the word that reached his channel', () => {
  expect(RETIRED_MARKERS).toContain('PLACEHOLDER')
})

/**
 * verify.sh is the one definition of "is this repo OK" and CI runs that exact
 * file. A check that is not in it runs nowhere — and a list nobody is shown is
 * the state this whole change is undoing.
 */
it('is run by verify.sh', () => {
  const verify = readFileSync(new URL('../verify.sh', import.meta.url), 'utf8')

  expect(verify).toContain('scripts/check-placeholders.ts')
})
