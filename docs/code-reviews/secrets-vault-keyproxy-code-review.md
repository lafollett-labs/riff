# Code Review — per-company secrets vault + key-injecting proxy

**Verdict:** ✅ APPROVED (round 2)
**Reviewer:** Marvin (orchestrator) + `pe-aws-infra` (docker) + adversarial security PE (TS core)
**Scope:** Staged diff, 17 files, +1253 / −42. Lands on `main`.

## What it is

Per-company secrets that agents can *use* but never *possess*. An encrypted
vault (`src/core/secrets.ts`), HMAC-scoped per-shift tokens
(`src/core/proxytoken.ts`), and a key-injecting proxy that runs in its own
hardened container (`src/keyproxy/main.ts`, compose service `keyproxy`). The
real key is decrypted only in the proxy and injected on egress; the factory —
where the untrusted agents run — never holds it. Wired through
`/api/secrets` (write-only), a `services` config allowlist, and per-shift token
injection in `scheduler.ts`/`staff.ts`.

## Findings (round 1) and resolution (round 2)

| ID | Sev | Finding | Resolution |
| - | - | - | - |
| CRITICAL-001 | 🔴 | Shift sandbox `denyRead` covered only `/data/companies`; the secrets store (`master.key`, vaults, `keyproxy.secret`) are siblings under `/data` and bubblewrap reads are allow-by-default, so a shift could `cat /data/master.key` and decrypt every company's keys / forge any token. | **Fixed** — `denyRead: [installRoot(), …]`, extracted to the tested pure fn `sandboxFilesystem(worldRoot)`; `allowRead` re-admits only the company home (more-specific-wins). `test/sandbox-filesystem.test.ts` locks it. Re-verified: the direct-decrypt and forge paths are closed; no legitimate read regressed. |
| HIGH-001 | 🟠 | `keyproxy` `fetch` followed redirects; undici does not strip a *custom* injection header (`X-Api-Key`) across a cross-origin hop, so an open redirect on the upstream exfiltrates the real key. | **Fixed** — `redirect: 'manual'` + refuse any 3xx-with-Location (502, own audit line). `test/keyproxy.test.ts` proves the attacker host is never contacted for both bearer and custom-header routes. |
| MEDIUM-001 | 🟡 | The key-holder sidecar reused the fat factory image (bash/curl/socat/chromium/ffmpeg/Claude-CLI) — exfil tooling in the crown-jewel container. | **Fixed** — minimal `keyproxy` Dockerfile stage: `node:26-slim` + `ca-certificates` + `src` only, `nologin`, **no node_modules** (import graph is node: builtins + `src/core`). Reviewer: "better than recommended." |
| MEDIUM-002 | 🟡 | No contract test guarding keyproxy's env against a future token/secret leak. | **Fixed** — `test/container.test.ts` guards: no token, no credentials env, `/data:ro`, `target: keyproxy`, `read_only`, `cap_drop [ALL]`, `no-new-privileges`. |
| LOW-001 | 🟢 | `secrets/` dir created world-listable (names enumerable). | **Fixed** — `writeSecret600` mkdir+chmod 0700. |
| LOW-002 | 🟢 | `secretsEqual` dead code with a misleading comment. | **Fixed** — removed (+ unused import). |
| LOW (docker) | 🟢 | `factory depends_on keyproxy` was start-order only. | **Fixed** — `condition: service_healthy`. |

## Verified-holding (round 1, unchanged round 2)

Token HMAC scheme resists forgery (split/canonicalization attacks fail);
`/api/secrets` is write-only (`getSecret` has one caller — the proxy — and the
gateway never returns a value); host-fixing prevents SSRF pivots; AES-256-GCM
with a fresh 96-bit IV per write and per-company DEK envelope; hop-by-hop header
stripping keeps the scoped token off the upstream; all failure paths fail
closed; no Claude token or factory secret in the keyproxy container; the
`NO_PROXY += keyproxy` change does not weaken the internal-network egress wall.

## Tests

515/515 pass; `npm run check` clean (tsgo strict + SFC + desk + e2e). New:
`secrets` (18), `proxytoken` (16), `keyproxy` (14, incl. redirect-refusal),
`sandbox-filesystem` (3), keyproxy container guard.

---

## Follow-on — Desk Secrets panel

**Verdict:** ✅ APPROVED (round 3) · Reviewer: `pe-vue`
**Scope:** `desk/src/views/Secrets.vue` (new), `desk/src/api.ts`, `desk/src/App.vue`, `e2e/desk.spec.ts`.

A per-company Secrets tab in the console — set a name + masked value, list names
(never values), replace, remove-with-confirm. Writes to `/api/secrets` over
loopback; `api.ts` stays type-only.

| ID | Sev | Finding | Resolution |
| - | - | - | - |
| HIGH-001 | 🟠 | Inputs had no accessible name (placeholder-only), breaking the Desk's own a11y pattern. | **Fixed** — `aria-label` on both inputs, matching Inbox/Staff. |
| MEDIUM-001 | 🟡 | e2e asserted the value via `textContent` (vacuous — input value isn't text). | **Fixed** — asserts `.fld.val` `toHaveValue('')` + a Replace-focus check. |
| MEDIUM-002 | 🟡 | Focus dropped on the destructive Remove→confirm swap; no Escape. | **Fixed** — confirm takes focus, Escape cancels, name refocused after save. |
| MEDIUM-003 | 🟡 | *(round 2, self-introduced)* `cancelBtn` ref inside `v-for` resolves to an array; `.focus()` threw, hidden by the type and by green tests. | **Fixed** — function ref captures the single open element; e2e now asserts Cancel is focused. |
| LOW-001/002 | 🟢 | Enter could double-submit; `name.trim()` in template. | **Fixed** — `canSave` computed guards both. |
| INFO-001 | ℹ️ | Password manager might offer to save the value. | `autocomplete="new-password"` + `data-1p-ignore`/`data-lpignore`. |
| INFO-004 | ℹ️ | Focus not restored to Remove after the confirm closes. | Deferred (accepted) — inline confirm, single-operator console. |

The loop's shape is the point: a real a11y gap, then a bug my *own* round-2 fix
introduced (green tests missed it), caught and closed by round 3. 62/62 UI tests,
`npm run check` clean.
