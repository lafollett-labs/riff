# Code Review: audit-recorder

**Verdict:** ✅ APPROVED

| | |
| - | - |
| **Branch** | `main` |
| **Reviewer** | @Cali LaFollett |
| **Review Round** | 1 |
| **Reviewed SHA** | `e246e75e926a1e55623c932c7ae14fa4e7f40555` |
| **Title** | Record a company's own audit trail from the SDK stream (transcript.db) |
| **Files Changed** | 8 |
| **Lines Changed** | +375 / -7 |
| **Date** | 2026-09-13 |

---

## Summary

Increment 1 of the "review a shift" feature. Instead of parsing Claude Code's
private JSONL transcripts (provider-locked, schema we don't own), record our own
audit from the SDK message stream `tick()` already consumes — assistant text,
reasoning, tool calls + results, final tally — into a per-company `transcript.db`
beside the ledger. Storage is a separate db (not a ledger table) to keep the
governance ledger lean and isolate the high-volume write path. Threaded genesis →
registry → scheduler → tick; travels on export/import; closed in the registry
lifecycle. Generic three-pass (TS-only, no matching PE). `npm run check` clean,
`npm test` 588/588 (12 new). No in-scope defects; two INFO.

---

## Findings Overview

| Severity | In Scope | Out of Scope |
| -------- | -------- | ------------ |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 0 | 0 |
| 🟢 LOW | 0 | 0 |
| ℹ️ INFO | 2 | 0 |

---

## In Scope Findings

### ℹ️ INFO-001: No retention/pruning yet — the store grows unbounded

**Domains:** [Operations]
**Location:** `src/ledger/transcript.ts`

Every shift appends turns forever; nothing prunes old sessions. Per-block text is
capped at 200KB, so a single row can't run away, but the file grows with company
age. Acceptable for now — it's a *separate* db, so growth never threatens the
governance ledger, and pruning/retention is a clean follow-on (a `DELETE FROM turns
WHERE at < ?` plus a policy knob). Noted so it's a deliberate deferral, not a
forgotten one.

### ℹ️ INFO-002: Recording adds synchronous SQLite writes to the message loop

**Domains:** [Performance]
**Location:** `src/runtime/staff.ts` (the `for await (const m of q)` loop)

Each SDK message triggers one or more synchronous `INSERT`s. At SQLite's throughput
(thousands/sec, ~microseconds each) this is negligible against model latency, and it
writes to a separate db so it doesn't block ledger writes. On the container's `/data`
(real disk) this is a non-issue; flagged only so the hot-path cost is on record.

---

## Architecture (Pass 1)

`transcript` is threaded exactly like `ledger` (genesis.found → registry #build →
Scheduler Deps → TickDeps), added to `Company`, and closed alongside the ledger. The
recorder (`recordShiftMessage`) is a pure mapping from `SDKMessage` to store rows,
exported for testing; the store (`TranscriptStore`) owns SQLite the same way `Ledger`
does (own schema, WAL, busy_timeout). Separate-db choice documented in the class
comment with the reasoning (governance ledger stays lean; blast radius contained).

## Quality + Tests (Pass 2)

`npm run check` clean; `npm test` 588/588. New coverage: store append/seq/ordering,
per-session numbering, meta round-trip, 200KB clip; recorder mapping for assistant
(text/thinking/tool_use), user (string + tool_result, string-content and block-content
forms), result tally, empty-text skip, and fail-soft ("a broken sink cannot fail a
shift"); and a transfer round-trip proving the audit travels with a moved company.

## Security (Pass 3)

- **Fail-soft**: `recordShiftMessage` wraps every path in one try/catch — a recording
  error (disk full, bad message) can never fail a shift. Proven by the broken-sink test.
- **Ordering**: recording runs *before* the blind / tools_missing `break`s, so a turn
  that is then cut off is still on the record — the audit doesn't lose the last thing an
  agent did before the lights went out.
- **Isolation**: separate db → no added WAL contention on the governance ledger;
  cross-company isolation unchanged (each company's `transcript.db` is in its own home).
- **No secret exposure**: records assistant/tool content, never the subscription token or
  scoped proxy tokens (those live in env, not in message content). Base64 thinking
  signatures are dropped (only `thinking` text is kept).
- **Transfer**: `transcript.db` copied via `VACUUM INTO` (clean single-file snapshot,
  no WAL to carry), guarded by existsSync; carries no resume state to strip (unlike
  `session:*` meta), so it lands as a valid historical record.

---

## Files Reviewed

| File | Findings |
| ---- | -------- |
| `src/ledger/transcript.ts` | 1 INFO |
| `src/runtime/staff.ts` | 1 INFO |
| `src/company/genesis.ts` | 0 |
| `src/company/registry.ts` | 0 |
| `src/runtime/scheduler.ts` | 0 |
| `src/company/transfer.ts` | 0 |
| `test/transcript.test.ts`, `test/transfer.test.ts` | 0 |

---

## Merge Eligibility

**Locked to SHA:** `e246e75e926a1e55623c932c7ae14fa4e7f40555`
**Status:** ✅ Mergeable IF `git rev-parse HEAD == e246e75e926a1e55623c932c7ae14fa4e7f40555`. Any commit after this SHA invalidates this round and requires re-review.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
