# Code Review — a build left behind is not committed in anyone's name

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | security and correctness review, three rounds and a verify pass, each HIGH reproduced by experiment |
| Base SHA | 8789a79 |
| Files | `src/worldfs/git.ts`, `src/company/genesis.ts`, `test/{world,world-git-trust,registry}.test.ts` |
| Verdict | ✅ APPROVED |

## Origin

The shift-end commit (`commitAs`) ran `git add -A` over the whole world in the
staff member's name. On 2026-09-24 it put a 9.6 MB `livecall` and a 5.7 MB
`explain` (each a `go build` left where it ran) into ShipIt's history. The staff
untracked both, but the bytes stay in history. Measured today, `livecall` is
tracked again.

## Design, as landed

- **What is held.** A new file is left untracked if it is either:
  - a compiled program: ELF, Mach-O thin or fat, Java class, WebAssembly, or a
    PE with a NUL in its header;
  - over 10 MB (`HOLD_BYTES`). ShipIt's largest authored file is 735 KB.
- **The decision comes before anything is staged**, so a held file is never
  hashed into the repository:
  1. `ls-files --others` lists the new files.
  2. Each one is opened through `openWithin` and its head is read.
  3. Tracked files are staged with `add -u`, and new files that are not held
     with `update-index --stdin`.

  Both git calls take their input on stdin and grow linearly with the number of
  files.
- **Already chosen stays tracked.** A program whose bytes are in HEAD's tree is
  committed (a move or a copy), and so is any file already tracked. A rebuild is
  held.
- **Held files are cheap to keep.** They are cached by stat, so on later commits
  an unchanged held file costs one `lstat`. Each is reported once, as a
  `world.held` event whose subject is the path.
- **One bad path doesn't fail the commit.** If `update-index` refuses a path, the
  path it names is set aside, up to 5 times. After that the new files wait for
  the next commit, and the edits commit now, in the right name.

## Findings

| Round | ID | Severity | Finding | Resolution |
| - | - | - | - | - |
| 1 | H1 | HIGH | `rm --cached` after `add` threw when a held file kept changing: 0/10 commits | decided before staging; no `rm` |
| 1 | H2 | HIGH | all held paths on argv: `E2BIG` at 30k files | stdin |
| 1 | M1 | MEDIUM | a tab in a name untracked a different, tracked file | NUL-separated listing |
| 1 | M2 | MEDIUM | `numstat` read every new blob under the 10 s bound | no diff; head reads only |
| 1 | M3 | MEDIUM | re-reported on every commit, with no path | reported once; path as subject |
| 2 | R2-H1 | HIGH | one exclusion per held file made `add` quadratic: 140k stubs took 126 s, then git stopped for the company | `add -u` + `update-index --stdin`: 9.1 s, then 0.93 s with the cache |
| 2 | R2-L3 | LOW | a tracked program moved was deleted and held | bytes in HEAD's tree count as chosen |
| 3 | R3-M1 | MEDIUM | one unstageable path failed the commit: 3/10 under a colleague's flip loop | set aside and retried: 10/10 |
| 3 | R3-M2 | MEDIUM | held files re-read on every commit (5.3 s at 140k), and the hash read to EOF | stat cache; exact-size read |
| 3 | R3-L1..L3 | LOW | whole object store as "known"; English error match; wall-clock test | HEAD's tree; `LC_ALL=C`; a property test |
| verify | — | INFO | the held notice was lost if staging threw | emitted before staging |

## Residual

- The author is not told directly. The event is in the ledger, and the file
  shows in `git status`.
- A file swapped between the check and staging can still slip through. This
  guard is hygiene, not a security boundary.
- `ls-files` output hits the 32 MB buffer at about 150k paths of 200
  characters, the same limit the existing `diff --name-only` has.

Tests 834/834; `npm run check` clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
