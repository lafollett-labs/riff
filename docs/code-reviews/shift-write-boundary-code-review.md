# Code Review — what a shift may write, and what the gateway's git will run

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | generic three-pass with adversarial passes, three rounds, on the staged diff; live contained probes in a throwaway company |
| Base SHA | 05f8f47 |
| Reviewed SHA | d67fae1 |
| Files | `src/runtime/staff.ts`, `src/runtime/permissions.ts`, `src/worldfs/git.ts`, `src/worldfs/world.ts`, `src/core/models.ts`, `SECURITY.md`, `test/world-git-trust.test.ts` (new), `test/sandbox-filesystem.test.ts`, `test/world.test.ts`, `test/container.test.ts` |
| Verdict | ✅ APPROVED (round 3) |

## Origin

Raised as out-of-scope F3 in the per-seat model review: a shift's shell could
write its own `ledger.db` and `config.json`. Scoping the fix found that the
gateway runs git over the staff-written world outside the sandbox, which made
the repository itself the larger boundary. Nothing in ShipIt's world had used
either route (its repository config, hooks and attributes were clean).

## What changed

- **Control files** (`companyControlFiles`): `config.json`, `ledger.db*`,
  `transcript.db*` are write-denied to the shell. The home stays writable —
  ShipIt keeps a 3.2 GB toolchain beside its world, and a read-only home was
  measured to stop the CLI's sandbox from starting. `world/` is its own
  writable mount.
- **The gateway's git** (`WorldGit`): command-running features off on every
  call; each call first vets the repository (real `.git` directory, no borrowed
  repository, no links in the metadata git touches, config keys on an
  allowlist); nested repositories are left out of add/status/diff.
- **The gate**: `world/.git` is outside the company for the file tools, in any
  letter case.
- **`world/` identity**: pinned by inode at open; a replaced or linked world is
  refused wherever the gateway resolves it.

## Measured (contained probe, throwaway company)

| Check | Before | After |
| - | - | - |
| shell write / rename / overwrite of control files | ok | refused (`Read-only file system`) |
| hard link, symlink, delete of a control file | — | refused (EXDEV / RO / EBUSY) |
| shell rename of `world/` | refused | refused |
| writes in `world/`, `scratch/`, a sibling toolchain dir, a new top-level dir | ok | ok |
| `/data/master.key` | denied | denied |
| gateway API on loopback / by name | unreachable | unreachable |

## Findings

- **Round 1** — five items on the gateway's git (nested repositories, links in
  `.git`, `world/` replacement, a spoofable vet cache, missing-file denies). All
  fixed or measured closed; each fix has a test, and the hooks and nested-repo
  tests were mutation-checked (removing the fix fails them).
- **Round 2** — nested-repo detection was case-sensitive on a case-insensitive
  volume (fixed, mutation-checked); background gc/maintenance (turned off); the
  proposed read-only home broke the sandbox and was replaced by measurement.
- **Round 3** — all resolved.

## Residual — tracked for a separate change

- **R3-1 (pre-existing, MEDIUM)** — the gate checks a file tool's path, then the
  CLI opens it outside the sandbox; a parallel shell write below `world/` could
  change what that path resolves to in between. Candidate fix: inside the
  container, route file access through the sandboxed shell or link-refusing
  company tools rather than the CLI's own file tools.

## Verdict

✅ **APPROVED.** `npm run check` clean; `npm test` 670 pass; `npm run test:ui` 80 pass.
