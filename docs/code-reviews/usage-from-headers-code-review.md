# Code Review — plan usage read from the runtime credential's own responses

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | generic three-pass with adversarial passes (keyproxy, gateway) + pe-vue five-pass (desk), two rounds each, on the staged diff |
| Base SHA | 53a1470 |
| Reviewed SHA | a6e949b |
| Files | `src/core/usage.ts` (new), `src/runtime/usageFeed.ts` (new), `src/keyproxy/main.ts`, `src/core/settings.ts`, `src/gateway/server.ts`, `src/company/registry.ts`, `src/runtime/scheduler.ts`, `src/runtime/staff.ts`, `src/mcp/{server,client}.ts`, `desk/src/{api.ts,views/Settings.vue}`, `SECURITY.md`, `CLAUDE.md`, `README.md`, tests; removed `src/mcp/usagePoll.ts`, `src/mcp/usage-daemon.ts`, `scripts/usage-poller.sh`, `test/usagePoll.test.ts` |
| Verdict | ✅ APPROVED (round 2) |

## What changed

The plan's 5-hour and 7-day windows were posted to an unauthenticated
`POST /api/usage` by a host process reading the operator's Keychain login,
because the long-lived runtime token cannot call `/api/oauth/usage`. Measured:
a one-token Haiku call through the keyproxy on that token returns
`anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}` — 5% / 42%,
matching the operator's status line. So:

- the keyproxy reads those headers off every runtime response billed to the
  installation credential and serves the latest on `GET /usage`, to a scoped
  token for the reserved `_install` audience only the gateway can mint;
- the gateway pulls it each minute and pings (Haiku, one output token) only
  when the reading is older than the Riff Settings interval — default 10 min,
  at most 25, 0 off, at most once per interval, never on an API-key default;
- readings carry the time they were read, so a re-passed reading still ages,
  and an older one never replaces a newer one;
- the host poller, its daemon and script, the MCP's embedded poller and the
  POST endpoint are gone. Nothing reads the operator's login any more.

## Findings

Backend round 1 — no blocking findings; token scope, reading-poisoning and DoS
verified. LOWs fixed: a reserved-audience folder never gets a shift token (U1);
older readings never overwrite newer (U2); companies on their own credential are
not paced by the install plan (U3); interval capped below the scheduler's 30-min
staleness line (U4); no ping on an API-key default (U5); a stale import (U6).
Round 2: all resolved, none new.

Desk round 1 — MEDIUM: the reading and its age froze at mount (now a ticking
refresh). LOWs: a failed fetch read as "no reading yet"; an API-key default
promised a reading that never comes; the interval showed a literal default
before load; a stale error after correction; per-model weeks hidden. All fixed.
Round 2: all resolved; the new branches got an e2e test (age advances under a
fake clock, error state), and the interval's max now comes from the server.

## Awareness

- A running company switched from the install credential to its own keeps the
  install windows it had until they age out (30 min) — conservative pacing.
- The ping uses the dated Haiku id that was measured; if it is retired the ping
  fails quietly and the reading refreshes only from shifts.

## Verdict

✅ **APPROVED.** `npm run check` clean; `npm test` 673 pass; `npm run test:ui` 82 pass.
