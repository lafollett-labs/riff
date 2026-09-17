# Code Review — inbox message ops (read-by-id + mark-read)

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff (generic three-pass; no matching PE — TS runtime) |
| Review round | 1 |
| Reviewed SHA | 1cc9af5 |
| Files | `src/mcp/client.ts`, `src/mcp/server.ts`, `test/mcp.test.ts` |
| Verdict | ✅ APPROVED |

## What changed

Two steps of the board-mail loop had no MCP tool: marking mail read (a curl to
`/api/inbox/read`) and reading one specific message (pull the whole inbox, pick
by hand). Both added as thin wrappers over existing endpoints.

1. **`riff_inbox` `ids` filter** — `shapeInbox` gains `ids`, returning exactly
   the named messages' full bodies, composing before `unreadOnly` then `limit`.
   The "open these" step, symmetric with the ids that mark them.
2. **`riff_mark_read`** — `RiffClient.markRead` → `POST /api/inbox/read?c=slug`:
   name `ids` to mark those, omit to mark the whole inbox, `read=false` to mark
   unread. Returns how many rows changed.

The loop is now one surface: `riff_inbox` unreadOnly → `ids` to read → mark.

## Method

Generic three-pass (Architecture → Quality+Tests → Security) + adversarial
re-read + self-adversarial. `npm run check` clean; `npm test` 612/612 pass
(1 new test, 1 extended). No PE dispatched — TS backend runtime (`src/mcp/`,
`test/`), matching none of pe-go/pe-vue/pe-aws-infra/pe-governance/pe-devtools.

## Findings

No CRITICAL / HIGH / MEDIUM.

### Verified non-issues (adversarial pass)

- **Body contract.** `markRead` omits `read` when unset, so an ids-only call
  sends `{ ids: [...] }` and the server's `read !== false` default applies —
  confirmed by the live run that cleared the four ShipIt messages (`marked: 4`)
  and by the test asserting the empty-opts call sends `{}`.
- **Read-by-id order.** `ids` returns matches in the inbox's own order, not the
  order the ids were passed — asserted, and the doc comment says so.
- **Empty `ids: []`.** Guarded by `.length > 0`, so an empty array is treated as
  "no filter" (all), consistent with how `shapeEvents` treats empty `kinds`.
- **Surface.** Both tools are on the host operator MCP only; staff agents use the
  separate in-process company server and gain nothing here.
- **Security.** Read-state mutation on the operator's own loopback inbox; no
  secrets, injection, or new dependencies; the gate is untouched.

### LOW / INFO (awareness — non-blocking)

- **INFO** — `riff_mark_read` with `ids` omitted marks the **entire** inbox. It
  is read-state only, reversible (`read=false` un-marks), operator-only, and the
  tool description states it plainly, so it is a documented convenience rather
  than a footgun. The safe habit — and what the description recommends — is to
  pass the ids you actually handled.
