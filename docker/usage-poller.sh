#!/bin/sh
# Read the subscription's usage windows and inject them into the running server.
#
# WHY THIS EXISTS. The companies spend on a `setup-token`, which is stable and
# never races the operator's login — but it carries `user:inference` without
# `user:profile`, so it can spend the plan and cannot read what is left of it.
# The five-hour and seven-day windows the throttle paces on therefore have to be
# read with the operator's INTERACTIVE login, which does carry `user:profile`,
# and handed to the server from outside. That is this script's whole job.
#
# It is READ-ONLY. It never refreshes or rotates a token, so it cannot cause the
# single-use-refresh collision that killed a night's run on 2026-09-11: reading
# `/api/oauth/usage` spends nothing and rotates nothing. The interactive login it
# reads is the one the host keeps fresh through normal use; if it lapses, the
# windows go stale but spending continues, which is the failure mode we want.
#
# Run it on a timer (see docker/com.riff.usage-poller.plist). Every few minutes
# is plenty — the windows move slowly.
set -eu

PORT=${PORT:-4173}
GATEWAY=${RIFF_GATEWAY:-http://127.0.0.1:${PORT}}
KEYCHAIN_ITEM=${RIFF_LOGIN_KEYCHAIN_ITEM:-Claude Code-credentials}
# The usage endpoint rate-limits hard without a claude-code User-Agent, so this
# must always look like the CLI. Prefer the installed version; fall back to a
# known-good one rather than a bogus string when `claude` is not on PATH (it
# often is not under launchd).
UA="claude-code/$(claude --version 2>/dev/null | awk '{print $1}' | grep -E '^[0-9.]+$' || echo 2.1.268)"

# The interactive login lives in the macOS keychain — Claude Code stores it
# there and deletes the plaintext file — so `security -w` prints the record and
# jq lifts the access token. This prompts on first run unless the keychain item
# is set to always-allow for the `security` tool (grant it once).
token=$(security find-generic-password -s "$KEYCHAIN_ITEM" -w 2>/dev/null \
  | jq -r '.claudeAiOauth.accessToken // empty')
if [ -z "$token" ]; then
  echo "usage-poller: no interactive credential in keychain item '$KEYCHAIN_ITEM'." >&2
  echo "  Is the host logged in (claude /login)? Windows will be stale until it is." >&2
  exit 1
fi

# Keep the token out of argv (and therefore out of `ps`) by handing curl the
# headers from a 0600 file rather than on the command line.
hdr=$(mktemp)
chmod 600 "$hdr"
# INT/TERM as well as EXIT: launchd reaps a job with SIGTERM, and the EXIT trap
# alone does not fire on a signal — that path would leave the bearer-token header
# in $TMPDIR. (SIGKILL cannot be trapped; that residue is unavoidable.)
trap 'rm -f "$hdr"' EXIT INT TERM
{
  printf 'Authorization: Bearer %s\n' "$token"
  printf 'anthropic-beta: oauth-2025-04-20\n'
  printf 'User-Agent: %s\n' "$UA"
} > "$hdr"

usage=$(curl -sf -m 15 https://api.anthropic.com/api/oauth/usage -H @"$hdr") || {
  echo "usage-poller: usage request failed (token expired, or offline)." >&2
  exit 1
}

# Post the response verbatim; the gateway turns it into windows (it skips every
# field that is not a window, so the raw body is exactly what it wants).
if curl -sf -m 10 -X POST "${GATEWAY}/api/usage" \
     -H 'content-type: application/json' -d "$usage" >/dev/null; then
  echo "usage-poller: injected usage into ${GATEWAY}"
else
  echo "usage-poller: could not reach the gateway at ${GATEWAY} — is it running?" >&2
  exit 1
fi
