import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The store runs against a throwaway RIFF_ROOT, because it writes the master
 * key and every vault under the installation root, and a test that can read or
 * overwrite the operator's real secrets is not a test. The module reads
 * installRoot() at call time, so setting the env var in-process is enough — no
 * subprocess, unlike registry, which snapshots at import.
 */
let root: string;
let secrets: typeof import('../src/core/secrets.ts');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'riff-secrets-'));
  process.env['RIFF_ROOT'] = join(root, '.riff');
  secrets = await import('../src/core/secrets.ts');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['RIFF_ROOT'];
});

describe('a secret survives a round trip and nothing else can', () => {
  test('what goes in comes back out', () => {
    secrets.putSecret('shipit', 'OPENROUTER_API_KEY', 'sk-or-v1-abc123');
    assert.equal(secrets.getSecret('shipit', 'OPENROUTER_API_KEY'), 'sk-or-v1-abc123');
  });

  test('a second write replaces the first', () => {
    secrets.putSecret('shipit', 'K', 'one');
    secrets.putSecret('shipit', 'K', 'two');
    assert.equal(secrets.getSecret('shipit', 'K'), 'two');
  });

  test('an absent secret is null, not an error', () => {
    assert.equal(secrets.getSecret('shipit', 'NOPE'), null);
  });
});

describe('names are separable from values, which is the whole point', () => {
  test('listing returns names, sorted, and never a value', () => {
    secrets.putSecret('shipit', 'BETA', 'v2');
    secrets.putSecret('shipit', 'ALPHA', 'v1');
    const names = secrets.listSecretNames('shipit');
    assert.deepEqual(names, ['ALPHA', 'BETA']);
    assert.ok(!JSON.stringify(names).includes('v1'));
    assert.ok(!JSON.stringify(names).includes('v2'));
  });

  test('an empty vault lists nothing', () => {
    assert.deepEqual(secrets.listSecretNames('shipit'), []);
  });
});

describe('one company cannot reach another', () => {
  test("a secret in one company is invisible to the other", () => {
    secrets.putSecret('shipit', 'KEY', 'shipit-secret');
    secrets.putSecret('fathom', 'KEY', 'fathom-secret');
    assert.equal(secrets.getSecret('shipit', 'KEY'), 'shipit-secret');
    assert.equal(secrets.getSecret('fathom', 'KEY'), 'fathom-secret');
    assert.deepEqual(secrets.listSecretNames('shipit'), ['KEY']);
  });

  test("one company's data key does not decrypt another's secret", () => {
    secrets.putSecret('a', 'K', 'a-value');
    secrets.putSecret('b', 'K', 'b-value');
    // Splice company b's wrapped DEK into company a's vault. Under a per-company
    // key this must fail to decrypt a's secret rather than quietly return it.
    const aPath = join(process.env['RIFF_ROOT']!, 'secrets', 'a.vault.json');
    const bPath = join(process.env['RIFF_ROOT']!, 'secrets', 'b.vault.json');
    const a = JSON.parse(readFileSync(aPath, 'utf8'));
    const b = JSON.parse(readFileSync(bPath, 'utf8'));
    a.dek = b.dek;
    writeFileSync(aPath, JSON.stringify(a));
    assert.throws(() => secrets.getSecret('a', 'K'));
  });
});

describe('the file on disk gives nothing away', () => {
  test('the plaintext is not in the vault file', () => {
    secrets.putSecret('shipit', 'K', 'super-secret-value');
    const raw = readFileSync(join(process.env['RIFF_ROOT']!, 'secrets', 'shipit.vault.json'), 'utf8');
    assert.ok(!raw.includes('super-secret-value'));
  });

  test('a tampered ciphertext is a decrypt error, not wrong bytes', () => {
    secrets.putSecret('shipit', 'K', 'value');
    const path = join(process.env['RIFF_ROOT']!, 'secrets', 'shipit.vault.json');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    // Flip a byte of the ciphertext; GCM's tag must catch it.
    const ct = Buffer.from(file.secrets.K.ct, 'base64');
    ct.writeUInt8(ct.readUInt8(0) ^ 0xff, 0);
    file.secrets.K.ct = ct.toString('base64');
    writeFileSync(path, JSON.stringify(file));
    assert.throws(() => secrets.getSecret('shipit', 'K'));
  });
});

describe('the master key is protected and not silently replaced', () => {
  test('it is written 0600', () => {
    secrets.putSecret('shipit', 'K', 'v');
    const mode = statSync(secrets.masterKeyPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test('it persists, so a secret written now reads back after a reload', () => {
    secrets.putSecret('shipit', 'K', 'v');
    const key1 = readFileSync(secrets.masterKeyPath(), 'utf8');
    secrets.putSecret('shipit', 'K2', 'v2');
    const key2 = readFileSync(secrets.masterKeyPath(), 'utf8');
    assert.equal(key1, key2);
  });

  test('a malformed master key is refused, not overwritten', () => {
    secrets.putSecret('shipit', 'K', 'v'); // creates the key + a vault
    writeFileSync(secrets.masterKeyPath(), 'dG9vLXNob3J0\n'); // "too-short", 9 bytes
    assert.throws(() => secrets.getSecret('shipit', 'K'), /malformed|bytes/);
  });
});

describe('bad input is refused at the door', () => {
  test('an empty value is refused', () => {
    assert.throws(() => secrets.putSecret('shipit', 'K', ''), /empty/);
  });

  test('a name that is not an env identifier is refused', () => {
    assert.throws(() => secrets.putSecret('shipit', 'has-dash', 'v'), /identifier/);
    assert.throws(() => secrets.putSecret('shipit', '1LEADING', 'v'), /identifier/);
    assert.throws(() => secrets.putSecret('shipit', 'has space', 'v'), /identifier/);
  });
});

describe('removal', () => {
  test('a deleted secret is gone and reports that it was there', () => {
    secrets.putSecret('shipit', 'K', 'v');
    assert.equal(secrets.deleteSecret('shipit', 'K'), true);
    assert.equal(secrets.getSecret('shipit', 'K'), null);
  });

  test('deleting an absent secret reports false, not an error', () => {
    assert.equal(secrets.deleteSecret('shipit', 'K'), false);
  });

  test('dropping a vault removes the file entirely', () => {
    secrets.putSecret('shipit', 'K', 'v');
    const path = join(process.env['RIFF_ROOT']!, 'secrets', 'shipit.vault.json');
    assert.ok(existsSync(path));
    secrets.dropVault('shipit');
    assert.ok(!existsSync(path));
  });
});

describe('the secrets directory is owner-only', () => {
  test('the store directory is 0700, not world-listable', () => {
    secrets.putSecret('shipit', 'K', 'v');
    const mode = statSync(join(process.env['RIFF_ROOT']!, 'secrets')).mode & 0o777;
    assert.equal(mode, 0o700);
  });
});

describe('the installation-level vault holds the runtime default, separately', () => {
  test('an install secret round-trips', () => {
    secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'sk-ant-install');
    assert.equal(secrets.getInstallSecret('RIFF_RUNTIME_TOKEN'), 'sk-ant-install');
    assert.equal(secrets.hasInstallSecret('RIFF_RUNTIME_TOKEN'), true);
  });

  test('an absent install secret is null / false, not an error', () => {
    assert.equal(secrets.getInstallSecret('NOPE'), null);
    assert.equal(secrets.hasInstallSecret('NOPE'), false);
  });

  test('it lives at a fixed path, not a company slug, and does not cross with one', () => {
    secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'install-default');
    secrets.putSecret('shipit', 'RIFF_RUNTIME_TOKEN', 'shipit-own');
    // Same name, two different vaults, two different values.
    assert.equal(secrets.getInstallSecret('RIFF_RUNTIME_TOKEN'), 'install-default');
    assert.equal(secrets.getSecret('shipit', 'RIFF_RUNTIME_TOKEN'), 'shipit-own');
    assert.ok(existsSync(join(process.env['RIFF_ROOT']!, 'secrets', 'install.vault.json')));
  });

  test('its plaintext is not on disk', () => {
    secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'super-secret-default');
    const raw = readFileSync(join(process.env['RIFF_ROOT']!, 'secrets', 'install.vault.json'), 'utf8');
    assert.ok(!raw.includes('super-secret-default'));
  });

  test('deleting an install secret reports whether it was there', () => {
    secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'v');
    assert.equal(secrets.deleteInstallSecret('RIFF_RUNTIME_TOKEN'), true);
    assert.equal(secrets.getInstallSecret('RIFF_RUNTIME_TOKEN'), null);
    assert.equal(secrets.deleteInstallSecret('RIFF_RUNTIME_TOKEN'), false);
  });
});

describe('hasSecret answers presence without reading the value', () => {
  test('true only when the named secret is stored', () => {
    secrets.putSecret('shipit', 'RIFF_RUNTIME_TOKEN', 'v');
    assert.equal(secrets.hasSecret('shipit', 'RIFF_RUNTIME_TOKEN'), true);
    assert.equal(secrets.hasSecret('shipit', 'MISSING'), false);
    assert.equal(secrets.hasSecret('nobody', 'RIFF_RUNTIME_TOKEN'), false);
  });
});
