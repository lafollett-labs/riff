import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { mintScopedToken } from '../core/proxytoken.ts';
import { INSTALL_SCOPE, KEYPROXY_ORIGIN, type UsageSnapshot, type UsageWindow } from '../core/usage.ts';
import { DEFAULT_USAGE_POLL_MINUTES, readSettings } from '../core/settings.ts';

/**
 * The plan's usage windows, fed to every company from inside the stack.
 *
 * They used to come from outside: a host process read the operator's own
 * interactive login, called /api/oauth/usage, and posted the result here —
 * because the long-lived runtime token cannot call that endpoint. It can,
 * though, spend, and every response it gets carries the same windows in its
 * headers. The keyproxy sees every one of those responses, so it keeps the
 * latest (src/core/usage.ts) and this reads it.
 *
 * While shifts run that reading refreshes itself for free. While nothing runs
 * it ages, so once it is older than the operator's interval (Riff Settings,
 * default ten minutes, 0 off) this sends the smallest real call there is —
 * Haiku, one output token — through the keyproxy on the installation's own
 * credential, which is what makes the headers arrive.
 */

/** Measured: 9 input tokens and 1 output, and it carries the full header set. */
export const PING_BODY = JSON.stringify({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 1,
  messages: [{ role: 'user', content: '.' }],
});

const PULL_MS = 60_000;
const TOKEN_TTL_S = 120;

export const toRateLimits = (windows: readonly UsageWindow[]): Array<[string, SDKRateLimitInfo]> =>
  windows.map((w) => [w.kind, {
    status: w.status === 'allowed_warning' || w.status === 'rejected' ? w.status : 'allowed',
    utilization: w.utilization,
    ...(w.kind === 'five_hour' || w.kind === 'seven_day' || w.kind === 'seven_day_opus' || w.kind === 'seven_day_sonnet'
      ? { rateLimitType: w.kind } : {}),
    ...(w.resetsAt != null ? { resetsAt: w.resetsAt } : {}),
  }]);

export type FeedDeps = {
  /** Where a reading lands: Registry.injectUsage. */
  inject: (windows: Array<[string, SDKRateLimitInfo]>, at: number) => void;
  fetch?: typeof fetch;
  origin?: string;
  now?: () => number;
  /** Minutes a reading may age before a ping; read each round so a Settings change applies. */
  pollMinutes?: () => number;
  /** The installation default's credential type, read each round. */
  credentialType?: () => string | undefined;
};

/**
 * One round: take the keyproxy's reading, pass it on if it is new, and ping
 * when it is older than the interval. Exported for the tests; start() loops it.
 * Failures are quiet by design — no keyproxy (a host run), no credential set,
 * an upstream hiccup — and the next round tries again.
 */
export const feedRound = async (d: FeedDeps, last: { at: number; pingedAt: number }): Promise<void> => {
  const f = d.fetch ?? fetch;
  const origin = d.origin ?? KEYPROXY_ORIGIN;
  const now = d.now ?? Date.now;
  const auth = { authorization: `Bearer ${mintScopedToken(INSTALL_SCOPE, TOKEN_TTL_S)}` };

  const read = async (): Promise<UsageSnapshot | null> => {
    const r = await f(`${origin}/usage`, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const s = await r.json() as { at: number | null; windows: UsageWindow[] };
    return s.at == null ? null : { at: s.at, windows: s.windows };
  };
  const pass = (s: UsageSnapshot | null): void => {
    if (!s || s.at <= last.at || !s.windows.length) return;
    last.at = s.at;
    d.inject(toRateLimits(s.windows), s.at);
  };

  let snap = await read();
  pass(snap);

  const minutes = (d.pollMinutes ?? (() => readSettings().usagePollMinutes ?? DEFAULT_USAGE_POLL_MINUTES))();
  if (minutes <= 0) return;
  // Plan windows exist only for a subscription token; on an API key the ping
  // would be billed and bring nothing back.
  if ((d.credentialType ?? (() => readSettings().runtimeCredential?.type))() === 'apiKey') return;
  if (snap && now() - snap.at < minutes * 60_000) return;
  // One ping per interval, whatever came of the last: with no credential set, or
  // an upstream that answers without the headers, the reading stays stale and
  // this would otherwise ping every minute.
  if (now() - last.pingedAt < minutes * 60_000) return;
  last.pingedAt = now();

  const r = await f(`${origin}/svc/_runtime/v1/messages`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: PING_BODY,
    signal: AbortSignal.timeout(30_000),
  });
  await r.arrayBuffer();
  snap = await read();
  pass(snap);
};

/** Start the loop. Rounds never overlap; the timer does not hold the process open. */
export const startUsageFeed = (d: FeedDeps): { stop: () => void } => {
  const last = { at: 0, pingedAt: 0 };
  let busy = false;
  const round = (): void => {
    if (busy) return;
    busy = true;
    feedRound(d, last).catch(() => { /* quiet: see feedRound */ }).finally(() => { busy = false; });
  };
  round();
  const t = setInterval(round, PULL_MS);
  t.unref();
  return { stop: () => clearInterval(t) };
};
