# Code Review — retire_project sign-off

**Verdict:** ✅ APPROVED (only LOW + INFO findings)
**Reviewer:** Marvin (technical oversight), with an independent adversarial pass by a fresh reviewer agent
**Review Round:** 1
**Reviewed SHA:** 127d009 (pre-commit review of staged changes; not yet landed)
**Scope:** Staged diff — `git diff --cached`

## What changed

`retire_project` (the company MCP tool that deletes a project directory tree)
used to gate on `world.write`, which the gate allows outright for any active
agent — so any lead could delete a project with no sign-off, a sharper edge than
`retire_role`, which has always escalated. It now gates on a new capability,
`project.retire`, added to the constitution's `executiveApproves`, so a
non-CEO's retirement escalates to the CEO (R2) and the CEO's own retirement is
allowed (R2.ceo_self) — exactly mirroring how `retire_role` signs via `hire`.

| File | Change |
| - | - |
| `src/core/types.ts` | `'project.retire'` added to `CAPABILITIES` |
| `src/policy/rules.ts` | `'project.retire'` added to `executiveApproves` |
| `src/runtime/tools.ts` | `retireProject` gates on `project.retire` + carries `{ project, why }` payload; capability-map entry updated |
| `src/runtime/executor.ts` | new `case 'project.retire'` in `applyApproved` — an approved retirement removes the tree and emits `project.retired`; without it, an approved retirement would hit the default no-op |
| `test/gate.test.ts` | R2 escalation + CEO-self-allow for `project.retire` |
| `test/executor.test.ts` | new — the approved retirement removes the tree, is idempotent, and fails loudly when the project is already gone |

## Verification

- `npm run check` — clean.
- `npm test` — 597 pass, 0 fail (36 in the two touched files).
- Gate trace confirmed: `project.retire` routes through R2 (escalate to executive for a lead; `R2.ceo_self` allow for the CEO); R6/R7 (commons/portfolio ceilings), which key on `world.write`, are unaffected — starting a project still rations correctly.
- Executor: payload shape written by the tool (`{ project, why }`) matches what the case reads; idempotent via the `applied:<id>` meta guard; `world.removeProject` rejects any name containing `/`, `\`, or a leading `.`, so the payload cannot drive a delete outside `projects/`.

## Findings

### 🟢 LOW-001 — approved retirement is name-addressed, not identity-addressed
`in_scope: true`

The approval carries only `{ project, why }`; the executor re-resolves the name
at apply time. If a project were retired (or renamed) and a new project reused
the same directory name inside the approval window, approving the stale request
would delete the new tree. Authorization-fidelity gap, not a traversal or
double-delete bug — idempotency and traversal defenses are intact.

**Disposition:** documented as a known trade-off in the executor case comment.
Not a regression — `retire_role` is id-addressed the same way, and matching it
keeps the two paths one shape. The collision requires deliberate name reuse in a
short window. Stronger identity (a created-at/tree hash captured at request time,
refused on mismatch) is available as later hardening if the pattern ever bites.

### ℹ️ INFO-001 — `world.write_other` escalates to a dead-end (pre-existing)
`in_scope: false`

`world.write_other` is in `executiveApproves` but has no executor case: a
non-CEO Write/Edit to a colleague's file is denied as "Held for approval", the
content is never captured in a payload, and on approval the executor emits
`approval.applied_noop` — nothing is written and nothing tells the requester to
redo it. Effectively "deny with extra steps." Pre-existing, not introduced here;
surfaced because this change's test premise ("a capability that escalates needs
a case") brought it into view. Fixing it needs a payload-carrying draft
mechanism (like `external.write` / `project.retire` now have), not just a case.
**Flagged to the board as a separate governance decision.**

## Notes

Landing is deferred: the change is complete and green but stays uncommitted
until the running ShipIt shift ends, because the container is not rebuilt while a
company is mid-shift (a recreate kills a shift mid-write). Commit + `up --build`
happen together once the shift is stopped.
