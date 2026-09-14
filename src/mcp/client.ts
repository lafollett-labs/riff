/*
 * A typed client for Riff's HTTP API, and nothing more.
 *
 * Every method here is a call to http://localhost:4173/api. It never opens a
 * ledger, reads a config or touches the registry — the gateway is the only way
 * in, and a second path to the data is the thing that drifts from it. Nine
 * scripts once reached past the API straight to the ledger; they disagreed
 * with it one at a time, and one founded a company by editing config.json
 * under a running server and corrupted its ledger. See CLAUDE.md, "The API is
 * the only way in".
 *
 * The endpoint knowledge lives here rather than in the MCP wiring so it can be
 * tested against a stub server: the run/running field name that silently
 * stopped a company instead of starting it is exactly the kind of mistake a
 * test pins down once and forgets.
 */

export interface RiffResponse {
  readonly status: number;
  readonly data: unknown;
}

export interface FoundInput {
  name: string;
  business: string;
  ceo: string;
  chair?: string;
  board?: ReadonlyArray<{ name: string; role?: string }>;
  policy?: Record<string, number>;
  running?: boolean;
}

export interface RunBounds {
  hours?: number;
  maxTicks?: number;
  hard?: boolean;
}

/** Trailing slashes off, empty falls back to the loopback default. */
export const normalizeBase = (raw?: string): string =>
  (raw?.trim() || 'http://localhost:4173').replace(/\/+$/, '');

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/**
 * Events arrive with the payload as a JSON string in `dataJson`; a reader
 * wants it parsed. `kinds` keeps only the named event kinds, which is how a
 * caller asks "any failures?" without pulling two hundred rows back through
 * the model.
 */
export const shapeEvents = (
  data: unknown,
  kinds?: string,
): { count: number; events: Array<Record<string, unknown>> } => {
  const raw = asRecord(data)['events'];
  const rows = Array.isArray(raw) ? raw : [];
  const want = kinds
    ? new Set(kinds.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
    : null;
  const events = rows
    .map((r) => asRecord(r))
    .filter((e) => want === null || (typeof e['kind'] === 'string' && want.has(e['kind'])))
    .map((e) => {
      let payload: unknown = null;
      const dj = e['dataJson'];
      if (typeof dj === 'string' && dj.length > 0) {
        try { payload = JSON.parse(dj); } catch { payload = dj; }
      }
      return {
        seq: e['seq'] ?? null,
        at: e['at'] ?? null,
        actor: e['actor'] ?? null,
        kind: e['kind'] ?? null,
        subject: e['subject'] ?? null,
        data: payload,
      };
    });
  return { count: events.length, events };
};

/**
 * A shift's recorded turns, filtered to the entries a reader asked for. The
 * endpoint pages by seq and returns every kind; a reviewer usually wants one
 * slice — the tool calls, or only what errored — and returning the whole page
 * back through the model is how a 300-turn shift becomes unreadable. `kinds`
 * keeps only the named entry kinds; `errorsOnly` keeps errored tool results and
 * any shift result whose subtype is not success. The filter runs over the page
 * the endpoint returned, so `scanned` says how much was looked at and `more`
 * whether another page waits — raise `limit` or page with `after` to see more.
 */
export const shapeTranscript = (
  data: unknown,
  opts?: { kinds?: string; errorsOnly?: boolean },
): {
  agent: unknown; sessionId: unknown; sessions: unknown[];
  scanned: number; shown: number; more: unknown; nextAfter: unknown;
  turns: Array<Record<string, unknown>>;
} => {
  const d = asRecord(data);
  const raw = Array.isArray(d['turns']) ? (d['turns'] as unknown[]) : [];
  const rows = raw.map((r) => asRecord(r));
  const want = opts?.kinds
    ? new Set(opts.kinds.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
    : null;
  const errored = (t: Record<string, unknown>): boolean => {
    const m = asRecord(t['meta']);
    if (m['isError'] === true) return true;
    // A shift's own closing result: any subtype but success is a failed leg.
    if (t['kind'] === 'result') {
      const st = m['subtype'];
      return typeof st === 'string' && st !== 'success';
    }
    return false;
  };
  const turns = rows.filter((t) =>
    (want === null || (typeof t['kind'] === 'string' && want.has(t['kind'] as string))) &&
    (!opts?.errorsOnly || errored(t)));
  return {
    agent: d['agent'] ?? null,
    sessionId: d['sessionId'] ?? null,
    sessions: Array.isArray(d['sessions']) ? (d['sessions'] as unknown[]) : [],
    scanned: rows.length,
    shown: turns.length,
    more: d['more'] ?? false,
    nextAfter: d['nextAfter'] ?? 0,
    turns,
  };
};

const q = (slug: string): string => `?c=${encodeURIComponent(slug)}`;

export type Fetcher = typeof fetch;

export class RiffClient {
  readonly #base: string;
  readonly #fetch: Fetcher;

  constructor(base?: string, fetchImpl: Fetcher = fetch) {
    this.#base = normalizeBase(base);
    this.#fetch = fetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<RiffResponse> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' } } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data: unknown = null;
    if (text.length > 0) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    return { status: res.status, data };
  }

  // -------------------------------------------------------------- reads
  companies(): Promise<RiffResponse> {
    return this.#req('GET', '/api/companies');
  }

  usage(): Promise<RiffResponse> {
    return this.#req('GET', '/api/usage');
  }

  /** Inject a subscription usage reading. `body` is the `/api/oauth/usage`
   *  response verbatim (its rate_limits map); the gateway folds it into every
   *  running company's throttle. See src/mcp/usagePoll.ts. */
  postUsage(body: unknown): Promise<RiffResponse> {
    return this.#req('POST', '/api/usage', body);
  }

  state(slug: string): Promise<RiffResponse> {
    return this.#req('GET', `/api/state${q(slug)}`);
  }

  async events(slug: string, opts?: { limit?: number; kinds?: string }): Promise<RiffResponse> {
    const limit = opts?.limit && opts.limit > 0 ? Math.min(500, Math.round(opts.limit)) : 60;
    const r = await this.#req('GET', `/api/events${q(slug)}&limit=${limit}`);
    if (r.status >= 400) return r;
    return { status: r.status, data: shapeEvents(r.data, opts?.kinds) };
  }

  vitals(slug: string, window?: string): Promise<RiffResponse> {
    const w = window ? `&window=${encodeURIComponent(window)}` : '';
    return this.#req('GET', `/api/vitals${q(slug)}${w}`);
  }

  inbox(slug: string, scope?: 'mine' | 'all'): Promise<RiffResponse> {
    const s = scope === 'all' ? '&scope=all' : '';
    return this.#req('GET', `/api/inbox${q(slug)}${s}`);
  }

  approvals(slug: string, decided?: boolean): Promise<RiffResponse> {
    return decided
      ? this.#req('GET', `/api/approvals/decided${q(slug)}`)
      : this.#req('GET', `/api/approvals${q(slug)}`);
  }

  commons(slug: string): Promise<RiffResponse> {
    return this.#req('GET', `/api/commons${q(slug)}`);
  }

  doc(slug: string, path: string): Promise<RiffResponse> {
    return this.#req('GET', `/api/doc${q(slug)}&path=${encodeURIComponent(path)}`);
  }

  whathappened(slug: string, since?: string): Promise<RiffResponse> {
    const s = since ? `&since=${encodeURIComponent(since)}` : '';
    return this.#req('GET', `/api/whathappened${q(slug)}${s}`);
  }

  /**
   * Review a shift: the company's own audit of what a staff member did.
   * `agent` is required; `session` defaults server-side to that agent's most
   * recent. Unfiltered we ask for a small page (a shift dumps hundreds of turns
   * and each one costs tokens); when filtering we scan a large page and hand
   * back only the matches, so "the errors in this shift" is one call for any
   * shift under the page size. `after`/`limit` page a longer one.
   */
  async transcript(
    slug: string,
    opts: { agent: string; session?: string; after?: number; limit?: number; kinds?: string; errorsOnly?: boolean },
  ): Promise<RiffResponse> {
    const filtering = Boolean(opts.kinds) || opts.errorsOnly === true;
    const limit = opts.limit && opts.limit > 0
      ? Math.min(2000, Math.round(opts.limit))
      : (filtering ? 500 : 60);
    const after = opts.after && opts.after > 0 ? Math.round(opts.after) : 0;
    const session = opts.session ? `&session=${encodeURIComponent(opts.session)}` : '';
    const r = await this.#req(
      'GET',
      `/api/transcript${q(slug)}&agent=${encodeURIComponent(opts.agent)}${session}&after=${after}&limit=${limit}`,
    );
    if (r.status >= 400) return r;
    return {
      status: r.status,
      data: shapeTranscript(r.data, {
        ...(opts.kinds !== undefined ? { kinds: opts.kinds } : {}),
        ...(opts.errorsOnly !== undefined ? { errorsOnly: opts.errorsOnly } : {}),
      }),
    };
  }

  // ---------------------------------------------------------- run control
  /**
   * Start or pause a company. The wire field is `running`, not `run` — the
   * server reads `b['running'] === true`, so `run` is silently a pause. A
   * pause drains by default; `hard: true` kills the shift mid-write.
   */
  setRunning(slug: string, running: boolean, bounds?: RunBounds): Promise<RiffResponse> {
    return this.#req('POST', `/api/companies/${encodeURIComponent(slug)}/running`, {
      running,
      ...(bounds?.hours !== undefined ? { hours: bounds.hours } : {}),
      ...(bounds?.maxTicks !== undefined ? { maxTicks: bounds.maxTicks } : {}),
      ...(bounds?.hard !== undefined ? { hard: bounds.hard } : {}),
    });
  }

  /** Wake one agent now and start the company if it was stopped. */
  wake(slug: string, who?: string): Promise<RiffResponse> {
    return this.#req('POST', `/api/wake${q(slug)}`, who !== undefined ? { who } : {});
  }

  // -------------------------------------------------------------- writes
  found(input: FoundInput): Promise<RiffResponse> {
    return this.#req('POST', '/api/companies', {
      name: input.name,
      business: input.business,
      ceo: input.ceo,
      ...(input.chair !== undefined ? { chair: input.chair } : {}),
      ...(input.board !== undefined ? { board: input.board } : {}),
      ...(input.policy !== undefined ? { policy: input.policy } : {}),
      ...(input.running !== undefined ? { running: input.running } : {}),
    });
  }

  update(
    slug: string,
    patch: { name?: string; business?: string; policy?: Record<string, number>; release?: 'none' | 'bundle' },
  ): Promise<RiffResponse> {
    return this.#req('PATCH', `/api/companies/${encodeURIComponent(slug)}`, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.business !== undefined ? { business: patch.business } : {}),
      ...(patch.policy !== undefined ? { policy: patch.policy } : {}),
      ...(patch.release !== undefined ? { release: patch.release } : {}),
    });
  }

  /** Board mail. `from` must be a board seat; it defaults to the chair. */
  say(slug: string, text: string, opts?: { to?: string[]; from?: string }): Promise<RiffResponse> {
    return this.#req('POST', `/api/say${q(slug)}`, {
      text,
      ...(opts?.to !== undefined ? { to: opts.to } : {}),
      ...(opts?.from !== undefined ? { from: opts.from } : {}),
    });
  }

  /** Decide a pending approval. `as` defaults to the chair on the server. */
  decide(
    slug: string,
    id: string,
    approved: boolean,
    opts?: { as?: string; reason?: string },
  ): Promise<RiffResponse> {
    return this.#req('POST', `/api/approvals/${encodeURIComponent(id)}${q(slug)}`, {
      approved,
      ...(opts?.as !== undefined ? { as: opts.as } : {}),
      ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
    });
  }
}
