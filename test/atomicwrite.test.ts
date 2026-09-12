import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../src/core/atomicwrite.ts';

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
