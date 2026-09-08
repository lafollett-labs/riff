#!/bin/sh
# The server founds a company when the installation is empty and resumes every
# company left running, so there is nothing to arrange here.
#
# This used to run init.ts and a scheduler of its own. Both are now the
# server's job, and running a second scheduler beside it would have woken
# every agent twice.
set -eu

# Fail loudly rather than writing a whole company somewhere it will not survive.
case "${RIFF_ROOT:-}" in
  /data*) ;;
  *) echo "RIFF_ROOT must live under the mounted volume; got '${RIFF_ROOT:-unset}'" >&2
     exit 1 ;;
esac

# Can we actually write to the mount?
#
# Docker Desktop maps ownership on bind mounts, so on macOS a directory owned
# by your account is writable by this container whatever uid it runs as. A
# rootful Linux daemon does no such mapping: the host directory keeps its own
# ownership, and this user cannot create anything in it. That surfaces as a
# confusing crash deep in a git call, so catch it here and say what to do.
if ! touch /data/.write-test 2>/dev/null; then
  cat >&2 <<MSG

  Cannot write to /data (running as uid $(id -u)).

  The host directory behind the mount is owned by someone else. On Linux,
  either give it to this user:

      sudo chown -R $(id -u):$(id -g) "\${RIFF_DATA:-\$HOME/.riff}"

  or run the container as yourself, by adding to docker/.env:

      UID=\$(id -u)
      GID=\$(id -g)

  and uncommenting the \`user:\` line on the factory service in compose.yaml.

MSG
  exit 1
fi
rm -f /data/.write-test

# Put the CLI's conversation transcripts on the durable volume.
#
# $HOME is a 256M tmpfs (see compose.yaml, which explains why), and the CLI
# keeps every transcript under $HOME/.claude/projects. The session id that
# names one is written to the ledger, which is NOT on a tmpfs — so every
# restart left every agent holding an id for a conversation that no longer
# existed. On 2026-09-07 the first shift of two agents after a rebuild died
# that way; the runtime now checks the store before resuming, and this is why
# there is usually something there to find.
#
# Only `projects/` moves. `.credentials.json` stays on the tmpfs beside it,
# deliberately: the subscription token is delivered into memory after start
# and must not be written to the operator's disk.
sessions=/data/sessions
mkdir -p "$sessions" "$HOME/.claude"
if [ ! -L "$HOME/.claude/projects" ]; then
  # Anything the CLI wrote before the link exists was written to the tmpfs and
  # is about to be discarded with it; move it across rather than lose it.
  if [ -d "$HOME/.claude/projects" ]; then
    (cd "$HOME/.claude/projects" && tar cf - .) | (cd "$sessions" && tar xf -)
    rm -rf "$HOME/.claude/projects"
  fi
  ln -s "$sessions" "$HOME/.claude/projects"
fi

# Wait for the credentials record, when that is how this stack is being run.
#
# A bare token in CLAUDE_CODE_OAUTH_TOKEN can spend the subscription and cannot
# read what is left of it: the CLI has no subscription record to ask about, so
# every rate-limit window comes back empty and the throttle has nothing to pace
# on. The record carries the plan alongside the token and fixes that — but it
# only exists on a tmpfs that is created with this container, so `up.sh` has to
# push it in after we are already running.
#
# Starting the server first would mean the companies left running wake up,
# spend a shift with no credentials at all and log the failure. So block here.
# Nothing is running yet, and there is nothing to lose by waiting.
#
# Waits rather than gives up, and that is the whole point. The home directory
# is a tmpfs, so it is recreated by ANY restart — `docker restart`, a Docker
# Desktop reboot, a crash and respawn — and the record is gone every time.
# Exiting on a deadline turned that into a crash loop that took the API down
# with it, so `up.sh` could not even be asked to deliver a new one. Sitting
# here logging is diagnosable; a restart loop is not.
#
# Bounded, and what it does at the deadline is NOT exit. `up.sh up --build` was
# interrupted on 2026-09-05 after compose had already recreated the container
# but before the record was pushed, and this loop then logged the same line
# 2,695 times over eleven hours — the API never came up, so nothing could even
# be asked for a new record. Giving up and starting is the way out that keeps
# the door open; giving up and exiting is the restart loop this comment warns
# about two paragraphs above.
if [ "${RIFF_WAIT_FOR_CREDENTIALS:-}" = 1 ]; then
  creds="$HOME/.claude/.credentials.json"
  deadline=${RIFF_CREDENTIALS_TIMEOUT:-300}
  waited=0
  while [ ! -s "$creds" ]; do
    if [ "$waited" -ge "$deadline" ]; then
      echo "riff: no credentials record after ${waited}s. Starting anyway, with"
      echo "  every company held paused, so nothing wakes up unable to work."
      echo "  Deliver the record and start them when you are ready:"
      echo "    docker/up.sh creds"
      # The server reads this and skips restoring whatever was left running.
      # A company that wakes with no credentials burns a shift to log a failure.
      RIFF_HOLD_PAUSED=1
      export RIFF_HOLD_PAUSED
      break
    fi
    if [ "$waited" -gt 0 ] && [ $((waited % 15)) -eq 0 ]; then
      echo "riff: still waiting for a credentials record at $creds (${waited}s of ${deadline}s)."
      echo "  Deliver one with: docker/up.sh creds"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  [ -s "$creds" ] && echo "riff: credentials record present after ${waited}s"
fi

exec "$@"
