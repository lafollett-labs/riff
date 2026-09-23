#!/bin/sh
# Start the stack, draining any in-flight shift first so a rebuild does not kill
# it mid-write.
#
#   docker/up.sh up --build    start it
#   docker/up.sh check         validate the compose wiring, start nothing
#   docker/up.sh logs -f       anything else compose understands
#
# THE RUNTIME CREDENTIAL IS NOT HERE. The agents' Claude token no longer reaches
# the container through Docker — not as an env var, not on a tmpfs record. It
# lives encrypted in the keyproxy's vault and is set once in the console (Riff
# Settings); each shift carries only a scoped, per-shift token the proxy swaps
# for the real key on the way out. So this script has no token to fetch, and
# `docker inspect` on the factory shows none. See SECURITY.md.
#
# WHERE COMPOSE SETTINGS LIVE (RIFF_DATA, PORT, UID/GID …), increasing precedence:
#
#   docker/.env                repo-local and gitignored; ordinary settings only.
#   $RIFF_ENV                  any path outside the checkout, set in your profile.
#   the environment            an exported var wins over both files.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
local_env="$here/.env"
outside_env=${RIFF_ENV:-}

if [ -n "$outside_env" ] && [ ! -f "$outside_env" ]; then
  echo "riff: RIFF_ENV points at $outside_env, which does not exist." >&2
  exit 1
fi

# The subcommand, for the drain and check cases below. Flags are skipped so
# `up --build` still reads as `up`.
subcommand=
for a in "$@"; do
  case $a in
    -*) continue ;;
    *) subcommand=$a ;;
  esac
  break
done

compose() { docker compose -f "$here/compose.yaml" "$@"; }

# Both files are handed to compose, later winning, so ordinary settings can live
# in either. Naming any --env-file replaces the automatic docker/.env, so when
# both exist both are named; spelling the cases out keeps every path quoted,
# which matters the moment a home directory has a space in it.
run_compose() {
  if [ -n "$outside_env" ] && [ -f "$local_env" ]; then
    compose --env-file "$local_env" --env-file "$outside_env" "$@"
  elif [ -n "$outside_env" ]; then
    compose --env-file "$outside_env" "$@"
  else
    compose "$@"
  fi
}

# `check` proves the wiring before an overnight run: it validates the compose
# configuration and starts nothing. There is no token to resolve any more — the
# runtime credential is set in the console, and a company with none is held on
# boot by the server rather than waking unable to work.
if [ "$subcommand" = check ]; then
  run_compose config >/dev/null
  echo "riff: compose configuration is valid. Nothing was started."
  echo "  Set the runtime credential in the console (Riff Settings) before"
  echo "  starting a company; one with none is held rather than run."
  exit 0
fi

# Recreating the container kills whoever is mid-shift.
#
# Compose sends SIGTERM and waits ten seconds; a shift runs for minutes, so the
# shift dies and the ledger records `Claude Code process aborted by user` for
# work that was going fine. Pausing first lets the scheduler finish what is in
# flight — `stop()` waits on it deliberately — and the server restores whatever
# was running when it comes back up, so nothing has to be restarted by hand.
drain() {
  # Where the RUNNING stack is published, asked of compose. It read $PORT from
  # the environment alone, so a PORT set in docker/.env or $RIFF_ENV — where
  # .env.example says to set it — sent the listing to 4173, found nobody, and
  # the rebuild recreated the container under the shifts it was there to wait
  # for. Re-reading the env files would still be wrong the moment PORT is
  # edited before a rebuild: that names the next container, not this one.
  port=$(run_compose port ingress 4173 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')
  [ -n "$port" ] || return 0            # nothing published: no stack, nothing to drain
  base="http://127.0.0.1:$port/api"
  # Said out loud: the stack is up but its server did not answer, which looks
  # exactly like nobody working, and only one of them is safe to rebuild over.
  list=$(curl -sf -m 5 "$base/companies" 2>/dev/null) || {
    echo "riff: the stack is up on 127.0.0.1:$port but its server did not answer; nothing was drained" >&2
    return 0
  }
  # Split on `{` so each line is one company object, carrying both its slug and
  # its running flag whatever order the fields arrive in. The first version cut
  # on commas and took the line before "running":true, which assumed slug and
  # running were adjacent — they are eight fields apart, so it silently matched
  # nothing and two rebuilds killed a shift each while the test passed against a
  # fixture that had them side by side.
  running=$(printf '%s' "$list" | tr '{' '\n' | grep '"running":true' \
    | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p') || true
  [ -n "$running" ] || return 0

  for slug in $running; do
    echo "riff: draining $slug so its shift is not killed by the rebuild"
    # drain:true is the difference between waiting for a shift and killing it.
    # Without it this POST aborts whoever is mid-shift and the rebuild it was
    # meant to protect them from is beside the point — the pause did the
    # damage. It answers at once and the company reports `draining` until the
    # last journal is written, which is what the wait below watches.
    curl -sf -m 10 -X POST "$base/companies/$slug/running" \
      -H 'content-type: application/json' -d '{"running":false,"drain":true}' >/dev/null 2>&1 || true
  done

  # Long enough for a real shift, because a wait that gives up early is worse
  # than no wait at all: it recreates the container under a live shift and
  # prints that everything drained.
  #
  # It was 300s. On 2026-09-08 a rebuild reached that cap eight minutes into
  # two shifts, announced "shifts drained", and killed both — `Claude Code
  # process aborted by user`, the exact line this guard exists to prevent.
  # Across the 499 shifts this installation has recorded, p99 is 16.1 minutes
  # and the longest that ever finished is 27.7, so 300s was short of a normal
  # shift, not of an unusual one. 30 minutes covers every one of them, and
  # CompanyPolicy.shiftTimeoutMinutes guarantees the wait ends either way.
  waited=0
  while [ "$waited" -lt 1800 ]; do
    awake=$(curl -sf -m 5 "$base/companies" 2>/dev/null | grep -o '"awake":\[[^]]*\]' \
      | grep -v '"awake":\[\]' | head -1) || break
    [ -z "$awake" ] && break
    [ $((waited % 15)) -eq 0 ] && echo "riff: waiting for shifts to finish (${waited}s of 1800s)"
    sleep 3
    waited=$((waited + 3))
  done

  # Say which happened. Announcing a drain that did not finish is how the
  # killed shifts above went unnoticed until someone read the ledger.
  if [ -n "${awake:-}" ]; then
    echo "riff: STILL WORKING after ${waited}s — $awake" >&2
    echo "  Recreating the container now kills them mid-shift and loses" >&2
    echo "  everything since their last journal entry. Stop here unless you" >&2
    echo "  mean it: ^C, then re-run once 'up.sh check' shows nobody awake." >&2
  else
    echo "riff: shifts drained; the server restores what was running on boot"
  fi
}

case $subcommand in
  up|restart|down|stop|create) drain ;;
esac

# `up` starts the stack. Watching it is `up.sh logs -f`, which is why that is a
# separate line in the usage above. Attached — which is what plain `docker
# compose up` is — the command streams logs and never returns; the stack is more
# useful detached, so default to it unless the caller asked otherwise.
if [ "$subcommand" = up ]; then
  detached=no
  for a in "$@"; do
    case $a in -d|--detach) detached=yes ; break ;; esac
  done
  [ "$detached" = no ] && set -- "$@" --detach
fi

run_compose "$@"
