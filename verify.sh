#!/bin/sh
#
# The one command that says whether this repo is OK: typecheck, then lint, then
# test, stopping at the first thing that fails.
#
# ONE ENTRY POINT, AND CI RUNS THIS EXACT FILE. The alternative — a workflow
# that lists the three npm scripts itself — works right up until a fourth check
# is added here and not there, and from then on CI is greener than the repo and
# nothing says so. Adding a check means editing this file and nothing else.
#
# THE ORDER IS NOT ARBITRARY. A `tsc` failure means the source does not
# describe a valid program, and lint output or a test run over a program that
# does not compile is noise wrapped around the same fault: one missing import
# reports as twenty failing tests. The first thing that breaks is the thing to
# fix, so nothing after it runs.
#
# NOT `npm run typecheck && npm run lint && npm test`. Same three commands, same
# order, and it was rejected for one reason: when it fails you get npm's own
# output and no statement of WHICH step failed — thirty seconds of scrolling a
# CI log for something the script already knew. The banner exists to be the
# first thing you see.
#
# NO ARGUMENTS, DELIBERATELY. A `--skip-tests` flag is a flag somebody reaches
# for at 1am, and after that CI and the humans are running different checks with
# nothing to show it. Run the npm scripts directly if you want a subset.
#
# POSIX sh rather than bash: nothing here needs an array, `[[` or `pipefail`,
# and `/bin/sh` is the one interpreter present on the CI runner, on the EC2 box
# and in Git Bash on a Windows laptop alike.

set -u

# Run from the repo root whatever directory the caller is standing in. `npm`
# finds package.json by walking UP from the current directory, so
# `~/blitz-bot/verify.sh` invoked from `~` does not fail cleanly: it either
# finds no package.json at all, or — if the caller happens to be inside some
# other project — runs THAT project's scripts and returns a verdict on the
# wrong repository.
#
# `CDPATH=` because a `cd` with CDPATH set in the environment can land
# somewhere else entirely and print where it went, which is the kind of fault
# that reproduces on exactly one person's machine.
here=$(dirname -- "$0")
CDPATH= cd -- "$here" || {
  printf 'verify: cannot enter %s\n' "$here" >&2
  exit 1
}

# Loud, and loud in plain ASCII rather than colour. This output is read in a
# GitHub Actions log and over SSH at least as often as in a terminal, and
# escape codes in a piped log are noise around the message instead of emphasis
# on it. The step is named verbatim so it can be grepped for.
fail() {
  printf '\n' >&2
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' >&2
  printf '!! VERIFY FAILED: %s\n' "$1" >&2
  printf '!! exit status %s -- the steps after it did not run\n' "$2" >&2
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' >&2
  # The failing command's own status rather than a flat 1, so a tool that
  # crashed stays distinguishable from a check that ran and found problems.
  exit "$2"
}

step() {
  label=$1
  shift
  printf '\n== %s ==\n' "$label"
  "$@" || fail "$label" $?
}

# The files in deploy/ are not TypeScript and nothing above looks at them: two
# POSIX shell scripts and three systemd units, which land on the box as
# /usr/local/bin/blitz-bot-update and /etc/systemd/system/*. Until they were
# extracted out of docs/deploy.md they were text inside a markdown fence, so the
# first parse of the updater happened when a unit ran it at 3am and the first
# parse of a unit happened at `systemctl start`. Both are cheap here.
#
# WHAT THIS IS NOT. It does not run either script and it does not install
# anything: `sh -n` parses without executing, and `systemd-analyze verify` reads
# unit files. Nothing in this step touches /etc, /usr/local or systemd's state,
# which is what makes it safe on a laptop.
deploy() {
  status=0

  # `sh -n` AND NOT `bash -n`, because both files say `#!/bin/sh` and the
  # parser that matters is the one that will actually run them. On the CI runner
  # /bin/sh is dash, so this rejects a bashism -- an array, a `[[`, a `local` --
  # that `bash -n` would accept here and that /bin/sh on the box would then
  # refuse at the worst moment. In Git Bash `sh` is bash in POSIX mode and
  # catches less; CI is where this one earns its keep.
  for script in deploy/blitz-bot-update deploy/install.sh; do
    sh -n "$script" || {
      printf 'deploy: %s does not parse as POSIX sh\n' "$script" >&2
      status=1
    }
  done

  # `systemd-analyze verify` reads a unit the way systemd will: a misspelled
  # directive, a section that is not a section, a value it cannot parse. None of
  # that is visible to any other check in this repo, and all of it is a unit
  # that fails at `systemctl start` on a box nobody is watching.
  #
  # SKIPPED LOUDLY WHERE IT IS NOT INSTALLED. CI is ubuntu-latest and has it; a
  # Windows laptop does not. A check that could not run has to say so, or a skip
  # reads as a tick and the repo believes for a year that something is verified.
  #
  # ITS OUTPUT IS THE VERDICT AND ITS EXIT STATUS IS NOT, which is forced rather
  # than chosen. It also checks that every path a unit names exists and is
  # executable, and here none of them do: /opt/node24/bin/node and
  # /usr/local/bin/blitz-bot-update are on the box and nowhere else, so it exits
  # non-zero on every machine this file runs on. Complaints about a missing path
  # are therefore dropped -- that class and no other -- and anything else it
  # prints fails this step. deploy/install.sh runs the same command ON the box,
  # after putting those paths there, and uses its status as it comes.
  if command -v systemd-analyze > /dev/null 2>&1; then
    complaints=$(
      systemd-analyze verify \
        deploy/blitz-bot.service \
        deploy/blitz-bot-update.service \
        deploy/blitz-bot-update.timer 2>&1 |
        grep -v 'No such file or directory'
    )

    if [ -n "$complaints" ]; then
      printf '%s\n' "$complaints" >&2
      printf 'deploy: systemd-analyze rejected a unit file, above\n' >&2
      status=1
    else
      printf 'deploy: systemd-analyze accepts the three unit files\n'
    fi
  else
    printf 'deploy: no systemd-analyze here, so the three unit files were NOT checked\n'
    printf 'deploy: CI runs on ubuntu-latest, where it exists, and does check them\n'
  fi

  return "$status"
}

# Every DynamoDB expression string in src/, read against DynamoDB's own list of
# 573 reserved words, failing on any attribute name that is not behind a `#`
# placeholder.
#
# WHY IT IS A STEP HERE AND NOT A TEST. Two DynamoDB bugs reached production on
# 2026-08-30 and neither could have been caught by `npm test`, because of what
# the test suite is: every test injects a fake client, and a fake accepts
# whatever string the code hands it. The fake and the code agree with each other
# and both disagree with DynamoDB. One of the two even had a passing test that
# asserted the broken string verbatim, so the suite was green AND held the bug in
# place. The missing rule comes from outside the program -- AWS's reserved word
# list -- applied to the source text, which is a static check and not a test.
#
# WHAT THIS IS NOT. It makes no AWS call, needs no credentials, and reads only
# files. It is not a substitute for the schema check that would have caught the
# OTHER bug that day; the foot of scripts/check-ddb-expressions.ts says why that
# one is not shippable and what would make it possible.
ddb_expressions() {
  # It parses src/ with TypeScript's own parser rather than matching a regex,
  # which means it needs the compiler -- already a devDependency, and free.
  #
  # SKIPPED LOUDLY WHERE IT IS NOT INSTALLED, the same as systemd-analyze below
  # and for the same reason: a check that could not run has to say so, or the
  # skip reads as a tick. `npm ci` installs it on a laptop and on CI; only a
  # production install (`npm ci --omit=dev`) omits it, and nothing runs this file
  # there.
  if [ ! -d node_modules/typescript ]; then
    printf 'ddb-expressions: no node_modules/typescript here, so expression strings were NOT checked\n'
    printf 'ddb-expressions: `npm ci` installs it, and CI runs that, so CI does check them\n'
    return 0
  fi

  node scripts/check-ddb-expressions.ts
}

# Every user-facing string in src/ that nobody has the owner's words for, listed
# with who reads it, what it has to say, and what ships in its place today.
#
# WHY IT IS A STEP AND NOT A TEST. The owner has been finding out which replies
# are unfinished by running the bot and reading them in his own Discord, weeks
# after each was written: "What other surprise PLACEHOLDER text exists? I was
# never made aware of these and finding them on the fly is terrible." No test can
# tell him that, because there is nothing failing -- unwritten copy is a normal
# state in this repo, supplied in batches over days. What was missing was a place
# where the whole list is stated, to everybody, on every run. That is a report
# over the source text, which is a step.
#
# IT REPORTS AND DOES NOT FAIL ON THE LIST, DELIBERATELY. A check that went red
# on unwritten copy would be red for weeks at a time, and a permanently red check
# is one everybody learns to run past -- at which point the next real failure is
# invisible too.
#
# WHAT IT DOES FAIL ON is a marker inside a string that SHIPS, which is the bug
# that actually reached him: a real admin ran /drain and read `PLACEHOLDER: no
# wording supplied yet for a window that was scheduled.` The marker belongs in
# the doc comment above the string, and that rule has a definite answer, so it is
# enforced. A marker that does not parse fails too -- a marker with no audience
# or no note is a string that thinks it is on the list and is not.
copy_inventory() {
  # Same guard as ddb_expressions above and for the same reason: it parses src/
  # with TypeScript's own parser, `npm ci` installs it here and on CI, and a
  # check that could not run has to say so rather than read as a tick.
  if [ ! -d node_modules/typescript ]; then
    printf 'copy: no node_modules/typescript here, so the copy inventory was NOT printed\n'
    printf 'copy: `npm ci` installs it, and CI runs that, so CI does print it\n'
    return 0
  fi

  node scripts/check-placeholders.ts
}

step 'npm run typecheck' npm run typecheck
step 'npm run lint' npm run lint
step 'npm test' npm test

# AFTER THE THREE ABOVE, BECAUSE IT READS THE SOURCE AS A PROGRAM. It hands src/
# to the TypeScript parser, so a file that does not parse gives it nothing useful
# to say -- exactly the relationship `tsc` has with lint and test, and the reason
# the same ordering applies. Before deploy/ because that one has to stay last;
# see below.
step 'src/ -- DynamoDB expression strings' ddb_expressions

# LAST, AND THE ORDER ABOVE IT IS THE REASON. Those three are ordered against
# each other because a `tsc` failure makes the next two into noise. This one has
# no such relationship with any of them -- it reads shell and ini files, not the
# TypeScript program -- so it goes where it cannot displace a compile error as
# the first thing reported. It, and the expression check above it, are the only
# steps that can half-run, and a "NOT checked" line belongs at the end as a note
# rather than at the top as a headline.
step 'deploy/ -- shell syntax and unit files' deploy

# LAST OF ALL, AND THAT IS THE WHOLE PLACEMENT DECISION. It is not ordered
# against anything: it reads the same source the expression check reads and has
# no relationship with lint, the tests or the unit files. What it produces is a
# LIST somebody is meant to read rather than a verdict, and the last thing
# printed is the thing that gets read. Put in front of the tests it would be a
# wall of text between you and the failure you were looking for, which is how a
# report earns the scrolling past that makes it useless.
step 'src/ -- copy awaiting wording' copy_inventory

printf '\nverify: typecheck, lint, test, DynamoDB expressions, deploy/ and the copy inventory all passed\n'
