#!/usr/bin/env bash
# pe: devtools
# Riff usage poller — keeps the plan's rate-limit windows flowing to the
# throttle without a Claude Code session holding the MCP. Run it directly, or
# from a launchd user-agent, for autonomous operation.
#
# It reads the host's interactive Claude login (the Keychain on macOS) to fetch
# the five-hour/seven-day windows and POSTs them to the local gateway; a
# setup-token cannot read those windows, which is why this runs host-side. See
# src/mcp/usage-daemon.ts and src/mcp/usagePoll.ts.
#
# launchd (optional, for true 24/7 autonomy): point a user-agent plist's
# ProgramArguments at this script, KeepAlive=true, then `launchctl load` it.
set -eo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root

# nvm.sh references unset vars, so `-u` is deliberately left out of the flags
# above; without that it would exit before node ever runs.
# shellcheck disable=SC1090
source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
nvm use 26 >/dev/null

cd "$here"
exec node src/mcp/usage-daemon.ts
