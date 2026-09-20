import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scopedSecretEnv } from '../src/runtime/staff.ts';
import { verifyScopedToken } from '../src/core/proxytoken.ts';
import { RUNTIME_BASE_URL } from '../src/core/config.ts';
import type { ServiceRoute } from '../src/core/config.ts';

/**
 * A shift's own Claude inference, and its product's external calls, both reach a
 * key through the keyproxy by reading an ordinary env var and finding a *scoped
 * token* there, not the real key. scopedSecretEnv builds that env — one token per
 * shift — and staff merges it into the child-process env. It points the agents'
 * SDK at the reserved runtime route (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)
 * and puts the same token under each declared service secret.
 *
 * Minting reads the signing secret at installRoot(), so every test runs against a
 * throwaway root — a real mint verified by the real verifier, not a stub.
 */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'riff-shift-env-'));
  process.env['RIFF_ROOT'] = join(root, '.riff');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['RIFF_ROOT'];
});

const route = (secret: string, extra: Partial<ServiceRoute> = {}): ServiceRoute => ({
  upstream: 'https://openrouter.ai/api/v1', secret, ...extra,
});

describe('a shift routes its own Claude inference through the keyproxy', () => {
  test('the SDK is pointed at the reserved runtime route with a scoped token', () => {
    const env = scopedSecretEnv('shipit', undefined, 45 * 60_000);
    assert.equal(env['ANTHROPIC_BASE_URL'], RUNTIME_BASE_URL);
    assert.deepEqual(verifyScopedToken(env['ANTHROPIC_AUTH_TOKEN']!), { company: 'shipit' },
      'the auth token is a real, unexpired scoped token for this company');
  });

  test('the runtime routing is present even when the company declares no services', () => {
    const env = scopedSecretEnv('shipit', {}, 60_000);
    assert.equal(env['ANTHROPIC_BASE_URL'], RUNTIME_BASE_URL);
    assert.ok(env['ANTHROPIC_AUTH_TOKEN']);
  });

  test('no company means no env at all — nothing is minted for a shift that reaches nothing', () => {
    assert.deepEqual(scopedSecretEnv(undefined, { anthropic: route('X') }, 60_000), {});
  });
});

describe('a shift carries a usable scoped token under each service secret', () => {
  test('the env var the product reads holds a token scoped to this company', () => {
    const env = scopedSecretEnv('shipit', { openrouter: route('OPENROUTER_API_KEY') }, 45 * 60_000);
    const token = env['OPENROUTER_API_KEY'];
    assert.ok(token, 'the declared secret name is present in the shift env');
    assert.deepEqual(verifyScopedToken(token), { company: 'shipit' });
  });

  test('the injected value is the scoped token, never the secret name or a key', () => {
    // A regression that wrote the *name* into the env would still be truthy and
    // present — only verification catches it.
    const env = scopedSecretEnv('shipit', { openrouter: route('OPENROUTER_API_KEY', { header: 'x-api-key', scheme: '' }) }, 45 * 60_000);
    assert.notEqual(env['OPENROUTER_API_KEY'], 'OPENROUTER_API_KEY');
    assert.ok(verifyScopedToken(env['OPENROUTER_API_KEY']!));
  });

  test('every declared service gets a valid token under its own name', () => {
    const env = scopedSecretEnv('shipit', {
      openrouter: route('OPENROUTER_API_KEY'),
      stripe: { upstream: 'https://api.stripe.com', secret: 'STRIPE_KEY' },
    }, 45 * 60_000);
    assert.deepEqual(verifyScopedToken(env['OPENROUTER_API_KEY']!), { company: 'shipit' });
    assert.deepEqual(verifyScopedToken(env['STRIPE_KEY']!), { company: 'shipit' });
  });

  test('two services naming one secret share the one token — it names the company, not the route', () => {
    const env = scopedSecretEnv('shipit', {
      chat: route('MODEL_KEY'),
      embed: route('MODEL_KEY'),
    }, 45 * 60_000);
    assert.ok(verifyScopedToken(env['MODEL_KEY']!));
    // The same company-scoped token the runtime routing carries.
    assert.equal(env['MODEL_KEY'], env['ANTHROPIC_AUTH_TOKEN']);
  });

  test('the token outlives the shift clock, so a call late in the shift still authenticates', () => {
    const shiftMs = 45 * 60_000;
    const env = scopedSecretEnv('shipit', { openrouter: route('OPENROUTER_API_KEY') }, shiftMs);
    const justAfterShift = Date.now() + shiftMs + 60_000;
    assert.ok(verifyScopedToken(env['OPENROUTER_API_KEY']!, justAfterShift),
      'still valid a minute past the shift deadline');
  });
});

describe('the scoped tokens reach the shift subprocess env, and the raw token does not', () => {
  // The env passed to query() is what the CLI child inherits, and a unit test
  // cannot drive the real query(). Guard the wiring seam by source.
  const staff = () => readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');

  test('secretEnv is spread into the child env on top of process.env', () => {
    assert.match(staff(), /\.\.\.process\.env,[\s\S]*?\.\.\.secretEnv,/,
      'the shift child-process env must spread process.env then secretEnv');
  });

  test('the inherited subscription token is stripped from the child env', () => {
    // The agents authenticate through the proxy now; a raw CLAUDE_CODE_OAUTH_TOKEN
    // in the child env would only let the SDK bypass it and be readable by every
    // process the shift spawns — the exposure this move closes.
    assert.match(staff(), /delete env\['CLAUDE_CODE_OAUTH_TOKEN'\]/,
      'the shift child env must strip the raw subscription token');
  });

  test('the env is named whenever there are tokens, not only when a cache dir is set', () => {
    assert.match(staff(), /d\.cacheDir \|\| d\.configDir \|\| Object\.keys\(secretEnv\)\.length/);
  });
});
