# Code Review — riff_state lean read

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff (generic three-pass; no matching PE — TS runtime) |
| Review round | 1 |
| Reviewed SHA | 62d8c02 (working tree) |
| Files | `src/mcp/client.ts`, `src/mcp/server.ts`, `test/mcp.test.ts` |
| Verdict | ✅ APPROVED |

## What changed

`riff_state` returned the whole company on every call — including the founding
charter (`company.business`) and every agent's `mandate` prose, a multi-KB block
a status check or a 15-minute monitor pulls each tick and never reads. It was the
one read with no shaping, the same dump that made a plain inbox read overrun the
token budget.

Add client-side shaping, the pattern `shapeInbox` / `shapeEvents` /
`shapeTranscript` already use:

1. **`shapeState(data, opts)`** — pure exported shaper. `lean` drops
   `company.business` and each `agents[].mandate` and keeps the operational
   surface: run flags, headcount, counts, the roster's live `activity`, dueAt,
   the usage windows. Every other field passes through the spread, so a field the
   endpoint adds later survives the trim. Unfiltered it returns the reply
   untouched (same reference).
2. **`RiffClient.state`** — now async, shapes the reply; `state(slug)` and
   `state(slug, { lean: true })`.
3. **`riff_state` tool** — new `lean` boolean.
4. **Tests** — shaper (drops charter/mandate, keeps operational + unknown fields,
   garbage→empty, full passthrough) and the client integration over the wire.

The endpoint is unchanged — display shaping over the same single API, not a
second path to the data.

## Method

Generic three-pass (Architecture → Quality+Tests → Security) + adversarial
re-read + self-adversarial. `npm run check` clean; `npm test` 614/614 pass
(2 new tests). No PE dispatched — TS backend runtime (`src/mcp/`, `test/`),
matching none of pe-go/pe-vue/pe-aws-infra/pe-governance/pe-devtools.

## Findings

No CRITICAL / HIGH / MEDIUM.

### Verified non-issues (adversarial pass)

- **Opt-in, not default.** `lean` defaults off, so `client.state(slug)` and the
  Desk console (its own client) are unchanged — a caller reading the charter
  still gets it. Matches how `inbox` left its default full and opted into
  `unreadOnly`/`limit`.
- **Sync → async is contained.** `state` returned the `#req` promise directly and
  now `await`s it; the type stays `Promise<RiffResponse>`. The one src caller is
  the `riff_state` handler (a `run()` thunk); `usagePoll` never calls `state`;
  Desk keeps its own client. Every call site already awaits.
- **Drift safety.** `{ ...d, company, agents }` overrides only the two trimmed
  fields and spreads the rest — no allowlist that would silently drop a new
  endpoint field. The `somethingNew` test pins this.
- **No mutation.** `drop` shallow-copies then deletes on the copy; the shaper
  builds fresh `company`/`agents` and shares the untouched fields by reference,
  never writing them.
- **Security.** Read-only shaping of the operator's own loopback state; `lean`
  strictly reduces what crosses the wire. No secrets ride the state reply (vault
  values never do), no injection, no new dependencies; the gate is untouched.

### LOW / INFO (awareness — non-blocking)

- **INFO** — `drop` is defined inside `shapeState`, so it is re-created per call.
  Negligible at a monitor's cadence and kept local to its single user by choice;
  hoisting to module scope would trade that locality for one fewer closure alloc.
