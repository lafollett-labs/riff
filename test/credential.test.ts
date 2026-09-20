import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_SECRET_NAME } from '../src/core/config.ts';

/**
 * runtimeCredentialHealth is the start preflight: it refuses a wake no runtime
 * credential can back, rather than letting a company burn shifts failing to
 * authenticate. It reads the vault the keyproxy will read, so the two agree.
 *
 * It runs against a throwaway RIFF_ROOT — it consults the install vault under
 * the installation root, and a test that reads the operator's real secrets is
 * not a test. It takes an explicit `contained` flag so the in-container path
 * can be exercised without a container; outside one it must always answer live,
 * or every host run and every test would be blocked by a vault that is empty
 * by design.
 */
let root: string;
let cred: typeof import('../src/runtime/credential.ts');
let secrets: typeof import('../src/core/secrets.ts');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'riff-cred-'));
  process.env['RIFF_ROOT'] = join(root, '.riff');
  cred = await import('../src/runtime/credential.ts');
  secrets = await import('../src/core/secrets.ts');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['RIFF_ROOT'];
});

describe('the runtime-credential preflight', () => {
  test('outside a container it never blocks, so tests and host runs are not gated', () => {
    // No credential is set, yet contained=false answers live: an operator's own
    // machine and the throwaway test installation have no vault to consult.
    assert.deepEqual(cred.runtimeCredentialHealth('shipit', false), { live: true });
  });

  test('in a container with nothing set, it refuses and names Riff Settings', () => {
    const h = cred.runtimeCredentialHealth('shipit', true);
    assert.equal(h.live, false);
    assert.match((h as { why: string }).why, /no runtime credential/);
    assert.match((h as { fix: string }).fix, /Riff Settings/);
  });

  test('an installation default token makes a company with no override live', () => {
    secrets.putInstallSecret(RUNTIME_SECRET_NAME, 'sk-ant-install-default');
    assert.deepEqual(cred.runtimeCredentialHealth('shipit', true), { live: true });
  });
});
