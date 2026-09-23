# Code Review — keyboard focus after a Save, and the Docker section of CLAUDE.md

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | pe-vue (desk, e2e) and pe-governance (CLAUDE.md), two rounds on the working tree |
| Base SHA | ab0906e |
| Reviewed SHA | b172946, d9c70ed |
| Files | `desk/src/focus.ts` (new), `desk/src/views/{CompanySettings,Settings,Staff}.vue`, `e2e/desk.spec.ts`, `CLAUDE.md`, `.gitignore` |
| Verdict | ✅ APPROVED (round 2) |

## Origin

INFO-002 of the Overview split review, carried as awareness through the seat
model review: a keyboard-activated Save disabled itself and dropped focus to
`<body>`. The CLAUDE.md Docker section was carried as stale since the runtime
credential moved into the keyproxy vault.

## Findings — Round 1

pe-vue:

- **MEDIUM-001 (fixed)** — the dials Save sent focus to the first dial, twelve
  fields back; measured, `main` scrolled from 1093 to 248 and "Saved." left the
  viewport. Now the field just above Save (`dial-cap`); the e2e asserts the
  status stays in view.
- **LOW-001 (fixed)** — focus was taken from `document.activeElement`, which is
  a mouse-clicked button in Chromium and possibly another button in Safari.
  `pressedByKeyboard` reads the event's button and requires `:focus-visible`.
- **LOW-002 (fixed)** — Reset and the Remove confirm's Cancel/Remove dropped
  focus the same way.
- **LOW-003 (fixed for dials)** — e2e covered two of six call sites.
- **INFO-001 (fixed)** — the dials error line had no `role="alert"`.

pe-governance:

- **MEDIUM-001 (fixed)** — "no credential reaches the container through Docker"
  was false: `master.key` and the vaults sit on the factory's `/data` mount. Now
  names what Docker does not pass and what actually keeps shifts from them.
- **LOW-001 (fixed)** — the drain was described as a guarantee; it is
  best-effort, and the stop rule now points at it.
- **LOW-002 (fixed)** — the test guard is named by the three variables it checks.
- **MEDIUM-002 (out of scope, follow-up)** — `up.sh`'s drain reads `PORT` from the
  shell only, so a `PORT` set in `docker/.env` or `$RIFF_ENV` skips the drain
  silently and a rebuild kills shifts.

## Findings — Round 2

All round-1 in-scope findings verified resolved, each fallback id probed by hand.
New:

- **LOW-001 (fixed)** — opening the Remove confirm unmounted the pressed button
  and left focus on `<body>`; a keyboard open now lands on Cancel.
- **INFO-001** — poll, credential, Reset, Cancel and Remove paths are verified by
  probe, not e2e; a renamed fallback id would fail silently.

## Verdict

✅ **APPROVED.** `npm run check` clean; `npm test` 676 pass; `npm run test:ui` 83
pass. The new e2e fails with the focus move disabled.
