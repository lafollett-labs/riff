import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withoutSecrets, streamClosedResult, toolsConnected, awaitToolsConnected } from '../src/runtime/staff.ts';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_POLICY, readPolicy } from '../src/core/config.ts';

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
    // What starts a turn: one response with a tool call in it, whether or not
    // the call reaches the gate. (test/shift-landing.test.ts drives the count:
    // parallel calls and a subagent's are not turns.)
    const src = staff();
    const at = src.indexOf('const turnStarts');
    const def = src.slice(at, src.indexOf(';', at));
    assert.doesNotMatch(def, /reachesGate/,
      'the ceiling is measured against all tool turns');
    assert.match(def, /b\.type === 'tool_use'/);
    assert.match(src, /if \(turnStarts && \+\+toolTurns >= maxTurns\)/);
  });

  test('the count is per leg, so a second leg does not inherit the first one', () => {
    const src = staff();
    const leg = src.indexOf('const runLeg');
    assert.match(src.slice(leg, leg + 300), /atCeiling = false;\s*\n\s*let toolTurns = 0;/);
  });

  test('a death at the ceiling ends the shift as truncated, not as a failure', () => {
    // Truncated shifts journal, commit, and say "resumes next shift".
    // Failures do none of that, and the work stays uncommitted.
    assert.match(staff(), /if \(OUT_OF_TURNS\.test\(error\) \|\| atCeiling \|\| landed\) \{ truncated = true; break; \}/);
  });
});

describe('a shift that dies for some other reason says what the CLI said', () => {
  test('stderr is captured, because the SDK error alone is four words', () => {
    const src = staff();
    assert.match(src, /const keepNoise = \(data: string\) => \{ noise = \(noise \+ data\)\.slice\(-STDERR_KEPT\); \};/);
    assert.match(src, /stderr: keepNoise,/);
    // The SDK feeds `stderr` only on its own spawn path; the confined one must
    // read the pipe itself or a crash is four words again.
    assert.match(src, /confinedSpawn\(dirname\(world\.root\), keepNoise\)/);
    assert.match(src, /child\.stderr\.on\('data', onStderr\);/);
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
    const arm = src.slice(src.indexOf('const armStop'), src.indexOf('let staleSession'));
    assert.match(arm, /d\.signal\.aborted\) stop\.abort\(\)/);
    assert.match(arm, /addEventListener\('abort'/);
  });

  test('every early exit still aborts — the point was the retry, not the exit', () => {
    // The stale resumed stream, shift.tools_missing and shift.overran each break
    // the stream this way, and the signal chain is the fourth.
    assert.equal((staff().match(/stop\.abort\(\);/g) ?? []).length, 4,
      'three early exits plus the signal chain');
  });
});

/**
 * A stale resumed session is one whose control stream came up dead — the gate
 * asked zero times, every tool back as `Stream closed`. It is the same shape as
 * a tools/list that never connects, and gets the same cure: drop the resume and
 * take the leg again cold, once. A shift that hangs any other way is caught by
 * the shift timeout, not guessed at from silence.
 */
describe('a stale resumed session is retried cold, once', () => {
  const recover = () => {
    const src = staff();
    const from = src.indexOf('const recoverStaleSession');
    assert.notEqual(from, -1, 'recoverStaleSession must exist');
    return src.slice(from, src.indexOf('};', from) + 2);
  };

  test('the retry only fires with a resume to drop, and only once', () => {
    // A dead stream on a leg that was already cold is a real channel fault, not
    // resume flakiness, and must fail loudly rather than loop forever.
    assert.match(recover(), /if \(!\(session && staleRetries\+\+ < 1\)\) return false;/);
  });

  test('it drops the resume so the retake is cold', () => {
    // The session id is what carries the dead stream forward; clearing it is
    // what makes the next leg bring up a fresh control stream.
    const r = recover();
    assert.match(r, /session = null;/);
    assert.match(r, /setMeta\(`session:\$\{agent\.id\}`, ''\)/);
    assert.match(r, /staleSession = false;/);
  });

  test('both exits route through the retry before failing', () => {
    // The normal return from the message loop and the catch both have to try
    // recovery first — a stale-session abort can surface either way.
    assert.equal(
      (staff().match(/if \(recoverStaleSession\(\)\) continue; failure = STALE_SESSION; break;/g) ?? []).length,
      2,
      'the post-loop path and the catch path both recover before failing');
  });

  test('recovery is the same shape as the tools-missing retry it borrows from', () => {
    // Both clear the session meta, null the session, and continue the leg —
    // the proven pattern, not a new one invented for a stale session.
    const src = staff();
    const tools = src.slice(src.indexOf('if (!toolsUp) {'), src.indexOf('failure = NO_TOOLS;'));
    assert.match(tools, /toolRetries\+\+ < 1/);
    assert.match(tools, /session = null;/);
  });
});

/**
 * The cure beneath recoverStaleSession: the prompt is streamed, never a string.
 *
 * A string prompt makes the SDK mark the query single-turn and close stdin —
 * the channel canUseTool rides on — the instant the first result lands. On a
 * resumed session that result races the first tool turn, stdin closes, the
 * gate is never asked (gateCalls: 0) while tools are called, and every tool
 * comes back `Stream closed`. A held-open one-message async iterable is routed
 * through streamInput and never marked single-turn, so stdin stays alive until
 * the leg's own result releases it. recoverStaleSession is the backstop; this
 * is the fix.
 */
describe('the permission channel is kept alive by streaming the prompt, not passing a string', () => {
  const runLeg = () => {
    const src = staff();
    const from = src.indexOf('const runLeg');
    assert.notEqual(from, -1, 'runLeg must exist');
    return src.slice(from, src.indexOf('let prompt = buildTickPrompt', from));
  };

  test('the prompt handed to the SDK is a held-open stream, never a bare string', () => {
    const src = runLeg();
    // One user turn, then parked: completing the input stream is what closes
    // stdin, so the generator must not return while the leg is live.
    assert.match(src, /async function\* onePrompt\(\)/);
    assert.match(src, /await inputOpen;/);
    assert.match(src, /query\)\(\{\s*prompt: onePrompt\(\),/);
    // A bare string straight into query is the stream-closing shape, and the bug.
    assert.doesNotMatch(src, /query\)?\(\{\s*prompt,/);
  });

  test('the shift trace is gated on the flag and rides the failure events', () => {
    // The audit trace is diagnostic weight: it must be a no-op when off, and
    // when a shift is stopped it must carry the leg's operation trail.
    const src = staff();
    const leg = runLeg();
    // Off is a real no-op path, so a quiet shift pays nothing.
    assert.match(src, /const tracing = d\.shiftTrace \?\? false;/);
    assert.match(src, /\(_op: string\): void => \{ \/\* auditing off \*\/ \}/);
    // The tools-missing emit carries the audit tail.
    assert.equal((leg.match(/\.\.\.auditTail\(\)/g) ?? []).length, 1,
      'the tools_missing emit carries the trace when auditing');
    // The trace records the ordering that makes a stopped shift legible: the
    // gate ask is logged in the shift-level gate wrapper, the leg start inside.
    assert.match(src, /trace\(`gate ask \$\{name\}`\)/);
    assert.match(leg, /trace\(`leg start /);
  });

  test('the held input is released on the result and again after the loop', () => {
    // Released after the usage read on the happy path (usage needs a live
    // stdin), on the handover result, and once more after the loop for the
    // break paths — a post-loop release alone would never be reached on the
    // happy path, because the held-open stream keeps the loop from ending.
    const src = runLeg();
    assert.ok((src.match(/releaseInput\(\);/g) ?? []).length >= 3,
      'released on the result, on the handover result, and after the loop');
  });
});

describe('the dead control stream is read at its source, not inferred from silence', () => {
  // A user message carrying tool_result blocks, the shape the SDK emits when it
  // answers the assistant's tool calls.
  const userMsg = (blocks: unknown[]): SDKUserMessage =>
    ({ type: 'user', message: { role: 'user', content: blocks } } as unknown as SDKUserMessage);

  test('a Stream closed tool_result with is_error is the dead channel', () => {
    assert.equal(streamClosedResult(userMsg([
      { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'AbortError: Stream closed' },
    ])), true);
  });

  test('the closed-stream text can arrive as content blocks, not only a string', () => {
    assert.equal(streamClosedResult(userMsg([
      { type: 'tool_result', tool_use_id: 't1', is_error: true,
        content: [{ type: 'text', text: 'AbortError: Stream closed' }] },
    ])), true);
  });

  test('a tool that merely printed the words, without is_error, is not the channel dying', () => {
    // The whole point of matching is_error too: a Bash tool that ran fine and
    // echoed "stream closed" must not be read as the transport being gone.
    assert.equal(streamClosedResult(userMsg([
      { type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'the stream closed cleanly' },
    ])), false);
  });

  test('a tool that ran and failed for its own reason is not the channel dying', () => {
    assert.equal(streamClosedResult(userMsg([
      { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'ENOENT: no such file' },
    ])), false);
  });

  test('a plain user prompt carries no tool_result and is never the channel dying', () => {
    assert.equal(streamClosedResult(
      { type: 'user', message: { role: 'user', content: 'just text' } } as unknown as SDKUserMessage), false);
  });

  test('the leg drops on the first result only while the gate has never answered, with a resume to drop', () => {
    // The guards are what keep it from clobbering a leg that was working: a
    // live channel that closes after the gate has answered is a different
    // fault, and a cold leg with no session to reset falls through to the shift
    // timeout rather than looping.
    const src = staff();
    assert.match(src,
      /if \(m\.type === 'user' && session && gateCalls === 0 && streamClosedResult\(m\)\) \{/);
    const branch = src.slice(src.indexOf("if (m.type === 'user' && session"));
    assert.match(branch.slice(0, 260), /staleSession = true;/,
      'routes through the staleSession -> recoverStaleSession path, not a new one');
  });
});

/**
 * The startup race that made a healthy resume look like dead tools.
 *
 * The init snapshot is one reading, and on a resumed session it can arrive
 * before the in-process company server finishes connecting — so the server
 * reads `pending` or absent, and the shift was aborted for tools_missing when
 * the very next reading would have said `connected`. The grace poll waits that
 * race out; only a server that never connects runs the budget out.
 */
describe('a still-connecting company server is waited out, not called dead', () => {
  const status = (s: string) => [{ name: 'company', status: s }];
  // A fake query whose server status walks a scripted sequence, one entry per read.
  const scripted = (seq: Array<Array<{ name: string; status: string }>> | Error) => {
    let i = 0;
    return {
      reads: () => i,
      mcpServerStatus: async () => {
        if (seq instanceof Error) throw seq;
        return seq[Math.min(i++, seq.length - 1)] ?? [];
      },
    };
  };
  const noSleep = async () => {};

  test('toolsConnected reads only the company server, and only `connected` counts', () => {
    assert.equal(toolsConnected(status('connected')), true);
    assert.equal(toolsConnected(status('pending')), false);
    assert.equal(toolsConnected(status('failed')), false);
    assert.equal(toolsConnected([]), false, 'an absent server is not connected');
    assert.equal(toolsConnected([{ name: 'other', status: 'connected' }]), false,
      'another server being up is not the company server being up');
  });

  test('it returns the instant the company server is connected, without sleeping', async () => {
    const q = scripted([status('connected')]);
    assert.equal(await awaitToolsConnected(q, 3000, 150, noSleep), true);
    assert.equal(q.reads(), 1, 'one status read, no wait');
  });

  test('it keeps polling a pending server until it connects', async () => {
    const q = scripted([status('pending'), status('pending'), status('connected')]);
    assert.equal(await awaitToolsConnected(q, 3000, 150, noSleep), true);
    assert.equal(q.reads(), 3, 'polled until the race resolved');
  });

  test('a server that never connects runs the budget out and is called dead', async () => {
    // now() steps 200ms per read, so a 300ms budget is spent after two reads.
    let t = 0;
    const q = scripted([status('pending')]);
    const now = () => { const v = t; t += 200; return v; };
    assert.equal(await awaitToolsConnected(q, 300, 150, noSleep, now), false);
  });

  test('a status call that throws is not trusted either way and falls through', async () => {
    const q = scripted(new Error('control stream gone'));
    assert.equal(await awaitToolsConnected(q, 3000, 150, noSleep), false);
  });

  test('a status read that never settles is bounded by the budget, not left to block', async () => {
    // The bug it fixes: mcpServerStatus() that hangs. The deadline is only checked
    // between reads, so without the race a hung read blocked 382s past a 3s budget.
    const q = { mcpServerStatus: () => new Promise<{ name: string; status: string }[]>(() => {}) };
    // Injected race resolves null (budget elapsed) so the test never waits on a real timer.
    const budgetElapsed = async () => null;
    assert.equal(await awaitToolsConnected(q, 3000, 150, noSleep, undefined, budgetElapsed), false);
  });

  test('end to end, a hung status read returns within the budget without hanging', async () => {
    // The real default race with a real (tiny) timer: proves the function honours
    // its own budget when the read never settles.
    const q = { mcpServerStatus: () => new Promise<{ name: string; status: string }[]>(() => {}) };
    const start = Date.now();
    assert.equal(await awaitToolsConnected(q, 40, 10, noSleep), false);
    assert.ok(Date.now() - start < 500, 'returned near the budget, did not block on the hung read');
  });

  test('the init handler waits out the grace before it emits tools_missing', () => {
    const src = staff();
    const from = src.indexOf("m.subtype === 'init'");
    const block = src.slice(from, src.indexOf('void readUsage(q);', from));
    // The grace poll runs on the not-connected path, above the emit.
    assert.ok(block.indexOf('awaitToolsConnected(q, TOOLS_GRACE_MS, TOOLS_POLL_MS)')
      < block.indexOf("'shift.tools_missing'"),
      'the live status is polled before the channel is declared dead');
    // And the emit records how long it waited, for the audit.
    assert.match(block, /graceMs: TOOLS_GRACE_MS/);
  });

  test('an init that arrives after the leg result is a phantom re-init, not tools_missing', () => {
    // A resumed leg can emit a second init AFTER its result, with the in-process
    // company server unregistered (reads absent). The init handler must bail on
    // that rather than call a finished leg's tools missing (Carver, seq 6286).
    const src = staff();
    const initFrom = src.indexOf("m.subtype === 'init'");
    const guard = src.slice(initFrom, src.indexOf('toolsUp = toolsConnected(m.mcp_servers)', initFrom));
    assert.match(guard, /if \(sawResult\)/, 'the tools check bails once the leg has produced its result');
    // And the result handler is what sets that flag.
    const resultFrom = src.indexOf("m.type === 'result'");
    assert.ok(src.indexOf('sawResult = true', resultFrom) > resultFrom,
      'the result handler marks the leg as answered');
  });
});

/**
 * The bound on a shift that is stuck rather than slow.
 *
 * Turns, context and spend are the other three ceilings, and none of them
 * advance while a shift waits on something that never answers — so a stuck
 * shift is unbounded and holds one of `concurrency` slots for as long as it
 * waits. Two of those and the company has stopped with nothing on the record
 * saying so. A shell command left holding stdin ran for three days in this
 * repo before a person noticed it and killed it by hand.
 */
describe('a shift that is stuck rather than slow', () => {
  test('the clock is on the shift, not on one leg of it', () => {
    // A shift that rotates twice is still one shift and gets one ceiling.
    // Reading `stop` at fire time rather than capturing it is what makes that
    // true, since every leg replaces the controller.
    const src = staff();
    const arm = src.slice(src.indexOf('let overran = false;'), src.indexOf('let toolsUp'));
    assert.match(arm, /setTimeout\(/);
    assert.match(arm, /stop\.abort\(\)/);
    assert.ok(src.indexOf('let overran = false;') < src.indexOf('const runLeg'),
      'armed once per shift, above the leg that would reset it');
  });

  test('it says it ran out of time, not that a person aborted it', () => {
    // The SDK calls every abort "aborted by user", and an operator reading
    // that in the ledger goes looking for the operator who did it.
    const src = staff();
    assert.match(src, /const overranBy = \(ms: number\): string =>/);
    assert.match(src, /ledger\.emit\(agent\.id, 'shift\.overran'/);
    // Checked before every other reading of the abort it caused.
    const c = src.indexOf('} catch (err) {');
    assert.ok(src.indexOf('if (overran)', c) < src.indexOf('LOST_SESSION.test(`${error}\\n${noise}`)', c),
      'the ceiling is why the error happened, so it is read first');
  });

  test('nothing is held open by a shift that has already ended', () => {
    const src = staff();
    assert.match(src, /timeout\?\.unref\(\);/);
    assert.match(src, /if \(timeout\) clearTimeout\(timeout\);/);
  });

  test('the ceiling is above every shift this installation has ever run', () => {
    // Measured over 499 recorded shifts: median 3.3 minutes, p99 16.1, and
    // the longest that ever finished 27.7. A ceiling that can cut off work
    // which is actually happening is a worse bug than the one it fixes.
    assert.equal(DEFAULT_POLICY.shiftTimeoutMinutes, 45);
    assert.ok(DEFAULT_POLICY.shiftTimeoutMinutes > 27.7 * 1.5);
  });

  test('the run has its own ceiling, and it is not the shift ceiling', () => {
    // Two different runaways. A shift ceiling catches one that is stuck; it
    // does nothing about a company left working all night, because every
    // shift in that night is a healthy three-minute shift.
    assert.equal(DEFAULT_POLICY.maxSessionHours, 2);
    assert.equal(readPolicy({ maxSessionHours: 0 }).maxSessionHours, 0);
    assert.equal(readPolicy({}).maxSessionHours, 2);
  });

  test('zero turns it off, and is not mistaken for unset', () => {
    assert.equal(readPolicy({ shiftTimeoutMinutes: 0 }).shiftTimeoutMinutes, 0);
    assert.equal(readPolicy({}).shiftTimeoutMinutes, 45);
    assert.equal(readPolicy({ shiftTimeoutMinutes: 99999 }).shiftTimeoutMinutes, 1440);
    // And a shift only arms a clock it was actually given.
    assert.match(staff(), /d\.shiftTimeoutMs && d\.shiftTimeoutMs > 0/);
  });

  test('a stuck shift shows up in the report rather than only in the log', () => {
    const vitals = readFileSync(new URL('../src/analytics/vitals.ts', import.meta.url), 'utf8');
    assert.match(vitals, /const overran = n\('shift\.overran'\);/);
    assert.match(vitals, /troubleRate: over\(failed \+ overran, woke\)/);
  });
});
