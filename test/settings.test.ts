import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuntimeCredential, runtimeRouteShape, runtimeRouteHeaders } from '../src/core/config.ts';

/**
 * readRuntimeCredential is what stands between a hand-edited config and a shape
 * the keyproxy acts on. It is pure — no disk, no env — so the test is inputs and
 * verdicts. "Anything else" must read as undefined, which the keyproxy treats as
 * "fall back to the install default" rather than a hard error.
 */
describe('readRuntimeCredential accepts only the two known shapes', () => {
  test('subscription and apiKey pass through', () => {
    assert.deepEqual(readRuntimeCredential({ type: 'subscription' }), { type: 'subscription' });
    assert.deepEqual(readRuntimeCredential({ type: 'apiKey' }), { type: 'apiKey' });
  });
  test('anything else is undefined', () => {
    for (const bad of [undefined, null, {}, { type: 'other' }, { type: 42 }, 'subscription', [], 7]) {
      assert.equal(readRuntimeCredential(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe('the synthesized runtime route has the shape each credential type needs', () => {
  test('a subscription token is a Bearer with the OAuth beta + claude-code UA', () => {
    assert.deepEqual(runtimeRouteShape('subscription'), { header: 'authorization', scheme: 'Bearer' });
    const h = runtimeRouteHeaders('subscription');
    assert.equal(h['anthropic-beta'], 'oauth-2025-04-20');
    assert.match(h['user-agent']!, /^claude-code\//);
    // anthropic-version is required on every /v1/messages call; the route injects
    // it so a subscription shift never depends on the SDK sending it (a missing
    // version header 400s silently — the deploy-verify curl hit exactly that).
    assert.ok(h['anthropic-version']);
  });

  test('an API key is x-api-key raw with the version header', () => {
    assert.deepEqual(runtimeRouteShape('apiKey'), { header: 'x-api-key', scheme: '' });
    assert.ok(runtimeRouteHeaders('apiKey')['anthropic-version']);
  });
});

/**
 * Settings reads installRoot() at call time, so an in-process RIFF_ROOT is enough
 * — the same throwaway-root discipline the secrets store uses, and for the same
 * reason: a test that writes settings.json under the operator's real install root
 * is not a test.
 */
let root: string;
let settings: typeof import('../src/core/settings.ts');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'riff-settings-'));
  process.env['RIFF_ROOT'] = join(root, '.riff');
  settings = await import('../src/core/settings.ts');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['RIFF_ROOT'];
});

describe('the installation default runtime-credential type persists', () => {
  test('unset reads as empty, before any company or install root exists', () => {
    assert.deepEqual(settings.readSettings(), {});
  });

  test('a set type round-trips, creating the install root on first write', () => {
    settings.setDefaultRuntimeCredentialType('apiKey');
    assert.deepEqual(settings.readSettings().runtimeCredential, { type: 'apiKey' });
  });

  test('setting again replaces', () => {
    settings.setDefaultRuntimeCredentialType('subscription');
    settings.setDefaultRuntimeCredentialType('apiKey');
    assert.deepEqual(settings.readSettings().runtimeCredential, { type: 'apiKey' });
  });

  test('clearing drops the default type back to empty', () => {
    settings.setDefaultRuntimeCredentialType('subscription');
    settings.clearDefaultRuntimeCredential();
    assert.deepEqual(settings.readSettings(), {});
  });

  test('clearing when nothing is set is a no-op, not a throw', () => {
    settings.clearDefaultRuntimeCredential();
    assert.deepEqual(settings.readSettings(), {});
  });

  test('a malformed settings file reads as empty rather than throwing', () => {
    mkdirSync(process.env['RIFF_ROOT']!, { recursive: true });
    writeFileSync(join(process.env['RIFF_ROOT']!, 'settings.json'), '{ not json');
    assert.deepEqual(settings.readSettings(), {});
  });

  test('a stored but invalid type is dropped, not surfaced', () => {
    mkdirSync(process.env['RIFF_ROOT']!, { recursive: true });
    writeFileSync(join(process.env['RIFF_ROOT']!, 'settings.json'),
      JSON.stringify({ runtimeCredential: { type: 'bogus' } }));
    assert.deepEqual(settings.readSettings(), {});
  });
});
