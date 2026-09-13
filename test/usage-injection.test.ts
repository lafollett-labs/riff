import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { windowsFromUsage } from '../src/runtime/limits.ts';
import { Scheduler } from '../src/runtime/scheduler.ts';
import type { Ledger } from '../src/ledger/ledger.ts';
import type { Gate } from '../src/policy/gate.ts';
import type { World } from '../src/worldfs/world.ts';
import type { Clock } from '../src/core/clock.ts';

// The /api/oauth/usage response verbatim (trimmed): each window is a TOP-LEVEL
// key, alongside fields that are not windows. The gateway wraps this as the
// `rate_limits` map windowsFromUsage reads, and that function's "skip anything
// without a numeric utilization" rule is what drops the non-window fields.
const USAGE_RESPONSE = {
  five_hour: { utilization: 4.0, resets_at: '2026-09-12T02:49:59.974768+00:00', limit_dollars: null },
  seven_day: { utilization: 21.0, resets_at: '2026-09-17T00:59:59.974789+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  extra_usage: { is_enabled: false, utilization: null },
  spend: { used: { amount_minor: 0 }, percent: 0 },
  limits: [{ kind: 'session', percent: 4 }],
  member_dashboard_available: false,
};

const asRateLimits = (r: unknown) => windowsFromUsage({
  rate_limits_available: true,
  rate_limits: r as Record<string, { utilization: number | null; resets_at: string | null } | null>,
});

test('the usage response yields exactly its windows, and none of its other fields', () => {
  const windows = new Map(asRateLimits(USAGE_RESPONSE));
  assert.deepEqual([...windows.keys()].sort(), ['five_hour', 'nimbus_quill', 'seven_day']);
  // utilization arrives 0-100 and is stored 0-1, the scale the scheduler uses.
  assert.equal(windows.get('five_hour')?.utilization, 0.04);
  assert.equal(windows.get('seven_day')?.utilization, 0.21);
  // A zero window is real news (a fresh reset), not an absent one.
  assert.equal(windows.get('nimbus_quill')?.utilization, 0);
});

test('a null window is dropped, not stored as zero', () => {
  const windows = new Map(asRateLimits(USAGE_RESPONSE));
  assert.ok(!windows.has('seven_day_opus'), 'a null window must not become a 0% one');
});

test('resets_at is carried as epoch seconds when present, omitted when null', () => {
  const windows = new Map(asRateLimits(USAGE_RESPONSE));
  assert.equal(windows.get('seven_day')?.resetsAt, Date.parse('2026-09-17T00:59:59.974789+00:00') / 1000);
  assert.equal(windows.get('nimbus_quill')?.resetsAt, undefined);
});

// ------------------------------------------------------------- scheduler side

const win = (kind: string, utilization: number): [string, SDKRateLimitInfo] =>
  [kind, { status: 'allowed', utilization,
           rateLimitType: kind as NonNullable<SDKRateLimitInfo['rateLimitType']> }];

const harness = (opts: Partial<{
  dailyBudgetUsd: number; maxSessionMs: number;
  throttleAboveUtilization: number; pauseAboveUtilization: number;
}> = {}) => {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const ledger = {
    emit: (_a: string, kind: string, _s: unknown, data: unknown) =>
      events.push({ kind, data: data as Record<string, unknown> }),
    lastWorked: () => [] as Array<[string, number]>,
  } as unknown as Ledger;
  const clock = { now: () => new Date('2026-09-11T23:00:00Z'), day: () => '2026-09-11' } as unknown as Clock;
  const s = new Scheduler({
    ledger, clock, gate: {} as unknown as Gate, world: {} as unknown as World,
    options: { throttleAboveUtilization: 0.7, pauseAboveUtilization: 0.92, ...opts },
  });
  return { s, events };
};

test('injected windows below the throttle floor leave the company at full pace', () => {
  const { s, events } = harness();
  s.applyUsage([win('five_hour', 0.1), win('seven_day', 0.21)]);
  assert.equal(s.binding?.utilization, 0.21, 'the fullest window is the binding one');
  assert.ok(!events.some((e) => e.kind === 'company.throttled'), 'no throttle below the floor');
  assert.ok(!events.some((e) => e.kind === 'company.usage_paused'), 'no pause below the ceiling');
  assert.equal(s.pausedUntil, 0);
});

test('an injected window over the throttle floor slows the company and says so', () => {
  const { s, events } = harness();
  s.applyUsage([win('seven_day', 0.85)]);
  const throttled = events.find((e) => e.kind === 'company.throttled');
  assert.ok(throttled, 'a throttle over the floor is recorded');
  assert.equal(throttled?.data['utilization'], 0.85);
  assert.equal(s.pausedUntil, 0, 'slowed, not stopped');
});

test('an injected window over the pause ceiling stops the company until it resets', () => {
  const { s, events } = harness();
  const before = Date.now();
  s.applyUsage([win('seven_day', 0.95)]);
  assert.ok(events.some((e) => e.kind === 'company.usage_paused'), 'a pause is recorded');
  assert.ok(s.pausedUntil > before, 'the company is paused into the future');
});

test('the fullest window wins even when a fresh one reads low', () => {
  // The exact regression the per-window store exists for: a five-hour window
  // just reset to 2% must not lift the throttle while the weekly sits at 94%.
  const { s } = harness();
  s.applyUsage([win('seven_day', 0.94), win('five_hour', 0.02)]);
  assert.equal(s.binding?.utilization, 0.94);
  assert.ok(s.pausedUntil > Date.now(), 'the weekly ceiling still pauses it');
});

test('a window the build does not know is recorded but never paces the company', () => {
  // Same rule as limits.ts: an unknown window reporting 99% must not throttle or
  // pause on a number this build cannot reason about — but it is still recorded.
  const { s, events } = harness();
  s.applyUsage([['mystery_window', { status: 'allowed', utilization: 0.99 }]]);
  assert.ok(s.windows.some((w) => w.kind === 'mystery_window'), 'recorded for the console');
  assert.equal(s.binding, null, 'not a known limit, so nothing to pace on');
  assert.ok(!events.some((e) => e.kind === 'company.usage_paused'));
  assert.equal(s.pausedUntil, 0);
});

test('an empty injection changes nothing', () => {
  const { s, events } = harness();
  s.applyUsage([]);
  assert.equal(s.binding, null);
  assert.equal(events.length, 0);
});

// ---------------------------------------------------- pacing when blind

test('with no reading yet the company is blind and names its fallback', () => {
  const { s } = harness();
  const p = s.pacing();
  assert.equal(p.blind, true, 'no window read means pacing cannot trust one');
  assert.equal(p.windowAgeMs, null);
  // No spend cap here, but the session-time cap is always the last resort.
  assert.equal(p.fallback, 'time');
});

test('a just-read window is trusted; the same reading half an hour on is not', () => {
  const { s } = harness();
  s.applyUsage([win('seven_day', 0.3)]);
  const now = Date.now();
  assert.equal(s.pacing(now).blind, false, 'a fresh reading paces the company');
  assert.ok((s.pacing(now).windowAgeMs ?? 1e9) < 1_000);
  // A dead poller freezes this reading; past the horizon it is no longer trusted
  // and the company falls back to its caps.
  assert.equal(s.pacing(now + 31 * 60_000).blind, true);
});

test('a spend cap is the named fallback ahead of time when the feed is blind', () => {
  const { s } = harness({ dailyBudgetUsd: 5 });
  assert.equal(s.pacing().fallback, 'spend');
});
