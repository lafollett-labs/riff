# Code Review: scoped-secret-env

**Verdict:** ✅ APPROVED

| | |
| - | - |
| **Branch** | `main` |
| **Reviewer** | @Cali LaFollett |
| **Review Round** | 1 |
| **Reviewed SHA** | `e1a8658dd4fd0e8765b44e2ecf306e0e2aacf425` |
| **Title** | Extract `scopedSecretEnv`; test the per-shift proxy token reaches the product |
| **Files Changed** | 2 |
| **Lines Changed** | +142 / -15 |
| **Date** | 2026-09-13 |

---

## Summary

Phase 1 test-gap closure for the per-company Claude provider work. The per-shift
scoped-proxy-token env builder was inlined in `runLeg` and merged into the shift
child-process env, but no test proved the product actually receives a usable token
under each declared service's secret name. The change extracts that logic as a pure
exported `scopedSecretEnv` (behaviour identical — same TTL, same guard, same
route→secret loop) and adds `test/shift-env.test.ts`, which mints real tokens and
verifies them with the real `verifyScopedToken`, plus a source guard that the built
env is spread into `query()`'s `env`. Generic three-pass (Architecture → Quality+Tests
→ Security); no matching PE for plain `src/**/*.ts`. `npm run check` clean, `npm test`
572/572, new suite 8/8. No in-scope defects; one INFO on an intentional design choice.

---

## Findings Overview

| Severity | In Scope | Out of Scope |
| -------- | -------- | ------------ |
| 🔴 CRITICAL | 0 | 0 |
| 🟠 HIGH | 0 | 0 |
| 🟡 MEDIUM | 0 | 0 |
| 🟢 LOW | 0 | 0 |
| ℹ️ INFO | 1 | 0 |

---

## In Scope Findings

### ℹ️ INFO-001: The env-wiring source guard is formatting-sensitive by design

**Domains:** [Testing]
**Location:** `test/shift-env.test.ts:96`

The guard `assert.match(src, /env: \{ \.\.\.process\.env,.*\.\.\.secretEnv \}/)` matches
the literal single-line env spread in `staff.ts`. A behavioural unit test cannot drive
the real `query()`, so this asserts by source text that the built `secretEnv` is spread
into the child-process env — the one seam the eight behavioural tests above it cannot
reach. It will break if that env spread is reflowed across multiple lines.

This is the same deliberate tradeoff `test/ceiling.test.ts` already makes (it asserts
against `staff.ts` source text for internals that can't be executed in isolation): a
reformat of exactly the credential-wiring line *should* trip a test that makes a human
re-confirm the tokens still reach the child. Kept as-is; noted so the next reader knows
the sensitivity is intentional, not an oversight.

---

## Architecture (Pass 1)

- Clean SRP extraction of a pure function from a closure; no new coupling.
  `mintScopedToken` was already imported. The helper is exported solely to make the
  credential wiring testable — documented in its doc comment.
- Behaviour is identical to the prior inline loop: TTL `ceil(shiftMs ?? 45m /1000)+300`,
  the `!companySlug || !services || !size` guard, and the `route.secret → token` loop
  all preserved. The downstream `Object.keys(secretEnv).length` gate at the env-spread
  site is unchanged and still correct (`{}` when empty).

## Quality + Tests (Pass 2)

- `npm run check` clean; `npm test` 572/572; new suite 8/8.
- Test coverage is behavioural, not mock-shaped: company scoping, value-is-token-
  not-name regression, per-service tokens, shared-secret dedup, TTL past the shift
  clock, and empty cases — all against the real verifier.

## Security (Pass 3)

- Invariant holds: each service's secret env var carries a *scoped token* (a
  capability), never the real key, which stays in the proxy container. The extraction
  moves no key material.
- Shared-token-per-secret is correct — the token identifies the company, not the route.
- Exporting `scopedSecretEnv` does not widen the trust boundary: it signs with the
  installation-root secret that no world can read, and staff runs server-side, not in
  the agent sandbox.
- No secret is logged; `withoutSecrets` redaction is unchanged.

---

## Files Reviewed

| File | Findings |
| ---- | -------- |
| `src/runtime/staff.ts` | 0 |
| `test/shift-env.test.ts` | 1 (INFO) |

---

## Merge Eligibility

**Locked to SHA:** `e1a8658dd4fd0e8765b44e2ecf306e0e2aacf425`
**Status:** ✅ Mergeable IF `git rev-parse HEAD == e1a8658dd4fd0e8765b44e2ecf306e0e2aacf425`. Any commit after this SHA invalidates this round and requires re-review (`/code-reviewer` again before merge).

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
