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

---

## Review Round 2

🚫 PRIOR ROUND INVALIDATED — re-reviewing post-approval changes (a follow-on
increment on the same view, not a fix of round 1).

| | |
| - | - |
| **Branch** | `main` |
| **Reviewer** | Marvin (server/store) + PE-Vue (desk, two rounds) |
| **Review Round** | 2 |
| **Reviewed SHA** | `c955ac6` |
| **Title** | Page, tail, and navigate a recorded shift — cursor read path, auto-drain, live tail, timeline + summary, agent dropdown, content filters |
| **Files Changed** | 7 |
| **Lines Changed** | +430 / -92 |
| **Date** | 2026-09-13 |

### Summary

Follow-on to rounds 1's read path. `/api/transcript` gained a forward cursor
(`after` + `limit` → `more` + `nextAfter`); `TranscriptStore.bySession` pages
`WHERE seq > after ORDER BY seq` (turns_session index), ending the silent 5000-row
truncation. The console auto-drains pages (no button) and tails a running shift
(3s poll + woke/slept, gated on newest-session-and-agent-awake). Presentation
gained a summary card (started / ended-or-last-block / duration-or-elapsed /
blocks / model / session) and a two-column timeline (time + gap-since-previous),
the staff button row became a scaling Agent dropdown, and Thinking/Tool content
filters were added. `costUsd` still never rendered; all agent content
escaped-interpolated.

### Findings Overview

| Severity | Round 1 → Round 2 |
| - | - |
| 🔴 CRITICAL | 0 |
| 🟠 HIGH | 0 |
| 🟡 MEDIUM | 2 raised (drain truncation/switch-race; aria-live flood) → **both fixed & confirmed RESOLVED** |
| 🟢 LOW | 2 (round-1 coverage gap → tests added; round-2 unmount-abort → fixed) |
| ℹ️ INFO | XSS-clean, costUsd-clean, timer lifecycle, drainReq ownership — all verified |

### PE-Vue findings — all resolved pre-commit

| id | Finding | Resolution |
| - | - | - |
| MEDIUM-001 | `drain()` conflated done / busy / error → silent truncation on switch-race, stuck progress line; woke/slept under-filled a >1-page burst | `extend()` returns `{done, progressed}`; `drain()` retries with backoff, stops only on server `done` / reqId change / bounded stalls; woke/slept + tick use `drain()`. **Verified resolved (round 2).** |
| MEDIUM-002 | `aria-live` on the whole log floods AT under drain/tail | log removed from live region; dedicated `.feed-status` `aria-live` status line; `.results` `:aria-busy="loading \|\| more"`. **Verified resolved (round 2).** |
| LOW-001 (r1) | no coverage for drain / live tail / switch-race | e2e added: 510-block drain, wick→fen switch-race, content filters |
| LOW-001 (r2) | in-flight `drain()` not aborted on unmount — keeps paging into a detached component | `alive` flag set false in `onUnmounted`, checked in the drain loop |

### Server/store (Marvin's pass)

- Endpoint params sanitized: `after` `NaN`→0 / negative→0; `limit` clamped [1,2000].
  `more = turns.length === limit` (worst case one extra empty fetch); `nextAfter`
  holds the cursor on a quiet tail poll. Company-scoped inside the resolved block.
- **INFO (non-blocking):** the tail poll recomputes `sessionsFor` (a GROUP BY) every
  3s. Bounded (one agent, `turns_agent` index, ≤50 groups) and single-operator, so
  deferred, not fixed.

### Verification

`npm run check` (incl. SFC) clean. 589 unit + 69 e2e green. Not live-verified in
the container: staff are stopped (weekly usage at 62%, no reset for days) and this
is a pure read-path/UI change whose server code runs under the e2e web server.

### Merge Eligibility

**Locked to SHA:** `c955ac6`
**Status:** ✅ Landed on `main`.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
