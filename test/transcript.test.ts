import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { TranscriptStore, type TurnInput } from '../src/ledger/transcript.ts';
import { recordShiftMessage } from '../src/runtime/staff.ts';

/**
 * The company's own audit store, and the mapping from an SDK message to the
 * rows it records. Both matter: a shift that runs and records nothing leaves no
 * audit, and a mapping that drops tool calls leaves an audit that lies by
 * omission.
 */
describe('the audit store keeps a shift on the record', () => {
  let dir: string;
  let store: TranscriptStore;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'riff-transcript-')); store = new TranscriptStore(join(dir, 't.db')); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test('blocks come back in the order they were spoken, numbered per session', () => {
    store.append({ sessionId: 'A', agentId: 'jack', role: 'assistant', kind: 'text', text: 'one' });
    store.append({ sessionId: 'A', agentId: 'jack', role: 'assistant', kind: 'tool_use', name: 'Bash', text: '{}' });
    store.append({ sessionId: 'B', agentId: 'jack', role: 'assistant', kind: 'text', text: 'other session' });
    const a = store.bySession('A');
    assert.deepEqual(a.map((t) => t.seq), [1, 2], 'seq is per session, from one');
    assert.deepEqual(a.map((t) => t.kind), ['text', 'tool_use']);
    assert.equal(store.bySession('B')[0]!.seq, 1, 'a second session starts its own count');
  });

  test('a session pages forward from a cursor, so a long shift is never truncated', () => {
    for (let i = 0; i < 5; i++) store.append({ sessionId: 'A', agentId: 'jack', role: 'assistant', kind: 'text', text: `b${i}` });
    const page1 = store.bySession('A', { limit: 2 });
    assert.deepEqual(page1.map((t) => t.seq), [1, 2], 'the first page starts at the beginning');
    const page2 = store.bySession('A', { after: page1[page1.length - 1]!.seq, limit: 2 });
    assert.deepEqual(page2.map((t) => t.seq), [3, 4], 'the next page is strictly after the cursor');
    const tail = store.bySession('A', { after: page2[page2.length - 1]!.seq, limit: 2 });
    assert.deepEqual(tail.map((t) => t.seq), [5], 'and the last page is whatever remains');
    assert.equal(store.bySession('A', { after: 5 }).length, 0, 'past the end is empty — a quiet live tail');
  });

  test('meta round-trips as an object, not a string', () => {
    store.append({ sessionId: 'A', agentId: 'jack', role: 'assistant', kind: 'text', text: 'hi', meta: { model: 'claude-opus-5' } });
    assert.deepEqual(store.bySession('A')[0]!.meta, { model: 'claude-opus-5' });
  });

  test('sessionsFor groups an agent\'s sessions, most recent first', () => {
    store.append({ sessionId: 'A', agentId: 'jack', role: 'assistant', kind: 'text', text: 'a1' });
    store.append({ sessionId: 'A', agentId: 'jack', role: 'assistant', kind: 'text', text: 'a2' });
    store.append({ sessionId: 'B', agentId: 'jack', role: 'assistant', kind: 'text', text: 'b1' });
    store.append({ sessionId: 'C', agentId: 'carver', role: 'assistant', kind: 'text', text: 'c1' });
    const sessions = store.sessionsFor('jack');
    assert.deepEqual(sessions.map((s) => s.sessionId), ['B', 'A'], 'most recently written first, only this agent');
    assert.equal(sessions.find((s) => s.sessionId === 'A')!.turns, 2);
  });

  test('a tool that dumps a file is clipped, with the head kept and the cut named', () => {
    const huge = 'x'.repeat(250_000);
    store.append({ sessionId: 'A', agentId: 'jack', role: 'user', kind: 'tool_result', name: 't1', text: huge });
    const t = store.bySession('A')[0]!;
    assert.ok(t.text.length < huge.length, 'stored shorter than the dump');
    assert.match(t.text, /more characters\]$/, 'and says how much was cut');
  });
});

describe('an SDK message maps to the rows that record it', () => {
  const rows: TurnInput[] = [];
  const sink = { append: (t: TurnInput) => { rows.push(t); } };
  const record = (m: unknown) => recordShiftMessage(sink, 'sess', 'jack', m as SDKMessage);
  beforeEach(() => { rows.length = 0; });

  test('an assistant turn records its text, its reasoning, and each tool call', () => {
    record({ type: 'assistant', message: { model: 'claude-opus-5', content: [
      { type: 'text', text: 'On it.' },
      { type: 'thinking', thinking: 'let me check', signature: 'sig' },
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
    ] } });
    assert.deepEqual(rows.map((r) => r.kind), ['text', 'thinking', 'tool_use']);
    assert.equal(rows[0]!.text, 'On it.');
    assert.equal(rows[1]!.text, 'let me check', 'the reasoning, without the base64 signature');
    assert.equal(rows[2]!.name, 'Bash');
    assert.equal(rows[2]!.text, JSON.stringify({ command: 'ls' }));
  });

  test('an empty text block is not a turn and is not recorded', () => {
    record({ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: '   ' }] } });
    assert.equal(rows.length, 0);
  });

  test('a string user prompt is one row; a tool result carries its call id and error flag', () => {
    record({ type: 'user', message: { content: 'You have woken up.' } });
    record({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file-a\nfile-b', is_error: false },
    ] } });
    assert.equal(rows[0]!.kind, 'text');
    assert.equal(rows[0]!.text, 'You have woken up.');
    assert.equal(rows[1]!.kind, 'tool_result');
    assert.equal(rows[1]!.name, 'tu_1');
    assert.equal(rows[1]!.text, 'file-a\nfile-b');
    assert.deepEqual(rows[1]!.meta, { isError: false });
  });

  test('a tool result given as content blocks is flattened to its text', () => {
    record({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu_2', content: [{ type: 'text', text: 'the output' }], is_error: true },
    ] } });
    assert.equal(rows[0]!.text, 'the output');
    assert.deepEqual(rows[0]!.meta, { isError: true });
  });

  test('the final result records the tally, not a wall of nothing', () => {
    record({ type: 'result', subtype: 'success', result: 'done', num_turns: 7, total_cost_usd: 1.25 });
    assert.equal(rows[0]!.role, 'result');
    assert.deepEqual(rows[0]!.meta, { subtype: 'success', turns: 7, sessionCostUsd: 1.25 },
      'the conversation\'s running total, named as one — a resume carries it forward');
  });

  test('a subagent\'s messages are tagged with the call that spawned it', () => {
    // They arrive in the agent's stream; untagged, Carver's helper's reads
    // were recorded as Carver's own.
    record({ type: 'assistant', parent_tool_use_id: null, message: { model: 'm', content: [
      { type: 'tool_use', id: 'spawn', name: 'Agent', input: { description: 'look' } },
    ] } });
    record({ type: 'user', parent_tool_use_id: 'spawn', message: { content: 'Read the file.' } });
    record({ type: 'assistant', parent_tool_use_id: 'spawn', message: { model: 'm', content: [
      { type: 'tool_use', id: 'r1', name: 'Read', input: {} },
    ] } });
    record({ type: 'user', parent_tool_use_id: 'spawn', message: { content: [
      { type: 'tool_result', tool_use_id: 'r1', content: 'text' },
    ] } });
    assert.deepEqual(rows.map((r) => (r.meta as { parent?: string } | undefined)?.parent),
      [undefined, 'spawn', 'spawn', 'spawn']);
  });

  test('recording never throws — a broken sink cannot fail a shift', () => {
    const boom = { append: () => { throw new Error('disk full'); } };
    assert.doesNotThrow(() => recordShiftMessage(boom, 'sess', 'jack',
      { type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'hi' }] } } as unknown as SDKMessage));
  });
});
