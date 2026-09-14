# Code Review — blindWatch false-positive fix (sandboxed-Bash proof of life)

**Verdict:** ✅ APPROVED (MEDIUM raised in review, resolved before landing)
**Reviewer:** Marvin (technical oversight) + an independent adversarial pass by a fresh reviewer agent
**Review Round:** 1
**Reviewed SHA:** af3adde (pre-commit review of working-tree changes)
**Scope:** `src/runtime/staff.ts` (blindWatch, `hasSuccessfulResult`, one loop guard), `test/permissions.test.ts`, `test/ceiling.test.ts`

## The bug

`shift.blind` fired 44 times and failed 32 shifts. The investigation (ledger +
`transcript.db`, read from inside the container) proved the shifts were
**healthy**: every blind carried `gateCalls:0` at `turns:0`, and the transcript
showed the leg's Bash commands *ran and returned real output* (`isError:false`).

Cause: Claude Code's Bash sandbox (bubblewrap) runs a **contained read-only**
command (`ls`, `grep`, `sed`, `cat`) without ever calling `canUseTool` — the
sandbox is the authorization. So a leg that opens by orienting on read-only
shell (every CEO/engineer does) returns real output with `gateCalls` still 0,
which `blindWatch`'s gate-silence counter could not tell from a dead control
stream. It killed the shift after 3 such turns. Correlates with *who opens on
read-only shell*: Jack/Lynn blinded constantly, Carver (gated MCP tools sooner)
once. Not resume-specific — a **cold** leg (`resumed:false`) blinded too.

## The fix

A tool **succeeding** is proof of life alongside the gate answering. A dead
control stream returns `is_error` aborts and nothing else; a command that ran
returns output. So:

- `blindWatch` gains `result()`, which sets `proven` (renamed from
  `everAnswered` — the flag now means "the pipeline has demonstrably worked",
  set by either a gate call or a successful result).
- `hasSuccessfulResult(m)` — a user message carrying a `tool_result` with
  `is_error !== true`.
- The message loop calls `watch.result()` on a user message that is
  `!streamClosedResult(m) && hasSuccessfulResult(m)`.

The stream-closed fast path (drops a resumed dead leg, retakes cold) and the
no-result hang backstop are unchanged.

## Verification

- `npm run check` — clean.
- `npm test` — 606 pass, 0 fail (66 in the two touched files).
- Evidence trail: blind trace for seq 5618 (`init tools=connected`, then seven
  `assistant wants [Bash] gated=true`, gate never asked) cross-referenced with
  `transcript.db` session `ba14687c` (13 Bash results, `isError:false`) — the
  same leg that emitted the blind.

## Findings

### 🟠 MEDIUM — text-independence of the backstop (raised in review, RESOLVED)

The first cut counted **any** non-`Stream closed` `tool_result` as proof. That
made `blindWatch` — the backstop whose whole reason for existing is to catch a
dead stream "for the day the SDK stops surfacing the error" — depend on the same
`"Stream closed"` text match as the fast path. A future SDK rewording its abort
to e.g. `premature close` would slip past **both** layers: the fast path misses
the text, and the guard wrongly marks the leg alive, so the shift burns its
whole budget calling into a dead gate, silently — the exact loud-death property
the subsystem exists to provide.

**Resolution:** proof of life is now a **successful** result (`is_error !== true`),
not any result. A transport abort is an `is_error` result whatever it says, so a
reworded `Stream closed` still never disarms the watch — the fast path just
loses its turn-one shortcut and `blindWatch` trips at three instead. The
backstop is text-independent again.

**Trade-off accepted:** a leg whose opening turns are *all* genuinely-failing
commands (a grep with no match, a red test) with no success and no thinking
between could false-positive — rare (adaptive thinking interleaves text turns
that reset the counter; real legs return `isError:false` output within a turn or
two) and recoverable (the cold retry catches it). Documented in
`hasSuccessfulResult` and the loop guard.

### 🟢 LOW — the regression was untested (RESOLVED)

Added `hasSuccessfulResult` tests asserting an `is_error` result is NOT proof,
including the reworded-abort case (`AbortError: premature close`), so the
text-independence property is pinned.

### ℹ️ INFO — gate answers then stream dies mid-leg
Once `gateCalls > 0`, `blindWatch` is disarmed for the rest of the leg (a live
channel that closes after the gate answered is a different fault, handled
elsewhere). Pre-existing and intentional; unchanged by this fix.

### ℹ️ INFO — source-regex test assertions
`ceiling.test.ts` pins the loop wiring with a source-text regex, consistent with
the existing pattern in that file. Verifies text, not behavior; the behavior is
covered by the `blindWatch`/`hasSuccessfulResult` unit tests.

## Security note

Not a security control. `canUseTool: gated` is wired unconditionally and
`makeCanUseTool` runs default-deny on every crossing regardless of
`proven`/`blind` state; `blindWatch`'s only outputs are the `shift.blind` emit
and `stop.abort()`. A wrongly-"alive" shift keeps running under the same gate
and the same bubblewrap sandbox — a missed liveness alert, never a permission
bypass. Confirmed against SECURITY.md; no gate/sandbox/`permissionMode` change.

## Landing

Deferred until ShipIt is stopped (it is — `running:false`); a rebuild is
required because `staff.ts` runs in the container. Commit + `up --build` land
together while the company is paused; the rebuild does not restart ShipIt.
