import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  bareNamesIn,
  checkFiles,
  checkSource,
  EXPRESSION_KINDS,
  findExpressionStrings,
  RESERVED_WORDS,
  reservedWordsIn,
} from './check-ddb-expressions.ts'

/**
 * The check that catches the class of bug no test in this repo can.
 *
 * THE POINT OF TESTING A CHECK IS THE FALSE POSITIVE, not the true one. A
 * checker that fails the build on correct code gets deleted within the week, and
 * with it goes the coverage it did have. So most of what follows is "this
 * correct thing is NOT reported": placeholders, function names, operators, the
 * union members in a `Pick<>` type, a human-readable assertion message. The two
 * real bugs are in here as well, and they are the shortest tests in the file.
 *
 * OFFLINE, LIKE EVERYTHING ELSE HERE. The reserved word list is transcribed into
 * the source; these tests read it and the repo's own files and nothing else.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe("the reserved word list is AWS's, whole", () => {
  /**
   * THE COUNT IS THE GUARD AGAINST A HALF-PASTE. The list is 573 words on one
   * page and it is pasted by hand; the failure mode of a hand-pasted list is
   * that it is silently short, and a short reserved word list is a check that
   * passes everything it does not know about. `at` was word 23.
   */
  it('has all 573 words', () => {
    expect(RESERVED_WORDS.size).toBe(573)
  })

  it('is uppercase and alphabetical, as AWS publishes it', () => {
    const words = [...RESERVED_WORDS]
    expect(words.every((w) => w === w.toUpperCase())).toBe(true)
    expect(words).toEqual([...words].sort())
  })

  /**
   * The word that caused the outage, and a handful nobody would put on a
   * shortlist. If a future edit narrows this list to "the common ones", these
   * are what it will drop.
   */
  it('has the words a shortlist would miss', () => {
    for (const word of ['AT', 'BUCKET', 'OWNER', 'SOURCE', 'RESULT', 'TOKEN', 'RANGE', 'RECORD']) {
      expect(RESERVED_WORDS.has(word)).toBe(true)
    }
  })

  /**
   * THE OTHER DIRECTION, AND IT IS THE ONE THAT PROTECTS THE BUILD. Every
   * attribute name this repo actually puts in an expression is here. A garbled
   * paste that added a word — or a future "helpful" addition of `id` or `pk` —
   * would turn the whole of src/ddb.ts red for no reason, and this is where that
   * gets caught rather than in CI.
   */
  it('does not contain the names src/ddb.ts uses', () => {
    for (const name of [
      'PK',
      'SK',
      'TS',
      'ID',
      'LICENSE',
      'LIFTEDAT',
      'LIFTEDBY',
      'LIFTREASON',
      'OUTCOME',
      'RESOLVEDAT',
      'COMMANDID',
    ]) {
      expect(RESERVED_WORDS.has(name)).toBe(false)
    }
  })
})

describe('reading an expression the way DynamoDB reads it', () => {
  it('reads bare attribute names', () => {
    expect(bareNamesIn('ConditionExpression', 'at = :seenAt')).toEqual(['at'])
  })

  /**
   * THE FIX MUST NOT LOOK LIKE THE BUG. `#at` is what the corrected code says,
   * and a checker that reported it would be reporting every correct expression
   * in the repo.
   */
  it('does not read a #name placeholder as an attribute name', () => {
    expect(bareNamesIn('ConditionExpression', '#at = :seenAt')).toEqual([])
  })

  it('does not read a :value placeholder as an attribute name', () => {
    expect(bareNamesIn('ConditionExpression', 'commandId = :status')).toEqual(['commandId'])
  })

  /**
   * `size` and `contains` are themselves reserved words. Read as attribute names
   * they would fail every correct expression that uses them as functions, which
   * is the cry-wolf failure this check cannot afford.
   */
  it('does not read a function name as an attribute name', () => {
    expect(bareNamesIn('ConditionExpression', 'attribute_not_exists(license)')).toEqual(['license'])
    expect(bareNamesIn('ConditionExpression', 'size(payload) > :n')).toEqual(['payload'])
    expect(bareNamesIn('KeyConditionExpression', 'pk = :pk AND begins_with(sk, :sk)')).toEqual(['pk', 'sk'])
    // The path argument of if_not_exists IS an attribute name and is still read.
    expect(bareNamesIn('UpdateExpression', 'SET total = if_not_exists(total, :zero) + :n')).toEqual([
      'total',
      'total',
    ])
  })

  it('reads a function name split from its bracket by a space', () => {
    expect(bareNamesIn('ConditionExpression', 'attribute_not_exists (license)')).toEqual(['license'])
  })

  /**
   * Keywords are grammar, and the grammar differs by expression kind — which is
   * why the kind is a parameter rather than a convenience. `SET` is a clause
   * keyword in an update and a reserved attribute name in a projection.
   */
  it('treats keywords as syntax only in the kinds that have them', () => {
    expect(bareNamesIn('UpdateExpression', 'SET a = :a REMOVE b ADD c :n DELETE d :s')).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
    expect(bareNamesIn('ConditionExpression', 'a = :a AND NOT b = :b OR c BETWEEN :x AND :y')).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(bareNamesIn('FilterExpression', 'a IN (:x, :y)')).toEqual(['a'])
    // A projection is a list of paths. Nothing in it is a keyword, so a word
    // that happens to spell one is an attribute name — and a reserved one.
    expect(bareNamesIn('ProjectionExpression', 'set, name, pk')).toEqual(['set', 'name', 'pk'])
  })

  it('is case-insensitive about keywords, as DynamoDB is', () => {
    expect(bareNamesIn('UpdateExpression', 'set a = :a')).toEqual(['a'])
    expect(bareNamesIn('ConditionExpression', 'a = :a and b = :b')).toEqual(['a', 'b'])
  })

  /**
   * DynamoDB applies the reserved word rule to EVERY element of a document path,
   * so every element has to be read. Aliasing the first does not protect the
   * second.
   */
  it('reads every element of a document path, and the aliased ones not at all', () => {
    expect(bareNamesIn('ProjectionExpression', 'profile.at')).toEqual(['profile', 'at'])
    expect(bareNamesIn('ProjectionExpression', '#profile.at')).toEqual(['at'])
    expect(bareNamesIn('ProjectionExpression', 'sessions[0].name')).toEqual(['sessions', 'name'])
  })

  it('reads the comparison operators', () => {
    expect(bareNamesIn('ConditionExpression', 'a <> :x AND b <= :y AND c >= :z AND d < :w AND e > :v')).toEqual(
      ['a', 'b', 'c', 'd', 'e'],
    )
  })

  /**
   * THE SAFETY VALVE. Assertion arguments are read as expressions (see below),
   * and a string that cannot be an expression must come back as "not an
   * expression" rather than as a bag of words. English prose is full of reserved
   * words — `write`, `key`, `order`, `value` — and reporting them is how a check
   * gets switched off.
   */
  it('refuses a string that cannot be a DynamoDB expression', () => {
    expect(bareNamesIn('ConditionExpression', "the ban write must be conditional, per the owner's rule")).toBe(
      null,
    )
    expect(bareNamesIn('ConditionExpression', 'a = "literal"')).toBe(null)
    expect(bareNamesIn('ConditionExpression', 'a = :')).toBe(null)
    expect(bareNamesIn('ConditionExpression', 'a[x]')).toBe(null)
  })

  it('reads an empty string as an expression with nothing in it', () => {
    expect(bareNamesIn('ConditionExpression', '')).toEqual([])
  })
})

describe('the two bugs that reached production', () => {
  /**
   * BUG ONE, VERBATIM. `ConditionExpression: 'at = :seenAt'` shipped, and
   * DynamoDB answered "Invalid ConditionExpression: Attribute name is a reserved
   * keyword; reserved keyword: at" on the first ban that replaced an existing
   * row. A first ban takes the `attribute_not_exists` branch, which is why the
   * owner's live test passed and a replay hours later did not.
   */
  it('names `at`', () => {
    expect(reservedWordsIn('ConditionExpression', 'at = :seenAt')).toEqual(['at'])
  })

  it('says nothing about the fix', () => {
    expect(reservedWordsIn('ConditionExpression', '#at = :seenAt')).toEqual([])
  })

  /**
   * The whole file, both shapes, as they were on the day: the request being
   * built and the test that asserted the broken string verbatim and went green.
   */
  it('catches the write and the test that pinned it', () => {
    const source = [
      "const guard = { ConditionExpression: 'at = :seenAt' }",
      "expect(put.ConditionExpression).toBe('at = :seenAt')",
    ].join('\n')

    const { violations } = checkSource('src/ddb.ts', source)

    expect(violations.map((v) => ({ line: v.line, word: v.word }))).toEqual([
      { line: 1, word: 'at' },
      { line: 2, word: 'at' },
    ])
  })

  /**
   * BUG TWO IS NOT CAUGHT HERE, and this test exists so that stays a decision
   * rather than a surprise. `Key: { key }` against a table keyed on `id` is a
   * key-shape bug, not an expression bug: `key` never appears in an expression
   * string, and DynamoDB's complaint is "The provided key element does not match
   * the schema" rather than a reserved keyword. The foot of
   * check-ddb-expressions.ts says why the cross-reference against the documented
   * schema is not shipped and what would make it possible.
   */
  it('does not pretend to catch the key-shape bug', () => {
    const source = "const res = await doc.get({ TableName: tables.botState, Key: { key } })"
    expect(checkSource('src/ddb.ts', source).violations).toEqual([])
  })
})

describe('finding the strings in a file', () => {
  const kindsOf = (source: string): string[] =>
    findExpressionStrings('x.ts', source).map((f) => `${f.shape}:${f.kind}:${String(f.text)}`)

  it('finds all five request fields', () => {
    for (const kind of EXPRESSION_KINDS) {
      expect(kindsOf(`const q = { ${kind}: 'a = :a' }`)).toEqual([`property:${kind}:a = :a`])
    }
  })

  /**
   * src/ddb.ts wraps one condition onto its own line and would be invisible to a
   * regex over `Kind: '...'`. The parser does not care where the newline is.
   */
  it('finds a string on the line after the property name', () => {
    const source = ["const q = {", "  ConditionExpression:", "    'at = :seenAt',", "}"].join('\n')
    expect(kindsOf(source)).toEqual(['property:ConditionExpression:at = :seenAt'])
  })

  it('joins a concatenation', () => {
    expect(kindsOf("const q = { ConditionExpression: 'at' + ' = :seenAt' }")).toEqual([
      'property:ConditionExpression:at = :seenAt',
    ])
  })

  /**
   * THE SHAPE THAT PINNED THE BUG. A test asserting the expression is as much a
   * statement about what DynamoDB will accept as the code that builds it, and
   * the one in src/ddb.test.ts was green while the production write was failing.
   */
  it('finds the string a test asserts', () => {
    expect(kindsOf("expect(put.ConditionExpression).toBe('at = :seenAt')")).toEqual([
      'assertion:ConditionExpression:at = :seenAt',
    ])
    expect(kindsOf("expect(input['UpdateExpression']).toBe('SET a = :a')")).toEqual([
      'assertion:UpdateExpression:SET a = :a',
    ])
  })

  /**
   * AND THE ARGUMENT THAT IS NOT AN EXPRESSION. A message passed to `expect`
   * itself is an argument of `expect`, not of the matcher, so it is never read
   * as an expression — which matters because prose is full of reserved words.
   */
  it('does not read an assertion message as an expression', () => {
    expect(kindsOf("expect(put.ConditionExpression, 'the ban write is conditional').toBe(undefined)")).toEqual(
      [],
    )
  })

  /**
   * src/ddb.ts really contains
   * `Pick<PutCommandInput, 'ConditionExpression' | 'ExpressionAttributeNames' | ...>`.
   * Those are type positions, not values. A regex reports them and then reports
   * the word `ConditionExpression` as an attribute name; the parser does not see
   * them at all.
   */
  it('ignores the property names in a type', () => {
    const source = "type G = Pick<PutCommandInput, 'ConditionExpression' | 'ExpressionAttributeNames'>"
    expect(kindsOf(source)).toEqual([])
  })

  it('ignores ExpressionAttributeNames, whose values are meant to be reserved words', () => {
    const source = "const q = { ExpressionAttributeNames: { '#at': 'at' } }"
    expect(kindsOf(source)).toEqual([])
  })

  it('records a computed value as unreadable rather than guessing at it', () => {
    const { violations, notices, checked } = checkSource(
      'x.ts',
      'const q = { ConditionExpression: build(row) }',
    )
    expect(violations).toEqual([])
    expect(checked).toBe(0)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.reason).toContain('not a literal string')
  })

  it('records a shorthand property the same way', () => {
    const { notices } = checkSource('x.ts', 'const q = { ConditionExpression }')
    expect(notices).toHaveLength(1)
  })
})

describe('the check over this repo', () => {
  /**
   * THE ONE THAT IS ACTUALLY WIRED TO THE REPO. Everything above proves the
   * reader works on strings written here; this proves it is pointed at src/ and
   * that src/ is clean today. It is also what would have gone red on 2026-08-30
   * before commit 0b6b370.
   */
  const report = checkFiles(fileURLToPath(new URL('../src', import.meta.url)), repoRoot)

  it('finds no reserved word used bare in src/', () => {
    expect(report.violations.map((v) => `${v.file}:${String(v.line)} ${v.word}`)).toEqual([])
  })

  it('has nothing it could not read', () => {
    expect(report.notices).toEqual([])
  })

  /**
   * A CHECK THAT FINDS NOTHING TO CHECK HAS BROKEN. If src/ddb.ts is renamed, or
   * a refactor moves every expression behind a builder, this check would go on
   * reporting a clean repo forever with nothing to say it had stopped looking.
   * The script fails on zero for the same reason; this asserts the number is
   * comfortably above it and that it counts test files as well as source.
   */
  it('read expression strings from both src/ddb.ts and its test', () => {
    expect(report.checked).toBeGreaterThan(15)
    const files = new Set(report.violations.map((v) => v.file))
    expect(files.size).toBe(0)

    const seen = ['src/ddb.ts', 'src/ddb.test.ts'].map((file) => {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      return findExpressionStrings(file, source).length
    })
    // The twelfth in src/ddb.ts is `incidents.get`'s `ProjectionExpression`,
    // added when that read stopped pulling back the whole incident row; the
    // thirteenth is `incidents.opened`'s `KeyConditionExpression`, which is the
    // one expression in this repo that names a secondary index's key schema
    // rather than a table's.
    expect(seen).toEqual([13, 11])
  })

  /**
   * verify.sh is the one definition of "is this repo OK" and CI runs that exact
   * file. A check that is not in it runs nowhere.
   */
  it('is run by verify.sh', () => {
    const verify = readFileSync(new URL('../verify.sh', import.meta.url), 'utf8')
    expect(verify).toContain('scripts/check-ddb-expressions.ts')
  })
})
