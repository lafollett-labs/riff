#!/bin/sh
# Start the stack, resolving the Claude token at launch.
#
#   docker/up.sh up --build    start it
#   docker/up.sh check         prove the token wiring works, and start nothing
#   docker/up.sh creds        re-deliver the credentials record to a factory
#                              that is already running. Needed after any
#                              restart that did not come through this script:
#                              the record lives on a tmpfs and does not
#                              survive one. The container waits and says so.
#   docker/up.sh logs -f       anything else compose understands
#
# WHERE THE TOKEN LIVES: in your password manager, and nowhere else. Not in
# this repository, not in a dotfile, not in your shell profile. What the
# configuration holds is a COMMAND that prints it:
#
#   RIFF_TOKEN_CMD="pass show riff/claude-token"        # or op / keepassxc-cli
#   RIFF_TOKEN_CMD="secret-tool lookup service riff account claude"
#
# That line is not a secret, which is the point — it can sit in a config file
# without the file needing to be protected, backed up carefully, or kept out of
# a directory you might one day zip up and send to someone.
#
# WHICH TOKEN, and it decides whether the throttle works at all. A token from
# `claude setup-token` is long-lived and carries `user:inference` without
# `user:profile`, so the container can spend the subscription and cannot read
# what is left of it — every rate-limit window comes back empty, the throttle
# has nothing to pace on, and a run gets judged on token counts nobody is
# billed for. Your own login session has `user:profile`. Reading it instead
# costs an expiry: the access token lasts hours, so a run outliving it needs
# `up.sh` again, which picks up a fresh one.
#
#   macOS    RIFF_TOKEN_CMD='security find-generic-password \
#                              -s "Claude Code-credentials" -w \
#                            | jq -r .claudeAiOauth.accessToken'
#   Linux    RIFF_TOKEN_CMD='jq -r .claudeAiOauth.accessToken \
#                              "$HOME/.claude/.credentials.json"'
#   WSL      as Linux, against the credentials file inside WSL.
#
# The command is the portable part; only the store differs. Riff records
# `planVisible: no` on every shift taken with a token it cannot read the plan
# through, so this is visible rather than silent.
#
# WHERE THAT LINE LIVES, in increasing precedence:
#
#   docker/.env                repo-local and gitignored. Fine, because it
#                              holds a pointer rather than a credential.
#   $RIFF_ENV              any path you like, outside the checkout. Set it
#                              in your shell profile and the repository holds
#                              no configuration of yours at all.
#   the environment            CLAUDE_CODE_OAUTH_TOKEN or RIFF_TOKEN_CMD
#                              already exported wins over both files.
#
# Both files are handed to compose, later winning, so ordinary settings like
# RIFF_DATA can live in either.
#
# WHAT THIS DOES NOT DO, and it matters: once the container is running the
# token is in its environment, and the staff have a shell. Anything in that box
# can read it, and so can `docker inspect` on the host. Secrecy is not the
# control. The control is that the factory sits on a network with no route to
# the internet except a logging proxy. See SECURITY.md.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
local_env="$here/.env"
outside_env=${RIFF_ENV:-}

if [ -n "$outside_env" ] && [ ! -f "$outside_env" ]; then
  echo "riff: RIFF_ENV points at $outside_env, which does not exist." >&2
  exit 1
fi

# Read one key out of a config file without sourcing it. Sourcing would execute
# whatever else is in there, and a config file should not be a program.
from_file() {
  [ -f "$1" ] || return 0
  sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -n 1 \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# Only the subcommands that actually START something need a real token. Asking
# a password manager to unlock so you can read `logs`, or `down` a stack that
# is already running, trains you to unlock it without reading the prompt —
# which is the habit the password manager exists to prevent. Compose still
# interpolates the variable for every subcommand, so the others get a
# placeholder that never reaches a running container.
needs_token=no
subcommand=
for a in "$@"; do
  case $a in
    -*) continue ;;
    *) subcommand=$a ;;
  esac
  break
done
case $subcommand in
  up|run|start|restart|create|check|creds) needs_token=yes ;;
esac

if [ "$needs_token" = no ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  CLAUDE_CODE_OAUTH_TOKEN=not-needed-for-this-command
  export CLAUDE_CODE_OAUTH_TOKEN
fi

# The credentials RECORD, when one is configured. Preferred over a bare token:
# it carries the subscription, which is what lets the runtime read how much of
# the plan is left instead of guessing from token counts nobody is billed for.
#
# Held in a variable and pushed onto the container's tmpfs after start. It is
# never written to host disk, never echoed, and dies with the container.
record=
if [ "$needs_token" = yes ]; then
  # Exported wins over both files, and that includes exporting it EMPTY: that
  # is how a caller says "not this way" without editing the operator's config.
  # Without it a test harness, or anyone with a record in docker/.env, cannot
  # exercise the bare-token path at all — and a test that reaches past its
  # fixtures into the real config resolves the operator's real credential.
  if [ -n "${RIFF_CREDENTIALS_CMD+set}" ]; then
    rcmd=${RIFF_CREDENTIALS_CMD}
  else
    rcmd=
    [ -n "$outside_env" ] && rcmd=$(from_file "$outside_env" RIFF_CREDENTIALS_CMD)
    [ -n "$rcmd" ] || rcmd=$(from_file "$local_env" RIFF_CREDENTIALS_CMD)
  fi
  if [ -n "$rcmd" ]; then
    if ! record=$(eval "$rcmd"); then
      echo "riff: RIFF_CREDENTIALS_CMD failed, so there is no credential." >&2
      echo "  command: $rcmd" >&2
      exit 1
    fi
    case $record in
      *claudeAiOauth*) ;;
      *) echo "riff: RIFF_CREDENTIALS_CMD printed something without a" >&2
         echo "  claudeAiOauth record in it. Expected the contents of" >&2
         echo "  ~/.claude/.credentials.json." >&2
         exit 1 ;;
    esac
    # Length only, same as the token path: enough to tell a credential from an
    # error message without putting any of it on your screen.
    echo "riff: credentials record resolved (${#record} characters)"
    RIFF_WAIT_FOR_CREDENTIALS=1
    export RIFF_WAIT_FOR_CREDENTIALS
  fi
fi

if [ "$needs_token" = yes ] && [ -z "$record" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  cmd=${RIFF_TOKEN_CMD:-}
  [ -n "$cmd" ] || { [ -n "$outside_env" ] && cmd=$(from_file "$outside_env" RIFF_TOKEN_CMD); }
  [ -n "$cmd" ] || cmd=$(from_file "$local_env" RIFF_TOKEN_CMD)

  if [ -n "$cmd" ]; then
    # Runs with your shell and your tty, so a vault that wants a passphrase can
    # ask for one. Failure here must stop everything: starting without a token
    # gets you a company that wakes up, fails every shift, and logs it.
    if ! token=$(eval "$cmd"); then
      echo "riff: RIFF_TOKEN_CMD failed, so there is no token." >&2
      echo "  command: $cmd" >&2
      exit 1
    fi
    # Trim a trailing newline; most vault tools add one and the SDK will not.
    token=$(printf '%s' "$token" | tr -d '\r\n')
    if [ -z "$token" ]; then
      echo "riff: RIFF_TOKEN_CMD printed nothing." >&2
      echo "  command: $cmd" >&2
      exit 1
    fi
    CLAUDE_CODE_OAUTH_TOKEN=$token
    export CLAUDE_CODE_OAUTH_TOKEN
    # Length only. Enough to tell "the vault gave me something" from "the vault
    # gave me an error message", without putting any of it on your screen.
    echo "riff: token resolved from RIFF_TOKEN_CMD (${#token} characters)"
  fi
fi

# `check` exists so you can prove the wiring before trusting it with an
# overnight run: it does everything a start does right up to the point of
# starting anything. It prints a length, never a token.
if [ "$subcommand" = check ]; then
  if [ -n "$record" ]; then
    echo "riff: a credentials record is available (${#record} characters)."
    echo "  The plan's own windows will be readable, so the throttle has a"
    echo "  figure to govern on. Nothing was started."
    exit 0
  fi
  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    echo "riff: no credential, and nothing configured to fetch one." >&2
    echo "  Set RIFF_CREDENTIALS_CMD (preferred) or RIFF_TOKEN_CMD in" >&2
    echo "  $local_env${outside_env:+ or $outside_env}." >&2
    exit 1
  fi
  echo "riff: a bare token is available (${#CLAUDE_CODE_OAUTH_TOKEN} characters)."
  echo "  The plan will NOT be readable with it: rate limits come back empty,"
  echo "  the throttle has nothing to govern on, and shifts record"
  echo "  planVisible: no. Set RIFF_CREDENTIALS_CMD to fix that."
  echo "  Nothing was started."
  exit 0
fi

# Anything still unset is left to compose, which has its own message pointing
# at `claude setup-token`. A literal CLAUDE_CODE_OAUTH_TOKEN in either file
# still works — a command is a better default, not the only way.
#
# Naming any --env-file replaces the automatic docker/.env, so when both exist
# both are named. Spelling the three cases out keeps every path quoted, which
# matters the moment someone's home directory has a space in it.
# With a record to push, this cannot `exec` — there is work after compose
# returns, and the entrypoint is blocked waiting for exactly that work.
if [ -n "$record" ]; then
  compose() { docker compose -f "$here/compose.yaml" "$@"; }
else
  compose() { exec docker compose -f "$here/compose.yaml" "$@"; }
fi

# Hand the record to a running factory. Idempotent, and safe to repeat.
delivered=no
deliver() {
  [ "$delivered" = yes ] && return 0
  waited=0
  until printf '%s' "$record" \
      | run_compose exec -T factory sh -c \
          'mkdir -p "$HOME/.claude" && cat > "$HOME/.claude/.credentials.json" \
           && chmod 600 "$HOME/.claude/.credentials.json"' 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -ge 30 ]; then
      echo "riff: could not hand the credentials record to the factory." >&2
      echo "  Is it running? docker/up.sh ps" >&2
      return 1
    fi
    sleep 1
  done
  delivered=yes
  echo "riff: credentials delivered to the factory (tmpfs only, never on disk)"
}

# Deliver on the way out, however we leave.
#
# `up --build` recreates the container and THEN pushes the record, and the build
# is the slow half — minutes of apt and npm. Interrupt it in there, as happened
# on 2026-09-05, and compose has already started a factory that is now blocked
# waiting for a record this script was about to hand it and never will. It sat
# there eleven hours.
#
# So the delivery is not the last statement of the happy path any more; it is
# what this script does before it stops existing, whether it finished, failed or
# was killed. Nothing to undo if the container was never started: `deliver`
# fails its exec, gives up after 30 tries and says so.
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$record" ] && [ "$delivered" = no ] \
     && run_compose ps --status running factory 2>/dev/null | grep -q factory; then
    echo "riff: handing over the credentials record before exiting" >&2
    deliver || true
  fi
  exit $status
}

run_compose() {
  if [ -n "$outside_env" ] && [ -f "$local_env" ]; then
    compose --env-file "$local_env" --env-file "$outside_env" "$@"
  elif [ -n "$outside_env" ]; then
    compose --env-file "$outside_env" "$@"
  else
    compose "$@"
  fi
}

# `creds` exists because the record lives on a tmpfs: any restart that did not
# come through this script loses it, and the factory then waits for a new one.
# This hands it over without starting or recreating anything.
if [ "$subcommand" = creds ]; then
  if [ -z "$record" ]; then
    echo "riff: nothing configured to fetch a credentials record." >&2
    echo "  Set RIFF_CREDENTIALS_CMD in $local_env${outside_env:+ or $outside_env}." >&2
    exit 1
  fi
  deliver || exit 1
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
  port=${PORT:-4173}
  base="http://127.0.0.1:$port/api"
  # Split on `{` so each line is one company object, carrying both its slug and
  # its running flag whatever order the fields arrive in. The first version cut
  # on commas and took the line before "running":true, which assumed slug and
  # running were adjacent — they are eight fields apart, so it silently matched
  # nothing and two rebuilds killed a shift each while the test passed against a
  # fixture that had them side by side.
  running=$(curl -sf -m 5 "$base/companies" 2>/dev/null \
    | tr '{' '\n' | grep '"running":true' \
    | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p') || return 0
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

# `up` starts the stack. Watching it is `up.sh logs -f`, which is why that is
# a separate line in the usage above.
#
# Attached — which is what plain `docker compose up` is — the command streams
# logs and never returns, so the delivery below is unreachable and the factory
# waits for a record this script is still, technically, about to send. That is
# what happened on 2026-09-05: the stack sat on its 300s credentials deadline,
# started held-paused, and needed `up.sh creds` by hand to become useful. The
# deadline is the backstop; this is the bug it was papering over.
if [ "$subcommand" = up ]; then
  detached=no
  for a in "$@"; do
    case $a in -d|--detach) detached=yes ; break ;; esac
  done
  [ "$detached" = no ] && set -- "$@" --detach
fi

[ -n "$record" ] && trap on_exit EXIT HUP INT TERM

run_compose "$@" || exit $?

# Push the record in. The home directory is a tmpfs created with the container,
# so this cannot happen before start — the entrypoint waits for it rather than
# letting companies wake with no credentials.
if [ -n "$record" ]; then
  deliver || exit 1
fi
