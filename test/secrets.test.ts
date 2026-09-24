import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, createCipheriv } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The store runs against a throwaway RIFF_ROOT, because it writes every vault
 * under the installation root and the vault key beside it, and a test that can read or
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
  delete process.env['RIFF_VAULT_PUBLIC_FROM'];
});

describe('a secret survives a round trip and nothing else can', () => {
  test('what goes in comes back out', () => {
    secrets.putSecret('shipit', 'OPENROUTER_API_KEY', 'sk-or-v1-abc123', []);
    assert.equal(secrets.getSecret('shipit', 'OPENROUTER_API_KEY'), 'sk-or-v1-abc123');
  });

  test('a second write replaces the first', () => {
    secrets.putSecret('shipit', 'K', 'one', []);
    secrets.putSecret('shipit', 'K', 'two', []);
    assert.equal(secrets.getSecret('shipit', 'K'), 'two');
  });

  test('an absent secret is null, not an error', () => {
    assert.equal(secrets.getSecret('shipit', 'NOPE'), null);
  });
});

describe('names are separable from values, which is the whole point', () => {
  test('listing returns names, sorted, and never a value', () => {
    secrets.putSecret('shipit', 'BETA', 'v2', []);
    secrets.putSecret('shipit', 'ALPHA', 'v1', []);
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
    secrets.putSecret('shipit', 'KEY', 'shipit-secret', []);
    secrets.putSecret('fathom', 'KEY', 'fathom-secret', []);
    assert.equal(secrets.getSecret('shipit', 'KEY'), 'shipit-secret');
    assert.equal(secrets.getSecret('fathom', 'KEY'), 'fathom-secret');
    assert.deepEqual(secrets.listSecretNames('shipit'), ['KEY']);
  });

  test("a sealed value copied into another company's vault, or under another name, does not open", () => {
    // One vault key seals every company's secrets, so what keeps them apart is
    // the vault and the name bound into each sealing.
    secrets.putSecret('a', 'K', 'a-value', []);
    secrets.putSecret('b', 'K', 'b-value', []);
    const aPath = join(process.env['RIFF_ROOT']!, 'secrets', 'a.vault.json');
    const bPath = join(process.env['RIFF_ROOT']!, 'secrets', 'b.vault.json');
    const a = JSON.parse(readFileSync(aPath, 'utf8'));
    const b = JSON.parse(readFileSync(bPath, 'utf8'));
    b.secrets.K = a.secrets.K;
    b.secrets.OTHER = a.secrets.K;
    writeFileSync(bPath, JSON.stringify(b));
    assert.throws(() => secrets.getSecret('b', 'K'));
    assert.throws(() => secrets.getSecret('b', 'OTHER'));
    assert.equal(secrets.getSecret('a', 'K'), 'a-value');
  });
});

describe('the file on disk gives nothing away', () => {
  test('the plaintext is not in the vault file', () => {
    secrets.putSecret('shipit', 'K', 'super-secret-value', []);
    const raw = readFileSync(join(process.env['RIFF_ROOT']!, 'secrets', 'shipit.vault.json'), 'utf8');
    assert.ok(!raw.includes('super-secret-value'));
  });

  test('a tampered ciphertext is a decrypt error, not wrong bytes', () => {
    secrets.putSecret('shipit', 'K', 'value', []);
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

describe('the vault key lives outside the installation, and only its holder opens a vault', () => {
  const keyPath = () => join(secrets.vaultKeysDir(), 'vault.key');

  test('it sits beside the installation, not in it, 0600 in a 0700 folder', () => {
    secrets.putSecret('shipit', 'K', 'v', []);
    assert.equal(secrets.vaultKeysDir(), join(root, '.riff-keys'));
    assert.equal(statSync(keyPath()).mode & 0o777, 0o600);
    assert.equal(statSync(secrets.vaultKeysDir()).mode & 0o777, 0o700);
    assert.ok(!existsSync(secrets.masterKeyPath()), 'nothing makes a master.key any more');
  });

  test('it persists, and a damaged one is refused rather than replaced', () => {
    secrets.putSecret('shipit', 'K', 'v', []);
    const before = readFileSync(keyPath(), 'utf8');
    secrets.putSecret('shipit', 'K2', 'v2', []);
    assert.equal(readFileSync(keyPath(), 'utf8'), before);
    writeFileSync(keyPath(), 'not a key\n');
    assert.throws(() => secrets.getSecret('shipit', 'K'));
    assert.equal(readFileSync(keyPath(), 'utf8'), 'not a key\n', 'not overwritten');
  });

  test('a process that only seals cannot open, and cannot make a key of its own', async () => {
    secrets.putSecret('shipit', 'K', 'v', []);
    process.env['RIFF_VAULT_PUBLIC_FROM'] = 'http://127.0.0.1:9';
    assert.throws(() => secrets.getSecret('shipit', 'K'), /only seals/);
    assert.throws(() => secrets.putSecret('shipit', 'K3', 'v', []), /not been fetched/);
  });

  test('a lost key is refused, not replaced, while vaults are sealed to it', () => {
    // A wrong mount or a restore without the key archive: a fresh key would
    // open none of them, one failed secret at a time.
    secrets.putSecret('shipit', 'K', 'v', []);
    rmSync(keyPath());
    assert.throws(() => secrets.loadOrCreateVaultKey(), /restore it from/);
    assert.ok(!existsSync(keyPath()));
  });

  test('a value sealed to another key says so', () => {
    secrets.putSecret('shipit', 'K', 'v', []);
    rmSync(keyPath());
    rmSync(join(process.env['RIFF_ROOT']!, 'secrets', 'shipit.vault.json'));
    secrets.loadOrCreateVaultKey();
    secrets.putSecret('other', 'K', 'v', []);
    const other = join(process.env['RIFF_ROOT']!, 'secrets', 'other.vault.json');
    const f = JSON.parse(readFileSync(other, 'utf8'));
    f.secrets.K.kid = 'not-this-key';
    writeFileSync(other, JSON.stringify(f));
    assert.throws(() => secrets.getSecret('other', 'K'), /different vault key/);
  });

  test('where a value may go is sealed with it, and cannot be edited on disk', () => {
    const to = [{ origin: 'https://openrouter.ai', header: 'authorization', scheme: 'Bearer' }];
    secrets.putSecret('shipit', 'K', 'v', to);
    assert.deepEqual(secrets.openSecret('shipit', 'K'), { value: 'v', to });
    assert.deepEqual(secrets.secretBoundTo('shipit', 'K'), to);
    const path = join(process.env['RIFF_ROOT']!, 'secrets', 'shipit.vault.json');
    const f = JSON.parse(readFileSync(path, 'utf8'));
    f.secrets.K.to.push({ origin: 'https://evil.example', header: 'authorization', scheme: 'Bearer' });
    writeFileSync(path, JSON.stringify(f));
    assert.throws(() => secrets.openSecret('shipit', 'K'));
  });
});

describe('vaults under the old master.key move across, once', () => {
  // A vault as it was written before public-key sealing: a company data key
  // wrapped under master.key, each value under the data key.
  const oldSeal = (key: Buffer, plaintext: Buffer) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
  };
  const writeOld = (file: string, values: Record<string, string>, master: Buffer) => {
    const dek = randomBytes(32);
    const dir = join(process.env['RIFF_ROOT']!, 'secrets');
    mkdirSync(dir, { recursive: true });
    const out = { v: 1, dek: oldSeal(master, dek), secrets: {} as Record<string, unknown> };
    for (const [k, v] of Object.entries(values)) out.secrets[k] = oldSeal(dek, Buffer.from(v));
    writeFileSync(join(dir, file), JSON.stringify(out));
  };

  test('every secret reads the same after, bound to where it goes, and master.key is gone', async () => {
    const master = randomBytes(32);
    mkdirSync(process.env['RIFF_ROOT']!, { recursive: true });
    writeFileSync(secrets.masterKeyPath(), master.toString('base64') + '\n');
    writeOld('shipit.vault.json', { OPENROUTER: 'sk-or', ANTHROPIC: 'sk-ant' }, master);
    writeOld('install.vault.json', { RIFF_RUNTIME_TOKEN: 'oauth-tok' }, master);
    assert.equal(secrets.getSecret('shipit', 'OPENROUTER'), 'sk-or', 'still readable before the move');

    const where = (company: string | null, name: string) =>
      [{ origin: `https://${company ?? 'install'}.example`, header: 'authorization', scheme: name === 'ANTHROPIC' ? '' : 'Bearer' }];
    assert.deepEqual(await secrets.migrateVaults(where, secrets.verifyCanary), { vaults: 2, secrets: 3, failed: [] });
    assert.ok(!existsSync(secrets.masterKeyPath()));
    assert.deepEqual(secrets.openSecret('shipit', 'OPENROUTER'), { value: 'sk-or', to: where('shipit', 'OPENROUTER') });
    assert.equal(secrets.getSecret('shipit', 'ANTHROPIC'), 'sk-ant');
    assert.deepEqual(secrets.openInstallSecret('RIFF_RUNTIME_TOKEN'), { value: 'oauth-tok', to: where(null, 'RIFF_RUNTIME_TOKEN') });
    assert.ok(!existsSync(join(process.env['RIFF_ROOT']!, 'secrets', 'install.vault.json')), 'moved to a name no company can take');
    const raw = readFileSync(join(process.env['RIFF_ROOT']!, 'secrets', 'shipit.vault.json'), 'utf8');
    assert.equal(JSON.parse(raw).v, 2);
    assert.ok(!raw.includes('"dek"'));
    assert.equal(await secrets.migrateVaults(where, secrets.verifyCanary), null, 'nothing left to move');
  });

  test('master.key stays if the key holder cannot open what was sealed', async () => {
    const master = randomBytes(32);
    mkdirSync(process.env['RIFF_ROOT']!, { recursive: true });
    writeFileSync(secrets.masterKeyPath(), master.toString('base64') + '\n');
    writeOld('shipit.vault.json', { K: 'v' }, master);
    const path = join(process.env['RIFF_ROOT']!, 'secrets', 'shipit.vault.json');
    const before = readFileSync(path, 'utf8');
    await assert.rejects(secrets.migrateVaults(() => [], async () => 'wrong'), /nothing was moved/);
    assert.ok(existsSync(secrets.masterKeyPath()));
    assert.equal(readFileSync(path, 'utf8'), before, 'checked before anything was rewritten');
  });

  test('a token set after a partial move survives the next boot', async () => {
    const master = randomBytes(32);
    mkdirSync(process.env['RIFF_ROOT']!, { recursive: true });
    writeFileSync(secrets.masterKeyPath(), master.toString('base64') + '\n');
    writeOld('install.vault.json', { RIFF_RUNTIME_TOKEN: 'OLD-TOKEN' }, master);
    writeFileSync(join(process.env['RIFF_ROOT']!, 'secrets', 'bad.vault.json'), '{"v":1,"dek":{"iv":"","ct":"","tag":""},"secrets":{}}');
    assert.deepEqual((await secrets.migrateVaults(() => [], secrets.verifyCanary))!.failed, ['bad.vault.json']);
    secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'NEW-TOKEN', []);
    await secrets.migrateVaults(() => [], secrets.verifyCanary);
    assert.equal(secrets.getInstallSecret('RIFF_RUNTIME_TOKEN'), 'NEW-TOKEN');
  });

  test('while the old install vault has not moved, a new token is refused rather than later overwritten', async () => {
    const master = randomBytes(32);
    mkdirSync(process.env['RIFF_ROOT']!, { recursive: true });
    writeFileSync(secrets.masterKeyPath(), master.toString('base64') + '\n');
    writeOld('install.vault.json', { RIFF_RUNTIME_TOKEN: 'OLD-TOKEN' }, master);
    await assert.rejects(secrets.migrateVaults(() => [], async () => 'timed out'));
    assert.throws(() => secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'NEW-TOKEN', []), /not been moved/);
    assert.equal(secrets.deleteInstallSecret('RIFF_RUNTIME_TOKEN'), true, 'clearing it clears the one that is read');
    assert.equal(secrets.hasInstallSecret('RIFF_RUNTIME_TOKEN'), false);
  });

  test('before the move, the installation token is still found in the old file', () => {
    const master = randomBytes(32);
    mkdirSync(process.env['RIFF_ROOT']!, { recursive: true });
    writeFileSync(secrets.masterKeyPath(), master.toString('base64') + '\n');
    writeOld('install.vault.json', { RIFF_RUNTIME_TOKEN: 'tok' }, master);
    assert.equal(secrets.hasInstallSecret('RIFF_RUNTIME_TOKEN'), true);
    assert.equal(secrets.getInstallSecret('RIFF_RUNTIME_TOKEN'), 'tok');
  });

  test('until it moves, an old vault still sends the runtime token to Anthropic', () => {
    const master = randomBytes(32);
    mkdirSync(process.env['RIFF_ROOT']!, { recursive: true });
    writeFileSync(secrets.masterKeyPath(), master.toString('base64') + '\n');
    writeOld('install.vault.json', { RIFF_RUNTIME_TOKEN: 'tok', OTHER: 'x' }, master);
    const legacy = (n: string) => secrets.openSecret('install', n);
    // A company slug of 'install' reads the legacy file here, which is exactly
    // the window the migration closes.
    assert.ok(legacy('RIFF_RUNTIME_TOKEN')!.to.length > 0);
    assert.deepEqual(legacy('OTHER')!.to, []);
  });

  test('one vault that cannot move holds master.key, not the others', async () => {
    const master = randomBytes(32);
    mkdirSync(process.env['RIFF_ROOT']!, { recursive: true });
    writeFileSync(secrets.masterKeyPath(), master.toString('base64') + '\n');
    writeOld('a.vault.json', { K: 'a' }, master);
    writeOld('b.vault.json', { K: 'b' }, master);
    // An unreadable third vault stops the move part way.
    writeFileSync(join(process.env['RIFF_ROOT']!, 'secrets', 'c.vault.json'), '{"v":1,"dek":{"iv":"","ct":"","tag":""},"secrets":{}}');
    const first = await secrets.migrateVaults(() => [], secrets.verifyCanary);
    assert.deepEqual(first, { vaults: 2, secrets: 2, failed: ['c.vault.json'] }, 'the rest move; the bad one is named');
    assert.ok(existsSync(secrets.masterKeyPath()), 'kept, since a vault still needs it');
    rmSync(join(process.env['RIFF_ROOT']!, 'secrets', 'c.vault.json'));
    assert.deepEqual(await secrets.migrateVaults(() => [], secrets.verifyCanary), { vaults: 0, secrets: 0, failed: [] });
    assert.ok(!existsSync(secrets.masterKeyPath()));
    assert.equal(secrets.getSecret('a', 'K'), 'a');
    assert.equal(secrets.getSecret('b', 'K'), 'b');
  });

  test('storing into a vault not yet moved is refused, not mixed', () => {
    const master = randomBytes(32);
    mkdirSync(process.env['RIFF_ROOT']!, { recursive: true });
    writeFileSync(secrets.masterKeyPath(), master.toString('base64') + '\n');
    writeOld('shipit.vault.json', { K: 'v' }, master);
    assert.throws(() => secrets.putSecret('shipit', 'K2', 'v2', []), /not been moved/);
  });
});

describe('bad input is refused at the door', () => {
  test('an empty value is refused', () => {
    assert.throws(() => secrets.putSecret('shipit', 'K', '', []), /empty/);
  });

  test('a name that is not an env identifier is refused', () => {
    assert.throws(() => secrets.putSecret('shipit', 'has-dash', 'v', []), /identifier/);
    assert.throws(() => secrets.putSecret('shipit', '1LEADING', 'v', []), /identifier/);
    assert.throws(() => secrets.putSecret('shipit', 'has space', 'v', []), /identifier/);
  });
});

describe('removal', () => {
  test('a deleted secret is gone and reports that it was there', () => {
    secrets.putSecret('shipit', 'K', 'v', []);
    assert.equal(secrets.deleteSecret('shipit', 'K'), true);
    assert.equal(secrets.getSecret('shipit', 'K'), null);
  });

  test('deleting an absent secret reports false, not an error', () => {
    assert.equal(secrets.deleteSecret('shipit', 'K'), false);
  });

  test('dropping a vault removes the file entirely', () => {
    secrets.putSecret('shipit', 'K', 'v', []);
    const path = join(process.env['RIFF_ROOT']!, 'secrets', 'shipit.vault.json');
    assert.ok(existsSync(path));
    secrets.dropVault('shipit');
    assert.ok(!existsSync(path));
  });
});

describe('the secrets directory is owner-only', () => {
  test('the store directory is 0700, not world-listable', () => {
    secrets.putSecret('shipit', 'K', 'v', []);
    const mode = statSync(join(process.env['RIFF_ROOT']!, 'secrets')).mode & 0o777;
    assert.equal(mode, 0o700);
  });
});

describe('the installation-level vault holds the runtime default, separately', () => {
  test('an install secret round-trips', () => {
    secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'sk-ant-install', []);
    assert.equal(secrets.getInstallSecret('RIFF_RUNTIME_TOKEN'), 'sk-ant-install');
    assert.equal(secrets.hasInstallSecret('RIFF_RUNTIME_TOKEN'), true);
  });

  test('an absent install secret is null / false, not an error', () => {
    assert.equal(secrets.getInstallSecret('NOPE'), null);
    assert.equal(secrets.hasInstallSecret('NOPE'), false);
  });

  test('it lives at a fixed path, not a company slug, and does not cross with one', () => {
    secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'install-default', []);
    secrets.putSecret('shipit', 'RIFF_RUNTIME_TOKEN', 'shipit-own', []);
    // Same name, two different vaults, two different values.
    assert.equal(secrets.getInstallSecret('RIFF_RUNTIME_TOKEN'), 'install-default');
    assert.equal(secrets.getSecret('shipit', 'RIFF_RUNTIME_TOKEN'), 'shipit-own');
    assert.ok(existsSync(join(process.env['RIFF_ROOT']!, 'secrets', '_install.vault.json')));
  });

  test('its plaintext is not on disk', () => {
    secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'super-secret-default', []);
    const raw = readFileSync(join(process.env['RIFF_ROOT']!, 'secrets', '_install.vault.json'), 'utf8');
    assert.ok(!raw.includes('super-secret-default'));
  });

  test('deleting an install secret reports whether it was there', () => {
    secrets.putInstallSecret('RIFF_RUNTIME_TOKEN', 'v', []);
    assert.equal(secrets.deleteInstallSecret('RIFF_RUNTIME_TOKEN'), true);
    assert.equal(secrets.getInstallSecret('RIFF_RUNTIME_TOKEN'), null);
    assert.equal(secrets.deleteInstallSecret('RIFF_RUNTIME_TOKEN'), false);
  });
});

describe('hasSecret answers presence without reading the value', () => {
  test('true only when the named secret is stored', () => {
    secrets.putSecret('shipit', 'RIFF_RUNTIME_TOKEN', 'v', []);
    assert.equal(secrets.hasSecret('shipit', 'RIFF_RUNTIME_TOKEN'), true);
    assert.equal(secrets.hasSecret('shipit', 'MISSING'), false);
    assert.equal(secrets.hasSecret('nobody', 'RIFF_RUNTIME_TOKEN'), false);
  });
});
