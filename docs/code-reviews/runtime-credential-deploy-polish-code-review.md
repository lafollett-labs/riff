# Code Review — runtime-credential deploy polish

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff across three commits: generic security three-pass on the TS/secrets path (by the calling agent) + dispatched `code-reviewer:pe-vue` five-pass on the Desk/e2e diff |
| Reviewed SHA | 1c54fb6 |
| Commits | c6cbba0 (config route + regex), ca54837 (Desk surface + install chrome), 1c54fb6 (remove default + nav-deadend fix) |
| Files | `src/core/config.ts`, `src/core/settings.ts`, `src/gateway/server.ts`, `desk/src/api.ts`, `desk/src/App.vue`, `desk/src/views/Settings.vue`, `test/settings.test.ts`, `e2e/desk.spec.ts` |
| Verdict | ✅ APPROVED |

## What changed

Polish landed after the runtime-credential cutover deployed and was verified live
(a 200 through `/svc/_runtime` with the real subscription token injected from the
install vault). Three things:

1. **`anthropic-version` on the runtime route.** The subscription route sent
   `anthropic-beta` + a `claude-code` user-agent but not `anthropic-version`,
   which every `/v1/messages` request requires — it worked only because the Agent
   SDK adds the header itself. The keyproxy now injects `anthropic-version` for
   both credential types (a single `ANTHROPIC_VERSION` constant), so a shift is
   not one dropped SDK header from a silent 400. Proven live: a curl with no
   client version header now returns 200.
2. **`CONTROL_CHARS_RE` written with escapes, not raw bytes.** The regex had been
   authored by typing the literal control characters (a raw NUL, US, DEL, and a
   UTF-8-encoded U+009F) into the class instead of `\x` escapes (from 5e97909).
   Node decoded it correctly so every test passed, but the raw NUL made git/grep
   classify `config.ts` as binary. Now `/[\x00-\x1f\x7f-\x9f]/` — proven identical
   to the old semantics across all 65,536 code points, clean ASCII on disk.
3. **Desk surfacing + install-level chrome + remove.** Riff Settings shows a
   prominent set/not-set badge (the durable "it is set" signal the operator was
   missing). Companies/Settings are installation-level, so the rail sheds the
   selected company's name, section nav, board list and run/staff footer and names
   the installation instead. The default can now be removed (DELETE /api/settings
   → `clearDefaultRuntimeCredential` + `deleteInstallSecret`), behind a confirm.

## Method

Calling agent ran the generic three-pass (Architecture → Correctness → Security) +
adversarial re-read on the config/settings/gateway/secrets-path portion (no
matching stack PE; SECURITY.md + CLAUDE.md re-read). `code-reviewer:pe-vue`
dispatched for the Desk/e2e diff (its own five-pass, full-file reads). `npm run
check` clean; `npm test` 657; `npm run test:ui` 75.

## Findings

### pe-vue

- **HIGH-001 — install-view navigation dead-end (FIXED in 1c54fb6).** Hiding the
  section nav on install views removed the in-view way back to the company,
  leaving the switcher as the only gesture — but `select()` returned early when
  the picked slug equalled the active one, before the view reset, so re-picking
  the current company silently no-opped. On a single-company install (the current
  case) that stranded the operator on Riff Settings with no path back but a page
  reload. Confirmed by trace; both entry points (switcher menu and Companies'
  pick button) route through the same `select()`, so the one fix covers both.
  **Fix:** `select()` now leaves the install view (`view = 'envelope'`) when the
  active company is re-picked from one, before the early return.
- **MEDIUM-001 — return path untested (FIXED in 1c54fb6).** The e2e proved the
  chrome is shed but never that the operator can get back, so the suite stayed
  green while the operator was trapped. **Fix:** added
  `the switcher returns from an install view to the active company`, which fails
  without the HIGH-001 fix.
- **MEDIUM-002 — switcher is not a conformant menu widget (DEFERRED, awareness).**
  Pre-existing widget (not in this diff), but the change makes it the sole nav on
  install views, so its gaps are now load-bearing: no `aria-haspopup`, the popup
  is not `role="menu"`/`menuitem`, no Escape-to-close, no arrow-key nav, focus not
  restored on close. Still operable via Tab/Enter, so not a blocker. Tracked as a
  follow-up (switcher a11y), out of scope for a runtime-credential change.
- **INFO-001 — write-only guarantee intact (VERIFIED).** The badge renders only
  the type label and a literal "Set"/"Not set"; `RuntimeCredential` is `{ type }`
  and structurally cannot carry the value; the input stays `type="password"`,
  cleared to '' after save; e2e asserts the token never appears in `main`.

### Calling agent (config / settings / gateway / secrets path)

No CRITICAL / HIGH / MEDIUM.

- **`anthropic-version` injection is safe.** The keyproxy merges route headers by
  `headers[lk] = v` (overwrite, never append) and applies them after the caller's,
  so a client-sent version header is overwritten, never duplicated; the credential
  header is still injected last and always wins. `anthropic-version` is a non-secret
  required header, neither a framing header nor the credential header, so it is not
  skipped by the injection guards. Verified live (200 with no client header).
- **`CONTROL_CHARS_RE` change is behaviour-preserving.** Proven: 0 disagreements
  with the old regex across all 65,536 BMP code points; the `services.test.ts`
  control-char scheme/header tests (tab, DEL, C1, CRLF) still pass.
- **DELETE /api/settings fails safe.** Clearing drops both the type and the vault
  value; the keyproxy then resolves neither and 502s (fail-closed), which the
  gateway preflight turns into a "set a runtime credential" refusal before any
  wake — a company inheriting the cleared default is held, not run unauthenticated.
  `clearDefaultRuntimeCredential` preserves any other settings and is a no-op (not
  a throw) when nothing is set. The reserved-name guards on the generic
  `/api/secrets` endpoints are unchanged.

## Follow-ups

- Switcher menu-widget a11y (pe-vue MEDIUM-002) — track separately.
- Docker retirement of `CLAUDE_CODE_OAUTH_TOKEN` (the compose residual) and the
  HTTP-level `_runtime` keyproxy test remain the next runtime-credential commit,
  per the cutover review's "Next".
