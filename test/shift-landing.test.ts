import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallback, Options, query as sdkQuery, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Ledger } from '../src/ledger/ledger.ts';
import { World } from '../src/worldfs/world.ts';
import { Gate } from '../src/policy/gate.ts';
import { constitutionFor } from '../src/policy/rules.ts';
import { fixedClock } from '../src/core/clock.ts';
import { landing, tick } from '../src/runtime/staff.ts';
import type { Agent, Tier } from '../src/core/types.ts';

/**
 * Time is a shift's budget; the turn ceiling is a runaway net under it. The
 * agent is told as either nears, and stopped between tool calls at either —
 * by Riff, not by trusting the CLI: Lynn's leg of 2026-09-23 ran 92 tool calls
 * under a ceiling of 75 and the CLI reported success.
 */
describe('where a shift stands against its limits', () => {
  const at = (o: Partial<Parameters<typeof landing>[0]>) =>
    landing({ elapsedMs: 0, timeoutMs: 45 * 60_000, turns: 1, maxTurns: 200, told: new Set(), ...o });

  test('nothing is said early in a shift', () => {
    assert.equal(at({ elapsedMs: 10 * 60_000 }), null);
  });

  test('the agent is told at three quarters of its time, and again at nine tenths', () => {
    const three = at({ elapsedMs: 34 * 60_000 });
    assert.ok(three && 'say' in three && three.mark === 'time-75');
    assert.match(three.say, /About 11 minutes/);
    const nine = at({ elapsedMs: 41 * 60_000, told: new Set(['time-75']) });
    assert.ok(nine && 'say' in nine && nine.mark === 'time-90');
    assert.match(nine.say, /Start nothing new/);
  });

  test('a last minute is a minute', () => {
    const t = at({ timeoutMs: 60_000, elapsedMs: 46_000 });
    assert.ok(t && 'say' in t);
    assert.match(t.say, /^About 1 minute of/);
  });

  test('each notice is given once', () => {
    assert.equal(at({ elapsedMs: 42 * 60_000, told: new Set(['time-90']) }), null);
  });

  test('at the deadline, or the ceiling, the shift stops', () => {
    assert.deepEqual(at({ elapsedMs: 45 * 60_000 }), { stop: 'time' });
    assert.deepEqual(at({ turns: 200 }), { stop: 'turns' });
  });

  test('a few turns short of the ceiling the agent is told, even with time to spare', () => {
    const t = at({ turns: 181 });
    assert.ok(t && 'say' in t && t.mark === 'turns');
    assert.match(t.say, /^19 tool turns remain/);
    assert.equal(at({ turns: 179 }), null);
  });

  test('a shift with no time budget is held only by its turns', () => {
    assert.equal(at({ timeoutMs: 0, elapsedMs: 10 * 3_600_000 }), null);
  });
});

const agent = (id: string, tier: Tier, reportsTo: string | null = 'ceo'): Agent => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), tier, role: tier,
  department: '', reportsTo, status: 'active', activity: '', mandate: '',
  hiredAt: '2026-08-01T00:00:00.000Z', hiredBy: null, model: 'claude-opus-5', effort: 'company',
});

let dir: string;
let ledger: Ledger;
let world: World;
const clock = fixedClock('2026-09-23T09:00:00.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'riff-landing-'));
  ledger = new Ledger(':memory:', clock);
  ledger.upsertAgent(agent('ceo', 'executive', null));
  world = new World(join(dir, 'world'), clock);
  world.ensure();
  world.ensureStaff('ceo');
});
afterEach(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });

type Script = {
  turns: number;
  ignoreStop?: boolean;
  result?: string;
  /** Tool calls per response, each its own message sharing the response's id. */
  parallel?: number;
  /** A subagent's batch before each of the agent's own: its messages and its hook. */
  subagent?: boolean;
  /** Called before each batch's hook, to move the wall clock. */
  tick?: () => void;
};

/**
 * The SDK's query, played from scripts — one per query() call, so a rotating
 * shift's legs each get their own: an init, then one response at a time with
 * the PostToolBatch hook after each, as the CLI does, and a result. The CLI
 * emits a message per content block, so parallel calls share a message.id.
 */
const scripted = (...scripts: Script[]) => {
  const said: unknown[][] = [];
  let interrupts = 0;
  let call = 0;
  const fake = ((args: { options?: Options }) => {
    const script = scripts[Math.min(call, scripts.length - 1)]!;
    const leg = call++;
    const out: unknown[] = [];
    said.push(out);
    const hook = args.options?.hooks?.PostToolBatch?.[0]?.hooks[0] as HookCallback;
    const batch = (agentId?: string) => hook(
      { hook_event_name: 'PostToolBatch', tool_calls: [], ...(agentId ? { agent_id: agentId } : {}) } as never,
      undefined, { signal: new AbortController().signal });
    const response = (id: string, parent: string | null) => ({
      type: 'assistant', parent_tool_use_id: parent,
      message: { id, content: [{ type: 'tool_use', id: `${id}-t`, name: 'Read', input: {} }], usage: {} },
    }) as unknown as SDKMessage;
    async function* run(): AsyncGenerator<SDKMessage> {
      yield { type: 'system', subtype: 'init', session_id: `s${leg}`, model: 'claude-opus-5',
        mcp_servers: [{ name: 'company', status: 'connected' }] } as unknown as SDKMessage;
      let n = 0;
      while (n < script.turns && interrupts === 0) {
        n++;
        if (script.subagent) {
          for (let i = 0; i < 3; i++) yield response(`sub${leg}-${n}-${i}`, `task${n}`);
          out.push(await batch('sub'));
        }
        for (let i = 0; i < (script.parallel ?? 1); i++) yield response(`msg${leg}-${n}`, null);
        script.tick?.();
        const o = await batch();
        out.push(o);
        if ((o as { continue?: boolean }).continue === false && !script.ignoreStop) break;
      }
      yield { type: 'result', subtype: 'success', num_turns: n + 1, result: script.result ?? 'stopped here',
        session_id: `s${leg}`, total_cost_usd: 0.01, modelUsage: {} } as unknown as SDKMessage;
    }
    return Object.assign(run(), { interrupt: async () => { interrupts++; } });
  }) as unknown as typeof sdkQuery;
  return { fake, said, interrupts: () => interrupts, calls: () => call };
};

const shift = (fake: typeof sdkQuery, o: {
  maxTurns: number; shiftTimeoutMs?: number; now?: () => number; rotateAtSessionTurns?: number;
}) => tick({
  agent: ledger.getAgent('ceo')!, ledger, world, clock,
  gate: new Gate(ledger, constitutionFor({ ceo: 'ceo', board: [] }), { exists: () => false, count: () => 0 }),
  query: fake, ...o,
});

const slept = () => {
  const e = ledger.lastEvent(['agent.slept', 'agent.failed']);
  return { kind: e?.kind, data: JSON.parse(e?.dataJson ?? '{}') as Record<string, unknown> };
};

describe('a shift is landed between tool calls', () => {
  test('told when a few turns remain, then stopped at the ceiling — truncated, not failed', async () => {
    const s = scripted({ turns: 50 });
    const r = await shift(s.fake, { maxTurns: 4 });
    assert.equal(r.ok, true);
    const said = s.said[0]!;
    assert.equal(said.length, 4, 'stopped on the fourth batch');
    assert.match(JSON.stringify(said[0]), /3 tool turns remain/);
    assert.deepEqual(said[1], {}, 'told once');
    assert.deepEqual(said[3], { continue: false, stopReason: 'The shift is out of turns.' });
    const { kind, data } = slept();
    assert.equal(kind, 'agent.slept');
    assert.equal(data['truncated'], true);
    assert.equal(data['landed'], 'turns');
  });

  test('out of time, it is stopped at the next pause between tool calls', async () => {
    let t = 0;
    const s = scripted({ turns: 50, result: '', tick: () => { t += 10 * 60_000; } });
    const r = await shift(s.fake, { maxTurns: 200, shiftTimeoutMs: 45 * 60_000, now: () => t });
    const said = s.said[0]!;
    assert.match(JSON.stringify(said[3]), /About 5 minutes .* remain/, 'told at 40 of 45');
    assert.deepEqual(said[4], { continue: false, stopReason: 'The shift is out of time.' });
    assert.equal(slept().data['landed'], 'time');
    assert.equal(ledger.lastEvent(['shift.overran']), null, 'landed, not killed');
    // Stopped before it could speak, the CLI's result is empty; the record
    // still says why the shift ended.
    assert.equal(r.summary, 'stopped at its time limit');
    assert.match(readFileSync(join(world.root, 'staff', 'ceo', 'journal', '2026-09-23.md'), 'utf8'),
      /Stopped at its 45-minute limit/, 'and the journal does not call it a turn ceiling');
  });

  test('a CLI that runs on past both stops is interrupted', async () => {
    const s = scripted({ turns: 50, ignoreStop: true });
    await shift(s.fake, { maxTurns: 4 });
    assert.equal(s.interrupts(), 1);
    assert.equal(slept().data['landed'], 'turns');
  });

  test('parallel calls and a subagent\'s calls are not the agent\'s turns', async () => {
    // The CLI emits one message per tool call, and a subagent's carry its
    // parent's id: counted as turns, three parallel reads a response would
    // interrupt a shift at a third of its ceiling.
    const s = scripted({ turns: 5, parallel: 3, subagent: true });
    await shift(s.fake, { maxTurns: 6 });
    assert.equal(s.interrupts(), 0);
    const said = s.said[0]!;
    assert.deepEqual(said.filter((_, i) => i % 2 === 0), [{}, {}, {}, {}, {}], 'the subagent is told nothing');
    assert.match(JSON.stringify(said[5]), /3 tool turns remain/, 'the agent is, at its own third turn');
    const { data } = slept();
    assert.equal(data['truncated'], undefined);
    assert.equal(data['landed'], undefined);
  });
});

describe('a landing and a rotation', () => {
  test('a hand-over that spends its turns does not mark the shift cut', async () => {
    // The last leg answers without a tool call, so its conversation is too
    // short to rotate again.
    const s = scripted({ turns: 2 }, { turns: 50 }, { turns: 0 });
    await shift(s.fake, { maxTurns: 200, rotateAtSessionTurns: 2 });
    assert.equal(s.said[1]!.length, 6, 'the hand-over was stopped at its own six turns');
    assert.equal(s.calls(), 3, 'work, hand-over, work');
    const { data } = slept();
    assert.equal(data['rotations'], 1);
    assert.equal(data['landed'], undefined);
    assert.equal(data['truncated'], undefined);
  });

  test('out of time during the hand-over, the conversation is kept and nothing starts past the deadline', async () => {
    let t = 0;
    const s = scripted({ turns: 2 }, { turns: 50, tick: () => { t += 60 * 60_000; } }, { turns: 1 });
    await shift(s.fake, { maxTurns: 200, rotateAtSessionTurns: 2, shiftTimeoutMs: 45 * 60_000, now: () => t });
    assert.equal(s.calls(), 2, 'no cold leg after the deadline');
    const { data } = slept();
    assert.equal(data['landed'], 'time');
    assert.equal(data['rotations'], undefined, 'not rotated');
    assert.equal(ledger.getMeta('session:ceo'), 's1', 'the conversation is kept to resume');
  });

  test('past three quarters of its time a shift does not rotate', async () => {
    let t = 0;
    const s = scripted({ turns: 2, tick: () => { t += 20 * 60_000; } }, { turns: 1 });
    await shift(s.fake, { maxTurns: 200, rotateAtSessionTurns: 2, shiftTimeoutMs: 45 * 60_000, now: () => t });
    assert.equal(s.calls(), 1);
  });
});
