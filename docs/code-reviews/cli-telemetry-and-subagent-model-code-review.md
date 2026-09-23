# Code Review — the CLI's own telemetry off, and a subagent held to its seat's model

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | security review, one round; live probes in throwaway companies (`egress-probe`, `flags-probe`, since deleted) |
| Base SHA | 9a970ea |
| Files | `src/runtime/{staff,permissions}.ts`, `docker/proxy/denylist.conf`, `SECURITY.md`, `test/{container,permissions}.test.ts` |
| Verdict | ✅ APPROVED |

## Origin

The subagent review's egress check found the CLI inside each shift sending its
own traffic out through the egress proxy, around the keyproxy. In a half hour of
ShipIt it made 21 connections to `api.anthropic.com` and 30 to
`http-intake.logs.us5.datadoghq.com`. Cali also ruled that a seat's model binds
its subagents.

## Measured live

| Check | Result |
| - | - |
| direct CONNECTs in a probe shift, switch off → on | 2 → 0; model calls unchanged through the keyproxy |
| the Datadog intake, from the factory through egress | refused: "Proxying refused on filtered domain" |
| `api.anthropic.com`, the same way | reachable |
| a spawn with `model: "haiku"` | refused before it ran; the same spawn without `model` ran on the seat's model |

The same shift was re-run with the switch on (N-2), to check the behaviours
measured earlier, some of which could be controlled by feature flags:

| Behaviour | Result |
| - | - |
| colleague `Read` | `world.read_other` |
| one shell command | one `gate.allow shell` |
| remote spawn | refused |
| background spawn | finished by its notice: 1 call, 5239ms |
| 1-minute budget | notice quoted; `landed: time` at 65s |
| direct egress | 0 |

## Findings

- **N-1 LOW (fixed)**: the SECURITY.md row now says any `model` is refused.
  Aliases name no pinned version, so matching the seat's model cannot be decided.
- **N-2 LOW (measured)**: the re-run above.
- **N-3 INFO (noted)**: the denylist lists one regional Datadog host. A periodic
  count of non-keyproxy egress would show any new destination.

✅ **APPROVED.** `npm run check` is clean; `npm test` passes 759 of 759 on the
host and 759 of 759 in the factory image.
