import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let pt: typeof import('../src/core/proxytoken.ts');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'riff-proxytoken-'));
  process.env['RIFF_ROOT'] = join(root, '.riff');
  pt = await import('../src/core/proxytoken.ts');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['RIFF_ROOT'];
});

describe('a scoped token names its company and cannot be forged', () => {
  test('mint then verify recovers the company', () => {
    const tok = pt.mintScopedToken('shipit', 3600);
    assert.deepEqual(pt.verifyScopedToken(tok), { company: 'shipit' });
  });

  test('an expired token verifies to null', () => {
    const tok = pt.mintScopedToken('shipit', -1); // already past
    assert.equal(pt.verifyScopedToken(tok), null);
  });

  test('a token still valid now expires later', () => {
    const now = Date.now();
    const tok = pt.mintScopedToken('shipit', 60, now);
    assert.deepEqual(pt.verifyScopedToken(tok, now + 59_000), { company: 'shipit' });
    assert.equal(pt.verifyScopedToken(tok, now + 61_000), null);
  });

  test('a tampered signature is rejected', () => {
    const tok = pt.mintScopedToken('shipit', 3600);
    const bad = tok.slice(0, -2) + (tok.endsWith('AA') ? 'BB' : 'AA');
    assert.equal(pt.verifyScopedToken(bad), null);
  });

  test('swapping the company invalidates the signature', () => {
    const tok = pt.mintScopedToken('shipit', 3600);
    const parts = tok.split('.');
    parts[0] = 'fathom'; // keep the old signature
    assert.equal(pt.verifyScopedToken(parts.join('.')), null);
  });

  test('a token minted under a different secret does not verify', () => {
    const tok = pt.mintScopedToken('shipit', 3600);
    // Replace the signing secret with a fresh one; the old token must now fail.
    rmSync(join(process.env['RIFF_ROOT']!, 'keyproxy.secret'));
    pt.loadOrCreateProxySecret(); // creates a new one
    assert.equal(pt.verifyScopedToken(tok), null);
  });

  test('a malformed token is null, not a throw', () => {
    assert.equal(pt.verifyScopedToken(''), null);
    assert.equal(pt.verifyScopedToken('a.b'), null);
    assert.equal(pt.verifyScopedToken('a.b.c.d'), null);
    assert.equal(pt.verifyScopedToken('shipit.notanumber.sig'), null);
  });
});

describe('the signing secret is a protected file', () => {
  test('it is written 0600 and reused', () => {
    const s1 = pt.loadOrCreateProxySecret();
    const mode = statSync(join(process.env['RIFF_ROOT']!, 'keyproxy.secret')).mode & 0o777;
    assert.equal(mode, 0o600);
    const s2 = pt.loadOrCreateProxySecret();
    assert.ok(s1.equals(s2));
  });

  test('a truncated secret is refused, not used', () => {
    pt.loadOrCreateProxySecret();
    writeFileSync(join(process.env['RIFF_ROOT']!, 'keyproxy.secret'), 'c2hvcnQ=\n'); // "short"
    assert.throws(() => pt.mintScopedToken('shipit', 60), /bytes|minimum/);
  });
});
