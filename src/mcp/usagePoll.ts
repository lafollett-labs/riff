/*
 * Usage poller — the one feed that can read the plan's rate-limit windows.
 *
 * A `setup-token` spends the subscription but carries no `user:profile`, so it
 * cannot read what is left of the plan (see limits.ts: rate_limits_available
 * comes back false). Only an interactive login can, and that login lives on the
 * host — the login Keychain on macOS, `~/.claude/.credentials.json` on Linux,
 * where the SDK also refreshes it in place. So the windows are polled host-side
 * with that credential and POSTed to /api/usage, which paces every running
 * company off the plan's real five-hour and seven-day windows rather than the
 * sparse rate_limit_event a shift occasionally carries.
 *
 * The access token is read into memory per poll and is never logged, written,
 * or returned — a failed poll degrades to the last-known windows, never to a
 * leaked credential.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RiffClient } from './client.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Without a Claude-Code-shaped User-Agent the usage endpoint answers with
// aggressive 429s; the beta header is what makes it return the windows at all.
const UA = 'claude-code/2.1.280';
const BETA = 'oauth-2025-04-20';
const DEFAULT_INTERVAL_MS = 5 * 60_000;

const tokenFromRaw = (raw: string): string | null => {
  try {
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return j.claudeAiOauth?.accessToken ?? null;
  } catch { return null; }
};

/**
 * The interactive login's access token, read in memory, or null when none is
 * reachable. macOS keeps it in the login Keychain; Linux in a file the SDK also
 * refreshes. Never logged. The `run`/`read` seams exist so a test can drive
 * this without a real Keychain or home directory.
 */
export const readAccessToken = (
  run: (cmd: string, args: string[]) => string =
    (c, a) => execFileSync(c, a, { encoding: 'utf8' }),
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string | null => {
  try {
    const t = tokenFromRaw(run('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w']));
    if (t) return t;
  } catch { /* not macOS, or no such Keychain entry */ }
  try {
    const t = tokenFromRaw(read(join(homedir(), '.claude', '.credentials.json')));
    if (t) return t;
  } catch { /* no credentials file */ }
  return null;
};

export type PollDeps = {
  client: Pick<RiffClient, 'postUsage'>;
  token: () => string | null;
  fetch?: typeof globalThis.fetch;
};

export type PollResult = { ok: boolean; note: string };

/**
 * One poll cycle: read token → fetch the plan windows → POST them to
 * /api/usage. A cycle that cannot complete returns `ok: false` with a reason
 * and changes nothing — the throttle keeps its last-known windows. It never
 * throws for an operational failure, so an interval can call it forever.
 */
export const pollUsageOnce = async (d: PollDeps): Promise<PollResult> => {
  const f = d.fetch ?? globalThis.fetch;
  const at = d.token();
  if (!at) return { ok: false, note: 'no interactive credential to read windows' };

  let body: string;
  try {
    const r = await f(USAGE_URL, { headers: {
      Authorization: `Bearer ${at}`, 'anthropic-beta': BETA, 'User-Agent': UA,
    } });
    if (!r.ok) return { ok: false, note: `oauth/usage HTTP ${r.status}` };
    body = await r.text();
  } catch (e) {
    return { ok: false, note: `oauth/usage ${e instanceof Error ? e.message : String(e)}` };
  }

  // The body is the rate_limits map verbatim; the gateway wraps it. Parse here
  // only so a non-JSON answer (an auth redirect, an error page) is a skipped
  // poll rather than a 400 stored as if it were windows.
  let map: unknown;
  try { map = JSON.parse(body); } catch { return { ok: false, note: 'oauth/usage did not return JSON' }; }

  const res = await d.client.postUsage(map);
  if (res.status >= 400) return { ok: false, note: `/api/usage HTTP ${res.status}` };
  const accepted = (res.data as { accepted?: number } | null)?.accepted ?? 0;
  return { ok: true, note: `injected ${accepted} window(s)` };
};

/**
 * Poll on an interval until the returned stop function is called. Seeds one
 * poll immediately so a fresh start paces at once rather than after the first
 * interval. The interval is unref'd, so it never keeps the host process alive
 * on its own — it rides whatever already holds the loop (the MCP transport, or
 * the daemon's own keep-alive).
 */
export const startUsagePolling = (
  client: Pick<RiffClient, 'postUsage'>,
  opts: {
    intervalMs?: number;
    token?: () => string | null;
    log?: (s: string) => void;
    fetch?: typeof globalThis.fetch;
  } = {},
): (() => void) => {
  const intervalMs = opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  const token = opts.token ?? (() => readAccessToken());
  const log = opts.log ?? ((s) => process.stderr.write(`[usage-poll] ${s}\n`));
  const tick = (): void => {
    void pollUsageOnce({ client, token, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
      .then((r) => { if (!r.ok) log(r.note); })
      .catch((e) => log(e instanceof Error ? e.message : String(e)));
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
};
