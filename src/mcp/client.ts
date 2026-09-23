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

/**
 * A service route as the API accepts it. Mirrors `ServiceRoute` in core/config,
 * restated here rather than imported so this client stays a standalone HTTP
 * client with no dependency on the runtime. `headers` are static, NON-secret
 * literals (e.g. an OAuth upstream's `anthropic-beta` and `user-agent`); the
 * credential is named by `secret` and injected by the proxy, never sent here.
 */
export interface ServiceRouteInput {
  upstream: string;
  secret: string;
  header?: string;
  scheme?: string;
  headers?: Record<string, string>;
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

/**
 * Board mail, filtered to what a reader asked for. The endpoint returns every
 * message with its full body, and a long inbox is hundreds of KB — enough to
 * blow the token budget on a plain read. `ids` reads exactly the named messages
 * (their full bodies) and is the "open these" half of the loop, symmetric with
 * markRead's `ids`; `unreadOnly` keeps only unread mail addressed to the viewer
 * (`readAt` null and `yours`), which answers "do I have unread?" in one call and
 * matches the endpoint's own `unread` count; `limit` keeps the most recent N
 * (the endpoint orders newest-first). The filters compose in that order. The
 * `unread` count and `me`/`scope` pass through untouched, so a filtered view
 * still reports the true total.
 */
export const shapeInbox = (
  data: unknown,
  opts?: { ids?: string[]; unreadOnly?: boolean; limit?: number },
): {
  me: unknown; scope: unknown; unread: unknown;
  count: number; messages: Array<Record<string, unknown>>;
} => {
  const d = asRecord(data);
  const raw = Array.isArray(d['messages']) ? (d['messages'] as unknown[]) : [];
  let rows = raw.map((r) => asRecord(r));
  if (opts?.ids && opts.ids.length > 0) {
    const want = new Set(opts.ids);
    rows = rows.filter((m) => typeof m['id'] === 'string' && want.has(m['id'] as string));
  }
  if (opts?.unreadOnly) {
    rows = rows.filter((m) => m['readAt'] == null && m['yours'] === true);
  }
  if (opts?.limit !== undefined && opts.limit > 0) {
    rows = rows.slice(0, Math.round(opts.limit));
  }
  return {
    me: d['me'] ?? null,
    scope: d['scope'] ?? null,
    unread: d['unread'] ?? null,
    count: rows.length,
    messages: rows,
  };
};

/**
 * Company state, trimmed for an operational read. The endpoint carries the full
 * founding charter (`company.business`) and every agent's `mandate` prose — a
 * multi-KB block that a status check or a monitor pulls every tick and never
 * reads, the same dump that made a plain inbox read overrun the token budget.
 * `lean` drops the charter and the per-agent mandate and keeps the operational
 * surface: run flags, headcount, counts, the roster's live `activity`, dueAt
 * and the usage windows. Every other field passes through the spread, so a new
 * field the endpoint adds survives the trim rather than being silently dropped.
 * Unfiltered it returns the reply untouched.
 */
export const shapeState = (data: unknown, opts?: { lean?: boolean }): unknown => {
  if (!opts?.lean) return data;
  const drop = (obj: Record<string, unknown>, key: string): Record<string, unknown> => {
    const copy = { ...obj };
    delete copy[key];
    return copy;
  };
  const d = asRecord(data);
  const agents = (Array.isArray(d['agents']) ? (d['agents'] as unknown[]) : [])
    .map((a) => drop(asRecord(a), 'mandate'));
  return { ...d, company: drop(asRecord(d['company']), 'business'), agents };
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

  /**
   * Live state of one company. `lean` shapes the reply client-side (see
   * shapeState), dropping the founding charter and each agent's mandate prose
   * so a monitor's every-tick read is the operational surface, not a multi-KB
   * charter dump.
   */
  async state(slug: string, opts?: { lean?: boolean }): Promise<RiffResponse> {
    const r = await this.#req('GET', `/api/state${q(slug)}`);
    if (r.status >= 400) return r;
    return { status: r.status, data: shapeState(r.data, opts) };
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

  /**
   * Board mail. `scope: 'all'` widens to the whole company's traffic; unfiltered
   * it is only what reached the chair. `ids`, `unreadOnly` and `limit` shape the
   * reply client-side (see shapeInbox) so a long inbox is not dumped through the
   * model — `ids` reads the named messages' full bodies.
   */
  async inbox(
    slug: string,
    opts?: { scope?: 'mine' | 'all'; ids?: string[]; unreadOnly?: boolean; limit?: number },
  ): Promise<RiffResponse> {
    const s = opts?.scope === 'all' ? '&scope=all' : '';
    const r = await this.#req('GET', `/api/inbox${q(slug)}${s}`);
    if (r.status >= 400) return r;
    return {
      status: r.status,
      data: shapeInbox(r.data, {
        ...(opts?.ids !== undefined ? { ids: opts.ids } : {}),
        ...(opts?.unreadOnly !== undefined ? { unreadOnly: opts.unreadOnly } : {}),
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      }),
    };
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

  /**
   * Archive a company. The server moves its directory to the archive area, git
   * history and all, and drops its vault; it does not delete anything. The slug
   * in the path is the whole request — no body. See registry.archive: a running
   * company is stopped without draining first.
   */
  archive(slug: string): Promise<RiffResponse> {
    return this.#req('DELETE', `/api/companies/${encodeURIComponent(slug)}`);
  }

  /** Board mail. `from` must be a board seat; it defaults to the chair. */
  say(slug: string, text: string, opts?: { to?: string[]; from?: string }): Promise<RiffResponse> {
    return this.#req('POST', `/api/say${q(slug)}`, {
      text,
      ...(opts?.to !== undefined ? { to: opts.to } : {}),
      ...(opts?.from !== undefined ? { from: opts.from } : {}),
    });
  }

  /**
   * Mark board mail read, or unread with `read: false`. `ids` names the
   * messages; omit it to mark the whole inbox at once. The endpoint scopes to
   * the chair and returns how many rows changed. Pairs with `inbox({ unreadOnly:
   * true })` — read the unread, then clear exactly those ids.
   */
  markRead(slug: string, opts?: { ids?: string[]; read?: boolean }): Promise<RiffResponse> {
    return this.#req('POST', `/api/inbox/read${q(slug)}`, {
      ...(opts?.ids !== undefined ? { ids: opts.ids } : {}),
      ...(opts?.read !== undefined ? { read: opts.read } : {}),
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

  // ------------------------------------------------------------- services
  /**
   * A company's service routes: which named service the injecting proxy forwards
   * to which upstream, authenticated by which vault secret. The map holds NO
   * secret values — a name, a host, headers — so the whole thing reads back.
   * Secret VALUES are set only through the Desk Secrets tab, never here.
   */
  services(slug: string): Promise<RiffResponse> {
    return this.#req('GET', `/api/services${q(slug)}`);
  }

  /**
   * Create or update one service route. The route is flattened beside its `name`
   * in the body — the shape the server's validateServiceRoute reads — and merged
   * as a delta, so it composes with concurrent writes instead of clobbering.
   */
  setService(slug: string, name: string, route: ServiceRouteInput): Promise<RiffResponse> {
    return this.#req('PUT', `/api/services${q(slug)}`, {
      name,
      upstream: route.upstream,
      secret: route.secret,
      ...(route.header !== undefined ? { header: route.header } : {}),
      ...(route.scheme !== undefined ? { scheme: route.scheme } : {}),
      ...(route.headers !== undefined ? { headers: route.headers } : {}),
    });
  }

  /** Delete a service route by name. The server reports whether it existed. */
  deleteService(slug: string, name: string): Promise<RiffResponse> {
    return this.#req('DELETE', `/api/services${q(slug)}&name=${encodeURIComponent(name)}`);
  }
}
