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

  // The transcript store moved onto the volume under the company's own home, so
  // the home the shift may read now contains its own conversation history. The
  // deny has to follow it there, or a shift greps back everything it ever said.
  describe('the transcript store on the volume is denied even inside the allowed home', () => {
    const configDir = '/data/companies/shipit/.claude';

    test('the config dir is denied outright', () => {
      assert.ok(sandboxFilesystem(world, configDir).denyRead.includes(configDir));
    });

    test('transcripts and session state under it fall under the deny', () => {
      const fs = sandboxFilesystem(world, configDir);
      assert.ok(denied(fs, '/data/companies/shipit/.claude/projects/-data-companies-shipit-world/x.jsonl'),
        'a shift cannot read its own transcripts');
      assert.ok(denied(fs, '/data/companies/shipit/.claude/.claude.json'), 'nor the CLI state file');
    });

    test('the configDir deny is scoped to .claude and does not shadow the world', () => {
      // The installRoot deny reaches the world too, but allowRead overrides it
      // (more-specific-wins, bubblewrap's job). What this asserts is that the
      // config-store deny we added is narrow: it must not itself cover the world.
      const fs = sandboxFilesystem(world, configDir);
      const worldFile = '/data/companies/shipit/world/src/index.ts';
      assert.ok(!worldFile.startsWith(configDir + '/'),
        'the world is outside the denied config dir');
      assert.ok(fs.allowRead.includes('/data/companies/shipit'));
    });

    test('the shared $HOME store stays denied even when the on-volume one is set', () => {
      // The deny is additive, not either/or: /home/labs is one tmpfs shared by
      // every company, and reads there are allow-by-default, so dropping its deny
      // when configDir is set would make any residual the CLI leaves there a
      // cross-company read. Both stores denied, always.
      const withCfg = sandboxFilesystem(world, configDir);
      assert.ok(withCfg.denyRead.some((d) => d.endsWith('/.claude/projects')), 'default $HOME store still denied');
      assert.ok(withCfg.denyRead.includes(configDir), 'and the on-volume store too');
      const noCfg = sandboxFilesystem(world);
      assert.ok(noCfg.denyRead.some((d) => d.endsWith('/.claude/projects')), 'default store denied with no configDir');
    });
  });
});
