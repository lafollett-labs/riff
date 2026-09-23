import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync, mkdirSync, renameSync, symlinkSync,
  utimesSync, readdirSync, readFileSync } from 'node:fs';
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

  test('a nested repository the world ignores does not stop the shift being committed', () => {
    // Excluding it by pathspec made `git add` refuse: a pathspec naming an
    // ignored path is an error. ShipIt ignores staff/*/notes/wt-*, and from the
    // 00:42 deploy on 2026-09-22 every shift's commit threw on Jack's leftover
    // worktree — no journal commit, no agent.slept, for the whole team.
    const nested = join(world.root, 'staff', 'juno', 'notes', 'wt-old');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['-C', nested, 'init', '-q'], { stdio: 'ignore' });
    writeFileSync(join(world.root, '.gitignore'), '.DS_Store\nstaff/*/notes/wt-*\n');
    changeSomething();
    assert.ok(world.git.commitAs({ id: 'juno', name: 'Juno' }, 'work'));
    assert.equal(world.git.isDirty(), false);
  });

  test('a nested repository named like pathspec magic keeps its exclusion', () => {
    const nested = join(world.root, 'staff', 'juno', ':(glob)*');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['-C', nested, 'init', '-q'], { stdio: 'ignore' });
    writeFileSync(join(nested, 'inside.md'), 'not the world\'s\n');
    changeSomething();
    world.git.commitAs({ id: 'juno', name: 'Juno' }, 'work');
    const tracked = execFileSync('git', ['-C', world.root, 'ls-files'], { encoding: 'utf8' });
    assert.doesNotMatch(tracked, /inside\.md|\(glob\)/);
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

  test('pruning cannot be pointed at a directory outside the repository', () => {
    // Prune deletes a stale .git/worktrees/<name> recursively, and git opens a
    // linked one as the directory it points at — from the gateway, outside the
    // sandbox. A planted link is refused before anything is removed.
    const victim = join(dir, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.md'), 'still here\n');
    mkdirSync(join(world.root, '.git', 'worktrees'), { recursive: true });
    symlinkSync(victim, join(world.root, '.git', 'worktrees', 'evil'));
    assert.throws(() => world.git.pruneWorktrees(), /worktrees\/evil is a symbolic link/);
    assert.ok(existsSync(join(victim, 'keep.md')));
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

describe('worktrees the staff removed are forgotten on their behalf', () => {
  // The sandbox mounts each .git/worktrees/<name> read-only, so a shift's own
  // `git worktree prune` answers EBUSY and every removed worktree left its entry.
  const add = (name: string) => {
    changeSomething();
    world.git.commitAs({ id: 'ada', name: 'Ada' }, 'work');
    const at = join(dir, 'wt', name);
    raw('worktree', 'add', '-q', '--detach', at);
    return at;
  };
  const entries = () => readdirSync(join(world.root, '.git', 'worktrees')).sort();
  const age = (name: string, hours: number) => {
    const t = new Date(Date.now() - hours * 3_600_000);
    // What git reads the age from, for an entry whose checkout is gone.
    utimesSync(join(world.root, '.git', 'worktrees', name, 'index'), t, t);
  };

  test('a gone checkout is pruned, a live one and a fresh one are kept', () => {
    const gone = add('gone');
    add('live');
    const fresh = add('fresh');
    rmSync(gone, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
    age('gone', 3);
    age('live', 3);
    // `fresh` may be a live checkout in a shift's private /tmp, which reads as
    // gone from the gateway; nothing younger than a shift can live is touched.
    world.git.pruneWorktrees();
    assert.deepEqual(entries(), ['fresh', 'live']);
  });
});

describe('the gateway prunes inside the company\'s own view', () => {
  test('git runs under bwrap with the confinement it was given, and still prunes', () => {
    // A stand-in bwrap on PATH records its argv and runs what follows `--`,
    // since bubblewrap is Linux-only and this suite runs anywhere.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'bwrap.argv');
    writeFileSync(join(bin, 'bwrap'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
      { mode: 0o755 });
    const path = process.env['PATH'];
    process.env['PATH'] = `${bin}:${path ?? ''}`;
    try {
      changeSomething();
      world.git.commitAs({ id: 'ada', name: 'Ada' }, 'work');
      const at = join(dir, 'wt', 'gone');
      raw('worktree', 'add', '-q', '--detach', at);
      rmSync(at, { recursive: true, force: true });
      const t = new Date(Date.now() - 3 * 3_600_000);
      utimesSync(join(world.root, '.git', 'worktrees', 'gone', 'index'), t, t);
      world.git.pruneWorktrees(['--ro-bind', '/', '/']);
      const argv = readFileSync(log, 'utf8').split('\n');
      assert.deepEqual(argv.slice(0, 4), ['--ro-bind', '/', '/', '--']);
      assert.equal(argv[4], 'git');
      assert.ok(argv.includes('prune'));
      assert.ok(!existsSync(join(world.root, '.git', 'worktrees', 'gone')));
    } finally {
      process.env['PATH'] = path;
    }
  });
});
