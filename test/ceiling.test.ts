import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withoutSecrets } from '../src/runtime/staff.ts';

/**
 * `Claude Code process exited with code 1` is the turn ceiling, not a crash.
 *
 * Two Fathom shifts died that way on 2026-09-03 with nothing recorded — no
 * result, no turns, no summary — and the console showed a red failure for a
 * shift that had done thirty turns of work. The transcripts of all three
 * shifts that hit the ceiling that hour end on the same internal record,
 * `max_turns_reached {maxTurns: 30, turnCount: 31}`. What separated the two
 * that died from the one that returned cleanly was the tool underneath:
 *
 *   rafe   died    Bash `timeout 60 node --test …`   result after  60.3s
 *   juno   died    Bash `timeout 120 npm test …`     result after 120.0s
 *   nadia  clean   an MCP message                    result after   0.02s
 */
const staff = () => readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');

describe('a shift that spends its last turn and then dies was truncated', () => {
  test('the turns are counted here, not inferred from a result that never comes', () => {
    // Both deaths reported no result at all, so `turns` stayed at zero and
    // nothing downstream could tell a full shift from an instant failure.
    assert.match(staff(), /\+\+toolTurns >= maxTurns/);
  });

  test('every tool-using turn counts, not only the ones that reach the gate', () => {
    // The ceiling counts turns, and the gate sees a subset of them: Read,
    // Glob and Grep never reach it. Counting gated turns would undercount a
    // research-heavy shift and miss the ceiling it actually hit.
    const src = staff();
    const at = src.indexOf('++toolTurns');
    const line = src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at));
    assert.doesNotMatch(line, /reachesGate/,
      'the ceiling is measured against all tool turns');
    assert.match(line, /b\.type === 'tool_use'/);
  });

  test('the count is per leg, so a second leg does not inherit the first one', () => {
    const src = staff();
    const leg = src.indexOf('const runLeg');
    assert.match(src.slice(leg, leg + 300), /atCeiling = false;\s*\n\s*let toolTurns = 0;/);
  });

  test('a death at the ceiling ends the shift as truncated, not as a failure', () => {
    // Truncated shifts journal, commit, and say "resumes next shift".
    // Failures do none of that, and the work stays uncommitted.
    assert.match(staff(), /if \(OUT_OF_TURNS\.test\(error\) \|\| atCeiling\) \{ truncated = true; break; \}/);
  });
});

describe('a shift that dies for some other reason says what the CLI said', () => {
  test('stderr is captured, because the SDK error alone is four words', () => {
    const src = staff();
    assert.match(src, /stderr: \(data: string\) => \{ noise = \(noise \+ data\)\.slice\(-STDERR_KEPT\); \}/);
    assert.match(src, /stderr: withoutSecrets\(noise\)\.trim\(\)/);
  });

  test('the subscription token cannot reach the ledger through a crash dump', () => {
    // docker/.env holds a command that prints the token precisely so the value
    // is never written down. The ledger is a file on disk.
    const was = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'oat-abcdef0123456789';
    try {
      const out = withoutSecrets('boom: oat-abcdef0123456789 while calling home');
      assert.doesNotMatch(out, /abcdef0123456789/);
      assert.match(out, /\[CLAUDE_CODE_OAUTH_TOKEN\]/);
    } finally {
      if (was === undefined) delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
      else process.env['CLAUDE_CODE_OAUTH_TOKEN'] = was;
    }
  });

  test('a token-shaped string is redacted even when it is not one we set', () => {
    assert.doesNotMatch(withoutSecrets('auth: Bearer eyJhbGciOiJIUzI1NiJ9'), /eyJhbGciOiJIUzI1NiJ9/);
    assert.doesNotMatch(withoutSecrets('key sk-ant-api03-notreal-value'), /notreal-value/);
  });

  test('an empty stderr adds no field, so a clean failure stays readable', () => {
    assert.match(staff(), /noise\.trim\(\) \? \{ stderr:/);
  });
});

describe('a leg that aborted itself does not hand the dead controller to the retry', () => {
  test('every leg arms its own controller', () => {
    // One controller for the whole shift meant the missing-tools retry — the
    // one the comment calls "worth exactly one cold retry" — handed the SDK a
    // controller that was already aborted, and died on the spot.
    const src = staff();
    const leg = src.indexOf('const runLeg');
    assert.match(src.slice(leg, src.indexOf('const q = query(', leg)), /armStop\(\);/,
      'the retry inherits a live controller or it is not a retry');
    assert.doesNotMatch(src, /const stop = new AbortController\(\)/,
      'a shift-long controller cannot survive a leg that aborts');
  });

  test('the shift signal is chained on every leg, not only the first', () => {
    // Otherwise a company stopping mid-retry would not reach the new leg.
    const src = staff();
    const arm = src.slice(src.indexOf('const armStop'), src.indexOf('const watch = blindWatch'));
    assert.match(arm, /d\.signal\.aborted\) stop\.abort\(\)/);
    assert.match(arm, /addEventListener\('abort'/);
  });

  test('both early exits still abort — the point was the retry, not the exit', () => {
    // shift.blind and shift.tools_missing each break the stream this way.
    assert.equal((staff().match(/stop\.abort\(\);/g) ?? []).length, 3,
      'two early exits plus the signal chain');
  });
});
