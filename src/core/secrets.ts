import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { installRoot, slugId, operatorError } from './config.ts';
import { atomicWriteFileSync } from './atomicwrite.ts';

/**
 * Per-company secrets the agents can USE but never POSSESS.
 *
 * A company's product must authenticate to a model backend, a database, its own
 * API — with a key the staff running that product must not be able to read. The
 * only place a key can be that a shift genuinely cannot reach is OUTSIDE the
 * factory container: SECURITY.md is blunt that anything inside the box, the
 * subscription token included, is readable by a shell that has run long enough.
 * So this module is only half of the answer. It is the STORE: encrypted at
 * rest, wrapped per company, and it lives at the installation root, never in a
 * world. The injector that hands a decrypted value to a call without the value
 * passing through the agent's reach is a separate sidecar; this is what it reads.
 *
 * What this store guarantees on its own:
 *   - a value is never on disk in plaintext, never in config.json, never in git;
 *   - one company's vault cannot be decrypted with another company's key;
 *   - the file lives outside every world, so the sandbox — which lets a shift
 *     read only its own world — cannot reach even the ciphertext.
 * What it does NOT guarantee, and only the sidecar does: that the process using
 * the key cannot read it. The code using a secret can always read the secret;
 * that is why the real key lives one container away and the factory holds a
 * scoped token instead.
 */

const ALG = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM's standard nonce length.

/** The vault store, a sibling of `companies/`, never inside a world. */
const secretsDir = (): string => join(installRoot(), 'secrets');
const vaultPath = (slug: string): string => join(secretsDir(), `${slug}.vault.json`);

/**
 * The key that wraps every company's key. It sits at the installation root,
 * OUTSIDE any world, so the shift sandbox (which re-allows a shift to read only
 * its own world) never sees it. 0600, and forced with chmod because writeFileSync
 * honours mode only on create and only modulo the umask.
 */
export const masterKeyPath = (): string => join(installRoot(), 'master.key');

/**
 * Write a file only its owner can read. writeFileSync honours mode only on
 * create and only modulo the umask, so the chmod is not redundant — it is what
 * makes the 0600 hold on a machine with a permissive umask. Shared with the
 * proxy-token secret, which has the same "a credential on disk, owner-only"
 * requirement.
 */
export const writeSecret600 = (path: string, contents: string): void => {
  // The directory holding secrets is owner-only too: even with each file 0600,
  // a world-listable directory tells another local user which companies and
  // services exist. chmod after mkdir because mkdir honours mode only on create
  // and only masked by the umask.
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Atomic: the proxy reads a vault fresh on every request, so a putSecret that
  // truncated it in place could be read half-written and fail to decrypt.
  atomicWriteFileSync(path, contents, 0o600);
};

export const loadOrCreateMasterKey = (): Buffer => {
  const path = masterKeyPath();
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    // A short key is a corrupted key. Generating a fresh one instead would
    // silently orphan every secret the old one wrapped, turning a recoverable
    // "restore this file" into an unrecoverable "re-enter every credential".
    if (key.length !== KEY_BYTES) {
      throw operatorError(
        `master key at ${path} is ${key.length} bytes, not ${KEY_BYTES}: ` +
        `refusing to use a malformed key or to replace it, which would orphan every secret it wrapped`,
      );
    }
    return key;
  }
  const key = randomBytes(KEY_BYTES);
  writeSecret600(path, key.toString('base64') + '\n');
  return key;
};

/** One encrypted blob: nonce, ciphertext, GCM tag, all base64. */
type Sealed = { iv: string; ct: string; tag: string };

const seal = (key: Buffer, plaintext: Buffer): Sealed => {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
};

const unseal = (key: Buffer, s: Sealed): Buffer => {
  const d = createDecipheriv(ALG, key, Buffer.from(s.iv, 'base64'));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  // final() throws on a tag mismatch, so a tampered blob is a decrypt error
  // rather than silently wrong bytes.
  return Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]);
};

type VaultFile = {
  v: 1;
  /** The company data key, generated once when the company's vault is first
   *  written and wrapped under the master key. Rotating the master key means
   *  re-wrapping this one blob per company, not re-encrypting every secret. */
  dek: Sealed;
  /** Each value encrypted under the company data key, keyed by name. */
  secrets: Record<string, Sealed>;
};

const readVault = (slug: string): VaultFile | null => {
  const path = vaultPath(slug);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as VaultFile;
};

const openVault = (master: Buffer, slug: string): { file: VaultFile; dek: Buffer } => {
  const existing = readVault(slug);
  if (existing) return { file: existing, dek: unseal(master, existing.dek) };
  const dek = randomBytes(KEY_BYTES);
  return { file: { v: 1, dek: seal(master, dek), secrets: {} }, dek };
};

const writeVault = (slug: string, file: VaultFile): void =>
  writeSecret600(vaultPath(slug), JSON.stringify(file, null, 2) + '\n');

// A secret is delivered to the product as an environment variable, so its name
// has to be a legal one: letters, digits and underscore, not leading with a
// digit. Rejecting a bad name here beats a value that silently never resolves.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const checkName = (name: string): void => {
  if (!NAME_RE.test(name)) {
    throw operatorError(
      `secret name ${JSON.stringify(name)} is not a valid environment identifier ` +
      `(letters, digits, underscore; not leading with a digit)`,
    );
  }
};

/**
 * Store or replace one secret. Write-only by design: there is no companion that
 * returns a stored value to an API caller — see getSecret, which the injector
 * uses and the gateway does not expose.
 */
export const putSecret = (companySlug: string, name: string, value: string): void => {
  const slug = slugId(companySlug);
  checkName(name);
  // An empty secret reads as "set" to anything listing names and as "unset" to
  // anything resolving it — the two disagree, so refuse the blank outright.
  if (value === '') {
    throw operatorError('refusing to store an empty secret; delete the name instead of storing a blank that reads as set');
  }
  const master = loadOrCreateMasterKey();
  const { file, dek } = openVault(master, slug);
  file.secrets[name] = seal(dek, Buffer.from(value, 'utf8'));
  writeVault(slug, file);
};

/** The names a company has, sorted. NEVER the values — this is what the API
 *  may return, and the reason values and names are separable at all. */
export const listSecretNames = (companySlug: string): string[] => {
  const file = readVault(slugId(companySlug));
  return file ? Object.keys(file.secrets).sort() : [];
};

/**
 * Resolve one secret to plaintext. Internal to the server and the injector
 * sidecar; the gateway must never return this to a client. Null means the
 * company has no such secret, distinct from a decrypt failure, which throws.
 */
export const getSecret = (companySlug: string, name: string): string | null => {
  const slug = slugId(companySlug);
  const file = readVault(slug);
  if (!file) return null;
  const sealed = file.secrets[name];
  if (!sealed) return null;
  const dek = unseal(loadOrCreateMasterKey(), file.dek);
  return unseal(dek, sealed).toString('utf8');
};

/** Remove one secret. Returns whether it was there to remove. */
export const deleteSecret = (companySlug: string, name: string): boolean => {
  const slug = slugId(companySlug);
  const file = readVault(slug);
  if (!file || !(name in file.secrets)) return false;
  delete file.secrets[name];
  writeVault(slug, file);
  return true;
};

/**
 * Drop a company's whole vault. Called when a company is archived so its
 * secrets do not outlive it as a decryptable file under the master key.
 */
export const dropVault = (companySlug: string): void => {
  const path = vaultPath(slugId(companySlug));
  if (existsSync(path)) rmSync(path);
};
