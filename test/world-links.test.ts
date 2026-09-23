import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../src/worldfs/world.ts';
import { writeWithin, readWithin, unlinkWithin } from '../src/worldfs/within.ts';
import { fixedClock } from '../src/core/clock.ts';

/**
 * The gateway writes into a world from outside every shift's view, on names a
 * shift chose, while that shift's shell can plant links. Each test plants one
 * aimed at a neighbouring company and checks the neighbour is untouched.
 */
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
      /outside the world/);
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

  test('a directory the kernel places outside is refused before anything is made in it', () => {
    // The Linux branch, which a Mac cannot reach on its own: /proc says where
    // the pinned directory really is, and here it says next door.
    mkdirSync(join(world.root, 'commons', 'x'), { recursive: true });
    const abs = join(world.root, 'commons', 'x', 'doc.md');
    const nextDoor = () => join(victim, 'staff');
    assert.throws(() => writeWithin(world.root, abs, 'obey', nextDoor), /outside the world/);
    assert.ok(!existsSync(abs));
    writeFileSync(abs, 'mine\n');
    assert.throws(() => readWithin(world.root, abs, nextDoor), /outside the world/);
    assert.throws(() => unlinkWithin(world.root, abs, nextDoor), /outside the world/);
    assert.equal(readFileSync(abs, 'utf8'), 'mine\n');
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

  test('contained, a project is removed inside the company\'s own view', () => {
    // A stand-in bwrap records its argv and runs what follows `--`.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'bwrap.argv');
    writeFileSync(join(bin, 'bwrap'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
      { mode: 0o755 });
    const path = process.env['PATH'];
    process.env['PATH'] = `${bin}:${path ?? ''}`;
    try {
      const confined = new World(world.root, clock, () => ['--ro-bind', '/', '/']);
      mkdirSync(join(world.root, 'projects', 'app', 'src'), { recursive: true });
      writeFileSync(join(world.root, 'projects', 'app', 'src', 'main.ts'), 'x\n');
      assert.equal(confined.removeProject('app'), true);
      const argv = readFileSync(log, 'utf8').trim().split('\n');
      assert.deepEqual(argv, ['--ro-bind', '/', '/', '--', 'rm', '-rf', '--', join(world.root, 'projects', 'app')]);
      assert.ok(!existsSync(join(world.root, 'projects', 'app')));
    } finally {
      process.env['PATH'] = path;
    }
  });
});
