import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installRoot, readRuntimeCredential } from './config.ts';
import type { RuntimeCredential, RuntimeCredentialType } from './config.ts';
import { atomicWriteFileSync } from './atomicwrite.ts';

/**
 * Installation-level settings — the first Riff-level (not per-company) config.
 *
 * A company's config lives in its own directory; this is the one file that
 * belongs to the installation itself, at the install root beside `master.key`
 * and `secrets/`. Today it holds exactly one thing: the DEFAULT runtime
 * credential TYPE a company inherits when it has not set its own. The token
 * VALUE is never here — it is in the install vault (`install.vault.json`) under
 * `RUNTIME_SECRET_NAME`. Keeping the type here and the value in the vault is the
 * same split every service route already makes.
 *
 * Written only by the gateway (the read-write mount). The keyproxy reads it.
 */
export type InstallSettings = {
  /** The default runtime-credential type; absent until the operator sets one. */
  runtimeCredential?: RuntimeCredential;
};

const settingsPath = (): string => join(installRoot(), 'settings.json');

/** Read the installation settings, normalised. A missing or malformed file
 *  reads as empty rather than throwing — an unset default is a valid state, and
 *  the keyproxy must not fail a request over a settings-file typo. */
export const readSettings = (): InstallSettings => {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const runtimeCredential = readRuntimeCredential(raw['runtimeCredential']);
    return runtimeCredential ? { runtimeCredential } : {};
  } catch {
    return {};
  }
};

/** Replace the installation settings. Not a secret file (a type enum, no value),
 *  so ordinary permissions. The install root may not exist yet — an operator can
 *  set the default before founding any company — so ensure it before writing. */
export const writeSettings = (next: InstallSettings): void => {
  mkdirSync(installRoot(), { recursive: true });
  atomicWriteFileSync(settingsPath(), JSON.stringify(next, null, 2) + '\n');
};

/** Set the default runtime-credential type, preserving any other settings. */
export const setDefaultRuntimeCredentialType = (type: RuntimeCredentialType): void => {
  writeSettings({ ...readSettings(), runtimeCredential: { type } });
};
