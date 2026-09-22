# Code Review — per-seat model and effort

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | pe-vue five-pass (desk) + generic three-pass with adversarial passes (backend), two rounds each, on the staged diff |
| Base SHA | ffa2255 |
| Reviewed SHA | 4de747a |
| Files | `src/core/models.ts` (new), `src/runtime/models.ts` (new), `src/runtime/staff.ts`, `src/runtime/scheduler.ts`, `src/company/{registry,hire,genesis,rename}.ts`, `src/core/{config,types}.ts`, `src/ledger/{ledger.ts,schema.sql,transcript.ts}`, `src/gateway/server.ts`, `src/mcp/usagePoll.ts`, `desk/src/{api.ts,models.ts}`, `desk/src/views/{CompanySettings,Staff}.vue`, tests, `package.json` / lock |
| Verdict | ✅ APPROVED (round 2) |

## What changed

Every seat was stamped `claude-opus-5` at hire with no way to change it, and effort
was one hard-coded `'medium'` in `staff.ts`. Now:

- **Company default** (`RiffConfig.staff`, Settings → Thinking): model + effort. Default
  is `default`, passed through to the CLI, so it tracks Claude Code's own default
  (the latest Opus). Kept out of `policy` on purpose: read per wake through a scheduler
  getter, so saving it never rebuilds the company or aborts a shift.
- **Per-seat override** (Staff): `company` inherits; anything else singles the seat out.
  Board-only through `POST /api/agents/model`; no staff tool sets either value.
- **Catalog** from the bundled CLI's own `supportedModels()` (`GET /api/models`), so an
  SDK bump brings its models with it. Fallback list when the probe fails.
- **Ledger**: `agents.effort` column; one-time migration moves every hire-time stamp to
  `company` (guarded by `migrated:seat-models`, re-read inside the write lock).
- **Record**: `agent.slept` / `agent.failed` carry the model and effort the CLI reported
  at init — what ran, not what was asked for.
- **SDK 0.3.243 → 0.3.280** (CLI 2.1.280). Measured: `default` resolved to Opus 5 on
  0.3.243 and to `claude-opus-5-5[1m]` on 0.3.280. User-agents bumped, now pinned to the
  installed SDK by a test.

## Findings — Round 1

Backend (generic):

- **HIGH F1 — the SDK bump froze each seat's system prompt.** CLI 2.1.280 records a
  conversation's system prompt on its first request and replays it on every resume
  until compaction (`systemPromptSnapshot` defaults on; absent from 2.1.243). Roster,
  rules, persona and memory would have stayed as they were the day a conversation
  began. **Fixed:** `systemPrompt: { type: 'custom', prompt, snapshot: false }`; pinned.
- **HIGH F2 — the SDK bump made usage cumulative across resume.** A resumed session's
  `modelUsage` / `total_cost_usd` now start from the transcript's saved totals, so
  summing results recorded every earlier shift again and vitals would grow
  quadratically. **Fixed:** `meterDelta` counts what each result added over a
  per-session baseline kept in meta (`session-meter:<agent>`); new session → zero;
  resets never go negative. Four unit tests. The transcript's result meta is renamed
  `sessionCostUsd` to say what it is.
- **LOW F5 — catalog probe.** Now raced against a timeout (not only aborted), run with
  an env stripped of `ANTHROPIC_*` / OAuth vars and a throwaway `CLAUDE_CONFIG_DIR`.
  Measured on host: 3.2 s, no credentials.
- **LOW F6 — migration guard outside its transaction.** Re-read under `BEGIN IMMEDIATE`.
- **LOW F7 — tests on helpers, not wiring.** Source pins added for the model/effort sent
  and the resolved-model window key (the repo's existing pattern; no SDK stub exists).
- **INFO F10** — a trace line when no context window resolves (rotation would be off).
- **INFO F8/F9** — catalog resolves `default` tokenless while shifts authenticate
  through the keyproxy; a seat moved to a smaller-window model resumes a conversation
  that may not fit. Awareness; F8 is checked on the first live shift.

Desk (pe-vue): MEDIUM-001 the stored model read "not offered by this CLI" while the
catalog loaded (now a `loading/ready/failed` status); LOW-001..006 (stale "Saved.",
unannounced error, duplicated effort list now typed `Record<Effort,…>`, effort picker
locking on Haiku, pickers surviving a company switch, misplaced JSDoc). All fixed.
INFO-001 focus after Save: awareness, as INFO-002 in the Overview split review.

## Findings — Round 2 (verification)

All in-scope round-1 findings confirmed resolved by both reviewers. New:

- **LOW R2-1** — `meterDelta` keeps the higher baseline so a zeroed crash result cannot
  erase it; wrong if the CLI ever persists a genuine reset for the same session.
  Unmeasured. **R2-2** — assumes resume keeps the session id (as `session-turns`
  already does). Both are checked against the first live resumed shift.
- **INFO R2-3** (probe temp dir on a synchronous throw) and **R2-4** (transcript cost
  meta) — fixed. pe-vue **INFO-002** (status stuck on `failed` during a retry) — fixed.

## Out of scope — raised for a separate change

- **F3 (pre-existing, HIGH class)** — the shift sandbox's `allowWrite` is the whole
  company home, so a contained shift's Bash can write `ledger.db` and `config.json`
  — approvals, policy, and now model/effort. SECURITY.md covers reading the own
  ledger, not writing it. Fix: narrow writes to `world/` + caches, prove it in a
  contained probe. Until then "board-only" holds at the API and tool layer, not in
  the container.
- **F4** — whether a contained shift can reach the unauthenticated gateway on loopback.
  Unmeasured; needs one probe from a real contained shift.

## Verdict

✅ **APPROVED.** Two regressions the SDK bump would have shipped silently (a frozen
system prompt, quadratically inflating usage) were caught and fixed with tests. Gates:
`npm run check` clean; `npm test` 654 pass; `npm run test:ui` 80 pass.
