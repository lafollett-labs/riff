# Code Review — per-company service routes (`/api/services` + Desk Services tab)

**Verdict:** ✅ APPROVED (round 1 + remediation)
**Reviewer:** Marvin (orchestrator) + `pe-vue` (Desk) + adversarial security PE (backend TS)
**Reviewed SHA:** `44c6d59`
**Scope:** Staged diff, 11 files, +~640. Lands on `main`.

## What it is

The follow-on to the secrets vault + keyproxy feature. A **service route** maps a
named service to an upstream host and the vault secret the key-injecting proxy
injects on the way out. Setting one was the last operator action reaching past
the API — a hand-edit of `config.json`. Now it is `/api/services` (GET/PUT/DELETE)
and a Desk **Services** tab.

- `validateServiceRoute` (`src/core/config.ts`) — the gate between operator input
  and what the proxy acts on. https-only, no embedded creds, no control chars in
  the scheme, RFC-7230 header names, reserved prototype-chain names refused.
- `registry.update` takes a set/remove **delta** merged against the config it
  reads fresh, non-structural (the proxy reads routes per-request; no shift is
  aborted).
- Desk `Services.vue` — name + upstream + secret (picked from the names already
  set), optional header/scheme. A route holds no value, so the whole map reads
  back; the view warns when a route names a secret that is not set.

## Findings and resolution

### Backend — adversarial security PE

The security-critical core was **verified sound, not merely un-flagged**: no
secret-VALUE read path (routes carry a secret NAME; the vault is separate and
exposed by no endpoint; GET returns names/hosts only); https-only holds against
every bypass tried (`http:`/`javascript:`, userinfo `https://u:p@evil`, NUL in
authority, `https:evil`, `HTTPS://Evil.COM`, backslash-authority confusion) —
verified by running them through `new URL` + the validator; header-name and
CRLF injection blocked; persistence is ledger-safe (writes `config.json` only,
never the ledger/WAL) and fail-closed (invalid → 400, nothing persisted).

| ID | Sev | Finding | Resolution |
| - | - | - | - |
| SVC-4 | 🟢 | `SERVICE_NAME_RE` admitted `constructor`/`toString`/etc.; the proxy's `services[svc]` returns an inherited member for those, so a probe answered 502 (special) not 404 (unknown) — a regression of the proxy's "probing tells you nothing" invariant. Fails closed. | **Fixed** — validator rejects a reserved-name set; proxy `routeFor` uses `Object.hasOwn`. `test/keyproxy.test.ts` proves `/svc/constructor` → 404; `test/services.test.ts` proves the names are refused. |
| SVC-5 | 🟢 | DELETE used `name in cfg.services`, which walks the prototype chain — `?name=toString` reported `deleted:true` and rewrote config for a route that never existed. | **Fixed** — `Object.hasOwn(cfg.services, name)`. |
| SVC-6 | 🟢 | PUT built the whole services map from a request-time in-memory snapshot; two concurrent writes → the second drops the first (lost update). | **Fixed** — `registry.update` takes a set/remove delta merged against its own fresh on-disk read; `update()` has no `await` between read and write on the services path, so writes compose. `test/registry.test.ts` proves a second set composes and a delete leaves the rest. |
| SVC-3 | ℹ️ | `scheme` rejected CR/LF/NUL but admitted other control bytes (TAB, DEL, C1) — could not inject a header (no CR/LF) and failed closed as a 502 at the proxy, but better caught at the 400 gate. | **Fixed** — control-char check widened to C0/DEL/C1; test extended. |
| SVC-7 | ℹ️ | No private/loopback denylist on the upstream host. Operator-only (gateway is not agent-reachable) and the host is operator-declared, so an SSRF-to-internal is self-inflicted, https-only. | **Accepted** — trust rests on the operator by design; documented here. Revisit if the keyproxy container ever shares a network with a metadata/internal endpoint. |
| SVC-8 | ℹ️ | `config.json` is written non-atomically (whole-file), a pre-existing torn-read window shared with `setRunningFlag`/founding. | **Accepted** — not specific to this change; a repo-wide atomic-write change is its own follow-up. |

### Desk — `pe-vue`

`npm run check` clean, all e2e pass including the new service-route test. The
scheme three-state round-trip (bearer omits / raw `''` / custom) verified on both
save and edit-prefill; the v-for confirm function-ref (Cancel focus) verified
correct and asserted by e2e; selector isolation from the Secrets view confirmed;
`.rup` ellipsis keeps a long upstream from scrolling the page.

| ID | Sev | Finding | Resolution |
| - | - | - | - |
| MEDIUM-001 | 🟡 | The advanced disclosure had `aria-expanded` but no `aria-controls`, and the panel no `id` — the WAI-ARIA disclosure pattern pairs them. | **Fixed** — `aria-controls="svc-advanced"` + panel `id`. |
| LOW-001 | 🟢 | Choosing "custom prefix" with an empty value silently saved as Bearer, discarding the choice. | **Fixed** — `canSave` requires a value when the mode is custom; `save()` messages why. |
| LOW-002 | 🟢 | Focus fell to `<body>` after confirming a route removal (Secrets.vue shares this gap). | **Fixed here** — focus returns to the name input after remove. Secrets.vue parity is a noted follow-up. |
| INFO-002 | ℹ️ | Header/Scheme inputs carried both a visible `<label for>` and a differing `aria-label`. | **Fixed** — dropped the redundant `aria-label`; the visible label is the accessible name. |
| INFO-001/003 | ℹ️ | `effect()`/`includes()` per-render in the small route list; no e2e asserts no-sideways-scroll with a long upstream. | **Accepted** — negligible cost; CSS verified correct by inspection. |

## Tests

530 unit + 63 UI pass; `npm run check` clean. New: `services` validator (13),
`registry` delta compose/delete (1), `keyproxy` prototype-probe → 404 (1), the
Desk service-route e2e (1).

## Follow-ups (noted, not blocking)

- `Secrets.vue` focus-restore parity (LOW-002) — same one-liner, keep the pattern
  consistent.
- Atomic `config.json` write (SVC-8) — repo-wide, its own change.
- Private-host denylist (SVC-7) — only if the keyproxy network gains a sensitive
  neighbour.
