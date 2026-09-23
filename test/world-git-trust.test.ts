import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../src/worldfs/world.ts';
import { nestedRepos } from '../src/worldfs/git.ts';
import { classifyPath } from '../src/runtime/permissions.ts';
import { fixedClock } from '../src/core/clock.ts';

/**
 * The world's repository is written by the staff and committed by the gateway,
 * outside the shift sandbox. Anything in it that makes git run a command would
 * run past bubblewrap, where master.key and every other company are readable.
 * Each test plants one such route and checks that nothing runs.
 */
let dir: string;
let world: World;
let marker: string;
const clock = fixedClock('2026-09-22T12:00:00.000Z');
const raw = (...args: string[]) => execFileSync('git', ['-C', world.root, ...args], { stdio: 'ignore' });
const touch = () => `touch '${marker}'`;
const changeSomething = () => writeFileSync(join(world.root, 'commons', 'work.md'), `# work ${Math.random()}\n`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'riff-gittrust-'));
  world = new World(join(dir, 'world'), clock);
  world.ensure();
  marker = join(dir, 'RAN');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the gateway’s git runs nothing the world wrote', () => {
  test('a planted hook does not run when the shift is committed', () => {
    const hook = join(world.root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\n${touch()}\n`);
    chmodSync(hook, 0o755);
    changeSomething();
    assert.ok(world.git.commitAs({ id: 'juno', name: 'Juno' }, 'work'), 'the work is still committed');
    assert.ok(!existsSync(marker), 'the hook must not have run');
  });

  for (const [what, set] of [
    ['an fsmonitor', ['core.fsmonitor', `sh -c "${touch()}"`]],
    ['a clean filter', ['filter.x.clean', touch()]],
    ['an include of another config', ['include.path', '/tmp/elsewhere']],
    ['a moved worktree', ['core.worktree', '/tmp']],
  ] as const) {
    test(`a repository whose config names ${what} is refused, not run`, () => {
      raw('config', set[0], set[1]);
      writeFileSync(join(world.root, '.gitattributes'), '* filter=x\n');
      changeSomething();
      assert.throws(() => world.git.commitAs({ id: 'juno', name: 'Juno' }, 'work'),
        new RegExp(`refusing to run git.*${set[0].replace('.', '\\.')}`, 'i'));
      assert.ok(!existsSync(marker), 'nothing ran');
    });
  }

  test('a .git that is a file pointing elsewhere is refused', () => {
    // A gitdir file would aim the gateway's commits at another company's repository.
    renameSync(join(world.root, '.git'), join(dir, 'elsewhere.git'));
    writeFileSync(join(world.root, '.git'), `gitdir: ${join(dir, 'elsewhere.git')}\n`);
    changeSomething();
    assert.throws(() => world.git.commitAs({ id: 'juno', name: 'Juno' }, 'work'), /not a directory/);
  });

  test('borrowing another repository’s objects is refused', () => {
    mkdirSync(join(world.root, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(world.root, '.git', 'objects', 'info', 'alternates'), '/tmp/other/.git/objects\n');
    assert.throws(() => world.git.isDirty(), /alternates/);
  });

  test('the settings Riff and its staff actually leave behind are fine', () => {
    // What ShipIt's repository carried after two weeks of staff running git in it.
    raw('config', 'user.name', 'Riff');
    raw('config', 'branch.main.remote', 'origin');
    changeSomething();
    assert.ok(world.git.commitAs({ id: 'juno', name: 'Juno' }, 'work'));
  });
});

describe('the gateway’s git stays inside this company’s repository', () => {
  test('a repository nested in the world is not descended into', () => {
    // Its config is not the world's, and the vet never reads it. Set up with
    // the filter inert, then armed, so only the gateway's own calls could run it.
    const nested = join(world.root, 'staff', 'juno', 'tool');
    mkdirSync(nested, { recursive: true });
    const inNested = (...args: string[]) => execFileSync('git',
      ['-C', nested, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'filter.x.clean=cat', ...args], { stdio: 'ignore' });
    inNested('init', '-q');
    writeFileSync(join(nested, '.gitattributes'), '* filter=x\n');
    writeFileSync(join(nested, 'a.txt'), 'one\n');
    inNested('add', '-A');
    inNested('commit', '-qm', 'x');
    execFileSync('git', ['-C', nested, 'config', 'filter.x.clean', touch()], { stdio: 'ignore' });

    world.git.commitAs({ id: 'juno', name: 'Juno' }, 'first');
    writeFileSync(join(nested, 'a.txt'), 'two\n');           // a change only the nested filter would inspect
    world.git.isDirty();
    changeSomething();
    assert.ok(world.git.commitAs({ id: 'juno', name: 'Juno' }, 'work'), 'the world’s own work is still committed');
    assert.ok(!existsSync(marker), 'nothing in the nested repository ran');
  });

  test('a nested repository is left out whatever the case of its .git', () => {
    // The volume is case-insensitive; git takes .GIT for a repository there.
    const nested = join(world.root, 'staff', 'juno', 'odd');
    mkdirSync(join(nested, '.GIT'), { recursive: true });
    assert.deepEqual(nestedRepos(world.root), ['staff/juno/odd']);
  });

  test('a link anywhere in the metadata git touches is refused', () => {
    for (const rel of ['logs/HEAD', 'refs/heads/elsewhere']) {
      const at = join(world.root, '.git', rel);
      mkdirSync(join(at, '..'), { recursive: true });
      rmSync(at, { force: true });
      symlinkSync(join(dir, 'outside'), at);
      assert.throws(() => world.git.isDirty(), /symbolic link/, rel);
      rmSync(at, { force: true });
    }
  });

  test('a world moved aside and replaced is refused, not followed', () => {
    const root = world.root;                                   // pins the directory it opened as
    const other = join(dir, 'other-world');
    mkdirSync(join(other, 'commons'), { recursive: true });
    renameSync(root, join(dir, 'world-aside'));
    symlinkSync(other, root);
    assert.throws(() => world.root, /no longer a directory/);
    rmSync(root);
    mkdirSync(root);                                           // a real directory, but not the same one
    assert.throws(() => world.root, /was replaced/);
  });
});

describe('the file tools cannot write the world’s repository', () => {
  test('.git is outside the company, in any case', () => {
    for (const p of ['.git/hooks/pre-commit', '.git/config', '.GIT/config', '.Git/hooks/post-commit']) {
      assert.equal(classifyPath(world, 'juno', p).kind, 'outside', p);
    }
  });

  test('a file merely named like it elsewhere is still ordinary work', () => {
    assert.equal(classifyPath(world, 'juno', 'commons/.git-notes.md').kind, 'commons');
    assert.equal(classifyPath(world, 'juno', 'staff/juno/.gitignore').kind, 'own');
  });
});
