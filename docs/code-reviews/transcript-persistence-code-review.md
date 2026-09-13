# Code Review: transcript-persistence

**Verdict:** ✅ APPROVED

| | |
| - | - |
| **Branch** | `main` |
| **Reviewer** | @Cali LaFollett |
| **Review Round** | 1 |
| **Reviewed SHA** | `455ed36d6d0466802cc5e606473378a8dacb65b2` |
| **Title** | Persist shift transcripts on the volume, per company (CLAUDE_CONFIG_DIR → /data) |
| **Files Changed** | 8 |
| **Lines Changed** | +~140 / -~30 |
| **Date** | 2026-09-13 |

---

## Summary

Phase 3a of the transcript-persistence plan. Each shift's CLI store (transcripts,
sessions, `.claude.json`) moved off the container's tmpfs `$HOME` onto the durable
volume by setting `CLAUDE_CONFIG_DIR=/data/companies/<slug>/.claude` per shift —
`registry` derives it, `scheduler` carries it as `configDir`, `staff` sets it in the
shift child env and threads it into `sandboxFilesystem`. This makes resume survive
restarts and gives a per-company audit trail. Generic three-pass (no PE matches plain
`src/**/*.ts`; the `docker/compose.yaml` change is comment-only). Two real defects were
found in the security pass and fixed **before** the commit; the change was then verified
live in-container. `npm run check` clean, `npm test` 577/577.

---

## Findings Overview

| Severity | In Scope | Out of Scope |
| -------- | -------- | ------------ |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 0 | 0 |
| 🟢 LOW | 0 | 0 |
| ℹ️ INFO | 2 (resolved pre-commit) | 0 |

---

## Defects found and fixed during review (pre-commit)

### 🟠 (resolved) Resume guard read the wrong session store

**Domains:** [Correctness]
**Location:** `src/runtime/staff.ts:871`

`tick()`'s resume guard called `transcriptExists(session)` with the default store,
which reads the **server** process's env — where `CLAUDE_CONFIG_DIR` is not set — so it
looked in `/home/labs/.claude/projects` while the shift's CLI writes to
`/data/companies/<slug>/.claude/projects`. Every resume would have found an empty
directory and reset to a cold start: persistence built and then never used. **Fixed** by
deriving the store from `d.configDir` (`sessionStore({ CLAUDE_CONFIG_DIR: d.configDir })`)
and passing it in. Guarded by a source assertion in `rotation.test.ts`.

### 🟠 (resolved) Sandbox deny was either/or — a cross-company read on the container path

**Domains:** [Security]
**Location:** `src/runtime/staff.ts:85` (`sandboxFilesystem`)

The first cut wrote `configDir ? [configDir] : [<$HOME denies>]`, dropping the
`/home/labs` denies whenever `configDir` was set. `/home/labs` is a single tmpfs shared
by every company and bubblewrap reads are allow-by-default, so anything the CLI leaves
there despite the redirect (e.g. `.claude/bridge-spawn`, verified to still land there)
would be readable by any company's Bash — a cross-company read, the CRITICAL-001 class.
**Fixed** to additive: `installRoot()`, the `$HOME` store, `.credentials.json`,
`.claude.json` are **always** denied, and `configDir` is denied **on top** when set.
New `sandbox-filesystem.test.ts` case asserts both stores stay denied together.

---

## In Scope Findings

### ℹ️ INFO-001: `bridge-spawn` still writes to the tmpfs `$HOME`

**Domains:** [Infrastructure]
**Location:** `docker/compose.yaml:124` (tmpfs list)

After the redirect, `/home/labs/.claude` holds only `bridge-spawn` (a CLI/bridge dir not
in Riff source that ignores `CLAUDE_CONFIG_DIR`). This is why the `/home/labs` tmpfs is
**kept**, not removed: under `read_only` the CLI's HOME still needs a writable mount for
this ephemeral scratch. Correct as shipped; noted so a later "remove the tmpfs" pass
knows the one blocker. Non-blocking.

### ℹ️ INFO-002: One-time cold-start for pre-migration sessions

**Domains:** [Operations]
**Location:** n/a (migration behavior)

Sessions whose transcripts lived on the old tmpfs (e.g. `session:jack`) correctly
cold-start once after this lands — their transcript is genuinely gone — then persist from
there. Expected, self-healing, no action.

---

## Architecture (Pass 1)

`configDir` is threaded exactly like the existing `cacheDir` (registry → scheduler option
→ tick dep → child env), so it adds no new pattern. The store sits beside `world/`, never
inside it, so transcripts are not staged into the company's git repo. Eager `mkdirSync`
surfaces an unwritable volume at open, matching `cacheDir`. `sandboxFilesystem`'s new
param is optional, so host tests and any non-container path keep prior behavior.

## Quality + Tests (Pass 2)

`npm run check` clean; `npm test` 577/577. Coverage: sandbox deny follows `configDir` and
stays additive; the resume guard reads the per-company store (source guard); the env
wiring guard updated for the multi-line spread; the now-reversed "don't use
CLAUDE_CONFIG_DIR" test rewritten to assert the current design.

## Security (Pass 3)

Cross-company isolation holds: `configDir` is under the denied `installRoot()`, re-allowed
only for this company's own home, then denied back (more-specific-wins) so a shift cannot
Bash-read even its own transcripts. `read_only` is untouched — the container still cannot
rewrite its own image. No secret is written to disk or log by this change.

## Live verification (in-container, post-rebuild)

- Real transcript JSONLs (69KB, 139KB) written to `/data/companies/shipit/.claude/projects/`.
- `/home/labs/.claude` holds only `bridge-spawn`; `.claude.json`, sessions, transcripts all on `/data`.
- Ledger `session:carver` / `session:lynn` resolve to transcripts present on `/data` → resume; `session:jack` correctly MISSING (pre-migration) → one cold-start.

---

## Files Reviewed

| File | Findings |
| ---- | -------- |
| `src/runtime/staff.ts` | 2 (both fixed pre-commit) |
| `src/runtime/scheduler.ts` | 0 |
| `src/company/registry.ts` | 0 |
| `docker/compose.yaml` | 1 INFO (comment-only edit) |
| `test/*` (4 files) | 0 |

---

## Merge Eligibility

**Locked to SHA:** `455ed36d6d0466802cc5e606473378a8dacb65b2`
**Status:** ✅ Mergeable IF `git rev-parse HEAD == 455ed36d6d0466802cc5e606473378a8dacb65b2`. Any commit after this SHA invalidates this round and requires re-review.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
