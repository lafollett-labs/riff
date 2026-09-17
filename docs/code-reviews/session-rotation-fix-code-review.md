# Code Review — session rotation on turn count + mid-leg stream-death recovery

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff (generic three-pass; no matching PE — TS runtime) |
| Review round | 1 |
| Reviewed SHA | 514f2d2 (working tree) |
| Files | `src/runtime/staff.ts`, `test/rotation.test.ts` |
| Verdict | ✅ APPROVED |

## The bug

`rotateAtContextPct: 50` was the *only* rotation trigger, and on a **1,000,000-token**
context window it is unreachable: the runtime compacts context back down, so real
`contextPct` peaked at **~41.5%** and never crossed 50% (500K). Measured on ShipIt's
ledger: **6 `session.rotated` vs 349 `agent.slept` vs 56 `session.reset`**. One
conversation (`f778733c`) ran **4,367 turns over ~29 hours** without rotating; its SDK
`canUseTool` control stream aged out and died mid-shift, so `WebFetch`/`WebSearch`
(ask-gated, need a permission round-trip) returned *"Tool permission request failed:
AbortError: Stream closed"* while `Bash`/`curl` (allow-gated, no round-trip) kept working.
The existing dead-stream recovery only catches the stream dead **at resume**
(`gateCalls === 0`); mid-leg death was deliberately left unhandled.

## What changed

1. **Turn-count rotation trigger.** `shouldRotate` gains a `sessionTurns` input and a
   second trigger: rotate once the conversation passes `ROTATE_AT_SESSION_TURNS` (300),
   independent of context %. A model-agnostic platform-health constant, sibling to the
   existing `MAX_ROTATIONS` / `HANDOVER_TURNS`. The context-% path is unchanged.
2. **Cumulative session-turn tracking.** `session-turns:<agent>` in the ledger mirrors
   `session:<agent>`: loaded on resume, re-zeroed by the leg that starts a fresh
   conversation, persisted at shift end. `sessionTurns()` = base + (shift turns since the
   current conversation began), so a session replaced mid-shift is charged only its own
   turns.
3. **Mid-leg stream-death recovery.** When a stream-closed tool_result appears with
   `gateCalls > 0` (the live channel died mid-leg, not at resume), flag it — do **not**
   abort the leg (it has real work; allow-gated tools still run) — and retire the session
   after the leg so the next one comes up cold with a fresh gate.

## Method

Generic three-pass (Architecture → Quality/Correctness → Security) + adversarial state-machine
trace + self-adversarial. `npm run check` clean; `npm test` 621/621 (7 new). No PE dispatched —
TS runtime (`src/runtime/`, `test/`), matching none of pe-go/pe-vue/pe-aws-infra/pe-governance/pe-devtools.
No security-boundary file touched (`permissions.ts` / `gate.ts` unchanged); the mid-leg
detection reads tool_result text but changes no permission decision, so `SECURITY.md`'s gate
rules do not apply.

## Findings

No CRITICAL / HIGH / MEDIUM remaining.

### Fixed during review (self-adversarial pass)

- **LOW — stale `permissionStreamDead` across legs.** The flag is shift-scoped and was only
  reset after the try-block check; a leg that set it and then *threw* into the catch (which
  may `continue`) would carry it into the next leg and retire a healthy cold-retried session.
  Fixed by resetting it at `runLeg` entry, so it only ever reflects the current leg.

### Verified non-issues (adversarial trace)

- **Turn accounting across resume/rotation/reset.** Traced cold-start, resume (base loaded,
  not reset because the resumed `session_id` equals `session`), mid-shift rotation, and all
  four session-drop paths (transcript-gone, LOST_SESSION, stale-at-resume, tools-not-connected,
  and the new mid-leg drop). Every fresh conversation re-zeroes the base at its `session_id`
  (the one choke point where a new id is assigned), so no session is charged another's turns
  and none is double-counted. Handover-leg turns land on the old conversation and are
  discarded with it.
- **`shouldRotate` back-compat.** Guards reordered (`rotations`, then `turnsLeft`, then the two
  triggers); all eight prior context-% cases still pass, confirmed by the suite. The turn
  trigger fires with zero context and still honors the hand-over-room and rotation-cap guards.
- **Meta parse.** `Number(getMeta(...)) || 0` maps absent/empty/garbage to 0 — a resumed
  session with no recorded count starts at 0 (won't rotate until it can be measured), which is
  the safe default, not a bug.
- **Mid-leg false-positive.** A non-control-stream tool_result containing "stream closed" would
  trigger a session reset — but a reset is a safe cold restart, and it reuses the same regex the
  existing `gateCalls === 0` path already trusts.
- **Security.** No secrets, injection, or new dependencies; gate untouched; the meta key derives
  from `agent.id`.

### INFO (awareness — non-blocking)

- **INFO** — `ROTATE_AT_SESSION_TURNS` is a constant, not policy. Chosen deliberately: it is a
  platform-health limit (like `MAX_ROTATIONS`), model-agnostic, not a per-company business knob.
  If per-company tuning is ever wanted it can be promoted to `CompanyPolicy` on the same path as
  `rotateAtContextPct`.
- **INFO** — on deploy, existing over-long sessions have no `session-turns` meta, so they start
  counting from 0 and rotate within the next 300 turns rather than immediately. Acceptable — a
  container rebuild starts fresh sessions anyway.
