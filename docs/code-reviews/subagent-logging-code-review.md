# Code Review — subagents on the record, and the gate for what the CLI approves itself

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | security review with adversarial passes, four rounds; `tick()` driven on a scripted `query`; live probes in throwaway companies (`subagent-probe`, `remote-probe`, `matcher-probe`, all since deleted) |
| Base SHA | ad3025c |
| Files | `src/runtime/{staff,permissions}.ts`, `src/analytics/{vitals,types}.ts`, `desk/src/views/Vitals.vue`, `SECURITY.md`, `test/{shift-landing,permissions,transcript,container}.test.ts` |
| Verdict | ✅ APPROVED (round 4) |

## Origin

Cali asked for subagents to be logged. From 09-13 ShipIt spawned 25 of them:
22 by Carver, 2 by Jack and 1 by Lynn. None left a ledger record, and the
transcript mixed each subagent's calls in with its parent's.

## Measured live

| Probe | Before | After |
| - | - | - |
| a subagent's `echo hi > staff/tess/…` | written with no `gate.allow` | one `gate.allow shell` (`autoAllowBashIfSandboxed: false`) |
| a built-in `Read` of a colleague's file | silent | `gate.allow world.read_other` |
| plain `ls` | no gate record | one `gate.allow shell` |
| `Agent` with `isolation: "remote"` | accepted, ran as a background agent; nothing new left the container | refused before it runs |
| a background spawn | recorded as finished at its launch receipt (18 of the 25 were background) | finished by its completion notice: 1 tool call, 6160ms |
| `TaskStop` on a background `sleep` | worked | still works (anchored matcher) |

## Rounds

- **Round 1: changes requested.**
  - **S1 MEDIUM (fixed)**: calls the CLI approves itself never reached the gate. A `PreToolUse` hook (`makePreToolCheck`) now puts them to it. It adds refusals and records, and never grants.
  - **S2 MEDIUM (fixed, measured)**: a remote spawn is refused.
  - **S3 LOW (recorded)**: a spawn's `model` is recorded. Enforcing the seat's model on its subagents is Cali's call.
  - **S4 LOW (fixed)**: SECURITY.md has a measured table in place of "every tool call — built-ins included".
  - **S5 LOW (fixed)**: background spawns are recognised.
  - **S6 INFO (fixed)**: `type` is capped.
  - **S7 (follow-up)**: SHELL_TOOLS names are stale.
- **Round 2: changes requested.**
  - **R2-1 MEDIUM (fixed)**: a Grep or Glob across the world read colleagues' files silently; it is now one `world.read_other`. CLI 2.1.280 ships neither tool, so searches run through the shell.
  - **R2-2 LOW (fixed)**: the hook fails closed.
  - **R2-3 LOW (fixed)**: the matcher is anchored.
  - **R2-4 LOW (follow-up)**: pin the CLI tool set with `tools`.
  - **R2-5 INFO (fixed)**: `task_started.is_backgrounded` is used.
- **Round 3: approved.**
  - **R3-1 LOW (fixed)**: a link in your own folder hid a search of a colleague's; the search scope is now resolved through links.

✅ **APPROVED.**
- `npm run check`: clean.
- `npm test`: 756 of 756 on the host and 756 of 756 in the factory image.
- `test:ui`: 83 of 83.
- Each fix has a test that fails when it is removed.
