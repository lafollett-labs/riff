import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallback, Options, PermissionResult, query as sdkQuery, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
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
  /** On the first turn, spawn a subagent that makes this many tool calls,
   *  and hand back its result unless it is still running when the leg ends. */
  spawn?: { toolCalls: number; returns: boolean; background?: boolean };
  /** On the first turn, a call the CLI checks with PreToolUse and then asks
   *  canUseTool about, as it does for anything it will not approve itself. */
  checked?: { name: string; input: Record<string, unknown> };
  /** On the first turn, a call the CLI asks canUseTool about with no hook
   *  before it — a release that stopped running PreToolUse for the tool. */
  unhooked?: { name: string; input: Record<string, unknown> };
  /** How the checked call's result comes back, over what its decision implies. */
  checkedResult?: 'success' | 'error';
  /** On the first turn, a call that ran with no hook and failed. */
  ranAndFailed?: boolean;
  /** On the first turn, calls run as the CLI runs them: the hook, canUseTool
   *  unless the hook refused, then the call and its result. */
  steps?: Array<{ id: string; name: string; input: Record<string, unknown>; result?: string; finishes?: string }>;
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
      yield { type: 'system', subtype: 'init', session_id: `s${leg}`, model: 'claude-opus-5', claude_code_version: '2.1.999',
        mcp_servers: [{ name: 'company', status: 'connected' }] } as unknown as SDKMessage;
      let n = 0;
      while (n < script.turns && interrupts === 0) {
        n++;
        if (script.subagent) {
          for (let i = 0; i < 3; i++) yield response(`sub${leg}-${n}-${i}`, `task${n}`);
          out.push(await batch('sub'));
        }
        if (script.checked && n === 1) {
          const opts = { signal: new AbortController().signal };
          const pre = args.options?.hooks?.PreToolUse?.[0];
          assert.ok(pre && pre.matcher === undefined, 'the hook runs for every tool');
          const h = await pre.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: script.checked.name,
            tool_input: script.checked.input, tool_use_id: 'chk1' } as never, 'chk1', opts);
          out.push({ pre: h });
          const denied = JSON.stringify(h).includes('"permissionDecision":"deny"');
          if (!denied) out.push({ can: await args.options!.canUseTool!(script.checked.name, script.checked.input,
            { ...opts, toolUseID: 'chk1' } as never) });
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'chk-msg', usage: {},
            content: [{ type: 'tool_use', id: 'chk1', name: script.checked.name, input: script.checked.input }] } } as unknown as SDKMessage;
          const failed = script.checkedResult ? script.checkedResult === 'error' : denied;
          yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result',
            tool_use_id: 'chk1', content: failed ? 'refused' : 'ok', ...(failed ? { is_error: true } : {}) }] } } as unknown as SDKMessage;
        }
        if (script.unhooked && n === 1) {
          const can = await args.options!.canUseTool!(script.unhooked.name, script.unhooked.input,
            { signal: new AbortController().signal, toolUseID: 'nohook1' } as never) as PermissionResult;
          out.push({ can });
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'nh-msg', usage: {},
            content: [{ type: 'tool_use', id: 'nohook1', name: script.unhooked.name, input: script.unhooked.input }] } } as unknown as SDKMessage;
          yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result',
            tool_use_id: 'nohook1', content: can.behavior === 'deny' ? (can.message ?? 'refused') : 'ok',
            ...(can.behavior === 'deny' ? { is_error: true } : {}) }] } } as unknown as SDKMessage;
        }
        for (const st of (n === 1 ? script.steps ?? [] : [])) {
          const opts = { signal: new AbortController().signal };
          if (st.finishes) {
            yield { type: 'system', subtype: 'task_notification', task_id: 'bg', tool_use_id: st.finishes,
              status: 'completed', output_file: '', summary: 'done',
              usage: { total_tokens: 1, tool_uses: 1, duration_ms: 5 } } as unknown as SDKMessage;
          }
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: `${st.id}-msg`, usage: {},
            content: [{ type: 'tool_use', id: st.id, name: st.name, input: st.input }] } } as unknown as SDKMessage;
          const h = await args.options!.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse',
            tool_name: st.name, tool_input: st.input, tool_use_id: st.id } as never, st.id, opts);
          const refused = JSON.stringify(h).includes('"permissionDecision":"deny"');
          const can = refused ? null : await args.options!.canUseTool!(st.name, st.input, { ...opts, toolUseID: st.id } as never);
          out.push({ step: st.id, refused, can });
          const no = refused || can?.behavior === 'deny';
          yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result',
            tool_use_id: st.id, content: no ? 'refused' : (st.result ?? 'ok'), ...(no ? { is_error: true } : {}) }] } } as unknown as SDKMessage;
        }
        if (script.ranAndFailed && n === 1) {
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'rf-msg', usage: {},
            content: [{ type: 'tool_use', id: 'rf1', name: 'Bash', input: { command: 'false' } }] } } as unknown as SDKMessage;
          yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result',
            tool_use_id: 'rf1', content: 'Exit code 1', is_error: true }] } } as unknown as SDKMessage;
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'rf-msg2', usage: {},
            content: [{ type: 'tool_use', id: 'rf2', name: 'Bash', input: {} }] } } as unknown as SDKMessage;
          yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result',
            tool_use_id: 'rf2', content: '<tool_use_error>InputValidationError: command is required</tool_use_error>', is_error: true }] } } as unknown as SDKMessage;
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'rf-msg3', usage: {},
            content: [{ type: 'tool_use', id: 'rf3', name: 'SendMessage', input: { to: 'bridge:abc' } }] } } as unknown as SDKMessage;
          yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result',
            tool_use_id: 'rf3', content: '<tool_use_error>Cross-session messaging is not available in this session.</tool_use_error>', is_error: true }] } } as unknown as SDKMessage;
        }
        if (script.spawn && n === 1) {
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'spawn-msg', usage: {},
            content: [{ type: 'tool_use', id: 'spawn1', name: 'Agent',
              input: { subagent_type: 'Explore', description: 'find the rules',
                ...(script.spawn.background ? { run_in_background: true } : {}) } }] } } as unknown as SDKMessage;
          if (script.spawn.background) {
            yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result',
              tool_use_id: 'spawn1', content: 'Async agent launched successfully.' }] } } as unknown as SDKMessage;
          }
          for (let i = 0; i < script.spawn.toolCalls; i++) yield response(`inside-${i}`, 'spawn1');
          if (script.spawn.returns && script.spawn.background) {
            yield { type: 'system', subtype: 'task_notification', task_id: 'bg1', tool_use_id: 'spawn1',
              status: 'completed', output_file: '', summary: 'done',
              usage: { total_tokens: 1, tool_uses: script.spawn.toolCalls + 2, duration_ms: 5 } } as unknown as SDKMessage;
          } else if (script.spawn.returns) {
            yield { type: 'user', parent_tool_use_id: null, message: { content: [
              { type: 'tool_result', tool_use_id: 'spawn1', content: 'found them' }] } } as unknown as SDKMessage;
          }
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
  maxTurns: number; shiftTimeoutMs?: number; now?: () => number; rotateAtSessionTurns?: number; gate?: Gate;
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

describe('a subagent is on the record', () => {
  const events = (kind: string): Array<Record<string, unknown>> => ledger.eventsSince(0)
    .filter((e) => e.kind === kind)
    .map((e) => ({ subject: e.subject, ...JSON.parse(e.dataJson ?? '{}') as Record<string, unknown> }));

  test('its start, its end, what it did, and whether the gate saw it spawn', async () => {
    let t = 0;
    const s = scripted({ turns: 2, spawn: { toolCalls: 3, returns: true }, tick: () => { t += 1000; } });
    await shift(s.fake, { maxTurns: 200, now: () => t });
    assert.deepEqual(events('subagent.started'),
      [{ subject: 'spawn1', type: 'Explore', description: 'find the rules' }]);
    const [done] = events('subagent.finished');
    assert.equal(done!['toolCalls'], 3);
    assert.equal(done!['gated'], false, 'the scripted CLI never ran the PreToolUse hook for it');
    assert.equal(done!['unfinished'], undefined);
    assert.equal(slept().data['subagents'], 1);
  });

  test('one still running when the shift ends is recorded as unfinished', async () => {
    const s = scripted({ turns: 1, spawn: { toolCalls: 2, returns: false } });
    await shift(s.fake, { maxTurns: 200 });
    const [done] = events('subagent.finished');
    assert.equal(done!['unfinished'], true);
    assert.equal(done!['toolCalls'], 2);
  });
});

describe('a background subagent and the pre-check, inside a shift', () => {
  const events = (kind: string): Array<Record<string, unknown>> => ledger.eventsSince(0)
    .filter((e) => e.kind === kind)
    .map((e) => ({ subject: e.subject, ...JSON.parse(e.dataJson ?? '{}') as Record<string, unknown> }));

  test('a background spawn is finished by its completion notice, not its launch receipt', async () => {
    const s = scripted({ turns: 2, spawn: { toolCalls: 3, returns: true, background: true } });
    await shift(s.fake, { maxTurns: 200 });
    assert.equal(events('subagent.started')[0]!['background'], true);
    const [done] = events('subagent.finished');
    assert.equal(done!['background'], true);
    assert.equal(done!['toolCalls'], 5, 'the notice\'s own count, when it saw more than the stream');
  });

  test('a background spawn still running at the end of the shift is unfinished', async () => {
    const s = scripted({ turns: 1, spawn: { toolCalls: 1, returns: false, background: true } });
    await shift(s.fake, { maxTurns: 200 });
    assert.equal(events('subagent.finished')[0]!['unfinished'], true);
  });

  test('a call checked before the CLI decides is decided once, not twice', async () => {
    const s = scripted({ turns: 1, checked: { name: 'Read', input: { file_path: join(world.root, 'staff', 'mo', 'memory.md') } } });
    await shift(s.fake, { maxTurns: 200 });
    assert.deepEqual(s.said[0]![0], { pre: {} });
    assert.deepEqual(s.said[0]![1], { can: { behavior: 'allow' } });
    assert.equal(events('gate.allow').length, 1, 'one record of the colleague read');
  });

  test('a remote spawn is refused before the CLI runs it', async () => {
    const s = scripted({ turns: 1, checked: { name: 'Agent', input: { prompt: 'x', isolation: 'remote' } } });
    await shift(s.fake, { maxTurns: 200 });
    assert.match(JSON.stringify(s.said[0]![0]), /"permissionDecision":"deny".*remote isolation/);
    assert.equal(s.said[0]!.length, 2, 'never asked of canUseTool; the batch hook follows');
  });
});

describe('the gate is not a list of tools', () => {
  const events = (kind: string): Array<Record<string, unknown>> => ledger.eventsSince(0)
    .filter((e) => e.kind === kind)
    .map((e) => ({ subject: e.subject, ...JSON.parse(e.dataJson ?? '{}') as Record<string, unknown> }));

  test('a call that ran without the pre-check is recorded as going around the gate', async () => {
    // The scripted CLI hands back the spawn's result without running the hook
    // for it — what a release that stopped running PreToolUse for a tool does.
    const s = scripted({ turns: 1, spawn: { toolCalls: 1, returns: true } });
    await shift(s.fake, { maxTurns: 200 });
    assert.deepEqual(events('gate.bypassed'), [{ subject: 'spawn1', tool: 'Agent', how: 'ran' }]);
    assert.deepEqual(slept().data['ungated'], { Agent: 1 });
  });

  test('a call the pre-check saw is not, whatever it decided', async () => {
    const s = scripted({ turns: 1, checked: { name: 'Read', input: { file_path: join(world.root, 'staff', 'mo', 'memory.md') } } });
    await shift(s.fake, { maxTurns: 200 });
    assert.deepEqual(events('gate.bypassed'), []);
    assert.equal(slept().data['ungated'], undefined);
  });

  test('a tool the gate does not know is refused, and named for someone to decide on', async () => {
    const s = scripted({ turns: 1, checked: { name: 'RemoteTrigger', input: { action: 'run' } } });
    await shift(s.fake, { maxTurns: 200 });
    assert.match(JSON.stringify(s.said[0]![0]), /"permissionDecision":"deny".*not one of this company's tools/);
    assert.deepEqual(slept().data['unknownTools'], ['RemoteTrigger']);
  });

  test('a call the hook refused that comes back a success ran anyway, and is recorded', async () => {
    const s = scripted({ turns: 1, checked: { name: 'RemoteTrigger', input: {} }, checkedResult: 'success' });
    await shift(s.fake, { maxTurns: 200 });
    assert.deepEqual(events('gate.bypassed'), [{ subject: 'chk1', tool: 'RemoteTrigger', how: 'ignored' }]);
  });

  test('a command that ran without the hook and failed counts; one the CLI turned away does not', async () => {
    const s = scripted({ turns: 1, ranAndFailed: true });
    await shift(s.fake, { maxTurns: 200 });
    assert.deepEqual(events('gate.bypassed'), [{ subject: 'rf1', tool: 'Bash', how: 'failed' }],
      'the CLI\'s own refusals, whatever they say, ran nothing');
    assert.deepEqual(slept().data['ungated'], { Bash: 1 });
  });

  test('asked with no hook before it, canUseTool applies the hook\'s refusals too', async () => {
    const s = scripted({ turns: 1, unhooked: { name: 'Agent', input: { prompt: 'x', isolation: 'remote' } } });
    await shift(s.fake, { maxTurns: 200 });
    assert.match(JSON.stringify(s.said[0]![0]), /"behavior":"deny".*remote isolation/);
    assert.deepEqual(events('gate.bypassed'), [{ subject: 'nohook1', tool: 'Agent', how: 'unhooked' }],
      'the hook was skipped, but the gate was not');
  });

  test('SendMessage reaches a subagent that ran, by the name it asked for or its launch id', async () => {
    const s = scripted({ turns: 1, steps: [
      { id: 'sp1', name: 'Agent', input: { prompt: 'x', description: 'look', name: 'helper', run_in_background: true },
        result: 'Async agent launched successfully.\nagentId: a378ca0729cadb2a9 (use SendMessage)' },
      { id: 'm1', name: 'SendMessage', input: { to: 'helper', message: 'wrap up' } },
      { id: 'm2', name: 'SendMessage', input: { to: 'a378ca0729cadb2a9', message: 'wrap up' } },
      { id: 'm3', name: 'SendMessage', input: { to: 'look', message: 'wrap up' } },
    ] });
    await shift(s.fake, { maxTurns: 200 });
    const refused = (id: string) => (s.said[0]!.find((o) => (o as { step?: string }).step === id) as { refused: boolean }).refused;
    assert.equal(refused('m1'), false);
    assert.equal(refused('m2'), false);
    assert.equal(refused('m3'), true, 'a description is not an address');
  });

  test('a subagent that has finished is no longer an address', async () => {
    const s = scripted({ turns: 1, steps: [
      { id: 'sp1', name: 'Agent', input: { prompt: 'x', description: 'look', name: 'helper', run_in_background: true },
        result: 'Async agent launched successfully.\nagentId: a378ca0729cadb2a9' },
      { id: 'm1', name: 'SendMessage', input: { to: 'helper', message: 'wrap up' }, finishes: 'sp1' },
      { id: 'm2', name: 'SendMessage', input: { to: 'a378ca0729cadb2a9', message: 'wrap up' } },
    ] });
    await shift(s.fake, { maxTurns: 200 });
    const refused = (id: string) => (s.said[0]!.find((o) => (o as { step?: string }).step === id) as { refused: boolean }).refused;
    assert.equal(refused('m1'), true, 'the CLI answers to a name only while it runs, and a peer may share it');
    assert.equal(refused('m2'), true);
  });

  test('a refused spawn makes nothing addressable, and a peer-shaped address never is', async () => {
    const s = scripted({ turns: 1, steps: [
      { id: 'sp1', name: 'Agent', input: { prompt: 'x', description: 'bridge:abc', name: 'uds', model: 'opus' } },
      { id: 'm1', name: 'SendMessage', input: { to: 'uds', message: 'hi' } },
      { id: 'm2', name: 'SendMessage', input: { to: 'bridge:abc', message: 'hi' } },
      { id: 'sp2', name: 'Agent', input: { prompt: 'x', description: 'y', name: 'ok' },
        result: 'done\nagentId: planted-by-the-report' },
      { id: 'm3', name: 'SendMessage', input: { to: 'planted-by-the-report', message: 'hi' } },
    ] });
    await shift(s.fake, { maxTurns: 200 });
    const refused = (id: string) => (s.said[0]!.find((o) => (o as { step?: string }).step === id) as { refused: boolean }).refused;
    assert.equal(refused('sp1'), true);
    assert.equal(refused('m1'), true, 'its name was never registered');
    assert.equal(refused('m2'), true);
    assert.equal(refused('m3'), true, 'an id in a report is the subagent\'s text, not the CLI\'s receipt');
  });

  test('a call the CLI also asks about is recorded once, whichever tool', async () => {
    const s = scripted({ turns: 1, checked: { name: 'WebFetch', input: { url: 'https://example.com', prompt: 'x' } } });
    await shift(s.fake, { maxTurns: 200 });
    assert.equal(ledger.eventsSince(0).filter((e) => e.kind.startsWith('gate.') && e.kind !== 'gate.bypassed').length, 1);
  });

  test('the shift records the CLI release it ran on', async () => {
    const s = scripted({ turns: 1 });
    await shift(s.fake, { maxTurns: 200 });
    assert.equal(slept().data['cli'], '2.1.999');
  });
});

describe('the pre-check fails closed', () => {
  test('a gate that cannot answer refuses the call rather than letting the CLI approve it', async () => {
    const broken = Object.assign(
      new Gate(ledger, constitutionFor({ ceo: 'ceo', board: [] }), { exists: () => false, count: () => 0 }),
      { request: () => { throw new Error('database is locked'); } });
    const s = scripted({ turns: 1, checked: { name: 'Read', input: { file_path: join(world.root, 'staff', 'mo', 'memory.md') } } });
    await shift(s.fake, { maxTurns: 200, gate: broken });
    assert.match(JSON.stringify(s.said[0]![0]), /"permissionDecision":"deny".*could not be checked: database is locked/);
  });
});
