# Code Review — runtime-credential Docker retirement

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Dispatched `code-reviewer:pe-aws-infra` five-pass on the docker/ diff + generic security three-pass (by the calling agent) on the TS/secrets path, tests and SECURITY.md |
| Reviewed SHA | 104a937 (fixes in 742d89b) |
| Files | `docker/compose.yaml`, `docker/up.sh`, `docker/entrypoint.sh`, `docker/.env.example`, `src/runtime/credential.ts`, `src/gateway/server.ts`, `SECURITY.md`, `test/{container,credential}.test.ts` |
| Verdict | ✅ APPROVED |

## What changed

The final commit of the runtime-credential externalization. The agents' Claude
token used to be a factory env var (readable by any in-box shell and by
`docker inspect`); it now lives encrypted in the keyproxy's vault, injected on the
reserved `_runtime` route with a scoped per-shift token. This retires the now-dead
Docker delivery: the `CLAUDE_CODE_OAUTH_TOKEN` / `RIFF_WAIT_FOR_CREDENTIALS` env,
`up.sh`'s ~150 lines of token/record/`creds` machinery, the entrypoint
credentials-wait, and the dead `credentialHealth`/`startCredentialHealth`/
`readRecord`/`OauthRecord`. `check` now validates the compose config; the
SECURITY.md token section is rewritten to the vault model.

## Method

`pe-aws-infra` five-pass on `docker/` (its own Bash: 56 docker/credential tests,
shellcheck, dead-code search). Calling agent ran the generic three-pass
(Architecture → Correctness → Security) on the credential/gateway/test/doc
portion; SECURITY.md + CLAUDE.md re-read. `npm run check` clean; `npm test` 634;
`npm run test:ui` 75. **Verified live post-deploy:** `docker inspect` on the
factory shows no token or credential, the stack boots healthy (gateway 200), and
`/svc/_runtime` returns 200 with a token set / 502 fail-closed with none.

## Findings

No CRITICAL / HIGH / MEDIUM.

### pe-aws-infra (docker/)

- **LOW-001 — stale compose.yaml threat-model header (FIXED in 742d89b).** The
  header still claimed the factory "has a long-lived Claude token" and pointed at
  `cp .env.example .env # put your token in it` + raw `docker compose up --build`
  (which bypasses `up.sh`'s drain-before-recreate). No functional defect — the
  actual controls are intact and test-covered — but the file that is supposed to
  state the threat model disproved itself. Rewritten: the factory holds no token
  (authenticates through the keyproxy on a scoped token); quick-start points at
  `docker/up.sh up --build`.
- **INFO-001 — orphaned `RIFF_HOLD_PAUSED` narration (FIXED in 742d89b).** The
  entrypoint no longer sets it; `server.ts` still read it with a comment
  describing the deleted flow. Kept as a deliberate operator-only blanket-hold
  override; the comment now says so, and names the per-company
  `runtimeCredentialHealth` resume filter as the automatic hold.
- **INFO-002 — operators' local `docker/.env` may keep inert credential lines
  (FIXED in 742d89b).** `up.sh`/`compose.yaml` no longer read `RIFF_TOKEN_CMD` /
  `RIFF_CREDENTIALS_CMD` / `CLAUDE_CODE_OAUTH_TOKEN`; a leftover line is now dead
  exposure. Added a SECURITY.md migration note to delete them.

Verified by pe-aws-infra: the security claim is wired (the resume filter plus the
`refuseIfNoCredential` 503 gate at the wake/start endpoints); shellcheck clean
(the lone SC1007 on `CDPATH= cd` is a deliberate idiom); no lingering references
to the retired machinery in `src/` or `desk/`.

### Calling agent (credential / gateway / tests / SECURITY.md)

- **No orphaned references.** A repo-wide grep for the retired names finds only
  the intentional inverse-guards in `container.test.ts` and the operator-local
  gitignored `docker/.env*` (not tracked; only `.env.example` is).
- **`runtimeCredentialHealth` resolves as the keyproxy does** (own vault vs
  install vault), fails closed, and is gated on `shellIsContained()` so host/test
  runs answer live — now unit-tested (`credential.test.ts`, 3 cases).
- **The container tests assert real invariants**, flipped from "compose must
  require the token" to "the token appears nowhere", "the entrypoint no longer
  waits", "the launcher resolves/delivers no credential", and "`check` runs
  `config`, not `up`".
- **SECURITY.md matches the shipped model** and preserves the checked claim the
  denylist test depends on ("neither is the proxy").

## Deferred

- **Hermetic HTTP `_runtime` keyproxy test.** The forward mechanics are covered by
  the identical-shape `anthropic` declared-route test; resolution is unit-tested
  and proven live (200/502). A hermetic version would require weakening
  `RUNTIME_UPSTREAM` from a hardcoded host to an overridable one — kept hardcoded
  as a security property instead.
- **Switcher menu-widget a11y** (from the deploy-polish review, unchanged).
