# Code Review — a shift is offered the tools the gate has rules for

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | security review, one round; live probes in throwaway companies (`probe-cli-301`, `probe-tools-301`, since archived) |
| Base SHA | 8524886 |
| Files | `src/runtime/{permissions,staff}.ts`, `SECURITY.md`, `test/{permissions,shift-landing}.test.ts` |
| Verdict | ✅ APPROVED |

## Origin

After the rebuild onto CLI 2.1.301, a probe shift found the CLI offering every
seat CronCreate, CronDelete, CronList, ScheduleWakeup, Workflow, EnterWorktree,
ExitWorktree, EnterPlanMode, AskUserQuestion and ReportFindings. The gate
refused each one that was tried. Glob and Grep were not offered at all, so the
gate's scoped search went unused while staff grepped in the shell. Cali asked
for an allowlist, and a generous one, since shifts are sandboxed.

## Design, as landed

- **The list.** `offeredTools(contained)` is passed as the SDK's `tools`
  option. It holds every built-in tool the gate has a rule for: the shell only
  when contained, read, write, the free tools, web reads and `SendMessage`.
- **Two tools held back.** `Skill` and `ExitPlanMode` are decided if called but
  not offered, and `skills: []` is set.
- **New free tools.** `TaskCreate`, `TaskGet`, `TaskUpdate` and `TaskList` are
  the session's to-do list, TodoWrite's successor.
- **Effect.** In the CLI, each name left off becomes a deny rule (source
  `toolsNarrowing`), and subagents inherit it. The PreToolUse hook still runs
  for every call, and the gate is unchanged.

## Measured live

| Check | Result |
| - | - |
| built-ins offered before, 2.1.301 | 22, including the ten above; no Glob/Grep |
| built-ins offered after (session init) | Task(Agent), Bash, Edit, Glob, Grep, NotebookEdit, Read, SendMessage, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, ToolSearch, WebFetch, WebSearch, Write |
| company MCP tools | unaffected |
| names the CLI does not ship (`MultiEdit`, `TodoWrite`, …) | ignored, no error |
| Glob `*.md` / Grep `Pat` in the seat's own folder | 1 file / 3 matches |
| `gate.bypassed`, `unknownTools` | 0, none |

## Findings

| ID | Severity | Finding | Resolution |
| - | - | - | - |
| 1 | LOW | SECURITY.md overstated it: the CLI adds tools bundled with a named one | stated, with 2.1.301 measured as having none |
| 2 | LOW | Glob/Grep row undated | "measured on 2.1.301" |
| 3 | LOW | `ExitPlanMode` (and `Skill`) offered with no use | `NOT_OFFERED`; `skills: []` |
| 4 | LOW | the session test compared `offeredTools` with itself | direct asserts on Bash, CronCreate, Skill, `skills` |
| 5 | INFO | `TaskCreate`/`Get`/`Update`/`List` are the to-do successor | added to `FREE_TOOLS` |
| 6 | INFO | `Monitor` and `ToolSearch` are named but turn themselves on | confirm `Monitor` on the next contained shift |

Tests 821/821; `npm run check` clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
