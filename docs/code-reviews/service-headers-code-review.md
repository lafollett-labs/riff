# Code Review — static non-secret headers on a service route

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff (mixed: generic three-pass for the TS/secrets-path files + pe-vue for the Desk view) |
| Review round | 1 (MEDIUM + LOWs remediated in-round) |
| Reviewed SHA | 5e97909 |
| Files | `src/core/config.ts`, `src/keyproxy/main.ts`, `src/mcp/client.ts`, `src/mcp/server.ts`, `desk/src/views/Services.vue`, `test/services.test.ts`, `test/keyproxy.test.ts`, `test/mcp.test.ts`, `e2e/desk.spec.ts` |
| Verdict | ✅ APPROVED |

## What changed

A subscription/OAuth upstream needs headers beyond the credential — Anthropic
wants `anthropic-beta: oauth-2025-04-20` and a `claude-code/<ver>` user-agent, the
pair the Agent SDK adds. The injecting proxy could set only the one credential
header a route named, so a subscription token arrived at `api.anthropic.com`
missing the beta + UA and was refused — which is why ShipIt's product routed
through OpenRouter instead of Anthropic-direct.

- **`ServiceRoute.headers`** (`config.ts`): static, NON-secret literals injected
  on every forwarded request. `validateServiceRoute` lower-cases keys, holds each
  to the RFC-7230 token set, rejects control chars in values, refuses a key that
  names the credential header (default `authorization`, or a route's custom one)
  or a connection-framing header (`FORBIDDEN_STATIC_HEADERS`), and caps the map at
  50.
- **keyproxy injection** (`keyproxy/main.ts`): static headers apply after the
  caller's headers (so a route-declared `user-agent` wins over the product's) and
  the credential injects **last** so it always wins; a defense-in-depth pass skips
  any static key in `HOP_BY_HOP` or equal to the credential header, for a
  hand-edited/imported config that bypassed the validator.
- **MCP** (`mcp/client.ts`, `mcp/server.ts`): `riff_services` / `riff_set_service`
  / `riff_delete_service`. No tool ever takes a secret VALUE — only the vault
  secret's name — so the credential-values rule holds.
- **Desk** (`Services.vue`): a static-headers editor (key/value rows) behind the
  existing advanced toggle; the route list shows each as a chip.

## Method

Mixed diff. Generic three-pass (Architecture → Quality/Correctness → Security) +
adversarial re-read over the TS/secrets-path files, run by the calling agent
(no Go/infra PE matches plain TS). `pe-vue` dispatched for `Services.vue` +
`e2e/desk.spec.ts` (five-pass). SECURITY.md re-read before touching the secrets
path. `npm run check` clean; `npm test` 636/636; `npm run test:ui` 72/72.

## Findings

No CRITICAL / HIGH.

### Fixed in-round

- **MEDIUM (pe-vue MEDIUM-001) — editable header rows keyed by array index.**
  `v-for :key="i"` patched inputs by position, so removing row A while typing in
  row C left the caret bound to a neighbour's data. Fixed: each row carries a
  stable `id` (`hrSeq`), and the `v-for` keys on `hr.id`. Verified `check` + 72/72.
- **LOW (pe-vue LOW-001) — focus dropped to `<body>` on remove, not advanced on
  add.** The rest of this view keeps a deliberate focus discipline; the new editor
  broke it. Fixed: `addHeaderRow`/`removeHeaderRow` move focus to the affected
  row's name input (or the add button when the list empties) via a group ref +
  `nextTick`.
- **LOW (pe-vue LOW-002) — duplicate keys collapse silently** (case-insensitively,
  since the server lower-cases). Added a `dupHeader` warning and a hint line that
  names are stored lower-cased, so the collapse and the case change are not a
  surprise.
- **LOW (pe-vue LOW-003) — repeated identical `aria-label`s** across rows. Numbered
  the input labels to match the remove buttons, and wrapped the rows in a
  `role="group"` labelled "Static headers".
- **INFO (pe-vue INFO-002) — long values could overflow `.rmeta`.** Added
  `flex-wrap` to the meta row and clamped `.hchip` with `max-width` + ellipsis.

### Verified non-issues / awareness

- **Security (generic pass 3).** Credential injected last so it always wins; values
  are CRLF/control-char rejected and keys held to the RFC token set (no header
  splitting); the validator refuses the credential + framing headers and the
  keyproxy re-asserts both (fail-closed) for hand-edited configs. No secret VALUE
  crosses the MCP boundary. Static headers are exported with the route (non-secret);
  the vault is not.
- **INFO (generic) — `FORBIDDEN_STATIC_HEADERS` (config) duplicates `HOP_BY_HOP`
  (keyproxy).** Drift-safe: both fail closed independently, so a divergence cannot
  open a hole. A shared constant or a parity test would prevent silent divergence —
  noted, not changed.
- **INFO (generic) — a static key of `__proto__`** passes the token regex but is
  silently dropped when building the map (assigning `__proto__` on a plain object
  is a no-op; string values, no pollution; the keyproxy would drop it too). Not a
  real use case and not exploitable; noted for consistency with the existing
  `RESERVED_SERVICE_NAMES` handling.
- **INFO (pe-vue INFO-001) — `staticHeaders()` allocates per render.** Negligible
  (infrequent re-render, tiny objects, stable `:key`), and mirrors the adjacent
  `effect()` call. No change.
