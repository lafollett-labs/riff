import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scopedSecretEnv } from '../src/runtime/staff.ts';
import { verifyScopedToken } from '../src/core/proxytoken.ts';
import type { ServiceRoute } from '../src/core/config.ts';

/**
 * The product reaches an external key through the proxy by reading an ordinary
 * env var and finding a *scoped token* there, not the real key. scopedSecretEnv
 * builds that env — one token per shift, keyed by each service's secret name —
 * and staff merges it into the shift's child-process env. Nothing else in the
 * suite proved the product actually receives a usable token under the right
 * name, so a route could have been declared and the token silently never wired.
 *
 * Minting reads the signing secret at installRoot(), so every test runs against
 * a throwaway root — a real mint verified by the real verifier, not a stub.
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
  upstream: 'https://api.anthropic.com', secret, ...extra,
});

describe('a shift carries a usable scoped token under each service secret', () => {
  test('the env var the product reads holds a token scoped to this company', () => {
    const env = scopedSecretEnv('shipit', { anthropic: route('ANTHROPIC_AUTH_TOKEN') }, 45 * 60_000);
    const token = env['ANTHROPIC_AUTH_TOKEN'];
    assert.ok(token, 'the declared secret name is present in the shift env');
    assert.deepEqual(verifyScopedToken(token), { company: 'shipit' },
      'and it verifies as a real, unexpired token for this company');
  });

  test('the injected value is the scoped token, never the secret name or a key', () => {
    // A regression that wrote the *name* into the env (env[secret] = secret)
    // would still be truthy and still be present — only verification catches it.
    const env = scopedSecretEnv('shipit', { anthropic: route('ANTHROPIC_API_KEY', { header: 'x-api-key', scheme: '' }) }, 45 * 60_000);
    assert.notEqual(env['ANTHROPIC_API_KEY'], 'ANTHROPIC_API_KEY');
    assert.ok(verifyScopedToken(env['ANTHROPIC_API_KEY']!));
  });

  test('every declared service gets a valid token under its own name', () => {
    const env = scopedSecretEnv('shipit', {
      anthropic: route('ANTHROPIC_AUTH_TOKEN'),
      openrouter: { upstream: 'https://openrouter.ai/api/v1', secret: 'OPENROUTER_API_KEY' },
    }, 45 * 60_000);
    assert.deepEqual(verifyScopedToken(env['ANTHROPIC_AUTH_TOKEN']!), { company: 'shipit' });
    assert.deepEqual(verifyScopedToken(env['OPENROUTER_API_KEY']!), { company: 'shipit' });
  });

  test('two services naming one secret share the one token — it names the company, not the route', () => {
    const env = scopedSecretEnv('shipit', {
      chat: route('ANTHROPIC_AUTH_TOKEN'),
      embed: route('ANTHROPIC_AUTH_TOKEN'),
    }, 45 * 60_000);
    assert.equal(Object.keys(env).length, 1);
    assert.ok(verifyScopedToken(env['ANTHROPIC_AUTH_TOKEN']!));
  });

  test('the token outlives the shift clock, so a call late in the shift still authenticates', () => {
    // ttl = shift wall clock + 5 min grace; verify just past the shift's own
    // deadline and the token must still be good (it dies with the leg, not before).
    const shiftMs = 45 * 60_000;
    const env = scopedSecretEnv('shipit', { anthropic: route('ANTHROPIC_AUTH_TOKEN') }, shiftMs);
    const justAfterShift = Date.now() + shiftMs + 60_000;
    assert.ok(verifyScopedToken(env['ANTHROPIC_AUTH_TOKEN']!, justAfterShift),
      'still valid a minute past the shift deadline');
  });

  test('no company or no services means no tokens — nothing is minted for a shift that reaches nothing', () => {
    assert.deepEqual(scopedSecretEnv(undefined, { anthropic: route('X') }, 60_000), {});
    assert.deepEqual(scopedSecretEnv('shipit', undefined, 60_000), {});
    assert.deepEqual(scopedSecretEnv('shipit', {}, 60_000), {});
  });
});

describe('the scoped tokens actually reach the shift subprocess env', () => {
  // The env passed to query() is what the CLI child inherits, and a unit test
  // cannot drive the real query(). Guard the one wiring seam by source: the
  // built secretEnv MUST be spread into that env object, or the tokens above
  // are minted and thrown away.
  const staff = () => readFileSync(new URL('../src/runtime/staff.ts', import.meta.url), 'utf8');

  test('secretEnv is spread into the env handed to query(), on top of process.env', () => {
    const src = staff();
    assert.match(src, /env: \{ \.\.\.process\.env,.*\.\.\.secretEnv \}/,
      'the shift child-process env must include ...secretEnv');
  });

  test('the env is named whenever there are tokens, not only when a cache dir is set', () => {
    // Naming `env` replaces the inherited environment, so the guard that decides
    // to name it must fire on secretEnv too — otherwise a company with services
    // but no cache dir would run with tokens dropped.
    assert.match(staff(), /d\.cacheDir \|\| Object\.keys\(secretEnv\)\.length/);
  });
});
