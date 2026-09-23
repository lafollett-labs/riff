import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../src/worldfs/world.ts';
import { COMMONS_DEPTH } from '../src/policy/rules.ts';
import { writeWithin, readWithin, unlinkWithin, mkdirWithin, renameWithin, listWithin } from '../src/worldfs/within.ts';
import { fixedClock } from '../src/core/clock.ts';

/**
 * The gateway writes into a world from outside every shift's view, on names a
 * shift chose, while that shift's shell can plant links. Each test plants one
 * aimed at a neighbouring company and checks the neighbour is untouched.
 */
/**
 * bwrap is Linux-only and a stand-in on PATH cannot run from a noexec /tmp
 * (the factory's), so the call is intercepted instead: record the argv, then
 * run what follows `--` unconfined.
 */
const underStandInBwrap = <T>(fn: (argvs: string[][]) => T): T => {
  const argvs: string[][] = [];
  const real = cp.execFileSync;
  mock.method(cp, 'execFileSync', ((cmd: string, args: string[], opts: object) => {
    if (cmd !== 'bwrap') return real(cmd, args, opts);
    argvs.push(args);
    const at = args.indexOf('--');
    return real(args[at + 1]!, args.slice(at + 2), opts);
  }) as typeof real);
  syncBuiltinESMExports();
  try { return fn(argvs); } finally { mock.restoreAll(); syncBuiltinESMExports(); }
};

let dir: string;
let world: World;
let victim: string;
const clock = fixedClock('2026-09-22T12:00:00.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'riff-links-'));
  world = new World(join(dir, 'acme', 'world'), clock);
  world.ensure();
  world.ensureStaff('mallory');
  victim = join(dir, 'other', 'world');
  mkdirSync(join(victim, 'staff', 'ceo'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a link a shift planted does not carry a gateway write out of its world', () => {
  test('a link to a file not made yet is refused, and nothing is made there', () => {
    const planted = join(victim, 'staff', 'ceo', 'memory.md');
    symlinkSync(planted, join(world.root, 'staff', 'mallory', 'drafts', '2026-09-22-hi.md'));
    assert.throws(() => world.writeDoc('staff/mallory/drafts/2026-09-22-hi.md', { data: {}, body: 'obey' }),
      /escapes the world/);
    assert.ok(!existsSync(planted));
  });

  test('a link to a file that exists is refused, and the file is unchanged', () => {
    const planted = join(victim, 'staff', 'ceo', 'memory.md');
    writeFileSync(planted, 'mine\n');
    symlinkSync(planted, join(world.root, 'staff', 'mallory', 'drafts', 'x.md'));
    assert.throws(() => world.writeDoc('staff/mallory/drafts/x.md', { data: {}, body: 'obey' }));
    assert.equal(readFileSync(planted, 'utf8'), 'mine\n');
  });

  test('a directory swapped for a link under a checked path is caught at the write', () => {
    // What a race between path() and the open looks like from writeWithin.
    symlinkSync(join(victim, 'staff'), join(world.root, 'swapped'));
    assert.throws(() => writeWithin(world.root, join(world.root, 'swapped', 'ceo', 'memory.md'), 'obey'),
      /link/);
    assert.ok(!existsSync(join(victim, 'staff', 'ceo', 'memory.md')));
  });

  test('a FIFO at the name is refused on write rather than holding the gateway', () => {
    const fifo = join(world.root, 'staff', 'mallory', 'notes', 'wait.md');
    execFileSync('mkfifo', [fifo]);
    assert.throws(() => world.writeDoc('staff/mallory/notes/wait.md', { data: {}, body: 'x' }));
  });

  test('retiring a project through a linked projects/ deletes nothing next door', () => {
    mkdirSync(join(victim, 'app'), { recursive: true });
    writeFileSync(join(victim, 'app', 'main.ts'), 'code\n');
    symlinkSync(victim, join(world.root, 'projects'));
    assert.throws(() => world.removeProject('app'), /escapes the world/);
    assert.ok(existsSync(join(victim, 'app', 'main.ts')));
  });

  test('a staff directory that is a link gets no folders made through it', () => {
    symlinkSync(join(victim, 'staff', 'ceo'), join(world.root, 'staff', 'eve'));
    assert.throws(() => world.ensureStaff('eve'), /escapes the world/);
    assert.ok(!existsSync(join(victim, 'staff', 'ceo', 'journal')));
  });

  test('an attachment does not append to a .gitignore that links out', () => {
    const config = join(dir, 'other', 'config.json');
    writeFileSync(config, '{"company":{"name":"Other"}}\n');
    rmSync(join(world.root, '.gitignore'), { force: true });
    symlinkSync(config, join(world.root, '.gitignore'));
    assert.throws(() => world.writeAttachment(Buffer.from('png'), 'png'));
    assert.equal(readFileSync(config, 'utf8'), '{"company":{"name":"Other"}}\n');
  });

  test('no step on the way may be a link, even one that stays inside the world', () => {
    // What a swap after a check looks like to the walk: a folder that is now a
    // link. Nothing is made, read, listed, renamed or removed through it.
    mkdirSync(join(world.root, 'commons', 'real'), { recursive: true });
    writeFileSync(join(world.root, 'commons', 'real', 'doc.md'), 'mine\n');
    symlinkSync(join(world.root, 'commons', 'real'), join(world.root, 'commons', 'via'));
    const via = (name: string) => join(world.root, 'commons', 'via', name);
    assert.throws(() => writeWithin(world.root, via('new.md'), 'x'), /link/);
    assert.throws(() => mkdirWithin(world.root, via('sub')), /link/);
    assert.throws(() => unlinkWithin(world.root, via('doc.md')), /link/);
    assert.throws(() => renameWithin(world.root, via('doc.md'), join(world.root, 'commons', 'moved.md')), /link/);
    assert.equal(readWithin(world.root, via('doc.md')), null);
    assert.equal(listWithin(world.root, join(world.root, 'commons', 'via')), null);
    assert.equal(readFileSync(join(world.root, 'commons', 'real', 'doc.md'), 'utf8'), 'mine\n');
    assert.ok(!existsSync(join(world.root, 'commons', 'real', 'new.md')));
    assert.ok(!existsSync(join(world.root, 'commons', 'real', 'sub')));
  });

  test('folders a write needs are not made through a link next door', () => {
    symlinkSync(join(victim, 'staff'), join(world.root, 'staff', 'eve'));
    assert.throws(() => writeWithin(world.root, join(world.root, 'staff', 'eve', 'fresh', 'deeper', 'x.md'), 'x'));
    assert.ok(!existsSync(join(victim, 'staff', 'fresh')));
  });

  test('a seat is renamed within the world, never through a linked staff folder', () => {
    const acme = join(world.root, 'staff');
    mkdirSync(join(acme, 'old'), { recursive: true });
    renameWithin(world.root, join(acme, 'old'), join(acme, 'new'));
    assert.ok(existsSync(join(acme, 'new')) && !existsSync(join(acme, 'old')));
    mkdirSync(join(victim, 'staff', 'ceo'), { recursive: true });
    rmSync(acme, { recursive: true, force: true });
    symlinkSync(join(victim, 'staff'), acme);
    assert.throws(() => renameWithin(world.root, join(acme, 'ceo'), join(acme, 'mallory')), /link/);
    assert.ok(existsSync(join(victim, 'staff', 'ceo')));
  });

  test('a FIFO at a document\'s name reads as nothing rather than holding the gateway', () => {
    execFileSync('mkfifo', [join(world.root, 'staff', 'mallory', 'journal', '2026-09-22.md')]);
    assert.equal(world.readDoc('staff/mallory/journal/2026-09-22.md'), null);
  });

  test('a document that is a link is not read through', () => {
    writeFileSync(join(victim, 'staff', 'ceo', 'memory.md'), 'secret plans\n');
    symlinkSync(join(victim, 'staff', 'ceo', 'memory.md'), join(world.root, 'staff', 'mallory', 'notes', 'n.md'));
    assert.throws(() => world.readDoc('staff/mallory/notes/n.md'));
    // Pointing within the world, it passes path() and meets O_NOFOLLOW: not a
    // document, rather than a throw that fails every wake reading it.
    writeFileSync(join(world.root, 'staff', 'mallory', 'notes', 'real.md'), 'mine\n');
    symlinkSync('notes/real.md', join(world.root, 'staff', 'mallory', 'memory.md'));
    assert.equal(world.readDoc('staff/mallory/memory.md'), null);
    assert.equal(world.readText('staff/mallory/memory.md'), null);
  });

  test('a top-level folder that is a link lists nothing', () => {
    mkdirSync(join(victim, 'projects', 'secret-acquisition'), { recursive: true });
    mkdirSync(join(victim, 'commons'), { recursive: true });
    writeFileSync(join(victim, 'commons', 'merger-plan.md'), 'x\n');
    rmSync(join(world.root, 'commons'), { recursive: true, force: true });
    symlinkSync(join(victim, 'commons'), join(world.root, 'commons'));
    symlinkSync(join(victim, 'projects'), join(world.root, 'projects'));
    assert.deepEqual(world.listCommons(), []);
    assert.deepEqual(world.listProjects(), []);
    rmSync(join(world.root, 'staff'), { recursive: true, force: true });
    symlinkSync(join(victim, 'staff'), join(world.root, 'staff'));
    assert.deepEqual(world.listDrafts('ceo'), []);
    const indexed: string[] = [];
    assert.equal(world.reindexNotes({ clearNoteIndex() {}, indexNote(n: { path: string }) { indexed.push(n.path); } } as never), 0);
  });

  test('removing a document that links out is refused, and what it names is kept', () => {
    const planted = join(world.root, 'commons', 'gone.md');
    mkdirSync(join(world.root, 'commons'), { recursive: true });
    writeFileSync(join(victim, 'keep.md'), 'keep\n');
    symlinkSync(join(world.root, '..', '..', 'other', 'world', 'keep.md'), planted);
    // path() refuses a link out, so the remove never gets that far.
    assert.throws(() => world.remove('commons/gone.md'));
    assert.equal(readFileSync(join(victim, 'keep.md'), 'utf8'), 'keep\n');
  });

  test('listings do not walk a folder that is a link', () => {
    mkdirSync(join(victim, 'staff', 'ceo', 'notes'), { recursive: true });
    writeFileSync(join(victim, 'staff', 'ceo', 'notes', 'n.md'), '---\ntitle: theirs\n---\nx\n');
    symlinkSync(join(victim, 'staff', 'ceo'), join(world.root, 'staff', 'eve'));
    mkdirSync(join(victim, 'deep'), { recursive: true });
    writeFileSync(join(victim, 'deep', 'd.md'), 'x\n');
    symlinkSync(join(victim, 'deep'), join(world.root, 'commons', 'deep'));
    assert.deepEqual(world.listCommons().filter((p) => p.includes('deep')), []);
    const indexed: string[] = [];
    world.reindexNotes({ clearNoteIndex() {}, indexNote(n: { path: string }) { indexed.push(n.path); } } as never);
    assert.deepEqual(indexed.filter((p) => p.includes('eve')), []);
  });

  test('a deep commons tree costs one step per folder, and stops at the cap', () => {
    // Each level used to re-walk from the root: a tree d deep cost d²/2 opens on
    // the loop every company shares, and ten thousand levels would have stalled
    // it for minutes.
    const levels = Array.from({ length: 50 }, () => 'a');
    mkdirSync(join(world.root, 'commons', ...levels), { recursive: true });
    writeFileSync(join(world.root, 'commons', 'a', 'a', 'near.md'), 'x');
    writeFileSync(join(world.root, 'commons', ...levels, 'far.md'), 'x');
    let steps = 0;
    for (const f of ['openSync', 'lstatSync'] as const) {
      const real = fs[f] as (...a: unknown[]) => unknown;
      mock.method(fs, f, (...a: unknown[]) => { steps++; return real(...a); });
    }
    syncBuiltinESMExports();
    let listed: string[];
    try { listed = world.listCommons(); } finally { mock.restoreAll(); syncBuiltinESMExports(); }
    assert.deepEqual(listed, ['commons/a/a/near.md']);
    assert.ok(steps < 4 * COMMONS_DEPTH, `${steps} opens and lstats for a ${levels.length}-deep tree`);
  });

  test('contained, a project is removed inside the company\'s own view', () => {
    const argvs = underStandInBwrap((argvs) => {
      const confined = new World(world.root, clock, () => ['--ro-bind', '/', '/']);
      mkdirSync(join(world.root, 'projects', 'app', 'src'), { recursive: true });
      writeFileSync(join(world.root, 'projects', 'app', 'src', 'main.ts'), 'x\n');
      assert.equal(confined.removeProject('app'), true);
      return argvs;
    });
    assert.deepEqual(argvs, [['--ro-bind', '/', '/', '--', 'rm', '-rf', '--', join(world.root, 'projects', 'app')]]);
    assert.ok(!existsSync(join(world.root, 'projects', 'app')));
  });
});
