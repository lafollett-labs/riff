# Code Review — session-turn rotation as a company policy field

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff (mixed: generic three-pass for TS runtime + pe-vue for the Desk dial) |
| Review round | 1 |
| Reviewed SHA | 531d561 (working tree) |
| Files | `src/core/config.ts`, `src/runtime/staff.ts`, `src/runtime/scheduler.ts`, `src/company/registry.ts`, `test/rotation.test.ts`, `desk/src/views/Overview.vue` |
| Verdict | ✅ APPROVED |

## What changed

The session-turn rotation bound shipped one commit earlier as a constant
(`ROTATE_AT_SESSION_TURNS = 300`). This promotes it to a per-company **policy
field** `rotateAtSessionTurns` (integer, clamped 0–100000, default **600**, 0 =
off) so it is tunable per company and live via `riff_update` — no container
rebuild to change the dial. `shouldRotate` now takes `maxSessionTurns` as a
parameter instead of reading a constant. The field flows through the same path
as `rotateAtContextPct` (`CompanyPolicy` → `DEFAULT_POLICY` → `readPolicy` clamp
→ `registry` → `Scheduler` opts → `TickDeps` → `shouldRotate`) and gains a dial
in the Desk Tune panel.

Default raised 300 → 600 on the chair's call: rotation should be a hygiene
ceiling, not a routine event, since the mid-leg stream-death recovery already
handles the acute failure gracefully. 600 sits well above a normal work span and
well below where a control stream was seen to die (4367).

## Method

Mixed diff. Generic three-pass (Architecture → Quality/Correctness → Security) +
adversarial re-read over the TS runtime files, run by the calling agent.
`pe-vue` dispatched for `desk/src/views/Overview.vue` (five-pass). `npm run check`
clean; `npm test` 624/624; `npm run test:ui` 71/71.

## Findings

No CRITICAL / HIGH / MEDIUM.

### Fixed during review

- **LOW (pe-vue LOW-001)** — the new dial label read `"Fresh conversation after N
  turns"`, using an algebra "N" out of step with the panel's plain-language voice.
  Changed to `"Fresh conversation by turn count"` per pe-vue's recommendation.
  Cosmetic; no test references the string; `test:ui` re-run green.

### Verified non-issues

- **Live-tune merges, not clobbers.** `registry.update` composes the patch as
  `readPolicy({ ...readPolicy(cfg.policy), ...patch.policy })` (`registry.ts:372`),
  so `riff_update({ policy: { rotateAtSessionTurns: X } })` preserves every other
  policy field. A policy change is "structural", so it rebuilds the scheduler
  (true of any policy field, pre-existing) — no container rebuild, but it does
  restart the scheduler, so it is best changed between runs.
- **`0` = off is preserved.** `d.rotateAtSessionTurns ?? DEFAULT_POLICY...` uses
  `??`, not `||`, so an explicit 0 is honored; `shouldRotate` guards the trigger
  with `maxSessionTurns > 0`. Both defaults (config `DEFAULT_POLICY` and the
  scheduler's own default block) are 600.
- **Dial ↔ clamp agreement (pe-vue).** Dial `min:0 max:100000` matches the server
  clamp `[0, 100000]` exactly, and 600 is step-aligned (600 ÷ 50), so closing the
  panel never shows a value different from what was set in range.
- **Editor-coverage guard passes (pe-vue).** `policy.test.ts` scrapes
  `key: '<field>', label:` and asserts every schema field is editable and none is
  stray — the all-alpha `rotateAtSessionTurns` key satisfies both.
- **Back-compat.** `shouldRotate`'s guard order is unchanged in effect; all prior
  context-% cases still pass alongside the new turn-cap cases.
- **Security.** No security-boundary file touched; value bounded by the clamp; the
  Desk field flows through the existing typed client (`desk/src/api.ts` unchanged).

### INFO (deferred — awareness)

- **INFO (pe-vue INFO-001)** — each dial is a `<label>` wrapping both its text and
  its multi-sentence hint, so a screen reader folds the whole hint into the
  input's accessible name. **Pre-existing and panel-wide**, not introduced here.
  Scheduled to be fixed in the upcoming Tune-panel grouping refactor via
  `aria-describedby`, alongside sectioning the growing dial list.
