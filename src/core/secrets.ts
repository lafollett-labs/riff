import {
  randomBytes, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject,
} from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { installRoot, slugId, operatorError, sameDestination, runtimeDestinations, RUNTIME_SECRET_NAME, type Destination } from './config.ts';
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
 *
 * Sealed to a PUBLIC key since 2026-09-23. The gateway stores secrets and never
 * reads one back, yet it held `master.key`, which unlocks every vault — and the
 * gateway is the process that loads the Agent SDK, taken from npm as each
 * release ships. Now each value is sealed to the keyproxy's X25519 public key;
 * the private key lives in a directory only the keyproxy container mounts
 * (`vaultKeysDir`), and nothing in the factory can open a vault, whatever code
 * runs there. A value typed into the Desk still passes through the gateway on
 * its way in; one already stored never comes back out of it.
 */

const ALG = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM's standard nonce length.
const INFO = 'riff-vault-v2';

/** The vault store, a sibling of `companies/`, never inside a world. */
const secretsDir = (): string => join(installRoot(), 'secrets');
const vaultPath = (slug: string): string => join(secretsDir(), `${slug}.vault.json`);

/**
 * The symmetric key every vault was sealed under before public-key sealing.
 * Read only to move old vaults across (`migrateVaults`), then deleted; nothing
 * creates one any more.
 */
export const masterKeyPath = (): string => join(installRoot(), 'master.key');

/**
 * Where the vault's private key lives: beside the installation, never inside
 * it — `~/.riff-keys` for `~/.riff` — because the factory container mounts the
 * installation and must not mount this. In Docker only the keyproxy has it, at
 * RIFF_KEYS_DIR. Derived from the install root, so a test's throwaway root gets
 * a throwaway key.
 */
export const vaultKeysDir = (): string =>
  process.env['RIFF_KEYS_DIR'] || join(dirname(installRoot()), `${basename(installRoot())}-keys`);
const privateKeyPath = (): string => join(vaultKeysDir(), 'vault.key');

/**
 * Set in the factory: where to fetch the public key from, and a statement that
 * this process seals and never opens. Any path to the private key throws there,
 * so a misconfigured factory fails rather than minting a key of its own on a
 * tmpfs and sealing secrets to it.
 */
const publicFrom = (): string | undefined => process.env['RIFF_VAULT_PUBLIC_FROM'] || undefined;

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

const loadMasterKey = (): Buffer => {
  const path = masterKeyPath();
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  // A short key is a corrupted key: refuse it, and never replace it, which
  // would orphan every secret it wrapped.
  if (key.length !== KEY_BYTES) {
    throw operatorError(
      `master key at ${path} is ${key.length} bytes, not ${KEY_BYTES}: ` +
      `refusing to use a malformed key or to replace it, which would orphan every secret it wrapped`,
    );
  }
  return key;
};

const rawPublic = (k: KeyObject): Buffer => Buffer.from(k.export({ format: 'jwk' }).x!, 'base64url');
const publicFromRaw = (raw: Buffer): KeyObject =>
  createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
/** Which public key a value was sealed to, so a mismatch reads as one. */
const keyId = (raw: Buffer): string => createHash('sha256').update(raw).digest('base64url').slice(0, 16);

const loadPrivateKey = (create: boolean): KeyObject => {
  if (publicFrom()) throw operatorError('this process only seals secrets; the vault\'s private key lives with the keyproxy');
  const path = privateKeyPath();
  // An unreadable key file throws here rather than being replaced: a new key
  // would orphan every secret sealed to the old one.
  if (existsSync(path)) return createPrivateKey(readFileSync(path, 'utf8'));
  if (!create) throw operatorError(`no vault private key at ${path}`);
  const { privateKey } = generateKeyPairSync('x25519');
  writeSecret600(path, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
  return privateKey;
};

/**
 * The keyproxy's key: made on its first start, and only then. A key missing
 * while vaults sealed to one exist is a lost key — a wrong mount, a restore
 * without the key archive — and making a fresh one would turn that into every
 * secret failing one by one, so it is refused and said.
 */
export const loadOrCreateVaultKey = (): { publicKey: string; kid: string } => {
  if (!existsSync(privateKeyPath()) && anySealed()) {
    throw operatorError(`no vault key at ${privateKeyPath()}, but vaults are sealed to one: restore it from ` +
      `the riff-keys backup, or point RIFF_KEYS at where it is. A new key would open none of them.`);
  }
  return vaultPublicKey(true);
};

/** The public half, for the gateway to seal to. Makes nothing. */
export const vaultPublicKey = (create = false): { publicKey: string; kid: string } => {
  const raw = rawPublic(createPublicKey(loadPrivateKey(create)));
  return { publicKey: raw.toString('base64url'), kid: keyId(raw) };
};

/** The public key this process seals to, by where it came from, so a test's
 *  next throwaway root does not seal to the last one's key. */
let sealing: { from: string; raw: Buffer } | null = null;

/** Fetch the public key from the keyproxy, where RIFF_VAULT_PUBLIC_FROM says. */
export const fetchVaultPublicKey = async (attempts = 10): Promise<void> => {
  const from = publicFrom();
  if (!from) return;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${from}/vault/public-key`, { signal: AbortSignal.timeout(5000) });
      const body = await r.json() as { publicKey?: unknown };
      const raw = Buffer.from(String(body.publicKey ?? ''), 'base64url');
      if (!r.ok || raw.length !== KEY_BYTES) throw new Error(`keyproxy answered ${r.status}`);
      sealing = { from, raw };
      return;
    } catch (e) { last = e; await new Promise((res) => setTimeout(res, 1000)); }
  }
  throw operatorError(`could not fetch the vault public key from ${from}: ${last instanceof Error ? last.message : String(last)}`);
};

const sealingKey = (): Buffer => {
  const from = publicFrom() ?? privateKeyPath();
  if (sealing?.from === from) return sealing.raw;
  if (publicFrom()) throw operatorError('the vault public key has not been fetched from the keyproxy; secrets cannot be stored yet');
  sealing = { from, raw: rawPublic(createPublicKey(loadPrivateKey(true))) };
  return sealing.raw;
};

/** One encrypted blob: nonce, ciphertext, GCM tag, all base64. */
type Sealed = { iv: string; ct: string; tag: string };

const unseal = (key: Buffer, s: Sealed): Buffer => {
  const d = createDecipheriv(ALG, key, Buffer.from(s.iv, 'base64'));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  // final() throws on a tag mismatch, so a tampered blob is a decrypt error
  // rather than silently wrong bytes.
  return Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]);
};

/**
 * One value sealed to the vault's public key: an ephemeral X25519 key, whose
 * agreement with the vault key derives (HKDF-SHA256) the AES-256-GCM key for
 * this value alone. Bound in as additional data: the vault file, the name, and
 * `to` — where the value may be sent, fixed when it was entered. A value moved
 * to another company or name no longer opens, and neither does one whose `to`
 * the gateway has edited.
 */
export type Sealed2 = { kid: string; to: Destination[]; epk: string; iv: string; ct: string; tag: string };

type VaultFile =
  | {
    /** Before 2026-09-23: a company data key wrapped under master.key. */
    v: 1;
    dek: Sealed;
    secrets: Record<string, Sealed>;
  }
  | { v: 2; secrets: Record<string, Sealed2> };

/** One order and one spelling for a list of destinations, so the same list is
 *  the same bytes whichever order the routes were read in. */
const canonical = (to: Destination[]): Destination[] =>
  to.map((d) => ({ origin: d.origin, header: d.header, scheme: d.scheme }))
    // Byte order, not localeCompare: these become AAD bytes, and a collation
    // that differed between the sealer and the opener would open nothing.
    .sort((a, b) => {
      const x = `${a.origin}\0${a.header}\0${a.scheme}`, y = `${b.origin}\0${b.header}\0${b.scheme}`;
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .filter((d, i, all) => i === 0 || !sameDestination(d, all[i - 1]!));

const aadFor = (vault: string, name: string, to: Destination[]): Buffer =>
  Buffer.from(`${INFO}\0${vault}\0${name}\0${JSON.stringify(canonical(to))}`);

const deriveKey = (shared: Buffer, epk: Buffer, pub: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, pub]), INFO, KEY_BYTES));

const sealTo = (pub: Buffer, aad: Buffer, plaintext: Buffer): Omit<Sealed2, 'to'> => {
  const eph = generateKeyPairSync('x25519');
  const epk = rawPublic(eph.publicKey);
  const key = deriveKey(diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(pub) }), epk, pub);
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv(ALG, key, iv, { authTagLength: 16 });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { kid: keyId(pub), epk: epk.toString('base64url'), iv: iv.toString('base64'),
    ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
};

const openSealed = (priv: KeyObject, aad: Buffer, s: Omit<Sealed2, 'to'>): Buffer => {
  const pub = rawPublic(createPublicKey(priv));
  if (s.kid !== keyId(pub)) {
    throw operatorError('this secret was sealed to a different vault key than the keyproxy holds; enter it again');
  }
  const epk = Buffer.from(s.epk, 'base64url');
  const key = deriveKey(diffieHellman({ privateKey: priv, publicKey: publicFromRaw(epk) }), epk, pub);
  // The tag length stated, not left to the runtime's default: a short tag
  // accepted would make /vault/verify worth forging against.
  const d = createDecipheriv(ALG, key, Buffer.from(s.iv, 'base64'), { authTagLength: 16 });
  d.setAAD(aad);
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]);
};

const sealValue = (pub: Buffer, vault: string, name: string, to: Destination[], value: Buffer): Sealed2 => {
  const bound = canonical(to);
  return { ...sealTo(pub, aadFor(vault, name, bound), value), to: bound };
};

// The vault helpers key off a path rather than a slug so the install-level vault
// (a single fixed file, below) shares the exact same crypto and key as every
// per-company vault — one code path, no second implementation to drift.
const readVaultAt = (path: string): VaultFile | null => {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as VaultFile;
};

const writeVaultAt = (path: string, file: VaultFile): void =>
  writeSecret600(path, JSON.stringify(file, null, 2) + '\n');

const vaultFiles = (): string[] => {
  const dir = secretsDir();
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.vault.json')).map((f) => join(dir, f)) : [];
};

/** Whether any vault holds a value sealed to a vault key. */
const anySealed = (): boolean =>
  vaultFiles().some((p) => { const f = readVaultAt(p); return f?.v === 2 && Object.keys(f.secrets).length > 0; });

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

// The write and read cores, keyed by vault path. Name/value validation lives
// here so the per-company and install-level writers cannot diverge on it.
const putSecretAt = (path: string, name: string, value: string, to: Destination[]): void => {
  checkName(name);
  // An empty secret reads as "set" to anything listing names and as "unset" to
  // anything resolving it — the two disagree, so refuse the blank outright.
  if (value === '') {
    throw operatorError('refusing to store an empty secret; delete the name instead of storing a blank that reads as set');
  }
  const file = readVaultAt(path) ?? { v: 2, secrets: {} };
  // The gateway moves every old vault across before it serves; one still old
  // here means that move failed, and sealing into it would mix two schemes.
  if (file.v !== 2) throw operatorError(`the vault at ${path} has not been moved to public-key sealing yet`);
  file.secrets[name] = sealValue(sealingKey(), basename(path), name, to, Buffer.from(value, 'utf8'));
  writeVaultAt(path, file);
};

/** A stored value and where it may be sent, from one read of the vault. */
export type Opened = { value: string; to: Destination[] };

const openSecretAt = (path: string, name: string): Opened | null => {
  const file = readVaultAt(path);
  if (!file || !Object.hasOwn(file.secrets, name)) return null;
  if (file.v === 1) {
    // Only between an upgrade and its migration. Bound to nowhere — except the
    // runtime token, whose destination is a constant — so one vault the move
    // could not reach does not stop every shift on the installation's token.
    return { value: unseal(unseal(loadMasterKey(), file.dek), file.secrets[name]!).toString('utf8'),
      to: name === RUNTIME_SECRET_NAME ? canonical(runtimeDestinations()) : [] };
  }
  const sealed = file.secrets[name]!;
  const to = Array.isArray(sealed.to) ? sealed.to : [];
  const value = openSealed(loadPrivateKey(false), aadFor(basename(path), name, to), sealed).toString('utf8');
  return { value, to: canonical(to) };
};

/**
 * The canary a move checks before master.key goes: sealed like a secret but
 * under a vault name no secret has, so opening it opens nothing else.
 */
const CANARY = '_canary';
export const sealCanary = (): { sealed: Sealed2; digest: string } => {
  const value = randomBytes(KEY_BYTES);
  return { sealed: sealValue(sealingKey(), CANARY, CANARY, [], value),
    digest: createHash('sha256').update(value).digest('hex') };
};
export const openCanary = (sealed: Sealed2): string =>
  createHash('sha256').update(openSealed(loadPrivateKey(false), aadFor(CANARY, CANARY, []), sealed)).digest('hex');

/** Ask whoever holds the private key to open a canary: the keyproxy, or this
 *  process when it is a host run holding the key itself. */
export const verifyCanary = async (sealed: Sealed2): Promise<string> => {
  const from = publicFrom();
  if (!from) return openCanary(sealed);
  const r = await fetch(`${from}/vault/verify`, { method: 'POST', body: JSON.stringify(sealed),
    headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) });
  const b = await r.json() as { digest?: unknown };
  return r.ok && typeof b.digest === 'string' ? b.digest : '';
};

/**
 * Move every vault sealed under master.key to the public key, then delete
 * master.key. Run by the gateway before it serves: it can open the old vaults
 * today anyway, so doing it there costs nothing, and after it nothing can.
 *
 * Each value is bound to where it is sent today (`destinations`, from the
 * company's routes); the install vault moves to `_install.vault.json`, a name
 * no company slug can take. Each vault is rewritten atomically, and master.key
 * goes last — only once `verify` shows the keyproxy opens what was sealed — so
 * a move cut short resumes on the next boot, and a key nobody holds deletes
 * nothing. Returns what it moved, or null if nothing was left to.
 */
export const migrateVaults = async (
  destinations: (company: string | null, name: string) => Destination[],
  verify: (canary: Sealed2) => Promise<string>,
): Promise<{ vaults: number; secrets: number; failed: string[] } | null> => {
  if (!existsSync(masterKeyPath())) return null;
  const master = loadMasterKey();
  const pub = sealingKey();
  // First, before anything is rewritten: sealed to a key the keyproxy does not
  // hold, every vault would be replaced by one nobody can open.
  const canary = sealCanary();
  if (await verify(canary.sealed) !== canary.digest) {
    throw operatorError('the keyproxy could not open what was sealed to its key; nothing was moved');
  }
  let vaults = 0, count = 0;
  const failed: string[] = [];
  for (const path of vaultFiles()) {
    const file = readVaultAt(path);
    if (!file || file.v !== 1) continue;
    // One unreadable vault is reported and left under master.key; the rest move.
    try {
      const install = basename(path) === LEGACY_INSTALL_VAULT;
      const target = install ? installVaultPath() : path;
      const company = install ? null : basename(path).slice(0, -'.vault.json'.length);
      const dek = unseal(master, file.dek);
      const out: VaultFile = { v: 2, secrets: {} };
      let n = 0;
      for (const [name, sealed] of Object.entries(file.secrets)) {
        out.secrets[name] = sealValue(pub, basename(target), name, destinations(company, name), unseal(dek, sealed));
        n++;
      }
      writeVaultAt(target, out);
      // Moved once: left behind, the next boot moved it again over whatever
      // runtime token had been set since, and put the old one back.
      if (target !== path) rmSync(path);
      vaults++; count += n;
    } catch { failed.push(basename(path)); }
  }
  // master.key goes only when nothing still needs it.
  if (failed.length) return { vaults, secrets: count, failed };
  rmSync(masterKeyPath());
  return { vaults, secrets: count, failed };
};

/** Presence of a name without decrypting it — the "is it set?" the gateway
 *  answers for a reserved name it must never list or return. */
const hasSecretAt = (path: string, name: string): boolean => {
  const file = readVaultAt(path);
  return file ? Object.hasOwn(file.secrets, name) : false;
};

/** Where a stored value may be sent, read without opening it: for the Desk to
 *  say which routes a key will and will not work on. Cannot be forged into
 *  use — the keyproxy checks it against the sealing. */
const boundToAt = (path: string, name: string): Destination[] | null => {
  const file = readVaultAt(path);
  if (!file || !Object.hasOwn(file.secrets, name)) return null;
  return file.v === 2 ? canonical(file.secrets[name]!.to ?? []) : [];
};

const deleteSecretAt = (path: string, name: string): boolean => {
  const file = readVaultAt(path);
  if (!file || !Object.hasOwn(file.secrets, name)) return false;
  delete file.secrets[name];
  writeVaultAt(path, file);
  return true;
};

/**
 * Store or replace one secret, bound to where it may be sent (`to`, from the
 * company's routes that name it now). Write-only by design: nothing returns a
 * stored value to an API caller — see openSecret, which only the keyproxy runs.
 */
export const putSecret = (companySlug: string, name: string, value: string, to: Destination[]): void =>
  putSecretAt(vaultPath(slugId(companySlug)), name, value, to);

/** The names a company has, sorted. NEVER the values — this is what the API
 *  may return, and the reason values and names are separable at all. */
export const listSecretNames = (companySlug: string): string[] => {
  const file = readVaultAt(vaultPath(slugId(companySlug)));
  return file ? Object.keys(file.secrets).sort() : [];
};

/**
 * A value and where it may go. The keyproxy's alone: the gateway runs with
 * RIFF_VAULT_PUBLIC_FROM set and cannot load the key this needs. Null means no
 * such secret, distinct from a decrypt failure, which throws.
 */
export const openSecret = (companySlug: string, name: string): Opened | null =>
  openSecretAt(vaultPath(slugId(companySlug)), name);

/** The value alone, for tests and anything that sends to no route. */
export const getSecret = (companySlug: string, name: string): string | null =>
  openSecret(companySlug, name)?.value ?? null;

export const secretBoundTo = (companySlug: string, name: string): Destination[] | null =>
  boundToAt(vaultPath(slugId(companySlug)), name);

/** Whether a company has a secret of this name, without reading its value —
 *  lets the gateway report a reserved credential as set without listing it. */
export const hasSecret = (companySlug: string, name: string): boolean =>
  hasSecretAt(vaultPath(slugId(companySlug)), name);

/** Remove one secret. Returns whether it was there to remove. */
export const deleteSecret = (companySlug: string, name: string): boolean =>
  deleteSecretAt(vaultPath(slugId(companySlug)), name);

/**
 * Drop a company's whole vault. Called when a company is archived so its
 * secrets do not outlive it as a file the vault key opens.
 */
export const dropVault = (companySlug: string): void => {
  const path = vaultPath(slugId(companySlug));
  if (existsSync(path)) rmSync(path);
};

/**
 * The installation-level vault: one fixed file for installation-wide secrets —
 * today just the DEFAULT Claude runtime token, the fallback a company uses when
 * it has not set its own. Sealed to the same vault key as every company vault.
 * `_install`, which slugId can never produce: it was `install.vault.json`, the
 * very file a company founded as "Install" would have had, and a compromised
 * gateway could found one to reach the installation's token.
 *
 * Read-only on the keyproxy: it only opens; the gateway, on the read-write
 * mount, is the only writer.
 */
const LEGACY_INSTALL_VAULT = 'install.vault.json';
export const installVaultPath = (): string => join(secretsDir(), '_install.vault.json');

// Through the same choice of file as the reads: while the old vault has not
// moved, a write to it is refused as a company vault's is, rather than land in
// `_install` and be overwritten by the move when it finally runs.
export const putInstallSecret = (name: string, value: string, to: Destination[]): void =>
  putSecretAt(installVaultNow(), name, value, to);

/** The install vault, or the old one while it has not moved yet — before the
 *  first migration, or after a canary that stopped it — so the installation's
 *  token keeps working and does not read as unset, inviting a re-entry. */
const installVaultNow = (): string => existsSync(installVaultPath()) ? installVaultPath()
  : existsSync(join(secretsDir(), LEGACY_INSTALL_VAULT)) ? join(secretsDir(), LEGACY_INSTALL_VAULT) : installVaultPath();

export const openInstallSecret = (name: string): Opened | null =>
  openSecretAt(installVaultNow(), name);

export const getInstallSecret = (name: string): string | null =>
  openInstallSecret(name)?.value ?? null;

export const hasInstallSecret = (name: string): boolean =>
  hasSecretAt(installVaultNow(), name);

export const deleteInstallSecret = (name: string): boolean =>
  deleteSecretAt(installVaultNow(), name);
