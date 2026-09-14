# Code Review — riff_transcript MCP tool

**Verdict:** ✅ APPROVED (LOW/INFO only)
**Reviewer:** Marvin (generic three-pass; no PE matches host-side `src/mcp/*.ts`)
**Reviewed SHA:** 127d009 (pre-commit review of working-tree changes)
**Scope:** `src/mcp/client.ts`, `src/mcp/server.ts`, `test/mcp.test.ts`

## What changed

An operator MCP tool to read a shift's audit transcript and filter it to the
entries that matter — closing the gap that forced `docker/up.sh exec … node -e`
against `transcript.db` (a build-utility workaround, not an operator endpoint).

- `shapeTranscript(data, {kinds?, errorsOnly?})` — pure filter, mirrors
  `shapeEvents`. `kinds` keeps named entry kinds; `errorsOnly` keeps errored tool
  results (`meta.isError`) and any shift `result` whose `subtype !== 'success'`.
  Reports `scanned`/`shown` so a filtered page is honest about coverage.
- `RiffClient.transcript(slug, {agent, session?, after?, limit?, kinds?, errorsOnly?})`
  — a thin GET on the existing `/api/transcript`. Small page (60) unfiltered so a
  long shift is not dumped through the model; large page (500, up to 2000) when
  filtering so "the errors in this shift" is one call.
- `riff_transcript` tool wiring in the MCP server.

Endpoint unchanged — so no container rebuild, and the API stays the single source
of truth (no second path to the data).

## Verification

- `npm run check` — clean.
- `npm test` (mcp) — 10 pass: pure `shapeTranscript` (kinds, errorsOnly incl.
  success-is-not-an-error, scanned/cursor passthrough) + client URL shape
  (default limit 60, filtering 500, session param) + reply shaping.
- **Live**, against the running ShipIt shift via the gateway API (the sanctioned
  read path for a running company): `transcript(shipit, {agent: lynn,
  errorsOnly: true, limit: 2000})` scanned 163 turns, returned 4 real errors
  (a bwrap sandbox miss, two path misses, a leg result). Sessions list returned
  for selection.

## Findings

### ℹ️ INFO-001 — result turns carry `costUsd` in `meta`; the tool returns meta verbatim
A `result` turn's `meta` includes the imputed `costUsd`. The tool returns turns
faithfully (the description says "never report dollars"), leaving the
report-percentages-not-dollars discipline to the caller, as the Desk Shift viewer
does at its display layer. Faithful-read over data-mutation is the right call for
an audit tool; flagged for awareness.

### ℹ️ INFO-002 — filtering is per-page, not a whole-shift drain
`errorsOnly`/`kinds` filter the fetched page. For shifts over the (raised) page
size, the caller pages with `after`=nextAfter — documented in the tool
description and surfaced by `scanned`/`more`. Auto-drain was considered and
rejected: it would pull a large session on every call and muddy the cursor.

## Notes

Host-side (the riff MCP server runs on the operator's machine over the gateway
API), so no container rebuild — but the new tool reaches a running session only
after the MCP server reconnects (next session). Validated this round via the
client directly against the live gateway.
