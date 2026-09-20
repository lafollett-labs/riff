import { shellIsContained } from './permissions.ts';
import { resolveConfig, RUNTIME_SECRET_NAME } from '../core/config.ts';
import { hasSecret, hasInstallSecret } from '../core/secrets.ts';

export type CredentialHealth =
  | { live: true }
  | { live: false; why: string; fix: string };

/**
 * Whether a company has a runtime credential the keyproxy can actually inject.
 *
 * The runtime credential no longer reaches the factory as an env token or a
 * tmpfs record — it lives encrypted in a vault the keyproxy reads on egress — so
 * the start decision is "does a token the proxy can resolve exist?", mirroring
 * the keyproxy's own resolution so the gate and the injector agree: a company on
 * its OWN credential needs its own vault token; otherwise the installation
 * default must be set. Refusing here turns "wake, fail to authenticate, burn a
 * shift saying so" into a loud refusal that names the fix. The failure this
 * guards against happened twice on 2026-09-11, silently, before it existed: a
 * company woke, could not authenticate, and spent shift after shift logging it.
 *
 * Gated to the contained runtime: on an operator's own machine and in the test
 * suite there is no factory to gate, and the throwaway installations the tests
 * run against have no credential set — so outside a container this answers live
 * and never blocks a test's found-and-run.
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
