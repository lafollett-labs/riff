import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_POLICY, readPolicy } from '../src/core/config.ts';

/**
 * Policy arrives from a hand-edited file and from the console, so nothing here
 * may be trusted to be a number, in range, or present at all.
 */
describe('a company can be tuned without being broken', () => {
  test('a company that predates policy reads back at the defaults, not at zero', () => {
    assert.deepEqual(readPolicy(undefined), DEFAULT_POLICY);
    assert.deepEqual(readPolicy({}), DEFAULT_POLICY);
  });

  test('what is written down wins, field by field', () => {
    const p = readPolicy({ maxTurns: 120, concurrency: 6 });
    assert.equal(p.maxTurns, 120);
    assert.equal(p.concurrency, 6);
    assert.equal(p.commonsCeiling, DEFAULT_POLICY.commonsCeiling, 'untouched fields keep the default');
  });

  test('nonsense falls back rather than propagating', () => {
    const p = readPolicy({ maxTurns: 'lots', concurrency: null, baseIntervalMinutes: NaN });
    assert.equal(p.maxTurns, DEFAULT_POLICY.maxTurns);
    assert.equal(p.concurrency, DEFAULT_POLICY.concurrency);
    assert.equal(p.baseIntervalMinutes, DEFAULT_POLICY.baseIntervalMinutes);
  });

  test('a turn ceiling of zero would mean a company that cannot work', () => {
    assert.equal(readPolicy({ maxTurns: 0 }).maxTurns, 1);
    assert.equal(readPolicy({ maxTurns: -5 }).maxTurns, 1);
  });

  test('a thousand concurrent agents is not a configuration, it is an accident', () => {
    assert.equal(readPolicy({ concurrency: 1000 }).concurrency, 16);
  });

  test('stopping below where it slows down would mean it never slows down', () => {
    // Ordered, whichever way round they were written.
    const p = readPolicy({ throttleAboveUtilization: 0.9, pauseAboveUtilization: 0.4 });
    assert.ok(p.pauseAboveUtilization >= p.throttleAboveUtilization,
      `stop ${p.pauseAboveUtilization} is below slow-down ${p.throttleAboveUtilization}`);
  });

  test('a full window is a valid answer: never stop', () => {
    assert.equal(readPolicy({ pauseAboveUtilization: 1 }).pauseAboveUtilization, 1);
  });

  test('turns and headcount are whole things', () => {
    const p = readPolicy({ maxTurns: 60.7, concurrency: 2.4, commonsCeiling: 40.5 });
    assert.equal(p.maxTurns, 61);
    assert.equal(p.concurrency, 2);
    assert.equal(p.commonsCeiling, 41);
  });

  test('the shift-trace flag is off by default and takes only a real boolean', () => {
    assert.equal(readPolicy({}).shiftTrace, false);
    assert.equal(readPolicy({ shiftTrace: true }).shiftTrace, true);
    // Diagnostic weight should never switch on by a stray truthy value.
    assert.equal(readPolicy({ shiftTrace: 'true' }).shiftTrace, false);
    assert.equal(readPolicy({ shiftTrace: 1 }).shiftTrace, false);
  });
});

describe('the Tune panel edits the whole policy schema', () => {
  // The one that would have caught this: maxSessionHours, portfolioCeiling,
  // dailyCapCents and shiftTimeoutMinutes were all real, parsed policy fields
  // with no editor in the console — the operator could not set the very bounds
  // that keep an unattended run from spending the plan. A restated copy of the
  // type in desk had even dropped portfolioCeiling, so it typechecked blind.
  test('every policy field has an editor in CompanySettings.vue, and none is stray', () => {
    const src = readFileSync(new URL('../desk/src/views/CompanySettings.vue', import.meta.url), 'utf8');
    // Plain dials declare themselves as `{ key: 'field', label: ... }`.
    const dialKeys = [...src.matchAll(/key: '([a-zA-Z]+)', label:/g)].map((m) => m[1]!);
    // Fields whose value is transformed in the field (percent, dollars) are
    // handled outside DIALS and sent by name in the save patch.
    const special = ['throttleAboveUtilization', 'pauseAboveUtilization', 'dailyCapCents'];
    // Diagnostic-only, deliberately off the operator's Settings page: set via the
    // API/config when someone is diagnosing a stopped shift, not a knob to graze past.
    const diagnostic = ['shiftTrace'];
    const editable = new Set([...dialKeys, ...special, ...diagnostic]);
    const schema = Object.keys(DEFAULT_POLICY);

    const missing = schema.filter((k) => !editable.has(k));
    assert.deepEqual(missing, [], `policy fields with no editor on the Settings page: ${missing.join(', ')}`);
    const stray = [...editable].filter((k) => !schema.includes(k));
    assert.deepEqual(stray, [], `the Settings page edits keys that are not policy fields: ${stray.join(', ')}`);
  });

  // The page groups the dials for layout, and a dial rendered by a group it was
  // left out of renders nowhere — a real field with no editor, the exact bug the
  // guard above exists to catch, but invisible to it because it reads only DIALS.
  // The DialKey type stops a stray group key; only this stops a missing one.
  test('every dial sits in exactly one group', () => {
    const src = readFileSync(new URL('../desk/src/views/CompanySettings.vue', import.meta.url), 'utf8');
    const dialKeys = [...src.matchAll(/key: '([a-zA-Z]+)', label:/g)].map((m) => m[1]!);
    const groupKeys = [...src.matchAll(/keys: \[([^\]]+)\]/g)]
      .flatMap((m) => [...m[1]!.matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1]!));
    assert.deepEqual([...groupKeys].sort(), [...dialKeys].sort(),
      'DIAL_GROUPS keys must be a permutation of DIALS keys — no dial missing from a group, none duplicated');
  });
})
