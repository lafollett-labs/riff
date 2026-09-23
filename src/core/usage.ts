/**
 * The plan's usage windows, read from the traffic that already spends them.
 *
 * Anthropic answers every inference call on a subscription credential with the
 * account's rate-limit state in its headers — measured through the keyproxy on
 * the long-lived runtime token, which cannot call /api/oauth/usage:
 *
 *   anthropic-ratelimit-unified-5h-utilization = 0.05   (reset 1790134200)
 *   anthropic-ratelimit-unified-7d-utilization = 0.42   (reset 1790211600)
 *
 * The same figures the host poller read with an interactive login, with no
 * login and no extra call. Account-wide, so the operator's own Claude Code use
 * is in them too. Shared by the keyproxy (which sees the headers) and the
 * gateway (which paces on them); the keyproxy image carries src/core only.
 */

/**
 * The scoped-token audience that means the installation itself rather than a
 * company. Minted only by the gateway, which holds the signing secret; the
 * leading underscore is outside everything slugId() can produce, so no company
 * can ever be it.
 */
export const INSTALL_SCOPE = '_install';

/** Where the factory reaches the keyproxy. RUNTIME_BASE_URL is a route under it. */
export const KEYPROXY_ORIGIN = 'http://keyproxy:8890';

export type UsageWindow = {
  /** `five_hour`, `seven_day`, or a per-model week like `seven_day_opus`. */
  kind: string;
  /** 0–1. */
  utilization: number;
  /** Epoch seconds, or null when the header did not say. */
  resetsAt: number | null;
  /** `allowed`, `allowed_warning`, `rejected`… as the upstream said it. */
  status: string | null;
};

/** One reading: when the keyproxy saw it (epoch ms), and every window it named. */
export type UsageSnapshot = { at: number; windows: UsageWindow[] };

const HEADER = /^anthropic-ratelimit-unified-([a-z0-9_]+)-(utilization|reset|status)$/;

/** `5h` and `7d` are what the headers say; `five_hour` and `seven_day` are what Riff has always called them. */
const kindOf = (raw: string): string => raw.replace(/^5h/, 'five_hour').replace(/^7d/, 'seven_day');

/**
 * Every window named in a response's headers. A group without a numeric
 * utilization is not a window (the headers also carry `overage-status` and the
 * like), and is left out rather than reported as zero.
 */
export const unifiedWindows = (headers: Record<string, string | string[] | undefined>): UsageWindow[] => {
  const parts = new Map<string, { utilization?: number; resetsAt?: number; status?: string }>();
  for (const [name, value] of Object.entries(headers)) {
    const m = HEADER.exec(name.toLowerCase());
    const raw = Array.isArray(value) ? value[0] : value;
    if (!m || raw == null) continue;
    const kind = kindOf(m[1]!);
    const w = parts.get(kind) ?? {};
    if (m[2] === 'utilization') { const n = Number(raw); if (Number.isFinite(n)) w.utilization = n; }
    else if (m[2] === 'reset') { const n = Number(raw); if (Number.isFinite(n)) w.resetsAt = n; }
    else w.status = raw;
    parts.set(kind, w);
  }
  const out: UsageWindow[] = [];
  for (const [kind, w] of parts) {
    if (w.utilization === undefined) continue;
    out.push({ kind, utilization: w.utilization, resetsAt: w.resetsAt ?? null, status: w.status ?? null });
  }
  return out;
};
