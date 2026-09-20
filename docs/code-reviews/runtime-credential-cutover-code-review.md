# Code Review — runtime-credential cutover (agents route through the keyproxy)

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff, generic three-pass (security-focused) + adversarial re-read — all TS/secrets-path, no `.vue`, no `docker/` |
| Reviewed SHA | c7a21a9 |
| Files | `src/core/config.ts`, `src/keyproxy/main.ts`, `src/runtime/staff.ts`, `src/runtime/credential.ts`, `src/company/registry.ts`, `src/gateway/server.ts`, `test/{container,services,settings,shift-env}.test.ts` |
| Verdict | ✅ APPROVED |

## What changed

The foundation (`6698d00`) stored a runtime credential; this uses it. The agents'
own Claude inference now goes through the keyproxy's reserved `_runtime` route, so
the real token lives one container away and no shift — nor anything it spawns —
holds the raw credential. Follows the foundation; the Docker token delivery is
still in place but inert (stripped from every shift env), retired in a follow-up
once the proxy path is verified live.

## Method

Generic three-pass (Architecture → Correctness → Security) + adversarial re-read,
run by the calling agent (no matching stack PE; no `.vue`/`docker` in this diff).
SECURITY.md + CLAUDE.md re-read. `npm run check` clean; `npm test` 655; `npm run
test:ui` 74.

## Findings

No CRITICAL / HIGH / MEDIUM.

### Verified (adversarial pass)

- **`_runtime` is unspoofable + fails closed.** Built in the keyproxy, never read
  from `cfg.services`, and `service === '_runtime'` is special-cased before the
  declared-route lookup; `SERVICE_NAME_RE` bars any company from declaring the name
  (now unit-tested). Type and token resolve from the SAME tier (per-company or
  install), and a missing token 502s with a fix message rather than forwarding
  unauthenticated. Upstream is the hardcoded Anthropic host, so the plaintext guard
  holds; credential injected last over the static headers.
- **The raw token cannot reach a shift.** `shiftChildEnv` deletes
  `CLAUDE_CODE_OAUTH_TOKEN` from the child env and sets `ANTHROPIC_BASE_URL` + a
  scoped `ANTHROPIC_AUTH_TOKEN`, so the SDK authenticates only through the proxy and
  a spawned product harness inherits a scoped, capped token — F-044 declawed.
- **The preflight fires in production and no-ops in tests.** `runtimeCredentialHealth`
  is gated on `shellIsContained()`; `RIFF_CONTAINED=1` is set in the Dockerfile
  runtime stage (verified), so the gateway-in-factory gates on the vault, while
  host/test runs (no container marker) answer live and never block found-and-run.
  Boot resume is per-company: an unresolvable credential is held, not woken.

### Awareness / deferred (INFO)

- **Dead code:** `startCredentialHealth` / `credentialHealth` / `readRecord` are no
  longer called (the gateway uses `runtimeCredentialHealth`). They and their tests
  are valid pure logic tied to the record-delivery mechanism; removed in the
  Docker-retirement follow-up rather than churned here.
- **HTTP-level `_runtime` test deferred:** the synthesized route's upstream is the
  hardcoded Anthropic host, so a full proxy-forward test needs a test override of
  `RUNTIME_UPSTREAM`; the resolution/shape logic is unit-tested and the forward is
  proven at deploy-verify. Fast-follow before the Docker retirement.
- **`withoutSecrets` redaction unchanged:** the scoped `ANTHROPIC_AUTH_TOKEN` is
  per-shift (not in `process.env`, so the env-keyed redaction cannot see it) and is
  a bounded capability; its `Bearer <token>` form is already caught by the regex.
- **Company-less shift edge:** with no `companySlug`, `scopedSecretEnv` returns `{}`
  and the token is not stripped — not reachable through the gateway preflight, which
  requires a company. Non-issue.

## Next (post-verify)

Deploy (`up --build`), operator sets the runtime token in Riff Settings, verify a
live call through `/svc/_runtime` before any shift, then the Docker-retirement
commit (compose/up.sh/entrypoint + `container.test.ts` flip + SECURITY.md).
