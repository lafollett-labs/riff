# Code Review — config staged off-home, connector headers out of argv, the gateway's world I/O through links, and the runtime token for companies without services

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | generic security review with adversarial and mutation passes, four rounds; live measurements in the factory against throwaway companies (`link-probe`, `link-probe-b`) |
| Base SHA | e19519c |
| Files | `src/core/{atomicwrite,config}.ts`, `src/runtime/{staff,scheduler}.ts`, `src/worldfs/{within,world,git}.ts`, `src/company/{genesis,registry,rename}.ts`, `src/gateway/server.ts`, `SECURITY.md`, `test/{atomicwrite,sandbox-filesystem,world-links,shift-env}.test.ts` |
| Verdict | ✅ APPROVED (round 4, all three scopes) |

## Origin

- SB-12 of the CLI confinement review: `config.json.tmp-*` staged inside the
  company home, which a shift's view binds writable.
- The same review's `/proc` measurement: `cmdline` is readable from every
  company, and the SDK put connector headers there.
- OOS-1 and OOS-2, found by this review's round 1: the gateway, outside every
  view, followed links a shift planted in its world.
- Found while measuring: a company with no declared services got no runtime
  token, and every shift failed "Not logged in".

## Scope A — config staging and `--mcp-config`

- **F1 MEDIUM (fixed)** — the first test passed with SB-12 put back. It now spies
  on the rename; with `stageIn` dropped, the test fails.
- **F2 MEDIUM (fixed, measured)** — in the factory with a marker header: 0 matches
  in the argv of bwrap or the CLI; `/proc/<pid>/root/data/mcp.json`, `environ`
  and bwrap's `fd/3` refused from a neighbour's view. Without connectors there is
  no `--mcp-config` at all.
- **F3 LOW (fixed)** — any other shape of the flag refuses the shift; a test drives
  the real SDK, and fails with the rewrite dropped.
- **F4..F8 LOW/INFO (fixed)** — one `isCompanyHome`; every atomic-write caller
  pinned; `.staging` re-tightened to 0700; the claim stated as cross-company; the
  SDK debug log noted.
- **A2 LOW (fixed)** — the measurements recorded in SECURITY.md.

## Scope B — the gateway's world I/O

Five routes worked before, each reproduced against the old code in
`test/world-links.test.ts`: a dangling link written through, a recursive delete
through a linked `projects/`, folders made through a linked `staff/<id>`, an
append through a linked `.gitignore`, and a FIFO that held the gateway.

- **B1 MEDIUM (fixed)** — round 2's cleanup unlinked by path and could be
  redirected; replaced by a directory pinned by descriptor and checked through
  `/proc/self/fd`, so nothing is created outside to undo.
- **B2 HIGH (fixed)** — reads followed links and FIFOs; `readDoc`, `readText` and
  `/api/file` now read by descriptor.
- **B3 HIGH (fixed, measured)** — `removeProject` runs `rm -rf` inside the
  company's view. With `projects/` swapped for a link to the neighbour, the
  neighbour's marker survived.
- **B4 LOW (fixed)** — the kernel's verdict is injectable, and a mutation of the
  check fails the test; on Linux the real branch ran in the factory.
- **B5 LOW (fixed)** — seat rename and the home's `scratch`/`.claude` refuse links.
- **R3-1 MEDIUM (fixed)** — a listing starting at a linked top-level folder leaked
  a neighbour's names.
- **R3-2 LOW (fixed)** — a link at a document's name reads as nothing, not a throw.
- **R3-3, R4-1 LOW (accepted)** — the seat-rename and listing races are named in
  SECURITY.md beside `mkdir -p`.
- **R3-4 INFO (fixed)** — `/api/file` streams through `pipeline`.

## Scope C — runtime token wiring

- **Fix** — `companySlug` reaches every shift; before, the registry and scheduler
  passed it only with declared services. Measured: link-probe's first wake failed
  "Not logged in" with no request at the keyproxy; after the fix its scheduled
  shift slept normally.
- **C1 LOW (accepted)** — the test reads source, as the atomic-write scan does.

## Verdict

✅ **APPROVED.** `npm run check` clean; `npm test` 712 pass. On Linux in the
factory, `test/world-links.test.ts` passes 13 of 14; the other needs an
executable `/tmp` for its stand-in bwrap, as the prune test already does.
