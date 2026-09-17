# Code Review — riff_archive MCP tool

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff (generic three-pass; no matching PE — TS runtime) |
| Review round | 1 |
| Reviewed SHA | 08baef9 |
| Files | `src/mcp/client.ts`, `src/mcp/server.ts`, `test/mcp.test.ts` |
| Verdict | ✅ APPROVED |

## What changed

A `riff_archive` MCP tool over the existing `DELETE /api/companies/<slug>`
endpoint (`registry.archive` — moves the company dir to the archive area with
git history, drops its vault, not a delete). Before this, archiving had no tool;
an operator hand-rolled a `curl`.

1. **`RiffClient.archive(slug)`** — a thin `#req('DELETE', …)` with the slug
   `encodeURIComponent`'d into the path and no body, matching `update` /
   `setRunning`.
2. **`riff_archive` tool** — registered on the host operator surface only,
   between `riff_update` and `riff_say`. Description states it is not a delete
   (dir kept, re-importable) and that a running company should be paused first.
3. **Test** — asserts method + URL, that no body is sent, and response
   passthrough.

## Method

Generic three-pass (Architecture → Quality+Tests → Security) + adversarial
re-read + self-adversarial. `npm run check` clean; `npm test` 609/609 pass
(1 new test). No PE dispatched — the diff is TS backend runtime (`src/mcp/`,
`test/`), matching none of pe-go/pe-vue/pe-aws-infra/pe-governance/pe-devtools.

## Findings

No CRITICAL / HIGH / MEDIUM.

### Verified non-issues (adversarial pass)

- **Surface boundary.** The tool is registered in `src/mcp/server.ts`, the host
  operator MCP (`mcp__riff__*`, launched from `.mcp.json` against the loopback
  gateway). Staff agents get the separate narrow in-process company server, so
  this does not hand agents the power to archive a company.
- **No drift.** The endpoint knowledge stays in `RiffClient`; the tool is a thin
  `run(() => client.archive(c))`, consistent with the client's stated reason to
  exist (one path to the API, no second implementation).
- **Path safety.** A hostile or malformed slug (`../foo`) is `encodeURIComponent`'d
  and then fails `registry.has(slug)` server-side → 404, surfaced by `present()`
  as an `isError` result. No traversal.
- **No body on DELETE.** `#req` omits the body and content-type when `body` is
  `undefined`; the server's DELETE arm reads no body. The test pins this so a
  future stray body cannot be misread as an update.
- **Security surface.** No secrets, injection, or new dependencies. Auth posture
  is unchanged — the gateway is loopback-bound, which is the existing boundary,
  not something this diff relaxes. `dropVault` on archive is existing endpoint
  behavior, not introduced here.

### LOW / INFO (awareness — non-blocking)

- **INFO** — nothing guards against archiving the active or last remaining
  company; the installation can be left with none. This is pre-existing
  `DELETE /api/companies` behavior and a product decision for the endpoint, out
  of scope for a thin client wrapper that must not grow a second policy.
- **INFO** — "pause the company first" in the description is advisory, not
  enforced. It is accurate: the endpoint stops a running company without
  draining (`registry.archive` closes with `drain:false`), so the note tells the
  operator the truth rather than gating on it.
