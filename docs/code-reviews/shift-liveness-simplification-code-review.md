# Code Review — shift liveness: remove the gate-silence watchdog

**Verdict:** ✅ APPROVED (LOW/INFO only)
**Reviewer:** Marvin (technical oversight) + an independent adversarial pass by a fresh reviewer agent
**Review Round:** 1
**Reviewed SHA:** 5654233 (pre-commit review of working-tree changes)
**Scope:** `src/runtime/staff.ts`, `src/runtime/scheduler.ts`, `src/core/config.ts`,
`src/company/registry.ts`, `src/analytics/{vitals,types}.ts`, `src/mcp/server.ts`,
`desk/src/views/{Overview,Vitals}.vue`, and the ceiling/permissions/rotation/policy/vitals/mcp tests.

## Why

The `shift.blind` watchdog inferred a dead permission channel from gate silence:
three consecutive assistant turns wanting a gated tool with `gateCalls` still 0.
The investigation (see the prior commit and `git log`) proved those were false
positives — the Bash sandbox auto-runs contained read-only commands without
calling `canUseTool`, so a healthy leg opening on `ls`/`grep` returned real
output with `gateCalls` 0, and 44 shifts were killed mid-work for it.

The watchdog had **no unique catch**. To reach three gated turns the model must
keep going, which means results are arriving — healthy (a false positive) or
`Stream closed` (caught on turn one by the explicit fast path). A true no-result
hang stalls after one turn and is caught by the shift-timeout. So the inference
layer was pure liability, and its "proof of life" patch was propping up a
heuristic that should not exist. Removed entirely; the runtime now leans only on
what the SDK/runtime state say outright.

## What changed

| Removed (inference) | Kept (explicit signal) |
| - | - |
| `blindWatch`, `BLIND_TURNS`, `WENT_BLIND` | `streamClosedResult` — the SDK's own `Stream closed` on a dead resume |
| `reachesGate` + `UNGATED_TOOLS` + `READ_ONLY_COMPANY_TOOLS` | `recoverStaleSession` (was `recoverBlind`) — drop the resume, retake cold once |
| the per-turn `watch.turn()` check + `hasSuccessfulResult`/`watch.result()` | the shift-timeout timer — the backstop for any hang |
| the `shift.blind` event + the `blind` vitals metric | `shift.tools_missing`, the result-subtype handling |

Renames: `wentBlind`→`staleSession`, `blindRetries`→`staleRetries`,
`blindTrace`→`shiftTrace` (policy field, threaded through config/scheduler/registry/desk).
`troubleRate` is now `over(failed + overran, woke)`.

Net −341 lines.

## Verification

- `npm run check` — clean (incl. `check-sfc-types.mjs` + all three tsgo passes; no desk↔src drift).
- `npm test` — 587 pass, 0 fail.
- `npm run test:ui` — 70 pass (desk changed).
- Every removed symbol is gone from runtime code; the only surviving mentions are
  a test *asserting* the removal and historical review docs.
- Failure paths walked end to end: dead resume → `streamClosedResult` → cold
  retake; hang → timer → `stop.abort()` → catch → `overran` → `agent.failed`;
  `is_error`-forever → bounded by the turn ceiling and the timeout.

## Findings

### 🟢 LOW-1 — a reworded transport abort loses its fast-path catch (accepted)
`streamClosedResult` matches the literal `/stream closed/i`. If a future SDK
rewords its abort, a dead resumed stream would fall through to the turn ceiling /
shift-timeout (recorded `truncated`/`overran`) instead of a fast cold retake — so
that one shift is wasted rather than retaken. Still **bounded** (never a hang),
and `blindWatch` never caught the post-gate-answer variant of this either. This is
the tradeoff the removal deliberately accepts: the timeout is the honest,
mechanism-independent backstop, and widening the regex to guess at future abort
strings is the same kind of inference we removed. One-line fix (broaden the
pattern) if it ever bites in practice.

### 🟢 LOW-2 — troubleRate double-counts an overran-then-failed shift (pre-existing)
An overran shift emits both `shift.overran` and `agent.failed`, and `troubleRate`
sums the two counts with no per-shift dedup. Identical before this refactor
(`shift.blind` shifts did the same); metric-neutral here. Follow-up, out of scope.

### ℹ️ INFO
- `recoverStaleSession`'s short-circuit (`staleRetries++` not evaluated when
  `session` is falsy) and dual-path routing are verified by inspection + the
  structural tests, consistent with this file's test style.
- `setRunningFlag` rewrites config from the raw file without `readPolicy`, so a
  legacy `blindTrace` key would persist as ignored dead data until a full
  `persisted()` write. Harmless.
- The unrelated *pacing-blind* concept (no fresh usage window to pace on) was
  correctly left untouched.

## Landing

Deferred until ShipIt is stopped (it is); a rebuild is required because
`staff.ts` runs in the container. Commit + `up --build` land together while the
company is paused; the rebuild does not restart ShipIt.
