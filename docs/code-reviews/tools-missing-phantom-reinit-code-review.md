# Code Review — resumed-leg phantom re-init + grace-poll wall-clock bound

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Staged diff (generic three-pass; no matching PE — TS runtime) |
| Review round | 1 |
| Reviewed SHA | 864b7ea |
| Files | `src/runtime/staff.ts`, `test/ceiling.test.ts` |
| Verdict | ✅ APPROVED |

## What changed

Two defensive fixes for the `shift.tools_missing` incident on a resumed leg
(Carver, 2026-09-16, seq 6286):

1. **Ignore a post-result phantom re-init** (`runLeg`). A `sawResult` flag is set
   when the leg's result lands; the `init` handler bails (`continue`) on any init
   that arrives after it. The tools check belongs only to the init that opens a
   leg; a second init emitted as the query winds down has an unregistered
   in-process company server (reads absent) and must not be called missing tools.
2. **Wall-clock-bound the grace poll** (`awaitToolsConnected`). Each
   `mcpServerStatus()` read is raced against the remaining budget via an injected
   `race` (default: `setTimeout`, cleared on settle, `unref`'d). The deadline was
   previously only checked *between* reads, so a hung read blocked 382s past a 3s
   budget. Returns `null` (→ false) when the budget elapses first.

## Method

Generic three-pass (Architecture → Quality+Tests → Security) + adversarial
re-read + self-adversarial. `npm run check` clean; `npm test` 608/608 pass
(4 new tests). No PE dispatched — the diff is TS backend runtime, matching none
of pe-go/pe-vue/pe-aws-infra/pe-governance/pe-devtools.

## Findings

No CRITICAL / HIGH / MEDIUM.

### Verified non-issues (adversarial pass)

- **Per-leg reset.** `sawResult` is declared inside `runLeg`, so rotation and
  handover legs each start `false` and their opening init is checked normally.
- **Handover path.** `sawResult = true` is set before the `if (handover)` branch,
  so a handover leg's phantom init is ignored too — correct.
- **Pre-result second init (hypothetical).** With `sawResult` false it is still
  processed, so the guard changes behavior only for post-result inits — no
  regression for any real or hypothetical mid-leg init.
- **Race double-settle.** Promise resolve/reject is idempotent; the timer is
  cleared on settle, and the rejection path has an `onRejected` handler, so a
  late rejection after a timeout is a handled no-op (no unhandled rejection).
- **`remaining <= 0` pre-check.** Does not regress the existing "budget out" test
  (still performs a read, still returns false); starts at ~budgetMs > 0 for the
  only prod caller (`TOOLS_GRACE_MS`).
- **Security.** No gate/permissions/secrets/docker paths touched; the init tools
  check is a liveness probe, not a security boundary.

### LOW / INFO (awareness — non-blocking)

- **LOW** — the two guard tests assert on source text (`src.indexOf`), which is
  brittle, but consistent with the file's existing `staff()`-source convention
  (`the init handler waits out the grace…`). A behavioral test would be stronger
  but needs a `tick()`/fake-query harness that does not exist yet.
- **INFO** — `awaitToolsConnected` now takes six positional params; if it grows
  further, an options object would read better.
- **INFO** — the end-to-end hung-read test asserts `< 500ms` wall-clock against a
  40ms budget; generous headroom, but wall-clock-dependent.

## Note on root cause

The trigger (a resumed leg producing an immediate `turns=0` result then a second
init with tools absent) did not reproduce in isolation — not the parked-input
pattern, not truncation of the prior shift, not resuming the exact 640K session.
It is a live-runtime race under concurrent shift execution. These fixes make the
runtime robust to it (no false failure, fast recovery) rather than chase a repro
that will not fire single-process. To catch the race itself: run with
`shiftTrace` on at `concurrency: 2` and wait for a recurrence.
