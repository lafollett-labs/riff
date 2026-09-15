# Code Review — agent redefine endpoint + tools_missing startup-race grace

**Verdict:** ✅ APPROVED (all HIGH/MEDIUM/LOW findings remediated in the working tree before commit)
**Reviewer:** Marvin (technical oversight) + `code-reviewer:pe-vue` (adversarial five-pass on the Desk surface)
**Review Round:** 1
**Reviewed SHA:** base `100fc2e` (pre-commit review of working-tree changes)
**Scope:** the working-tree diff only — two independent changes:

1. **tools_missing startup-race fix** — `src/runtime/staff.ts`, `test/ceiling.test.ts`
2. **Agent redefinition** — `src/company/redefine.ts` (new), `src/gateway/server.ts`,
   `desk/src/api.ts`, `desk/src/views/Staff.vue`, `test/redefine.test.ts` (new), `e2e/desk.spec.ts`

## Why

**tools_missing** was a startup race, not a dead server. The SDK emits its `init`
snapshot before the non-blocking in-process (`type:'sdk'`) company MCP server has
finished connecting — on a resumed session, transcript-load jitter fires `init`
early, so `mcp_servers` shows the company server `pending` or omits it. Read once,
that looked like a dead permission channel and a healthy resume was aborted for
`shift.tools_missing` (Rafe, 2026-09-03). The cold retry heals most, but the shift
is wasted. Now the init handler polls `q.mcpServerStatus()` over a bounded ~3s
grace window before declaring the tools missing; a still-connecting server reaches
`connected` in well under a second, and only a genuinely dead one runs the budget
out (then the existing one cold retry still applies).

**Redefinition**: `role` was set at hire and `mandate` at genesis, with no way to
change either afterwards — only rename (a name) and retire (a departure). Altering
what an agent *is* meant hand-editing `persona.md` under a stopped company and
committing it in the world repo by hand (which is how Jack was redefined on
2026-09-14). This makes it an operation: `POST /api/agents/redefine`, a
`redefineAgent` module, a client method, and a **Redefine…** panel in the Staff
console at parity with rename/retire. The system prompt is built from `agent.role`
(ledger) and the persona body (`world.readPersona`), never from `mandate` or the
charter — so role and persona are the behavioural levers; mandate is recorded for
the board.

## Key correctness verifications

- **Grace poll does not deadlock the message loop.** `await awaitToolsConnected(q)`
  runs inside `for await (const m of q)`, which stops pulling messages while it
  waits. Confirmed against the installed SDK (`@anthropic-ai/claude-agent-sdk`
  0.3.243, `sdk.mjs`): the `Query` constructor starts `this.readMessages()`
  **without awaiting it** — a background pump that reads the transport and resolves
  `pendingControlResponses` handlers independently of iterator consumption. So the
  `mcpServerStatus()` control response resolves even while the grace poll blocks the
  consumer. No hang; the shift-timeout remains the backstop regardless.
- **A redefine persona write is committed as the company, not the agent.**
  `redefineAgent` calls `world.git.commitAs({ id: 'company', … })`, so a running
  shift's `git add -A` cannot sweep an operator's edit into the agent's own commit
  and sign it with the agent's name. Takes effect on the next shift.
- **XSS surface clean** (pe-vue INFO-002): the new persona editor binds untrusted
  agent text only through `<textarea v-model>`. The pre-existing persona preview
  (`v-html="render(...)"`) is unchanged; `render` runs markdown-it with `html:false`.
- **Board guard** on both the server (`tier === 'board'` refused) and the Desk button.

## Findings (pe-vue on the Desk surface) — all remediated

### 🟠 HIGH-001 — persona diff baseline was a moving async target (FIXED)
`doRedefine` diffed the persona field against the **live** `persona.value` at save
time, not against its value when the editor opened. Two triggers: (1) the
empty-wipe race — `select` sets `persona.value = ''` then awaits the fetch, and the
Redefine button rendered during that window, so an untouched field captured `''`
and, once the fetch resolved, diffed as a change and sent an empty body that the
server wrote — **wiping the brief**; (2) a concurrent shift's `onEvents` persona
refresh moved the baseline under the editor, committing a stale body over a fresher
one. **Fix:** froze the baseline in `rPersonaBase` at open and diff against it;
gated the Redefine button on the load (`:disabled="loading"`); reset `redefining`
on seat switch; and skip the `onEvents` persona refresh while that seat's editor is
open. The new e2e test proves a role-only edit sends `changed: ['role']` and leaves
the brief intact.

### 🟡 MEDIUM-001 — no e2e coverage for the Redefine flow (FIXED)
Rename and retire each had a Playwright test; redefine had none (`test/redefine.test.ts`
is backend-only). Added `e2e/desk.spec.ts` "a seat can be redefined from the console,
sending only the fields that changed": asserts the board seat has no Redefine button,
that a missing reason is refused, that a role-only save emits `agent.redefined` with
`changed: ['role']` and `by: 'board'`, that the ledger role updated, and that the
persona body was untouched — then restores the fixture.

### 🟢 LOW-001 — mandate diff untrimmed while role was trimmed (FIXED)
A whitespace-only mandate edit passed the client diff but the server found no real
change, so the operator got a 409 after an apparent save. The client now trims the
mandate for its diff (persona stays untrimmed — its whitespace is body content).

### 🟢 LOW-002 — Escape closed the panel only from the Why field (FIXED)
Added `@keyup.esc` to the Role input.

### ℹ️ INFO
- **INFO-001** — panel state reset on seat switch: `select` now clears `redefining`,
  and the Redefine/Retire buttons are mutually exclusive per seat (tightened beyond
  the sibling rename/retire convention).
- **INFO-002** — XSS surface confirmed clean (see above). No action.

## Marvin's own generic pass (src, no TS/Node PE) — remediated
- **HTTP status parity**: redefine mapped all non-404 refusals to 409; retire uses
  400 for "say why". Aligned: 404 no-agent, 409 rule-refusal (board) / nothing to
  reconcile, 400 for bad input (no reason, over a cap).
- **Truthful `changed`**: `'persona'` was reported whenever a body was *supplied*;
  now only when the body actually differs from what is on file (a role-only edit
  rewrites the header but is reported as `'role'`).

## Verification
- `npm run check` — clean (SFC check + all three tsgo passes; no desk↔src drift).
- `npm test` — 605 pass, 0 fail (+6 grace-poll unit tests, +12 redefine module tests).
- `npm run test:ui` — 71 pass (+1 redefine e2e).

## Landing
Deferred until ShipIt is stopped (it is). A rebuild is required because `staff.ts`
runs in the container; commit + `up --build` land together while the company is
paused. The rebuild does not restart ShipIt.
