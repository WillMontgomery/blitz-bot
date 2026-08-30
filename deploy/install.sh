#!/bin/sh
#
# Put the four files next to this one onto the box: the update script into
# /usr/local/bin, the three units into /etc/systemd/system. Then check them and
# tell systemd they are there.
#
# WHY THIS FILE EXISTS. The four files used to live inside `sudo tee <<'EOF'`
# blocks in docs/deploy.md, and installing them meant pasting nearly four
# hundred lines into an SSH session. That is not a slow install, it is an
# unreviewable one: a script that exists only inside a markdown fence cannot be
# run through `sh -n`, cannot be diffed against what is on the box, and a paste
# that dropped a line produced a file with nothing to compare it against. The
# four files are in the repository now, `bash verify.sh` checks them on every
# push, and this installs exactly what is in the checkout.
#
# IT INSTALLS AND IT DOES NOT START. There is no `systemctl enable` and no
# `systemctl start` in this file, deliberately. Copying files onto a disk is
# reversible and dull; starting a bot that is about to delete messages in a live
# guild is neither, and the two do not belong in one command. §7 of
# docs/deploy.md starts them one at a time and reads the journal after each.
#
# SAFE TO RUN TWICE, AND IT SAYS WHICH OF THE TWO IT WAS. Every file is
# compared against what is already installed, so a second run reports
# `unchanged` four times and copies nothing. That makes it an answer to "is the
# box actually on this commit's units?" as well as an installer -- which is a
# question nobody could ask at all while the units existed only in a document.
#
# POSIX sh, like verify.sh and like the script it installs. Nothing here needs
# an array, `[[` or `pipefail`, and /bin/sh is the one interpreter present on
# the box, on the CI runner and in Git Bash on the laptop this is edited from.

set -u

BIN=/usr/local/bin
SYSTEMD=/etc/systemd/system

# §3 of docs/deploy.md clones the repository here, §6.4's WorkingDirectory names
# it, and the update script's own REPO= names it. Its presence is what this
# script uses to answer "am I on the box".
REPO=/opt/blitz-bot

fail() {
  printf '\ninstall: %s\n' "$1" >&2
  exit 1
}

# Where the files are, rather than where the caller was standing when they typed
# the command. `sudo sh /opt/blitz-bot/deploy/install.sh` run from a home
# directory has to work, because that is how §6 tells the operator to run it.
#
# CDPATH= for the reason verify.sh gives: a `cd` with CDPATH set in the
# environment can land somewhere else entirely and print where it went, which is
# the kind of fault that reproduces on exactly one person's machine.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ||
  fail 'cannot work out which directory this script is in'

# ---- the two refusals, both of them before anything is written -------------

# NOT THE BOX. Everything below writes into /usr/local/bin and
# /etc/systemd/system, and on a laptop that is four root-owned files scattered
# outside any checkout, which nothing will ever clean up and which `git status`
# will never mention. The check is for the clone rather than for a hostname or a
# distribution, because the clone is what these files actually depend on:
# WorkingDirectory=, EnvironmentFile= and the update's REPO= all name it, so a
# machine without it could not run these units even if they were installed.
[ -d "$REPO" ] || fail "no $REPO on this machine.
  These files install into $BIN and $SYSTEMD, which is only useful on the box
  that runs the bot. §3 of docs/deploy.md is what creates $REPO. If you meant to
  read the files rather than install them, all four are in $here."

# REQUIRED UNDER sudo RATHER THAN RE-EXECUTING ITSELF UNDER IT, and the reason
# is what the two failures look like. Re-exec'ing means this script decides on
# its own to become root, by handing `sudo` a path it worked out itself and an
# interpreter it picked -- so a password prompt appears from a command the
# operator did not type `sudo` in front of, and what runs as root is chosen by
# the file rather than by him. Refusing costs one retype, and the message below
# is the line to retype, spelled out in full, so there is nothing to work out.
[ "$(id -u)" = '0' ] || fail "not root, so nothing was installed.
  This writes to $BIN and $SYSTEMD, which are root's. Run:

      sudo sh $here/install.sh"

printf 'install: from %s\n\n' "$here"

# ---- one file --------------------------------------------------------------

# `install` rather than `cp` followed by a `chmod`: it writes the file with its
# ownership and mode already set, so there is no window in which
# /usr/local/bin/blitz-bot-update is on the box and not executable. That is the
# state the update unit fails in, with a permission error naming neither the
# mode nor this script.
place() {
  src="$here/$1"
  dest=$2
  mode=$3

  [ -f "$src" ] || fail "missing $src -- this is not a complete checkout"

  if [ ! -e "$dest" ]; then
    verb=installed
  elif cmp -s "$src" "$dest"; then
    verb=unchanged
  else
    verb=updated
  fi

  if [ "$verb" = unchanged ]; then
    # The bytes are right and the bits still might not be -- a file somebody
    # copied by hand, or edited in place, can match and be mode 644. Repairing
    # that silently is correct, because it is not a change to WHAT is installed,
    # but it has to happen: otherwise "unchanged" gets reported over a script
    # the unit cannot execute.
    chmod "$mode" -- "$dest" || fail "cannot set mode $mode on $dest"
    chown root:root -- "$dest" || fail "cannot set ownership of $dest"
  else
    install -o root -g root -m "$mode" -- "$src" "$dest" || fail "cannot write $dest"
  fi

  printf '  %-9s  %s\n' "$verb" "$dest"
}

# THE SCRIPT BEFORE THE UNITS THAT NAME IT. The other order leaves a window --
# short, but real on a box whose timer is already running -- in which
# blitz-bot-update.service exists and the file its ExecStart names does not. It
# is also what makes the check below mean anything: `systemd-analyze verify`
# tests the ExecStart path as well as the file, and it can only do that once the
# target is there.
place blitz-bot-update "$BIN/blitz-bot-update" 755

# 644, not 755. A unit file is read by systemd and never executed, and a unit
# marked executable is one of the things `systemd-analyze` complains about.
place blitz-bot.service "$SYSTEMD/blitz-bot.service" 644
place blitz-bot-update.service "$SYSTEMD/blitz-bot-update.service" 644
place blitz-bot-update.timer "$SYSTEMD/blitz-bot-update.timer" 644

# ---- what was installed, checked where it was installed --------------------

# CHECKED HERE AND NOT ONLY IN CI. CI checks the files in the repository; this
# checks the files on the box, which is also a check on the copy itself and on
# the two paths CI cannot see -- /opt/node24/bin/node and
# /usr/local/bin/blitz-bot-update, both of which systemd-analyze tests for
# existence and for being executable.
#
# SO ITS OUTPUT HERE IS EMPTY AND ITS EXIT STATUS IS USED AS IT COMES. Off the
# box it complains that those two paths are missing, which is why verify.sh has
# to read its output rather than its status; by this line both of them are on
# the disk, so anything at all from it is a real problem.
command -v systemd-analyze > /dev/null 2>&1 ||
  fail "no systemd-analyze on this machine, so the units went in unchecked.
  That is systemd itself missing, on a box meant to run systemd units. Remove
  the three files from $SYSTEMD before going any further."

printf '\n'
systemd-analyze verify \
  "$SYSTEMD/blitz-bot.service" \
  "$SYSTEMD/blitz-bot-update.service" \
  "$SYSTEMD/blitz-bot-update.timer" ||
  fail "systemd-analyze rejected what was just installed, above.
  The files are on the box and nothing has been enabled or started, so the fix
  is: correct the file in $here, then run this script again."

printf '  %-9s  all three unit files parse, and their ExecStart paths exist\n' verified

# Units on a disk are not units systemd knows about. Without this,
# `sudo systemctl start blitz-bot-update` answers "Unit blitz-bot-update.service
# not found" over a file plainly sitting in /etc/systemd/system -- which is the
# exact error this whole arrangement exists because of.
systemctl daemon-reload ||
  fail 'daemon-reload failed -- systemd has not been told about the new files'
printf '  %-9s  systemd now knows about the three units\n' reloaded

# ---- and the sentence that says what was deliberately not done -------------

printf '
install: done. NOTHING WAS ENABLED AND NOTHING WAS STARTED.

  Installing and starting are separate decisions, and this made only the first.
  §7 of docs/deploy.md starts the bot, reads the journal after it, and turns the
  timer on last. Until then these four files sit on the disk doing nothing.
'
