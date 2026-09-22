# Code Review — Overview→Settings split

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | pe-vue five-pass, two rounds, on the staged desk diff |
| Reviewed SHA | 6ff1d9e |
| Files | `desk/src/views/CompanySettings.vue` (new), `desk/src/views/Overview.vue`, `desk/src/App.vue`, `e2e/desk.spec.ts`, `test/policy.test.ts` |
| Verdict | ✅ APPROVED (round 2) |

## What changed

Overview carried both a company's status (brief, fact tiles, plan meters, board,
the power button) and its configuration (the "how hard it works" dials behind a
Tune toggle, plus the runtime-credential panel). The configuration moved to a new
company-level **Settings** view (`CompanySettings.vue`), added to the per-company
nav at the bottom with id `config` — deliberately distinct from the installation-
level `settings` that `App.vue`'s `installView` computed special-cases. The dials
are now always editable (Tune toggle gone); Save/Reset gate on a `dirty` check.
Overview is now purely the status front page. The power/shutdown button stayed on
Overview (it is about the live run, not config).

## Method

pe-vue five-pass (Architecture → Quality+Tests → Security → Adversarial Re-read →
Self-Adversarial), reading the full files, over two rounds. `npm run check` clean;
`npm test` 635 pass; `npm run test:ui` 77 pass (two new regression tests added).

## Findings — Round 1 (all remediated)

- **HIGH-001 — blanking a percentage field saved 0, switching off a safety bound.**
  `saveDials` guarded the numeric dials and the dollar cap with `numOr` (blank →
  unchanged), but the two percentage fields (`throttleAboveUtilization`,
  `pauseAboveUtilization`) skipped it. `'' / 100` is `0`, so clearing "Stop at" and
  saving sent `pauseAboveUtilization: 0`; the server clamps to its 5% floor and
  rebuilds the company to stop only at 5% of the window — a safety bound switched
  off by an empty field. A latent bug carried verbatim from the old `Overview.vue`.
  **Fix:** both percentages now route through the same `numOr(field, currentServer)`
  guard. Regression test: *"clearing a percentage safety bound leaves it unchanged,
  not zeroed"*.

- **MEDIUM-001 — post-save resync raced the poll, pinning dials to the old value.**
  The always-editable redesign used a fire-once `justSaved` flag to let the next
  state update resync the fields to the server's clamped values. But state reads
  fire concurrently (the 20s timer, `@changed`, every streamed event), so a `GET`
  dispatched before the `PATCH` committed could land after `justSaved` was set,
  carrying the pre-save policy, consuming the one-shot, and stranding the change.
  **Fix:** the flag/baseline machinery was removed entirely. `saveDials` now reads
  the authoritative clamped policy straight back via `await api.state()` and applies
  it locally (`renameCompany` returns only `{ slug }`); the poll watch reduces to
  `if (dirty) return; resetDials()`. Verified server-side that `/api/state` serves
  host-persisted, `readPolicy`-clamped `cfg.policy` via `registry.get`'s lazy
  `#build`, so the read-back is correct whether the policy PATCH left the company
  running, closed-and-reopened, or stopped — no mid-rebuild hazard.

- **MEDIUM-002 — a chosen credential type reverted before the token was pasted.**
  The picker treated "mid-edit" as "a token value has been typed" (`rcDirty =
  !!rcValue`). Selecting the type first — the order the on-screen hint instructs —
  left `rcDirty` false, so the poll reverted the picker to the stored type; the
  operator then pasted the token and saved it under the wrong shape, and the
  keyproxy injects that with the wrong auth headers. Also latent from `Overview.vue`.
  **Fix:** an `rcTypeTouched` ref (set on the select's `@change`, cleared on
  save/revert/company-switch) gates the poll-sync watch. Regression test: *"a chosen
  credential type survives a refresh before the token is pasted"*.

- **LOW-001 — two "Save" buttons shared an accessible name.** **Fix:** distinct
  `aria-label`s ("Save settings" / "Save credential").

## Findings — Round 2 (verification)

All four round-1 findings confirmed resolved against the full file and a server-side
trace; no regressions. Two awareness-level items surfaced, both non-blocking:

- **LOW-001 (a11y, follow-on) — the dials Save gave assistive tech no success cue,
  and the static `aria-label` masked the "Saving…" busy state.** **Applied:** a
  dials-side `role="status"` "Saved." region (mirroring the credential section) plus
  `:aria-busy="saving"` on both Save buttons.

- **INFO-002 — focus drops to `<body>` when a keyboard-activated Save disables after
  a save.** Matches the prior Overview behavior (Save left the DOM there), so not a
  regression. Left as awareness; the `useDefault` focus re-home pattern is the fix if
  it is ever worth doing.

## Verdict

✅ **APPROVED.** Every round-1 finding is remediated and re-verified; only awareness-
level items remain, and the cheap a11y one was applied. The split fixes two latent
safety/auth bugs the old Overview shipped, and both are now covered by regression
tests.
