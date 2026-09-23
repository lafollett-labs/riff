import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, readFileSync, statSync, readdirSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../src/core/atomicwrite.ts';
import { writeConfigFile } from '../src/core/config.ts';

/**
 * The atomic writer's job is that a reader never sees a torn file and a failed
 * write never damages the one already there. The rename that guarantees it can't
 * be observed racing in a unit test, so these pin the observable contracts:
 * content round-trips, perms are exact, no temp is left behind, and a failed
 * write leaves the prior file intact.
 */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'riff-atomic-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('a whole-file write that a reader cannot catch half-done', () => {
  test('what is written is read back, and an existing file is replaced', () => {
    const p = join(dir, 'f.json');
    atomicWriteFileSync(p, 'one');
    assert.equal(readFileSync(p, 'utf8'), 'one');
    atomicWriteFileSync(p, 'two');
    assert.equal(readFileSync(p, 'utf8'), 'two');
  });

  test('a mode is applied exactly, past the umask', () => {
    const p = join(dir, 'secret');
    atomicWriteFileSync(p, 'k', 0o600);
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });

  test('no temp file is left behind after a successful write', () => {
    const p = join(dir, 'f');
    atomicWriteFileSync(p, 'x');
    assert.deepEqual(readdirSync(dir), ['f'], 'only the target should remain');
  });

  test('a failed write throws and leaves the prior file untouched, with no temp', () => {
    const p = join(dir, 'f');
    atomicWriteFileSync(p, 'good');
    // Force a failure: p is a file, so p/child has a non-directory parent and the
    // temp write itself throws — the prior file must be untouched and no temp left.
    assert.throws(() => atomicWriteFileSync(join(p, 'child'), 'nope'));
    assert.equal(readFileSync(p, 'utf8'), 'good', 'the existing file must survive a failed write');
    assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')), 'no temp file may linger');
  });
});

describe('a config.json staged where no shift can reach its temp', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['RIFF_ROOT']; process.env['RIFF_ROOT'] = dir; });
  afterEach(() => { if (saved === undefined) delete process.env['RIFF_ROOT']; else process.env['RIFF_ROOT'] = saved; });

  test('the temp is written where it is told, and a stage that is not there fails the write', () => {
    const p = join(dir, 'f');
    atomicWriteFileSync(p, 'good');
    assert.throws(() => atomicWriteFileSync(p, 'nope', undefined, join(dir, 'absent')), /ENOENT/);
    assert.equal(readFileSync(p, 'utf8'), 'good');
  });

  /** The directory each temp was renamed out of. */
  const stagedFrom = (write: () => void): string[] => {
    const from: string[] = [];
    const real = fs.renameSync;
    mock.method(fs, 'renameSync', (a: string, b: string) => { from.push(dirname(a)); real(a, b); });
    syncBuiltinESMExports();
    try { write(); } finally { mock.restoreAll(); syncBuiltinESMExports(); }
    return from;
  };

  test('a company\'s config is staged under the root, outside its home', () => {
    const home = join(dir, 'companies', 'acme');
    mkdirSync(home, { recursive: true });
    // Left wider by hand, or by a directory made before the mode was chosen.
    mkdirSync(join(dir, '.staging'), { mode: 0o755 });
    chmodSync(join(dir, '.staging'), 0o755);
    const from = stagedFrom(() => writeConfigFile(join(home, 'config.json'), { company: { name: 'Acme' } }));
    assert.deepEqual(from, [join(dir, '.staging')]);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), { company: { name: 'Acme' } });
    assert.equal(statSync(join(dir, '.staging')).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(dir, '.staging')), []);
    assert.deepEqual(readdirSync(home), ['config.json']);
  });

  test('a home that is no company\'s stays staged beside itself', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'riff-elsewhere-'));
    const deeper = join(dir, 'companies', 'a', 'b');
    mkdirSync(deeper, { recursive: true });
    try {
      for (const d of [elsewhere, join(dir, 'companies'), deeper]) {
        assert.deepEqual(stagedFrom(() => writeConfigFile(join(d, 'config.json'), {})), [d], d);
      }
      assert.ok(!existsSync(join(dir, '.staging')));
    } finally { rmSync(elsewhere, { recursive: true, force: true }); }
  });

  test('every write of a config.json goes through writeConfigFile', () => {
    // One stray atomicWriteFileSync(join(home, CONFIG_NAME), ...) and the temp
    // lands in the shift's view again, so each caller is pinned: a new one has
    // to say where it writes. transfer.ts writes into its own .transfer work
    // directory, under the root, before the company exists; secrets and
    // settings live under the root too.
    const src = join(import.meta.dirname, '..', 'src');
    const calls = (fs.readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && f !== join('core', 'atomicwrite.ts'))
      .flatMap((f) => [...readFileSync(join(src, f), 'utf8').matchAll(/atomicWriteFileSync\(([^,]*)/g)]
        .map((m) => `${f}: ${m[1]}`));
    assert.deepEqual(calls.sort(), [
      `${join('company', 'transfer.ts')}: join(work`,
      `${join('core', 'config.ts')}: path`,
      `${join('core', 'secrets.ts')}: path`,
      `${join('core', 'settings.ts')}: settingsPath()`,
    ]);
  });
});
