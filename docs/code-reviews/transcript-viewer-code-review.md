# Code Review: transcript-viewer

**Verdict:** ✅ APPROVED

| | |
| - | - |
| **Branch** | `main` |
| **Reviewer** | @Cali LaFollett (server) + PE-Vue (desk) |
| **Review Round** | 1 |
| **Reviewed SHA** | `8ddae41de49f796575b2c4362a30d92cbfe68703` |
| **Title** | Review a shift in the console — `/api/transcript` + Desk "Shift" view |
| **Files Changed** | 5 |
| **Lines Changed** | +191 / -1 |
| **Date** | 2026-09-13 |

---

## Summary

Increments 2–3 of the "review a shift" feature: a `GET /api/transcript` endpoint
serving a company's own audit from `transcript.db`, and a Desk "Shift" tab that
renders it as a conversation (prompt, assistant words, tool calls + results, tally).
The `.vue` changes were reviewed by PE-Vue with first-class attention to XSS on
untrusted agent content, accessibility, and reactivity; the server endpoint got a
generic pass. Both critical guarantees verified clean: **no XSS vector** (all agent
output through escaped interpolation, no `v-html`) and **costUsd never displayed**.
All seven PE-Vue MEDIUM findings and both LOW were fixed before this landed.
`npm run check` clean; `npm run test:ui` 65/65 (new Shift e2e included).

---

## Findings Overview

| Severity | In Scope | Out of Scope |
| -------- | -------- | ------------ |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 7 (all fixed) | 0 |
| 🟢 LOW | 2 (both fixed) | 0 |
| ℹ️ INFO | 2 | 0 |

---

## PE-Vue findings — all resolved pre-commit

| id | Finding | Resolution |
| - | - | - |
| MEDIUM-001 | Session `<select>` unlabeled for AT | `id`/`for` pairing added |
| MEDIUM-002 | Agent picker selection by color alone | `:aria-pressed` added |
| MEDIUM-003 | `load()` race — stale response overwrites fresh | monotonic `reqId` guard |
| MEDIUM-004 | Fetch failure shown as empty (not errored) audit | `error` ref + explicit error state |
| MEDIUM-005 | `agent.slept` refetch drops the picked session | refetch passes `session.value` |
| MEDIUM-006 | `v-for` keyed by index → `<details>` state bleeds across agents | keyed by `${sessionId}:${seq}` |
| MEDIUM-007 | `prettyInput`/JSON reparse on every state poll | precomputed `rows` computed off `turns` |
| LOW-001 | Hardcoded `#e06c6c` | `var(--alert)` token |
| LOW-002 | Log region updates silently for AT | `aria-live="polite"` + `aria-busy` |
| INFO-001 | `watch(state.slug)` redundant (remount re-picks) | removed |
| INFO-002 | XSS + costUsd critical checks | verified clean, no change needed |

## Server endpoint (generic pass)

- `/api/transcript` sits inside the resolved-company block, so it is company-scoped by
  `?c=` like every other read; no cross-company reach. No auth, consistent with all read
  endpoints. `agent` required → 400. Thin delegation to the already-tested
  `TranscriptStore.sessionsFor` / `bySession`; the only new logic is default-session
  selection (one line).
- **INFO:** the response is bounded by `bySession`'s 5000-row limit and the store's
  200KB-per-block write cap, so a realistic shift is a few MB; a pathological
  thousands-of-large-blocks session could be larger. Pagination is the clean follow-on
  if sessions ever grow that big. Non-blocking.

## Verification

`npm run check` (incl. SFC typecheck) clean; `npm run test:ui` 65/65 including
`a shift can be reviewed agent by agent, and says so honestly when empty`. Live endpoint
verification (real recorded turns served) done post-rebuild against ShipIt.

---

## Files Reviewed

| File | Findings |
| ---- | -------- |
| `desk/src/views/Shift.vue` | 9 (all fixed) + 2 INFO |
| `desk/src/App.vue` | 0 |
| `desk/src/api.ts` | 0 |
| `src/gateway/server.ts` | 1 INFO |
| `e2e/desk.spec.ts` | 0 |

---

## Merge Eligibility

**Locked to SHA:** `8ddae41de49f796575b2c4362a30d92cbfe68703`
**Status:** ✅ Mergeable IF `git rev-parse HEAD == 8ddae41de49f796575b2c4362a30d92cbfe68703`. Any commit after this SHA invalidates this round and requires re-review.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
