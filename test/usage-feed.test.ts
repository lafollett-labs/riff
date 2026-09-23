import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unifiedWindows, INSTALL_SCOPE } from '../src/core/usage.ts';
import { slugId } from '../src/core/config.ts';

/**
 * The plan's windows come off the runtime credential's own responses now,
 * through the keyproxy, instead of a host process reading the operator's login.
 */

// The header set a one-token Haiku call came back with through the keyproxy on
// the long-lived runtime token, 2026-09-22.
const MEASURED = {
  'anthropic-ratelimit-unified-5h-reset': '1790134200',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.05',
  'anthropic-ratelimit-unified-7d-reset': '1790211600',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.42',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': '1790134200',
  'anthropic-ratelimit-unified-status': 'allowed',
  'content-type': 'application/json',
};

describe('the windows are read off the response headers', () => {
  test('the five-hour and seven-day windows, under the names Riff has always used', () => {
    assert.deepEqual(unifiedWindows(MEASURED), [
      { kind: 'five_hour', utilization: 0.05, resetsAt: 1790134200, status: 'allowed' },
      { kind: 'seven_day', utilization: 0.42, resetsAt: 1790211600, status: 'allowed' },
    ]);
  });

  test('a group with no utilization is not a window, and is left out rather than zeroed', () => {
    assert.ok(!unifiedWindows(MEASURED).some((w) => w.kind === 'overage'));
    assert.deepEqual(unifiedWindows({ 'content-type': 'text/plain' }), []);
  });

  test('a per-model week keeps its own name', () => {
    assert.deepEqual(unifiedWindows({ 'anthropic-ratelimit-unified-7d_opus-utilization': '0.3' }),
      [{ kind: 'seven_day_opus', utilization: 0.3, resetsAt: null, status: null }]);
  });

  test('the install scope can never be a company', () => {
    // It is what lets the gateway read the plan and a company's token not.
    for (const name of [INSTALL_SCOPE, 'install', '_install', 'Install']) {
      assert.notEqual(slugId(name), INSTALL_SCOPE, name);
    }
  });
});

describe('the gateway’s feed', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'riff-feed-'));
    process.env['RIFF_ROOT'] = join(root, '.riff');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); delete process.env['RIFF_ROOT']; });

  type Call = { url: string; method: string };
  const fakeProxy = (readings: Array<{ at: number | null; windows: unknown[] }>) => {
    const calls: Call[] = [];
    let i = 0;
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/usage')) {
        const r = readings[Math.min(i++, readings.length - 1)]!;
        return new Response(JSON.stringify(r), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    return { f, calls, pings: () => calls.filter((c) => c.method === 'POST').length };
  };
  const W = [{ kind: 'five_hour', utilization: 0.05, resetsAt: 1790134200, status: 'allowed' }];

  test('a fresh reading is passed on with the time it was read, once', async () => {
    const { feedRound } = await import('../src/runtime/usageFeed.ts');
    const got: Array<{ at: number; n: number }> = [];
    const p = fakeProxy([{ at: 1_000_000, windows: W }]);
    const last = { at: 0, pingedAt: 0 };
    const d = { inject: (w: unknown[], at: number) => got.push({ at, n: w.length }), fetch: p.f,
                origin: 'http://kp', now: () => 1_000_000 + 60_000, pollMinutes: () => 10 };
    await feedRound(d, last);
    await feedRound(d, last);
    assert.deepEqual(got, [{ at: 1_000_000, n: 1 }], 'the same reading is not re-applied as if new');
    assert.equal(p.pings(), 0, 'a minute-old reading needs no ping');
  });

  test('a stale reading gets one ping per interval, and the fresh one is passed on', async () => {
    const { feedRound } = await import('../src/runtime/usageFeed.ts');
    const got: number[] = [];
    let now = 10_000_000;
    const p = fakeProxy([{ at: 1_000, windows: W }, { at: now, windows: W }, { at: now, windows: W }]);
    const last = { at: 0, pingedAt: 0 };
    const d = { inject: (_w: unknown[], at: number) => got.push(at), fetch: p.f, origin: 'http://kp',
                now: () => now, pollMinutes: () => 10 };
    await feedRound(d, last);
    assert.equal(p.pings(), 1);
    assert.deepEqual(got, [1_000, now]);
    assert.ok(p.calls.some((c) => c.url === 'http://kp/svc/_runtime/v1/messages' && c.method === 'POST'));
  });

  test('a ping that brings nothing back is not repeated every minute', async () => {
    const { feedRound } = await import('../src/runtime/usageFeed.ts');
    let now = 10_000_000;
    const p = fakeProxy([{ at: null, windows: [] }]);       // no credential set: never a reading
    const last = { at: 0, pingedAt: 0 };
    const d = { inject: () => {}, fetch: p.f, origin: 'http://kp', now: () => now, pollMinutes: () => 10 };
    await feedRound(d, last);
    now += 60_000; await feedRound(d, last);
    now += 60_000; await feedRound(d, last);
    assert.equal(p.pings(), 1);
    now += 10 * 60_000; await feedRound(d, last);
    assert.equal(p.pings(), 2, 'and tried again once the interval has passed');
  });

  test('an API-key default is never pinged: it has no plan windows, and the call would be billed', async () => {
    const { feedRound } = await import('../src/runtime/usageFeed.ts');
    const p = fakeProxy([{ at: null, windows: [] }]);
    await feedRound({ inject: () => {}, fetch: p.f, origin: 'http://kp', now: () => 9e12, pollMinutes: () => 10,
      credentialType: () => 'apiKey' }, { at: 0, pingedAt: 0 });
    assert.equal(p.pings(), 0);
  });

  test('an interval of 0 never pings', async () => {
    const { feedRound } = await import('../src/runtime/usageFeed.ts');
    const p = fakeProxy([{ at: null, windows: [] }]);
    await feedRound({ inject: () => {}, fetch: p.f, origin: 'http://kp', now: () => 9e12, pollMinutes: () => 0 },
      { at: 0, pingedAt: 0 });
    assert.equal(p.pings(), 0);
  });
});

describe('the reading reaches the right companies, and never goes backwards', () => {
  test('a reserved audience never gets a shift token', async () => {
    const { scopedSecretEnv } = await import('../src/runtime/staff.ts');
    assert.deepEqual(scopedSecretEnv(INSTALL_SCOPE, undefined, undefined), {},
      'a folder named _install under companies/ must not speak as the installation');
  });

  test('an older reading never replaces a newer one', async () => {
    const { Scheduler } = await import('../src/runtime/scheduler.ts');
    const s = new Scheduler({
      ledger: { emit: () => ({}), lastWorked: () => [] } as never,
      clock: { now: () => new Date('2026-09-22T12:00:00Z'), day: () => '2026-09-22' } as never,
      gate: {} as never, world: {} as never,
      options: { throttleAboveUtilization: 0.7, pauseAboveUtilization: 0.92 },
    });
    s.applyUsage([['five_hour', { status: 'allowed', utilization: 0.8, rateLimitType: 'five_hour' }]], 2_000);
    s.applyUsage([['five_hour', { status: 'allowed', utilization: 0.1, rateLimitType: 'five_hour' }]], 1_000);
    assert.equal(s.windows.find((w) => w.kind === 'five_hour')?.utilization, 0.8);
  });

  test('the refresh interval stays inside the window the scheduler trusts', async () => {
    const { readUsagePollMinutes, MAX_USAGE_POLL_MINUTES } = await import('../src/core/settings.ts');
    assert.ok(MAX_USAGE_POLL_MINUTES < 30, 'below WINDOW_STALE_MS, or an idle company flips blind and back');
    assert.equal(readUsagePollMinutes(1440), MAX_USAGE_POLL_MINUTES);
    assert.equal(readUsagePollMinutes(-3), 0);
  });
});
