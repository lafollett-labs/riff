import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellIsContained } from './permissions.ts';
import { resolveConfig, RUNTIME_SECRET_NAME } from '../core/config.ts';
import { hasSecret, hasInstallSecret } from '../core/secrets.ts';

/**
 * The slice of ~/.claude/.credentials.json a start decision reads.
 *
 * Only the fields judged below are named. An expired ACCESS token is not one of
 * them: it is short-lived by design and the SDK renews it from the refresh
 * token, so gating on it would refuse a credential that is working exactly as
 * intended. What is fatal is a credential that cannot be renewed at all.
 */
export type OauthRecord = {
  claudeAiOauth?: {
    accessToken?: string | null;
    refreshTokenExpiresAt?: number | null;
  } | null;
};

export type CredentialHealth =
  | { live: true }
  | { live: false; why: string; fix: string };

const REDELIVER = 'docker/up.sh creds';

/**
 * Whether the delivered credential can actually authenticate a shift.
 *
 * This exists because the credential failed twice on 2026-09-11 and both were
 * silent: a company woke, could not authenticate, and spent a shift logging it,
 * cycle after cycle, until someone read the ledger. Once the record was absent
 * — an interrupted `up --build` recreated the container but delivered nothing.
 * Once it was present but its token fields had been cleared to null after a
 * refresh failed ~70 minutes in. Both are caught here so the start refuses
 * loudly instead of waking to fail quietly.
 *
 * A bare CLAUDE_CODE_OAUTH_TOKEN is opaque — there is no expiry to read — so it
 * is taken on faith. That path already records planVisible:no and is the
 * operator's explicit, self-announced choice; second-guessing it here would
 * only refuse a credential we cannot actually prove is dead.
 */
export const credentialHealth = (
  token: string | undefined,
  record: OauthRecord | null,
  now: number,
): CredentialHealth => {
  if (token && token.trim()) return { live: true };
  if (!record) {
    return { live: false, why: 'no credentials record has been delivered', fix: REDELIVER };
  }
  const o = record.claudeAiOauth;
  if (!o || !o.accessToken) {
    return {
      live: false,
      why: 'the credentials record carries no token — a refresh failed and cleared it',
      fix: REDELIVER,
    };
  }
  // The refresh token is the one whose expiry is fatal: past it, the access
  // token can no longer be renewed and every shift will fail to authenticate.
  // Guarded on presence and type so a record without the field is never
  // refused on a guess.
  if (typeof o.refreshTokenExpiresAt === 'number' && o.refreshTokenExpiresAt <= now) {
    return {
      live: false,
      why: 'the refresh token has expired, so the access token can no longer be renewed',
      fix: `re-login on the host, then ${REDELIVER}`,
    };
  }
  return { live: true };
};

/**
 * Judge the delivered credential, but only inside the container.
 *
 * On an operator's own machine there is no factory and ~/.claude/.credentials.json
 * is their personal Claude login. Reading it to gate a start would be wrong
 * there, and in the test suite would resolve the operator's real credential —
 * so outside a contained runtime this always answers live. The guard is for the
 * stack that delivers a record onto tmpfs, and nowhere else.
 *
 * Which credential is in force is not guessed: up.sh sets
 * RIFF_WAIT_FOR_CREDENTIALS only when a record is configured and pushed to
 * tmpfs. When it is set, the record file is the credential and the bare token
 * (a compose placeholder in that mode) is ignored; otherwise the bare token is.
 */
export const startCredentialHealth = (
  env: NodeJS.ProcessEnv = process.env,
  contained: boolean = shellIsContained(env),
): CredentialHealth => {
  if (!contained) return { live: true };
  if (env['RIFF_WAIT_FOR_CREDENTIALS'] === '1') {
    return credentialHealth(undefined, readRecord(env['HOME'] ?? ''), Date.now());
  }
  return credentialHealth(env['CLAUDE_CODE_OAUTH_TOKEN'], null, Date.now());
};

/**
 * Whether a company has a runtime credential the keyproxy can actually inject —
 * the post-cutover preflight, replacing the env/record check above (the raw token
 * no longer lives in the factory env). Mirrors the keyproxy's resolution so the
 * gate and the injector agree: a company on its OWN credential needs its own vault
 * token; otherwise the installation default must be set. Refusing here turns "wake,
 * fail to authenticate, burn a shift saying so" into a loud 503 that names the fix.
 *
 * Gated to the contained runtime for the same reason as startCredentialHealth: on
 * an operator's machine and in the test suite there is no factory to gate, and the
 * throwaway installations tests run against have no credential set — so outside a
 * container this answers live and never blocks a test's found-and-run.
 */
export const runtimeCredentialHealth = (
  slug: string,
  contained: boolean = shellIsContained(),
): CredentialHealth => {
  if (!contained) return { live: true };
  const own = resolveConfig(process.cwd(), slug).runtimeCredential;
  const has = own ? hasSecret(slug, RUNTIME_SECRET_NAME) : hasInstallSecret(RUNTIME_SECRET_NAME);
  if (has) return { live: true };
  return own
    ? {
        live: false,
        why: "this company's runtime credential type is set but no token is stored",
        fix: "set the company's runtime credential in the console",
      }
    : {
        live: false,
        why: 'no runtime credential is set for this installation',
        fix: 'set a default runtime credential in Riff Settings',
      };
};

/** Read and parse the record, treating anything unreadable as absent. */
const readRecord = (home: string): OauthRecord | null => {
  const path = join(home, '.claude', '.credentials.json');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as OauthRecord) : null;
  } catch {
    // A file that cannot be read or parsed is not a live credential. Judged
    // absent, which is the honest verdict and the one that refuses the start.
    return null;
  }
};
