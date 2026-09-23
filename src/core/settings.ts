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
  /**
   * How stale the plan's usage reading may get, in minutes, before the gateway
   * asks for a fresh one with a one-token call. Shifts refresh it for free as
   * they run; this only fires while nothing is. 0 turns it off. See usageFeed.
   */
  usagePollMinutes?: number;
};

/** Ten minutes: at most 144 one-token Haiku calls a day, and only while idle. */
export const DEFAULT_USAGE_POLL_MINUTES = 10;
/**
 * Below the scheduler's 30-minute staleness line (WINDOW_STALE_MS), or an idle
 * company's reading lapses between refreshes and it flips blind and back.
 */
export const MAX_USAGE_POLL_MINUTES = 25;

/** A poll interval as stored or offered, clamped; anything unusable is the default. */
export const readUsagePollMinutes = (raw: unknown): number => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.min(MAX_USAGE_POLL_MINUTES, Math.max(0, Math.round(n))) : DEFAULT_USAGE_POLL_MINUTES;
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
    return {
      ...(runtimeCredential ? { runtimeCredential } : {}),
      ...(raw['usagePollMinutes'] !== undefined ? { usagePollMinutes: readUsagePollMinutes(raw['usagePollMinutes']) } : {}),
    };
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

/** Set how stale the usage reading may get before the gateway refreshes it. */
export const setUsagePollMinutes = (minutes: number): void => {
  writeSettings({ ...readSettings(), usagePollMinutes: readUsagePollMinutes(minutes) });
};

/** Drop the default runtime-credential type, preserving any other settings. The
 *  token VALUE in the install vault is a separate concern the caller deletes; the
 *  keyproxy then resolves neither a type nor a value and falls closed (502), which
 *  the gateway preflight turns into "set a runtime credential" before any wake. */
export const clearDefaultRuntimeCredential = (): void => {
  const next = { ...readSettings() };
  delete next.runtimeCredential;
  writeSettings(next);
};
