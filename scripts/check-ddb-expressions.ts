/**
 * Every DynamoDB expression string in `src/`, read the way DynamoDB reads it,
 * and refused here if it names a reserved word without a placeholder.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A TEST. Two of these reached production in
 * one day and neither could have been caught by the test suite, because of what
 * the test suite is: every test injects a fake `DynamoDBDocumentClient`, and a
 * fake accepts whatever string the code hands it. The fake and the code agree
 * with each other and both disagree with DynamoDB. Worse, the reserved-word bug
 * had a test that asserted the broken string VERBATIM -- so the suite passed AND
 * pinned the bug in place, and the next person to "fix" the code would have had
 * to delete a green assertion to do it.
 *
 * A mocked seam can only prove the two halves of the mock agree. The missing
 * piece is a rule that comes from OUTSIDE the program: DynamoDB's own reserved
 * word list, applied to the strings the program actually contains. That is a
 * static check over source text, and it is the only shape of check that could
 * have caught `at = :seenAt` before the deploy.
 *
 * WHAT IT COSTS TO GET WRONG, which is the reason for the care below. A check
 * that reports a problem that is not one gets switched off, and a switched-off
 * check is worse than no check because the repo believes it is covered. So the
 * bar here is zero false positives on correct code, and a false NEGATIVE is
 * accepted wherever the alternative is a guess -- each one is named in a comment
 * where it happens rather than left for somebody to discover.
 *
 * SCOPE, DELIBERATELY. This checks reserved words in expression strings. It does
 * NOT check that a `Key: { ... }` matches the table's real partition key, which
 * is the OTHER bug from the same day. That one was attempted and is not shippable
 * -- see the note at the foot of this file, which says why and what would make it
 * possible.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

/**
 * DynamoDB's reserved words, all 573 of them, from
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html
 * (fetched 2026-08-30), verbatim and in AWS's own order, which is alphabetical.
 *
 * TRANSCRIBED WHOLE RATHER THAN NARROWED TO "THE COMMON ONES", and that is the
 * entire value of the list. Nobody's shortlist has `AT` on it. Nobody's
 * shortlist has `BUCKET`, `OWNER`, `SOURCE`, `RESULT`, `TOKEN`, `RANGE` or
 * `RECORD` on it either, and all seven are the kind of word a schema written by
 * a person actually uses. A list of the twenty words everybody already
 * remembers catches the bugs nobody writes.
 *
 * NOT FETCHED AT RUN TIME. The test suite and CI run offline, on purpose (see
 * .github/workflows/ci.yml: no secrets, no network), and a check that needs the
 * internet fails on somebody else's outage. AWS adds to this list roughly never;
 * when it does, re-fetch the page and paste the block. `npm run test` asserts the
 * count and the sort order, so a half-pasted list is caught here rather than
 * being quietly permissive.
 */
const RESERVED_WORD_LIST = `
  ABORT ABSOLUTE ACTION ADD AFTER AGENT AGGREGATE ALL
  ALLOCATE ALTER ANALYZE AND ANY ARCHIVE ARE ARRAY
  AS ASC ASCII ASENSITIVE ASSERTION ASYMMETRIC AT ATOMIC
  ATTACH ATTRIBUTE AUTH AUTHORIZATION AUTHORIZE AUTO AVG BACK
  BACKUP BASE BATCH BEFORE BEGIN BETWEEN BIGINT BINARY
  BIT BLOB BLOCK BOOLEAN BOTH BREADTH BUCKET BULK
  BY BYTE CALL CALLED CALLING CAPACITY CASCADE CASCADED
  CASE CAST CATALOG CHAR CHARACTER CHECK CLASS CLOB
  CLOSE CLUSTER CLUSTERED CLUSTERING CLUSTERS COALESCE COLLATE COLLATION
  COLLECTION COLUMN COLUMNS COMBINE COMMENT COMMIT COMPACT COMPILE
  COMPRESS CONDITION CONFLICT CONNECT CONNECTION CONSISTENCY CONSISTENT CONSTRAINT
  CONSTRAINTS CONSTRUCTOR CONSUMED CONTINUE CONVERT COPY CORRESPONDING COUNT
  COUNTER CREATE CROSS CUBE CURRENT CURSOR CYCLE DATA
  DATABASE DATE DATETIME DAY DEALLOCATE DEC DECIMAL DECLARE
  DEFAULT DEFERRABLE DEFERRED DEFINE DEFINED DEFINITION DELETE DELIMITED
  DEPTH DEREF DESC DESCRIBE DESCRIPTOR DETACH DETERMINISTIC DIAGNOSTICS
  DIRECTORIES DISABLE DISCONNECT DISTINCT DISTRIBUTE DO DOMAIN DOUBLE
  DROP DUMP DURATION DYNAMIC EACH ELEMENT ELSE ELSEIF
  EMPTY ENABLE END EQUAL EQUALS ERROR ESCAPE ESCAPED
  EVAL EVALUATE EXCEEDED EXCEPT EXCEPTION EXCEPTIONS EXCLUSIVE EXEC
  EXECUTE EXISTS EXIT EXPLAIN EXPLODE EXPORT EXPRESSION EXTENDED
  EXTERNAL EXTRACT FAIL FALSE FAMILY FETCH FIELDS FILE
  FILTER FILTERING FINAL FINISH FIRST FIXED FLATTERN FLOAT
  FOR FORCE FOREIGN FORMAT FORWARD FOUND FREE FROM
  FULL FUNCTION FUNCTIONS GENERAL GENERATE GET GLOB GLOBAL
  GO GOTO GRANT GREATER GROUP GROUPING HANDLER HASH
  HAVE HAVING HEAP HIDDEN HOLD HOUR IDENTIFIED IDENTITY
  IF IGNORE IMMEDIATE IMPORT IN INCLUDING INCLUSIVE INCREMENT
  INCREMENTAL INDEX INDEXED INDEXES INDICATOR INFINITE INITIALLY INLINE
  INNER INNTER INOUT INPUT INSENSITIVE INSERT INSTEAD INT
  INTEGER INTERSECT INTERVAL INTO INVALIDATE IS ISOLATION ITEM
  ITEMS ITERATE JOIN KEY KEYS LAG LANGUAGE LARGE
  LAST LATERAL LEAD LEADING LEAVE LEFT LENGTH LESS
  LEVEL LIKE LIMIT LIMITED LINES LIST LOAD LOCAL
  LOCALTIME LOCALTIMESTAMP LOCATION LOCATOR LOCK LOCKS LOG LOGED
  LONG LOOP LOWER MAP MATCH MATERIALIZED MAX MAXLEN
  MEMBER MERGE METHOD METRICS MIN MINUS MINUTE MISSING
  MOD MODE MODIFIES MODIFY MODULE MONTH MULTI MULTISET
  NAME NAMES NATIONAL NATURAL NCHAR NCLOB NEW NEXT
  NO NONE NOT NULL NULLIF NUMBER NUMERIC OBJECT
  OF OFFLINE OFFSET OLD ON ONLINE ONLY OPAQUE
  OPEN OPERATOR OPTION OR ORDER ORDINALITY OTHER OTHERS
  OUT OUTER OUTPUT OVER OVERLAPS OVERRIDE OWNER PAD
  PARALLEL PARAMETER PARAMETERS PARTIAL PARTITION PARTITIONED PARTITIONS PATH
  PERCENT PERCENTILE PERMISSION PERMISSIONS PIPE PIPELINED PLAN POOL
  POSITION PRECISION PREPARE PRESERVE PRIMARY PRIOR PRIVATE PRIVILEGES
  PROCEDURE PROCESSED PROJECT PROJECTION PROPERTY PROVISIONING PUBLIC PUT
  QUERY QUIT QUORUM RAISE RANDOM RANGE RANK RAW
  READ READS REAL REBUILD RECORD RECURSIVE REDUCE REF
  REFERENCE REFERENCES REFERENCING REGEXP REGION REINDEX RELATIVE RELEASE
  REMAINDER RENAME REPEAT REPLACE REQUEST RESET RESIGNAL RESOURCE
  RESPONSE RESTORE RESTRICT RESULT RETURN RETURNING RETURNS REVERSE
  REVOKE RIGHT ROLE ROLES ROLLBACK ROLLUP ROUTINE ROW
  ROWS RULE RULES SAMPLE SATISFIES SAVE SAVEPOINT SCAN
  SCHEMA SCOPE SCROLL SEARCH SECOND SECTION SEGMENT SEGMENTS
  SELECT SELF SEMI SENSITIVE SEPARATE SEQUENCE SERIALIZABLE SESSION
  SET SETS SHARD SHARE SHARED SHORT SHOW SIGNAL
  SIMILAR SIZE SKEWED SMALLINT SNAPSHOT SOME SOURCE SPACE
  SPACES SPARSE SPECIFIC SPECIFICTYPE SPLIT SQL SQLCODE SQLERROR
  SQLEXCEPTION SQLSTATE SQLWARNING START STATE STATIC STATUS STORAGE
  STORE STORED STREAM STRING STRUCT STYLE SUB SUBMULTISET
  SUBPARTITION SUBSTRING SUBTYPE SUM SUPER SYMMETRIC SYNONYM SYSTEM
  TABLE TABLESAMPLE TEMP TEMPORARY TERMINATED TEXT THAN THEN
  THROUGHPUT TIME TIMESTAMP TIMEZONE TINYINT TO TOKEN TOTAL
  TOUCH TRAILING TRANSACTION TRANSFORM TRANSLATE TRANSLATION TREAT TRIGGER
  TRIM TRUE TRUNCATE TTL TUPLE TYPE UNDER UNDO
  UNION UNIQUE UNIT UNKNOWN UNLOGGED UNNEST UNPROCESSED UNSIGNED
  UNTIL UPDATE UPPER URL USAGE USE USER USERS
  USING UUID VACUUM VALUE VALUED VALUES VARCHAR VARIABLE
  VARIANCE VARINT VARYING VIEW VIEWS VIRTUAL VOID WAIT
  WHEN WHENEVER WHERE WHILE WINDOW WITH WITHIN WITHOUT
  WORK WRAPPED WRITE YEAR ZONE
`

/** The list above, uppercased and indexed. AWS says the match is case-insensitive. */
export const RESERVED_WORDS: ReadonlySet<string> = new Set(RESERVED_WORD_LIST.trim().split(/\s+/))

/**
 * The five request fields whose value DynamoDB parses as an expression.
 *
 * These and no others. `ExpressionAttributeNames` and `ExpressionAttributeValues`
 * are maps, not expressions -- and their VALUES are allowed to be reserved words,
 * which is the whole point of them: `ExpressionAttributeNames: { '#at': 'at' }`
 * is the fix, not a second instance of the bug.
 */
export const EXPRESSION_KINDS = [
  'ConditionExpression',
  'FilterExpression',
  'KeyConditionExpression',
  'ProjectionExpression',
  'UpdateExpression',
] as const

export type ExpressionKind = (typeof EXPRESSION_KINDS)[number]

const KIND_SET: ReadonlySet<string> = new Set(EXPRESSION_KINDS)

/**
 * Which bare words are SYNTAX rather than attribute names, per expression kind.
 *
 * KEYED ON THE KIND BECAUSE DYNAMODB'S GRAMMAR IS, and treating one flat list of
 * keywords as syntax everywhere is how a check starts lying. `SET` is a clause
 * keyword in an UpdateExpression and is a plain (reserved) attribute name
 * anywhere else; `AND` is an operator in a condition and is not legal at all in
 * a projection, which is a comma-separated list of paths and nothing else. Kind
 * by kind:
 *
 *   ProjectionExpression   -- no keywords. Every word in it is an attribute name.
 *   UpdateExpression       -- the four clause keywords. No boolean operators exist.
 *   KeyConditionExpression -- AND and BETWEEN. `OR`, `NOT` and `IN` are not legal
 *                             in a key condition, so a word `or` appearing in one
 *                             is an attribute name (and a reserved one).
 *   Condition / Filter     -- the full boolean set.
 *
 * THE FALSE NEGATIVE, NAMED. An attribute genuinely called `set` used bare in an
 * UpdateExpression is missed, because this cannot tell it from the clause keyword
 * without implementing the grammar's clause positions. That word is reserved, so
 * the miss is real -- it is accepted because the alternative is a positional guess
 * that would eventually flag a correct `SET` and get the whole check deleted.
 * Every other reserved word in that same expression is still caught.
 *
 * Matched case-insensitively: DynamoDB accepts `set`/`Set`/`SET` alike.
 */
const SYNTAX_KEYWORDS: Readonly<Record<ExpressionKind, ReadonlySet<string>>> = {
  ConditionExpression: new Set(['AND', 'OR', 'NOT', 'BETWEEN', 'IN']),
  FilterExpression: new Set(['AND', 'OR', 'NOT', 'BETWEEN', 'IN']),
  KeyConditionExpression: new Set(['AND', 'BETWEEN']),
  ProjectionExpression: new Set<string>(),
  UpdateExpression: new Set(['SET', 'REMOVE', 'ADD', 'DELETE']),
}

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/
const DIGIT = /[0-9]/
const SPACE = /\s/

/**
 * Every BARE attribute name in one expression string, in order, or `null` when
 * the string is not a DynamoDB expression at all.
 *
 * "Bare" means DynamoDB will read the word as an attribute name and apply the
 * reserved word rule to it. Four things are therefore NOT bare names, and each
 * one is a false positive this check would otherwise raise on correct code:
 *
 *   `#name`  -- an expression attribute name. This is the FIX for a reserved
 *               word, so flagging it would flag exactly the corrected code.
 *   `:value` -- an expression attribute value. Never an attribute name; the
 *               substitution happens on the other side of the `=`.
 *   `f(...)` -- a function name. DynamoDB's are attribute_exists,
 *               attribute_not_exists, attribute_type, begins_with, contains,
 *               size, if_not_exists and list_append, and three of those
 *               (`size`, `contains`, `add` via ADD) are themselves reserved
 *               words, so `size(a) > :n` would report a reserved word in
 *               correct code. Detected by the `(` that must follow, which no
 *               attribute name can be followed by.
 *   keywords -- see SYNTAX_KEYWORDS above.
 *
 * DOCUMENT PATHS ARE SPLIT AND EVERY ELEMENT IS CHECKED, because DynamoDB
 * applies the rule per element: `a.at` is refused for `at` even though `a` is
 * fine, and `#a.at` is refused too -- aliasing the first element does not
 * protect the second.
 *
 * RETURNS null RATHER THAN GUESSING on a string it cannot tokenise. That is the
 * safety valve: this function is also pointed at assertion arguments (see
 * findExpressionStrings), where a string might be a message rather than an
 * expression, and a checker that treats English prose as attribute names finds
 * `WRITE`, `KEY` and `ORDER` in a sentence and cries wolf.
 */
export function bareNamesIn(kind: ExpressionKind, expression: string): string[] | null {
  const keywords = SYNTAX_KEYWORDS[kind]
  const names: string[] = []
  let i = 0

  while (i < expression.length) {
    const c = expression.charAt(i)

    if (SPACE.test(c)) {
      i += 1
      continue
    }

    // `#foo` and `:foo`. A lone sigil is not valid DynamoDB, so the string is
    // not an expression.
    if (c === '#' || c === ':') {
      let j = i + 1
      while (j < expression.length && NAME_CHAR.test(expression.charAt(j))) j += 1
      if (j === i + 1) return null
      i = j
      continue
    }

    if (NAME_START.test(c)) {
      const start = i
      let j = i
      while (j < expression.length && NAME_CHAR.test(expression.charAt(j))) j += 1
      const word = expression.slice(start, j)

      // Look past whitespace for a `(`: an attribute name can never be followed
      // by one, so a word that is means a function call.
      let k = j
      while (k < expression.length && SPACE.test(expression.charAt(k))) k += 1
      i = j

      if (k < expression.length && expression.charAt(k) === '(') continue
      if (keywords.has(word.toUpperCase())) continue

      names.push(word)
      continue
    }

    // A list index: `a[0]`. The digits inside are not a name.
    if (c === '[') {
      let j = i + 1
      while (j < expression.length && DIGIT.test(expression.charAt(j))) j += 1
      if (j === i + 1 || expression.charAt(j) !== ']') return null
      i = j + 1
      continue
    }

    // `<>`, `<=`, `>=` before the single-character `<` and `>`.
    if (c === '<' || c === '>') {
      const next = expression.charAt(i + 1)
      i += next === '=' || (c === '<' && next === '>') ? 2 : 1
      continue
    }

    // The rest of the punctuation an expression may contain. `.` separates path
    // elements, `+` and `-` are the UpdateExpression arithmetic.
    if ('().,=+-'.includes(c)) {
      i += 1
      continue
    }

    // Anything else -- a quote, a slash, an apostrophe, a `!` -- cannot appear
    // in a DynamoDB expression, so this string is something else.
    return null
  }

  return names
}

/**
 * The reserved words among the bare names, de-duplicated, or `null` when the
 * string is not an expression.
 */
export function reservedWordsIn(kind: ExpressionKind, expression: string): string[] | null {
  const names = bareNamesIn(kind, expression)
  if (names === null) return null

  const hits: string[] = []
  for (const name of names) {
    if (RESERVED_WORDS.has(name.toUpperCase()) && !hits.includes(name)) hits.push(name)
  }
  return hits
}

/**
 * Where an expression string was found, and how.
 *
 * `shape` matters to the caller: a `property` with no static text is a real gap
 * worth mentioning, and an `assertion` argument that is not an expression is
 * just another argument. See checkSource.
 */
export type FoundExpression = {
  kind: ExpressionKind
  /** The string, or null when it is not a static string this can read. */
  text: string | null
  /** 1-based, for an editor and for a CI log. */
  line: number
  shape: 'property' | 'assertion'
}

/**
 * A string literal's value, following the two shapes that still count as a
 * literal: parentheses, and `+` concatenation of literals. Anything computed --
 * a call, a variable, a template with a substitution -- returns null, because
 * guessing at its value is how a static check starts being wrong.
 */
function staticText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left)
    const right = staticText(node.right)
    return left === null || right === null ? null : left + right
  }
  return null
}

function propertyKeyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

/**
 * The expression kind READ somewhere inside a subtree, if any -- `put.ConditionExpression`
 * or `input['UpdateExpression']`. Used to recognise assertions; see below.
 */
function kindReadIn(node: ts.Node): ExpressionKind | null {
  const found: ExpressionKind[] = []

  const visit = (n: ts.Node): void => {
    if (found.length > 0) return
    if (ts.isPropertyAccessExpression(n) && KIND_SET.has(n.name.text)) {
      found.push(n.name.text as ExpressionKind)
      return
    }
    if (ts.isElementAccessExpression(n)) {
      const arg = n.argumentExpression
      if (ts.isStringLiteral(arg) && KIND_SET.has(arg.text)) {
        found.push(arg.text as ExpressionKind)
        return
      }
    }
    ts.forEachChild(n, visit)
  }

  visit(node)
  return found[0] ?? null
}

/**
 * Every expression string in one TypeScript file.
 *
 * PARSED WITH TYPESCRIPT'S OWN PARSER RATHER THAN MATCHED WITH A REGEX. A regex
 * for `ConditionExpression:\s*'(.*)'` gets the value wrong on a string that wraps
 * to the next line (src/ddb.ts has one), gets it wrong again on a concatenation,
 * and reports the union member in `Pick<PutCommandInput, 'ConditionExpression' |
 * ...>` -- also in src/ddb.ts -- as an expression whose text is the word
 * `ConditionExpression`. The compiler is already a devDependency; the exact
 * answer is free.
 *
 * TWO SHAPES, AND THE SECOND ONE IS THE POINT.
 *
 *   property   `ConditionExpression: '#at = :seenAt'` -- what the request is
 *              built from. Catching this catches the bug being written.
 *
 *   assertion  `expect(put.ConditionExpression).toBe('#at = :seenAt')` -- what a
 *              test says the request should contain. Catching this catches the
 *              bug being PINNED, which is what actually happened: the shipped
 *              test asserted `'at = :seenAt'` verbatim and went green. Without
 *              this shape the check would pass a repo whose test suite still
 *              demands the broken string, and the next correct fix would look
 *              like a test failure.
 *
 * THE ASSERTION RULE IS NARROW ON PURPOSE: a string counts only when it is an
 * ARGUMENT to a call whose CALLEE reads one of the five properties. In
 * `expect(x.ConditionExpression).toBe(s)` the callee is `expect(x.ConditionExpression).toBe`
 * and `s` counts. In `expect(x.ConditionExpression, 'a human message').toBe(s)`
 * the message is an argument to `expect`, whose callee is the bare identifier
 * `expect`, so the prose is never read as an expression.
 */
export function findExpressionStrings(fileName: string, source: string): FoundExpression[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const out: FoundExpression[] = []
  const seen = new Set<number>()

  const add = (kind: ExpressionKind, node: ts.Node, text: string | null, shape: FoundExpression['shape']): void => {
    const pos = node.getStart(sourceFile)
    if (seen.has(pos)) return
    seen.add(pos)
    out.push({ kind, text, shape, line: sourceFile.getLineAndCharacterOfPosition(pos).line + 1 })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyKeyName(node.name)
      if (name !== null && KIND_SET.has(name)) {
        add(name as ExpressionKind, node.initializer, staticText(node.initializer), 'property')
      }
    } else if (ts.isShorthandPropertyAssignment(node) && KIND_SET.has(node.name.text)) {
      // `{ ConditionExpression }` -- the value is a variable, so there is nothing
      // to read. Reported as unchecked rather than ignored.
      add(node.name.text as ExpressionKind, node, null, 'property')
    } else if (ts.isCallExpression(node)) {
      const kind = kindReadIn(node.expression)
      if (kind !== null) {
        for (const arg of node.arguments) {
          const text = staticText(arg)
          if (text !== null) add(kind, arg, text, 'assertion')
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return out
}

/** A bare reserved word, ready to print. */
export type Violation = {
  file: string
  line: number
  kind: ExpressionKind
  word: string
  expression: string
}

/** An expression this could not read. Printed, but does not fail the check. */
export type Notice = {
  file: string
  line: number
  kind: ExpressionKind
  reason: string
}

export type Report = {
  violations: Violation[]
  notices: Notice[]
  /** How many expression strings were actually read. Zero means something broke. */
  checked: number
  files: number
}

export function checkSource(file: string, source: string): Omit<Report, 'files'> {
  const violations: Violation[] = []
  const notices: Notice[] = []
  let checked = 0

  for (const found of findExpressionStrings(file, source)) {
    if (found.text === null) {
      // Only worth saying for a property: THAT is a request field whose value is
      // an expression nobody can read here. An assertion argument that is not a
      // string is just an argument.
      if (found.shape === 'property') {
        notices.push({
          file,
          line: found.line,
          kind: found.kind,
          reason: 'value is not a literal string, so it was not checked',
        })
      }
      continue
    }

    const hits = reservedWordsIn(found.kind, found.text)

    if (hits === null) {
      // Same split: a property whose string does not tokenise is a real gap; an
      // assertion argument that does not tokenise was probably never an
      // expression, and saying so on every run is the noise that gets a check
      // switched off.
      if (found.shape === 'property') {
        notices.push({
          file,
          line: found.line,
          kind: found.kind,
          reason: 'does not read as a DynamoDB expression, so it was not checked',
        })
      }
      continue
    }

    checked += 1
    for (const word of hits) {
      violations.push({ file, line: found.line, kind: found.kind, word, expression: found.text })
    }
  }

  return { violations, notices, checked }
}

/** Every `.ts` file under a directory, sorted, so output is the same run to run. */
export function typeScriptFilesIn(root: string): string[] {
  const out: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
    }
  }

  walk(root)
  return out
}

/**
 * The whole tree.
 *
 * TEST FILES ARE INCLUDED, and that is not an oversight. The reserved-word bug
 * had a passing test asserting the broken string; skipping `*.test.ts` would
 * leave that fossil in place and let the check call the repo clean while the
 * suite still demanded the bug. If a test one day needs a deliberately broken
 * expression to prove error handling, hand it to the fake through a variable --
 * a non-literal is reported as unchecked, not as a violation.
 */
export function checkFiles(root: string, reportRelativeTo: string): Report {
  const violations: Violation[] = []
  const notices: Notice[] = []
  let checked = 0
  let files = 0

  for (const file of typeScriptFilesIn(root)) {
    const shown = relative(reportRelativeTo, file).split('\\').join('/')
    const result = checkSource(shown, readFileSync(file, 'utf8'))
    violations.push(...result.violations)
    notices.push(...result.notices)
    checked += result.checked
    files += 1
  }

  return { violations, notices, checked, files }
}

export function formatViolation(v: Violation): string {
  return [
    `  ${v.file}:${v.line}  ${v.kind}`,
    `    reserved word \`${v.word}\` is named directly`,
    `    ${v.expression}`,
  ].join('\n')
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const repo = resolve(here, '..')
  const root = join(repo, 'src')

  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`ddb-expressions: ${root} is not a directory\n`)
    process.exitCode = 1
    return
  }

  const report = checkFiles(root, repo)

  for (const notice of report.notices) {
    process.stdout.write(`ddb-expressions: ${notice.file}:${notice.line} ${notice.kind} ${notice.reason}\n`)
  }

  if (report.violations.length > 0) {
    const lines = [
      '',
      'ddb-expressions: a DynamoDB reserved word is used bare in an expression.',
      'DynamoDB refuses the whole request with "Invalid <kind>: Attribute name is a',
      'reserved keyword", at run time, on the box. No test can catch this: the fake',
      'accepts whatever string it is handed.',
      '',
      ...report.violations.map(formatViolation),
      '',
      'Fix each one with an expression attribute name -- for `at`:',
      "  ConditionExpression: '#at = :seenAt'",
      "  ExpressionAttributeNames: { '#at': 'at' }",
      'The full list of 573 reserved words is in scripts/check-ddb-expressions.ts.',
      '',
    ]
    process.stderr.write(lines.join('\n'))
    process.exitCode = 1
    return
  }

  // A check that finds nothing to check has broken silently -- a moved file, a
  // renamed property, a parser that stopped parsing -- and would report a clean
  // repo forever. There are expression strings in src/; if there are none, that
  // is the finding.
  if (report.checked === 0) {
    process.stderr.write(
      'ddb-expressions: read 0 expression strings across ' +
        `${String(report.files)} files in src/. There are some, so this check is broken.\n`,
    )
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `ddb-expressions: ${String(report.checked)} expression strings in ${String(report.files)} files, ` +
      'no reserved word named bare\n',
  )
}

// Run only when invoked as a script. Imported by its test, which must not exit
// the process.
const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) main()

/*
 * ----------------------------------------------------------------------------
 * THE CHECK THAT IS NOT HERE: KEY NAMES AGAINST THE DOCUMENTED SCHEMA.
 *
 * The other bug of the same day was `Key: { key }` against `ringmaster-bot-state`,
 * whose partition key is `id`. Every read and write to that table came back "The
 * provided key element does not match the schema" and three features went dark at
 * once. It was attempted here and is deliberately not shipped. The reason is not
 * that the parsing is hard -- it is that the source of truth is wrong.
 *
 * The documented schema lives in two markdown tables: this repo's
 * docs/aws-notes.md ("Tables") and the console's docs/aws-setup.md (§1). A
 * working prototype was built and pointed at all eight `Key: { ... }` sites in
 * src/ddb.ts. It found two things, and both of them are reasons not to ship it.
 *
 * ONE: THE DOC IS THE THING THAT IS WRONG. docs/aws-notes.md still says
 * `ringmaster-bot-state` has key `key` (S), and still prints an
 * `aws dynamodb create-table` command with `AttributeName=key,KeyType=HASH`.
 * The real table has `id`; src/ddb.ts was corrected in cd23b1a and the doc was
 * not. So seven sites agree and the eighth is reported as a mismatch against
 * CORRECT CODE. A check that goes red on the one line that is right, on a repo
 * that is otherwise green, teaches exactly one lesson: the way to fix it is to
 * put the outage back. Anybody standing a second environment up from that doc
 * reproduces the original bug at the `create-table` step, which is the real
 * problem here and is a doc fix, not a check.
 *
 * TWO: PARSING PROSE FOR A SCHEMA PRODUCES CONFIDENT NONSENSE. The prototype
 * read docs/aws-setup.md and came back with `ringmaster-bans` keyed on
 * `GetItem` -- because that file has a SECOND markdown table further down whose
 * first column is also a table name (`| ringmaster-bans | GetItem | the connect
 * gate |`), and the last row seen wins. Some of what it extracted was right
 * (`ringmaster-sessions` = pk+sk) and some was garbage, which is the worst
 * possible mixture: it looks like it works. Tightening the parser to that one
 * heading is a check that silently stops checking the day somebody edits a
 * heading.
 *
 * WHAT WOULD MAKE IT POSSIBLE, in order of how much it is worth:
 *
 *   1. Fix docs/aws-notes.md, and add `ringmaster-bot-state` to the console's
 *      docs/aws-setup.md table, which does not list it at all. Until the prose
 *      is right nothing built on it can be.
 *   2. Move the schema out of prose and into src/ddb.ts, beside `tableNames()`,
 *      as a `TABLE_KEYS` record: `{ botState: ['id'], audit: ['pk', 'ts'], ... }`.
 *      Then a check reads a declaration instead of a markdown table, `Key: { ... }`
 *      is compared against it, and the DOC becomes the thing that gets checked
 *      against the code rather than the other way round. That also removes the
 *      second fragile step this needs today: resolving `TableName: tables.botState`
 *      back to `ringmaster-bot-state` through the template literals in
 *      `tableNames()`.
 *   3. Even then it is partial, and honestly: a `Key: { ... }` object literal can
 *      be read, but `doc.put({ Item: row })` cannot -- `row` is a variable, and a
 *      put names its key attributes inside the item. Half the bug's blast radius
 *      is invisible to any static check of this shape. Typing the row against the
 *      key declaration is what closes that, and that is a change to src/ddb.ts.
 * ----------------------------------------------------------------------------
 */
