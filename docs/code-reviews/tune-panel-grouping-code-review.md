# Code Review — Tune panel grouping + accessibility

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | Working-tree diff (single PE — pe-vue) |
| Review round | 1 (MEDIUM remediated in-round) |
| Reviewed SHA | 9d47aaf (working tree) |
| Files | `desk/src/views/Overview.vue`, `test/policy.test.ts` |
| Verdict | ✅ APPROVED |

## What changed

The Tune panel (the company-policy editor) had grown to nine dials plus three
transformed fields in one flat column. Refactored into **four labeled groups** —
Cadence, Conversations, Rationing, Safety limits — each with a short caption, and
the accessibility of every control fixed along the way.

- `DIAL_GROUPS` (title, caption, keys, `extras?`) drives the render; the flat
  `DIALS` array is unchanged and stays the single source the dirty-check and save
  map read, so a dial can be grouped but never un-saved. `groupDials(keys)`
  resolves a group's keys to `DIALS` entries.
- Template: `v-for` over groups → an `<h3>` + caption + the group's dials; the
  three hand-rendered fields (Slow down at / Stop at / Daily spend cap) render
  inside the `extras`-flagged Safety limits group.
- **Accessibility:** dials are no longer a wrapping `<label>` that folded the
  multi-sentence hint into the input's accessible name. `.k` is now a
  `<label :for>`, the input carries the matching `:id` + `:aria-describedby`, and
  the hint span carries that id — so the name is the short label and the hint is a
  description (the correct WCAG help-text pattern).
- Styles: per-dial borders replaced by group eyebrows with a top rule; a
  `@media (max-width: 560px)` block stacks each dial to one column.

## Method

Single-PE: `pe-vue` five-pass (Architecture → Quality+Tests → Security →
Adversarial → Self-Adversarial). `npm run check` clean; `npm test` 625/625;
`npm run test:ui` 71/71.

## Findings

### Fixed in-round

- **MEDIUM (pe-vue MEDIUM-001) — the `DIAL_GROUPS`↔`DIALS` coupling was
  unenforced in both directions.** A dial present in `DIALS` but omitted from every
  group would render nowhere yet pass all 625+71 tests, because the
  `policy.test.ts` editor-coverage guard only inspects `DIALS` — the exact
  "real field, no editor" bug that guard exists to prevent. And a stray/typo'd
  group key (`keys: readonly string[]`) would slip past tsgo and throw at render,
  masked by the `!` in `groupDials`. **Fixed as prescribed:**
  1. Typed the keys as `type DialKey = (typeof DIALS)[number]['key']`, so tsgo
     rejects a stray or renamed key and the `!` is provably safe (stray direction).
  2. Added a `policy.test.ts` guard scraping both `DIALS` and `DIAL_GROUPS` keys
     from source and asserting they are a permutation — no dial missing from a
     group, none duplicated (missing direction, which types cannot see).
  Verified: `npm run check` clean, the new guard passes, 625/625 + 71/71.

### Verified correct (pe-vue INFO — awareness)

- **a11y wiring** — accessible name is the short label; hint is `aria-describedby`;
  no duplicate ids (`dial-${key}`/`why-${key}` unique via unique DIALS keys;
  static `dial-throttle|pause|cap` collide with no dial key); heading order
  h1→h2→h3 non-skipping.
- **`groupDials` template call** — re-runs per render but depends only on static
  consts, 9 keys × O(9) `.find`, stable `:key` and element refs; a `computed`
  would not measurably help. No action.
- **bind/save/reset parity** — `DIALS` unchanged; the three special refs
  unchanged; `v-model.number` bindings byte-identical; `maxTurns` still renders
  first, so the e2e `input.first()` locators still target it.
- **Security** — no data flow, secret, or endpoint change; a presentational
  refactor of an existing authenticated panel.
