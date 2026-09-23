import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import {
  DEFAULT_STAFF, INHERIT, isModelId, mindOf, readStaffDefaults,
} from '../src/core/models.ts';
import { catalogFrom, toOptions } from '../src/runtime/models.ts';
import { meterDelta, type SessionMeter } from '../src/runtime/staff.ts';
import { Ledger } from '../src/ledger/ledger.ts';
import { CLAUDE_CODE_UA } from '../src/core/config.ts';

describe('which model a seat thinks with', () => {
  test('a seat that was never singled out follows the company, whatever the company picks', () => {
    const seat = { model: INHERIT, effort: INHERIT };
    assert.deepEqual(mindOf(seat, { model: 'default', effort: 'medium' }), { model: 'default', effort: 'medium' });
    assert.deepEqual(mindOf(seat, { model: 'sonnet', effort: 'low' }), { model: 'sonnet', effort: 'low' });
  });

  test('a seat singled out keeps its own, one setting at a time', () => {
    const company = { model: 'default', effort: 'medium' } as const;
    assert.deepEqual(mindOf({ model: 'haiku', effort: INHERIT }, company), { model: 'haiku', effort: 'medium' });
    assert.deepEqual(mindOf({ model: INHERIT, effort: 'max' }, company), { model: 'default', effort: 'max' });
  });

  test('a corrupted seat falls back to the company rather than reaching the CLI', () => {
    const company = { model: 'default', effort: 'medium' } as const;
    assert.deepEqual(mindOf({ model: 'opus; rm -rf /', effort: 'extreme' }, company), company);
  });

  test('the company default is Default: the CLI’s own latest Opus, at the old medium', () => {
    // Pinning an id here is how every seat stayed on Opus 5 the day 5.5 shipped.
    assert.deepEqual(DEFAULT_STAFF, { model: 'default', effort: 'medium' });
    assert.deepEqual(readStaffDefaults(undefined), DEFAULT_STAFF, 'a company founded before this existed');
    assert.deepEqual(readStaffDefaults({ model: 42, effort: 'turbo' }), DEFAULT_STAFF);
    assert.deepEqual(readStaffDefaults({ model: 'opus[1m]', effort: 'xhigh' }), { model: 'opus[1m]', effort: 'xhigh' });
  });

  test('a model setting is an id or an alias, never something else a spawn would carry', () => {
    for (const ok of ['default', 'sonnet', 'opus[1m]', 'claude-fable-5-1[1m]', 'claude-haiku-4-5-20251001']) {
      assert.ok(isModelId(ok), ok);
    }
    for (const bad of ['', '--dangerously-skip-permissions', 'opus sonnet', 'a/b', 'x'.repeat(81), 'opus[1m]x']) {
      assert.ok(!isModelId(bad), bad);
    }
  });
});

describe('the model catalog is the CLI’s own list', () => {
  const rows = [
    { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (recommended)',
      description: 'Use the default model (currently Opus 5.5 (1M context)) · $5/$25 per Mtok',
      supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku',
      description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok' },
    { value: '--bad flag', displayName: 'Nope', description: '' },
  ] as ModelInfo[];

  test('each row keeps what it resolves to and the efforts it takes, and drops the price', () => {
    const [def, haiku, ...rest] = toOptions(rows);
    assert.deepEqual(def, {
      value: 'default', label: 'Default (recommended)',
      description: 'Use the default model (currently Opus 5.5 (1M context))',
      resolved: 'claude-opus-5-5[1m]', efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    // costUsd is imputed list price; a subscription pays none of it.
    assert.ok(!JSON.stringify(def).includes('$'));
    assert.deepEqual(haiku?.efforts, [], 'a model with no effort setting says so, rather than offering five');
    assert.equal(rest.length, 0, 'a value that is not a model id never reaches the picker');
  });

  test('asked once, kept, and shared by concurrent callers', async () => {
    let asks = 0;
    const get = catalogFrom(async () => { asks++; await new Promise((r) => setTimeout(r, 10)); return rows; });
    const [a, b] = await Promise.all([get(), get()]);
    await get();
    assert.equal(asks, 1);
    assert.equal(a.source, 'sdk');
    assert.equal(b.models[0]?.resolved, 'claude-opus-5-5[1m]');
  });

  test('a CLI that cannot answer serves the common aliases, and is asked again later', async () => {
    let now = 0;
    let asks = 0;
    const get = catalogFrom(async () => { asks++; if (asks === 1) throw new Error('spawn failed'); return rows; },
      () => now);
    const first = await get();
    assert.equal(first.source, 'fallback');
    assert.ok(first.models.some((m) => m.value === 'default'), 'Default is always offered');
    now += 60_000;
    assert.equal((await get()).source, 'fallback', 'not re-spawned on every picker open');
    assert.equal(asks, 1);
    now += 10 * 60_000;
    assert.equal((await get()).source, 'sdk');
    assert.equal(asks, 2);
  });

  test('the runtime route speaks as the CLI that is actually bundled', () => {
    // The keyproxy stamps this user-agent on every subscription call. Left behind
    // an SDK bump, it claims a Claude Code the factory is no longer running.
    const pkg = JSON.parse(readFileSync(
      new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8')) as
      { claudeCodeVersion: string };
    assert.equal(CLAUDE_CODE_UA, `claude-code/${pkg.claudeCodeVersion}`);
  });
});

describe('a ledger from before seats had a model of their own', () => {
  test('every stamped seat moves to the company default once, and a later choice is kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'riff-models-'));
    try {
      const path = join(dir, 'ledger.db');
      // The agents table as it stood: no effort column, and a model stamped at hire.
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE agents (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL, role TEXT NOT NULL,
          department TEXT NOT NULL DEFAULT '', reports_to TEXT REFERENCES agents(id),
          status TEXT NOT NULL DEFAULT 'active', activity TEXT NOT NULL DEFAULT '',
          mandate TEXT NOT NULL DEFAULT '', hired_at TEXT NOT NULL,
          hired_by TEXT REFERENCES agents(id), model TEXT NOT NULL);
        INSERT INTO agents(id,name,tier,role,hired_at,model) VALUES
          ('cali','Cali','board','Chairman','2026-09-01','human'),
          ('juno','Juno','executive','CEO','2026-09-01','claude-opus-5'),
          ('pax','Pax','member','Engineer','2026-09-02','claude-opus-4-8');`);
      old.close();

      const l = new Ledger(path);
      const seat = (id: string) => { const a = l.getAgent(id)!; return { model: a.model, effort: a.effort }; };
      assert.deepEqual(seat('juno'), { model: INHERIT, effort: INHERIT });
      assert.deepEqual(seat('pax'), { model: INHERIT, effort: INHERIT });
      assert.equal(l.getAgent('cali')?.model, 'human', 'the board stays human');

      l.upsertAgent({ ...l.getAgent('pax')!, model: 'sonnet', effort: 'low' });
      l.close();

      const again = new Ledger(path);
      assert.deepEqual({ model: again.getAgent('pax')!.model, effort: again.getAgent('pax')!.effort },
        { model: 'sonnet', effort: 'low' }, 'a choice made after the move survives the next open');
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a shift is metered for what it spent, not what its conversation has', () => {
  // From 0.3.280 a resumed session's results carry the totals of every earlier
  // shift of the conversation. Summed as they arrive, a seat's fifth resumed
  // shift would record five shifts' tokens, and vitals would add them again.
  const u = (input: number, output: number, cacheRead = 0, cacheWrite = 0) =>
    ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead,
       cacheCreationInputTokens: cacheWrite }) as never;

  test('the first result of a conversation counts in full', () => {
    const r = meterDelta(null, 's1', 0.5, { opus: u(100, 50, 1000, 200) });
    assert.deepEqual(r.tokens, { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 });
    assert.equal(r.costUsd, 0.5);
  });

  test('a resumed shift counts only what it added over the saved totals', () => {
    const before: SessionMeter = { session: 's1', costUsd: 0.5,
      usage: { opus: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 } } };
    const r = meterDelta(before, 's1', 0.8, { opus: u(130, 90, 2500, 260), haiku: u(10, 5) });
    assert.deepEqual(r.tokens, { input: 40, output: 45, cacheRead: 1500, cacheWrite: 60 },
      'an auxiliary model new to the conversation counts in full beside the delta');
    assert.ok(Math.abs(r.costUsd - 0.3) < 1e-9);
    assert.deepEqual(r.after.usage['opus'], { input: 130, output: 90, cacheRead: 2500, cacheWrite: 260 });
  });

  test('a different conversation starts from zero, whatever the last one reached', () => {
    const before: SessionMeter = { session: 'old', costUsd: 9,
      usage: { opus: { input: 9000, output: 9000, cacheRead: 9000, cacheWrite: 9000 } } };
    const r = meterDelta(before, 'new', 0.1, { opus: u(10, 5) });
    assert.deepEqual(r.tokens, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
    assert.equal(r.costUsd, 0.1);
  });

  test('a zeroed crash result counts nothing and does not erase the baseline', () => {
    const before: SessionMeter = { session: 's1', costUsd: 0.5,
      usage: { opus: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 } } };
    const crash = meterDelta(before, 's1', 0, { opus: u(0, 0) });
    assert.deepEqual(crash.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(crash.costUsd, 0);
    const next = meterDelta(crash.after, 's1', 0.6, { opus: u(110, 60, 1100, 200) });
    assert.deepEqual(next.tokens, { input: 10, output: 10, cacheRead: 100, cacheWrite: 0 },
      'the next real result is measured against the totals before the crash');
  });
});

describe('what a shift is handed', () => {
  const staff = readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');

  test('the system prompt is rendered fresh every leg, never replayed from the first', () => {
    // 0.3.280 records a conversation's system prompt once and replays it on
    // every resume unless told not to — roster, rules, persona and memory frozen
    // at the day the conversation began.
    assert.match(staff, /systemPrompt: \{ type: 'custom', prompt: buildSystemPrompt\(d\), snapshot: false \}/);
  });

  test('the model and effort sent are the seat’s resolved mind, and the window is keyed on what ran', () => {
    assert.match(staff, /model: mind\.model,/);
    assert.match(staff, /effort: mind\.effort,/);
    assert.match(staff, /contextWindowOf\(m\.modelUsage, ran\.model \?\? mind\.model\)/);
    assert.match(staff, /ran\.model = m\.model;/);
  });
});
