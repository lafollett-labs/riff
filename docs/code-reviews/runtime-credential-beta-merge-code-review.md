# Code Review — runtime route anthropic-beta merge

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Generic security three-pass (by the calling agent) on the keyproxy diff + hermetic test + live production proof |
| Reviewed SHA | 421dde5 |
| Files | `src/keyproxy/main.ts`, `test/keyproxy.test.ts` |
| Verdict | ✅ APPROVED |

## What changed

The first live ShipIt run after the cutover failed every long-context shift in
~2 seconds: `400 context_management: Extra inputs are not permitted`. Diagnosis —
the runtime route injects `anthropic-beta: oauth-2025-04-20` as a static header,
and the keyproxy's static-header injection **replaced** the caller's value.
Claude Code sends its own `anthropic-beta` carrying the context-management beta
its auto-compaction needs; replacing it dropped that beta, so the API rejected
the request body's `context_management` field. The fix: `anthropic-beta` is a
comma-separated list, so the proxy now **merges** the route's flag into the
caller's list (deduped) for that one header; every other static header still
wins outright.

## Method

Generic three-pass (Architecture → Correctness → Security) + adversarial re-read
on the keyproxy diff; SECURITY.md re-read. Hermetic test added: the fake upstream
sees both the caller's betas and the route's oauth flag. **Proven live:** a real
Opus-5 shift (Carver) that failed in ~2s on the 400 cleared compaction and ran
(observed `awake` and working, no `agent.failed`) after redeploy. `npm run check`
clean; `npm test` green; the keyproxy suite is 16/16 including the merge test.

## Findings

No CRITICAL / HIGH / MEDIUM.

### Verified (adversarial pass)

- **No new exposure.** The merge only affects the caller's OWN inference request
  on the runtime route. A shift already controlled every request header the route
  did not overwrite; letting it also contribute `anthropic-beta` values (which the
  CLI legitimately sets) enables beta features on its own request and nothing
  more. No cross-company reach, no credential exposure.
- **The credential still wins.** It is injected last (`headers[injectHeader]`),
  after the header loop, so no caller-supplied or merged header can shadow it. The
  upstream stays the hardcoded Anthropic host, so the plaintext guard holds.
- **No header-injection surface.** The merged value is a comma-join of trimmed,
  non-empty tokens; `node:http` rejects control characters in incoming headers at
  parse, so CR/LF cannot ride in through the caller's `anthropic-beta`.
- **Scoped to one header.** Only `anthropic-beta` merges; `user-agent`,
  `anthropic-version` and any other static header keep the "route wins" semantics
  the static-headers feature was built for.

## Note

`anthropic-version` (`2023-06-01`) and `user-agent` are still injected as
route-wins. They were not the cause (the beta was), and the CLI sends the same
`anthropic-version`, so overwriting is a no-op there; left as-is.
