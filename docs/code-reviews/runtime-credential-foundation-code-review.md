# Code Review — runtime-credential foundation (install settings + stored credential)

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff (generic three-pass for the TS/secrets-path + gateway; pe-vue for the Desk views) |
| Review round | 1 (one MEDIUM + one MEDIUM + two LOW remediated in-round) |
| Reviewed SHA | 6698d00 |
| Files | `src/core/config.ts`, `src/core/secrets.ts`, `src/core/settings.ts`, `src/company/registry.ts`, `src/gateway/server.ts`, `test/secrets.test.ts`, `test/settings.test.ts`, `desk/src/api.ts`, `desk/src/App.vue`, `desk/src/views/Settings.vue`, `desk/src/views/Overview.vue`, `e2e/desk.spec.ts` |
| Verdict | ✅ APPROVED |

## What changed

The Claude runtime credential (the token the agents' own inference runs on)
reaches a shift only by process-env inheritance in the factory, so the raw token
is readable by any shell and everything it spawns. This lands the storage,
settings, API and UI to hold that credential per company and as an installation
default, ahead of the keyproxy/`staff.ts` cutover that will route the agents
through the proxy. On its own it changes no shift behaviour — it is dormant until
the cutover wires `ANTHROPIC_BASE_URL` at `/svc/_runtime`.

- **Install-level settings** (`settings.ts`): the first Riff-level (not
  per-company) config — `settings.json` at the install root — plus an install
  vault (`install.vault.json`) sealed under the same master key. The per-company
  vault helpers were parameterised by path so the install vault reuses the exact
  crypto (`getInstallSecret`/`putInstallSecret`/`hasInstallSecret`).
- **Per-company override** (`config.ts`, `registry.ts`):
  `RiffConfig.runtimeCredential` (the type; value is vault-only), a non-structural
  `registry.update` delta.
- **Reserved name** `RIFF_RUNTIME_TOKEN`: refused and unlisted on the generic
  `/api/secrets` endpoints; written only via `PUT /api/settings` (default) and
  `PUT /api/runtime-credential` (per company).
- **Desk**: a top-level "Riff Settings" screen + a per-company section; the token
  value is write-only end to end.

## Method

Mixed diff. Generic three-pass (Architecture → Quality/Correctness → Security) +
adversarial re-read over the TS/secrets-path + gateway files, run by the calling
agent (no Go/infra PE matches plain TS). `pe-vue` dispatched (five-pass) for the
four Desk files + `e2e/desk.spec.ts`. SECURITY.md + CLAUDE.md re-read before
touching the secrets path. `npm run check` clean; `npm test` 649/649;
`npm run test:ui` 74/74.

## Findings

No CRITICAL / HIGH.

### Fixed in-round

- **MEDIUM (Primary, security) — a token value could be stored with no resolvable
  type.** The stored token is provider-specific (a subscription Bearer vs an
  `x-api-key`), so a value under no type would be injected in the wrong shape and
  401 silently. Fixed: `/api/settings` and `/api/runtime-credential` reject a
  value with no effective type, and — with pe-vue MEDIUM-001 — a type change with
  no fresh value. Type and token are now stored together, atomically.
- **MEDIUM (pe-vue MEDIUM-001) — Save was live on a pristine inheriting company,
  so one click created a valueless override.** `dirty` compared the seeded type
  against `null` and was always true. Fixed both server- and client-side: the
  server refuses a type without a value (above), and the Desk `dirty` is now
  `!!value` on both surfaces, so Save stays inert until a token is entered.
  Incoherent states (value-no-type, type-no-value, type-changed-stale-value) are
  now unrepresentable.
- **MEDIUM (pe-vue MEDIUM-002) — no test guarded the write-only invariant.** Added
  two e2e specs (install default + per-company) asserting the token never returns
  to the page, the field clears, only the type + "is set" come back, Save is
  disabled with no token, and the per-company override reverts to the default.
- **LOW (pe-vue LOW-001) — the "Saved." status was sticky on a fresh edit.** Fixed:
  a `watch` on the value field clears it on the next keystroke, both surfaces.
- **LOW (pe-vue LOW-002) — "Use installation default" dropped focus when it
  removed itself.** Fixed: focus moves to the credential-type select after a
  revert (`nextTick`).

### Verified non-issues / awareness

- **Security (generic pass 3).** The token value is write-only across every
  endpoint (`/api/settings` GET, `/api/state`, and both PUTs return the type and a
  boolean, never the value); the reserved name is refused and filtered on
  `/api/secrets`; MCP has no secret/runtime-credential method, so the value is
  Desk-only; the install vault is a fixed path (not a `slugId` sentinel that could
  collide with a real company) sealed under the same master key; the keyproxy will
  read it read-only and only after the gateway (read-write) has created it.
- **INFO (pe-vue LOW-001 residual) — a switch-during-save can briefly flash
  "Saved." on the newly selected company.** The save itself targets the right
  company (the request URL captured `c=` synchronously); only the transient
  indicator is misattributed. Accepted as LOW/cosmetic; not changed.
- **INFO (Primary) — `hasSecret` runs on every `/api/state` poll.** A small vault
  file read + `JSON.parse` (no decrypt) per poll. Negligible; not cached.
- **INFO (Primary) — the reserved-name guard has no HTTP-level test.** There is no
  gateway HTTP test harness in the repo; the security-critical parts (vault
  separation, write-only) are unit-tested and the happy path is covered e2e. The
  guard itself is a string-equality check.
- **INFO (pe-vue INFO-001) — the company switcher is an incomplete ARIA menu.**
  Pre-existing (the "Manage companies…" item shares it); the new "Riff settings…"
  item only follows the established pattern. Out of scope; flagged for a future
  a11y pass.
