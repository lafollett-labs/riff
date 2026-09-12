import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installRoot, operatorError } from './config.ts';
import { writeSecret600 } from './secrets.ts';

/**
 * The scoped token a shift carries to the key-injecting proxy.
 *
 * The real key lives one container away, in the proxy; the factory holds only
 * this — a capability that says "the bearer is company X, until time T" and
 * proves it with an HMAC the factory server can mint but an agent cannot forge.
 *
 * WHY AN AGENT CANNOT FORGE ONE. The signing secret sits at the installation
 * root, outside every world, so the shift sandbox — which re-allows a shift to
 * read only its own world — never sees the file (the same protection the master
 * key relies on, measured in SECURITY.md against the companies directory). The
 * server mints a token for the company whose shift it is about to start and
 * injects it into that shift's environment; the shift can read its OWN token
 * and use it, which is the point, but cannot mint one for another company
 * because it cannot read the secret the signature is keyed on.
 *
 * WHAT IT DOES NOT DEFEND, stated so it is not mistaken for more: a token that a
 * neighbouring shift could read out of this one's process environment is a valid
 * token, and signing does not change that. Cross-shift environment isolation is
 * a container-model property (a shared /proc under one uid is the exposure), not
 * this file's, and the residual is bounded by the per-key spend cap. This makes
 * a token unforgeable, not unstealable.
 */

const TOKEN_BYTES = 32;
const SEP = '.';

const proxySecretPath = (): string => join(installRoot(), 'keyproxy.secret');

/**
 * The HMAC secret shared by the server (mints) and the proxy (verifies). Read
 * from the installation root by both; created on first use. Owner-only, and
 * never inside a world.
 */
export const loadOrCreateProxySecret = (): Buffer => {
  const path = proxySecretPath();
  if (existsSync(path)) {
    const secret = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (secret.length < TOKEN_BYTES) {
      throw operatorError(
        `proxy secret at ${path} is ${secret.length} bytes, under the ${TOKEN_BYTES} minimum: ` +
        `refusing a weak or truncated signing key`,
      );
    }
    return secret;
  }
  const secret = randomBytes(TOKEN_BYTES);
  writeSecret600(path, secret.toString('base64') + '\n');
  return secret;
};

const sign = (secret: Buffer, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/**
 * Mint a token for one company, valid for ttlSeconds. Format is
 * `<company>.<expiryEpochSeconds>.<hmac>`; company slugs carry no dot and the
 * signature is base64url, so a plain split on '.' recovers all three parts.
 */
export const mintScopedToken = (company: string, ttlSeconds: number, now = Date.now()): string => {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${company}${SEP}${exp}`;
  return `${payload}${SEP}${sign(loadOrCreateProxySecret(), payload)}`;
};

/**
 * Verify a token and return the company it is scoped to, or null. Null covers
 * every rejection — wrong shape, bad signature, expired — because the caller's
 * response is the same for all of them (no key) and telling them apart only
 * helps an attacker. A constant-time signature compare avoids a timing oracle.
 */
export const verifyScopedToken = (token: string, now = Date.now()): { company: string } | null => {
  const parts = token.split(SEP);
  if (parts.length !== 3) return null;
  const [company, expStr, sig] = parts as [string, string, string];
  const exp = Number(expStr);
  if (!company || !Number.isInteger(exp)) return null;
  if (exp * 1000 <= now) return null;

  const expected = sign(loadOrCreateProxySecret(), `${company}${SEP}${expStr}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { company };
};
