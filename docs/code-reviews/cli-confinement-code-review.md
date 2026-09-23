# Code Review — the CLI confined to its company, the gateway's worktree prune, and shifts that went unrecorded

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | generic security review with adversarial passes, three rounds; pe-devtools on `up.sh`, two rounds; live measurements in the factory against a throwaway company (`confine-probe`) |
| Base SHA | ac8f8fc |
| Reviewed SHA | a6fc4bc, a243841, 82c80ad |
| Files | `src/runtime/staff.ts`, `src/worldfs/git.ts`, `src/runtime/scheduler.ts`, `docker/up.sh`, `SECURITY.md`, `test/{sandbox-filesystem,world-git-trust,world,scheduler,ceiling,container}.test.ts` |
| Verdict | ✅ APPROVED (security round 3, pe-devtools round 2) |

## Origin

- R3-1 of the shift write boundary review: a file tool's path is checked by the
  gate and then opened by the CLI outside the Bash sandbox.
- pe-governance MEDIUM-002 of the keyboard focus review: `up.sh` drained the
  wrong port when `PORT` was set in an env file.
- Carver (ShipIt) on 2026-09-22: `git worktree prune` fails inside the sandbox,
  leaving 25 stale entries.
- Found while monitoring ShipIt the same night: four `agent.woke` events and no
  `agent.slept`. Every shift-end commit had thrown since the 00:42 deploy, and
  the scheduler swallowed the error.

## Findings — security, round 1

- **SB-1 MEDIUM (fixed)** — per-shift tmpfs mounts were unsized; now 1 MiB / 256 MiB / 512 MiB.
- **SB-2 MEDIUM (fixed)** — a fresh `$HOME` made `~/.npm`, `~/.cache`, `~/.undo`
  read-only to the shell (its sandbox skips missing allowWrite paths); now
  created with `--dir`, measured writable from a shift.
- **SB-3 MEDIUM (fixed)** — the `/proc` claim was measured for `root` only; now
  measured for `fd`, `environ`, `map_files`, `cmdline`, and two older SECURITY.md
  statements corrected.
- **SB-4..SB-10 LOW (fixed or documented)** — lost-session detection reads the
  confined stderr; a missing bwrap is named; signals documented; main control
  files fail closed; the home must be one level below `companies/`; the
  within-company limit stated; argv and spawn wiring tested.
- **SB-12 MEDIUM (out of scope, follow-up)** — `atomicWriteFileSync` stages
  `config.json.tmp-*` inside the company home, where a shift could hold a
  descriptor across the rename. Predates this change.

## Findings — security, round 2

- **R2-1 MEDIUM (fixed)** — the prune's link check is a moment before git
  walks; a colleague's shell could plant a link in between. The prune now runs
  inside the company's own bubblewrap view.
- **R2-2..R2-5 LOW/INFO (fixed)** — refused prunes are recorded; the home check
  normalises the path; a date.

## Findings — security, round 3

- **R3-1 LOW (fixed)** — `check-ignore` read staff-named directories as
  pathspecs. It refuses magic outright, so one directory named `:(...)` would
  have stopped every commit; paths now go in as `./<name>`, with a test.
- **R3-2 LOW** — `.gitignore` edited between check-ignore and add; the scope is
  built once per commit. Accepted.
- **R3-3 LOW (fixed)** — the scheduler's failure message is scrubbed with
  `withoutSecrets`, worded for any phase, and `onTick` is outside the catch.
- **R3-4, R3-5 INFO** — within-company reach of a raced prune; the scheduler
  test reads source.

## Findings — pe-devtools (`up.sh`)

Round 1: three LOW. Parsing `PORT` out of env files missed spellings compose
accepts and named the next container rather than the running one. Taken as the
fix: ask `compose port ingress 4173`. Round 2: no findings above INFO.

## Verdict

✅ **APPROVED.** `npm run check` clean; `npm test` 689 pass. The confinement, the
confined prune and the `~/.undo` fix were each measured in the factory.
