# Code Review — riff_inbox unread/limit filtering

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff (generic three-pass; no matching PE — TS runtime) |
| Review round | 1 |
| Reviewed SHA | e4f57e3 |
| Files | `src/mcp/client.ts`, `src/mcp/server.ts`, `test/mcp.test.ts` |
| Verdict | ✅ APPROVED |

## What changed

`riff_inbox` returned every message with its full body — a ShipIt read came
back 79 messages / 187K characters and overran the token budget, so "do I have
unread?" meant dumping the whole inbox to a file and querying it by hand.

Add client-side shaping, the same pattern `shapeEvents` / `shapeTranscript`
already use over `/api/events` and `/api/transcript`:

1. **`shapeInbox(data, opts)`** — pure exported shaper. `unreadOnly` keeps only
   unread mail addressed to the viewer (`readAt == null && yours === true`);
   `limit` keeps the most recent N (endpoint orders newest-first). `me`, `scope`
   and the `unread` count pass through untouched.
2. **`RiffClient.inbox`** — now async, shapes the reply, and its signature moves
   from a positional `scope?` to an opts object `{ scope?, unreadOnly?, limit? }`.
3. **`riff_inbox` tool** — new `unreadOnly` (boolean) and `limit` (int 1–500).
4. **Tests** — shaper (no-filter passthrough, unreadOnly, limit, garbage→empty)
   and the client integration.

The endpoint is unchanged — display shaping over the same single API, not a
second path to the data.

## Method

Generic three-pass (Architecture → Quality+Tests → Security) + adversarial
re-read + self-adversarial. `npm run check` clean; `npm test` 611/611 pass
(2 new tests). No PE dispatched — TS backend runtime (`src/mcp/`, `test/`),
matching none of pe-go/pe-vue/pe-aws-infra/pe-governance/pe-devtools.

## Findings

No CRITICAL / HIGH / MEDIUM.

### Verified non-issues (adversarial pass)

- **Unread semantics.** `readAt == null && yours === true` was confirmed against
  the live inbox: it selects exactly the 4 messages the endpoint's own `unread`
  count reports, and excludes the chair's own outgoing mail (which shows
  `readAt` null but `yours` false). Loose `== null` catches null and undefined;
  strict `=== true` excludes messages missing a `yours` field.
- **Signature change is contained.** The positional `scope?` → opts-object move
  has exactly two call sites — the `riff_inbox` handler and one test line — both
  updated. Desk keeps its own client (`desk/src/api.ts`), so nothing outside
  `src/mcp` consumes this method.
- **Pattern fidelity.** `shapeInbox` matches `shapeEvents` / `shapeTranscript`:
  `asRecord` guards, tolerant of a non-array `messages`, endpoint untouched.
- **Count integrity.** The `unread` total is passed through, so a filtered view
  still reports the real number rather than the size of the filtered slice.
- **Security.** Read-only path; no secrets, injection, or new dependencies; the
  gate and the `scope: 'all'` behavior are unchanged.

### LOW / INFO (awareness — non-blocking)

- **INFO** — `limit` takes `slice(0, N)`, trusting the endpoint's newest-first
  order. Verified: `ledger.messagesFor` returns strictly descending by `sentAt`,
  and the comment documents the assumption. This is the same "trust the
  endpoint's order" contract `shapeTranscript` already relies on for paging; if
  the ledger's order ever changed, the shaper would need a sort.
