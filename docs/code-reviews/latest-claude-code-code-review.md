# Code Review — each Claude Code release as it ships, with a gate that does not depend on it

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | infra and security review, three rounds; live probes in throwaway companies (`probe-gate-latest`, `probe-peer-off`, since deleted) |
| Base SHA | a8f6154 |
| Files | `docker/{Dockerfile,compose.yaml,compose.dev.yaml,up.sh}`, `package{,-lock}.json`, `src/core/config.ts`, `src/runtime/{staff,permissions}.ts`, `SECURITY.md`, `test/{container,permissions,shift-landing}.test.ts` |
| Verdict | ✅ APPROVED (round 3) |

## Origin

Cali asked for Riff to run the newest Claude Code always: Anthropic ships almost
daily, and he runs his own CLI on auto-update. Two things stood in the way:

- a8f6154 had pinned the SDK exactly, and the image carried a second, separate
  `claude-code@latest`, 2.1.270, next to an SDK on 2.1.281.
- The gate's pre-check ran only for the tools measured to skip canUseTool.
  ShipIt's transcripts show that list was already stale: four `Monitor` shell
  commands (2026-09-15 and -17, one polling api.github.com), `SendMessage` ×4,
  `ListAgents` ×3, `TaskStop` ×3 and `ToolSearch` ×61. None has a gate event.

## Measured live

| Check | Result |
| - | - |
| `claude` on PATH | links to the SDK's own binary; 2.1.281; the build fails if it and the SDK's `claudeCodeVersion` disagree |
| the keyproxy's user-agent | `claude-code/2.1.281`, read from the one SDK file it carries |
| `SendMessage` / `ListAgents` to a peer | refused by the hook; listed in `agent.slept.unknownTools` |
| shell, `Write`, the company's own MCP tools | gated as before; `gate.bypassed` 0 |
| `SendMessage` to `bridge:abc` with `CLAUDE_CODE_HARBOR_KITE=0` | the CLI's own refusal: "Cross-session messaging is not available" |
| background subagent | `gated: true`; its name stops being an address once it finishes |
| `agent.slept.cli` | `2.1.281` |
| `Monitor`, `ToolSearch` | not in a shift's tool set on 2.1.281 with non-essential traffic off; their classification is unit-tested |

## Findings

| Round | ID | Severity | Finding | Resolution |
| - | - | - | - | - |
| 1 | I-M1 | MEDIUM | A new minor line or an unreachable registry fell back to the lockfile, which is a silent downgrade | picks the newest stable release in the line; an unreachable registry warns that it may downgrade |
| 1 | I-M2 | MEDIUM | the SDK at npm latest runs in the gateway, next to `master.key` | documented in SECURITY.md; no soak window, by the operator's choice; `CLAUDE_SDK_VERSION` rolls back |
| 1 | I-L1 | LOW | an env-file pin was overridden by the export | pins in `docker/.env` / `$RIFF_ENV` are left for compose |
| 1 | I-L2 | LOW | the UA fell back silently; SDK/CLI parity was unchecked | build-time parity check; a stderr warning on fallback |
| 1 | I-L3 | LOW | nothing tested the keyproxy's single-file COPY or the single-CLI rule | static Dockerfile tests |
| 1 | G-M1 | MEDIUM | `Monitor` with `ws` was recorded as an opaque shell | `external.read` with the URL; neither or both is refused |
| 1 | G-M2 | MEDIUM | canUseTool without the hook fell back to a weaker gate | runs the pre-check first |
| 1 | G-M3 | MEDIUM | the tripwire missed ignored denials and failed runs | `ignored` / `failed` |
| 1 | G-M4 | MEDIUM | default-deny of SendMessage broke steering of the shift's own subagents | allowed only to the shift's own subagents |
| 1 | G-L2..L5, I1 | LOW/INFO | pruning; `disallowedTools` from `SHELL_TOOLS`; version attribution; task tools made FREE; `UNKNOWN_TOOL` | fixed |
| 2 | R2-S1 | MEDIUM | the SendMessage allow-list was seeded from model text, including refused spawns (`bridge:<id>` as a description) | registered only after a spawn the gate allowed has run, by its `name` and the CLI receipt's `agentId`; peer-shaped addresses always refused |
| 2 | R2-S2 | LOW | the pre-hook refusal regex was too broad | superseded by the probe below |
| 2 | R2-I1 | LOW | the pin grep missed `export` and indented forms | fixed; an empty value is not a pin |
| 2 | R2-I2 | INFO | a call decided through the fallback was reported as a bypass | `how: "unhooked"` |
| 3 | R3-S1 | LOW | a plain name could match a peer session | `CLAUDE_CODE_HARBOR_KITE=0` turns off cross-session messaging at the CLI; names expire when their subagent ends |

After round 3, the `probe-peer-off` shift showed that the CLI's checks before
any hook return free-form `<tool_use_error>` text, which the tripwire counted as
`failed`. R2-S2's narrower match is replaced: any tagged error is the CLI's own
and is not counted. A tool that really goes around the hook still shows up on a
call that succeeds.

## Follow-ups

- `Monitor` and `ToolSearch` are unmeasured live on a release that offers them.
- Whether shifts in the one container can see each other's peer sockets is
  unmeasured. With cross-session messaging off, the question is moot.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
