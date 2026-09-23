# Code Review — time as a shift's budget, turns as a runaway net

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | generic review with adversarial passes, two rounds; `tick()` driven end to end on a scripted `query`; live probes in a throwaway company (`landing-probe`, since deleted) |
| Base SHA | 5ae9e25 |
| Files | `src/runtime/staff.ts`, `src/core/config.ts`, `src/runtime/scheduler.ts`, `src/analytics/{vitals,types}.ts`, `desk/src/views/{CompanySettings,Vitals}.vue`, `test/{shift-landing,ceiling}.test.ts` |
| Verdict | ✅ APPROVED (round 2) |

## Origin

On 2026-09-23 one of Lynn's legs on ShipIt ran 92 sequential top-level tool
calls against `maxTurns` 75, and the CLI reported `success` with `num_turns`
93. Riff only labelled an ending (`atCeiling`) and never enforced the ceiling
itself. Cali's call was that time should be the budget, the turn setting a
configurable runaway net, and the agent should be warned as the end nears.

## Measured live

The probes ran on the factory build.

| Probe | Outcome |
| - | - |
| a 1-minute shift | the agent quoted the 75% notice, saved a memory, and ended the shift itself at 56s |
| the notices told to be ignored | Riff stopped the shift between tool calls at 64s: `landed: time`, no `shift.overran` |
| `maxTurns` 3 | Riff stopped the shift after the third batch, before the CLI's own ceiling fired; the turn notice was delivered |

## Round 1 — changes requested

- **L1 HIGH (fixed)**: the backstop counted tool-call messages. The CLI emits
  one per content block, and a subagent's calls come the same way, so ordinary
  shifts would have been interrupted early. A turn is now one top-level
  response, deduplicated by `message.id`.
- **L2 MEDIUM (fixed)**: a subagent's batches spent the leg's turns and took
  the agent's one-time notice. A batch with `agent_id` set is now ignored.
- **L3 MEDIUM (fixed)**:
  - A hand-over that spent its six turns marked the whole shift as cut.
  - Running out of time during a hand-over dropped the conversation and started
    a cold leg after the deadline.
  - Both are now kept apart, and the conversation is kept.
- **L4 LOW (fixed)**: the journal and Vitals called a time landing "the turn
  ceiling". Vitals now counts `outOfTime` separately.
- **L5 LOW (fixed)**: no rotation once 75% of the time is spent.
- **L6 INFO (fixed)**: `TickDeps.now`, so the time tests are deterministic.

## Round 2 — approved

- **L9 LOW (follow-up)**: a subagent that is still making tool calls at the
  deadline is not stopped between calls. It is killed at the grace limit
  instead. Measure what `continue:false` does inside a subagent first.
- **L10 INFO (fixed)**: a message with no id counts as a new turn.

✅ **APPROVED.**
- `npm run check`: clean.
- `npm test`: 738 of 738 on the host and 738 of 738 in the factory image.
- `test:ui`: 83 of 83.
- Each fix has a `tick()`-level test that fails when the fix is removed.
