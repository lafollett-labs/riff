import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxFilesystem } from '../src/runtime/staff.ts';
import { installRoot } from '../src/core/config.ts';

/**
 * The one boundary CRITICAL-001 turned on: the shift sandbox must hide the whole
 * installation root, because the secrets store (master.key, secrets/<slug>.vault,
 * keyproxy.secret) sits there. bubblewrap reads are allow-by-default and Linux
 * only, so this asserts the deny list — not a live read — is correct.
 */
describe('the shift sandbox hides the whole installation root, not just companies/', () => {
  const world = '/data/companies/shipit/world';

  beforeEach(() => { process.env['RIFF_ROOT'] = '/data'; });
  afterEach(() => { delete process.env['RIFF_ROOT']; });

  const denied = (fs: { denyRead: string[] }, p: string): boolean =>
    fs.denyRead.some((d) => p === d || p.startsWith(d + '/'));

  test('denyRead names the installation root itself', () => {
    assert.ok(sandboxFilesystem(world).denyRead.includes(installRoot()));
  });

  test('every secrets-store path and both neighbours fall under a denied root', () => {
    const fs = sandboxFilesystem(world);
    assert.ok(denied(fs, '/data/master.key'), 'master.key must be hidden');
    assert.ok(denied(fs, '/data/secrets/fathom.vault.json'), 'another company vault must be hidden');
    assert.ok(denied(fs, '/data/keyproxy.secret'), 'the token-signing secret must be hidden');
    assert.ok(denied(fs, '/data/archive/gone-co'), 'archived companies must be hidden');
    assert.ok(denied(fs, '/data/companies/fathom'), 'neighbour companies must still be hidden');
  });

  test('the company keeps its own home through a more-specific allow', () => {
    assert.ok(sandboxFilesystem(world).allowRead.includes('/data/companies/shipit'));
  });
});
