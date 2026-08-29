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

step 'npm run typecheck' npm run typecheck
step 'npm run lint' npm run lint
step 'npm test' npm test

printf '\nverify: typecheck, lint and test all passed\n'
