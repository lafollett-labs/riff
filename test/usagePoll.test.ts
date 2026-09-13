import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pollUsageOnce, readAccessToken, startUsagePolling } from '../src/mcp/usagePoll.ts';
import type { RiffResponse } from '../src/mcp/client.ts';

// The /api/oauth/usage response: its top level IS the rate_limits map.
const usageBody = JSON.stringify({
  five_hour: { utilization: 27, resets_at: '2026-09-13T18:00:00Z' },
  seven_day: { utilization: 49, resets_at: '2026-09-20T00:00:00Z' },
});

const fetchReturning = (body: string, ok = true, status = 200): typeof globalThis.fetch =>
  (async () => ({ ok, status, text: async () => body })) as unknown as typeof globalThis.fetch;

describe('one poll reads the plan windows and injects them, or skips cleanly', () => {
  test('a good cycle posts the oauth body verbatim and reports what was accepted', async () => {
    let posted: unknown;
    const client = {
      postUsage: async (b: unknown): Promise<RiffResponse> => {
        posted = b; return { status: 200, data: { accepted: 2 } };
      },
    };
    const r = await pollUsageOnce({ client, token: () => 'tok', fetch: fetchReturning(usageBody) });
    assert.equal(r.ok, true);
    assert.match(r.note, /injected 2/);
    // The body is the parsed rate_limits map, handed on unshaped.
    assert.equal((posted as { five_hour?: { utilization?: number } }).five_hour?.utilization, 27);
  });

  test('no credential is a skipped poll and posts nothing', async () => {
    let posted = false;
    const client = { postUsage: async (): Promise<RiffResponse> => { posted = true; return { status: 200, data: {} }; } };
    const r = await pollUsageOnce({ client, token: () => null, fetch: fetchReturning(usageBody) });
    assert.equal(r.ok, false);
    assert.match(r.note, /no interactive credential/);
    assert.equal(posted, false);
  });

  test('an oauth HTTP error is skipped — the throttle keeps its last windows', async () => {
    let posted = false;
    const client = { postUsage: async (): Promise<RiffResponse> => { posted = true; return { status: 200, data: {} }; } };
    const r = await pollUsageOnce({ client, token: () => 'tok', fetch: fetchReturning('', false, 429) });
    assert.equal(r.ok, false);
    assert.match(r.note, /HTTP 429/);
    assert.equal(posted, false);
  });

  test('a non-JSON answer is skipped, never stored as if it were windows', async () => {
    let posted = false;
    const client = { postUsage: async (): Promise<RiffResponse> => { posted = true; return { status: 200, data: {} }; } };
    const r = await pollUsageOnce({ client, token: () => 'tok', fetch: fetchReturning('<html>login</html>') });
    assert.equal(r.ok, false);
    assert.match(r.note, /did not return JSON/);
    assert.equal(posted, false);
  });

  test('a gateway that rejects the post is reported, not swallowed as success', async () => {
    const client = { postUsage: async (): Promise<RiffResponse> => ({ status: 503, data: 'nope' }) };
    const r = await pollUsageOnce({ client, token: () => 'tok', fetch: fetchReturning(usageBody) });
    assert.equal(r.ok, false);
    assert.match(r.note, /\/api\/usage HTTP 503/);
  });

  test('a fetch that throws is a skipped poll, never an unhandled rejection', async () => {
    const boom = (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch;
    const client = { postUsage: async (): Promise<RiffResponse> => ({ status: 200, data: {} }) };
    const r = await pollUsageOnce({ client, token: () => 'tok', fetch: boom });
    assert.equal(r.ok, false);
    assert.match(r.note, /offline/);
  });
});

describe('reading the interactive access token stays in memory and fails soft', () => {
  test('the macOS Keychain entry wins when present', () => {
    const t = readAccessToken(
      () => JSON.stringify({ claudeAiOauth: { accessToken: 'from-keychain' } }),
      () => { throw new Error('the file must not be read when the Keychain has it'); });
    assert.equal(t, 'from-keychain');
  });

  test('it falls back to the credentials file when the Keychain has nothing', () => {
    const t = readAccessToken(
      () => { throw new Error('no keychain'); },
      () => JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } }));
    assert.equal(t, 'from-file');
  });

  test('neither source reachable is null, not a throw', () => {
    assert.equal(readAccessToken(() => { throw new Error('x'); }, () => { throw new Error('y'); }), null);
  });

  test('a malformed credential is null, never a partial token', () => {
    assert.equal(readAccessToken(() => 'not json', () => '{}'), null);
  });
});

describe('the interval seeds one poll at once and stops on demand', () => {
  test('startUsagePolling polls immediately and the stop function clears it', async () => {
    let polls = 0;
    const client = {
      postUsage: async (): Promise<RiffResponse> => { polls++; return { status: 200, data: { accepted: 1 } }; },
    };
    const stop = startUsagePolling(client, {
      intervalMs: 1_000_000, token: () => 'tok', log: () => {}, fetch: fetchReturning(usageBody),
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(polls, 1, 'exactly one immediate seed poll');
    stop();
  });
});
