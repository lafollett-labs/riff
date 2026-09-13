# Code Review — composer formatting toolbar + image paste/embed

**Verdict:** ✅ APPROVED (round 1 + remediation)
**Reviewer:** Marvin (orchestrator, generic three-pass on the backend) + PE-Vue (frontend, five-pass)
**Reviewed SHA:** `d100317`
**Scope (Specific Files):** `desk/src/MarkdownEditor.vue` (new), `desk/src/api.ts`, `desk/src/views/Inbox.vue`, `src/gateway/server.ts`, `src/worldfs/world.ts`, `src/worldfs/git.ts`, `test/world.test.ts`, `e2e/desk.spec.ts`. Commits `5828d33`, `5eed6a2`, `d100317`.

## What it is

Message bodies already render as Markdown (`markdown.ts`), so the composer was a
Markdown editor that made you remember the syntax. This adds a formatting
toolbar (bold/italic/link, `⌘B`/`⌘I`/`⌘K`) that wraps the selection, and the
ability to paste or choose an image.

The renderer already resolves `![alt](path)` against the company world through
`/api/file` and **drops remote srcs** (no third-party fetch), so an image only
needed somewhere to land and a path to name it by. `POST /api/attachment` takes
the bytes, decides the type by **sniffing the magic bytes** (not the client's
`content-type`), refuses anything that is not a raster image (**SVG refused** —
the one "image" that can carry script, and one a paste never produces), caps the
size at 12MB, and writes into a **gitignored `attachments/`** dir.

## Backend — generic three-pass (Marvin): no CRITICAL/HIGH/MEDIUM

- **Upload trust boundary sound.** Extension is server-decided from the bytes;
  the path is server-generated (`attachments/<date>-<12 hex>.<ext>`) and passes
  `world.path()` confinement — no client-controlled path component. A polyglot
  cannot execute: `/api/file` already serves with `x-content-type-options:
  nosniff` and `content-security-policy: default-src 'none'; sandbox`.
- **gitignore / no-sweep correct.** `WorldGit.ignore()` commits via a
  `commit -- .gitignore` pathspec, so a concurrent staff-staged file is never
  swept in; `commitAs`'s `add -A` skips the ignored `attachments/`. An
  attachment is operator metadata for a message, not authored work, so it is
  kept out of history, artifact counts, and attribution — the same reasoning as
  the `.DS_Store` ignore. Consistent with existing gateway precedent
  (`rename.ts:90` commits the world with a synthetic actor).
- **Fails safe.** A thrown error (e.g. the one-time first-upload git race) hits
  the outer handler → clean 500; the client surfaces it and removes the
  placeholder.

## Frontend — PE-Vue five-pass: 1 MEDIUM (fixed), 2 LOW + 2 INFO

`npm run check` clean; the injection surface confirmed safe (`html:false`,
remote srcs dropped).

| ID | Sev | Finding | Resolution |
| - | - | - | - |
| MEDIUM-001 | 🟡 | Sending while an upload was in flight shipped the raw `![uploading…]` placeholder (rendered as a broken `/api/file` src) and orphaned the uploaded file (`discard()`/send blanked the note, so `swap()` no-op'd). | **Fixed** — editor emits `busy` while uploading; composer folds it into `canPost` (Send disabled until the reference is real); `discard()` clears it. |
| LOW-001 | 🟢 | `aria-live` status region was created together with its text (`v-if`/`v-else-if`), which several screen readers do not announce (WCAG 4.1.3). | **Fixed** — one always-present `role="status"` region whose text changes. |
| LOW-002 | 🟢 | A failed upload's error was masked by "uploading…" while a sibling upload still ran (`v-if="uploading"` won). | **Fixed** — the single region prefers the error, so a failure is never hidden behind an unrelated in-progress upload. |
| LOW-003 | 🟢 | `link()` caret math, italic, `⌘B`/`⌘I`/`⌘K`, and the paste path had no test. | **Fixed** — e2e now covers `⌘I`, `⌘K` (label kept, "url" selected), and a paste via a `ClipboardEvent` image item. |
| INFO-001 | ℹ️ | `String.replace(token, withText)` would interpret `$&`/`$1` in the replacement (latent — a server path has no `$`). | **Fixed** — replace via a `() => withText` function. |
| INFO-002 | ℹ️ | `role="toolbar"` implies roving arrow-key nav that isn't implemented. | **Fixed** — dropped to `role="group"`. |

Backend LOW/INFO (accepted, non-blocking): `readBinaryBody`'s catch labels any
error "too large"; `sniffImage` isn't unit-tested in isolation (covered by the
e2e refusal path); the one-time first-upload `ignore()` commit can 500 under a
rare simultaneous-first-paste race (single-operator, retry succeeds).

## Tests + deploy

`npm run check` clean; **542 unit + 64 UI pass**. New: `World.writeAttachment`
round-trip / gitignored / not-swept-into-a-staff-commit / no-collision (4);
the composer e2e (bold button, file-pick upload + 415 refusal, `⌘I`, `⌘K`
offset, paste). **Not yet deployed** — `up --build` recreates the factory and
would kill a live ShipIt shift; rides the next factory rebuild.
